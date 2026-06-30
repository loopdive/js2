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
  const part = (v: ValType): string => {
    let s = v.kind;
    if (v.kind === "ref" || v.kind === "ref_null") s += ":" + (v as { typeIdx: number }).typeIdx;
    // (#2795) An `i32` Wasm slot backs `number`, `boolean` (1/0) and symbol
    // HANDLES, which box to the host DIFFERENTLY (`__box_number` vs
    // `__box_boolean` vs `__box_symbol`). The brand rides on the ValType but the
    // bare `kind` is identical, so a brand-blind dedup collapses e.g. a
    // `(f64)->boolean` signature onto a previously-registered `(f64)->number`
    // one — and `getWasmFuncReturnType` then hands callers a PLAIN i32, so a
    // boolean-returning recursive kernel's result boxed as the number 1 instead
    // of `true` (#2795 closures/10-mutual). Keep branded i32 signatures distinct.
    else if (v.kind === "i32") {
      if ((v as { boolean?: true }).boolean) s += ":bool";
      else if ((v as { symbol?: true }).symbol) s += ":sym";
    }
    // (#2846) Same brand-propagation hazard as i32 (#2795), one slot down: a
    // bigint-branded `i64` (`{ kind:"i64"; bigint:true }`) backs a BigInt and
    // boxes to the host via `__box_bigint`, whereas a plain native `i64`
    // (`type i64 = number`) boxes via `__box_number` (`f64.convert_i64_s`,
    // lossy past 2^53). A brand-blind dedup collapses a `(...)->bigint`
    // signature onto a previously-registered plain-`i64` one, so
    // `getWasmFuncReturnType` hands callers a PLAIN i64 and acorn's
    // `stringToBigInt` return got boxed as a rounded number (#2846). Keep the
    // branded i64 signature distinct.
    else if (v.kind === "i64") {
      if ((v as { bigint?: true }).bigint) s += ":big";
    }
    return s;
  };
  return params.map(part).join(",") + "|" + results.map(part).join(",");
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
  // (#2846) Keep the two i64 brands non-equal so `funcTypeEq` (structural-match
  // callers) does not re-merge a bigint-branded i64 with a plain i64 — mirrors
  // the `funcTypeKey` `:big` bucket above and the #2795 i32 precedent.
  if (a.kind === "i64") {
    return Boolean((a as { bigint?: true }).bigint) === Boolean((b as { bigint?: true }).bigint);
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
  // (#2688) Qualify a bare `ref`/`ref_null` elemKind with its struct typeIdx so
  // DISTINCT ref-struct element types get DISTINCT array types. Caching ref
  // arrays under the plain `"ref"` key collapsed every ref-element array to the
  // FIRST-registered element struct — so a shape-transforming `.map` returning a
  // different struct stored into an array typed for the wrong struct
  // (`array.set` validation failure, eslint apply-disable-directives.js). Matches
  // the existing `ref_<typeIdx>` convention (symbol-native / native-string vecs).
  const cacheKey =
    (elemKind === "ref" || elemKind === "ref_null") &&
    elemTypeOverride &&
    (elemTypeOverride.kind === "ref" || elemTypeOverride.kind === "ref_null")
      ? `ref_${(elemTypeOverride as { typeIdx: number }).typeIdx}`
      : elemKind;
  if (ctx.arrayTypeMap.has(cacheKey)) return ctx.arrayTypeMap.get(cacheKey)!;
  let elemType: ValType =
    elemTypeOverride ??
    (elemKind === "f64" ? { kind: "f64" } : elemKind === "i32" ? { kind: "i32" } : { kind: "externref" });
  if (elemType.kind === "ref") {
    elemType = { kind: "ref_null", typeIdx: (elemType as { typeIdx: number }).typeIdx };
  }
  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: `__arr_${cacheKey}`,
    element: elemType,
    mutable: true,
  } as ArrayTypeDef);
  ctx.arrayTypeMap.set(cacheKey, idx);
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
  // (#2083) Any request for a vec type — whether it allocates a new struct or
  // reuses a pre-registered one (`externref`/`f64`, baked into every context for
  // type-index stability) — means the module genuinely materialises an array
  // value. Record that so the host-glue vec exports (`__vec_len`/`__vec_get`/
  // `__vec_push`/`__vec_pop`/`__vec_mut_supported`/`__is_vec`) are emitted only
  // for modules that actually use arrays, instead of unconditionally (the two
  // pre-registrations otherwise make `vecTypeMap.size === 0` unreachable, so the
  // exports leaked into every arith-/string-only module). The pre-registration
  // calls in `createCodegenContext` set `ctx.suppressVecUsageFlag` so they do
  // NOT count as usage.
  if (!ctx.suppressVecUsageFlag) ctx.usesVecValue = true;
  // (#2688) Qualify a bare `ref`/`ref_null` elemKind with its struct typeIdx (see
  // getOrRegisterArrayType) so distinct ref-struct vecs are distinct types, not
  // collapsed onto the first ref struct registered.
  const cacheKey =
    (elemKind === "ref" || elemKind === "ref_null") &&
    elemTypeOverride &&
    (elemTypeOverride.kind === "ref" || elemTypeOverride.kind === "ref_null")
      ? `ref_${(elemTypeOverride as { typeIdx: number }).typeIdx}`
      : elemKind;
  const existing = ctx.vecTypeMap.get(cacheKey);
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
    name: `__vec_${cacheKey}`,
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
  ctx.vecTypeMap.set(cacheKey, vecIdx);

  const vecStructName = `__vec_${cacheKey}`;
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
