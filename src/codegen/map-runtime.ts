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
import type { Instr, StructTypeDef, ArrayTypeDef, ValType } from "../ir/types.js";
import type { CodegenContext, FunctionContext } from "./context/types.js";
import { allocLocal } from "./context/locals.js";
import { addFuncType } from "./registry/types.js";
import type { InnerResult } from "./shared.js";
import { compileArrowAsClosure, compileExpression, VOID_RESULT } from "./shared.js";
import { coercionInstrs } from "./type-coercion.js";

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
      { name: "buckets", type: { kind: "ref", typeIdx: ctx.mapBucketsTypeIdx }, mutable: true },
      { name: "entries", type: { kind: "ref", typeIdx: ctx.mapEntriesTypeIdx }, mutable: true },
      { name: "entryCount", type: { kind: "i32" }, mutable: true },
      { name: "liveCount", type: { kind: "i32" }, mutable: true },
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
      { name: "map", type: { kind: "ref", typeIdx: ctx.mapTypeIdx }, mutable: false },
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
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mapHelpers.set(name, funcIdx);
  ctx.mod.functions.push({ name, typeIdx, locals, body, exported: false });
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
  const entryRefNull: ValType = { kind: "ref_null", typeIdx: ctx.mapEntryTypeIdx };
  const entriesRef: ValType = { kind: "ref", typeIdx: ctx.mapEntriesTypeIdx };
  const bucketsRef: ValType = { kind: "ref", typeIdx: ctx.mapBucketsTypeIdx };
  const mref = mapRef(ctx);
  const iterRef: ValType = { kind: "ref", typeIdx: ctx.mapIterTypeIdx };
  const iterResultRef: ValType = { kind: "ref", typeIdx: ctx.mapIterResultTypeIdx };

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
    // 1) Reference identity (covers i31 small ints/bools, null, same object).
    body.push({ op: "local.get", index: 0 });
    body.push({ op: "ref.test", typeIdx: EQ_HEAP });
    body.push({ op: "local.get", index: 1 });
    body.push({ op: "ref.test", typeIdx: EQ_HEAP });
    body.push({ op: "i32.and" } as Instr);
    body.push({
      op: "if",
      blockType: { kind: "val", type: i32 },
      then: [
        { op: "local.get", index: 0 },
        { op: "ref.cast", typeIdx: EQ_HEAP } as Instr,
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: EQ_HEAP } as Instr,
        { op: "ref.eq" } as Instr,
        {
          op: "if",
          blockType: { kind: "val", type: i32 },
          then: [{ op: "i32.const", value: 1 }, { op: "return" }],
          else: [],
        } as Instr,
      ],
      else: [],
    } as Instr);
    // 2) Both numbers → unbox + f64 compare (NaN===NaN, +0===-0 per SVZ).
    if (unbox !== undefined && typeofNum !== undefined) {
      body.push({ op: "local.get", index: 0 });
      body.push({ op: "extern.convert_any" } as Instr);
      body.push({ op: "call", funcIdx: typeofNum } as Instr);
      body.push({ op: "local.get", index: 1 });
      body.push({ op: "extern.convert_any" } as Instr);
      body.push({ op: "call", funcIdx: typeofNum } as Instr);
      body.push({ op: "i32.and" } as Instr);
      body.push({
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [
          // a == b OR (both NaN). f64.eq handles +0/-0 equal. NaN handled by
          // the (a!==a && b!==b) branch.
          { op: "local.get", index: 0 },
          { op: "extern.convert_any" } as Instr,
          { op: "call", funcIdx: unbox } as Instr,
          { op: "local.tee", index: 2 },
          { op: "local.get", index: 1 },
          { op: "extern.convert_any" } as Instr,
          { op: "call", funcIdx: unbox } as Instr,
          { op: "local.tee", index: 3 },
          { op: "f64.eq" } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: i32 },
            then: [{ op: "i32.const", value: 1 }, { op: "return" }],
            else: [
              // NaN===NaN: a!==a && b!==b
              { op: "local.get", index: 2 },
              { op: "local.get", index: 2 },
              { op: "f64.ne" } as Instr,
              { op: "local.get", index: 3 },
              { op: "local.get", index: 3 },
              { op: "f64.ne" } as Instr,
              { op: "i32.and" } as Instr,
              { op: "return" },
            ],
          } as Instr,
        ],
        else: [],
      } as Instr);
    }
    // 3) Both strings → content equality.
    if (strEq !== undefined && typeofStr !== undefined && ctx.anyStrTypeIdx >= 0) {
      const anyStrRef: ValType = { kind: "ref", typeIdx: ctx.anyStrTypeIdx };
      body.push({ op: "local.get", index: 0 });
      body.push({ op: "extern.convert_any" } as Instr);
      body.push({ op: "call", funcIdx: typeofStr } as Instr);
      body.push({ op: "local.get", index: 1 });
      body.push({ op: "extern.convert_any" } as Instr);
      body.push({ op: "call", funcIdx: typeofStr } as Instr);
      body.push({ op: "i32.and" } as Instr);
      body.push({
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [
          { op: "local.get", index: 0 },
          { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
          { op: "call", funcIdx: strEq } as Instr,
          { op: "return" },
        ],
        else: [],
      } as Instr);
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
      body.push({ op: "extern.convert_any" } as Instr);
      body.push({ op: "call", funcIdx: typeofNum } as Instr);
      body.push({
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [
          { op: "local.get", index: 0 },
          { op: "extern.convert_any" } as Instr,
          { op: "call", funcIdx: unbox } as Instr,
          { op: "local.tee", index: 1 },
          // normalize -0 to +0 so they hash equal
          { op: "f64.const", value: 0 },
          { op: "f64.add" } as Instr,
          { op: "i64.reinterpret_f64" } as Instr,
          { op: "local.tee", index: 2 },
          { op: "i64.const", value: 32n } as unknown as Instr,
          { op: "i64.shr_u" } as Instr,
          { op: "local.get", index: 2 },
          { op: "i64.xor" } as Instr,
          { op: "i32.wrap_i64" } as Instr,
          { op: "i32.const", value: 0x3fffffff },
          { op: "i32.and" } as Instr,
          { op: "return" },
        ],
        else: [],
      } as Instr);
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
        body.push({ op: "extern.convert_any" } as Instr);
        body.push({ op: "call", funcIdx: typeofStr } as Instr);
        body.push({
          op: "if",
          blockType: { kind: "val", type: i32 },
          then: [
            { op: "local.get", index: 0 },
            { op: "ref.cast", typeIdx: ctx.anyStrTypeIdx } as Instr,
            { op: "call", funcIdx: flatten } as Instr,
            { op: "ref.cast", typeIdx: strTypeIdx } as Instr,
            { op: "local.tee", index: 5 },
            // data array (field 3 of NativeString: len,byteLen?,off,data — use struct.get by name index)
            // NativeString layout: { len(i32), ..., data }. We read length via array.len of data.
            { op: "struct.get", typeIdx: strTypeIdx, fieldIdx: nativeStrDataFieldIdx(ctx) } as unknown as Instr,
            { op: "local.tee", index: 6 },
            { op: "array.len" } as Instr,
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
                    { op: "i32.ge_s" } as Instr,
                    { op: "br_if", depth: 1 },
                    // h ^= cu
                    { op: "local.get", index: 3 },
                    { op: "local.get", index: 6 },
                    { op: "local.get", index: 4 },
                    { op: "array.get_u", typeIdx: dataTypeIdx } as unknown as Instr,
                    { op: "i32.xor" } as Instr,
                    // h *= 16777619
                    { op: "i32.const", value: 16777619 },
                    { op: "i32.mul" } as Instr,
                    { op: "local.set", index: 3 },
                    { op: "local.get", index: 4 },
                    { op: "i32.const", value: 1 },
                    { op: "i32.add" } as Instr,
                    { op: "local.set", index: 4 },
                    { op: "br", depth: 0 },
                  ],
                } as Instr,
              ],
            } as Instr,
            { op: "local.get", index: 3 },
            { op: "i32.const", value: 0x3fffffff },
            { op: "i32.and" } as Instr,
            { op: "return" },
          ],
          else: [],
        } as Instr);
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
        { name: "flat", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } },
        { name: "data", type: { kind: "ref_null", typeIdx: ctx.nativeStrDataTypeIdx } },
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

  // ── __map_new() -> ref $Map ─────────────────────────────────────────────
  {
    const body: Instr[] = [
      // buckets: array.new i32 of length INIT_CAP, all -1
      { op: "i32.const", value: -1 },
      { op: "i32.const", value: INIT_CAP },
      { op: "array.new", typeIdx: ctx.mapBucketsTypeIdx } as unknown as Instr,
      // entries: array.new_default ref null $MapEntry, length INIT_CAP
      { op: "i32.const", value: INIT_CAP },
      { op: "array.new_default", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
      // entryCount=0, liveCount=0
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "struct.new", typeIdx: ctx.mapTypeIdx },
    ];
    addMapFunc(ctx, "__map_new", [], [mref], [], body);
  }

  const hashIdx = ctx.mapHelpers.get("__hash_anyref")!;
  const svzIdx = ctx.mapHelpers.get("__same_value_zero")!;

  // ── __map_lookup_idx(m, key) -> i32 (entry index or -1) ─────────────────
  {
    // params: m(0), key(1). locals: hash(2), bucket(3), cur(4), entry(5)
    const body: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: hashIdx } as Instr,
      { op: "local.tee", index: 2 },
      // bucket = hash & (cap-1)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_BUCKETS } as unknown as Instr,
      { op: "array.len" } as Instr,
      { op: "i32.const", value: 1 },
      { op: "i32.sub" } as Instr,
      { op: "i32.and" } as Instr,
      { op: "local.set", index: 3 },
      // cur = buckets[bucket]
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_BUCKETS } as unknown as Instr,
      { op: "local.get", index: 3 },
      { op: "array.get", typeIdx: ctx.mapBucketsTypeIdx } as unknown as Instr,
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
              { op: "i32.lt_s" } as Instr,
              { op: "br_if", depth: 1 }, // cur<0 → miss
              // entry = entries[cur]
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
              { op: "local.get", index: 4 },
              { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
              { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx } as Instr,
              { op: "local.set", index: 5 },
              // if !tombstone && hash matches && SVZ(key, entry.key) → return cur
              { op: "local.get", index: 5 },
              { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_HASH } as unknown as Instr,
              { op: "i32.const", value: TOMBSTONE_BIT },
              { op: "i32.and" } as Instr,
              { op: "i32.eqz" } as Instr,
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 1 },
                  { op: "local.get", index: 5 },
                  { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_KEY } as unknown as Instr,
                  { op: "call", funcIdx: svzIdx } as Instr,
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "local.get", index: 4 }, { op: "return" }],
                    else: [],
                  } as Instr,
                ],
                else: [],
              } as Instr,
              // cur = entry.next
              { op: "local.get", index: 5 },
              { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_NEXT } as unknown as Instr,
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          } as Instr,
        ],
      } as Instr,
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
    // idx(2)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: lookupIdx } as Instr,
      { op: "local.tee", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: anyref },
        then: [{ op: "ref.null", typeIdx: NONE_HEAP }], // undefined → null
        else: [
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
          { op: "local.get", index: 2 },
          { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
          { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx } as Instr,
          { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_VALUE } as unknown as Instr,
        ],
      } as Instr,
    ];
    addMapFunc(ctx, "__map_get", [mref, anyref], [anyref], [{ name: "idx", type: i32 }], body);
  }

  // ── __map_has(m, key) -> i32 ────────────────────────────────────────────
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: lookupIdx } as Instr,
      { op: "i32.const", value: -1 },
      { op: "i32.ne" } as Instr,
    ];
    addMapFunc(ctx, "__map_has", [mref, anyref], [i32], [], body);
  }

  // ── __map_size(m) -> i32 ────────────────────────────────────────────────
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_LIVECOUNT } as unknown as Instr,
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
      { op: "call", funcIdx: lookupIdx } as Instr,
      { op: "local.tee", index: 3 },
      { op: "i32.const", value: 0 },
      { op: "i32.ge_s" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // entries[idx].value = value; return m
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
          { op: "local.get", index: 3 },
          { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
          { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx } as Instr,
          { op: "local.get", index: 2 },
          { op: "struct.set", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_VALUE } as unknown as Instr,
          { op: "local.get", index: 0 },
          { op: "return" },
        ],
        else: [],
      } as Instr,
      // grow entries vector if full (entryCount == entries.len)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRYCOUNT } as unknown as Instr,
      { op: "local.tee", index: 8 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
      { op: "array.len" } as Instr,
      { op: "i32.ge_s" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: growEntriesInstrs(ctx, M_ENTRIES, M_ENTRYCOUNT, 7, 8),
        else: [],
      } as Instr,
      // hash + bucket
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: hashIdx } as Instr,
      { op: "local.tee", index: 4 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_BUCKETS } as unknown as Instr,
      { op: "array.len" } as Instr,
      { op: "i32.const", value: 1 },
      { op: "i32.sub" } as Instr,
      { op: "i32.and" } as Instr,
      { op: "local.set", index: 5 },
      // entry = struct.new(key,value,buckets[bucket],hash)
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_BUCKETS } as unknown as Instr,
      { op: "local.get", index: 5 },
      { op: "array.get", typeIdx: ctx.mapBucketsTypeIdx } as unknown as Instr,
      { op: "local.get", index: 4 },
      { op: "struct.new", typeIdx: ctx.mapEntryTypeIdx },
      { op: "local.set", index: 6 },
      // entries[entryCount] = entry
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
      { op: "local.get", index: 8 },
      { op: "local.get", index: 6 },
      { op: "array.set", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
      // buckets[bucket] = entryCount
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_BUCKETS } as unknown as Instr,
      { op: "local.get", index: 5 },
      { op: "local.get", index: 8 },
      { op: "array.set", typeIdx: ctx.mapBucketsTypeIdx } as unknown as Instr,
      // entryCount++ ; liveCount++
      { op: "local.get", index: 0 },
      { op: "local.get", index: 8 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" } as Instr,
      { op: "struct.set", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRYCOUNT } as unknown as Instr,
      { op: "local.get", index: 0 },
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_LIVECOUNT } as unknown as Instr,
      { op: "i32.const", value: 1 },
      { op: "i32.add" } as Instr,
      { op: "struct.set", typeIdx: ctx.mapTypeIdx, fieldIdx: M_LIVECOUNT } as unknown as Instr,
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
      { op: "call", funcIdx: lookupIdx } as Instr,
      { op: "local.tee", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: i32 },
        then: [{ op: "i32.const", value: 0 }],
        else: [
          // entry = entries[idx]
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
          { op: "local.get", index: 2 },
          { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
          { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx } as Instr,
          { op: "local.tee", index: 3 },
          // hash |= TOMBSTONE_BIT
          { op: "local.get", index: 3 },
          { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_HASH } as unknown as Instr,
          { op: "i32.const", value: TOMBSTONE_BIT },
          { op: "i32.or" } as Instr,
          { op: "struct.set", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_HASH } as unknown as Instr,
          // key=null, value=null
          { op: "local.get", index: 3 },
          { op: "ref.null", typeIdx: NONE_HEAP },
          { op: "struct.set", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_KEY } as unknown as Instr,
          { op: "local.get", index: 3 },
          { op: "ref.null", typeIdx: NONE_HEAP },
          { op: "struct.set", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_VALUE } as unknown as Instr,
          // liveCount--
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 },
          { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_LIVECOUNT } as unknown as Instr,
          { op: "i32.const", value: 1 },
          { op: "i32.sub" } as Instr,
          { op: "struct.set", typeIdx: ctx.mapTypeIdx, fieldIdx: M_LIVECOUNT } as unknown as Instr,
          { op: "i32.const", value: 1 },
        ],
      } as Instr,
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
      { op: "array.new", typeIdx: ctx.mapBucketsTypeIdx } as unknown as Instr,
      { op: "struct.set", typeIdx: ctx.mapTypeIdx, fieldIdx: M_BUCKETS } as unknown as Instr,
      // entries = new default array INIT_CAP
      { op: "local.get", index: 0 },
      { op: "i32.const", value: INIT_CAP },
      { op: "array.new_default", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
      { op: "struct.set", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
      // entryCount=0, liveCount=0
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "struct.set", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRYCOUNT } as unknown as Instr,
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "struct.set", typeIdx: ctx.mapTypeIdx, fieldIdx: M_LIVECOUNT } as unknown as Instr,
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
  // {value, done} result. For entry-kind iteration, returns the value field
  // (key/value handled by callers; entries() packing deferred — returns value).
  {
    // locals: m(1), idx(2), entries(3), entry(4)
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: ctx.mapIterTypeIdx, fieldIdx: IT_MAP } as unknown as Instr,
      { op: "local.tee", index: 1 },
      { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
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
              { op: "struct.get", typeIdx: ctx.mapIterTypeIdx, fieldIdx: IT_INDEX } as unknown as Instr,
              { op: "local.tee", index: 2 },
              { op: "local.get", index: 1 },
              { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRYCOUNT } as unknown as Instr,
              { op: "i32.ge_s" } as Instr,
              { op: "br_if", depth: 1 }, // done
              // entry = entries[idx]
              { op: "local.get", index: 3 },
              { op: "local.get", index: 2 },
              { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
              { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx } as Instr,
              { op: "local.tee", index: 4 },
              // index++
              { op: "local.get", index: 0 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" } as Instr,
              { op: "struct.set", typeIdx: ctx.mapIterTypeIdx, fieldIdx: IT_INDEX } as unknown as Instr,
              // tombstone? skip
              { op: "local.get", index: 4 },
              { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_HASH } as unknown as Instr,
              { op: "i32.const", value: TOMBSTONE_BIT },
              { op: "i32.and" } as Instr,
              { op: "br_if", depth: 0 },
              // result: kind 0=key,1=value (entries→value for now)
              { op: "local.get", index: 0 },
              { op: "struct.get", typeIdx: ctx.mapIterTypeIdx, fieldIdx: IT_KIND } as unknown as Instr,
              { op: "i32.eqz" } as Instr,
              {
                op: "if",
                blockType: { kind: "val", type: anyref },
                then: [
                  { op: "local.get", index: 4 },
                  { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_KEY } as unknown as Instr,
                ],
                else: [
                  { op: "local.get", index: 4 },
                  { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_VALUE } as unknown as Instr,
                ],
              } as Instr,
              { op: "i32.const", value: 0 },
              { op: "struct.new", typeIdx: ctx.mapIterResultTypeIdx },
              { op: "return" },
            ],
          } as Instr,
        ],
      } as Instr,
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
      ],
      body,
    );
  }
}

/**
 * (#1103a) Coerce a freshly-compiled Map key/value argument to `anyref` — the
 * uniform slot type the runtime stores. Numbers arrive as `f64` and are boxed
 * via `__box_number` (the contract `__same_value_zero` / `__hash_anyref`
 * assume); native strings and other GC refs are already anyref subtypes;
 * externrefs externalize via `any.convert_extern`.
 */
/**
 * (#2162) Re-exported for the Set runtime, which reuses the Map backing store
 * and needs the identical key/value → anyref boxing for its element arg.
 */
export function coerceSetArgToAnyref(ctx: CodegenContext, fctx: FunctionContext, t: ValType | null): void {
  coerceArgToAnyref(ctx, fctx, t);
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
        fctx.body.push({ op: "any.convert_extern" } as Instr);
      }
      return;
    }
    case "i32": {
      // boolean / small int → box as number for now (slice 1 number/string).
      fctx.body.push({ op: "f64.convert_i32_s" } as Instr);
      const boxIdx = ctx.funcMap.get("__box_number");
      if (boxIdx !== undefined) {
        fctx.body.push({ op: "call", funcIdx: boxIdx });
        fctx.body.push({ op: "any.convert_extern" } as Instr);
      }
      return;
    }
    case "externref":
      fctx.body.push({ op: "any.convert_extern" } as Instr);
      return;
    default:
      // GC struct refs (native strings, $Map, etc.) and anyref/eqref are
      // already anyref subtypes — no conversion needed.
      return;
  }
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
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx } as Instr);
  } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx } as Instr);
  } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== ctx.mapTypeIdx) {
    // Wrong struct — not our Map; bail so the generic path can try.
    return undefined;
  }

  const args = callExpr.arguments;
  switch (methodName) {
    case "get":
    case "has":
    case "delete": {
      const kt = args.length > 0 ? compileExpression(ctx, fctx, args[0]!) : null;
      coerceArgToAnyref(ctx, fctx, kt);
      fctx.body.push({ op: "call", funcIdx: helperIdx });
      // get → anyref value; has/delete → i32 (boolean).
      return methodName === "get" ? ({ kind: "anyref" } as ValType) : ({ kind: "i32" } as ValType);
    }
    case "set": {
      const kt = args.length > 0 ? compileExpression(ctx, fctx, args[0]!) : null;
      coerceArgToAnyref(ctx, fctx, kt);
      const vt = args.length > 1 ? compileExpression(ctx, fctx, args[1]!) : null;
      coerceArgToAnyref(ctx, fctx, vt);
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
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx } as Instr);
  } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx } as Instr);
  } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== ctx.mapTypeIdx) {
    return undefined;
  }
  fctx.body.push({ op: "call", funcIdx: sizeIdx });
  return { kind: "i32" } as ValType;
}

/**
 * (#2162) Intercept `Map.prototype.forEach` / `Set.prototype.forEach` in
 * standalone / `nativeStrings` mode and drive the callback over the native
 * `$Map` backing store. Spec 24.1.3.5 / 24.2.3.6: invoke
 * `callbackfn(value, key, collection)` for every live entry in insertion order
 * (a Set passes the value as both `value` and `key`). The `thisArg` 2nd
 * argument is accepted but, like the array-method native callbacks, only honored
 * when the callback closes over `this` itself — out of scope for this slice.
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
): InnerResult | undefined {
  if (!ctx.nativeStrings) return undefined;
  if (propAccess.name.text !== "forEach") return undefined;
  ensureMapHelpers(ctx);
  if (ctx.mapTypeIdx < 0) return undefined;

  const cbArg = callExpr.arguments[0];
  if (cbArg === undefined) return undefined;
  // Only handle Wasm-closure callbacks (arrow / function expr / named fn ref).
  const willBeClosure =
    ts.isArrowFunction(cbArg) ||
    ts.isFunctionExpression(cbArg) ||
    (ts.isIdentifier(cbArg) && (ctx.funcMap.has(cbArg.text) || ctx.closureMap.has(cbArg.text)));
  if (!willBeClosure) return undefined;

  // Map struct field layout (matches ensureMapHelpers' local constants).
  const M_ENTRIES = 1;
  const M_ENTRYCOUNT = 2;
  const F_KEY = 0;
  const F_VALUE = 1;
  const F_HASH = 3;
  const anyref: ValType = { kind: "anyref" };

  // Receiver → ref $Map, stored in a temp.
  const recvType = compileExpression(ctx, fctx, propAccess.expression);
  if (recvType === null) return undefined;
  if (recvType.kind === "externref") {
    fctx.body.push({ op: "any.convert_extern" } as Instr);
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx } as Instr);
  } else if (recvType.kind === "anyref" || recvType.kind === "eqref") {
    fctx.body.push({ op: "ref.cast", typeIdx: ctx.mapTypeIdx } as Instr);
  } else if ((recvType.kind === "ref" || recvType.kind === "ref_null") && recvType.typeIdx !== ctx.mapTypeIdx) {
    return undefined;
  }
  const mTmp = allocLocal(fctx, `__mfe_m_${fctx.locals.length}`, { kind: "ref", typeIdx: ctx.mapTypeIdx });
  fctx.body.push({ op: "local.set", index: mTmp });

  // Compile the callback to a Wasm closure; resolve its ClosureInfo.
  const cbResult =
    ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg)
      ? compileArrowAsClosure(ctx, fctx, cbArg)
      : compileExpression(ctx, fctx, cbArg);
  if (!cbResult || (cbResult.kind !== "ref" && cbResult.kind !== "ref_null")) return undefined;
  const closureTypeIdx = (cbResult as { typeIdx: number }).typeIdx;
  const closureInfo = ctx.closureInfoByTypeIdx.get(closureTypeIdx);
  if (!closureInfo) return undefined;
  const closureTmp = allocLocal(fctx, `__mfe_cb_${fctx.locals.length}`, cbResult);
  fctx.body.push({ op: "local.set", index: closureTmp });

  const numParams = closureInfo.paramTypes.length;
  const iTmp = allocLocal(fctx, `__mfe_i_${fctx.locals.length}`, { kind: "i32" });
  const entryTmp = allocLocal(fctx, `__mfe_e_${fctx.locals.length}`, {
    kind: "ref",
    typeIdx: ctx.mapEntryTypeIdx,
  });

  // local funcref guard (same shape as array-methods guardedFuncRefCastInstrs).
  const guardFuncTmp = allocLocal(fctx, `__mfe_gfc_${fctx.locals.length}`, { kind: "funcref" } as ValType);
  const guardedFuncRefCast = (funcTypeIdx: number): Instr[] => [
    { op: "local.tee", index: guardFuncTmp },
    { op: "ref.test", typeIdx: funcTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: { kind: "ref_null", typeIdx: funcTypeIdx } as ValType },
      then: [
        { op: "local.get", index: guardFuncTmp },
        { op: "ref.cast_null", typeIdx: funcTypeIdx },
      ],
      else: [{ op: "ref.null", typeIdx: funcTypeIdx }],
    } as Instr,
  ];

  // entry = m.entries[i]  (cast to $MapEntry, stored in entryTmp)
  const loadEntry: Instr[] = [
    { op: "local.get", index: mTmp } as Instr,
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
    { op: "local.get", index: iTmp } as Instr,
    { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
    { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx } as Instr,
    { op: "local.set", index: entryTmp } as Instr,
  ];

  // callback(value, key, collection) — push only as many args as it declares.
  // The closure funcref's FIRST param is the closure env itself; push it before
  // the user args (mirrors array-methods.ts callClosure).
  const callClosure: Instr[] = [
    { op: "local.get", index: closureTmp } as Instr,
    // entry.value / entry.key are stored as `anyref` (boxed numbers are
    // `__box_number` externrefs wrapped via any.convert_extern). Externalize to
    // externref first, then coerce to the param type — externref→f64 unboxes via
    // `__unbox_number`, externref→string casts to the native string, etc.
    ...(numParams >= 1
      ? [
          { op: "local.get", index: entryTmp } as Instr,
          { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_VALUE } as unknown as Instr,
          { op: "extern.convert_any" } as Instr,
          ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[0] ?? anyref, fctx),
        ]
      : []),
    ...(numParams >= 2
      ? [
          // Map: key field; Set: value === key.
          { op: "local.get", index: entryTmp } as Instr,
          { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: isSet ? F_VALUE : F_KEY } as unknown as Instr,
          { op: "extern.convert_any" } as Instr,
          ...coercionInstrs(ctx, { kind: "externref" }, closureInfo.paramTypes[1] ?? anyref, fctx),
        ]
      : []),
    ...(numParams >= 3
      ? [
          { op: "local.get", index: mTmp } as Instr,
          ...coercionInstrs(ctx, { kind: "ref", typeIdx: ctx.mapTypeIdx }, closureInfo.paramTypes[2] ?? anyref, fctx),
        ]
      : []),
    { op: "local.get", index: closureTmp } as Instr,
    { op: "struct.get", typeIdx: closureTypeIdx, fieldIdx: 0 } as Instr,
    ...guardedFuncRefCast(closureInfo.funcTypeIdx),
    { op: "ref.as_non_null" } as Instr,
    { op: "call_ref", typeIdx: closureInfo.funcTypeIdx } as Instr,
    // forEach ignores the callback result; drop whatever it returned.
    ...(closureInfo.returnType === null ? [] : [{ op: "drop" } as Instr]),
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
          { op: "local.get", index: iTmp } as Instr,
          { op: "local.get", index: mTmp } as Instr,
          { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRYCOUNT } as unknown as Instr,
          { op: "i32.ge_s" } as Instr,
          { op: "br_if", depth: 1 } as Instr,
          ...loadEntry,
          // i++
          { op: "local.get", index: iTmp } as Instr,
          { op: "i32.const", value: 1 } as Instr,
          { op: "i32.add" } as Instr,
          { op: "local.set", index: iTmp } as Instr,
          // tombstone? skip (continue the loop)
          { op: "local.get", index: entryTmp } as Instr,
          { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_HASH } as unknown as Instr,
          { op: "i32.const", value: TOMBSTONE_BIT } as Instr,
          { op: "i32.and" } as Instr,
          { op: "br_if", depth: 0 } as Instr,
          ...callClosure,
          { op: "br", depth: 0 } as Instr,
        ],
      } as Instr,
    ],
  } as Instr);

  return VOID_RESULT;
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
  const fnPos = idx - ctx.numImportFuncs;
  const fn = ctx.mod.functions[fnPos] as { locals: { name: string; type: ValType }[] } | undefined;
  if (!fn) return;
  fn.locals = [
    { name: "nv", type: { kind: "f64" } }, // local 1
    { name: "bits", type: { kind: "i64" } }, // local 2
    { name: "h", type: { kind: "i32" } }, // local 3
    { name: "i", type: { kind: "i32" } }, // local 4
    { name: "flat", type: { kind: "ref_null", typeIdx: ctx.nativeStrTypeIdx } }, // local 5
    { name: "data", type: { kind: "ref_null", typeIdx: ctx.nativeStrDataTypeIdx } }, // local 6
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
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
    { op: "array.len" } as Instr,
    { op: "i32.const", value: 2 },
    { op: "i32.mul" } as Instr,
    { op: "array.new_default", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
    { op: "local.tee", index: newLocal },
    // array.copy(newEntries, 0, oldEntries, 0, oldLen)
    { op: "i32.const", value: 0 },
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
    { op: "i32.const", value: 0 },
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
    { op: "array.len" } as Instr,
    { op: "array.copy", dstTypeIdx: ctx.mapEntriesTypeIdx, srcTypeIdx: ctx.mapEntriesTypeIdx },
    // map.entries = newEntries
    { op: "local.get", index: 0 },
    { op: "local.get", index: newLocal },
    { op: "struct.set", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
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
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_LIVECOUNT } as unknown as Instr,
    { op: "i32.const", value: 4 },
    { op: "i32.mul" } as Instr,
    { op: "local.get", index: 0 },
    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_BUCKETS } as unknown as Instr,
    { op: "array.len" } as Instr,
    { op: "i32.const", value: 3 },
    { op: "i32.mul" } as Instr,
    { op: "i32.gt_s" } as Instr,
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // cap = buckets.len*2
        { op: "local.get", index: 0 },
        { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_BUCKETS } as unknown as Instr,
        { op: "array.len" } as Instr,
        { op: "i32.const", value: 2 },
        { op: "i32.mul" } as Instr,
        { op: "local.set", index: 9 },
        // map.buckets = new -1 array(cap)
        { op: "local.get", index: 0 },
        { op: "i32.const", value: -1 },
        { op: "local.get", index: 9 },
        { op: "array.new", typeIdx: ctx.mapBucketsTypeIdx } as unknown as Instr,
        { op: "struct.set", typeIdx: ctx.mapTypeIdx, fieldIdx: M_BUCKETS } as unknown as Instr,
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
                { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRYCOUNT } as unknown as Instr,
                { op: "i32.ge_s" } as Instr,
                { op: "br_if", depth: 1 },
                // entry = entries[i]
                { op: "local.get", index: 0 },
                { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_ENTRIES } as unknown as Instr,
                { op: "local.get", index: 8 },
                { op: "array.get", typeIdx: ctx.mapEntriesTypeIdx } as unknown as Instr,
                { op: "ref.cast", typeIdx: ctx.mapEntryTypeIdx } as Instr,
                { op: "local.set", index: 6 },
                // if !tombstone: bucket = (hash & TOMBSTONE? no) & (cap-1); relink
                { op: "local.get", index: 6 },
                { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_HASH } as unknown as Instr,
                { op: "i32.const", value: 0x40000000 },
                { op: "i32.and" } as Instr,
                { op: "i32.eqz" } as Instr,
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [
                    // bucket = hash & (cap-1)
                    { op: "local.get", index: 6 },
                    { op: "struct.get", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_HASH } as unknown as Instr,
                    { op: "local.get", index: 9 },
                    { op: "i32.const", value: 1 },
                    { op: "i32.sub" } as Instr,
                    { op: "i32.and" } as Instr,
                    { op: "local.set", index: 5 },
                    // entry.next = buckets[bucket]
                    { op: "local.get", index: 6 },
                    { op: "local.get", index: 0 },
                    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_BUCKETS } as unknown as Instr,
                    { op: "local.get", index: 5 },
                    { op: "array.get", typeIdx: ctx.mapBucketsTypeIdx } as unknown as Instr,
                    { op: "struct.set", typeIdx: ctx.mapEntryTypeIdx, fieldIdx: F_NEXT } as unknown as Instr,
                    // buckets[bucket] = i
                    { op: "local.get", index: 0 },
                    { op: "struct.get", typeIdx: ctx.mapTypeIdx, fieldIdx: M_BUCKETS } as unknown as Instr,
                    { op: "local.get", index: 5 },
                    { op: "local.get", index: 8 },
                    { op: "array.set", typeIdx: ctx.mapBucketsTypeIdx } as unknown as Instr,
                  ],
                  else: [],
                } as Instr,
                { op: "local.get", index: 8 },
                { op: "i32.const", value: 1 },
                { op: "i32.add" } as Instr,
                { op: "local.set", index: 8 },
                { op: "br", depth: 0 },
              ],
            } as Instr,
          ],
        } as Instr,
      ],
      else: [],
    } as Instr,
  ];
}
