// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) Value adapter: detached plain-JS copies of WasmGC values for
 * host consumers that need data rather than a live facade, and the compiled
 * Date carrier → host `Date` marshal (#5208). Split out of `src/runtime.ts`.
 */

import { wasmDateHostView } from "./date-host-method.js";
import {
  _MISS,
  _isWasmStruct,
  _canBeWeakKey,
  _hostProxyReverse,
  _wasmStructProps,
  _nativeIsArray,
  _isWasmVec,
} from "./host-carrier-state.js";
import { _decoderExportsFor, _getStructFieldNames } from "./struct-reflection.js";

/**
 * Convert a WasmGC struct to a plain JS object using exported getters.
 * Returns undefined if the struct type is not recognized.
 */
function _structToPlainObject(
  obj: any,
  exports: Record<string, Function> | undefined,
  seen?: Set<any>,
): Record<string, any> | undefined {
  const fieldNames = _getStructFieldNames(obj, exports);
  if (!fieldNames) return undefined;
  const result: Record<string, any> = {};
  for (const key of fieldNames) {
    const getter = exports?.[`__sget_${key}`];
    if (typeof getter === "function") {
      let val = getter(obj);
      // Recursively convert nested WasmGC structs and vecs (threading the
      // JSON cycle-detection `seen` set, when supplied, so a self-referential
      // field — `o.prop = o` — raises a TypeError instead of recursing here
      // until a host stack overflow; #2671).
      val = _wasmToPlain(val, exports, seen);
      if (typeof exports?.[`__sbool_${key}`] === "function" && (val === 0 || val === 1)) {
        val = val !== 0;
      }
      result[key] = val;
    }
  }
  // Also include sidecar properties (dynamically-assigned own props, e.g.
  // acorn's `node.quasis = [...]` / `node.expressions = [...]`).
  // (#2851/#2852) These MUST be deep-converted the same way nominal fields are
  // (the `val = _wasmToPlain(getter(obj))` above): a sidecar value that is —
  // or contains — raw WasmGC structs (a child AST node, or an ARRAY of child
  // nodes) was previously merged verbatim, so a `marshal:"copy"`/JSON consumer
  // saw `quasis[*]` / `expressions[*]` elements as blank/opaque. Recurse so the
  // deep copy reaches struct values and array-of-struct elements. Idempotent
  // for plain JS values (`_wasmToPlain` returns primitives as-is).
  const sc = _wasmStructProps.get(obj);
  if (sc) {
    for (const key of Object.keys(sc)) {
      if (!(key in result)) {
        let value = _wasmToPlain(sc[key], exports, seen);
        if (typeof exports?.[`__sbool_${key}`] === "function" && (value === 0 || value === 1)) {
          value = value !== 0;
        }
        result[key] = value;
      }
    }
  }
  return result;
}

/**
 * Recursively convert a WasmGC value (struct, vec/array, or primitive) to a
 * plain JS value suitable for JSON.stringify.  Handles:
 *   - WasmGC structs  -> plain objects (via _structToPlainObject)
 *   - WasmGC vecs     -> JS arrays (via __vec_len / __vec_get)
 *   - primitives / normal JS objects -> returned as-is
 */
export function _wasmToPlain(val: any, exports: Record<string, Function> | undefined, seen?: Set<any>): any {
  if (val == null || typeof val !== "object") return val;
  // (#2841) A real host JS array can still hold RAW wasm-struct elements. This
  // happens when a wasm vec crosses a dynamic-dispatch boundary as an `any`
  // argument and the host shim `__make_iterable` materialises it into a JS
  // array of opaque structs (#2836 — e.g. acorn's arrow-function param list:
  // the paren `exprList` is passed to `parseArrowExpression` indirectly, so
  // `node.params` ends up a host JS array whose Identifier elements are wasm
  // structs). `_wasmToPlain` previously returned such an array as-is (the
  // `!_isWasmStruct` early-out below), leaving the elements opaque so a
  // marshal:"copy"/JSON.stringify consumer saw `param.type`/`.name` as
  // `undefined`. Decl/fn-expr params take the `parseBindingList` path and stay a
  // genuine wasm vec, which the `__vec_get` branch below already converts —
  // hence only ARROW params lost their fields. Recurse element-wise so the deep
  // copy reaches the structs. (A wasm vec is NOT a JS array — `Array.isArray`
  // is false for it — so this never double-handles the `__vec_get` path.)
  if (_nativeIsArray(val)) {
    if (seen) {
      if (seen.has(val)) throw new TypeError("Converting circular structure to JSON");
      seen.add(val);
    }
    try {
      return val.map((e) => _wasmToPlain(e, exports, seen));
    } finally {
      if (seen) seen.delete(val);
    }
  }
  if (!_isWasmStruct(val)) return val;

  // (#5208) The Date carrier flattens to its HOST Date, not to its raw
  // `{timestamp}` field list — `JSON.stringify({d: new Date(0)})` answered
  // `{"d":{"timestamp":null}}`, the compiler's private carrier field leaked
  // through the boundary. Handing back a real Date lets §25.5.2.4 step 2 find
  // `Date.prototype.toJSON` on the host side, so nothing Date-specific has to
  // be synthesised in compiled code. Ahead of the cycle bookkeeping: a Date is
  // a leaf, it cannot participate in a cycle.
  {
    const hostDate = _marshalWasmDateForHost(val, exports);
    if (hostDate !== _MISS) return hostDate;
  }

  // (#2671) Cycle detection for the JSON.stringify flatten fast path. When a
  // `seen` ancestor set is supplied, a struct already on the current
  // serialization path is a circular reference — §25.5.2.5 / §25.5.2.6 step 1
  // mandate a TypeError ("Converting circular structure to JSON"); the previous
  // behaviour recursed (`_wasmToPlain` → `_structToPlainObject` → `_wasmToPlain`
  // via the field getter) until a host RangeError stack overflow. The set is
  // PATH-scoped (added before descending, removed in `finally`), so a DAG with
  // shared-but-acyclic references still flattens correctly. Callers that omit
  // `seen` (non-JSON consumers) keep the original cycle-unsafe behaviour.
  if (seen) {
    if (seen.has(val)) throw new TypeError("Converting circular structure to JSON");
    seen.add(val);
  }
  try {
    // Check if this is a named struct (has field names from __struct_field_names).
    // Named structs are user-defined types — convert to plain objects.
    // Vec wrappers (arrays) don't have meaningful field names registered.
    const fieldNames = _getStructFieldNames(val, exports);
    if (fieldNames) {
      // It's a named struct — convert to plain object with recursive conversion
      return _structToPlainObject(val, exports, seen);
    }

    // Try vec (array wrapper) conversion — vec structs have {length, data} fields
    // but are NOT registered in __struct_field_names (they're internal types).
    //
    // (#3637) Gated on the POSITIVE `__is_vec` discriminator. The old code
    // treated `__vec_len(val) === 0` as "empty array" with the reasoning quoted
    // in `_normaliseJsonReplacer` — "len === 0 could be an empty array or a
    // non-vec struct … treat len=0 as an empty array". That was the vacuity
    // itself: `__vec_len`'s not-a-vec DEFAULT is 0, so every field-less struct
    // (a class instance carrying only methods, a boxed value, a closure that
    // slipped past `__is_closure`) flattened to `[]`. Measured pre-fix:
    // `JSON.stringify(new Empty())` → `"[]"` and `{a: new Empty()}` →
    // `{"a":[]}`, where the host answers `"{}"` / `{"a":{}}`.
    const isVec = exports ? _isWasmVec(val, exports) : false;
    if (isVec && exports) {
      const vecLen = exports.__vec_len;
      const vecGet = exports.__vec_get;
      if (typeof vecLen === "function" && typeof vecGet === "function") {
        try {
          const len = vecLen(val);
          if (typeof len === "number" && len >= 0) {
            const arr: any[] = [];
            for (let i = 0; i < len; i++) {
              arr.push(_wasmToPlain(vecGet(val, i), exports, seen));
            }
            return arr;
          }
        } catch (e) {
          // Propagate a circular-structure TypeError raised by a deeper element.
          if (e instanceof TypeError) throw e;
          // (#3637) The rest is NOT "not a vec" — `_isWasmVec` on the guard
          // above decided that and `__vec_len` never throws for a non-vec. Only
          // a genuine element-read trap lands here; fall through to the object
          // rendering below.
        }
      }
      // A genuine vec we cannot read (no `__vec_get`) — hand the raw ref back
      // rather than inventing a shape for it.
      return val;
    }

    // (#3637) A WasmGC struct that is neither a named struct nor a vec is still
    // an OBJECT, not an array: render it as `{}` plus any sidecar-assigned
    // dynamic own properties, which is what the host produces for the same
    // source (`JSON.stringify(new Empty())` → `"{}"`). Before the `__is_vec`
    // gate above, such values never reached here — the vacuous `len === 0`
    // probe claimed them as empty arrays.
    if (exports) {
      const sidecar = _wasmStructProps.get(val);
      if (sidecar) {
        const out: Record<string, any> = {};
        for (const key of Object.keys(sidecar)) out[key] = _wasmToPlain(sidecar[key], exports, seen);
        return out;
      }
      return {};
    }

    // No exports to introspect with — return as-is
    return val;
  } finally {
    if (seen) seen.delete(val);
  }
}

/**
 * (#5208) The compiler-owned WasmGC Date carrier as a real host `Date`, or
 * `_MISS`. The view itself — and why it is identity-CACHED and yet RE-SYNCED on
 * every crossing — lives in `runtime/date-host-method.ts`, which already owns
 * the carrier protocol. This is only the binding of the three things that
 * module cannot see: struct classification, the #5225 cross-module DECODER
 * selection (without it a linked project's `ref.test` answers 0 and the carrier
 * silently falls through to the generic proxy), and the reverse identity map.
 */
export function _marshalWasmDateForHost(
  value: any,
  exports: Record<string, Function> | undefined,
): Date | typeof _MISS {
  if (value == null || typeof value !== "object" || !_isWasmStruct(value) || !_canBeWeakKey(value)) return _MISS;
  const hostDate = wasmDateHostView(value, _decoderExportsFor(value, exports), _isWasmStruct, (host, carrier) =>
    _hostProxyReverse.set(host, carrier),
  );
  return hostDate ?? _MISS;
}
