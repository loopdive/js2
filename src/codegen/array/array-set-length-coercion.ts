// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6771 S10a) ArraySetLength's two coercions on the STATIC `arr.length = v`
 * paths, `--target standalone` and host alike.
 *
 * §10.4.2.4 steps 3–5: `newLen = ToUint32(Desc.[[Value]])`, then `numberLen =
 * ToNumber(Desc.[[Value]])`, and `newLen ≠ numberLen ⇒ RangeError` — TWO
 * observable conversions (valueOf / `@@toPrimitive` run twice), and only THEN
 * (step 12) the `[[Writable]]` check of the old `length`. The static lowering
 * converted once (`Array/length/define-own-prop-length-coercion-order-set.js`
 * counts the hints), and the compile-time non-writable fold
 * (`tryEmitNonWritablePropertyWrite`, #3872) threw before converting at all —
 * so a `@@toPrimitive` that itself freezes `length` was never called.
 *
 * - {@link emitArraySetLengthNumber}: `[v] → [f64]` — for a value that may be an
 *   object, both conversions, answering `numberLen` when it equals
 *   `ToUint32(first)` and NaN otherwise (the caller's
 *   `emitArraySetLengthValidation` turns NaN into the step-5 RangeError). A
 *   provably primitive value converts once: a second conversion is
 *   unobservable.
 * - {@link emitArraySetLengthCoercionEffects}: `[v] → [v]` — the same steps run
 *   for their effects (and the RangeError) ahead of the non-writable fold's
 *   TypeError / sloppy no-op; the RHS stays the assignment's value.
 * - {@link arraySetLengthDynamicParts}: the dynamic `__extern_set` vec
 *   `"length"` arm (vec-length-set.ts, reached by `Reflect.set` and every
 *   `any`-receiver write) converted once and never re-read the writable bit
 *   after converting; it gains the first conversion, the step-5 agreement, and a
 *   step-12 refusal when the overlay companion's `"length"` entry is
 *   non-writable by then (the #4504 result channel: `Reflect.set` answers
 *   false, a strict write throws).
 */
import type { Instr, ValType, WasmFunction } from "../../ir/types.js";
import { allocLocal } from "../context/locals.js";
import type { CodegenContext, FunctionContext } from "../context/types.js";
import { emitArraySetLengthValidation, stringConstantExternrefInstrs } from "../helpers/core-delegates.js"; // (#6797) late-bound core
import { coerceType } from "../shared.js";

const F64: ValType = { kind: "f64" };
const FLAG_WRITABLE = 0x01; // `$PropEntry.$flags` bit 0 (the object-runtime flag ABI, #1888)
const SET_RESULT_REFUSED = 2; // the #4504 [[Set]] result channel

/** May a value of this Wasm type be an object whose ToNumber is observable? */
function mayBeObject(ctx: CodegenContext, t: ValType): boolean {
  if (t.kind === "externref" || t.kind === "anyref" || t.kind === "eqref") return true;
  if (t.kind !== "ref" && t.kind !== "ref_null") return false;
  const ti = (t as { typeIdx: number }).typeIdx;
  return ti !== ctx.anyStrTypeIdx && ti !== ctx.nativeStrTypeIdx;
}

/** `[v: valType] → [f64]` — ArraySetLength steps 3–5 minus the throw (see the module doc). */
export function emitArraySetLengthNumber(ctx: CodegenContext, fctx: FunctionContext, valType: ValType): void {
  if (!mayBeObject(ctx, valType)) {
    coerceType(ctx, fctx, valType, F64);
    return;
  }
  const v = allocLocal(fctx, `__asl_v_${fctx.locals.length}`, valType);
  const u = allocLocal(fctx, `__asl_u_${fctx.locals.length}`, F64);
  const n = allocLocal(fctx, `__asl_n_${fctx.locals.length}`, F64);
  fctx.body.push({ op: "local.tee", index: v });
  coerceType(ctx, fctx, valType, F64); // step 3: ToUint32(value) — its ToNumber
  fctx.body.push(
    { op: "i64.trunc_sat_f64_s" },
    { op: "i64.const", value: 0xffffffffn },
    { op: "i64.and" },
    { op: "f64.convert_i64_u" },
    { op: "local.set", index: u },
    { op: "local.get", index: v },
  );
  coerceType(ctx, fctx, valType, F64); // step 4: ToNumber(value)
  fctx.body.push(
    { op: "local.tee", index: n },
    { op: "f64.const", value: NaN },
    { op: "local.get", index: n },
    { op: "local.get", index: u },
    { op: "f64.eq" },
    { op: "select" }, // step 5: SameValueZero(newLen, numberLen) ? numberLen : NaN → RangeError
  );
}

/** `[v] → [v]`: ArraySetLength steps 3–5 for their effects, ahead of a statically known non-writable `length`. */
export function emitArraySetLengthCoercionEffects(ctx: CodegenContext, fctx: FunctionContext, valType: ValType): void {
  const v = allocLocal(fctx, `__asl_rhs_${fctx.locals.length}`, valType);
  fctx.body.push({ op: "local.tee", index: v }, { op: "local.get", index: v });
  if (valType.kind === "i32") fctx.body.push({ op: "f64.convert_i32_s" });
  else if (valType.kind !== "f64") emitArraySetLengthNumber(ctx, fctx, valType);
  emitArraySetLengthValidation(ctx, fctx);
  fctx.body.push({ op: "drop" });
}

/**
 * Pieces for the dynamic `__extern_set` vec `"length"` arm (params 0 = obj,
 * 1 = key, 2 = value; appends its own locals to `setFn`). `toNumber` is the
 * arm's `[value] → [f64]` ToNumber sequence (cloned here).
 */
export function arraySetLengthDynamicParts(
  ctx: CodegenContext,
  setFn: WasmFunction,
  toNumber: readonly Instr[],
  setResultGlobalIdx: number | undefined,
): { firstConversion: Instr[]; agreesWithFirst: (nLocal: number) => Instr[]; nonWritableRefusal: Instr[] } {
  const lU = 3 + setFn.locals.length;
  setFn.locals.push({ name: "__veclen_u", type: F64 });
  const firstConversion: Instr[] = [
    { op: "local.get", index: 2 },
    ...toNumber.map((i) => ({ ...i })),
    { op: "i64.trunc_sat_f64_s" },
    { op: "i64.const", value: 0xffffffffn },
    { op: "i64.and" },
    { op: "f64.convert_i64_u" },
    { op: "local.set", index: lU },
  ];
  // [n] → [n'] — n' = n when ToUint32(first) = n, else NaN (the arm's validity test then fails).
  const agreesWithFirst = (nLocal: number): Instr[] => [
    { op: "drop" },
    { op: "local.get", index: nLocal },
    { op: "f64.const", value: NaN },
    { op: "local.get", index: nLocal },
    { op: "local.get", index: lU },
    { op: "f64.eq" },
    { op: "select" },
    { op: "local.tee", index: nLocal },
  ];
  // The companion lookup is minted by the overlay fill, which runs AFTER this
  // arm is spliced; park an empty block and let `fillArraySetLengthRefusal`
  // (called from that fill) write its body.
  const slot: Instr[] = [];
  pendingRefusals.set(ctx, { slot, setFn, setResultGlobalIdx });
  return {
    firstConversion,
    agreesWithFirst,
    nonWritableRefusal: [{ op: "block", blockType: { kind: "empty" }, body: slot }],
  };
}

const pendingRefusals = new WeakMap<
  CodegenContext,
  { slot: Instr[]; setFn: WasmFunction; setResultGlobalIdx: number | undefined }
>();

/**
 * Overlay-fill hook (vec-overlay.ts `fillVecOverlayHelpers`, once the companion
 * lookup exists): the parked refusal — the receiver's companion `"length"`
 * entry, when present and non-writable, refuses the store (§10.4.2.4 step 12)
 * AFTER both conversions ran. No companion ⇒ `length` was never redefined ⇒
 * still writable.
 */
export function fillArraySetLengthRefusal(ctx: CodegenContext, lookupIdx: number): void {
  const pending = pendingRefusals.get(ctx);
  const objFindIdx = ctx.funcMap.get("__obj_find");
  const types = ctx.objectRuntimeTypes;
  if (!pending || objFindIdx === undefined || !types) return;
  pendingRefusals.delete(ctx);
  const { slot, setFn, setResultGlobalIdx } = pending;
  const lComp = 3 + setFn.locals.length;
  const lEntry = lComp + 1;
  setFn.locals.push(
    { name: "__veclen_comp", type: { kind: "ref_null", typeIdx: types.objectTypeIdx } },
    { name: "__veclen_entry", type: { kind: "ref_null", typeIdx: types.propEntryTypeIdx } },
  );
  const refuse: Instr[] =
    setResultGlobalIdx === undefined
      ? [{ op: "return" }]
      : [
          { op: "i32.const", value: SET_RESULT_REFUSED },
          { op: "global.set", index: setResultGlobalIdx },
          { op: "return" },
        ];
  const entryNonWritable: Instr[] = [
    { op: "local.get", index: lEntry },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: types.propEntryTypeIdx, fieldIdx: 2 },
    { op: "i32.const", value: FLAG_WRITABLE },
    { op: "i32.and" },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: refuse },
  ];
  const companionEntry: Instr[] = [
    { op: "local.get", index: lComp },
    { op: "ref.as_non_null" },
    ...stringConstantExternrefInstrs(ctx, "length"),
    { op: "call", funcIdx: objFindIdx },
    { op: "local.tee", index: lEntry },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [], else: entryNonWritable },
  ];
  slot.push(
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "call", funcIdx: lookupIdx },
    { op: "local.tee", index: lComp },
    { op: "ref.is_null" },
    { op: "if", blockType: { kind: "empty" }, then: [], else: companionEntry },
  );
}
