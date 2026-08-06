// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4010 S1′) The seam between the two disjoint array own-property tables.
 *
 * ## The defect this closes
 * A named expando written by assignment (`arr.q = 12`) lands in the #3537
 * **bag** (`vec-props.ts`). A later `Object.defineProperty(arr,"q",{…})` lands
 * in the #3251 **companion** (`vec-overlay.ts`), which has never heard of `q`.
 * `__extern_get`'s named-key prologue then treats the companion as
 * authoritative for any non-index key and returns its never-populated value
 * field — so `arr.q` becomes **`undefined`**. Two identity-keyed tables, each
 * scoping the other out in its own header, one clobbering the other. That is
 * the defect #4010 leads with, measured:
 *
 * ```js
 * arr.q = 12;
 * Object.defineProperty(arr, "q", { writable: false });
 * arr.q   // => undefined, should be 12
 * ```
 *
 * ## Why SEEDING is the spec-correct fix, not a read-side patch
 * §10.1.6.3 ValidateAndApplyPropertyDescriptor **preserves the existing
 * `[[Value]]`** when the incoming descriptor omits one. That rule is already
 * implemented correctly by the `$Object` define native `__vec_dp_value`
 * delegates to — it simply has nothing to preserve, because the existing value
 * lives in the *other* table. Seeding the companion's **pre-state** from the bag
 * lets the existing, correct rule do the work.
 *
 * Patching `__extern_get` instead would fix one reader and leave the store
 * incoherent for every other one — which is the shape of defect this issue
 * exists to end, not to add to.
 *
 * ## This is the NAMED-KEY TWIN of `seedIfRealElement`
 * `vec-overlay.ts` already seeds the companion's pre-state from the **vec
 * element** when the key is an in-bounds index. This module is the same move
 * for a **named** key, sourcing from the bag instead. The symmetry is the
 * argument that the site is right: the index half was always here.
 *
 * ## Why this cannot fire the −684 mechanism (#4010's ordering law)
 * **No own-property visibility surface moves.** The companion already gains an
 * entry for the key today — the delegate creates it; this only populates its
 * value. `__hasOwnProperty` / `__object_hasOwn` / `Object.keys` / gOPD reach is
 * byte-identical, which is what #4055 v1 changed when it cost **−684** host-free
 * passes (713 files lost, 682 of them `built-ins/**\/{name,length}.js`, 696
 * failing "descriptor should be configurable"). Per #4010's ordering law —
 * *own-property visibility cannot ship before own-property deletability* —
 * visibility widening waits for tombstones (S2/S3). `tests/issue-4010.test.ts`
 * pins the unchanged visibility answers so a later slice must flip them
 * deliberately.
 *
 * ## Guards, mirroring the index twin exactly
 * Seeds only when the companion has **no entry yet** for the key, so an existing
 * companion entry is never overwritten; and only when the bag actually holds the
 * key, so a key neither table knows is untouched. A descriptor that *does* carry
 * `[[Value]]` is unaffected — the delegate overwrites the seed immediately after.
 *
 * ## Byte-neutrality
 * Reached only from `fillVecOverlayHelpers`, which returns early unless
 * `ctx.standalone`, so gc/host output is unchanged. Degrades to emitting nothing
 * when `vec-props.ts` reserved no helpers (a module with no expando writes).
 *
 * ## (#4010 S2) The DELETE side of the same seam
 * `buildVecDeletePrologue` below is the vec arm of `__delete_property`, moved
 * here from `vec-overlay.ts` so both directions of the seam — seeding a value IN
 * and taking a property OUT — have one owner. Its S2 change is the mirror of the
 * seed's: the companion is not the whole store, so
 *
 *  - when the companion has **no** entry for the key, the #3537 bag is consulted
 *    before reporting the historical no-op success (this is the `STILL PRESENT`
 *    cell of #4010's capability matrix, measured on both arms); and
 *  - when the companion **did** hold the key and the delete succeeded, the bag is
 *    **shadowed** as well. Without that step a tombstoned companion entry simply
 *    makes `__obj_find` return null again and `__extern_get`'s named-key prologue
 *    falls through to the bag, which still holds the value — measured, not
 *    assumed: `a.q=12; Object.defineProperty(a,"q",{writable:true}); delete a.q`
 *    left `a.q === 12` with a companion-only tombstone.
 *
 * Both steps go through `__carrier_bag_delete` (`carrier-bag-delete.ts`), whose
 * tri-state result keeps them additive; see that module for why.
 */
import type { Instr, WasmFunction } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { CARRIER_BAG_DELETE } from "./carrier-bag-delete.js";
import { buildBagGopdFallback, buildBagHasFallback } from "./carrier-bag-visibility.js"; // (#4010 S3)
import { nativeStringLiteralInstrs } from "./native-strings.js";

/**
 * (#4010 S3) `__vec_gopd`'s LAST RESORT, spliced in front of its miss: the
 * #3537 expando bag. Reached only when the #3251 companion has no entry AND the
 * key is not an in-bounds index — i.e. exactly where the native used to answer
 * `undefined`, so it is additive. `__carrier_bag_gopd` returns null ("not
 * handled") for a key the bag does not hold, which keeps `miss` reachable.
 */
export function buildBagGopdOrMiss(ctx: CodegenContext, tmp: number, miss: Instr[]): Instr[] {
  return [...buildBagGopdFallback(ctx, tmp), ...miss];
}

/** #3537 array expando bag reader (`vec-props.ts`). */
const VEC_PROP_GET = "__vec_prop_get";

/**
 * INDEX-key seed (moved here from `vec-overlay.ts` by #4010 S1′ so both key
 * kinds have ONE owner — the point of this issue). Seeds an in-bounds real vec
 * element into an entry-less companion:
 * `__defineProperty_value(compExt, key, __extern_get_idx(vec, f64(i)), SEED_FLAGS)`.
 * Behaviour is byte-identical to the inline version it replaces; `tests/issue-4010.test.ts`
 * carries an explicit index-key case pinning that.
 */
export function buildRealElementSeed(
  l: BagSeedLocals & { len: number },
  objFindIdx: number,
  dpValueIdx: number,
  externGetIdxIdx: number,
  seedFlags: number,
): Instr[] {
  return [
    { op: "local.get", index: l.i },
    { op: "i32.const", value: 0 },
    { op: "i32.ge_s" },
    { op: "local.get", index: l.i },
    { op: "local.get", index: l.len },
    { op: "i32.lt_s" },
    { op: "i32.and" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: l.comp },
        { op: "ref.as_non_null" },
        { op: "local.get", index: l.key },
        { op: "call", funcIdx: objFindIdx },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: l.compExt },
            { op: "local.get", index: l.key },
            { op: "local.get", index: l.vec },
            { op: "local.get", index: l.i },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: externGetIdxIdx },
            { op: "f64.const", value: seedFlags },
            { op: "call", funcIdx: dpValueIdx },
            { op: "drop" },
          ],
        },
      ],
    },
  ];
}

/** Locals of `__vec_dp_value` this splice reads. */
export interface BagSeedLocals {
  /** companion `$Object` (ref null) */
  comp: number;
  /** companion as externref */
  compExt: number;
  /** property key (externref) */
  key: number;
  /** the vec receiver (externref) */
  vec: number;
  /** parsed array index, < 0 for a named key */
  i: number;
}

/**
 * Emit the named-key companion seed. Returns `[]` (a no-op splice) when either
 * the #3537 bag or the undefined predicate is absent from this module.
 *
 * @param objFindIdx  `__obj_find(comp, key) -> $PropEntry?`
 * @param dpValueIdx  the `$Object` `__defineProperty_value(obj, key, v, flags)`
 * @param seedFlags   `SEED_FLAGS` — bits 0-2 values, 3-5 specified, 7 hasValue
 */
export function buildBagValueSeed(
  ctx: CodegenContext,
  l: BagSeedLocals,
  objFindIdx: number,
  dpValueIdx: number,
  seedFlags: number,
): Instr[] {
  const vecPropGetIdx = ctx.funcMap.get(VEC_PROP_GET);
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  if (vecPropGetIdx === undefined || isUndefinedIdx === undefined) return [];
  return [
    // named (non-index) key only — the index case is seedIfRealElement's
    { op: "local.get", index: l.i },
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // ...and the companion has no entry for this key yet
        { op: "local.get", index: l.comp },
        { op: "ref.as_non_null" },
        { op: "local.get", index: l.key },
        { op: "call", funcIdx: objFindIdx },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // ...and the #3537 bag holds a real value for it
            { op: "local.get", index: l.vec },
            { op: "local.get", index: l.key },
            { op: "call", funcIdx: vecPropGetIdx },
            { op: "call", funcIdx: isUndefinedIdx },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: l.compExt },
                { op: "local.get", index: l.key },
                { op: "local.get", index: l.vec },
                { op: "local.get", index: l.key },
                { op: "call", funcIdx: vecPropGetIdx },
                { op: "f64.const", value: seedFlags },
                { op: "call", funcIdx: dpValueIdx },
                { op: "drop" },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/**
 * (#4010 S3) Splice the vec arms into the own-property PREDICATES —
 * `__hasOwnProperty` / `__object_hasOwn` / `__propertyIsEnumerable`.
 *
 * Moved here from `vec-overlay.ts` because this IS the overlay-to-bag seam that
 * this module owns (the other direction of the same seam as the value seed and
 * the delete arm), and because the god-file it came from has no LOC headroom.
 *
 * These predicates are independent natives, not wrappers around gOPD. The
 * prologue consults the #3251 overlay so implicit indices and companion
 * properties are own — and, since S3, falls through to the #3537 BAG when the
 * overlay says no. Before S3 it `return`ed the overlay answer UNCONDITIONALLY,
 * which is exactly why #4010's matrix recorded array `hasOwn` as ABSENT: a
 * bag-only expando could never reach the bag. The affirmative answer is
 * unchanged and still wins first; only the `false` is widened, so the change is
 * additive.
 *
 * The bag consult is repeated here rather than left to `__vec_gopd`'s own
 * fallback because `__vec_gopd` bails EARLY for a non-whitelisted carrier
 * (TypedArray / subview) and for `length` — and `hasOwn` must not disagree with
 * `in` on those receivers.
 */
export function fillVecHasOwnHelpers(ctx: CodegenContext, vecBaseIdx: number): void {
  // Resolved by NAME (the #3251 overlay's `__vec_gopd`) rather than by importing
  // vec-overlay's private constant — that would be a cycle, since vec-overlay
  // imports this module.
  const vecGopdIdx = ctx.funcMap.get("__vec_gopd");
  const isUndefinedIdx = ctx.funcMap.get("__extern_is_undefined");
  if (vecGopdIdx === undefined || isUndefinedIdx === undefined) return;
  // These predicates are independent natives, not wrappers around gOPD.
  // Consult the overlay so implicit indices and companion properties are own.
  for (const name of ["__hasOwnProperty", "__object_hasOwn"]) {
    const fn = ctx.mod.functions.find((candidate) => candidate.name === name);
    if (!fn) continue;
    fn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: vecBaseIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: vecGopdIdx },
          { op: "call", funcIdx: isUndefinedIdx },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 1 }, { op: "return" }],
          },
          // (#4010 S3) This prologue used to `return` the gOPD answer
          // UNCONDITIONALLY, which is why the #4010 matrix recorded array
          // `hasOwn` as ABSENT: a bag-only expando never reached the #3537 bag.
          // The affirmative answer above is unchanged and still wins; only the
          // `false` falls through to the bag. The consult is repeated here
          // rather than left to `__vec_gopd`'s own fallback because `__vec_gopd`
          // bails EARLY for a non-whitelisted carrier (TypedArray/subview) and
          // for `length`, and `hasOwn` must not disagree with `in` on those.
          ...buildBagHasFallback(ctx),
          { op: "i32.const", value: 0 },
          { op: "return" },
        ],
      },
    );
  }

  const propertyIsEnumerableFn = ctx.mod.functions.find((candidate) => candidate.name === "__propertyIsEnumerable");
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const unboxBooleanIdx = ctx.funcMap.get("__unbox_boolean");
  if (propertyIsEnumerableFn && externGetIdx !== undefined && unboxBooleanIdx !== undefined) {
    const descLocal = 2 + propertyIsEnumerableFn.locals.length;
    propertyIsEnumerableFn.locals.push({ name: "__vec_desc", type: { kind: "externref" } });
    propertyIsEnumerableFn.body.unshift(
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: vecBaseIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: vecGopdIdx },
          { op: "local.tee", index: descLocal },
          { op: "call", funcIdx: isUndefinedIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 0 }, { op: "return" }],
          },
          { op: "local.get", index: descLocal },
          ...nativeStringLiteralInstrs(ctx, "enumerable"),
          { op: "extern.convert_any" },
          { op: "call", funcIdx: externGetIdx },
          { op: "call", funcIdx: unboxBooleanIdx },
          { op: "return" },
        ],
      },
    );
  }
}

/** Everything `buildVecDeletePrologue` needs from `fillVecOverlayHelpers`. */
export interface VecDeleteDeps {
  objectTypeIdx: number;
  propEntryTypeIdx: number;
  vecBaseIdx: number;
  vecGopdIdx: number;
  toPropertyKeyIdx: number;
  externIsUndefinedIdx: number;
  externGetIdx: number;
  unboxBoolIdx: number;
  deletePropertyIdx: number;
  dpValueIdx: number;
  objFindIdx: number;
  ensureIdx: number;
  numericFlagGlobalIdx: number;
  /** `FLAG_DELETED_INDEX | FLAG_COMPANION_VALUE` — owned by `vec-overlay.ts`. */
  deletedIndexFlags: number;
  /** Fresh undefined-sentinel instrs (never a shared array — #DCE double-remap). */
  missExtern: () => Instr[];
  /** `idxLocal = __obj_index_of_key(key)` — canonical array index, or -1. */
  parseIndex: (keyLocal: number, idxLocal: number) => Instr[];
}

/**
 * Splice the vec arm into `__delete_property` (append-locals, splice-front —
 * the #2190/#3183 fill discipline). §13.5.1 / §10.1.10 on a vec receiver:
 *
 * ```
 * key = ToPropertyKey(key);
 * if (obj is a vec) {
 *   d = __vec_gopd(obj, key);
 *   if (d === undefined) {                     // the companion does not know it
 *     rc = __carrier_bag_delete(obj, key);     // (#4010 S2) ...but the BAG may
 *     if (rc >= 0) return rc;
 *     return 1;                                //   absent everywhere ⇒ success
 *   }
 *   if (!d.configurable) return 0;
 *   comp = ensure(obj);
 *   if (!isArrayIndex(key)) {
 *     rc = __delete_property(comp, key);
 *     if (rc) __carrier_bag_delete(obj, key);  // (#4010 S2) shadow the BAG
 *     return rc;
 *   }
 *   <index key: mark the element deleted via the companion — unchanged>
 * }
 * ```
 *
 * The index arm is byte-identical to the version this replaces: it defines
 * `undefined` into the companion and marks the entry
 * `FLAG_DELETED_INDEX | FLAG_COMPANION_VALUE` so the read prologues answer a
 * hole. Deliberately NOT given the bag steps — an index key's storage is the vec
 * element, and the bag never owns one (`__vec_prop_set` writes named keys). This
 * is the same explicit split as the seed's accessor exclusion: decide the case,
 * do not pattern-match the neighbouring arm.
 */
export function buildVecDeletePrologue(ctx: CodegenContext, fn: WasmFunction, d: VecDeleteDeps): void {
  const base = 2 + fn.locals.length;
  const anyLocal = base;
  const keyLocal = base + 1;
  const descLocal = base + 2;
  const compLocal = base + 3;
  const entryLocal = base + 4;
  const indexLocal = base + 5;
  const rcLocal = base + 6;
  fn.locals.push(
    { name: "__vec_del_any", type: { kind: "anyref" } },
    { name: "__vec_del_key", type: { kind: "externref" } },
    { name: "__vec_del_desc", type: { kind: "externref" } },
    { name: "__vec_del_comp", type: { kind: "ref_null", typeIdx: d.objectTypeIdx } },
    { name: "__vec_del_entry", type: { kind: "ref_null", typeIdx: d.propEntryTypeIdx } },
    { name: "__vec_del_index", type: { kind: "i32" } },
    { name: "__vec_del_rc", type: { kind: "i32" } },
  );

  const cbdIdx = ctx.funcMap.get(CARRIER_BAG_DELETE);
  /**
   * `rc = __carrier_bag_delete(obj, key); if (rc >= 0) return rc;`
   *
   * A FACTORY, not a shared array: since S3 this is spliced at two sites, and a
   * shared `Instr` object reachable from two places is remapped twice by the
   * finalize walks (`reference_shared_instr_object_dce_double_remap` / #1302).
   */
  const bagConsult = (): Instr[] =>
    cbdIdx === undefined
      ? []
      : [
          { op: "local.get", index: 0 },
          { op: "local.get", index: keyLocal },
          { op: "call", funcIdx: cbdIdx },
          { op: "local.tee", index: rcLocal },
          { op: "i32.const", value: 0 },
          { op: "i32.ge_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "local.get", index: rcLocal }, { op: "return" }],
          },
        ];
  /** Best-effort bag removal after the companion already agreed to the delete. */
  const bagShadow: Instr[] =
    cbdIdx === undefined
      ? []
      : [
          { op: "local.get", index: 0 },
          { op: "local.get", index: keyLocal },
          { op: "call", funcIdx: cbdIdx },
          { op: "drop" },
        ];

  fn.body.unshift(
    { op: "local.get", index: 1 },
    { op: "call", funcIdx: d.toPropertyKeyIdx },
    { op: "local.set", index: keyLocal },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: anyLocal },
    { op: "ref.test", typeIdx: d.vecBaseIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "local.get", index: keyLocal },
        { op: "call", funcIdx: d.vecGopdIdx },
        { op: "local.tee", index: descLocal },
        { op: "call", funcIdx: d.externIsUndefinedIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...bagConsult(), { op: "i32.const", value: 1 }, { op: "return" }],
        },
        { op: "local.get", index: descLocal },
        ...nativeStringLiteralInstrs(ctx, "configurable"),
        { op: "extern.convert_any" },
        { op: "call", funcIdx: d.externGetIdx },
        { op: "call", funcIdx: d.unboxBoolIdx },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [{ op: "i32.const", value: 0 }, { op: "return" }],
        },
        { op: "local.get", index: anyLocal },
        { op: "call", funcIdx: d.ensureIdx },
        { op: "local.set", index: compLocal },
        ...d.parseIndex(keyLocal, indexLocal),
        { op: "local.get", index: indexLocal },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            // (#4010 S3) S2 reached this arm only for a key the COMPANION knew,
            // because `__vec_gopd` answered `undefined` for a bag-only key and
            // the `bagConsult` branch above owned it. S3 made `__vec_gopd`
            // bag-aware, so a bag-only key now arrives here — and delegating it
            // to `__delete_property(comp, …)` would answer 1 (absent ⇒ success)
            // while `bagShadow`'s own refusal was discarded, i.e. a loud success
            // over a possibly-surviving value: the exact defect S2 was written
            // to remove. Route a key the companion does not own back to the
            // tri-state bag delete, which is authoritative for it.
            { op: "local.get", index: compLocal },
            { op: "ref.as_non_null" },
            { op: "local.get", index: keyLocal },
            { op: "call", funcIdx: d.objFindIdx },
            { op: "ref.is_null" },
            { op: "if", blockType: { kind: "empty" }, then: bagConsult() },
            { op: "local.get", index: compLocal },
            { op: "extern.convert_any" },
            { op: "local.get", index: keyLocal },
            { op: "call", funcIdx: d.deletePropertyIdx },
            { op: "local.tee", index: rcLocal },
            { op: "if", blockType: { kind: "empty" }, then: bagShadow },
            { op: "local.get", index: rcLocal },
            { op: "return" },
          ],
        },
        { op: "i32.const", value: 1 },
        { op: "global.set", index: d.numericFlagGlobalIdx },
        { op: "local.get", index: compLocal },
        { op: "extern.convert_any" },
        { op: "local.get", index: keyLocal },
        ...d.missExtern(),
        { op: "f64.const", value: 0xbc },
        { op: "call", funcIdx: d.dpValueIdx },
        { op: "drop" },
        { op: "local.get", index: compLocal },
        { op: "ref.as_non_null" },
        { op: "local.get", index: keyLocal },
        { op: "call", funcIdx: d.objFindIdx },
        { op: "local.tee", index: entryLocal },
        { op: "ref.is_null" },
        { op: "i32.eqz" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: entryLocal },
            { op: "ref.as_non_null" },
            { op: "local.get", index: entryLocal },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 2 },
            { op: "i32.const", value: d.deletedIndexFlags },
            { op: "i32.or" },
            { op: "struct.set", typeIdx: d.propEntryTypeIdx, fieldIdx: 2 },
          ],
        },
        { op: "i32.const", value: 1 },
        { op: "return" },
      ],
    },
  );
}
