// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6482 r4) The absence-marker fill every `length` store owes the backing
 * store.
 *
 * §10.4.2.1 ArraySetLength: shrinking DELETES the dropped elements and growing
 * creates HOLES. Neither leaves a value behind. The backing store did not agree
 * with that:
 *
 * - `arr.length = n` (`expressions/assignment.ts`) writes ONLY field 0, through
 *   the `$__vec_base` supertype — it never touches the data array, so a shrink
 *   leaves the old element sitting in its slot.
 * - `Object.defineProperty(arr, "length", …)` (`array-length-define.ts`)
 *   reallocates with `array.new_default`, which zero-fills the new tail.
 *
 * Either way the slot holds a legal-looking value, so `__vec_has_own_index`
 * — which reads the RAW element to tell a hole from a present one — honestly
 * reported an index that is not an own property as present. That is what
 * `15.2.3.7-6-a-161/162` (`[0,1]; length = 1; length = 10`) and
 * `15.2.3.6-4-159` (`[0, , 2]; length = 5`) assert about.
 *
 * ## Why this is a shared emitter rather than three ladders
 *
 * `__vec_set_len` already carries this fill inline (it has the concrete vec
 * type in hand). The other two sites do not: the assignment site holds the
 * receiver as `$__vec_base`, whose only field is `length`, so reaching the data
 * array needs a per-vec-type `ref.test` ladder. Rather than write that ladder
 * twice more, both sites call THIS, and the rule lives in one place.
 *
 * ## Scope: the f64 carrier only, and that is exact
 *
 * f64 is the carrier with a distinguishable absence marker (`HOLE_F64_BITS`, a
 * signaling NaN payload JS arithmetic cannot produce — `value-tags.ts`). Other
 * element kinds get nothing here: packed/byte/i32 carriers back typed arrays
 * and tuples, which have no holes by construction, and the externref carrier's
 * `$Hole` singleton is minted only in modules that already use array holes, so
 * forcing it here would mint a type — and shift every type index — in modules
 * that do not.
 *
 * Call this BEFORE the `length` store: it needs the OLD length to know which
 * region the store is about to orphan.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { getArrTypeIdxFromVec } from "./registry/types.js";
import { HOLE_F64_BITS } from "./value-tags.js";

/**
 * Emit, for every f64-backed vec type, a guarded fill of
 * `[min(oldLen, newLen), array.len(data))` with the absence marker.
 *
 * `vecLocal` may be typed as any vec (concrete or `$__vec_base`) — the ladder
 * `ref.test`s it against each concrete type and only the matching arm runs.
 * Leaves the operand stack unchanged.
 */
export function emitVecLengthHoleFill(
  ctx: CodegenContext,
  fctx: FunctionContext,
  vecLocal: number,
  newLenLocal: number,
  mode: "shrink-only" | "both" = "both",
): void {
  const f64Vecs: number[] = [];
  for (const vecTypeIdx of ctx.vecTypeMap.values()) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) continue;
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (arrDef === undefined || arrDef.kind !== "array") continue;
    if ((arrDef.element as ValType).kind !== "f64") continue;
    f64Vecs.push(vecTypeIdx);
  }
  if (f64Vecs.length === 0) return;

  const startLocal = allocLocal(fctx, `__vlhf_start_${fctx.locals.length}`, { kind: "i32" });

  for (const vecTypeIdx of f64Vecs) {
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    const dataLocal = allocLocal(fctx, `__vlhf_data_${fctx.locals.length}`, {
      kind: "ref_null",
      typeIdx: arrTypeIdx,
    });
    const fillBody: Instr[] = [
      // data — a null backing has nothing to fill
      { op: "local.get", index: vecLocal },
      { op: "ref.cast", typeIdx: vecTypeIdx },
      { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: dataLocal },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        else: [
          // count = array.len(data) - start, and only when positive
          { op: "local.get", index: dataLocal },
          { op: "array.len" },
          { op: "local.get", index: startLocal },
          { op: "i32.gt_u" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: dataLocal },
              { op: "local.get", index: startLocal },
              { op: "i64.const", value: HOLE_F64_BITS },
              { op: "f64.reinterpret_i64" },
              { op: "local.get", index: dataLocal },
              { op: "array.len" },
              { op: "local.get", index: startLocal },
              { op: "i32.sub" },
              { op: "array.fill", typeIdx: arrTypeIdx },
            ],
          },
        ],
        then: [],
      },
    ];
    const then: Instr[] =
      mode === "both"
        ? [
            // start = min(oldLen, newLen)
            { op: "local.get", index: vecLocal },
            { op: "ref.cast", typeIdx: vecTypeIdx },
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
            { op: "local.tee", index: startLocal },
            { op: "local.get", index: newLenLocal },
            { op: "i32.gt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: newLenLocal },
                { op: "local.set", index: startLocal },
              ],
            },
            ...fillBody,
          ]
        : [
            // Shrink only: fill [newLen, cap) and ONLY when the length actually
            // moves down. A GROW must not touch the tail here, because this site
            // also carries the `arr[len] = v; arr.length = len + 1` append shape
            // — the element is already in the slot when the length store runs,
            // and filling the tail would erase it.
            { op: "local.get", index: vecLocal },
            { op: "ref.cast", typeIdx: vecTypeIdx },
            { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
            { op: "local.get", index: newLenLocal },
            { op: "i32.gt_s" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: newLenLocal }, { op: "local.set", index: startLocal }, ...fillBody],
            },
          ];
    fctx.body.push({ op: "local.get", index: vecLocal });
    fctx.body.push({ op: "ref.test", typeIdx: vecTypeIdx });
    fctx.body.push({ op: "if", blockType: { kind: "empty" }, then });
  }
}
