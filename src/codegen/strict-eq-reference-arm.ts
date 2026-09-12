// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5357) The reference-equality arm of `===` / `!==` (and `==` / `!=`) for an
 * operand pair whose §6.1 `Type()` cannot be decided from the static types —
 * in ONE place for both lanes, so a scalar that meets a reference is compared
 * by the language's own algorithm instead of a ToNumber collapse.
 *
 * ## The defect
 *
 * `x === false` answered `true` when `x` was a nullish REFERENCE. The tail of
 * the externref-equality block in `binary-ops-typed-dispatch.ts` widened the
 * Boolean to `f64`, put the reference through `__unbox_number` (§7.1.4
 * ToNumber: `null → 0`, `"0" → 0`, `true → 1`, `[0] → 0`) and compared with
 * `f64.eq` — `Number(null) === Number(false)`. §7.2.16 step 1 says
 * `Type(x) ≠ Type(y)` ⇒ `false`, with no coercion at all. The arm that
 * implements that — `__host_eq` (JS `===`) in the host lane, the #1776 tag
 * dispatch under `semanticProviders === "native-first"` — excluded the pair
 * twice: once because a Boolean scalar is an `i32`, not an `externref`, and
 * once because its static type IS Boolean. So a `const n = null`, a call typed
 * `null | string`, and above all an `any`-typed `onEnter?.(doc) === false`
 * (prettier's `traverseDoc`; `tests/unit/is-empty-doc.js` 7/16) all fell into
 * the collapse. The same collapse made `x === true` answer `true` for an `x`
 * holding the number `1`.
 *
 * ## The fix
 *
 * Box the scalar by its BRAND — a Boolean through `__box_boolean`, so its
 * runtime tag stays Boolean (`coerceType`'s #2785 arm; the bare number box
 * turns `true` into `1`, which is exactly the `x === true` defect one level
 * down) — then compare in the lane's reference arm:
 *
 * - host lane: `__host_eq` / `__host_loose_eq`, emitted by
 *   `emitHostEqualityFromStack` (coercion-engine.ts), which stays the single
 *   place that names those imports;
 * - native-first: `__extern_strict_eq` (#1461 — `ref.eq` identity, then the
 *   `$AnyValue` primitive comparison) for `===`, and `__any_eq` through
 *   `emitAnyEqFromExternTemps` for `==`.
 *
 * The typed dispatch's native tag-dispatch block returns for every externref
 * pair before the collapse is reached (measured: the whole #5357 matrix already
 * answers correctly under `--target standalone` and `native-first`), so today
 * only the host lane reaches the new call site. The native branch keeps the
 * semantics in one place should that gate ever move.
 *
 * Loose equality has the same nullish hole one step over: §7.2.15 steps 9-10
 * ToNumber the Boolean and recurse, and steps 2-3 make `null` / `undefined`
 * loosely equal only each other — but the collapse read `Number(null)` as `0`,
 * so `null == false` and `null == 0` answered `true`.
 * `emitLooseScalarVsReferenceEquality` decides the nullish case with
 * `ref.is_null` and keeps the (otherwise correct) ToNumber comparison for a
 * non-nullish reference.
 */
import { ts } from "../ts-api.js";
import { isBooleanType } from "../checker/type-mapper.js";
import type { Instr, ValType } from "../ir/types.js";
import { ensureExternStrictEqHelper } from "./any-helpers.js";
import { emitAnyEqFromExternTemps, emitHostEqualityFromStack } from "./coercion-engine.js";
import { allocTempLocal, releaseTempLocal } from "./context/locals.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { coerceType, flushLateImportShifts } from "./shared.js";

/**
 * Brand a scalar operand by its static type so `coerceType` picks the box that
 * preserves its JS tag: `boolean` → `__box_boolean`, `symbol` → `__box_symbol`
 * (#3154). A number-typed `i32` (`string.length`, `type i32 = number`) keeps
 * the number box; an already-branded or non-`i32` operand is returned as is.
 */
function brandScalarForBoxing(type: ValType, tsType: ts.Type): ValType {
  if (type.kind !== "i32" || type.boolean === true || type.symbol === true) return type;
  if (isBooleanType(tsType)) return { kind: "i32", boolean: true };
  if ((tsType.flags & ts.TypeFlags.ESSymbolLike) !== 0) return { kind: "i32", symbol: true };
  return type;
}

/**
 * Compare the two operands already on the stack (right on top) with JS `===`
 * (`strict`) or `==`, in whichever lane is active. Scalars are boxed to
 * `externref` by brand first. `negate` yields the `!==` / `!=` form.
 */
export function emitReferenceEqualityFromStack(
  ctx: CodegenContext,
  fctx: FunctionContext,
  leftType: ValType,
  rightType: ValType,
  leftTsType: ts.Type,
  rightTsType: ts.Type,
  strict: boolean,
  negate: boolean,
): ValType {
  const left = brandScalarForBoxing(leftType, leftTsType);
  const right = brandScalarForBoxing(rightType, rightTsType);
  if (ctx.targetProfile.semanticProviders !== "native-first") {
    return emitHostEqualityFromStack(ctx, fctx, left, right, strict, negate);
  }

  // Native-first: park both boxed operands in externref temps for the helper.
  const rTmp = allocTempLocal(fctx, { kind: "externref" });
  if (right.kind !== "externref") coerceType(ctx, fctx, right, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: rTmp });
  const lTmp = allocTempLocal(fctx, { kind: "externref" });
  if (left.kind !== "externref") coerceType(ctx, fctx, left, { kind: "externref" });
  fctx.body.push({ op: "local.set", index: lTmp });

  const native = strict
    ? nativeStrictEqualityInstrs(ctx, fctx, lTmp, rTmp, negate)
    : emitAnyEqFromExternTemps(ctx, lTmp, rTmp, negate);
  if (native !== null) {
    for (const instr of native) fctx.body.push(instr);
    releaseTempLocal(fctx, lTmp);
    releaseTempLocal(fctx, rTmp);
    return { kind: "i32" };
  }
  // Native helpers unavailable (should not happen): hand the boxed temps to the
  // host arm exactly as the pre-#5357 sites did.
  fctx.body.push({ op: "local.get", index: lTmp });
  fctx.body.push({ op: "local.get", index: rTmp });
  releaseTempLocal(fctx, lTmp);
  releaseTempLocal(fctx, rTmp);
  return emitHostEqualityFromStack(ctx, fctx, { kind: "externref" }, { kind: "externref" }, strict, negate);
}

/** `__extern_strict_eq(l, r)` over two externref temps, or `null` when unavailable. */
function nativeStrictEqualityInstrs(
  ctx: CodegenContext,
  fctx: FunctionContext,
  lTmp: number,
  rTmp: number,
  negate: boolean,
): Instr[] | null {
  const provisionalIdx = ensureExternStrictEqHelper(ctx);
  if (provisionalIdx === undefined) return null;
  // The helper (and the `$AnyValue` machinery it pulls in) may register late
  // imports; settle them before the call index is baked into this body.
  flushLateImportShifts(ctx, fctx);
  const funcIdx = ctx.funcMap.get("__extern_strict_eq") ?? provisionalIdx;
  return [
    { op: "local.get", index: lTmp },
    { op: "local.get", index: rTmp },
    { op: "call", funcIdx },
    ...(negate ? ([{ op: "i32.eqz" }] satisfies Instr[]) : []),
  ];
}

/**
 * `==` / `!=` between a Number-or-Boolean SCALAR (`f64` / `i32`) and a
 * reference that is not statically numeric, with the §7.2.15 nullish rule in
 * front of the ToNumber comparison: `null` / `undefined` loosely equal only each
 * other (steps 2-3), so against a scalar `ref.is_null` alone decides; a
 * non-nullish reference then takes the ToNumber path the collapse always
 * emitted — `__unbox_number` (§7.1.4) on the reference, `f64.convert_i32_s` on
 * a Boolean (step 9/10) — which is steps 5-10 for a Number, String, Boolean or
 * Object operand against a Number. Both operands are on the stack (right on
 * top); `unboxIdx` is the caller's `__unbox_number`.
 */
export function emitLooseScalarVsReferenceEquality(
  fctx: FunctionContext,
  leftType: ValType,
  rightType: ValType,
  unboxIdx: number,
  negate: boolean,
): ValType {
  const rTmp = allocTempLocal(fctx, rightType);
  fctx.body.push({ op: "local.set", index: rTmp });
  const lTmp = allocTempLocal(fctx, leftType);
  fctx.body.push({ op: "local.set", index: lTmp });
  const refTmp = rightType.kind === "externref" ? rTmp : lTmp;
  const toNumber = (type: ValType, tmp: number): Instr[] => [
    { op: "local.get", index: tmp },
    ...(type.kind === "externref"
      ? ([{ op: "call", funcIdx: unboxIdx }] satisfies Instr[])
      : type.kind === "i32"
        ? ([{ op: "f64.convert_i32_s" }] satisfies Instr[])
        : []),
  ];
  fctx.body.push({ op: "local.get", index: refTmp });
  fctx.body.push({ op: "ref.is_null" });
  fctx.body.push({
    op: "if",
    blockType: { kind: "val", type: { kind: "i32" } },
    then: [{ op: "i32.const", value: negate ? 1 : 0 }],
    else: [...toNumber(leftType, lTmp), ...toNumber(rightType, rTmp), { op: negate ? "f64.ne" : "f64.eq" }],
  });
  releaseTempLocal(fctx, lTmp);
  releaseTempLocal(fctx, rTmp);
  return { kind: "i32" };
}
