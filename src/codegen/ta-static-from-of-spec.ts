// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster E, slice E2) The §23.2.2.1 / §23.2.2.2 pieces that the
 * `%TypedArray%.from` / `%TypedArray%.of` STATIC call-site arm
 * (`tryEmitTaStaticOfFrom`, `expressions/call-receiver-method.ts`) has to run
 * before it hands the source to the shared builder: the runtime identity of the
 * `%TypedArray%` intrinsic constructor carrier, and the step-3 `IsCallable(mapfn)`
 * gate.
 *
 * ## Why the carrier identity exists
 * `%TypedArray%` (§23.2.1) is materialized in standalone as a plain `$Object`
 * singleton by `emitTypedArrayIntrinsicCtorObject` — the object the
 * test262 harness binds with `var TypedArray = Object.getPrototypeOf(Int8Array)`
 * (`harness/testTypedArray.js` L64) and then calls `.from` / `.of` on. It is
 * NOT a `$__ta_ctor` struct and it is NOT the `ctor:Int8Array` carrier, so the
 * two existing runtime discriminators in `tryEmitTaStaticOfFrom`
 * (`taCtorIdentityTestInstrs` and `buildInt8ArrayCarrierMatch`) both decline
 * for it and `TypedArray.from(source)` fell to the ordinary dynamic dispatcher.
 *
 * That answered a **TypeError from the refusal closure seeded on the carrier's
 * own `from`/`of` properties**, which is the wrong error AT THE WRONG TIME:
 * §23.2.2.1 runs IterableToList / the array-like `length` read BEFORE
 * TypedArrayCreate, so a source whose iterator or `length` getter throws must
 * surface THAT completion, not the abstract-constructor TypeError. Measured on
 * this branch's base: `TypedArray.from(iterWhoseNextThrows)` answered TypeError
 * where the six `built-ins/TypedArray/from/*-error` rows require Test262Error.
 *
 * ## What it provides
 * A single carrier-identity test, written the same way `buildInt8ArrayCarrierMatch`
 * writes the Int8Array one (reserve the global eagerly so whichever of the two
 * emitters runs first owns the slot, then `ref.eq` against it under a cast).
 * The global is `externref`-typed and null until the intrinsic is materialized,
 * so the match is guarded on non-null: a module that never evaluates
 * `Object.getPrototypeOf(<TA ctor>)` leaves it null and every probe declines.
 *
 * Kept OUT of `array-object-proto.ts` (which owns the intrinsic's SEEDING) and
 * out of `call-receiver-method.ts` (which owns the CONSUMING arm) deliberately:
 * both are over the LOC threshold, and the identity predicate is exactly the
 * shared contract between them.
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { ensureObjectRuntime } from "./object-runtime.js";
import { buildThrowJsErrorInstrs } from "./js-errors.js";

/**
 * Module-global name of the `%TypedArray%` intrinsic constructor carrier.
 * MUST stay in sync with `emitTypedArrayIntrinsicCtorObject`
 * (`array-object-proto.ts`) — they are two halves of one singleton.
 */
export const TA_INTRINSIC_CTOR_GLOBAL = "__builtin_%TypedArray%_ctor";

/**
 * Reserve (idempotently) the `%TypedArray%` carrier global slot and return its
 * index. Whichever of the seeder / the identity probe runs first creates it;
 * the other finds it through `ctx.builtinObjectGlobals`.
 */
export function reserveTypedArrayIntrinsicCtorGlobal(ctx: CodegenContext): number {
  const existing = ctx.builtinObjectGlobals.get(TA_INTRINSIC_CTOR_GLOBAL);
  if (existing !== undefined) return existing;
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: TA_INTRINSIC_CTOR_GLOBAL,
    type: { kind: "externref" },
    mutable: true,
    init: [{ op: "ref.null.extern" }],
  });
  ctx.builtinObjectGlobals.set(TA_INTRINSIC_CTOR_GLOBAL, globalIdx);
  return globalIdx;
}

/**
 * Emit `if (anyLocal is the %TypedArray% intrinsic carrier) { onMatch }`.
 *
 * `anyLocal` holds the receiver already converted to `anyref`. Returns `[]`
 * when the object runtime has no `$Object` type in this module (nothing can be
 * that carrier then, so declining is the correct answer, not a degradation).
 */
export function buildTypedArrayIntrinsicCarrierMatch(ctx: CodegenContext, anyLocal: number, onMatch: Instr[]): Instr[] {
  const globalIdx = reserveTypedArrayIntrinsicCtorGlobal(ctx);
  ensureObjectRuntime(ctx);
  const objectTypeIdx = ctx.objectRuntimeTypes?.objectTypeIdx;
  if (objectTypeIdx === undefined) return [];
  return [
    { op: "global.get", index: globalIdx },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    { op: "local.get", index: anyLocal },
    { op: "ref.test", typeIdx: objectTypeIdx },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: anyLocal },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        { op: "global.get", index: globalIdx },
        { op: "any.convert_extern" },
        { op: "ref.cast_null", typeIdx: objectTypeIdx },
        { op: "ref.eq" },
        { op: "if", blockType: { kind: "empty" }, then: onMatch, else: [] },
      ],
      else: [],
    },
  ];
}

/**
 * §23.2.2.1 step 3 — `%TypedArray%.from ( source [ , mapfn [ , thisArg ] ] )`:
 *
 *   3. If mapfn is present and mapfn is not undefined, then
 *      a. If IsCallable(mapfn) is false, throw a TypeError exception.
 *   4. Let usingIterator be ? GetMethod(source, @@iterator).
 *
 * Two things are observable here and BOTH were wrong before this gate.
 *
 * 1. `null` is not `undefined`. The call-site arm decided "is there a mapping?"
 *    with `__nullish_to_null` + `ref.is_null`, which folds the two together, so
 *    `TA.from(src, null)` silently ran the NO-MAPPING path and returned a typed
 *    array instead of throwing (measured on this branch's base).
 * 2. The check precedes the `@@iterator` GET. `mapfn-is-not-callable.js`
 *    asserts exactly that with a counting `@@iterator` accessor; on the base it
 *    counted 14 where the spec requires 0 (this probe measured 2 gets per
 *    `from` call).
 *
 * Emitted as `if (!isUndefined(mapfn) && !isCallable(mapfn)) throw TypeError`,
 * over the two natives the sibling §23.1.3.30 `sort` comparefn gate already
 * uses (`__extern_is_undefined` / `__typeof_function`, #6651 E-S1) so the two
 * "a present non-callable function argument is a TypeError" sites agree rather
 * than each inventing a predicate. Returns `[]` when either native is absent
 * from this module — declining leaves the caller byte-identical rather than
 * half-enforcing the step.
 */
export function buildTaFromMapfnCallableGate(ctx: CodegenContext, mapfnLocal: number): Instr[] {
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  const typeofFunctionIdx = ctx.funcMap.get("__typeof_function");
  if (isUndefinedIdx === undefined || typeofFunctionIdx === undefined) return [];
  return [
    { op: "local.get", index: mapfnLocal },
    { op: "call", funcIdx: isUndefinedIdx },
    { op: "i32.eqz" },
    { op: "local.get", index: mapfnLocal },
    { op: "call", funcIdx: typeofFunctionIdx },
    { op: "i32.eqz" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: buildThrowJsErrorInstrs(ctx, "TypeError", "TypeError: %TypedArray%.from mapfn is not a function"),
      else: [],
    },
  ];
}
