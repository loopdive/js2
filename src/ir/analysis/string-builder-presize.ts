// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1761 / (#7291) The presize analysis of a `let s = ""; for (…) s += …`
 * builder, shared by legacy's #1210 rewrite and the IR builder lowering.
 */
import { forEachChild, ts } from "../../ts-api.js";
import { readEnv } from "../../env.js";

/**
 * #1761 — presize info for a string-builder whose final length is provably a
 * runtime-known linear function of a loop bound. When the build loop is a
 * canonical `for (let i = 0; i < BOUND; i++)` (step +1) whose body appends a
 * statically-fixed number of code units per iteration and never exits early,
 * the final buffer length is exactly `BOUND * unitsPerIter`. Presizing the
 * WasmGC i16 buffer to that length up front eliminates every doubling
 * reallocation AND lets the per-append `len+1 > cap` cap-check be removed
 * (the capacity is proven sufficient for all appends). See #1746 lever #3.
 */
export interface StringBuilderPresizeInfo {
  /** Loop-invariant bound expression, evaluated once at buffer-init time. */
  boundExpr: ts.Expression;
  /** Constant code-unit count appended per loop iteration (the exact total
   *  is `boundExpr * unitsPerIter`). */
  unitsPerIter: number;
}

/**
 * #1761 — try to prove the builder's final length is `bound * unitsPerIter`.
 *
 * Preconditions (all required; any failure → no presize, keep doubling buffer):
 *   1. The loop is `for (let i = INIT; i < BOUND; i++)` with INIT a constant
 *      and the step a `i++` / `i += 1` over the same counter. (`<=` is
 *      rejected here for simplicity — it changes the trip count by one.)
 *   2. INIT === 0. (A non-zero start would make the count `BOUND - INIT`; we
 *      keep the common case and bail otherwise.)
 *   3. BOUND is loop-invariant: a numeric literal, or an identifier whose
 *      binding is never written inside the loop body. Evaluating it once at
 *      buffer-init time (before the loop) yields the same value the loop sees.
 *   4. The loop body contains NO `break` / `continue` / `return` / `throw`
 *      (which could cut the iteration count short) — though a short run only
 *      *under*-fills the presized buffer, we reject to keep the bound exact
 *      and the analysis simple.
 *   5. Every `s += <expr>` in the body appends a statically-fixed code-unit
 *      count (a 1-char literal → 1, a k-char literal → k, `X.charAt(i)` → 1),
 *      and the appends are unconditional (not nested under an `if`/loop).
 *      Then per-iteration units is the constant sum, identical every pass.
 */
export function planStringBuilderPresize(
  checker: ts.TypeChecker,
  decl: ts.VariableDeclaration,
  loop: ts.IterationStatement,
): StringBuilderPresizeInfo | null {
  // Escape hatch / A-B harness: disable the presize to compare against the
  // doubling-buffer baseline (used by the #1760 warm benchmark and as a
  // safety valve if a regression is ever traced here).
  if (readEnv("JS2WASM_DISABLE_STRING_PRESIZE") === "1") return null;
  // (1) canonical for-loop shape.
  if (!ts.isForStatement(loop)) return null;
  if (!loop.initializer || !loop.condition || !loop.incrementor) return null;

  // Counter binding from `let i = <const>`.
  if (!ts.isVariableDeclarationList(loop.initializer)) return null;
  if (loop.initializer.declarations.length !== 1) return null;
  const counterDecl = loop.initializer.declarations[0]!;
  if (!ts.isIdentifier(counterDecl.name)) return null;
  if (!counterDecl.initializer || !ts.isNumericLiteral(counterDecl.initializer)) return null;
  if (Number(counterDecl.initializer.text) !== 0) return null; // (2) INIT === 0
  const counterSym = checker.getSymbolAtLocation(counterDecl.name);
  if (!counterSym) return null;

  // (1) condition `i < BOUND`.
  if (!ts.isBinaryExpression(loop.condition)) return null;
  if (loop.condition.operatorToken.kind !== ts.SyntaxKind.LessThanToken) return null;
  if (!ts.isIdentifier(loop.condition.left)) return null;
  if (checker.getSymbolAtLocation(loop.condition.left) !== counterSym) return null;
  const boundExpr = loop.condition.right;

  // (1) incrementor `i++` / `++i` / `i += 1`.
  if (!isUnitIncrementOf(checker, loop.incrementor, counterSym)) return null;

  // (3) BOUND is loop-invariant.
  if (!isLoopInvariantBound(checker, boundExpr, loop.statement, counterSym)) return null;

  // (4) + (5): walk the body once, summing per-iteration units and rejecting
  // early-exit / conditional appends.
  const units = sumUnconditionalAppendUnits(checker, decl, loop.statement);
  if (units === null) return null;
  if (units <= 0) return null; // nothing to presize (or unknown) → keep doubling

  return { boundExpr, unitsPerIter: units };
}

/** True if `incr` is `i++`, `++i`, or `i += 1` for the counter symbol. */
function isUnitIncrementOf(checker: ts.TypeChecker, incr: ts.Expression, counterSym: ts.Symbol): boolean {
  if (ts.isPostfixUnaryExpression(incr) || ts.isPrefixUnaryExpression(incr)) {
    if (incr.operator !== ts.SyntaxKind.PlusPlusToken) return false;
    if (!ts.isIdentifier(incr.operand)) return false;
    return checker.getSymbolAtLocation(incr.operand) === counterSym;
  }
  if (ts.isBinaryExpression(incr) && incr.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
    if (!ts.isIdentifier(incr.left)) return false;
    if (checker.getSymbolAtLocation(incr.left) !== counterSym) return false;
    return ts.isNumericLiteral(incr.right) && Number(incr.right.text) === 1;
  }
  return false;
}

/**
 * True if `boundExpr` is loop-invariant and safe to evaluate once before the
 * loop: a numeric literal, or an identifier whose binding is the loop counter
 * (rejected — that would not be invariant) excluded, or an identifier whose
 * binding is never assigned within `body`. Conservative: anything else → false.
 */
function isLoopInvariantBound(
  checker: ts.TypeChecker,
  boundExpr: ts.Expression,
  body: ts.Node,
  counterSym: ts.Symbol,
): boolean {
  if (ts.isNumericLiteral(boundExpr)) return true;
  if (!ts.isIdentifier(boundExpr)) return false;
  const boundSym = checker.getSymbolAtLocation(boundExpr);
  if (!boundSym) return false;
  if (boundSym === counterSym) return false; // `i < i` is degenerate
  // Reject if `boundExpr`'s binding is written anywhere inside the body.
  let written = false;
  function visit(node: ts.Node): void {
    if (written) return;
    if (isFunctionScopeBoundary(node)) return;
    // Assignment LHS.
    if (ts.isBinaryExpression(node)) {
      const op = node.operatorToken.kind;
      const isAssign =
        op === ts.SyntaxKind.EqualsToken ||
        op === ts.SyntaxKind.PlusEqualsToken ||
        op === ts.SyntaxKind.MinusEqualsToken ||
        op === ts.SyntaxKind.AsteriskEqualsToken ||
        op === ts.SyntaxKind.SlashEqualsToken ||
        op === ts.SyntaxKind.PercentEqualsToken;
      if (isAssign && ts.isIdentifier(node.left) && checker.getSymbolAtLocation(node.left) === boundSym) {
        written = true;
        return;
      }
    }
    // ++/-- on the bound.
    if (
      (ts.isPostfixUnaryExpression(node) || ts.isPrefixUnaryExpression(node)) &&
      ts.isIdentifier(node.operand) &&
      checker.getSymbolAtLocation(node.operand) === boundSym
    ) {
      written = true;
      return;
    }
    forEachChild(node, visit);
  }
  visit(body);
  return !written;
}

/**
 * Walk the loop body and return the constant number of code units appended to
 * the builder per iteration, or `null` if the count is not statically fixed
 * (conditional/looped append, variable-length RHS) or if the body contains a
 * control-flow construct that could change the iteration count
 * (`break`/`continue`/`return`/`throw`). The appends must be unconditional —
 * direct statements of the loop body (or its top-level block), never nested
 * inside an inner `if`/loop/try.
 */
function sumUnconditionalAppendUnits(
  checker: ts.TypeChecker,
  decl: ts.VariableDeclaration,
  body: ts.Node,
): number | null {
  const declSym = checker.getSymbolAtLocation(decl.name);
  if (!declSym) return null;

  // Flatten the body into its top-level statement list. A single statement
  // body (`for (...) s += "x";`) is treated as a one-element list.
  const stmts: readonly ts.Statement[] = ts.isBlock(body) ? body.statements : [body as ts.Statement];

  let total = 0;
  for (const stmt of stmts) {
    // Any nested control-flow that can short-circuit the trip count or make an
    // append conditional disqualifies the loop. We only admit
    // ExpressionStatements and plain `const`/`let` decls with no `s` append.
    if (
      ts.isBreakStatement(stmt) ||
      ts.isContinueStatement(stmt) ||
      ts.isReturnStatement(stmt) ||
      ts.isThrowStatement(stmt)
    ) {
      return null;
    }
    // A nested statement that might *contain* an `s` append under a branch, or
    // a break/continue/return/throw, disqualifies. Detect by checking whether
    // the statement references the builder or contains abrupt control flow.
    if (
      ts.isIfStatement(stmt) ||
      ts.isIterationStatement(stmt, /*lookInLabeledStatements*/ true) ||
      ts.isSwitchStatement(stmt) ||
      ts.isTryStatement(stmt) ||
      ts.isLabeledStatement(stmt) ||
      ts.isBlock(stmt)
    ) {
      if (statementMutatesBuilderOrExitsLoop(checker, stmt, declSym)) return null;
      // Otherwise the nested statement is irrelevant to the builder (e.g. a
      // bookkeeping `if`) and contributes 0 units.
      continue;
    }
    if (ts.isExpressionStatement(stmt)) {
      const units = appendUnitsOfExpression(checker, stmt.expression, declSym);
      if (units === null) return null; // an `s += <variable-length>` → bail
      total += units;
      continue;
    }
    // `const a = ...;` style bookkeeping decls are fine as long as they don't
    // reference the builder (they can't append to it). Reject if they do.
    if (ts.isVariableStatement(stmt)) {
      if (referencesSymbol(checker, stmt, declSym)) return null;
      continue;
    }
    // Anything else (e.g. nested function decl) — be conservative.
    if (referencesSymbol(checker, stmt, declSym)) return null;
  }
  return total;
}

/**
 * For an ExpressionStatement's expression, return the code-unit count it
 * appends to the builder, 0 if it doesn't touch the builder, or `null` if it
 * appends a variable-length value (so the per-iteration count is not fixed).
 */
function appendUnitsOfExpression(checker: ts.TypeChecker, expr: ts.Expression, declSym: ts.Symbol): number | null {
  // Comma expression: sum each operand.
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    const l = appendUnitsOfExpression(checker, expr.left, declSym);
    if (l === null) return null;
    const r = appendUnitsOfExpression(checker, expr.right, declSym);
    if (r === null) return null;
    return l + r;
  }
  // `s += <rhs>` where `s` is the builder.
  if (
    ts.isBinaryExpression(expr) &&
    expr.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken &&
    ts.isIdentifier(expr.left) &&
    checker.getSymbolAtLocation(expr.left) === declSym
  ) {
    return staticAppendUnitsOfRhs(checker, expr.right);
  }
  // An expression that doesn't append to the builder but still references it
  // (e.g. reads `s.length`) — a read forces materialisation and is fine for
  // correctness, but reading mid-build means the presize length still holds.
  // It contributes 0 appended units.
  if (referencesSymbol(checker, expr, declSym)) {
    // Only allow READS — any write/`+=`/assignment was handled above. A
    // postfix/prefix on `s` (nonsensical for strings) → bail.
    if (
      (ts.isPostfixUnaryExpression(expr) || ts.isPrefixUnaryExpression(expr)) &&
      ts.isIdentifier(expr.operand) &&
      checker.getSymbolAtLocation(expr.operand) === declSym
    ) {
      return null;
    }
    // A bare `s = ...` assignment (handled separately by validateNoOtherWrites
    // which would have rejected the builder) — but defensively bail here too.
    if (
      ts.isBinaryExpression(expr) &&
      expr.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(expr.left) &&
      checker.getSymbolAtLocation(expr.left) === declSym
    ) {
      return null;
    }
    return 0;
  }
  return 0;
}

/**
 * Constant code-unit count of a `+=` RHS, or `null` if not statically fixed.
 *   - string literal `"abc"` → its `.length` (UTF-16 code units)
 *   - `X.charAt(i)` on a string receiver → exactly 1 code unit
 * Anything else (numbers, variables, concatenations, `X.substring(...)`, etc.)
 * → `null`.
 */
function staticAppendUnitsOfRhs(checker: ts.TypeChecker, rhs: ts.Expression): number | null {
  if (ts.isStringLiteral(rhs)) {
    // `.length` is the UTF-16 code-unit count, which is exactly what the
    // builder appends. `rhs.text` is the decoded value, so its JS `.length`
    // (code units) is correct including surrogate pairs.
    return rhs.text.length;
  }
  if (ts.isNoSubstitutionTemplateLiteral(rhs)) {
    return rhs.text.length;
  }
  // `X.charAt(i)` on a static-string receiver appends exactly one code unit.
  if (
    ts.isCallExpression(rhs) &&
    ts.isPropertyAccessExpression(rhs.expression) &&
    rhs.expression.name.text === "charAt" &&
    rhs.arguments.length <= 1
  ) {
    const recvType = checker.getTypeAtLocation(rhs.expression.expression);
    if ((recvType.flags & ts.TypeFlags.StringLike) !== 0) return 1;
  }
  return null;
}

/** Does `node`'s subtree reference the symbol (any identifier resolving to it)? */
function referencesSymbol(checker: ts.TypeChecker, node: ts.Node, sym: ts.Symbol): boolean {
  let found = false;
  function visit(n: ts.Node): void {
    if (found) return;
    if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === sym) {
      found = true;
      return;
    }
    forEachChild(n, visit);
  }
  visit(node);
  return found;
}

/**
 * For a nested statement (if/loop/switch/try/block/labeled), return true if it
 * either mutates the builder (`s += ...`, `s = ...`, `s++`) or contains a
 * loop-exiting construct (`break`/`continue`/`return`/`throw`) for the BUILDER
 * loop. Either condition disqualifies the exact-length presize.
 */
function statementMutatesBuilderOrExitsLoop(checker: ts.TypeChecker, stmt: ts.Node, declSym: ts.Symbol): boolean {
  let bad = false;
  function visit(n: ts.Node): void {
    if (bad) return;
    if (isFunctionScopeBoundary(n)) return; // closures handled separately
    // Loop-exiting / function-exiting control flow inside the body.
    if (ts.isBreakStatement(n) || ts.isContinueStatement(n) || ts.isReturnStatement(n) || ts.isThrowStatement(n)) {
      bad = true;
      return;
    }
    // Builder mutation: `s += ...` / `s = ...` / `s++`.
    if (
      ts.isBinaryExpression(n) &&
      ts.isIdentifier(n.left) &&
      checker.getSymbolAtLocation(n.left) === declSym &&
      (n.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken || n.operatorToken.kind === ts.SyntaxKind.EqualsToken)
    ) {
      bad = true;
      return;
    }
    if (
      (ts.isPostfixUnaryExpression(n) || ts.isPrefixUnaryExpression(n)) &&
      ts.isIdentifier(n.operand) &&
      checker.getSymbolAtLocation(n.operand) === declSym
    ) {
      bad = true;
      return;
    }
    forEachChild(n, visit);
  }
  visit(stmt);
  return bad;
}

/** A nested function scope: a builder analysis never looks inside one. */
export function isFunctionScopeBoundary(node: ts.Node): boolean {
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
