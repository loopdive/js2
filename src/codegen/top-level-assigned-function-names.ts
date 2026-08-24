// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4491 wave-6 T12) Names bound by a module-scope `function` declaration —
 * pre-scanned, so a top-level assignment OVER one of them is collected into
 * `__module_init` instead of being silently dropped.
 *
 * ## The drop this closes
 *
 * A function declaration's binding is an ordinary mutable var binding, so
 * `function g() {}; g = 123;` must leave `g` holding `123`. Measured on this
 * branch, `--target standalone`, before the fix:
 *
 * ```js
 * function g() { return 1; }
 * var before = g, after;
 * g = 123;
 * after = g;   // → still the function object; `typeof g` → "function"
 * ```
 *
 * — and the emitted `__module_init` contains no `f64.const 123` at all. The
 * statement never reaches `compileAssignment`; it is dropped by
 * `shouldCollectTopLevelAssignment` (`declarations.ts`), whose `namedGlobal`
 * arm asks `ctx.moduleGlobals.has("g")`.
 *
 * ## Why the answer was "no" even though `__mod_g` exists
 *
 * It is the ORDERING hole `top-level-hoisted-var-names.ts` documents for
 * `var`, with a different filler. The module global that backs a reassigned
 * function binding is minted by `registerReassignedFunctionGlobals`
 * (#2931, `index.ts`), which runs AFTER `collectDeclarations` — the same pass
 * that asks the question. So the collector sees an empty answer for EVERY such
 * name, whatever the statement order inside the file, and the write is dropped
 * with no diagnostic: the #3623 silent-drop family again
 * (`{1268, 2671, 2992, 3366, 3468, 3592, 3615, 3956, 4179, 4491-T3}`).
 *
 * Unlike the `var` case there is no order under which this works, which is why
 * the defect reads as "assignment over a function is ignored" rather than as a
 * hoisting bug.
 *
 * ## Deliberately narrow
 *
 * - **Bare-identifier targets only.** `shouldCollectTopLevelAssignment` is
 *   consulted with the whole assignment target, and member writes rooted at a
 *   function (`F.p = …`, `F.prototype = …`) already have their own arms with
 *   their own host/standalone gating. Widening those through this predicate
 *   would change which member writes survive, which is not this fix.
 * - **Function declarations only**, hoisted like `var` out of blocks, `if`,
 *   loops, `try`, `switch`, labels and `with`, and stopping at every
 *   function/class boundary — an inner declaration binds in that scope.
 *   `class` declarations are lexical and keep their own path.
 */
import { ts } from "../ts-api.js";

const CACHE = new WeakMap<ts.SourceFile, ReadonlySet<string>>();

function walk(node: ts.Node, out: Set<string>): void {
  if (ts.isFunctionDeclaration(node)) {
    // The declaration itself binds at module scope; its BODY is a nested var
    // scope, so nothing inside it is collected.
    if (node.name !== undefined) out.add(node.name.text);
    return;
  }
  if (
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
  ts.forEachChild(node, (child) => walk(child, out));
}

/** Every name a module-scope `function` declaration binds in `sourceFile`. */
export function topLevelHoistedFunctionNames(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const cached = CACHE.get(sourceFile);
  if (cached !== undefined) return cached;
  const out = new Set<string>();
  for (const stmt of sourceFile.statements) walk(stmt, out);
  CACHE.set(sourceFile, out);
  return out;
}

/**
 * True when `target` is a bare identifier naming a module-scope function
 * declaration — the ordering hole `shouldCollectTopLevelAssignment` needs to
 * see through so the write over that binding survives collection.
 */
export function isAssignmentOverTopLevelFunctionName(target: ts.Expression): boolean {
  return ts.isIdentifier(target) && topLevelHoistedFunctionNames(target.getSourceFile()).has(target.text);
}
