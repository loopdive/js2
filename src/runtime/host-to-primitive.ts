// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6979 S7-d) Value adapter: OrdinaryToPrimitive for a WasmGC carrier that
 * reaches a host ToPrimitive (#1319, #1716) — the compiled `@@toPrimitive` /
 * `valueOf` / `toString` members run, Date carriers answer their time value,
 * and an abrupt user method propagates. Split out of `src/runtime.ts`.
 */

import { _isWasmStruct, _PRIM_ABSENT, _hostProxyReverse, _MISS, _sidecarGet } from "./host-carrier-state.js";
import type { MarshalExportSource } from "./init-marshal-registry.js";
import { compiledClosureNativeSource } from "./native-function-source.js";
import { _crossModuleStructs } from "./struct-reflection.js";

/**
 * ToPrimitive for WasmGC structs (#850).
 *
 * Implements the JS ToPrimitive abstract operation for opaque WasmGC struct
 * externrefs. V8 cannot call valueOf/toString on opaque GC structs natively,
 * so we check sidecar properties and Wasm-exported struct getters.
 *
 * For hint "string", toString is checked before valueOf (per spec).
 * For hint "number"/"default", valueOf is checked before toString.
 * Returns the primitive value, or undefined if no conversion found.
 */
/**
 * (#4616, cookie Expires family) ToPrimitive for the compiler-owned WasmGC
 * Date carrier. `+d` / `d1 - d2` / `String(d)` on an any-typed `$Date`
 * funneled through the generic ToPrimitive protocols and fell to the NaN /
 * "[object Object]" defaults, so every Date equality/order comparison in the
 * parse-set-cookie corpus (and jest's diff `expires` toEqual) failed.
 * §21.4.4.45: hint "number" → the timestamp; "string"/"default" → the date
 * string. Mirrors tryCallWasmDateHostMethod's carrier protocol. Returns
 * `_MISS` when the value is not the Date carrier.
 */
export function _wasmDateToPrimitive(
  raw: any,
  hint: "number" | "string" | "default",
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any | typeof _MISS {
  if (raw == null || typeof raw !== "object" || !_isWasmStruct(raw)) return _MISS;
  const dexps = callbackState?.getExports();
  const isDate = dexps?.["__\0js2_is_date"] as ((value: unknown) => number) | undefined;
  const dateValue = dexps?.["__\0js2_date_value"] as ((value: unknown) => bigint) | undefined;
  if (typeof isDate !== "function" || typeof dateValue !== "function") return _MISS;
  try {
    if (isDate(raw) !== 1) return _MISS;
    const invalidTimestamp = -0x8000000000000000n;
    const ts = dateValue(raw);
    const ms = ts === invalidTimestamp ? NaN : Number(ts);
    return hint === "number" ? ms : new Date(ms).toString();
  } catch {
    return _MISS;
  }
}

/**
 * (#3481) Does `struct` OWN the field `name`, per the compiler's own presence
 * bits? `__sget_<name>` is a shape-DISPATCHED getter: it answers for any shape
 * carrying that field, and for a conditionally-initialized slot it happily
 * returns the untouched default. `__shas_<name>` (#2847) is the query that
 * distinguishes "explicitly set" from "default slot" — consult it when the
 * module emitted one, and assume presence otherwise (it is only emitted when
 * some field is presence-tracked, so its absence means every slot is always
 * present). Used to keep the exotic-@@toPrimitive probe from reading a default
 * slot as a user-supplied `Symbol.toPrimitive`.
 */
function _hasOwnStructField(struct: any, name: string, exports: Record<string, Function> | undefined): boolean {
  const shas = exports?.[`__shas_${name}`];
  if (typeof shas !== "function") return true;
  try {
    return Number(shas(struct)) !== 0;
  } catch (e: any) {
    if (!(e instanceof WebAssembly.RuntimeError)) throw e;
    return false;
  }
}

/**
 * (#3481) Invoke an exotic `@@toPrimitive` that was read out of a WasmGC struct
 * FIELD (the object-literal `{ [Symbol.toPrimitive]: … }` shape).
 *
 * §7.1.1 step 2 is `Call(exoticToPrim, input, «hint»)` — a METHOD call on the
 * receiver that is handed the hint — so the receiver-threading
 * `__call_fn_method_*` dispatchers are tried before the receiver-less ones, and
 * the 1-arg forms before the 0-arg ones. (The generic dispatchers tolerate an
 * arity mismatch, so a `function () { … }` that ignores the hint still runs on
 * the 1-arg arm; the cascade is the belt-and-braces order the sibling sidecar
 * branch in `_toPrimitive` already uses.)
 *
 * Returns the produced primitive, or `_PRIM_ABSENT` when the module exports no
 * dispatcher that could run the closure — the caller then continues with
 * OrdinaryToPrimitive, i.e. keeps the pre-#3481 behaviour rather than inventing
 * a failure. Both spec violations throw a real TypeError: a non-callable slot
 * (step 2d) and a method that returns an object (step 5).
 */
function _callExoticToPrimitiveSlot(
  receiver: any,
  slot: any,
  hint: "number" | "string" | "default",
  exports: Record<string, Function> | undefined,
): any {
  // A host-bridged JS function (proxy-wrapped closure or a real binding).
  if (typeof slot === "function") {
    const prim = slot.call(receiver, hint);
    if (prim == null || typeof prim !== "object") return prim;
    throw new TypeError("Cannot convert object to primitive value");
  }
  // §7.1.1 step 2d — the slot holds a non-callable (a number, a string, a
  // plain object, …). IsCallable is false, so this is a TypeError, not a
  // fall-through to valueOf/toString.
  if (typeof slot !== "object" || !_isWasmStruct(slot)) {
    throw new TypeError("Cannot convert object to primitive value");
  }
  const isClosure = exports?.["__is_closure"];
  if (typeof isClosure === "function") {
    let callable = 1;
    try {
      callable = Number(isClosure(slot));
    } catch (e: any) {
      if (!(e instanceof WebAssembly.RuntimeError)) throw e;
    }
    if (!callable) throw new TypeError("Cannot convert object to primitive value");
  }
  const attempts: [string, (dispatch: Function) => any][] = [
    ["__call_fn_method_1", (dispatch) => dispatch(receiver, slot, hint)],
    ["__call_fn_1", (dispatch) => dispatch(slot, hint)],
    ["__call_fn_method_0", (dispatch) => dispatch(receiver, slot)],
    ["__call_fn_0", (dispatch) => dispatch(slot)],
  ];
  for (const [name, invoke] of attempts) {
    const dispatch = exports?.[name];
    if (typeof dispatch !== "function") continue;
    try {
      const prim = invoke(dispatch);
      if (prim == null || typeof prim !== "object") return prim;
      // §7.1.1 step 5 — exotic @@toPrimitive returned an object.
      throw new TypeError("Cannot convert object to primitive value");
    } catch (e: any) {
      // Only a wasm type-mismatch trap falls through to the next dispatcher;
      // a user throw and the step-5 TypeError above propagate.
      if (!(e instanceof WebAssembly.RuntimeError)) throw e;
    }
  }
  return _PRIM_ABSENT;
}

/**
 * Full ToPrimitive for proxied WasmGC structs and plain JS objects (#1090).
 * Unlike _toPrimitive (which only checks sidecar + Wasm exports), this function
 * also checks real JS properties on the object/proxy. This handles the case where
 * Symbol.toPrimitive/valueOf/toString are WasmGC closures that the proxy wraps
 * as callable JS functions, or where V8's native property access finds them.
 *
 * Throws TypeError if no conversion is possible (per ECMA-262 §7.1.1).
 */
export function _hostToPrimitive(
  obj: any,
  hint: "number" | "string" | "default",
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (obj == null || typeof obj !== "object") return obj;

  // Check Symbol.toPrimitive via real JS property access (goes through proxy if applicable)
  const raw = _hostProxyReverse.get(obj) ?? obj;
  // (#5374) The #5225 seam, one step past the field read: every arm below
  // dispatches through an export of ONE module (`__sget_valueOf`,
  // `__call_fn_method_0`, `__call_@@toPrimitive`, …) resolved from the module
  // the coercion is RUNNING in — so a consumer-minted object coerced inside a
  // linked provider found no method and bottomed out at "[object Object]".
  // Retargeted once here, not per probe: the arms must agree on a module.
  // Miss path only (the registry's `enabled` boolean). Detail in the issue.
  callbackState = _crossModuleCallbackState(raw, callbackState);
  // (#4616) WasmGC Date carrier — see _wasmDateToPrimitive.
  {
    const dateMs = _wasmDateToPrimitive(raw, hint, callbackState);
    if (dateMs !== _MISS) return dateMs;
  }
  const exotic = obj[Symbol.toPrimitive];
  if (exotic !== undefined && exotic !== null) {
    if (typeof exotic === "function") {
      const result = exotic.call(obj, hint);
      if (result == null || typeof result !== "object") return result;
      throw new TypeError("Cannot convert object to primitive value");
    }
    // WasmGC closure struct — dispatch via __call_fn_1 (#1090)
    if (typeof exotic === "object" && _isWasmStruct(exotic) && callbackState) {
      const exports = callbackState.getExports();
      if (exports) {
        const callFn1 = exports["__call_fn_1"];
        if (typeof callFn1 === "function") {
          const result = callFn1(exotic, hint);
          if (result == null || typeof result !== "object") return result;
          throw new TypeError("Cannot convert object to primitive value");
        }
        const callFn0 = exports["__call_fn_0"];
        if (typeof callFn0 === "function") {
          const result = callFn0(exotic);
          if (result == null || typeof result !== "object") return result;
          throw new TypeError("Cannot convert object to primitive value");
        }
      }
    }
    throw new TypeError("Cannot convert object to primitive value");
  }

  // Also check sidecar (for unwrapped WasmGC structs not behind a proxy)
  const scExotic = _sidecarGet(raw, Symbol.toPrimitive);
  if (scExotic !== undefined && scExotic !== null) {
    if (typeof scExotic === "function") {
      const result = scExotic.call(raw, hint);
      if (result == null || typeof result !== "object") return result;
      throw new TypeError("Cannot convert object to primitive value");
    }
    // WasmGC closure struct — dispatch via __call_fn_1 (#1090)
    if (typeof scExotic === "object" && _isWasmStruct(scExotic) && callbackState) {
      const exports = callbackState.getExports();
      if (exports) {
        const callFn1 = exports["__call_fn_1"];
        if (typeof callFn1 === "function") {
          const result = callFn1(scExotic, hint);
          if (result == null || typeof result !== "object") return result;
          throw new TypeError("Cannot convert object to primitive value");
        }
        const callFn0 = exports["__call_fn_0"];
        if (typeof callFn0 === "function") {
          const result = callFn0(scExotic);
          if (result == null || typeof result !== "object") return result;
          throw new TypeError("Cannot convert object to primitive value");
        }
      }
    }
    // Non-callable Symbol.toPrimitive
    throw new TypeError("Cannot convert object to primitive value");
  }

  // (#1716) A class that defines `[Symbol.toPrimitive]` as a *method* compiles
  // the method to a struct-method export `__call_@@toPrimitive`, but does NOT
  // populate the sidecar `Symbol.toPrimitive` slot — so neither the proxy
  // property read nor the sidecar check above finds it. `_toPrimitive` only
  // reaches its `__call_@@toPrimitive` dispatch when the sidecar slot is set, so
  // the method-shorthand shape was silently missed here (the residual the
  // property-key / arg paths hit). Probe the struct-method export directly,
  // mirroring §7.1.1 step 2 (exotic @@toPrimitive consulted before
  // valueOf/toString).
  if (_isWasmStruct(raw) && callbackState) {
    const exports = callbackState.getExports();
    const callTP = exports?.["__call_@@toPrimitive"];
    if (typeof callTP === "function") {
      try {
        const result = callTP(raw, hint);
        if (result == null || typeof result !== "object") return result;
        // Exotic @@toPrimitive returned an object → §7.1.1 step 5 TypeError.
        throw new TypeError("Cannot convert object to primitive value");
      } catch (e: any) {
        // Only a Wasm type-mismatch trap (wrong struct variant) is swallowed so
        // we can fall through to valueOf/toString; user throws + the TypeError
        // above propagate.
        if (!(e instanceof WebAssembly.RuntimeError)) throw e;
      }
    }
    // (#3481) An object LITERAL with a computed `[Symbol.toPrimitive]` key —
    // `{ [Symbol.toPrimitive]: function () { … } }` — is a THIRD shape, and it
    // was reaching none of the three probes above. Codegen stores the closure
    // in a struct FIELD whose wasm name is `@@toPrimitive` and emits only the
    // field accessor `__sget_@@toPrimitive`: there is no sidecar slot (the key
    // is physical, not dynamic), no host proxy (the struct arrives raw), and no
    // `__call_@@toPrimitive` wrapper (that export is produced for a *method*
    // body, #1716). So the walker fell through to the `"[object Object]"`
    // fallback at the end, which is why `{[Symbol.toPrimitive]: () => 2n} * 2n`
    // reported "Cannot mix BigInt and other types" — the host binop multiplied
    // a STRING by a BigInt. Probe the field accessor here, still at §7.1.1
    // step 2 (before OrdinaryToPrimitive), mirroring the `__sget_${mName}`
    // fallback the valueOf/toString loop below already relies on.
    const sgetTP = exports?.["__sget_@@toPrimitive"];
    if (typeof sgetTP === "function" && _hasOwnStructField(raw, "@@toPrimitive", exports)) {
      let slot: any = null;
      try {
        slot = sgetTP(raw);
      } catch (e: any) {
        // Shape-dispatch miss on an unrelated struct — not our field.
        if (!(e instanceof WebAssembly.RuntimeError)) throw e;
      }
      // §7.1.1 step 2a: an undefined/null exotic means OrdinaryToPrimitive.
      // `__sget_*` also answers null for "this shape has no such field", so the
      // two collapse onto the same (correct) fall-through.
      if (slot != null) {
        const prim = _callExoticToPrimitiveSlot(raw, slot, hint, exports);
        if (prim !== _PRIM_ABSENT) return prim;
      }
    }
  }

  // OrdinaryToPrimitive §7.1.1.1
  // Track whether any user-defined method was found AND invoked-but-returned-
  // a-non-primitive. Distinct from "no method found at all" — only the latter
  // triggers the WasmGC `"[object Object]"` fallback (#1319). The former
  // represents the spec violation in §7.1.1.1 step 6 and must throw TypeError
  // (#1253).
  let methodInvokedReturnedObject = false;
  const rawOpaque = obj === raw && _isWasmStruct(obj);
  const methodNames = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  for (const mName of methodNames) {
    // Check real JS property first (goes through proxy which may wrap closures)
    // Raw Wasm carriers use the sidecar/export fallbacks below. A genuine
    // host or proxy Get can run an accessor and must preserve its abrupt result.
    const fn = rawOpaque ? undefined : obj[mName];
    if (typeof fn === "function") {
      const result = fn.call(obj);
      if (result == null || typeof result !== "object") return result;
      methodInvokedReturnedObject = true;
      continue;
    }
    // WasmGC closure struct for valueOf/toString — dispatch via __call_fn_0 (#1090).
    // (#2679) Thread the RECEIVER as `this`: a compiled `valueOf(){…this…}` reads
    // `this` from `__current_this`, which `__call_fn_0` does NOT install — so the
    // method body saw the wrong `this`. `__call_fn_method_0(thisVal, closure)`
    // installs `thisVal` into `__current_this` before the call (and restores it),
    // matching §7.1.1.1 OrdinaryToPrimitive step 4.b `Call(method, O)`.
    if (fn != null && typeof fn === "object" && _isWasmStruct(fn) && callbackState) {
      const exports = callbackState.getExports();
      if (exports) {
        const callFnM0 = exports["__call_fn_method_0"];
        const callFn0 = exports["__call_fn_0"];
        if (typeof callFnM0 === "function") {
          try {
            const result = callFnM0(obj, fn);
            if (result == null || typeof result !== "object") return result;
            methodInvokedReturnedObject = true;
          } catch (e: any) {
            if (!(e instanceof WebAssembly.RuntimeError)) throw e;
          }
          continue;
        }
        if (typeof callFn0 === "function") {
          try {
            const result = callFn0(fn);
            if (result == null || typeof result !== "object") return result;
            methodInvokedReturnedObject = true;
          } catch (e: any) {
            if (!(e instanceof WebAssembly.RuntimeError)) throw e;
          }
          continue;
        }
      }
    }
    // Then sidecar
    const scFn = _sidecarGet(raw, mName);
    if (typeof scFn === "function") {
      const result = scFn.call(raw);
      if (result == null || typeof result !== "object") return result;
      methodInvokedReturnedObject = true;
      continue;
    }
    // WasmGC closure struct in sidecar (#1090)
    if (scFn != null && typeof scFn === "object" && _isWasmStruct(scFn) && callbackState) {
      const exports = callbackState.getExports();
      if (exports) {
        const callFn0 = exports["__call_fn_0"];
        if (typeof callFn0 === "function") {
          try {
            const result = callFn0(scFn);
            if (result == null || typeof result !== "object") return result;
            methodInvokedReturnedObject = true;
          } catch (e: any) {
            if (!(e instanceof WebAssembly.RuntimeError)) throw e;
          }
          continue;
        }
      }
    }
    // Then Wasm exports
    if (callbackState) {
      const exports = callbackState.getExports();
      if (exports) {
        const callFn = exports[`__call_${mName}`];
        if (typeof callFn === "function") {
          try {
            const result = callFn(raw);
            if (result == null || typeof result !== "object") return result;
            methodInvokedReturnedObject = true;
          } catch (e: any) {
            if (!(e instanceof WebAssembly.RuntimeError)) throw e;
          }
        }
        // (#1253) Fallback: when no `__call_${mName}` wrapper exists (small
        // structs without a method-shorthand body), use `__sget_${mName}`
        // to extract the closure from the struct field, then dispatch via
        // generic `__call_fn_0`. This catches the AC1b shape:
        //
        //   const o: any = {};
        //   o.valueOf = () => ({});
        //   o.toString = () => ({});
        //
        // where the closure lives in the struct field but no
        // `__call_valueOf` export was emitted. Without this, the loop
        // misses the closure entirely and silently returns
        // "[object Object]" on the WasmGC fallback below — bypassing the
        // §7.1.1.1 step 6 TypeError.
        const sget = exports[`__sget_${mName}`];
        const callFn0 = exports.__call_fn_0;
        if (typeof sget === "function" && typeof callFn0 === "function") {
          let field: any;
          try {
            field = sget(raw);
          } catch (e: any) {
            if (!(e instanceof WebAssembly.RuntimeError)) throw e;
          }
          if (field != null) {
            // Field may be a JS function (real V8 binding) or a WasmGC closure struct.
            if (typeof field === "function") {
              const result = field.call(raw);
              if (result == null || typeof result !== "object") return result;
              methodInvokedReturnedObject = true;
            } else if (typeof field === "object" && _isWasmStruct(field)) {
              try {
                const result = callFn0(field);
                if (result == null || typeof result !== "object") return result;
                methodInvokedReturnedObject = true;
              } catch (e: any) {
                if (!(e instanceof WebAssembly.RuntimeError)) throw e;
              }
            } else if (typeof field !== "object") {
              // Raw primitive in the struct field — that's the result.
              return field;
            }
          }
        }
      }
    }
  }
  // (#1319) WasmGC structs without any user-defined valueOf / toString /
  // Symbol.toPrimitive don't inherit Object.prototype.toString the way a
  // plain JS `{}` does, so they reach this fallback even though V8 would
  // produce "[object Object]" for an ordinary object in the same shape.
  // Mirror V8's default toString here instead of throwing — matches the
  // _toPrimitiveSync fallback at line ~477 and the spec behaviour you'd
  // observe by hand: `String({})` is "[object Object]", not a TypeError.
  //
  // (#1253) BUT — only when no user-defined method was found. If a method
  // WAS found and invoked but returned a non-primitive, that's the
  // spec-violation case in §7.1.1.1 step 6 → TypeError. Otherwise we
  // silently swallow the error and produce NaN, breaking
  // `+{ valueOf: () => ({}), toString: () => ({}) }` which the spec
  // requires to throw.
  const closureSource = compiledClosureNativeSource(raw, callbackState);
  if (closureSource !== undefined && !methodInvokedReturnedObject) return closureSource;
  if (_isWasmStruct(raw) && !methodInvokedReturnedObject) return "[object Object]";
  throw new TypeError("Cannot convert object to primitive value");
}

/** (#5225) `_decoderExportsFor` for the paths that thread a callback state. */
export function _crossModuleCallbackState<T extends MarshalExportSource | undefined>(obj: any, state: T): T {
  if (obj == null || typeof obj !== "object") return state;
  const owner = _crossModuleStructs.decoderFor(obj, state?.getExports());
  return owner === undefined ? state : (_crossModuleStructs.stateFor(owner) as T);
}
