// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5269 J-1) Native body for the reflective `Number.prototype.toPrecision`
 * closure under standalone.
 *
 * The DIRECT spelling `(1).toPrecision(p)` has been native for a long time —
 * `call-receiver-method.ts` recovers the receiver's f64, range-checks the
 * argument and calls `number_toPrecision`. The reflective VALUE had no body at
 * all: `makeGlue`'s ladder answered `valueOf` for the `Number` brand and let
 * everything else fall to `emitProtoMemberBodyRefusal`, so
 * `Number.prototype.toPrecision.call(1, x)` threw
 * `"Number.prototype.toPrecision is not yet implemented"` — a TypeError, where
 * §21.1.3.5 step 5 demands a **RangeError** for an out-of-range precision.
 * That is `precision-cannot-be-coerced-to-a-number-in-range.js`: all three of
 * its cases (`function(){}`, `NaN`, `{}`) coerce to a precision outside 1-100.
 *
 * The body follows §21.1.3.5 in order, and each step reuses the substrate the
 * direct arm already uses, so the two spellings cannot drift:
 *
 *   1. `x = ? thisNumberValue(this)` — the `__wrapper_valueOf_Number` helper
 *      (#4582), which accepts a primitive number or a Number WRAPPER and
 *      answers null for anything else → TypeError.
 *   2. `precision` undefined → `ToString(x)`.
 *   3. `p = ToIntegerOrInfinity(precision)` — `__unbox_number` (the runtime
 *      ToNumber every other reflective arm uses), then truncate, NaN → 0.
 *   4. `x` not finite → `Number::toString(x)`, BEFORE the range check.
 *   5. `p < 1` or `p > 100` → RangeError.
 *   6. `number_toPrecision(x, p)`.
 *
 * Returns `null` — having emitted NOTHING — when any dependency is missing, so
 * `makeGlue`'s `??` ladder reaches its existing refusal and the module is
 * byte-identical ("ask first, emit second").
 */
import type { Instr, ValType } from "../ir/types.js";
import { undefinedSingletonActive } from "./any-helpers.js";
import { ensureBoxedValueOfHelper } from "./boxed-proto-valueof.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { emitBrandCheckTypeError } from "./native-proto.js";
import { emitNativeNumberFormat } from "./number-format-native.js";

/** The §21.1.3.5 members this module can answer. */
export type NumberProtoFormatMember = "toPrecision";

export function emitNumberProtoFormatBody(ctx: CodegenContext, fctx: FunctionContext, member: string): ValType | null {
  if (!ctx.standalone) return null;
  if (member !== "toPrecision") return null;

  emitNativeNumberFormat(ctx, new Set(["number_toPrecision", "number_toString"]));
  const formatIdx = ctx.funcMap.get("number_toPrecision");
  const numToStringIdx = ctx.funcMap.get("number_toString");
  const unboxIdx = ctx.funcMap.get("__unbox_number");
  if (formatIdx === undefined || numToStringIdx === undefined || unboxIdx === undefined) return null;
  const thisNumberValueIdx = ensureBoxedValueOfHelper(ctx, "Number");
  if (thisNumberValueIdx < 0) return null;

  const boxedLocal = allocLocal(fctx, `__tp_boxed_${fctx.locals.length}`, { kind: "externref" });
  const xLocal = allocLocal(fctx, `__tp_x_${fctx.locals.length}`, { kind: "f64" });
  const pLocal = allocLocal(fctx, `__tp_p_${fctx.locals.length}`, { kind: "f64" });

  // 1. x = ? thisNumberValue(this)
  const brandThrow: Instr[] = [];
  emitBrandCheckTypeError(ctx, brandThrow, "Number.prototype.toPrecision called on incompatible receiver");
  fctx.body.push(
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "call", funcIdx: thisNumberValueIdx },
    { op: "local.tee", index: boxedLocal },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: brandThrow },
    { op: "local.get", index: boxedLocal },
    { op: "call", funcIdx: unboxIdx },
    { op: "local.set", index: xLocal },
  );

  // 2. precision undefined → ToString(x).
  //
  // Regime-aware on purpose: under the #2106 `$undefined`-singleton regime an
  // ABSENT argument arrives as a NON-null singleton, so a bare `ref.is_null`
  // would miss it, `ToNumber(undefined)` would give NaN, and step 3 would turn
  // `(1).toPrecision()` — whose answer is "1" — into a RangeError.
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const precisionAbsent: Instr[] =
    undefinedSingletonActive(ctx) && isUndefinedIdx !== undefined
      ? [
          { op: "local.get", index: 2 },
          { op: "ref.is_null" },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: isUndefinedIdx },
          { op: "i32.or" },
        ]
      : [{ op: "local.get", index: 2 }, { op: "ref.is_null" }];
  fctx.body.push(...precisionAbsent, {
    op: "if",
    blockType: { kind: "empty" },
    then: [{ op: "local.get", index: xLocal }, { op: "call", funcIdx: numToStringIdx }, { op: "return" }],
  });

  // 3. p = ToIntegerOrInfinity(precision): ToNumber, truncate toward zero,
  //    NaN → 0 (which then fails the step-5 range check, as the spec intends).
  fctx.body.push(
    { op: "local.get", index: 2 },
    { op: "call", funcIdx: unboxIdx },
    { op: "local.set", index: pLocal },
    { op: "local.get", index: pLocal },
    { op: "local.get", index: pLocal },
    { op: "f64.ne" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "f64.const", value: 0 },
        { op: "local.set", index: pLocal },
      ],
      else: [{ op: "local.get", index: pLocal }, { op: "f64.trunc" }, { op: "local.set", index: pLocal }],
    },
  );

  // 4. x not finite → Number::toString(x), BEFORE the range check (§21.1.3.5
  //    step 4 precedes step 5, so `(NaN).toPrecision(0)` is "NaN", not a throw).
  fctx.body.push(
    { op: "local.get", index: xLocal },
    { op: "local.get", index: xLocal },
    { op: "f64.ne" },
    { op: "local.get", index: xLocal },
    { op: "f64.abs" },
    { op: "f64.const", value: Infinity },
    { op: "f64.eq" },
    { op: "i32.or" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "local.get", index: xLocal }, { op: "call", funcIdx: numToStringIdx }, { op: "return" }],
    },
  );

  // 5. p < 1 or p > 100 → RangeError.
  const rangeThrow = buildThrowJsErrorInstrs(ctx, "RangeError", "toPrecision() argument must be between 1 and 100", {
    flush: fctx,
  });
  fctx.body.push(
    { op: "local.get", index: pLocal },
    { op: "f64.const", value: 1 },
    { op: "f64.lt" },
    { op: "local.get", index: pLocal },
    { op: "f64.const", value: 100 },
    { op: "f64.gt" },
    { op: "i32.or" },
    { op: "if", blockType: { kind: "empty" }, then: rangeThrow },
  );

  // 6. The same formatter the direct arm calls.
  fctx.body.push(
    { op: "local.get", index: xLocal },
    { op: "local.get", index: pLocal },
    { op: "call", funcIdx: formatIdx },
  );
  return { kind: "externref" };
}
