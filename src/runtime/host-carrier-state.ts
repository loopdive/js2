// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) Value-adapter base layer: the WasmGC carrier predicates
 * (`_isWasmStruct`, `_isWasmVec`, `_canBeWeakKey`), the absence sentinel, and
 * the sidecar property / descriptor / integrity state the host facades keep
 * for opaque WasmGC structs. Every other value-adapter module builds on this;
 * it imports nothing from `src/runtime.ts`. Split out of `src/runtime.ts`.
 */

import { hasOwn } from "./host-bridge-authority.js";
import {
  type WasmStructSidecarState,
  getOrCreateWasmStructSidecar,
  readWasmStructSidecar,
  writeWasmStructSidecar,
} from "./wasm-struct-sidecar.js";

// (#4616) Internal runtime decisions (arg conversion, deep equal, trampolines)
// must survive a user-level patch of `Array.isArray` (jest.spyOn). A patched
// isArray whose mockImplementation is a COMPILED closure otherwise recurses:
// spy → trampoline → arg conversion → patched isArray → spy. Only the
// user-visible `__extern_is_array` lane reads the live global.
export const _nativeIsArray = Array.isArray;

/**
 * Sidecar property store for WasmGC structs.
 *
 * WasmGC structs are opaque to JS — property get returns undefined, and
 * property set / delete / for-in / Object.freeze throw "WebAssembly objects
 * are opaque".  This WeakMap stores extra properties that JS code attaches
 * to WasmGC structs at runtime (e.g. `obj[Symbol.iterator] = fn`).
 *
 * The helpers below are used by every host import that touches object
 * properties so that WasmGC structs behave like regular JS objects for
 * the subset of operations test262 (and user code) requires.
 */
export const _wasmStructProps = new WeakMap<object, Record<string | symbol, any>>();

// Restore the dedicated f64 undefined sentinel at the host property boundary.
const _f64 = new DataView(new ArrayBuffer(8));
export const _restoreF64Undefined = (v: unknown): unknown =>
  typeof v === "number" && (_f64.setFloat64(0, v) ?? _f64.getBigUint64(0)) === 0x7ff00000deadc0den ? undefined : v;

// (#2739) Host-recorded [[Prototype]] link for an opaque WasmGC struct. A struct
// exported to JS has no host-observable [[Prototype]] (`Object.getPrototypeOf`
// returns null/the engine default), so `Object.setPrototypeOf(struct, proto)` /
// `Reflect.setPrototypeOf` / `struct.__proto__ = proto` record the user-intended
// prototype here, and the for-in walk + read path consult it via
// `_structUserProto`. A recorded value may be `null` (setPrototypeOf(o, null));
// presence is tested with `.has`, never `!== undefined`.
export const _wasmStructProto = new WeakMap<object, any>();

// Links constructed instances to their closure constructor's prototype sidecar.
export const _fnctorInstanceCtor = new WeakMap<object, object>();

/**
 * (#1334) Per-object set of property keys that were explicitly deleted via
 * the `delete` operator. WasmGC structs have a fixed shape — fields can't
 * be removed at runtime — so a successful `delete obj.x` only sets the
 * field to a sentinel. Without a separate "tombstone" set, subsequent
 * `obj.hasOwnProperty("x")` would return true (the field is still in the
 * struct shape), violating spec §10.1.10 which requires the property to
 * appear absent after a successful delete.
 *
 * This set is consulted by `__hasOwnProperty`, `__propertyIsEnumerable`,
 * `__for_in_keys`, and `Object.getOwnPropertyDescriptor` to filter out
 * deleted struct-shape fields. It's populated by `__delete_property` and
 * cleared whenever the property is re-assigned (handled at the
 * `_sidecarSet`/struct-set path).
 */
export const _wasmStructDeletedKeys = new WeakMap<object, Set<string | symbol>>();

/**
 * (#2731) Struct-shape fields that were DELETED then RE-ADDED, so their live
 * value now lives in the sidecar (insertion-ordered) and they must be enumerated
 * from the sidecar at insertion-order END — NOT from their fixed struct-shape
 * slot. Set in `_safeSet` when a re-assignment clears a tombstone on a key that
 * is a struct-shape field; consulted by `__for_in_keys` (and the `__object_*`
 * key collectors) to skip the struct-slot emission so the sidecar loop supplies
 * the field at the correct (end) position. A plain re-assignment of a
 * never-deleted field is NOT marked (it keeps its struct position), and a
 * dynamic sidecar-only key needs no marker (it already orders via the sidecar).
 */
export const _wasmStructShadowedFields = new WeakMap<object, Set<string>>();

/**
 * Sidecar property descriptor store for WasmGC structs.
 *
 * Stores property descriptor flags per property on WasmGC structs, enabling
 * spec-compliant ValidateAndApplyPropertyDescriptor behavior (ES spec 9.1.6.3)
 * for Object.defineProperty on opaque objects.
 *
 * Key: the WasmGC struct object. Value: map of property name -> descriptor flags.
 * Flags: bit 0 = writable, bit 1 = enumerable, bit 2 = configurable, bit 3 = defined.
 */
export const _wasmPropDescs = new WeakMap<object, Map<string | symbol, number>>();

/**
 * Sidecar accessor storage for WasmGC structs.
 * Stores get/set functions for accessor properties (including Symbol-keyed ones).
 * Separate from _wasmStructProps because template literals can't stringify Symbols.
 */
export const _wasmStructAccessors = new WeakMap<object, Map<string | symbol, { get?: Function; set?: Function }>>();

export const _wasmFrozenObjs = new WeakSet<object>();
export const _wasmSealedObjs = new WeakSet<object>();
/** Tracks WasmGC struct objects that are non-extensible (freeze/seal/preventExtensions). */
export const _wasmNonExtensibleObjs = new WeakSet<object>();
export const _wasmSidecars: WasmStructSidecarState = {
  props: _wasmStructProps,
  prototypes: _wasmStructProto,
  deletedKeys: _wasmStructDeletedKeys,
  shadowedFields: _wasmStructShadowedFields,
  descriptors: _wasmPropDescs,
  accessors: _wasmStructAccessors,
  frozen: _wasmFrozenObjs,
  sealed: _wasmSealedObjs,
  nonExtensible: _wasmNonExtensibleObjs,
};

export const _SC_WRITABLE = 1;
export const _SC_ENUMERABLE = 2;
export const _SC_CONFIGURABLE = 4;
export const _SC_DEFINED = 8;
export const _SC_ACCESSOR = 16;

/** Normalize property key for descriptor Map lookups — JS treats numeric keys
 * like 0 and "0" as the same property, but Map uses ===. (#1092) */
export function _normalizeDescKey(key: any): string | symbol {
  if (typeof key === "symbol") return key;
  return String(key);
}

export function _getSidecarDescs(obj: object): Map<string | symbol, number> {
  if (!_canBeWeakKey(obj)) return new Map();
  let m = _wasmPropDescs.get(obj);
  if (!m) {
    m = new Map();
    _wasmPropDescs.set(obj, m);
  }
  return m;
}

/**
 * Validate a defineProperty call against existing sidecar property descriptor.
 * Implements ES spec 9.1.6.3 ValidateAndApplyPropertyDescriptor for WasmGC structs.
 * Throws TypeError if the redefinition violates non-configurable constraints.
 * Returns the new flags to store.
 */
export function _validatePropertyDescriptor(
  descs: Map<string | symbol, number>,
  prop: string | symbol,
  desc: PropertyDescriptor,
  existingValue?: any,
  existingDesc?: PropertyDescriptor,
): number {
  const existing = descs.get(_normalizeDescKey(prop));
  const hasValue = hasOwn(desc, "value");
  const hasWritable = hasOwn(desc, "writable");
  const hasEnumerable = hasOwn(desc, "enumerable");
  const hasConfigurable = hasOwn(desc, "configurable");
  const hasGet = hasOwn(desc, "get");
  const hasSet = hasOwn(desc, "set");

  // Compute new flags. ECMA-262 §10.1.6.3 ValidateAndApplyPropertyDescriptor:
  // a *redefine* keeps every attribute the descriptor omits — only fields
  // explicitly present in `desc` overwrite the existing descriptor (#1831).
  // On first definition, omitted attributes default to false. The previous code
  // rebuilt the flags purely from `desc` truthiness, so a partial redefine like
  // `Object.defineProperty(o,"k",{value:5})` wrongly cleared a previously-set
  // writable/enumerable/configurable.
  let newFlags = existing === undefined ? _SC_DEFINED : existing | _SC_DEFINED;
  // helper: set/clear `bit` when the descriptor field is present; on first
  // definition, an omitted field defaults to false (cleared).
  const applyFlag = (present: boolean, value: boolean | undefined, bit: number): void => {
    if (present) {
      newFlags = value ? newFlags | bit : newFlags & ~bit;
    } else if (existing === undefined) {
      newFlags &= ~bit;
    }
  };
  applyFlag(hasWritable, desc.writable, _SC_WRITABLE);
  applyFlag(hasEnumerable, desc.enumerable, _SC_ENUMERABLE);
  applyFlag(hasConfigurable, desc.configurable, _SC_CONFIGURABLE);
  // Data<->accessor kind: explicit get/set ⇒ accessor; explicit value/writable
  // ⇒ data; otherwise keep the existing kind (or default data on first def).
  if (hasGet || hasSet) {
    newFlags |= _SC_ACCESSOR;
  } else if (hasValue || hasWritable) {
    newFlags &= ~_SC_ACCESSOR;
  } else if (existing === undefined) {
    newFlags &= ~_SC_ACCESSOR;
  }

  if (existing === undefined) return newFlags; // First definition

  const isConfigurable = !!(existing & _SC_CONFIGURABLE);
  if (isConfigurable) return newFlags; // Configurable — change OK (omitted fields preserved above)

  // Non-configurable: validate constraints (ES spec 9.1.6.3 step 7)
  if (desc.configurable === true) {
    throw new TypeError("Cannot redefine property: " + String(prop));
  }
  if (hasEnumerable) {
    const wasEnumerable = !!(existing & _SC_ENUMERABLE);
    if (desc.enumerable !== wasEnumerable) {
      throw new TypeError("Cannot redefine property: " + String(prop));
    }
  }
  // Cannot change data<->accessor on non-configurable
  const wasAccessor = !!(existing & _SC_ACCESSOR);
  const isAccessor = hasGet || hasSet;
  if (isAccessor && !wasAccessor) {
    throw new TypeError("Cannot redefine property: " + String(prop));
  }
  if (!isAccessor && wasAccessor && (hasValue || hasWritable)) {
    throw new TypeError("Cannot redefine property: " + String(prop));
  }
  if (wasAccessor && isAccessor) {
    if (hasGet && !Object.is(desc.get, existingDesc?.get)) {
      throw new TypeError("Cannot redefine property: " + String(prop));
    }
    if (hasSet && !Object.is(desc.set, existingDesc?.set)) {
      throw new TypeError("Cannot redefine property: " + String(prop));
    }
  }
  // Data property: writable checks
  if (!wasAccessor && !isAccessor) {
    const wasWritable = !!(existing & _SC_WRITABLE);
    if (!wasWritable) {
      if (desc.writable === true) {
        throw new TypeError("Cannot redefine property: " + String(prop));
      }
      // ES spec 9.1.6.3: can set value only if SameValue(desc.value, existing.value).
      // Use Object.is for SameValue semantics (distinguishes +0/-0, NaN===NaN).
      if (hasValue && !Object.is(desc.value, existingValue)) {
        throw new TypeError("Cannot redefine property: " + String(prop));
      }
    }
  }

  // Preserve existing flags for non-configurable (can only narrow writable)
  let resultFlags = existing;
  if (desc.writable === false) resultFlags &= ~_SC_WRITABLE;
  return resultFlags;
}

// (#3673) Memoized classification for `_isWasmStruct`. The predicate is on the
// hot path of EVERY boundary helper (`__extern_get`/`_safeGet`/`_safeSet` call
// it several times per crossing), and the original probe-set-and-catch
// implementation forced a V8 exception throw/catch plus a fresh Symbol PER CALL
// for every WasmGC struct receiver — measured at 57% of total CPU during a
// compiled-acorn parse. Classification is stable for a given object identity
// (a struct never becomes a plain object and vice versa), so cache the verdict
// in a single WeakMap (one probe per call — ~20k calls per small acorn parse
// makes the second probe of a two-WeakSet scheme measurable).
const _wasmStructVerdict = new WeakMap<object, boolean>();

export function _isWasmStruct(obj: any): boolean {
  if (obj == null || typeof obj !== "object") return false;
  const verdict = _wasmStructVerdict.get(obj);
  if (verdict !== undefined) return verdict;
  try {
    // WasmGC structs have a null prototype — quick check that exits early for
    // normal objects. (Kept inside the try so an unregistered revoked proxy —
    // whose traps throw — classifies exactly as before the #3673 rework.)
    if (Object.getPrototypeOf(obj) !== null) {
      // (#3903) Deliberately NOT memoized. `mixed/csv-parse` reaches here 31,000
      // times per `run()` (21k `__extern_length` + 10k `__extern_get`), and every
      // receiver is a FRESH, short-lived `split()` result array — so the memo
      // was a pure cost: one `WeakMap.set` per crossing, plus an ephemeron entry
      // per dead object for the GC to walk. `_isWasmStruct` was 48% of that
      // benchmark's self time under `--cpu-prof`, with the GC a further 7.7%.
      // Re-deriving the verdict is a single map load, cheaper than the WeakMap
      // write it replaces, and skipping a cache write is not observable.
      //
      // The #3673 memo still covers the two cases it was introduced for — the
      // null-prototype arms below, where the classification is genuinely
      // expensive (an `Object.isExtensible` probe, or a thrown TypeError).
      // Ordering is untouched: the memo is still consulted first, so a proxy's
      // [[GetPrototypeOf]] trap is invoked exactly as often as before.
      return false;
    }
    // (#3673) WasmGC objects report non-extensible; a plain Object.create(null)
    // is extensible. This resolves the common case without the probe throw below.
    if (Object.isExtensible(obj)) {
      _wasmStructVerdict.set(obj, false);
      return false;
    }
    // Final check (rare: non-extensible null-proto value — a sealed/frozen JS
    // object or a WasmGC struct): attempting a property set on a WasmGC struct
    // throws an opaqueness TypeError. We test with a unique symbol to avoid
    // side-effects.
    const probe = Symbol();
    (obj as any)[probe] = 1;
    delete (obj as any)[probe];
    _wasmStructVerdict.set(obj, false);
    return false; // set succeeded → regular object
  } catch (e: any) {
    // Sealed/frozen plain JS objects (null-proto) throw on new-symbol set too.
    // WasmGC structs throw "WebAssembly objects are opaque" — NOT an extensibility error.
    // Filter out the JS extensibility error so sealed JS objects aren't misidentified.
    if (e instanceof TypeError && (e.message ?? "").includes("extensible")) {
      _wasmStructVerdict.set(obj, false);
      return false;
    }
    _wasmStructVerdict.set(obj, true);
    return true; // "WebAssembly objects are opaque" or similar
  }
}

/**
 * (#3637) THE vec discriminator for host-side runtime code. Use this — never an
 * open-coded `typeof __vec_len(v) === "number"` probe.
 *
 * WHY THIS EXISTS. `__vec_len` is a *length accessor*, not a predicate. Its
 * emitted body (`codegen/vec-access-exports.ts` `_emitVecAccessExportsInner`) is
 * a `ref.test` chain over every registered vec type whose FINAL `else` arm is
 * `i32.const 0; return` — it answers **0 for any non-vec value and does not
 * throw**. So `typeof __vec_len(v) === "number" && v >= 0` is *vacuously true
 * for every WasmGC struct*, and `len === 0` is indistinguishable from "not a
 * vec". Every call site that used that idiom as a discriminator silently
 * classified plain objects, class instances, Maps-as-structs, generators and
 * boxed values as **empty arrays** — erasing their contents rather than failing.
 *
 * The positive discriminator is `__is_vec`, emitted by the SAME pass as
 * `__vec_len` (both unconditional once `ctx.vecTypeMap` is non-empty — asserted
 * by `tests/issue-3637-*.test.ts`), so `__is_vec` is present whenever
 * `__vec_len` is. It is the identical `ref.test` chain but returns 1/0, which
 * makes "empty vec" and "not a vec" distinguishable.
 *
 * History: #2836 replaced this idiom at seven sites; #3486 found an eighth
 * (`extern_get`'s `.constructor` arm, which answered `Array` for every struct);
 * #3637 is the exhaustive sweep of the remainder plus this shared predicate, so
 * a ninth site cannot be written by copy-paste.
 *
 * The `__vec_len` branch below is LEGACY PARITY ONLY, for a hypothetical module
 * that exports `__vec_len` without `__is_vec`. Current codegen cannot produce
 * that shape; the branch exists so an unexpected module degrades to the old
 * (over-broad) answer rather than losing vec support entirely.
 */
export function _isWasmVec(v: any, exports: Record<string, Function> | undefined): boolean {
  if (v == null || typeof v !== "object" || !exports) return false;
  const isVec = exports.__is_vec;
  if (typeof isVec === "function") {
    try {
      return isVec(v) === 1;
    } catch {
      return false;
    }
  }
  const vecLen = exports.__vec_len;
  if (typeof vecLen !== "function") return false;
  try {
    const len = vecLen(v);
    return typeof len === "number" && len >= 0;
  } catch {
    return false;
  }
}

/** Check if a value can be used as a WeakMap/WeakSet key (must be object or function). */
export function _canBeWeakKey(obj: any): boolean {
  return obj != null && (typeof obj === "object" || typeof obj === "function");
}

export function _getSidecar(obj: object): Record<string | symbol, any> {
  if (!_canBeWeakKey(obj)) return Object.create(null) as Record<string | symbol, any>;
  return getOrCreateWasmStructSidecar(_wasmSidecars, obj);
}

export function _sidecarGet(obj: any, key: any): any {
  return _canBeWeakKey(obj) ? readWasmStructSidecar(_wasmSidecars, obj, key) : undefined;
}

export function _sidecarSet(obj: any, key: any, val: any): void {
  if (!_canBeWeakKey(obj)) return;
  writeWasmStructSidecar(_wasmSidecars, obj, key, val);
}

export function _sidecarDelete(obj: any, key: any): boolean {
  if (!_canBeWeakKey(obj)) return false;
  const sc = _wasmStructProps.get(obj);
  if (sc && key in sc) {
    delete sc[key];
    return true;
  }
  return false;
}

// #1826/#1935: an unforgeable absence sentinel keeps legitimate `undefined`
// results distinct from missing getters, methods, and properties.
export const _MISS: unique symbol = Symbol("runtime-absent-sentinel");
// Back-compat alias so the existing ToPrimitive call sites keep reading
// naturally; both names refer to the same unique symbol.
export const _PRIM_ABSENT: typeof _MISS = _MISS;

// (#3116) Default attribute flags for a live array element that has never been
// reconfigured: data property, writable+enumerable+configurable (§10.4.2).
export const _SC_ELEM_DEFAULT = _SC_DEFINED | _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE;

/**
 * (#983) The host facade cache: raw WasmGC carrier → its live-mirror Proxy
 * (`_wrapForHost`), and the reverse map `_unwrapForHost` uses to recover the
 * carrier identity when a facade crosses back into Wasm.
 */
export const _hostProxyCache = new WeakMap<object, any>();
export const _hostProxyReverse = new WeakMap<object, any>();
