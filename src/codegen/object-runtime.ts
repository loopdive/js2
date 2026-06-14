// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1472 Phase B — Wasm-native open-object runtime for `--target standalone`.
 *
 * Open objects (plain object literals, `any`-typed property access) are the
 * single largest standalone-mode failure cluster (26,880 primary rows). In
 * JS-host mode they route through a family of `env::__extern_*` /
 * `env::__object_*` host imports backed by JS WeakMap sidecars; in standalone
 * there is no JS runtime to satisfy those imports. Phase A refuses such code at
 * compile time. Phase B (this module) replaces the sidecars with a pure-WasmGC
 * open-hash-map so dynamic object semantics work with zero host calls.
 *
 * ## Representation
 *
 * ```
 * (type $PropEntry (struct
 *   (field $key   (ref $AnyString))            ;; immutable property key
 *   (field $value (mut anyref))                ;; property value (boxed)
 *   (field $flags (mut i32))))                 ;; writable/enumerable/configurable/tombstone
 *
 * (type $PropMap (array (mut (ref null $PropEntry))))   ;; open-addressing table
 *
 * (type $Object (struct
 *   (field $proto      (mut (ref null $Object)))
 *   (field $props      (mut (ref $PropMap)))
 *   (field $count      (mut i32))              ;; live entries (excl. tombstones)
 *   (field $tombstones (mut i32))              ;; dead entries pending rehash
 *   (field $flags      (mut i32))))            ;; extensible/frozen/sealed bits
 * ```
 *
 * ## Integration strategy (why no per-call-site retargeting)
 *
 * The existing JS-host call sites treat objects as `externref` and look the
 * helper up by name via `ensureLateImport(ctx, "__extern_get", …)` then emit a
 * plain `call funcIdx`. To avoid touching every call site (and the index-shift
 * machinery they rely on), the native helpers registered here keep the **exact
 * same name and externref-based signature** as the host imports:
 *
 *   - `__new_plain_object()                          -> externref`
 *   - `__extern_get(externref obj, externref key)    -> externref`
 *   - `__extern_set(externref obj, externref key, externref value) -> void`
 *
 * Internally a `$Object` struct is wrapped to externref via `extern.convert_any`
 * (a no-op at the engine level, same trick `__box_number` uses) and unwrapped
 * via `any.convert_extern` + `ref.cast $Object`. So `ensureLateImport` can route
 * these names here under `ctx.standalone` exactly like the #1471 boxing helpers
 * (`UNION_NATIVE_HELPER_NAMES`), and the call sites are byte-for-byte unchanged.
 *
 * Keys arrive as `externref` holding a `$NativeString` (standalone auto-enables
 * nativeStrings, so a string literal key is `extern.convert_any(ref
 * $NativeString)`). We `ref.cast $AnyString` + `__str_flatten` to a
 * `$NativeString` for hashing and reuse the existing `__str_equals` for
 * comparison.
 *
 * Closed-shape struct access (the `getFieldEntry` fast path) never reaches this
 * runtime — it emits `struct.get`/`struct.set` directly and never calls
 * `ensureLateImport` for these names.
 */
import type { Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import {
  ensureAnyToStringHelper,
  ensureNativeStringHelpers,
  nativeStringLiteralInstrs,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType } from "./registry/types.js";
import { addUnionImportsViaRegistry, flushLateImportShifts } from "./shared.js";
import { reserveAccessorGetDriver, reserveAccessorSetDriver } from "./accessor-driver.js";

/** Initial `$PropMap` capacity. Must be a power of two (mask = cap - 1). */
const INITIAL_CAP = 8;

/** WasmGC `none` bottom heap type (signed-LEB 0x6e = -18). `ref.null none` is a
 *  subtype of `anyref`, used to push a null into the `$PropEntry.$get/$set`
 *  anyref slots on the data path (#1888 Slice 5). */
const NONE_HEAP = -18;

/** `$PropEntry.$flags` bit layout. */
const FLAG_WRITABLE = 0x01;
const FLAG_ENUMERABLE = 0x02;
const FLAG_CONFIGURABLE = 0x04;
// #1888 Slice 5 — accessor descriptor: when set, the entry's value is replaced
// by the `$get`/`$set` funcref-bearing slots (fields 4/5). 0x08 is the first
// free bit (0x10/0x20/0x40 remain free; 0x80 = TOMBSTONE).
const FLAG_ACCESSOR = 0x08;
const FLAG_TOMBSTONE = 0x80;
/** Default for a data property created by `o.x = v` — w/e/c all true. */
const FLAG_DEFAULT = FLAG_WRITABLE | FLAG_ENUMERABLE | FLAG_CONFIGURABLE;

/**
 * `$Object.flags` (field 4) object-level integrity bits (#1472 Phase B Blocker
 * A Half 1, landed via PR #1074). Read by the
 * __object_isFrozen/isSealed/isExtensible helpers; set by the freeze/seal SET
 * path (Half 2, not yet landed). On a never-frozen object the field is 0, so
 * isFrozen/isSealed read false and isExtensible reads true.
 */
const OBJ_FLAG_NONEXTENSIBLE = 0x01;
const OBJ_FLAG_SEALED = 0x02;
const OBJ_FLAG_FROZEN = 0x04;

/**
 * Type indices for the open-object runtime structs/arrays, allocated once per
 * module by `ensureObjectRuntime`. Stored on the context so subsequent slices
 * (keys/values/delete/for-in) can reference the same types.
 */
export interface ObjectRuntimeTypes {
  propEntryTypeIdx: number;
  propMapTypeIdx: number;
  objectTypeIdx: number;
  /** `$ObjVec` struct {len: i32, data: (ref (array (mut externref)))} — the
   *  growable externref vector that backs standalone `Object.keys/values/entries`
   *  enumeration results (#1472 Phase B Blocker B). */
  objVecTypeIdx: number;
  /** Backing `(array (mut externref))` for `$ObjVec.data`. */
  objVecArrTypeIdx: number;
}

/**
 * Idempotently register the open-object runtime types + helper functions as
 * defined Wasm functions in `ctx.funcMap` (under the host-import names the call
 * sites already look up). Safe to call repeatedly; only the first call emits.
 *
 * MUST run after `ensureNativeStringHelpers` (it depends on `__str_flatten` /
 * `__str_equals` and the `$NativeString` type indices) — we call it here to
 * guarantee that. Because this path adds only DEFINED functions (no imports),
 * the freshly-allocated func indices sit above every existing function and no
 * index shift is required (same invariant as `addUnionImportsAsNativeFuncs`).
 *
 * That invariant only holds when NO late-import batch is pending: a deferred
 * `ensureLateImport` shift (ctx.pendingLateImportShift) would later add its
 * delta to every funcIdx >= its importsBefore — including the indices this
 * function is about to bake with the post-batch `numImportFuncs` — leaving
 * funcMap and every internal sibling call one regime too high while the
 * function itself sits lower (#2039: `__obj_find` calling `__new_plain_object`
 * instead of `__obj_hash`, 146 invalid-Wasm test262 binaries). So we end any
 * pending batch first; registration then happens in a clean, final regime.
 */
export function ensureObjectRuntime(ctx: CodegenContext): ObjectRuntimeTypes {
  if (ctx.objectRuntimeTypes) return ctx.objectRuntimeTypes;

  // #2039: settle any deferred late-import shift before baking funcIdx values.
  flushLateImportShifts(ctx, null);

  // Dependencies: native string helpers (flatten + equals) and the string type
  // indices they populate.
  ensureNativeStringHelpers(ctx);

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const nativeStrTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;

  // --- 1. Register the three struct/array types. ---
  const propEntryTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$PropEntry",
    fields: [
      { name: "key", type: { kind: "ref", typeIdx: anyStrTypeIdx }, mutable: false },
      { name: "value", type: { kind: "anyref" }, mutable: true },
      { name: "flags", type: { kind: "i32" }, mutable: true },
      // #1837 — monotonically-increasing insertion sequence, assigned at
      // create time from $Object.nextSeq and PRESERVED across rehash so
      // OrdinaryOwnPropertyKeys can emit string keys in insertion order. Mutable
      // only so the field can be filled by struct.new at any callsite; it is
      // never rewritten after creation.
      { name: "seq", type: { kind: "i32" }, mutable: true },
      // #1888 Slice 5 — accessor get/set slots. Non-null only when
      // (flags & FLAG_ACCESSOR); the boxed getter/setter closure is held as an
      // anyref (closures are per-signature structs dispatched dynamically, so
      // there is no single typed closure ref to use here). On the data path
      // both are null — zero behavioural change for non-accessor properties.
      // Appended LAST so existing field indices 0-3 (key/value/flags/seq) are
      // unchanged (R3 migration note); the single `struct.new $PropEntry` site
      // (__obj_insert) pushes two `ref.null any` for these.
      { name: "get", type: { kind: "anyref" }, mutable: true },
      { name: "set", type: { kind: "anyref" }, mutable: true },
    ],
  });

  const propMapTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "$PropMap",
    element: { kind: "ref_null", typeIdx: propEntryTypeIdx },
    mutable: true,
  });

  const objectTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$Object",
    fields: [
      { name: "proto", type: { kind: "ref_null", typeIdx: objectTypeIdx }, mutable: true },
      { name: "props", type: { kind: "ref", typeIdx: propMapTypeIdx }, mutable: true },
      { name: "count", type: { kind: "i32" }, mutable: true },
      { name: "tombstones", type: { kind: "i32" }, mutable: true },
      { name: "flags", type: { kind: "i32" }, mutable: true },
      // #1837 — next insertion sequence number. Incremented (never reset, not
      // even on rehash) on every NEW key so $PropEntry.seq records the order
      // string keys were first added. Powers OrdinaryOwnPropertyKeys insertion
      // ordering for Object.keys/values/entries/for-in/spread/JSON.stringify.
      { name: "nextSeq", type: { kind: "i32" }, mutable: true },
    ],
  });

  // $ObjVec backing array: (array (mut externref)) — holds enumeration results
  // (keys/values/entries) as boxed externrefs. Separate from the closed-shape
  // __vec_externref/__arr_externref the array literal path uses, so this runtime
  // owns its own type and never collides with shifted indices there.
  const objVecArrTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "array",
    name: "$ObjVecArr",
    element: { kind: "externref" },
    mutable: true,
  });

  // $ObjVec struct {len: i32, data: (ref $ObjVecArr)} — a growable externref
  // vector. Wrapped to externref via extern.convert_any so it flows through the
  // existing externref-typed enumeration call sites (Object.keys → __extern_*).
  const objVecTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$ObjVec",
    fields: [
      { name: "len", type: { kind: "i32" }, mutable: true },
      { name: "data", type: { kind: "ref", typeIdx: objVecArrTypeIdx }, mutable: true },
    ],
  });

  const types: ObjectRuntimeTypes = {
    propEntryTypeIdx,
    propMapTypeIdx,
    objectTypeIdx,
    objVecTypeIdx,
    objVecArrTypeIdx,
  };
  ctx.objectRuntimeTypes = types;

  // Common ValTypes.
  const objRef: ValType = { kind: "ref", typeIdx: objectTypeIdx };
  const objRefNull: ValType = { kind: "ref_null", typeIdx: objectTypeIdx };
  const propMapRef: ValType = { kind: "ref", typeIdx: propMapTypeIdx };
  const entryRefNull: ValType = { kind: "ref_null", typeIdx: propEntryTypeIdx };
  const anyStrRef: ValType = { kind: "ref", typeIdx: anyStrTypeIdx };
  const nativeStrRef: ValType = { kind: "ref", typeIdx: nativeStrTypeIdx };
  const objVecRef: ValType = { kind: "ref", typeIdx: objVecTypeIdx };
  const objVecArrRef: ValType = { kind: "ref", typeIdx: objVecArrTypeIdx };

  // Helper: register a defined function, return its funcIdx.
  const registerNative = (
    name: string,
    paramTypes: ValType[],
    resultTypes: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ): number => {
    const typeIdx = addFuncType(ctx, paramTypes, resultTypes);
    const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
    ctx.funcMap.set(name, funcIdx);
    ctx.mod.functions.push({ name, typeIdx, locals, body, exported: false });
    return funcIdx;
  };

  // ── __extern_is_array(externref v) -> i32 ────────────────────────────────
  //
  // Placeholder reserved with the object runtime and filled at FINALIZE by
  // fillExternIsArray(), after all module-local array carrier types are known.
  // This keeps Array.isArray over a helper compiled before a later array type
  // from baking an incomplete ref.test list.
  registerNative(
    "__extern_is_array",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
    [{ name: "any", type: { kind: "anyref" } }],
    [{ op: "i32.const", value: 0 } as Instr],
  );
  ctx.externIsArrayReserved = true;

  // Look up an already-emitted native string helper.
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten")!;
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals")!;

  // ── $__obj_hash(externref key) -> i32 ────────────────────────────────────
  //
  // FNV-1a over the UTF-16 code units of the flattened string. The key is an
  // externref holding a $NativeString/$AnyString; convert + cast + flatten,
  // then read len/off/data and fold. Returns a non-negative i32 hash.
  //
  // locals: 1=str(ref $NativeString) 2=data(ref $strData) 3=len 4=off 5=i 6=h
  {
    const FNV_OFFSET = 0x811c9dc5 | 0;
    const FNV_PRIME = 0x01000193;
    const body: Instr[] = [
      // str = flatten(cast<$AnyString>(any.convert_extern(key)))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
      { op: "call", funcIdx: strFlattenIdx },
      { op: "local.tee", index: 1 },
      // len = str.len ; off = str.off ; data = str.data
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },
      // h = FNV_OFFSET ; i = 0
      { op: "i32.const", value: FNV_OFFSET },
      { op: "local.set", index: 6 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 3 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // h = (h ^ data[off + i]) * FNV_PRIME
              { op: "local.get", index: 6 },
              { op: "local.get", index: 2 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "i32.xor" },
              { op: "i32.const", value: FNV_PRIME },
              { op: "i32.mul" },
              { op: "local.set", index: 6 },
              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return h & 0x7fffffff  (non-negative; masking happens at call sites too)
      { op: "local.get", index: 6 },
      { op: "i32.const", value: 0x7fffffff },
      { op: "i32.and" },
    ];
    registerNative(
      "__obj_hash",
      [{ kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "str", type: nativeStrRef },
        { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
        { name: "len", type: { kind: "i32" } },
        { name: "off", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "h", type: { kind: "i32" } },
      ],
      body,
    );
  }
  const objHashIdx = ctx.funcMap.get("__obj_hash")!;

  // ── __new_plain_object() -> externref ────────────────────────────────────
  //
  // struct.new $Object { proto: null, props: new $PropMap[INITIAL_CAP], count:
  // 0, tombstones: 0, flags: 0, nextSeq: 0 }, then extern.convert_any.
  {
    const body: Instr[] = [
      { op: "ref.null", typeIdx: objectTypeIdx }, // proto
      { op: "i32.const", value: INITIAL_CAP }, // props: array.new_default count
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "i32.const", value: 0 }, // count
      { op: "i32.const", value: 0 }, // tombstones
      { op: "i32.const", value: 0 }, // flags
      { op: "i32.const", value: 0 }, // nextSeq (#1837)
      { op: "struct.new", typeIdx: objectTypeIdx },
      { op: "extern.convert_any" },
    ];
    registerNative("__new_plain_object", [], [{ kind: "externref" }], [], body);
  }

  // ── $__obj_find(ref $Object, externref key) -> ref null $PropEntry ────────
  //
  // Linear-probing lookup in the object's OWN props table (no proto walk).
  // Returns the matching live entry, or null if absent. Tombstoned entries
  // (FLAG_TOMBSTONE set) are skipped but do not terminate the probe (they are
  // "deleted but occupied" slots in open addressing).
  //
  // params: 0=o(ref $Object) 1=key(externref)
  // locals: 2=arr(ref $PropMap) 3=cap 4=mask 5=i 6=e(ref null $PropEntry) 7=fkey(ref $NativeString)
  {
    const body: Instr[] = [
      // fkey = flatten(cast<$AnyString>(any.convert_extern(key)))
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
      { op: "call", funcIdx: strFlattenIdx },
      { op: "local.set", index: 7 },
      // arr = o.props ; cap = arr.len ; mask = cap - 1
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 2 },
      { op: "array.len" },
      { op: "local.tee", index: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "local.set", index: 4 },
      // i = hash(key) & mask
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objHashIdx },
      { op: "local.get", index: 4 },
      { op: "i32.and" },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // e = arr[i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              // if e == null → key absent → return null
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "ref.null", typeIdx: propEntryTypeIdx }, { op: "return" }],
              },
              // if !(e.flags & TOMBSTONE) && str_equals(flatten(e.key), fkey) → return e
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              { op: "i32.const", value: FLAG_TOMBSTONE },
              { op: "i32.and" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // flatten(e.key)
                  { op: "local.get", index: 6 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                  { op: "call", funcIdx: strFlattenIdx },
                  { op: "local.get", index: 7 },
                  { op: "call", funcIdx: strEqualsIdx },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [{ op: "local.get", index: 6 }, { op: "return" }],
                  },
                ],
              },
              // i = (i + 1) & mask ; loop
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: 4 },
              { op: "i32.and" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "ref.null", typeIdx: propEntryTypeIdx },
    ];
    registerNative(
      "__obj_find",
      [objRef, { kind: "externref" }],
      [entryRefNull],
      [
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "mask", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "fkey", type: nativeStrRef },
      ],
      body,
    );
  }
  const objFindIdx = ctx.funcMap.get("__obj_find")!;

  // ── __extern_get(externref obj, externref key) -> externref ──────────────
  //
  // Unwrap obj to $Object (return null on non-object), walk the own-property
  // entry then the prototype chain. Property values are stored as anyref;
  // convert back to externref for the result.
  //
  // params: 0=obj(externref) 1=key(externref)
  // locals: 2=o(ref null $Object) 3=e(ref null $PropEntry) 4=any(anyref)
  //         5=getter(externref) — (#1888 S5b) stored accessor $get closure
  {
    // (#1888 S5b) Reserve the `__call_accessor_get` driver funcIdx BEFORE the
    // body bakes its `call`. The driver body is filled in finalize once
    // `__call_fn_method_0` exists (fillAccessorDrivers). Routing through funcMap
    // keeps the late-import shifter in sync (#329/#1899).
    const callAccessorGetIdx = reserveAccessorGetDriver(ctx);
    const body: Instr[] = [
      // any = any.convert_extern(obj)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 4 },
      // if !ref.test $Object → not one of our objects → return null
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      // o = cast<$Object>(any)
      { op: "local.get", index: 4 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 2 },
      // proto-walk loop
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if o == null break
              { op: "local.get", index: 2 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // e = __obj_find(o, key)
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: objFindIdx },
              { op: "local.tee", index: 3 },
              // if e != null → resolve the property
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // (#1888 S5b) Accessor branch: if (e.flags & FLAG_ACCESSOR),
                  // invoke the stored getter with the ORIGINAL receiver (param 0,
                  // §6.2.5.5 Get — NOT the proto-walk cursor) bound as `this`.
                  { op: "local.get", index: 3 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_ACCESSOR },
                  { op: "i32.and" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // getter = extern.convert_any(e.$get)
                      { op: "local.get", index: 3 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                      { op: "extern.convert_any" },
                      { op: "local.tee", index: 5 },
                      // if getter == null → return undefined (null externref)
                      { op: "ref.is_null" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [{ op: "ref.null.extern" }, { op: "return" }],
                      },
                      // return __call_accessor_get(obj /*param 0*/, getter)
                      { op: "local.get", index: 0 },
                      { op: "local.get", index: 5 },
                      { op: "call", funcIdx: callAccessorGetIdx },
                      { op: "return" },
                    ],
                  },
                  // Data property → return extern.convert_any(e.value)
                  { op: "local.get", index: 3 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                  { op: "extern.convert_any" },
                  { op: "return" },
                ],
              },
              // o = o.proto ; loop
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found anywhere → null
      { op: "ref.null.extern" },
    ];
    registerNative(
      "__extern_get",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "o", type: objRefNull },
        { name: "e", type: entryRefNull },
        { name: "any", type: { kind: "anyref" } },
        { name: "getter", type: { kind: "externref" } }, // (#1888 S5b) accessor $get
      ],
      body,
    );
  }

  // ── $__obj_insert(ref $Object, externref key, anyref value, i32 flags, i32 seq) ──
  //
  // Insert-or-update on the OWN table. Caller is responsible for growing the
  // table BEFORE calling when the load factor is exceeded (see __extern_set).
  // On update of a LIVE entry with the same key, overwrites value + flags (the
  // existing entry's seq is NOT touched — first-insertion order is preserved
  // per OrdinaryOwnPropertyKeys; updating an existing key does not reorder it).
  // `seq` (#1837) is stamped onto a freshly-created entry. Callers that add a
  // NEW key pass `o.nextSeq` (and bump it); the __obj_grow rehash passes the
  // entry's PRESERVED seq so order survives a resize.
  //
  // params: 0=o(ref $Object) 1=key(externref) 2=value(anyref) 3=flags 4=seq
  // locals: 5=arr(ref $PropMap) 6=cap 7=mask 8=i 9=e(ref null $PropEntry) 10=fkey(ref $NativeString) 11=keyStr(ref $AnyString)
  {
    const body: Instr[] = [
      // keyStr = cast<$AnyString>(any.convert_extern(key)) ; fkey = flatten(keyStr)
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
      { op: "local.tee", index: 11 },
      { op: "call", funcIdx: strFlattenIdx },
      { op: "local.set", index: 10 },
      // arr = o.props ; cap = arr.len ; mask = cap - 1
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 5 },
      { op: "array.len" },
      { op: "local.tee", index: 6 },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "local.set", index: 7 },
      // i = hash(key) & mask
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objHashIdx },
      { op: "local.get", index: 7 },
      { op: "i32.and" },
      { op: "local.set", index: 8 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // e = arr[i]
              { op: "local.get", index: 5 },
              { op: "local.get", index: 8 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 9 },
              // empty slot → create new entry here, UNLESS the object is
              // non-extensible (#1472 Phase B Blocker A Half 2). A
              // sealed/preventExtensions/frozen object refuses NEW keys per ES
              // §10.4.7 [[DefineOwnProperty]] extensibility check — sloppy no-op
              // (strict throw deferred to #1473). Updates of existing keys are
              // unaffected (they take the update-in-place branch below). A
              // frozen object never reaches __obj_insert via __extern_set (the
              // FROZEN gate there returns first), but __obj_insert is also
              // called during __obj_grow rehash — where the table is rebuilt
              // from existing live entries, all of which take the empty-slot
              // branch. We must NOT refuse those, so the gate is keyed on the
              // OBJECT's NON_EXTENSIBLE bit, which during a grow only matters
              // when a non-extensible object grows (it can't — no new key was
              // accepted, so load never rises to force a grow). Safe.
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // if o.flags & NON_EXTENSIBLE → refuse new key (return)
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
                  { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
                  { op: "i32.and" },
                  { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
                  // arr[i] = struct.new $PropEntry { keyStr, value, flags, seq,
                  //                                   get=null, set=null }
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 8 },
                  { op: "local.get", index: 11 },
                  { op: "local.get", index: 2 },
                  { op: "local.get", index: 3 },
                  { op: "local.get", index: 4 }, // seq (#1837)
                  { op: "ref.null", typeIdx: NONE_HEAP }, // get (#1888 S5) — data path: null
                  { op: "ref.null", typeIdx: NONE_HEAP }, // set (#1888 S5) — data path: null
                  { op: "struct.new", typeIdx: propEntryTypeIdx },
                  { op: "array.set", typeIdx: propMapTypeIdx },
                  // o.count++
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 0 },
                  { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 2 },
                  { op: "return" },
                ],
              },
              // occupied + LIVE + key matches → update in place
              // str_equals(flatten(e.key), fkey)
              { op: "local.get", index: 9 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "call", funcIdx: strFlattenIdx },
              { op: "local.get", index: 10 },
              { op: "call", funcIdx: strEqualsIdx },
              // AND not a tombstone
              { op: "local.get", index: 9 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              { op: "i32.const", value: FLAG_TOMBSTONE },
              { op: "i32.and" },
              { op: "i32.eqz" },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // e.value = value ; e.flags = flags ; return (update in place,
                  // seq untouched — first-insertion order preserved per #1837)
                  { op: "local.get", index: 9 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 2 },
                  { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                  { op: "local.get", index: 9 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 3 },
                  { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "return" },
                ],
              },
              // collision → i = (i + 1) & mask ; loop
              { op: "local.get", index: 8 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.get", index: 7 },
              { op: "i32.and" },
              { op: "local.set", index: 8 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ];
    registerNative(
      "__obj_insert",
      [objRef, { kind: "externref" }, { kind: "anyref" }, { kind: "i32" }, { kind: "i32" }],
      [],
      [
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "mask", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "fkey", type: nativeStrRef },
        { name: "keyStr", type: anyStrRef },
      ],
      body,
    );
  }
  const objInsertIdx = ctx.funcMap.get("__obj_insert")!;

  // ── $__obj_grow(ref $Object) -> void ─────────────────────────────────────
  //
  // Double the capacity and rehash live (non-tombstone) entries into a fresh
  // table. Resets tombstones to 0 and replays entries through __obj_insert
  // against the NEW table (count reset to 0 first so inserts re-accumulate it).
  //
  // params: 0=o(ref $Object)
  // locals: 1=old(ref $PropMap) 2=newCap 3=i 4=oldLen 5=e(ref null $PropEntry)
  {
    const body: Instr[] = [
      // old = o.props ; oldLen = old.len ; newCap = oldLen * 2
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 1 },
      { op: "array.len" },
      { op: "local.tee", index: 4 },
      { op: "i32.const", value: 2 },
      { op: "i32.mul" },
      { op: "local.set", index: 2 },
      // o.props = new $PropMap[newCap] ; o.count = 0 ; o.tombstones = 0
      { op: "local.get", index: 0 },
      { op: "local.get", index: 2 },
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 0 },
      { op: "i32.const", value: 0 },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 3 },
      // for i in 0..oldLen: replay live entries
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 3 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // e = old[i]
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 5 },
              // if e != null && !(e.flags & TOMBSTONE): re-insert
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 5 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_TOMBSTONE },
                  { op: "i32.and" },
                  { op: "i32.eqz" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // __obj_insert(o, extern.convert_any(e.key), e.value,
                      // e.flags, e.seq) — PRESERVE the original seq across the
                      // rehash so insertion order survives a resize (#1837)
                      { op: "local.get", index: 0 },
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                      { op: "extern.convert_any" },
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                      { op: "local.get", index: 5 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 3 }, // seq
                      { op: "call", funcIdx: objInsertIdx },
                    ],
                  },
                ],
              },
              // i++
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
    ];
    registerNative(
      "__obj_grow",
      [objRef],
      [],
      [
        { name: "old", type: propMapRef },
        { name: "newCap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "oldLen", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
      ],
      body,
    );
  }
  const objGrowIdx = ctx.funcMap.get("__obj_grow")!;

  // ── __extern_set(externref obj, externref key, externref value) -> void ──
  //
  // Unwrap obj to $Object (no-op on non-object — matches host leniency), grow
  // if the load factor is too high, then insert/update with default data-prop
  // flags. Value is stored as anyref via any.convert_extern.
  //
  // params: 0=obj 1=key 2=value
  // locals: 3=o(ref null $Object) 4=cap 5=load 6=any(anyref) 7=seq
  //         8=accEntry(ref null $PropEntry) 9=setter(externref) — (#1888 S5b)
  {
    // (#1888 S5b) Reserve the `__call_accessor_set` driver funcIdx BEFORE the
    // body bakes its `call`; body filled in finalize (fillAccessorDrivers) once
    // `__call_fn_method_1` exists.
    const callAccessorSetIdx = reserveAccessorSetDriver(ctx);
    const body: Instr[] = [
      // any = any.convert_extern(obj)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 6 },
      // if !ref.test $Object → silently no-op (host import is lenient too)
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "return" }],
      },
      // o = cast<$Object>(any)
      { op: "local.get", index: 6 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 3 },
      // (#1888 S5b) Accessor write gate — runs BEFORE the FROZEN gate because a
      // setter is invoked regardless of [[Extensible]]/frozen state (§10.1.5.3
      // OrdinarySetWithOwnDescriptor calls Set even on a frozen object; only data
      // writes are blocked by frozen). Find the OWN entry; if it has
      // FLAG_ACCESSOR, invoke the stored setter with the ORIGINAL receiver
      // (param 0) bound as `this` and `value` (param 2) as the argument, then
      // return — bypassing the data-write path entirely. A null setter is a
      // sloppy no-op (strict TypeError deferred, matches the frozen-refuse).
      // Inherited-accessor set (proto-chain) is out of scope for this slice;
      // __obj_find walks only the own table.
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 8 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 8 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          { op: "i32.const", value: FLAG_ACCESSOR },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // setter = extern.convert_any(e.$set)
              { op: "local.get", index: 8 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
              { op: "extern.convert_any" },
              { op: "local.tee", index: 9 },
              // if setter != null → __call_accessor_set(obj /*param 0*/, setter, value /*param 2*/)
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: 9 },
                  { op: "local.get", index: 2 },
                  { op: "call", funcIdx: callAccessorSetIdx },
                ],
              },
              // accessor write handled (setter ran, or sloppy no-op) → return
              { op: "return" },
            ],
          },
        ],
      },
      // #1472 Phase B Blocker A Half 2 — FROZEN write gate. A frozen object
      // refuses ALL data writes (update AND new key) per ES §10.4.7 / the
      // [[Set]] invariant on non-writable own data properties. Sloppy-mode
      // no-op here (strict-mode TypeError throw is deferred to the error
      // machinery slice, #1473). Sealed/non-extensible objects still allow
      // updates of existing keys — that new-key refusal lives in __obj_insert's
      // empty-slot branch (gated on NON_EXTENSIBLE), so it is NOT gated here.
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: OBJ_FLAG_FROZEN },
      { op: "i32.and" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      // load = o.count + o.tombstones ; cap = o.props.len
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 5 },
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
      // if (load + 1) * 10 >= cap * 7 → grow  (load factor 0.7)
      { op: "local.get", index: 5 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "i32.const", value: 10 },
      { op: "i32.mul" },
      { op: "local.get", index: 4 },
      { op: "i32.const", value: 7 },
      { op: "i32.mul" },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 3 }, { op: "ref.as_non_null" }, { op: "call", funcIdx: objGrowIdx }],
      },
      // seq = o.nextSeq ; o.nextSeq = seq + 1  (#1837 — claim the next insertion
      // sequence for a potential NEW entry; an update of an existing key keeps
      // its original seq so this number is simply skipped, which is harmless
      // because seq values are only compared for relative order)
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 5 },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 7 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 5 },
      // __obj_insert(o, key, any.convert_extern(value), FLAG_DEFAULT, seq)
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "i32.const", value: FLAG_DEFAULT },
      { op: "local.get", index: 7 },
      { op: "call", funcIdx: objInsertIdx },
    ];
    registerNative(
      "__extern_set",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [],
      [
        { name: "o", type: objRefNull },
        { name: "cap", type: { kind: "i32" } },
        { name: "load", type: { kind: "i32" } },
        { name: "any", type: { kind: "anyref" } },
        { name: "seq", type: { kind: "i32" } },
        { name: "accEntry", type: entryRefNull }, // (#1888 S5b) own entry for accessor probe
        { name: "setter", type: { kind: "externref" } }, // (#1888 S5b) accessor $set
      ],
      body,
    );
  }

  // ── __reflect_set(externref obj, externref key, externref value) -> i32 ──
  //
  // Reflect.set's supported standalone subset shares the existing __extern_set
  // data-write machinery, but it must return the [[Set]] boolean instead of
  // void. Keep __extern_set's ABI stable for ordinary assignment call sites and
  // preflight the object-runtime refusal cases here:
  //   - non-$Object receiver → false (standalone has no host TypeError bridge)
  //   - own accessor with no setter → false
  //   - own data property with !writable → false
  //   - frozen object data write → false
  //   - missing own property on a non-extensible object → false
  // Otherwise delegate to __extern_set and return true.
  {
    const reflectSetExternSetIdx = ctx.funcMap.get("__extern_set")!;
    const body: Instr[] = [
      // any = any.convert_extern(obj); if !ref.test $Object → false
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 3 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // o = cast<$Object>(any); e = __obj_find(o, key)
      { op: "local.get", index: 3 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 4 },
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 5 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // Own accessor: true iff a setter exists; __extern_set invokes it.
          { op: "local.get", index: 5 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          { op: "i32.const", value: FLAG_ACCESSOR },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 5 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
              { op: "extern.convert_any" },
              { op: "ref.is_null" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 0 }, { op: "return" }],
              },
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: reflectSetExternSetIdx },
              { op: "i32.const", value: 1 },
              { op: "return" },
            ],
          },
          // Own data: false if non-writable.
          { op: "local.get", index: 5 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          { op: "i32.const", value: FLAG_WRITABLE },
          { op: "i32.and" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 0 }, { op: "return" }],
          },
          // Frozen data write: false. __extern_set would no-op; Reflect.set
          // exposes that refusal as its boolean result.
          { op: "local.get", index: 4 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
          { op: "i32.const", value: OBJ_FLAG_FROZEN },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "i32.const", value: 0 }, { op: "return" }],
          },
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: reflectSetExternSetIdx },
          { op: "i32.const", value: 1 },
          { op: "return" },
        ],
      },
      // Missing own property: non-extensible objects refuse the new key.
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: reflectSetExternSetIdx },
      { op: "i32.const", value: 1 },
    ];
    registerNative(
      "__reflect_set",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "e", type: entryRefNull },
      ],
      body,
    );
  }

  // ── __delete_property(externref obj, externref key) -> i32 ───────────────
  //
  // ES §13.5.1 delete operator / §28.1.4 Reflect.deleteProperty on an own data
  // property. Finds the live entry; if present AND configurable (§10.1.10
  // OrdinaryDelete), marks it tombstoned (FLAG_TOMBSTONE), nulls its value (drop
  // the reference for GC), decrements count, increments tombstones, returns 1.
  // (#2046 PR-B) A configurability preflight refuses non-configurable props
  // (return 0): props on a sealed/frozen object, or data props defined
  // non-configurable via __defineProperty_value (#1629) — the prior "always
  // configurable" assumption was stale once #1629 landed. Returns 1 when the key
  // is absent (delete of a missing own prop succeeds, §10.1.10 step 2 / host
  // import parity).
  //
  // params: 0=obj(externref) 1=key(externref)
  // locals: 2=any(anyref) 3=o(ref null $Object) 4=e(ref null $PropEntry)
  {
    const body: Instr[] = [
      // any = any.convert_extern(obj) ; if !ref.test $Object → return 1 (no-op success)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
      // o = cast<$Object>(any) ; e = __obj_find(o, key)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 3 },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 4 },
      // if e == null → property absent → return 1 (delete of missing key succeeds)
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 1 }, { op: "return" }],
      },
      // (#2046 PR-B) Configurability preflight — §10.1.10 OrdinaryDelete step 3-4:
      // a non-configurable own property is NOT deletable. Return 0 (false, keep)
      // when either:
      //   (a) the OBJECT is sealed/frozen — `__object_seal`/`__object_freeze`
      //       set the object-level OBJ_FLAG_SEALED bit but do NOT clear each
      //       entry's FLAG_CONFIGURABLE, so the per-entry check below is NOT
      //       sufficient on its own; sealed ⇒ every own prop is non-configurable
      //       (frozen ⊃ sealed), so test the object bit too; OR
      //   (b) the individual entry was defined non-configurable
      //       (FLAG_CONFIGURABLE cleared) via __defineProperty_value (#1629).
      // This is correct for BOTH callers of __delete_property: Reflect (returns
      // false) and sloppy `delete obj[k]` (also returns false for a
      // non-configurable own prop, §13.5.1.2).
      // (a) object sealed/frozen?
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: OBJ_FLAG_SEALED },
      { op: "i32.and" },
      // (b) entry non-configurable? ((e.flags & FLAG_CONFIGURABLE) == 0)
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: FLAG_CONFIGURABLE },
      { op: "i32.and" },
      { op: "i32.eqz" },
      // refuse-delete = (sealed) | (entry not configurable)
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // e.flags |= TOMBSTONE
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: FLAG_TOMBSTONE },
      { op: "i32.or" },
      { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      // o.count-- ; o.tombstones++
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: 1 },
      { op: "i32.sub" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 3 },
      // return 1
      { op: "i32.const", value: 1 },
    ];
    registerNative(
      "__delete_property",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "e", type: entryRefNull },
      ],
      body,
    );
  }

  // ════════════════════════════════════════════════════════════════════════
  // #1472 Phase B Blocker B — native $ObjVec build/iterate foundation.
  //
  // A growable externref vector that backs standalone enumeration results
  // (Object.keys/values/entries). It is wrapped to externref via
  // extern.convert_any so the result flows unchanged through the existing
  // externref-typed enumeration call sites, where the consumer reads it back
  // via __extern_length + __extern_get_idx. Those two helpers gain a
  // $ObjVec-aware native path here so the round-trip is fully host-free.
  //
  // Insert/append uses doubling growth; INITIAL_CAP keeps small objects cheap.
  // ════════════════════════════════════════════════════════════════════════

  // ── __objvec_new() -> externref ─────────────────────────────────────────
  // struct.new $ObjVec { len: 0, data: new $ObjVecArr[INITIAL_CAP] }, wrapped.
  {
    const body: Instr[] = [
      { op: "i32.const", value: 0 }, // len
      { op: "i32.const", value: INITIAL_CAP }, // data: array.new_default count
      { op: "array.new_default", typeIdx: objVecArrTypeIdx },
      { op: "struct.new", typeIdx: objVecTypeIdx },
      { op: "extern.convert_any" },
    ];
    registerNative("__objvec_new", [], [{ kind: "externref" }], [], body);
  }
  const objVecNewIdx = ctx.funcMap.get("__objvec_new")!;

  // ── __objvec_push(externref vec, externref elem) -> void ─────────────────
  //
  // Append elem to the wrapped $ObjVec, doubling the backing array when full.
  // No-op (silently) if vec is not a $ObjVec — keeps the helper total.
  //
  // params: 0=vec(externref) 1=elem(externref)
  // locals: 2=any(anyref) 3=v(ref null $ObjVec) 4=arr(ref null $ObjVecArr)
  //         5=len 6=cap 7=narr(ref null $ObjVecArr) 8=i
  {
    const body: Instr[] = [
      // any = any.convert_extern(vec); if !$ObjVec → return
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "return" }] },
      // v = cast<$ObjVec>(any)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objVecTypeIdx },
      { op: "local.set", index: 3 },
      // arr = v.data ; len = v.len ; cap = arr.len
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 4 },
      { op: "array.len" },
      { op: "local.set", index: 6 },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 5 },
      // if len >= cap → grow: narr = new[cap*2]; copy 0..len; v.data = narr; arr = narr
      { op: "local.get", index: 5 },
      { op: "local.get", index: 6 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // narr = array.new_default(cap*2)  (cap is always >=1)
          { op: "local.get", index: 6 },
          { op: "i32.const", value: 2 },
          { op: "i32.mul" },
          { op: "array.new_default", typeIdx: objVecArrTypeIdx },
          { op: "local.set", index: 7 },
          // i = 0; while i < len: narr[i] = arr[i]; i++
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
                  { op: "local.get", index: 5 },
                  { op: "i32.ge_s" },
                  { op: "br_if", depth: 1 },
                  // narr[i] = arr[i]
                  { op: "local.get", index: 7 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 8 },
                  { op: "local.get", index: 4 },
                  { op: "ref.as_non_null" },
                  { op: "local.get", index: 8 },
                  { op: "array.get", typeIdx: objVecArrTypeIdx },
                  { op: "array.set", typeIdx: objVecArrTypeIdx },
                  // i++
                  { op: "local.get", index: 8 },
                  { op: "i32.const", value: 1 },
                  { op: "i32.add" },
                  { op: "local.set", index: 8 },
                  { op: "br", depth: 0 },
                ],
              },
            ],
          },
          // v.data = narr ; arr = narr
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 7 },
          { op: "ref.as_non_null" },
          { op: "struct.set", typeIdx: objVecTypeIdx, fieldIdx: 1 },
          { op: "local.get", index: 7 },
          { op: "local.set", index: 4 },
        ],
      },
      // arr[len] = elem ; v.len = len + 1
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 5 },
      { op: "local.get", index: 1 },
      { op: "array.set", typeIdx: objVecArrTypeIdx },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 5 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objVecTypeIdx, fieldIdx: 0 },
    ];
    registerNative(
      "__objvec_push",
      [{ kind: "externref" }, { kind: "externref" }],
      [],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "v", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
        { name: "arr", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } },
        { name: "len", type: { kind: "i32" } },
        { name: "cap", type: { kind: "i32" } },
        { name: "narr", type: { kind: "ref_null", typeIdx: objVecArrTypeIdx } },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
    );
  }
  const objVecPushIdx = ctx.funcMap.get("__objvec_push")!;

  // ── __hasOwnProperty / __object_hasOwn (externref obj, externref key) -> i32 ─
  //
  // ES §20.1.3.2 Object.prototype.hasOwnProperty / §20.1.2.13 Object.hasOwn:
  // OWN-property presence only (NO prototype walk). Cast obj to $Object (return
  // 0 on a non-$Object / null receiver — never throws into Wasm), then
  // __obj_find on the own props table; present iff the returned entry is
  // non-null (find already skips tombstones). Object.hasOwn shares the exact
  // own-only predicate, so both names register the same body.
  const emitHasOwn = (name: string): void => {
    const body: Instr[] = [
      // any = any.convert_extern(obj); if !ref.test $Object → 0
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // e = __obj_find(cast<$Object>(any), key) ; return e != null
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
    ];
    registerNative(
      name,
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [{ name: "any", type: { kind: "anyref" } }],
      body,
    );
  };
  emitHasOwn("__hasOwnProperty");
  emitHasOwn("__object_hasOwn");

  // ── __extern_has(externref obj, externref key) -> i32 (#1472 Phase C) ──────
  //
  // ES §7.3.12 HasProperty(O, P): keyed `key in obj` — own properties AND the
  // prototype chain. Mirrors __extern_get's proto-walk but returns a boolean
  // instead of the value (so a present-but-undefined property still reports 1).
  // Non-$Object / null receiver → 0 (the `in` dispatch site has already
  // confirmed an object-shaped externref; this never throws into Wasm).
  //
  // params: 0=obj(externref) 1=key(externref)
  // locals: 2=o(ref null $Object) 3=any(anyref)
  {
    const body: Instr[] = [
      // any = any.convert_extern(obj); if !ref.test $Object → 0
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 3 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // o = cast<$Object>(any)
      { op: "local.get", index: 3 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 2 },
      // proto-walk loop (mirror of __extern_get)
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if o == null break
              { op: "local.get", index: 2 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // if __obj_find(o, key) != null → return 1
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 1 },
              { op: "call", funcIdx: objFindIdx },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 1 }, { op: "return" }],
              },
              // o = o.proto ; loop
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // not found anywhere → 0
      { op: "i32.const", value: 0 },
    ];
    registerNative(
      "__extern_has",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "o", type: objRefNull },
        { name: "any", type: { kind: "anyref" } },
      ],
      body,
    );
  }

  // ── __to_primitive(externref input, externref hint) -> externref ─────────
  //
  // #1900 Phase 1 — Wasm-native OrdinaryToPrimitive over the standalone
  // `$Object` runtime. Implements ECMA-262 §7.1.1.1 method ordering:
  //   string hint: toString → valueOf
  //   number/default hint: valueOf → toString
  //
  // The standalone runtime does not yet materialize Object.prototype as a real
  // prototype object, so a modeled object with no `toString` property would
  // otherwise throw. When `__extern_has(obj, "toString")` is false, the helper
  // supplies the ordinary default Object.prototype.toString result
  // `"[object Object]"`. A present non-callable or object-returning `toString`
  // still shadows that default and can produce the required TypeError.
  {
    addUnionImportsViaRegistry(ctx);
    const externGetIdx = ctx.funcMap.get("__extern_get")!;
    const externHasIdx = ctx.funcMap.get("__extern_has")!;
    const callMethod0Idx = reserveAccessorGetDriver(ctx);
    const typeofNumberIdx = ctx.funcMap.get("__typeof_number")!;
    const typeofStringIdx = ctx.funcMap.get("__typeof_string")!;
    const typeofBooleanIdx = ctx.funcMap.get("__typeof_boolean")!;
    const typeofFunctionIdx = ctx.funcMap.get("__typeof_function")!;

    const typeErrorMessage = "Cannot convert object to primitive value";
    addStringConstantGlobal(ctx, typeErrorMessage);
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
    const exnTagIdx = ensureExnTag(ctx);

    const stringExtern = (value: string): Instr[] => {
      addStringConstantGlobal(ctx, value);
      return stringConstantExternrefInstrs(ctx, value);
    };

    const L_ANY = 2;
    const L_METHOD = 3;
    const L_RESULT = 4;

    const returnIfPrimitive = (localIdx: number): Instr[] => [
      { op: "local.get", index: localIdx },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: localIdx }, { op: "return" }],
      },
      { op: "local.get", index: localIdx },
      { op: "call", funcIdx: typeofNumberIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: localIdx }, { op: "return" }],
      },
      { op: "local.get", index: localIdx },
      { op: "call", funcIdx: typeofBooleanIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: localIdx }, { op: "return" }],
      },
      { op: "local.get", index: localIdx },
      { op: "call", funcIdx: typeofStringIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: localIdx }, { op: "return" }],
      },
    ];

    const throwTypeError = (): Instr[] => [
      ...stringExtern(typeErrorMessage),
      { op: "call", funcIdx: typeErrorCtorIdx },
      { op: "throw", tagIdx: exnTagIdx } as Instr,
    ];

    const isStringHint: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 0 }],
        else: [
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: typeofStringIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: 1 },
              { op: "any.convert_extern" },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "call", funcIdx: strFlattenIdx },
              ...nativeStringLiteralInstrs(ctx, "string"),
              { op: "call", funcIdx: strFlattenIdx },
              { op: "call", funcIdx: strEqualsIdx },
            ],
            else: [{ op: "i32.const", value: 0 }],
          } as Instr,
        ],
      } as Instr,
    ];

    const tryOrdinaryMethod = (name: "valueOf" | "toString", defaultObjectToStringOnMissing: boolean): Instr[] => [
      { op: "local.get", index: 0 },
      ...stringExtern(name),
      { op: "call", funcIdx: externGetIdx },
      { op: "local.tee", index: L_METHOD },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: defaultObjectToStringOnMissing
          ? [
              { op: "local.get", index: 0 },
              ...stringExtern(name),
              { op: "call", funcIdx: externHasIdx },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [...stringExtern("[object Object]"), { op: "return" }],
              } as Instr,
            ]
          : [],
        else: [
          { op: "local.get", index: L_METHOD },
          { op: "call", funcIdx: typeofFunctionIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "local.get", index: L_METHOD },
              { op: "call", funcIdx: callMethod0Idx },
              { op: "local.set", index: L_RESULT },
              ...returnIfPrimitive(L_RESULT),
            ],
          } as Instr,
        ],
      } as Instr,
    ];

    const body: Instr[] = [
      // Non-objects return unchanged (ToPrimitive step 1).
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_ANY },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      ...isStringHint,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...tryOrdinaryMethod("toString", true), ...tryOrdinaryMethod("valueOf", false)],
        else: [...tryOrdinaryMethod("valueOf", false), ...tryOrdinaryMethod("toString", true)],
      },
      ...throwTypeError(),
    ];

    registerNative(
      "__to_primitive",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "method", type: { kind: "externref" } },
        { name: "result", type: { kind: "externref" } },
      ],
      body,
    );

    const toPrimitiveIdx = ctx.funcMap.get("__to_primitive")!;
    const anyToStringIdx = ensureAnyToStringHelper(ctx);
    const toStringBody: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [{ op: "ref.null.extern" }],
        else: [
          { op: "local.get", index: 0 },
          { op: "any.convert_extern" },
          { op: "ref.test", typeIdx: objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "local.get", index: 0 }, ...stringExtern("string"), { op: "call", funcIdx: toPrimitiveIdx }],
            else: [{ op: "local.get", index: 0 }],
          } as Instr,
        ],
      } as Instr,
      { op: "any.convert_extern" },
      { op: "call", funcIdx: anyToStringIdx },
      { op: "extern.convert_any" },
    ];
    registerNative("__extern_toString", [{ kind: "externref" }], [{ kind: "externref" }], [], toStringBody);
  }

  // ── Prototype-chain ops (#1472 Phase C) ──────────────────────────────────
  //
  // The $Object struct already carries the [[Prototype]] in field 0 ($proto,
  // ref null $Object) and __extern_get/__extern_has already walk it. These four
  // helpers expose the chain directly. All operate purely on the $proto field;
  // non-$Object / null receivers return a lenient null/0 (never throw into
  // Wasm — the receiver-dispatch / ToObject checks live at the call site).

  // __getPrototypeOf(externref) -> externref (ES §20.1.2.12):
  //   $Object → extern.convert_any($proto) (may be null); non-$Object → null.
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
          { op: "extern.convert_any" },
        ],
        else: [{ op: "ref.null.extern" }],
      },
    ];
    registerNative(
      "__getPrototypeOf",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [{ name: "any", type: { kind: "anyref" } }],
      body,
    );
  }

  // __object_create(externref proto) -> externref (ES §20.1.2.2):
  //   fresh empty $Object with $proto = (proto is $Object ? proto : null).
  //   Object.create(null) passes a null externref → $proto stays null.
  //   (The descriptors second arg is materialised separately by the call site.)
  {
    const body: Instr[] = [
      // props = new $PropMap(INITIAL_CAP) (all null)
      { op: "ref.null", typeIdx: propEntryTypeIdx },
      { op: "i32.const", value: INITIAL_CAP },
      { op: "array.new", typeIdx: propMapTypeIdx },
      { op: "local.set", index: 2 },
      // proto = (any.convert_extern(arg) is $Object ? cast : null)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: objRefNull },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
        ],
        else: [{ op: "ref.null", typeIdx: objectTypeIdx }],
      },
      // struct.new $Object {proto, props, count=0, tombstones=0, flags=0, nextSeq=0}
      { op: "local.get", index: 2 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 },
      { op: "i32.const", value: 0 }, // nextSeq (#1837)
      { op: "struct.new", typeIdx: objectTypeIdx },
      { op: "extern.convert_any" },
    ];
    registerNative(
      "__object_create",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "props", type: propMapRef },
      ],
      body,
    );
  }

  // __object_setPrototypeOf(externref obj, externref proto) -> externref
  //   (ES §20.1.2.21 Object.setPrototypeOf → §10.1.2 [[SetPrototypeOf]] →
  //   §10.1.2.1 OrdinarySetPrototypeOf). #1888 Slice 7. Writes $Object.$proto
  //   (field 0) after the OrdinarySetPrototypeOf checks, then returns obj.
  //
  //   Per §20.1.2.21 the return value is always the first argument `obj`, even
  //   when the [[SetPrototypeOf]] would have been observably a no-op or refused.
  //   (Object.setPrototypeOf returns O regardless of the boolean result, except
  //   that a *false* result throws a TypeError in the spec — see the dual-mode
  //   note below.)
  //
  //   OrdinarySetPrototypeOf(O, V), with V restricted to Object|null here
  //   (a non-$Object externref V coerces to null, matching __object_create):
  //     1. current = O.[[Prototype]].
  //     2. If SameValue(V, current) → true (no write; ref.eq, both nullable).
  //     3. If O is non-extensible (OBJ_FLAG_NONEXTENSIBLE) → false (NO write).
  //     4. Cycle check: walk p = V; while p ≠ null: if p === O → false (refuse,
  //        never build a cyclic chain that a later proto-walk would loop on);
  //        p = p.$proto. (We do not model the exotic [[GetPrototypeOf]] short-
  //        circuit — all our objects are ordinary.)
  //     5. O.[[Prototype]] = V → true.
  //
  //   Dual-mode posture (#1472 / #1888): a *refused* set (steps 3/4 → false)
  //   is a SILENT no-op in standalone, NOT a thrown TypeError. This mirrors the
  //   freeze-write refusal posture (the #1473 error machinery is a separate
  //   layer) and keeps this slice from pulling __new_TypeError / the exn tag
  //   late into the runtime. The proto is simply left unchanged; obj is still
  //   returned. A non-$Object obj receiver is also a silent no-op (the ToObject
  //   / RequireObjectCoercible receiver guard lives at the #820k call site).
  //
  // params: 0=obj(externref) 1=proto(externref)
  // locals: 2=o(ref null $Object) 3=v(ref null $Object) 4=p(ref null $Object)
  //         5=any(anyref)
  {
    const body: Instr[] = [
      // o = (obj is $Object ? cast : null); if not an $Object → return obj as-is
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 5 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 5 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "local.set", index: 2 },
        ],
        else: [
          // non-$Object receiver → no write, return obj unchanged
          { op: "local.get", index: 0 },
          { op: "return" },
        ],
      },
      // v = (proto is $Object ? cast : null) — non-$Object/null proto ⇒ null
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 5 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: objRefNull },
        then: [
          { op: "local.get", index: 5 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
        ],
        else: [{ op: "ref.null", typeIdx: objectTypeIdx }],
      },
      { op: "local.set", index: 3 },
      // step 2: if SameValue(v, o.$proto) → no-op (return obj)
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
      { op: "ref.eq" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // step 3: if o.flags & OBJ_FLAG_NONEXTENSIBLE → refuse (return obj, no write)
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // step 4: cycle check — p = v ; while p != null { if p === o → refuse ; p = p.$proto }
      { op: "local.get", index: 3 },
      { op: "local.set", index: 4 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if p == null break (end of candidate chain, no cycle)
              { op: "local.get", index: 4 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // if ref.eq(p, o) → cycle → refuse (return obj, no write)
              { op: "local.get", index: 4 },
              { op: "ref.as_non_null" },
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "local.get", index: 0 }, { op: "return" }],
              },
              // p = p.$proto ; loop
              { op: "local.get", index: 4 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 4 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // step 5: o.$proto = v
      { op: "local.get", index: 2 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 3 },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 0 },
      // return obj
      { op: "local.get", index: 0 },
    ];
    registerNative(
      "__object_setPrototypeOf",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "o", type: objRefNull },
        { name: "v", type: objRefNull },
        { name: "p", type: objRefNull },
        { name: "any", type: { kind: "anyref" } },
      ],
      body,
    );
  }

  // __isPrototypeOf(externref obj, externref candidate) -> i32 (ES §20.1.3.3):
  //   1 iff obj appears in candidate's prototype chain. Walk candidate.$proto
  //   and ref.eq each level against obj. Non-$Object obj/candidate → 0.
  //
  // params: 0=obj(externref) 1=candidate(externref)
  // locals: 2=target(ref null $Object) 3=cur(ref null $Object) 4=any(anyref)
  {
    const body: Instr[] = [
      // target = (obj is $Object ? cast : null); if null → 0
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 4 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      { op: "local.get", index: 4 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 2 },
      // cur = (candidate is $Object ? cast : null)
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 4 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: objRefNull },
        then: [
          { op: "local.get", index: 4 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
        ],
        else: [{ op: "ref.null", typeIdx: objectTypeIdx }],
      },
      { op: "local.set", index: 3 },
      // walk: cur = cur.$proto ; if cur == null → 0 ; if cur === target → 1
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if cur == null break (candidate had no [[Prototype]])
              { op: "local.get", index: 3 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // cur = cur.$proto
              { op: "local.get", index: 3 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 3 },
              // if cur == null break (reached end of chain)
              { op: "local.get", index: 3 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // if ref.eq(cur, target) → 1
              { op: "local.get", index: 3 },
              { op: "local.get", index: 2 },
              { op: "ref.eq" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: 1 }, { op: "return" }],
              },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "i32.const", value: 0 },
    ];
    registerNative(
      "__isPrototypeOf",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "target", type: objRefNull },
        { name: "cur", type: objRefNull },
        { name: "any", type: { kind: "anyref" } },
      ],
      body,
    );
  }

  // ── __obj_index_of_key(ref $AnyString key) -> i32 ────────────────────────
  // #1837 — canonical array-index test for OrdinaryOwnPropertyKeys ordering.
  // Returns the integer value of `key` if it is a canonical numeric array index
  // (ES §6.1.7 / 7.1.21 CanonicalNumericIndexString restricted to array index
  // range), else -1. Canonical means: "0", or a digit string with no leading
  // zero whose value is a non-negative integer < 2^31-1 (we cap below i32 max so
  // the value is usable as a signed sort key — array indices in practice are
  // small; anything ≥ 2^31-1 is treated as a string key, which is acceptable
  // since it would also sort after all in-range indices). Non-digit strings,
  // leading-zero strings ("01"), "+1", "-1", "1.0", "" → -1.
  //
  // param: 0=key(ref $AnyString)
  // locals: 1=str(ref $NativeString) 2=data(ref $strData) 3=len 4=off 5=i 6=c 7=val
  {
    const body: Instr[] = [
      // str = flatten(key) ; len = str.len ; off = str.off ; data = str.data
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: strFlattenIdx },
      { op: "local.tee", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 0 },
      { op: "local.tee", index: 3 },
      // if len == 0 → -1 (empty string is not an index)
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -1 }, { op: "return" }],
      },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 1 },
      { op: "local.set", index: 4 },
      { op: "local.get", index: 1 },
      { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 2 },
      // c = data[off + 0]
      { op: "local.get", index: 2 },
      { op: "local.get", index: 4 },
      { op: "array.get_u", typeIdx: strDataTypeIdx },
      { op: "local.tee", index: 6 },
      // special case "0": len==1 && c=='0' → 0
      { op: "i32.const", value: 0x30 }, // '0'
      { op: "i32.eq" },
      { op: "local.get", index: 3 },
      { op: "i32.const", value: 1 },
      { op: "i32.eq" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // first char must be '1'..'9' (no leading zero, no '0' prefix)
      { op: "local.get", index: 6 },
      { op: "i32.const", value: 0x31 }, // '1'
      { op: "i32.lt_u" },
      { op: "local.get", index: 6 },
      { op: "i32.const", value: 0x39 }, // '9'
      { op: "i32.gt_u" },
      { op: "i32.or" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: -1 }, { op: "return" }],
      },
      // val = 0 ; i = 0 ; accumulate digits
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 7 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= len break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 3 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // c = data[off + i]
              { op: "local.get", index: 2 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "i32.add" },
              { op: "array.get_u", typeIdx: strDataTypeIdx },
              { op: "local.tee", index: 6 },
              // if c < '0' || c > '9' → not an index (return -1)
              { op: "i32.const", value: 0x30 },
              { op: "i32.lt_u" },
              { op: "local.get", index: 6 },
              { op: "i32.const", value: 0x39 },
              { op: "i32.gt_u" },
              { op: "i32.or" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: -1 }, { op: "return" }],
              },
              // val = val * 10 + (c - '0')
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 10 },
              { op: "i32.mul" },
              { op: "local.get", index: 6 },
              { op: "i32.const", value: 0x30 },
              { op: "i32.sub" },
              { op: "i32.add" },
              { op: "local.tee", index: 7 },
              // overflow / out-of-range guard: if val < 0 (wrapped past i32 max)
              // treat as a string key (return -1)
              { op: "i32.const", value: 0 },
              { op: "i32.lt_s" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [{ op: "i32.const", value: -1 }, { op: "return" }],
              },
              // i++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return val
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__obj_index_of_key",
      [anyStrRef],
      [{ kind: "i32" }],
      [
        { name: "str", type: nativeStrRef },
        { name: "data", type: { kind: "ref", typeIdx: strDataTypeIdx } },
        { name: "len", type: { kind: "i32" } },
        { name: "off", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "c", type: { kind: "i32" } },
        { name: "val", type: { kind: "i32" } },
      ],
      body,
    );
  }
  const objIndexOfKeyIdx = ctx.funcMap.get("__obj_index_of_key")!;

  // ── __obj_ordered(ref $Object o) -> ref $PropMap ──────────────────────────
  // #1837 — collect this object's LIVE + ENUMERABLE own property entries into a
  // freshly compacted $PropMap in ECMAScript OrdinaryOwnPropertyKeys order
  // (§10.1.11.1): integer-index keys ascending by numeric value first, then the
  // remaining string keys in insertion order ($PropEntry.seq ascending). The
  // result array's prefix [0..m) holds the ordered entries; the suffix is null,
  // so callers walk until the first null (or use the known live count). Symbol
  // keys are out of scope here (the open-object runtime stores only string keys).
  //
  // Selection sort over the compacted set — O(m²) but m is the live-property
  // count of one object, which is small in practice and avoids any auxiliary
  // host array.
  //
  // param: 0=o(ref $Object)
  // locals: 1=arr(ref $PropMap) 2=cap 3=i 4=e(ref null $PropEntry) 5=out(ref $PropMap)
  //         6=m(filled count) 7=j 8=best 9=k 10=cand(ref null $PropEntry) 11=bestE(ref null $PropEntry)
  //         12=candIdx 13=bestIdx 14=candSeq 15=bestSeq 16=tmp(ref null $PropEntry)
  {
    const entryRef: ValType = { kind: "ref", typeIdx: propEntryTypeIdx };
    // Inline: leave on stack the array index (i32) for entry `e` (local idx given
    // by `entryLocal`) — its key parsed as a canonical array index, else -1.
    const entryIndexOf = (entryLocal: number): Instr[] => [
      { op: "local.get", index: entryLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
      { op: "call", funcIdx: objIndexOfKeyIdx },
    ];
    const entrySeqOf = (entryLocal: number): Instr[] => [
      { op: "local.get", index: entryLocal },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 3 },
    ];
    // keyLess(candIdx, candSeq, bestIdx, bestSeq) -> i32 — true iff the
    // (candIdx, candSeq) key precedes (bestIdx, bestSeq) in
    // OrdinaryOwnPropertyKeys order. Integer-index keys (idx >= 0) precede all
    // string keys (idx < 0); among integer keys compare by value, among string
    // keys compare by insertion seq.
    const keyLess = (candIdx: number, candSeq: number, bestIdx: number, bestSeq: number): Instr[] => [
      // if candIdx >= 0
      { op: "local.get", index: candIdx },
      { op: "i32.const", value: 0 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // candidate is an integer index
          // if bestIdx >= 0 → candIdx < bestIdx ; else → true (int before string)
          { op: "local.get", index: bestIdx },
          { op: "i32.const", value: 0 },
          { op: "i32.ge_s" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "local.get", index: candIdx }, { op: "local.get", index: bestIdx }, { op: "i32.lt_s" }],
            else: [{ op: "i32.const", value: 1 }],
          },
        ],
        else: [
          // candidate is a string key
          // if bestIdx >= 0 → false (string never precedes int) ; else → candSeq < bestSeq
          { op: "local.get", index: bestIdx },
          { op: "i32.const", value: 0 },
          { op: "i32.ge_s" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 0 }],
            else: [{ op: "local.get", index: candSeq }, { op: "local.get", index: bestSeq }, { op: "i32.lt_s" }],
          },
        ],
      },
    ];
    const body: Instr[] = [
      // arr = o.props ; cap = arr.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 1 },
      { op: "array.len" },
      { op: "local.set", index: 2 },
      // out = new $PropMap[o.count]  (upper bound on live entries; enumerable
      // entries are a subset, trailing slots stay null)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "local.set", index: 5 },
      // m = 0 ; i = 0 — first pass: compact live + enumerable entries into out
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 6 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 3 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 3 },
              { op: "local.get", index: 2 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // e = arr[i]
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 4 },
              { op: "ref.is_null" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // (not tombstone) && enumerable
                  { op: "local.get", index: 4 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_TOMBSTONE },
                  { op: "i32.and" },
                  { op: "i32.eqz" },
                  { op: "local.get", index: 4 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_ENUMERABLE },
                  { op: "i32.and" },
                  { op: "i32.eqz" },
                  { op: "i32.eqz" },
                  { op: "i32.and" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // out[m] = e ; m++
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 6 },
                      { op: "local.get", index: 4 },
                      { op: "array.set", typeIdx: propMapTypeIdx },
                      { op: "local.get", index: 6 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 6 },
                    ],
                  },
                ],
              },
              { op: "local.get", index: 3 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 3 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // Second pass: selection sort out[0..m) by OrdinaryOwnPropertyKeys order.
      // for j in 0..m-1: find best in [j..m) and swap into out[j]
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 7 }, // j
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if j >= m break
              { op: "local.get", index: 7 },
              { op: "local.get", index: 6 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // best = j ; bestE = out[j] ; bestIdx = idx(bestE) ; bestSeq = bestE.seq
              { op: "local.get", index: 7 },
              { op: "local.set", index: 8 },
              { op: "local.get", index: 5 },
              { op: "local.get", index: 7 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.set", index: 11 },
              ...entryIndexOf(11),
              { op: "local.set", index: 13 },
              ...entrySeqOf(11),
              { op: "local.set", index: 15 },
              // for k in j+1..m
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 9 },
              {
                op: "block",
                blockType: { kind: "empty" },
                body: [
                  {
                    op: "loop",
                    blockType: { kind: "empty" },
                    body: [
                      { op: "local.get", index: 9 },
                      { op: "local.get", index: 6 },
                      { op: "i32.ge_u" },
                      { op: "br_if", depth: 1 },
                      // cand = out[k] ; candIdx = idx(cand) ; candSeq = cand.seq
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 9 },
                      { op: "array.get", typeIdx: propMapTypeIdx },
                      { op: "local.set", index: 10 },
                      ...entryIndexOf(10),
                      { op: "local.set", index: 12 },
                      ...entrySeqOf(10),
                      { op: "local.set", index: 14 },
                      // if cand precedes best → best = k, bestIdx=candIdx,
                      // bestSeq=candSeq, bestE=cand
                      //
                      // ordering predicate keyLess(candIdx,candSeq,bestIdx,bestSeq):
                      //   both indices (>=0): cand < best  ⇔  candIdx < bestIdx
                      //   cand index, best string: cand precedes  (candIdx>=0 && bestIdx<0)
                      //   cand string, best index: cand does NOT precede
                      //   both strings (<0): candSeq < bestSeq
                      ...keyLess(12, 14, 13, 15),
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 9 },
                          { op: "local.set", index: 8 },
                          { op: "local.get", index: 12 },
                          { op: "local.set", index: 13 },
                          { op: "local.get", index: 14 },
                          { op: "local.set", index: 15 },
                          { op: "local.get", index: 10 },
                          { op: "local.set", index: 11 },
                        ],
                      },
                      { op: "local.get", index: 9 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 9 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // swap out[j] <-> out[best] (only if best != j)
              { op: "local.get", index: 8 },
              { op: "local.get", index: 7 },
              { op: "i32.ne" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // tmp = out[j]
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 7 },
                  { op: "array.get", typeIdx: propMapTypeIdx },
                  { op: "local.set", index: 16 },
                  // out[j] = out[best] (== bestE)
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 7 },
                  { op: "local.get", index: 11 },
                  { op: "array.set", typeIdx: propMapTypeIdx },
                  // out[best] = tmp
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 8 },
                  { op: "local.get", index: 16 },
                  { op: "array.set", typeIdx: propMapTypeIdx },
                ],
              },
              { op: "local.get", index: 7 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 7 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 5 },
    ];
    registerNative(
      "__obj_ordered",
      [objRef],
      [propMapRef],
      [
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "out", type: propMapRef },
        { name: "m", type: { kind: "i32" } },
        { name: "j", type: { kind: "i32" } },
        { name: "best", type: { kind: "i32" } },
        { name: "k", type: { kind: "i32" } },
        { name: "cand", type: entryRefNull },
        { name: "bestE", type: entryRefNull },
        { name: "candIdx", type: { kind: "i32" } },
        { name: "bestIdx", type: { kind: "i32" } },
        { name: "candSeq", type: { kind: "i32" } },
        { name: "bestSeq", type: { kind: "i32" } },
        { name: "tmp", type: entryRefNull },
      ],
      body,
    );
    void entryRef;
  }
  const objOrderedIdx = ctx.funcMap.get("__obj_ordered")!;

  // ── __object_keys(externref obj) -> externref ────────────────────────────
  //
  // ES §20.1.2.18 / §10.1.11.1 — own enumerable string keys in
  // OrdinaryOwnPropertyKeys order: integer-index keys ascending first, then
  // string keys in insertion order. We delegate the filtering + ordering to
  // __obj_ordered (#1837), which returns a compacted $PropMap (live + enumerable
  // entries in spec order, trailing nulls), then push each entry's key into a
  // fresh $ObjVec. Non-$Object receivers return an empty $ObjVec (host returns []
  // for those that reach here; ToObject-throw on null/undefined is handled at the
  // call site).
  //
  // params: 0=obj(externref)
  // locals: 1=any(anyref) 2=o(ref null $Object) 3=arr(ordered ref $PropMap) 4=cap
  //         5=i 6=e(ref null $PropEntry) 7=vec(externref)
  {
    const body: Instr[] = [
      // vec = __objvec_new()
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      // any = any.convert_extern(obj); if !$Object → return empty vec
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 7 }, { op: "return" }],
      },
      // o = cast<$Object>(any) ; arr = __obj_ordered(o) ; cap = arr.len
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "call", funcIdx: objOrderedIdx },
      { op: "local.tee", index: 3 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
      // i = 0
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if i >= cap break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // e = arr[i] ; ordered array is compacted — stop at first null
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // __objvec_push(vec, extern.convert_any(e.key))
              { op: "local.get", index: 7 },
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
              // i++ ; loop
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return vec
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__object_keys",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "vec", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __extern_length(externref v) -> f64 ──────────────────────────────────
  //
  // Standalone numeric "length" for an enumeration result. Recognises a wrapped
  // $ObjVec and returns its f64 len; any other value returns 0 (matches the
  // host import's null/non-array fallback). This is what the array-iteration
  // consumers (buildVecFromExternref, array-methods length loops) read.
  //
  // params: 0=v(externref) ; locals: 1=any(anyref)
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "f64" } },
        then: [
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: objVecTypeIdx },
          { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
          { op: "f64.convert_i32_s" },
        ],
        else: [{ op: "f64.const", value: 0 }],
      },
    ];
    registerNative(
      "__extern_length",
      [{ kind: "externref" }],
      [{ kind: "f64" }],
      [{ name: "any", type: { kind: "anyref" } }],
      body,
    );
  }

  // ── __extern_get_idx(externref v, f64 idx) -> externref ───────────────────
  //
  // Standalone indexed read. Recognises a wrapped $ObjVec and returns
  // data[i32(idx)] when 0 <= idx < len; otherwise null. Any non-$ObjVec value
  // returns null (matches the host import's null/undefined fallback).
  //
  // params: 0=v(externref) 1=idx(f64) ; locals: 2=any(anyref) 3=vec(ref null $ObjVec) 4=i
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      // vec = cast<$ObjVec>(any) ; i = i32(idx)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objVecTypeIdx },
      { op: "local.set", index: 3 },
      { op: "local.get", index: 1 },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.tee", index: 4 },
      // if i < 0 || i >= vec.len → null
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      { op: "local.get", index: 4 },
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      // return vec.data[i]
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
      { op: "local.get", index: 4 },
      { op: "array.get", typeIdx: objVecArrTypeIdx },
    ];
    registerNative(
      "__extern_get_idx",
      [{ kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "vec", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
    );
  }
  const externSetIdx = ctx.funcMap.get("__extern_set")!;

  // ── __object_values(externref obj) -> externref ──────────────────────────
  //
  // ES §20.1.2.22 — own enumerable string-keyed values. Same hash-slot walk as
  // __object_keys but pushes each LIVE + enumerable entry's *value* (stored as
  // anyref; wrapped back to externref) into a fresh $ObjVec. Non-$Object
  // receivers return an empty $ObjVec (the ToObject-throw on null/undefined is
  // handled at the call site, matching __object_keys).
  //
  // params: 0=obj(externref)
  // locals: 1=any(anyref) 2=o(ref null $Object) 3=arr(ref $PropMap) 4=cap 5=i
  //         6=e(ref null $PropEntry) 7=vec(externref)
  {
    const body: Instr[] = [
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 7 }, { op: "return" }],
      },
      // o = cast<$Object>(any) ; arr = __obj_ordered(o) ; cap = arr.len (#1837)
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "call", funcIdx: objOrderedIdx },
      { op: "local.tee", index: 3 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // e = arr[i] ; compacted ordered array — stop at first null
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // __objvec_push(vec, extern.convert_any(e.value))
              { op: "local.get", index: 7 },
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__object_values",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "vec", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __object_entries(externref obj) -> externref ─────────────────────────
  //
  // ES §20.1.2.5 — own enumerable [key, value] pairs. Each entry is itself a
  // 2-element $ObjVec (key at idx 0, value at idx 1), wrapped to externref and
  // pushed into the outer $ObjVec. The native __extern_get_idx already indexes a
  // $ObjVec, so `entry[0]`/`entry[1]` in consuming code reads back correctly
  // without any host array. Non-$Object receivers return an empty $ObjVec.
  //
  // params: 0=obj(externref)
  // locals: 1=any(anyref) 2=o(ref null $Object) 3=arr(ref $PropMap) 4=cap 5=i
  //         6=e(ref null $PropEntry) 7=vec(externref) 8=pair(externref)
  {
    const body: Instr[] = [
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 7 }, { op: "return" }],
      },
      // o = cast<$Object>(any) ; arr = __obj_ordered(o) ; cap = arr.len (#1837)
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "call", funcIdx: objOrderedIdx },
      { op: "local.tee", index: 3 },
      { op: "array.len" },
      { op: "local.set", index: 4 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // e = arr[i] ; compacted ordered array — stop at first null
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // pair = __objvec_new()
              { op: "call", funcIdx: objVecNewIdx },
              { op: "local.set", index: 8 },
              // __objvec_push(pair, extern.convert_any(e.key))
              { op: "local.get", index: 8 },
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
              // __objvec_push(pair, extern.convert_any(e.value))
              { op: "local.get", index: 8 },
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
              { op: "extern.convert_any" },
              { op: "call", funcIdx: objVecPushIdx },
              // __objvec_push(vec, pair)
              { op: "local.get", index: 7 },
              { op: "local.get", index: 8 },
              { op: "call", funcIdx: objVecPushIdx },
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__object_entries",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "vec", type: { kind: "externref" } },
        { name: "pair", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __extern_has_idx(externref v, f64 idx) -> i32 ─────────────────────────
  //
  // Standalone HasProperty(O, ToString(idx)) for array-like indexed access.
  // Recognises a wrapped $ObjVec: present iff 0 <= i32(idx) < len. Any
  // non-$ObjVec value returns 0 (matches the host import's null fallback).
  //
  // params: 0=v(externref) 1=idx(f64) ; locals: 2=any(anyref) 3=i
  {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // i = i32(idx) ; if i < 0 → 0
      { op: "local.get", index: 1 },
      { op: "i32.trunc_sat_f64_s" },
      { op: "local.tee", index: 3 },
      { op: "i32.const", value: 0 },
      { op: "i32.lt_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // result = i < vec.len
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objVecTypeIdx },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
      { op: "i32.lt_s" },
    ];
    registerNative(
      "__extern_has_idx",
      [{ kind: "externref" }, { kind: "f64" }],
      [{ kind: "i32" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "i", type: { kind: "i32" } },
      ],
      body,
    );
  }

  // ── __object_assign(externref target, externref sources) -> externref ─────
  //
  // ES §20.1.2.1 Object.assign(target, ...sources). `sources` is a $ObjVec of
  // source externrefs (the call sites build it via __js_array_new/__js_array_push,
  // which standalone routes to __objvec_new/__objvec_push — same signatures). For
  // each source that is one of our $Objects, copy every LIVE + enumerable own
  // property into `target` via the native __extern_set (which itself grows/inserts
  // and is a no-op on a non-$Object target). Sources that are not $Objects (e.g.
  // null/undefined/primitives) are skipped, matching the spec's "ignore nullish
  // sources" + our open-object-only own-key enumeration. Returns `target`.
  //
  // params: 0=target(externref) 1=sources(externref)
  // locals: 2=any(anyref) 3=sv(ref null $ObjVec) 4=slen 5=si
  //         6=srcAny(anyref) 7=so(ref null $Object) 8=arr(ref $PropMap) 9=cap 10=i
  //         11=e(ref null $PropEntry) 12=srcExt(externref)
  {
    const body: Instr[] = [
      // any = any.convert_extern(sources) ; if !$ObjVec → return target
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objVecTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // sv = cast<$ObjVec>(any) ; slen = sv.len ; si = 0
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objVecTypeIdx },
      { op: "local.tee", index: 3 },
      { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
      { op: "local.set", index: 4 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 5 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if si >= slen break
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              // srcExt = sv.data[si]
              { op: "local.get", index: 3 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: objVecArrTypeIdx },
              { op: "local.tee", index: 12 },
              // srcAny = any.convert_extern(srcExt)
              { op: "any.convert_extern" },
              { op: "local.tee", index: 6 },
              // if !$Object → skip this source
              { op: "ref.test", typeIdx: objectTypeIdx },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // so = cast<$Object>(srcAny) ; arr = so.props ; cap = arr.len
                  { op: "local.get", index: 6 },
                  { op: "ref.cast", typeIdx: objectTypeIdx },
                  { op: "local.tee", index: 7 },
                  { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
                  { op: "local.tee", index: 8 },
                  { op: "array.len" },
                  { op: "local.set", index: 9 },
                  { op: "i32.const", value: 0 },
                  { op: "local.set", index: 10 },
                  {
                    op: "block",
                    blockType: { kind: "empty" },
                    body: [
                      {
                        op: "loop",
                        blockType: { kind: "empty" },
                        body: [
                          { op: "local.get", index: 10 },
                          { op: "local.get", index: 9 },
                          { op: "i32.ge_s" },
                          { op: "br_if", depth: 1 },
                          // e = arr[i]
                          { op: "local.get", index: 8 },
                          { op: "local.get", index: 10 },
                          { op: "array.get", typeIdx: propMapTypeIdx },
                          { op: "local.tee", index: 11 },
                          { op: "ref.is_null" },
                          { op: "i32.eqz" },
                          {
                            op: "if",
                            blockType: { kind: "empty" },
                            then: [
                              // (!tombstone) && enumerable
                              { op: "local.get", index: 11 },
                              { op: "ref.as_non_null" },
                              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                              { op: "i32.const", value: FLAG_TOMBSTONE },
                              { op: "i32.and" },
                              { op: "i32.eqz" },
                              { op: "local.get", index: 11 },
                              { op: "ref.as_non_null" },
                              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                              { op: "i32.const", value: FLAG_ENUMERABLE },
                              { op: "i32.and" },
                              { op: "i32.eqz" },
                              { op: "i32.eqz" }, // normalise enumerable bit to 0/1
                              { op: "i32.and" },
                              {
                                op: "if",
                                blockType: { kind: "empty" },
                                then: [
                                  // __extern_set(target, extern.convert_any(e.key),
                                  //              extern.convert_any(e.value))
                                  { op: "local.get", index: 0 },
                                  { op: "local.get", index: 11 },
                                  { op: "ref.as_non_null" },
                                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                                  { op: "extern.convert_any" },
                                  { op: "local.get", index: 11 },
                                  { op: "ref.as_non_null" },
                                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                                  { op: "extern.convert_any" },
                                  { op: "call", funcIdx: externSetIdx },
                                ],
                              },
                            ],
                          },
                          { op: "local.get", index: 10 },
                          { op: "i32.const", value: 1 },
                          { op: "i32.add" },
                          { op: "local.set", index: 10 },
                          { op: "br", depth: 0 },
                        ],
                      },
                    ],
                  },
                ],
              },
              // si++
              { op: "local.get", index: 5 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 5 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return target
      { op: "local.get", index: 0 },
    ];
    registerNative(
      "__object_assign",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "sv", type: { kind: "ref_null", typeIdx: objVecTypeIdx } },
        { name: "slen", type: { kind: "i32" } },
        { name: "si", type: { kind: "i32" } },
        { name: "srcAny", type: { kind: "anyref" } },
        { name: "so", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "srcExt", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __defineProperty_value (#1629 S6 — native data-descriptor define) ─────
  //
  // `Object.defineProperty(obj, key, { value, writable?, enumerable?,
  // configurable? })` and `Reflect.defineProperty` for a DATA descriptor under
  // `--target standalone`. In JS-host mode this is the `env::__defineProperty_value`
  // host import backed by the JS descriptor sidecar; standalone has no host, so we
  // store the value + attribute flags directly into the `$Object`/`$PropEntry`
  // runtime that the native `__extern_get` already reads back.
  //
  // The compiler passes `flags` as an f64 in the host encoding
  // (`computeRuntimeFlags`, object-ops.ts):
  //   bit 0: writable          bit 3: writable specified
  //   bit 1: enumerable        bit 4: enumerable specified
  //   bit 2: configurable      bit 5: configurable specified
  //   bit 6: is accessor       bit 7: has value
  // We translate to the native `$PropEntry.flags` bits (FLAG_WRITABLE / _ENUMERABLE
  // / _CONFIGURABLE). Per CompletePropertyDescriptor (ES §6.2.6.4) a NEW
  // property's omitted attributes default to false — and the host f64 encoding
  // already reflects that (an unspecified attr has neither its specified-bit nor
  // its value-bit set, so the `& value-bit` test yields 0 → false). So the
  // translation is a straight per-attribute mask of bits 0/1/2 onto the native
  // bit positions, which happen to coincide (native WRITABLE=0x1, ENUMERABLE=0x2,
  // CONFIGURABLE=0x4 == host value bits 0,1,2). The only divergence from
  // __extern_set is the explicit flag word instead of FLAG_DEFAULT.
  //
  // Accessor descriptors (`{ get, set }`, host flag bit 6) are NOT handled here —
  // they stay refused under standalone (deferred S6 follow-up: accessor slots +
  // call_ref invocation). The accessor path keeps emitting __defineProperty_accessor,
  // which remains in STANDALONE_REFUSED_IMPORT.
  //
  // params: 0=obj 1=key 2=value 3=flagsF64
  // locals: 4=o(ref null $Object) 5=any(anyref) 6=cap 7=load 8=nflags(i32) 9=hf(i32)
  {
    const NATIVE_ATTR_MASK = FLAG_WRITABLE | FLAG_ENUMERABLE | FLAG_CONFIGURABLE; // 0x07
    const body: Instr[] = [
      // any = any.convert_extern(obj) ; if !$Object → return obj (lenient no-op,
      // matches the host import returning O unchanged)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 5 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // o = cast<$Object>(any)
      { op: "local.get", index: 5 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 4 },
      // hf = trunc_s(flagsF64)  (the host encoding is a small non-negative int)
      { op: "local.get", index: 3 },
      { op: "i32.trunc_f64_s" },
      { op: "local.set", index: 9 },
      // nflags = hf & (WRITABLE|ENUMERABLE|CONFIGURABLE)
      // Host value bits 0/1/2 line up with native FLAG_* bit positions, so a
      // direct mask is the translation. (Specified/hasValue/accessor bits 3-7
      // are dropped.)
      { op: "local.get", index: 9 },
      { op: "i32.const", value: NATIVE_ATTR_MASK },
      { op: "i32.and" },
      { op: "local.set", index: 8 },
      // load = o.count + o.tombstones ; cap = o.props.len ; grow at LF 0.7
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 7 },
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "array.len" },
      { op: "local.set", index: 6 },
      // if (load + 1) * 10 >= cap * 7 → grow
      { op: "local.get", index: 7 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "i32.const", value: 10 },
      { op: "i32.mul" },
      { op: "local.get", index: 6 },
      { op: "i32.const", value: 7 },
      { op: "i32.mul" },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 4 }, { op: "ref.as_non_null" }, { op: "call", funcIdx: objGrowIdx }],
      },
      // seq = o.nextSeq ; o.nextSeq = seq + 1  (#1837)
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 5 },
      { op: "local.set", index: 10 },
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 10 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 5 },
      // __obj_insert(o, key, any.convert_extern(value), nflags, seq)
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "local.get", index: 8 },
      { op: "local.get", index: 10 },
      { op: "call", funcIdx: objInsertIdx },
      // return obj (host import returns O)
      { op: "local.get", index: 0 },
    ];
    registerNative(
      "__defineProperty_value",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
      [
        { name: "o", type: objRefNull },
        { name: "any", type: { kind: "anyref" } },
        { name: "cap", type: { kind: "i32" } },
        { name: "load", type: { kind: "i32" } },
        { name: "nflags", type: { kind: "i32" } },
        { name: "hf", type: { kind: "i32" } },
        { name: "seq", type: { kind: "i32" } },
      ],
      body,
    );
  }

  // ── __defineProperty_accessor (#1888 Slice 5 — native accessor-descriptor STORE) ─
  //
  // `Object.defineProperty(obj, key, { get?, set?, enumerable?, configurable? })`
  // and `Reflect.defineProperty` for an ACCESSOR descriptor under standalone /
  // WASI. The JS-host path is the `env::__defineProperty_accessor` import backed
  // by the JS descriptor sidecar; standalone has no host, so we store the boxed
  // getter/setter closures + attribute flags directly into the `$PropEntry`
  // accessor slots ($get field 4 / $set field 5).
  //
  // RUNTIME-LAYER GROUNDWORK (#1888 Slice 5). This + the native
  // `__getOwnPropertyDescriptor` below + the R3 `$PropEntry.$get/$set` layout are
  // the foundation for accessor descriptors under standalone. They are NOT yet
  // reached end-to-end (see the call-site note below), so they bank ~0 test262 on
  // their own — the value is de-risking the R3 layout change in isolation +
  // providing the runtime target the wiring follow-up calls.
  //
  // FOLLOW-UPS (both #329-gated — the late-shift / host-free-closure funcIdx
  // stability fix being driven now):
  //   - Call-site wiring: `Object.defineProperty(o,k,{get,set})` (object-ops.ts)
  //     compiles getter/setter via `compileArrowAsCallback` → `__make_getter_callback`
  //     (a JS-host import). Routing those to HOST-FREE closures so they reach this
  //     helper (and the GOPD readback can see real getter/setter) needs the #329
  //     funcIdx-stability fix.
  //   - LIVE get/set invocation on member read/write — the accessor arms in
  //     `__extern_get` / `__extern_set` invoke `$get`/`$set` with the original
  //     receiver bound as `this` via `__call_fn_method_0/1` (#1636-S1); also rides
  //     sd-1472c's #1224 `__call_fn_N` externref-arg coercion fix (now landed).
  //
  // Flag translation matches __defineProperty_value (host value bits 0/1/2 →
  // native FLAG_WRITABLE/_ENUMERABLE/_CONFIGURABLE) — but an accessor has no
  // writable attribute (ES §6.2.6.1), so we additionally OR in FLAG_ACCESSOR and
  // leave WRITABLE masked off via the same NATIVE_ATTR_MASK (the host accessor
  // encoding never sets bit 0). The data $value slot is cleared to null.
  //
  // params: 0=obj 1=key 2=getter(externref) 3=setter(externref) 4=flagsF64
  // locals: 5=o(ref null $Object) 6=any(anyref) 7=cap 8=load 9=nflags(i32) 10=hf(i32) 11=seq 12=e(ref null $PropEntry)
  {
    const NATIVE_ATTR_MASK = FLAG_ENUMERABLE | FLAG_CONFIGURABLE; // 0x06 — accessors carry no WRITABLE
    const body: Instr[] = [
      // any = any.convert_extern(obj) ; if !$Object → return obj (lenient no-op)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 6 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // o = cast<$Object>(any)
      { op: "local.get", index: 6 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 5 },
      // hf = trunc_s(flagsF64)
      { op: "local.get", index: 4 },
      { op: "i32.trunc_f64_s" },
      { op: "local.set", index: 10 },
      // nflags = (hf & (ENUMERABLE|CONFIGURABLE)) | FLAG_ACCESSOR
      { op: "local.get", index: 10 },
      { op: "i32.const", value: NATIVE_ATTR_MASK },
      { op: "i32.and" },
      { op: "i32.const", value: FLAG_ACCESSOR },
      { op: "i32.or" },
      { op: "local.set", index: 9 },
      // load = o.count + o.tombstones ; cap = o.props.len ; grow at LF 0.7
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 3 },
      { op: "i32.add" },
      { op: "local.set", index: 8 },
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "array.len" },
      { op: "local.set", index: 7 },
      // if (load + 1) * 10 >= cap * 7 → grow
      { op: "local.get", index: 8 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "i32.const", value: 10 },
      { op: "i32.mul" },
      { op: "local.get", index: 7 },
      { op: "i32.const", value: 7 },
      { op: "i32.mul" },
      { op: "i32.ge_s" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 5 }, { op: "ref.as_non_null" }, { op: "call", funcIdx: objGrowIdx }],
      },
      // seq = o.nextSeq ; o.nextSeq = seq + 1  (#1837)
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 5 },
      { op: "local.set", index: 11 },
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 11 },
      { op: "i32.const", value: 1 },
      { op: "i32.add" },
      { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 5 },
      // __obj_insert(o, key, ref.null any, nflags, seq) — value slot stays null
      // for an accessor; this creates the entry (or updates flags in place) and
      // handles growth/tombstone reuse in one place.
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "ref.null", typeIdx: NONE_HEAP },
      { op: "local.get", index: 9 },
      { op: "local.get", index: 11 },
      { op: "call", funcIdx: objInsertIdx },
      // e = __obj_find(o, key) — re-locate the just-inserted/updated entry to
      // write the accessor slots. (__obj_insert does not take get/set params.)
      // It is always non-null here: either we just created it, or the update-in-
      // place branch matched an existing live entry. The only way to get null is
      // a non-extensible object refusing a NEW key — in which case there are no
      // accessor slots to write, so the null-guarded if is a correct no-op.
      { op: "local.get", index: 5 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 12 },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // e.get = any.convert_extern(getter) ; e.set = any.convert_extern(setter)
          // A null externref (absent get/set) converts to a null anyref, which
          // GOPD reads back as `undefined` for that half of the descriptor.
          { op: "local.get", index: 12 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 2 },
          { op: "any.convert_extern" },
          { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
          { op: "local.get", index: 12 },
          { op: "ref.as_non_null" },
          { op: "local.get", index: 3 },
          { op: "any.convert_extern" },
          { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
          // e.value = null (clear any prior data value — accessors hold no value)
          { op: "local.get", index: 12 },
          { op: "ref.as_non_null" },
          { op: "ref.null", typeIdx: NONE_HEAP },
          { op: "struct.set", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
        ],
      },
      // return obj (host import returns O)
      { op: "local.get", index: 0 },
    ];
    registerNative(
      "__defineProperty_accessor",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "externref" }, { kind: "f64" }],
      [{ kind: "externref" }],
      [
        { name: "o", type: objRefNull },
        { name: "any", type: { kind: "anyref" } },
        { name: "cap", type: { kind: "i32" } },
        { name: "load", type: { kind: "i32" } },
        { name: "nflags", type: { kind: "i32" } },
        { name: "hf", type: { kind: "i32" } },
        { name: "seq", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
      ],
      body,
    );
  }

  // ── __defineProperties (#1906 — native plural descriptor apply) ─────────
  //
  // `Object.defineProperties(obj, Properties)` dynamic fallback under
  // `--target standalone`. The compiler's literal path already expands to
  // individual `Object.defineProperty` calls; this helper covers descriptor
  // maps that are themselves runtime `$Object`s (for example, dynamic or
  // computed-key maps that cannot be closed-shape inferred).
  //
  // Mirrors ECMA-262 §20.1.2.3.1 ObjectDefineProperties: pass 1 walks the
  // enumerable own keys of `Properties`, validates each `$Object` descriptor via
  // the supported ToPropertyDescriptor subset, and stores a compact descriptor
  // record in a temporary `$PropMap`; pass 2 applies the gathered records through
  // the existing native single-property helpers. Unsupported dynamic shapes
  // (non-`$Object` target/descriptor map/per-property descriptor, data+accessor
  // conflicts, non-callable get/set) throw before any target mutation.
  {
    addUnionImportsViaRegistry(ctx);
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
    const exnTagIdx = ensureExnTag(ctx);
    const hasOwnIdx = ctx.funcMap.get("__hasOwnProperty")!;
    const isTruthyIdx = ctx.funcMap.get("__is_truthy")!;
    const typeofFunctionIdx = ctx.funcMap.get("__typeof_function")!;
    const defineValueIdx = ctx.funcMap.get("__defineProperty_value")!;
    const defineAccessorIdx = ctx.funcMap.get("__defineProperty_accessor")!;
    const externGetIdx = ctx.funcMap.get("__extern_get")!;

    const HOST_FLAG_WRITABLE_SPECIFIED = 1 << 3;
    const HOST_FLAG_ENUMERABLE_SPECIFIED = 1 << 4;
    const HOST_FLAG_CONFIGURABLE_SPECIFIED = 1 << 5;
    const HOST_FLAG_ACCESSOR = 1 << 6;
    const HOST_FLAG_HAS_VALUE = 1 << 7;

    const L_OBJ_ANY = 2;
    const L_OBJ = 3;
    const L_DESCS_ANY = 4;
    const L_DESCS = 5;
    const L_ORDERED = 6;
    const L_GATHERED = 7;
    const L_CAP = 8;
    const L_I = 9;
    const L_M = 10;
    const L_ENTRY = 11;
    const L_RAW_DESC = 12;
    const L_RAW_ANY = 13;
    const L_RAW_OBJ = 14;
    const L_FLAGS = 15;
    const L_HAS_DATA = 16;
    const L_HAS_ACCESSOR = 17;
    const L_KEY = 18;
    const L_VALUE = 19;
    const L_GETTER = 20;
    const L_SETTER = 21;

    const keyRef = (key: string): Instr[] => [
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "extern.convert_any" } as Instr,
    ];
    const hasField = (key: string): Instr[] => [
      { op: "local.get", index: L_RAW_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: hasOwnIdx },
    ];
    const getField = (key: string): Instr[] => [
      { op: "local.get", index: L_RAW_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: externGetIdx },
    ];
    const setFlag = (bit: number): Instr[] => [
      { op: "local.get", index: L_FLAGS },
      { op: "i32.const", value: bit },
      { op: "i32.or" },
      { op: "local.set", index: L_FLAGS },
    ];
    const throwTypeError = (message: string): Instr[] => {
      addStringConstantGlobal(ctx, message);
      return [
        ...stringConstantExternrefInstrs(ctx, message),
        { op: "call", funcIdx: typeErrorCtorIdx },
        { op: "throw", tagIdx: exnTagIdx } as Instr,
      ];
    };
    const throwUnsupported = (): Instr[] =>
      throwTypeError("Object.defineProperties unsupported descriptor shape in standalone mode (#1906)");
    const throwConflict = (): Instr[] =>
      throwTypeError("TypeError: Invalid property descriptor in Object.defineProperties (#1906)");
    const throwAccessor = (): Instr[] =>
      throwTypeError("TypeError: Object.defineProperties get/set must be callable (#1906)");

    const readBooleanFlag = (key: string, specifiedBit: number, valueBit: number, marksData: boolean): Instr[] => [
      ...hasField(key),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...(marksData
            ? ([
                { op: "i32.const", value: 1 },
                { op: "local.set", index: L_HAS_DATA },
              ] as Instr[])
            : []),
          ...setFlag(specifiedBit),
          ...getField(key),
          { op: "call", funcIdx: isTruthyIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: setFlag(valueBit),
          } as Instr,
        ],
      } as Instr,
    ];

    const readAccessor = (key: "get" | "set", localIdx: number): Instr[] => [
      ...hasField(key),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: L_HAS_ACCESSOR },
          ...getField(key),
          { op: "local.tee", index: localIdx },
          { op: "ref.is_null" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: localIdx },
              { op: "call", funcIdx: typeofFunctionIdx },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: throwAccessor(),
              } as Instr,
            ],
          } as Instr,
        ],
      } as Instr,
    ];

    const body: Instr[] = [
      // Dynamic Type(O) / ToObject(Properties) checks for the supported native
      // surface: both must be standalone `$Object`s.
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: throwUnsupported() },
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_OBJ_ANY },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: throwUnsupported() },
      { op: "local.get", index: L_OBJ_ANY },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: L_OBJ },

      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: throwUnsupported() },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_DESCS_ANY },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      { op: "if", blockType: { kind: "empty" }, then: throwUnsupported() },
      { op: "local.get", index: L_DESCS_ANY },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: L_DESCS },

      // ordered = enumerable own keys of Properties; gathered has the same
      // capacity and is filled compactly in pass 1.
      { op: "local.get", index: L_DESCS },
      { op: "ref.as_non_null" },
      { op: "call", funcIdx: objOrderedIdx },
      { op: "local.tee", index: L_ORDERED },
      { op: "array.len" },
      { op: "local.tee", index: L_CAP },
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "local.set", index: L_GATHERED },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_M },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_I },

      // Pass 1: gather + validate.
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: L_I },
              { op: "local.get", index: L_CAP },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: L_ORDERED },
              { op: "local.get", index: L_I },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: L_ENTRY },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },

              // key = entry.key; rawDesc = entry.value.
              { op: "local.get", index: L_ENTRY },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "extern.convert_any" },
              { op: "local.set", index: L_KEY },
              { op: "local.get", index: L_ENTRY },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
              { op: "extern.convert_any" },
              { op: "local.set", index: L_RAW_DESC },

              // Per-property descriptor must be a `$Object` in this slice.
              { op: "local.get", index: L_RAW_DESC },
              { op: "any.convert_extern" },
              { op: "local.tee", index: L_RAW_ANY },
              { op: "ref.test", typeIdx: objectTypeIdx },
              { op: "i32.eqz" },
              { op: "if", blockType: { kind: "empty" }, then: throwUnsupported() },
              { op: "local.get", index: L_RAW_ANY },
              { op: "ref.cast", typeIdx: objectTypeIdx },
              { op: "local.set", index: L_RAW_OBJ },

              // Reset descriptor accumulators.
              { op: "i32.const", value: 0 },
              { op: "local.set", index: L_FLAGS },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: L_HAS_DATA },
              { op: "i32.const", value: 0 },
              { op: "local.set", index: L_HAS_ACCESSOR },
              { op: "ref.null.extern" },
              { op: "local.set", index: L_VALUE },
              { op: "ref.null.extern" },
              { op: "local.set", index: L_GETTER },
              { op: "ref.null.extern" },
              { op: "local.set", index: L_SETTER },

              // Data descriptor fields.
              ...hasField("value"),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "i32.const", value: 1 },
                  { op: "local.set", index: L_HAS_DATA },
                  ...setFlag(HOST_FLAG_HAS_VALUE),
                  ...getField("value"),
                  { op: "local.set", index: L_VALUE },
                ],
              },
              ...readBooleanFlag("writable", HOST_FLAG_WRITABLE_SPECIFIED, FLAG_WRITABLE, true),
              ...readBooleanFlag("enumerable", HOST_FLAG_ENUMERABLE_SPECIFIED, FLAG_ENUMERABLE, false),
              ...readBooleanFlag("configurable", HOST_FLAG_CONFIGURABLE_SPECIFIED, FLAG_CONFIGURABLE, false),

              // Accessor descriptor fields.
              ...readAccessor("get", L_GETTER),
              ...readAccessor("set", L_SETTER),

              // Data/accessor conflict is a ToPropertyDescriptor TypeError.
              { op: "local.get", index: L_HAS_DATA },
              { op: "local.get", index: L_HAS_ACCESSOR },
              { op: "i32.and" },
              { op: "if", blockType: { kind: "empty" }, then: throwConflict() },
              { op: "local.get", index: L_HAS_ACCESSOR },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: setFlag(HOST_FLAG_ACCESSOR),
              },

              // gathered[m] = { key, value, flags, get, set } using the existing
              // $PropEntry layout as a compact descriptor-record carrier.
              { op: "local.get", index: L_GATHERED },
              { op: "local.get", index: L_M },
              { op: "local.get", index: L_ENTRY },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
              { op: "local.get", index: L_VALUE },
              { op: "any.convert_extern" },
              { op: "local.get", index: L_FLAGS },
              { op: "i32.const", value: 0 },
              { op: "local.get", index: L_GETTER },
              { op: "any.convert_extern" },
              { op: "local.get", index: L_SETTER },
              { op: "any.convert_extern" },
              { op: "struct.new", typeIdx: propEntryTypeIdx },
              { op: "array.set", typeIdx: propMapTypeIdx },
              { op: "local.get", index: L_M },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_M },
              { op: "local.get", index: L_I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_I },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      // Pass 2: apply the gathered records through the existing single-property
      // helpers. No target mutation happened before this point.
      { op: "i32.const", value: 0 },
      { op: "local.set", index: L_I },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: L_I },
              { op: "local.get", index: L_M },
              { op: "i32.ge_s" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: L_GATHERED },
              { op: "local.get", index: L_I },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.set", index: L_ENTRY },
              { op: "local.get", index: L_ENTRY },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
              { op: "local.tee", index: L_FLAGS },
              { op: "i32.const", value: HOST_FLAG_ACCESSOR },
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: L_ENTRY },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: L_ENTRY },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: L_ENTRY },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: L_FLAGS },
                  { op: "f64.convert_i32_s" },
                  { op: "call", funcIdx: defineAccessorIdx },
                  { op: "drop" },
                ],
                else: [
                  { op: "local.get", index: 0 },
                  { op: "local.get", index: L_ENTRY },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: L_ENTRY },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                  { op: "extern.convert_any" },
                  { op: "local.get", index: L_FLAGS },
                  { op: "f64.convert_i32_s" },
                  { op: "call", funcIdx: defineValueIdx },
                  { op: "drop" },
                ],
              },
              { op: "local.get", index: L_I },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: L_I },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },

      { op: "local.get", index: 0 },
    ];

    registerNative(
      "__defineProperties",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "objAny", type: { kind: "anyref" } },
        { name: "obj", type: objRefNull },
        { name: "descsAny", type: { kind: "anyref" } },
        { name: "descs", type: objRefNull },
        { name: "ordered", type: propMapRef },
        { name: "gathered", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "m", type: { kind: "i32" } },
        { name: "entry", type: entryRefNull },
        { name: "rawDesc", type: { kind: "externref" } },
        { name: "rawAny", type: { kind: "anyref" } },
        { name: "rawObj", type: objRefNull },
        { name: "flags", type: { kind: "i32" } },
        { name: "hasData", type: { kind: "i32" } },
        { name: "hasAccessor", type: { kind: "i32" } },
        { name: "key", type: { kind: "externref" } },
        { name: "value", type: { kind: "externref" } },
        { name: "getter", type: { kind: "externref" } },
        { name: "setter", type: { kind: "externref" } },
      ],
      body,
    );
    void L_OBJ;
    void L_RAW_OBJ;
    void L_KEY;
  }

  // ── __getOwnPropertyDescriptor (#1888 Slice 5 — native descriptor read-back) ─
  //
  // `Object.getOwnPropertyDescriptor(obj, key)` / `Reflect.getOwnPropertyDescriptor`
  // under standalone. Reads the own `$PropEntry` for `key` and materialises a
  // descriptor `$Object`:
  //   accessor (flags & FLAG_ACCESSOR) → { get, set, enumerable, configurable }
  //   data                            → { value, writable, enumerable, configurable }
  // A missing own property, or a non-`$Object` receiver, returns `undefined`
  // (the null externref). This is the read side of the Slice-5 store/round-trip:
  // a getter/setter installed via `__defineProperty_accessor` reads back here as
  // `{ get, set, … }`. The boxed getter/setter come straight out of the
  // `$PropEntry.$get/$set` anyref slots via `extern.convert_any` (a null anyref —
  // an absent half — reads back as `undefined`).
  //
  // Descriptor keys ("get"/"set"/"value"/"writable"/"enumerable"/"configurable")
  // are materialised as native `$NativeString`s (standalone forces nativeStrings)
  // and handed to `__extern_set` as externref — `$NativeString <: $AnyString`, so
  // the insert's `ref.cast $AnyString` succeeds. Attribute booleans are boxed via
  // `__box_boolean` (registered through addUnionImportsViaRegistry, same defined-
  // func, no-index-shift invariant as the rest of this runtime).
  //
  // params: 0=obj(externref) 1=key(externref)
  // locals: 2=any(anyref) 3=o(ref null $Object) 4=e(ref null $PropEntry)
  //         5=fl(i32) 6=desc(externref)
  {
    // __box_boolean is needed for the attribute flags — register the union
    // helpers (idempotent; defined funcs, no index shift) and resolve it.
    addUnionImportsViaRegistry(ctx);
    const boxBoolIdx = ctx.funcMap.get("__box_boolean")!;
    const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;

    // `__extern_set(desc, "<key>", <value externref>)` — desc is in local 6.
    // `valueInstrs` must leave one externref on the stack.
    const setKey = (key: string, valueInstrs: Instr[]): Instr[] => [
      { op: "local.get", index: 6 }, // desc (externref)
      // key: native string → externref
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "extern.convert_any" } as Instr,
      ...valueInstrs,
      { op: "call", funcIdx: externSetIdx },
    ];

    // Box `(e.flags & MASK) != 0` as a JS boolean externref.
    const boolAttr = (mask: number): Instr[] => [
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: mask },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      { op: "call", funcIdx: boxBoolIdx },
    ];

    const body: Instr[] = [
      // any = any.convert_extern(obj) ; if !$Object → return undefined (null)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 2 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      // o = cast<$Object>(any) ; e = __obj_find(o, key)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 3 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 4 },
      // if e == null → return undefined (own property does not exist)
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      // fl = e.flags
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "local.set", index: 5 },
      // desc = __new_plain_object()
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 6 },
      // accessor vs data branch
      { op: "local.get", index: 5 },
      { op: "i32.const", value: FLAG_ACCESSOR },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        // accessor: { get, set, enumerable, configurable }
        then: [
          // desc.get = extern.convert_any(e.get)  (null anyref → undefined)
          ...setKey("get", [
            { op: "local.get", index: 4 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 4 },
            { op: "extern.convert_any" } as Instr,
          ]),
          // desc.set = extern.convert_any(e.set)
          ...setKey("set", [
            { op: "local.get", index: 4 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 5 },
            { op: "extern.convert_any" } as Instr,
          ]),
        ],
        // data: { value, writable }
        else: [
          // desc.value = extern.convert_any(e.value)
          ...setKey("value", [
            { op: "local.get", index: 4 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
            { op: "extern.convert_any" } as Instr,
          ]),
          // desc.writable = box(fl & FLAG_WRITABLE)
          ...setKey("writable", boolAttr(FLAG_WRITABLE)),
        ],
      },
      // common: enumerable, configurable
      ...setKey("enumerable", boolAttr(FLAG_ENUMERABLE)),
      ...setKey("configurable", boolAttr(FLAG_CONFIGURABLE)),
      // return desc
      { op: "local.get", index: 6 },
    ];
    registerNative(
      "__getOwnPropertyDescriptor",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
        { name: "e", type: entryRefNull },
        { name: "fl", type: { kind: "i32" } },
        { name: "desc", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── Object integrity predicates (#1472 Phase B Blocker A Half 1, PR #1074) ─
  //
  // __object_isFrozen / __object_isSealed / __object_isExtensible read the
  // object-level `$Object.flags` (field 4). On a never-frozen `$Object` the
  // flags field is 0 → isFrozen/isSealed read false, isExtensible reads true.
  // ES §20.5.2.13/14: isFrozen/isSealed on a NON-object return TRUE; §20.5.2.12:
  // isExtensible on a non-object returns FALSE. (Merged from main; preserved
  // here through the Blocker B merge so the standalone predicates remain native.)
  const emitIntegrityPredicate = (name: string, flagBit: number, invert: boolean, nonObjResult: number): void => {
    const testExpr: Instr[] = [
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
      { op: "i32.const", value: flagBit },
      { op: "i32.and" },
    ];
    if (invert) {
      testExpr.push({ op: "i32.eqz" });
    } else {
      testExpr.push({ op: "i32.const", value: 0 }, { op: "i32.ne" });
    }
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: testExpr,
        else: [{ op: "i32.const", value: nonObjResult }],
      },
    ];
    registerNative(name, [{ kind: "externref" }], [{ kind: "i32" }], [{ name: "any", type: { kind: "anyref" } }], body);
  };
  emitIntegrityPredicate("__object_isFrozen", OBJ_FLAG_FROZEN, false, 1);
  emitIntegrityPredicate("__object_isSealed", OBJ_FLAG_SEALED, false, 1);
  emitIntegrityPredicate("__object_isExtensible", OBJ_FLAG_NONEXTENSIBLE, true, 0);

  // ── Object integrity SET path (#1472 Phase B Blocker A Half 2) ────────────
  //
  // __object_preventExtensions / __object_seal / __object_freeze set the
  // object-level `$Object.flags` (field 4) integrity bits and return the
  // ORIGINAL externref (identity preserved — these return their argument per
  // ES §20.5.2.{5,18,6}). freeze ⊃ seal ⊃ preventExtensions, so each sets a
  // cumulative bit-mask:
  //   preventExtensions → NONEXTENSIBLE
  //   seal              → NONEXTENSIBLE | SEALED
  //   freeze            → NONEXTENSIBLE | SEALED | FROZEN
  // The write gates in __extern_set (FROZEN → refuse all) and __obj_insert
  // empty-slot (NONEXTENSIBLE → refuse new key) read these bits to enforce
  // immutability. Non-$Object receiver: returned unchanged (primitives are
  // already non-extensible; the predicate readers handle their query side).
  //
  // params: 0=obj(externref) ; locals: 1=any(anyref) 2=o(ref null $Object)
  const emitSetFlags = (name: string, bits: number): void => {
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // o = cast<$Object>(any) ; o.flags |= bits
          { op: "local.get", index: 1 },
          { op: "ref.cast", typeIdx: objectTypeIdx },
          { op: "local.tee", index: 2 },
          { op: "local.get", index: 2 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
          { op: "i32.const", value: bits },
          { op: "i32.or" },
          { op: "struct.set", typeIdx: objectTypeIdx, fieldIdx: 4 },
        ],
      },
      // return the original externref unchanged (identity preserved)
      { op: "local.get", index: 0 },
    ];
    registerNative(
      name,
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "o", type: objRefNull },
      ],
      body,
    );
  };
  emitSetFlags("__object_preventExtensions", OBJ_FLAG_NONEXTENSIBLE);
  emitSetFlags("__object_seal", OBJ_FLAG_NONEXTENSIBLE | OBJ_FLAG_SEALED);
  emitSetFlags("__object_freeze", OBJ_FLAG_NONEXTENSIBLE | OBJ_FLAG_SEALED | OBJ_FLAG_FROZEN);

  // ── __extern_is_undefined(externref) -> i32 (#1472 Phase C) ───────────────
  //
  // The JS-host import is `(v) => (v === undefined ? 1 : 0)` — it distinguishes
  // JS `undefined` (a defined externref produced by `__get_undefined`) from
  // `null` (a null reference). Standalone has no `__get_undefined`: `emitUndefined`
  // falls back to `ref.null.extern`, so the runtime represents BOTH `undefined`
  // and `null` as the null externref. The standalone `__typeof_undefined` helper
  // (addUnionImportsAsNativeFuncs) already encodes this same conflation as a bare
  // `ref.is_null`. We mirror it here so the two are internally consistent.
  //
  // This is exactly the predicate every caller wants in standalone: the
  // default-parameter / destructuring-default paths (function-body.ts,
  // closures.ts, class-bodies.ts, destructuring.ts) and `x === undefined`
  // (binary-ops.ts) use `__extern_is_undefined` to decide whether to apply a
  // default — and a missing/omitted argument arrives as the null externref, the
  // same value `undefined` lowers to. So `ref.is_null` applies the default in
  // precisely the "value is undefined" cases, matching §14.3.3 (keyed/iterator
  // binding initialization defaults fire when the bound value is `undefined`).
  registerNative(
    "__extern_is_undefined",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
    [],
    [{ op: "local.get", index: 0 }, { op: "ref.is_null" }],
  );

  // ── __extern_method_call(externref recv, externref name, externref args)
  //    -> externref (#1888 Slice 2) ─────────────────────────────────────────
  //
  // Generic `recv.name(args)` dispatch on an open `any`/externref receiver
  // (ES §7.3.14 Call). Open-`$Object` user-method path: resolve `name` via
  // `__extern_get` (own + prototype walk) and invoke through the
  // `__apply_closure` arity bridge → `__call_fn_method_0..4` (D6/D7). Non-
  // `$Object` brands ($Vec/string/Map/Set instance methods on a genuinely-`any`
  // receiver) are the Slice-4 brand arms — they return undefined here for now
  // (trackable, never invalid Wasm). The closure-round-trip prerequisite landed
  // (#1226 typeof-closure recognition + every compiled fn-expr self-registers in
  // `closureInfoByTypeIdx` so `__call_fn_method_N` emits a matching `ref.test`
  // arm), so a closure stored into an open `$Object` reads back callable.
  const S2_OPENANY_DISPATCH_WIRED = true;
  if (S2_OPENANY_DISPATCH_WIRED) {
    const applyClosureIdx = reserveApplyClosure(ctx);
    const externGetIdx = ctx.funcMap.get("__extern_get")!;

    const body: Instr[] = [
      // any = any.convert_extern(recv); if null → return undefined
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 3 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "ref.null.extern" }, { op: "return" }],
      },
      // if ref.test $Object(any) → __apply_closure(__extern_get(recv,name), recv, args)
      { op: "local.get", index: 3 },
      { op: "ref.test", typeIdx: objectTypeIdx },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: [
          // m = __extern_get(recv, name)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: externGetIdx },
          // __apply_closure(m, recv, args)
          { op: "local.get", index: 0 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: applyClosureIdx },
        ],
        // Non-$Object receiver: brand arms ($Vec/string/Map/Set) are Slice 4;
        // return undefined for now (never invalid Wasm).
        else: [{ op: "ref.null.extern" }],
      },
    ];
    registerNative(
      "__extern_method_call",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [{ name: "any", type: { kind: "anyref" } }],
      body,
    );
  }

  // Silence "declared but never used" for ValType aliases reserved for the
  // values/entries/assign slices that stack on this foundation.
  void objVecRef;
  void objVecArrRef;
  void nativeStrRef;

  return types;
}

/**
 * #1472 Phase B Slice 3 — the native `$ObjVec` builder funcIdxs that the
 * `Object.assign(target, ...sources)` / object-spread call sites use to build
 * the variadic `...sources` list under `--target standalone`. In JS-host mode
 * those sites build a real JS array via the `__js_array_new` / `__js_array_push`
 * host imports and hand it to `__object_assign`; standalone has no JS array, so
 * they build a `$ObjVec` (which the native `__object_assign` iterates via
 * `ref.test $ObjVec`) instead. Returns `{ newIdx, pushIdx }`, registering the
 * object runtime on first call. Signatures match the host imports exactly —
 * `__objvec_new : () -> externref`, `__objvec_push : (externref, externref) ->
 * void` — so the only call-site change is *which funcIdx* the existing builder
 * code calls.
 */
export function ensureObjVecBuilders(ctx: CodegenContext): { newIdx: number; pushIdx: number } {
  ensureObjectRuntime(ctx);
  return {
    newIdx: ctx.funcMap.get("__objvec_new")!,
    pushIdx: ctx.funcMap.get("__objvec_push")!,
  };
}

/**
 * (#1888 Slice 1) Reserve the `__apply_closure(externref fn, externref recv,
 * externref args) -> externref` arity-bridge funcIdx with a placeholder
 * `unreachable` body, registered in `funcMap`. The real body (an arity switch
 * on `__extern_length(args)` dispatching to `__call_fn_method_0..4`) is filled
 * by `fillApplyClosure` at FINALIZE, because the `__call_fn_method_N` exports
 * it calls are only emitted there (after `closureInfoByTypeIdx` is complete).
 * Mirrors the `reserveProtoIteratorDriver`/`fillProtoIteratorDriver` pattern
 * (#1719). Idempotent. Sets `ctx.applyClosureReserved`.
 */
export function reserveApplyClosure(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__apply_closure");
  if (existing !== undefined) return existing;
  const typeIdx = addFuncType(
    ctx,
    [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
    [{ kind: "externref" }],
    "$apply_closure_type",
  );
  const funcIdx = ctx.numImportFuncs + ctx.mod.functions.length;
  ctx.mod.functions.push({
    name: "__apply_closure",
    typeIdx,
    locals: [],
    // Placeholder; filled by fillApplyClosure. A bare `unreachable` keeps the
    // stub valid (externref result) if the fill is ever skipped.
    body: [{ op: "unreachable" } as Instr],
    exported: false,
  });
  ctx.funcMap.set("__apply_closure", funcIdx);
  ctx.applyClosureReserved = true;
  return funcIdx;
}

/**
 * (#1888 Slice 1) Fill the reserved `__apply_closure` bridge body at FINALIZE,
 * AFTER `emitClosureMethodCallExportN(0..4)` have registered
 * `__call_fn_method_0..4` in `funcMap`. The bridge reads the dynamic arg count
 * from `__extern_length(args)` and dispatches to the matching this-threaded
 * closure dispatcher:
 *
 *   n = i32(__extern_length(args))
 *   if n==0: __call_fn_method_0(recv, fn)
 *   if n==1: __call_fn_method_1(recv, fn, idx0)
 *   ... up to 4 ...
 *   else (n>4): return undefined (sentinel)
 *
 * S1 SCOPE — NO THROWS. This bridge returns the undefined sentinel
 * (`ref.null.extern`) for the not-a-function and arity-overflow cases rather
 * than raising a `TypeError`. Reason: emitting a spec-correct throw here would
 * pull `__new_TypeError` + the exn tag + a string constant into the object
 * runtime, and those late registrations land AFTER the string helpers have
 * already baked `call` targets at finalize — shifting func indices and
 * corrupting the module ("__str_flatten expected (ref null 5) found i32"). That
 * is the #1839/#117/#1886 late-registration-index-shift class. Carving S1
 * without throws keeps the bridge dependency-free of late error machinery, so
 * the module verifies cleanly. The spec-correct `TypeError` throws (ES §7.3.14
 * step 2 "is not a function", and arity-overflow) plus the index-shift fix are
 * the S2 fast-follow. Each `__call_fn_method_N` arm is only emitted when that
 * export was registered (no closure of arity ≤ N ⇒ no dispatcher ⇒ that arm
 * returns the undefined sentinel). No-op when `__apply_closure` was never
 * reserved.
 */
export function fillApplyClosure(ctx: CodegenContext): void {
  if (!ctx.applyClosureReserved) return;
  const bridgeIdx = ctx.funcMap.get("__apply_closure");
  if (bridgeIdx === undefined) return;
  const fnArrayIdx = bridgeIdx - ctx.numImportFuncs;
  const bridgeFn = ctx.mod.functions[fnArrayIdx];
  if (!bridgeFn) return;

  // Dependencies, all registered by now: __extern_length + __extern_get_idx
  // (object runtime). S1 intentionally pulls NO error machinery (see header).
  const externLengthIdx = ctx.funcMap.get("__extern_length");
  const externGetIdxArr = ctx.funcMap.get("__extern_get_idx");
  if (externLengthIdx === undefined || externGetIdxArr === undefined) {
    // Dependencies absent (object runtime not emitted after all) — keep a valid
    // body that returns undefined so the module verifies.
    bridgeFn.body = [{ op: "ref.null.extern" } as Instr];
    return;
  }

  // S1 undefined sentinel: every non-dispatchable case (arity > 4, or a missing
  // arity-N dispatcher) returns undefined rather than throwing. S2 replaces
  // these with spec-correct TypeError throws once the late-shift is fixed.
  const undefinedSentinel = (): Instr[] => [{ op: "ref.null.extern" } as Instr];

  // Locals: 0=fn 1=recv 2=args (params); 3=n(i32)
  const ARG_OF = (k: number): Instr[] => [
    { op: "local.get", index: 2 } as Instr,
    { op: "f64.const", value: k } as Instr,
    { op: "call", funcIdx: externGetIdxArr } as Instr,
  ];

  // Build the arity dispatch from the bottom up (n>4 → undefined), each arm
  // guarded on the matching __call_fn_method_N being registered.
  const callMethod = (n: number): number | undefined => ctx.funcMap.get(`__call_fn_method_${n}`);
  const armUnsupported = undefinedSentinel();

  const buildArm = (n: number): Instr[] => {
    const idx = callMethod(n);
    if (idx === undefined) {
      // No closure of this arity was emitted ⇒ no dispatcher. A live call of
      // this arity is impossible (the program has no arity-n closure), but keep
      // a valid body: return the undefined sentinel.
      return undefinedSentinel();
    }
    // __call_fn_method_N(recv, fn, arg0..arg{N-1})
    const ops: Instr[] = [{ op: "local.get", index: 1 } as Instr, { op: "local.get", index: 0 } as Instr];
    for (let k = 0; k < n; k++) ops.push(...ARG_OF(k));
    ops.push({ op: "call", funcIdx: idx } as Instr);
    return ops;
  };

  // if n==0 .. n==4 else undefined. Nest as if/else chain.
  let dispatch: Instr[] = armUnsupported;
  for (let n = 4; n >= 0; n--) {
    dispatch = [
      { op: "local.get", index: 3 } as Instr,
      { op: "i32.const", value: n } as Instr,
      { op: "i32.eq" } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "externref" } },
        then: buildArm(n),
        else: dispatch,
      } as Instr,
    ];
  }

  // n = i32(__extern_length(args)); dispatch.
  const body: Instr[] = [
    { op: "local.get", index: 2 } as Instr,
    { op: "call", funcIdx: externLengthIdx } as Instr,
    { op: "i32.trunc_f64_s" } as Instr,
    { op: "local.set", index: 3 } as Instr,
    ...dispatch,
  ];

  bridgeFn.body = body;
  bridgeFn.locals = [{ name: "n", type: { kind: "i32" } }];
}

/**
 * (#2047) Byte-backed vec carriers that are NEVER JS arrays and must report
 * `Array.isArray === false` per ES §7.2.2:
 *   - `i32_byte` — ArrayBuffer / DataView backing store.
 *   - `i8_byte`  — native (standalone/WASI) `Uint8Array` packed-byte storage.
 * The codebase already excludes `i32_byte` vecs from array treatment elsewhere
 * (`type-coercion.ts` — the `__make_iterable` shim skips it), so this filter is
 * consistent precedent. NOTE: other TypedArrays (Float64Array, Int32Array, …)
 * share the generic `f64` vec carrier with `number[]`, so a struct-level
 * `ref.test` cannot distinguish them without a brand bit — `__vec_f64` is kept
 * IN the carrier list and `Array.isArray(new Float64Array(1))` remains a known
 * residual false-positive tracked for a brand-bit follow-up. Only the
 * exclusively-non-array `_byte` carriers can be filtered cleanly.
 */
const NON_ARRAY_BYTE_VEC_ELEM_KINDS: ReadonlySet<string> = new Set(["i32_byte", "i8_byte"]);

function isNonArrayByteVecName(name: string): boolean {
  // Matches `__vec_i32_byte` / `__vec_i8_byte`. Only `__vec_*` structs reach
  // this check (the caller already restricts to vec struct names).
  for (const elemKind of NON_ARRAY_BYTE_VEC_ELEM_KINDS) {
    if (name === `__vec_${elemKind}`) return true;
  }
  return false;
}

function collectStandaloneArrayCarrierTypeIdxs(ctx: CodegenContext): number[] {
  const carriers = new Set<number>();
  const objVecTypeIdx = ctx.objectRuntimeTypes?.objVecTypeIdx;
  if (objVecTypeIdx !== undefined) carriers.add(objVecTypeIdx);

  // (#2047) Drop the exclusively-non-array byte carriers from vecTypeMap by key
  // so ArrayBuffer/DataView (`i32_byte`) and native Uint8Array (`i8_byte`) are
  // never claimed as arrays.
  for (const [elemKind, typeIdx] of ctx.vecTypeMap.entries()) {
    if (NON_ARRAY_BYTE_VEC_ELEM_KINDS.has(elemKind)) continue;
    carriers.add(typeIdx);
  }
  for (let typeIdx = 0; typeIdx < ctx.mod.types.length; typeIdx++) {
    const typeDef = ctx.mod.types[typeIdx];
    if (typeDef?.kind !== "struct") continue;
    const name = typeDef.name ?? "";
    if (isNonArrayByteVecName(name)) continue; // (#2047) §7.2.2 — never an array
    if (name.startsWith("__vec_") || name === "__template_vec_externref") carriers.add(typeIdx);
  }
  return Array.from(carriers).sort((a, b) => a - b);
}

/**
 * (#1904) Fill the standalone native `__extern_is_array` predicate after all
 * user functions and late runtime helpers have registered their WasmGC carrier
 * types. Implements the non-Proxy subset of ES §7.2.2 IsArray that can exist in
 * standalone: primitives/non-array objects return false, and compiler-emitted
 * array carriers (`__vec_*`, template vectors, `$ObjVec`) return true.
 */
export function fillExternIsArray(ctx: CodegenContext): void {
  if (!ctx.externIsArrayReserved) return;
  const funcIdx = ctx.funcMap.get("__extern_is_array");
  if (funcIdx === undefined) return;
  const fn = ctx.mod.functions[funcIdx - ctx.numImportFuncs];
  if (!fn) return;

  const carrierTypeIdxs = collectStandaloneArrayCarrierTypeIdxs(ctx);
  const anyLocal = 1;
  const body: Instr[] = [
    { op: "local.get", index: 0 } as Instr,
    { op: "any.convert_extern" } as Instr,
    { op: "local.set", index: anyLocal } as Instr,
  ];

  let chain: Instr[] = [{ op: "i32.const", value: 0 } as Instr];
  for (let i = carrierTypeIdxs.length - 1; i >= 0; i--) {
    const typeIdx = carrierTypeIdxs[i]!;
    chain = [
      { op: "local.get", index: anyLocal } as Instr,
      { op: "ref.test", typeIdx } as Instr,
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 } as Instr],
        else: chain,
      } as Instr,
    ];
  }
  body.push(...chain);

  fn.locals = [{ name: "any", type: { kind: "anyref" } }];
  fn.body = body;
}

/**
 * Names of the object-runtime host imports that `ensureObjectRuntime` provides
 * Wasm-native implementations for. `ensureLateImport` routes these here under
 * `ctx.standalone` (mirrors `UNION_NATIVE_HELPER_NAMES` for the #1471 boxing
 * helpers) so existing call sites resolve to the native func with no per-site
 * change. Internal helpers (`__obj_hash`, `__obj_find`, `__obj_insert`,
 * `__obj_grow`) are NOT in this set — they are never requested via
 * `ensureLateImport`.
 */
export const OBJECT_RUNTIME_HELPER_NAMES: ReadonlySet<string> = new Set([
  "__new_plain_object",
  "__extern_is_array",
  "__extern_get",
  "__extern_set",
  "__reflect_set",
  "__to_primitive",
  "__extern_toString",
  "__delete_property",
  // #1472 Phase B Blocker B — native $ObjVec-backed enumeration + indexed read.
  "__object_keys",
  "__extern_length",
  "__extern_get_idx",
  // #1472 Phase B Slice 3 — remaining enumeration / indexed-access / assign.
  "__object_values",
  "__object_entries",
  "__extern_has_idx",
  "__object_assign",
  // #1472 Phase B Blocker A Half 1 (PR #1074) — object integrity predicates.
  "__object_isFrozen",
  "__object_isSealed",
  "__object_isExtensible",
  // #1472 Phase B Blocker A Half 2 — object integrity SET path.
  "__object_preventExtensions",
  "__object_seal",
  "__object_freeze",
  // #1629 S6 — native data-descriptor define (Object.defineProperty /
  // Reflect.defineProperty with a { value, writable?, enumerable?, configurable? }
  // descriptor).
  "__defineProperty_value",
  // #1888 Slice 5 — native accessor-descriptor STORE ({ get?, set? }): stores
  // the boxed getter/setter into $PropEntry.$get/$set + FLAG_ACCESSOR.
  "__defineProperty_accessor",
  // #1906 — native Object.defineProperties dynamic fallback for `$Object`
  // descriptor maps. Gathers/validates enumerable descriptor records first,
  // then applies them through __defineProperty_value/accessor.
  "__defineProperties",
  // #1888 Slice 5 — native getOwnPropertyDescriptor: reads the $PropEntry back
  // and builds a descriptor `$Object` (accessor → { get, set, enumerable,
  // configurable }, data → { value, writable, enumerable, configurable };
  // missing own prop / non-$Object receiver → undefined). RUNTIME-LAYER
  // GROUNDWORK: both this and __defineProperty_accessor are not yet reached
  // end-to-end under standalone — the accessor define call-site compiles
  // getter/setter via the __make_getter_callback JS bridge, and that call-site
  // routing (host-free closures → __defineProperty_accessor) plus live get/set
  // invocation are #329-gated follow-ups. Landing the helpers + the R3
  // $PropEntry $get/$set layout now de-risks the layout change in isolation.
  "__getOwnPropertyDescriptor",
  // #1472 Phase C — `x === undefined` / default-parameter / destructuring-default
  // undefinedness check. Native impl is `ref.is_null` (standalone conflates
  // undefined and null, same as __typeof_undefined). This is the single largest
  // remaining standalone-refusal helper (~6.6k tests).
  "__extern_is_undefined",
  // #1472 Phase C — own-property presence (Object.prototype.hasOwnProperty /
  // Object.hasOwn) over the $Object hash-map via __obj_find; keyed HasProperty
  // (`key in obj`) over own + prototype chain via a proto-walk mirroring
  // __extern_get.
  "__hasOwnProperty",
  "__object_hasOwn",
  "__extern_has",
  // #1472 Phase C — prototype-chain ops over $Object.$proto (field 0):
  // getPrototypeOf / Object.create / isPrototypeOf.
  "__getPrototypeOf",
  "__object_create",
  "__isPrototypeOf",
  // #1888 Slice 7 — Object.setPrototypeOf writes $Object.$proto (field 0) after
  // the §10.1.2.1 OrdinarySetPrototypeOf extensibility + cycle checks. Routed
  // here so the standalone call site reaches the native helper instead of the
  // proto-dropping stub. (GC/host keeps the stub — see the calls.ts dual-mode
  // gate.)
  "__object_setPrototypeOf",
  // #1888 Slice 2 — open-`any` method dispatch `recv.m(args)`. Native arm
  // (__extern_method_call → __extern_get + __apply_closure arity bridge). The
  // closure round-trips through __extern_set/__extern_get as a ref.test-able
  // wrapper (#1226 typeof recognition + closureInfoByTypeIdx self-reg), so
  // routing native is a correct answer, not a silent undefined.
  "__extern_method_call",
]);
