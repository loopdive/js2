// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4055) `__hasOwnProperty` / `__object_hasOwn`: consult the carrier own-property
 * side tables for a non-`$Object` receiver.
 *
 * ## The gap (instance #7 of the #4080 family)
 * #3468 (closures) and #3537 (arrays) gave the terminal dynamic-property helpers
 * `__extern_get` / `__extern_set` / `__extern_method_call` a fallback for a
 * receiver that is not a `$Object`: an identity-keyed side table mapping the
 * carrier to a `$Object` "bag" holding its named own properties.
 *
 * `__hasOwnProperty` never got wired to it. Its body still bails with `0` on
 * `ref.test $Object`, so a function or array answered `false` for an own
 * property it had *just stored through the very same substrate*:
 *
 * ```js
 * var f = function () {};
 * f.enumerable = true;
 * f["enumerable"];                 // true   (__extern_get reads the bag)
 * f.hasOwnProperty("enumerable");  // false  <- the gap
 * ```
 *
 * ## Why this is worth fixing beyond `hasOwnProperty` itself
 * `__obj_define_from_desc`'s ToPropertyDescriptor (§6.2.5.6) gates **every**
 * descriptor field on `HasProperty` before reading it. With the gap, a
 * Function/Array descriptor carrier — the dominant test262 spelling, e.g.
 * `var descObj = function(){}; descObj.enumerable = true;` — produced an EMPTY
 * descriptor, and CompletePropertyDescriptor then filled in `undefined` + all
 * attributes `false`. Silently: no refusal, wrong content.
 *
 * ## Why this is NOT the carrier-bag arm that #4047 measured and reverted
 * That arm resolved a **`Properties` map** through the bag. Enumerating a map
 * needs a COMPLETE own-key source, and the bag is not one — writes via
 * `props.p = v` land in the bag while `Object.defineProperty(props,"p",…)` lands
 * in the separate #3251 overlay (Array) or nowhere (Function). So it enumerated
 * an empty bag, defined nothing, and returned normally: a silent no-op on the
 * more idiomatic spelling.
 *
 * `hasOwnProperty(k)` is a **fixed-key presence query**. It needs no key source
 * at all, and the bag is exactly where `__extern_set` put the write, so presence
 * and read agree by construction. `Object.defineProperty(fun,"p",…)` still lands
 * nowhere and this arm still answers `false` for it — the same answer as today,
 * so no new inconsistency is introduced.
 *
 * ## LOOKUP, never ENSURE
 * The bag is read with `__vec_bag_lookup` / `__closure_bag_lookup`, never the
 * `_ensure` variants: a presence *query* must not allocate a bag, or merely
 * observing a value would mutate the side table and give a later
 * `__integrity_bag` consumer a carrier that previously had none.
 *
 * ## The ARRAY half is deliberately NOT here — measured, not assumed
 * `fillVecHasOwnHelpers` (`vec-overlay.ts`) **unshifts** a prologue into
 * `__hasOwnProperty` that answers from `__vec_gopd` and `return`s for EVERY vec
 * receiver, so no arm placed in the body can be reached for an array. Verified
 * by probe: with an array carrier, `hasOwnProperty("0")` is `true` and
 * `hasOwnProperty("9")` is `false` (the overlay answering indices) while
 * `arr.q = 5; arr.hasOwnProperty("q")` is `false` even though `arr.q` reads `5`.
 *
 * That is the #3251-overlay-vs-#3537-bag split — the two disjoint identity-keyed
 * side tables filed as **#4010** — and reconciling them is that issue's job, not
 * a symptom fix's. A vec arm was written here, measured unreachable, and removed
 * rather than shipped as decoration.
 *
 * ## Ownership / byte-neutrality
 * Composition only — `closure-props.ts` (#3468) and `vec-props.ts` (#3537) are
 * not edited; this module reaches their helpers by name through `funcMap`. Every
 * builder returns `[]` when a substrate is absent, which is the host/gc case, so
 * the non-standalone output stays byte-identical.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

/** #3468 closure-own-property side table. */
const IS_CLOSURE_PROP_CARRIER = "__is_closure_prop_carrier";
const CLOSURE_BAG_LOOKUP = "__closure_bag_lookup";

/** Splice-site contract: the host function's `$Object` type + `__obj_find` idx. */
export interface BagHasOwnArgs {
  /** `__obj_find(ref $Object, externref key) -> ref null $PropEntry`. */
  objFindIdx: number;
  /** The `$Object` struct type index. */
  objectTypeIdx: number;
}

/**
 * The local `emitHasOwn` must append for {@link buildHasOwnNonObjectBail} to use.
 * Declared here so the index below and the registration stay in one place — the
 * arm reads it by absolute index, which is exactly the coupling that rots when
 * the two halves live in different files.
 */
export const HASOWN_BAG_LOCAL: { readonly name: string; readonly type: ValType } = {
  name: "bag",
  type: { kind: "externref" },
};

/** `emitHasOwn` params are 0/1 and its first local (`any`) is 2, so `bag` is 3. */
const BAG_LOCAL_INDEX = 3;

/**
 * `__obj_find(bag, key) != null`, returned from the enclosing function.
 *
 * A FACTORY, never a shared array: the result is spliced into two arms of the
 * same body, and aliasing one `Instr[]` into both makes the finalize walks remap
 * it twice (see `reference_shared_instr_object_dce_double_remap`).
 *
 * The `ref.test` guard is not decoration — a bag is always a `__new_plain_object`
 * product today, but a bare `ref.cast` here would turn any future substrate
 * change into a runtime trap inside a helper that must never throw.
 */
function bagProbe(args: BagHasOwnArgs): Instr[] {
  return [
    { op: "local.get", index: BAG_LOCAL_INDEX },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: args.objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: BAG_LOCAL_INDEX },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: args.objectTypeIdx },
        { op: "local.get", index: 1 }, // key
        { op: "call", funcIdx: args.objFindIdx },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "return" },
      ],
    },
  ];
}

/** One carrier arm: `if (isCarrier(obj)) { bag = lookup(obj); if (bag) probe }`. */
function carrierArm(ctx: CodegenContext, isCarrierName: string, bagLookupName: string, args: BagHasOwnArgs): Instr[] {
  const isCarrierIdx = ctx.funcMap.get(isCarrierName);
  const bagLookupIdx = ctx.funcMap.get(bagLookupName);
  if (isCarrierIdx === undefined || bagLookupIdx === undefined) return [];
  return [
    { op: "local.get", index: 0 }, // obj
    { op: "call", funcIdx: isCarrierIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 }, // obj
        { op: "call", funcIdx: bagLookupIdx },
        { op: "local.tee", index: BAG_LOCAL_INDEX },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        { op: "if", blockType: { kind: "empty" }, then: bagProbe(args) },
      ],
    },
  ];
}

/**
 * The WHOLE `then:` body of `emitHasOwn`'s `ref.test $Object` bail: consult the
 * carrier bag, else answer `false`.
 *
 * It owns the terminal `i32.const 0; return` so the caller in `object-runtime.ts`
 * stays a single expression — the arm and the answer it falls through to are one
 * decision and belong in one place. A `$Object` receiver never reaches here, so
 * it pays nothing for the carrier predicate.
 */
export function buildHasOwnNonObjectBail(ctx: CodegenContext, args: BagHasOwnArgs): Instr[] {
  return [
    ...carrierArm(ctx, IS_CLOSURE_PROP_CARRIER, CLOSURE_BAG_LOOKUP, args),
    { op: "i32.const", value: 0 },
    { op: "return" },
  ];
}
