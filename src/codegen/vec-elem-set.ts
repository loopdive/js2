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
// Not IR-only: legacy reaches the same helper for rest-parameter collection
// (`codegen/index.ts`), the overlay stores (`vec-overlay.ts`), the vec arm of
// `__extern_set` and `__vec_dp_value` (`object-runtime.ts`) and self-hosted
// stdlib bodies (`stdlib-selfhost.ts`), on both lanes. Those callers pass only
// non-negative indices; the IR's store sites skip a negative one themselves
// (`emitElementWrite` in `ir/from-ast.ts`), so the helper never sees one.
//
// Semantics — legacy parity (JS `arr[i] = v` on a growable vec):
//   1. Null receiver → throw TypeError (`ref.null.extern` payload on the
//      shared `__exn` tag) — the legacy null-guard shape (#441).
//   2. idx >= capacity → grow the backing array to
//      `max(idx + 1, oldCap * 2, 4)`, copy the old contents, and point the
//      vec's `data` field at the new array (legacy grow sequence,
//      assignment.ts:4094-4178). (#7106) An f64 grow gap holds the absence
//      marker when the module can ask presence questions, else the undefined
//      marker — the #4491 T8/T11 choice legacy's inline store
//      (`compileElementAssignment`) already makes on every lane — so it never
//      reads back as `0`. Until #7106 this helper zero-filled the gap except
//      on a standalone module with hole presence, so a gap written through it
//      (the IR's stores, and legacy's `__extern_set`) read `0` where the same
//      store compiled inline read `undefined`. Every reader maps the markers:
//      the host bridge's `__vec_get` maps both to `undefined` (#3315, #4491
//      T11), and the flag gating its absence-marker arm
//      (`f64HoleMarkerEmitted`) is set at finalize for every module with an
//      f64 vec BEFORE `__vec_get` is built (`vec-access-exports.ts`), so a
//      helper materialized later cannot leave a marker the bridge misses.
//   3. `data[idx] = val`.
//   4. idx + 1 > vec.length → vec.length = idx + 1 (JS length update on
//      OOB writes).
//
// The helper is pure WasmGC — no host import — so it works identically in
// JS-host and standalone modes (the dual-mode rule).
import type { ValType, WasmFunction } from "../ir/types.js";
import { mintDefinedFunc, pushDefinedFunc } from "./func-space.js";
import type { CodegenContext } from "./context/types.js";
import { addFuncType, getOrRegisterHoleyArrayType, getOrRegisterVecType, isHoleyArrayType } from "./registry/types.js";
import { ensureExnTag } from "./registry/imports.js";
import { ensureHoleType, holeSentinelInstrs } from "./array-holes.js";
import { buildVectorGrowStoreBody, type VectorGrowStoreGapFill } from "../runtime/wasmgc/values/vector-grow-store.js";
import { f64HolesActive } from "./vec-f64-hole-presence.js";
import { HOLE_F64_BITS, UNDEF_F64_BITS } from "./value-tags.js";

/** Reserved name prefix; the suffix is the vec STRUCT typeIdx. */
export const VEC_ELEM_SET_PREFIX = "__vec_elem_set_";
export const VEC_NEW_SIZED_PREFIX = "__vec_new_sized_";
export const HOLEY_ARRAY_NEW = "__holey_array_new";

/**
 * Materialize the dedicated `$Hole`-filled sized-array allocator. Its result
 * has a distinct subtype brand, so the sparse representation never leaks into
 * ordinary externref vectors in the same module.
 */
export function ensureHoleyArrayNew(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get(HOLEY_ARRAY_NEW);
  if (existing !== undefined) return existing;

  const vecTypeIdx = getOrRegisterHoleyArrayType(ctx);
  const arrTypeIdx =
    ctx.mod.types[vecTypeIdx]?.kind === "struct" ? ctx.mod.types[vecTypeIdx]!.fields[1]?.type : undefined;
  if (!arrTypeIdx || (arrTypeIdx.kind !== "ref" && arrTypeIdx.kind !== "ref_null")) {
    throw new Error("holey array allocator requires a vec data field");
  }
  const dataTypeIdx = arrTypeIdx.typeIdx;
  const resultType: ValType = { kind: "ref_null", typeIdx: vecTypeIdx };
  const typeIdx = addFuncType(ctx, [{ kind: "i32" }], [resultType], `$${HOLEY_ARRAY_NEW}_type`);
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: HOLEY_ARRAY_NEW,
    typeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 0 },
      ...holeSentinelInstrs(ctx),
      { op: "local.get", index: 0 },
      { op: "array.new", typeIdx: dataTypeIdx },
      { op: "struct.new", typeIdx: vecTypeIdx },
    ],
    exported: false,
  });
  ctx.funcMap.set(HOLEY_ARRAY_NEW, funcIdx);
  return funcIdx;
}

function vecTypeIndexForElement(ctx: CodegenContext, elementValType: ValType): number | null {
  const elemKind =
    elementValType.kind === "ref" || elementValType.kind === "ref_null"
      ? `ref_${elementValType.typeIdx}`
      : elementValType.kind;
  const vecTypeIdx = getOrRegisterVecType(ctx, elemKind, elementValType);
  return vecTypeIdx >= 0 ? vecTypeIdx : null;
}

/** Resolve a logical element type at the final WasmGC helper boundary. */
export function ensureVecNewSizedForElement(ctx: CodegenContext, elementValType: ValType): number | null {
  const vecTypeIdx = vecTypeIndexForElement(ctx, elementValType);
  return vecTypeIdx === null ? null : ensureVecNewSized(ctx, vecTypeIdx);
}

/** Resolve a logical element type at the final WasmGC helper boundary. */
export function ensureVecElemSetForElement(ctx: CodegenContext, elementValType: ValType): number | null {
  const vecTypeIdx = vecTypeIndexForElement(ctx, elementValType);
  return vecTypeIdx === null ? null : ensureVecElemSet(ctx, vecTypeIdx);
}

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

  const holeyCarrier = isHoleyArrayType(ctx, vecTypeIdx) && elem.kind === "externref";
  // An f64 grow gap holds a marker on every lane, exactly as legacy's inline
  // store fills it (#4491 T8/T11): the absence marker where the module can ask
  // presence questions, else the undefined marker. Without one, an indexed
  // write past capacity grows the backing array with f64 zeroes, so the gap
  // reads back as `0`. Mark the carrier here as well as in literal lowering: a
  // module can first encounter a sparse indexed write before it emits a f64
  // literal marker.
  const f64Absence = elem.kind === "f64" && f64HolesActive(ctx);
  if (f64Absence) ctx.f64HoleMarkerEmitted = true;
  const gapFill: VectorGrowStoreGapFill = holeyCarrier
    ? { kind: "hole-global", globalIndex: ensureHoleType(ctx) }
    : elem.kind === "f64"
      ? { kind: "f64-hole", bits: f64Absence ? HOLE_F64_BITS : UNDEF_F64_BITS }
      : { kind: "default" };
  // (#4430) The branded sparse carrier is a FINAL subtype of the ordinary
  // externref vec, and BOTH fields this helper touches (`length`, `data`) are
  // declared on that parent. The IR path types the receiving binding from the
  // logical `vec<externref>` IrType, which carries no brand, so a holey-typed
  // parameter made the call itself unrepresentable — V8 rejected the module
  // with `local.set expected type (ref null $__holey_array), found (ref null
  // $__vec_externref)`. Take the PARENT carrier in the signature and in every
  // struct access: a holey instance is a valid argument by subtyping (the
  // legacy path, which does type its binding `$__holey_array`, is unaffected),
  // the hole-preserving growth semantics below are unchanged, and no cast is
  // needed in either direction. Same idiom as the #4426 `.length=` receiver
  // fix — type the receiver at the level that owns the fields being written.
  const parentTypeIdx = vecDef.superTypeIdx;
  const carrierTypeIdx = holeyCarrier && parentTypeIdx !== undefined ? parentTypeIdx : vecTypeIdx;

  const tagIdx = ensureExnTag(ctx);
  const vecParam: ValType = { kind: "ref_null", typeIdx: carrierTypeIdx };
  const sigIdx = addFuncType(ctx, [vecParam, { kind: "i32" }, elem], [], `$${name}_type`);
  const funcIdx = mintDefinedFunc(ctx);

  const { locals, body } = buildVectorGrowStoreBody({
    carrierTypeIndex: carrierTypeIdx,
    arrayTypeIndex: arrTypeIdx,
    exceptionTagIndex: tagIdx,
    gapFill,
  });

  const fn: WasmFunction = {
    name,
    typeIdx: sigIdx,
    locals,
    body,
    exported: false,
  };
  pushDefinedFunc(ctx, funcIdx, fn);
  ctx.funcMap.set(name, funcIdx);
  return funcIdx;
}
