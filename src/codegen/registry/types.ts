// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Wasm type registry ownership for the backend.
 *
 * This module owns function-type caches plus reusable GC array/vec/ref-cell
 * registrations so leaf modules can depend on a narrow type-registry surface.
 */
import type { ArrayTypeDef, FuncTypeDef, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";

/** Build a cache key for a function type signature (params + results). */
function funcTypeKey(params: ValType[], results: ValType[]): string {
  let key = "";
  for (let i = 0; i < params.length; i++) {
    const p = params[i]!;
    if (i > 0) key += ",";
    key += p.kind;
    if (p.kind === "ref" || p.kind === "ref_null") key += ":" + (p as { typeIdx: number }).typeIdx;
  }
  key += "|";
  for (let i = 0; i < results.length; i++) {
    const r = results[i]!;
    if (i > 0) key += ",";
    key += r.kind;
    if (r.kind === "ref" || r.kind === "ref_null") key += ":" + (r as { typeIdx: number }).typeIdx;
  }
  return key;
}

export function addFuncType(ctx: CodegenContext, params: ValType[], results: ValType[], name?: string): number {
  const key = funcTypeKey(params, results);
  const cached = ctx.funcTypeCache.get(key);
  if (cached !== undefined) return cached;
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "func",
    name: name ?? `type${idx}`,
    params,
    results,
  });
  ctx.funcTypeCache.set(key, idx);
  return idx;
}

function valTypeEq(a: ValType, b: ValType): boolean {
  if (a.kind !== b.kind) return false;
  if ((a.kind === "ref" || a.kind === "ref_null") && (b.kind === "ref" || b.kind === "ref_null")) {
    return a.typeIdx === (b as { typeIdx: number }).typeIdx;
  }
  return true;
}

export function funcTypeEq(t: FuncTypeDef, params: ValType[], results: ValType[]): boolean {
  if (t.params.length !== params.length) return false;
  if (t.results.length !== results.length) return false;
  for (let i = 0; i < params.length; i++) {
    if (!valTypeEq(t.params[i]!, params[i]!)) return false;
  }
  for (let i = 0; i < results.length; i++) {
    if (!valTypeEq(t.results[i]!, results[i]!)) return false;
  }
  return true;
}

/**
 * Get or register a Wasm array type for a given element kind.
 * Reuses existing registrations so each element type only gets one array type.
 */
export function getOrRegisterArrayType(ctx: CodegenContext, elemKind: string, elemTypeOverride?: ValType): number {
  if (ctx.arrayTypeMap.has(elemKind)) return ctx.arrayTypeMap.get(elemKind)!;
  let elemType: ValType =
    elemTypeOverride ??
    (elemKind === "f64" ? { kind: "f64" } : elemKind === "i32" ? { kind: "i32" } : { kind: "externref" });
  if (elemType.kind === "ref") {
    elemType = { kind: "ref_null", typeIdx: (elemType as { typeIdx: number }).typeIdx };
  }
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: `__arr_${elemKind}`,
    element: elemType,
    mutable: true,
  } as ArrayTypeDef);
  ctx.arrayTypeMap.set(elemKind, idx);
  return idx;
}

/**
 * (#2186) Get or register the shared `$__vec_base` supertype struct — a single
 * `(length i32)` field that every concrete `__vec_<elemKind>` subtypes. This
 * gives standalone runtime helpers a uniform `ref.test $__vec_base` /
 * `ref.cast $__vec_base` → `struct.get 0` path to read a boxed array's length
 * regardless of its element kind (the array-length-through-externref boundary
 * fix). Declared open (`superTypeIdx: -1`) so vecs can extend it. Idempotent.
 */
export function getOrRegisterVecBaseType(ctx: CodegenContext): number {
  if (ctx.vecBaseTypeIdx >= 0) return ctx.vecBaseTypeIdx;
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__vec_base",
    superTypeIdx: -1, // open / non-final — concrete vecs subtype this
    fields: [{ name: "length", type: { kind: "i32" }, mutable: true }],
  });
  ctx.vecBaseTypeIdx = idx;
  ctx.structMap.set("__vec_base", idx);
  ctx.typeIdxToStructName.set(idx, "__vec_base");
  ctx.structFields.set("__vec_base", [{ name: "length", type: { kind: "i32" as const }, mutable: true }]);
  return idx;
}

/**
 * Get or register a vec struct type wrapping a Wasm GC array.
 * The vec struct has {length: i32, data: (ref $__arr_<elemKind>)}.
 */
export function getOrRegisterVecType(ctx: CodegenContext, elemKind: string, elemTypeOverride?: ValType): number {
  const existing = ctx.vecTypeMap.get(elemKind);
  if (existing !== undefined) return existing;

  // (#2186) Ensure the shared `$__vec_base` length supertype exists before
  // registering any concrete vec. Every `__vec_<elemKind>` subtypes it so a
  // boxed array externref can be `ref.test`/`ref.cast`-ed to read `.length`
  // uniformly (the `__extern_length` `$__vec_base` arm). `length` (i32) is field
  // 0 of every vec, a valid struct-subtype prefix. The base is `superTypeIdx:-1`
  // (open / non-final) so vecs may extend it.
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);

  const arrTypeIdx = getOrRegisterArrayType(ctx, elemKind, elemTypeOverride);
  const vecIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `__vec_${elemKind}`,
    superTypeIdx: vecBaseIdx,
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      {
        name: "data",
        type: { kind: "ref", typeIdx: arrTypeIdx },
        mutable: true,
      },
    ],
  });
  ctx.vecTypeMap.set(elemKind, vecIdx);

  const vecStructName = `__vec_${elemKind}`;
  ctx.structMap.set(vecStructName, vecIdx);
  ctx.typeIdxToStructName.set(vecIdx, vecStructName);
  ctx.structFields.set(vecStructName, [
    { name: "length", type: { kind: "i32" as const }, mutable: true },
    { name: "data", type: { kind: "ref" as const, typeIdx: arrTypeIdx }, mutable: true },
  ]);

  return vecIdx;
}

/**
 * (#2159 / #2357 / #47) Get or register the `$__subview_<elemKind>` struct — a
 * TypedArray `subarray` view that SHARES the parent's backing array:
 *   `{length: i32, data: (ref null $__arr_<elemKind>), byteOffset: i32}`.
 *
 * `length` is field 0 (subtypes `$__vec_base`) so uniform `.length` reads and the
 * externref-length helper keep working. `data` holds the PARENT's backing array
 * DIRECTLY (shared — no copy); `byteOffset` is the element offset of the window
 * into that array. We deliberately store the array type (`$__arr_<elemKind>`,
 * uniquely deduped per element kind) rather than a concrete vec struct idx,
 * because the same element kind can be registered behind multiple vec struct
 * indices in a module (hoist-time vs body-time) — pinning to the array type makes
 * the subview idx-stable. Element access on a `$__subview` receiver reads
 * `data[byteOffset + i]`; a plain vec reads `vec.data[i]` unchanged. The
 * discrimination is by the receiver's static ValType.typeIdx at COMPILE time, so
 * the plain-array hot path is untouched. Keyed per element kind. Idempotent.
 */
export function getOrRegisterSubviewType(ctx: CodegenContext, elemKind: string, elemTypeOverride?: ValType): number {
  const existing = ctx.subviewTypeMap.get(elemKind);
  if (existing !== undefined) return existing;

  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  const arrTypeIdx = getOrRegisterArrayType(ctx, elemKind, elemTypeOverride);

  const idx = ctx.mod.types.length;
  const name = `__subview_${elemKind}`;
  ctx.mod.types.push({
    kind: "struct",
    name,
    superTypeIdx: vecBaseIdx, // length-prefix compatible with $__vec_base
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      { name: "data", type: { kind: "ref_null", typeIdx: arrTypeIdx }, mutable: false },
      { name: "byteOffset", type: { kind: "i32" }, mutable: false },
    ],
  });
  ctx.subviewTypeMap.set(elemKind, idx);
  ctx.subviewTypeIdx = idx;
  ctx.structMap.set(name, idx);
  ctx.typeIdxToStructName.set(idx, name);
  ctx.structFields.set(name, [
    { name: "length", type: { kind: "i32" as const }, mutable: true },
    { name: "data", type: { kind: "ref_null" as const, typeIdx: arrTypeIdx }, mutable: false },
    { name: "byteOffset", type: { kind: "i32" as const }, mutable: false },
  ]);
  return idx;
}

/** (#2357) The backing array type idx for a `$__subview_<elem>` struct (field 1). */
export function getSubviewArrTypeIdx(ctx: CodegenContext, subviewTypeIdx: number): number {
  const def = ctx.mod.types[subviewTypeIdx];
  if (!def || def.kind !== "struct") return -1;
  const dataField = def.fields[1];
  if (!dataField || (dataField.type.kind !== "ref" && dataField.type.kind !== "ref_null")) return -1;
  return (dataField.type as { typeIdx: number }).typeIdx;
}

/** (#2357) True iff `typeIdx` is a registered `$__subview_<elem>` struct. */
export function isSubviewTypeIdx(ctx: CodegenContext, typeIdx: number): boolean {
  for (const v of ctx.subviewTypeMap.values()) if (v === typeIdx) return true;
  return false;
}

/**
 * Get or register the template vec struct type for tagged template string arrays.
 */
export function getOrRegisterTemplateVecType(ctx: CodegenContext): number {
  if (ctx.templateVecTypeIdx >= 0) return ctx.templateVecTypeIdx;

  const baseVecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, baseVecTypeIdx);

  const baseVecDef = ctx.mod.types[baseVecTypeIdx];
  if (baseVecDef && baseVecDef.kind === "struct" && baseVecDef.superTypeIdx === undefined) {
    baseVecDef.superTypeIdx = -1;
  }

  const templateVecIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "__template_vec_externref",
    superTypeIdx: baseVecTypeIdx,
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      {
        name: "data",
        type: { kind: "ref", typeIdx: arrTypeIdx },
        mutable: true,
      },
      {
        name: "raw",
        type: { kind: "ref_null", typeIdx: baseVecTypeIdx },
        mutable: false,
      },
    ],
  });
  ctx.templateVecTypeIdx = templateVecIdx;
  return templateVecIdx;
}

/**
 * Get or register a ref cell struct type for mutable closure captures.
 */
export function getOrRegisterRefCellType(ctx: CodegenContext, valType: ValType): number {
  const key =
    valType.kind === "ref" || valType.kind === "ref_null"
      ? `${valType.kind}_${(valType as { typeIdx: number }).typeIdx}`
      : valType.kind;
  const existing = ctx.refCellTypeMap.get(key);
  if (existing !== undefined) return existing;

  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: `__ref_cell_${key}`,
    fields: [{ name: "value", type: valType, mutable: true }],
  });
  ctx.refCellTypeMap.set(key, typeIdx);
  return typeIdx;
}

/** Get the raw array type index from a vec struct type index. */
export function getArrTypeIdxFromVec(ctx: CodegenContext, vecTypeIdx: number): number {
  const vecDef = ctx.mod.types[vecTypeIdx];
  if (!vecDef || vecDef.kind !== "struct") return -1;
  const dataField = vecDef.fields[1];
  if (!dataField) return -1;
  if (dataField.type.kind !== "ref" && dataField.type.kind !== "ref_null") {
    return -1;
  }
  const arrTypeIdx = (dataField.type as { typeIdx: number }).typeIdx;
  // Verify field 1 actually points to an array type (not a ref cell, closure struct, etc.)
  const arrDef = ctx.mod.types[arrTypeIdx];
  if (!arrDef || arrDef.kind !== "array") return -1;
  return arrTypeIdx;
}

/**
 * Register the WasmGC types for native strings (rope/cons-string support).
 */
export function registerNativeStringTypes(ctx: CodegenContext): void {
  ctx.nativeStrDataTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "__str_data",
    element: { kind: "i16" },
    mutable: true,
  });

  ctx.anyStrTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "AnyString",
    fields: [{ name: "len", type: { kind: "i32" }, mutable: false }],
    superTypeIdx: -1,
  });

  ctx.nativeStrTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "NativeString",
    fields: [
      { name: "len", type: { kind: "i32" }, mutable: false },
      { name: "off", type: { kind: "i32" }, mutable: false },
      { name: "data", type: { kind: "ref", typeIdx: ctx.nativeStrDataTypeIdx }, mutable: false },
    ],
    superTypeIdx: ctx.anyStrTypeIdx,
  });

  ctx.consStrTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "ConsString",
    fields: [
      { name: "len", type: { kind: "i32" }, mutable: false },
      { name: "left", type: { kind: "ref", typeIdx: ctx.anyStrTypeIdx }, mutable: false },
      { name: "right", type: { kind: "ref", typeIdx: ctx.anyStrTypeIdx }, mutable: false },
    ],
    superTypeIdx: ctx.anyStrTypeIdx,
  });

  // #1588 PR-B: dual i8/i16 storage. Only register the UTF-8 backing array +
  // `Utf8String` subtype when `--utf8-storage` is on. When off, the type table
  // is unchanged so emitted Wasm is byte-identical to today.
  if (ctx.utf8Storage) {
    ctx.utf8StrDataTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "array",
      name: "__str_data_u8",
      element: { kind: "i8" },
      mutable: true,
    });

    ctx.utf8StrTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "struct",
      name: "Utf8String",
      fields: [
        // JS-visible code-unit (UTF-16) length — preserves observable
        // `.length` / indexing / comparison semantics (issue Non-goals).
        { name: "len", type: { kind: "i32" }, mutable: false },
        // Canonical-ABI byte length (>= len for multi-byte scalars; == len for ascii).
        { name: "byteLen", type: { kind: "i32" }, mutable: false },
        { name: "off", type: { kind: "i32" }, mutable: false },
        { name: "data", type: { kind: "ref", typeIdx: ctx.utf8StrDataTypeIdx }, mutable: false },
      ],
      superTypeIdx: ctx.anyStrTypeIdx,
    });
  }
}
