// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491) Names bound by a top-level `var` — pre-scanned, so a top-level
 * assignment that appears BEFORE the declaration is still collected into
 * `__module_init`.
 *
 * ## The drop this closes
 *
 * `collectDeclarations` registers module globals and collects top-level
 * expression statements in ONE pass over `sourceFile.statements`, deliberately:
 * source order is load-bearing (`Ctor.prototype = proto` must run before
 * `new Ctor()`). But `shouldCollectTopLevelAssignment` decides whether to keep
 * `x = 1` by asking `ctx.moduleGlobals.has("x")` — a set the same pass is still
 * filling in. So an assignment that precedes its own `var` declaration sees an
 * EMPTY answer and the statement is dropped:
 *
 * ```js
 * x = 1;             // dropped — `x` is not yet in ctx.moduleGlobals
 * if (x !== 1) { …}  // reads the hoisted global's zero value
 * var x = 1;
 * ```
 *
 * Measured on this branch, `--target standalone`, before the fix:
 * `language/expressions/assignment/S11.13.1_A2.1_T1.js` failed with
 * `#1: x = 1; x === 1. Actual: 0`, and the reduced probe reported
 * `CHECK1 x=0 typeof=number` — the write never happened, exactly the #3623
 * silent-drop family (`{1268, 2671, 2992, 3366, 3468, 3592, 3615, 3956, 4179}`).
 * `var x;` with no initializer reproduces it too (`x=undefined`), which rules
 * out an initializer-ordering explanation: the STATEMENT is gone, not reordered.
 *
 * ## Why a pre-scan rather than a tenth allow-list arm
 *
 * The shape is already on the allow-list — `namedGlobal` names exactly this
 * case. What was missing is the FACT, not the arm: at the moment of the
 * question, the compiler did not yet know `x` would become a module global.
 * A pre-scan makes the answer independent of statement order without touching
 * the single-pass collection that everything else depends on.
 *
 * ## Deliberately `var` only
 *
 * `let` / `const` are NOT hoisted-and-initialised: an assignment before the
 * declaration is a TDZ ReferenceError, not a write. Collecting those would
 * emit a write where the spec wants a throw — a different (and worse) wrong
 * answer than today's silent drop. They stay out until the TDZ path can carry
 * them. Function and class declarations already have their own collection arms.
 *
 * The walk mirrors `walkModuleStmtForVars` in `declarations.ts` — `var` hoists
 * out of blocks, `if`, loops, `try`/`catch`/`finally`, `switch`, labels and
 * `with`, and stops at every function/class boundary (an inner `var` belongs to
 * that function, not to module scope).
 */
import { ts } from "../ts-api.js";

const CACHE = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

/** Add every identifier bound by `pattern` (including nested patterns). */
function addBindingNames(pattern: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(pattern)) {
    out.add(pattern.text);
    return;
  }
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    addBindingNames(element.name, out);
  }
}

/** `var` declaration lists only — `let`/`const` are TDZ, see the module note. */
function addVarDeclList(list: ts.VariableDeclarationList, out: Set<string>): void {
  if ((list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) !== 0) return;
  for (const decl of list.declarations) addBindingNames(decl.name, out);
}

function walk(node: ts.Node, out: Set<string>): void {
  // A `var` inside a function or class body belongs to that scope, not module
  // scope. Stop before descending into one.
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isClassDeclaration(node) ||
    ts.isClassExpression(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return;
  }
  if (ts.isVariableStatement(node)) {
    if (!node.modifiers?.some((m) => m.kind === ts.SyntaxKind.DeclareKeyword)) {
      addVarDeclList(node.declarationList, out);
    }
    return;
  }
  if (ts.isVariableDeclarationList(node)) {
    addVarDeclList(node, out);
    return;
  }
  ts.forEachChild(node, (child) => walk(child, out));
}

/**
 * Every name a top-level `var` binds in `sourceFile`, regardless of where the
 * declaration sits relative to a use. Cached per source file — the collection
 * pass asks once per top-level assignment.
 */
export function topLevelHoistedVarNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = CACHE.get(sourceFile);
  if (cached !== undefined) return cached;
  const out = new Set<string>();
  for (const stmt of sourceFile.statements) walk(stmt, out);
  CACHE.set(sourceFile, out);
  return out;
}

/**
 * True when `name` will become a module global for this file but has not been
 * registered yet — the ordering hole `shouldCollectTopLevelAssignment` needs to
 * see through.
 */
export function isHoistedTopLevelVarName(node: ts.Node, name: string): boolean {
  return topLevelHoistedVarNames(node.getSourceFile()).has(name);
}
