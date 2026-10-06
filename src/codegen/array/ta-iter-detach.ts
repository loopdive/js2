// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 V3) `%ArrayIteratorPrototype%.next` over a TypedArray whose buffer is
 * detached mid-iteration must throw a TypeError (§23.1.5.2.1 step 6.b —
 * `IsTypedArrayOutOfBounds(taRecord)` is true for a detached buffer).
 *
 * `__ta_dyn_{keys,values,entries}` (ta-dyn-proto-methods.ts) build a SNAPSHOT
 * `$__IterRec` over a fresh canonical externref vec, so the record had no path
 * back to the view and `__iterator_next` stepped the snapshot to the end
 * (test262 `ArrayIteratorPrototype/next/detach-typedarray-in-progress.js`: 5
 * steps, no throw).
 *
 * The snapshot vec is now a `$__ta_iter_vec` — a subtype of the canonical vec
 * with one appended field, the iterated `$__ta_dyn_view` — and a FINALIZE arm
 * prepended to `__iterator_next` re-checks the view's buffer on every
 * non-exhausted step. Same shape as the `$__arguments_vec` subtype #6484 S4
 * uses for its live-length step: the brand is an O(1) `ref.test`, and every
 * consumer that reads the record's `vec` as the canonical type keeps working.
 *
 * Narrow by construction: the type is registered only by those three helpers,
 * so a module with no dynamic-view iterator registers nothing and its
 * `__iterator_next` keeps its bytes. An exhausted record (cursor latched at
 * INT32_MAX, §23.1.5.2.1 step 4) never reads the view again.
 *
 * Type-only imports: this leaf must not value-import a module inside the
 * import-cycle SCC, so the caller resolves every index and the throw sequence.
 */
import type { Instr, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

const TA_ITER_VEC_STRUCT = "__ta_iter_vec";
/** The appended field holding the iterated `$__ta_dyn_view`. */
const TA_ITER_VIEW_FIELD = 2;

/**
 * Register (once) `$__ta_iter_vec <: <canonical externref vec>` with the view
 * appended. Opens the canonical vec for subtyping exactly as
 * `getOrRegisterArgumentsVecType` does.
 */
export function getOrRegisterTaIterVecType(
  ctx: CodegenContext,
  canonVecTypeIdx: number,
  canonArrTypeIdx: number,
  dynViewTypeIdx: number,
): number {
  const existing = ctx.structMap.get(TA_ITER_VEC_STRUCT);
  if (existing !== undefined) return existing;
  const base = ctx.mod.types[canonVecTypeIdx];
  if (base && base.kind === "struct") base.final = false;
  const fields = [
    { name: "length", type: { kind: "i32" } as ValType, mutable: true },
    { name: "data", type: { kind: "ref", typeIdx: canonArrTypeIdx } as ValType, mutable: true },
    { name: "view", type: { kind: "ref_null", typeIdx: dynViewTypeIdx } as ValType, mutable: false },
  ];
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({ kind: "struct", name: TA_ITER_VEC_STRUCT, superTypeIdx: canonVecTypeIdx, fields });
  ctx.structMap.set(TA_ITER_VEC_STRUCT, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, TA_ITER_VEC_STRUCT);
  ctx.structFields.set(TA_ITER_VEC_STRUCT, fields);
  return typeIdx;
}

/** The registered `$__ta_iter_vec`, or undefined when no helper minted one. */
export function taIterVecTypeIdx(ctx: CodegenContext): number | undefined {
  return ctx.structMap.get(TA_ITER_VEC_STRUCT);
}

/**
 * The stack-neutral prologue for `__iterator_next(recExt)` (param 0): when the
 * record's `vec` is a `$__ta_iter_vec`, its cursor is not latched, and the
 * view's buffer is detached (`length < 0`, the #3173 marker), run `throwInstrs`.
 * Fresh instruction objects on every call (#2169b).
 */
export function buildTaIterDetachPrologue(
  iterRecTypeIdx: number,
  taIterVecIdx: number,
  dynViewTypeIdx: number,
  bufVecTypeIdx: number,
  throwInstrs: Instr[],
): Instr[] {
  const rec = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: iterRecTypeIdx },
  ];
  const buf = (): Instr[] => [
    ...rec(),
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 1 },
    { op: "ref.cast", typeIdx: taIterVecIdx },
    { op: "struct.get", typeIdx: taIterVecIdx, fieldIdx: TA_ITER_VIEW_FIELD },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: dynViewTypeIdx, fieldIdx: 1 },
  ];
  const detached: Instr[] = [
    ...buf(),
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "i32" } },
      then: [{ op: "i32.const", value: 0 }],
      else: [
        ...buf(),
        { op: "ref.as_non_null" },
        { op: "struct.get", typeIdx: bufVecTypeIdx, fieldIdx: 0 },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
      ],
    },
    { op: "if", blockType: { kind: "empty" }, then: throwInstrs },
  ];
  const liveTaRecord: Instr[] = [
    ...rec(),
    { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 1 },
    { op: "ref.test", typeIdx: taIterVecIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        ...rec(),
        { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 2 },
        { op: "i32.const", value: 0x7fffffff },
        { op: "i32.ne" },
        { op: "if", blockType: { kind: "empty" }, then: detached },
      ],
    },
  ];
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: iterRecTypeIdx },
    { op: "if", blockType: { kind: "empty" }, then: liveTaRecord },
  ];
}
