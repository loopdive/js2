// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4200) Standalone `<Builtin>.prototype.constructor` — the own `constructor`
 * data property of every builtin prototype (§20.1.3.1, §22.1.3.2, §20.5.3.1, …).
 *
 * ## Why this module exists
 *
 * `constructor` is an OWN data property of every builtin prototype, but it is
 * not a *method*, so it is deliberately absent from the per-brand method tables
 * in `array-object-proto.ts` (`ARRAY_PROTO_METHODS`, `ERROR_PROTO_METHODS`, …).
 * Those tables drive BOTH consumers of a builtin-proto member:
 *
 *   1. the VALUE read `<Builtin>.prototype.<m>` (`builtin-value-read.ts` →
 *      `resolveStandaloneProtoMemberValueClosure`), and
 *   2. the #2885 Site-2 gOPD descriptor synthesis (`call-builtin-static.ts`).
 *
 * With `constructor` in neither table both consumers fell to their "unknown
 * member" arm and answered `undefined`, so on standalone
 * `Error.prototype.constructor` read as `undefined` and
 * `gOPD(Error.prototype, "constructor")` returned no descriptor at all.
 *
 * Adding `"constructor"` to the method tables would be WRONG: the shared
 * consumer mints a brand-keyed *method closure* per CSV member, so
 * `Error.prototype.constructor` would become a callable refusal stub rather
 * than the constructor object. It needs its own arm, which is what this module
 * is — and it is ONE module rather than two call-site patches precisely so the
 * two consumers cannot drift apart: `gOPD(p,"constructor").value ===
 * p.constructor` is an assertion in the corpus (15.2.3.3-4-27/34/39/…), and it
 * holds only while both arms resolve to the same carrier.
 *
 * ## Which carrier
 *
 * The value must be the SAME identity-stable object the bare `<Builtin>`
 * identifier resolves to, so `Error.prototype.constructor === Error` is
 * genuinely true by `ref.eq` (not a null≡null tautology). Standalone already
 * has exactly two such carriers, and this module dispatches between them
 * instead of minting a third:
 *
 * | carrier                            | builtins                                            |
 * | ---------------------------------- | --------------------------------------------------- |
 * | `__builtin_ctor_<N>` (#3006)       | Set, Map, Weak*, RegExp, FinalizationRegistry, …    |
 * | `__builtin_<N>` namespace (#2907)  | Object, Array, Math, JSON, Reflect, Error family    |
 *
 * A builtin with NEITHER carrier (`Date`, `String`, `Number`, `Boolean`)
 * declines and keeps today's `undefined`. `Function` is the one exception:
 * its constructor value already has a single shared emitter
 * (`emitStandaloneFunctionIntrinsicValue`) because the bare value is the
 * realm-owned `%Function%` intrinsic in runtime-eval builds. Reusing that
 * emitter here makes the prototype's own data property agree with both the
 * `Function.prototype.constructor` read and the bare `Function` value without
 * minting a second, non-callable carrier.
 *
 * ## Safety envelope
 *
 * Standalone only (`ctx.standalone` is checked by both callers); host/gc keep
 * their genuine `Object_get_constructor` read. Every shape this module answers
 * was previously `undefined` on main, so nothing that previously produced a
 * value can change. `tryEmit*` keeps the no-partial-instructions contract when
 * it declines.
 */
import type { ValType } from "../ir/types.js";
import {
  emitBuiltinConstructorIdentity,
  emitBuiltinNamespaceObject,
  isBuiltinConstructorIdentityName,
  isSupportedBuiltinNamespace,
} from "./builtin-static-globals.js";
import { emitStandaloneFunctionIntrinsicValue } from "./function-intrinsic-carrier.js";
// (#5194 step 1) TypedArray carriers. Both are used only inside functions, so
// the module cycle these introduce is evaluation-order safe.
import { emitTaCtorValue } from "./dataview-native.js";
import { taCtorKindOf } from "./registry/types.js";
import { emitTypedArrayIntrinsicCtorObject } from "./array-object-proto.js";
import { withSpeculativeCompile } from "./context/speculative.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { coerceType, ensureLateImport, flushLateImportShifts } from "./shared.js";

/**
 * §6.1.7.3 attribute bits for a builtin prototype's own `constructor`:
 * `{writable: true, enumerable: false, configurable: true}` — mirrors
 * `__create_descriptor`'s encoding (1=writable, 2=enumerable, 4=configurable).
 */
const CONSTRUCTOR_FLAGS = 0x05;

/**
 * True when `<builtinName>.prototype.constructor` has an identity-stable
 * carrier to resolve to. Pure — no emission — so callers can gate BEFORE
 * pushing operands and keep the "declines push nothing" contract.
 */
export function hasBuiltinProtoConstructorCarrier(builtinName: string): boolean {
  return (
    builtinName === "Function" ||
    isBuiltinConstructorIdentityName(builtinName) ||
    isSupportedBuiltinNamespace(builtinName) ||
    // (#5194 step 1) The TypedArray family. `<View>.prototype.constructor` is
    // the per-kind `$__ta_ctor` singleton — the SAME value the bare
    // `Uint8Array` identifier reads (Int8Array is already covered above by the
    // #4490 identity carrier). `%TypedArray%.prototype.constructor` is the
    // abstract intrinsic ctor object (§23.2.3.5). Without a carrier here the
    // seeder skipped `constructor` entirely, so `verifyNotEnumerable(
    // TA.prototype, "constructor")` null-dereferenced the missing descriptor.
    isTypedArrayProtoConstructorName(builtinName)
  );
}

/**
 * (#5194 step 1) The TypedArray-family prototype names whose own `constructor`
 * resolves to a TypedArray carrier: the 9 wired concrete views plus the
 * abstract `%TypedArray%` intrinsic. `taCtorKindOf` is the same predicate the
 * bare-identifier read uses, so the two cannot drift.
 */
function isTypedArrayProtoConstructorName(builtinName: string): boolean {
  return builtinName === "%TypedArray%" || taCtorKindOf(builtinName) >= 0;
}

/**
 * Push the constructor object for `<builtinName>.prototype.constructor` — the
 * same singleton the bare `<builtinName>` identifier reads. Returns the pushed
 * type, or `null` (pushing nothing) when the builtin has no carrier.
 *
 * Stack: `[] → [externref]` on success.
 */
export function emitBuiltinProtoConstructorValue(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string,
): ValType | null {
  if (builtinName === "Function") {
    return emitStandaloneFunctionIntrinsicValue(ctx, fctx) ?? null;
  }
  if (isBuiltinConstructorIdentityName(builtinName)) {
    return emitBuiltinConstructorIdentity(ctx, fctx, builtinName);
  }
  if (isSupportedBuiltinNamespace(builtinName)) {
    return emitBuiltinNamespaceObject(ctx, fctx, builtinName);
  }
  // (#5194 step 1) TypedArray family — see `isTypedArrayProtoConstructorName`.
  if (builtinName === "%TypedArray%") {
    return emitTypedArrayIntrinsicCtorObject(ctx, fctx);
  }
  if (taCtorKindOf(builtinName) >= 0) {
    return emitTaCtorValue(ctx, fctx, builtinName);
  }
  return null;
}

/**
 * Synthesize the descriptor for `gOPD(<builtinName>.prototype, "constructor")`
 * — a data descriptor whose `.value` is the very carrier
 * `emitBuiltinProtoConstructorValue` returns, so the corpus's
 * `desc.value === <B>.prototype.constructor` assertion holds by construction.
 *
 * Takes the raw (possibly `undefined`) receiver name and member key and does
 * its own gating, so the gOPD driver spends one `if` on this arm rather than
 * carrying the `constructor` special case in the god-file.
 *
 * Returns `true` leaving one externref on the stack, or `false` having pushed
 * NOTHING. The `__create_descriptor` import is resolved and its shifts flushed
 * BEFORE the value is emitted, so a late import registered by the carrier's own
 * lowering cannot invalidate the captured funcIdx.
 */
export function tryEmitBuiltinProtoConstructorDescriptor(
  ctx: CodegenContext,
  fctx: FunctionContext,
  builtinName: string | undefined,
  member: string | undefined,
): boolean {
  if (builtinName === undefined || member !== "constructor") return false;
  if (!hasBuiltinProtoConstructorCarrier(builtinName)) return false;
  return withSpeculativeCompile(ctx, fctx, () => {
    // The provider-backed `%Function%` emitter can register the runtime-eval
    // import while producing the descriptor value. Emit the value first, then
    // resolve the descriptor helper and flush shifts so its call index is live.
    // The other carriers are self-contained, but keeping the ordering uniform
    // avoids a future carrier reintroducing the same stale-index hazard.
    const valueType = emitBuiltinProtoConstructorValue(ctx, fctx, builtinName);
    if (valueType === null) return { commit: false, value: false };
    if (valueType.kind !== "externref") coerceType(ctx, fctx, valueType, { kind: "externref" });

    const createIdx = ensureLateImport(
      ctx,
      "__create_descriptor",
      [{ kind: "externref" }, { kind: "i32" }],
      [{ kind: "externref" }],
    );
    flushLateImportShifts(ctx, fctx);
    if (createIdx === undefined) return { commit: false, value: false };
    fctx.body.push({ op: "i32.const", value: CONSTRUCTOR_FLAGS });
    fctx.body.push({ op: "call", funcIdx: ctx.funcMap.get("__create_descriptor") ?? createIdx });
    return { commit: true, value: true };
  });
}
