// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4222) The overlay PRESENCE prologue — `__extern_has_idx`'s companion consult.
 *
 * ## The defect this closes
 * `__delete_property`'s vec arm (#4010, `buildVecDeletePrologue` in
 * `vec-bag-seed.ts`) tombstones a deleted array index: it defines `undefined`
 * into the #3251 overlay companion and marks the entry
 * `FLAG_DELETED_INDEX | FLAG_COMPANION_VALUE`. The **read** side has honoured
 * that since #3251 — `__extern_get_idx`'s prologue answers `undefined` through
 * the `FLAG_COMPANION_VALUE` arm, and `__vec_gopd` reports the index absent.
 *
 * The **presence** side never did. `__extern_has_idx`'s `$__vec_base` arm
 * answers `0 <= i < length`, and `delete` does not change `length`. Measured on
 * `main` before this module existed:
 *
 * ```js
 * const arr = [0, 1, 2, 3];
 * delete arr[1];
 * arr[1];        // undefined   ← Get already agreed
 * 1 in arr;      // true        ← HasProperty did not
 * ```
 *
 * §7.3.12 HasProperty and §7.3.2 Get must agree about which indices exist, and
 * every array HOF gates its per-index visit on the former (§23.1.3.* step 5.b) —
 * so `filter`/`every`/`some`/`forEach`/`map`/`indexOf` all visited indices the
 * program had deleted.
 *
 * ## Why this is a prologue on the chokepoint, not a fix at each call site
 * `__extern_has_idx` is the single presence chokepoint: `__extern_has`
 * delegates numeric keys to it, the typed `n in arr` arm now defers to it, the
 * `Object.keys` / for-in vec index loops gate each key on it, and
 * `overlayFilterAccess` (#4221 Wave 1) uses it as the HOF `hasIdx` predicate.
 * One prologue therefore makes all of them agree by construction — the same
 * argument that put the READ prologue on `__extern_get_idx` rather than in each
 * reader.
 *
 * ## Scope: it can only turn a `true` into a `false`
 * The prologue answers ONLY the deleted case. A companion entry also exists for
 * a plain SEEDED element (a data define seeds `{value, w/e/c: true}`) and for an
 * accessor; both of those are PRESENT, and the existing dense /
 * `protoIndexDirty` tail already answers them correctly. Everything that is not
 * a `FLAG_DELETED_INDEX` hit falls through to that tail byte-for-byte. This
 * respects #4010's ordering law — no own-property visibility is *widened* here,
 * only narrowed to match a deletion that already happened.
 *
 * ## Byte-neutrality
 * Reached only from `fillVecOverlayHelpers`, which returns early unless
 * `ctx.standalone`, so gc/host output is unchanged. Within standalone the
 * prologue is gated at runtime on the `__vec_overlay_numeric` flag global — the
 * same gate the `__extern_get_idx` prologue uses (#3673): a module that never
 * puts an INDEXED entry in a companion pays exactly one `global.get`, not the
 * linear companion-table scan.
 *
 * Splice discipline is the #2190/#3183 one shared with every other fill:
 * append-locals, splice-front, fresh `Instr` objects (a shared `Instr` reachable
 * from two places is remapped twice by the finalize walks —
 * `reference_shared_instr_object_dce_double_remap` / #1302).
 */
import type { Instr, WasmFunction } from "../ir/types.js";

/** Everything `buildVecHasIdxPresencePrologue` needs from `fillVecOverlayHelpers`. */
export interface VecPresenceDeps {
  objectTypeIdx: number;
  propEntryTypeIdx: number;
  vecBaseIdx: number;
  /** `__vec_overlay_lookup(anyref vec) -> (ref null $Object)`. */
  lookupIdx: number;
  /** The `__vec_overlay_numeric` flag global (#3673). */
  numericFlagGlobalIdx: number;
  /** `number_toString(f64) -> externref` — the canonical index key. */
  numToStringIdx: number;
  /** `__obj_find(obj, key) -> (ref null $PropEntry)`. */
  objFindIdx: number;
  /** `FLAG_DELETED_INDEX` — owned by `vec-overlay.ts`. */
  deletedIndexFlag: number;
  /** Prototype-chain HasProperty answer for a deleted own index. */
  deletedIndexMiss?: Instr[];
}

/**
 * Splice the overlay presence consult into `__extern_has_idx`
 * (`(externref v, f64 idx) -> i32`, params 0 and 1):
 *
 * ```
 * if (overlayHasNumericEntry) {
 *   if (v is a vec) {
 *     comp = __vec_overlay_lookup(v);
 *     if (comp != null) {
 *       e = __obj_find(comp, ToString(idx));
 *       if (e != null && (e.flags & FLAG_DELETED_INDEX))
 *         return prototypeHas(idx); // or 0 when the proto store is inactive
 *     }
 *   }
 * }
 * <existing dense / proto-chain body>
 * ```
 */
export function buildVecHasIdxPresencePrologue(fn: WasmFunction, d: VecPresenceDeps): void {
  const base = 2 + fn.locals.length;
  const anyLocal = base;
  const compLocal = base + 1;
  const entryLocal = base + 2;
  fn.locals.push(
    { name: "__ovh_any", type: { kind: "anyref" } },
    { name: "__ovh_comp", type: { kind: "ref_null", typeIdx: d.objectTypeIdx } },
    { name: "__ovh_e", type: { kind: "ref_null", typeIdx: d.propEntryTypeIdx } },
  );

  const prologue: Instr[] = [
    { op: "global.get", index: d.numericFlagGlobalIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "local.tee", index: anyLocal },
        { op: "ref.test", typeIdx: d.vecBaseIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: anyLocal },
            { op: "call", funcIdx: d.lookupIdx },
            { op: "local.tee", index: compLocal },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                // e = __obj_find(comp, number_toString(idx))
                { op: "local.get", index: compLocal },
                { op: "ref.as_non_null" },
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: d.numToStringIdx },
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
                    { op: "struct.get", typeIdx: d.propEntryTypeIdx, fieldIdx: 2 },
                    { op: "i32.const", value: d.deletedIndexFlag },
                    { op: "i32.and" },
                    {
                      op: "if",
                      blockType: { kind: "empty" },
                      then: [...(d.deletedIndexMiss ?? [{ op: "i32.const", value: 0 }]), { op: "return" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ];
  fn.body.splice(0, 0, ...prologue);
}
