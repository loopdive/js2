// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4619 family D) Native bodies for `Number.prototype.toString`,
 * `String.prototype.toString` and `Boolean.prototype.toString` under
 * `--target standalone`.
 *
 * ## The gap, and why it is NOT the one the issue predicted
 *
 * #4619 filed these rows as "wrapper-method VALUE calls" — read the method off
 * the prototype, then call the read value. Measured on this branch's base
 * (`2937ca57a`, real `runTest262File` standalone lane, one module per probe),
 * that is not what the failing rows do. `S15.6.4.2_A1_T1`,
 * `S15.7.4.2_A1_T01` and `property-accessors/S11.2.1_A3_T1` call
 * `<wrapper>.toString()` and `<Builtin>.prototype.toString()` DIRECTLY:
 *
 * | probe                              | base                                    |
 * | ---------------------------------- | --------------------------------------- |
 * | `new Boolean(true).toString()`     | `TypeError: called value is not a function` |
 * | `(new Number(0)).toString()`       | same                                    |
 * | `(new String("ab")).toString()`    | same                                    |
 * | `new Boolean(true).valueOf()`      | **passes** (#4491 wave-5 T2 / #4582)    |
 * | `(255).toString(16)`               | passes (primitive receiver, radix arm)  |
 *
 * The `valueOf` row is the tell: the two members differ only in that `valueOf`
 * has a native body and `toString` does not.
 *
 * ## Why the call reaches nothing at all
 *
 * Traced, not guessed (`JS2WASM_TRACE_WDMC` on the emitter): the call is claimed
 * by #1397's wrapper-reassignment branch in `call-receiver-method.ts`, which
 * routes a wrapper receiver to `__extern_method_call` whenever the module
 * assigns `<anything>.toString` ANYWHERE. In test262 that condition is
 * universal — `sta.js`, prepended to every file in the corpus, contains
 * `Test262Error.prototype.toString = function () {…}` — so every wrapper
 * `.toString()` in the corpus goes dynamic. The dynamic read then answers null
 * (the brand's closure was never minted), and `__extern_method_call`'s #4221
 * absent-callee guard reports `called value is not a function`.
 *
 * That branch is CORRECT and is deliberately left alone: `s1.toString =
 * Number.prototype.toString; s1.toString()` must observe the own slot and throw
 * (§15.7.4.2, the `_A2_*` rows). The defect is that the dynamic route it hands
 * off to has nothing to find. Two things were missing, and both are needed —
 * verified by forcing the closure to be minted (`var _f = Number.prototype
 * .toString;` in the same module), which moved the error from "called value is
 * not a function" to the refusal body's own message, i.e. routing was already
 * sound and only the BODY was absent:
 *
 *   1. the native body — this module;
 *   2. the DEMAND that mints the closure at all — see
 *      `ensureWrapperProtoDynamicMember` below, called from
 *      `emitWrapperDynamicMethodCall`.
 *
 * ## The body — §21.1.3.6 / §22.1.3.27 / §20.3.3.2
 *
 * All three are `Let x be ? this<X>Value(this value)` followed by a conversion,
 * so the receiver ladder is shared verbatim with `valueOf`
 * (`emitWrapperThisValueBody`, wrapper-proto-value-of.ts) and only the
 * conversion lives here:
 *
 * | brand     | conversion                                                     |
 * | --------- | -------------------------------------------------------------- |
 * | `String`  | identity — the slot already holds the string                    |
 * | `Boolean` | `__unbox_boolean` → the `"true"` / `"false"` constant           |
 * | `Number`  | `__unbox_number` → `number_toString[_radix]` (§21.1.3.6 radix)  |
 *
 * The receiver arms answer `<Brand>.prototype` itself with the §15.x default
 * ([[NumberData]] `+0`, [[StringData]] `""`, [[BooleanData]] `false`), which is
 * exactly what `Boolean.prototype.toString() === "false"` (S15.6.4.2_A1_T1) and
 * `Number.prototype.toString() === "0"` (S15.7.4.2_A1_T01) assert. A receiver
 * matching no arm throws the §…step-3 TypeError, unchanged.
 *
 * ## Radix
 *
 * §21.1.3.6 steps 2-4: an absent or `undefined` radix means 10 and SKIPS the
 * range check, so `(5).toString(undefined)` is `"5"` and not a RangeError —
 * the same carve-out #3175 already made for the primitive-receiver arm, and the
 * reason the radix preamble tests `ref.is_null` and `__typeof_undefined` before
 * validating. The preamble is emitted ONCE, before the receiver ladder, because
 * it depends only on the argument; the per-arm tail merely selects
 * `number_toString` or `number_toString_radix` from the flag it computed.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { addStringConstantGlobal } from "./registry/imports.js";
import { stringConstantExternrefInstrs } from "./native-strings.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";
import { ensureLateImport, flushLateImportShifts } from "./shared.js";
import {
  canEmitWrapperThisValueBody,
  emitWrapperThisValueBody,
  type WrapperBrandName,
} from "./wrapper-proto-value-of.js";

/** Fresh copies of a constant instruction list — never share an `Instr` (#4221). */
const clone = (instrs: readonly Instr[]): Instr[] => instrs.map((i) => ({ ...i }) as Instr);

/**
 * Emit `<brandName>.prototype.toString`'s native body into `fctx` (closure ABI:
 * param 0 = self, param 1 = `this`, param 2 = radix for Number).
 *
 * Returns `{ kind: "externref" }` when emitted, or `null` having emitted
 * NOTHING — the caller then keeps the member's catchable-TypeError refusal.
 */
export function emitWrapperProtoToStringBody(
  ctx: CodegenContext,
  fctx: FunctionContext,
  brandName: WrapperBrandName,
): ValType | null {
  if (!ctx.standalone) return null;
  // Ask before emitting anything at all — see the note in
  // `emitNumberProtoToStringBody`. Cheap here, load-bearing there.
  if (!canEmitWrapperThisValueBody(ctx, brandName)) return null;

  // §22.1.3.27 — `thisStringValue(this)` IS the answer; no conversion at all,
  // so the body is literally `valueOf`'s.
  if (brandName === "String") {
    return emitWrapperThisValueBody(ctx, fctx, "String", "toString", () => [{ op: "return" }]);
  }

  if (brandName === "Boolean") {
    // Late-import discipline (the established `emitTypedArrayProtoMemberBody`
    // shape): resolve + flush BEFORE any funcidx is baked into an arm, so a
    // late import added mid-ladder cannot stale an index already emitted.
    const unboxBoolIdx = ensureLateImport(ctx, "__unbox_boolean", [{ kind: "externref" }], [{ kind: "i32" }]);
    // …and `__box_boolean`, which arm 3 of the shared ladder needs to build
    // `Boolean.prototype`'s [[BooleanData]] constant (§20.3.3). It is resolved
    // HERE, with the other import and before any index is baked, because
    // `protoDefaultPrimitive` reads it mid-ladder — adding it there would shift
    // funcidxs already frozen into the arms above it.
    ensureLateImport(ctx, "__box_boolean", [{ kind: "i32" }], [{ kind: "externref" }]);
    flushLateImportShifts(ctx, fctx);
    if (unboxBoolIdx === undefined) return null;
    addStringConstantGlobal(ctx, "true");
    addStringConstantGlobal(ctx, "false");
    const trueStr = stringConstantExternrefInstrs(ctx, "true");
    const falseStr = stringConstantExternrefInstrs(ctx, "false");
    if (trueStr.length === 0 || falseStr.length === 0) return null;
    return emitWrapperThisValueBody(ctx, fctx, "Boolean", "toString", () => [
      { op: "call", funcIdx: unboxBoolIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: clone(trueStr),
        else: clone(falseStr),
      },
      { op: "return" },
    ]);
  }

  return emitNumberProtoToStringBody(ctx, fctx);
}

/**
 * §21.1.3.6 `Number.prototype.toString(radix)`. Separated only for size; the
 * receiver ladder is still `emitWrapperThisValueBody`'s.
 */
function emitNumberProtoToStringBody(ctx: CodegenContext, fctx: FunctionContext): ValType | null {
  // ALL-OR-NOTHING. The radix preamble below writes into `fctx.body` BEFORE the
  // receiver ladder runs, and the ladder can still decline (returning `null`
  // having emitted nothing of its own). `makeGlue` reaches its refusal through
  // `??`, so a `null` here would emit a SECOND body on top of the orphaned
  // preamble. Ask first, emit second.
  if (!canEmitWrapperThisValueBody(ctx, "Number")) return null;
  // Mint the native formatters first — `emitNativeNumberFormat` mints DEFINED
  // funcs (append-only) and pulls the native-string helpers, so it must run
  // before any index below is read.
  if (!ctx.funcMap.has("number_toString")) emitNativeNumberFormat(ctx, new Set(["number_toString"]));
  const unboxNumIdx = ensureLateImport(ctx, "__unbox_number", [{ kind: "externref" }], [{ kind: "f64" }]);
  flushLateImportShifts(ctx, fctx);
  const toStrIdx = ctx.funcMap.get("number_toString");
  const toStrRadixIdx = ctx.funcMap.get("number_toString_radix");
  const isUndefIdx = ctx.funcMap.get("__typeof_undefined");
  if (unboxNumIdx === undefined || toStrIdx === undefined || toStrRadixIdx === undefined) return null;

  const numLocal = allocLocal(fctx, `__wts_num_${fctx.locals.length}`, { kind: "f64" });
  const radixLocal = allocLocal(fctx, `__wts_radix_${fctx.locals.length}`, { kind: "f64" });
  // 1 exactly when a radix other than 10 was supplied — the only case that has
  // to reach the (slower, general) radix formatter.
  const useRadixLocal = allocLocal(fctx, `__wts_useradix_${fctx.locals.length}`, { kind: "i32" });

  // ── radix preamble (once; depends only on the argument) ────────────────────
  // A closure minted for a family whose `memberParamSlots` gave it no argument
  // slot has no param 2 — then the radix is always absent, which is base 10.
  const hasRadixParam = fctx.params.length > 2;
  fctx.body.push({ op: "f64.const", value: 10 }, { op: "local.set", index: radixLocal });
  fctx.body.push({ op: "i32.const", value: 0 }, { op: "local.set", index: useRadixLocal });
  if (hasRadixParam) {
    // present := radix !== null && !__typeof_undefined(radix)
    const validate: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: unboxNumIdx },
      { op: "f64.floor" },
      { op: "local.tee", index: radixLocal },
      { op: "f64.const", value: 2 },
      { op: "f64.lt" },
      { op: "local.get", index: radixLocal },
      { op: "f64.const", value: 36 },
      { op: "f64.gt" },
      { op: "i32.or" },
      // NaN (a non-numeric radix floors to NaN) — §21.1.3.6 step 4's range test
      // is false for NaN either way, so test it explicitly.
      { op: "local.get", index: radixLocal },
      { op: "local.get", index: radixLocal },
      { op: "f64.ne" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: buildThrowJsErrorInstrs(ctx, "RangeError", "toString() radix must be between 2 and 36", {
          forceInModuleCtor: true,
        }),
      },
      { op: "local.get", index: radixLocal },
      { op: "f64.const", value: 10 },
      { op: "f64.ne" },
      { op: "local.set", index: useRadixLocal },
    ];
    const presentArm: Instr[] =
      isUndefIdx === undefined
        ? validate
        : [
            { op: "local.get", index: 2 },
            { op: "call", funcIdx: isUndefIdx },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: validate },
          ];
    fctx.body.push(
      { op: "local.get", index: 2 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: presentArm },
    );
  }

  return emitWrapperThisValueBody(ctx, fctx, "Number", "toString", () => [
    { op: "call", funcIdx: unboxNumIdx },
    { op: "local.set", index: numLocal },
    { op: "local.get", index: useRadixLocal },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "externref" } },
      then: [
        { op: "local.get", index: numLocal },
        { op: "local.get", index: radixLocal },
        { op: "call", funcIdx: toStrRadixIdx },
      ],
      else: [
        { op: "local.get", index: numLocal },
        { op: "call", funcIdx: toStrIdx },
      ],
    },
    { op: "return" },
  ]);
}
