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
 */
import type { Instr } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";

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
