// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Pure-AST scope + free-variable walks, lifted BELOW the IR (#4601 route 1).
 *
 * ## Why this module exists
 *
 * These four walks — "which nodes open a function scope?", "what does this
 * function declare?", "which identifiers does this subtree reference?", "what
 * names does this binding pattern bind?" — are shared vocabulary: the legacy
 * codegen path and the IR front-end both need them, and neither of them is
 * codegen. They lived in `src/codegen/closures.ts` (3,984 LOC, `CodegenContext`
 * throughout) purely for historical reasons, which made every IR-side consumer
 * of a predicate built on top of them an inverted `ir -> codegen` import edge.
 *
 * `src/codegen/statements/loop-analysis.ts` was the concrete blocker: it is
 * pure-AST from top to bottom and five `src/ir/` modules import it, but it
 * could not move below the IR while its own two dependencies
 * (`collectReferencedIdentifiers` here, `collectPatternBindingNames` from
 * `codegen/statements/tdz.ts`) sat in `CodegenContext`-typed homes. Lifting
 * that leaf closure is what this file is.
 *
 * ## What is (and is not) here
 *
 * MOTION ONLY. Every function below is byte-identical to the one it replaced,
 * with the same doc comment. Nothing takes a `CodegenContext` / `FunctionContext`
 * / `ts.TypeChecker`, nothing emits Wasm: a `ts.Node` in, names out. The old
 * homes re-export these names, so every existing codegen consumer keeps
 * importing exactly what it imported before.
 *
 * Same precedent as `src/ir/js-tag.ts` (#3113 slice 1) and
 * `src/ir/async-static.ts` / `src/ir/regexp-runtime-contract.ts` (#3113 S2):
 * move the shared vocabulary below the IR rather than routing a new edge
 * through the bridge.
 */
import { forEachChild, ts } from "../../ts-api.js";
import { addFunctionOwnLocals, registerOwnLocalsCollector } from "./binding-info.js";

/** True for nodes that introduce a new function scope (params + body locals). */
export function isFunctionScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** Collect all identifier names from a binding pattern (destructuring parameter) */
export function collectBindingPatternNames(pattern: ts.BindingPattern, names: Set<string>): void {
  for (const element of pattern.elements) {
    if (ts.isOmittedExpression(element)) continue;
    if (ts.isIdentifier(element.name)) {
      names.add(element.name.text);
    } else if (ts.isObjectBindingPattern(element.name) || ts.isArrayBindingPattern(element.name)) {
      collectBindingPatternNames(element.name, names);
    }
  }
}

/**
 * #1452 — Walk a binding pattern (array / object / nested / rest) and yield
 * every identifier name that the pattern binds. `{a: y}` introduces `y`,
 * not `a`. `[...rest]` introduces `rest`. Used to drive the bulk TDZ-flip
 * step that runs after a binding-pattern destructure completes.
 */
export function* collectPatternBindingNames(name: ts.BindingName): Iterable<string> {
  if (ts.isIdentifier(name)) {
    yield name.text;
    return;
  }
  if (ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isOmittedExpression(el)) continue;
      yield* collectPatternBindingNames(el.name);
    }
    return;
  }
  if (ts.isObjectBindingPattern(name)) {
    for (const el of name.elements) {
      // For `{a: y}` el.name is `y`; for `{a}` el.name is also `a`.
      // For `{...rest}` el.name is the rest identifier. Either way
      // walking el.name covers every introduced binding.
      yield* collectPatternBindingNames(el.name);
    }
  }
}

/**
 * Collect names that are LOCALLY DECLARED inside a function-like node's scope.
 * Used to compute the shadow set for free-variable analysis.
 *
 * Includes:
 *   - parameter binding identifiers (function-scoped)
 *   - `var` declarations anywhere in the body (function-scoped)
 *   - top-level `function`/`class` declarations in the body
 *
 * Does NOT cross nested function boundaries.
 *
 * Conservatively excludes block-scoped `let`/`const` since they only shadow
 * within their block, and adding them to the function-wide shadow set would
 * incorrectly mask legitimate outer captures.
 */
export function collectFunctionOwnLocals(funcLike: ts.Node, out: Set<string>): void {
  if (!isFunctionScopeBoundary(funcLike)) return;
  const decl = funcLike as ts.SignatureDeclaration;
  // Params (including destructuring binding identifiers)
  if (decl.parameters) {
    for (const p of decl.parameters) {
      if (ts.isIdentifier(p.name)) {
        out.add(p.name.text);
      } else if (ts.isObjectBindingPattern(p.name) || ts.isArrayBindingPattern(p.name)) {
        collectBindingPatternNames(p.name, out);
      }
    }
  }
  // Body var/function/class decls. Concise arrow bodies are expressions — no decls.
  const body = (decl as { body?: ts.Node | undefined }).body;
  if (body && ts.isBlock(body)) {
    for (const stmt of body.statements) {
      collectVarAndTopLevelDecls(stmt, out, /*atTopLevel=*/ true);
    }
  }
}

// (#2103) Back the shared binding-info oracle with the own-locals collector
// above. Registered once at module load; the oracle memoizes per function node
// so the repeated per-scope-boundary calls inside the identifier walks below
// (and across all other lowerings) reuse a single computed set.
registerOwnLocalsCollector(collectFunctionOwnLocals);

/**
 * Recursively collect `var` declarations (function-scoped) and top-level
 * `function`/`class` declarations from a node tree, without crossing nested
 * function scope boundaries.
 */
function collectVarAndTopLevelDecls(node: ts.Node, out: Set<string>, atTopLevel: boolean): void {
  if (isFunctionScopeBoundary(node)) return; // do not cross
  if (ts.isVariableStatement(node)) {
    const isVar = !(node.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
    if (isVar) {
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) out.add(d.name.text);
        else if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
          collectBindingPatternNames(d.name, out);
        }
      }
    }
    // Initializers may contain nested functions — keep walking but we won't
    // descend into their bodies (boundary check above).
    for (const d of node.declarationList.declarations) {
      if (d.initializer) collectVarAndTopLevelDecls(d.initializer, out, false);
    }
    return;
  }
  if (ts.isForStatement(node) && node.initializer && ts.isVariableDeclarationList(node.initializer)) {
    const isVar = !(node.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
    if (isVar) {
      for (const d of node.initializer.declarations) {
        if (ts.isIdentifier(d.name)) out.add(d.name.text);
        else if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
          collectBindingPatternNames(d.name, out);
        }
      }
    }
  }
  if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && ts.isVariableDeclarationList(node.initializer)) {
    const isVar = !(node.initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const));
    if (isVar) {
      for (const d of node.initializer.declarations) {
        if (ts.isIdentifier(d.name)) out.add(d.name.text);
        else if (ts.isObjectBindingPattern(d.name) || ts.isArrayBindingPattern(d.name)) {
          collectBindingPatternNames(d.name, out);
        }
      }
    }
  }
  if (ts.isFunctionDeclaration(node) && node.name && atTopLevel) {
    out.add(node.name.text);
    return; // do not recurse into nested function body
  }
  if (ts.isClassDeclaration(node) && node.name && atTopLevel) {
    out.add(node.name.text);
    return;
  }
  forEachChild(node, (c) => collectVarAndTopLevelDecls(c, out, false));
}

/**
 * Collect all identifiers referenced in a node.
 *
 * If `shadowed` is provided, identifiers in that set are NOT collected. The
 * walker also detects nested function scopes and augments the shadow set with
 * each nested function's own locals so that references inside them to names
 * shadowed by nested var/param decls aren't incorrectly attributed to the
 * outer scope.
 *
 * Callers analyzing free variables of a function-like body should compute the
 * function's own locals via `collectFunctionOwnLocals` and pass them as the
 * initial `shadowed` set, since the walker enters the body without crossing
 * the boundary itself.
 */
export function collectReferencedIdentifiers(node: ts.Node, names: Set<string>, shadowed?: ReadonlySet<string>): void {
  if (ts.isIdentifier(node)) {
    if (!shadowed || !shadowed.has(node.text)) names.add(node.text);
    return;
  }
  // Track `this` keyword references so arrow functions can capture the
  // enclosing scope's `this` through the normal closure mechanism.
  if (node.kind === ts.SyntaxKind.ThisKeyword || node.kind === ts.SyntaxKind.SuperKeyword) {
    if (!shadowed || !shadowed.has("this")) names.add("this");
    return;
  }
  // (#3378) A non-computed MEMBER/PROPERTY NAME is never a free-variable
  // reference — `a.join`, the key of `{ join: x }`, or `ns.Type` name a
  // property, not a binding. The generic `forEachChild` walk below would
  // otherwise collect the `.name` Identifier and, if it collides with an
  // outer local (e.g. `parts.join('')` vs. a module-scope `let join`), record
  // a SPURIOUS capture. That capture's `outerLocalIdx` is valid only in the
  // declaring frame, so baking it into a differently-framed nested closure
  // emits a `local.get` past the closure's local count ("local index out of
  // range" — the deepEqual.js `__closure_NN` crash). Recurse only into the
  // reference-bearing children (the object/expression, the initializer, and
  // any computed key), skipping the member NAME. Optional chaining
  // (`a?.b`, `a?.[k]`) shares the same node kinds.
  if (ts.isPropertyAccessExpression(node)) {
    collectReferencedIdentifiers(node.expression, names, shadowed);
    return;
  }
  if (ts.isQualifiedName(node)) {
    collectReferencedIdentifiers(node.left, names, shadowed);
    return;
  }
  if (ts.isPropertyAssignment(node)) {
    // A computed key (`{ [k]: v }`) IS a reference; a plain identifier / string
    // / numeric key is a property name. Always recurse the initializer.
    if (ts.isComputedPropertyName(node.name)) {
      collectReferencedIdentifiers(node.name, names, shadowed);
    }
    collectReferencedIdentifiers(node.initializer, names, shadowed);
    return;
  }
  if (isFunctionScopeBoundary(node)) {
    // Augment shadow set with this nested function's own locals before
    // recursing into its body. Function/method names declared by nested
    // FunctionExpressions/ArrowFunctions don't leak out, so we don't add the
    // node's own name to the OUTER shadow set; we add it (the named func
    // expr's own name) to the inner shadow so self-references aren't treated
    // as outer captures.
    const merged = new Set<string>(shadowed ?? []);
    addFunctionOwnLocals(node, merged); // (#2103) memoized own-locals
    if (ts.isFunctionExpression(node) && node.name) merged.add(node.name.text);
    forEachChild(node, (child) => collectReferencedIdentifiers(child, names, merged));
    return;
  }
  forEachChild(node, (child) => collectReferencedIdentifiers(child, names, shadowed));
}
