// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6656 slice 3 (#5383 S74b) — the numeric hint for a binary operator whose
// operands are BIGINT-BRANDED i64 slots.
//
// WHAT WAS BROKEN. In untyped JS (the vendored Temporal polyfill, and every
// `.js` test body) a helper like `function mul(a, b) { return a * b; }` called
// with bigints gets bigint-branded i64 PARAMETER SLOTS from the compiler's own
// propagation — `{ kind: "i64", bigint: true }` — while the TS checker, which
// sees plain JS, types both parameters `any`. `compileBinaryExpression` then
// derives its `numericHint` from the OPERATOR (numeric ⇒ f64) without looking
// at the slots, so each operand was loaded through `f64.convert_i64_s` and the
// pair reached `compileTypedBinaryDispatch` as f64/f64. The existing
// `leftType.kind === "i64" && rightType.kind === "i64"` arm — which already
// lowers to `compileI64BinaryOp`, the exact i64 operator — was therefore
// unreachable for this shape, and the f64 round trip rounded every value past
// 2^53: `mul(6n, 7n)` answered `NaN` and `add(9007199254740992n, 1n)` answered
// `90071992547409921`.
//
// WHY THE BRAND, NOT THE SLOT KIND. A bare i64 slot is also how a native
// `type i64 = number` annotation lowers, and `/` on two of those is FLOAT
// division (§6.1.6.1.5), not `i64.div_s`. Only the `bigint: true` brand proves
// the operands are real BigInts, for which truncating division is the spec
// answer (§6.1.6.2.5). An unbranded i64 pair keeps its existing hint.
import ts from "typescript";
import type { ValType } from "../ir/types.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { compileI64BinaryOp } from "./binary-ops.js";
import type { InnerResult } from "./shared.js";
import { compileExpression } from "./shared.js";

/** A BigInt-carrying i64: the brand is what separates it from a native `type i64`. */
const BIGINT_I64: ValType = { kind: "i64", bigint: true };

/** The slot ValType an identifier operand reads, or undefined for anything else. */
function identifierSlotType(fctx: FunctionContext, expr: ts.Expression): ValType | undefined {
  if (!ts.isIdentifier(expr)) return undefined;
  const idx = fctx.localMap.get(expr.text);
  if (idx === undefined) return undefined;
  const entry = idx < fctx.params.length ? fctx.params[idx] : fctx.locals[idx - fctx.params.length];
  if (entry && typeof entry === "object" && "type" in entry) return (entry as { type: ValType }).type;
  return entry as ValType | undefined;
}

/**
 * True for an operand that is PROVABLY a BigInt at the wasm level, whatever
 * the checker says about it: a bigint literal, an identifier reading a
 * bigint-branded i64 slot, or a call to a function whose result was proven to
 * be a branded i64 (`ctx.bigIntKernelFunctions`).
 *
 * The proof is deliberately about the VALUE, not about a hint: compiling a
 * `number` operand under an i64 hint also yields an i64, and treating that as
 * evidence would make `0n === 0` answer true (§7.2.15 step 1 — different
 * Types are never strictly equal).
 */
export function isBigIntCarrierExpression(ctx: CodegenContext, fctx: FunctionContext, expr: ts.Expression): boolean {
  if (ts.isParenthesizedExpression(expr)) return isBigIntCarrierExpression(ctx, fctx, expr.expression);
  if (ts.isBigIntLiteral(expr)) return true;
  if (ts.isPrefixUnaryExpression(expr) && expr.operator === ts.SyntaxKind.MinusToken) {
    return isBigIntCarrierExpression(ctx, fctx, expr.operand);
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    return ctx.bigIntKernelFunctions.has(expr.expression.text);
  }
  const slot = identifierSlotType(fctx, expr);
  return slot?.kind === "i64" && slot.bigint === true;
}

/**
 * True when BOTH operands of a binary expression are proven BigInt carriers, so
 * the numeric hint must stay i64 instead of collapsing each side to f64.
 *
 * Deliberately narrow: an identifier reading a bigint-branded i64 slot, or a
 * bigint literal (`a * 2n`, the shape the polyfill uses most). A mixed pair is
 * left alone — the existing f64 hint and the static-bigint TypeError path in
 * `binary-ops.ts` both keep working unchanged.
 */
export function bothOperandsAreBigIntCarriers(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
): boolean {
  return isBigIntCarrierExpression(ctx, fctx, expr.left) && isBigIntCarrierExpression(ctx, fctx, expr.right);
}

/**
 * (#6656 slice 3) Does this implicit-any-return function declaration return a
 * BigInt?
 *
 * `inferNumericReturnTypes` promotes any function whose body "looks numeric"
 * to an f64 result, and `a * b` over two bigint parameters looks exactly that
 * numeric. The operator itself is now exact (see above), but an f64 RESULT
 * slot converts it straight back — `mul(1234567890123456789n, 7n)` computed
 * the right i64 and then returned a rounded double. A function proven to
 * return a BigInt gets the branded i64 carrier instead, so the value stays
 * exact across the call boundary and still boxes as a JS bigint downstream.
 *
 * `paramIsBigIntCarrier` is passed in rather than imported to keep this module
 * free of a cycle back through the inference it feeds.
 *
 * Conservative by construction: every return expression must be built only
 * from bigint literals, bigint-carrier parameters, and the arithmetic
 * operators that are closed over BigInt (§6.1.6.2). A comparison returns a
 * boolean, `**` has no i64 opcode here, and anything else — a call, a property
 * read, a conditional — answers false and leaves the existing f64 promotion
 * exactly as it was.
 */
function returnsBigIntCarrier(decl: ts.FunctionDeclaration, paramIsBigIntCarrier: (index: number) => boolean): boolean {
  if (!decl.body) return false;
  const bigIntParams = new Set<string>();
  decl.parameters.forEach((param, index) => {
    if (ts.isIdentifier(param.name) && paramIsBigIntCarrier(index)) bigIntParams.add(param.name.text);
  });

  const CLOSED_BINARY = new Set<ts.SyntaxKind>([
    ts.SyntaxKind.PlusToken,
    ts.SyntaxKind.MinusToken,
    ts.SyntaxKind.AsteriskToken,
    ts.SyntaxKind.SlashToken,
    ts.SyntaxKind.PercentToken,
    ts.SyntaxKind.AmpersandToken,
    ts.SyntaxKind.BarToken,
    ts.SyntaxKind.CaretToken,
  ]);

  const MAX_DEPTH = 32;
  const isBigIntExpr = (expr: ts.Expression, depth = 0): boolean => {
    if (depth > MAX_DEPTH) return false;
    if (ts.isParenthesizedExpression(expr)) return isBigIntExpr(expr.expression, depth + 1);
    if (ts.isBigIntLiteral(expr)) return true;
    if (ts.isIdentifier(expr)) return bigIntParams.has(expr.text);
    if (ts.isPrefixUnaryExpression(expr)) {
      // §6.1.6.2.{1,2} — unary `-` and `~` are closed over BigInt; unary `+`
      // on a BigInt is a TypeError, so it is deliberately not admitted.
      if (expr.operator !== ts.SyntaxKind.MinusToken && expr.operator !== ts.SyntaxKind.TildeToken) return false;
      return isBigIntExpr(expr.operand, depth + 1);
    }
    if (ts.isBinaryExpression(expr)) {
      if (!CLOSED_BINARY.has(expr.operatorToken.kind)) return false;
      return isBigIntExpr(expr.left, depth + 1) && isBigIntExpr(expr.right, depth + 1);
    }
    return false;
  };

  let sawReturn = false;
  let allBigInt = true;
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      if (node !== decl) return; // a nested callable's returns are its own
    }
    if (ts.isReturnStatement(node)) {
      sawReturn = true;
      if (!node.expression || !isBigIntExpr(node.expression)) allBigInt = false;
    }
    ts.forEachChild(node, walk);
  };
  ts.forEachChild(decl.body, walk);
  return sawReturn && allBigInt && bigIntParams.size > 0;
}

/**
 * (#6656 slice 3) The tail of the §7.2.15-step-1 strict-equality fold — "a
 * BigInt and a Number are never strictly equal" — for a pair whose static
 * types say the two Types are disjoint.
 *
 * WHY IT IS NOT JUST A CONSTANT. The fold reads the STATIC TS type, and in
 * untyped JS a BigInt kernel (`function mul(a, b) { return a * b; }`, both
 * parameters `any`) is typed `number` while its wasm result is a
 * bigint-branded i64. `mul(6n, 7n) === 42n` therefore compiled both sides,
 * dropped them and answered the constant `false` for two genuine BigInts.
 *
 * So the decision is made from the OPERANDS, not the static types: when both
 * are proven carriers the exact `i64.eq`/`i64.ne` is the spec answer. The
 * proof is deliberately `isBigIntCarrierExpression`, not "the i64 hint
 * produced an i64" — a `number` operand under an i64 hint is also an i64, and
 * gating on that made `0n === 0` answer TRUE.
 *
 * Everything else keeps the Type()-disjoint constant, with both operands still
 * compiled for their side effects.
 */
export function emitTypeDisjointStrictEq(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  isStrictNeq: boolean,
): ValType {
  const bothCarriers = bothOperandsAreBigIntCarriers(ctx, fctx, expr);
  const tmp = allocTempLocal(fctx, BIGINT_I64);
  const lt = compileExpression(ctx, fctx, expr.left, bothCarriers ? BIGINT_I64 : undefined);
  const rt = compileExpression(ctx, fctx, expr.right, bothCarriers ? BIGINT_I64 : undefined);
  if (bothCarriers && lt?.kind === "i64" && rt?.kind === "i64") {
    // The right operand is on top; park it so the left can be re-pushed under
    // it — `i64.eq` is commutative, but the temp keeps the stack discipline
    // identical to the other two-operand emitters here.
    fctx.body.push({ op: "local.set", index: tmp });
    fctx.body.push({ op: "local.get", index: tmp });
    releaseTempLocal(fctx, tmp);
    fctx.body.push({ op: isStrictNeq ? "i64.ne" : "i64.eq" });
    return { kind: "i32", boolean: true };
  }
  releaseTempLocal(fctx, tmp);
  if (rt) fctx.body.push({ op: "drop" });
  if (lt) fctx.body.push({ op: "drop" });
  fctx.body.push({ op: "i32.const", value: isStrictNeq ? 1 : 0 });
  return { kind: "i32" };
}

/**
 * (#6656 slice 3) The operators `compileI64BinaryOp` lowers directly and that
 * are closed over BigInt (§6.1.6.2) — the ones a proven bigint-carrier pair may
 * take without consulting the checker. Comparisons are deliberately absent:
 * they answer i32 and already work through the relational path.
 */
const I64_CLOSED_BINARY_OPS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.PlusToken,
  ts.SyntaxKind.MinusToken,
  ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken,
  ts.SyntaxKind.PercentToken,
  ts.SyntaxKind.AmpersandToken,
  ts.SyntaxKind.BarToken,
  ts.SyntaxKind.CaretToken,
]);

/**
 * (#6656 slice 3) BigInt arithmetic that reached the `$AnyValue` dispatch, or
 * undefined to decline and leave that dispatch exactly as it was.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE NUMERIC HINT. `+` is the reason. The
 * hint is only consulted for an operator the checker calls numeric, and
 * `any + any` is `any`, never `number` — so `a + b` over two bigint parameters
 * never saw the hint at all and reached the `$AnyValue` helpers, which box each
 * operand with `__any_box_f64`. Both sides were rounded to doubles and then
 * CONCATENATED as strings before `__any_add` ever ran:
 * `add(9007199254740992n, 1n)` answered `90071992547409921`.
 */
export function tryCompileBigIntCarrierArithmetic(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  op: ts.SyntaxKind,
): InnerResult | undefined {
  if (!I64_CLOSED_BINARY_OPS.has(op) || !bothOperandsAreBigIntCarriers(ctx, fctx, expr)) return undefined;
  const left = compileExpression(ctx, fctx, expr.left, BIGINT_I64);
  const right = compileExpression(ctx, fctx, expr.right, BIGINT_I64);
  if (left?.kind === "i64" && right?.kind === "i64") {
    const result = compileI64BinaryOp(ctx, fctx, op, expr);
    return result.kind === "i64" ? { kind: "i64", bigint: true } : result;
  }
  // The proof held but a hint did not materialise an i64. Both admitted operand
  // shapes — a bigint literal and an identifier reading a branded i64 slot —
  // are side-effect-free, so dropping what was emitted and declining lets the
  // ordinary dispatch re-evaluate them safely rather than leaving a half-typed
  // operator behind.
  if (right) fctx.body.push({ op: "drop" });
  if (left) fctx.body.push({ op: "drop" });
  return undefined;
}

/**
 * (#6656 slice 3) Is `stmt` a BigInt kernel — every parameter a bigint-branded
 * i64 slot and every return built only from those and operators closed over
 * BigInt? Records the name in `ctx.bigIntKernelFunctions` when it is, which is
 * what lets the `typeof` folds answer `"bigint"` for a call to it.
 *
 * WHY THE RESULT TYPE NEEDS THIS. `inferNumericReturnTypes` promotes any
 * function whose body "looks numeric" to an f64 result, and `a * b` over two
 * bigint parameters looks exactly that numeric. The operator itself is exact,
 * but an f64 RESULT slot converts it straight back:
 * `mul(1234567890123456789n, 7n)` computed the right i64 and then returned a
 * rounded double.
 */
export function recordBigIntKernel(
  ctx: CodegenContext,
  name: string,
  params: readonly ValType[],
  stmt: ts.FunctionDeclaration,
): boolean {
  const isBranded = (index: number): boolean => params[index]?.kind === "i64" && params[index]?.bigint === true;
  if (params.length === 0 || !params.every((param) => param.kind === "i64" && param.bigint === true)) return false;
  if (!returnsBigIntCarrier(stmt, isBranded)) return false;
  ctx.bigIntKernelFunctions.add(name);
  return true;
}
