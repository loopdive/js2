// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Wasm type registry ownership for the backend.
 *
 * This module owns function-type caches plus reusable GC array/vec/ref-cell
 * registrations so leaf modules can depend on a narrow type-registry surface.
 */
import type { ArrayTypeDef, FieldDef, FuncTypeDef, StructTypeDef, ValType } from "../../ir/types.js";
import type { CodegenContext } from "../context/types.js";
import { closureBagField } from "../closures/funcref-wrapper-types.js"; // (#4241)

/**
 * (#3268) Register a WasmGC struct type: append it to `ctx.mod.types` and wire
 * the name -> typeIdx, typeIdx -> name, and name -> fields lookup tables.
 * Returns the assigned type index. Consolidates the identical registration
 * idiom used by the empty-object widening pre-pass and the interface/object
 * struct registration paths.
 */
export function registerStructType(ctx: CodegenContext, name: string, fields: FieldDef[]): number {
  const typeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name,
    fields,
  } as StructTypeDef);
  ctx.structMap.set(name, typeIdx);
  ctx.typeIdxToStructName.set(typeIdx, name);
  ctx.structFields.set(name, fields);
  return typeIdx;
}

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
 * (#4443) Is `typeIdx` an INDEXABLE CARRIER — `$__vec_base` itself or any
 * (transitive) subtype of it?
 *
 * Every concrete vec, subview, TypedArray view and the regexp match-result
 * struct subtypes `$__vec_base`, so this is the one reliable way to ask "does
 * this struct's element data live in a `data`/`buf` array, read by the
 * dedicated vec / typed-array arms?". Callers that answer that question by
 * NAME instead go stale the moment a new carrier is minted: the array-like
 * fill in `object-runtime.ts` listed `__vec_*` / `__arr_*` / `__subview_*` and
 * so silently admitted `__regexp_match_vec`, `__template_vec_externref`,
 * `__ta_view_<K>` and `__ta_dyn_view` as ordinary closed structs (#4443).
 *
 * The walk is bounded by the type-table size so a malformed or cyclic
 * supertype chain cannot hang finalize. Returns false when no `$__vec_base`
 * has been registered — a module with no vecs has no carriers either.
 */
export function isVecBaseSubtype(ctx: CodegenContext, typeIdx: number): boolean {
  const vecBaseTypeIdx = ctx.vecBaseTypeIdx;
  if (vecBaseTypeIdx < 0) return false;
  if (typeIdx === vecBaseTypeIdx) return true;
  for (let cur = typeIdx, hops = 0; hops < ctx.mod.types.length; hops++) {
    const def = ctx.mod.types[cur];
    if (!def || def.kind !== "struct") return false;
    const sup = def.superTypeIdx;
    if (sup === undefined || sup < 0) return false;
    if (sup === vecBaseTypeIdx) return true;
    cur = sup;
  }
  return false;
}

/**
 * (#4034) Run `fn` with `usesVecValue` pinned to its current value, so vec
 * types registered by COMPILER-INTERNAL emission (runtime preludes, reflective
 * accessors, type-index-stability stubs) do not read as user array usage.
 *
 * Type registration still happens — only the usage flag is suppressed — so the
 * emitted types and every index derived from them are unchanged. Restores the
 * previous value rather than clearing, so nesting is safe.
 */
export function withSuppressedVecUsage<T>(ctx: CodegenContext, fn: () => T): T {
  const wasSuppressed = ctx.suppressVecUsageFlag;
  ctx.suppressVecUsageFlag = true;
  try {
    return fn();
  } finally {
    ctx.suppressVecUsageFlag = wasSuppressed;
  }
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
 * (#4222 ES5 residual) Register the one sparse carrier used by the bounded
 * `new Array(<literal>)` → direct `.filter(...)` slice.
 *
 * It is deliberately a subtype of the ordinary externref vec rather than a
 * flag on that vec. The physical brand survives constructor, local binding,
 * writes, and HOF dispatch, so no unrelated `any[]` can acquire `$Hole`
 * semantics merely because the source module contains a sized constructor.
 */
export function getOrRegisterHoleyArrayType(ctx: CodegenContext): number {
  if (ctx.holeyArrayTypeIdx >= 0) return ctx.holeyArrayTypeIdx;

  const parentVecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, parentVecTypeIdx);
  if (arrTypeIdx < 0) throw new Error("holey array carrier requires the canonical externref vec layout");

  const idx = ctx.mod.types.length;
  const name = "__holey_array";
  ctx.mod.types.push({
    kind: "struct",
    name,
    superTypeIdx: parentVecTypeIdx,
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      { name: "data", type: { kind: "ref", typeIdx: arrTypeIdx }, mutable: true },
    ],
  });
  ctx.holeyArrayTypeIdx = idx;
  ctx.structMap.set(name, idx);
  ctx.typeIdxToStructName.set(idx, name);
  ctx.structFields.set(name, [
    { name: "length", type: { kind: "i32" as const }, mutable: true },
    { name: "data", type: { kind: "ref" as const, typeIdx: arrTypeIdx }, mutable: true },
  ]);
  return idx;
}

/** True exactly for the dedicated sparse `new Array(n)` carrier. */
export function isHoleyArrayType(ctx: CodegenContext, typeIdx: number): boolean {
  return ctx.holeyArrayTypeIdx >= 0 && typeIdx === ctx.holeyArrayTypeIdx;
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
 * (#3054 B1) Get or register the `$__ta_view_<name>` struct — a byte-backed
 * TypedArray view over an ArrayBuffer that SHARES the buffer's backing store:
 *   `{length: i32, buf: (ref null $__vec_i32_byte), byteOffset: i32}`.
 *
 * Unlike `$__subview` (which pins the parent's raw *element* array), a
 * `$__ta_view` holds a ref to the ArrayBuffer's `$__vec_i32_byte` **vec struct**
 * and byte-decodes each element little-endian from `buf.data` at the element's
 * byteOffset (via the dataview-native engine). This is mandatory because WasmGC
 * array types are nominal per element kind — the buffer's packed-i8 array
 * (`$__arr_i32_byte`) cannot be aliased/reinterpreted as an f64/i32 element
 * array — so uniform byte-decoding is the only sound shared-backing scheme
 * (Phase A A.1, option (c) impossible). Refing the *vec struct* (not the inner
 * array) is a deliberate forward-compat choice: a future resize (Phase C) swaps
 * the vec's `data` field in place and the view — which reads `buf.data` at each
 * access — observes it, so length-tracking falls out for free.
 *
 * `length` is field 0 (subtypes `$__vec_base`) so uniform `.length` reads and the
 * externref-length helper keep working. Keyed per TS view NAME (each view kind
 * needs a distinct typeIdx so element access can recover its byte width /
 * signedness / float / clamp behaviour purely from the receiver's static
 * ValType.typeIdx — no runtime tag). Idempotent.
 */
export function getOrRegisterTaViewType(ctx: CodegenContext, viewName: string): number {
  const existing = ctx.taViewTypeMap.get(viewName);
  if (existing !== undefined) return existing;

  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  // The shared ArrayBuffer/DataView backing vec (packed i8 bytes, one per slot).
  const bufVecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });

  const idx = ctx.mod.types.length;
  const name = `__ta_view_${viewName}`;
  ctx.mod.types.push({
    kind: "struct",
    name,
    superTypeIdx: vecBaseIdx, // length-prefix compatible with $__vec_base
    fields: [
      { name: "length", type: { kind: "i32" }, mutable: true },
      { name: "buf", type: { kind: "ref_null", typeIdx: bufVecTypeIdx }, mutable: false },
      { name: "byteOffset", type: { kind: "i32" }, mutable: false },
    ],
  });
  ctx.taViewTypeMap.set(viewName, idx);
  ctx.structMap.set(name, idx);
  ctx.typeIdxToStructName.set(idx, name);
  ctx.structFields.set(name, [
    { name: "length", type: { kind: "i32" as const }, mutable: true },
    { name: "buf", type: { kind: "ref_null" as const, typeIdx: bufVecTypeIdx }, mutable: false },
    { name: "byteOffset", type: { kind: "i32" as const }, mutable: false },
  ]);
  return idx;
}

/** (#3054 B1) True iff `typeIdx` is a registered `$__ta_view_<name>` struct. */
export function isTaViewTypeIdx(ctx: CodegenContext, typeIdx: number): boolean {
  for (const v of ctx.taViewTypeMap.values()) if (v === typeIdx) return true;
  return false;
}

/** (#3054 B1) The TS view name (`"Uint8Array"` …) for a `$__ta_view` typeIdx, or undefined. */
export function getTaViewName(ctx: CodegenContext, typeIdx: number): string | undefined {
  for (const [name, v] of ctx.taViewTypeMap.entries()) if (v === typeIdx) return name;
  return undefined;
}

/**
 * (#3054 D) Canonical ordered list of TypedArray element kinds a first-class
 * `$__ta_ctor` value can name. The array INDEX is the runtime `kind` stored in the
 * struct; every dynamic-construct / `BYTES_PER_ELEMENT` dispatch iterates this list
 * so the ordering is the single source of truth. Float16 views are omitted
 * (unsupported elsewhere in the standalone lane).
 *
 * (#3613) The two BigInt views are APPENDED at kinds 9/10 — never inserted — so
 * every already-emitted `kind` constant (baked into the `$__ta_ctor` singleton
 * globals and into the `if`-chain arms of the decode/encode/BYTES dispatches)
 * keeps its value. Before this they were absent, so a bare `BigInt64Array` /
 * `BigUint64Array` in VALUE position fell through `emitTaCtorValue` to the
 * `ref.null.extern` unimplemented-global default in identifiers.ts — i.e.
 * `[BigInt64Array, BigUint64Array]` was `[null, null]` and the test262
 * `testWithBigIntTypedArrayConstructors` harness's `new TA(...)` produced null
 * for every BigInt row. The host/gc lane had already been fixed (#3087 routes
 * the same two names through `__extern_get(globalThis, name)`); only the
 * host-free lane was left behind.
 *
 * Element VALUES in a dynamically-constructed BigInt view are still the f64
 * carrier the rest of the dyn-view substrate uses, NOT i64-branded BigInts —
 * that representation split is #1349/#2401(b) and deliberately out of scope
 * here. This entry buys the STRUCTURE (non-null identity-stable ctor, correct
 * 8-byte element width, working length/byteLength/MOP), which is what the
 * harness rows actually gate on.
 */
export const TA_CTOR_KINDS: readonly string[] = [
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
];

/** (#3054 D) Element byte width per `TA_CTOR_KINDS` entry (BYTES_PER_ELEMENT). */
export const TA_CTOR_BYTES: readonly number[] = [1, 1, 1, 2, 2, 4, 4, 4, 8, 8, 8];

/** (#3054 D) The `kind` index for a TS TypedArray name, or -1 if not a first-class TA ctor. */
export function taCtorKindOf(name: string): number {
  return TA_CTOR_KINDS.indexOf(name);
}

/**
 * (#3054 D) Get or register the `$__ta_ctor` struct — `{kind: i32}` — the
 * first-class runtime value for a TypedArray CONSTRUCTOR used in value position.
 * A bare TA name in value position (`const c = Uint8Array`, `[Uint8Array, …]`,
 * a `new ctor(rab)` callee) previously degraded to `ref.null.extern`
 * (indistinguishable — `Uint8Array === Int8Array` was `true`), so a dynamic
 * `new ctor(rab)` dropped the ctor and produced null. The immutable `kind` field
 * (index into `TA_CTOR_KINDS`) drives the runtime-switch dynamic construct and
 * `ctor.BYTES_PER_ELEMENT`. A plain struct (NOT a vec subtype) so it never collides
 * with buffer/view `ref.test`s. Registered late+once, memoized on `ctx.taCtorTypeIdx`.
 */
export function getOrRegisterTaCtorType(ctx: CodegenContext): number {
  if (ctx.taCtorTypeIdx >= 0) return ctx.taCtorTypeIdx;
  const idx = ctx.mod.types.length;
  const name = "__ta_ctor";
  ctx.mod.types.push({
    kind: "struct",
    name,
    fields: [{ name: "kind", type: { kind: "i32" }, mutable: false }],
  });
  ctx.taCtorTypeIdx = idx;
  ctx.structMap.set(name, idx);
  ctx.typeIdxToStructName.set(idx, name);
  ctx.structFields.set(name, [{ name: "kind", type: { kind: "i32" as const }, mutable: false }]);
  return idx;
}

/**
 * (#3054 D) Get or register `$__ta_dyn_view` — a shared-backing TypedArray view
 * whose element kind is carried in a runtime `kind` field (index into
 * `TA_CTOR_KINDS`), for views built by a dynamic `new ctor(rab)` where the kind is
 * only known at runtime. B1's per-kind `$__ta_view_<K>` are structurally identical
 * → WasmGC canonicalizes them to ONE runtime type, so a boxed view can't recover
 * its kind via `ref.test`; this struct stores it explicitly. Subtype of
 * `$__vec_base` so `.length` reads field0 uniformly. Registered late+once.
 */
export function getOrRegisterTaDynViewType(ctx: CodegenContext): number {
  if (ctx.taDynViewTypeIdx >= 0) return ctx.taDynViewTypeIdx;
  const vecBaseIdx = getOrRegisterVecBaseType(ctx);
  const bufVecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
  const idx = ctx.mod.types.length;
  const name = "__ta_dyn_view";
  const fields = [
    { name: "length", type: { kind: "i32" as const }, mutable: true },
    { name: "buf", type: { kind: "ref_null" as const, typeIdx: bufVecTypeIdx }, mutable: false },
    { name: "byteOffset", type: { kind: "i32" as const }, mutable: false },
    { name: "kind", type: { kind: "i32" as const }, mutable: false },
    // (#3177 slice 4) Expando side-table: non-index own props defined on the
    // view (`Object.defineProperty(sample, "foo", …)`, symbol keys, and the
    // preventExtensions state) live on a lazily-created `$Object` boxed as
    // externref (no `$Object` type dependency at registration — the MOP arms
    // cast on use). APPEND-ONLY: existing field indices and the `$__vec_base`
    // supertype prefix stay valid.
    { name: "expando", type: { kind: "externref" as const }, mutable: true },
    // #3371: Reflect.construct's distinct NewTarget may select a custom
    // ordinary-object prototype. Null means "use the intrinsic per-kind proto".
    { name: "constructProto", type: { kind: "externref" as const }, mutable: true },
  ];
  ctx.mod.types.push({ kind: "struct", name, superTypeIdx: vecBaseIdx, fields });
  ctx.taDynViewTypeIdx = idx;
  ctx.structMap.set(name, idx);
  ctx.typeIdxToStructName.set(idx, name);
  ctx.structFields.set(name, fields);
  return idx;
}

/**
 * (#3140) Get or register `$__bound_fn` — the standalone/WASI native
 * bound-function carrier minted by `Function.prototype.bind`:
 * `{target: externref, thisArg: externref, boundArgs: externref}` where
 * `boundArgs` holds a boxed `$ObjVec` of the partial-application arguments.
 * Invocation unwraps through the `__apply_closure` front-guard (prepending
 * `boundArgs` and recursing on `target`, so bound-of-bound chains compose);
 * the closure classifier (`closure-classifier.ts`) counts it callable so
 * `typeof bound === "function"`. A plain struct (NOT a vec/closure subtype) so
 * it never collides with other `ref.test`s. Registered late+once, memoized on
 * `ctx.boundFnTypeIdx`. Byte-inert: only emitted when a standalone `.bind(...)`
 * site compiles.
 */
export function getOrRegisterBoundFnType(ctx: CodegenContext): number {
  if (ctx.boundFnTypeIdx >= 0) return ctx.boundFnTypeIdx;
  const idx = ctx.mod.types.length;
  const name = "__bound_fn";
  const fields = [
    { name: "target", type: { kind: "externref" as const }, mutable: false },
    { name: "thisArg", type: { kind: "externref" as const }, mutable: false },
    { name: "boundArgs", type: { kind: "externref" as const }, mutable: false },
    // (#4241) Carrier-intrinsic expando bag — a bound function is a callable
    // carrier for `__closure_bag_lookup`, so it gets the O(1) slot instead of
    // a `$ClosurePropEntry` registry entry. Appended LAST: this struct is
    // final and super-less, so no field index shifts.
    closureBagField(),
  ];
  ctx.mod.types.push({ kind: "struct", name, fields });
  ctx.boundFnTypeIdx = idx;
  ctx.structMap.set(name, idx);
  ctx.typeIdxToStructName.set(idx, name);
  ctx.structFields.set(name, fields);
  return idx;
}

/**
 * (#3054 C) Get or register the `$__resizable_ab` struct — a WasmGC SUBTYPE of the
 * ArrayBuffer backing vec `$__vec_i32_byte`, carrying one extra `maxByteLength`
 * field:
 *   `{length: i32 (mut), data: (ref $__arr_i32_byte) (mut), maxByteLength: i32}`.
 *
 * `new ArrayBuffer(n, {maxByteLength})` allocates one of these instead of a plain
 * `$__vec_i32_byte`. The **subtype identity IS the resizable bit**:
 * `ref.test $__resizable_ab` ⇒ resizable, a plain `$__vec_i32_byte` ⇒ fixed — no
 * separate flag, so a resizable buffer whose `maxByteLength === byteLength` is
 * still distinguishable from a fixed one (the flaw of the "over-allocate + derive"
 * option). Because it is a subtype, every one of the ~23 `i32_byte` read sites
 * that does `ref.cast $__vec_i32_byte; struct.get 0/1` succeeds on a
 * `$__resizable_ab` instance UNCHANGED (is-a) — only the resizable-aware sites
 * (the ctor, `.resize()`, and the `maxByteLength`/`resizable` getters) know the
 * subtype. `$__vec_i32_byte` is emitted open (`sub`, non-final — every vec
 * subtypes `$__vec_base` with no `final` flag), so a further subtype of it is
 * legal.
 *
 * Type-index discipline (the one real hazard, Phase A A.2): registered LATE +
 * ONCE, memoized on `ctx.resizableAbTypeIdx`, mirroring `getOrRegisterTaViewType`
 * / `getOrRegisterDvWindowType`. `getOrRegisterVecType` is called FIRST so the
 * parent `$__vec_i32_byte` is always at a LOWER type index than this subtype —
 * the subtype's supertype reference points BACKWARD, which is valid without a rec
 * group and never triggers `computeRecGroups` to reorder (that pass only extends a
 * group FORWARD on forward refs; a backward supertype ref is left as a singleton).
 * Types are append-only (`ctx.mod.types.length`), and DCE preserves relative
 * order + keeps a live subtype's supertype reachable (it is referenced as both
 * `superTypeIdx` and the `data` field's array elem type). So the subtype always
 * follows its supertype in the final type section. Idempotent.
 */
export function getOrRegisterResizableAbType(ctx: CodegenContext): number {
  if (ctx.resizableAbTypeIdx >= 0) return ctx.resizableAbTypeIdx;

  // Register the parent buffer vec FIRST so it precedes this subtype in the type
  // index order (the mandatory supertype-before-subtype ordering).
  const bufVecTypeIdx = getOrRegisterVecType(ctx, "i32_byte", { kind: "i8" });
  const arrTypeIdx = getArrTypeIdxFromVec(ctx, bufVecTypeIdx);

  const idx = ctx.mod.types.length;
  const name = "__resizable_ab";
  ctx.mod.types.push({
    kind: "struct",
    name,
    superTypeIdx: bufVecTypeIdx, // SUBTYPE of $__vec_i32_byte — inherits length + data
    fields: [
      // fields 0 + 1 MUST match the parent's shape exactly (subtype invariance on
      // mutable fields): length + data, same types + mutability as $__vec_i32_byte.
      { name: "length", type: { kind: "i32" }, mutable: true },
      { name: "data", type: { kind: "ref", typeIdx: arrTypeIdx }, mutable: true },
      // field 2 — the resizable-only metadata. Immutable (a buffer's declared
      // maxByteLength never changes after construction).
      { name: "maxByteLength", type: { kind: "i32" }, mutable: false },
    ],
  });
  ctx.resizableAbTypeIdx = idx;
  ctx.structMap.set(name, idx);
  ctx.typeIdxToStructName.set(idx, name);
  ctx.structFields.set(name, [
    { name: "length", type: { kind: "i32" as const }, mutable: true },
    { name: "data", type: { kind: "ref" as const, typeIdx: arrTypeIdx }, mutable: true },
    { name: "maxByteLength", type: { kind: "i32" as const }, mutable: false },
  ]);
  return idx;
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

/**
 * (#3328) The VALUE type a mutable-capture ref cell carries — its field-0
 * type. The authoritative fallback for a boxed capture's `valType` when the
 * outer scope's `boxedCaptures` entry is not populated yet (the lifted body
 * compiles BEFORE the construct site boxes the outer local, so
 * `fctx.boxedCaptures.get(name)` misses and the legacy `?? {kind:"f64"}`
 * default silently retyped e.g. a captured STRING as a number — `log += 'y'`
 * inside the closure then compiled as `f64.add` with a `ref.null` +
 * `ref.as_non_null` placeholder for the string result, a guaranteed
 * "dereferencing a null pointer" trap the first time any capturing
 * `toString`/`valueOf` ran). Returns undefined when `refCellTypeIdx` is not a
 * cell-shaped struct so callers keep their final default.
 */
export function refCellValueType(ctx: CodegenContext, refCellTypeIdx: number): ValType | undefined {
  const def = ctx.mod.types[refCellTypeIdx];
  if (!def || def.kind !== "struct") return undefined;
  return (def as StructTypeDef).fields[0]?.type;
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
 * Get or register the `$Error_struct` WasmGC type. Idempotent — returns the
 * cached type index on subsequent calls.
 *
 * (#2962) Moved here from `registry/error-types.ts` (which re-exports it for
 * its existing importers) so `native-strings.ts` can reach the error struct
 * type for the `__error_to_string` §20.5.3.4 arm without creating an
 * error-types ⇄ native-strings import cycle (error-types.ts imports
 * `stringConstantExternrefInstrs` from native-strings.ts). Field-layout
 * documentation lives with the constructors in error-types.ts.
 */
export function getOrRegisterErrorStructType(ctx: CodegenContext): number {
  if (ctx.errorStructTypeIdx >= 0) return ctx.errorStructTypeIdx;

  const idx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$Error_struct",
    fields: [
      { name: "tag", type: { kind: "i32" }, mutable: false },
      { name: "message", type: { kind: "externref" }, mutable: true },
      // (#4485) Mutable since the §20.5.3.4 own-`name` slice: `err.name = "X"`
      // is an ordinary writable own-property write (`Error.prototype.name` is
      // `{writable:true}`), and the standalone `.name` READ is a hard
      // `struct.get` of this field, so a write that landed anywhere else was
      // simply invisible — `e.name = ""; e.name` read back `"Error"`. Same
      // rationale as `stack` below; the field index is unchanged, so no other
      // reader moves.
      { name: "name", type: { kind: "externref" }, mutable: true },
      // (#1536) $stack — fieldIdx 3, kept AFTER message(1)/name(2) so their
      // indices stay stable. `error.stack` is non-standard (no normative
      // test262 coverage); materializing a real stack trace needs no Wasm
      // primitive, so standalone constructs it as `ref.null.extern` (reads
      // back as `undefined`, not a trap). Mutable so a future `err.stack = …`
      // write can land here without a struct-type change.
      { name: "stack", type: { kind: "externref" }, mutable: true },
      // (#2188) $userClassId — fieldIdx 4. Per-user-Error-subclass brand that
      // distinguishes sibling `extends Error` classes which all share the SAME
      // builtin parent `$tag` (field 0). `__new_<Parent>` writes the sentinel
      // `-1` (a plain builtin Error / the shared parent ctor has no user-class
      // brand); the subclass `super()` site overwrites it with the subclass's
      // `classTagMap` id (see emitSetSubclassUserBrand in class-bodies.ts). The
      // standalone `instanceof <UserSubclass>` path reads this field instead of
      // the shared builtin tag, so `(new A) instanceof B` is false for distinct
      // siblings A,B. Mutable: the brand is written AFTER struct.new at the
      // per-subclass construction site, not baked into the shared parent ctor.
      // Kept LAST so fields 0..3 stay stable.
      { name: "userClassId", type: { kind: "i32" }, mutable: true },
      // (#2101a R5) $props — fieldIdx 5. Backing store for user-declared OWN
      // fields on an externref-backed Error subclass (`class A extends Error {
      // code = 0 }`). Such an instance IS this `$Error_struct` (no per-subclass
      // WasmGC struct), so own fields have nowhere to live — `this.code = …`
      // previously cast `this` to the vestigial `$A` struct and trapped. Holds
      // an externref to an open `$Object` (the LANDED object-runtime), lazily
      // allocated via `__new_plain_object()` on the first own-field write;
      // reads/writes route through `__extern_get`/`__extern_set`. `ref.null`
      // until first written. Stored as externref (not `ref null $Object`) to
      // avoid a forward type-reference to `$Object` here — `$Object` is
      // registered lazily by the object-runtime, which may run AFTER this
      // struct. Kept LAST so fields 0..4 stay stable.
      { name: "props", type: { kind: "externref" }, mutable: true },
    ],
  });
  ctx.errorStructTypeIdx = idx;
  return idx;
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
      // (#3673) left/right are mutable so `__str_flatten` can memoize: after
      // flattening a rope it rewrites the cons in place to (left=flat result,
      // right=""), turning every later flatten of the same rope into a two-
      // field fast path instead of an O(len) re-copy. `len` stays immutable —
      // the rewrite preserves the total length.
      { name: "left", type: { kind: "ref", typeIdx: ctx.anyStrTypeIdx }, mutable: true },
      { name: "right", type: { kind: "ref", typeIdx: ctx.anyStrTypeIdx }, mutable: true },
    ],
    superTypeIdx: ctx.anyStrTypeIdx,
  });

  // (#3673 round 9) `$HashedString <: $NativeString` — a flat string that
  // CACHES its FNV-1a hash. `__obj_hash` re-hashed the probe key per $Object
  // lookup (O(len) loop) even though most keys are compile-time constants.
  // Only two producers allocate this subtype: interned literal globals (hash
  // BAKED at compile time by `nativeStringLiteralHash`) and `__str_flatten`'s
  // memoized flat copies (hash 0 = uncomputed, filled lazily by `__obj_hash`
  // via `struct.set`). Field encoding: 0 = uncomputed; else
  // `(fnv & 0x7fffffff) | 0x80000000` (the sign bit marks "computed", so a
  // genuine hash of 0 stays distinguishable). Every existing
  // `(ref $NativeString)` consumer accepts it via subtyping — no other
  // allocation or read site changes.
  // Fields 4-6 (#3673 round 9b): a per-KEY prototype-lookup inline cache used
  // by `__extern_get` for fnctor-receiver method resolution (acorn's
  // `this.readToken()` class of call). When a proto-walk starting at a fnctor
  // prototype finds a DATA entry on the FIRST prototype object and the key is
  // an interned `$HashedString`, the (owner-proto, entry) pair is memoized ON
  // THE KEY STRING with the current table generation. A later lookup with the
  // same interned key + same proto short-circuits the whole `__extern_get`
  // ladder to one entry-value read. Validity: `cacheGen == __obj_table_gen`
  // (bumped ONLY by `__obj_grow` — rehash re-mints entry structs), owner
  // `ref.eq`, and the entry's flags carry neither TOMBSTONE (delete) nor
  // ACCESSOR (defineProperty morph) — value updates mutate the entry in place
  // and stay visible through the cache. Fields are `anyref` (not typed refs)
  // because `$Object`/`$PropEntry` are registered later by the object runtime.
  ctx.hashedStrTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "HashedString",
    fields: [
      { name: "len", type: { kind: "i32" }, mutable: false },
      { name: "off", type: { kind: "i32" }, mutable: false },
      { name: "data", type: { kind: "ref", typeIdx: ctx.nativeStrDataTypeIdx }, mutable: false },
      { name: "hash", type: { kind: "i32" }, mutable: true },
      { name: "cacheGen", type: { kind: "i32" }, mutable: true },
      { name: "cacheOwner", type: { kind: "anyref" }, mutable: true },
      { name: "cacheEntry", type: { kind: "anyref" }, mutable: true },
      // (#3673 round 21) the owner's props ARRAY at population time — a grow
      // replaces the array, so `ref.eq` on it is a per-object staleness check
      // (replaces the global `__obj_table_gen`, whose bump on ANY object's
      // grow cold-started every cache twice per parse via acorn's options
      // build). Field 4 degrades to a populated flag (0/1).
      { name: "cacheProps", type: { kind: "anyref" }, mutable: true },
    ],
    superTypeIdx: ctx.nativeStrTypeIdx,
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
