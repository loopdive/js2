// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1103a — Wasm-native `Map` runtime for standalone / WASI targets.
 *
 * In JS-host mode `new Map()` and every method call route through the
 * `builtinCtors` host table (`src/runtime.ts`) and `ctx.externClasses`. Under
 * `--target standalone` / `--target wasi` there is no JS host to satisfy those
 * imports, so this module provides a pure-WasmGC ordered hash table:
 *
 *   - **Entries vector** — insertion-ordered array of `$MapEntry` records that
 *     iterators walk. Deletion tombstones a slot (key/value set to null, hash
 *     top-bit set) so live iterators stay stable (spec 24.1.5).
 *   - **Bucket array** — `i32` table indexed by `hash & (cap-1)` storing the
 *     head entry index of each chain; each entry's `$next` continues the chain.
 *
 * Lookup is O(1); iteration order = entries-vector order. Rehash/compact runs
 * when the live load factor exceeds 0.75.
 *
 * Keys are compared with SameValueZero (spec 7.2.10): numbers (incl. NaN===NaN,
 * +0===-0), booleans, strings (by content), null/undefined, and object
 * reference identity. Hashing dispatches on the anyref runtime type.
 *
 * Everything here is emitted lazily and only when the native-collections path
 * is active (`ctx.standalone || ctx.wasi`). The JS-host path is untouched.
 */
import { ts } from "../ts-api.js";
import { isVoidType } from "../checker/type-mapper.js";
import type { Instr, StructTypeDef, ArrayTypeDef, ValType } from "../ir/types.js";
import { canonicalUndefinedExternInstrs, ensureAnyValueType, undefinedSingletonActive } from "./any-helpers.js";
import type { ClosureInfo, CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { ensureObjVecBuilders, reserveApplyClosure, FLAG_DEFAULT } from "./object-runtime.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecType } from "./registry/types.js";
import type { InnerResult } from "./shared.js";
import { compileArrowAsClosure, compileExpression, VOID_RESULT } from "./shared.js";
import { isNullOrUndefinedLiteral } from "./destructuring-params.js";
import { emitReceiverBrandCheck, type ReceiverBrandSpec } from "./receiver-brand.js";
import { emitThrowTypeError } from "./js-errors.js";
import { coercionInstrs, emitGuardedRefCast } from "./type-coercion.js";
import { resolveWasmType, resolveWasmTypeForClosureReturn } from "./index.js";
import { ensureCurrentThisGlobal } from "./statements/nested-declarations.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2/S3) positional-read chokepoint + stable-regime minting
import { nativeStringLiteralInstrs } from "./native-string-literals.js"; // (#4629) dyn-dispatch fill key compares
import { getWellKnownSymbolId } from "./literals.js"; // (#4629) @@iterator id
import { ensureSymbolCarrier, usesNativeSymbolProvider } from "./symbol-native.js"; // (#5267 A-2) symbol keys box as symbols, not ids
import { ensureNativeIteratorRuntime } from "./iterator-native.js"; // (#5267 B-2) live collection iterator records
import { getClosureFuncSelfTypeIdx, getOrCreateFuncRefWrapperTypes } from "./closures/funcref-wrapper-types.js"; // (#4629) iterator closure singleton

/** WasmGC `eq` abstract heap type, signed-LEB `0x6d` = -19. Used for ref.eq on
 *  object keys (only GC eqrefs can be compared by identity). */
const EQ_HEAP = -19;

/** WasmGC `none` bottom heap type (0x6e as signed LEB = -18). A `ref.null none`
 *  is a subtype of anyref, used to push the absent/undefined value. */
const NONE_HEAP = -18;

/** Initial bucket capacity (power of two). */
const INIT_CAP = 8;

/** Deleted/tombstone flag stored in the top bit of `$MapEntry.$hash`. */
const TOMBSTONE_BIT = 0x40000000; // bit 30 — keeps hashes non-negative i32

/**
 * (#2162) `$Map` / `$MapEntry` field layout, exported so the for-of entries
 * driver (statements/loops.ts) can walk the entries vector natively without
 * re-deriving the constants. `entries` is the `$MapEntry[]` backing array;
 * `entryCount` is the high-water mark (live + tombstoned); a `$MapEntry` stores
 * `key`, `value`, and a `hash` whose top bit (`tombstoneBit`) flags deletion.
 */
export const MAP_LAYOUT = {
  M_ENTRIES: 1,
  M_ENTRYCOUNT: 2,
  M_LIVECOUNT: 3,
  /** (#3171) Immutable collection-kind tag (COLLECTION_KIND), appended LAST so
   *  every pre-existing field index stays valid. */
  M_KIND: 4,
  F_KEY: 0,
  F_VALUE: 1,
  F_HASH: 3,
  TOMBSTONE_BIT,
} as const;

/**
 * (#3171) Which keyed collection a `$Map` struct instance backs. All four
 * collections share the `$Map` hash table (Set/WeakSet store key === value), so
 * struct identity alone cannot distinguish `[[MapData]]` / `[[SetData]]` /
 * `[[WeakMapData]]` / `[[WeakSetData]]` for the spec receiver brand checks
 * (`Map.prototype.get.call(new Set())` must throw a TypeError). The immutable
 * `kind` field (MAP_LAYOUT.M_KIND), stamped at construction by `__map_new`,
 * carries the brand.
 */
export const COLLECTION_KIND = {
  MAP: 0,
  SET: 1,
  WEAKMAP: 2,
  WEAKSET: 3,
} as const;
export type CollectionKind = (typeof COLLECTION_KIND)[keyof typeof COLLECTION_KIND];

/**
 * Register the WasmGC struct/array types backing the native Map. Idempotent.
 * Stores the type indices on `ctx`. Mirrors `ensureWrapperTypes` /
 * `ensureNativeStringHelpers` type-registration.
 */
export function ensureMapRuntimeTypes(ctx: CodegenContext): void {
  if (ctx.mapTypeIdx >= 0) return;

  // $MapEntry: struct { key: anyref(mut); value: anyref(mut); next: i32(mut); hash: i32(mut) }
  ctx.mapEntryTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "MapEntry",
    fields: [
      { name: "key", type: { kind: "anyref" }, mutable: true },
      { name: "value", type: { kind: "anyref" }, mutable: true },
      { name: "next", type: { kind: "i32" }, mutable: true },
      { name: "hash", type: { kind: "i32" }, mutable: true },
    ],
  } as StructTypeDef);

  // $MapEntries: (array (mut (ref null $MapEntry)))
  ctx.mapEntriesTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "MapEntries",
    element: { kind: "ref_null", typeIdx: ctx.mapEntryTypeIdx },
    mutable: true,
  } as ArrayTypeDef);

  // $MapBuckets: (array (mut i32))
  ctx.mapBucketsTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "MapBuckets",
    element: { kind: "i32" },
    mutable: true,
  } as ArrayTypeDef);

  // $Map: struct { buckets; entries; entryCount(mut i32); liveCount(mut i32) }
  ctx.mapTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "Map",
    fields: [
      {
        name: "buckets",
        type: { kind: "ref", typeIdx: ctx.mapBucketsTypeIdx },
        mutable: true,
      },
      {
        name: "entries",
        type: { kind: "ref", typeIdx: ctx.mapEntriesTypeIdx },
        mutable: true,
      },
      { name: "entryCount", type: { kind: "i32" }, mutable: true },
      { name: "liveCount", type: { kind: "i32" }, mutable: true },
      // (#3171) COLLECTION_KIND brand tag, trailing + immutable — see MAP_LAYOUT.
      { name: "kind", type: { kind: "i32" }, mutable: false },
    ],
  } as StructTypeDef);
  ctx.structMap.set("Map", ctx.mapTypeIdx);
  ctx.typeIdxToStructName.set(ctx.mapTypeIdx, "Map");

  // $MapIterResult: struct { value: anyref(mut); done: i32(mut) } — shared
  // iterator-result shape for collection iterators.
  ctx.mapIterResultTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "MapIterResult",
    fields: [
      { name: "value", type: { kind: "anyref" }, mutable: true },
      { name: "done", type: { kind: "i32" }, mutable: true },
    ],
  } as StructTypeDef);

  // $MapIter: struct { map: ref $Map; index: i32(mut); kind: i32 (0=key,1=val,2=entry) }
  ctx.mapIterTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "MapIter",
    fields: [
      {
        name: "map",
        type: { kind: "ref", typeIdx: ctx.mapTypeIdx },
        mutable: false,
      },
      { name: "index", type: { kind: "i32" }, mutable: true },
      { name: "kind", type: { kind: "i32" }, mutable: false },
    ],
  } as StructTypeDef);
}

/** Convenience ValTypes once types are registered. */
function mapRef(ctx: CodegenContext): ValType {
  return { kind: "ref", typeIdx: ctx.mapTypeIdx };
}

/**
 * Register a module function, return its funcIdx, and record it in
 * `ctx.mapHelpers`. Mirrors the `funcIdx = numImportFuncs + functions.length`
 * idiom used across codegen.
 */
function addMapFunc(
  ctx: CodegenContext,
  name: string,
  params: ValType[],
  results: ValType[],
  locals: { name: string; type: ValType }[],
  body: Instr[],
): number {
  const typeIdx = addFuncType(ctx, params, results);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.mapHelpers.set(name, funcIdx);
  pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
  return funcIdx;
}

/**
 * Emit the full Map runtime (hash, equality, lookup, construction, methods,
 * iterators). Idempotent. MUST run before any user body that references a Map
 * helper, and after the native-string helpers so `__str_equals` is available
 * (string-key equality reuses it).
 */
export function ensureMapHelpers(ctx: CodegenContext): void {
  if (ctx.mapHelpersEmitted) return;
  ctx.mapHelpersEmitted = true;
  ensureMapRuntimeTypes(ctx);

  const anyref: ValType = { kind: "anyref" };
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };
  const entryRef: ValType = { kind: "ref", typeIdx: ctx.mapEntryTypeIdx };
  const entryRefNull: ValType = {
    kind: "ref_null",
    typeIdx: ctx.mapEntryTypeIdx,
  };
  const entriesRef: ValType = { kind: "ref", typeIdx: ctx.mapEntriesTypeIdx };
  const bucketsRef: ValType = { kind: "ref", typeIdx: ctx.mapBucketsTypeIdx };
  const mref = mapRef(ctx);
  const iterRef: ValType = { kind: "ref", typeIdx: ctx.mapIterTypeIdx };
  const iterResultRef: ValType = {
    kind: "ref",
    typeIdx: ctx.mapIterResultTypeIdx,
  };

  // Field indices.
  const F_KEY = 0;
  const F_VALUE = 1;
  const F_NEXT = 2;
  const F_HASH = 3;
  const M_BUCKETS = 0;
  const M_ENTRIES = 1;
  const M_ENTRYCOUNT = 2;
  const M_LIVECOUNT = 3;
  const IT_MAP = 0;
  const IT_INDEX = 1;
  const IT_KIND = 2;

  // ── __same_value_zero(a: anyref, b: anyref) -> i32 ──────────────────────
  // SameValueZero (spec 7.2.10). For the native collection we only have to
  // distinguish: both i31 (small int / bool) → i32 compare; both heap-number
  // boxes → f64 compare with NaN===NaN; both eqref objects → ref.eq; else 0.
  // The hash already groups by these classes, so a == b reaching here means
  // they hashed equal; full type discrimination keeps it correct.
  //
  // We rely on the existing boxing: numbers are boxed via __box_number into a
  // struct (a non-i31 eqref); small ints may be i31ref. ref.eq covers i31 and
  // object identity. For boxed numbers ref.eq is identity (wrong for equal
  // values in distinct boxes) so we additionally compare unboxed values when
  // both are number boxes. Strings compare by content via __str_equals.
  {
    const unbox = ctx.funcMap.get("__unbox_number");
    const typeofNum = ctx.funcMap.get("__typeof_number");
    const typeofStr = ctx.funcMap.get("__typeof_string");
    const strEq = ctx.nativeStrHelpers.get("__str_equals");
    // a(0), b(1)
    const body: Instr[] = [];
    // 0) (#2606 Bug A) Both null → SameValueZero true. `null`/`undefined` set
    //    elements are stored as `ref.null NONE_HEAP` (the `none` bottom), which
    //    is NOT a non-null eqref — so `ref.test (ref eq)` returns 0 for it and
    //    the reference-identity arm below never fires for null-vs-null. Compare
    //    `ref.is_null` on both operands directly: a stored null and a queried
    //    null are SameValueZero-equal (and `null`/`undefined` collapse to the
    //    same `none` representation, matching JS `set.add(undefined);
    //    set.has(undefined)` and the absent/`undefined`→null sentinel).
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "ref.is_null" });
    body.push({ op: "local.get", index: 1 });
    body.push({ op: "ref.is_null" });
    body.push({ op: "i32.and" });
    body.push({
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      else: [],
    });
    // 1) Reference identity (covers i31 small ints/bools, null, same object).
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "ref.test", typeIdx: EQ_HEAP });
    body.push({ op: "local.get", index: 1 });
    body.push({ op: "ref.test", typeIdx: EQ_HEAP });
    body.push({ op: "i32.and" });
    body.push({
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [
        { op: "local.get", index: 0 },
        { op: "ref.cast", typeIdx: EQ_HEAP },
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: EQ_HEAP },
        { op: "ref.eq" },
        {
          op: "if",
          blockType: { kind: "val", type: i32 },
          then: [{ op: "i32.const", value: 1 }, { op: "return" }],
          else: [],
        },
      ],
      else: [],
    });
    // 2) Both numbers → unbox + f64 compare (NaN===NaN, +0===-0 per SVZ).
    if (unbox !== undefined && typeofNum !== undefined) {
      body.push({ op: "local.get", index: 0 });
      body.push({ op: "extern.convert_any" });
      body.push({ op: "call", funcIdx: typeofNum });
      body.push({ op: "local.get", index: 1 });
      body.push({ op: "extern.convert_any" });
      body.push({ op: "call", funcIdx: typeofNum });
      body.push({ op: "i32.and" });
      body.push({
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [
          // a == b OR (both NaN). f64.eq handles +0/-0 equal. NaN handled by
          // the (a!==a && b!==b) branch.
          { op: "local.get", index: 0 },
          { op: "extern.convert_any" },
          { op: "call", funcIdx: unbox },
          { op: "local.tee", index: 2 },
          { op: "local.get", index: 1 },
          { op: "extern.convert_any" },
          { op: "call", funcIdx: unbox },
          { op: "local.tee", index: 3 },
          { op: "f64.eq" },
          {
            op: "if",
            blockType: { kind: "val", type: i32 },
            then: [{ op: "i32.const", value: 1 }, { op: "return" }],
            else: [
              // NaN===NaN: a!==a && b!==b
              { op: "local.get", index: 2 },
              { op: "local.get", index: 2 },
              { op: "f64.ne" },
              { op: "local.get", index: 3 },
              { op: "local.get", index: 3 },
              { op: "f64.ne" },
              { op: "i32.and" },
              { op: "return" },
            ],
          },
        ],
        else: [],
      });
    }
    // 3) Both strings → content equality.
    if (strEq !== undefined && typeofStr !== undefined && ctx.anyStrTypeIdx >= 0) {
      const anyStrRef: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
      body.push({ op: "local.get", index: 0 });
      body.push({ op: "extern.convert_any" });
      body.push({ op: "call", funcIdx: typeofStr });
      body.push({ op: "local.get", index: 1 });
      body.push({ op: "extern.convert_any" });
      body.push({ op: "call", funcIdx: typeofStr });
      body.push({ op: "i32.and" });
      body.push({
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
          { op: "call", funcIdx: strEq },
          { op: "return" },
        ],
        else: [],
      });
      void anyStrRef;
    }
    body.push({ op: "i32.const", value: 0 });
    addMapFunc(
      ctx,
      "__same_value_zero",
      [anyref, anyref],
      [i32],
      [
        { name: "av", type: f64 },
        { name: "bv", type: f64 },
      ],
      body,
    );
  }

  // ── __hash_anyref(k: anyref) -> i32 (non-negative, low 30 bits) ─────────
  // Number → fold f64 bits. String → FNV-1a over code units. Object/i31/bool/
  // null → a stable bucketing constant (identity hash deferred: all
  // non-number/non-string keys share bucket 0 and rely on ref.eq in the chain
  // walk — correct, though objects collide; acceptable for #1103a foundation).
  {
    const unbox = ctx.funcMap.get("__unbox_number");
    const typeofNum = ctx.funcMap.get("__typeof_number");
    const typeofStr = ctx.funcMap.get("__typeof_string");
    const strLen = ctx.nativeStrHelpers.get("__str_charAt"); // not used; placeholder removed below
    void strLen;
    const body: Instr[] = [];
    // number → bits fold
    if (unbox !== undefined && typeofNum !== undefined) {
      body.push({ op: "local.get", index: 0 });
      body.push({ op: "extern.convert_any" });
      body.push({ op: "call", funcIdx: typeofNum });
      body.push({
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [
          { op: "local.get", index: 0 },
          { op: "extern.convert_any" },
          { op: "call", funcIdx: unbox },
          { op: "local.tee", index: 1 },
          // normalize -0 to +0 so they hash equal
          { op: "f64.const", value: 0 },
          { op: "f64.add" },
          { op: "i64.reinterpret_f64" },
          { op: "local.tee", index: 2 },
          { op: "i64.const", value: 32n },
          { op: "i64.shr_u" },
          { op: "local.get", index: 2 },
          { op: "i64.xor" },
          { op: "i32.wrap_i64" },
          // (#3951) Murmur3 finalizer — REQUIRED, not a refinement. The bare
          // xor-fold leaves the low bits zero for integer keys (a small integer
          // as an f64 has an all-zero low mantissa), and the caller's bucket
          // index is `hash & (cap-1)` — exactly those bits — so every integer
          // key hashed to bucket 0 and lookups were O(n). Bucket-only change;
          // measurements and full analysis on plan/issues/3951-*.md.
          { op: "local.set", index: 3 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 3 },
          { op: "i32.const", value: 16 },
          { op: "i32.shr_u" },
          { op: "i32.xor" },
          { op: "i32.const", value: 0x85ebca6b | 0 },
          { op: "i32.mul" },
          { op: "local.set", index: 3 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 3 },
          { op: "i32.const", value: 13 },
          { op: "i32.shr_u" },
          { op: "i32.xor" },
          { op: "i32.const", value: 0xc2b2ae35 | 0 },
          { op: "i32.mul" },
          { op: "local.set", index: 3 },
          { op: "local.get", index: 3 },
          { op: "local.get", index: 3 },
          { op: "i32.const", value: 16 },
          { op: "i32.shr_u" },
          { op: "i32.xor" },
          { op: "i32.const", value: 0x3fffffff },
          { op: "i32.and" },
          { op: "return" },
        ],
        else: [],
      });
    }
    // string → FNV-1a over UTF-16 code units via __str_charAt + length.
    const charAt = ctx.nativeStrHelpers.get("__str_charAt");
    void charAt;
    if (typeofStr !== undefined && ctx.anyStrTypeIdx >= 0) {
      const flatten = ctx.nativeStrHelpers.get("__str_flatten");
      const strTypeIdx = ctx.nativeStrTypeIdx;
      const dataTypeIdx = ctx.nativeStrDataTypeIdx;
      if (flatten !== undefined && strTypeIdx >= 0 && dataTypeIdx >= 0) {
        // h(3)=2166136261; i(4)=0; flat(5)=ref $NativeString; data(6); len(7)
        body.push({ op: "local.get", index: 0 });
        body.push({ op: "extern.convert_any" });
        body.push({ op: "call", funcIdx: typeofStr });
        body.push({
          op: "if",
          blockType: { kind: "val", type: i32 },
          then: [
            { op: "local.get", index: 0 },
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx },
            { op: "call", funcIdx: flatten },
            { op: "ref.cast", typeIdx: strTypeIdx },
            { op: "local.tee", index: 5 },
            // data array (field 3 of NativeString: len,byteLen?,off,data — use struct.get by name index)
            // NativeString layout: { len(i32), ..., data }. We read length via array.len of data.
            {
              op: "struct.get",
              typeIdx: strTypeIdx,
              fieldIdx: nativeStrDataFieldIdx(ctx),
            },
            { op: "local.tee", index: 6 },
            { op: "array.len" },
            { op: "local.set", index: 7 },
            { op: "i32.const", value: 0x811c9dc5 | 0 },
            { op: "local.set", index: 3 },
            { op: "i32.const", value: 0 },
            { op: "local.set", index: 4 },
            {
              op: "block",
              blockType: { kind: "empty" },
              body: [
                {
                  op: "loop",
                  blockType: { kind: "empty" },
                  body: [
                    { op: "local.get", index: 4 },
                    { op: "local.get", index: 7 },
                    { op: "i32.ge_s" },
                    { op: "br_if", depth: 1 },
                    // h ^= cu
                    { op: "local.get", index: 3 },
                    { op: "local.get", index: 6 },
                    { op: "local.get", index: 4 },
                    {
                      op: "array.get_u",
                      typeIdx: dataTypeIdx,
                    },
                    { op: "i32.xor" },
                    // h *= 16777619
                    { op: "i32.const", value: 16777619 },
                    { op: "i32.mul" },
                    { op: "local.set", index: 3 },
                    { op: "local.get", index: 4 },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" },
                    { op: "local.set", index: 4 },
                    { op: "br", depth: 0 },
                  ],
                },
              ],
            },
            { op: "local.get", index: 3 },
            { op: "i32.const", value: 0x3fffffff },
            { op: "i32.and" },
            { op: "return" },
          ],
          else: [],
        });
      }
    }
    // default: bucket 0 (objects/bools/null share; ref.eq resolves chain)
    body.push({ op: "i32.const", value: 0 });
    addMapFunc(
      ctx,
      "__hash_anyref",
      [anyref],
      [i32],
      [
        { name: "nv", type: f64 },
        { name: "i", type: i32 },
        { name: "bits", type: { kind: "i64" } },
        {
          name: "flat",
          type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx },
        },
        {
          name: "data",
          type: { kind: "ref_null", typeIdx: ctx.nativeStrDataTypeIdx },
        },
        { name: "len", type: i32 },
      ],
      // reorder locals to match indices used above: h(3) bits(2) i(4)? — we used
      // explicit indices 1..7; declare locals 1..7 accordingly.
      // params: k(0). locals: 1=nv(f64),2=bits(i64),3=h(i32),4=i(i32),5=flat,6=data,7=len
      body,
    );
  }

  // NOTE: the local layout for __hash_anyref above is finalized in a follow-up
  // pass (declareHashLocals) to guarantee indices 1..7 line up; see below.
  fixHashLocals(ctx);

  // ── __map_new(kind: i32) -> ref $Map ────────────────────────────────────
  // (#3171) `kind` is the COLLECTION_KIND brand tag (0=Map 1=Set 2=WeakMap
  // 3=WeakSet) stamped immutably at construction — every construction site
  // (new-super.ts ctors, set-algebra results, groupBy) passes its brand.
  {
    const body: Instr[] = [
      // buckets: array.new i32 of length INIT_CAP, all -1
      { op: "i32.const", value: -1 },
      { op: "i32.const", value: INIT_CAP },
      { op: "array.new", typeIdx: ctx.mapBucketsTypeIdx },
      // entries: array.new_default ref null $MapEntry, length INIT_CAP
      { op: "i32.const", value: INIT_CAP },
      {
        op: "array.new_default",
        typeIdx: ctx.mapEntriesTypeIdx,
      },
      // entryCount=0, liveCount=0
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      // kind (trailing brand field)
      { op: "local.get", index: 0 },
      { op: "struct.new", typeIdx: ctx.mapTypeIdx },
    ];
    addMapFunc(ctx, "__map_new", [i32], [mref], [], body);
  }

  const hashIdx = ctx.mapHelpers.get("__hash_anyref")!;
  const svzIdx = ctx.mapHelpers.get("__same_value_zero")!;

  // ── __map_lookup_idx(m, key) -> i32 (entry index or -1) ─────────────────
  {
    // params: m(0), key(1). locals: hash(2), bucket(3), cur(4), entry(5)
    const body: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: hashIdx },
      { op: "local.tee", index: 2 },
      // bucket = hash & (cap-1)
      { op: "local.get", index: 0 },
      {
        op: "struct.get",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_BUCKETS,
      },
      { op: "array.len" },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "i32.and" },
      { op: "local.set", index: 3 },
      // cur = buckets[bucket]
      { op: "local.get", index: 0 },
      {
        op: "struct.get",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_BUCKETS,
      },
      { op: "local.get", index: 3 },
      { op: "array.get", typeIdx: ctx.mapBucketsTypeIdx },
      { op: "local.set", index: 4 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 4 },
              { op: "i32.const", value: 0 },
              { op: "i32.lt_s" },
              { op: "br_if", depth: 1 }, // cur<0 → miss
              // entry = entries[cur]
              { op: "local.get", index: 0 },
              {
                op: "struct.get",
                typeIdx: ctx.mapTypeIdx,
                fieldIdx: M_ENTRIES,
              },
              { op: "local.get", index: 4 },
              {
                op: "array.get",
                typeIdx: ctx.mapEntriesTypeIdx,
              },
              { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
              { op: "local.set", index: 5 },
              // if !tombstone && hash matches && SVZ(key, entry.key) → return cur
              { op: "local.get", index: 5 },
              {
                op: "struct.get",
                typeIdx: ctx.mapEntryTypeIdx,
                fieldIdx: F_HASH,
              },
              { op: "i32.const", value: TOMBSTONE_BIT },
              { op: "i32.and" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 1 },
                  { op: "local.get", index: 5 },
                  {
                    op: "struct.get",
                    typeIdx: ctx.mapEntryTypeIdx,
                    fieldIdx: F_KEY,
                  },
                  { op: "call", funcIdx: svzIdx },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "local.get", index: 4 }, { op: "return" }],
                    else: [],
                  },
                ],
                else: [],
              },
              // cur = entry.next
              { op: "local.get", index: 5 },
              {
                op: "struct.get",
                typeIdx: ctx.mapEntryTypeIdx,
                fieldIdx: F_NEXT,
              },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: -1 },
    ];
    addMapFunc(
      ctx,
      "__map_lookup_idx",
      [mref, anyref],
      [i32],
      [
        { name: "hash", type: i32 },
        { name: "bucket", type: i32 },
        { name: "cur", type: i32 },
        { name: "entry", type: entryRef },
      ],
      body,
    );
  }

  const lookupIdx = ctx.mapHelpers.get("__map_lookup_idx")!;

  // ── __map_get(m, key) -> anyref ─────────────────────────────────────────
  {
    // (#3331) MISS value: under the #2106 `$undefined`-singleton regime a
    // missing key answers the singleton (miss ≡ undefined per §24.1.3.6 step
    // 5), keeping it DISTINCT from a stored `null` — the legacy null-miss
    // made `m.get(missing) === undefined` false (fourth instance of the
    // singleton null-guard class). Legacy lanes keep `ref.null` (their
    // undefined representation) byte-identically. The one internal null-keyed
    // consumer (Map.groupBy) treats the singleton as miss explicitly below.
    const missInstrs: Instr[] = (() => {
      if (undefinedSingletonActive(ctx)) {
        if (ctx.undefinedGlobalIdx === undefined) ensureAnyValueType(ctx);
        if (ctx.undefinedGlobalIdx !== undefined) {
          return [{ op: "global.get", index: ctx.undefinedGlobalIdx }];
        }
      }
      return [{ op: "ref.null", typeIdx: NONE_HEAP }]; // legacy: undefined → null
    })();
    // idx(2)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: lookupIdx },
      { op: "local.tee", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: anyref },
        then: missInstrs,
        else: [
          { op: "local.get", index: 0 },
          {
            op: "struct.get",
            typeIdx: ctx.mapTypeIdx,
            fieldIdx: M_ENTRIES,
          },
          { op: "local.get", index: 2 },
          {
            op: "array.get",
            typeIdx: ctx.mapEntriesTypeIdx,
          },
          { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
          {
            op: "struct.get",
            typeIdx: ctx.mapEntryTypeIdx,
            fieldIdx: F_VALUE,
          },
        ],
      },
    ];
    addMapFunc(ctx, "__map_get", [mref, anyref], [anyref], [{ name: "idx", type: i32 }], body);
  }

  // ── __map_has(m, key) -> i32 ────────────────────────────────────────────
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: lookupIdx },
      { op: "i32.const", value: -1 },
      { op: "i32.ne" },
    ];
    addMapFunc(ctx, "__map_has", [mref, anyref], [i32], [], body);
  }

  // ── __map_size(m) -> i32 ────────────────────────────────────────────────
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      {
        op: "struct.get",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_LIVECOUNT,
      },
    ];
    addMapFunc(ctx, "__map_size", [mref], [i32], [], body);
  }

  // ── __map_set(m, key, value) -> ref $Map ────────────────────────────────
  // Overwrite if present; else append a new entry, link into bucket, grow on
  // load factor > 0.75.
  {
    // locals: idx(3), hash(4), bucket(5), entry(6), newEntries(7), ec(8), cap(9)
    const body: Instr[] = [
      // existing?
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: lookupIdx },
      { op: "local.tee", index: 3 },
      { op: "i32.const", value: 0 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // entries[idx].value = value; return m
          { op: "local.get", index: 0 },
          {
            op: "struct.get",
            typeIdx: ctx.mapTypeIdx,
            fieldIdx: M_ENTRIES,
          },
          { op: "local.get", index: 3 },
          {
            op: "array.get",
            typeIdx: ctx.mapEntriesTypeIdx,
          },
          { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
          { op: "local.get", index: 2 },
          {
            op: "struct.set",
            typeIdx: ctx.mapEntryTypeIdx,
            fieldIdx: F_VALUE,
          },
          { op: "local.get", index: 0 },
          { op: "return" },
        ],
        else: [],
      },
      // grow entries vector if full (entryCount == entries.len)
      { op: "local.get", index: 0 },
      {
        op: "struct.get",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_ENTRYCOUNT,
      },
      { op: "local.tee", index: 8 },
      { op: "local.get", index: 0 },
      {
        op: "struct.get",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_ENTRIES,
      },
      { op: "array.len" },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: growEntriesInstrs(ctx, M_ENTRIES, M_ENTRYCOUNT, 7, 8),
        else: [],
      },
      // hash + bucket
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: hashIdx },
      { op: "local.tee", index: 4 },
      { op: "local.get", index: 0 },
      {
        op: "struct.get",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_BUCKETS,
      },
      { op: "array.len" },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "i32.and" },
      { op: "local.set", index: 5 },
      // entry = struct.new(key,value,buckets[bucket],hash)
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 0 },
      {
        op: "struct.get",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_BUCKETS,
      },
      { op: "local.get", index: 5 },
      { op: "array.get", typeIdx: ctx.mapBucketsTypeIdx },
      { op: "local.get", index: 4 },
      { op: "struct.new", typeIdx: ctx.mapEntryTypeIdx },
      { op: "local.set", index: 6 },
      // entries[entryCount] = entry
      { op: "local.get", index: 0 },
      {
        op: "struct.get",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_ENTRIES,
      },
      { op: "local.get", index: 8 },
      { op: "local.get", index: 6 },
      { op: "array.set", typeIdx: ctx.mapEntriesTypeIdx },
      // buckets[bucket] = entryCount
      { op: "local.get", index: 0 },
      {
        op: "struct.get",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_BUCKETS,
      },
      { op: "local.get", index: 5 },
      { op: "local.get", index: 8 },
      { op: "array.set", typeIdx: ctx.mapBucketsTypeIdx },
      // entryCount++ ; liveCount++
      { op: "local.get", index: 0 },
      { op: "local.get", index: 8 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      {
        op: "struct.set",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_ENTRYCOUNT,
      },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 0 },
      {
        op: "struct.get",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_LIVECOUNT,
      },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      {
        op: "struct.set",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_LIVECOUNT,
      },
      // rehash if liveCount*4 > buckets.len*3
      ...rehashIfNeededInstrs(ctx, M_BUCKETS, M_LIVECOUNT),
      { op: "local.get", index: 0 },
    ];
    addMapFunc(
      ctx,
      "__map_set",
      [mref, anyref, anyref],
      [mref],
      [
        { name: "idx", type: i32 },
        { name: "hash", type: i32 },
        { name: "bucket", type: i32 },
        { name: "entry", type: entryRef },
        { name: "newEntries", type: entriesRef },
        { name: "ec", type: i32 },
        { name: "cap", type: i32 },
      ],
      body,
    );
    void entryRefNull;
    void bucketsRef;
  }

  // ── __map_delete(m, key) -> i32 ─────────────────────────────────────────
  // Tombstone the entry (preserve iteration stability); decrement liveCount.
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: lookupIdx },
      { op: "local.tee", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [{ op: "i32.const", value: 0 }],
        else: [
          // entry = entries[idx]
          { op: "local.get", index: 0 },
          {
            op: "struct.get",
            typeIdx: ctx.mapTypeIdx,
            fieldIdx: M_ENTRIES,
          },
          { op: "local.get", index: 2 },
          {
            op: "array.get",
            typeIdx: ctx.mapEntriesTypeIdx,
          },
          { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
          { op: "local.tee", index: 3 },
          // hash |= TOMBSTONE_BIT
          { op: "local.get", index: 3 },
          {
            op: "struct.get",
            typeIdx: ctx.mapEntryTypeIdx,
            fieldIdx: F_HASH,
          },
          { op: "i32.const", value: TOMBSTONE_BIT },
          { op: "i32.or" },
          {
            op: "struct.set",
            typeIdx: ctx.mapEntryTypeIdx,
            fieldIdx: F_HASH,
          },
          // key=null, value=null
          { op: "local.get", index: 3 },
          { op: "ref.null", typeIdx: NONE_HEAP },
          {
            op: "struct.set",
            typeIdx: ctx.mapEntryTypeIdx,
            fieldIdx: F_KEY,
          },
          { op: "local.get", index: 3 },
          { op: "ref.null", typeIdx: NONE_HEAP },
          {
            op: "struct.set",
            typeIdx: ctx.mapEntryTypeIdx,
            fieldIdx: F_VALUE,
          },
          // liveCount--
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 },
          {
            op: "struct.get",
            typeIdx: ctx.mapTypeIdx,
            fieldIdx: M_LIVECOUNT,
          },
          { op: "i32.const", value: 1 },
          { op: "i32.sub" },
          {
            op: "struct.set",
            typeIdx: ctx.mapTypeIdx,
            fieldIdx: M_LIVECOUNT,
          },
          { op: "i32.const", value: 1 },
        ],
      },
    ];
    addMapFunc(
      ctx,
      "__map_delete",
      [mref, anyref],
      [i32],
      [
        { name: "idx", type: i32 },
        { name: "entry", type: entryRef },
      ],
      body,
    );
  }

  // ── __map_clear(m) -> (void) ────────────────────────────────────────────
  {
    const body: Instr[] = [
      // buckets = new -1 array INIT_CAP
      { op: "local.get", index: 0 },
      { op: "i32.const", value: -1 },
      { op: "i32.const", value: INIT_CAP },
      { op: "array.new", typeIdx: ctx.mapBucketsTypeIdx },
      {
        op: "struct.set",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_BUCKETS,
      },
      // entries = new default array INIT_CAP
      { op: "local.get", index: 0 },
      { op: "i32.const", value: INIT_CAP },
      {
        op: "array.new_default",
        typeIdx: ctx.mapEntriesTypeIdx,
      },
      {
        op: "struct.set",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_ENTRIES,
      },
      // entryCount=0, liveCount=0
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      {
        op: "struct.set",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_ENTRYCOUNT,
      },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      {
        op: "struct.set",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_LIVECOUNT,
      },
    ];
    addMapFunc(ctx, "__map_clear", [mref], [], [], body);
  }

  // ── __map_iter_new(m, kind) -> ref $MapIter ─────────────────────────────
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "local.get", index: 1 },
      { op: "struct.new", typeIdx: ctx.mapIterTypeIdx },
    ];
    addMapFunc(ctx, "__map_iter_new", [mref, i32], [iterRef], [], body);
  }

  // ── __map_iter_next(it) -> ref $MapIterResult ───────────────────────────
  // Walks the entries vector from it.index, skipping tombstones. Produces a
  // {value, done} result. Entry-kind iteration must return a FRESH [key,value]
  // pair on every poll (§24.1.5.2). Use the canonical `$Vec` carrier so
  // native-first values-only Map iteration does not initialize the object
  // runtime just to keep this otherwise-dead entries arm available.
  {
    // locals: m(1), idx(2), entries(3), entry(4), pair data(5)
    const pairVecTypeIdx = getOrRegisterVecType(ctx, "externref", {
      kind: "externref",
    });
    const pairArrTypeIdx = getArrTypeIdxFromVec(ctx, pairVecTypeIdx);
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      {
        op: "struct.get",
        typeIdx: ctx.mapIterTypeIdx,
        fieldIdx: IT_MAP,
      },
      { op: "local.tee", index: 1 },
      {
        op: "struct.get",
        typeIdx: ctx.mapTypeIdx,
        fieldIdx: M_ENTRIES,
      },
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 0 },
              {
                op: "struct.get",
                typeIdx: ctx.mapIterTypeIdx,
                fieldIdx: IT_INDEX,
              },
              { op: "local.tee", index: 2 },
              { op: "local.get", index: 1 },
              {
                op: "struct.get",
                typeIdx: ctx.mapTypeIdx,
                fieldIdx: M_ENTRYCOUNT,
              },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 }, // done
              // entry = entries[idx]
              { op: "local.get", index: 3 },
              { op: "local.get", index: 2 },
              {
                op: "array.get",
                typeIdx: ctx.mapEntriesTypeIdx,
              },
              { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
              { op: "local.tee", index: 4 },
              // index++
              { op: "local.get", index: 0 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              {
                op: "struct.set",
                typeIdx: ctx.mapIterTypeIdx,
                fieldIdx: IT_INDEX,
              },
              // tombstone? skip
              { op: "local.get", index: 4 },
              {
                op: "struct.get",
                typeIdx: ctx.mapEntryTypeIdx,
                fieldIdx: F_HASH,
              },
              { op: "i32.const", value: TOMBSTONE_BIT },
              { op: "i32.and" },
              { op: "br_if", depth: 0 },
              // result: kind 0=key,1=value,2=entries
              { op: "local.get", index: 0 },
              {
                op: "struct.get",
                typeIdx: ctx.mapIterTypeIdx,
                fieldIdx: IT_KIND,
              },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "val", type: anyref },
                then: [
                  { op: "local.get", index: 4 },
                  {
                    op: "struct.get",
                    typeIdx: ctx.mapEntryTypeIdx,
                    fieldIdx: F_KEY,
                  },
                ],
                else: [
                  { op: "local.get", index: 0 },
                  {
                    op: "struct.get",
                    typeIdx: ctx.mapIterTypeIdx,
                    fieldIdx: IT_KIND,
                  },
                  { op: "i32.const", value: 2 },
                  { op: "i32.eq" },
                  {
                    op: "if",
                    blockType: { kind: "val", type: anyref },
                    then: [
                      // Allocate a fresh canonical two-slot vec for [key,
                      // value]. Strict native iterator consumers already
                      // understand this carrier, while the old ObjVec path
                      // reached the compatibility iterator bridge.
                      { op: "i32.const", value: 2 },
                      { op: "array.new_default", typeIdx: pairArrTypeIdx },
                      { op: "local.set", index: 5 },
                      { op: "local.get", index: 5 },
                      { op: "i32.const", value: 0 },
                      { op: "local.get", index: 4 },
                      {
                        op: "struct.get",
                        typeIdx: ctx.mapEntryTypeIdx,
                        fieldIdx: F_KEY,
                      },
                      { op: "extern.convert_any" },
                      { op: "array.set", typeIdx: pairArrTypeIdx },
                      { op: "local.get", index: 5 },
                      { op: "i32.const", value: 1 },
                      { op: "local.get", index: 4 },
                      {
                        op: "struct.get",
                        typeIdx: ctx.mapEntryTypeIdx,
                        fieldIdx: F_VALUE,
                      },
                      { op: "extern.convert_any" },
                      { op: "array.set", typeIdx: pairArrTypeIdx },
                      { op: "i32.const", value: 2 },
                      { op: "local.get", index: 5 },
                      { op: "struct.new", typeIdx: pairVecTypeIdx },
                    ],
                    else: [
                      { op: "local.get", index: 4 },
                      {
                        op: "struct.get",
                        typeIdx: ctx.mapEntryTypeIdx,
                        fieldIdx: F_VALUE,
                      },
                    ],
                  },
                ],
              },
              { op: "i32.const", value: 0 },
              { op: "struct.new", typeIdx: ctx.mapIterResultTypeIdx },
              { op: "return" },
            ],
          },
        ],
      },
      // done: {value:null, done:1}
      { op: "ref.null", typeIdx: NONE_HEAP },
      { op: "i32.const", value: 1 },
      { op: "struct.new", typeIdx: ctx.mapIterResultTypeIdx },
    ];
    addMapFunc(
      ctx,
      "__map_iter_next",
      [iterRef],
      [iterResultRef],
      [
        { name: "m", type: mref },
        { name: "idx", type: i32 },
        { name: "entries", type: entriesRef },
        { name: "entry", type: entryRef },
        { name: "pairData", type: { kind: "ref", typeIdx: pairArrTypeIdx } },
      ],
      body,
    );
  }
}

/**
 * (#3149) Native standalone `Map.groupBy(items, callback)` — ES2024 §24.1.1.2
 * (GroupBy with keyCoercion COLLECTION). Under `--target standalone`/`wasi`
 * there is no host `__map_groupBy`, so the call site (`expressions/calls.ts`)
 * hits the #1472 dynamic-shape refusal. This registers a Wasm-native helper
 * that mirrors `ensureObjectGroupBy` (object-runtime.ts) but groups into a
 * WasmGC-native `$Map` keyed by SameValueZero:
 *
 *   out = new Map()
 *   for i in 0 .. __extern_length(items):
 *     val = __extern_get_idx(items, i)
 *     key = callback(val, i)   via __apply_closure(cb, undefined, [val, box(i)])
 *     group = __map_get(out, key)           // SameValueZero lookup
 *     if group is null: group = __objvec_new(); __map_set(out, key, group)
 *     __objvec_push(group, val)
 *   return out
 *
 * The COLLECTION key coercion — `CanonicalizeKeyedCollectionKey`, i.e. -0 → +0
 * (the `built-ins/Map/groupBy/negativeZero.js` assertion) — is provided FOR
 * FREE by `__map_set`/`__map_get`, whose `__same_value_zero`/`__hash_anyref`
 * already normalize -0 to +0 (map-runtime.ts). The key is the RAW callback
 * result (Map keys are values, NOT property keys — no ToPropertyKey), converted
 * externref → anyref for the map. Each group value is a `$ObjVec` (a real Array
 * on read-back). A callback that throws propagates (the closure bridge rethrows
 * into the caller). Returns `ref $Map` so the binding is typed for the Map
 * method/`.size` dispatch (mirrors `new Map()`).
 *
 * `items` is iterated via `__extern_length`/`__extern_get_idx` (real Array /
 * array-like `$Object`) exactly like `Object.groupBy`; generic iterables
 * (Map/Set/user iterators) are the shared iterator-carrier follow-up (#2864)
 * and are gated OUT at the call site. Registered lazily (append-only) from the
 * call site. Returns the `__map_groupBy` funcIdx.
 */
export function ensureMapGroupBy(ctx: CodegenContext): number {
  ensureMapHelpers(ctx);
  const existing = ctx.mapHelpers.get("__map_groupBy");
  if (existing !== undefined) return existing;

  const { newIdx: objVecNewIdx, pushIdx: objVecPushIdx } = ensureObjVecBuilders(ctx);
  const applyClosureIdx = reserveApplyClosure(ctx);
  const mapNewIdx = ctx.mapHelpers.get("__map_new")!;
  const mapGetIdx = ctx.mapHelpers.get("__map_get")!;
  const mapSetIdx = ctx.mapHelpers.get("__map_set")!;
  const externLengthIdx = ctx.funcMap.get("__extern_length")!;
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx")!;
  const boxNumIdx = ctx.funcMap.get("__box_number")!;

  const mref: ValType = { kind: "ref", typeIdx: ctx.mapTypeIdx };
  const anyref: ValType = { kind: "anyref" };
  const externref: ValType = { kind: "externref" };
  const i32: ValType = { kind: "i32" };
  const f64: ValType = { kind: "f64" };

  // params: 0=items(externref) 1=callback(externref)
  // locals: 2=out(ref $Map) 3=len(f64) 4=i(i32) 5=val(externref)
  //         6=keyExt(externref) 7=keyAny(anyref) 8=groupAny(anyref)
  //         9=groupExt(externref) 10=args(externref)
  const body: Instr[] = [
    { op: "i32.const", value: COLLECTION_KIND.MAP }, // (#3171) groupBy returns a real Map
    { op: "call", funcIdx: mapNewIdx },
    { op: "local.set", index: 2 },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: externLengthIdx },
    { op: "local.set", index: 3 },
    { op: "i32.const", value: 0 },
    { op: "local.set", index: 4 },
    {
      op: "block",
      blockType: { kind: "empty" },
      body: [
        {
          op: "loop",
          blockType: { kind: "empty" },
          body: [
            // if f64(i) >= len → break
            { op: "local.get", index: 4 },
            { op: "f64.convert_i32_s" },
            { op: "local.get", index: 3 },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            // val = __extern_get_idx(items, f64(i))
            { op: "local.get", index: 0 },
            { op: "local.get", index: 4 },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: externGetIdxIdx },
            { op: "local.set", index: 5 },
            // args = __objvec_new(); push(val); push(box(i))
            { op: "call", funcIdx: objVecNewIdx },
            { op: "local.set", index: 10 },
            { op: "local.get", index: 10 },
            { op: "local.get", index: 5 },
            { op: "call", funcIdx: objVecPushIdx },
            { op: "local.get", index: 10 },
            { op: "local.get", index: 4 },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: boxNumIdx },
            { op: "call", funcIdx: objVecPushIdx },
            // keyExt = __apply_closure(callback, undefined, args)
            { op: "local.get", index: 1 },
            { op: "ref.null.extern" },
            { op: "local.get", index: 10 },
            { op: "call", funcIdx: applyClosureIdx },
            { op: "local.set", index: 6 },
            // keyAny = any.convert_extern(keyExt)  (Map key is an anyref value)
            { op: "local.get", index: 6 },
            { op: "any.convert_extern" },
            { op: "local.set", index: 7 },
            // groupAny = __map_get(out, keyAny)
            { op: "local.get", index: 2 },
            { op: "local.get", index: 7 },
            { op: "call", funcIdx: mapGetIdx },
            { op: "local.set", index: 8 },
            // if groupAny is null → group = __objvec_new(); __map_set(out, keyAny, any(group))
            // (#3331) under the singleton regime the __map_get MISS is the
            // $undefined singleton (a `$AnyValue` box) — a group slot is
            // always an objvec, so `ref.test $AnyValue` ⇔ miss. The extra
            // test is regime-gated away in legacy lanes (byte-identical).
            { op: "local.get", index: 8 },
            { op: "ref.is_null" },
            ...((undefinedSingletonActive(ctx) && ctx.anyValueTypeIdx >= 0
              ? [{ op: "local.get", index: 8 }, { op: "ref.test", typeIdx: ctx.anyValueTypeIdx }, { op: "i32.or" }]
              : []) satisfies Instr[]),
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "call", funcIdx: objVecNewIdx },
                { op: "local.set", index: 9 },
                { op: "local.get", index: 2 },
                { op: "local.get", index: 7 },
                { op: "local.get", index: 9 },
                { op: "any.convert_extern" },
                { op: "call", funcIdx: mapSetIdx },
                { op: "drop" }, // __map_set returns ref $Map
              ],
              else: [
                // groupExt = extern.convert_any(groupAny)
                { op: "local.get", index: 8 },
                { op: "extern.convert_any" },
                { op: "local.set", index: 9 },
              ],
            },
            // __objvec_push(group, val)
            { op: "local.get", index: 9 },
            { op: "local.get", index: 5 },
            { op: "call", funcIdx: objVecPushIdx },
            // i++
            { op: "local.get", index: 4 },
            { op: "i32.const", value: 1 },
            { op: "i32.add" },
            { op: "local.set", index: 4 },
            { op: "br", depth: 0 },
          ],
        },
      ],
    },
    { op: "local.get", index: 2 },
  ];

  return addMapFunc(
    ctx,
    "__map_groupBy",
    [externref, externref],
    [mref],
    [
      { name: "out", type: mref },
      { name: "len", type: f64 },
      { name: "i", type: i32 },
      { name: "val", type: externref },
      { name: "keyExt", type: externref },
      { name: "keyAny", type: anyref },
      { name: "groupAny", type: anyref },
      { name: "groupExt", type: externref },
      { name: "args", type: externref },
    ],
    body,
  );
}

/**
 * (#2162) Re-exported for the WeakMap/WeakSet runtime, which reuses the Map
 * backing store and needs the identical key/value → anyref boxing.
 */
export function coerceMapKeyToAnyref(ctx: CodegenContext, fctx: FunctionContext, t: ValType | null): void {
  coerceArgToAnyref(ctx, fctx, t);
}

function coerceArgToAnyref(ctx: CodegenContext, fctx: FunctionContext, t: ValType | null): void {
  if (t === null) {
    // Absent value (e.g. compileExpression produced nothing) — push a null
    // `none`-typed ref (subtype of anyref), matching the runtime's ABSENT.
    fctx.body.push({ op: "ref.null", typeIdx: NONE_HEAP });
    return;
  }
  // __box_number must already be registered (the call sites call
  // addUnionImports before dispatching — see the #1103a note in
  // tryCompileNativeMapMethodCall). Looking it up (vs ensureLateImport) avoids
  // adding an import mid-function-body, which would retrigger the #1677
  // native-string finalize-shift and corrupt __str_flatten.
  switch (t.kind) {
    case "f64": {
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        fctx.body.push({ op: "any.convert_extern" });
      }
      return;
    }
    case "i32": {
      // (#5267 A-2) A BRANDED symbol is a bare i32 id in standalone/WASI
      // (`ensureSymbolCarrier`, symbol-native.ts) — boxing it with
      // `__box_number` handed the collection the symbol's *numeric id*, so
      // `new WeakMap([[Symbol('a'), 42]])` stored the key `100` and the
      // patched `WeakMap.prototype.set` observed a number
      // (`iterable-with-symbol-keys.js` / `iterable-with-symbol-values.js`).
      // `__box_symbol` INTERNS by id, so two boxings of the same symbol stay
      // `ref.eq`-equal and two same-description symbols stay distinct.
      // Registered by the callers' addUnionImports/symbol lowering; a funcMap
      // lookup avoids a mid-body import shift (same note as the boolean arm).
      if (t.symbol === true) {
        // The brand is only set under the native provider (literals.ts:2619),
        // which is exactly where `ensureSymbolCarrier` is legal; it mints a
        // DEFINED function, so registering it here shifts no baked index.
        if (ctx.funcMap.get("__box_symbol") === undefined && usesNativeSymbolProvider(ctx)) ensureSymbolCarrier(ctx);
        const boxSymIdx = ctx.funcMap.get("__box_symbol");
        if (boxSymIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: boxSymIdx });
          fctx.body.push({ op: "any.convert_extern" });
          return;
        }
      }
      // (#2712 I2) A BRANDED boolean boxes via __box_boolean so the element/key
      // reifies as a boolean, not the number 1/0 — `new Set([(n<2)]).has(1)` must
      // be false and `.has(true)` true (SameValueZero on a boolean, not a number).
      // __box_boolean is registered alongside __box_number by the callers'
      // addUnionImports (same note as below), so a funcMap lookup avoids a
      // mid-body import shift; falls through to the number box if absent.
      if (t.boolean === true) {
        const boxBoolIdx = ctx.funcMap.get("__box_boolean");
        if (boxBoolIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: boxBoolIdx });
          fctx.body.push({ op: "any.convert_extern" });
          return;
        }
      }
      // small int → box as number.
      fctx.body.push({ op: "f64.convert_i32_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        fctx.body.push({ op: "any.convert_extern" });
      }
      return;
    }
    case "i64": {
      // (#3394) A collection key/value that is an i64 (a bigint element, or a
      // native `type i64 = number`) has no anyref supertype — leaving it raw
      // emits `call[N] expected anyref, found i64` on `__map_set`/`__set_add`/…
      // A BRANDED bigint boxes as a JS bigint via `__box_bigint` (mirrors the
      // type-coercion.ts:2001 i64→externref arm); a native i64 boxes as a
      // number. Both then `any.convert_extern` up to anyref. `__box_bigint` /
      // `__box_number` are registered by the callers' addUnionImports (same
      // note as the f64/i32 arms), so a funcMap lookup avoids a mid-body import
      // shift; falls through to the number box if `__box_bigint` is absent.
      if (t.bigint === true) {
        const boxBigIdx = ctx.funcMap.get("__box_bigint");
        if (boxBigIdx !== undefined) {
          fctx.body.push({ op: "call", funcIdx: boxBigIdx });
          fctx.body.push({ op: "any.convert_extern" });
          return;
        }
      }
      fctx.body.push({ op: "f64.convert_i64_s" });
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        fctx.body.push({ op: "any.convert_extern" });
      }
      return;
    }
    case "externref":
      fctx.body.push({ op: "any.convert_extern" });
      return;
    default:
      // GC struct refs (native strings, $Map, etc.) and anyref/eqref are
      // already anyref subtypes — no conversion needed.
      return;
  }
}

/**
 * (#2606 Bug A) Compile a `Set`/`Map` element/key/value argument to an anyref
 * for the native collection helpers, handling `null`/`undefined` literals.
 *
 * Root cause: `compileExpression(<null/undefined literal>)` reports ValType
 * `externref` but emits a **typed** `ref.null` instruction on the stack (a
 * concrete bottom, not a real externref). `coerceArgToAnyref`'s `externref` arm
 * then emits `any.convert_extern`, which fails validation — "any.convert_extern
 * expected type externref, found ref.null of type (ref null N)" — so
 * `s.add(null)` / `s.has(null)` / `s.has(undefined)` failed to compile
 * standalone (#2606).
 *
 * Fix: for a null/undefined-literal argument, skip `compileExpression` and emit
 * a canonical `ref.null NONE_HEAP` — the same `none`-bottom anyref-subtype the
 * runtime already stores for absent/`undefined` entries (lines 657/912/919/1120)
 * and for the absent-arg case above. A stored `none`-null is then `ref.eq`-equal
 * to a queried `none`-null, so SameValueZero null/undefined equality works once
 * the representation is uniform.
 */
/**
 * (#3395) Peel `as`/`satisfies`/parenthesized/`!` wrappers that never change a
 * value's runtime identity, so a null/undefined literal behind such a wrapper
 * (`null as any`, `(undefined)`) is still recognized as a null literal by the
 * collection element null-guard.
 */
function unwrapExprWrappers(expr: ts.Expression): ts.Expression {
  let e: ts.Expression = expr;
  while (
    ts.isAsExpression(e) ||
    ts.isParenthesizedExpression(e) ||
    ts.isNonNullExpression(e) ||
    ts.isSatisfiesExpression(e) ||
    ts.isTypeAssertionExpression(e)
  ) {
    e = e.expression;
  }
  return e;
}

export function compileCollectionElementArg(
  ctx: CodegenContext,
  fctx: FunctionContext,
  argExpr: ts.Expression | undefined,
): void {
  // (#3395) Unwrap `as`/parenthesized/`!` wrappers before the null-literal
  // check: a Weak-collection key written `s.has(null as any)` (or the raw
  // `s.has(null)` whose `null` reaches here through a cast) is an AsExpression,
  // not a bare NullKeyword, so the guard below missed it — `compileExpression`
  // then emitted a TYPED `ref.null $Struct` and `coerceArgToAnyref`'s externref
  // arm fed it to `any.convert_extern` ("expected externref, found ref.null of
  // type (ref null N)"), invalid Wasm. Unwrapping routes it to the canonical
  // `ref.null NONE_HEAP` path (identical runtime ABSENT/undefined semantics).
  const unwrapped = argExpr !== undefined ? unwrapExprWrappers(argExpr) : undefined;
  if (unwrapped !== undefined && isNullOrUndefinedLiteral(unwrapped)) {
    // Canonical anyref-subtype null matching the runtime's ABSENT/`undefined`
    // sentinel — bypasses the `compileExpression` typed-`ref.null` + externref
    // mismatch.
    // (#3331) Under the #2106 singleton regime an UNDEFINED literal stores
    // the $undefined singleton (distinct from null) so `m.get(k)` reads back
    // `undefined`, not `null`; a NULL literal keeps the canonical ref.null.
    // Legacy lanes conflate both to ref.null byte-identically.
    if (unwrapped.kind !== ts.SyntaxKind.NullKeyword && undefinedSingletonActive(ctx)) {
      if (ctx.undefinedGlobalIdx === undefined) ensureAnyValueType(ctx);
      if (ctx.undefinedGlobalIdx !== undefined) {
        fctx.body.push({ op: "global.get", index: ctx.undefinedGlobalIdx });
        return;
      }
    }
    fctx.body.push({ op: "ref.null", typeIdx: NONE_HEAP });
    return;
  }
  const t = argExpr !== undefined ? compileExpression(ctx, fctx, argExpr) : null;
  coerceArgToAnyref(ctx, fctx, t);
}

/**
 * (#1103a) Intercept a `Map.prototype.*` method call in standalone /
 * `nativeStrings` mode and route it to the WasmGC-native Map runtime
 * (`ensureMapHelpers`). Mirrors the RegExp pre-externClass interception in
 * `expressions/calls.ts`: returns the result `InnerResult` when handled, or
 * `undefined` to let the generic extern/host path proceed.
 *
 * Slice 1 covers `set` / `get` / `has` / `delete` / `clear` for number and
 * string keys/values. `forEach` / `for-of` and `new Map(iterable)` are slice 2
 * (need the `$MapIter` drive + `__map_new_from_arr`).
 *
 * Receiver and arguments are compiled here (the caller has not pushed them).
 */
export function tryCompileNativeMapMethodCall(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  const methodName = propAccess.name.text;

  // forEach drives a callback over the entries vector (24.1.3.5) — separate path.
  if (methodName === "forEach") {
    return tryCompileNativeCollectionForEach(ctx, fctx, propAccess, callExpr, /* isSet */ false);
  }

  // (#5267 B-1/B-2) keys()/values()/entries() yield a LIVE `$__IterRec` cursor
  // over the `$Map` (24.1.3.*). `entries()` was deferred by #2162 — it needed
  // the `[k, v]` pair packing that the MAPSET stepper now does (B-3), and while
  // it fell through here it reached the generic path, where `.next()` read
  // `undefined` (`Map/prototype/entries/returns-iterator.js`).
  if (methodName === "keys" || methodName === "values" || methodName === "entries") {
    return compileNativeCollectionIterator(ctx, fctx, propAccess, callExpr, methodName, /* isSet */ false);
  }

  const handled =
    methodName === "set" ||
    methodName === "get" ||
    methodName === "has" ||
    methodName === "delete" ||
    methodName === "clear";
  if (!handled) return undefined;

  ensureMapHelpers(ctx);
  const helperName = `__map_${methodName}`;
  const helperIdx = ctx.mapHelpers.get(helperName);
  if (helperIdx === undefined || ctx.mapTypeIdx < 0) return undefined;

  // Receiver → `ref $Map`. compileExpression yields the receiver's ValType;
  // it must be the native Map struct (recorded by the `new Map()` site / a
  // `Map`-typed binding). If it comes through as externref/anyref, cast it.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType === null) return undefined;
  if (recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== ctx.mapTypeIdx) {
    // Wrong struct — not our Map; bail so the generic path can try.
    return undefined;
  }

  const args = callExpr.arguments;
  switch (methodName) {
    case "get":
    case "has":
    case "delete": {
      // (#2606 Bug A) Route the key through compileCollectionElementArg so a
      // `null`/`undefined` literal key emits a canonical `ref.null NONE_HEAP`
      // (not a typed ref-null that fails the externref any.convert_extern).
      compileCollectionElementArg(ctx, fctx, args[0]);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // get → anyref value; has/delete → i32 (boolean).
      return methodName === "get" ? ({ kind: "anyref" } as ValType) : ({ kind: "i32" } as ValType);
    }
    case "set": {
      compileCollectionElementArg(ctx, fctx, args[0]);
      compileCollectionElementArg(ctx, fctx, args[1]);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // __map_set returns `ref $Map` (the map itself) — chainable.
      return { kind: "ref", typeIdx: ctx.mapTypeIdx } as ValType;
    }
    case "clear": {
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // __map_clear is void → undefined result.
      return VOID_RESULT;
    }
  }
  return undefined;
}

/**
 * (#1103a) Intercept the `Map.prototype.size` accessor in standalone /
 * `nativeStrings` mode → `__map_size` (returns i32). Receiver is compiled
 * here. Returns the result ValType when handled, else `undefined`.
 */
export function tryCompileNativeMapSizeGet(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  ensureMapHelpers(ctx);
  const sizeIdx = ctx.mapHelpers.get("__map_size");
  if (sizeIdx === undefined || ctx.mapTypeIdx < 0) return undefined;
  const recvType = compileExpression(ctx, fctx, receiver);
  if (recvType === null) return undefined;
  if (recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== ctx.mapTypeIdx) {
    return undefined;
  }
  fctx.body.push({ op: "call", funcIdx: sizeIdx });
  return { kind: "i32" } as ValType;
}

/** Resolve a function-valued local to the canonical Wasm closure wrapper.
 *
 * Function expressions assigned to a variable are represented as externref by
 * the general expression path. Native forEach still knows their TypeScript
 * call signature, so it can recover the wrapper type used by call_ref instead
 * of falling back to a host Map_forEach import. Inline callbacks and statically
 * known function identifiers continue through the existing ref path.
 */
function resolveDynamicCallbackClosure(
  ctx: CodegenContext,
  cbArg: ts.Expression,
): { closureInfo: ClosureInfo; selfStructTypeIdx: number } | undefined {
  const cbType = ctx.checker.getTypeAtLocation(cbArg);
  const sigs = cbType.getCallSignatures();
  if (sigs.length !== 1) return undefined;
  const sig = sigs[0]!;
  const paramTypes: ValType[] = [];
  for (const param of sig.parameters) {
    const loc = param.valueDeclaration ?? param.declarations?.[0] ?? cbArg;
    paramTypes.push(resolveWasmType(ctx, ctx.checker.getTypeOfSymbolAtLocation(param, loc)));
  }
  const returnType = ctx.checker.getReturnTypeOfSignature(sig);
  const results: ValType[] =
    isVoidType(returnType) || (returnType.flags & ts.TypeFlags.Never) !== 0
      ? []
      : [resolveWasmTypeForClosureReturn(ctx, returnType)];
  const wrapper = getOrCreateFuncRefWrapperTypes(ctx, paramTypes, results);
  if (!wrapper) return undefined;
  return {
    closureInfo: wrapper.closureInfo,
    selfStructTypeIdx: getClosureFuncSelfTypeIdx(ctx, wrapper.liftedFuncTypeIdx) ?? wrapper.structTypeIdx,
  };
}

/**
 * (#2162) Intercept `Map.prototype.forEach` / `Set.prototype.forEach` in
 * standalone / `nativeStrings` mode and drive the callback over the native
 * `$Map` backing store. Spec 24.1.3.5 / 24.2.3.6: invoke
 * `callbackfn(value, key, collection)` for every live entry in insertion order
 * (a Set passes the value as both `value` and `key`). The optional `thisArg`
 * is installed in `__current_this` around each callback invocation, matching
 * the array-method closure path.
 *
 * Reuses the entries-vector walk from `__map_iter_next` (index 0..entryCount,
 * skipping tombstones via `F_HASH & TOMBSTONE_BIT`) and the closure-call shape
 * from `array-methods.ts` (push coerced args, `call_ref` the closure funcref).
 * The callback must be a Wasm closure (arrow / function expr / named fn);
 * otherwise we bail so the generic path can try.
 *
 * `isSet` selects the key passed to the callback: for a Set, value === key.
 */
export function tryCompileNativeCollectionForEach(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  isSet: boolean,
  // (#3171) Reflective `X.prototype.forEach.call(recv, cb)` re-entry: receiver
  // and callback come from the `.call` argument list, and the receiver goes
  // through the shared brand-check preamble (catchable TypeError on a
  // wrong-brand receiver) instead of the static trapping cast.
  reflective?: { recvExpr: ts.Expression; cbArg: ts.Expression | undefined; brand: ReceiverBrandSpec },
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  if (propAccess.name.text !== "forEach") return undefined;
  ensureMapHelpers(ctx);
  if (ctx.mapTypeIdx < 0) return undefined;

  const cbArg = reflective !== undefined ? reflective.cbArg : callExpr.arguments[0];
  if (cbArg === undefined) return undefined;
  // Only handle Wasm-closure callbacks (arrow / function expr / named fn ref).
  const willBeClosure =
    ts.isArrowFunction(cbArg) ||
    ts.isFunctionExpression(cbArg) ||
    (ts.isIdentifier(cbArg) &&
      (ctx.funcMap.has(cbArg.text) ||
        ctx.closureMap.has(cbArg.text) ||
        (ctx.nativeStrings && ctx.checker.getTypeAtLocation(cbArg).getCallSignatures().length === 1)));
  if (!willBeClosure) {
    // (#3573) Spec 24.1.3.5 / 24.2.3.6: "If IsCallable(callbackfn) is false,
    // throw a TypeError". A statically non-callable LITERAL argument (`null` /
    // `undefined` / number / boolean / string) can never be a closure, so emit
    // the TypeError natively rather than fall through to the host
    // `Map_forEach`/`Set_forEach` import (a standalone host-leak → compile
    // error). A dynamic value (variable / call result) still routes to the
    // general path.
    const staticNonCallable =
      cbArg.kind === ts.SyntaxKind.NullKeyword ||
      cbArg.kind === ts.SyntaxKind.TrueKeyword ||
      cbArg.kind === ts.SyntaxKind.FalseKeyword ||
      ts.isNumericLiteral(cbArg) ||
      ts.isStringLiteral(cbArg) ||
      ts.isNoSubstitutionTemplateLiteral(cbArg) ||
      // A Symbol primitive is never callable. Keep this in the same
      // compile-time guard as the #3573 literal cases so standalone does not
      // fall through to the host Set_forEach/Map_forEach import. (#5091)
      ctx.oracle.staticJsTypeOf(cbArg) === "symbol" ||
      (ts.isIdentifier(cbArg) && cbArg.text === "undefined" && !fctx.localMap.has("undefined"));
    if (!staticNonCallable) return undefined;
    // Evaluate the receiver for its side effects first (this native path only
    // fires for a statically Set/Map receiver, so its [[SetData]]/[[MapData]]
    // brand check is already satisfied), then throw. The throw is terminal /
    // stack-polymorphic, so nothing is left on the value stack (VOID_RESULT).
    const recvExpr = reflective !== undefined ? reflective.recvExpr : propAccess.expression;
    compileExpression(ctx, fctx, recvExpr);
    fctx.body.push({ op: "drop" });
    emitThrowTypeError(ctx, fctx, `${isSet ? "Set" : "Map"}.prototype.forEach callback is not a function`);
    return VOID_RESULT;
  }

  // Map struct field layout (matches ensureMapHelpers' local constants).
  const M_ENTRIES = 1;
  const M_ENTRYCOUNT = 2;
  const F_KEY = 0;
  const F_VALUE = 1;
  const F_HASH = 3;
  const anyref: ValType = { kind: "anyref" };

  // Receiver → ref $Map, stored in a temp. Reflective callers brand-check
  // (catchable TypeError); the direct path keeps the static cast/bail.
  const recvType = compileExpression(ctx, fctx, reflective !== undefined ? reflective.recvExpr : propAccess.expression);
  if (reflective !== undefined) {
    emitReceiverBrandCheck(ctx, fctx, recvType, reflective.brand);
  } else {
    if (recvType === null) return undefined;
    if (recvType.kind === "externref") {
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
    } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
    } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== ctx.mapTypeIdx) {
      return undefined;
    }
  }
  const mTmp = allocLocal(fctx, `__mfe_m_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.mapTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: mTmp });

  // Compile the callback to a Wasm closure; resolve its ClosureInfo.
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  let closureTypeIdx: number | undefined;
  let closureInfo: ClosureInfo | undefined;
  let closureValue = cbResult;
  if (cbResult && (cbResult.kind === "ref" || cbResult.kind === "ref_null")) {
    closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
    closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  } else if (ctx.nativeStrings && cbResult?.kind === "externref") {
    const dynamic = resolveDynamicCallbackClosure(ctx, cbArg);
    if (dynamic) {
      closureInfo = dynamic.closureInfo;
      closureTypeIdx = dynamic.selfStructTypeIdx;
      fctx.body.push({ op: "any.convert_extern" });
      emitGuardedRefCast(fctx, dynamic.selfStructTypeIdx);
      fctx.body.push({ op: "ref.as_non_null" });
      closureValue = { kind: "ref", typeIdx: dynamic.selfStructTypeIdx };
    }
  }
  if (!closureInfo || closureTypeIdx === undefined || !closureValue) return undefined;
  const closureTmp = allocLocal(fctx, `__mfe_cb_${fctx.locals.length}`, closureValue);
  fctx.body.push({ op: "local.set", index: closureTmp });

  // Evaluate the optional thisArg after the callback, as required by call
  // argument order. Arrow callbacks keep lexical this, but their thisArg is
  // still evaluated for side effects.
  let thisArgTmp: number | undefined;
  let prevThisTmp: number | undefined;
  let currentThisGlobalIdx: number | undefined;
  const thisArgExpr = reflective === undefined ? callExpr.arguments[1] : undefined;
  if (thisArgExpr !== undefined) {
    const thisArgType = compileExpression(ctx, fctx, thisArgExpr);
    if (thisArgType && thisArgType.kind !== "externref") {
      fctx.body.push(...coercionInstrs(ctx, thisArgType, { kind: "externref" }, fctx));
    } else if (!thisArgType) {
      fctx.body.push({ op: "ref.null.extern" });
    }
    if (!ts.isArrowFunction(cbArg)) {
      currentThisGlobalIdx = ensureCurrentThisGlobal(ctx);
      thisArgTmp = allocLocal(fctx, `__mfe_this_${fctx.locals.length}`, { kind: "externref" });
      prevThisTmp = allocLocal(fctx, `__mfe_prevthis_${fctx.locals.length}`, { kind: "externref" });
      fctx.body.push({ op: "local.set", index: thisArgTmp });
    } else {
      fctx.body.push({ op: "drop" });
    }
  }

  const numParams = closureInfo.paramTypes.length;
  const iTmp = allocLocal(fctx, `__mfe_i_${fctx.locals.length}`, {
    kind: "i32",
  });
  const entryTmp = allocLocal(fctx, `__mfe_e_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.mapEntryTypeIdx,
  });

  // local funcref guard (same shape as array-methods guardedFuncRefCastInstrs).
  const guardFuncTmp = allocLocal(fctx, `__mfe_gfc_${fctx.locals.length}`, {
    kind: "funcref",
  } as ValType);
  const guardedFuncRefCast = (funcTypeIdx: number): Instr[] => [
    { op: "local.tee", index: guardFuncTmp },
    { op: "ref.test", typeIdx: funcTypeIdx },
    {
      op: "if",
      blockType: {
        kind: "val",
        type: { kind: "ref_null", typeIdx: funcTypeIdx } as ValType,
      },
      then: [
        { op: "local.get", index: guardFuncTmp },
        { op: "ref.cast_null", typeIdx: funcTypeIdx },
      ],
      else: [{ op: "ref.null", typeIdx: funcTypeIdx }],
    },
  ];

  // entry = m.entries[i]  (cast to $MapEntry, stored in entryTmp)
  const loadEntry: Instr[] = [
    { op: "local.get", index: mTmp },
    {
      op: "struct.get",
      typeIdx: ctx.mapTypeIdx,
      fieldIdx: M_ENTRIES,
    },
    { op: "local.get", index: iTmp },
    { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx },
    { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
    { op: "local.set", index: entryTmp },
  ];

  // callback(value, key, collection) — push only as many args as it declares.
  // The closure funcref's FIRST param is the closure env itself; push it before
  // the user args (mirrors array-methods.ts callClosure).
  const callClosure: Instr[] = [
    ...(thisArgTmp !== undefined && prevThisTmp !== undefined && currentThisGlobalIdx !== undefined
      ? ([
          { op: "global.get", index: currentThisGlobalIdx },
          { op: "local.set", index: prevThisTmp },
          { op: "local.get", index: thisArgTmp },
          { op: "global.set", index: currentThisGlobalIdx },
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: closureTmp },
    // entry.value / entry.key are stored as `anyref` (boxed numbers are
    // `__box_number` externrefs wrapped via any.convert_extern). Externalize to
    // externref first, then coerce to the param type — externref→f64 unboxes via
    // `__unbox_number`, externref→string casts to the native string, etc.
    ...(numParams >= 1
      ? ([
          { op: "local.get", index: entryTmp },
          {
            op: "struct.get",
            typeIdx: ctx.mapEntryTypeIdx,
            fieldIdx: F_VALUE,
          },
          { op: "extern.convert_any" },
          ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? anyref, fctx),
        ] satisfies Instr[])
      : []),
    ...(numParams >= 2
      ? ([
          // Map: key field; Set: value === key.
          { op: "local.get", index: entryTmp },
          {
            op: "struct.get",
            typeIdx: ctx.mapEntryTypeIdx,
            fieldIdx: isSet ? F_VALUE : F_KEY,
          },
          { op: "extern.convert_any" },
          ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[1] ?? anyref, fctx),
        ] satisfies Instr[])
      : []),
    ...(numParams >= 3
      ? ([
          { op: "local.get", index: mTmp },
          ...coercionInstrs(ctx, { kind: "ref", typeIdx: ctx.mapTypeIdx }, closureInfo.paramTypes[2] ?? anyref, fctx),
        ] satisfies Instr[])
      : []),
    { op: "local.get", index: closureTmp },
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 },
    ...guardedFuncRefCast(closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" },
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx },
    // forEach ignores the callback result; drop whatever it returned.
    ...((closureInfo.returnType === null ? [] : [{ op: "drop" }]) satisfies Instr[]),
    ...(thisArgTmp !== undefined && prevThisTmp !== undefined && currentThisGlobalIdx !== undefined
      ? ([
          { op: "local.get", index: prevThisTmp },
          { op: "global.set", index: currentThisGlobalIdx },
        ] satisfies Instr[])
      : []),
  ];

  // i = 0; loop { if i >= entryCount break; entry = entries[i]; i++;
  //               if (entry.hash & TOMBSTONE_BIT) continue; callback(...); }
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: iTmp });
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [
      {
        op: "loop",
        blockType: { kind: "empty" },
        body: [
          // if i >= entryCount → break
          { op: "local.get", index: iTmp },
          { op: "local.get", index: mTmp },
          {
            op: "struct.get",
            typeIdx: ctx.mapTypeIdx,
            fieldIdx: M_ENTRYCOUNT,
          },
          { op: "i32.ge_s" },
          { op: "br_if", depth: 1 },
          ...loadEntry,
          // i++
          { op: "local.get", index: iTmp },
          { op: "i32.const", value: 1 },
          { op: "i32.add" },
          { op: "local.set", index: iTmp },
          // tombstone? skip (continue the loop)
          { op: "local.get", index: entryTmp },
          {
            op: "struct.get",
            typeIdx: ctx.mapEntryTypeIdx,
            fieldIdx: F_HASH,
          },
          { op: "i32.const", value: TOMBSTONE_BIT },
          { op: "i32.and" },
          { op: "br_if", depth: 0 },
          ...callClosure,
          { op: "br", depth: 0 },
        ],
      },
    ],
  });

  return VOID_RESULT;
}

/**
 * (#2162) Compile `map.keys()` / `map.values()` / `map.entries()` (and the Set
 * equivalents) in standalone / `nativeStrings` mode by eagerly materializing a
 * canonical externref `$Vec` of the requested projection — mirroring the array
 * iterator pattern (`compileNativeArrayIterator`, array-methods.ts). The vec is
 * returned as a `ref $Vec`, so the for-of vec-struct fast path
 * (`compileForOfArrayTentative`) and array spread consume it directly with no
 * `__iterator` round-trip.
 *
 * Projection per `kind`:
 *   - "keys"    → each entry's KEY (for a Set, key === value)
 *   - "values"  → each entry's VALUE (for a Set, value === key)
 *   - "entries" → a 2-element `$ObjVec` `[key, value]` pair per entry, so a
 *     consumer's `pair[0]`/`pair[1]` and `[k, v]` destructuring read back
 *     through the native `__extern_get_idx`/`__extern_length` arm — exactly as
 *     the array `.entries()` path builds its pairs.
 *
 * The result array is sized to `liveCount` (the exact non-tombstone count, what
 * `size` returns), then filled by walking the entries vector with a separate
 * write cursor, skipping tombstones.
 *
 * Returns the vec `ValType` when handled, or `undefined` to let the generic
 * extern/host path proceed. The receiver (and no arguments) are compiled here.
 */
export function compileNativeCollectionIterator(
  ctx: CodegenContext,
  fctx: FunctionContext,
  propAccess: ts.PropertyAccessExpression,
  callExpr: ts.CallExpression,
  kind: "keys" | "values" | "entries",
  isSet: boolean,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  if (callExpr.arguments.length !== 0) return undefined;
  const live = emitLiveCollectionIterRec(ctx, fctx, propAccess.expression, kind, isSet);
  if (live !== undefined) return live;
  return emitCollectionIteratorVec(ctx, fctx, propAccess.expression, kind, isSet);
}

/**
 * (#5267 B-2) Emit a LIVE `$__IterRec{ITER_KIND_MAPSET}` cursor over a native
 * `$Map`/`$Set` for `keys()` / `values()` / `entries()` in EXPRESSION position.
 *
 * `emitCollectionIteratorVec` materializes an eager `$Vec` snapshot, which is
 * the right producer for the array-shaped consumers (`[...set]`,
 * `Array.from(map)`, the for-of head — `compileForOfNativeCollection` calls it
 * directly and is unaffected) but is NOT an iterator: `map.entries().next()`
 * read `undefined`, `map.keys()` did not observe a later `delete`, and
 * `set.entries()` was not routed at all. The record produced here is exactly
 * the one `fillMapSetDynDispatchArms` builds for `__iterator($Map)`, so every
 * downstream step (`__iterator_next`'s MAPSET twin, `__iter_next_result`, the
 * `__iterator` identity-adopt arm) already understands it, and the underlying
 * `__map_iter_next` index walk skips tombstones — so mutation during iteration
 * behaves per §24.1.5.1.
 *
 * Returns `undefined` (caller keeps the vec producer) when the iterator runtime
 * is unavailable or the receiver does not lower to the native `$Map` struct.
 */
function emitLiveCollectionIterRec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  kind: "keys" | "values" | "entries",
  isSet: boolean,
): InnerResult | undefined {
  ensureMapHelpers(ctx);
  if (ctx.mapTypeIdx < 0 || ctx.mapIterTypeIdx < 0) return undefined;
  ensureNativeIteratorRuntime(ctx);
  const iterRecTypeIdx = ctx.structMap.get("__IterRec");
  const iterNewIdx = ctx.mapHelpers.get("__map_iter_new");
  if (iterRecTypeIdx === undefined || iterNewIdx === undefined) return undefined;
  const vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });

  const recvType = compileExpression(ctx, fctx, receiver);
  if (recvType === null) return undefined;
  if (recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" });
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
  } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== ctx.mapTypeIdx) {
    // Not the native carrier — the receiver was already compiled, so the caller
    // cannot retry; drop it and let the vec producer recompile. (Speculative
    // rollback is the caller's job; here the shapes that reach us are always
    // Map/Set-typed, so this arm is a safety valve, not a hot path.)
    return undefined;
  }

  // `$MapIter` kinds: 0 = key, 1 = value, 2 = entry-pair. A Set stores
  // key === value, so `keys`/`values` both project the element.
  const iterKind = kind === "entries" ? 2 : isSet ? 1 : kind === "keys" ? 0 : 1;
  const mTmp = allocLocal(fctx, `__liveit_m_${fctx.locals.length}`, { kind: "ref", typeIdx: ctx.mapTypeIdx });
  fctx.body.push({ op: "local.set", index: mTmp });
  fctx.body.push(
    { op: "i32.const", value: ITER_KIND_MAPSET },
    { op: "ref.null", typeIdx: vecTypeIdx },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: mTmp },
    { op: "i32.const", value: iterKind },
    { op: "call", funcIdx: iterNewIdx },
    { op: "extern.convert_any" },
    { op: "struct.new", typeIdx: iterRecTypeIdx },
    { op: "extern.convert_any" },
  );
  return { kind: "externref" } as ValType;
}

/**
 * (#2162) Core of the collection-iterator materialization: given the *receiver*
 * expression (compiled here), emit a canonical externref `$Vec` of the `kind`
 * projection and return its `ValType`. Shared by the `keys/values/entries`
 * method dispatch and the bare `for (… of map/set)` path (which passes the
 * iterable expression directly). Returns `undefined` if the receiver does not
 * lower to the native `$Map` struct.
 */
export function emitCollectionIteratorVec(
  ctx: CodegenContext,
  fctx: FunctionContext,
  receiver: ts.Expression,
  kind: "keys" | "values" | "entries",
  isSet: boolean,
  // (#3171) Reflective `X.prototype.{keys,values,entries}.call(recv)` re-entry:
  // the receiver goes through the shared brand-check preamble (catchable
  // TypeError on a wrong-brand receiver) instead of the static cast/bail.
  brand?: ReceiverBrandSpec,
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  ensureMapHelpers(ctx);
  if (ctx.mapTypeIdx < 0) return undefined;

  // Map struct field layout (matches ensureMapHelpers' local constants).
  const M_ENTRIES = 1;
  const M_ENTRYCOUNT = 2;
  const M_LIVECOUNT = 3;
  const F_KEY = 0;
  const F_VALUE = 1;
  const F_HASH = 3;

  // Canonical externref vec (the producer contract shared with array iterators)
  // + the $ObjVec pair builders (only needed for `entries`). Register both
  // BEFORE compiling the receiver so no function-index shift happens mid-body.
  const canonVecTypeIdx = getOrRegisterVecType(ctx, "externref", {
    kind: "externref",
  });
  const canonArrTypeIdx = getArrTypeIdxFromVec(ctx, canonVecTypeIdx);
  let objVecNewIdx = 0;
  let objVecPushIdx = 0;
  if (kind === "entries") {
    const builders = ensureObjVecBuilders(ctx);
    objVecNewIdx = builders.newIdx;
    objVecPushIdx = builders.pushIdx;
  }

  // Receiver → ref $Map, stored in a temp. Reflective callers brand-check
  // (catchable TypeError); the direct path keeps the static cast/bail.
  const recvType = compileExpression(ctx, fctx, receiver);
  if (brand !== undefined) {
    emitReceiverBrandCheck(ctx, fctx, recvType, brand);
  } else {
    if (recvType === null) return undefined;
    if (recvType.kind === "externref") {
      fctx.body.push({ op: "any.convert_extern" });
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
    } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
      fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx });
    } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== ctx.mapTypeIdx) {
      return undefined;
    }
  }
  const mTmp = allocLocal(fctx, `__mit_m_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.mapTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: mTmp });

  // For a Set, keys() and values() both project the (single) element; entries()
  // yields `[v, v]`. Map keys()→key, values()→value, entries()→`[key, value]`.
  const slotField = isSet ? F_VALUE : kind === "keys" ? F_KEY : F_VALUE;

  // locals: out (canonical arr), idx (read cursor over entries), w (write cursor),
  // entry temp.
  const outTmp = allocLocal(fctx, `__mit_out_${fctx.locals.length}`, {
    kind: "ref_null",
    typeIdx: canonArrTypeIdx,
  });
  const idxTmp = allocLocal(fctx, `__mit_i_${fctx.locals.length}`, {
    kind: "i32",
  });
  const wTmp = allocLocal(fctx, `__mit_w_${fctx.locals.length}`, {
    kind: "i32",
  });
  const entryTmp = allocLocal(fctx, `__mit_e_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.mapEntryTypeIdx,
  });

  // out = new externref[liveCount]
  fctx.body.push({ op: "local.get", index: mTmp });
  fctx.body.push({
    op: "struct.get",
    typeIdx: ctx.mapTypeIdx,
    fieldIdx: M_LIVECOUNT,
  });
  fctx.body.push({
    op: "array.new_default",
    typeIdx: canonArrTypeIdx,
  });
  fctx.body.push({ op: "local.set", index: outTmp });
  // idx = 0; w = 0
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: idxTmp });
  fctx.body.push({ op: "i32.const", value: 0 });
  fctx.body.push({ op: "local.set", index: wTmp });

  // Externalize a $MapEntry field (F_KEY / F_VALUE) to externref for the slot.
  const slotFromEntry = (field: number): Instr[] => [
    { op: "local.get", index: entryTmp },
    {
      op: "struct.get",
      typeIdx: ctx.mapEntryTypeIdx,
      fieldIdx: field,
    },
    { op: "extern.convert_any" },
  ];

  // The per-slot value pushed into out[w]: a single externref, or an $ObjVec pair.
  const buildSlot: Instr[] =
    kind === "entries"
      ? (() => {
          const pairTmp = allocLocal(fctx, `__mit_pair_${fctx.locals.length}`, {
            kind: "externref",
          });
          return [
            { op: "call", funcIdx: objVecNewIdx },
            { op: "local.tee", index: pairTmp },
            // pair.push(key)  — for a Set, key === value
            ...slotFromEntry(isSet ? F_VALUE : F_KEY),
            { op: "call", funcIdx: objVecPushIdx },
            { op: "local.get", index: pairTmp },
            // pair.push(value)
            ...slotFromEntry(F_VALUE),
            { op: "call", funcIdx: objVecPushIdx },
            // the pair externref itself is the slot value
            { op: "local.get", index: pairTmp },
          ];
        })()
      : slotFromEntry(slotField);

  // loop { if idx >= entryCount break; entry = entries[idx]; idx++;
  //        if (entry.hash & TOMBSTONE_BIT) continue; out[w] = slot; w++; }
  const loopBody: Instr[] = [
    // if idx >= entryCount → break
    { op: "local.get", index: idxTmp },
    { op: "local.get", index: mTmp },
    {
      op: "struct.get",
      typeIdx: ctx.mapTypeIdx,
      fieldIdx: M_ENTRYCOUNT,
    },
    { op: "i32.ge_s" },
    { op: "br_if", depth: 1 },
    // entry = entries[idx]
    { op: "local.get", index: mTmp },
    {
      op: "struct.get",
      typeIdx: ctx.mapTypeIdx,
      fieldIdx: M_ENTRIES,
    },
    { op: "local.get", index: idxTmp },
    { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx },
    { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
    { op: "local.set", index: entryTmp },
    // idx++
    { op: "local.get", index: idxTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: idxTmp },
    // tombstone? skip
    { op: "local.get", index: entryTmp },
    {
      op: "struct.get",
      typeIdx: ctx.mapEntryTypeIdx,
      fieldIdx: F_HASH,
    },
    { op: "i32.const", value: TOMBSTONE_BIT },
    { op: "i32.and" },
    { op: "br_if", depth: 0 },
    // out[w] = slot
    { op: "local.get", index: outTmp },
    { op: "ref.as_non_null" },
    { op: "local.get", index: wTmp },
    ...buildSlot,
    { op: "array.set", typeIdx: canonArrTypeIdx },
    // w++
    { op: "local.get", index: wTmp },
    { op: "i32.const", value: 1 },
    { op: "i32.add" },
    { op: "local.set", index: wTmp },
    { op: "br", depth: 0 },
  ];
  fctx.body.push({
    op: "block",
    blockType: { kind: "empty" },
    body: [{ op: "loop", blockType: { kind: "empty" }, body: loopBody }],
  });

  // Result = { length: liveCount, data: out } canonical externref $Vec. Use the
  // write cursor `w` (== liveCount) as the length so the vec reflects exactly the
  // materialized slots.
  fctx.body.push({ op: "local.get", index: wTmp });
  fctx.body.push({ op: "local.get", index: outTmp });
  fctx.body.push({ op: "ref.as_non_null" });
  fctx.body.push({
    op: "struct.new",
    typeIdx: canonVecTypeIdx,
  });
  return { kind: "ref", typeIdx: canonVecTypeIdx } as ValType;
}

/**
 * NativeString data field index. The FlatString/NativeString struct stores its
 * i16 backing array as the LAST field. We look it up from the registered struct
 * def to avoid hard-coding a layout that may drift.
 */
function nativeStrDataFieldIdx(ctx: CodegenContext): number {
  const def = ctx.mod.types[ctx.nativeStrTypeIdx] as StructTypeDef | undefined;
  if (def && def.kind === "struct") {
    for (let i = def.fields.length - 1; i >= 0; i--) {
      const f = def.fields[i];
      if (f.type.kind === "ref" || f.type.kind === "ref_null") return i;
    }
  }
  // Fallback: NativeString is { len, off, data } → data at index 2 historically.
  return 2;
}

/**
 * Repair the `__hash_anyref` local declaration so the explicit local indices
 * (1=nv f64, 2=bits i64, 3=h i32, 4=i i32, 5=flat, 6=data, 7=len) line up with
 * the body. The body was authored with those indices; the `addMapFunc` call
 * passed locals in a different order, so re-set them here.
 */
function fixHashLocals(ctx: CodegenContext): void {
  const idx = ctx.mapHelpers.get("__hash_anyref");
  if (idx === undefined) return;
  const fn = definedFuncAt(ctx, idx) as { locals: { name: string; type: ValType }[] } | undefined;
  if (!fn) return;
  fn.locals = [
    { name: "nv", type: { kind: "f64" } }, // local 1
    { name: "bits", type: { kind: "i64" } }, // local 2
    { name: "h", type: { kind: "i32" } }, // local 3
    { name: "i", type: { kind: "i32" } }, // local 4
    { name: "flat", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } }, // local 5
    {
      name: "data",
      type: { kind: "ref_null", typeIdx: ctx.nativeStrDataTypeIdx },
    }, // local 6
    { name: "len", type: { kind: "i32" } }, // local 7
  ];
}

/**
 * Instructions to double the entries vector when full. Copies the old array
 * into a new one of twice the length and stores it back. Uses scratch locals
 * `newLocal` (ref $MapEntries) and `ecLocal` (i32, current entryCount, already
 * loaded by caller into the local).
 */
function growEntriesInstrs(
  ctx: CodegenContext,
  M_ENTRIES: number,
  _M_ENTRYCOUNT: number,
  newLocal: number,
  _ecLocal: number,
): Instr[] {
  return [
    // newEntries = array.new_default len*2
    { op: "local.get", index: 0 },
    {
      op: "struct.get",
      typeIdx: ctx.mapTypeIdx,
      fieldIdx: M_ENTRIES,
    },
    { op: "array.len" },
    { op: "i32.const", value: 2 },
    { op: "i32.mul" },
    {
      op: "array.new_default",
      typeIdx: ctx.mapEntriesTypeIdx,
    },
    { op: "local.tee", index: newLocal },
    // array.copy(newEntries, 0, oldEntries, 0, oldLen)
    { op: "i32.const", value: 0 },
    { op: "local.get", index: 0 },
    {
      op: "struct.get",
      typeIdx: ctx.mapTypeIdx,
      fieldIdx: M_ENTRIES,
    },
    { op: "i32.const", value: 0 },
    { op: "local.get", index: 0 },
    {
      op: "struct.get",
      typeIdx: ctx.mapTypeIdx,
      fieldIdx: M_ENTRIES,
    },
    { op: "array.len" },
    {
      op: "array.copy",
      dstTypeIdx: ctx.mapEntriesTypeIdx,
      srcTypeIdx: ctx.mapEntriesTypeIdx,
    },
    // map.entries = newEntries
    { op: "local.get", index: 0 },
    { op: "local.get", index: newLocal },
    {
      op: "struct.set",
      typeIdx: ctx.mapTypeIdx,
      fieldIdx: M_ENTRIES,
    },
  ];
}

/**
 * Rehash when liveCount*4 > buckets.len*3 (load factor > 0.75). Rebuilds the
 * bucket array at double capacity and re-links every non-tombstoned entry.
 * Emitted inline at the end of `__map_set`.
 *
 * For the #1103a foundation this is a straightforward rebuild loop. Scratch
 * locals reuse the `__map_set` frame slots (hash=4, bucket=5, entry=6,
 * newEntries=7, ec=8, cap=9).
 */
function rehashIfNeededInstrs(ctx: CodegenContext, M_BUCKETS: number, M_LIVECOUNT: number): Instr[] {
  const F_NEXT = 2;
  const F_HASH = 3;
  const M_ENTRIES = 1;
  const M_ENTRYCOUNT = 2;
  return [
    { op: "local.get", index: 0 },
    {
      op: "struct.get",
      typeIdx: ctx.mapTypeIdx,
      fieldIdx: M_LIVECOUNT,
    },
    { op: "i32.const", value: 4 },
    { op: "i32.mul" },
    { op: "local.get", index: 0 },
    {
      op: "struct.get",
      typeIdx: ctx.mapTypeIdx,
      fieldIdx: M_BUCKETS,
    },
    { op: "array.len" },
    { op: "i32.const", value: 3 },
    { op: "i32.mul" },
    { op: "i32.gt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // cap = buckets.len*2
        { op: "local.get", index: 0 },
        {
          op: "struct.get",
          typeIdx: ctx.mapTypeIdx,
          fieldIdx: M_BUCKETS,
        },
        { op: "array.len" },
        { op: "i32.const", value: 2 },
        { op: "i32.mul" },
        { op: "local.set", index: 9 },
        // map.buckets = new -1 array(cap)
        { op: "local.get", index: 0 },
        { op: "i32.const", value: -1 },
        { op: "local.get", index: 9 },
        { op: "array.new", typeIdx: ctx.mapBucketsTypeIdx },
        {
          op: "struct.set",
          typeIdx: ctx.mapTypeIdx,
          fieldIdx: M_BUCKETS,
        },
        // for i in 0..entryCount: relink non-tombstoned
        { op: "i32.const", value: 0 },
        { op: "local.set", index: 8 },
        {
          op: "block",
          blockType: { kind: "empty" },
          body: [
            {
              op: "loop",
              blockType: { kind: "empty" },
              body: [
                { op: "local.get", index: 8 },
                { op: "local.get", index: 0 },
                {
                  op: "struct.get",
                  typeIdx: ctx.mapTypeIdx,
                  fieldIdx: M_ENTRYCOUNT,
                },
                { op: "i32.ge_s" },
                { op: "br_if", depth: 1 },
                // entry = entries[i]
                { op: "local.get", index: 0 },
                {
                  op: "struct.get",
                  typeIdx: ctx.mapTypeIdx,
                  fieldIdx: M_ENTRIES,
                },
                { op: "local.get", index: 8 },
                {
                  op: "array.get",
                  typeIdx: ctx.mapEntriesTypeIdx,
                },
                { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx },
                { op: "local.set", index: 6 },
                // if !tombstone: bucket = (hash & TOMBSTONE? no) & (cap-1); relink
                { op: "local.get", index: 6 },
                {
                  op: "struct.get",
                  typeIdx: ctx.mapEntryTypeIdx,
                  fieldIdx: F_HASH,
                },
                { op: "i32.const", value: 0x40000000 },
                { op: "i32.and" },
                { op: "i32.eqz" },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // bucket = hash & (cap-1)
                    { op: "local.get", index: 6 },
                    {
                      op: "struct.get",
                      typeIdx: ctx.mapEntryTypeIdx,
                      fieldIdx: F_HASH,
                    },
                    { op: "local.get", index: 9 },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" },
                    { op: "i32.and" },
                    { op: "local.set", index: 5 },
                    // entry.next = buckets[bucket]
                    { op: "local.get", index: 6 },
                    { op: "local.get", index: 0 },
                    {
                      op: "struct.get",
                      typeIdx: ctx.mapTypeIdx,
                      fieldIdx: M_BUCKETS,
                    },
                    { op: "local.get", index: 5 },
                    {
                      op: "array.get",
                      typeIdx: ctx.mapBucketsTypeIdx,
                    },
                    {
                      op: "struct.set",
                      typeIdx: ctx.mapEntryTypeIdx,
                      fieldIdx: F_NEXT,
                    },
                    // buckets[bucket] = i
                    { op: "local.get", index: 0 },
                    {
                      op: "struct.get",
                      typeIdx: ctx.mapTypeIdx,
                      fieldIdx: M_BUCKETS,
                    },
                    { op: "local.get", index: 5 },
                    { op: "local.get", index: 8 },
                    {
                      op: "array.set",
                      typeIdx: ctx.mapBucketsTypeIdx,
                    },
                  ],
                  else: [],
                },
                { op: "local.get", index: 8 },
                { op: "i32.const", value: 1 },
                { op: "i32.add" },
                { op: "local.set", index: 8 },
                { op: "br", depth: 0 },
              ],
            },
          ],
        },
      ],
      else: [],
    },
  ];
}

/**
 * (#4629) Finalize fill: dynamic (any-channel) dispatch arms for native Map/Set
 * carriers, driven by what the test262 deepEqual harness consumes:
 *
 *  1. `__extern_get` — `$Map` receiver: string key `"size"` answers
 *     `__map_size` boxed; a `$Symbol` key whose id is the well-known
 *     `@@iterator` answers a callable closure singleton delegating to the
 *     native `__iterator` (so `typeof v[Symbol.iterator] === "function"`
 *     holds and a manual `f.call(v)` works).
 *  2. `__iterator` — `$Map` receiver arm: Map iterates entries (currently the
 *     value-projection `__map_iter_next` provides), Set iterates values,
 *     Weak* stay non-iterable; wrapped in an `$__IterRec` of kind
 *     {@link ITER_KIND_MAPSET} carrying the `$MapIter` in `userIter`.
 *  3. `__iterator_next` — the kind-{@link ITER_KIND_MAPSET} twin: drive
 *     `__map_iter_next` and hand back the `(i32 done, externref value)` pair.
 *  4. `__extern_method_call` — an `$__IterRec` receiver's `.next()` (the
 *     deepEqual manual-drive shape `it.next()`) packages the pair into a
 *     fresh `$Object {value, done}`; other names fall through to the
 *     ordinary dispatch (whose miss is undefined, so `if (b.return)` guards
 *     read undefined rather than trapping).
 *
 * Prepended at FINALIZE. The one minted closure body is a DEFINED function
 * (appending cannot shift baked indices, #608/#794); everything else only
 * reads already-registered helpers. Every instruction template is minted
 * FRESH per position (factory functions, never a spread-shared const array) —
 * the DCE type-remapper's aliased-object guard remaps a shared instruction
 * object once, which desynchronizes its typeIdx from unshared neighbors
 * (observed as `struct.get expected (ref null 76), found (ref 74)`). Must run
 * BEFORE `fillStandaloneTypeofClosureArms` so the minted closure's wrap type
 * is in the classifier roots when the typeof arms bake. No-op unless the
 * module built the native map runtime; js-host lanes never register
 * `__map_*`, so they stay byte-identical.
 */
// 9: kinds 1-7 are taken by iterator-native.ts (VEC=3, USER=1, OBJ=4,
// HOSTGEN=5, ASYNCGEN=6, GENSTATE=7 — colliding with 7 sent sync-generator
// recs into the $MapIter cast, the exact set-like regression this constant's
// first value caused); 8 is left spare for iterator-native's next arm.
export const ITER_KIND_MAPSET = 9;

export function fillMapSetDynDispatchArms(ctx: CodegenContext): void {
  if (ctx.mapTypeIdx < 0) return;
  const mapSizeIdx = ctx.mapHelpers.get("__map_size");
  const iterNewIdx = ctx.mapHelpers.get("__map_iter_new");
  const mapIterNextIdx = ctx.mapHelpers.get("__map_iter_next");
  if (mapSizeIdx === undefined || iterNewIdx === undefined || mapIterNextIdx === undefined) return;
  // Idempotence: both finalize paths may reach this fill in one compile —
  // splicing twice would double the arms. First caller wins.
  if (ctx.mapHelpers.has("__mapset_dyn_arms_filled")) return;
  ctx.mapHelpers.set("__mapset_dyn_arms_filled", 1);
  const mapIdx = ctx.mapTypeIdx;
  const mapIterIdx = ctx.mapIterTypeIdx;
  const iterResultIdx = ctx.mapIterResultTypeIdx;
  if (mapIterIdx < 0 || iterResultIdx < 0) return;

  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;

  /** `[…] -> i32` — key (param `keyParam`) is an `$AnyString` equal to `name`. */
  const keyEqualsStr = (name: string, keyParam: number): Instr[] | null => {
    if (strFlattenIdx === undefined || strEqualsIdx === undefined || anyStrTypeIdx < 0) return null;
    return [
      { op: "local.get", index: keyParam },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: anyStrTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: keyParam },
          { op: "any.convert_extern" },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          { op: "ref.as_non_null" },
          ...nativeStringLiteralInstrs(ctx, name),
          { op: "call", funcIdx: strEqualsIdx },
        ],
        else: [{ op: "i32.const", value: 0 }],
      },
    ];
  };

  const castMap = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "ref.cast", typeIdx: mapIdx },
  ];

  // ── (2) __iterator: $Map arm ─────────────────────────────────────────────
  const iterIdx = ctx.funcMap.get("__iterator");
  const iterFn = iterIdx === undefined ? undefined : definedFuncAt(ctx, iterIdx);
  const iterNextIdx = ctx.funcMap.get("__iterator_next");
  const iterNextFn = iterNextIdx === undefined ? undefined : definedFuncAt(ctx, iterNextIdx);
  const iterRecTypeIdx = ctx.structMap.get("__IterRec");
  if (iterFn && iterRecTypeIdx !== undefined) {
    const vecTypeIdx = getOrRegisterVecType(ctx, "externref", { kind: "externref" });
    iterFn.body.splice(
      0,
      0,
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: mapIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // Weak collections (kind >= 2) are NOT iterable — keep the ladder.
          ...castMap(),
          { op: "struct.get", typeIdx: mapIdx, fieldIdx: MAP_LAYOUT.M_KIND },
          { op: "i32.const", value: 2 },
          { op: "i32.lt_s" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "i32.const", value: ITER_KIND_MAPSET },
              { op: "ref.null", typeIdx: vecTypeIdx },
              { op: "i32.const", value: 0 },
              // userIter = __map_iter_new(m, m.kind === SET ? 1 (values) : 2 (entries))
              ...castMap(),
              ...castMap(),
              { op: "struct.get", typeIdx: mapIdx, fieldIdx: MAP_LAYOUT.M_KIND },
              { op: "i32.const", value: 1 },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "val", type: { kind: "i32" } },
                then: [{ op: "i32.const", value: 1 }],
                else: [{ op: "i32.const", value: 2 }],
              },
              { op: "call", funcIdx: iterNewIdx },
              { op: "extern.convert_any" },
              { op: "struct.new", typeIdx: iterRecTypeIdx },
              { op: "extern.convert_any" },
              { op: "return" },
            ],
          },
        ],
      },
    );
  }

  // ── (3) __iterator_next: MAPSET twin ─────────────────────────────────────
  if (iterNextFn && iterRecTypeIdx !== undefined) {
    const mrLocal = 1 + iterNextFn.locals.length;
    iterNextFn.locals.push({ name: "__mapset_mr", type: { kind: "ref_null", typeIdx: iterResultIdx } });
    const castRec = (): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: iterRecTypeIdx },
    ];
    /**
     * (#5267 B-3) Fresh instrs (#2169b) for the projected value:
     *   done      → the canonical `undefined` (a bare `ref.null.extern`
     *               surfaces as JS **null**, so `result.value === undefined`
     *               was false on the exhausted step);
     *   otherwise → the value `__map_iter_next` produced. The `entries`
     *               (kind 2) `[key, value]` pair is packed INSIDE
     *               `__map_iter_next` (#5131, `ensureMapHelpers` above), so
     *               this arm must pass it through untouched — packing again
     *               here yielded the doubly-nested `[key, [key, value]]`.
     */
    const mapsetValueInstrs = (): Instr[] => [
      { op: "local.get", index: mrLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: iterResultIdx, fieldIdx: 1 }, // done
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [...canonicalUndefinedExternInstrs(ctx)],
        else: [
          { op: "local.get", index: mrLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: iterResultIdx, fieldIdx: 0 }, // value
          { op: "extern.convert_any" },
        ],
      },
    ];
    iterNextFn.body.splice(
      0,
      0,
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: iterRecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...castRec(),
          { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 0 }, // kind
          { op: "i32.const", value: ITER_KIND_MAPSET },
          { op: "i32.eq" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              ...castRec(),
              { op: "struct.get", typeIdx: iterRecTypeIdx, fieldIdx: 3 }, // userIter externref
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: mapIterIdx },
              { op: "call", funcIdx: mapIterNextIdx },
              { op: "local.set", index: mrLocal },
              { op: "local.get", index: mrLocal },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: iterResultIdx, fieldIdx: 1 }, // done i32
              ...mapsetValueInstrs(),
              { op: "return" },
            ],
          },
        ],
      },
    );
  }

  // ── (1) __extern_get: $Map "size" + @@iterator arms ──────────────────────
  const externGetIdx = ctx.funcMap.get("__extern_get");
  const externGetFn = externGetIdx === undefined ? undefined : definedFuncAt(ctx, externGetIdx);
  const boxNumIdx = ctx.funcMap.get("__box_number");
  if (externGetFn && boxNumIdx !== undefined) {
    const sizeTest = keyEqualsStr("size", 1);
    const arms: Instr[] = [];
    if (sizeTest) {
      arms.push(...sizeTest, {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...castMap(),
          { op: "call", funcIdx: mapSizeIdx },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: boxNumIdx },
          { op: "return" },
        ],
      });
    }
    // @@iterator symbol key → the callable closure singleton (only when the
    // module minted the $Symbol carrier AND the native __iterator exists).
    const wkIterId = getWellKnownSymbolId("iterator");
    if (ctx.symbolTypeIdx >= 0 && iterIdx !== undefined && wkIterId !== undefined) {
      const closureGlobalIdx = ensureMapSetIteratorClosureSingleton(ctx, iterIdx);
      if (closureGlobalIdx !== undefined) {
        arms.push(
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: ctx.symbolTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: ctx.symbolTypeIdx },
              { op: "struct.get", typeIdx: ctx.symbolTypeIdx, fieldIdx: 0 }, // id
              { op: "i32.const", value: wkIterId },
              { op: "i32.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "global.get", index: closureGlobalIdx }, { op: "extern.convert_any" }, { op: "return" }],
              },
            ],
          },
        );
      }
    }
    if (arms.length > 0) {
      externGetFn.body.splice(
        0,
        0,
        { op: "local.get", index: 0 },
        { op: "any.convert_extern" },
        { op: "ref.test", typeIdx: mapIdx },
        { op: "if", blockType: { kind: "empty" }, then: arms },
      );
    }
  }

  // ── (4) __extern_method_call: `$__IterRec`.next() ────────────────────────
  const methodCallIdx = ctx.funcMap.get("__extern_method_call");
  const methodCallFn = methodCallIdx === undefined ? undefined : definedFuncAt(ctx, methodCallIdx);
  const objCreateIdx = ctx.funcMap.get("__object_create");
  const definePropIdx = ctx.funcMap.get("__defineProperty_value");
  const boxBoolIdx = ctx.funcMap.get("__box_boolean");
  const nextTest = keyEqualsStr("next", 1);
  if (
    methodCallFn &&
    iterRecTypeIdx !== undefined &&
    iterNextIdx !== undefined &&
    objCreateIdx !== undefined &&
    definePropIdx !== undefined &&
    boxBoolIdx !== undefined &&
    nextTest
  ) {
    const base = 3 + methodCallFn.locals.length;
    methodCallFn.locals.push(
      { name: "__mapset_done", type: { kind: "i32" } },
      { name: "__mapset_val", type: { kind: "externref" } },
      { name: "__mapset_obj", type: { kind: "externref" } },
    );
    const dLocal = base;
    const vLocal = base + 1;
    const oLocal = base + 2;
    methodCallFn.body.splice(
      0,
      0,
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: iterRecTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...nextTest,
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "call", funcIdx: iterNextIdx }, // (i32 done, externref value)
              { op: "local.set", index: vLocal },
              { op: "local.set", index: dLocal },
              { op: "ref.null.extern" },
              { op: "call", funcIdx: objCreateIdx },
              { op: "local.set", index: oLocal },
              { op: "local.get", index: oLocal },
              ...nativeStringLiteralInstrs(ctx, "value"),
              { op: "extern.convert_any" },
              { op: "local.get", index: vLocal },
              { op: "f64.const", value: FLAG_DEFAULT },
              { op: "call", funcIdx: definePropIdx },
              { op: "drop" },
              { op: "local.get", index: oLocal },
              ...nativeStringLiteralInstrs(ctx, "done"),
              { op: "extern.convert_any" },
              { op: "local.get", index: dLocal },
              { op: "call", funcIdx: boxBoolIdx },
              { op: "f64.const", value: FLAG_DEFAULT },
              { op: "call", funcIdx: definePropIdx },
              { op: "drop" },
              { op: "local.get", index: oLocal },
              { op: "return" },
            ],
          },
        ],
      },
    );
  }
}

/**
 * (#4629) Mint (once) the `[Symbol.iterator]` closure singleton for Map/Set
 * receivers: a no-capture `__fn_wrap` whose lifted body is
 * `(self, this) -> __iterator(this)`. Held in an immutable module global so
 * repeated reads are identity-stable. Returns the global index.
 */
function ensureMapSetIteratorClosureSingleton(ctx: CodegenContext, iterIdx: number): number | undefined {
  const existing = ctx.mapHelpers.get("__mapset_iterfn_global");
  if (existing !== undefined) return existing;
  const wrap = getOrCreateFuncRefWrapperTypes(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
  if (!wrap) return undefined;
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__mapset_symbol_iterator",
    typeIdx: wrap.liftedFuncTypeIdx,
    locals: [],
    body: [
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: iterIdx },
    ],
    exported: false,
  });
  const globalIdx = ctx.numImportGlobals + ctx.mod.globals.length;
  ctx.mod.globals.push({
    name: "__mapset_iterfn",
    type: { kind: "ref", typeIdx: wrap.structTypeIdx },
    mutable: false,
    // Wrap layout: {func funcref, $arity i32, $bag externref} (closure-header-layout).
    init: [
      { op: "ref.func", funcIdx },
      { op: "i32.const", value: 0 }, // $arity: the @@iterator method takes 0 user args
      { op: "ref.null.extern" }, // $bag
      { op: "struct.new", typeIdx: wrap.structTypeIdx },
    ],
  });
  ctx.mapHelpers.set("__mapset_iterfn_global", globalIdx);
  return globalIdx;
}
