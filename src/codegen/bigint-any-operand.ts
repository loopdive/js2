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
 * `emitMaybeBigIntLooseEquality` (#7373) is the `==` / `!=` counterpart, for any operand type that may hold a
 * BigInt.
 */
import { ts } from "../ts-api.js";
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import { popBody, pushBody } from "./context/bodies.js";
import { emitThrowTypeError } from "./js-errors.js";
import { flushLateImportShifts } from "./expressions/late-imports.js";
import { addUnionImports } from "./index.js";
import { coerceType, compileExpression } from "./shared.js";

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

/**
 * (#7373) `==` / `!=` when exactly one side is statically BigInt and the other may hold a BigInt at run time
 * (`typeMayBeBigInt`). A BigInt there is compared as a BigInt (§7.2.15 step 1); anything else keeps the static
 * mixed arm's ToNumber comparison, which answers NaN, so never equal, for a BigInt. Returns `undefined` having
 * emitted nothing when a helper is unavailable.
 */
export function emitMaybeBigIntLooseEquality(
  ctx: CodegenContext,
  fctx: FunctionContext,
  expr: ts.BinaryExpression,
  bigintOnLeft: boolean,
  negate: boolean,
): ValType | null | undefined {
  addUnionImports(ctx);
  if (!ctx.funcMap.has("__typeof_bigint") || !ctx.funcMap.has("__to_bigint")) return undefined;

  const operands = compileOperandLocals(ctx, fctx, expr, bigintOnLeft);
  if (operands === null) return null;
  const { anyLocal, bigLocal } = operands;

  const saved = pushBody(fctx);
  fctx.body.push(
    { op: "local.get", index: bigLocal },
    { op: "f64.convert_i64_s" },
    { op: "local.get", index: anyLocal },
  );
  coerceType(ctx, fctx, EXTERNREF, { kind: "f64" }, "number");
  fctx.body.push({ op: "f64.eq" });
  const asNumbers = fctx.body;
  popBody(fctx, saved);

  // The ToNumber coercion can register late imports; read the helper indices once those shifts are settled.
  flushLateImportShifts(ctx, fctx);
  fctx.body.push(
    { op: "local.get", index: anyLocal },
    { op: "call", funcIdx: ctx.funcMap.get("__typeof_bigint")! },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [
        { op: "local.get", index: bigLocal },
        { op: "local.get", index: anyLocal },
        { op: "call", funcIdx: ctx.funcMap.get("__to_bigint")! },
        { op: "i64.eq" },
      ],
      else: asNumbers,
    },
  );
  if (negate) fctx.body.push({ op: "i32.eqz" });
  releaseTempLocal(fctx, bigLocal);
  releaseTempLocal(fctx, anyLocal);
  return { kind: "i32" };
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
  const compileSide = (side: ts.Expression, isBigint: boolean): boolean => {
    const want = isBigint ? BIGINT_I64 : EXTERNREF;
    const got = compileExpression(ctx, fctx, side, want);
    if (got === null) return false;
    if (got.kind !== want.kind) coerceType(ctx, fctx, got, want);
    fctx.body.push({ op: "local.set", index: isBigint ? bigLocal : anyLocal });
    return true;
  };
  if (compileSide(expr.left, bigintOnLeft) && compileSide(expr.right, !bigintOnLeft)) return { anyLocal, bigLocal };
  releaseTempLocal(fctx, bigLocal);
  releaseTempLocal(fctx, anyLocal);
  return null;
}
