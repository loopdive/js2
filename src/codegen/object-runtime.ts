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
import type { FieldDef, Instr, ValType } from "../ir/types.js";
import type { CodegenContext } from "./context/types.js";
import {
  ensureAnyToStringHelper,
  ensureNativeStringHelpers,
  nativeStringLiteralInstrs,
  stringConstantExternrefInstrs,
} from "./native-strings.js";
import { emitNativeNumberFormat } from "./number-format-native.js";
import { emitWasiErrorConstructor } from "./registry/error-types.js";
import { addStringConstantGlobal, ensureExnTag } from "./registry/imports.js";
import { addFuncType, getArrTypeIdxFromVec, getOrRegisterVecBaseType } from "./registry/types.js";
import { addUnionImportsViaRegistry, flushLateImportShifts } from "./shared.js";
import { reserveAccessorGetDriver, reserveAccessorSetDriver } from "./accessor-driver.js";
import { ensureSymbolCarrier } from "./symbol-native.js";
import { reserveArrayToPrimitiveString } from "./array-to-primitive.js";
import { UNDEF_F64_BITS } from "./value-tags.js";
// (#2106 S1) function-level-only cycle with any-helpers.ts (which imports
// ensureObjectRuntime) — same tolerated shape as native-strings ↔ any-helpers.
import { buildIsUndefinedExternBody, undefinedExternInstrs, undefinedSingletonActive } from "./any-helpers.js";
import { reserveClassToPrimitive } from "./class-to-primitive.js";
import { definedFuncAt, mintDefinedFunc, pushDefinedFunc } from "./func-space.js"; // (#1916 S2/S3) positional-read chokepoint + stable-regime minting

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
// #1910/#1472 S2 — internal-slot marker. Set on the single reserved $PropEntry a
// boxed primitive wrapper (`new Number`/`new String`/`new Boolean`) carries: it
// holds the wrapper's [[NumberData]]/[[StringData]]/[[BooleanData]] primitive
// under WRAPPER_PRIMITIVE_KEY. The entry is NON-enumerable (FLAG_INTERNAL is set,
// FLAG_ENUMERABLE is not), so it never appears in Object.keys/for-in/JSON, and
// `__to_primitive` reads it FIRST (before the OrdinaryToPrimitive valueOf/toString
// probe) per §7.1.1.1 — standalone ships no Number.prototype.valueOf, so the slot
// IS the recoverable internal value. 0x20/0x40 remain free.
export const FLAG_INTERNAL = 0x10;
const FLAG_TOMBSTONE = 0x80;
/**
 * Reserved own-key under which a boxed primitive wrapper stores its internal
 * `[[PrimitiveValue]]` slot (#1910/#1472 S2). Uses the spec internal-slot
 * spelling so it cannot collide with an ordinary identifier-shaped key created
 * by user code in any realistic program; the entry is additionally flagged
 * FLAG_INTERNAL so even an explicit `o["[[PrimitiveValue]]"]` user write is
 * distinguishable, and it is non-enumerable so enumeration never observes it.
 */
export const WRAPPER_PRIMITIVE_KEY = "[[PrimitiveValue]]";
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
  /** (#1100) `$ProxyTraps` struct — 4 funcref fields (get/set/has/apply) for the
   *  standalone Proxy meta-object Phase 1. Null fields forward to the ordinary
   *  [[Get]]/[[Set]]/[[Has]]/[[Call]] on the target. */
  proxyTrapsTypeIdx: number;
  /** (#1100) `$Proxy` struct — subtype of `$Object` carrying the proxy tag,
   *  target, handler, traps, and revoked bit. A proxy IS-A object, so every
   *  `ref.test $Object` still matches it. */
  proxyTypeIdx: number;
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

  // #2036 — the array-like `$Object` arms in __extern_length / __extern_get_idx /
  // __extern_has_idx need (a) `number_toString` to ToString a numeric index into
  // its canonical decimal key, and (b) `__unbox_number` to ToLength the stored
  // `length` value. Gate on standalone: in gc/host mode this runtime is also
  // pulled in (Object.keys etc.) but the host `__extern_*` JS imports own the
  // array-like read path, so registering these helpers there would only shift
  // funcMap indices and risk breaking existing references — the $Object arms are
  // skipped in gc mode (see `withObjectArrayLikeArms` below). Both helpers are
  // DEFINED funcs in standalone (no import added → no funcIdx shift) and
  // idempotent. Register BEFORE the helper bodies bake their `call` funcIdx.
  // (`number_toString` also upgrades __extern_toString's boxed-number arm from
  // "[object Object]" to the real decimal, which is spec-correct.)
  const objArrayLikeArms = ctx.standalone;
  if (objArrayLikeArms) {
    emitNativeNumberFormat(ctx, new Set(["number_toString"]));
    addUnionImportsViaRegistry(ctx);
  }

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const nativeStrTypeIdx = ctx.nativeStrTypeIdx;
  const strDataTypeIdx = ctx.nativeStrDataTypeIdx;

  // (#2866) Register the native `$Symbol` carrier struct + `__box_symbol` builder
  // so the `$Object` property key channel can hold a Symbol key (`o[sym] = v`).
  // The carrier struct's type index drives the `ref.test $Symbol` discriminators
  // in `__obj_hash`/`__key_equals`/`__obj_ordered`. Gated on no-JS-host mode: in
  // gc/host mode this native object runtime is not used (host `env::__extern_*`
  // imports own the dynamic property path), so the carrier is never needed there.
  // `symbolTypeIdx` stays -1 when not registered, and every symbol branch below
  // is guarded on `symbolKeysEnabled` (idx >= 0) so the string-only key path is
  // byte-unchanged when symbols are absent from the type space.
  const symbolTypeIdx = ctx.standalone || ctx.wasi ? ensureSymbolCarrier(ctx) : -1;
  const symbolKeysEnabled = symbolTypeIdx >= 0;

  // --- 1. Register the three struct/array types. ---
  const propEntryTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$PropEntry",
    fields: [
      // (#2866) `key` is `anyref`, not `(ref $AnyString)`: the open-object key
      // channel now holds EITHER a native string key ($AnyString) OR a native
      // `$Symbol` carrier (for `o[sym] = v`). Readers discriminate with
      // `ref.test $AnyString` / `ref.test $Symbol`; the hash + equality
      // (`__obj_hash`/`__key_equals`) branch on the key kind. `anyref` (not
      // `eqref`) keeps storage free — the converted search key (`any.convert_extern`
      // → anyref) and a `(ref $AnyString)`/`(ref $Symbol)` both widen to it with no
      // cast — and symbol identity is decided by the i32 `$id`, not `ref.eq`, so
      // `eqref` is unnecessary. String-only programs are behaviour-identical; the
      // few string readers add a `ref.cast $AnyString` (always succeeds).
      { name: "key", type: { kind: "anyref" }, mutable: false },
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
  const objectFields: FieldDef[] = [
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
  ];
  // `$Object` is a plain (final) struct. NOTE (#1100): an earlier attempt made
  // this a NON-FINAL `sub` so the standalone `$Proxy` could extend it, but
  // opening `$Object` up triggered WasmGC iso-recursive canonicalization
  // (#2009): the now-open single-shape struct merged with another module type,
  // so a baked `struct.new`/index resolved to a wrong-arity type and
  // `__new_plain_object` failed to validate ("not enough arguments on the stack
  // for drop"). Same canonicalization hazard as #2158. So `$Object` stays
  // closed and `$Proxy` is a STANDALONE struct (below), discriminated by its own
  // `ref.test $Proxy` ahead of the ordinary `ref.cast $Object` path — the
  // front-guards already test `$Proxy` first, so a proxy never reaches the
  // `$Object` cast.
  ctx.mod.types.push({
    kind: "struct",
    name: "$Object",
    fields: objectFields,
  });

  // $ObjVec backing array: (array (mut externref)) — holds enumeration results
  // (keys/values/entries) as boxed externrefs. Separate from the closed-shape
  // __vec_externref/__arr_externref the array literal path uses, so this runtime
  // owns its own type and never collides with shifted indices there.
  //
  // (#2026 #53) ADOPT the eagerly-reserved `$ObjVecArr` slot when present
  // (`reserveObjVecArrType`, called up-front for class-bearing sources): the
  // dynamic-`new` runtime-argv path references this type from a function body,
  // so its index must be stable across the type prefix. Minting it here lazily
  // when this runtime is first pulled in would land it at a pass-dependent index
  // (the #2043 / subview type-idx-stability hazard). Fall back to registering it
  // now when no reservation exists (the common Object.keys/values path).
  let objVecArrTypeIdx: number;
  if (ctx.reservedObjVecArrTypeIdx !== undefined) {
    objVecArrTypeIdx = ctx.reservedObjVecArrTypeIdx;
  } else {
    objVecArrTypeIdx = ctx.mod.types.length;
    ctx.mod.types.push({
      kind: "array",
      name: "$ObjVecArr",
      element: { kind: "externref" },
      mutable: true,
    });
  }

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

  // (#1100/#1355) `$ProxyTraps` — trap fields for the standalone Proxy. A null
  // field means "no trap" → forward to the ordinary operation on the proxy
  // target. The fields hold the user trap handler as an **externref closure**
  // (the boxed closure-wrapper struct produced by every compiled function
  // expression), NOT a bare funcref: a user trap `(t,k,r) => …` lowers to a GC
  // closure struct whose own funcref takes the closure-self as arg0, so it cannot
  // be `call_ref`-ed with `(target,key,receiver)` directly. Traps are invoked
  // through the existing closure-call bridge (`__apply_closure`, the same path
  // accessors use) which threads `this` and the closure-self correctly — see
  // `ensureProxyRuntime` / `fillProxyDispatch`. This is the architect's "reuse
  // the closure→funcref bridge, don't invent a calling convention" requirement.
  //
  // (#1355) APPEND new trap fields after the #1100 base four (get/set/has/apply);
  // never renumber the base — the dispatch helpers and `__proxy_create` bake the
  // field indices. `deleteProperty` is field index 4.
  const proxyTrapsTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$ProxyTraps",
    fields: [
      { name: "get", type: { kind: "externref" }, mutable: false },
      { name: "set", type: { kind: "externref" }, mutable: false },
      { name: "has", type: { kind: "externref" }, mutable: false },
      { name: "apply", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice A) deleteProperty — field index 4.
      { name: "deleteProperty", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice B) getOwnPropertyDescriptor — field index 5.
      { name: "getOwnPropertyDescriptor", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice C) getPrototypeOf — field index 6.
      { name: "getPrototypeOf", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice C) setPrototypeOf — field index 7.
      { name: "setPrototypeOf", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice D) isExtensible — field index 8.
      { name: "isExtensible", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice D) preventExtensions — field index 9.
      { name: "preventExtensions", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice E) ownKeys — field index 10. §10.5.11 [[OwnPropertyKeys]].
      { name: "ownKeys", type: { kind: "externref" }, mutable: false },
      // (#1355 Slice F) defineProperty — field index 11. §10.5.6 [[DefineOwnProperty]].
      { name: "defineProperty", type: { kind: "externref" }, mutable: false },
    ],
  });

  // (#1100) `$Proxy` — a STANDALONE struct (NOT a subtype of `$Object`; see the
  // canonicalization note on `$Object` above). A proxy is discriminated by its
  // own `ref.test $Proxy`, emitted by the `__extern_get/set/has` front-guards
  // AHEAD of the ordinary `ref.cast $Object`, so the proxy never flows down the
  // plain-object path and does not need to carry `$Object`'s fields. Fields:
  //   0 ptag      i32           PROXY_TAG marker (the bare ref.test is the real
  //                             discriminator; kept for symmetry with #1325)
  //   1 ptarget   anyref(mut)   wrapped target (any value)
  //   2 phandler  anyref(mut)   handler object — trap `this` (§10.5.x)
  //   3 ptraps    ref null …    the 4 trap closures
  //   4 revoked   i32(mut)      revocation bit
  const proxyTypeIdx = ctx.mod.types.length;
  ctx.mod.types.push({
    kind: "struct",
    name: "$Proxy",
    fields: [
      { name: "ptag", type: { kind: "i32" }, mutable: false },
      { name: "ptarget", type: { kind: "anyref" }, mutable: true },
      { name: "phandler", type: { kind: "anyref" }, mutable: true },
      { name: "ptraps", type: { kind: "ref_null", typeIdx: proxyTrapsTypeIdx }, mutable: true },
      { name: "revoked", type: { kind: "i32" }, mutable: true },
    ],
  });

  const types: ObjectRuntimeTypes = {
    propEntryTypeIdx,
    propMapTypeIdx,
    objectTypeIdx,
    objVecTypeIdx,
    objVecArrTypeIdx,
    proxyTrapsTypeIdx,
    proxyTypeIdx,
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
    const funcIdx = mintDefinedFunc(ctx);
    ctx.funcMap.set(name, funcIdx);
    pushDefinedFunc(ctx, funcIdx, { name, typeIdx, locals, body, exported: false });
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

  // ── (#2896) Reserved builtin-fn metadata natives (standalone only) ────────
  //
  // Builtin function values (the per-(builtin, member) closure meta subtypes —
  // see builtin-fn-meta.ts) answer their spec `name`/`length` own properties at
  // RUNTIME through these four helpers. They are REGISTERED here with valid
  // constant default bodies (so a module with no builtin closures is
  // unaffected), and their `ref.test <metaType>` arms are SPLICED IN AT
  // FINALIZE by `fillBuiltinFnMeta` once every meta type is known — the same
  // reserve/fill discipline as `__extern_is_array` above. The reflective
  // consumers below (`__extern_get` / `__hasOwnProperty` /
  // `__getOwnPropertyDescriptor` / `__getOwnPropertyNames` /
  // `__delete_property`) bake eager `call`s to these funcIdxs at their own
  // registration, keeping the late-import shift invariant intact.
  //
  //   __builtinfn_get_meta(v, key)  -> externref   name string / boxed length,
  //                                                 null when not a builtin fn,
  //                                                 not "name"/"length", or the
  //                                                 property was deleted.
  //   __builtinfn_gopd(v, key)      -> externref   full data descriptor
  //                                                 ({writable:false,
  //                                                 enumerable:false,
  //                                                 configurable:true}) or null.
  //   __builtinfn_delete(v, key)    -> i32          1 = handled (deleted-bit
  //                                                 set on the instance).
  //   __builtinfn_push_ownnames(v, vec) -> i32      1 = v is a builtin fn (its
  //                                                 undeleted own names were
  //                                                 pushed into vec).
  //
  // Gated on ctx.standalone: in gc/host mode this runtime is also pulled in
  // (Object.keys etc.) but builtin function values are host objects there — the
  // host imports own their metadata, and registering these would only shift
  // funcMap indices (gc bytes must stay unchanged).
  const bfnMetaLocals = [
    { name: "any", type: { kind: "anyref" } as ValType },
    { name: "fkey", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } as ValType },
    { name: "isName", type: { kind: "i32" } as ValType },
    { name: "isLen", type: { kind: "i32" } as ValType },
  ];
  if (ctx.standalone) {
    registerNative(
      "__builtinfn_get_meta",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      bfnMetaLocals,
      [{ op: "ref.null.extern" } as Instr],
    );
    registerNative(
      "__builtinfn_gopd",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [{ name: "v", type: { kind: "externref" } as ValType }],
      [{ op: "ref.null.extern" } as Instr],
    );
    registerNative(
      "__builtinfn_delete",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      bfnMetaLocals,
      [{ op: "i32.const", value: 0 } as Instr],
    );
    registerNative(
      "__builtinfn_push_ownnames",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [{ name: "any", type: { kind: "anyref" } as ValType }],
      [{ op: "i32.const", value: 0 } as Instr],
    );
  }
  const bfnGetMetaIdx = ctx.standalone ? ctx.funcMap.get("__builtinfn_get_meta") : undefined;
  const bfnGopdIdx = ctx.standalone ? ctx.funcMap.get("__builtinfn_gopd") : undefined;
  const bfnDeleteIdx = ctx.standalone ? ctx.funcMap.get("__builtinfn_delete") : undefined;
  const bfnPushOwnNamesIdx = ctx.standalone ? ctx.funcMap.get("__builtinfn_push_ownnames") : undefined;

  // #2042 R2 — held reference to `__to_property_key`'s body so the object-key
  // arm can be spliced in after `__extern_toString` is registered later in this
  // pass (forward dependency; see the splice below the `__extern_toString` reg).
  let tpkBodyRef: Instr[] | undefined;

  // ── __to_property_key(externref key) -> externref (#2042 S1) ──────────────
  //
  // Central ToPropertyKey-style coercion for the string-keyed `$Object` runtime.
  // The downstream `ref.cast $AnyString` in `__obj_hash` / `__obj_find` traps
  // (`illegal cast [in __obj_find()]`) for any non-string key — every computed
  // numeric access (`o[0]`, `Reflect.get(o, 1)`, descriptor reflection) feeds a
  // boxed number straight into that cast. Coercing once here, at the top of both
  // hash + find, makes the cast always safe without patching each public entry
  // (`__extern_get`/`_set`/`_has`/`__getOwnPropertyDescriptor`/`__delete_property`).
  //
  //   - already an `$AnyString` (cons or flat) → return unchanged (fast path).
  //   - a boxed number → `number_toString(__unbox_number(key))` → canonical
  //     decimal `$NativeString` ("0"/"1.5"/"-0"→"0" per §6.1.6.1.20), matching
  //     `{0:x}` literal-key storage and host behaviour.
  //   - else (Symbol / opaque) → return unchanged: the downstream behaviour is
  //     unchanged for those keys (no NEW trap introduced), while the dominant
  //     numeric + string cases are fixed. Symbol keys under the string-keyed
  //     runtime stay a separate concern (#1472 Phase B refusal at compile time).
  //
  // standalone-only: in gc/host mode the host `__extern_*` JS imports own these
  // paths and ToPropertyKey the key themselves, so registering this helper there
  // would only shift funcMap indices — host output stays byte-identical.
  if (ctx.standalone) {
    const numToStringIdx = ctx.funcMap.get("number_toString")!;
    const unboxNumberIdx = ctx.funcMap.get("__unbox_number")!;
    const boxNumTypeIdx = ctx.nativeBoxNumberTypeIdx;
    const tpkBody: Instr[] = [
      // any = any.convert_extern(key)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 1 },
      // if (ref.test $AnyString any) return key unchanged
      { op: "ref.test", typeIdx: anyStrTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // else if (boxed number) return number_toString(__unbox_number(key))
      ...(boxNumTypeIdx >= 0
        ? ([
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: boxNumTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 0 },
                { op: "call", funcIdx: unboxNumberIdx },
                { op: "call", funcIdx: numToStringIdx },
                { op: "return" },
              ],
            },
          ] as Instr[])
        : []),
      // #2042 R2 — object-key arm. A computed access with an OBJECT key
      // (`obj[{valueOf:()=>2}]`) reaches here as a `$Object` externref; the
      // downstream `ref.cast $AnyString` in `__obj_find`/`__obj_hash` then traps
      // ("illegal cast"). Run the object through `__extern_toString` (§7.1.1
      // ToPrimitive(string) → ToString — the same canonical ToString used by
      // `String(x)` / template literals), yielding the canonical string key.
      // `__extern_toString` is registered LATER in this same `ensureObjectRuntime`
      // pass, so the call is spliced in below once its funcIdx is known (the body
      // array is held by reference in `mod.functions`). The splice goes BEFORE
      // the unchanged-fallthrough so non-object opaque keys (Symbols) still
      // pass through untouched.
      // <<R2-OBJECT-ARM-SPLICE>>
      // else return key unchanged (Symbol / opaque — preserve existing behaviour)
      { op: "local.get", index: 0 },
    ];
    registerNative(
      "__to_property_key",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [{ name: "any", type: { kind: "anyref" } }],
      tpkBody,
    );
    // Record the splice point: index of the trailing `local.get 0` fallthrough.
    // After `__extern_toString` registers we insert the `$Object`-key arm here.
    tpkBodyRef = tpkBody;
  }
  const toPropertyKeyIdx = ctx.funcMap.get("__to_property_key");

  // Prepend, in standalone mode, a guarded ToPropertyKey coercion to a key-taking
  // helper body so its downstream `ref.cast $AnyString` is always safe. No-op in
  // gc/host mode (the host imports own the path → byte-identical output).
  // The coercion is itself guarded (`__to_property_key` fast-returns an
  // already-$AnyString key) so the common string-key path pays one `ref.test`.
  const withKeyCoercion = (keyParamIdx: number, body: Instr[]): Instr[] =>
    toPropertyKeyIdx === undefined
      ? body
      : [
          { op: "local.get", index: keyParamIdx } as Instr,
          { op: "call", funcIdx: toPropertyKeyIdx } as Instr,
          { op: "local.set", index: keyParamIdx } as Instr,
          ...body,
        ];

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
      // (#2866) keyAny = any.convert_extern(key). A Symbol key hashes by its i32
      // identity id (consistent with `__key_equals`'s id-compare); a string key
      // takes the FNV-1a path below. The two hash spaces may collide — open
      // addressing resolves any collision via `__key_equals`, so that is benign.
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 7 },
      ...(symbolKeysEnabled
        ? ([
            { op: "ref.test", typeIdx: symbolTypeIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "local.get", index: 7 },
                { op: "ref.cast", typeIdx: symbolTypeIdx },
                { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 }, // $Symbol.id
                { op: "i32.const", value: 0x7fffffff },
                { op: "i32.and" },
                { op: "return" },
              ],
            },
          ] as Instr[])
        : []),
      // str = flatten(cast<$AnyString>(keyAny))
      { op: "local.get", index: 7 },
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
        { name: "keyAny", type: { kind: "anyref" } }, // (#2866) index 7
      ],
      // #2042 S1 — coerce a non-string key (boxed number) to its canonical
      // string before the FNV walk's `ref.cast $AnyString`. key is param 0.
      withKeyCoercion(0, body),
    );
  }
  const objHashIdx = ctx.funcMap.get("__obj_hash")!;

  // ── __key_equals(anyref storedKey, i32 searchIsSym, i32 searchSymId,
  //                ref_null $NativeString fkey) -> i32  (#2866) ───────────────
  //
  // Unified property-key equality over the widened (anyref) `$PropEntry.key`
  // channel. The caller classifies the SEARCH key ONCE (`searchIsSym` +
  // `searchSymId` for a Symbol, or the pre-flattened `fkey` for a string) so the
  // per-probe cost stays a single `__str_equals` on the string hot path — exactly
  // the pre-#2866 work — plus one `ref.test` to reject a cross-kind collision.
  //
  //   - searching for a Symbol: match iff storedKey is a `$Symbol` whose `$id`
  //     equals `searchSymId` (identity by id; no interning needed).
  //   - searching for a string: match iff storedKey is an `$AnyString` whose
  //     flattened content equals `fkey` (`__str_equals`). A `$Symbol` stored key
  //     fails the `ref.test $AnyString` and is skipped (cross-kind keys collide
  //     in the table only by hash, never by equality).
  if (symbolKeysEnabled) {
    const keyEqualsBody: Instr[] = [
      { op: "local.get", index: 1 }, // searchIsSym
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // symbol search: ref.test $Symbol(storedKey) && id == searchSymId
          { op: "local.get", index: 0 },
          { op: "ref.test", typeIdx: symbolTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: 0 },
              { op: "ref.cast", typeIdx: symbolTypeIdx },
              { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 },
              { op: "local.get", index: 2 }, // searchSymId
              { op: "i32.eq" },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ],
        else: [
          // string search: ref.test $AnyString(storedKey) && str_equals(flatten(storedKey), fkey)
          { op: "local.get", index: 0 },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [
              { op: "local.get", index: 0 },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "call", funcIdx: strFlattenIdx },
              { op: "local.get", index: 3 }, // fkey (ref_null $NativeString)
              { op: "ref.as_non_null" },
              { op: "call", funcIdx: strEqualsIdx },
            ],
            else: [{ op: "i32.const", value: 0 }],
          },
        ],
      },
    ];
    registerNative(
      "__key_equals",
      [{ kind: "anyref" }, { kind: "i32" }, { kind: "i32" }, { kind: "ref_null", typeIdx: nativeStrTypeIdx }],
      [{ kind: "i32" }],
      [],
      keyEqualsBody,
    );
  }
  const keyEqualsIdx = symbolKeysEnabled ? ctx.funcMap.get("__key_equals")! : -1;

  // (#2866) Classify a search key (an externref param) into scratch locals:
  //   searchAny  (anyref)               — the converted key; ALSO the value to
  //                                       STORE into `$PropEntry.key` (preserves
  //                                       Symbol identity in the table).
  //   searchIsSym(i32)                  — 1 iff the key is a `$Symbol`.
  //   searchSymId(i32)                  — the `$Symbol.$id` when a symbol.
  //   fkey       (ref_null $NativeString) — the flattened string key (null when a
  //                                       symbol) — the hot-path `__str_equals` rhs.
  const emitClassifyKey = (
    keyParamIdx: number,
    searchAnyLocal: number,
    isSymLocal: number,
    symIdLocal: number,
    fkeyLocal: number,
  ): Instr[] => [
    { op: "local.get", index: keyParamIdx },
    { op: "any.convert_extern" },
    { op: "local.set", index: searchAnyLocal },
    ...(symbolKeysEnabled
      ? ([
          { op: "local.get", index: searchAnyLocal },
          { op: "ref.test", typeIdx: symbolTypeIdx },
          { op: "local.tee", index: isSymLocal },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: searchAnyLocal },
              { op: "ref.cast", typeIdx: symbolTypeIdx },
              { op: "struct.get", typeIdx: symbolTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: symIdLocal },
              { op: "ref.null", typeIdx: nativeStrTypeIdx },
              { op: "local.set", index: fkeyLocal },
            ],
            else: [
              { op: "local.get", index: searchAnyLocal },
              { op: "ref.cast", typeIdx: anyStrTypeIdx },
              { op: "call", funcIdx: strFlattenIdx },
              { op: "local.set", index: fkeyLocal },
            ],
          },
        ] as Instr[])
      : ([
          { op: "i32.const", value: 0 },
          { op: "local.set", index: isSymLocal },
          { op: "local.get", index: searchAnyLocal },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          { op: "local.set", index: fkeyLocal },
        ] as Instr[])),
  ];

  // (#2866) Leave an i32 (1/0) on the stack: does `entryLocal`'s (non-null) key
  // match the classified search key? Routes through `__key_equals` when symbol
  // keys are in play; a `ref.cast $AnyString` string-only path otherwise.
  const emitKeyMatch = (entryLocal: number, isSymLocal: number, symIdLocal: number, fkeyLocal: number): Instr[] =>
    symbolKeysEnabled
      ? [
          { op: "local.get", index: entryLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
          { op: "local.get", index: isSymLocal },
          { op: "local.get", index: symIdLocal },
          { op: "local.get", index: fkeyLocal },
          { op: "call", funcIdx: keyEqualsIdx },
        ]
      : [
          { op: "local.get", index: entryLocal },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          { op: "local.get", index: fkeyLocal },
          { op: "ref.as_non_null" },
          { op: "call", funcIdx: strEqualsIdx },
        ];

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
      // (#2866) classify the search key → searchAny(8)/isSym(9)/symId(10)/fkey(7)
      ...emitClassifyKey(1, 8, 9, 10, 7),
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
              // if !(e.flags & TOMBSTONE) && key_match(e.key) → return e  (#2866)
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
                  ...emitKeyMatch(6, 9, 10, 7),
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
        // (#2866) fkey is now NULLABLE — null for a Symbol search key.
        { name: "fkey", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } },
        { name: "searchAny", type: { kind: "anyref" } }, // 8
        { name: "searchIsSym", type: { kind: "i32" } }, // 9
        { name: "searchSymId", type: { kind: "i32" } }, // 10
      ],
      // #2042 S1 — coerce a non-string key (boxed number) to its canonical
      // string before the `ref.cast $AnyString` flatten + the inner __obj_hash
      // call. key is param 1 (param 0 is the $Object). The inner __obj_hash
      // re-coercion is idempotent (the key is now an $AnyString → fast-return).
      withKeyCoercion(1, body),
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
    // (#2106 S1) Under the `undefinedSingleton` regime a MISSING property read
    // answers the extern-wrapped tag-1 `$undefined` singleton — the value JS
    // semantics require (`({}).x === undefined` true, destructuring/param
    // defaults fire) — while a stored JS `null` still reads back as
    // `ref.null.extern`. Legacy (flag off): miss = `ref.null.extern`,
    // byte-identical. This is the producer half of the lockstep flip whose
    // absence caused PR #2025's −1245 (consumer flipped, producer not).
    // A FACTORY, not a shared array — the miss appears in three branches and
    // shared Instr objects get double-remapped by finalize walks (see
    // `reference_shared_instr_object_dce_double_remap`).
    const getMiss = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } as Instr];
    const body: Instr[] = [
      // (#2896) Builtin-fn metadata arm: `fn[key]` for key "name"/"length" on a
      // builtin function value answers its spec metadata (host-free). Non-meta
      // receivers/keys fall through unchanged (the helper returns null).
      ...(bfnGetMetaIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: bfnGetMetaIdx },
            { op: "local.tee", index: 6 },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 6 }, { op: "return" }],
            },
          ] as Instr[])
        : []),
      // any = any.convert_extern(obj)
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: 4 },
      // if !ref.test $Object → not one of our objects → miss (undefined)
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [...getMiss(), { op: "return" } as Instr],
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
                      // if getter == null → return undefined (§6.2.5.5 step 3)
                      { op: "ref.is_null" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [...getMiss(), { op: "return" } as Instr],
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
      // not found anywhere → miss (undefined under the S1 regime; legacy null)
      ...getMiss(),
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
        { name: "bfmeta", type: { kind: "externref" } }, // (#2896) builtin-fn meta
      ],
      body,
    );
  }

  // (#2106 S1, flag-only) __extern_is_nullish(externref) -> i32 — "null OR
  // undefined". Under the singleton regime a bare `ref.is_null` no longer
  // catches undefined (a non-null singleton), so every NULLISH-intent absence
  // check in the native runtime (missing-method / to-primitive / iterator
  // lookups, the loose `== null` guard) routes through this instead. Body is
  // self-contained (inline tag-1 ∨ UNDEF-box test, NOT a call into
  // `__extern_is_undefined`, which registers later) so it can be baked into
  // any subsequently-built native body. Registered ONLY under the flag so
  // legacy modules stay byte-identical.
  {
    const s1IsUndefTail = buildIsUndefinedExternBody(ctx, 1, UNDEF_F64_BITS);
    if (undefinedSingletonActive(ctx) && s1IsUndefTail !== undefined) {
      const isNullishIdx = registerNative(
        "__extern_is_nullish",
        [{ kind: "externref" }],
        [{ kind: "i32" }],
        [{ name: "any", type: { kind: "anyref" } }],
        [
          { op: "local.get", index: 0 },
          { op: "ref.is_null" },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 1 }],
            else: s1IsUndefTail,
          } as Instr,
        ],
      );
      // (#2106 S1, flag-only) __nullish_to_null(externref) -> externref —
      // canonicalize nullish (null OR the undefined singleton OR the UNDEF-box)
      // back to `ref.null.extern`. INTERNAL runtime lookups whose result feeds
      // null-keyed control logic (to-primitive valueOf/toString resolution,
      // proxy trap reads, descriptor field reads, method resolution, groupBy
      // presence checks) append ONE call to this after `__extern_get`, keeping
      // their entire downstream absence logic byte-identical to legacy instead
      // of widening every `ref.is_null` in place. JS-VISIBLE reads do NOT
      // normalize — they want the singleton.
      registerNative(
        "__nullish_to_null",
        [{ kind: "externref" }],
        [{ kind: "externref" }],
        [],
        [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: isNullishIdx } as Instr,
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "externref" } },
            then: [{ op: "ref.null.extern" }],
            else: [{ op: "local.get", index: 0 }],
          } as Instr,
        ],
      );
    }
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
      // (#2866) classify the search key → searchAny(12)/isSym(13)/symId(14)/fkey(10).
      // searchAny is the raw converted key (string OR $Symbol) — it is what gets
      // STORED into `$PropEntry.key`, preserving Symbol identity in the table.
      ...emitClassifyKey(1, 12, 13, 14, 10),
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
                  // arr[i] = struct.new $PropEntry { searchAny, value, flags, seq,
                  //                                   get=null, set=null }  (#2866:
                  //   store the raw converted key — $AnyString or $Symbol)
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 8 },
                  { op: "local.get", index: 12 },
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
              // occupied + LIVE + key matches → update in place  (#2866 key_match)
              ...emitKeyMatch(9, 13, 14, 10),
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
        // (#2866) fkey nullable (null for a Symbol key); keyStr retired (the raw
        // converted key in `searchAny` is stored directly).
        { name: "fkey", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } },
        { name: "keyStr", type: { kind: "ref_null", typeIdx: anyStrTypeIdx } },
        { name: "searchAny", type: { kind: "anyref" } }, // 12
        { name: "searchIsSym", type: { kind: "i32" } }, // 13
        { name: "searchSymId", type: { kind: "i32" } }, // 14
      ],
      // #2042 S1 — coerce a non-string key (boxed number) to its canonical
      // string before the `ref.cast $AnyString` that both flattens it for the
      // probe AND is stored into `$PropEntry.key`. So `o[0] = v` stores key "0"
      // (matching the literal `{0:v}` path and the find-side coercion). key is
      // param 1; the inner __obj_hash re-coercion is idempotent.
      withKeyCoercion(1, body),
    );
  }
  const objInsertIdx = ctx.funcMap.get("__obj_insert")!;

  // ── Boxed primitive wrappers (#1910/#1472 S2) ────────────────────────────
  //
  // `new Number(x)` / `new String(x)` / `new Boolean(x)` produce a wrapper
  // OBJECT (typeof === "object"), not a primitive. In standalone mode there is
  // no JS host to satisfy the `env::__new_Number` import that the gc path uses,
  // so we build the wrapper as a plain `$Object` carrying the internal
  // [[NumberData]]/[[StringData]]/[[BooleanData]] slot under the reserved,
  // non-enumerable WRAPPER_PRIMITIVE_KEY entry. Because the wrapper IS a
  // `$Object`, ordinary member access (`w.toString`, `w.constructor`, future
  // indexed reads) keeps flowing through __extern_get/__obj_find unchanged, and
  // `__to_primitive` recovers the primitive by reading this slot first
  // (§7.1.1.1 — the wrapper's intrinsic valueOf returns the internal slot).
  //
  // All three take an ALREADY-boxed primitive externref in local `valueLocal` and
  // emit the shared wrapper-build tail: create the `$Object`, insert the internal
  // slot (key + FLAG_INTERNAL, non-enumerable) into `objLocal`, and return the
  // wrapper as externref. The slot encoding lives in exactly one place. The
  // wrapper's INITIAL_CAP (8) table holds one entry without any grow, so
  // __obj_insert is called directly.
  const emitWrapperBuildTail = (valueLocal: number, objLocal: number): Instr[] => [
    // o = new $Object { proto: null, props: $PropMap[INITIAL_CAP], 0,0,0, nextSeq=1 }
    { op: "ref.null", typeIdx: objectTypeIdx }, // proto
    { op: "i32.const", value: INITIAL_CAP },
    { op: "array.new_default", typeIdx: propMapTypeIdx },
    { op: "i32.const", value: 0 }, // count
    { op: "i32.const", value: 0 }, // tombstones
    { op: "i32.const", value: 0 }, // flags
    { op: "i32.const", value: 1 }, // nextSeq (slot consumes seq 0)
    { op: "struct.new", typeIdx: objectTypeIdx },
    { op: "local.set", index: objLocal },
    // __obj_insert(o, WRAPPER_PRIMITIVE_KEY, any.convert_extern(value),
    //              FLAG_INTERNAL (non-enumerable), seq=0)
    { op: "local.get", index: objLocal },
    ...((): Instr[] => {
      addStringConstantGlobal(ctx, WRAPPER_PRIMITIVE_KEY);
      return stringConstantExternrefInstrs(ctx, WRAPPER_PRIMITIVE_KEY);
    })(),
    { op: "local.get", index: valueLocal },
    { op: "any.convert_extern" },
    { op: "i32.const", value: FLAG_INTERNAL },
    { op: "i32.const", value: 0 }, // seq
    { op: "call", funcIdx: objInsertIdx },
    // return extern.convert_any(o)
    { op: "local.get", index: objLocal },
    { op: "extern.convert_any" },
  ];

  // __new_Number(f64) -> externref : box the number, then wrap.
  {
    addUnionImportsViaRegistry(ctx);
    const boxNumIdx = ctx.funcMap.get("__box_number")!;
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: boxNumIdx }, // boxed number externref
      { op: "local.set", index: 1 },
      ...emitWrapperBuildTail(1, 2),
    ];
    registerNative(
      "__new_Number",
      [{ kind: "f64" }],
      [{ kind: "externref" }],
      [
        { name: "boxed", type: { kind: "externref" } },
        { name: "o", type: objRef },
      ],
      body,
    );
  }

  // __new_String(externref) -> externref : the value is already a string
  // externref; wrap it directly (param 0 is the value local).
  {
    const body: Instr[] = emitWrapperBuildTail(0, 1);
    registerNative(
      "__new_String",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [{ name: "o", type: objRef }],
      body,
    );
  }

  // __new_Boolean(f64) -> externref : ToBoolean(arg) — the call sites coerce the
  // argument to f64; truthy iff (x != 0) && (x == x) (NaN is falsy). Box the
  // i32 boolean, then wrap.
  {
    addUnionImportsViaRegistry(ctx);
    const boxBoolIdx = ctx.funcMap.get("__box_boolean")!;
    const body: Instr[] = [
      // truthy = (arg != 0) & (arg == arg)
      { op: "local.get", index: 0 },
      { op: "f64.const", value: 0 },
      { op: "f64.ne" },
      { op: "local.get", index: 0 },
      { op: "local.get", index: 0 },
      { op: "f64.eq" }, // 0 when NaN, 1 otherwise
      { op: "i32.and" },
      { op: "call", funcIdx: boxBoolIdx }, // boxed boolean externref
      { op: "local.set", index: 1 },
      ...emitWrapperBuildTail(1, 2),
    ];
    registerNative(
      "__new_Boolean",
      [{ kind: "f64" }],
      [{ kind: "externref" }],
      [
        { name: "boxed", type: { kind: "externref" } },
        { name: "o", type: objRef },
      ],
      body,
    );
  }

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
    const externSetIdx = registerNative(
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
    // (#2017) Standalone alias: the strict [[Set]] host import maps to the same
    // native data-write helper. The native runtime has no host TypeError bridge
    // yet (see __reflect_set note), so a getter-only write degrades to the
    // existing native behaviour rather than throwing — host (JS) mode carries
    // the spec-correct catchable TypeError. Aliasing keeps standalone
    // accessor-literal writes compiling unchanged (no refused import).
    ctx.funcMap.set("__extern_set_strict", externSetIdx);
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
      // (#2896) Builtin-fn metadata arm: `delete fn.name` / `delete fn.length`
      // on a builtin function value marks the instance's deleted bit (the
      // properties are configurable, §10.2.9) and reports success. Other
      // receivers/keys fall through (the helper returns 0).
      ...(bfnDeleteIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: bfnDeleteIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 1 }, { op: "return" }],
            },
          ] as Instr[])
        : []),
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
      // (#2896) Builtin-fn metadata arm: name/length are OWN properties of a
      // builtin function value (until deleted). get_meta returns non-null
      // exactly when the own property exists.
      ...(bfnGetMetaIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: bfnGetMetaIdx },
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "i32.const", value: 1 }, { op: "return" }],
            },
          ] as Instr[])
        : []),
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

  // ── __propertyIsEnumerable(externref obj, externref key) -> i32 (#2541) ─────
  //
  // ES §20.1.3.4 Object.prototype.propertyIsEnumerable: OWN-property presence
  // (NO prototype walk) AND the own property's [[Enumerable]] attribute. Same
  // __obj_find own-only lookup as __hasOwnProperty, then test the found entry's
  // FLAG_ENUMERABLE bit. Missing own property / non-$Object receiver → false.
  // This replaces the standalone #1472-Phase-B refusal with a native lowering
  // over the same $Object/$PropEntry runtime; host mode keeps its JS import.
  {
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
      // e = __obj_find(cast<$Object>(any), key)  (local 3)
      { op: "local.get", index: 2 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 3 },
      // if e == null → 0 (no own property)
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [{ op: "i32.const", value: 0 }, { op: "return" }],
      },
      // return (e.flags & FLAG_ENUMERABLE) != 0
      { op: "local.get", index: 3 },
      { op: "ref.as_non_null" },
      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
      { op: "i32.const", value: FLAG_ENUMERABLE },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
    ];
    registerNative(
      "__propertyIsEnumerable",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "e", type: entryRefNull },
      ],
      body,
    );
  }

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
    // (#2358 #10) Standalone Array → primitive. A real array (a `__vec_<k>`
    // struct subtyping `$__vec_base`) is NOT a `$Object`, so the
    // `ref.test objectTypeIdx` arm below misses it and ToPrimitive would return
    // the array unchanged → `__unbox_number(array)` → NaN. Reduce it via
    // `Array.prototype.toString` (`join(",")`) instead. The join helper depends
    // on `__extern_length`/`__extern_get_idx`, which are registered AFTER
    // `__to_primitive`, so we reserve the placeholder here (stable call target)
    // and fill it in post-processing. `$__vec_base` is the shared supertype with
    // `length` at field 0 (#2186) — one `ref.test` detects every element kind.
    const arrayLikeReduce = ctx.standalone;
    const vecBaseTypeIdx = arrayLikeReduce ? getOrRegisterVecBaseType(ctx) : -1;
    const arrayToPrimIdx = arrayLikeReduce ? reserveArrayToPrimitiveString(ctx) : -1;
    // (#2638) Standalone CLASS-instance → primitive. A nominal class struct is
    // neither `$Object` nor `$Vec`, so the `ref.test objectTypeIdx` arm below
    // misses it and ToPrimitive returns the struct unchanged → `__unbox_number`
    // → NaN. Route it through the per-struct `__call_valueOf`/`__call_toString`
    // dispatchers (§7.1.1.1) via the reserved `__class_to_primitive` driver. The
    // dispatchers are emitted at FINALIZE (after `__to_primitive`), so we reserve
    // the placeholder here (stable call target) and fill it post-processing
    // (`fillClassToPrimitive`, after `emitToPrimitiveMethodExports`). Same
    // reserve/fill funcIdx discipline as `arrayToPrimIdx`.
    const classToPrimIdx = arrayLikeReduce ? reserveClassToPrimitive(ctx) : -1;
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
    // #1910/#1472 S2 — the boxed-primitive internal-slot $PropEntry (or null).
    const L_SLOT = 5;

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

    // (#2106 S1) Normalize the method lookup back to the legacy null-keyed
    // convention: under the singleton regime a MISSING valueOf/toString comes
    // back as the non-null `$undefined` singleton, which the `ref.is_null`
    // absence check below would treat as a callable method — the exact source
    // of PR #2025's 948 "Cannot convert object to primitive value" CEs.
    const s1ToPrimNorm: Instr[] = (() => {
      const idx = ctx.funcMap.get("__nullish_to_null");
      return idx !== undefined ? [{ op: "call", funcIdx: idx } as Instr] : [];
    })();
    const tryOrdinaryMethod = (name: "valueOf" | "toString", defaultObjectToStringOnMissing: boolean): Instr[] => [
      { op: "local.get", index: 0 },
      ...stringExtern(name),
      { op: "call", funcIdx: externGetIdx },
      ...s1ToPrimNorm.map((i) => ({ ...i }) as Instr),
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
        then:
          arrayLikeReduce && vecBaseTypeIdx >= 0 && arrayToPrimIdx >= 0
            ? [
                // (#2358 #10) A real array (`$__vec_base`) reduces to its
                // Array.prototype.toString (`join(",")`) — a primitive string the
                // caller's hint then coerces (`__str_to_number` / string concat).
                { op: "local.get", index: L_ANY },
                { op: "ref.test", typeIdx: vecBaseTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "empty" },
                  then: [{ op: "local.get", index: 0 }, { op: "call", funcIdx: arrayToPrimIdx }, { op: "return" }],
                } as Instr,
                // (#2638) A nominal CLASS instance is neither `$Object` nor `$Vec`.
                // Route it through `__class_to_primitive(obj, stringHint)`, which
                // calls the per-struct `__call_valueOf`/`__call_toString`
                // dispatchers per §7.1.1.1 and returns a boxed primitive on a
                // method match, or the input unchanged otherwise. If the driver
                // produced a primitive (the class had valueOf/toString), return
                // it; else fall through to "return unchanged" (a struct/closure
                // with no user ToPrimitive — today's behaviour, no regression).
                ...(classToPrimIdx >= 0
                  ? [
                      { op: "local.get", index: 0 } as Instr,
                      ...isStringHint,
                      { op: "call", funcIdx: classToPrimIdx } as Instr,
                      { op: "local.set", index: L_RESULT } as Instr,
                      ...returnIfPrimitive(L_RESULT),
                    ]
                  : []),
                // Any other non-$Object value (a struct/closure without a user
                // ToPrimitive) returns unchanged as before.
                { op: "local.get", index: 0 },
                { op: "return" },
              ]
            : [{ op: "local.get", index: 0 }, { op: "return" }],
      },
      // #1910/#1472 S2 — boxed primitive wrapper short-circuit. A `new Number`/
      // `new String`/`new Boolean` wrapper carries its [[PrimitiveValue]] in the
      // reserved, FLAG_INTERNAL own-slot. §7.1.1.1: the wrapper's intrinsic
      // valueOf/toString return that internal primitive, so when the slot exists
      // we return it directly (BEFORE the ordinary valueOf/toString own-prop
      // probe) — the slot value is already a primitive, and the caller applies the
      // final ToNumber/ToString per its hint. Plain objects lack this slot, so
      // __obj_find returns null and we fall through to OrdinaryToPrimitive.
      { op: "local.get", index: L_ANY },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      ...stringExtern(WRAPPER_PRIMITIVE_KEY),
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: L_SLOT },
      { op: "ref.is_null" },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // entry present — confirm it is the internal slot (FLAG_INTERNAL), then
          // return extern.convert_any(entry.value).
          { op: "local.get", index: L_SLOT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 }, // flags
          { op: "i32.const", value: FLAG_INTERNAL },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: L_SLOT },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value (anyref)
              { op: "extern.convert_any" },
              { op: "return" },
            ],
          } as Instr,
        ],
      } as Instr,
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
        { name: "slot", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
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
        // (#2106 S1) under the singleton regime a null externref IS JS null →
        // ToString = "null" (§7.1.17). Legacy keeps the null pass-through
        // (downstream __any_to_string renders its residual arm).
        then: undefinedSingletonActive(ctx) ? [...stringExtern("null")] : [{ op: "ref.null.extern" } as Instr],
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

    // #2042 R2 / #2985 — now that `__extern_toString` exists, splice the
    // non-Symbol ToString arm into `__to_property_key`'s body (built earlier,
    // before this funcIdx was known). By this point the key is neither an
    // `$AnyString` nor a boxed number (both returned already). For EVERY
    // remaining non-Symbol key — `$Object`, boolean, bigint, null/undefined,
    // any other opaque primitive — ToPropertyKey = ToString(ToPrimitive(key,
    // "string")), exactly `__extern_toString` (§7.1.1.1 → §7.1.17). Originally
    // this arm only tested `$Object`, so a boolean/bigint/etc. computed key
    // (`o[true]`, `Object.defineProperty(o, true, …)`) fell through UNCHANGED
    // and then hit the downstream `ref.cast $AnyString` in
    // `emitClassifyKey`/`__obj_hash`, trapping "illegal cast [in __obj_find()]"
    // (#2985 residual). Broadening the test from "is `$Object`" to "is NOT a
    // Symbol" canonicalises those keys instead. A genuine Symbol still falls
    // through to the trailing `local.get 0` unchanged (Symbols are looked up by
    // identity via `__key_equals`, not by string cast). When symbol keys are
    // disabled there are no Symbol keys, so the ToString applies unconditionally.
    if (tpkBodyRef !== undefined) {
      const externToStringIdx = ctx.funcMap.get("__extern_toString")!;
      const toStringArm: Instr[] = [
        { op: "local.get", index: 0 },
        { op: "call", funcIdx: externToStringIdx },
        { op: "return" },
      ];
      const nonSymbolToStringArm: Instr[] = symbolKeysEnabled
        ? [
            // if (!ref.test $Symbol any) return __extern_toString(key)
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: symbolTypeIdx },
            { op: "i32.eqz" },
            { op: "if", blockType: { kind: "empty" }, then: toStringArm } as Instr,
          ]
        : // no Symbol keys in play → ToString every remaining key unconditionally
          toStringArm;
      // Splice before the last instruction (the unchanged-key fallthrough, which
      // now only serves genuine Symbol keys under symbolKeysEnabled).
      tpkBodyRef.splice(tpkBodyRef.length - 1, 0, ...nonSymbolToStringArm);
    }
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
      // (#2866) key is anyref; entries reaching here are pre-filtered to string
      // keys (the compaction pass excludes `$Symbol` keys), so this cast is safe.
      { op: "ref.cast", typeIdx: anyStrTypeIdx },
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
    // #2042 S3 — factory so `__obj_ordered` keeps the enumerable filter
    // (Object.keys/values/entries) while sibling `__obj_ordered_all` drops it
    // (Object.getOwnPropertyNames needs non-enumerable own string keys too).
    // Each registration gets a FRESH body + locals array — `registerNative`
    // stores the locals array by reference and a later lowering pass may mutate
    // it, so the two functions must not share one (that cross-corrupted both).
    const buildOrderedBody = (includeNonEnum: boolean): Instr[] => [
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
                  // (not tombstone) [&& enumerable, unless includeNonEnum]
                  { op: "local.get", index: 4 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_TOMBSTONE },
                  { op: "i32.and" },
                  { op: "i32.eqz" },
                  // enumerable check — omitted for __obj_ordered_all (#2042 S3)
                  ...(includeNonEnum
                    ? []
                    : ([
                        { op: "local.get", index: 4 },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                        { op: "i32.const", value: FLAG_ENUMERABLE },
                        { op: "i32.and" },
                        { op: "i32.eqz" },
                        { op: "i32.eqz" },
                        { op: "i32.and" },
                      ] as Instr[])),
                  // (#2866) AND is-string-key: exclude `$Symbol` keys from the
                  // string-key enumeration order (Object.keys/values/entries/
                  // getOwnPropertyNames/for-in/JSON — §10.1.11.1 lists string keys
                  // here; symbols come only from getOwnPropertySymbols).
                  ...(symbolKeysEnabled
                    ? ([
                        { op: "local.get", index: 4 },
                        { op: "ref.as_non_null" },
                        { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                        { op: "ref.test", typeIdx: anyStrTypeIdx },
                        { op: "i32.and" },
                      ] as Instr[])
                    : []),
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
    // Fresh locals array per registration (registerNative stores it by reference).
    const makeOrderedLocals = (): { name: string; type: ValType }[] => [
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
    ];
    // __obj_ordered — live + enumerable (Object.keys/values/entries).
    registerNative("__obj_ordered", [objRef], [propMapRef], makeOrderedLocals(), buildOrderedBody(false));
    // __obj_ordered_all — live, INCLUDING non-enumerable (#2042 S3,
    // Object.getOwnPropertyNames). Same ordering + sort; enumerable filter off.
    registerNative("__obj_ordered_all", [objRef], [propMapRef], makeOrderedLocals(), buildOrderedBody(true));

    // (#2866 slice 3) __obj_ordered_symbols — the SELECT counterpart to the
    // string-key exclusion above: collect this object's LIVE own SYMBOL-keyed
    // entries (INCLUDING non-enumerable ones — Object.getOwnPropertySymbols
    // returns own symbol keys regardless of enumerability, §20.5.2.9) into a
    // compacted $PropMap in insertion order. Symbol keys are never integer
    // indices and never interleave with string keys, so OrdinaryOwnPropertyKeys
    // order among symbols is purely creation order (`$PropEntry.seq` ascending) —
    // a plain seq selection sort, with NO `entryIndexOf` (its `ref.cast
    // $AnyString` would trap on a `$Symbol` key).
    //
    // param: 0=o(ref $Object) ; locals (reuse makeOrderedLocals): 1=arr 2=cap 3=i
    //   4=e 5=out 6=m 7=j 8=best 9=k 10=cand 11=bestE 15=bestSeq 14=candSeq 16=tmp
    const buildOrderedSymbolsBody = (): Instr[] => [
      // arr = o.props ; cap = arr.len
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 1 },
      { op: "local.tee", index: 1 },
      { op: "array.len" },
      { op: "local.set", index: 2 },
      // out = new $PropMap[o.count] (upper bound; trailing slots stay null)
      { op: "local.get", index: 0 },
      { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 2 },
      { op: "array.new_default", typeIdx: propMapTypeIdx },
      { op: "local.set", index: 5 },
      // m = 0 ; i = 0 — first pass: compact live symbol-keyed entries into out
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
                  // !tombstone
                  { op: "local.get", index: 4 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
                  { op: "i32.const", value: FLAG_TOMBSTONE },
                  { op: "i32.and" },
                  { op: "i32.eqz" },
                  // && ref.test $Symbol(key) — SELECT only symbol keys
                  { op: "local.get", index: 4 },
                  { op: "ref.as_non_null" },
                  { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                  { op: "ref.test", typeIdx: symbolTypeIdx },
                  { op: "i32.and" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
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
      // Second pass: selection sort out[0..m) by seq ascending (insertion order).
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
              { op: "local.get", index: 7 },
              { op: "local.get", index: 6 },
              { op: "i32.ge_u" },
              { op: "br_if", depth: 1 },
              // best = j ; bestE = out[j] ; bestSeq = bestE.seq
              { op: "local.get", index: 7 },
              { op: "local.set", index: 8 },
              { op: "local.get", index: 5 },
              { op: "local.get", index: 7 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.set", index: 11 },
              { op: "local.get", index: 11 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 3 },
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
                      // cand = out[k] ; candSeq = cand.seq
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 9 },
                      { op: "array.get", typeIdx: propMapTypeIdx },
                      { op: "local.set", index: 10 },
                      { op: "local.get", index: 10 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 3 },
                      { op: "local.set", index: 14 },
                      // if candSeq < bestSeq → best = k, bestSeq = candSeq, bestE = cand
                      { op: "local.get", index: 14 },
                      { op: "local.get", index: 15 },
                      { op: "i32.lt_s" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 9 },
                          { op: "local.set", index: 8 },
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
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 7 },
                  { op: "array.get", typeIdx: propMapTypeIdx },
                  { op: "local.set", index: 16 },
                  { op: "local.get", index: 5 },
                  { op: "local.get", index: 7 },
                  { op: "local.get", index: 11 },
                  { op: "array.set", typeIdx: propMapTypeIdx },
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
    if (symbolKeysEnabled) {
      registerNative("__obj_ordered_symbols", [objRef], [propMapRef], makeOrderedLocals(), buildOrderedSymbolsBody());
    }
    void entryRef;
  }
  const objOrderedIdx = ctx.funcMap.get("__obj_ordered")!;
  const objOrderedAllIdx = ctx.funcMap.get("__obj_ordered_all")!;

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

  // ── __object_keys_forin(externref obj) -> externref ──────────────────────
  //
  // #2964 — for-in enumeration over a dynamic `$Object`, INCLUDING inherited
  // enumerable string keys from the prototype chain (§14.7.5.9
  // EnumerateObjectProperties). `__object_keys` above is OWN-only (Object.keys
  // semantics); for-in must additionally walk `$proto` links and, at each
  // level, yield the enumerable own keys that are NOT shadowed by a
  // closer-level own property (enumerable OR non-enumerable — a non-enumerable
  // own property still shadows an inherited same-named key).
  //
  // Algorithm (per level, receiver → proto → …, until $proto is null):
  //   1. enumerable own keys (`__obj_ordered`, OrdinaryOwnPropertyKeys order —
  //      integer-index ascending then insertion order, #1837): yield each key
  //      not already in the `seen` set.
  //   2. ALL own keys (`__obj_ordered_all`, incl. non-enumerable): add each to
  //      `seen` so it shadows the same name at lower (proto) levels.
  // The `seen` set is a fresh empty `$Object` (null $proto) used purely as a
  // membership table via `__extern_has`/`__extern_set` — this reuses the exact
  // key hashing + equality the property map uses, so there is no native-string
  // representation mismatch. `__extern_has` proto-walks, but `seen`'s $proto is
  // null so it degenerates to an own-property check.
  //
  // params: 0=obj(externref)
  // locals: 1=any(anyref) 2=cur(ref null $Object) 3=arr(ref null $PropMap)
  //         4=cap(i32) 5=i(i32) 6=e(ref null $PropEntry) 7=vec(externref result)
  //         8=seen(externref scratch $Object) 9=keyExt(externref)
  {
    const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;
    const externHasIdx = ctx.funcMap.get("__extern_has")!;
    const externSetIdx = ctx.funcMap.get("__extern_set")!;
    const body: Instr[] = [
      // vec = __objvec_new() ; seen = __new_plain_object()
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 8 },
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
      // cur = cast<$Object>(any)
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.set", index: 2 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              // if cur == null break out of levels
              { op: "local.get", index: 2 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              // ---- yield enumerable own keys not already seen ----
              // arr = __obj_ordered(cur) ; cap = arr.len ; i = 0
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
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
                      // if i >= cap break
                      { op: "local.get", index: 5 },
                      { op: "local.get", index: 4 },
                      { op: "i32.ge_s" },
                      { op: "br_if", depth: 1 },
                      // e = arr[i] ; compacted — stop at first null
                      { op: "local.get", index: 3 },
                      { op: "ref.as_non_null" },
                      { op: "local.get", index: 5 },
                      { op: "array.get", typeIdx: propMapTypeIdx },
                      { op: "local.tee", index: 6 },
                      { op: "ref.is_null" },
                      { op: "br_if", depth: 1 },
                      // keyExt = extern.convert_any(e.key)
                      { op: "local.get", index: 6 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                      { op: "extern.convert_any" },
                      { op: "local.set", index: 9 },
                      // if __extern_has(seen, keyExt) == 0 → __objvec_push(vec, keyExt)
                      { op: "local.get", index: 8 },
                      { op: "local.get", index: 9 },
                      { op: "call", funcIdx: externHasIdx },
                      { op: "i32.eqz" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 7 },
                          { op: "local.get", index: 9 },
                          { op: "call", funcIdx: objVecPushIdx },
                        ],
                      },
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
              // ---- mark ALL own keys (incl. non-enumerable) into `seen` ----
              // arr = __obj_ordered_all(cur) ; cap = arr.len ; i = 0
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "call", funcIdx: objOrderedAllIdx },
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
                      { op: "local.get", index: 3 },
                      { op: "ref.as_non_null" },
                      { op: "local.get", index: 5 },
                      { op: "array.get", typeIdx: propMapTypeIdx },
                      { op: "local.tee", index: 6 },
                      { op: "ref.is_null" },
                      { op: "br_if", depth: 1 },
                      { op: "local.get", index: 6 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
                      { op: "extern.convert_any" },
                      { op: "local.set", index: 9 },
                      // if !__extern_has(seen, keyExt) → __extern_set(seen, keyExt, keyExt)
                      { op: "local.get", index: 8 },
                      { op: "local.get", index: 9 },
                      { op: "call", funcIdx: externHasIdx },
                      { op: "i32.eqz" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: [
                          { op: "local.get", index: 8 },
                          { op: "local.get", index: 9 },
                          { op: "local.get", index: 9 },
                          { op: "call", funcIdx: externSetIdx },
                        ],
                      },
                      { op: "local.get", index: 5 },
                      { op: "i32.const", value: 1 },
                      { op: "i32.add" },
                      { op: "local.set", index: 5 },
                      { op: "br", depth: 0 },
                    ],
                  },
                ],
              },
              // cur = cur.$proto ; loop
              { op: "local.get", index: 2 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 0 },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      // return vec
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__object_keys_forin",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "cur", type: objRefNull },
        { name: "arr", type: propMapRef },
        { name: "cap", type: { kind: "i32" } },
        { name: "i", type: { kind: "i32" } },
        { name: "e", type: entryRefNull },
        { name: "vec", type: { kind: "externref" } },
        { name: "seen", type: { kind: "externref" } },
        { name: "keyExt", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __extern_length(externref v) -> f64 ──────────────────────────────────
  //
  // Standalone numeric "length". Recognises a wrapped $ObjVec (enumeration
  // result) and returns its f64 len. #2036: ALSO recognises a real array-like
  // `$Object` ({0:x, length:n}) — ToLength(Get(O, "length")) per §23.1.3 so
  // borrowed Array.prototype generics (`indexOf.call(arrayLike, …)`) iterate
  // correctly. Any other value returns 0 (matches the host import fallback).
  //
  // params: 0=v(externref) ; locals: 1=any(anyref) 2=lenF64(f64) 3=lenTrunc(f64)
  {
    const MAX_SAFE = 9007199254740991; // 2^53 - 1
    // #2036 — array-like $Object arm (standalone only): ToLength(Get(O,"length")).
    // In gc/host mode the host `__extern_length` JS import owns this path, so the
    // arm is omitted and the body stays the original $ObjVec-or-0 to keep host
    // output byte-identical.
    const objLengthArm: Instr[] = objArrayLikeArms
      ? (() => {
          const externGetIdx2036 = ctx.funcMap.get("__extern_get")!;
          const unboxIdx2036 = ctx.funcMap.get("__unbox_number")!;
          return [
            { op: "local.get", index: 1 },
            { op: "ref.test", typeIdx: objectTypeIdx },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "f64" } },
              then: [
                // lenVal = __extern_get(v, "length")  (proto-walk + marshaling)
                { op: "local.get", index: 0 },
                ...nativeStringLiteralInstrs(ctx, "length"),
                { op: "extern.convert_any" },
                { op: "call", funcIdx: externGetIdx2036 },
                // ToLength: unbox to number (NaN for non-number length), then
                // truncate + clamp to [0, 2^53-1]. __unbox_number(null) = NaN.
                { op: "call", funcIdx: unboxIdx2036 },
                { op: "local.tee", index: 2 },
                // if NaN → 0 (n != n)
                { op: "local.get", index: 2 },
                { op: "f64.ne" },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "f64" } },
                  then: [{ op: "f64.const", value: 0 }],
                  else: [
                    // trunc toward zero
                    { op: "local.get", index: 2 },
                    { op: "f64.trunc" },
                    { op: "local.tee", index: 3 },
                    // if <= 0 → 0
                    { op: "f64.const", value: 0 },
                    { op: "f64.le" },
                    {
                      op: "if",
                      blockType: { kind: "val", type: { kind: "f64" } },
                      then: [{ op: "f64.const", value: 0 }],
                      else: [
                        // min(trunc, 2^53-1)
                        { op: "local.get", index: 3 },
                        { op: "f64.const", value: MAX_SAFE },
                        { op: "f64.min" } as Instr,
                      ],
                    },
                  ],
                },
              ],
              else: [{ op: "f64.const", value: 0 }],
            },
          ] as Instr[];
        })()
      : [{ op: "f64.const", value: 0 }];
    // (#2186) `$__vec_base` arm: a real array literal / array result boxed to
    // externref is a `__vec_<elemKind>` struct subtyping `$__vec_base`. Its
    // length (field 0) is readable through the shared supertype regardless of
    // element kind — fixing `.length` === 0 for arrays read through the externref
    // boundary (e.g. `const a:any = [1,2,3]; a.length`). Checked BEFORE the
    // $ObjVec arm (a vec is not an $ObjVec). `objArrayLikeArms` (standalone) gates
    // this since host mode's `__extern_length` import owns the path.
    const vecBaseIdx = objArrayLikeArms ? getOrRegisterVecBaseType(ctx) : -1;
    const vecBaseArm: Instr[] = objArrayLikeArms
      ? [
          { op: "local.get", index: 1 },
          { op: "ref.test", typeIdx: vecBaseIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 },
              { op: "ref.cast", typeIdx: vecBaseIdx },
              { op: "struct.get", typeIdx: vecBaseIdx, fieldIdx: 0 },
              { op: "f64.convert_i32_s" },
              { op: "return" },
            ],
          } as Instr,
        ]
      : [];
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 1 },
      ...vecBaseArm,
      { op: "local.get", index: 1 },
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
        else: objLengthArm,
      },
    ];
    registerNative(
      "__extern_length",
      [{ kind: "externref" }],
      [{ kind: "f64" }],
      [
        { name: "any", type: { kind: "anyref" } },
        { name: "lenF64", type: { kind: "f64" } },
        { name: "lenTrunc", type: { kind: "f64" } },
      ],
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
    // The array-like `$Object` arm (#2036) + the $ObjVec/typed-vec arms are all
    // built by the shared `buildExternGetIdxBody` builder below — the `$Object`
    // arm returns `__extern_get(v, number_toString(idx))` (the canonical decimal
    // key, NOT a truncated one — see #2551). number_toString is canonical
    // Number::toString, matching how `{0:x}` stores numeric-literal keys.
    // (#2190) The per-element-kind `__vec_<k>` indexing arms are NOT known yet
    // (array literals of a given element kind may be compiled AFTER this
    // runtime is emitted). They are appended at FINALIZE by
    // `fillExternGetIdxVecArms` — which rebuilds this whole body via the shared
    // `buildExternGetIdxBody` builder with the now-complete carrier set. Here we
    // bake the body WITHOUT vec arms (empty list) and flag the reserve.
    const body = buildExternGetIdxBody({
      objArrayLikeArms,
      objectTypeIdx,
      objVecTypeIdx,
      objVecArrTypeIdx,
      numberToStringIdx: objArrayLikeArms ? ctx.funcMap.get("number_toString")! : -1,
      externGetIdx: objArrayLikeArms ? ctx.funcMap.get("__extern_get")! : -1,
      vecArms: [],
      // (#2106 S1) OOB / non-indexable miss = undefined under the singleton
      // regime (`arr[oob] === undefined`), consistent with the `$Object` arm
      // which delegates to the (flipped) `__extern_get`. Legacy: null.
      missInstrs: () => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } as Instr],
    });
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
    // Reserve the typed-vec fill only in standalone (host mode's `__extern_get_idx`
    // JS import owns the path; registering arms there would shift funcMap indices).
    if (objArrayLikeArms) ctx.externGetIdxReserved = true;
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
    // #2036 — array-like $Object arm (standalone only): HasProperty(O,
    // ToString(idx)) so indexOf/forEach hole-skipping (§23.1.3 "HasProperty") is
    // correct — __extern_has does the proto-walk; a present-but-undefined entry
    // returns true while an absent (hole) index returns false. Omitted in
    // gc/host mode (the host import owns the path).
    const objHasArm: Instr[] = objArrayLikeArms
      ? [
          { op: "local.get", index: 2 },
          { op: "ref.test", typeIdx: objectTypeIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 0 },
              { op: "local.get", index: 1 },
              { op: "f64.trunc" },
              { op: "call", funcIdx: ctx.funcMap.get("number_toString")! },
              { op: "call", funcIdx: ctx.funcMap.get("__extern_has")! },
              { op: "return" },
            ],
          },
        ]
      : [];
    const body: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "local.set", index: 2 },
      ...objHasArm,
      { op: "local.get", index: 2 },
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

  // ── __object_is(externref a, externref b) -> i32 (#2042 S3 — Object.is) ────
  //
  // SameValue (§7.2.10) over two boxed externrefs. Tag-dispatched like the
  // union-helper `===` lowering, but with the SameValue numeric rule:
  // NaN is SameValue NaN, and +0 is NOT SameValue -0. Comparing the f64 bit
  // patterns (`i64.reinterpret_f64` + `i64.eq`) gives exactly that — equal NaN
  // bit patterns compare equal, and +0 (0x0…) vs -0 (0x8000…) compare unequal.
  // boolean → unbox i32; bigint → i64; both-null → equal; else ref identity.
  //
  // HOST-FREE (`ctx.standalone || ctx.wasi`), NOT standalone-only (#2609). The
  // native `__defineProperty_value` block below is registered UNCONDITIONALLY by
  // this runtime and its #2042-S4 ValidateAndApplyPropertyDescriptor preflight
  // bakes a direct `call __object_is` for the SameValue value-change check. WASI
  // is host-free too (no JS `__object_is` import — `--target wasi` sets
  // `ctx.wasi` but leaves `ctx.standalone` false), so gating this registration on
  // `ctx.standalone` alone left `funcMap.get("__object_is")` undefined in WASI,
  // and the define helper baked an undefined funcIdx → "function index out of
  // range — undefined at __defineProperty_value" hard emit error (loopdive/js2#389).
  // The host-only path (`!ctx.standalone && !ctx.wasi`) still owns `__object_is`
  // via its JS import, so its output stays byte-identical.
  if (ctx.standalone || ctx.wasi) {
    addUnionImportsViaRegistry(ctx);
    const typeofNumIdx = ctx.funcMap.get("__typeof_number")!;
    const typeofBoolIdx = ctx.funcMap.get("__typeof_boolean")!;
    const typeofBigIdx = ctx.funcMap.get("__typeof_bigint")!;
    const unboxNumIdx = ctx.funcMap.get("__unbox_number")!;
    const unboxBoolIdx = ctx.funcMap.get("__unbox_boolean")!;
    const toBigIdx = ctx.funcMap.get("__to_bigint")!;
    const EQ_HEAP = -19; // WasmGC `eq` abstract heap type

    // params: a=0, b=1 ; locals: aa=2 (anyref), ba=3 (anyref)
    const bothTag = (tagIdx: number): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: tagIdx } as Instr,
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: tagIdx } as Instr,
      { op: "i32.and" },
    ];
    // Reference identity over the WasmGC `eq` heap (the anyref temps are already
    // materialised in locals 2/3 by `identityArm`'s preamble below).
    const refIdentityArm: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "ref.test", typeIdx: EQ_HEAP } as Instr,
      { op: "local.get", index: 3 },
      { op: "ref.test", typeIdx: EQ_HEAP } as Instr,
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: EQ_HEAP } as Instr,
          { op: "local.get", index: 3 },
          { op: "ref.cast", typeIdx: EQ_HEAP } as Instr,
          { op: "ref.eq" },
        ],
        else: [{ op: "i32.const", value: 0 }],
      } as Instr,
    ];
    // String SameValue = value equality (flatten both, __str_equals); else ref
    // identity. `__str_flatten`/`__str_equals` are resolved at the top of this
    // same `ensureObjectRuntime` pass (object-runtime helpers already call them,
    // e.g. __obj_hash/__obj_find), so the call indices are regime-consistent.
    const stringOrIdentityArm: Instr[] =
      strFlattenIdx !== undefined && strEqualsIdx !== undefined && anyStrTypeIdx >= 0
        ? [
            { op: "local.get", index: 2 },
            { op: "ref.test", typeIdx: anyStrTypeIdx } as Instr,
            { op: "local.get", index: 3 },
            { op: "ref.test", typeIdx: anyStrTypeIdx } as Instr,
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [
                { op: "local.get", index: 2 },
                { op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr,
                { op: "call", funcIdx: strFlattenIdx } as Instr,
                { op: "local.get", index: 3 },
                { op: "ref.cast", typeIdx: anyStrTypeIdx } as Instr,
                { op: "call", funcIdx: strFlattenIdx } as Instr,
                { op: "call", funcIdx: strEqualsIdx } as Instr,
              ],
              else: refIdentityArm,
            } as Instr,
          ]
        : refIdentityArm;
    const identityArm: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 2 },
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 3 },
      ...stringOrIdentityArm,
    ];
    const bigintArm = (elseArm: Instr[]): Instr[] => [
      ...bothTag(typeofBigIdx),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: toBigIdx } as Instr,
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: toBigIdx } as Instr,
          { op: "i64.eq" },
        ],
        else: elseArm,
      } as Instr,
    ];
    const boolArm = (elseArm: Instr[]): Instr[] => [
      ...bothTag(typeofBoolIdx),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: unboxBoolIdx } as Instr,
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: unboxBoolIdx } as Instr,
          { op: "i32.eq" },
        ],
        else: elseArm,
      } as Instr,
    ];
    const numberArm = (elseArm: Instr[]): Instr[] => [
      ...bothTag(typeofNumIdx),
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [
          // SameValue numbers: compare f64 bit patterns (NaN==NaN, +0!=-0).
          { op: "local.get", index: 0 },
          { op: "call", funcIdx: unboxNumIdx } as Instr,
          { op: "i64.reinterpret_f64" } as Instr,
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: unboxNumIdx } as Instr,
          { op: "i64.reinterpret_f64" } as Instr,
          { op: "i64.eq" },
        ],
        else: elseArm,
      } as Instr,
    ];
    const nullArm = (rest: Instr[]): Instr[] => [
      { op: "local.get", index: 0 },
      { op: "ref.is_null" },
      { op: "local.get", index: 1 },
      { op: "ref.is_null" },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "val", type: { kind: "i32" } },
        then: [{ op: "i32.const", value: 1 }],
        else: rest,
      } as Instr,
    ];
    registerNative(
      "__object_is",
      [{ kind: "externref" }, { kind: "externref" }],
      [{ kind: "i32" }],
      [
        { name: "aa", type: { kind: "anyref" } },
        { name: "ba", type: { kind: "anyref" } },
      ],
      nullArm(numberArm(boolArm(bigintArm(identityArm)))),
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
  //         10=e(ref null $PropEntry) 11=efl(i32)  — #2042 S4 ValidateAndApply
  {
    const NATIVE_ATTR_MASK = FLAG_WRITABLE | FLAG_ENUMERABLE | FLAG_CONFIGURABLE; // 0x07

    // #2042 S4 — ValidateAndApplyPropertyDescriptor (§10.1.6.3) preflight for the
    // DATA-descriptor define. The host flags f64 carries, beyond the value bits
    // 0/1/2, "specified" bits 3/4/5 and a hasValue bit 7 (see encoding comment
    // above), so we can tell which attributes the descriptor actually mentions —
    // exactly what the spec's "Desc has a [[X]] field" conditions need. We throw a
    // catchable TypeError (same exn-tag pattern as __defineProperties) instead of
    // silently inserting when a (re)definition is invalid. Defaults
    // (CompletePropertyDescriptor, §6.2.6.4) are already correct on insert.
    addUnionImportsViaRegistry(ctx);
    emitWasiErrorConstructor(ctx, "TypeError", 1);
    const s4TypeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
    const s4ExnTagIdx = ensureExnTag(ctx);
    const s4ObjectIsIdx = ctx.funcMap.get("__object_is")!;
    const HOST_WRITABLE_SPECIFIED = 1 << 3;
    const HOST_ENUMERABLE_SPECIFIED = 1 << 4;
    const HOST_CONFIGURABLE_SPECIFIED = 1 << 5;
    const HOST_HAS_VALUE = 1 << 7;
    const s4Throw = (message: string): Instr[] => {
      addStringConstantGlobal(ctx, message);
      return [
        ...stringConstantExternrefInstrs(ctx, message),
        { op: "call", funcIdx: s4TypeErrorCtorIdx },
        { op: "throw", tagIdx: s4ExnTagIdx } as Instr,
      ];
    };
    // `(hf & valueBit) != 0` as an i32 0/1.
    const hfBit = (bit: number): Instr[] => [
      { op: "local.get", index: 9 },
      { op: "i32.const", value: bit },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
    ];
    // `(efl & flagBit) != 0` as an i32 0/1 (existing entry's flag word, local 12).
    const eflBit = (bit: number): Instr[] => [
      { op: "local.get", index: 12 },
      { op: "i32.const", value: bit },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
    ];
    // The preflight body, emitted after `o` (local 4) and `hf` (local 9) are set,
    // before the grow/insert. §10.1.6.3 in spec order.
    const s4Preflight: Instr[] = [
      // e = __obj_find(o, key)  (local 11)
      { op: "local.get", index: 4 },
      { op: "ref.as_non_null" },
      { op: "local.get", index: 1 },
      { op: "call", funcIdx: objFindIdx },
      { op: "local.tee", index: 11 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        // current is undefined (new property): §10.1.6.3 step 2 — reject if the
        // object is non-extensible.
        then: [
          { op: "local.get", index: 4 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: objectTypeIdx, fieldIdx: 4 },
          { op: "i32.const", value: OBJ_FLAG_NONEXTENSIBLE },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: s4Throw("TypeError: Cannot define property, object is not extensible"),
          } as Instr,
        ],
        // current exists: §10.1.6.3 step 4 — if current is non-configurable, gate
        // the forbidden transitions.
        else: [
          // efl = e.flags  (local 12)
          { op: "local.get", index: 11 },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 },
          { op: "local.set", index: 12 },
          // if (efl & FLAG_CONFIGURABLE) == 0  → current is non-configurable
          ...eflBit(FLAG_CONFIGURABLE),
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // 4.a: Desc specifies configurable:true → reject.
              ...hfBit(HOST_CONFIGURABLE_SPECIFIED),
              ...hfBit(1 << 2), // configurable value bit
              { op: "i32.and" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: s4Throw(
                  "TypeError: Cannot redefine property: configurable attribute of a non-configurable property",
                ),
              } as Instr,
              // 4.b: Desc specifies enumerable that differs from current → reject.
              ...hfBit(HOST_ENUMERABLE_SPECIFIED),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...hfBit(1 << 1), // desc enumerable value
                  ...eflBit(FLAG_ENUMERABLE), // current enumerable
                  { op: "i32.ne" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: s4Throw(
                      "TypeError: Cannot redefine property: enumerable attribute of a non-configurable property",
                    ),
                  } as Instr,
                ],
              } as Instr,
              // 4.c: data↔accessor conversion. This is the DATA define path; if the
              // current entry is an accessor, converting it to data is forbidden.
              ...eflBit(FLAG_ACCESSOR),
              {
                op: "if",
                blockType: { kind: "empty" },
                then: s4Throw(
                  "TypeError: Cannot redefine property: cannot convert a non-configurable accessor to a data property",
                ),
              } as Instr,
              // 4.d: both data, current non-writable (FLAG_WRITABLE clear) → reject
              // a writable:true request OR a value change (SameValue).
              ...eflBit(FLAG_WRITABLE),
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  // writable false→true
                  ...hfBit(HOST_WRITABLE_SPECIFIED),
                  ...hfBit(1 << 0), // desc writable value
                  { op: "i32.and" },
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: s4Throw(
                      "TypeError: Cannot redefine property: writable attribute of a non-configurable, non-writable property",
                    ),
                  } as Instr,
                  // value change: Desc has a value (hasValue) AND
                  // !SameValue(descValue, e.value) → reject.
                  ...hfBit(HOST_HAS_VALUE),
                  {
                    op: "if",
                    blockType: { kind: "empty" },
                    then: [
                      // __object_is(descValue (param 2), e.value)
                      { op: "local.get", index: 2 },
                      { op: "local.get", index: 11 },
                      { op: "ref.as_non_null" },
                      { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
                      { op: "extern.convert_any" } as Instr,
                      { op: "call", funcIdx: s4ObjectIsIdx },
                      { op: "i32.eqz" },
                      {
                        op: "if",
                        blockType: { kind: "empty" },
                        then: s4Throw("TypeError: Cannot assign to read only property of a non-configurable property"),
                      } as Instr,
                    ],
                  } as Instr,
                ],
              } as Instr,
            ],
          } as Instr,
        ],
      } as Instr,
    ];

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
      // #2042 S4 — ValidateAndApplyPropertyDescriptor preflight (throws on an
      // invalid (re)definition before any table mutation).
      ...s4Preflight,
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
        { name: "e", type: entryRefNull }, // #2042 S4 — existing entry (local 11)
        { name: "efl", type: { kind: "i32" } }, // #2042 S4 — existing flags (local 12)
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
      // (#2106 S1) normalize missing/undefined descriptor fields back to the
      // legacy null convention so downstream null-keyed logic is unchanged.
      ...(ctx.funcMap.has("__nullish_to_null")
        ? [{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! } as Instr]
        : []),
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

  // ── __obj_define_from_desc (#1629b — native single dynamic-descriptor apply) ─
  //
  // `Object.defineProperty(obj, key, descVar)` where `descVar` is a runtime
  // value (not an inline `{...}` literal the compiler can statically expand).
  // The JS-host path routes to the `env::__defineProperty_desc` import; under
  // `--target standalone` there is no host, so this is the Wasm-native analogue
  // of host `_toPropertyDescriptorValidate` + apply (runtime.ts) over a
  // descriptor `$Object`. It mirrors EXACTLY the per-descriptor block in
  // `__defineProperties` above (same field reads, same conflict/callable
  // checks, same dispatch to `__defineProperty_value` / `__defineProperty_accessor`),
  // but for ONE (obj, key, desc) triple instead of a key-map.
  //
  // Spec: ES §6.2.5.6 ToPropertyDescriptor + §10.1.6.3 OrdinaryDefineOwnProperty.
  //   - non-object desc (here: not a standalone `$Object`) → TypeError §10.1.6.
  //     null/undefined desc → lenient empty-descriptor no-op (matches host
  //     leniency for absent struct reads; the call site already throws for a
  //     statically-non-object literal).
  //   - data (value|writable) + accessor (get|set) both present → TypeError.
  //   - get/set present and non-callable → TypeError.
  //
  // params: 0=obj(externref) 1=key(externref) 2=desc(externref)
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

    // Host value-bit flag layout decoded by __defineProperty_value / _accessor.
    const HOST_FLAG_WRITABLE = FLAG_WRITABLE; // bit 0
    const HOST_FLAG_ENUMERABLE = FLAG_ENUMERABLE; // bit 1
    const HOST_FLAG_CONFIGURABLE = FLAG_CONFIGURABLE; // bit 2
    // (#2989) "Desc has a [[X]] field" specified-bits + hasValue bit — the
    // §10.1.6.3 ValidateAndApplyPropertyDescriptor preflight in
    // `__defineProperty_value` gates every spec TypeError on THESE bits (a
    // configurable/enumerable/writable change is only forbidden when the Desc
    // actually *specifies* that attribute). The inline-literal fast path
    // (`computeRuntimeFlags`, object-ops.ts) sets them; this dynamic-descriptor
    // applier previously set only the value bits 0/1/2, so the preflight read
    // "no attribute specified / no value" for every field → it never threw and
    // an invalid redefine silently no-op'd (array length non-writable→writable,
    // non-configurable redefine, non-extensible new prop via a `var` descriptor).
    const HOST_WRITABLE_SPECIFIED = 1 << 3;
    const HOST_ENUMERABLE_SPECIFIED = 1 << 4;
    const HOST_CONFIGURABLE_SPECIFIED = 1 << 5;
    const HOST_HAS_VALUE = 1 << 7;

    const L_DESC = 3; // desc as externref (after $Object validation)
    const L_DESC_ANY = 4;
    const L_FLAGS = 5;
    const L_HAS_DATA = 6;
    const L_HAS_ACCESSOR = 7;
    const L_VALUE = 8;
    const L_GETTER = 9;
    const L_SETTER = 10;

    const keyRef = (key: string): Instr[] => [
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "extern.convert_any" } as Instr,
    ];
    const hasField = (key: string): Instr[] => [
      { op: "local.get", index: L_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: hasOwnIdx },
    ];
    const getField = (key: string): Instr[] => [
      { op: "local.get", index: L_DESC },
      ...keyRef(key),
      { op: "call", funcIdx: externGetIdx },
      // (#2106 S1) normalize missing/undefined descriptor fields back to the
      // legacy null convention so downstream null-keyed logic is unchanged.
      ...(ctx.funcMap.has("__nullish_to_null")
        ? [{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! } as Instr]
        : []),
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
    // ToBoolean(getField(key)) → set valueBit; always set hasData when marksData.
    // (#2989) When the field is present, ALSO set its "specified" bit so the
    // `__defineProperty_value` §10.1.6.3 preflight can gate the spec TypeErrors.
    const readBooleanFlag = (key: string, valueBit: number, marksData: boolean, specifiedBit: number): Instr[] => [
      ...hasField(key),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          ...setFlag(specifiedBit),
          ...(marksData
            ? ([
                { op: "i32.const", value: 1 },
                { op: "local.set", index: L_HAS_DATA },
              ] as Instr[])
            : []),
          ...getField(key),
          { op: "call", funcIdx: isTruthyIdx },
          { op: "if", blockType: { kind: "empty" }, then: setFlag(valueBit) } as Instr,
        ],
      } as Instr,
    ];
    // get/set: mark hasAccessor, capture the closure, and if non-null require callable.
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
                then: throwTypeError("TypeError: Getter/setter must be a function"),
              } as Instr,
            ],
          } as Instr,
        ],
      } as Instr,
    ];

    const body: Instr[] = [
      // desc null → empty-descriptor no-op, return obj.
      { op: "local.get", index: 2 },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: [{ op: "local.get", index: 0 }, { op: "return" }] },
      // desc must be a standalone $Object; otherwise TypeError (ToPropertyDescriptor §10.1.6).
      { op: "local.get", index: 2 },
      { op: "any.convert_extern" },
      { op: "local.tee", index: L_DESC_ANY },
      { op: "ref.test", typeIdx: objectTypeIdx },
      { op: "i32.eqz" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: throwTypeError("TypeError: Property description must be an object"),
      },
      { op: "local.get", index: 2 },
      { op: "local.set", index: L_DESC },

      // Reset accumulators.
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

      // value present → hasData + hasValue bit (#2989), capture value.
      ...hasField("value"),
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "i32.const", value: 1 },
          { op: "local.set", index: L_HAS_DATA },
          ...setFlag(HOST_HAS_VALUE),
          ...getField("value"),
          { op: "local.set", index: L_VALUE },
        ],
      },
      ...readBooleanFlag("writable", HOST_FLAG_WRITABLE, true, HOST_WRITABLE_SPECIFIED),
      ...readBooleanFlag("enumerable", HOST_FLAG_ENUMERABLE, false, HOST_ENUMERABLE_SPECIFIED),
      ...readBooleanFlag("configurable", HOST_FLAG_CONFIGURABLE, false, HOST_CONFIGURABLE_SPECIFIED),
      ...readAccessor("get", L_GETTER),
      ...readAccessor("set", L_SETTER),

      // data + accessor conflict → TypeError (§6.2.5.6 step 4).
      { op: "local.get", index: L_HAS_DATA },
      { op: "local.get", index: L_HAS_ACCESSOR },
      { op: "i32.and" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: throwTypeError(
          "TypeError: Invalid property descriptor. Cannot both specify accessors and a value or writable attribute",
        ),
      },

      // Apply: accessor → __defineProperty_accessor(obj, key, get, set, flags);
      //        data     → __defineProperty_value(obj, key, value, flags).
      { op: "local.get", index: L_HAS_ACCESSOR },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: L_GETTER },
          { op: "local.get", index: L_SETTER },
          { op: "local.get", index: L_FLAGS },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: defineAccessorIdx },
          { op: "drop" },
        ],
        else: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: L_VALUE },
          { op: "local.get", index: L_FLAGS },
          { op: "f64.convert_i32_s" },
          { op: "call", funcIdx: defineValueIdx },
          { op: "drop" },
        ],
      },
      { op: "local.get", index: 0 },
    ];

    registerNative(
      "__obj_define_from_desc",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "desc", type: { kind: "externref" } },
        { name: "descAny", type: { kind: "anyref" } },
        { name: "flags", type: { kind: "i32" } },
        { name: "hasData", type: { kind: "i32" } },
        { name: "hasAccessor", type: { kind: "i32" } },
        { name: "value", type: { kind: "externref" } },
        { name: "getter", type: { kind: "externref" } },
        { name: "setter", type: { kind: "externref" } },
      ],
      body,
    );
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
    const boxNumIdx = ctx.funcMap.get("__box_number")!;
    const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;

    // (#2987) String-wrapper exotic own-property synthesis. `new String("ab")`
    // is a `$Object` wrapper carrying its [[StringData]] native string in the
    // reserved FLAG_INTERNAL slot (#1910 S2). Its integer-index own properties
    // ("0".."n-1") and "length" are String-exotic (§10.4.3) and have NO ordinary
    // `$PropEntry`, so `__obj_find` misses them and gOPD returned `undefined`.
    // When the ordinary lookup misses we recover the slot string and synthesize
    // the spec descriptor: index → { value: char, writable:false, enumerable:true,
    // configurable:false }; "length" → { value: len, writable:false,
    // enumerable:false, configurable:false }. Standalone + nativeStrings only —
    // the gc/host lane keeps its host `getOwnPropertyDescriptor` (byte-inert).
    const charAtIdx = ctx.nativeStrHelpers.get("__str_charAt");
    const strExotic = ctx.standalone && ctx.nativeStrings && anyStrTypeIdx >= 0 && charAtIdx !== undefined;
    const stringExternG = (value: string): Instr[] => {
      addStringConstantGlobal(ctx, value);
      return stringConstantExternrefInstrs(ctx, value);
    };
    const boxBoolConst = (v: number): Instr[] => [
      { op: "i32.const", value: v },
      { op: "call", funcIdx: boxBoolIdx },
    ];

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

    // (#2987) String-wrapper exotic own-property arm — runs when the ordinary
    // `__obj_find` misses. Locals: 7=sEnt(ref null $PropEntry) 8=sVal(anyref)
    // 9=wStr(ref null $NativeString) 10=wLen(i32) 11=kStr(ref null $NativeString)
    // 12=kIdx(i32). Always ends in a `return` on every control path.
    const L_SENT = 7;
    const L_SVAL = 8;
    const L_WSTR = 9;
    const L_WLEN = 10;
    const L_KSTR = 11;
    const L_KIDX = 12;
    const undefRet: Instr[] = [{ op: "ref.null.extern" }, { op: "return" }];
    // Build a fresh data descriptor into `desc` (local 6) and return it.
    const exoticDataDesc = (valueInstrs: Instr[], enumerable: number): Instr[] => [
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 6 },
      ...setKey("value", valueInstrs),
      ...setKey("writable", boxBoolConst(0)),
      ...setKey("enumerable", boxBoolConst(enumerable)),
      ...setKey("configurable", boxBoolConst(0)),
      { op: "local.get", index: 6 },
      { op: "return" },
    ];
    const stringExoticArm: Instr[] = strExotic
      ? [
          // key must be a string property key (else no exotic own property).
          { op: "local.get", index: 1 },
          { op: "any.convert_extern" },
          { op: "local.tee", index: 2 },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: undefRet },
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          { op: "local.set", index: L_KSTR },
          // slotEnt = __obj_find(o, "[[PrimitiveValue]]") — absent ⇒ not a wrapper.
          { op: "local.get", index: 3 },
          { op: "ref.as_non_null" },
          ...stringExternG(WRAPPER_PRIMITIVE_KEY),
          { op: "call", funcIdx: objFindIdx },
          { op: "local.tee", index: L_SENT },
          { op: "ref.is_null" },
          { op: "if", blockType: { kind: "empty" }, then: undefRet },
          // sVal = slotEnt.value; a String wrapper's [[StringData]] is a string.
          { op: "local.get", index: L_SENT },
          { op: "ref.as_non_null" },
          { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 },
          { op: "local.tee", index: L_SVAL },
          { op: "ref.test", typeIdx: anyStrTypeIdx },
          { op: "i32.eqz" },
          { op: "if", blockType: { kind: "empty" }, then: undefRet },
          // wStr = flatten([[StringData]]); wLen = wStr.len
          { op: "local.get", index: L_SVAL },
          { op: "ref.cast", typeIdx: anyStrTypeIdx },
          { op: "call", funcIdx: strFlattenIdx },
          { op: "local.tee", index: L_WSTR },
          { op: "struct.get", typeIdx: nativeStrTypeIdx, fieldIdx: 0 },
          { op: "local.set", index: L_WLEN },
          // "length" → { value: len, writable:false, enumerable:false, configurable:false }
          { op: "local.get", index: L_KSTR },
          ...nativeStringLiteralInstrs(ctx, "length"),
          { op: "call", funcIdx: strEqualsIdx },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: exoticDataDesc(
              [{ op: "local.get", index: L_WLEN }, { op: "f64.convert_i32_s" }, { op: "call", funcIdx: boxNumIdx }],
              0,
            ),
          },
          // integer index in [0, len) → { value: char, writable:false, enumerable:true, configurable:false }
          { op: "local.get", index: L_KSTR },
          { op: "call", funcIdx: objIndexOfKeyIdx },
          { op: "local.tee", index: L_KIDX },
          { op: "i32.const", value: 0 },
          { op: "i32.ge_s" },
          { op: "local.get", index: L_KIDX },
          { op: "local.get", index: L_WLEN },
          { op: "i32.lt_s" },
          { op: "i32.and" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: exoticDataDesc(
              [
                { op: "local.get", index: L_WSTR },
                { op: "ref.as_non_null" },
                { op: "local.get", index: L_KIDX },
                { op: "call", funcIdx: charAtIdx as number },
                { op: "extern.convert_any" } as Instr,
              ],
              1,
            ),
          },
          // no exotic own property matched → undefined
          ...undefRet,
        ]
      : undefRet;

    const body: Instr[] = [
      // (#2896) Builtin-fn metadata arm: gOPD over a builtin function value
      // synthesizes the spec data descriptor for its "name"/"length" own
      // properties ({writable:false, enumerable:false, configurable:true}).
      // The helper is filled at finalize; non-meta receivers return null and
      // fall through to the `$Object` path below.
      ...(bfnGopdIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            { op: "call", funcIdx: bfnGopdIdx },
            { op: "local.tee", index: 6 }, // desc local (externref) — reused
            { op: "ref.is_null" },
            { op: "i32.eqz" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 6 }, { op: "return" }],
            },
          ] as Instr[])
        : []),
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
      // if e == null → try String-wrapper exotic own property (#2987), else undefined
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: stringExoticArm,
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
        // (#2987) String-wrapper exotic own-property arm locals (7..12). Only
        // emitted when the arm is active (standalone) so every other lane — where
        // `stringExoticArm` is the original `[null.extern, return]` — keeps its
        // byte-identical function body + local vector.
        ...(strExotic
          ? ([
              { name: "sEnt", type: entryRefNull },
              { name: "sVal", type: { kind: "anyref" } },
              { name: "wStr", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } },
              { name: "wLen", type: { kind: "i32" } },
              { name: "kStr", type: { kind: "ref_null", typeIdx: nativeStrTypeIdx } },
              { name: "kIdx", type: { kind: "i32" } },
            ] as { name: string; type: ValType }[])
          : []),
      ],
      body,
    );
  }

  // ── __create_descriptor(value, flags) -> externref (#2874 standalone-native) ─
  //
  // Standalone-native carrier for the host `__create_descriptor` consumed by the
  // `Object.getOwnPropertyDescriptor` typed-receiver fast path
  // (`expressions/calls.ts:6652`/`:6808`). That fast path inlines `struct.get`
  // for a statically-typed receiver, then calls `__create_descriptor(value,
  // flags)` to wrap the field value in a data descriptor. The host import has no
  // standalone carrier, so the typed-receiver case leaked `env::__create_descriptor`
  // and the standalone module trapped (#2874; the `any`-typed / inline-literal
  // receiver already resolves natively).
  //
  // Builds a fresh DATA descriptor `$Object`
  // `{ value, writable, enumerable, configurable }` from the value externref +
  // the flag bits (1=writable, 2=enumerable, 4=configurable) — identical shape to
  // the host `runtime.ts:__create_descriptor` and to the data branch of the
  // native `__getOwnPropertyDescriptor` above. Keys are native `$AnyString`s; the
  // attribute booleans are boxed via `__box_boolean`.
  //
  // params: 0=value(externref) 1=flags(i32) ; locals: 2=desc(externref)
  {
    addUnionImportsViaRegistry(ctx);
    const boxBoolIdx = ctx.funcMap.get("__box_boolean")!;
    const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;
    const externSetCdIdx = ctx.funcMap.get("__extern_set")!;

    // `desc["<key>"] = <value externref>` — desc is in local 2.
    const setKeyCd = (key: string, valueInstrs: Instr[]): Instr[] => [
      { op: "local.get", index: 2 },
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "extern.convert_any" } as Instr,
      ...valueInstrs,
      { op: "call", funcIdx: externSetCdIdx },
    ];

    // Box `(flags & mask) != 0` as a JS boolean externref.
    const boolFlagCd = (mask: number): Instr[] => [
      { op: "local.get", index: 1 },
      { op: "i32.const", value: mask },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      { op: "call", funcIdx: boxBoolIdx },
    ];

    const body: Instr[] = [
      // desc = __new_plain_object()
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 2 },
      // desc.value = value (param 0)
      ...setKeyCd("value", [{ op: "local.get", index: 0 }]),
      // desc.writable / enumerable / configurable = box(flags & bit)
      ...setKeyCd("writable", boolFlagCd(FLAG_WRITABLE)),
      ...setKeyCd("enumerable", boolFlagCd(FLAG_ENUMERABLE)),
      ...setKeyCd("configurable", boolFlagCd(FLAG_CONFIGURABLE)),
      // return desc
      { op: "local.get", index: 2 },
    ];
    registerNative(
      "__create_descriptor",
      [{ kind: "externref" }, { kind: "i32" }],
      [{ kind: "externref" }],
      [{ name: "desc", type: { kind: "externref" } }],
      body,
    );
  }

  // ── __create_accessor_descriptor(get, set, flags) -> externref (#2885) ──────
  //
  // Accessor sibling of `__create_descriptor`. Builds a fresh ACCESSOR descriptor
  // `$Object` `{ get, set, enumerable, configurable }` from the get/set closure
  // externrefs (null → undefined) + the flag bits (2=enumerable, 4=configurable).
  // Used by the standalone builtin-proto descriptor-synthesis path in
  // `Object.getOwnPropertyDescriptor(<Builtin>.prototype, "<getter>")`
  // (expressions/calls.ts) so an intrinsic accessor reflects host-free, mirroring
  // the accessor branch of the native `__getOwnPropertyDescriptor` above and the
  // host `runtime.ts:__create_descriptor` shape. Keys are native `$AnyString`s;
  // attribute booleans are boxed via `__box_boolean`. Intrinsic accessors are
  // `{enumerable:false, configurable:true}` (flags = 0x04), so `writable` is
  // intentionally absent (accessor descriptors carry no `value`/`writable`).
  //
  // params: 0=get(externref) 1=set(externref) 2=flags(i32) ; locals: 3=desc(externref)
  {
    addUnionImportsViaRegistry(ctx);
    const boxBoolIdx = ctx.funcMap.get("__box_boolean")!;
    const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;
    const externSetCdIdx = ctx.funcMap.get("__extern_set")!;

    // `desc["<key>"] = <value externref>` — desc is in local 3.
    const setKeyAcc = (key: string, valueInstrs: Instr[]): Instr[] => [
      { op: "local.get", index: 3 },
      ...nativeStringLiteralInstrs(ctx, key),
      { op: "extern.convert_any" } as Instr,
      ...valueInstrs,
      { op: "call", funcIdx: externSetCdIdx },
    ];

    // Box `(flags & mask) != 0` as a JS boolean externref.
    const boolFlagAcc = (mask: number): Instr[] => [
      { op: "local.get", index: 2 },
      { op: "i32.const", value: mask },
      { op: "i32.and" },
      { op: "i32.const", value: 0 },
      { op: "i32.ne" },
      { op: "call", funcIdx: boxBoolIdx },
    ];

    const body: Instr[] = [
      // desc = __new_plain_object()
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 3 },
      // desc.get = get (param 0) ; desc.set = set (param 1)
      ...setKeyAcc("get", [{ op: "local.get", index: 0 }]),
      ...setKeyAcc("set", [{ op: "local.get", index: 1 }]),
      // desc.enumerable / configurable = box(flags & bit)
      ...setKeyAcc("enumerable", boolFlagAcc(FLAG_ENUMERABLE)),
      ...setKeyAcc("configurable", boolFlagAcc(FLAG_CONFIGURABLE)),
      // return desc
      { op: "local.get", index: 3 },
    ];
    registerNative(
      "__create_accessor_descriptor",
      [{ kind: "externref" }, { kind: "externref" }, { kind: "i32" }],
      [{ kind: "externref" }],
      [{ name: "desc", type: { kind: "externref" } }],
      body,
    );
  }

  // ── __getOwnPropertyNames(externref obj) -> externref (#2042 S3) ──────────
  //
  // `Object.getOwnPropertyNames(obj)` / `Reflect.ownKeys(obj)` (string subset)
  // under standalone. Mirrors `__object_keys` but **drops the enumerable
  // filter** — every LIVE (non-tombstone) own string entry is included, in
  // OrdinaryOwnPropertyKeys order, via `__obj_ordered_all`. A non-`$Object`
  // receiver returns an empty `$ObjVec` (`getOwnPropertyNames` on a primitive
  // throws ToObject at the call site; this is the open-object path). Symbol keys
  // are not represented by the string-keyed `$Object` runtime, so the result is
  // string keys only (matching the host `getOwnPropertyNames`, which never
  // returns symbols).
  //
  // params: 0=obj(externref)
  // locals: 1=any 2=o 3=arr(ordered) 4=cap 5=i 6=e 7=vec
  {
    const body: Instr[] = [
      { op: "call", funcIdx: objVecNewIdx },
      { op: "local.set", index: 7 },
      // (#2896) Builtin-fn metadata arm: a builtin function value's own string
      // keys are ["length", "name"] in spec order (minus deleted ones). The
      // filled helper pushes them into the vec and returns 1 on a hit.
      ...(bfnPushOwnNamesIdx !== undefined
        ? ([
            { op: "local.get", index: 0 },
            { op: "local.get", index: 7 },
            { op: "call", funcIdx: bfnPushOwnNamesIdx },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [{ op: "local.get", index: 7 }, { op: "return" }],
            },
          ] as Instr[])
        : []),
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
      // o = cast<$Object>(any) ; arr = __obj_ordered_all(o) ; cap = arr.len
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "call", funcIdx: objOrderedAllIdx },
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
              { op: "local.get", index: 3 },
              { op: "local.get", index: 5 },
              { op: "array.get", typeIdx: propMapTypeIdx },
              { op: "local.tee", index: 6 },
              { op: "ref.is_null" },
              { op: "br_if", depth: 1 },
              { op: "local.get", index: 7 },
              { op: "local.get", index: 6 },
              { op: "ref.as_non_null" },
              { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 0 },
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
      "__getOwnPropertyNames",
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

  // ── __getOwnPropertySymbols(externref obj) -> externref (#2042 S3, #2866 s3) ─
  //
  // §20.1.2.10 / OrdinaryOwnPropertyKeys §10.1.11.1 — own SYMBOL-keyed property
  // keys in creation (insertion) order.
  //
  // Without the native Symbol carrier (host/gc mode, or a standalone module with
  // no symbol keys in its type space) the `$Object` runtime holds no symbol keys,
  // so the list is always empty — return a fresh empty `$ObjVec` (the historical
  // #2042 S3 stub; lets the large body of symbol-free tests pass).
  //
  // With the carrier enabled (#2866 PR1: `$PropEntry.key` is `anyref` and may
  // hold a `$Symbol`), delegate selection + ordering to `__obj_ordered_symbols`
  // (live own symbol entries, incl. non-enumerable, in seq order), then push each
  // entry's key — the stored `$Symbol` carrier, `extern.convert_any`'d back to an
  // externref symbol VALUE — into the result vec. Identity is by the i32
  // `$Symbol.id`, so the returned carrier `===` the original symbol and re-indexes
  // the same own property. Non-`$Object` receivers return an empty vec.
  //
  // params: 0=obj(externref)
  // locals: 1=any(anyref) 2=o(ref null $Object) 3=arr(ref $PropMap) 4=cap
  //         5=i 6=e(ref null $PropEntry) 7=vec(externref)
  if (symbolKeysEnabled) {
    const objOrderedSymbolsIdx = ctx.funcMap.get("__obj_ordered_symbols")!;
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
      // o = cast<$Object>(any) ; arr = __obj_ordered_symbols(o) ; cap = arr.len
      { op: "local.get", index: 1 },
      { op: "ref.cast", typeIdx: objectTypeIdx },
      { op: "local.tee", index: 2 },
      { op: "call", funcIdx: objOrderedSymbolsIdx },
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
              // __objvec_push(vec, extern.convert_any(e.key))  — key is a $Symbol carrier
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
      { op: "local.get", index: 7 },
    ];
    registerNative(
      "__getOwnPropertySymbols",
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
  } else {
    // String-keyed runtime (host/gc, or no symbol keys): always [].
    const body: Instr[] = [{ op: "call", funcIdx: objVecNewIdx }];
    registerNative("__getOwnPropertySymbols", [{ kind: "externref" }], [{ kind: "externref" }], [], body);
  }

  // ── __getOwnPropertyDescriptors(externref obj) -> externref (#2042 S3) ────
  //
  // `Object.getOwnPropertyDescriptors(obj)` — a fresh `$Object` mapping each own
  // string key to its descriptor object. For each own key (from
  // `__getOwnPropertyNames`) set `out[key] = __getOwnPropertyDescriptor(o, key)`.
  // A non-`$Object` receiver yields an empty result object (the per-key loop runs
  // zero times). Reuses the same enumeration + per-key descriptor builders, so
  // accessor vs data shape and attribute flags are exactly consistent with the
  // singular `getOwnPropertyDescriptor`.
  //
  // params: 0=obj(externref)
  // locals: 1=names(externref $ObjVec) 2=cap(f64) 3=i(i32) 4=key(externref)
  //         5=out(externref)
  {
    const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;
    const externLengthIdx = ctx.funcMap.get("__extern_length")!;
    const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx")!;
    const getOwnNamesIdx = ctx.funcMap.get("__getOwnPropertyNames")!;
    const getOwnDescIdx = ctx.funcMap.get("__getOwnPropertyDescriptor")!;
    const externSetLocalIdx = ctx.funcMap.get("__extern_set")!;
    const body: Instr[] = [
      // out = __new_plain_object()
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 5 },
      // names = __getOwnPropertyNames(obj)
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: getOwnNamesIdx },
      { op: "local.tee", index: 1 },
      // cap = __extern_length(names)
      { op: "call", funcIdx: externLengthIdx },
      { op: "local.set", index: 2 },
      // i = 0
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
              // if i >= cap break  (cap is f64; compare as f64)
              { op: "local.get", index: 3 },
              { op: "f64.convert_i32_s" },
              { op: "local.get", index: 2 },
              { op: "f64.ge" },
              { op: "br_if", depth: 1 },
              // key = __extern_get_idx(names, i)
              { op: "local.get", index: 1 },
              { op: "local.get", index: 3 },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: externGetIdxIdx },
              { op: "local.set", index: 4 },
              // __extern_set(out, key, __getOwnPropertyDescriptor(obj, key))
              { op: "local.get", index: 5 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 0 },
              { op: "local.get", index: 4 },
              { op: "call", funcIdx: getOwnDescIdx },
              { op: "call", funcIdx: externSetLocalIdx },
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
      { op: "local.get", index: 5 },
    ];
    registerNative(
      // Call site (calls.ts) requests this with the `__object_` prefix.
      "__object_getOwnPropertyDescriptors",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "names", type: { kind: "externref" } },
        { name: "cap", type: { kind: "f64" } },
        { name: "i", type: { kind: "i32" } },
        { name: "key", type: { kind: "externref" } },
        { name: "out", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // ── __object_fromEntries(externref entries) -> externref (#2042 S3 residual) ─
  //
  // `Object.fromEntries(entries)` where `entries` is a `$ObjVec` of `[key,value]`
  // pair `$ObjVec`s. Builds a fresh `$Object` and, for each pair, sets
  // `out[pair[0]] = pair[1]` via `__extern_set` (which ToPropertyKeys the key —
  // #2042 R2/S1). Iterates via `__extern_length` / `__extern_get_idx` (which
  // index a `$ObjVec` reliably). The CALL SITE (calls.ts) normalises a literal
  // array-of-pairs arg into this `$ObjVec`-of-`$ObjVec` shape before calling, so
  // the helper only ever sees the indexable representation (a raw native vec /
  // Map is not reliably indexable through `__extern_get_idx` — that's why the
  // call site converts first, mirroring `compileObjectAssignArg`).
  //
  // params: 0=entries(externref) ; locals: 1=len(f64) 2=i(i32) 3=pair 4=key 5=val 6=out
  {
    const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;
    const externLengthIdx = ctx.funcMap.get("__extern_length")!;
    const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx")!;
    const externSetIdx2 = ctx.funcMap.get("__extern_set")!;
    const pairElem = (pairLocal: number, idx: number): Instr[] => [
      { op: "local.get", index: pairLocal },
      { op: "f64.const", value: idx },
      { op: "call", funcIdx: externGetIdxIdx },
    ];
    const body: Instr[] = [
      { op: "call", funcIdx: newPlainObjectIdx },
      { op: "local.set", index: 6 },
      { op: "local.get", index: 0 },
      { op: "call", funcIdx: externLengthIdx },
      { op: "local.set", index: 1 },
      { op: "i32.const", value: 0 },
      { op: "local.set", index: 2 },
      {
        op: "block",
        blockType: { kind: "empty" },
        body: [
          {
            op: "loop",
            blockType: { kind: "empty" },
            body: [
              { op: "local.get", index: 2 },
              { op: "f64.convert_i32_s" },
              { op: "local.get", index: 1 },
              { op: "f64.ge" },
              { op: "br_if", depth: 1 },
              // pair = __extern_get_idx(entries, i)
              { op: "local.get", index: 0 },
              { op: "local.get", index: 2 },
              { op: "f64.convert_i32_s" },
              { op: "call", funcIdx: externGetIdxIdx },
              { op: "local.set", index: 3 },
              // key = pair[0]; val = pair[1]
              ...pairElem(3, 0),
              { op: "local.set", index: 4 },
              ...pairElem(3, 1),
              { op: "local.set", index: 5 },
              // __extern_set(out, key, val)
              { op: "local.get", index: 6 },
              { op: "local.get", index: 4 },
              { op: "local.get", index: 5 },
              { op: "call", funcIdx: externSetIdx2 },
              { op: "local.get", index: 2 },
              { op: "i32.const", value: 1 },
              { op: "i32.add" },
              { op: "local.set", index: 2 },
              { op: "br", depth: 0 },
            ],
          },
        ],
      },
      { op: "local.get", index: 6 },
    ];
    registerNative(
      "__object_fromEntries",
      [{ kind: "externref" }],
      [{ kind: "externref" }],
      [
        { name: "len", type: { kind: "f64" } },
        { name: "i", type: { kind: "i32" } },
        { name: "pair", type: { kind: "externref" } },
        { name: "key", type: { kind: "externref" } },
        { name: "val", type: { kind: "externref" } },
        { name: "out", type: { kind: "externref" } },
      ],
      body,
    );
  }

  // NOTE (#2042 S3): `__defineProperty_desc` (generic
  // `Object.defineProperty(o, k, runtimeDescObj)`) is intentionally NOT
  // registered here yet. Its body would delegate to the working native
  // `__defineProperties` (a one-entry `{ [key]: desc }` map — verified to work
  // via `Object.defineProperties` directly), but its sole call site
  // (`Object.create(o, descs)` with an identifier descriptor value) currently
  // trips the #2043 late-import index-shift emit bug, so registering it converts
  // a clean #1472-Phase-B refusal into a messier #2043 binary-emit error with no
  // test gain. It stays a loud refusal until #2043 is fixed (then this helper +
  // its OBJECT_RUNTIME_HELPER_NAMES entry land as a follow-up). The read-side
  // reflection natives above (__getOwnPropertyNames / __getOwnPropertySymbols /
  // __object_getOwnPropertyDescriptors) are the shipped S3 slice.

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
  //
  // (#2979) SECOND arm — the boxed UNDEF_F64 sentinel. An `undefined` that
  // travels through an **f64 carrier** (the native generator done-result
  // `.value` field is the producer today) carries the UNDEF_F64 signaling-NaN
  // bit pattern (value-tags.ts); a generic f64→externref boxing site that isn't
  // sentinel-aware wraps it in a `$BoxedNumber`. Recognize that box here so
  // `x === undefined` / default-application still answer true after the value
  // crossed a sentinel-blind boxing site. JS arithmetic only produces the
  // quiet NaN 0x7FF8… — it can never forge the sentinel bits — and host mode
  // never builds this native (native generators are standalone/wasi-only), so
  // this cannot misfire on a genuine number. Gated on the carrier type
  // existing; without it the body is the legacy bare `ref.is_null`.
  // (#2106 S1) Under the `undefinedSingleton` regime the predicate flips to
  // "tag-1 `$AnyValue` box ∨ UNDEF_F64 `$BoxedNumber`" and — the whole point —
  // a null externref answers 0 (null is DISTINCT from undefined). Every
  // undefined PRODUCER (emitUndefined, `__extern_get`/`__extern_get_idx`
  // miss, literal stores, omitted-arg padding) flips to the singleton in the
  // same build, so the lockstep invariant that broke PR #2025 holds.
  const s1IsUndefBody = buildIsUndefinedExternBody(ctx, 1, UNDEF_F64_BITS);
  registerNative(
    "__extern_is_undefined",
    [{ kind: "externref" }],
    [{ kind: "i32" }],
    s1IsUndefBody !== undefined || ctx.nativeBoxNumberTypeIdx >= 0 ? [{ name: "any", type: { kind: "anyref" } }] : [],
    s1IsUndefBody !== undefined
      ? s1IsUndefBody
      : ctx.nativeBoxNumberTypeIdx >= 0
        ? [
            { op: "local.get", index: 0 },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "val", type: { kind: "i32" } },
              then: [{ op: "i32.const", value: 1 }],
              else: [
                { op: "local.get", index: 0 },
                { op: "any.convert_extern" },
                { op: "local.tee", index: 1 },
                { op: "ref.test", typeIdx: ctx.nativeBoxNumberTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: { kind: "i32" } },
                  then: [
                    { op: "local.get", index: 1 },
                    { op: "ref.cast", typeIdx: ctx.nativeBoxNumberTypeIdx },
                    { op: "struct.get", typeIdx: ctx.nativeBoxNumberTypeIdx, fieldIdx: 0 },
                    { op: "i64.reinterpret_f64" },
                    { op: "i64.const", value: UNDEF_F64_BITS },
                    { op: "i64.eq" },
                  ],
                  else: [{ op: "i32.const", value: 0 }],
                } as Instr,
              ],
            } as Instr,
          ]
        : [{ op: "local.get", index: 0 }, { op: "ref.is_null" }],
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
          // (#2106 S1) a missing method resolves to the undefined singleton —
          // normalize to null so __apply_closure keeps its legacy null path.
          ...(ctx.funcMap.has("__nullish_to_null")
            ? [{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! } as Instr]
            : []),
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

  // (#1100) Register the standalone Proxy dispatch runtime. Must run AFTER
  // __extern_get/set/has are registered (the trap dispatch helpers forward to
  // them when a trap is absent) and only adds DEFINED functions, so no index
  // shift (same invariant as the rest of this runtime).
  ensureProxyRuntime(ctx, types, registerNative);

  return types;
}

/**
 * (#2161 B1) `__wrapper_string_value(externref) -> ref null $AnyString` —
 * boxed-`new String(...)` receiver/argument primitive-string recovery.
 *
 * A `new String(x)` produces a `$Object` wrapper (`__new_String`) carrying its
 * [[StringData]] under the reserved FLAG_INTERNAL `WRAPPER_PRIMITIVE_KEY` slot.
 * When such a wrapper reaches an externref→native-`$AnyString` coercion (a string
 * method's receiver-as-subject, e.g. `new String("hello").split(/l/)`, or a
 * string-typed argument) the generic `ref.test $AnyString` misses it (a wrapper
 * is an object, not a string) and the value was previously dropped to null →
 * downstream `__str_flatten` trapped ("dereferencing a null pointer").
 *
 * This helper extracts JUST the wrapper's primitive-string slot — the same
 * internal-slot read `__to_primitive` performs inline (§7.1.1.1: the wrapper's
 * intrinsic valueOf/toString return the internal primitive) — WITHOUT pulling in
 * OrdinaryToPrimitive (the valueOf/toString method dispatch), so it stays a pure
 * bounded slot probe with no user-observable side effects. It returns the native
 * string when the input is a boxed-String wrapper, else null (a plain object,
 * another wrapper kind, or a non-string slot value), so the caller keeps its
 * prior null fallthrough for every non-boxed-String value.
 *
 * Registered lazily and idempotently — only when a qualifying coercion actually
 * needs it, so modules that never box a String stay byte-identical. Returns the
 * func index, or -1 when the object runtime is absent (no `__obj_find`) or native
 * strings are off (gc/host mode) — in which case the caller falls through to its
 * prior null. `ensureObjectRuntime` has already run (a boxed String cannot exist
 * otherwise), so `ctx.objectRuntimeTypes` and `__obj_find` are settled and no
 * late-import shift is pending.
 */
export function ensureWrapperStringValueHelper(ctx: CodegenContext): number {
  const existing = ctx.funcMap.get("__wrapper_string_value");
  if (existing !== undefined) return existing;

  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  const objTypes = ctx.objectRuntimeTypes;
  const objFindIdx = ctx.funcMap.get("__obj_find");
  if (anyStrTypeIdx < 0 || objTypes === undefined || objFindIdx === undefined) {
    return -1;
  }
  const { objectTypeIdx, propEntryTypeIdx } = objTypes;
  const anyStrRefNull: ValType = { kind: "ref_null", typeIdx: anyStrTypeIdx };

  const body: Instr[] = [
    // a = any.convert_extern(x)
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.tee", index: 1 },
    { op: "ref.test", typeIdx: objectTypeIdx },
    {
      op: "if",
      blockType: { kind: "val", type: anyStrRefNull },
      then: [
        // e = __obj_find(cast<$Object>(a), WRAPPER_PRIMITIVE_KEY)
        { op: "local.get", index: 1 },
        { op: "ref.cast", typeIdx: objectTypeIdx },
        ...((): Instr[] => {
          addStringConstantGlobal(ctx, WRAPPER_PRIMITIVE_KEY);
          return stringConstantExternrefInstrs(ctx, WRAPPER_PRIMITIVE_KEY);
        })(),
        { op: "call", funcIdx: objFindIdx },
        { op: "local.tee", index: 2 },
        { op: "ref.is_null" },
        {
          op: "if",
          blockType: { kind: "val", type: anyStrRefNull },
          then: [{ op: "ref.null", typeIdx: anyStrTypeIdx } as Instr],
          else: [
            // confirm the entry is the internal slot (FLAG_INTERNAL)
            { op: "local.get", index: 2 },
            { op: "ref.as_non_null" },
            { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 2 }, // flags
            { op: "i32.const", value: FLAG_INTERNAL },
            { op: "i32.and" },
            {
              op: "if",
              blockType: { kind: "val", type: anyStrRefNull },
              then: [
                // v = entry.value (anyref); if it is a native string, return it
                { op: "local.get", index: 2 },
                { op: "ref.as_non_null" },
                { op: "struct.get", typeIdx: propEntryTypeIdx, fieldIdx: 1 }, // value
                { op: "local.tee", index: 3 },
                { op: "ref.test", typeIdx: anyStrTypeIdx },
                {
                  op: "if",
                  blockType: { kind: "val", type: anyStrRefNull },
                  then: [
                    { op: "local.get", index: 3 },
                    { op: "ref.cast", typeIdx: anyStrTypeIdx },
                  ],
                  else: [{ op: "ref.null", typeIdx: anyStrTypeIdx } as Instr],
                } as Instr,
              ],
              else: [{ op: "ref.null", typeIdx: anyStrTypeIdx } as Instr],
            } as Instr,
          ],
        } as Instr,
      ],
      else: [{ op: "ref.null", typeIdx: anyStrTypeIdx } as Instr],
    } as Instr,
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [anyStrRefNull]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__wrapper_string_value", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__wrapper_string_value",
    typeIdx,
    locals: [
      { name: "a", type: { kind: "anyref" } },
      { name: "e", type: { kind: "ref_null", typeIdx: propEntryTypeIdx } },
      { name: "v", type: { kind: "anyref" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
}

/** (#1100/#1355) Reserved trap-invoke driver names — filled by `fillProxyDispatch`. */
const PROXY_CALL_GET = "__proxy_call_get";
const PROXY_CALL_SET = "__proxy_call_set";
const PROXY_CALL_HAS = "__proxy_call_has";
const PROXY_CALL_DELETE = "__proxy_call_delete"; // (#1355 Slice A)
const PROXY_CALL_GOPD = "__proxy_call_gopd"; // (#1355 Slice B) getOwnPropertyDescriptor
const PROXY_CALL_GPO = "__proxy_call_gpo"; // (#1355 Slice C) getPrototypeOf
const PROXY_CALL_SPO = "__proxy_call_spo"; // (#1355 Slice C) setPrototypeOf
const PROXY_CALL_ISEXT = "__proxy_call_isext"; // (#1355 Slice D) isExtensible
const PROXY_CALL_PREVEXT = "__proxy_call_prevext"; // (#1355 Slice D) preventExtensions
const PROXY_CALL_OWNKEYS = "__proxy_call_ownkeys"; // (#1355 Slice E) ownKeys
const PROXY_CALL_DEFINE = "__proxy_call_define"; // (#1355 Slice F) defineProperty

/**
 * (#1100) Standalone Proxy meta-object dispatch runtime — Phase 1.
 *
 * Registers the per-operation dispatch helpers (`__proxy_{get,set,has}_dispatch`),
 * the trap-invoke driver placeholders (`__proxy_call_{get,set,has}`, filled at
 * FINALIZE by `fillProxyDispatch`), the constructor (`__proxy_create`) and the
 * revoker (`__proxy_revoke`), and patches the `ref.test $Proxy` front-guard onto
 * `__extern_get`/`__extern_set`/`__extern_has`.
 *
 * ## Calling convention (the crux)
 * A user trap `(t,k,r) => …` lowers to a GC **closure-wrapper struct** boxed as
 * an externref; its own funcref takes the closure-self as arg0 and carries the
 * captured environment. It therefore CANNOT be `call_ref`-ed with a bare
 * `(target,key,receiver)` signature. So `$ProxyTraps` stores the trap as an
 * externref closure, and the dispatch invokes it through the existing
 * closure-call bridge `__call_fn_method_N(thisVal, closure, arg0…)` — the same
 * path accessors (`fillAccessorDrivers`) and open-`any` method calls
 * (`__apply_closure`) use. Those exports only exist at FINALIZE, so the
 * `__proxy_call_*` drivers are reserved here (placeholder `unreachable`) and
 * filled later (reserve-then-fill, #1719). The trap `this` is the handler
 * (§10.5.x `Call(trap, handler, …)`), threaded as `thisVal`.
 *
 * Each dispatch helper: (1) casts to `$Proxy`, (2) throws a TypeError if the
 * proxy is revoked, (3) reads the relevant trap closure from `$ptraps`,
 * (4) forwards to the ordinary operation on `$ptarget` when the trap is absent,
 * else invokes the trap driver with `(handler, target, key, receiver[, value])`.
 *
 * Phase 1 performs NO §10.5 result-invariant checks (deferred to #1355) — it
 * only enforces the revoked-proxy invariant.
 */
function ensureProxyRuntime(
  ctx: CodegenContext,
  types: ObjectRuntimeTypes,
  registerNative: (
    name: string,
    paramTypes: ValType[],
    resultTypes: ValType[],
    locals: { name: string; type: ValType }[],
    body: Instr[],
  ) => number,
): void {
  if (ctx.funcMap.has("__proxy_get_dispatch")) return;

  const { objectTypeIdx, proxyTypeIdx, proxyTrapsTypeIdx } = types;
  const externref: ValType = { kind: "externref" };

  // The dispatch helpers depend on `__box_boolean` (has-trap-absent arm boxes
  // the i32 __extern_has result) and `__is_truthy` (the __extern_has front-guard
  // coerces the trap's booleanish externref result back to i32). Both are
  // registered via the union-import registry; ensure they exist before we bake
  // their funcIdx into the proxy bodies (idempotent).
  addUnionImportsViaRegistry(ctx);

  // Revoked-proxy TypeError. Reuse the WASI error constructor + exn tag like
  // the ToPrimitive path does (object-runtime.ts ~1695).
  const revokedMsg = "Cannot perform operation on a proxy that has been revoked";
  addStringConstantGlobal(ctx, revokedMsg);
  emitWasiErrorConstructor(ctx, "TypeError", 1);
  const typeErrorCtorIdx = ctx.funcMap.get("__new_TypeError")!;
  const exnTagIdx = ensureExnTag(ctx);
  // FRESH Instr array per use. The same throw block is embedded in three
  // dispatch helpers; a SHARED array would be visited once per containing-body
  // pass AND, when reused twice in one body, double-remapped by the FINALIZE
  // dead-code `remapFuncIdxInBody` walk (no dedup Set) — over-shifting the baked
  // `call __new_TypeError` funcIdx. Build a new array each time.
  const throwRevoked = (): Instr[] => [
    ...stringConstantExternrefInstrs(ctx, revokedMsg),
    { op: "call", funcIdx: typeErrorCtorIdx },
    { op: "throw", tagIdx: exnTagIdx } as Instr,
  ];

  // (#1355 Slice E) §10.5.11 step 8 / CreateListFromArrayLike (§7.3.18 step 2):
  // the `ownKeys` trap result must be an Object — otherwise a TypeError. FRESH
  // Instr array per use, same rationale as `throwRevoked` (avoids the FINALIZE
  // double-remap of a shared, baked `call __new_TypeError` funcIdx).
  const notListObjectMsg = "Proxy ownKeys trap result must be an object";
  addStringConstantGlobal(ctx, notListObjectMsg);
  const throwNotListObject = (): Instr[] => [
    ...stringConstantExternrefInstrs(ctx, notListObjectMsg),
    { op: "call", funcIdx: typeErrorCtorIdx },
    { op: "throw", tagIdx: exnTagIdx } as Instr,
  ];

  // Reserve the open-`any` closure-call bridge `__apply_closure` (filled at
  // FINALIZE by `fillApplyClosure`). The proxy trap-invoke drivers
  // (`fillProxyDispatch`) call it to run the user trap closure with the handler
  // bound as `this` — the same bridge `__extern_method_call` uses. Reserving here
  // guarantees the bridge + its `__call_fn_method_N` arms exist when a standalone
  // `new Proxy` is the only closure-call site in the module.
  reserveApplyClosure(ctx);

  // Field indices on the standalone $Proxy struct:
  // ptag(0) ptarget(1) phandler(2) ptraps(3) revoked(4).
  const F_PTARGET = 1;
  const F_PHANDLER = 2;
  const F_PTRAPS = 3;
  const F_REVOKED = 4;
  // Field indices on $ProxyTraps: get(0) set(1) has(2) apply(3) deleteProperty(4).
  const TRAP_GET = 0;
  const TRAP_SET = 1;
  const TRAP_HAS = 2;
  const TRAP_DELETE = 4; // (#1355 Slice A)
  const TRAP_GOPD = 5; // (#1355 Slice B) getOwnPropertyDescriptor
  const TRAP_GPO = 6; // (#1355 Slice C) getPrototypeOf
  const TRAP_SPO = 7; // (#1355 Slice C) setPrototypeOf
  const TRAP_ISEXT = 8; // (#1355 Slice D) isExtensible
  const TRAP_PREVEXT = 9; // (#1355 Slice D) preventExtensions
  const TRAP_OWNKEYS = 10; // (#1355 Slice E) ownKeys
  const TRAP_DEFINE = 11; // (#1355 Slice F) defineProperty

  // ── Reserve the trap-invoke driver placeholders (filled by fillProxyDispatch) ──
  //
  // Each driver forwards to the closure-call bridge __call_fn_method_N. The
  // bodies are filled at FINALIZE once those exports exist; here we only reserve
  // the funcIdx (append position) so the dispatch helpers can bake a stable
  // `call <reserved funcIdx>`. Signatures match the spec trap arities:
  //   get(handler, trap, target, key, receiver)        → __call_fn_method_3
  //   set(handler, trap, target, key, value, receiver) → __call_fn_method_4
  //   has(handler, trap, target, key)                  → __call_fn_method_2
  const reserveDriver = (name: string, params: ValType[]): number => {
    const existing = ctx.funcMap.get(name);
    if (existing !== undefined) return existing;
    const typeIdx = addFuncType(ctx, params, [externref]);
    const funcIdx = mintDefinedFunc(ctx);
    pushDefinedFunc(ctx, funcIdx, {
      name,
      typeIdx,
      locals: [],
      // Placeholder; filled by fillProxyDispatch. A bare `unreachable` keeps the
      // stub valid (externref result) if the fill is ever skipped (no closure of
      // the needed arity ⇒ no real trap could have been installed ⇒ unused).
      body: [{ op: "unreachable" } as Instr],
      exported: false,
    });
    ctx.funcMap.set(name, funcIdx);
    return funcIdx;
  };
  const callGetIdx = reserveDriver(PROXY_CALL_GET, [externref, externref, externref, externref, externref]);
  const callSetIdx = reserveDriver(PROXY_CALL_SET, [externref, externref, externref, externref, externref, externref]);
  const callHasIdx = reserveDriver(PROXY_CALL_HAS, [externref, externref, externref, externref]);
  // (#1355 Slice A) deleteProperty driver — same arity as has: (handler, trap,
  // target, key) → __call_fn_method_2 (§10.5.10 step 8 `Call(trap, handler, «O, P»)`).
  const callDeleteIdx = reserveDriver(PROXY_CALL_DELETE, [externref, externref, externref, externref]);
  // (#1355 Slice B) getOwnPropertyDescriptor driver — 2-arg like has/delete:
  // (handler, trap, target, key) → __call_fn_method_2 (§10.5.5 step 8
  // `Call(trap, handler, «target, P»)`). Returns the trap's descriptor externref.
  const callGopdIdx = reserveDriver(PROXY_CALL_GOPD, [externref, externref, externref, externref]);
  // (#1355 Slice C) getPrototypeOf driver — 1 trap arg: (handler, trap, target)
  // → __call_fn_method_1 (§10.5.1 step 5 `Call(trap, handler, «target»)`).
  const callGpoIdx = reserveDriver(PROXY_CALL_GPO, [externref, externref, externref]);
  // (#1355 Slice C) setPrototypeOf driver — 2 trap args: (handler, trap, target,
  // proto) → __call_fn_method_2 (§10.5.2 step 7 `Call(trap, handler, «target, V»)`).
  const callSpoIdx = reserveDriver(PROXY_CALL_SPO, [externref, externref, externref, externref]);
  // (#1355 Slice D) isExtensible / preventExtensions drivers — 1 trap arg each:
  // (handler, trap, target) → __call_fn_method_1 (§10.5.3 step 5 / §10.5.4 step 5
  // `Call(trap, handler, «target»)`). Both return a booleanish externref.
  const callIsextIdx = reserveDriver(PROXY_CALL_ISEXT, [externref, externref, externref]);
  const callPrevextIdx = reserveDriver(PROXY_CALL_PREVEXT, [externref, externref, externref]);
  // (#1355 Slice E) ownKeys driver — 1 trap arg: (handler, trap, target) →
  // __call_fn_method_1 (§10.5.11 step 7 `Call(trap, handler, «target»)`). Returns
  // the trap's array-like result externref.
  const callOwnKeysIdx = reserveDriver(PROXY_CALL_OWNKEYS, [externref, externref, externref]);
  // (#1355 Slice F) defineProperty driver — 3 trap args: (handler, trap, target,
  // key, desc) → __call_fn_method_3 (§10.5.6 step 9 `Call(trap, handler, «target,
  // P, descObj»)`). Returns the trap's booleanish result externref.
  const callDefineIdx = reserveDriver(PROXY_CALL_DEFINE, [externref, externref, externref, externref, externref]);
  ctx.proxyDispatchReserved = true;

  // Builds a dispatch helper body. `trapFieldIdx` selects the trap closure;
  // `forwardName` is the ordinary operation to call when the trap is absent;
  // `isSet` switches the 3-arg (set) / 2-arg (get/has) forward + arg shape.
  // params: 0=proxyExtern 1=key 2=receiver(get/has)/value(set)
  // locals: 3=p (ref $Proxy)  4=trap (externref)
  const buildDispatch = (trapFieldIdx: number, forwardName: string, isSet: boolean): Instr[] => {
    const forwardIdx = ctx.funcMap.get(forwardName)!;
    // The trap-invoke arm: read handler + target, then call the reserved driver.
    // get:  driver(handler, trap, target, key, receiver=param2)
    // has:  driver(handler, trap, target, key)
    // set:  driver(handler, trap, target, key, value=param2, receiver=proxy)
    const trapArm: Instr[] = [
      // handler
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "extern.convert_any" } as Instr,
      // trap closure
      { op: "local.get", index: 4 },
      // target
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" } as Instr,
      // key
      { op: "local.get", index: 1 },
    ];
    if (isSet) {
      // value, then receiver (= the proxy itself, param 0)
      trapArm.push({ op: "local.get", index: 2 });
      trapArm.push({ op: "local.get", index: 0 });
      trapArm.push({ op: "call", funcIdx: callSetIdx });
    } else if (trapFieldIdx === TRAP_HAS) {
      trapArm.push({ op: "call", funcIdx: callHasIdx });
    } else if (trapFieldIdx === TRAP_DELETE) {
      // (#1355) deleteProperty: driver(handler, trap, target, key) — same 2-arg
      // shape as has (§10.5.10 step 8 `Call(trap, handler, «O, P»)`).
      trapArm.push({ op: "call", funcIdx: callDeleteIdx });
    } else if (trapFieldIdx === TRAP_GOPD) {
      // (#1355) getOwnPropertyDescriptor: driver(handler, trap, target, key) —
      // 2-arg, no receiver (§10.5.5 step 8 `Call(trap, handler, «target, P»)`).
      trapArm.push({ op: "call", funcIdx: callGopdIdx });
    } else {
      // get: receiver = param 2
      trapArm.push({ op: "local.get", index: 2 });
      trapArm.push({ op: "call", funcIdx: callGetIdx });
    }

    const body: Instr[] = [
      // p = ref.cast $Proxy(any.convert_extern(proxyExtern))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 3 },
      // if p.revoked: throw TypeError
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      { op: "if", blockType: { kind: "empty" }, then: throwRevoked() } as Instr,
      // trap = p.ptraps==null ? null : p.ptraps.<field>
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [{ op: "ref.null.extern" } as Instr],
        else: [
          { op: "local.get", index: 3 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
          { op: "ref.as_non_null" } as Instr,
          { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: trapFieldIdx },
        ],
      } as Instr,
      { op: "local.set", index: 4 },
      // if trap == null: forward to ordinary op on target
      { op: "local.get", index: 4 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: isSet
          ? [
              // __extern_set(target, key, value) -> (void) ; push undefined
              { op: "local.get", index: 3 },
              { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
              { op: "extern.convert_any" } as Instr,
              { op: "local.get", index: 1 },
              { op: "local.get", index: 2 },
              { op: "call", funcIdx: forwardIdx },
              { op: "ref.null.extern" },
            ]
          : trapFieldIdx === TRAP_HAS || trapFieldIdx === TRAP_DELETE
            ? [
                // has:    __extern_has(target, key)     -> i32
                // delete: __delete_property(target, key) -> i32
                // Both are 2-arg `(target,key) -> i32`; box back to a boolean any
                // so the dispatch result stays uniform externref.
                { op: "local.get", index: 3 },
                { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
                { op: "extern.convert_any" } as Instr,
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: forwardIdx },
                { op: "call", funcIdx: ctx.funcMap.get("__box_boolean")! },
              ]
            : [
                // __extern_get(target, key) -> externref
                { op: "local.get", index: 3 },
                { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
                { op: "extern.convert_any" } as Instr,
                { op: "local.get", index: 1 },
                { op: "call", funcIdx: forwardIdx },
              ],
        // trap present → invoke it through the closure-call bridge driver.
        else: trapArm,
      } as Instr,
    ];
    return body;
  };

  // (#1355 Slice C) Prototype-trap dispatch builder. getPrototypeOf /
  // setPrototypeOf don't take a property key, so they don't fit `buildDispatch`'s
  // key-centric shape (param 1 = key). This builds a parallel body for them:
  //   §10.5.1 [[GetPrototypeOf]]: forward __getPrototypeOf(target); trap arm
  //     driver(handler, trap, target).
  //   §10.5.2 [[SetPrototypeOf]]: forward __object_setPrototypeOf(target, proto)
  //     (drop its externref result, push the proxy as a truthy success token);
  //     trap arm driver(handler, trap, target, proto). The front-guard coerces
  //     the trap's booleanish result via __is_truthy.
  // params: 0=proxyExtern, 1=(setPrototypeOf only) proto. locals: 2=p 3=trap.
  // Phase-C scope: NO §10.5.1/2 result-invariant checks (non-extensible target →
  // trap result must equal the target's actual prototype) — deferred to the
  // invariant slice; the trap result is returned as-is.
  const buildProtoDispatch = (trapFieldIdx: number, forwardName: string, isSet: boolean): Instr[] => {
    const forwardIdx = ctx.funcMap.get(forwardName)!;
    const driverIdx = isSet ? callSpoIdx : callGpoIdx;
    const trapArm: Instr[] = [
      // handler
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "extern.convert_any" } as Instr,
      // trap closure
      { op: "local.get", index: 3 },
      // target
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" } as Instr,
    ];
    if (isSet) {
      trapArm.push({ op: "local.get", index: 1 }); // proto arg
    }
    trapArm.push({ op: "call", funcIdx: driverIdx });

    const forwardArm: Instr[] = isSet
      ? [
          // __object_setPrototypeOf(target, proto) -> externref ; drop, push the
          // proxy itself as a truthy boolean-ish success token (no trap → spec
          // OrdinarySetPrototypeOf, which succeeded since we just performed it).
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
          { op: "extern.convert_any" } as Instr,
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: forwardIdx },
          { op: "drop" },
          { op: "local.get", index: 0 }, // truthy success token (the proxy externref)
        ]
      : [
          // __getPrototypeOf(target) -> externref
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
          { op: "extern.convert_any" } as Instr,
          { op: "call", funcIdx: forwardIdx },
        ];

    return [
      // p = ref.cast $Proxy(any.convert_extern(proxyExtern))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 2 },
      // if p.revoked: throw TypeError
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      { op: "if", blockType: { kind: "empty" }, then: throwRevoked() } as Instr,
      // trap = p.ptraps==null ? null : p.ptraps.<field>
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [{ op: "ref.null.extern" } as Instr],
        else: [
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
          { op: "ref.as_non_null" } as Instr,
          { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: trapFieldIdx },
        ],
      } as Instr,
      { op: "local.set", index: 3 },
      // if trap == null: forward to ordinary op on target ; else invoke trap.
      { op: "local.get", index: 3 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: forwardArm,
        else: trapArm,
      } as Instr,
    ];
  };

  // (#1355 Slice D) isExtensible / preventExtensions dispatch builder. Both take
  // only the target (no key, no value) and return a booleanish result, so they
  // share a shape but differ in the trap-absent forward:
  //   §10.5.3 [[IsExtensible]]:      forward __object_isExtensible(target) -> i32
  //     → box via __box_boolean to keep the dispatch externref-uniform.
  //   §10.5.4 [[PreventExtensions]]: forward __object_preventExtensions(target)
  //     -> externref (returns the object) ; drop it, push the proxy as a truthy
  //     success token (OrdinaryPreventExtensions always succeeds).
  // Both invoke driver(handler, trap, target). params: 0=proxyExtern, 1=unused.
  // locals: 2=p 3=trap. The front-guard coerces the dispatch's booleanish
  // externref back to the native helper's i32/externref return via __is_truthy /
  // direct. Phase-D scope: NO §10.5.3/4 result-invariants (e.g. preventExtensions
  // reporting success while the target stays extensible → TypeError) — deferred.
  const buildExt1Dispatch = (trapFieldIdx: number, forwardName: string, forwardReturnsI32: boolean): Instr[] => {
    const forwardIdx = ctx.funcMap.get(forwardName)!;
    const driverIdx = trapFieldIdx === TRAP_ISEXT ? callIsextIdx : callPrevextIdx;
    const trapArm: Instr[] = [
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "extern.convert_any" } as Instr,
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" } as Instr,
      { op: "call", funcIdx: driverIdx },
    ];
    const forwardArm: Instr[] = forwardReturnsI32
      ? [
          // __object_isExtensible(target) -> i32 ; box to a boolean any.
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
          { op: "extern.convert_any" } as Instr,
          { op: "call", funcIdx: forwardIdx },
          { op: "call", funcIdx: ctx.funcMap.get("__box_boolean")! },
        ]
      : [
          // __object_preventExtensions(target) -> externref ; drop, push the proxy
          // as a truthy success token.
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
          { op: "extern.convert_any" } as Instr,
          { op: "call", funcIdx: forwardIdx },
          { op: "drop" },
          { op: "local.get", index: 0 },
        ];
    return [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 2 },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      { op: "if", blockType: { kind: "empty" }, then: throwRevoked() } as Instr,
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [{ op: "ref.null.extern" } as Instr],
        else: [
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
          { op: "ref.as_non_null" } as Instr,
          { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: trapFieldIdx },
        ],
      } as Instr,
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: forwardArm,
        else: trapArm,
      } as Instr,
    ];
  };

  // (#1355 Slice E) ownKeys dispatch builder. §10.5.11 [[OwnPropertyKeys]] takes
  // only the target (no key, no value) and returns the trap's array-like result
  // externref. It shares the 1-arg target-only shape of getPrototypeOf /
  // isExtensible but differs in two ways:
  //   1. The trap-absent forward target differs PER CALL SITE — `Object.keys`
  //      forwards to `__object_keys` (own enumerable string keys), whereas
  //      `Object.getOwnPropertyNames` / `Reflect.ownKeys` forward to
  //      `__getOwnPropertyNames` (all own string keys). So `forwardName` is a
  //      builder parameter (a separate dispatch helper is registered per forward
  //      target, both reading the SAME `ownKeys` trap field).
  //   2. When the trap IS present, §10.5.11 step 8 / CreateListFromArrayLike
  //      (§7.3.18 step 2) requires the trap result to be an Object — otherwise a
  //      TypeError. This is acceptance criterion #3 of #1355
  //      (`ownKeys/return-not-list-object-throws.js`: `ownKeys` returning
  //      `undefined`). We implement the top-level Object-type check here: the
  //      result is an Object iff it is non-null and not a boxed primitive
  //      (number / boolean / string) — exactly the complement of ToObject's
  //      primitive cases. The PER-ELEMENT String|Symbol check (CreateListFromArrayLike
  //      element-type step) and the §10.5.11 result-invariants (no duplicate keys;
  //      non-extensible target → result must equal the target's exact own keys)
  //      stay deferred to the dedicated invariant slice.
  // params: 0=proxyExtern, 1=unused. locals: 2=p, 3=trap.
  const buildOwnKeysDispatch = (forwardName: string): Instr[] => {
    const forwardIdx = ctx.funcMap.get(forwardName)!;
    const isObjectNumIdx = ctx.funcMap.get("__typeof_number")!;
    const isObjectBoolIdx = ctx.funcMap.get("__typeof_boolean")!;
    const isObjectStrIdx = ctx.funcMap.get("__typeof_string")!;
    // The trap arm: invoke driver(handler, trap, target), then enforce the
    // CreateListFromArrayLike Object-type check on the result before returning.
    const trapArm: Instr[] = [
      // result = driver(handler, trap, target)
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "extern.convert_any" } as Instr,
      { op: "local.get", index: 3 },
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" } as Instr,
      { op: "call", funcIdx: callOwnKeysIdx },
      // Stash the result in the trap local (reused — its prior value is dead here)
      // so we can both type-check and return it. trap local (3) is externref.
      { op: "local.set", index: 3 },
      // §7.3.18 step 2 / §10.5.11: if Type(result) is not Object → TypeError.
      // not-Object ⇔ is_null OR __typeof_number OR __typeof_boolean OR
      // __typeof_string. Compute (isNumber | isBoolean | isString), OR with
      // is_null, and throw if set.
      { op: "local.get", index: 3 },
      { op: "ref.is_null" },
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: isObjectNumIdx },
      { op: "i32.or" },
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: isObjectBoolIdx },
      { op: "i32.or" },
      { op: "local.get", index: 3 },
      { op: "call", funcIdx: isObjectStrIdx },
      { op: "i32.or" },
      { op: "if", blockType: { kind: "empty" }, then: throwNotListObject() } as Instr,
      // result is an Object → return it.
      { op: "local.get", index: 3 },
    ];
    const forwardArm: Instr[] = [
      // __object_keys / __getOwnPropertyNames (target) -> externref ($ObjVec)
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" } as Instr,
      { op: "call", funcIdx: forwardIdx },
    ];
    return [
      // p = ref.cast $Proxy(any.convert_extern(proxyExtern))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 2 },
      // if p.revoked: throw TypeError
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      { op: "if", blockType: { kind: "empty" }, then: throwRevoked() } as Instr,
      // trap = p.ptraps==null ? null : p.ptraps.ownKeys
      { op: "local.get", index: 2 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [{ op: "ref.null.extern" } as Instr],
        else: [
          { op: "local.get", index: 2 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
          { op: "ref.as_non_null" } as Instr,
          { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: TRAP_OWNKEYS },
        ],
      } as Instr,
      { op: "local.set", index: 3 },
      { op: "local.get", index: 3 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: forwardArm,
        else: trapArm,
      } as Instr,
    ];
  };

  // (#1355 Slice F) defineProperty-trap dispatch builder. §10.5.6
  // [[DefineOwnProperty]] takes (P, Desc) — a property key AND a descriptor — so
  // it has a 3-arg trap shape that doesn't fit the key-only `buildDispatch`. This
  // builds `__proxy_define_dispatch(proxyExtern, key, desc) -> externref`
  // (booleanish):
  //   revoked → throw; read defineProperty trap; null → forward
  //   `__obj_define_from_desc(target, key, desc)` on the target (the native
  //   single-descriptor applier — the same helper the non-proxy standalone path
  //   uses; returns an externref); else invoke the trap with `(target, key, desc)`
  //   and the handler as `this` (§10.5.6 step 9 `Call(trap, handler, «target, P,
  //   descObj»)`). The descriptor is passed through to the user trap UNCHANGED (an
  //   opaque externref) — the trap's own body reads it; we do not decompose it.
  // params: 0=proxyExtern, 1=key, 2=desc. locals: 3=p, 4=trap.
  // Phase-F scope: NO §10.5.6 result-invariants (a present non-callable trap →
  // TypeError; reconciling the returned definition against the target's existing
  // non-configurable / non-extensible descriptor) — those need the standalone
  // descriptor-attribute model (#797/#1460/#1462) and are deferred to the
  // invariant slice (G), mirroring slices A–E. The trap result is returned as-is.
  const buildDefineDispatch = (): Instr[] => {
    const forwardIdx = ctx.funcMap.get("__obj_define_from_desc")!;
    const trapArm: Instr[] = [
      // handler
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "extern.convert_any" } as Instr,
      // trap closure
      { op: "local.get", index: 4 },
      // target
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" } as Instr,
      // key
      { op: "local.get", index: 1 },
      // desc (unchanged externref)
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: callDefineIdx },
    ];
    const forwardArm: Instr[] = [
      // __obj_define_from_desc(target, key, desc) -> externref
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "extern.convert_any" } as Instr,
      { op: "local.get", index: 1 },
      { op: "local.get", index: 2 },
      { op: "call", funcIdx: forwardIdx },
    ];
    return [
      // p = ref.cast $Proxy(any.convert_extern(proxyExtern))
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 3 },
      // if p.revoked: throw TypeError
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      { op: "if", blockType: { kind: "empty" }, then: throwRevoked() } as Instr,
      // trap = p.ptraps==null ? null : p.ptraps.defineProperty
      { op: "local.get", index: 3 },
      { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: [{ op: "ref.null.extern" } as Instr],
        else: [
          { op: "local.get", index: 3 },
          { op: "struct.get", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
          { op: "ref.as_non_null" } as Instr,
          { op: "struct.get", typeIdx: proxyTrapsTypeIdx, fieldIdx: TRAP_DEFINE },
        ],
      } as Instr,
      { op: "local.set", index: 4 },
      // if trap == null: forward; else invoke trap
      { op: "local.get", index: 4 },
      { op: "ref.is_null" },
      {
        op: "if",
        blockType: { kind: "val", type: externref },
        then: forwardArm,
        else: trapArm,
      } as Instr,
    ];
  };

  // FRESH locals array + ValType objects per dispatch function. `registerNative`
  // stores `locals` by reference, and the FINALIZE dead-type-elimination pass
  // (`eliminateDeadImports`) mutates `func.locals[i]` in place when renumbering
  // surviving types — a SHARED array would be remapped once per owning function,
  // desyncing the local's type index from the (separately-remapped) body
  // instructions and yielding "struct.get expected (ref null A) found (ref null
  // B)". Build a new array each time so each function owns its locals.
  const dispatchLocals = (): { name: string; type: ValType }[] => [
    { name: "p", type: { kind: "ref", typeIdx: proxyTypeIdx } as ValType },
    { name: "trap", type: { kind: "externref" } as ValType },
  ];

  registerNative(
    "__proxy_get_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDispatch(TRAP_GET, "__extern_get", false),
  );
  registerNative(
    "__proxy_set_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDispatch(TRAP_SET, "__extern_set", true),
  );
  registerNative(
    "__proxy_has_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDispatch(TRAP_HAS, "__extern_has", false),
  );
  // (#1355 Slice A) __proxy_delete_dispatch(proxyExtern, key, _recv) -> externref
  // (booleanish). §10.5.10 [[Delete]]: revoked→throw; read deleteProperty trap;
  // null→forward __delete_property on target (boxed boolean); else invoke trap
  // with `(target, key)` and the handler as `this`. The `__delete_property`
  // front-guard coerces the result back to i32 via `__is_truthy`. Phase-A scope:
  // NO §10.5.10 result-invariant check (a trap may not report a delete of a
  // non-configurable own property as successful) — that is a later invariant
  // slice. Takes 3 params to match `buildDispatch`'s hardcoded local layout
  // (p=local 3, trap=local 4 after the 3 params); the [[Delete]] trap signature
  // has no receiver, so param 2 is an unused placeholder (the front-guard passes
  // the proxy itself, never read on the delete path).
  registerNative(
    "__proxy_delete_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDispatch(TRAP_DELETE, "__delete_property", false),
  );
  // (#1355 Slice B) __proxy_gopd_dispatch(proxy, key, _recv) -> externref.
  // §10.5.5 [[GetOwnProperty]]: revoked→throw; read getOwnPropertyDescriptor
  // trap; null→forward __getOwnPropertyDescriptor on target (returns the
  // descriptor object or undefined externref directly — like get, no boxing);
  // else invoke trap with `(target, key)` and the handler as `this`. Takes 3
  // params to match buildDispatch's local layout; the [[GetOwnProperty]] trap
  // signature has no receiver, so param 2 is an unused placeholder. Phase-B
  // scope: NO §10.5.5 result-invariant checks (trap must return an Object or
  // undefined; non-configurable/non-extensible consistency) — deferred to the
  // invariant slice; the trap result is returned as-is.
  registerNative(
    "__proxy_gopd_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDispatch(TRAP_GOPD, "__getOwnPropertyDescriptor", false),
  );
  // (#1355 Slice C) __proxy_gpo_dispatch(proxy, _unused) -> externref.
  // §10.5.1 [[GetPrototypeOf]]. 2 params (the second unused) so the local layout
  // (p=local 2, trap=local 3) matches `buildProtoDispatch` / the setPrototypeOf
  // dispatch; the [[GetPrototypeOf]] trap takes only the target.
  registerNative(
    "__proxy_gpo_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildProtoDispatch(TRAP_GPO, "__getPrototypeOf", false),
  );
  // (#1355 Slice C) __proxy_spo_dispatch(proxy, proto) -> externref (booleanish).
  // §10.5.2 [[SetPrototypeOf]]. The __object_setPrototypeOf front-guard coerces
  // the result via __is_truthy.
  registerNative(
    "__proxy_spo_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildProtoDispatch(TRAP_SPO, "__object_setPrototypeOf", true),
  );
  // (#1355 Slice D) __proxy_isext_dispatch(proxy, _unused) -> externref
  // (booleanish). §10.5.3 [[IsExtensible]]. Front-guard coerces via __is_truthy.
  registerNative(
    "__proxy_isext_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildExt1Dispatch(TRAP_ISEXT, "__object_isExtensible", true),
  );
  // (#1355 Slice D) __proxy_prevext_dispatch(proxy, _unused) -> externref
  // (booleanish). §10.5.4 [[PreventExtensions]]. The __object_preventExtensions
  // front-guard returns the dispatch externref directly (helper returns externref).
  registerNative(
    "__proxy_prevext_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildExt1Dispatch(TRAP_PREVEXT, "__object_preventExtensions", false),
  );
  // (#1355 Slice E) ownKeys — TWO dispatch helpers reading the SAME `ownKeys`
  // trap field but with different trap-absent forwards (§10.5.11 [[OwnPropertyKeys]]):
  //   __proxy_ownkeys_keys_dispatch  — forwards __object_keys (Object.keys path)
  //   __proxy_ownkeys_names_dispatch — forwards __getOwnPropertyNames
  //                                    (Object.getOwnPropertyNames / Reflect.ownKeys)
  // Both run the same trap + CreateListFromArrayLike Object-type check when the
  // trap is present; they diverge only in the absent-trap forward target.
  registerNative(
    "__proxy_ownkeys_keys_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildOwnKeysDispatch("__object_keys"),
  );
  registerNative(
    "__proxy_ownkeys_names_dispatch",
    [externref, externref],
    [externref],
    dispatchLocals(),
    buildOwnKeysDispatch("__getOwnPropertyNames"),
  );
  // (#1355 Slice F) __proxy_define_dispatch(proxy, key, desc) -> externref
  // (booleanish). §10.5.6 [[DefineOwnProperty]]: revoked→throw; read
  // defineProperty trap; null→forward __obj_define_from_desc on the target; else
  // invoke trap with `(target, key, desc)` and the handler as `this`. 3 params
  // (proxy, key, desc) so locals p=3, trap=4. The __obj_define_from_desc
  // front-guard returns the dispatch externref directly (the helper returns
  // externref). Phase-F scope: NO §10.5.6 result-invariants (deferred to the
  // descriptor-model invariant slice G).
  registerNative(
    "__proxy_define_dispatch",
    [externref, externref, externref],
    [externref],
    dispatchLocals(),
    buildDefineDispatch(),
  );

  // ── __proxy_create(target, handler) -> externref ──────────────────────────
  //
  // §28.2.1.1 ProxyCreate. Reads get/set/has/apply off `handler` via
  // `__extern_get`. CONTRACT: the call site (new-super.ts) builds the handler as
  // an OPEN `$Object` (`compileObjectLiteralAsExternref`) so these reads resolve
  // — a closed typed struct would hide its fields from the open-object prop-map
  // walk and every trap would read null. Each read yields the trap **closure
  // externref** (or undefined → stored null → dispatch forwards to the target).
  //  1. target/handler null/undefined → TypeError (§28.2.1.1 step 1/2; full
  //     object-ness is Phase 2 / #1355).
  //  2. build `$ProxyTraps` from the 4 reads; build `$Proxy` (phandler kept for
  //     the trap `this`).
  //
  // params: 0=target 1=handler ; locals: 2=getT 3=setT 4=hasT 5=applyT (externref)
  {
    const externGetIdx = ctx.funcMap.get("__extern_get")!;
    const notObjectMsg = "Cannot create proxy with a non-object as target or handler";
    addStringConstantGlobal(ctx, notObjectMsg);
    // FRESH array per use (this block is embedded in BOTH the target-null and
    // handler-null checks of the SAME `__proxy_create` body — a shared array gets
    // double-remapped by the FINALIZE dead-code funcIdx walk, corrupting the
    // baked `call __new_TypeError`).
    const throwNotObject = (): Instr[] => [
      ...stringConstantExternrefInstrs(ctx, notObjectMsg),
      { op: "call", funcIdx: typeErrorCtorIdx },
      { op: "throw", tagIdx: exnTagIdx } as Instr,
    ];
    // readTrap(name) → __extern_get(handler, "name") (undefined → dispatch nulls).
    const readTrap = (name: string): Instr[] => [
      { op: "local.get", index: 1 },
      ...stringConstantExternrefInstrs(ctx, name),
      { op: "call", funcIdx: externGetIdx },
      // (#2106 S1) a missing trap resolves to the undefined singleton —
      // normalize to null so the trap-dispatch null checks keep working.
      ...(ctx.funcMap.has("__nullish_to_null")
        ? [{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! } as Instr]
        : []),
    ];
    const proxyCreateBody: Instr[] = [
      // if target == null → throw
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: throwNotObject() } as Instr,
      // if handler == null → throw
      { op: "local.get", index: 1 },
      { op: "any.convert_extern" },
      { op: "ref.is_null" },
      { op: "if", blockType: { kind: "empty" }, then: throwNotObject() } as Instr,
      // read the traps off the (open) handler. (#1355) deleteProperty appended.
      ...readTrap("get"),
      { op: "local.set", index: 2 },
      ...readTrap("set"),
      { op: "local.set", index: 3 },
      ...readTrap("has"),
      { op: "local.set", index: 4 },
      ...readTrap("apply"),
      { op: "local.set", index: 5 },
      ...readTrap("deleteProperty"),
      { op: "local.set", index: 6 },
      ...readTrap("getOwnPropertyDescriptor"),
      { op: "local.set", index: 7 },
      ...readTrap("getPrototypeOf"),
      { op: "local.set", index: 8 },
      ...readTrap("setPrototypeOf"),
      { op: "local.set", index: 9 },
      ...readTrap("isExtensible"),
      { op: "local.set", index: 10 },
      ...readTrap("preventExtensions"),
      { op: "local.set", index: 11 },
      ...readTrap("ownKeys"),
      { op: "local.set", index: 12 },
      ...readTrap("defineProperty"),
      { op: "local.set", index: 13 },
      // proxy fields (standalone $Proxy struct):
      { op: "i32.const", value: 1 }, // ptag = PROXY_TAG (1; bare ref.test $Proxy is the real discriminator)
      { op: "local.get", index: 0 }, // ptarget (externref → anyref)
      { op: "any.convert_extern" } as Instr,
      { op: "local.get", index: 1 }, // phandler (externref → anyref; trap `this`)
      { op: "any.convert_extern" } as Instr,
      // ptraps = struct.new $ProxyTraps
      //   (getT,setT,hasT,applyT,delT,gopdT,gpoT,spoT,isextT,prevextT,ownKeysT)
      { op: "local.get", index: 2 },
      { op: "local.get", index: 3 },
      { op: "local.get", index: 4 },
      { op: "local.get", index: 5 },
      { op: "local.get", index: 6 },
      { op: "local.get", index: 7 },
      { op: "local.get", index: 8 },
      { op: "local.get", index: 9 },
      { op: "local.get", index: 10 },
      { op: "local.get", index: 11 },
      { op: "local.get", index: 12 },
      { op: "local.get", index: 13 },
      { op: "struct.new", typeIdx: proxyTrapsTypeIdx } as Instr,
      { op: "i32.const", value: 0 }, // revoked = 0
      { op: "struct.new", typeIdx: proxyTypeIdx } as Instr,
      { op: "extern.convert_any" } as Instr,
    ];
    registerNative(
      "__proxy_create",
      [externref, externref],
      [externref],
      [
        { name: "getT", type: externref },
        { name: "setT", type: externref },
        { name: "hasT", type: externref },
        { name: "applyT", type: externref },
        { name: "delT", type: externref }, // (#1355 Slice A)
        { name: "gopdT", type: externref }, // (#1355 Slice B)
        { name: "gpoT", type: externref }, // (#1355 Slice C) getPrototypeOf
        { name: "spoT", type: externref }, // (#1355 Slice C) setPrototypeOf
        { name: "isextT", type: externref }, // (#1355 Slice D) isExtensible
        { name: "prevextT", type: externref }, // (#1355 Slice D) preventExtensions
        { name: "ownKeysT", type: externref }, // (#1355 Slice E) ownKeys
        { name: "defineT", type: externref }, // (#1355 Slice F) defineProperty
      ],
      proxyCreateBody,
    );
  }

  // ── __proxy_revoke(proxyExtern) -> () : set revoked=1, null target/handler/traps ──
  // params: 0=proxyExtern(externref) ; locals: 1=p(ref $Proxy)
  {
    const revokeBody: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.cast", typeIdx: proxyTypeIdx },
      { op: "local.set", index: 1 },
      { op: "local.get", index: 1 },
      { op: "i32.const", value: 1 },
      { op: "struct.set", typeIdx: proxyTypeIdx, fieldIdx: F_REVOKED },
      // null out target/handler/traps (§28.2.2.1.1 RevocableProxy revoke).
      { op: "local.get", index: 1 },
      { op: "ref.null.extern" },
      { op: "any.convert_extern" } as Instr,
      { op: "struct.set", typeIdx: proxyTypeIdx, fieldIdx: F_PTARGET },
      { op: "local.get", index: 1 },
      { op: "ref.null.extern" },
      { op: "any.convert_extern" } as Instr,
      { op: "struct.set", typeIdx: proxyTypeIdx, fieldIdx: F_PHANDLER },
      { op: "local.get", index: 1 },
      { op: "ref.null", typeIdx: proxyTrapsTypeIdx },
      { op: "struct.set", typeIdx: proxyTypeIdx, fieldIdx: F_PTRAPS },
    ];
    registerNative(
      "__proxy_revoke",
      [externref],
      [],
      [{ name: "p", type: { kind: "ref", typeIdx: proxyTypeIdx } as ValType }],
      revokeBody,
    );
  }

  // ── Patch the `ref.test $Proxy` guard onto the FRONT of __extern_get/set/has ──
  //
  // Every standalone property read/write/has routes through these helpers, so a
  // single front-guard covers `p.x`, `p[k]`, `k in p`, etc. uniformly (the
  // architect's "branch at the helper" approach — far less churn than editing
  // every property-access.ts call site). The guard tests the RAW externref param
  // 0 (any.convert_extern → ref.test $Proxy) BEFORE the ordinary body's
  // `ref.cast $Object` runs; a proxy IS-A $Object so it would otherwise take the
  // plain-object path and miss its traps.
  const getDispatchIdx = ctx.funcMap.get("__proxy_get_dispatch")!;
  const setDispatchIdx = ctx.funcMap.get("__proxy_set_dispatch")!;
  const hasDispatchIdx = ctx.funcMap.get("__proxy_has_dispatch")!;
  const deleteDispatchIdx = ctx.funcMap.get("__proxy_delete_dispatch")!; // (#1355 Slice A)
  const gopdDispatchIdx = ctx.funcMap.get("__proxy_gopd_dispatch")!; // (#1355 Slice B)
  const gpoDispatchIdx = ctx.funcMap.get("__proxy_gpo_dispatch")!; // (#1355 Slice C)
  const spoDispatchIdx = ctx.funcMap.get("__proxy_spo_dispatch")!; // (#1355 Slice C)
  const isextDispatchIdx = ctx.funcMap.get("__proxy_isext_dispatch")!; // (#1355 Slice D)
  const prevextDispatchIdx = ctx.funcMap.get("__proxy_prevext_dispatch")!; // (#1355 Slice D)
  const ownKeysKeysDispatchIdx = ctx.funcMap.get("__proxy_ownkeys_keys_dispatch")!; // (#1355 Slice E)
  const ownKeysNamesDispatchIdx = ctx.funcMap.get("__proxy_ownkeys_names_dispatch")!; // (#1355 Slice E)
  const defineDispatchIdx = ctx.funcMap.get("__proxy_define_dispatch")!; // (#1355 Slice F)

  const findBody = (name: string): Instr[] | undefined => ctx.mod.functions.find((f) => f.name === name)?.body;

  // __extern_get(obj, key) -> externref : if proxy → return get_dispatch(obj,key,obj)
  const getBody = findBody("__extern_get");
  if (getBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 0 }, // receiver = the proxy itself
          { op: "call", funcIdx: getDispatchIdx },
          { op: "return" },
        ],
      } as Instr,
    ];
    getBody.unshift(...guard);
  }

  // __extern_set(obj, key, value) -> () : if proxy → set_dispatch(obj,key,value); drop; return
  const setBody = findBody("__extern_set");
  if (setBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: setDispatchIdx },
          { op: "drop" },
          { op: "return" },
        ],
      } as Instr,
    ];
    setBody.unshift(...guard);
  }

  // __extern_has(obj, key) -> i32 : if proxy → ToBoolean(has_dispatch(obj,key,obj))
  // The dispatch returns the trap's booleanish result as an externref; coerce to
  // i32 via `__is_truthy` (reliably present in the standalone runtime — same
  // helper the accessor/array-callback truthiness sites use).
  const hasBody = findBody("__extern_has");
  if (hasBody) {
    const isTruthyIdx = ctx.funcMap.get("__is_truthy")!;
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 0 }, // receiver = the proxy itself
          { op: "call", funcIdx: hasDispatchIdx },
          { op: "call", funcIdx: isTruthyIdx },
          { op: "return" },
        ],
      } as Instr,
    ];
    hasBody.unshift(...guard);
  }

  // (#1355 Slice A) __delete_property(obj, key) -> i32 : if proxy →
  // ToBoolean(delete_dispatch(obj,key)). `delete p.x` / `Reflect.deleteProperty`
  // both route through __delete_property, so this single front-guard covers both.
  // The dispatch returns the deleteProperty trap's booleanish externref result;
  // coerce to i32 via `__is_truthy` (same as the has guard).
  const deleteBody = findBody("__delete_property");
  if (deleteBody) {
    const isTruthyIdx = ctx.funcMap.get("__is_truthy")!;
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 0 }, // unused receiver placeholder (3-param dispatch)
          { op: "call", funcIdx: deleteDispatchIdx },
          { op: "call", funcIdx: isTruthyIdx },
          { op: "return" },
        ],
      } as Instr,
    ];
    deleteBody.unshift(...guard);
  }

  // (#1355 Slice B) __getOwnPropertyDescriptor(obj, key) -> externref : if proxy
  // → gopd_dispatch(obj,key,obj). `Object.getOwnPropertyDescriptor(p, k)` and
  // `Reflect.getOwnPropertyDescriptor(p, k)` both fall back to this helper for
  // dynamic receivers (calls.ts). The dispatch returns the trap's descriptor
  // externref (or undefined) directly — no coercion, like the get guard.
  const gopdBody = findBody("__getOwnPropertyDescriptor");
  if (gopdBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 0 }, // unused receiver placeholder (3-param dispatch)
          { op: "call", funcIdx: gopdDispatchIdx },
          { op: "return" },
        ],
      } as Instr,
    ];
    gopdBody.unshift(...guard);
  }

  // (#1355 Slice C) __getPrototypeOf(obj) -> externref : if proxy →
  // gpo_dispatch(obj, obj). `Object.getPrototypeOf(p)` / `Reflect.getPrototypeOf`
  // and `p.__proto__` reads fall back to this helper for dynamic receivers. The
  // dispatch returns the trap's prototype externref (or the target's, when the
  // trap is absent) directly — same return type, no coercion.
  const gpoBody = findBody("__getPrototypeOf");
  if (gpoBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 }, // unused 2nd param placeholder
          { op: "call", funcIdx: gpoDispatchIdx },
          { op: "return" },
        ],
      } as Instr,
    ];
    gpoBody.unshift(...guard);
  }

  // (#1355 Slice C) __object_setPrototypeOf(obj, proto) -> externref : if proxy →
  // spo_dispatch(obj, proto). `Object.setPrototypeOf(p, v)` /
  // `Reflect.setPrototypeOf` and `p.__proto__ = v` writes route here for dynamic
  // receivers. The dispatch returns the trap's booleanish externref (or a truthy
  // success token when the trap is absent and the ordinary set succeeded); we
  // return it as-is — the native helper's contract is also "returns an externref"
  // (it returns the object), so the booleanish externref is type-compatible and
  // the caller (Object.setPrototypeOf returns its first arg) ignores the value.
  const spoBody = findBody("__object_setPrototypeOf");
  if (spoBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "call", funcIdx: spoDispatchIdx },
          { op: "return" },
        ],
      } as Instr,
    ];
    spoBody.unshift(...guard);
  }

  // (#1355 Slice D) __object_isExtensible(obj) -> i32 : if proxy →
  // ToBoolean(isext_dispatch(obj)). `Object.isExtensible(p)` /
  // `Reflect.isExtensible` route here for dynamic receivers. The dispatch returns
  // the trap's booleanish externref; coerce to i32 via `__is_truthy`.
  const isextBody = findBody("__object_isExtensible");
  if (isextBody) {
    const isTruthyIdx = ctx.funcMap.get("__is_truthy")!;
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 }, // unused 2nd param placeholder
          { op: "call", funcIdx: isextDispatchIdx },
          { op: "call", funcIdx: isTruthyIdx },
          { op: "return" },
        ],
      } as Instr,
    ];
    isextBody.unshift(...guard);
  }

  // (#1355 Slice D) __object_preventExtensions(obj) -> externref : if proxy →
  // prevext_dispatch(obj). `Object.preventExtensions(p)` / `Reflect.*` /
  // `Object.seal`/`Object.freeze` (which call preventExtensions) route here. The
  // dispatch returns a booleanish externref (or the proxy success token); we
  // return it directly — the helper's contract is "returns an externref" (the
  // object), type-compatible, and the JS-level caller ignores the value.
  const prevextBody = findBody("__object_preventExtensions");
  if (prevextBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 }, // unused 2nd param placeholder
          { op: "call", funcIdx: prevextDispatchIdx },
          { op: "return" },
        ],
      } as Instr,
    ];
    prevextBody.unshift(...guard);
  }

  // (#1355 Slice E) __object_keys(obj) -> externref : if proxy →
  // ownkeys_keys_dispatch(obj). `Object.keys(p)` lowers to `__object_keys` for a
  // dynamic receiver, so this single front-guard covers the Object.keys path. The
  // dispatch reads the ownKeys trap, runs it (with the CreateListFromArrayLike
  // Object-type check) or forwards to the ordinary `__object_keys` on the target;
  // it returns the result externref ($ObjVec or the trap's array) directly.
  const objectKeysBody = findBody("__object_keys");
  if (objectKeysBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 }, // unused 2nd param placeholder
          { op: "call", funcIdx: ownKeysKeysDispatchIdx },
          { op: "return" },
        ],
      } as Instr,
    ];
    objectKeysBody.unshift(...guard);
  }

  // (#1355 Slice E) __getOwnPropertyNames(obj) -> externref : if proxy →
  // ownkeys_names_dispatch(obj). `Object.getOwnPropertyNames(p)` /
  // `Reflect.ownKeys(p)` route here for a dynamic receiver. Same ownKeys trap,
  // but the trap-absent forward is `__getOwnPropertyNames` (all own string keys,
  // no enumerable filter) rather than `__object_keys`. Returns the result
  // externref directly.
  const ownNamesBody = findBody("__getOwnPropertyNames");
  if (ownNamesBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 0 }, // unused 2nd param placeholder
          { op: "call", funcIdx: ownKeysNamesDispatchIdx },
          { op: "return" },
        ],
      } as Instr,
    ];
    ownNamesBody.unshift(...guard);
  }

  // (#1355 Slice F) __obj_define_from_desc(obj, key, desc) -> externref : if proxy
  // → define_dispatch(obj, key, desc). `Object.defineProperty(p, k, desc)` and
  // `Reflect.defineProperty(p, k, desc)` route here for a dynamic receiver (the
  // standalone single-descriptor applier funnel — the call site routes inline
  // `{...}` literals on a non-static-struct receiver through here too, see
  // object-ops.ts, so this single front-guard covers both descriptor forms). The
  // dispatch reads the defineProperty trap, runs it with `(target, key, desc)` (the
  // descriptor passed through UNCHANGED) or forwards to the ordinary
  // `__obj_define_from_desc` on the target; it returns the result externref
  // directly (the helper's contract is "returns an externref").
  const objDefineBody = findBody("__obj_define_from_desc");
  if (objDefineBody) {
    const guard: Instr[] = [
      { op: "local.get", index: 0 },
      { op: "any.convert_extern" },
      { op: "ref.test", typeIdx: proxyTypeIdx },
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 0 },
          { op: "local.get", index: 1 },
          { op: "local.get", index: 2 },
          { op: "call", funcIdx: defineDispatchIdx },
          { op: "return" },
        ],
      } as Instr,
    ];
    objDefineBody.unshift(...guard);
  }

  void objectTypeIdx;
}

/**
 * (#1100) Fill the reserved Proxy trap-invoke driver bodies at FINALIZE, AFTER
 * `emitClosureMethodCallExportN(2..4)` have registered `__call_fn_method_2/3/4`
 * in `funcMap`. Each driver is a thin wrapper around the closure-call bridge
 * that threads the handler as `this` and forwards the spec trap args:
 *
 *   __proxy_call_get(handler, trap, target, key, receiver)
 *       = __call_fn_method_3(handler, trap, target, key, receiver)
 *   __proxy_call_set(handler, trap, target, key, value, receiver)
 *       = __call_fn_method_4(handler, trap, target, key, value, receiver)
 *   __proxy_call_has(handler, trap, target, key)
 *       = __call_fn_method_2(handler, trap, target, key)
 *
 * No-op when the proxy runtime was never reserved (`ctx.proxyDispatchReserved`).
 * When a driver WAS reserved but the matching dispatcher was never emitted (no
 * closure of that arity exists — so no real trap of that arity could have been
 * installed either), the body is filled with `ref.null.extern` so the module
 * still verifies — mirrors `fillAccessorDrivers` / `fillApplyClosure`.
 */
export function fillProxyDispatch(ctx: CodegenContext): void {
  if (!ctx.proxyDispatchReserved) return;

  // The trap is invoked through the proven open-`any` closure bridge
  // `__apply_closure(fn, recv, argsVec)` — the SAME path `__extern_method_call`
  // uses for `o.m(...)` on an open receiver — NOT `__call_fn_method_N`. Rationale:
  // `__apply_closure` reads its args from a `$ObjVec` via `__extern_get_idx` and
  // re-dispatches by runtime arity, so it tolerates ANY user trap closure
  // signature (the `__call_fn_method_N` exports bind a single per-arity wrapper
  // type + box the result by the wrapper's declared return type, which mismatched
  // the trap closure's ABI). `recv` is the handler (trap `this`, §10.5.x).
  const applyClosureIdx = ctx.funcMap.get("__apply_closure");
  const objVecNewIdx = ctx.funcMap.get("__objvec_new");
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  const externref: ValType = { kind: "externref" };

  // Build the args $ObjVec from the driver's trap-arg params (indices 2..2+argc)
  // and call __apply_closure(trap=param1, handler=param0, vec). Uses a `$vec`
  // local appended after the driver's params.
  const fill = (name: string, argCount: number): void => {
    const driverIdx = ctx.funcMap.get(name);
    if (driverIdx === undefined) return;
    const driverFn = definedFuncAt(ctx, driverIdx);
    if (!driverFn) return;
    if (applyClosureIdx === undefined || objVecNewIdx === undefined || objVecPushIdx === undefined) {
      // Closure bridge / objvec builders absent (no standalone closure in the
      // module) → no trap could have been installed; keep a valid stub body.
      driverFn.body = [{ op: "ref.null.extern" } as Instr];
      return;
    }
    // params: 0=handler 1=trap 2..(argCount+1)=trap args. vec local index =
    // argCount + 2 (after all params).
    const vecLocal = argCount + 2;
    driverFn.locals = [{ name: "vec", type: externref }];
    const body: Instr[] = [
      { op: "call", funcIdx: objVecNewIdx } as Instr, // vec = __objvec_new()
      { op: "local.set", index: vecLocal } as Instr,
    ];
    for (let a = 0; a < argCount; a++) {
      body.push({ op: "local.get", index: vecLocal } as Instr);
      body.push({ op: "local.get", index: 2 + a } as Instr);
      body.push({ op: "call", funcIdx: objVecPushIdx } as Instr); // __objvec_push(vec, arg_a)
    }
    // return __apply_closure(trap, handler, vec)
    body.push({ op: "local.get", index: 1 } as Instr); // trap
    body.push({ op: "local.get", index: 0 } as Instr); // handler (recv → this)
    body.push({ op: "local.get", index: vecLocal } as Instr); // args vec
    body.push({ op: "call", funcIdx: applyClosureIdx } as Instr);
    driverFn.body = body;
  };
  fill(PROXY_CALL_GET, 3); // (target, key, receiver)
  fill(PROXY_CALL_SET, 4); // (target, key, value, receiver)
  fill(PROXY_CALL_HAS, 2); // (target, key)
  fill(PROXY_CALL_DELETE, 2); // (#1355 Slice A) deleteProperty (target, key)
  fill(PROXY_CALL_GOPD, 2); // (#1355 Slice B) getOwnPropertyDescriptor (target, key)
  fill(PROXY_CALL_GPO, 1); // (#1355 Slice C) getPrototypeOf (target)
  fill(PROXY_CALL_SPO, 2); // (#1355 Slice C) setPrototypeOf (target, proto)
  fill(PROXY_CALL_ISEXT, 1); // (#1355 Slice D) isExtensible (target)
  fill(PROXY_CALL_PREVEXT, 1); // (#1355 Slice D) preventExtensions (target)
  fill(PROXY_CALL_OWNKEYS, 1); // (#1355 Slice E) ownKeys (target)
  fill(PROXY_CALL_DEFINE, 3); // (#1355 Slice F) defineProperty (target, key, desc)
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
 * (#2863 Phase 3) Native standalone `Object.groupBy(items, keyFn)` — ES2024
 * §20.1.2.14 (GroupBy with keyCoercion PROPERTY). Under `--target
 * standalone`/`wasi` there is no host `__object_groupBy`, so the call site
 * (`expressions/calls.ts`) hits the #1472 dynamic-shape refusal. This registers
 * a Wasm-native helper that:
 *
 *   out = OrdinaryObjectCreate(null)                   // __new_plain_object
 *   for i in 0 .. __extern_length(items):
 *     val = __extern_get_idx(items, i)
 *     key = keyFn(val, i)  via __apply_closure(keyFn, undefined, [val, boxNum(i)])
 *     group = __extern_get(out, key)                   // ToPropertyKey done inside
 *     if group is null: group = __objvec_new(); __extern_set(out, key, group)
 *     __objvec_push(group, val)
 *   return out
 *
 * The keyFn is invoked through the proven open-`any` closure bridge
 * `__apply_closure` (the same path Proxy traps / `__extern_method_call` use), so
 * any user callback arity ≤ 2 is dispatched correctly (§ passes `(value,
 * index)`; a 1-arg arrow ignores the index). ToPropertyKey is applied uniformly
 * by `__extern_get`/`__extern_set`, so the get-probe and the set use the same
 * coerced key. Each group value is the ORIGINAL element (a `$ObjVec`, i.e. a
 * real Array on read-back).
 *
 * Registered lazily (append-only — no funcidx shift of the in-flight function)
 * from the call site, NOT unconditionally in `ensureObjectRuntime`, so a module
 * with no `Object.groupBy` pays nothing (and does not reserve the closure
 * bridge). Returns the `__object_groupBy` funcIdx.
 *
 * `items` is iterated via `__extern_length`/`__extern_get_idx`, which index a
 * real Array (`$__vec_base`) and array-like `$Object`s reliably — generic
 * iterables (Map/Set/user iterators) are the separate iterator-carrier follow-up
 * (#2864) and are NOT handled here.
 */
export function ensureObjectGroupBy(ctx: CodegenContext): number {
  ensureObjectRuntime(ctx);
  const existing = ctx.funcMap.get("__object_groupBy");
  if (existing !== undefined) return existing;

  const applyClosureIdx = reserveApplyClosure(ctx);
  const newPlainObjectIdx = ctx.funcMap.get("__new_plain_object")!;
  const externLengthIdx = ctx.funcMap.get("__extern_length")!;
  const externGetIdxIdx = ctx.funcMap.get("__extern_get_idx")!;
  const externGetIdx = ctx.funcMap.get("__extern_get")!;
  const externSetIdx = ctx.funcMap.get("__extern_set")!;
  const objVecNewIdx = ctx.funcMap.get("__objvec_new")!;
  const objVecPushIdx = ctx.funcMap.get("__objvec_push")!;
  const boxNumIdx = ctx.funcMap.get("__box_number")!;

  // params: 0=items 1=keyFn
  // locals: 2=len(f64) 3=i(i32) 4=out 5=val 6=key 7=group 8=args
  const body: Instr[] = [
    { op: "call", funcIdx: newPlainObjectIdx },
    { op: "local.set", index: 4 },
    { op: "local.get", index: 0 },
    { op: "call", funcIdx: externLengthIdx },
    { op: "local.set", index: 2 },
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
            // if f64(i) >= len → break
            { op: "local.get", index: 3 },
            { op: "f64.convert_i32_s" },
            { op: "local.get", index: 2 },
            { op: "f64.ge" },
            { op: "br_if", depth: 1 },
            // val = __extern_get_idx(items, f64(i))
            { op: "local.get", index: 0 },
            { op: "local.get", index: 3 },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: externGetIdxIdx },
            { op: "local.set", index: 5 },
            // args = __objvec_new(); push(val); push(box(i))
            { op: "call", funcIdx: objVecNewIdx },
            { op: "local.set", index: 8 },
            { op: "local.get", index: 8 },
            { op: "local.get", index: 5 },
            { op: "call", funcIdx: objVecPushIdx },
            { op: "local.get", index: 8 },
            { op: "local.get", index: 3 },
            { op: "f64.convert_i32_s" },
            { op: "call", funcIdx: boxNumIdx },
            { op: "call", funcIdx: objVecPushIdx },
            // key = __apply_closure(keyFn, undefined, args)
            { op: "local.get", index: 1 },
            { op: "ref.null.extern" },
            { op: "local.get", index: 8 },
            { op: "call", funcIdx: applyClosureIdx },
            { op: "local.set", index: 6 },
            // group = __extern_get(out, key)
            { op: "local.get", index: 4 },
            { op: "local.get", index: 6 },
            { op: "call", funcIdx: externGetIdx },
            // (#2106 S1) group-absent = undefined singleton → normalize to
            // null so the presence check below keeps its legacy shape.
            ...(ctx.funcMap.has("__nullish_to_null")
              ? [{ op: "call", funcIdx: ctx.funcMap.get("__nullish_to_null")! } as Instr]
              : []),
            { op: "local.set", index: 7 },
            // if group is null → group = __objvec_new(); __extern_set(out, key, group)
            { op: "local.get", index: 7 },
            { op: "ref.is_null" },
            {
              op: "if",
              blockType: { kind: "empty" },
              then: [
                { op: "call", funcIdx: objVecNewIdx },
                { op: "local.set", index: 7 },
                { op: "local.get", index: 4 },
                { op: "local.get", index: 6 },
                { op: "local.get", index: 7 },
                { op: "call", funcIdx: externSetIdx },
              ],
            },
            // __objvec_push(group, val)
            { op: "local.get", index: 7 },
            { op: "local.get", index: 5 },
            { op: "call", funcIdx: objVecPushIdx },
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
    { op: "local.get", index: 4 },
  ];

  const typeIdx = addFuncType(ctx, [{ kind: "externref" }, { kind: "externref" }], [{ kind: "externref" }]);
  const funcIdx = mintDefinedFunc(ctx);
  ctx.funcMap.set("__object_groupBy", funcIdx);
  pushDefinedFunc(ctx, funcIdx, {
    name: "__object_groupBy",
    typeIdx,
    locals: [
      { name: "len", type: { kind: "f64" } },
      { name: "i", type: { kind: "i32" } },
      { name: "out", type: { kind: "externref" } },
      { name: "val", type: { kind: "externref" } },
      { name: "key", type: { kind: "externref" } },
      { name: "group", type: { kind: "externref" } },
      { name: "args", type: { kind: "externref" } },
    ],
    body,
    exported: false,
  });
  return funcIdx;
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
  const funcIdx = mintDefinedFunc(ctx);
  pushDefinedFunc(ctx, funcIdx, {
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
  const bridgeFn = definedFuncAt(ctx, bridgeIdx);
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
 * (#2047) Non-array vec carriers that are NEVER JS arrays and must report
 * `Array.isArray === false` per ES §7.2.2:
 *   - `i32_byte` — ArrayBuffer / DataView backing store.
 *   - `i32_elem` — native (standalone/WASI) `Int32Array`/`Uint32Array` element
 *     storage. (#2835) Split from `i32_byte`: before the split Int32/Uint32 shared
 *     the `i32_byte` key, so they were ALREADY excluded here (Array.isArray === false,
 *     spec-correct — a TypedArray is not an Array). Keeping `i32_elem` in this set
 *     preserves that exactly; omitting it would regress `Array.isArray(new
 *     Int32Array(1))` to `true`. This set drives ONLY `__extern_is_array`, not
 *     element access / `.length` / iteration, so excluding the carrier does not
 *     affect Int32Array's array-like behaviour — only its IsArray result.
 *   - `i8_byte`  — native (standalone/WASI) `Uint8Array` packed-byte storage.
 * The codebase already excludes `i32_byte` vecs from array treatment elsewhere
 * (`type-coercion.ts` — the `__make_iterable` shim skips it), so this filter is
 * consistent precedent. NOTE: the FLOAT TypedArrays (Float32Array, Float64Array)
 * share the generic `f64` vec carrier with `number[]`, so a struct-level
 * `ref.test` cannot distinguish them without a brand bit — `__vec_f64` is kept
 * IN the carrier list and `Array.isArray(new Float64Array(1))` remains a known
 * residual false-positive tracked for a brand-bit follow-up. Only the
 * exclusively-non-array packed carriers can be filtered cleanly.
 */
export const NON_ARRAY_BYTE_VEC_ELEM_KINDS: ReadonlySet<string> = new Set(["i32_byte", "i32_elem", "i8_byte"]);

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
  const fn = definedFuncAt(ctx, funcIdx);
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
 * (#2190) Box one loaded `__vec_<elemKind>` element (already on the stack) up to
 * `externref`. Returns the box-op sequence, or `null` to tell the caller to skip
 * the arm for this carrier.
 *
 * SCOPE (regression-hardened, round 2): a non-null sequence is returned ONLY for
 * the two element kinds whose box op PROVABLY yields a fresh `externref` —
 * plain `f64` (`__box_number`) and plain `i32` (`f64.convert_i32_s` +
 * `__box_number`). EVERY other element kind, **including a literally-`externref`
 * element**, is skipped.
 *
 * Why skip `externref` too: the carriers keyed `"externref"` in `ctx.vecTypeMap`
 * are NOT uniformly `(array externref)`. Some are registered with a `ref`/
 * `ref_null` element override (e.g. the `arguments` object + closure-arg vecs via
 * `getOrRegisterVecType(ctx, "externref", refElem)` in function-body.ts /
 * closures.ts), and `getOrRegisterArrayType` rewrites a `ref` element to
 * `ref_null`. An identity arm for such a carrier left a `(ref null N)` on the
 * helper's `return` (`__extern_get_idx return[0] expected externref, got
 * (ref null N)`), emitting invalid Wasm for ~120 generator/async +
 * destructuring-rest + TypedArray modules and breaching the #2097 standalone
 * floor (-116). A number-only arm set has NO ref-returning path, so it stays
 * unconditionally valid across every carrier the proposal harness can register.
 * Non-number element indexing through the boundary (externref / string / GC-ref)
 * falls back to the prior null behaviour — no worse than pre-#2190 — and is
 * deferred to a follow-up.
 */
export function boxVecElementToExternref(ctx: CodegenContext, elemType: ValType): Instr[] | null {
  if (elemType.kind === "f64") {
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) return null;
    return [{ op: "call", funcIdx: boxIdx } as Instr];
  }
  if (elemType.kind === "i32") {
    // The `boolean`-tagged i32 variant must NOT box through `__box_number`
    // (number box ≠ boolean box) — skip it (falls back to prior null behaviour).
    if ((elemType as { boolean?: boolean }).boolean) return null;
    const boxIdx = ctx.funcMap.get("__box_number");
    if (boxIdx === undefined) return null;
    return [{ op: "f64.convert_i32_s" } as Instr, { op: "call", funcIdx: boxIdx } as Instr];
  }
  // (#2162b) A carrier whose `data` array element is EXACTLY `externref` (read
  // from `arrDef.element`, never the `"externref"` map key — see the scope note
  // above and [[reference_vec_externref_key_not_uniform]]) needs only an
  // identity pass-through: the loaded element is already an `externref`, so it
  // satisfies the helper's `externref` return with no boxing. This is the
  // canonical externref `$Vec` that `arr.entries()`/`.keys()`/`.values()` and
  // the spread/`Array.from` materialization hand back. The dangerous variants
  // the scope note warns about are the `ref`/`ref_null`-element carriers (the
  // `arguments`/closure-arg vecs), which would leave a `(ref null N)` on the
  // `externref` return — those stay skipped below.
  if (elemType.kind === "externref") {
    return [];
  }
  // (#2190 read-back, homogeneous string sub-array) A carrier whose `data`
  // element is a GC *string* ref — `$AnyString` / `$NativeString`
  // (`ctx.anyStrTypeIdx` / `ctx.nativeStrTypeIdx`) — is the inner vec of an
  // `any[]` of homogeneous-string arrays (`[["a","b"]]`). Without an arm here,
  // `__extern_get_idx(inner, i)` falls through to null, the caller's
  // `ref.test $AnyString` then fails, and `struct.get` null-derefs on the
  // `.length`/element read (the `e[0][0]` trap). `extern.convert_any` is the
  // universal GC-ref → externref boxing; the consuming site re-tests/casts the
  // returned externref back to `$AnyString`, so the round-trip is identity for a
  // string element and null for an array hole. Scoped to the string GC types
  // only — the `arguments`/closure-arg `(ref null N)` carriers the scope note
  // warns about stay skipped (they are not string carriers) so this adds no
  // behaviour to those paths.
  if (elemType.kind === "ref" || elemType.kind === "ref_null") {
    const ti = (elemType as { typeIdx: number }).typeIdx;
    if (ti >= 0 && (ti === ctx.anyStrTypeIdx || ti === ctx.nativeStrTypeIdx)) {
      return [{ op: "extern.convert_any" } as Instr];
    }
  }
  // other ref / ref_null / f32 / i64 / v128 → no arm (see scope note).
  return null;
}

/**
 * (#2190) Parameters needed to build the `__extern_get_idx` body, shared by the
 * eager registration (empty `vecArms`) and the FINALIZE fill (full `vecArms`).
 */
interface ExternGetIdxBodyParams {
  /** Standalone gate — emit the `$Object` array-like + typed-vec arms. */
  objArrayLikeArms: boolean;
  objectTypeIdx: number;
  objVecTypeIdx: number;
  objVecArrTypeIdx: number;
  /** funcIdx of `number_toString` (only used when objArrayLikeArms). */
  numberToStringIdx: number;
  /** funcIdx of `__extern_get` (only used when objArrayLikeArms). */
  externGetIdx: number;
  /** Pre-built per-`__vec_<k>` dispatch arms (empty at registration time). */
  vecArms: Instr[];
  /** (#2106 S1) Factory for the miss ("index absent") result instrs. A FACTORY
   *  — not a shared array — because the miss appears in several branches and
   *  shared Instr objects get double-remapped by the finalize walks (see
   *  `reference_shared_instr_object_dce_double_remap`). Legacy:
   *  `[{ ref.null.extern }]`; singleton regime: `global.get $undefined ;
   *  extern.convert_any`. */
  missInstrs: () => Instr[];
}

/**
 * (#2190) Build the `__extern_get_idx(externref v, f64 idx) -> externref` body.
 *
 * Layout: locals 2=any(anyref) 3=vec(ref null $ObjVec) 4=i(i32).
 * Order of arms (first match wins, each `return`s):
 *   1. `$Object` array-like (`{0:x, length:n}`) — `__extern_get(v, ToString(i))`.
 *   2. typed `__vec_<k>` carriers (`vecArms`) — the #2190 element read.
 *   3. `$ObjVec` enumeration vector — `data[i]` when in bounds.
 *   else → null.
 * The typed-vec arms sit BEFORE the `$ObjVec` test because a `__vec_<k>` is not
 * a `$ObjVec`; placing them first keeps the `$ObjVec` fast path unchanged.
 */
function buildExternGetIdxBody(p: ExternGetIdxBodyParams): Instr[] {
  const { objArrayLikeArms, objectTypeIdx, objVecTypeIdx, objVecArrTypeIdx } = p;
  const objIdxArm: Instr[] = objArrayLikeArms
    ? [
        { op: "local.get", index: 2 },
        { op: "ref.test", typeIdx: objectTypeIdx },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [
            { op: "local.get", index: 0 },
            { op: "local.get", index: 1 },
            // #2551 — do NOT truncate: ToPropertyKey of a numeric index is
            // ToString(idx) (§7.1.19 → §6.1.6.1.20), so a non-integer index must
            // stringify to its canonical decimal ("1.5"), matching how the STORE
            // path (`o[1.5] = …` → __extern_set → __to_property_key) keys it. A
            // prior `f64.trunc` here read `o[1.5]` from key "1" (truncated) while
            // the write stored under "1.5", so the read missed. number_toString is
            // canonical Number::toString, so an integer index still yields "3".
            { op: "call", funcIdx: p.numberToStringIdx },
            { op: "call", funcIdx: p.externGetIdx },
            { op: "return" },
          ],
        } as Instr,
      ]
    : [];
  return [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: 2 },
    ...objIdxArm,
    ...p.vecArms,
    { op: "local.get", index: 2 },
    { op: "ref.test", typeIdx: objVecTypeIdx },
    { op: "i32.eqz" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...p.missInstrs(), { op: "return" } as Instr],
    },
    // vec = cast<$ObjVec>(any) ; i = i32(idx)
    { op: "local.get", index: 2 },
    { op: "ref.cast", typeIdx: objVecTypeIdx },
    { op: "local.set", index: 3 },
    { op: "local.get", index: 1 },
    { op: "i32.trunc_sat_f64_s" },
    { op: "local.tee", index: 4 },
    // if i < 0 || i >= vec.len → miss
    { op: "i32.const", value: 0 },
    { op: "i32.lt_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...p.missInstrs(), { op: "return" } as Instr],
    },
    { op: "local.get", index: 4 },
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 0 },
    { op: "i32.ge_s" },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [...p.missInstrs(), { op: "return" } as Instr],
    },
    // return vec.data[i]
    { op: "local.get", index: 3 },
    { op: "ref.as_non_null" },
    { op: "struct.get", typeIdx: objVecTypeIdx, fieldIdx: 1 },
    { op: "local.get", index: 4 },
    { op: "array.get", typeIdx: objVecArrTypeIdx },
  ];
}

/**
 * (#2190) Fill `__extern_get_idx`'s typed-`__vec_<elemKind>` indexing arms after
 * every module-local array carrier is registered. Sibling of the #2189
 * `.length`-through-the-boundary fix: a real array literal lowers to a
 * `__vec_<elemKind>` struct, and a NUMERIC index on it through the externref
 * boundary (`(arr as any)[i]`) routes here. Without these arms, only `$ObjVec`
 * (enumeration results) and array-like `$Object` are recognised, so a boxed
 * `__vec_f64`/`__vec_<str>` falls through to null (number→0, ref→null).
 *
 * Unlike `.length` (one i32 at field 0, readable uniformly via the `$__vec_base`
 * supertype), element reads are element-type-polymorphic: each carrier has a
 * different `data` array element type and the loaded element must be boxed to
 * externref per kind. So we emit one `ref.test`/`ref.cast` arm per carrier with
 * its own bounds check + per-kind boxing (`boxVecElementToExternref`).
 *
 * Standalone only (gated by `ctx.externGetIdxReserved`, set in standalone). Edits
 * the body in place — no funcIdx churn, so cached call targets stay valid.
 */
export function fillExternGetIdxVecArms(ctx: CodegenContext): void {
  if (!ctx.externGetIdxReserved) return;
  const funcIdx = ctx.funcMap.get("__extern_get_idx");
  if (funcIdx === undefined) return;
  const fn = definedFuncAt(ctx, funcIdx);
  if (!fn) return;
  const types = ctx.objectRuntimeTypes;
  if (!types) return;

  // Enumerate concrete `__vec_<elemKind>` carriers (NOT $ObjVec — it keeps its
  // own dedicated arm — and NOT the non-array `_byte` carriers). Dedup by
  // typeIdx; sort for deterministic emission.
  const seen = new Set<number>();
  const carriers: { typeIdx: number; arrTypeIdx: number; elemType: ValType }[] = [];
  for (const [elemKind, vecTypeIdx] of ctx.vecTypeMap.entries()) {
    if (NON_ARRAY_BYTE_VEC_ELEM_KINDS.has(elemKind)) continue;
    if (seen.has(vecTypeIdx)) continue;
    const arrTypeIdx = getArrTypeIdxFromVec(ctx, vecTypeIdx);
    if (arrTypeIdx < 0) continue;
    const arrDef = ctx.mod.types[arrTypeIdx];
    if (!arrDef || arrDef.kind !== "array") continue;
    seen.add(vecTypeIdx);
    carriers.push({ typeIdx: vecTypeIdx, arrTypeIdx, elemType: arrDef.element });
  }
  carriers.sort((a, b) => a.typeIdx - b.typeIdx);

  // (#2106 S1) OOB miss = undefined under the singleton regime (fresh instr
  // objects per use — a factory, never a shared array, per the finalize
  // double-remap hazard). The singleton instrs carry no funcIdx/typeIdx, so
  // splicing them at FINALIZE cannot desync any index-shift walk.
  const idxMiss = (): Instr[] => undefinedExternInstrs(ctx) ?? [{ op: "ref.null.extern" } as Instr];
  const vecArms: Instr[] = [];
  for (const { typeIdx, arrTypeIdx, elemType } of carriers) {
    const boxOps = boxVecElementToExternref(ctx, elemType);
    if (boxOps === null) continue; // unsupported element kind — leave to null fallback
    vecArms.push({ op: "local.get", index: 2 }, { op: "ref.test", typeIdx }, {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        // i = trunc_sat(idx) ; if i < 0 → miss
        { op: "local.get", index: 1 },
        { op: "i32.trunc_sat_f64_s" },
        { op: "local.tee", index: 4 },
        { op: "i32.const", value: 0 },
        { op: "i32.lt_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...idxMiss(), { op: "return" } as Instr],
        } as Instr,
        // if i >= vec.length → miss
        { op: "local.get", index: 4 },
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx },
        { op: "struct.get", typeIdx, fieldIdx: 0 },
        { op: "i32.ge_s" },
        {
          op: "if",
          blockType: { kind: "empty" },
          then: [...idxMiss(), { op: "return" } as Instr],
        } as Instr,
        // return box(vec.data[i])
        { op: "local.get", index: 2 },
        { op: "ref.cast", typeIdx },
        { op: "struct.get", typeIdx, fieldIdx: 1 },
        { op: "local.get", index: 4 },
        { op: "array.get", typeIdx: arrTypeIdx },
        ...boxOps,
        { op: "return" },
      ],
    } as Instr);
  }

  if (vecArms.length === 0) return; // no number carriers → leave the eager body untouched

  // (#2190 regression fix, round 3) SPLICE the vec arms into the EXISTING body
  // instead of REBUILDING it. The eager body (from `buildExternGetIdxBody` at
  // registration) baked the `$Object` arm's `number_toString` / `__extern_get`
  // funcIdxs, and the late-import funcIdx-shift machinery walks + adjusts those
  // baked `call` targets if imports are added afterwards (the `addUnionImports`
  // invariant). Rebuilding the whole body here at FINALIZE re-baked those
  // funcIdxs with the *then-current* values; a subsequent reconcile shift would
  // then double-apply to them, corrupting the `call` target → invalid Wasm
  // (this regressed ~120 generator/async + destructuring-rest + TypedArray
  // modules that hit the `$Object`/`number_toString` arm, breaching the #2097
  // floor regardless of which element kinds we boxed). Splicing leaves the
  // original arms — and their shift-maintained funcIdxs — exactly as the eager
  // registration left them.
  //
  // The eager body starts with the 3-instr setup preamble
  // (`local.get 0 ; any.convert_extern ; local.set 2`); the typed-vec arms must
  // run after `any` is set and before the `$Object`/`$ObjVec` arms (a
  // `__vec_<k>` is neither). Insert right after the preamble.
  const SETUP_LEN = 3;
  if (
    fn.body.length >= SETUP_LEN &&
    fn.body[0]?.op === "local.get" &&
    fn.body[1]?.op === "any.convert_extern" &&
    fn.body[2]?.op === "local.set"
  ) {
    fn.body.splice(SETUP_LEN, 0, ...vecArms);
  } else {
    // Defensive: preamble shape changed — prepend the arms after a fresh setup
    // is not safe, so skip rather than risk an unbalanced body.
    return;
  }
}

/**
 * (#2896) Finalize-time fill for the reserved builtin-fn metadata natives
 * (`__builtinfn_get_meta` / `__builtinfn_gopd` / `__builtinfn_delete` /
 * `__builtinfn_push_ownnames` — registered by `ensureObjectRuntime` under
 * `--target standalone` with constant default bodies). Runs from index.ts
 * finalize, right after `fillExternGetIdxVecArms`, once EVERY builtin closure
 * meta type (`ctx.builtinFnMetaByTypeIdx`, see builtin-fn-meta.ts) is known —
 * a meta type registered after an eagerly-baked ref.test chain would otherwise
 * be invisible (the same compile-order snapshot bug `fillExternIsArray` fixes
 * for Array.isArray).
 *
 * Shift-safety: the arms are SPLICED into the existing default bodies (never
 * rebuilt — see `reference_no_rebuild_helper_body_at_finalize`); the `call`
 * funcIdxs baked here read `funcMap` at fill time, and any later import shift
 * walks + adjusts spliced instrs like all others. `ref.test`/`ref.cast`/
 * `struct.get`/`struct.set` use TYPE indices (rec-group stable, no funcidx
 * hazard).
 */
export function fillBuiltinFnMeta(ctx: CodegenContext): void {
  const metaMap = ctx.builtinFnMetaByTypeIdx;
  if (!metaMap || metaMap.size === 0) return;
  const getMetaFuncIdx = ctx.funcMap.get("__builtinfn_get_meta");
  if (getMetaFuncIdx === undefined) return; // object runtime never ensured
  const boxNumIdx = ctx.funcMap.get("__box_number");
  const strFlattenIdx = ctx.nativeStrHelpers.get("__str_flatten");
  const strEqualsIdx = ctx.nativeStrHelpers.get("__str_equals");
  const anyStrTypeIdx = ctx.anyStrTypeIdx;
  if (boxNumIdx === undefined || strFlattenIdx === undefined || strEqualsIdx === undefined || anyStrTypeIdx < 0) {
    return;
  }
  // Resolve fill targets BY NAME (funcIdx math across phases is shift-sensitive).
  const findFn = (name: string) => ctx.mod.functions.find((f) => f.name === name);
  const getMetaFn = findFn("__builtinfn_get_meta");
  const gopdFn = findFn("__builtinfn_gopd");
  const deleteFn = findFn("__builtinfn_delete");
  const pushOwnFn = findFn("__builtinfn_push_ownnames");

  // Deterministic arm order.
  const entries = Array.from(metaMap.entries()).sort((a, b) => a[0] - b[0]);

  // Shared preamble for get_meta / delete (locals: 2=any 3=fkey 4=isName 5=isLen):
  // convert the receiver, classify the key ONCE (string → flattened; isName /
  // isLen flags). A non-string key can never be "name"/"length" — the flags
  // stay 0 and the guarded arm block is skipped (falls to the default tail).
  // A FACTORY (fresh Instr objects per call): the same preamble goes into TWO
  // function bodies, and aliasing one Instr[] into both would double-remap
  // (see reference_shared_instr_object_dce_double_remap).
  const classifyPreamble = (): Instr[] => [
    { op: "local.get", index: 0 },
    { op: "any.convert_extern" },
    { op: "local.set", index: 2 },
    { op: "local.get", index: 1 },
    { op: "any.convert_extern" },
    { op: "ref.test", typeIdx: anyStrTypeIdx },
    {
      op: "if",
      blockType: { kind: "empty" },
      then: [
        { op: "local.get", index: 1 },
        { op: "any.convert_extern" },
        { op: "ref.cast", typeIdx: anyStrTypeIdx },
        { op: "call", funcIdx: strFlattenIdx },
        { op: "local.set", index: 3 },
        { op: "local.get", index: 3 },
        { op: "ref.as_non_null" },
        ...nativeStringLiteralInstrs(ctx, "name"),
        { op: "call", funcIdx: strEqualsIdx },
        { op: "local.set", index: 4 },
        { op: "local.get", index: 3 },
        { op: "ref.as_non_null" },
        ...nativeStringLiteralInstrs(ctx, "length"),
        { op: "call", funcIdx: strEqualsIdx },
        { op: "local.set", index: 5 },
      ],
    } as Instr,
  ];

  // ── __builtinfn_get_meta arms ──
  if (getMetaFn) {
    const arms: Instr[] = [];
    for (const [typeIdx, meta] of entries) {
      arms.push({ op: "local.get", index: 2 }, { op: "ref.test", typeIdx }, {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 4 }, // isName
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              // deleted? (state & NAME_DELETED)
              { op: "local.get", index: 2 },
              { op: "ref.cast", typeIdx },
              { op: "struct.get", typeIdx, fieldIdx: 1 },
              { op: "i32.const", value: 1 },
              { op: "i32.and" },
              { op: "i32.eqz" },
              {
                op: "if",
                blockType: { kind: "empty" },
                then: [
                  ...nativeStringLiteralInstrs(ctx, meta.name),
                  { op: "extern.convert_any" } as Instr,
                  { op: "return" },
                ],
              },
              { op: "ref.null.extern" },
              { op: "return" },
            ],
          },
          // length: deleted? (state & LENGTH_DELETED)
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: 1 },
          { op: "i32.const", value: 2 },
          { op: "i32.and" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [{ op: "f64.const", value: meta.length }, { op: "call", funcIdx: boxNumIdx }, { op: "return" }],
          },
          { op: "ref.null.extern" },
          { op: "return" },
        ],
      } as Instr);
    }
    getMetaFn.body.splice(
      0,
      0,
      ...classifyPreamble(),
      // Guard: only enter the arm block when the key is "name" or "length".
      { op: "local.get", index: 4 } as Instr,
      { op: "local.get", index: 5 } as Instr,
      { op: "i32.or" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: arms,
      } as Instr,
    );
  }

  // ── __builtinfn_gopd: get_meta(v, key) → __create_descriptor(value, 0x04) ──
  const createDescIdx = ctx.funcMap.get("__create_descriptor");
  if (gopdFn && createDescIdx !== undefined) {
    gopdFn.body.splice(
      0,
      0,
      { op: "local.get", index: 0 } as Instr,
      { op: "local.get", index: 1 } as Instr,
      { op: "call", funcIdx: getMetaFuncIdx } as Instr,
      { op: "local.tee", index: 2 } as Instr,
      { op: "ref.is_null" } as Instr,
      { op: "i32.eqz" } as Instr,
      {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          { op: "local.get", index: 2 },
          { op: "i32.const", value: FLAG_CONFIGURABLE }, // {writable:F, enumerable:F, configurable:T}
          { op: "call", funcIdx: createDescIdx },
          { op: "return" },
        ],
      } as Instr,
    );
  }

  // ── __builtinfn_delete arms: set the instance's deleted bit, return 1 ──
  if (deleteFn) {
    const arms: Instr[] = [];
    for (const [typeIdx] of entries) {
      arms.push({ op: "local.get", index: 2 }, { op: "ref.test", typeIdx }, {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // state |= isName ? 1 : 2
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: 1 },
          { op: "local.get", index: 4 },
          {
            op: "if",
            blockType: { kind: "val", type: { kind: "i32" } },
            then: [{ op: "i32.const", value: 1 }],
            else: [{ op: "i32.const", value: 2 }],
          },
          { op: "i32.or" },
          { op: "struct.set", typeIdx, fieldIdx: 1 },
          { op: "i32.const", value: 1 },
          { op: "return" },
        ],
      } as Instr);
    }
    deleteFn.body.splice(
      0,
      0,
      ...classifyPreamble(),
      { op: "local.get", index: 4 } as Instr,
      { op: "local.get", index: 5 } as Instr,
      { op: "i32.or" } as Instr,
      { op: "if", blockType: { kind: "empty" }, then: arms } as Instr,
    );
  }

  // ── __builtinfn_push_ownnames arms: push undeleted ["length","name"] ──
  const objVecPushIdx = ctx.funcMap.get("__objvec_push");
  if (pushOwnFn && objVecPushIdx !== undefined) {
    const arms: Instr[] = [];
    for (const [typeIdx] of entries) {
      arms.push({ op: "local.get", index: 2 }, { op: "ref.test", typeIdx }, {
        op: "if",
        blockType: { kind: "empty" },
        then: [
          // "length" first (spec order: OrdinaryOwnPropertyKeys creation order).
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: 1 },
          { op: "i32.const", value: 2 },
          { op: "i32.and" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 }, // vec
              ...nativeStringLiteralInstrs(ctx, "length"),
              { op: "extern.convert_any" } as Instr,
              { op: "call", funcIdx: objVecPushIdx },
            ],
          },
          { op: "local.get", index: 2 },
          { op: "ref.cast", typeIdx },
          { op: "struct.get", typeIdx, fieldIdx: 1 },
          { op: "i32.const", value: 1 },
          { op: "i32.and" },
          { op: "i32.eqz" },
          {
            op: "if",
            blockType: { kind: "empty" },
            then: [
              { op: "local.get", index: 1 }, // vec
              ...nativeStringLiteralInstrs(ctx, "name"),
              { op: "extern.convert_any" } as Instr,
              { op: "call", funcIdx: objVecPushIdx },
            ],
          },
          { op: "i32.const", value: 1 },
          { op: "return" },
        ],
      } as Instr);
    }
    pushOwnFn.body.splice(
      0,
      0,
      { op: "local.get", index: 0 } as Instr,
      { op: "any.convert_extern" } as Instr,
      { op: "local.set", index: 2 } as Instr,
      ...arms,
    );
  }
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
  // (#2896) builtin-fn metadata read (dyn-read `.length` closure arm routes here).
  "__builtinfn_get_meta",
  "__new_plain_object",
  "__extern_is_array",
  "__extern_get",
  "__extern_set",
  "__extern_set_strict", // (#2017) standalone alias → __extern_set native helper
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
  // #2042 S3 — read-side descriptor-reflection natives over $Object/$PropEntry:
  //   __getOwnPropertyNames               — own string keys incl. non-enumerable
  //                                         (via __obj_ordered_all), index/insert order
  //   __getOwnPropertySymbols             — always [] (string-keyed runtime, no symbols)
  //   __object_getOwnPropertyDescriptors  — { key: descriptor } over __getOwnPropertyNames
  // (`__defineProperty_desc` — the write side — is deferred until #2043; see the
  //  NOTE near __getOwnPropertyDescriptor's registration.)
  "__getOwnPropertyNames",
  "__getOwnPropertySymbols",
  "__object_getOwnPropertyDescriptors",
  // #2042 S3 — Object.is (SameValue §7.2.10): tag-dispatched native over two
  // boxed externrefs (number bit-compare for NaN==NaN / +0!=-0, boolean/bigint
  // unbox, both-null, else ref identity). Was a #1472-Phase-B refusal.
  "__object_is",
  // NOTE (#2042 S3): `__object_fromEntries` is intentionally NOT in this set. The
  // native helper only iterates a `$ObjVec` of pair `$ObjVec`s, which the
  // fromEntries call site BUILDS (and calls the helper via funcMap directly) only
  // for a literal array-of-pairs with string keys. The ordinary path (raw arg /
  // Map / non-string-key) must keep REFUSING (compile error) — routing it native
  // here would make `ensureLateImport` register the helper for those args too and
  // TRAP on the non-$ObjVec representation. So this name stays a refusal; the
  // call site resolves the registered helper via funcMap only on the safe shape.
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
  // #2541 — Object.prototype.propertyIsEnumerable: own-property presence (no
  // proto walk) AND the entry's FLAG_ENUMERABLE bit, over the same $Object
  // runtime as __hasOwnProperty. Replaces the #1472 Phase B standalone refusal.
  "__propertyIsEnumerable",
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
  // #1910/#1472 S2 — boxed primitive wrappers. `new Number`/`new String`/
  // `new Boolean` build a `$Object` carrying the [[PrimitiveValue]] internal slot
  // (non-enumerable) instead of leaking the `env::__new_*` host import;
  // __to_primitive reads the slot first to recover the wrapper's primitive.
  "__new_Number",
  "__new_String",
  "__new_Boolean",
]);
