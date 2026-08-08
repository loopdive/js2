// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4230) A COMPLETE own-enumerable-key source for a **vec** `Properties` map,
 * so `Object.defineProperties(O, arr)` / `Object.create(proto, arr)` stop
 * refusing with `[SITE-PROPS-BAG-NOT-AUTHORITATIVE]` under `--target
 * standalone`.
 *
 * ## The precondition this resolves, and how it was reframed
 * `object-runtime-descriptors.ts` refused every non-`$Object`, non-closure
 * `Properties`, stating the blocker as:
 *
 * > That arm becomes sound the moment ONE store is authoritative for a vec's
 * > own properties (#4010).
 *
 * That is **sufficient but not necessary**. What §20.1.2.3.1 actually needs
 * from `Properties` is a *complete* enumeration of its own enumerable keys —
 * and a union over a **closed, individually-enumerable** set of stores is
 * exactly as complete as a single store would be.
 *
 * The reframing is only legitimate because `Properties` is a **pure key
 * source** in that helper. Its `L_DESCS` local feeds one instruction,
 * `__obj_ordered`; the per-property *value* is read at step 3.b from the
 * ORIGINAL receiver via `__extern_get(props, key)` (the #3957 fix), which
 * already dispatches over every carrier — measured: an overlay-stored getter
 * on an array reads back correctly today (`.tmp/dp/probe2.mts`,
 * `t_arr_getread = 42`). So nothing here has to re-implement descriptor reads;
 * it only has to name every key.
 *
 * ## A vec has TWO stores, and #4010 S3 wired only one of them
 * | write | lands in | seen by `Object.keys` before this |
 * | --- | --- | --- |
 * | `arr.p = d` | #3537 bag (`vec-props.ts`) | yes (#4010 S3) |
 * | `Object.defineProperty(arr, "p", d)` | #3251 overlay companion | **no** |
 * | `arr[0] = d` | the vec's own `$data` | yes |
 *
 * Measured on this branch before the fix: an array carrying one bag key and one
 * overlay key reported `Object.keys(a).length === 3` where Node says `4`, and
 * `getOwnPropertyNames(a).length === 1` where Node says `5`. The overlay half
 * being invisible is the whole defect; the union closes it.
 *
 * ## Index keys are the one hole — so they REFUSE, they do not approximate
 * A vec's elements are own enumerable keys too, and they live in `$data` rather
 * than in either side table. Rendering `"0".."length-1"` as strings here would
 * be a second key-source implementation with its own failure modes, and getting
 * it subtly wrong reintroduces exactly the silent no-op #3957 forbade. So a vec
 * `Properties` with `length !== 0` yields **null** and the caller keeps
 * refusing, under the honest tag `[SITE-PROPS-VEC-INDEXED]` that the #4047
 * comment had already reserved for this case.
 *
 * `length === 0` is a *proof* that no index key exists in any of the three
 * stores, not a heuristic: an index define grows the array (`defineProperty([],
 * "0", …)` leaves `length === 1`), so a zero-length vec cannot be hiding one.
 *
 * ## Known, deliberate inaccuracy: cross-store key ORDER
 * Keys are emitted bag-first then overlay. True creation order ACROSS the two
 * stores is not recoverable — each `$Object` runs its own `nextSeq` counter
 * (#1837), so the two stores' sequence numbers are not comparable. Observable
 * only through side-effecting getters that interleave a plain assignment and a
 * `defineProperty` on the same map. Recorded rather than hidden: it is a
 * strictly smaller error than refusing the call, and it vanishes if the two
 * stores are ever unified.
 *
 * ## Reserve/fill, and what a skipped fill degrades to
 * `__vec_overlay_lookup` does not exist when the descriptor helpers are built —
 * it is minted inside `ensureOverlayCore` at finalize. So this native follows
 * the accessor-driver reserve/fill discipline (#1888 S5b, #329/#1899): reserved
 * as a placeholder returning null, filled from `fillObjVecReflectionHelpers`.
 * A skipped fill therefore degrades to **null ⇒ the caller refuses** — loud,
 * never a silent no-op. Reserved only when the #3537 substrate exists, so
 * gc/host output stays byte-identical.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import { mintDefinedFunc, pushDefinedFunc, definedFuncAt } from "./func-space.js";
import { addFuncType, getOrRegisterVecBaseType } from "./registry/types.js";

/** #3537 array-expando side table (`vec-props.ts`). */
const IS_VEC_PROP_CARRIER = "__is_vec_prop_carrier";
const VEC_BAG_LOOKUP = "__vec_bag_lookup";
/** #3251 descriptor overlay (`vec-overlay.ts`) — minted at FINALIZE. */
const VEC_OVERLAY_LOOKUP = "__vec_overlay_lookup";

/**
 * `(externref props) -> externref` — a fresh `$Object` whose own enumerable
 * keys are exactly the vec's, or **null = no complete key source** (not a vec,
 * or a vec carrying index elements).
 */
export const VEC_PROPS_KEYSRC = "__vec_props_keysrc";

const EXT: ValType = { kind: "externref" };

/** `$PropEntry.$flags` bits — mirrors of the object-runtime ABI (stable since #1888). */
const FLAG_WRITABLE = 0x01;
const FLAG_ENUMERABLE = 0x02;
const FLAG_CONFIGURABLE = 0x04;
/** Overlay/runtime bookkeeping entries that are NOT user-visible own properties. */
const FLAG_INTERNAL = 0x10;
const FLAG_DELETED_INDEX = 0x40;
/** Flags for a synthesized key-source entry: plain, enumerable, so `__obj_ordered` keeps it. */
const KEYSRC_FLAGS = FLAG_WRITABLE | FLAG_ENUMERABLE | FLAG_CONFIGURABLE;

/**
 * WasmGC `none` heap type (bottom of the anyref hierarchy) — a `ref.null none`
 * satisfies the `anyref` value slot `__obj_insert` takes. The key source never
 * reads these values back (step 3.b reads the ORIGINAL receiver), so a null
 * placeholder is the correct thing to store.
 */
const NONE_HEAP = -15;

/**
 * Reserve `__vec_props_keysrc` as a placeholder defined func so
 * `buildObjectDescriptorHelpers` can bake a `call <idx>` long before
 * `__vec_overlay_lookup` exists. Append-only mint, idempotent, and a no-op
 * unless the #3537 vec-expando substrate was reserved.
 */
export function reserveVecPropsKeySource(ctx: CodegenContext): void {
  if (ctx.funcMap.get(VEC_PROPS_KEYSRC) !== undefined) return;
  if (!ctx.standalone) return;
  if (ctx.funcMap.get(IS_VEC_PROP_CARRIER) === undefined) return;
  const typeIdx = addFuncType(ctx, [EXT], [EXT], `$${VEC_PROPS_KEYSRC}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: VEC_PROPS_KEYSRC,
    typeIdx,
    locals: [],
    // SAFE placeholder: null = "no complete key source", which makes the caller
    // keep its pre-existing refusal. Never a silent empty key walk.
    body: [{ op: "ref.null.extern" }],
    exported: false,
  });
  ctx.funcMap.set(VEC_PROPS_KEYSRC, funcIdx);
}

/**
 * `__defineProperties`' non-`$Object` `Properties` arm for a **vec** map:
 * substitute a merged key source built from the #3537 bag ∪ the #3251 overlay
 * companion, then fall through into the unchanged `$Object` key walk.
 *
 * Emits: if the value in `propsLocalIdx` is a vec carrier — build the key
 * source; null ⇒ `indexedFallback` (index elements, no complete source);
 * otherwise re-point `descsAnyLocalIdx` at it. Non-vec values run
 * `nonVecFallback` (the caller's pre-existing arm). Both fallbacks must
 * return/throw on their own. Returns `undefined` when the substrate is absent,
 * so the caller keeps its exact body AND local vector.
 */
export function vecPropertiesKeySourceArm(
  ctx: CodegenContext,
  opts: {
    propsLocalIdx: number;
    descsAnyLocalIdx: number;
    keySrcLocalIdx: number;
    indexedFallback: Instr[];
    nonVecFallback: Instr[];
  },
): Instr[] | undefined {
  const isVecIdx = ctx.funcMap.get(IS_VEC_PROP_CARRIER);
  const keySrcIdx = ctx.funcMap.get(VEC_PROPS_KEYSRC);
  if (isVecIdx === undefined || keySrcIdx === undefined) return undefined;
  return [
    { op: "local.get", index: opts.propsLocalIdx },
    { op: "call", funcIdx: isVecIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: opts.propsLocalIdx },
        { op: "call", funcIdx: keySrcIdx },
        { op: "local.tee", index: opts.keySrcLocalIdx },
        { op: "ref.is_null" },
        { op: "if", blockType: { kind: "empty" }, then: opts.indexedFallback },
        { op: "local.get", index: opts.keySrcLocalIdx },
        { op: "any.convert_extern" },
        { op: "local.set", index: opts.descsAnyLocalIdx },
      ],
      else: opts.nonVecFallback,
    },
  ];
}

/**
 * Fill `__vec_props_keysrc`. Called from `fillObjVecReflectionHelpers`, after
 * `ensureOverlayCore` has minted `__vec_overlay_lookup`. Order-independent with
 * respect to its callers: they baked the RESERVED index.
 */
export function fillVecPropsKeySource(ctx: CodegenContext): void {
  const selfIdx = ctx.funcMap.get(VEC_PROPS_KEYSRC);
  if (selfIdx === undefined) return;
  const fn = definedFuncAt(ctx, selfIdx);
  if (!fn) return;
  const types = ctx.objectRuntimeTypes;
  if (!types) return;
  const { objectTypeIdx, propMapTypeIdx, propEntryTypeIdx } = types;
  const bagLookupIdx = ctx.funcMap.get(VEC_BAG_LOOKUP);
  const overlayLookupIdx = ctx.funcMap.get(VEC_OVERLAY_LOOKUP);
  const objOrderedIdx = ctx.funcMap.get("__obj_ordered");
  const objInsertIdx = ctx.funcMap.get("__obj_insert");
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object");
  if (
    objOrderedIdx === undefined ||
    objInsertIdx === undefined ||
    newPlainObjectIdx === undefined ||
    (bagLookupIdx === undefined && overlayLookupIdx === undefined)
  ) {
    // Leave the null placeholder: the caller keeps refusing. A partial key
    // source would be the silent no-op #3957 forbade.
    return;
  }
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);

  // params: 0 = props(externref)
  const L_KS = 1; // merged key source ($Object as externref)
  const L_STORE = 2; // the store currently being drained (ref null $Object)
  const L_ARR = 3; // __obj_ordered(store)
  const L_CAP = 4;
  const L_I = 5;
  const L_E = 6;
  const L_SEQ = 7;
  const L_FL = 8;

  /**
   * Drain one store's own ENUMERABLE keys into the merged key source.
   * `loadStore` must leave a `(ref null $Object)` on the stack.
   */
  const drain = (loadStore: Instr[]): Instr[] => [
    ...loadStore,
    { op: "local.tee", index: L_STORE },
    { op: "ref.is_null" },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // arr = __obj_ordered(store) — already own+enumerable, tombstones
        // dropped, compacted, in OrdinaryOwnPropertyKeys order.
        { op: "local.get", index: L_STORE },
        { op: "ref.as_non_null" },
        { op: "call", funcIdx: objOrderedIdx },
        { op: "local.tee", index: L_ARR },
        { op: "array.len" },
        { op: "local.set", index: L_CAP },
        { op: "i32.const", value: 0 },
        { op: "local.set", index: L_I },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: L_I },
                { op: "local.get", index: L_CAP },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                { op: "local.get", index: L_ARR },
                { op: "ref.as_non_null" },
                { op: "local.get", index: L_I },
                { op: "array.get", typeIdx: propMapTypeIdx },
                { op: "local.tee", index: L_E },
                { op: "ref.is_null" },
                { op: "br_if", depth: 1 },
                // Skip runtime bookkeeping entries: the overlay's INTERNAL
                // records and its DELETED_INDEX gravestones are not own
                // properties of the array. (The seeded `length` entry is
                // already excluded — `LENGTH_SEED_FLAGS` leaves ENUMERABLE
                // clear, so `__obj_ordered` never yields it.)
                { op: "local.get", index: L_E },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                { op: "local.tee", index: L_FL },
                { op: "i32.const", value: FLAG_INTERNAL | FLAG_DELETED_INDEX },
                { op: "i32.and" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // __obj_insert(ks, entry.key, null, KEYSRC_FLAGS, seq++)
                    { op: "local.get", index: L_KS },
                    { op: "any.convert_extern" },
                    { op: "ref.cast", typeIdx: objectTypeIdx },
                    { op: "local.get", index: L_E },
                    { op: "ref.as_non_null" },
                    { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                    { op: "extern.convert_any" },
                    { op: "ref.null", typeIdx: NONE_HEAP },
                    { op: "i32.const", value: KEYSRC_FLAGS },
                    { op: "local.get", index: L_SEQ },
                    { op: "call", funcIdx: objInsertIdx },
                    { op: "local.get", index: L_SEQ },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: L_SEQ },
                  ],
                },
                { op: "local.get", index: L_I },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: L_I },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
    },
  ];

  const body: Instr[] = [
    // Index elements have no cheap complete key source → decline (the caller
    // refuses under [SITE-PROPS-VEC-INDEXED]). `length === 0` proves no index
    // key exists in ANY of the three stores, because an index define grows the
    // array.
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: vecBaseIdx },
    { op: "i32.eqz" },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: vecBaseIdx },
    { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
    { op: "if", blockType: { kind: "empty" }, then: [{ op: "ref.null.extern" }, { op: "return" }] },
    // ks = __new_plain_object() — a fresh, EMPTY key source is a complete and
    // correct answer (a vec with no side tables has no own named property).
    { op: "call", funcIdx: newPlainObjectIdx },
    { op: "local.set", index: L_KS },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: L_SEQ },
    // #3537 bag first, then the #3251 overlay companion. See the header on why
    // cross-store ORDER is not recoverable.
    ...(bagLookupIdx === undefined
      ? []
      : drain([
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: bagLookupIdx },
          { op: "any.convert_extern" },
          // `__vec_bag_lookup` answers externref; screen rather than bare-cast
          // so a future substrate change cannot trap inside a helper that must
          // never throw (#3468 S1 discipline).
          { op: "ref.test", typeIdx: objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: bagLookupIdx },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: objectTypeIdx },
            ],
            else: [{ op: "ref.null", typeIdx: NONE_HEAP }],
          },
        ])),
    ...(overlayLookupIdx === undefined
      ? []
      : drain([
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "call", funcIdx: overlayLookupIdx },
        ])),
    { op: "local.get", index: L_KS },
  ];

  fn.locals = [
    { name: "ks", type: EXT },
    { name: "store", type: { kind: "ref_null", typeIdx: objectTypeIdx } },
    { name: "arr", type: { kind: "ref_null", typeIdx: propMapTypeIdx } },
    { name: "cap", type: { kind: "i32" } },
    { name: "i", type: { kind: "i32" } },
    { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
    { name: "seq", type: { kind: "i32" } },
    { name: "fl", type: { kind: "i32" } },
  ];
  fn.body = body;
}
