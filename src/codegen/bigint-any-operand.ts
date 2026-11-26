// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5383) `<any> op <bigint>` without a JS host.
 *
 * `binary-ops.ts` treats a BigInt operand paired with a non-BigInt one as a
 * provable §13.15.3 mix and throws. That is right for a statically
 * number/string/boolean operand. For an `any`/`unknown` one it is only right
 * when the operand is not a BigInt at runtime. The JS-host lane hands the
 * whole operator to `__host_bigint_binop` (#3481). Standalone had no
 * counterpart, so every BigInt that crossed an untyped boundary stopped
 * working: `Temporal.Now.instant().epochNanoseconds / 1000000n` threw
 * "Cannot mix BigInt and other types".
 *
 * This emits the missing native arm for the same `any`/`unknown` operand
 * shape:
 * 1. Both operands are evaluated first, in source order (§13.15.4 step 1-4
 *    evaluates both before ApplyStringOrNumericBinaryOperator runs).
 * 2. If the `any` side is not a BigInt (`__typeof_bigint`), the same TypeError
 *    as before is thrown.
 * 3. Otherwise `__to_bigint` unboxes it to i64 and the ordinary i64 lowering
 *    runs.
 *
 * A BigInt WRAPPER (`Object(2n)`) still takes the TypeError: `__typeof_bigint`
 * answers false for it. That matches the standalone behaviour before this
 * change, which threw for every operand of this shape.
 *
 * `emitMaybeBigIntComparison` (#7373, #7403) is the equality and relational counterpart, for any operand type
 * that may hold a BigInt.
 */
import { ts } from "../ts-api.js";
import { typeMayBeBigInt } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import { popBody, pushBody } from "./context/bodies.js";
import { emitThrowTypeError } from "./js-errors.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import { addUnionImports } from "./index.js";
import { coerceType, compileExpression } from "./shared.js";
import { wideBigIntComparisons, wideBigIntConstantOf } from "./bigint-wide.js";

const EXTERNREF: ValType = { kind: "externref" };
const BIGINT_I64: ValType = { kind: "i64", bigint: true };

/**
 * Emit `expr` when exactly one side is statically BigInt and the other is
 * `any`/`unknown`, under a lane with no JS host. Returns `undefined` having
 * emitted NOTHING when a helper is unavailable, so the caller's throw stays in
 * place. `emitI64Op` pushes the i64 operator for `[left, right]` on the stack.
 */
export function emitStandaloneAnyBigIntBinary(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  bigintOnLeft: boolean,
  otherTsType: ts.Type,
  hostBinopCode: number | undefined,
  emitI64Op: () => ValType,
): ValType | null | undefined {
  if ((otherTsType.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) === 0) return undefined;
  if (hostBinopCode === undefined || expr.operatorToken.kind === ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken) {
    return undefined;
  }
  addUnionImports(ctx);
  flushLateImportShifts(ctx, fctx);
  const typeofBigintIdx = ctx.funcMap.get("__typeof_bigint");
  const toBigintIdx = ctx.funcMap.get("__to_bigint");
  if (typeofBigintIdx === undefined || toBigintIdx === undefined) return undefined;

  const operands = compileOperandLocals(ctx, fctx, expr, bigintOnLeft);
  if (operands === null) return null;
  const { anyLocal, bigLocal } = operands;

  const saved = pushBody(fctx);
  emitThrowTypeError(ctx, fctx, "Cannot mix BigInt and other types, use explicit conversions");
  const throwInstrs = fctx.body;
  popBody(fctx, saved);

  const anyAsI64: Instr[] = [
    { op: "local.get", index: anyLocal },
    { op: "call", funcIdx: toBigintIdx },
  ];
  fctx.body.push(
    { op: "local.get", index: anyLocal },
    { op: "call", funcIdx: typeofBigintIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: throwInstrs },
  );
  if (bigintOnLeft) fctx.body.push({ op: "local.get", index: bigLocal }, ...anyAsI64);
  else fctx.body.push(...anyAsI64, { op: "local.get", index: bigLocal });
  releaseTempLocal(fctx, bigLocal);
  releaseTempLocal(fctx, anyLocal);

  const result = emitI64Op();
  return result.kind === "i64" ? BIGINT_I64 : result;
}

/** The i64 (BigInt), i32 (an ordering against 0) and f64 (ToNumber) form of each comparison, and `==`'s answer for null. */
interface ComparisonOps {
  readonly i64: "i64.eq" | "i64.ne" | "i64.lt_s" | "i64.le_s" | "i64.gt_s" | "i64.ge_s";
  readonly i32: "i32.eq" | "i32.ne" | "i32.lt_s" | "i32.le_s" | "i32.gt_s" | "i32.ge_s";
  readonly f64: "f64.eq" | "f64.ne" | "f64.lt" | "f64.le" | "f64.gt" | "f64.ge";
  readonly onNull?: 0 | 1;
}

const COMPARISONS = new Map<ts.SyntaxKind, ComparisonOps>([
  [ts.SyntaxKind.EqualsEqualsToken, { i64: "i64.eq", i32: "i32.eq", f64: "f64.eq", onNull: 0 }],
  [ts.SyntaxKind.ExclamationEqualsToken, { i64: "i64.ne", i32: "i32.ne", f64: "f64.ne", onNull: 1 }],
  [ts.SyntaxKind.LessThanToken, { i64: "i64.lt_s", i32: "i32.lt_s", f64: "f64.lt" }],
  [ts.SyntaxKind.LessThanEqualsToken, { i64: "i64.le_s", i32: "i32.le_s", f64: "f64.le" }],
  [ts.SyntaxKind.GreaterThanToken, { i64: "i64.gt_s", i32: "i32.gt_s", f64: "f64.gt" }],
  [ts.SyntaxKind.GreaterThanEqualsToken, { i64: "i64.ge_s", i32: "i32.ge_s", f64: "f64.ge" }],
]);

/**
 * The statically-BigInt operand: its Number value, and the comparison's answer against a BigInt held by the other.
 * `againstBigInt` is built only once the ToNumber coercion's late imports have settled, since it bakes helper indices.
 */
interface BigIntSide {
  readonly asNumber: Instr[];
  readonly againstBigInt: () => Instr[];
}

/**
 * (#7373, #7403) `==`, `!=`, `<`, `<=`, `>`, `>=` when exactly one side is statically BigInt and the other may hold a
 * BigInt at run time (`typeMayBeBigInt(otherTsType)`). A BigInt there is compared as a BigInt (§7.2.15 step 1,
 * §7.2.13 step 3), exactly past 64 bits: the static side runs on the i64 lane, where a `$BigIntWide` on the other
 * side orders by its sign, unless it is a constant outside the i64 range, which is compared with the carrier
 * ordering. For `==` / `!=`, `null` is loosely equal only to `null` / `undefined` (§7.2.15 steps 2–3), so it answers
 * before ToNumber would turn it into 0. Anything else keeps the static mixed arm's ToNumber comparison. Returns
 * `undefined` having emitted nothing for any other operator or operand, or when a helper is unavailable.
 */
export function emitMaybeBigIntComparison(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  bigintOnLeft: boolean,
  otherTsType: ts.Type,
): ValType | null | undefined {
  const ops = COMPARISONS.get(expr.operatorToken.kind);
  if (ops === undefined || !typeMayBeBigInt(otherTsType)) return undefined;
  addUnionImports(ctx);
  const wide = wideBigIntComparisons(ctx);
  if (wide === undefined || !ctx.funcMap.has("__typeof_bigint") || !ctx.funcMap.has("__to_bigint")) return undefined;

  const inSourceOrder = (big: Instr[], other: Instr[]): Instr[] =>
    bigintOnLeft ? [...big, ...other] : [...other, ...big];
  // `ordering` is the other operand against the BigInt one (-1, 0, 1); the BigInt side stands in as 0.
  const againstZero = (ordering: Instr[]): Instr[] => [
    ...inSourceOrder([{ op: "i32.const", value: 0 }], ordering),
    { op: ops.i32 },
  ];
  const wideConstant = wideBigIntConstantOf(ctx, fctx, bigintOnLeft ? expr.left : expr.right);
  let anyLocal: number;
  let bigLocal: number | undefined;
  let side: BigIntSide;
  if (wideConstant !== undefined) {
    // A constant has no effects: only the other operand is evaluated.
    anyLocal = allocTempLocal(fctx, EXTERNREF);
    if (!compileInto(ctx, fctx, bigintOnLeft ? expr.right : expr.left, EXTERNREF, anyLocal)) {
      releaseTempLocal(fctx, anyLocal);
      return null;
    }
    side = {
      asNumber: [{ op: "f64.const", value: Number(wideConstant) }],
      againstBigInt: () => againstZero(wide.compare(anyLocal, wideConstant)),
    };
  } else {
    const operands = compileOperandLocals(ctx, fctx, expr, bigintOnLeft);
    if (operands === null) return null;
    ({ anyLocal, bigLocal } = operands);
    side = {
      asNumber: [{ op: "local.get", index: bigLocal }, { op: "f64.convert_i64_s" }],
      againstBigInt: () => [
        ...wide.isWide(anyLocal),
        {
          op: "if",
          blockType: { kind: "val", type: { kind: "i32" } },
          then: againstZero(wide.sign(anyLocal)),
          else: [
            ...inSourceOrder(
              [{ op: "local.get", index: bigLocal }],
              [
                { op: "local.get", index: anyLocal },
                { op: "call", funcIdx: ctx.funcMap.get("__to_bigint")! },
              ],
            ),
            { op: ops.i64 },
          ],
        },
      ],
    };
  }

  const saved = pushBody(fctx);
  fctx.body.push({ op: "local.get", index: anyLocal });
  coerceType(ctx, fctx, EXTERNREF, { kind: "f64" }, "number");
  const otherAsNumber = fctx.body;
  popBody(fctx, saved);
  const asNumbers: Instr[] = [...inSourceOrder(side.asNumber, otherAsNumber), { op: ops.f64 }];
  const notBigInt: Instr[] =
    ops.onNull === undefined
      ? asNumbers
      : [
          { op: "local.get", index: anyLocal },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: ops.onNull }],
            else: asNumbers,
          },
        ];
  flushLateImportShifts(ctx, fctx);
  fctx.body.push(
    { op: "local.get", index: anyLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__typeof_bigint")! },
    { op: "if", blockType: { kind: "val", type: { kind: "i32" } }, then: side.againstBigInt(), else: notBigInt },
  );
  if (bigLocal !== undefined) releaseTempLocal(fctx, bigLocal);
  releaseTempLocal(fctx, anyLocal);
  return { kind: "i32" };
}

/** Compile `side` as `want` into `local`; false when it did not compile. */
function compileInto(
  ctx: CodegenContext,
  fctx: FunctionContext,
  side: ts.Expression,
  want: ValType,
  local: number,
): boolean {
  const got = compileExpression(ctx, fctx, side, want);
  if (got === null) return false;
  if (got.kind !== want.kind) coerceType(ctx, fctx, got, want);
  fctx.body.push({ op: "local.set", index: local });
  return true;
}

/** Evaluate both operands in source order into an i64 local (the BigInt side) and an externref local (the other). */
function compileOperandLocals(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  bigintOnLeft: boolean,
): { anyLocal: number; bigLocal: number } | null {
  const anyLocal = allocTempLocal(fctx, EXTERNREF);
  const bigLocal = allocTempLocal(fctx, BIGINT_I64);
  const compileSide = (side: ts.Expression, isBigint: boolean): boolean =>
    compileInto(ctx, fctx, side, isBigint ? BIGINT_I64 : EXTERNREF, isBigint ? bigLocal : anyLocal);
  if (compileSide(expr.left, bigintOnLeft) && compileSide(expr.right, !bigintOnLeft)) return { anyLocal, bigLocal };
  releaseTempLocal(fctx, bigLocal);
  releaseTempLocal(fctx, anyLocal);
  return null;
}
