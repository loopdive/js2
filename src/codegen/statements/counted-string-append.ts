// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#1004) Counted-append string-loop aggregation.
 *
 * Recognizes the adversarial repeated-concat idiom
 *
 *     let s = <string>;
 *     for (let i = A; i < B; i++) s = s + FRAGMENT;   // or  s += FRAGMENT
 *
 * and lowers the whole loop to a SINGLE string operation
 *
 *     s = s + FRAGMENT.repeat(N)          where N = max(0, B - A)
 *
 * turning O(N) per-iteration concat operations (each of which crosses the
 * `wasm:js-string` host boundary or calls `__str_concat`) into one
 * `String.prototype.repeat` call plus one concat.
 *
 * The transform is applied ONLY when it is provably identical to running the
 * loop, under a deliberately tight guard:
 *
 *  - the loop counter `i` is `let`/`const`-declared in the for-head
 *    (block-scoped, so it cannot be observed after the loop) and initialized to
 *    a compile-time integer `A`;
 *  - the condition is `i < B` or `i <= B` where `B` is a compile-time integer
 *    (literal or `const`), so the iteration count `N` is a known finite
 *    non-negative integer (no `Infinity` / non-integer-bound hazards);
 *  - the incrementor is `i++`, `++i`, or `i += 1` (unit positive step);
 *  - the body is EXACTLY one statement `s = s + FRAGMENT` or `s += FRAGMENT`
 *    where `s` is a plain string-typed identifier (not `i`);
 *  - FRAGMENT is a side-effect-free, loop-invariant string value — a string
 *    literal or a string-typed identifier other than `s`/`i`. (Because the body
 *    is only the append, no other variable is mutated in the loop, so such an
 *    identifier is invariant; forbidding calls / member access rules out
 *    getters and other observable effects.)
 *
 * Under those constraints there are no intermediate observations of `s` and
 * FRAGMENT is evaluated with the same (side-effect-free) result each iteration,
 * so `s + FRAGMENT.repeat(N)` yields the byte-identical final string.
 */
import { ts } from "../../ts-api.js";
import type { TypeOracle } from "../../checker/oracle.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { compileStatement } from "../shared.js";

/** Unwrap parentheses/`as`/non-null wrappers around an expression. */
function unwrap(expr: ts.Expression): ts.Expression {
  let cur: ts.Expression = expr;
  while (
    ts.isParenthesizedExpression(cur) ||
    ts.isAsExpression(cur) ||
    ts.isNonNullExpression(cur) ||
    ts.isTypeAssertionExpression(cur)
  ) {
    cur = (cur as ts.ParenthesizedExpression | ts.AsExpression | ts.NonNullExpression | ts.TypeAssertion).expression;
  }
  return cur;
}

/**
 * Resolve a compile-time INTEGER constant: numeric literals, `const`
 * identifiers initialized to one, and unary `+`/`-` of those. Returns undefined
 * for anything non-integer or not statically known. Const resolution goes
 * through the oracle's `constInitializerOf` (which excludes `let`/`var`), so no
 * raw checker query is needed.
 */
function constIntValue(oracle: TypeOracle, expr: ts.Expression): number | undefined {
  const e = unwrap(expr);
  if (ts.isNumericLiteral(e)) {
    const n = Number(e.text);
    return Number.isInteger(n) ? n : undefined;
  }
  if (ts.isPrefixUnaryExpression(e)) {
    if (e.operator === ts.SyntaxKind.MinusToken || e.operator === ts.SyntaxKind.PlusToken) {
      const v = constIntValue(oracle, e.operand);
      if (v === undefined) return undefined;
      return e.operator === ts.SyntaxKind.MinusToken ? -v : v;
    }
    return undefined;
  }
  if (ts.isIdentifier(e)) {
    const init = oracle.constInitializerOf(e);
    if (init) return constIntValue(oracle, init);
  }
  return undefined;
}

/** True when `expr` is exactly the identifier named `name`. */
function isIdentNamed(expr: ts.Expression, name: string): boolean {
  const e = unwrap(expr);
  return ts.isIdentifier(e) && e.text === name;
}

/**
 * A safe, loop-invariant, side-effect-free STRING fragment: a string literal /
 * no-substitution template, or a string-typed identifier that is neither the
 * accumulator `s` nor the counter `i`. Calls, member access (possible getters),
 * template substitutions, etc. are rejected.
 */
function isSafeStringFragment(
  oracle: TypeOracle,
  expr: ts.Expression,
  accumName: string,
  counterName: string,
): boolean {
  const e = unwrap(expr);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return true;
  if (ts.isIdentifier(e)) {
    if (e.text === accumName || e.text === counterName) return false;
    return oracle.staticJsTypeOf(e) === "string";
  }
  return false;
}

/**
 * Extract the accumulator identifier and the appended fragment from a single
 * body statement of the form `s = s + FRAGMENT` or `s += FRAGMENT`.
 * Returns the REAL (typed) `s` read node and the REAL fragment node so the
 * synthesized replacement re-uses checker-resolvable nodes.
 */
function matchAppendBody(stmt: ts.Statement): { accum: ts.Identifier; fragment: ts.Expression } | undefined {
  let exprStmt: ts.Statement = stmt;
  if (ts.isBlock(stmt)) {
    if (stmt.statements.length !== 1) return undefined;
    exprStmt = stmt.statements[0]!;
  }
  if (!ts.isExpressionStatement(exprStmt)) return undefined;
  const expr = exprStmt.expression;
  if (!ts.isBinaryExpression(expr)) return undefined;

  // `s += FRAGMENT`
  if (expr.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
    const lhs = unwrap(expr.left);
    if (!ts.isIdentifier(lhs)) return undefined;
    return { accum: lhs, fragment: expr.right };
  }

  // `s = s + FRAGMENT`
  if (expr.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    const target = unwrap(expr.left);
    if (!ts.isIdentifier(target)) return undefined;
    const rhs = unwrap(expr.right);
    if (!ts.isBinaryExpression(rhs) || rhs.operatorToken.kind !== ts.SyntaxKind.PlusToken) return undefined;
    // Append shape only: `s = s + FRAGMENT` (accumulator on the LEFT of `+`).
    if (!isIdentNamed(rhs.left, target.text)) return undefined;
    const accumRead = unwrap(rhs.left);
    if (!ts.isIdentifier(accumRead)) return undefined;
    return { accum: accumRead, fragment: rhs.right };
  }

  return undefined;
}

/** Match `i++`, `++i`, or `i += 1` (unit positive step on `name`). */
function isUnitIncrement(oracle: TypeOracle, incr: ts.Expression | undefined, name: string): boolean {
  if (!incr) return false;
  const e = unwrap(incr);
  if (ts.isPostfixUnaryExpression(e) || ts.isPrefixUnaryExpression(e)) {
    return e.operator === ts.SyntaxKind.PlusPlusToken && isIdentNamed(e.operand, name);
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
    return isIdentNamed(e.left, name) && constIntValue(oracle, e.right) === 1;
  }
  return false;
}

/**
 * If `stmt` matches the counted string-append idiom, emit the aggregated
 * `s = s + FRAGMENT.repeat(N)` lowering and return true. Otherwise return false
 * (the caller compiles the loop normally).
 */
export function tryCompileCountedStringAppend(
  ctx: CodegenContext,
  fctx: FunctionContext,
  stmt: ts.ForStatement,
): boolean {
  const oracle = ctx.oracle;
  const { initializer, condition, incrementor, statement } = stmt;
  if (!initializer || !condition || !incrementor) return false;

  // init: `let i = A` (single block-scoped integer counter)
  if (!ts.isVariableDeclarationList(initializer)) return false;
  if ((initializer.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) return false;
  if (initializer.declarations.length !== 1) return false;
  const decl = initializer.declarations[0]!;
  if (!ts.isIdentifier(decl.name) || !decl.initializer) return false;
  const counterName = decl.name.text;
  const start = constIntValue(oracle, decl.initializer);
  if (start === undefined) return false;

  // cond: `i < B` or `i <= B` with compile-time integer B
  if (!ts.isBinaryExpression(condition)) return false;
  const condOp = condition.operatorToken.kind;
  if (condOp !== ts.SyntaxKind.LessThanToken && condOp !== ts.SyntaxKind.LessThanEqualsToken) return false;
  if (!isIdentNamed(condition.left, counterName)) return false;
  const bound = constIntValue(oracle, condition.right);
  if (bound === undefined) return false;

  // incrementor: unit positive step
  if (!isUnitIncrement(oracle, incrementor, counterName)) return false;

  // body: `s = s + FRAGMENT` / `s += FRAGMENT`
  const matched = matchAppendBody(statement);
  if (!matched) return false;
  const { accum, fragment } = matched;
  if (accum.text === counterName) return false;
  if (oracle.staticJsTypeOf(accum) !== "string") return false;
  if (!isSafeStringFragment(oracle, fragment, accum.text, counterName)) return false;

  // Iteration count N = number of times the body runs.
  const rawCount = condOp === ts.SyntaxKind.LessThanToken ? bound - start : bound - start + 1;
  const count = rawCount > 0 ? rawCount : 0;

  // N === 0 → loop never runs; the accumulator keeps its value (emit nothing).
  if (count === 0) return true;

  // N === 1 → a single append; let the normal loop path handle it (no repeat
  // machinery needed, avoids a needless `.repeat(1)`).
  if (count === 1) return false;

  // Synthesize `accum += fragment.repeat(N)` re-using the REAL, checker-typed
  // `accum` (string) and `fragment` nodes so type resolution and string-concat
  // routing behave exactly as for hand-written source.
  const countLit = ts.factory.createNumericLiteral(String(count));
  const repeatProp = ts.factory.createPropertyAccessExpression(fragment, "repeat");
  ts.setTextRange(repeatProp, fragment);
  (repeatProp as unknown as { parent: ts.Node }).parent = stmt;
  const repeatCall = ts.factory.createCallExpression(repeatProp, undefined, [countLit]);
  ts.setTextRange(repeatCall, stmt);
  (repeatCall as unknown as { parent: ts.Node }).parent = stmt;
  (countLit as unknown as { parent: ts.Node }).parent = repeatCall;

  const assign = ts.factory.createBinaryExpression(accum, ts.SyntaxKind.PlusEqualsToken, repeatCall);
  ts.setTextRange(assign, stmt);
  (assign as unknown as { parent: ts.Node }).parent = stmt;
  const exprStmt = ts.factory.createExpressionStatement(assign);
  ts.setTextRange(exprStmt, stmt);
  (exprStmt as unknown as { parent: ts.Node }).parent = stmt.parent;

  compileStatement(ctx, fctx, exprStmt);
  return true;
}
