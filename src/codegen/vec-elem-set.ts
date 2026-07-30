// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#2856 C2) On-demand `__vec_elem_set_<vecTypeIdx>` helper — the IR's
// element-store dual of the legacy inline `compileElementAssignment` vec
// path (src/codegen/expressions/assignment.ts). One defined function per
// vec struct type, materialized lazily via the IR resolver's `resolveFunc`
// interception (same append-only discipline as `ensureFmod`, #2945 — a
// DEFINED function appended at mint time, never an import, so no existing
// funcIdx shifts).
//
// Semantics — EXACT legacy parity (JS `arr[i] = v` on a growable vec):
//   1. Null receiver → throw TypeError (`ref.null.extern` payload on the
//      shared `__exn` tag) — the legacy null-guard shape (#441).
//   2. idx >= capacity → grow the backing array to
//      `max(idx + 1, oldCap * 2, 4)`, copy the old contents, and point the
//      vec's `data` field at the new array (legacy grow sequence,
//      assignment.ts:4094-4178).
//   3. `data[idx] = val`.
//   4. idx + 1 > vec.length → vec.length = idx + 1 (JS length update on
//      OOB writes).
//
// The helper is pure WasmGC — no host import — so it works identically in
// JS-host and standalone modes (the dual-mode rule).
import type { Instr, ValType, WasmFunction } from "../ir/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType } from "./registry/types.js";
import { ensureExnTag } from "./registry/imports.js";

/** Reserved name prefix; the suffix is the vec STRUCT typeIdx. */
export const VEC_ELEM_SET_PREFIX = "__vec_elem_set_";
export const VEC_NEW_SIZED_PREFIX = "__vec_new_sized_";

/**
 * Ensure a one-shot sized-vector allocator for a canonical dense-fill loop.
 *
 * Signature: `(f64 upperBound) -> (ref null $vec_<t>)`.
 * The loop `for (let i = 0; i < upperBound; i++)` executes
 * `max(ceil(upperBound), 0)` iterations for finite practical bounds, so that
 * value is both the required capacity and the post-loop JavaScript length.
 */
export function ensureVecNewSized(ctx: CodegenContext, vecTypeIdx: number): number | null {
  const name = `${VEC_NEW_SIZED_PREFIX}${vecTypeIdx}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct" || vecDef.fields.length !== 2) return null;
  if (vecDef.fields[0]?.name !== "length" || vecDef.fields[1]?.name !== "data") return null;
  const dataField = vecDef.fields[1]!.type;
  if (dataField.kind !== "ref" && dataField.kind !== "ref_null") return null;
  const arrTypeIdx = dataField.typeIdx;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return null;

  const resultType: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  const sigIdx = addFuncType(ctx, [{ kind: "f64" }], [resultType], `$${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  const fn: WasmFunction = {
    name,
    typeIdx: sigIdx,
    locals: [{ name: "$length", type: { kind: "i32" } }],
    body: [
      { op: "local.get", index: 0 },
      { op: "f64.ceil" },
      { op: "f64.const", value: 0 },
      { op: "f64.max" },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.tee", index: 1 },
      { op: "local.get", index: 1 },
      { op: "array.new_default", typeIdx: arrTypeIdx },
      { op: "struct.new", typeIdx: vecTypeIdx },
    ],
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}

/**
 * Ensure the element-store helper for the vec struct at `vecTypeIdx` exists
 * and return its funcIdx. Idempotent (funcMap-cached by name).
 *
 * Signature: `((ref null $vec_<t>) vec, i32 idx, <elem> val) -> ()`.
 *
 * Returns `null` (no helper) when `vecTypeIdx` doesn't name a recognisable
 * `{ length: i32, data: (ref $arr) }` vec struct — the caller treats that
 * as a clean IR demotion.
 */
export function ensureVecElemSet(ctx: CodegenContext, vecTypeIdx: number): number | null {
  const name = `${VEC_ELEM_SET_PREFIX}${vecTypeIdx}`;
  const existing = ctx.funcMap.get(name);
  if (existing !== undefined) return existing;

  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct" || vecDef.fields.length !== 2) return null;
  if (vecDef.fields[0]?.name !== "length" || vecDef.fields[1]?.name !== "data") return null;
  const dataField = vecDef.fields[1]!.type;
  if (dataField.kind !== "ref" && dataField.kind !== "ref_null") return null;
  const arrTypeIdx = (dataField as { typeIdx: number }).typeIdx;
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return null;
  // Packed i8/i16 elements have no value-position encoding for the `val`
  // param (#2159) — those vecs back TypedArrays, which the IR element-store
  // arm refuses at from-ast time anyway. Refuse here too, defensively.
  const elem = arrDef.element;
  if (elem.kind === "i8" || elem.kind === "i16") return null;

  const tagIdx = ensureExnTag(ctx);
  const vecParam: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  const sigIdx = addFuncType(ctx, [vecParam, { kind: "i32" }, elem], [], `$${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);

  // Params: 0=vec, 1=idx, 2=val. Locals: 3=data, 4=newCap, 5=newData, 6=oldCap.
  const VEC = 0;
  const IDX = 1;
  const VAL = 2;
  const DATA = 3;
  const NCAP = 4;
  const NDATA = 5;
  const OCAP = 6;

  const body: Instr[] = [
    // ── Null guard (#441 parity): if (vec == null) throw TypeError ─────────
    { op: "local.get", index: VEC },
    { op: "ref.is_null" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [{ op: "ref.null.extern" }, { op: "throw", tagIdx }],
      else: [],
    },
    // ── data = vec.data ─────────────────────────────────────────────────────
    { op: "local.get", index: VEC },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 1 },
    { op: "local.set", index: DATA },
    // ── Grow when idx >= capacity (legacy sequence) ─────────────────────────
    { op: "local.get", index: IDX },
    { op: "local.get", index: DATA },
    { op: "array.len" },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // oldCap = array.len(data)
        { op: "local.get", index: DATA },
        { op: "array.len" },
        { op: "local.set", index: OCAP },
        // newCap = idx + 1
        { op: "local.get", index: IDX },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "local.set", index: NCAP },
        // if (oldCap * 2 > newCap) newCap = oldCap * 2
        { op: "local.get", index: OCAP },
        { op: "i32.const", value: 1 },
        { op: "i32.shl" },
        { op: "local.get", index: NCAP },
        { op: "i32.gt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: OCAP },
            { op: "i32.const", value: 1 },
            { op: "i32.shl" },
            { op: "local.set", index: NCAP },
          ],
        },
        // if (4 > newCap) newCap = 4
        { op: "i32.const", value: 4 },
        { op: "local.get", index: NCAP },
        { op: "i32.gt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "i32.const", value: 4 },
            { op: "local.set", index: NCAP },
          ],
        },
        // newData = array.new_default(newCap)
        { op: "local.get", index: NCAP },
        { op: "array.new_default", typeIdx: arrTypeIdx },
        { op: "local.set", index: NDATA },
        // array.copy newData[0..oldCap] = data[0..oldCap]
        { op: "local.get", index: NDATA },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: DATA },
        { op: "i32.const", value: 0 },
        { op: "local.get", index: OCAP },
        { op: "array.copy", dstTypeIdx: arrTypeIdx, srcTypeIdx: arrTypeIdx },
        // vec.data = newData
        { op: "local.get", index: VEC },
        { op: "local.get", index: NDATA },
        { op: "ref.as_non_null" },
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 1 },
        // data = newData
        { op: "local.get", index: NDATA },
        { op: "local.set", index: DATA },
      ],
    },
    // ── data[idx] = val ─────────────────────────────────────────────────────
    { op: "local.get", index: DATA },
    { op: "local.get", index: IDX },
    { op: "local.get", index: VAL },
    { op: "array.set", typeIdx: arrTypeIdx },
    // ── if (idx + 1 > vec.length) vec.length = idx + 1 ─────────────────────
    { op: "local.get", index: IDX },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.get", index: VEC },
    { op: "struct.get", typeIdx: vecTypeIdx, fieldIdx: 0 },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: VEC },
        { op: "local.get", index: IDX },
        { op: "i32.const", value: 1 },
        { op: "i32.add" },
        { op: "struct.set", typeIdx: vecTypeIdx, fieldIdx: 0 },
      ],
    },
  ];

  const fn: WasmFunction = {
    name,
    typeIdx: sigIdx,
    locals: [
      { name: "$data", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      { name: "$ncap", type: { kind: "i32" } },
      { name: "$ndata", type: { kind: "ref_null", typeIdx: arrTypeIdx } },
      { name: "$ocap", type: { kind: "i32" } },
    ],
    body,
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}
