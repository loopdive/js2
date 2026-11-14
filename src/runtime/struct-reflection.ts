// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) Value adapter: own-property reflection over WasmGC carriers —
 * struct field names (asked of the minting module across a linked graph,
 * #5225), [[HasOwnProperty]] and [[GetOwnProperty]] answers combining the
 * physical shape with the sidecar descriptor state, and the integrity clamp
 * for frozen/sealed carriers. Split out of `src/runtime.ts`.
 */

import { createCrossModuleStructOwners } from "./cross-module-struct-owners.js";
import {
  _wasmFrozenObjs,
  _wasmSealedObjs,
  _canBeWeakKey,
  _MISS,
  _isWasmStruct,
  _wasmStructDeletedKeys,
  _wasmPropDescs,
  _SC_WRITABLE,
  _SC_ACCESSOR,
  _SC_ELEM_DEFAULT,
  _SC_ENUMERABLE,
  _SC_CONFIGURABLE,
  _wasmStructProps,
  _normalizeDescKey,
  _SC_DEFINED,
  _wasmStructAccessors,
} from "./host-carrier-state.js";
import { arrayIndexForPropertyKey as _asArrayIndex } from "./wasm-struct-sidecar.js";

/**
 * Get the field names of a WasmGC struct by calling the __struct_field_names export.
 * Returns an array of field name strings, or null if the export is not available
 * or the value is not a recognized struct type.
 */
// (#3673) Cache the `__struct_field_names` CSV split per distinct CSV string.
// The CSV is a per-shape constant (one string per struct type), so the split
// allocation is paid once per shape instead of per call. Callers of
// `_structFieldNamesRaw` must treat the returned array as immutable — it is
// shared across calls.
const _csvSplitCache = new Map<string, readonly string[]>([["", []]]); // "" = known shape, no fields (#6430)

export function _structFieldNamesRaw(
  obj: any,
  exports: Record<string, Function> | undefined,
): readonly string[] | null {
  exports = _decoderExportsFor(obj, exports); // (#5225)
  if (!exports) return null;
  const fn = exports.__struct_field_names;
  if (typeof fn !== "function") return null;
  const csv = fn(obj);
  if (csv == null || typeof csv !== "string") return null;
  let names = _csvSplitCache.get(csv);
  if (!names) {
    // (#4616) Codegen escapes commas INSIDE a field name as U+0001 (see
    // escapeStructFieldNameForCsv) so the join/split round-trip is lossless
    // for keys like cookie's "Expires=Sun, 26 Jul …" snapshot table.
    names = csv.split(",").map((n) => (n.indexOf("\u0001") >= 0 ? n.split("\u0001").join(",") : n));
    _csvSplitCache.set(csv, names);
  }
  return names;
}

export function _getStructFieldNames(obj: any, exports: Record<string, Function> | undefined): string[] | null {
  exports = _decoderExportsFor(obj, exports); // (#5225) `__shas_` must match the names
  const names = _structFieldNamesRaw(obj, exports);
  if (!names) return null;
  return names.filter((field) => {
    const presence = exports![`__shas_${field}`];
    return typeof presence !== "function" || presence(obj) !== 0;
  });
}

/**
 * (#3673) Single-key own-field membership for a WasmGC struct receiver —
 * `_getStructFieldNames(obj, exports).includes(key)` without paying a
 * `__shas_<field>` Wasm presence call for EVERY field of the shape (acorn's
 * Parser struct has dozens; the full filter was 28% of parse CPU). Presence is
 * consulted for the ONE requested key only, preserving the per-instance
 * presence-bit semantics (#2847).
 */
export function _structOwnFieldStatus(
  obj: any,
  key: string,
  exports: Record<string, Function> | undefined,
): boolean | undefined {
  exports = _decoderExportsFor(obj, exports); // (#5225) `__shas_` must match the names
  const names = _structFieldNamesRaw(obj, exports);
  if (!names) return undefined;
  if (!names.includes(key)) return false;
  const presence = exports![`__shas_${key}`];
  return typeof presence !== "function" || presence(obj) !== 0;
}

export function _structHasOwnFieldName(obj: any, key: string, exports: Record<string, Function> | undefined): boolean {
  return _structOwnFieldStatus(obj, key, exports) === true;
}

/**
 * (#2130) Shared own-property presence predicate for a WasmGC struct receiver.
 * This is the single source of truth for "does `obj` have its OWN property
 * `key`", combining — in spec order — the runtime delete tombstone, the sidecar
 * store, the descriptor table (accessor-only properties), registered class
 * proto/static method names, and finally the static struct field shape. It is
 * the WasmGC branch of `__hasOwnProperty` extracted verbatim so that
 * `__extern_has` (the `in` operator) and `__hasOwnProperty` answer identically
 * and BOTH consult the tombstone (`delete o.a; "a" in o` → false).
 *
 * The caller must have already established `_isWasmStruct(obj)` is true.
 * `key` may be a string or a symbol; tombstone/sidecar comparisons preserve
 * symbol identity (a symbol key is never stringified).
 */
export function _wasmStructHasOwn(obj: any, key: any, exports: Record<string, Function> | undefined): boolean {
  exports = _decoderExportsFor(obj, exports); // (#5225)
  // (#1334) Property explicitly deleted — treat as absent regardless of the
  // struct shape having the field name.
  const tomb = _wasmStructDeletedKeys.get(obj);
  if (tomb && tomb.has(typeof key === "symbol" ? key : String(key))) return false;
  // Sidecar properties (user-assigned dynamic props). Key-based — HasProperty
  // (§7.3.12) is value-independent, so `o.x = undefined; "x" in o` is true (A8).
  const sc = _wasmStructProps.get(obj);
  if (sc && key in sc) return true;
  // Descriptor map (accessor properties set via Object.defineProperty, #929).
  const descs = _wasmPropDescs.get(obj);
  if (descs && descs.has(String(key))) return true;
  // (#6482 r2) Vec receiver: an in-bounds element index is an own property even
  // with no sidecar/descriptor entry, and `length` always is. A vec has no
  // struct field names, so the shape probe below answers false for both — which
  // is what made propertyHelper's `__hasOwnProperty(arguments, "0")` false once
  // the `for…in` gate above it started passing.
  //
  // (#6482 r3/r4) An ordinary array can be SPARSE, so `idx < length` reports
  // its HOLES as own. A registered `arguments` object is dense by construction
  // (§10.4.4 maps exactly `0 .. length-1`) and keeps the length test; every
  // other vec asks the MINTING module via `__vec_has_own_index`. A module that
  // cannot answer leaves the key to the struct-shape probe below, which is the
  // pre-r2 behaviour.
  if (typeof key !== "symbol" && _canBeWeakKey(obj)) {
    const prop = String(key);
    const idx = _asArrayIndex(prop);
    if (prop === "length" || idx !== undefined) {
      const lenFn = exports?.__vec_len as ((v: any) => number) | undefined;
      const isVecFn = exports?.__is_vec as ((v: any) => number) | undefined;
      if (typeof lenFn === "function" && typeof isVecFn === "function") {
        try {
          if (isVecFn(obj) === 1) {
            if (prop === "length") return true;
            const own = _vecOverlayOwnIndex(obj, idx as number, exports);
            if (own !== undefined) return own;
          }
        } catch {
          /* not a vec of this module */
        }
      }
    }
  }
  // Static struct field shape (the per-receiver oracle, A1 — NOT a module-global
  // `__sget_<key>` existence probe). Single-key check (#3673) — avoids the
  // full per-field presence sweep.
  return _structHasOwnFieldName(obj, String(key), exports);
}
// (#5225) Inbound twin: which module of a linked project can DECODE a struct.
export const _crossModuleStructs = createCrossModuleStructOwners(_canBeWeakKey);

/**
 * (#5225) The exports that can DECODE `obj` — the reader's own, unless another
 * module of the same linked project minted it.
 *
 * Every struct read must resolve its field-name list, its `__shas_` presence
 * bit and its `__sget_` getter from the SAME module. Mixing them is not a
 * missed optimisation but a wrong answer: with the owner's names and the
 * reader's getter, a field name the reader happens to reuse for one of its own
 * shapes (`month` and `day` are all over the Temporal polyfill) reads as
 * "present" and returns that getter's `ref.test`-miss default — 0 — instead of
 * the real value. So this is applied at the top of each read, not as a retry.
 *
 * One boolean when no linked project is live; a cached `WeakMap.get` otherwise.
 */
export function _decoderExportsFor(
  obj: any,
  exports: Record<string, Function> | undefined,
): Record<string, Function> | undefined {
  return _crossModuleStructs.decoderFor(obj, exports) ?? exports;
}

/**
 * (#1629 S1) Canonical own-property-descriptor reader for a WasmGC struct.
 *
 * This is the single read-back path shared by `Object.getOwnPropertyDescriptor`
 * (single key) and `Object.getOwnPropertyDescriptors` (all keys). It resolves
 * a descriptor from the three storage sites in spec-precedence order:
 *   1. sidecar (`_wasmStructProps` value + `_wasmPropDescs` flags) — covers any
 *      property that has been touched by `defineProperty` / dynamic write,
 *      including accessor descriptors (`_SC_ACCESSOR`);
 *   2. registered class proto-/static-method allowlists — spec method flags;
 *   3. the bare WasmGC struct field via the exported `__sget_<key>` getter, with
 *      default data-property flags (the zero-overhead fast path for fields that
 *      were never `defineProperty`'d — the no-regression guarantee).
 *
 * Returns a PropertyDescriptor object, or `undefined` when `prop` is not an own
 * property of `obj`. Caller is responsible for the non-struct fast path
 * (`Object.getOwnPropertyDescriptor`) and for `ToPropertyKey` on `prop`.
 */
/**
 * (#3661) Clamp a data descriptor to the receiver's frozen/sealed state.
 *
 * `Object.freeze`/`seal` record per-property flags in the sidecar descriptor
 * table, which covers properties that HAVE a sidecar entry (dynamically added,
 * or `defineProperty`-created). It does NOT cover the two shapes whose value
 * lives outside the sidecar — a **bare struct field** (object-literal property)
 * and a **vec element** (array index) — so `getOwnPropertyDescriptor` reported
 * `writable: true, configurable: true` on a frozen object. Measured on HEAD:
 * frozen plain field read back `w,c,e = true,true,true` where V8 gives
 * `false,false,true`; a frozen array element likewise.
 *
 * Clamping on the READ side covers every shape uniformly and is exactly the
 * spec statement — an integrity-level-frozen object's own data properties are
 * non-writable and non-configurable (§7.3.15 SetIntegrityLevel), sealed ones
 * non-configurable — rather than trying to keep the write side's enumeration in
 * sync with every value-carrier. Accessor descriptors are left alone: freeze
 * makes them non-configurable but has no `[[Writable]]` to clear.
 */
function _clampFrozenDescriptor(obj: any, d: PropertyDescriptor): PropertyDescriptor {
  const frozen = _wasmFrozenObjs.has(obj);
  if (!frozen && !_wasmSealedObjs.has(obj)) return d;
  d.configurable = false;
  if (frozen && !d.get && !d.set) d.writable = false;
  return d;
}

function _vecOverlayOwnIndex(
  obj: any,
  idx: number,
  exports: Record<string, Function> | undefined,
): boolean | undefined {
  // (#6482 r5) A host-side `delete arr[i]` cannot reach the in-wasm #3251
  // overlay, so it records a tombstone here instead. It has to be consulted
  // BEFORE the module is asked: the element is still physically in the backing
  // array, so `__vec_has_own_index` would honestly answer "present".
  if (_wasmStructDeletedKeys.get(obj)?.has(String(idx)) === true) return false;
  const resolved = _decoderExportsFor(obj, exports); // (#5225/#6477) the MINTING module
  const hasOwnIdx = resolved?.__vec_has_own_index as ((v: any, i: number) => number) | undefined;
  if (typeof hasOwnIdx !== "function") return undefined;
  try {
    const answer = hasOwnIdx(obj, idx);
    // 1 = own, 0 = hole, anything else (-1) = the module does not recognize this
    // receiver and is not entitled to an opinion.
    return answer === 1 ? true : answer === 0 ? false : undefined;
  } catch {
    return undefined;
  }
}

export function _readOwnDescriptor(
  obj: any,
  prop: string | symbol,
  exports: Record<string, Function> | undefined,
): PropertyDescriptor | undefined {
  // (#6477) Every export this function reaches (`__is_vec`, `__vec_len`,
  // `__vec_get`, `__sget_<name>`, and the `_wasmStructHasOwn` gate) must come
  // from the module that MINTED `obj`. Across a #5225 linked boundary the
  // reader is frequently the other module, and its `ref.test` answers a miss —
  // so the descriptor came back `undefined`, or with a `0`/`null` value.
  // Redirecting here rather than at each caller covers the descriptor-value
  // path AND `_wasmStructPropertyIsEnumerable`, which funnels into it.
  // Idempotent, and a no-op when no linked project is live.
  exports = _decoderExportsFor(obj, exports);
  if (prop === "length" && exports) {
    const nativeString = _nativeStringToHost(obj, exports);
    if (nativeString !== _MISS)
      return { value: nativeString.length, writable: false, enumerable: false, configurable: false };
  }
  // (#3200 slice 2) Delete tombstone FIRST: `delete obj[k]` on a struct
  // receiver records the key in `_wasmStructDeletedKeys` (#1334) but the
  // struct FIELD still exists, so the field-name-registry step below would
  // resurrect the deleted property as an own data descriptor. A deleted key
  // is not an own property for gOPD, HasProperty, or the array-like index
  // MOP (the test262 forEach `-7-b-*` "deleted properties are visible"
  // family deletes mid-iteration through a `length` accessor). Mirrors the
  // `_wasmStructHasOwn` ordering.
  {
    const tomb = _wasmStructDeletedKeys.get(obj);
    if (tomb && tomb.has(typeof prop === "symbol" ? prop : String(prop))) return undefined;
  }
  // 0. (#3116) Vec (compiled array) receiver: element and `length` descriptors
  // read LIVE from the vec (values live in the vec, attributes in the sidecar
  // table — see _vecDefineOwnProperty). Previously an in-bounds element with no
  // sidecar entry read back as "not an own property", and one WITH a flags
  // entry read its value through `__sget_<idx>` (a struct-field getter that
  // does not exist for indices) — both wrong. Accessor-flagged entries fall
  // through to the generic sidecar branch, which serves get/set correctly.
  if (typeof prop === "string" && exports) {
    const isVecFn = exports.__is_vec as ((v: any) => number) | undefined;
    let isVecRecv = false;
    if (typeof isVecFn === "function") {
      try {
        isVecRecv = isVecFn(obj) === 1;
      } catch {
        isVecRecv = false;
      }
    }
    if (isVecRecv) {
      const lenFn = exports.__vec_len as ((v: any) => number) | undefined;
      const getVE = exports.__vec_get as ((v: any, i: number) => any) | undefined;
      const vecDescs = _wasmPropDescs.get(obj);
      if (prop === "length" && typeof lenFn === "function") {
        const lf = vecDescs?.get("length");
        return {
          value: lenFn(obj),
          writable: lf === undefined ? true : !!(lf & _SC_WRITABLE),
          enumerable: false,
          configurable: false,
        };
      }
      const idx = _asArrayIndex(prop);
      // (#6482 r5) A tombstoned index has no descriptor — see `__delete_property`.
      if (idx !== undefined && _wasmStructDeletedKeys.get(obj)?.has(prop) === true) return undefined;
      if (idx !== undefined && typeof lenFn === "function" && typeof getVE === "function") {
        let vlen = 0;
        try {
          vlen = lenFn(obj);
        } catch {
          vlen = 0;
        }
        if (idx < vlen) {
          const f = vecDescs?.get(prop);
          if (f === undefined || !(f & _SC_ACCESSOR)) {
            let value: any;
            try {
              value = getVE(obj, idx);
            } catch {
              value = undefined;
            }
            const flags = f ?? _SC_ELEM_DEFAULT;
            return _clampFrozenDescriptor(obj, {
              value,
              writable: !!(flags & _SC_WRITABLE),
              enumerable: !!(flags & _SC_ENUMERABLE),
              configurable: !!(flags & _SC_CONFIGURABLE),
            });
          }
        }
        // idx >= length or accessor-flagged → generic sidecar handling below.
      }
    }
  }
  // 1. Sidecar (dynamically added / defineProperty'd props).
  const sc = _wasmStructProps.get(obj);
  const descs = _wasmPropDescs.get(obj);
  const flagsFromTable = descs?.get(_normalizeDescKey(prop));
  const hasSidecarValue = !!sc && prop in sc;
  if (hasSidecarValue || flagsFromTable !== undefined) {
    const flags = flagsFromTable ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
    if (flags & _SC_ACCESSOR) {
      if (typeof prop === "symbol") {
        const accessor = _wasmStructAccessors.get(obj)?.get(prop) as
          | { get?: () => any; set?: (v: any) => void }
          | undefined;
        return {
          get: accessor?.get,
          set: accessor?.set,
          enumerable: !!(flags & _SC_ENUMERABLE),
          configurable: !!(flags & _SC_CONFIGURABLE),
        };
      }
      return {
        get: (sc as any)[`__get_${prop}`],
        set: (sc as any)[`__set_${prop}`],
        enumerable: !!(flags & _SC_ENUMERABLE),
        configurable: !!(flags & _SC_CONFIGURABLE),
      };
    }
    let value = hasSidecarValue ? (sc as any)[prop as any] : undefined;
    if (!hasSidecarValue && typeof prop === "string") {
      const getter = exports?.[`__sget_${prop}`];
      if (typeof getter === "function") {
        try {
          value = getter(obj);
        } catch {
          value = undefined;
        }
      }
    }
    return {
      value,
      writable: !!(flags & _SC_WRITABLE),
      enumerable: !!(flags & _SC_ENUMERABLE),
      configurable: !!(flags & _SC_CONFIGURABLE),
    };
  }
  const propStr = String(prop);
  // 3. Bare struct field via exported getter — zero-overhead data-property path.
  if (_structHasOwnFieldName(obj, propStr, exports)) {
    const getter = exports?.[`__sget_${propStr}`];
    const value = typeof getter === "function" ? getter(obj) : undefined;
    const descs = _wasmPropDescs.get(obj);
    const flags = descs?.get(propStr) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
    return _clampFrozenDescriptor(obj, {
      value,
      writable: !!(flags & _SC_WRITABLE),
      enumerable: !!(flags & _SC_ENUMERABLE),
      configurable: !!(flags & _SC_CONFIGURABLE),
    });
  }
  return undefined; // not an own property
}

/** Convert a native `$AnyString` carrier to its JS primitive at the edge. */
export function _nativeStringToHost(value: any, exports: Record<string, Function> | undefined): any | typeof _MISS {
  if (value == null || typeof value !== "object" || !_isWasmStruct(value) || !exports) return _MISS;
  const isNative = exports.__str_is_native as ((value: any) => number) | undefined;
  const toHost = exports.__str_to_extern as ((value: any) => string) | undefined;
  if (typeof isNative !== "function" || typeof toHost !== "function") return _MISS;
  try {
    return isNative(value) === 1 ? toHost(value) : _MISS;
  } catch {
    return _MISS;
  }
}
