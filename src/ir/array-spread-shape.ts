// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4487) Structural detector for the array-literal spread shapes the IR can
 * adopt by composing with #1804's `vec.new_fixed` literal lowering.
 *
 * `vec.new_fixed` allocates a backing array of a COMPILE-TIME count (the
 * WasmGC emitter lowers it to `array.new_fixed`, and the linear emitter to a
 * fixed `[header][len][cap][elements…]` block — see
 * `src/ir/backend/wasmgc-emitter.ts` `emitVecNewFixed`). There is no dynamic
 * `vec.new(n)` primitive in the IR today, so the only spread sources the IR
 * can lower WITHOUT inventing a new IR node kind are ones whose element count
 * is provable at compile time. Those expand element-wise into the existing
 * fixed literal, which also gives the required JS semantics for free:
 *
 *   - **copy, not alias** — `[...a]` builds a fresh vec; a later `a[0] = …`
 *     must not be observable through the result. `vec.new_fixed` allocates,
 *     so this holds by construction.
 *   - **left-to-right evaluation** — elements (spread reads included) are
 *     lowered in source order.
 *
 * Two source shapes qualify:
 *
 *   1. `inline-literal` — the spread operand is itself an array literal with
 *      no nested spread and no elision (`[...[1, 2], x]`). Its elements are
 *      inlined verbatim, exactly mirroring the already-shipped call-argument
 *      spread expansion (`isStaticSpreadSource` in `select.ts`, slice 8a).
 *   2. `fixed-const-vec` — the operand is an identifier bound by a
 *      function-local `const` whose initializer is such a literal AND whose
 *      length is provably invariant across the whole enclosing function. The
 *      lowerer emits one `vec.get` per index.
 *
 * Everything else — a spread of a parameter, of a call result, of a `let`
 * binding, of a string, or of a `const` array that could be resized or could
 * escape — has a length that is only knowable at run time and stays on
 * legacy. That residual is the genuine iterator-protocol / dynamic-length
 * gap, and it is reported under its own reject arm so the adoption matrix
 * records what is left rather than a blanket "spread".
 *
 * Deliberately checker-free and name-text based, like
 * `string-builder-shape.ts`: it must be callable from BOTH the selector
 * (`select.ts`, shape gate) and the builder (`from-ast.ts`, lowering) without
 * either importing the other, and a name-text analysis is strictly MORE eager
 * to answer "no" than a symbol-precise one. Answering "no" costs only the IR
 * fast path for that function (legacy still compiles it correctly); answering
 * a wrong "yes" would miscompile, so every uncertain use rejects.
 */
import { forEachChild, ts } from "../ts-api.js";

/** How a spread operand's elements are recovered at lowering time. */
export type SpreadSourceShape =
  /** Inline the operand literal's element expressions verbatim. */
  | { readonly kind: "inline-literal"; readonly elements: readonly ts.Expression[] }
  /**
   * Lower the operand once, then read indices `0 … length - 1` via `vec.get`.
   * `elements` are the BINDING's initializer elements — the lowerer never
   * touches them (it reads the vec), but the selector classifies the
   * element-type family from them so the existing mixed-family and
   * string-backend gates still see through the spread.
   */
  | { readonly kind: "fixed-const-vec"; readonly length: number; readonly elements: readonly ts.Expression[] };

function isFunctionScopeBoundary(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

/** Nearest enclosing function-like node (or the SourceFile at module level). */
function enclosingFunctionScope(node: ts.Node): ts.Node | undefined {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (isFunctionScopeBoundary(current) || ts.isSourceFile(current)) return current;
  }
  return undefined;
}

/** An array literal with a statically-known element count: no spread, no elision. */
function densePlainLiteral(expr: ts.Expression): ts.ArrayLiteralExpression | null {
  if (!ts.isArrayLiteralExpression(expr)) return null;
  for (const element of expr.elements) {
    if (ts.isSpreadElement(element) || ts.isOmittedExpression(element)) return null;
  }
  return expr;
}

/** True when `node` sits in a position that WRITES through the reference. */
function isWritePosition(node: ts.Node): boolean {
  const parent = node.parent;
  if (!parent) return true; // unknown position — refuse
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    // Every assignment operator (`=`, `+=`, `??=`, …) writes; `>>>=` included.
    const op = parent.operatorToken.kind;
    if (op >= ts.SyntaxKind.FirstAssignment && op <= ts.SyntaxKind.LastAssignment) return true;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    if (parent.operator === ts.SyntaxKind.PlusPlusToken || parent.operator === ts.SyntaxKind.MinusMinusToken) {
      return parent.operand === node;
    }
  }
  if (ts.isDeleteExpression(parent) && parent.expression === node) return true;
  return false;
}

/**
 * Is this occurrence of the tracked identifier provably LENGTH-PRESERVING and
 * non-escaping?
 *
 * Allowed: an in-bounds-agnostic element READ (`a[i]`), a `.length` read,
 * `for (… of a)` iteration, and being spread into an array literal. Note that
 * `a[i] = v` is refused even though it usually writes in bounds — an
 * out-of-range index EXTENDS the array, which is exactly the invariant this
 * analysis depends on. Every other position (call argument, method receiver,
 * `return a`, an object-literal value, a closure capture that does any of
 * those) can alias the vec into code that resizes it, so it refuses.
 */
function isLengthPreservingUse(id: ts.Identifier): boolean {
  const parent = id.parent;
  if (!parent) return false;
  if (ts.isElementAccessExpression(parent) && parent.expression === id) {
    return !isWritePosition(parent);
  }
  if (ts.isPropertyAccessExpression(parent) && parent.expression === id) {
    return parent.name.text === "length" && !isWritePosition(parent);
  }
  if (ts.isSpreadElement(parent) && parent.expression === id) {
    return parent.parent !== undefined && ts.isArrayLiteralExpression(parent.parent);
  }
  if (ts.isForOfStatement(parent) && parent.expression === id) return true;
  return false;
}

/** Every identifier occurrence with `name` inside `root`, in source order. */
function collectIdentifierOccurrences(root: ts.Node, name: string): ts.Identifier[] {
  const found: ts.Identifier[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && node.text === name) found.push(node);
    forEachChild(node, visit);
  };
  visit(root);
  return found;
}

/**
 * Does any declaration OTHER than `declaration` bind `name` inside `root`?
 * A second binding makes the name-text analysis ambiguous (an occurrence
 * might refer to the other binding), so the caller must refuse.
 */
function hasCompetingBinding(root: ts.Node, name: string, declaration: ts.VariableDeclaration): boolean {
  let competing = false;
  const visit = (node: ts.Node): void => {
    if (competing) return;
    if (node !== declaration) {
      const bound =
        (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) ||
        (ts.isParameter(node) && ts.isIdentifier(node.name) && node.name.text === name) ||
        (ts.isBindingElement(node) && ts.isIdentifier(node.name) && node.name.text === name) ||
        (ts.isFunctionDeclaration(node) && node.name?.text === name) ||
        (ts.isClassDeclaration(node) && node.name?.text === name) ||
        (ts.isImportSpecifier(node) && node.name.text === name);
      if (bound) {
        competing = true;
        return;
      }
    }
    forEachChild(node, visit);
  };
  visit(root);
  return competing;
}

/**
 * The `const` declaration binding `name` directly inside `scope`'s subtree,
 * or `null`. Only single-name declarators with a dense array-literal
 * initializer qualify — the initializer is what supplies the length.
 */
function denseConstArrayDeclaration(scope: ts.Node, name: string): ts.VariableDeclaration | null {
  let found: ts.VariableDeclaration | null = null;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
      densePlainLiteral(node.initializer) !== null
    ) {
      found = node;
      return;
    }
    forEachChild(node, visit);
  };
  visit(scope);
  return found;
}

/** Innermost node that delimits `const`/`let` scope for a declaration. */
function blockScopeOf(declaration: ts.Node): ts.Node | undefined {
  for (let current: ts.Node | undefined = declaration.parent; current; current = current.parent) {
    if (
      ts.isBlock(current) ||
      ts.isSourceFile(current) ||
      ts.isCaseBlock(current) ||
      ts.isModuleBlock(current) ||
      ts.isForStatement(current) ||
      ts.isForOfStatement(current) ||
      ts.isForInStatement(current) ||
      isFunctionScopeBoundary(current)
    ) {
      return current;
    }
  }
  return undefined;
}

function isDescendantOf(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * Classify one array-literal spread operand. Returns `null` when the operand's
 * element count is not provable at compile time (the legacy-owned residual).
 */
export function staticSpreadSourceShape(operand: ts.Expression): SpreadSourceShape | null {
  const inline = densePlainLiteral(operand);
  if (inline) return { kind: "inline-literal", elements: inline.elements };

  if (!ts.isIdentifier(operand)) return null;
  const scope = enclosingFunctionScope(operand);
  // Module-level `const`s are excluded on purpose: a module global can be
  // mutated by any function in the program, so a whole-function scan cannot
  // establish the invariant.
  if (!scope || ts.isSourceFile(scope)) return null;

  const declaration = denseConstArrayDeclaration(scope, operand.text);
  if (!declaration) return null;
  // The declaration must live in the SAME function scope as the spread, so the
  // subtree we scan below genuinely covers every use of this binding.
  if (enclosingFunctionScope(declaration) !== scope) return null;
  // …and the spread must actually be INSIDE the declaration's block scope, in
  // source order. Without this, `const a = [1, 2, 3];` at module level plus a
  // block-local `const a = [1, 2]` inside the function would let the
  // function-wide search bind the spread to the WRONG declaration and compile a
  // length of 2 for a source of length 3 — a miscompile, not a missed
  // optimisation. The position check likewise excludes a use before the
  // declaration (temporal dead zone).
  const declarationScope = blockScopeOf(declaration);
  if (!declarationScope || !isDescendantOf(operand, declarationScope)) return null;
  if (declaration.end > operand.pos) return null;
  if (hasCompetingBinding(scope, operand.text, declaration)) return null;

  const initializer = densePlainLiteral(declaration.initializer!);
  if (!initializer) return null;

  for (const occurrence of collectIdentifierOccurrences(scope, operand.text)) {
    if (occurrence === declaration.name) continue;
    if (!isLengthPreservingUse(occurrence)) return null;
  }
  return { kind: "fixed-const-vec", length: initializer.elements.length, elements: initializer.elements };
}

/**
 * Per-element plan for an array literal that contains at least one spread:
 * `null` when ANY spread operand is dynamic-length (the whole literal stays
 * legacy), otherwise the shape for each spread in source order.
 */
export function planArrayLiteralSpread(
  expr: ts.ArrayLiteralExpression,
): ReadonlyMap<ts.Node, SpreadSourceShape> | null {
  const plan = new Map<ts.Node, SpreadSourceShape>();
  for (const element of expr.elements) {
    if (ts.isOmittedExpression(element)) return null; // sparse — separate residual
    if (!ts.isSpreadElement(element)) continue;
    const shape = staticSpreadSourceShape(element.expression);
    if (!shape) return null;
    plan.set(element, shape);
  }
  return plan;
}
