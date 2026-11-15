// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Host runtime and instantiation helpers for `@loopdive/js2` (the `/runtime`
 * entry point).
 *
 * In the default JS-host (WasmGC) target a compiled binary needs an import
 * object wiring up strings, number boxing, and other host capabilities. This
 * module builds those imports ({@link buildImports},
 * {@link buildStringConstants}, {@link buildWasiPolyfill}) and offers one-call
 * instantiation helpers ({@link instantiateWasm},
 * {@link instantiateWasmStreaming}, {@link compileAndInstantiate}), plus
 * {@link wrapExports} for marshalling `Uint8Array` (and other TypedArray)
 * arguments and returns across the JS↔Wasm boundary.
 *
 * @module
 */
import { compileSource } from "./compiler.js";
import type { CompileResult, ImportDescriptor, ImportIntent, ImportPolicy } from "./index.js";
import { validateExportBoundaryPolicies } from "./boundary-policy.js";
import type { BoundaryValuePolicy, ExportBoundaryPolicy } from "./boundary-policy.js";
import { classifyHostImport } from "./host-import-policy.js";
import { resolveRegExpHostImport } from "./runtime/regexp-host-accelerator.js";
import * as intlAccel from "./runtime/intl-host-accelerator.js"; // (#6986)
import {
  createJavaScriptAdapterManifest,
  validateJavaScriptAdapterManifest,
  type JavaScriptAdapterManifestV1,
} from "./adapter-manifest.js";
import * as wsh from "./runtime/wasm-struct-host-semantics.js";
import { STRING_CONSTANTS16_NS } from "./string-surrogate.js";
import {
  _GeneratorState,
  _AsyncGeneratorState,
  _getGeneratorInstancePrototype,
  _getAsyncGeneratorInstancePrototype,
  _installIteratorHelperPolyfills,
  _resetIteratorRuntimeIntrinsicsForRealmIsolation,
} from "./runtime/iterator-polyfills.js";
import { buildStringConstants, buildStringConstants16 } from "./runtime/string-constants.js";
import { marshalExports, resolveInitExportImport, type MarshalExportSource } from "./runtime/init-marshal-registry.js"; // (#5193, #5202)
import { createLinkedProviderMirrorOwnership } from "./runtime/linked-provider-mirror-ownership.js";
import { createCrossModuleStructOwners } from "./runtime/cross-module-struct-owners.js";
import { linkedClosureDispatch } from "./runtime/linked-closure-dispatch.js";
import { rawExportsStructDecodeError } from "./runtime/raw-exports-struct-authority.js"; // (#6438)
import { wasmDateHostView } from "./runtime/date-host-method.js";
import { getWasmVecPrototypeMember as vecProtoGet, WASM_VEC_PROTOTYPE_MISS } from "./runtime/wasm-vec-prototype.js";
export { buildStringConstants, buildStringConstants16 };
export { _installIteratorHelperPolyfills, _resetIteratorRuntimeIntrinsicsForRealmIsolation };
// (#6492 r5 / #5967) The test262 worker primes the await-dictionary statics
// BEFORE its realm-canary snapshot, so the one-time install onto `Promise` is
// part of the baseline instead of drift that recycles the worker after every
// test (measured: 922 drift lines and 868 provider re-loads in one shard,
// aggregate compile time +345 % — merge-group run 35313398232).
export { _installPromiseKeyedCombinators } from "./runtime/promise-keyed-combinators.js";
import {
  compiledClosureNativeSource,
  installNativeFunctionSourceFacade,
  invokeNativeFunctionCallback,
  normalizeModuleCallbackException,
} from "./runtime/native-function-source.js";
import * as test262Host from "./runtime/test262-harness-host.js"; // (#4394)
import { ASYNC_CALLBACK_EXCEPTION_POLICY } from "./ir/async-runtime-providers.js";
import { vecForMirror, recordVecMirrorElements, vecMirrorElementsChanged } from "./runtime/vec-mirror-writeback.js"; // (#3603 S1) vec-mirror write-back; (#4531) mirror→vec mutation routing
import {
  arrayIndexForPropertyKey as _asArrayIndex,
  getOrCreateWasmStructSidecar,
  readWasmStructSidecar,
  wasmVecOwnKeys,
  wasmVecSidecarDescriptor,
  writeWasmStructSidecar,
  type WasmStructSidecarState,
} from "./runtime/wasm-struct-sidecar.js";
// (#5370) typed-array brand identity at the host boundary (inbound + `.constructor`)
import { COMPILED_TYPED_ARRAY_CTORS as _COMPILED_TYPED_ARRAY_CTORS } from "./runtime/typed-array-host-brand.js";
import * as dynamicCodePolicy from "./runtime/dynamic-code-policy.js"; // (#6779)
import { createBoundaryObjectAdapter } from "./runtime/boundary-object-adapter.js";
import { isNativeRegimeExports, readNativeRegimeBag } from "./runtime/native-regime-view.js"; // (#6879)
import { resolveProcessCapability } from "./runtime/process-capability.js"; // (#1490, #6910)
import { createBoundaryCallbackAdapter } from "./runtime/boundary-callback-adapter.js";
import { createBoundaryPromiseAdapter } from "./runtime/boundary-promise-adapter.js";
import {
  createCaughtExceptionImport,
  createHostAsyncCallbackMaker,
  createHostNumberBoxImport,
  createHostNumberUnboxImport,
} from "./runtime/host-async-imports.js";
import { createHostImportCallState } from "./runtime/host-import-call-state.js";
import {
  createBoundaryValueAdapter,
  isBoundaryValueImportIntent,
  withModuleTagThrow,
} from "./runtime/boundary-value-adapter.js";
import { createInstanceLifecycleAdapter } from "./runtime/instance-lifecycle-adapter.js";
import { installFreshDataStructAssociationToken } from "./runtime/exported-function-identity.js";
import { resolvePlatformCapabilityImport, wrapConsoleForHost } from "./runtime/console-host-marshal.js"; // (#6685)
import { closureBridges, declaredHostFunction, marshalPlatformArgs } from "./runtime/platform-arg-marshal.js"; // (#6708/#7095) regime carriers ↔ JS values
import {
  CLOCK_CAPABILITY_AUTHORITY,
  createCompiledDomCapabilityRuntime,
  prepareCompiledCapabilityAuthority,
  type CompiledCapabilityAuthorityOptions,
} from "./runtime/compiled-capability-authority.js";
import type { DomCapabilityRoot } from "./runtime/dom-capability-adapter.js";
import {
  createStandaloneTimerCallbackBridge,
  wrapStandaloneTimerCallback,
} from "./runtime/standalone-timer-callback-bridge.js";
import { installAmbientCompatibility } from "./runtime/compatibility-adapter.js";
import { resolveCompatibilitySemanticImport } from "./runtime/compatibility-semantic-adapter.js";
import { callResolvedClassPrimitive, createClassMemberResolver } from "./runtime/class-method-host-bridge.js";
import { scheduleNativeMicrotaskCheckpoint } from "./runtime/native-microtask-checkpoint.js"; // (#6982)
import { _makeLegacyRegExpState, type LegacyRegExpState } from "./runtime/legacy-regexp.js";
import { readEnv } from "./env.js";
import { getNodeRequire } from "./runtime/node-require.js";
import { resolveCryptoCapabilityImport } from "./runtime/crypto-capability.js";
import { resolveStringMemoryImport } from "./runtime/string-memory-adapter.js";
import { resolveExternClassImport } from "./runtime/extern-class-capability.js";
import {
  type DataStructHostBridgeAuthority,
  DATA_STRUCT_HOST_BRIDGE_TOKEN_VALUE,
  brandedInstanceExports,
  hasOwn,
  hostBridgeExportView,
} from "./runtime/host-bridge-authority.js";
import {
  _hostProxyCache,
  _hostProxyReverse,
  _MISS,
  _PRIM_ABSENT,
  _SC_ACCESSOR,
  _SC_CONFIGURABLE,
  _SC_DEFINED,
  _SC_ELEM_DEFAULT,
  _SC_ENUMERABLE,
  _SC_WRITABLE,
  _canBeWeakKey,
  _fnctorInstanceCtor,
  _getSidecar,
  _getSidecarDescs,
  _isWasmStruct,
  _isWasmVec,
  _nativeIsArray,
  _normalizeDescKey,
  _restoreF64Undefined,
  _sidecarDelete,
  _sidecarGet,
  _sidecarSet,
  _validatePropertyDescriptor,
  _wasmFrozenObjs,
  _wasmNonExtensibleObjs,
  _wasmPropDescs,
  _wasmSealedObjs,
  _wasmSidecars,
  _wasmStructAccessors,
  _wasmStructDeletedKeys,
  _wasmStructProps,
  _wasmStructProto,
  _wasmStructShadowedFields,
} from "./runtime/host-carrier-state.js";
import {
  _crossModuleStructs,
  _decoderExportsFor,
  _getStructFieldNames,
  _nativeStringToHost,
  _readOwnDescriptor,
  _structFieldNamesRaw,
  _structHasOwnFieldName,
  _structOwnFieldStatus,
  _wasmStructHasOwn,
} from "./runtime/struct-reflection.js";
import { _crossModuleCallbackState, _hostToPrimitive, _wasmDateToPrimitive } from "./runtime/host-to-primitive.js";
import { _marshalWasmDateForHost, _wasmToPlain } from "./runtime/host-plain-copy.js";
import { wrapWithDomContainment } from "./runtime/dom-containment.js";
export { buildWasiPolyfill } from "./runtime/wasi-polyfill.js";

/**
 * (#2739 b) Resolve a registered fnctor instance's user prototype object — the
 * ctor's vivified/assigned `.prototype` — or undefined when the instance is not
 * a registered fnctor instance or no prototype object was ever materialized.
 * Shared by `_fnctorProtoLookup` (property reads) and `_structUserProto` (the
 * for-in walk) so enumeration and [[Get]] resolve through ONE prototype source.
 */
function _fnctorCtorProto(obj: any, exports?: Record<string, Function> | undefined): any {
  if (!_canBeWeakKey(obj)) return undefined;
  const ctor = _fnctorInstanceCtor.get(obj);
  if (ctor == null) return undefined;
  let proto = _sidecarGet(ctor, "prototype");
  // (#3123) A top-level `F.prototype = <expr>` write may land in the closure
  // STRUCT's typed `prototype` field slot (the #2664 `__set_member_prototype`
  // dispatcher's struct arm) instead of the sidecar. Read the field through
  // the compiled `__sget_prototype` getter so the live prototype the compiled
  // side reads back is the SAME object the host walk starts from.
  if (proto === undefined && exports !== undefined && _isWasmStruct(ctor)) {
    const sgetProto = exports.__sget_prototype as ((v: any) => any) | undefined;
    if (typeof sgetProto === "function") {
      try {
        const v = sgetProto(ctor);
        if (v != null) proto = v;
      } catch {
        /* not a field of this struct shape */
      }
    }
  }
  if (proto == null || typeof proto !== "object") return undefined;
  return proto;
}

/** (#1712) Resolve a property through the instance's fnctor prototype chain. */
function _fnctorProtoLookup(
  obj: any,
  key: any,
  exports?: Record<string, Function> | undefined,
): PropertyDescriptor | undefined {
  const proto = _fnctorCtorProto(obj, exports);
  if (proto === undefined) return undefined;
  let cur: any = proto;
  let guard = 0;
  // (#6944) A cyclic user chain (aliased nested-ctor prototype) ends with `undefined`.
  const seen = new Set<any>();
  while (cur != null && typeof cur === "object" && guard++ < 16 && !seen.has(cur)) {
    seen.add(cur);
    // (#2680) Per ES §10.1.6.2 ToPropertyDescriptor → §7.3.12 HasProperty /
    // §7.3.3 Get (both prototype-inclusive), an inherited attribute must be
    // read. When an ancestor is itself a WasmGC struct (the common case:
    // `F.prototype = {…}` / a `new F()` proto literal compiles to a struct whose
    // attribute lives in its sidecar / typed field), native
    // Object.getOwnPropertyDescriptor sees an opaque null-proto object and drops
    // it. Use the wasmGC-aware, #1629-safe reader (_readOwnDescriptor: sidecar +
    // descriptor table + __sget_<key> gated on the concrete struct shape, NEVER
    // an __sget_* try/catch probe) at each such level; plain JS ancestors keep
    // the native reader.
    const desc = _isWasmStruct(cur) ? _readOwnDescriptor(cur, key, exports) : Object.getOwnPropertyDescriptor(cur, key);
    if (desc) return desc;
    // (#6944) A struct ancestor (`Derived.prototype = new Inheriter()`) has a null native
    // prototype; `_structUserProto` resolves its fnctor ctor link / setPrototypeOf record.
    cur = _structUserProto(cur, exports);
    if (cur === Object.prototype) break;
  }
  return undefined;
}

/**
 * (#2739) Resolve the user-intended [[Prototype]] of a value for the for-in
 * walk — the ONE prototype source for enumeration so it stays consistent with
 * member reads (§13.7.5.15 EnumerateObjectProperties walks [[GetPrototypeOf]]).
 * For an opaque WasmGC struct, native `Object.getPrototypeOf` is blind to the
 * user prototype, so consult the explicit `_wasmStructProto` link first
 * (setPrototypeOf / Reflect.setPrototypeOf / `__proto__` — the value may be
 * `null`, meaning "own keys only", which must stop the walk). Otherwise fall
 * back to the native `[[Prototype]]`.
 *
 * (#2739 b) The fnctor instance→ctor prototype link (`function F(){};
 * F.prototype = {…}; new F()`) IS consulted (after the explicit
 * `_wasmStructProto` record, which an explicit setPrototypeOf overrides) via
 * the SAME `_fnctorCtorProto` resolution `_fnctorProtoLookup` uses for reads —
 * so `for (k in new F())` enumerates inherited enumerable keys (`S12.6.4_A6*`)
 * exactly where `inst.k` resolves them. Note this also means #1712 acorn-style
 * `F.prototype.m = fn` methods enumerate on instances — which is spec-correct:
 * a plain prototype-method assignment creates an ENUMERABLE property.
 */
function _structUserProto(current: any, exports?: Record<string, Function> | undefined): any {
  if (_isWasmStruct(current) && _canBeWeakKey(current)) {
    if (_wasmStructProto.has(current)) {
      return _wasmStructProto.get(current);
    }
    const fnctorProto = _fnctorCtorProto(current, exports);
    if (fnctorProto !== undefined) return fnctorProto;
  }
  try {
    return Object.getPrototypeOf(current);
  } catch {
    return null;
  }
}

/**
 * (#1712) Read or auto-vivify the `.prototype` object of a Wasm closure
 * struct. Only closures (per the `__is_closure` export) vivify; everything
 * else returns undefined so plain structs keep `obj.prototype === undefined`.
 */
function _getOrVivifyFnPrototype(
  obj: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (!_isWasmStruct(obj)) return undefined;
  const existing = _sidecarGet(obj, "prototype");
  if (existing !== undefined) return existing;
  // (#4771) `f.prototype = undefined` writes a REAL slot value that reads back
  // as `undefined` — indistinguishable from "never written" by value alone.
  // Vivifying over it silently restored an object prototype, so §7.3.20 step 5
  // never saw the non-object the program installed. Presence, not value.
  if (_canBeWeakKey(obj)) {
    const sidecar = _wasmStructProps.get(obj);
    if (sidecar && "prototype" in sidecar) return undefined;
  }
  // Gate on `__is_closure` when exports are reachable. During the module
  // START function (where acorn's `Parser.prototype.m = fn` writes run)
  // `getExports()` is still undefined — WebAssembly.instantiate has not
  // returned yet — so fall back to the struct-only heuristic there. Post-
  // instantiation reads (e.g. test262 `({}).prototype === undefined`
  // checks) always have exports and keep the precise gate.
  const exports = callbackState?.getExports();
  const isClosureFn = exports?.__is_closure as ((v: any) => number) | undefined;
  if (typeof isClosureFn === "function") {
    try {
      if (isClosureFn(obj) !== 1) return undefined;
    } catch {
      return undefined;
    }
  }
  const proto: Record<string | symbol, any> = {};
  _sidecarSet(obj, "prototype", proto);
  return proto;
}

const _wasmClosureWrapperSource = new WeakMap<Function, { closure: any; arity: number }>();
const _wasmClosureDynamicWrapperCache = new WeakMap<object, Function>();
const _wasmClosureWrapperCache = new WeakMap<object, Map<number, Function>>();
const _wasmClosureWrapperTargets = new WeakMap<Function, object>();
closureBridges.configure(_wasmClosureWrapperSource, _wasmClosureWrapperTargets);

// Prevent callable-mirror property writes from recursing through their raw closure proxy.
// Keep internal Set bookkeeping safe from user-mutation of Set.prototype.add.
const _nativeSetAdd = Set.prototype.add;
const _closurePropertyMirrorActive = new WeakMap<object, Set<PropertyKey>>();
const _wasmAccessorGetterReturnWrappers = new WeakSet<Function>();
const _wasmGetterCallbackWrappers = new WeakSet<Function>();
// #3214 B2: cache reusable -1 void bridges; one-shot -2 closures intentionally bypass it.
const _wasmVoidHostCallbackCache = new WeakMap<object, Function>();
const _test262ErrorConstructors = new WeakSet<Function>();

_test262ErrorConstructors.add(test262Host.HostTest262Error);
// (#3369/#4758) Captured intrinsics keep callback ABI arrays independent of mutated prototypes.
const _IntrinsicArray = Array;
const _intrinsicReflectApply = Reflect.apply;
const _intrinsicReflectConstruct = Reflect.construct;
const _intrinsicReflectDefineProperty = Reflect.defineProperty;
function _defineDenseSlot(array: any[], index: number, value: any): void {
  _intrinsicReflectDefineProperty(array, index, { value, writable: true, enumerable: true, configurable: true });
}
function _denseOwnArgs(args: ArrayLike<any>, length: number): any[] {
  const dense = new _IntrinsicArray<any>(length);
  for (let i = 0; i < length; i++) _defineDenseSlot(dense, i, i < args.length ? args[i] : undefined);
  return dense;
}
// Compiled closure exports accept canonical Wasm values, not JS-facing proxy views.
function _denseOwnWasmArgs(args: ArrayLike<any>, length: number): any[] {
  const dense = _denseOwnArgs(args, length);
  for (let i = 0; i < length; i++) _defineDenseSlot(dense, i, _unwrapForHost(dense[i]));
  return dense;
}

// Build callback ABI arguments without Array iteration, then use captured Reflect.apply (#4758).
function _applyWithPrefix(fn: Function, thisArg: any, prefix: ArrayLike<any>, suffix: ArrayLike<any>): any {
  const args = new _IntrinsicArray<any>(prefix.length + suffix.length);
  for (let i = 0; i < prefix.length; i++) _defineDenseSlot(args, i, prefix[i]);
  for (let i = 0; i < suffix.length; i++) _defineDenseSlot(args, prefix.length + i, suffix[i]);
  return _intrinsicReflectApply(fn, thisArg, args);
}

/**
 * (#1382) Wrap a Wasm closure struct in a JS Function so it can be called
 * from JS host code (e.g. `Array.from(iter, mapFn)` where mapFn is a Wasm
 * closure rather than a real `function`).
 *
 * Wasm closure structs are externref-typed in JS but lack a `[[Call]]`
 * internal method, so `mapFn(value, index)` fails with "object is not a
 * function". The wrapper bridges by dispatching into Wasm via the
 * `__call_fn_<arity>` exports, which use funcref-type dispatch to invoke
 * the closure's lifted body.
 *
 * Returns `null` if the appropriate `__call_fn_<arity>` export isn't
 * available — caller falls back to the original (which will throw the
 * original "not a function" error). That keeps the failure mode visible
 * rather than silently swallowing it.
 *
 * Arity matches the number of JS args the host will pass; the JS wrapper
 * forwards exactly that count to `__call_fn_N`. Args beyond `arity` are
 * dropped, matching JS's "extra args ignored" semantics. If the wrapper is
 * invoked as a method, prefer `__call_fn_method_N` so prototype-installed
 * methods such as `Number.prototype[Symbol.iterator]` observe the receiver.
 */
function _wrapWasmClosure(
  closure: any,
  arity: number,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): ((...args: any[]) => any) | null {
  if (!callbackState) return null;
  // (#1712) Resolve the dispatcher exports at CALL time, not wrap time. The
  // module START function (where acorn-style `Object.defineProperties(
  // P.prototype, accessors)` runs) executes before WebAssembly.instantiate
  // returns, so `getExports()` is still undefined while the wrap happens —
  // an eager lookup silently dropped the wrapper and the accessor with it.
  // `callbackState` is a stable live object; by the time the wrapper is
  // actually invoked (post-instantiation), the exports are wired.
  if (callbackState.getExports() !== undefined) {
    const eager = callbackState.getExports()!;
    if (typeof eager[`__call_fn_${arity}`] !== "function") return null;
  }
  let byArity: Map<number, Function> | undefined;
  if (_canBeWeakKey(closure)) {
    byArity = _wasmClosureWrapperCache.get(closure as object);
    const cached = byArity?.get(arity);
    if (cached) return cached as (...args: any[]) => any;
  }
  // Closure parameter is captured by reference; the wrapper holds it alive
  // for as long as the JS Function is reachable from the host. JS Function
  // identity is preserved across multiple invocations (host may capture a
  // reference, e.g. callbacks stored on plain objects).
  //
  // (#1712 / #1320) Method-call `this` threading: when the wrapper is
  // invoked with a meaningful receiver — a Wasm struct (or its proxy, e.g.
  // `fn.apply(wrappedObj,…)` in `__extern_method_call` or a vivified fnctor
  // prototype method), or a plain JS object holder (#1320 iterator objects
  // whose `next` is a Wasm closure) — dispatch through
  // `__call_fn_method_<arity>` so the closure body's `ThisKeyword` (via the
  // `__current_this` global, #1636-S1) observes the receiver. Wasm-struct
  // proxies are unwrapped so the body sees the raw struct. Undefined /
  // globalThis receivers keep the plain `__call_fn_<arity>` path, so bare
  // callback invocations are byte-for-byte unchanged.
  const dispatch = function wasmClosureDispatch(this: any, ...args: any[]): any {
    const exports = callbackState.getExports();
    const callFn = exports?.[`__call_fn_${arity}`];
    if (typeof callFn !== "function") {
      throw new TypeError("wasm closure dispatcher __call_fn_" + arity + " is not available");
    }
    // Pad with undefined to exactly `arity` positional args. Extra args
    // dropped (JS spec for fewer/more args than declared params).
    const padded = _denseOwnWasmArgs(args, arity);
    if (this !== undefined && this !== globalThis) {
      // (#2838 L3) Method-`this` dispatch. Prefer the exact-arity method
      // dispatcher; when it is ABSENT, fall back to the HIGHEST available
      // `__call_fn_method_M` (M from 8 down to `arity`), padding the args to M.
      // The wasm method-dispatch arm hands each closure exactly its own declared
      // arity (extra positional args are dropped — emitClosureMethodCallExportN
      // in index.ts), so dispatching at a higher M still invokes THIS closure at
      // its real arity while threading `this` via `__current_this`. Without this
      // fallback, a getter/setter closure wrapped at fixed arity 0/1 whose exact
      // `__call_fn_method_${arity}` happens not to be emitted silently lost its
      // receiver (`this` inert) and fell back to the plain `__call_fn_${arity}`
      // path. This is the LAZY bridge (it resolves exports at call time), so it
      // is module-init-safe: `Object.defineProperties` runs before
      // `__setExports`, and the availability check happens only when the wrapped
      // accessor is actually invoked post-instantiation. Mirrors the dynamic
      // bridge's `methodMaxArity` logic (`_wrapWasmClosureUnknownArity`).
      let methodArity = -1;
      if (typeof exports?.[`__call_fn_method_${arity}`] === "function") {
        methodArity = arity;
      } else if (exports) {
        for (let a = 8; a >= arity; a--) {
          if (typeof exports[`__call_fn_method_${a}`] === "function") {
            methodArity = a;
            break;
          }
        }
      }
      if (methodArity >= 0) {
        const methodCallFn = exports![`__call_fn_method_${methodArity}`]!;
        const methodPadded = _denseOwnWasmArgs(args, methodArity);
        const rawThis = this !== null && typeof this === "object" ? _unwrapForHost(this) : this;
        const receiver = _isWasmStruct(rawThis) ? rawThis : this;
        // The ordinary method dispatcher intentionally consumes a pre-seeded
        // `__argc` when an in-Wasm dynamic caller widens an under-applied call.
        // A known-arity HOST callback has no such protocol state of its own:
        // calling the ordinary export directly lets it inherit the previous
        // callback's count (for example getter argc=0 immediately followed by
        // setter argc=1), so the setter's value is padded as `undefined`.
        // Enter through the reserved argc wrapper, exactly like the unknown-
        // arity bridge below, to make each host call self-contained and reset
        // the protocol slot before returning. Seed the SELECTED dispatcher
        // arity, not `args.length`: this known-arity path intentionally pads an
        // under-applied callback with real JS `undefined` values, whose normal
        // parameter coercion must still run inside the method dispatcher. The
        // unknown-arity path below is the one that preserves raw args.length.
        const argcCallFn = exports![`__\0js2_call_fn_method_argc_${methodArity}`];
        const ret =
          typeof argcCallFn === "function"
            ? _applyWithPrefix(argcCallFn, undefined, [methodArity, receiver, closure], methodPadded)
            : _applyWithPrefix(methodCallFn, undefined, [receiver, closure], methodPadded);
        return _wasmAccessorGetterReturnWrappers.has(wrapped)
          ? _maybeWrapAccessorGetterCallable(ret, callbackState)
          : ret;
      }
    }
    const ret = _applyWithPrefix(callFn, undefined, [closure], padded);
    return _wasmAccessorGetterReturnWrappers.has(wrapped) ? _maybeWrapAccessorGetterCallable(ret, callbackState) : ret;
  };
  const wrapped = function wasmClosureBridge(this: any, ...args: any[]): any {
    try {
      const result = _intrinsicReflectApply(dispatch, this, args);
      _drainNativePromiseBoundary(callbackState);
      return result;
    } catch (error) {
      throw normalizeModuleCallbackException(error, callbackState, ASYNC_CALLBACK_EXCEPTION_POLICY);
    }
  };
  installNativeFunctionSourceFacade(wrapped);
  _wasmClosureWrapperSource.set(wrapped, { closure, arity });
  wsh.recordCallableOwner(wrapped, callbackState);
  if (_canBeWeakKey(closure)) {
    if (!byArity) {
      byArity = new Map();
      _wasmClosureWrapperCache.set(closure as object, byArity);
    }
    byArity.set(arity, wrapped);
    _wasmClosureWrapperTargets.set(wrapped, closure as object);
    _linkedProviderMirrors.recordMirrorOwner(wrapped, callbackState?.getExports()); // (#5222)
  }
  return wrapped;
}

function _drainNativePromiseBoundary(
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
): void {
  const exports = callbackState?.getExports();
  const drain = exports?.__drain_microtasks as (() => void) | undefined;
  if (typeof exports?.__promise_boundary_observe !== "function" || typeof drain !== "function") return;
  const authority = _nativeBoundaryAuthority(exports);
  if (_nativePromiseBoundaryDraining.has(authority)) return;
  _nativePromiseBoundaryDraining.add(authority);
  try {
    drain();
  } finally {
    _nativePromiseBoundaryDraining.delete(authority);
  }
}

function _wrapWasmClosureUnknownArity(
  closure: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
  // (#4618) true = the class-ctor mirror's own construct/apply dispatch —
  // must get the RAW bridge, not the mirror (infinite recursion otherwise).
  rawDispatch = false,
  linkedPeer = false, // a per-module retry bridge (linked-closure-dispatch.ts): uncached, no retry of its own
): ((...args: any[]) => any) | null {
  if (closure != null && typeof closure === "object") {
    const cached = linkedPeer ? undefined : _wasmClosureDynamicWrapperCache.get(closure);
    if (cached) return cached as (...args: any[]) => any;
  }
  if (!callbackState) return null;
  // (#5203) During module init `getExports()` is undefined for the whole start
  // section, so this returned null and every init-window closure — notably a
  // STATIC method read off a class value (`JSBI.__clz30(t)`) — presented as a
  // non-callable raw struct ("clz is not a function"). Fall back to the
  // funcrefs the module registered on itself (#5193/#5202 channel), which now
  // carries the `__call_fn_*` family. Those are the SAME function objects the
  // export view yields later, so the snapshot captured below stays correct
  // once instantiation returns.
  const exports = marshalExports(callbackState);
  if (!exports) return null;
  let maxArity = -1;
  for (let arity = 0; arity <= 4; arity++) {
    if (typeof exports[`__call_fn_${arity}`] === "function") maxArity = arity;
  }
  if (maxArity < 0) return null;
  // (#2664) The highest available `__call_fn_method_N` dispatches EVERY closure
  // of arity ≤ N and passes each closure exactly its OWN declared arity (extra
  // args dropped at the wasm dispatch arm — emitClosureMethodCallExportN in
  // index.ts). So for a METHOD call we must dispatch at an arity ≥ the closure's
  // real arity, not at the JS caller's `args.length`: a method invoked with
  // FEWER args than its declared param count (acorn's `this.parseExpression()` —
  // 0 args, 2 params) was previously dispatched via `__call_fn_method_0`, which
  // OMITS the arity-2 closure and returns null → the method body never ran (the
  // acorn parse() deeper-wall hang). Pad the missing args with `undefined` (JS
  // missing-argument semantics). Compute the max method-dispatch arity once.
  let methodMaxArity = -1;
  for (let a = 8; a >= 0; a--) {
    if (typeof exports[`__call_fn_method_${a}`] === "function") {
      methodMaxArity = a;
      break;
    }
  }
  // (#2623 P-7 / B-1) The closure's REAL declared arity, resolved lazily via the
  // `__closure_arity` export (emitted alongside `__is_closure`). -2 = not yet
  // probed, -1 = unknown (no export / not a closure). Cached per wrapper — the
  // arity of a given closure struct never changes.
  let realArityCache = -2;
  /** The closure's declared formal count, or -1 when the module cannot say. */
  const declaredArity = (): number => {
    if (realArityCache === -2) {
      realArityCache = -1;
      const arityFn = exports.__closure_arity as ((v: any) => number) | undefined;
      if (typeof arityFn === "function") {
        try {
          const a = arityFn(closure);
          if (typeof a === "number" && a >= 0) realArityCache = a;
        } catch {
          realArityCache = -1;
        }
      }
    }
    return realArityCache;
  };
  const dispatch = function wasmClosureDynamicDispatch(this: any, ...args: any[]): any {
    // (#3051 Slice 3) Host-side [[Construct]] (`new bridge(...)` — e.g. V8's
    // `Construct(C_species, «rx, flags»)` in the RegExp @@split protocol): a
    // raw wasm-struct return must be marshalled to its host mirror so the
    // native consumer can read the constructed object. `new`-path only —
    // plain-call returns stay raw (marshalling generic call exits regressed
    // ~85 dstr files, #3123/#2835).
    const marshalObjectResult = new.target !== undefined;
    const marshalNew = (ret: any): any =>
      marshalObjectResult && ret != null && typeof ret === "object" && _isWasmStruct(ret)
        ? _wrapForHost(ret, callbackState?.getExports())
        : ret;
    // METHOD call (receiver-bound `o.m(...)` → `fn.apply(wrappedObj, …)`): dispatch
    // at an arity ≥ the closure's declared arity so the closure is still matched.
    // Each closure receives exactly its own declared formals at the wasm arm.
    if (methodMaxArity >= 0 && this !== undefined && this !== globalThis) {
      // (#2623 P-7 / B-1) Prefer dispatching at EXACTLY max(args.length,
      // realArity): the #820l argc/extras plumbing derives `arguments.length`
      // from the DISPATCHER arity, so padding to `methodMaxArity`
      // (indistinguishable from real undefined args) inflated the callee's
      // `arguments.length` (V8-native `.finally` invokes a patched `then` with
      // exactly 2 args; the wasm `then` observed 5 — the test262
      // `finally/invokes-then-with-*` assert-#3 failure). Falls back to the
      // historical max-arity dispatch when the module has no `__closure_arity`
      // export or the exact-arity dispatcher isn't emitted — never dispatches
      // BELOW the closure's declared arity (the #2664 acorn omission hazard).
      let dispatchArity = methodMaxArity;
      const methodRealArity = declaredArity();
      if (methodRealArity >= 0) {
        const exact = Math.max(args.length, methodRealArity);
        if (exact < methodMaxArity && typeof exports[`__call_fn_method_${exact}`] === "function") {
          dispatchArity = exact;
        }
      }
      const methodCallFn = exports[`__call_fn_method_${dispatchArity}`];
      if (typeof methodCallFn === "function") {
        const padded = _denseOwnWasmArgs(args, dispatchArity);
        // (#2015) Unwrap a `_wrapForHost` proxy receiver back to its raw WasmGC
        // struct before installing it as `__current_this`. `__extern_method_call`
        // dispatches `fn.apply(wrappedObj, …)` with `wrappedObj` being the host
        // proxy, so without this unwrap `__call_fn_method_N` would install the
        // opaque Proxy as `__current_this`; the object-literal method trampoline's
        // `ref.test (ref objStruct)` then fails and the body's `this.<field>` traps.
        // Mirrors the known-arity bridge in `_wrapWasmClosure` (#1712 / #1320).
        const rawThis = this !== null && typeof this === "object" ? _unwrapForHost(this) : this;
        const receiver = _isWasmStruct(rawThis) ? rawThis : this;
        const argcCallFn = exports[`__\0js2_call_fn_method_argc_${dispatchArity}`];
        if (linkedClosureDispatch.isRepeat(closure, exports, `m${dispatchArity}`, receiver)) return undefined;
        return marshalNew(
          typeof argcCallFn === "function"
            ? _applyWithPrefix(argcCallFn, undefined, [args.length, receiver, closure], padded)
            : _applyWithPrefix(methodCallFn, undefined, [receiver, closure], padded),
        );
      }
    }
    // Free-function / extracted-method (`const f = o.m; f()`) path: dispatch by the
    // caller's arg count so unbound-`this` + low-arity generator semantics hold
    // (a 0-arg generator invoked via `__call_fn_1` yields a non-iterator).
    let arity = Math.min(args.length, maxArity);
    // (#6491) UNDER-APPLICATION must still run the body. `__call_fn_N` matches
    // only closures whose declared arity is N (the #2664 omission the METHOD
    // arm above already handles), so a 0-arg call of a 1-param closure selected
    // `__call_fn_0`, matched nothing, and returned `undefined` — the body never
    // ran, default parameters never evaluated, and a throw the callee owed its
    // caller never happened. In-module that call is compiled in Wasm and never
    // reaches this bridge, so the divergence is invisible until a caller and a
    // callee live in DIFFERENT modules: the #3451 linked test262 lane, where the
    // harness calls the test body's functions. Measured there: every
    // `assert.throws(SyntaxError, f)` over an under-applied `f` scored "no
    // exception was thrown at all" (14 `language/eval-code/direct` rows).
    // Widen to the closure's own declared arity — never ABOVE it, so the
    // low-arity generator rule the comment above states is untouched — and let
    // `_denseOwnWasmArgs` pad the missing positions with real `undefined`.
    // A widened call must still present the REAL argument count, because
    // `arguments.length` is observable and a guard may be reading it:
    // `test/harness/verifyProperty-arguments.js` asserts that
    // `verifyProperty()` with 0 arguments throws. So enter through the
    // `__\0js2_call_fn_argc_N` wrapper (the free-function twin of the method
    // family's argc wrapper), which seeds the count and clears it again. A
    // module compiled before that wrapper existed keeps the plain dispatch.
    let widenedFrom = -1;
    const freeRealArity = declaredArity();
    if (freeRealArity > args.length) {
      const widened = Math.min(freeRealArity, maxArity);
      if (widened > arity && typeof exports[`__call_fn_${widened}`] === "function") {
        widenedFrom = args.length;
        arity = widened;
      }
    }
    while (arity > 0 && typeof exports[`__call_fn_${arity}`] !== "function") arity--;
    const callFn = exports[`__call_fn_${arity}`];
    if (typeof callFn !== "function") return undefined;
    const padded = _denseOwnWasmArgs(args, arity);
    if (linkedClosureDispatch.isRepeat(closure, exports, `f${arity}`, undefined)) return undefined;
    if (widenedFrom >= 0) {
      const argcCallFn = exports[`__\0js2_call_fn_argc_${arity}`];
      if (typeof argcCallFn === "function") {
        return marshalNew(_applyWithPrefix(argcCallFn, undefined, [widenedFrom, closure], padded));
      }
    }
    return marshalNew(_applyWithPrefix(callFn, undefined, [closure], padded));
  };
  const wrapped = function wasmClosureDynamicBridge(this: any, ...args: any[]): any {
    try {
      const via = linkedPeer ? dispatch : linkedClosureDispatch.routed(closure, exports, dispatch, rawDispatch);
      const result =
        new.target === undefined
          ? _intrinsicReflectApply(via, this, args)
          : _intrinsicReflectConstruct(via, args, new.target);
      _drainNativePromiseBoundary(callbackState);
      return result;
    } catch (error) {
      throw normalizeModuleCallbackException(error, callbackState, ASYNC_CALLBACK_EXCEPTION_POLICY);
    }
  };
  // (#3429) Surface the closure's real declared `.name`/`.length` (codegen's
  // sidecar stamp) on the bridge, mirroring the same stamp in
  // `_wrapCallableForHost` (used when a closure "carries own props"). Without
  // this, a compiled function value crossing to host code as a first-class
  // value (e.g. a user-defined error constructor passed as
  // `assert.throws(Test262Error, fn)`) presents `.name ===
  // "wasmClosureDynamicBridge"` (the bridge's own literal function name)
  // instead of the wrapped closure's real name — corrupting any host-side
  // constructor-identity / `.name` read (assert.throws' message construction,
  // `err.constructor.name`, etc). Best-effort: absent metadata leaves the
  // bridge's default name untouched.
  if (closure != null && typeof closure === "object") {
    const meta = _wasmStructProps.get(closure);
    if (meta) {
      if (typeof meta.name === "string") {
        try {
          Object.defineProperty(wrapped, "name", { value: meta.name, configurable: true });
        } catch {
          /* Function.name redefinition is best-effort. */
        }
      }
      if (typeof meta.length === "number") {
        try {
          Object.defineProperty(wrapped, "length", { value: meta.length, configurable: true });
        } catch {
          /* Function.length redefinition is best-effort. */
        }
      }
    }
  }
  try {
    if (wrapped.prototype && closure != null) {
      Object.defineProperty(wrapped.prototype, "constructor", {
        value: closure,
        writable: true,
        enumerable: false,
        configurable: true,
      });
    }
  } catch {
    /* best-effort constructor identity for function-expression wrappers */
  }
  installNativeFunctionSourceFacade(wrapped);
  _wasmClosureWrapperSource.set(wrapped, { closure, arity: -1 });
  wsh.recordCallableOwner(wrapped, callbackState);
  if (closure != null && typeof closure === "object") {
    if (!linkedPeer) _wasmClosureDynamicWrapperCache.set(closure, wrapped);
    _wasmClosureWrapperTargets.set(wrapped, closure);
    _linkedProviderMirrors.recordMirrorOwner(wrapped, callbackState?.getExports()); // (#5222)
    // (#4618) Surface the closure's OWN sidecar props on the bridge as live
    // non-enumerable accessors (jest's mock fn: `.mock` / `.mockRestore` /
    // `.mockImplementation`). Without this, a spy stored on a host object
    // (`spyOn(console,'log')`) read back through the generic member
    // dispatcher answered undefined for every prop and the mock protocol
    // threw. Reads delegate live to the sidecar, so later reassignments
    // (`mockImplementation`) stay visible; keys added AFTER bridge creation
    // are not mirrored (the jest shim assigns all protocol keys up front).
    // Scoped to the jest mock PROTOCOL shape (a sidecar carrying `mock`) —
    // stamping every prop-carrying closure was measured to break acorn
    // wholesale (its parser closures rely on the propless bridge surface).
    const sidecarProps0 = _wasmStructProps.get(closure);
    const sidecarProps =
      sidecarProps0 && Object.prototype.hasOwnProperty.call(sidecarProps0, "mock") ? sidecarProps0 : undefined;
    if (sidecarProps) {
      for (const k of Object.keys(sidecarProps)) {
        if (k === "name" || k === "length" || k === "prototype") continue;
        if (Object.prototype.hasOwnProperty.call(wrapped, k)) continue;
        try {
          Object.defineProperty(wrapped, k, {
            get: () => {
              const sv = _sidecarGet(closure, k);
              if (sv !== null && typeof sv === "object" && _isWasmStruct(sv)) {
                const callable = _maybeWrapCallableUnknownArity(sv, callbackState);
                if (callable !== sv) return callable;
                return _wrapForHost(sv, callbackState?.getExports());
              }
              return sv;
            },
            set: (nv) => {
              _sidecarSet(closure, k, nv);
            },
            enumerable: false,
            configurable: true,
          });
        } catch {
          /* best-effort — a frozen wrapper keeps the propless behavior */
        }
      }
    }
  }
  return wrapped;
}

function _maybeWrapCallable(
  val: any,
  arity: number,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (val == null) return val;
  if (typeof val === "function") return val;
  if (typeof val === "object" && callbackState) {
    const exports = callbackState.getExports();
    const isClosureFn = exports?.__is_closure as ((v: any) => number) | undefined;
    if (typeof isClosureFn === "function") {
      try {
        if (isClosureFn(val) === 1) {
          const wrapped = _wrapWasmClosure(val, arity, callbackState);
          return wrapped ?? val;
        }
        // The exact runtime classifier is authoritative. Falling through to
        // the opaque-struct heuristic would turn an ordinary data struct into
        // a callable merely because it is an object.
        return val;
      } catch {
        // Fall through to the older opaque-struct heuristic below.
      }
    }
  }
  if (!_isWasmStruct(val)) return val;
  const wrapped = _wrapWasmClosure(val, arity, callbackState);
  return wrapped ?? val;
}

function _wrapVoidHostCallback(
  closure: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
  preserveIdentity = true,
): any {
  if (!_canBeWeakKey(closure)) return closure;
  if (preserveIdentity) {
    const cached = _wasmVoidHostCallbackCache.get(closure as object);
    if (cached) return cached;
  }
  let wrapped: (...args: any[]) => void;
  if (typeof closure === "object" && callbackState) {
    // The -1 callback-maker sentinel is emitted only for a TypedAST-certified
    // zero-argument void IR closure. Dispatch that exact carrier directly:
    // routing it through `_maybeWrapCallable` first allocated a generic
    // closure wrapper, an arity Map, and then this second void wrapper for
    // every DOM listener. Resolve exports at call time so callbacks created
    // during Wasm start retain the established lazy-wiring contract.
    wrapped = (..._args: any[]): void => {
      const callFn = callbackState.getExports()?.__call_fn_0;
      if (typeof callFn !== "function") {
        throw new TypeError("wasm closure dispatcher __call_fn_0 is not available");
      }
      try {
        callFn(closure);
      } catch (error) {
        throw normalizeModuleCallbackException(error, callbackState, ASYNC_CALLBACK_EXCEPTION_POLICY);
      }
    };
  } else {
    const dispatch = _maybeWrapCallable(closure, 0, callbackState);
    if (typeof dispatch !== "function") return dispatch;
    // Arrow functions have no [[Construct]], matching the source arrow. The
    // block intentionally discards the dispatcher's result so a `void`
    // callback observes JavaScript `undefined`.
    wrapped = (..._args: any[]): void => {
      dispatch();
    };
  }
  installNativeFunctionSourceFacade(wrapped);
  if (preserveIdentity) _wasmVoidHostCallbackCache.set(closure as object, wrapped);
  // Certified void callbacks never need generic wrapper/raw equality
  // canonicalization. The reusable -1 ABI keeps only its dedicated identity
  // cache; the compiler-owned one-shot -2 ABI avoids both WeakMap operations.
  return wrapped;
}

/**
 * (#860) Wrap a Wasm closure stored as a property value so JS callers can
 * invoke it. Unlike `_maybeWrapCallable`, the arity is not known from
 * context — a value-typed property doesn't say how the host will eventually
 * call it. We use `__is_closure` plus the highest available dispatcher.
 *
 * The `__call_fn_N` dispatcher (emitClosureCallExportN in codegen) iterates
 * closures of arity ≤ N; lower-arity closures see their extra args dropped
 * at the wasm-side dispatch arm. So wrapping with the max arity is safe and
 * forwards a reasonable arg count for any caller.
 *
 * Returns unchanged when it is not a closure or no callback/export is available.
 */
function _maybeWrapCallableUnknownArity(
  val: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (val == null) return val;
  if (typeof val === "function") return val;
  if (typeof val !== "object") return val;
  if (!callbackState) return val;
  // (#5203) Same init-window fallback as `_wrapWasmClosureUnknownArity` — the
  // `__is_closure` discriminator this needs is an export too.
  const exports = marshalExports(callbackState);
  if (!exports) return val;
  const isClosureFn = exports.__is_closure as ((v: any) => number) | undefined;
  if (typeof isClosureFn !== "function") return val;
  try {
    if (isClosureFn(val) !== 1) return val;
  } catch {
    return val;
  }
  if (wsh.hasUserCallableSidecarProps(_wasmStructProps.get(val), _wasmStructAccessors.has(val)))
    return _wrapCallableForHost(val, callbackState) ?? val;
  return _wrapWasmClosureUnknownArity(val, callbackState) ?? val;
}

export function wrapLinkedProviderValue(value: any, providerExports: Record<string, Function>): any {
  // (#5222) Mark this module's exports as a linked-provider set BEFORE any
  // mirror is minted, so every mirror created underneath — including the nested
  // ones the proxy's get-trap mints lazily — is recognisable as foreign when the
  // CONSUMER module later reads through it.
  registerLinkedProviderModule(providerExports);
  if (value == null || (typeof value !== "object" && typeof value !== "function")) return value;
  const callable = _maybeWrapCallableUnknownArity(value, { getExports: () => providerExports });
  return callable !== value ? callable : _wrapForHost(value, providerExports);
}

function _maybeWrapAccessorGetterCallable(
  val: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  // Accessor-returned rest closures can share a signature wrapper with an
  // ordinary vec-parameter closure. Until that accessor-specific classifier
  // is allocation-exact, keep its conservative no-wrap behavior; ordinary
  // property/export bridges use the rest-packing dispatchers directly.
  if (val != null && typeof val === "object" && callbackState) {
    const hasRest = callbackState.getExports()?.__closure_has_rest as ((v: any) => number) | undefined;
    if (typeof hasRest === "function" && hasRest(val) === 1) return val;
  }
  return _maybeWrapCallableUnknownArity(val, callbackState);
}

function _invokeGetterCallbackBridge(
  bridge: (...args: any[]) => any,
  id: number,
  cap: any,
  self: any,
  args: readonly any[],
  callbackState?: {
    getExports: () => Record<string, Function> | undefined;
    deferToExports?: (fn: () => void) => void;
  },
): any {
  const exports = callbackState?.getExports();
  const ret = invokeNativeFunctionCallback(id, cap, [self, ...args], callbackState, ASYNC_CALLBACK_EXCEPTION_POLICY);
  // (#3051 Slice 3) Marshal DATA-struct/vec getter returns to their host
  // mirror. Closures and setter returns pass through unchanged.
  if (args.length === 0 && ret != null && typeof ret === "object" && _isWasmStruct(ret)) {
    try {
      const isData = exports?.__is_data_struct as unknown as ((v: any) => number) | undefined;
      if (typeof isData === "function" && isData(ret) === 1) return _wrapForHost(ret, exports);
      const isVec = exports?.__is_vec as unknown as ((v: any) => number) | undefined;
      if (typeof isVec === "function" && isVec(ret) === 1) return _wrapForHost(ret, exports);
    } catch {
      /* discriminators unavailable — keep the raw return */
    }
  }
  return _wasmAccessorGetterReturnWrappers.has(bridge) ? _maybeWrapAccessorGetterCallable(ret, callbackState) : ret;
}

/**
 * (#3051) Wrap a callable stored as `regexp.exec` so its RETURN value — the
 * match result object the RegExp protocol reads — is exposed to the native
 * engine via `_wrapForHost`. The user overrides `exec` with a compiled
 * function that returns a plain object literal (`{0: '…', index: {valueOf…},
 * length: …, groups: …}`). Compiled object literals are opaque WasmGC structs;
 * when V8's `RegExp.prototype[@@replace]` / `[@@split]` / `[@@match]` /
 * `[@@search]` protocol does `Get(result, "0" | "index" | "length" | "groups")`
 * on that struct it reads `undefined`, and the spec-mandated `ToString` /
 * `ToIntegerOrInfinity` / `ToLength` coercions (including nested `valueOf` /
 * `toString` on capture / index sub-objects) never run. Routing the return
 * through `_wrapForHost` presents the struct as a host proxy whose get-trap
 * surfaces the numeric / named fields and wraps nested closures, so the native
 * protocol's Get + ToXxx chain observes the right values. Arrays and non-struct
 * returns pass through unchanged (`_wrapForHost` is a no-op on them).
 */
function _wrapExecReturnForHost(
  fn: (...args: any[]) => any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): (...args: any[]) => any {
  return installNativeFunctionSourceFacade(function execReturnBridge(this: any, ...args: any[]): any {
    const ret = fn.apply(this, args);
    if (ret != null && typeof ret === "object" && _isWasmStruct(ret)) {
      return _wrapForHost(ret, callbackState?.getExports());
    }
    return ret;
  });
}

/**
 * (#2742) Mark an accessor GETTER bridge so a compiled-closure RETURN value is
 * bridged into a callable JS function before the host sees it.
 *
 * `get valueOf() { return function () { … }; }` compiles the inner function to a
 * WasmGC closure struct. The getter itself is already bridged (so V8 can invoke
 * it), but its return value crossed back raw — so V8 observed
 * `typeof o.valueOf === "object"`, i.e. NOT callable. In `OrdinaryToPrimitive`
 * (§7.1.1.1 step 5b `IsCallable(method)`) that silently skips the method, and
 * with `toString` also non-callable the algorithm falls through to step 6 and
 * throws "Cannot convert object to primitive value" — the observed failure for
 * the `String.prototype.trim{Start,End}` `this`-value method-priority tests.
 *
 * Deliberately narrow: only a bridge OWNED by `_wrapWasmClosure` or the
 * getter-callback maker can be marked, and only non-rest values that
 * `__is_closure` positively identifies are converted.
 * The existing cached bridge must itself remain the descriptor's `get`: adding
 * an outer return wrapper changes observable getter identity and makes a
 * SameValue redefinition of a non-configurable accessor throw. Marshalling
 * generic call exits was tried and reverted for regressing ~85 dstr files
 * (#3123/#2835), so the marker is consumed only inside the accessor bridge.
 */
function _markAccessorGetterReturn(getterFn: any): any {
  if (typeof getterFn !== "function") return getterFn;
  if (_wasmClosureWrapperSource.has(getterFn) || _wasmGetterCallbackWrappers.has(getterFn)) {
    _wasmAccessorGetterReturnWrappers.add(getterFn);
  }
  return getterFn;
}

// Keep native consumers of cached callable bridges in sync with raw-closure sidecar writes.
function _mirrorClosurePropertyToHostBridges(
  closure: any,
  key: PropertyKey,
  val: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): void {
  if (closure == null || typeof closure !== "object") return;
  let active = _closurePropertyMirrorActive.get(closure);
  if (!active) _closurePropertyMirrorActive.set(closure, (active = new Set<PropertyKey>()));
  if (active.has(key)) return;
  _nativeSetAdd.call(active, key);
  try {
    const bridges = new Set<Function>();
    const dynamic = _wasmClosureDynamicWrapperCache.get(closure);
    if (typeof dynamic === "function") _nativeSetAdd.call(bridges, dynamic);
    const known = _wasmClosureWrapperCache.get(closure);
    if (known) for (const bridge of known.values()) _nativeSetAdd.call(bridges, bridge);
    const callable = _hostCallableCache.get(closure);
    if (typeof callable === "function") _nativeSetAdd.call(bridges, callable);
    if (bridges.size === 0) return;
    const hostValue = _maybeWrapCallableUnknownArity(val, callbackState);
    for (const bridge of bridges) {
      try {
        Reflect.set(bridge, key, hostValue, bridge);
      } catch {}
    }
  } finally {
    active.delete(key);
    if (active.size === 0) _closurePropertyMirrorActive.delete(closure);
  }
}

function _toPrimitive(
  obj: any,
  hint: "number" | "string" | "default",
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  // Unwrap host proxy to raw WasmGC struct for sidecar lookups (#1090).
  // Proxies are created by _wrapForHost and _hostProxyReverse maps them back.
  const raw = _hostProxyReverse.get(obj) ?? obj;
  // (#5374) Every probe below — `__sget_valueOf`, `__call_fn_method_0`,
  // `__call_@@toPrimitive` — is an export of ONE module. See the note on the
  // same redirect in `_hostToPrimitive` for why the whole walker is retargeted
  // once, here, rather than per probe.
  callbackState = _crossModuleCallbackState(raw, callbackState);
  // (#4616, cookie Expires family) The compiler-owned WasmGC Date carrier —
  // see _wasmDateToPrimitive.
  {
    const dateMs = _wasmDateToPrimitive(raw, hint, callbackState);
    if (dateMs !== _MISS) return dateMs;
  }
  // 1. Check Symbol.toPrimitive (sidecar and real symbol)
  // Note: user-thrown errors from sidecar methods must propagate per spec
  // (#983) — tests rely on `assert.throws` seeing the original throw.
  const scToPrim = _sidecarGet(raw, Symbol.toPrimitive);
  if (scToPrim !== undefined && scToPrim !== null) {
    if (typeof scToPrim === "function") {
      const prim = scToPrim.call(raw, hint);
      if (prim == null || typeof prim !== "object") return prim;
      throw new TypeError("Cannot convert object to primitive value");
    }
    // WasmGC closure struct — dispatch via __call_fn_1 (Symbol.toPrimitive takes hint arg) (#1090).
    // (#2679) `@@toPrimitive` is called as a method on the receiver (§7.1.1 step
    // 2: `Call(exoticToPrim, input, «hint»)`), so thread `raw` as `this` via the
    // `__call_fn_method_*` callers; fall back to the receiver-less callers.
    if (typeof scToPrim === "object" && _isWasmStruct(scToPrim)) {
      const exps = callbackState?.getExports();
      // Try 1-arg method caller first (toPrimitive(hint) with `this`=raw)
      const callFnM1 = exps?.["__call_fn_method_1"];
      if (typeof callFnM1 === "function") {
        try {
          const prim = callFnM1(raw, scToPrim, hint);
          if (prim == null || typeof prim !== "object") return prim;
          throw new TypeError("Cannot convert object to primitive value");
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
      const callFn1 = exps?.["__call_fn_1"];
      if (typeof callFn1 === "function") {
        try {
          const prim = callFn1(scToPrim, hint);
          if (prim == null || typeof prim !== "object") return prim;
          throw new TypeError("Cannot convert object to primitive value");
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
      // Try 0-arg method caller (closure might ignore hint; `this`=raw)
      const callFnM0 = exps?.["__call_fn_method_0"];
      if (typeof callFnM0 === "function") {
        try {
          const prim = callFnM0(raw, scToPrim);
          if (prim == null || typeof prim !== "object") return prim;
          throw new TypeError("Cannot convert object to primitive value");
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
      const callFn0 = exps?.["__call_fn_0"];
      if (typeof callFn0 === "function") {
        try {
          const prim = callFn0(scToPrim);
          if (prim == null || typeof prim !== "object") return prim;
          throw new TypeError("Cannot convert object to primitive value");
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
      // Try __call_@@toPrimitive (struct method dispatch)
      const callTP = exps?.["__call_@@toPrimitive"];
      if (typeof callTP === "function") {
        try {
          const prim = callTP(raw);
          if (prim == null || typeof prim !== "object") return prim;
          throw new TypeError("Cannot convert object to primitive value");
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
      // Closure is a WasmGC struct but not dispatchable — treated as callable
      // (it was compiled from a function expression). Fall through to valueOf/toString.
    }
    // §7.1.1 step 2d: non-callable @@toPrimitive → TypeError (#1090)
    throw new TypeError("Cannot convert object to primitive value");
  }

  const exports = callbackState?.getExports();

  // Helper: try valueOf or toString from sidecar then Wasm exports.
  // Returns the produced primitive (including a real `undefined`!) or the
  // `_PRIM_ABSENT` sentinel when the method is absent, returned an Object, or
  // dispatch trapped — only then should the caller consult the next method
  // (§7.1.1.1 steps 5-6, #1826).
  const tryMethod = (name: string): any => {
    // Sidecar property (set via __extern_set)
    // User-thrown errors propagate — spec requires assert.throws to observe them.
    const scFn = _sidecarGet(raw, name);
    if (typeof scFn === "function") {
      const prim = scFn.call(raw);
      if (prim == null || typeof prim !== "object") return prim;
      // Returned an object — not a valid primitive, try next method
      return _PRIM_ABSENT;
    }
    // Sidecar value is a WasmGC closure struct — dispatch via generic callers (#1090).
    // (#2679) Thread the RECEIVER as `this` (`__call_fn_method_0`), so a compiled
    // `valueOf(){…this…}` sees the original object, not a stale __current_this.
    if (scFn != null && typeof scFn === "object" && _isWasmStruct(scFn) && exports) {
      const callFnM0 = exports["__call_fn_method_0"];
      if (typeof callFnM0 === "function") {
        try {
          const prim = callFnM0(raw, scFn);
          if (prim == null || typeof prim !== "object") return prim;
          return _PRIM_ABSENT; // returned an object — not valid
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
      // Try zero-arg caller (valueOf/toString are typically zero-arg)
      const callFn0 = exports["__call_fn_0"];
      if (typeof callFn0 === "function") {
        try {
          const prim = callFn0(scFn);
          if (prim == null || typeof prim !== "object") return prim;
          return _PRIM_ABSENT; // returned an object — not valid
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
      // Fall back to struct method dispatch
      const callFn = exports[`__call_${name}`];
      if (typeof callFn === "function") {
        try {
          const prim = callFn(raw);
          if (prim == null || typeof prim !== "object") return prim;
          return _PRIM_ABSENT;
        } catch (e: any) {
          if (!(e instanceof WebAssembly.RuntimeError)) throw e;
        }
      }
    }
    // Wasm-exported struct field getter (__sget_valueOf, __sget_toString)
    // Only Wasm RuntimeError (type-mismatch trap) is swallowed; user-thrown
    // errors from the invoked closure body must propagate (#983).
    if (exports) {
      const sget = exports[`__sget_${name}`];
      if (typeof sget === "function") {
        let field: any;
        try {
          field = sget(raw);
        } catch (e: any) {
          if (e instanceof WebAssembly.RuntimeError) return _PRIM_ABSENT;
          throw e;
        }
        if (typeof field === "function") {
          const prim = field.call(raw);
          if (prim == null || typeof prim !== "object") return prim;
        } else if (field != null && typeof field !== "object") {
          return field;
        }
        if (field != null && typeof field === "object" && _isWasmStruct(field)) {
          // Try named caller first (e.g. __call_valueOf)
          const callFn = exports[`__call_${name}`];
          if (typeof callFn === "function") {
            try {
              const prim = callFn(raw);
              if (prim == null || typeof prim !== "object") return prim;
            } catch (e: any) {
              if (!(e instanceof WebAssembly.RuntimeError)) throw e;
              /* ref.test/call dispatch failed — try generic caller */
            }
          }
          // Generic closure caller fallback (#1090) — handles any WasmGC closure
          // struct. (#2679) Thread `raw` as `this` via `__call_fn_method_0`.
          const callFnM0 = exports["__call_fn_method_0"];
          if (typeof callFnM0 === "function") {
            try {
              const prim = callFnM0(raw, field);
              if (prim == null || typeof prim !== "object") return prim;
            } catch (e: any) {
              if (!(e instanceof WebAssembly.RuntimeError)) throw e;
            }
          }
          const callFn0 = exports["__call_fn_0"];
          if (typeof callFn0 === "function") {
            try {
              const prim = callFn0(field);
              if (prim == null || typeof prim !== "object") return prim;
            } catch (e: any) {
              if (!(e instanceof WebAssembly.RuntimeError)) throw e;
            }
          }
        }
      }
    }
    if (exports) {
      const prim = callResolvedClassPrimitive(_resolveClassMember, raw, name, exports, _MISS);
      if (prim !== _MISS) {
        if (prim == null || typeof prim !== "object") return prim;
        return _PRIM_ABSENT;
      }
    }
    return _PRIM_ABSENT;
  };

  // Per JS spec: "string" hint -> toString first; "number"/"default" -> valueOf first.
  // A method that produces ANY primitive (including `undefined`) is the result;
  // only `_PRIM_ABSENT` means "consult the next method" (#1826).
  if (hint === "string") {
    const ts = tryMethod("toString");
    if (ts !== _PRIM_ABSENT) return ts;
    const vo = tryMethod("valueOf");
    if (vo !== _PRIM_ABSENT) return vo;
  } else {
    const vo = tryMethod("valueOf");
    if (vo !== _PRIM_ABSENT) return vo;
    const ts = tryMethod("toString");
    if (ts !== _PRIM_ABSENT) return ts;
  }

  // A compiled closure with no user-defined coercion method behaves like a
  // function whose inherited Function.prototype.toString is implementation
  // defined. Keep this fallback after @@toPrimitive/valueOf/toString so own
  // user overrides retain ordinary JavaScript precedence.
  const closureSource = compiledClosureNativeSource(raw, callbackState);
  if (closureSource !== undefined) return closureSource;
  return undefined;
}

/**
 * Simplified ToPrimitive for contexts without callbackState (e.g. jsString.concat).
 * Only checks sidecar properties, not Wasm exports.
 * Per §7.1.1.1 step 6, throws TypeError if no conversion is possible (#1128).
 *
 * For WasmGC structs where JS property access fails, falls back to "[object Object]"
 * because we can't dispatch through Wasm exports without callbackState.
 * For regular JS objects, uses V8's native valueOf/toString which throws TypeError
 * per spec if neither produces a primitive.
 *
 * (#1716) When a `callbackState` IS supplied (e.g. ToPropertyKey on an object
 * key inside `_safeGet`/`_safeSet`/`__extern_has`), route WasmGC structs through
 * `_hostToPrimitive` — the callbackState-aware OrdinaryToPrimitive walker built
 * for #1319/#1090 — so that a key/arg whose `valueOf` / `toString` /
 * `Symbol.toPrimitive` is a compiled WasmGC closure is actually invoked instead
 * of falling through to the opaque-struct "[object Object]" sentinel. This reuses
 * the existing machinery rather than duplicating the dispatch logic; a §7.1.1.1
 * step-6 violation (method returns an object) still throws TypeError, which is
 * the spec-correct outcome for the property-key path too.
 */
function _toPrimitiveSync(
  v: any,
  hint: "number" | "string" | "default",
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (v == null || typeof v !== "object") return v;
  // (#1716) With exports available, defer to the full OrdinaryToPrimitive walker
  // so WasmGC-closure valueOf/toString/@@toPrimitive get dispatched. It returns
  // "[object Object]" for a no-method struct and throws only on the spec
  // step-6 violation — both correct here.
  if (callbackState && _isWasmStruct(v)) {
    return _hostToPrimitive(v, hint, callbackState);
  }
  const prim = _toPrimitive(v, hint, callbackState);
  if (prim !== undefined) return prim;
  // WasmGC structs: JS property access fails on opaque structs, but they may
  // have compiled valueOf/toString that _toPrimitive couldn't dispatch without
  // callbackState. Fall back to "[object Object]" (same as V8's default toString).
  if (_isWasmStruct(v)) return "[object Object]";
  // Regular JS objects: try V8's native property access per OrdinaryToPrimitive §7.1.1.1
  const methodNames = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  for (const mName of methodNames) {
    try {
      const fn = v[mName];
      if (typeof fn === "function") {
        const r = fn.call(v);
        if (r == null || typeof r !== "object") return r;
      }
    } catch {
      /* property access may throw */
    }
  }
  throw new TypeError("Cannot convert object to primitive value");
}

/**
 * Bind imports from the complete frozen compile result rather than from an
 * unqualified compatibility manifest. Native-first modules disable ambient
 * semantic shims, and invalid capability/provider bindings fail before a Wasm
 * instance is published.
 */
export function buildCompiledImports(
  result: CompileResult,
  deps?: Record<string, any>,
  options: BuildImportsOptions = {},
): ReturnType<typeof buildImports> {
  if (!result.success) {
    throw new Error(
      `Cannot build imports for a failed compile: ${result.errors.map((error) => error.message).join("; ")}`,
    );
  }
  const providerDiagnostics = result.capabilityProviderDiagnostics ?? [];
  if (providerDiagnostics.length > 0) {
    throw new Error(
      `Capability provider validation failed: ${providerDiagnostics.map((diagnostic) => diagnostic.message).join("; ")}`,
    );
  }
  if (result.adapterManifest) return buildCompiledAdapterImports(result.adapterManifest, deps, options);
  if (!result.targetProfile) {
    return buildImports(result.imports, deps, result.stringPool, options);
  }
  return buildCompiledAdapterImports(
    createJavaScriptAdapterManifest({
      targetProfile: result.targetProfile,
      imports: result.imports,
      stringPool: result.stringPool,
      capabilities: result.capabilityRequirements,
      exportSignatures: result.exportSignatures,
      exportBoundaries: result.exportBoundaryPolicies,
    }),
    deps,
    options,
  );
}

/** Bind exactly the imports/capabilities declared by a generated adapter plan. */
export function buildCompiledAdapterImports(
  manifest: JavaScriptAdapterManifestV1,
  deps?: Record<string, any>,
  options: BuildImportsOptions = {},
): ReturnType<typeof buildImports> {
  const frozenManifest = createJavaScriptAdapterManifest(manifest);
  const diagnostics = validateJavaScriptAdapterManifest(frozenManifest);
  if (diagnostics.length > 0) {
    throw new Error(`Invalid JavaScript adapter manifest: ${diagnostics.join("; ")}`);
  }
  const { imports, capabilities, targetProfile } = frozenManifest;
  const authority = prepareCompiledCapabilityAuthority(frozenManifest, deps, options.domRoot !== undefined);
  return buildImports(imports, deps, frozenManifest.stringPool, {
    ...options,
    ...authority,
    ambientCompatibility: options.ambientCompatibility ?? targetProfile.semanticProviders === "backend-defined",
    hostAccelerators: options.hostAccelerators ?? targetProfile.accelerators,
  });
}

/** Symbol.dispose / Symbol.asyncDispose may not exist in older runtimes (ES2026). */
const _disposeSym: symbol = (Symbol as any).dispose ?? Symbol.for("Symbol.dispose");
const _asyncDisposeSym: symbol = (Symbol as any).asyncDispose ?? Symbol.for("Symbol.asyncDispose");

/** Map from JS well-known Symbols to Wasm "@@name" keys (and vice-versa). */
const _symbolToWasm: Map<symbol, string> = new Map([
  [Symbol.iterator, "@@iterator"],
  [Symbol.hasInstance, "@@hasInstance"],
  [Symbol.toPrimitive, "@@toPrimitive"],
  [Symbol.toStringTag, "@@toStringTag"],
  [Symbol.species, "@@species"],
  [Symbol.isConcatSpreadable, "@@isConcatSpreadable"],
  [Symbol.match, "@@match"],
  [Symbol.replace, "@@replace"],
  [Symbol.search, "@@search"],
  [Symbol.split, "@@split"],
  [Symbol.unscopables, "@@unscopables"],
  [Symbol.asyncIterator, "@@asyncIterator"],
  [_disposeSym, "@@dispose"],
  [_asyncDisposeSym, "@@asyncDispose"],
  [Symbol.matchAll, "@@matchAll"],
]);

/**
 * Reverse map from well-known symbol i32 IDs (used in compiled Wasm) to
 * the "@@name" string and real JS Symbol. When the compiler sees
 * `obj[Symbol.iterator]`, it emits `i32.const 1` which becomes a boxed
 * Number(1) at the JS boundary. This map resolves it back to "@@iterator"
 * and Symbol.iterator for sidecar lookups.
 */
const _symbolIdToKeys: Map<number, { wasm: string; sym: symbol }> = new Map([
  [1, { wasm: "@@iterator", sym: Symbol.iterator }],
  [2, { wasm: "@@hasInstance", sym: Symbol.hasInstance }],
  [3, { wasm: "@@toPrimitive", sym: Symbol.toPrimitive }],
  [4, { wasm: "@@toStringTag", sym: Symbol.toStringTag }],
  [5, { wasm: "@@species", sym: Symbol.species }],
  [6, { wasm: "@@isConcatSpreadable", sym: Symbol.isConcatSpreadable }],
  [7, { wasm: "@@match", sym: Symbol.match }],
  [8, { wasm: "@@replace", sym: Symbol.replace }],
  [9, { wasm: "@@search", sym: Symbol.search }],
  [10, { wasm: "@@split", sym: Symbol.split }],
  [11, { wasm: "@@unscopables", sym: Symbol.unscopables }],
  [12, { wasm: "@@asyncIterator", sym: Symbol.asyncIterator }],
  [13, { wasm: "@@dispose", sym: _disposeSym }],
  [14, { wasm: "@@asyncDispose", sym: _asyncDisposeSym }],
  [15, { wasm: "@@matchAll", sym: Symbol.matchAll }],
]);

/** Resolve and seed the per-instance well-known symbol cache (#3676). */
function _resolveSymbolCache(instanceState?: InstanceState): Map<number, symbol> {
  const symbolCache =
    instanceState?.symbolCache ??
    (instanceState ? (instanceState.symbolCache = new Map<number, symbol>()) : new Map<number, symbol>());
  if (symbolCache.size === 0) {
    symbolCache.set(1, Symbol.iterator);
    symbolCache.set(2, Symbol.hasInstance);
    symbolCache.set(3, Symbol.toPrimitive);
    symbolCache.set(4, Symbol.toStringTag);
    symbolCache.set(5, Symbol.species);
    symbolCache.set(6, Symbol.isConcatSpreadable);
    symbolCache.set(7, Symbol.match);
    symbolCache.set(8, Symbol.replace);
    symbolCache.set(9, Symbol.search);
    symbolCache.set(10, Symbol.split);
    symbolCache.set(11, Symbol.unscopables);
    symbolCache.set(12, Symbol.asyncIterator);
    symbolCache.set(13, _disposeSym);
    symbolCache.set(14, _asyncDisposeSym);
  }
  return symbolCache;
}

/** Safe property get: works on both JS objects and WasmGC structs. */
function _safeGet(
  obj: any,
  key: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
  rawCallable = false,
): any {
  if (obj == null) return undefined;
  // (#5225) Every struct probe below resolves helpers from `callbackState`. When
  // the receiver was minted by ANOTHER module of this linked project those
  // helpers are the wrong ones, and the failure is silent: a reader whose own
  // shapes reuse the field name (`day`, `month`, … are everywhere in the
  // Temporal polyfill) serves its `__sget_` `ref.test`-miss DEFAULT — 0 — which
  // reads as a real value. Redirect once, here, rather than at each probe.
  callbackState = _crossModuleCallbackState(obj, callbackState);
  // Coerce WasmGC struct keys to primitives via ToPrimitive (#1090, #1716).
  // Passing callbackState lets a key with a WasmGC-closure valueOf / toString /
  // @@toPrimitive be dispatched (ToPropertyKey §7.1.19 → ToPrimitive §7.1.1);
  // without it the opaque struct collapses to "[object Object]" and the lookup
  // silently misses.
  if (key != null && typeof key === "object" && _isWasmStruct(key)) {
    const prim = _toPrimitiveSync(key, "string", callbackState);
    if (prim != null && typeof prim !== "object") key = prim;
  }
  // Well-known symbol ID (i32 from compiler): only apply to WasmGC structs.
  // For regular JS objects/arrays, numeric keys 1-15 are actual indices, not symbol IDs
  // (e.g. getOwnPropertyNames conversion loop uses __extern_get with integer indices).
  // #1830 — the range must cover every id in `_symbolIdToKeys` (1-15, 15 =
  // @@matchAll); `<= 14` silently dropped Symbol.matchAll on WasmGC structs.
  // #4527: dynamic canonical string keys on reflective vec carriers must take
  // the same fast path as numeric indices; other strings continue to sidecars.
  if (_isWasmStruct(obj) && typeof key === "string" && _isCanonicalArrayIndexKey(key)) {
    const exports = callbackState?.getExports();
    const isVec = exports?.__is_vec as ((value: any) => number) | undefined;
    const vecLen = exports?.__vec_len as ((value: any) => number) | undefined;
    const vecGet = exports?.__vec_get as ((value: any, index: number) => any) | undefined;
    if (typeof isVec === "function" && typeof vecLen === "function" && typeof vecGet === "function") {
      try {
        if (isVec(obj) === 1) return Number(key) < vecLen(obj) ? vecGet(obj, Number(key)) : undefined;
      } catch {
        /* Continue through the ordinary struct path. */
      }
    }
  }
  // #2014: prefer genuine numeric data properties to symbol-ID collisions.
  if (_isWasmStruct(obj) && typeof key === "number" && Number.isInteger(key) && key >= 0) {
    const exports = callbackState?.getExports();
    const index = _asArrayIndex(String(key));
    const isVec = exports?.__is_vec as ((value: any) => number) | undefined;
    const vecLen = exports?.__vec_len as ((value: any) => number) | undefined;
    const vecGet = exports?.__vec_get as ((value: any, index: number) => any) | undefined;
    if (
      index !== undefined &&
      typeof isVec === "function" &&
      typeof vecLen === "function" &&
      typeof vecGet === "function"
    ) {
      try {
        if (isVec(obj) === 1) {
          return index < vecLen(obj) ? vecGet(obj, index) : undefined;
        }
      } catch {
        // Not a compatible live vec; continue through the ordinary struct path.
      }
    }
    const getter = exports?.[`__sget_${String(key)}`];
    if (typeof getter === "function" && _structHasOwnFieldName(obj, String(key), exports)) return getter(obj);
    // A tuple field uses the compiler-owned `_0`, `_1`, … names while JS
    // element access supplies the ordinary numeric key `0`, `1`, … . This
    // path is reached when an unproven outer-array read widens a tuple ref to
    // externref so OOB can carry `undefined` (for example
    // `Object.entries(obj)[0][0]`). Prove the receiver's concrete tuple field
    // before consulting the collision-shared getter; otherwise an unrelated
    // struct would read a zero-value shape miss as a real element.
    const tupleField = `_${String(key)}`;
    const tupleGetter = exports?.[`__sget_${tupleField}`];
    if (typeof tupleGetter === "function" && _structHasOwnFieldName(obj, tupleField, exports)) {
      return tupleGetter(obj);
    }
  }
  // (#2706 / #1830) Numeric keys fall through to the sidecar as real integer
  // indices; real symbol keys resolve via the `typeof key === "symbol"` arm below.
  if (_isWasmStruct(obj)) {
    const nativeString = _nativeStringToHost(obj, callbackState?.getExports());
    if (nativeString !== _MISS) return (nativeString as any)[key as any];
    // (#2130) A deleted property reads as `undefined` even when the static
    // struct shape still carries the field (the `__sget_<key>` getter would
    // otherwise return the stale field value). The tombstone is cleared by
    // `_safeSet` on re-add, so a re-added key never reaches here as tombstoned.
    // Symbol keys preserve identity; everything else compares stringified.
    const tomb = _wasmStructDeletedKeys.get(obj);
    if (tomb && tomb.has(typeof key === "symbol" ? key : String(key))) return undefined;
    // For WasmGC structs, user-assigned properties live in the sidecar.
    // Check sidecar FIRST — native JS property access on WasmGC structs can return
    // built-in artifacts (e.g. `obj.constructor` returns the Wasm struct constructor),
    // which would shadow user-assigned properties if we checked native first.
    // Check string accessor getter stored by Object.defineProperty (sidecar key: __get_<prop>)
    if (typeof key === "string") {
      const wasmSc = _wasmStructProps.get(obj);
      const getter = wasmSc?.[`__get_${key}` as string];
      if (typeof getter === "function") return (getter as Function).call(obj);
      if (getter != null && typeof getter === "object" && _isWasmStruct(getter)) {
        const callFn0 = callbackState?.getExports()?.__call_fn_0;
        if (typeof callFn0 === "function") return callFn0(getter);
      }
    }
    // Accessor descriptors take precedence over any stale data-sidecar value
    // retained while the receiver's static shape was widened.
    const sc = _sidecarGet(obj, key);
    if (sc !== undefined) return sc;
    // A declared own field shadows a prototype method with the same spelling
    // (§9.4.2 [[Get]]). This matters when an untyped host call reaches a
    // compiled class whose field stores a callable closure (Marked's
    // `parse`/`parseInline` fields) while another class in the module exports
    // a method of the same name. Resolve the concrete field before the
    // module-wide method discriminator; otherwise the unrelated method arm
    // masks the live field or returns a null closure.
    if (typeof key === "string") {
      // (#5209) MARSHALLING read — the fifth facet of the #5193 init window.
      // `__sget_*` and `__struct_field_names` are already handed to the runtime
      // from inside the start section (#5205 registers the STRUCT-READ family),
      // but this probe still asked `getExports()`, which is `undefined` for the
      // whole of module init. A field read off an `any`-typed receiver at init —
      // `arr.filter((x) => x.code)`, where the callback parameter has no static
      // type — therefore answered `undefined` SILENTLY: the predicate went
      // false, `filter` returned `[]`, and the Temporal era table came back
      // empty instead of throwing.
      const fieldExports = marshalExports(callbackState);
      if (_structHasOwnFieldName(obj, key, fieldExports)) {
        const getter = fieldExports?.[`__sget_${key}`];
        if (typeof getter === "function") return _restoreF64Undefined(getter(obj));
      }
    }
    // For JS Symbols, check the accessor map (for Symbol-keyed defineProperty accessors)
    if (typeof key === "symbol") {
      const accessor = _wasmStructAccessors.get(obj)?.get(key);
      if (accessor?.get) return accessor.get.call(obj);
      // Also check the Wasm "@@name" equivalent
      const wasmKey = _symbolToWasm.get(key);
      if (wasmKey) {
        const sc2 = _sidecarGet(obj, wasmKey);
        if (sc2 !== undefined) return sc2;
        // (#3123) A computed well-known-symbol property in an object LITERAL
        // (`{ [Symbol.iterator]: 0 }`) compiles to a typed struct FIELD named
        // "@@iterator" — invisible to the sidecar read above. Read it through
        // the per-shape `__sget_@@<name>` getter so a NON-CALLABLE @@iterator
        // (the flatMap iterable-to-iterator-fallback shape, which must make
        // GetMethod throw TypeError) is observable host-side.
        const exports2 = callbackState?.getExports();
        const fieldGetter = exports2?.[`__sget_${wasmKey}`];
        if (typeof fieldGetter === "function") {
          try {
            const v = fieldGetter(obj);
            if (v !== undefined && v !== null) return v;
          } catch {
            /* not a field of this struct shape */
          }
        }
      }
    }
    // (#3123) Compiled class methods/getters on a registered fnctor-subclass
    // instance — the own-C.prototype level, shadowing the fnctor parent's
    // prototype chain below.
    {
      const v = _resolveClassMember(obj, key, callbackState?.getExports());
      if (v !== _MISS) return v;
    }
    // (#1712) fnctor instances: resolve through the constructor's vivified
    // prototype object before giving up. Accessors run with the instance
    // (proxy-wrapped when one exists) as the receiver per §6.2.5.5 Get.
    // Raw closure structs (stored during the module START function, before
    // exports existed for the write-side wrap) are wrapped at read time.
    const protoDesc = _fnctorProtoLookup(obj, key, callbackState?.getExports());
    if (protoDesc) {
      // (#2739 b) §7.3.2 [[Get]]: an OWN typed struct FIELD shadows the
      // inherited prototype property. The own-field fast path lives in
      // __extern_get's fallback (AFTER _safeGet returns), so without this
      // check a proto hit here wrongly shadows the own field (e.g.
      // `function F(){this.hint="hinted"}; F.prototype={hint:"protohint"}` —
      // `new F().hint` must read "hinted"). Shape-gated via
      // _getStructFieldNames (never a blind __sget_ try/catch probe),
      // honoring the delete tombstone.
      if (typeof key === "string") {
        const tomb = _wasmStructDeletedKeys.get(obj);
        if (!(tomb && tomb.has(key))) {
          const exports = callbackState?.getExports();
          if (_structHasOwnFieldName(obj, key, exports)) {
            const getter = exports?.[`__sget_${key}`];
            if (typeof getter === "function") {
              const own = getter(obj);
              if (own !== undefined) return own;
            }
          }
        }
      }
      if (protoDesc.get) return protoDesc.get.call(_hostProxyCache.get(obj) ?? obj);
      return rawCallable ? protoDesc.value : _maybeWrapCallableUnknownArity(protoDesc.value, callbackState);
    }
    const vecPrototypeValue = vecProtoGet(obj, key, false, callbackState?.getExports());
    if (vecPrototypeValue !== WASM_VEC_PROTOTYPE_MISS) return vecPrototypeValue;
    // V8 exposes an opaque WasmGC struct miss as `null` on some versions.
    // That is not an own value: compiled writes live in the sidecar above and
    // declared fields are recovered by `__extern_get`'s generated getter after
    // this helper reports a miss. Normalize only that opaque native miss to
    // JavaScript `undefined`; a real null sidecar/field still round-trips.
    const native = obj[key];
    return native === null ? undefined : native;
  }
  const direct = obj[key];
  if (direct !== undefined) return direct;
  // Check sidecar for properties set via __extern_set on non-WasmGC objects
  const sc = _sidecarGet(obj, key);
  if (sc !== undefined) return sc;
  // (#5204) A compiled member of an EXTERNREF-BACKED class. Its instance is a
  // real host object, so the `_isWasmStruct(obj)` block above — which is where
  // `_resolveClassMember` was consulted — never runs for it, and a plain
  // property READ of a `get g()` on `class D extends Array` answered
  // `undefined` (→ NaN through the reader's `__unbox_number`). A METHOD call
  // never hit this because `__extern_method_call`'s not-a-function tail
  // consults the same resolver on its own.
  //
  // Placed AFTER the native read and the sidecar so nothing that already
  // resolved changes precedence; the resolver itself answers only for
  // registered compiled instances, so every other host object is untouched.
  //
  // Reads the #5193/#5202/#5203 start-export channel rather than bare
  // `getExports()`, so the same read works DURING module init — `__call_get_*`
  // and `__class_call_*` are both registered there.
  {
    const member = _resolveClassMember(obj, key, marshalExports(callbackState));
    if (member !== _MISS) return member;
  }
  // For JS Symbols, also check the Wasm "@@name" equivalent
  if (typeof key === "symbol") {
    const wasmKey = _symbolToWasm.get(key);
    if (wasmKey) return _sidecarGet(obj, wasmKey);
  }
  return undefined;
}

/**
 * `key`'s descriptor on `obj` or its prototype chain, WITHOUT firing a Proxy MOP
 * trap (bailing on a Proxy link keeps #2017's trap ordering) and without
 * throwing on an opaque WasmGC handle. Shared by `_safeSet`'s strict pre-check
 * (#2017 / #2745 d) and its sloppy setter-propagation arm (#2899).
 */
function _lookupDescriptorNoProxy(obj: any, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    let hops = 0;
    for (let cur = obj; cur != null && (typeof cur === "object" || typeof cur === "function"); ) {
      const d = Object.getOwnPropertyDescriptor(cur, key);
      if (d) return d;
      // (#6944) Struct nodes resolve their user [[Prototype]]; bounded, the chain may cycle.
      if (_isWasmStruct(cur)) {
        if (++hops > 16) break;
        cur = _structUserProto(cur);
      } else cur = Object.getPrototypeOf(cur);
    }
  } catch {
    /* opaque handle → no descriptor knowable */
  }
  return undefined;
}

/** Write a canonical numeric key through to a live WasmGC vec backing array. */
function _trySetWasmVecElement(
  obj: any,
  key: any,
  val: any,
  exports?: Record<string, Function>,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): boolean {
  if (typeof key === "symbol") return false;
  const index = _asArrayIndex(String(key));
  if (index === undefined) return false;
  const vecExports = exports ?? callbackState?.getExports();
  if (!vecExports) return false;
  const isVec = vecExports?.__is_vec as ((v: any) => number) | undefined;
  const setElem = vecExports?.__vec_set_elem as ((v: any, i: number, x: any) => number) | undefined;
  if (typeof isVec !== "function" || typeof setElem !== "function") return false;
  try {
    if (isVec(obj) !== 1) return false;
    const rawValue = _nativeDynamicFromHost(val, vecExports);
    const setResult = setElem(obj, index, rawValue);
    if (setResult !== 1) return false;
    const sc = _wasmStructProps.get(obj);
    if (sc && String(key) in sc) delete sc[String(key)];
    return true;
  } catch {
    return false;
  }
}

/**
 * Safe property set: works on both JS objects and WasmGC structs.
 *
 * When `exports` is provided AND `obj` is a WasmGC struct AND `key` is a
 * string, the optional `__sset_<key>` export is invoked so the write lands
 * in the real struct field (not only the sidecar). This is the writeback
 * symmetric to `__sget_<key>` and unblocks struct-target `Object.assign`,
 * `Reflect.set`, and `Object.defineProperty` data writes (#1630). Callers
 * that don't pass `exports` get the prior sidecar-only behaviour.
 */
function _safeSet(
  obj: any,
  key: any,
  val: any,
  exports?: Record<string, Function>,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
  // (#2017) Strict-mode [[Set]] (§10.1.9 / §13.15.2): a write to a getter-only
  // accessor or a non-writable / non-extensible-new property must throw a
  // catchable TypeError instead of silently failing. ESM module code is always
  // strict, so the `__extern_set_strict` host import passes `strict=true`; the
  // legacy `__extern_set` keeps `strict=false` (silent) for back-compat.
  strict?: boolean,
): void {
  if (obj == null) return;
  // (#1712) A vec read through `_wrapForHost` may return its real-array Proxy
  // view. Numeric writes must target the canonical raw WasmGC vec so the
  // module's element-set dispatcher can mutate the backing array.
  if (_wasmClosureWrapperTargets.has(obj)) Reflect.set(obj, key, val, obj);
  obj = _unwrapForHost(obj);
  // #2847: dynamic writes can cross a generic bridge after the Wasm boolean
  // carrier was widened to an unbranded numeric externref. The compiler emits
  // a marker only for property names whose complete visible write set is
  // boolean; restore the JS brand before either a host-object write or a
  // Wasm-struct writeback observes the value. Numeric properties with the same
  // spelling suppress the marker during whole-program analysis.
  if (typeof key === "string" && (val === 0 || val === 1)) {
    const booleanExports = exports ?? callbackState?.getExports();
    if (typeof booleanExports?.[`__sbool_${key}`] === "function") val = val !== 0;
  }
  // Coerce WasmGC struct keys to primitives via ToPrimitive (#1090, #1716).
  // Prefer the explicit callbackState; fall back to wrapping `exports` so a
  // WasmGC-closure key method can still be dispatched when only exports is in
  // scope at the call site.
  if (key != null && typeof key === "object" && _isWasmStruct(key)) {
    const cbState = callbackState ?? (exports ? { getExports: () => exports } : undefined);
    const prim = _toPrimitiveSync(key, "string", cbState);
    if (prim != null && typeof prim !== "object") key = prim;
  }
  // (#2130) Re-adding a previously-deleted property clears its tombstone, so
  // `delete o.a; o.a = 5; o.a` reads `5` and `"a" in o` is `true` again. This
  // is the single choke point for every WasmGC write arm (sidecar setter,
  // descriptor write, symbol-id, struct field) — placing the clear here rather
  // than only in `_sidecarSet` covers the `__sset_<name>`/native-write paths
  // that bypass the sidecar (A3).
  if (_isWasmStruct(obj)) {
    const tomb = _wasmStructDeletedKeys.get(obj);
    const k = typeof key === "symbol" ? key : String(key);
    // (#2731) Before clearing the tombstone, note whether THIS write is the
    // re-add of a deleted STRUCT-SHAPE field. If so, mark it shadowed: its live
    // value now lives in the sidecar (re-inserted below at the end) and it must
    // enumerate from there, not its fixed struct slot, so the for-in / Object.*
    // collectors place it at insertion-order END (§ EnumerateObjectProperties).
    if (typeof k === "string" && !!tomb && tomb.has(k)) {
      const exportsForShape = exports ?? callbackState?.getExports();
      if (_structHasOwnFieldName(obj, k, exportsForShape)) {
        let shadowed = _wasmStructShadowedFields.get(obj);
        if (!shadowed) {
          shadowed = new Set<string>();
          _wasmStructShadowedFields.set(obj, shadowed);
        }
        shadowed.add(k);
      }
    }
    if (tomb) tomb.delete(k);
  }
  // (#2706 / #1830) Mirror of the `_safeGet` fix above. A genuine integer-index
  // assignment (`o[5] = 55`) on a WasmGC struct is NOT a well-known-symbol write.
  // `runtime.ts` only runs in host mode, where the compiler boxes every
  // well-known-symbol access into a REAL JS Symbol (`o[Symbol.species]` arrives
  // as `typeof key === "symbol"`, never a number — verified). The old
  // `1 <= key <= 15 → _symbolIdToKeys` remap stored `o[5]` under the `@@species`
  // Symbol + `"@@species"` sidecar string, so for-in / Object.keys leaked
  // `"@@species"` and dropped `"5"`, and `5 in o` was false even though `o[5]`
  // round-tripped. Dropping the remap lets a numeric key fall through to the
  // sidecar write below (stored under `"5"`), so enumeration / `in` / Object.keys
  // see `"5"`. Real symbol keys (`typeof key === "symbol"`) keep their existing
  // routing; only standalone mode (object-runtime.ts, never this file) uses i32
  // symbol ids.
  //
  // WasmGC structs: native property assignment silently fails for non-struct fields
  // (V8 ignores `struct.constructor = {}` without throwing in non-strict mode).
  // Always write to sidecar so that dynamic properties are accessible via _safeGet.
  if (_isWasmStruct(obj)) {
    // Invoke sidecar setter if one was stored via Object.defineProperty (sidecar key: __set_<prop>)
    if (typeof key === "string") {
      const sc = _wasmStructProps.get(obj);
      const setter = sc?.[`__set_${key}` as string];
      if (typeof setter === "function") {
        (setter as Function).call(obj, val);
        return;
      }
      // (#2017) Getter-only sidecar accessor (a `__get_<key>` with no
      // `__set_<key>`): strict [[Set]] must throw a catchable TypeError; sloppy
      // callers keep the legacy silent no-op (the write falls through and the
      // getter continues to shadow any sidecar value).
      if (strict && sc && typeof sc[`__get_${key}` as string] === "function") {
        throw new TypeError(`Cannot set property ${key} of #<Object> which has only a getter`);
      }
    }
    // (#2017) Getter-only sidecar accessor under a symbol key (stored in the
    // dedicated accessor map, not the `__get_`/`__set_` string sidecar).
    if (strict && typeof key === "symbol") {
      const acc = _wasmStructAccessors.get(obj)?.get(key);
      if (acc && acc.get && !acc.set) {
        throw new TypeError(`Cannot set property ${String(key)} of #<Object> which has only a getter`);
      }
    }
    // Respect sidecar descriptor flags (non-configurable / non-writable properties)
    const descs = _wasmPropDescs.get(obj);
    if (descs) {
      const propKey = typeof key === "symbol" ? key : String(key);
      const flags = descs.get(propKey);
      if (flags !== undefined && !(flags & _SC_WRITABLE)) {
        // (#2017) strict-mode write to a non-writable / getter-only sidecar
        // property → catchable TypeError; otherwise silent (sloppy [[Set]]).
        if (strict) throw new TypeError(`Cannot assign to read only property '${String(propKey)}' of object`);
        return; // silent fail: read-only property
      }
    }
    // Respect non-extensible (no new properties, but existing sidecar props can be updated)
    if (_wasmNonExtensibleObjs.has(obj)) {
      const sc = _wasmStructProps.get(obj);
      const propKey = typeof key === "symbol" ? key : String(key);
      const hasInSidecar = sc && key in sc;
      const hasInDescs = descs?.has(propKey);
      if (!hasInSidecar && !hasInDescs) {
        // (#2017) strict-mode add to a non-extensible object → catchable TypeError.
        if (strict) throw new TypeError(`Cannot add property ${String(propKey)}, object is not extensible`);
        return; // silent fail: non-extensible, new property not added
      }
    }
    // (#1712) Dynamic indexed assignment to a WasmGC vec. Fnctor fields are
    // externref in JS-host mode, so an expression such as
    // `this.context[index] = nextContext` reaches `_safeSet` rather than the
    // compiler's typed `array.set` lane. A native assignment to the opaque
    // WasmGC handle is a silent no-op, and a sidecar value is invisible to
    // subsequent compiled vec reads. Route canonical array indices through the
    // same live-value writer used by Array [[DefineOwnProperty]].
    if (_trySetWasmVecElement(obj, key, val, exports, callbackState)) return;
    // Symmetric writeback through the compiled `__sset_<key>` export so the
    // real WasmGC struct field gets updated, not just the sidecar (#1630).
    // Falls back silently when the export is missing or doesn't match the
    // struct's runtime type — sidecar still carries the value so host-side
    // reads (Object.keys, JSON.stringify, dynamic-key reads) keep working.
    //
    // (#1712) Resolve exports from `callbackState` when the `exports` param is
    // absent. The `__extern_set` / `__extern_set_strict` host bindings pass
    // `callbackState` (not `exports`), so without this fallback the `__sset_`
    // writeback was skipped and the value landed in the SIDECAR ONLY. A later
    // *static* `struct.get` read (the compiled member-access path takes the
    // guarded-cast struct branch whenever the receiver ref-tests as the struct
    // type — e.g. an fnctor instance method body reading `this.field`) bypasses
    // the sidecar and reads the raw WasmGC field, which still held its
    // initializer value. That split made a dynamic-method write (`this.t = v`)
    // invisible to a struct-typed read of the same field — the identity defect
    // behind acorn's `this.type = types$1.eof` / `this.type !== types$1.eof`
    // tokenizer loop (#1712): the write reached only the sidecar while the
    // guard read the stale struct field, so the guard never tripped.
    const ssetExports = exports ?? callbackState?.getExports();
    // A dynamic write to a compiled class accessor must invoke the real
    // prototype setter before falling back to struct-field/sidecar storage.
    // The compiler publishes a receiver-discriminating bridge only for
    // setters whose value ABI is already externref, so no representation is
    // guessed here. An own data/accessor property still shadows the prototype
    // setter exactly as OrdinarySet requires.
    if (typeof key === "string" && ssetExports && !_wasmStructHasOwn(obj, key, ssetExports)) {
      const classSetter = ssetExports[`__call_set_${key}`];
      if (typeof classSetter === "function" && classSetter(obj, _unwrapForHost(val)) === 1) return;
    }
    // (#2853 B) Did the `__sset_<key>` writeback land in the LIVE struct
    // field? Setters return i32 1 when a dispatch arm matched the receiver's
    // runtime type and wrote. When they do, the sidecar must NOT also carry
    // the value: the sidecar cannot be updated by compiled `struct.set`
    // writes (e.g. acorn's `this.pos` advancing inside prototype methods),
    // so a sidecar copy of a REAL field becomes a permanently-stale SHADOW
    // that `_safeGet`-first readers prefer over the live field. That shadow
    // froze `state.pos` at 0 for every parameter-path read in acorn's regexp
    // validator, making every group `(…)` raise "Unmatched ')'". Older
    // binaries' void setters return undefined → flag stays false → the
    // prior sidecar-carries-it behaviour.
    let fieldWrote = false;
    if (typeof key === "string" && ssetExports) {
      const setter = ssetExports[`__sset_${key}`];
      if (typeof setter === "function") {
        try {
          // (#1712) Store the RAW WasmGC struct in the field, never a
          // `_wrapForHost` proxy. A method-call argument that is itself a
          // struct arrives here proxy-wrapped (host-bridge arg marshaling);
          // writing the proxy into the `externref` field would make a later
          // *typed* `ref.eq` read compare unequal to the original struct. The
          // proxy is a pure host-side view — `_unwrapForHost` recovers the
          // canonical struct (1:1) and passes a non-proxy through unchanged.
          const setterResult = setter(obj, _unwrapForHost(val));
          fieldWrote = setterResult === 1;
        } catch {
          /* not a field of this struct's runtime type */
        }
      }
    }
    // (#3673) NOTE: no native `obj[key] = val` attempt here. `obj` is a WasmGC
    // struct in this branch and the JS-API property set on an opaque WasmGC
    // object unconditionally throws in strict code (this module is ESM/strict),
    // so the old try/catch write was a guaranteed V8 exception per property
    // write — measured as a top cost of compiled-acorn parsing. The `__sset_`
    // writeback above and the sidecar below are the real write lanes.
    // (#2853 B) A successful live-field write skips the sidecar and HEALS any
    // stale sidecar entry for the key — EXCEPT for a #2731 shadowed field
    // (deleted-then-re-added), whose live value deliberately lives in the
    // sidecar for insertion-order enumeration.
    const isShadowedField =
      typeof key === "string" && fieldWrote ? _wasmStructShadowedFields.get(obj)?.has(key) === true : false;
    if (fieldWrote && !isShadowedField) {
      const sc = _wasmStructProps.get(obj);
      if (sc && (key as string) in sc) delete sc[key as string];
    } else {
      // Host mirrors are transport views, never JavaScript values in their own
      // right. Keeping a mirror in the sidecar breaks identity and makes a
      // later typed cast of the property null out. Object.assign is the common
      // path: reading a struct-valued source field yields its host proxy, then
      // writing that proxy to a dynamic target field must recover the original
      // WasmGC reference.
      _sidecarSet(obj, key, _unwrapForHost(val));
    }
    if (typeof key === "symbol") {
      const wasmKey = _symbolToWasm.get(key);
      if (wasmKey) _sidecarSet(obj, wasmKey, _unwrapForHost(val));
    }
    if (typeof key === "string" && key.startsWith("@@")) {
      for (const [sym, wk] of _symbolToWasm) {
        if (wk === key) {
          _sidecarSet(obj, sym, _unwrapForHost(val));
          break;
        }
      }
    }
    _mirrorClosurePropertyToHostBridges(obj, key, _unwrapForHost(val), callbackState);
    return;
  }
  // Strict [[Set]] pre-check (§13.15.2 → §10.1.9), by resolved descriptor kind:
  //   getter-only accessor  → throw (#2017; silent no-op was the bug)
  //   accessor WITH a setter → let the write run, re-raise its throw (#2745 d,
  //                            e.g. the %ThrowTypeError% poison a bound function
  //                            inherits for `caller`/`arguments`, §10.2.4)
  //   non-writable data      → throw (§6.2.5.6 step 3.e via #3374)
  // Skipped entirely for a sloppy Reference, where §10.1.9.2's "[[Set]] returned
  // false" outcomes are silent — only a THROWING setter escapes, handled in the
  // catch below. A Proxy anywhere on the chain also skips it (no MOP traps).
  let strictAccessorWrite = false;
  if (strict && (typeof key === "string" || typeof key === "symbol")) {
    const desc = _lookupDescriptorNoProxy(obj, key as PropertyKey);
    if (desc) {
      if ((desc.get || desc.set) && !desc.set) {
        // Getter-only accessor (own or inherited) → strict [[Set]] throws.
        throw new TypeError(`Cannot set property ${String(key)} of #<Object> which has only a getter`);
      }
      if (desc.get || desc.set) {
        // Accessor WITH a setter — invoke it via the write below; propagate throws.
        strictAccessorWrite = true;
      } else if (desc.writable === false) {
        // OrdinarySetWithOwnDescriptor step 2.a returns false for a
        // non-writable data descriptor; PutValue turns that false into a
        // TypeError for a strict Reference (§6.2.5.6 step 3.e).
        throw new TypeError(`Cannot assign to read only property '${String(key)}' of object`);
      }
    }
  }
  try {
    obj[key] = val;
  } catch (e) {
    // (#2745 d) A genuine accessor-setter exception (e.g. the bound-function
    // poison pill) must reach the user's try/catch — never divert to sidecar.
    if (strictAccessorWrite) throw e;
    // #2180 — writing to a revoked proxy throws TypeError; propagate it instead
    // of silently diverting to the sidecar. Native descriptor failures are
    // handled below.
    if (_isRevokedProxyError(e)) throw e;
    // (#3374) The runtime module itself executes in strict mode, so the native
    // assignment above throws when [[Set]] returns false. The compiler now
    // selects this helper only for a genuinely strict source Reference; in that
    // case PutValue requires the TypeError to propagate. Sloppy writes keep the
    // legacy silent fallback below.
    if (strict) throw e;
    // (#2899) …but sloppy silence covers ONLY [[Set]] RETURNING false. §10.1.9.2
    // step 3 CALLS the setter, and its abrupt completion propagates whatever the
    // Reference's strictness — so `bound.caller = {}` must throw in sloppy code
    // too (%ThrowTypeError% poison from %FunctionPrototype%). Resolved lazily on
    // this already-exceptional path; setter-less cases stay silent below.
    if (typeof key === "string" || typeof key === "symbol") {
      const desc = _lookupDescriptorNoProxy(obj, key as PropertyKey);
      if (desc && desc.set) throw e;
      if (wsh.failedSloppyNativeSetIsNoOp(obj, desc)) return;
    }
    // The sloppy helper retains the legacy silent fallback because this runtime
    // module is itself strict: the native assignment can throw even when the
    // compiled source Reference was non-strict.
    // For non-WasmGC objects (frozen/sealed JS objects),
    // fall through to sidecar set — preserves original behavior.
    _sidecarSet(obj, key, val);
    // Also store under the "@@name" alias for well-known symbols
    if (typeof key === "symbol") {
      const wasmKey = _symbolToWasm.get(key);
      if (wasmKey) _sidecarSet(obj, wasmKey, val);
    }
    // And vice-versa: if key is "@@name", also store under the real Symbol
    if (typeof key === "string" && key.startsWith("@@")) {
      for (const [sym, wk] of _symbolToWasm) {
        if (wk === key) {
          _sidecarSet(obj, sym, val);
          break;
        }
      }
    }
  }
}

/** JS-owned objects explicitly admitted through a native dynamic export. */
const _nativeBoundaryHostObjects = new WeakMap<object, WeakSet<object>>();
interface NativeBoundarySymbolState {
  readonly byId: Map<number, symbol>;
  readonly byHost: Map<symbol, number>;
}
const _nativeBoundarySymbols = new WeakMap<object, NativeBoundarySymbolState>();
interface NativeBoundaryPromiseState {
  nextId: number;
  readonly observers: Map<number, { resolve(value: unknown): void; reject(reason: unknown): void }>;
}
const _nativeBoundaryPromises = new WeakMap<object, NativeBoundaryPromiseState>();
const _nativePromiseBoundaryDraining = new WeakSet<object>();
const _nativeErrorHostCache = new WeakMap<object, Error>();
const _nativePromiseHostCache = new WeakMap<object, Promise<unknown>>();
// A proxy may be created while the module start function is still running,
// before buildImports.setInstance() can expose the module's generated struct
// getters. Keep the export view in a mutable slot so the identity-cached proxy
// gains those getters after instantiation instead of remaining permanently
// blind to its receiver's physical fields.
const _hostProxyExportSlots = new WeakMap<object, { current: Record<string, Function> | undefined }>();

const _linkedProviderMirrors = createLinkedProviderMirrorOwnership(_canBeWeakKey);
linkedClosureDispatch.configure(_crossModuleStructs, _wrapWasmClosureUnknownArity); // (#6757)

/**
 * (#6492 r20) Mirror a COMPILED thenable for the keyed-combinator polyfill.
 *
 * `Promise.allKeyed` must `Invoke(nextPromise, "then", …)` on whatever the
 * user's `resolve` returned, and seven rows of the family return a compiled
 * object literal — an opaque WasmGC struct whose `then` is not a host function
 * (`TypeError: nextPromise.then is not a function`). This is the #2671/#4736
 * mirror the Promise boundary already applies, reached from MODULE scope: the
 * owning module's exports come from the #5225 decoder registry rather than from
 * a per-instance `callbackState`, because the polyfill is installed before one
 * exists. Non-Wasm values are returned untouched, so a host thenable keeps its
 * identity.
 */
export function _mirrorPolyfillThenable(value: any): any {
  if (value == null || typeof value !== "object" || !_isWasmStruct(value)) return value;
  // The #5225 registry answers only for a LINKED project (it disables itself at
  // one module, since there every value is already local). The honest
  // whole-assembly lane is exactly that single-module case, so fall back to the
  // live instance's own exports — gated on a decode probe, never assumed, so a
  // multi-instance embedder cannot hand a struct to a stranger's decoder.
  const local = _latestInstance?.deref()?.getExports();
  const exports = _crossModuleStructs.decoderFor(value, local) ?? (_decodes(local, value) ? local : undefined);
  return exports ? _wrapForHost(value, exports) : value;
}

/** Whether `exports` can name this struct's fields (the #5225 `decodes` probe). */
function _decodes(exports: Record<string, Function> | undefined, obj: object): boolean {
  const fn = exports?.__struct_field_names;
  if (typeof fn !== "function") return false;
  try {
    const csv = fn(obj);
    return typeof csv === "string" && csv !== "";
  } catch {
    return false;
  }
}

/**
 * The live instance's exports, for module-scope helpers that run during a call
 * but are installed before any instance exists (the keyed-combinator mirror).
 */
// (#6492 r20 → #5983) A WeakRef, never a strong closure: a module-level strong
// reference to the latest instance's callbackState kept every instance graph
// reachable across a single-fork vitest run (the pinned `issue-tests` and the
// guard-suite OOMed at ~510 MB after two files). The mirror only needs the
// exports while that instance is alive anyway.
let _latestInstance: WeakRef<{ getExports: () => Record<string, Function> | undefined }> | undefined;

/** (#6790) Open a linked project keyed by its root import object; its modules decode only each other. */
export function beginLinkedProject(rootImports: object): void {
  _crossModuleStructs.beginProject(rootImports);
}

/** (#5225) Record a linked provider's exports as a decoder for `rootImports`' project. */
export function registerLinkedProviderModule(exports: Record<string, Function>, rootImports?: object): void {
  _linkedProviderMirrors.registerProviderExports(exports);
  _crossModuleStructs.registerModule(exports, rootImports);
}

/** (#5225) Record the consumer's exports as a decoder for `rootImports`' project. */
export function registerLinkedConsumerModule(exports: Record<string, Function>, rootImports?: object): void {
  _crossModuleStructs.registerModule(exports, rootImports);
}

/**
 * (#5364) Forget every linked project registered so far.
 *
 * (#6790) Correctness no longer depends on it: `instantiateLinkedProviders`
 * opens a project per call, and two instances of one provider binary — which
 * share canonical WasmGC types, so project 1's `__struct_field_names` names a
 * struct project 2 minted and `_owningClassObject` (#5354) would answer with
 * project 1's class-object singleton — are never consulted across projects.
 * Kept for the test262 seam (which retires each row before the next) and for
 * tests that want an empty registry.
 */
export function resetLinkedProjectRegistry(): void {
  _crossModuleStructs.reset();
  _linkedProviderMirrors.reset();
}

// (#1694 A.i / #1632b-1) Per-closure cache of the callable+constructible
// host wrapper produced by `_wrapCallableForHost`, so repeated wraps of the
// same closure return the same Proxy (constructor identity / @@species stays
// stable).
const _hostCallableCache = new WeakMap<object, any>();

/**
 * (#1629 S1) Own-key enumeration for a WasmGC struct, mirroring the union of
 * `__getOwnPropertyNames` (string keys) and `__getOwnPropertySymbols`. Used by
 * `Object.getOwnPropertyDescriptors`, which must visit every own key.
 *
 * `Reflect.ownKeys(_wrapForHost(obj))` can NOT be used here: the host proxy's
 * `ownKeys` trap does not expose the typed WasmGC struct fields (they are only
 * reachable via `_getStructFieldNames` + `__sget_<key>`), so a plain struct
 * would enumerate as `[]`.
 */
/**
 * (#2131) True for a CANONICAL array-index key per ES §6.1.7: a string that
 * is the canonical numeric representation of an integer in [0, 2^32-2]
 * (no leading zeros, no sign, no exponent).
 */
function _isCanonicalArrayIndexKey(k: string): boolean {
  if (k.length === 0 || k.length > 10) return false;
  if (k === "0") return true;
  if (k.charCodeAt(0) === 48) return false; // leading zero → not canonical
  for (let i = 0; i < k.length; i++) {
    const c = k.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  return Number(k) <= 4294967294; // 2^32 - 2
}

/**
 * Resolve the RAW host-visible value of property `key` on a WasmGC struct,
 * applying the same precedence the `_wrapForHost` proxy uses (accessor getter →
 * sidecar → `__sget_` struct-field getter → well-known-symbol sidecar →
 * vivified prototype) but WITHOUT the proxy `get` trap's closure-bridge
 * wrapping. `_wrapForHost` calls this and then applies its bridge on top; other
 * callers (e.g. GetSetRecord, which must distinguish a genuine callable from a
 * non-callable object — #1627) need the unmasked underlying value. Returns
 * `undefined` when nothing resolves.
 */
/**
 * (#3123, ported from the #3049-stack's bridge-exit marshaling — ONLY the
 * function, not the stack's wiring of it into the generic `__call_fn` bridge
 * exits, which regressed ~85 dstr iterator-close files in the parked #2835)
 * Marshal a Wasm-struct value host-usably: vec / data-struct → `_wrapForHost`
 * live mirror; closure struct → cached host-callable wrapper; anything
 * already host-usable passes through untouched. Called exclusively from the
 * fnctor-subclass member resolution below, so every other path keeps its
 * pre-#3123 bytes-for-bytes behavior.
 */
function _marshalBridgeResult(v: any, callbackState?: { getExports: () => Record<string, Function> | undefined }): any {
  if (v == null || typeof v !== "object" || !_isWasmStruct(v)) return v;
  const exports = callbackState?.getExports();
  if (!exports) return v;
  try {
    // Positive data-struct / vec discrimination FIRST (#2794 —
    // `__is_closure` can false-positive on layout-canonicalization
    // collisions; the data/vec markers cannot).
    const isVec = exports.__is_vec as unknown as ((x: any) => number) | undefined;
    if (typeof isVec === "function" && isVec(v) === 1) return _wrapForHost(v, exports);
    const isData = exports.__is_data_struct as unknown as ((x: any) => number) | undefined;
    if (typeof isData === "function" && isData(v) === 1) return _wrapForHost(v, exports);
    const isCl = exports.__is_closure as unknown as ((x: any) => number) | undefined;
    if (typeof isCl === "function" && isCl(v) === 1) {
      return _wrapWasmClosureUnknownArity(v, callbackState) ?? v;
    }
  } catch {
    /* discriminators unavailable — fall through to the generic proxy */
  }
  return _wrapForHost(v, exports);
}

const _resolveClassMember = createClassMemberResolver({
  miss: _MISS,
  canBeWeakKey: _canBeWeakKey,
  // Ordinary compiled classes are WasmGC structs, but unlike fnctor and
  // externref-backed classes they do not need a host-side instance registry:
  // the generated `__member_kind_*`/`__class_call_*` exports positively
  // discriminate their receiver with `ref.test`. Permit that exact carrier
  // through the resolver; otherwise a dynamic `any` call such as Marked's
  // `this.renderer.space(...)` reaches the generic host object and reports
  // "space is not a function" even though the closed bridge is present.
  isRegisteredInstance: (value) => _isWasmStruct(value) || _fnctorInstanceCtor.has(value as object),
  marshalBridgeResult: _marshalBridgeResult,
  // (#5237) No reader: the compiled bridges dispatch on the RAW carrier, so an
  // explicit `this` that arrived as a host mirror must be stripped back to it.
  unwrapReceiver: (value, reader) => _unwrapForHost(value, reader),
});

// (#3673) Hoisted from `_resolveHostField` — was a per-call closure on a hot
// path (invoked for every dynamic field read that reaches the host resolver).
// #1336 — accessor properties (Object.defineProperty(obj, k, {get})) must
// INVOKE the getter, not return a descriptor. #1935 — return `_MISS` ONLY when
// no getter is actually callable; a getter that runs and returns `undefined`
// is a genuine HIT that shadows the field.
function _invokeSidecarGetter(g: any, obj: any, exports: Record<string, Function> | undefined): any {
  if (g == null) return _MISS;
  if (typeof g === "function") return (g as Function).call(obj);
  if (typeof g === "object" && _isWasmStruct(g) && exports) {
    const callFn0 = exports["__call_fn_0"];
    if (typeof callFn0 === "function") return callFn0(g);
  }
  return _MISS;
}

/** Recover primitive values stored in Wasm-native boxed carriers. */
function _nativePrimitiveToHost(value: any, exports: Record<string, Function> | undefined): any | typeof _MISS {
  const stringValue = _nativeStringToHost(value, exports);
  if (stringValue !== _MISS) return stringValue;
  const symbolValue = _nativeSymbolToHost(value, exports);
  if (symbolValue !== _MISS) return symbolValue;
  if (value == null || typeof value !== "object" || !_isWasmStruct(value) || !exports) return _MISS;
  const boundaryTag = exports.__dynamic_boundary_tag as ((value: any) => number) | undefined;
  if (typeof boundaryTag === "function") {
    try {
      const tag = boundaryTag(value);
      if (tag === 1) return null;
      if (tag === 2) return undefined;
    } catch {
      /* try the remaining native carrier families */
    }
  }
  const probes: ReadonlyArray<readonly [string, string, (value: any) => any]> = [
    ["__typeof_number", "__unbox_number", (result) => result],
    ["__typeof_boolean", "__unbox_boolean", (result) => result !== 0],
    ["__typeof_bigint", "__to_bigint", (result) => result],
  ];
  for (const [classifyName, readName, normalize] of probes) {
    const classify = exports[classifyName] as ((value: any) => number) | undefined;
    const read = exports[readName] as ((value: any) => any) | undefined;
    if (typeof classify !== "function" || typeof read !== "function") continue;
    try {
      if (classify(value) === 1) return normalize(read(value));
    } catch {
      /* try the next carrier family */
    }
  }
  return _MISS;
}

/** Present a Wasm-owned `$Promise` as a real JS Promise at the value boundary. */
function _nativePromiseToHost(value: any, exports: Record<string, Function> | undefined): any | typeof _MISS {
  if (value == null || typeof value !== "object" || !_isWasmStruct(value) || !exports) return _MISS;
  const cached = _nativePromiseHostCache.get(value);
  if (cached) return cached;
  const readState = exports.__promise_boundary_state as ((value: any) => number) | undefined;
  const readValue = exports.__promise_boundary_value as ((value: any) => any) | undefined;
  if (typeof readState !== "function" || typeof readValue !== "function") return _MISS;
  try {
    if (readState(value) < 0) return _MISS;
  } catch {
    return _MISS;
  }

  let resolveHost!: (value: unknown) => void;
  let rejectHost!: (reason: unknown) => void;
  const hostPromise = new Promise<unknown>((resolve, reject) => {
    resolveHost = resolve;
    rejectHost = reject;
  });
  _nativePromiseHostCache.set(value, hostPromise);
  _hostProxyReverse.set(hostPromise, value);

  try {
    const observe = exports.__promise_boundary_observe as ((value: any, id: number) => number) | undefined;
    if (typeof observe === "function") {
      const state = _nativeBoundaryPromiseState(exports);
      const id = state.nextId++;
      state.observers.set(id, { resolve: resolveHost, reject: rejectHost });
      if (observe(value, id) !== 1) {
        state.observers.delete(id);
        rejectHost(new TypeError("native Promise boundary observer rejected a non-Promise value"));
      } else {
        const drain = exports.__drain_microtasks as (() => void) | undefined;
        if (typeof drain === "function") drain();
      }
      return hostPromise;
    }
    const drain = exports.__drain_microtasks as (() => void) | undefined;
    if (typeof drain === "function") drain();
    const state = readState(value);
    if (state === 1) resolveHost(_nativeBoundaryToHost(readValue(value), exports));
    else if (state === 2) rejectHost(_nativeBoundaryToHost(readValue(value), exports));
    // A still-pending native Promise remains pending. Platform-driven native
    // settlement needs an explicit subscription ABI; do not simulate it with
    // ambient timers or a host-side semantic Promise chain.
  } catch (error) {
    rejectHost(error);
  }
  return hostPromise;
}

/** Translate a Wasm-owned `$Error_struct` into a real JS Error boundary view. */
function _nativeErrorToHost(value: any, exports: Record<string, Function> | undefined): any | typeof _MISS {
  if (value == null || typeof value !== "object" || !_isWasmStruct(value) || !exports) return _MISS;
  const cached = _nativeErrorHostCache.get(value);
  if (cached) return cached;
  const isNative = exports.__error_boundary_is_native as ((value: any) => number) | undefined;
  const readName = exports.__error_boundary_name as ((value: any) => any) | undefined;
  const readMessage = exports.__error_boundary_message as ((value: any) => any) | undefined;
  if (typeof isNative !== "function" || typeof readName !== "function" || typeof readMessage !== "function") {
    return _MISS;
  }
  try {
    if (isNative(value) !== 1) return _MISS;
    const rawName = readName(value);
    const rawMessage = readMessage(value);
    const convertedName = _nativeStringToHost(rawName, exports);
    const convertedMessage = _nativeStringToHost(rawMessage, exports);
    const name = convertedName === _MISS ? "Error" : String(convertedName);
    const message = convertedMessage === _MISS ? undefined : String(convertedMessage);
    const constructors: Record<string, new (message?: string) => Error> = {
      Error,
      EvalError,
      RangeError,
      ReferenceError,
      SyntaxError,
      TypeError,
      URIError,
    };
    let result: Error;
    if (name === "AggregateError" && typeof AggregateError === "function") {
      result = message === undefined ? new AggregateError([]) : new AggregateError([], message);
    } else {
      const ErrorCtor = constructors[name] ?? Error;
      result = message === undefined ? new ErrorCtor() : new ErrorCtor(message);
      if (!(name in constructors)) result.name = name;
    }
    _nativeErrorHostCache.set(value, result);
    _hostProxyReverse.set(result, value);
    return result;
  } catch {
    return _MISS;
  }
}

function _isNativeOpenObject(value: any, exports: Record<string, Function> | undefined): boolean {
  const classify = exports?.__object_is_native_open as ((value: any) => number) | undefined;
  if (typeof classify !== "function") return false;
  try {
    return classify(value) === 1;
  } catch {
    return false;
  }
}

function _nativeBoundaryKey(key: string | number, exports: Record<string, Function>): any {
  const fromHost = exports.__str_from_extern as ((value: string) => any) | undefined;
  return typeof fromHost === "function" ? fromHost(String(key)) : String(key);
}

function _nativeBoundaryValue(value: any, exports: Record<string, Function>): any {
  const raw = _unwrapForHost(value);
  const fromHost = exports.__str_from_extern as ((value: string) => any) | undefined;
  return typeof raw === "string" && typeof fromHost === "function" ? fromHost(raw) : raw;
}

function _nativeBoundaryAuthority(exports: Record<string, Function>): object {
  const helper = exports.__dynamic_boundary_tag ?? exports.__str_from_extern ?? exports.__symbol_boundary_is_native;
  return (typeof helper === "function" ? helper : exports) as object;
}

function _nativeBoundarySymbolState(exports: Record<string, Function>): NativeBoundarySymbolState {
  const authority = _nativeBoundaryAuthority(exports);
  let state = _nativeBoundarySymbols.get(authority);
  if (!state) {
    state = { byId: new Map<number, symbol>(), byHost: new Map<symbol, number>() };
    _nativeBoundarySymbols.set(authority, state);
  }
  return state;
}

function _nativeBoundaryPromiseState(exports: Record<string, Function>): NativeBoundaryPromiseState {
  const authority = _nativeBoundaryAuthority(exports);
  let state = _nativeBoundaryPromises.get(authority);
  if (!state) {
    state = { nextId: 1, observers: new Map() };
    _nativeBoundaryPromises.set(authority, state);
  }
  return state;
}

function _nativeSymbolFromId(id: number, exports: Record<string, Function>): symbol | typeof _MISS {
  const state = _nativeBoundarySymbolState(exports);
  const cached = state.byId.get(id);
  if (cached !== undefined) return cached;

  const wellKnown = _symbolIdToKeys.get(id)?.sym;
  if (wellKnown !== undefined) {
    state.byId.set(id, wellKnown);
    state.byHost.set(wellKnown, id);
    return wellKnown;
  }

  const keyFor = exports.__symbol_boundary_key_for as ((id: number) => any) | undefined;
  const description = exports.__symbol_boundary_description as ((id: number) => any) | undefined;
  if (typeof keyFor !== "function" || typeof description !== "function") return _MISS;
  try {
    const keyValue = _nativeStringToHost(keyFor(id), exports);
    const symbolValue =
      keyValue !== _MISS
        ? Symbol.for(String(keyValue))
        : (() => {
            const descriptionValue = _nativeStringToHost(description(id), exports);
            return descriptionValue === _MISS ? Symbol() : Symbol(String(descriptionValue));
          })();
    state.byId.set(id, symbolValue);
    state.byHost.set(symbolValue, id);
    return symbolValue;
  } catch {
    return _MISS;
  }
}

function _nativeSymbolToHost(value: any, exports: Record<string, Function> | undefined): symbol | typeof _MISS {
  if (value == null || typeof value !== "object" || !_isWasmStruct(value) || !exports) return _MISS;
  const isNative = exports.__symbol_boundary_is_native as ((value: any) => number) | undefined;
  const readId = exports.__symbol_boundary_id as ((value: any) => number) | undefined;
  if (typeof isNative !== "function" || typeof readId !== "function") return _MISS;
  try {
    return isNative(value) === 1 ? _nativeSymbolFromId(readId(value), exports) : _MISS;
  } catch {
    return _MISS;
  }
}

function _nativeSymbolIdFromHost(value: any, exports: Record<string, Function>): number | typeof _MISS {
  const raw = _unwrapForHost(value);
  if (typeof raw !== "symbol") return _MISS;
  const state = _nativeBoundarySymbolState(exports);
  const cached = state.byHost.get(raw);
  if (cached !== undefined) return cached;

  for (const [id, entry] of _symbolIdToKeys) {
    if (entry.sym === raw) {
      state.byHost.set(raw, id);
      state.byId.set(id, raw);
      return id;
    }
  }

  const fromHostString = exports.__str_from_extern as ((value: string) => any) | undefined;
  const symbolFor = exports.__symbol_boundary_for as ((key: any) => number) | undefined;
  const symbolNew = exports.__symbol_boundary_new as ((description: any) => number) | undefined;
  if (typeof fromHostString !== "function" || typeof symbolFor !== "function" || typeof symbolNew !== "function") {
    return _MISS;
  }
  try {
    const registryKey = Symbol.keyFor(raw);
    const id =
      registryKey !== undefined
        ? symbolFor(fromHostString(registryKey))
        : symbolNew(raw.description === undefined ? null : fromHostString(raw.description));
    state.byHost.set(raw, id);
    state.byId.set(id, raw);
    return id;
  } catch {
    return _MISS;
  }
}

/** Per-instance authority for the JS-owned objects admitted at its boundary. */
function _nativeBoundaryHostObjectSet(exports: Record<string, Function>): WeakSet<object> {
  // Export views may be distinct wrapper objects. A generated function is a
  // stable, instance-unique identity shared by both the wrapper and imports.
  const authority = _nativeBoundaryAuthority(exports);
  let objects = _nativeBoundaryHostObjects.get(authority);
  if (!objects) {
    objects = new WeakSet<object>();
    _nativeBoundaryHostObjects.set(authority, objects);
  }
  return objects;
}

/** Adapt a JS primitive into the native carrier used by an `any`/`unknown` slot. */
function _nativeDynamicFromHost(value: any, exports: Record<string, Function>): any {
  const raw = _unwrapForHost(value);
  if (raw === null) {
    const box = exports.__any_box_null as (() => any) | undefined;
    return typeof box === "function" ? box() : raw;
  }
  if (raw === undefined) {
    const box = exports.__any_box_undefined as (() => any) | undefined;
    return typeof box === "function" ? box() : raw;
  }
  if (typeof raw === "string") {
    const box = exports.__str_from_extern as ((value: string) => any) | undefined;
    return typeof box === "function" ? box(raw) : raw;
  }
  if (typeof raw === "number") {
    const box = exports.__box_number as ((value: number) => any) | undefined;
    return typeof box === "function" ? box(raw) : raw;
  }
  if (typeof raw === "boolean") {
    const box = exports.__box_boolean as ((value: number) => any) | undefined;
    return typeof box === "function" ? box(raw ? 1 : 0) : raw;
  }
  if (typeof raw === "bigint") {
    const box = exports.__box_bigint as ((value: bigint) => any) | undefined;
    return typeof box === "function" ? box(raw) : raw;
  }
  if (typeof raw === "symbol") {
    const id = _nativeSymbolIdFromHost(raw, exports);
    const box = exports.__box_symbol as ((id: number) => any) | undefined;
    return id !== _MISS && typeof box === "function" ? box(id) : raw;
  }
  if ((typeof raw === "object" && raw !== null) || typeof raw === "function") {
    if (!_isWasmStruct(raw)) _nativeBoundaryHostObjectSet(exports).add(raw);
  }
  return raw;
}

/** Convert one native boundary carrier into its JS-side value/view. */
function _nativeBoundaryToHost(value: any, exports: Record<string, Function>): any {
  const primitive = _nativePrimitiveToHost(value, exports);
  return primitive !== _MISS ? primitive : _isWasmStruct(value) ? _wrapForHost(value, exports) : _unwrapForHost(value);
}

/** Materialize host-produced boundary keys into the native dynamic vector. */
function _nativeBoundaryVector(values: readonly any[], exports: Record<string, Function>): any {
  const create = exports.__objvec_new as (() => any) | undefined;
  const push = exports.__objvec_push as ((vec: any, value: any) => void) | undefined;
  if (typeof create !== "function" || typeof push !== "function") {
    return _nativeDynamicFromHost(Array.from(values), exports);
  }
  const vec = create();
  for (const value of values) push(vec, _nativeDynamicFromHost(value, exports));
  return vec;
}

function _nativeOpenObjectKeys(obj: any, exports: Record<string, Function> | undefined): string[] {
  if (!exports || !(_isNativeOpenObject(obj, exports) || isNativeRegimeExports(exports))) return [];
  const keys = exports.__object_keys as ((value: any) => any) | undefined;
  if (typeof keys !== "function") return [];
  try {
    const view = _wrapForHost(keys(obj), exports);
    if (!_nativeIsArray(view)) return [];
    const out: string[] = [];
    for (const key of view) if (typeof key === "string") out.push(key);
    return out;
  } catch {
    return [];
  }
}

function _resolveHostField(obj: any, key: any, exports: Record<string, Function> | undefined): any {
  // #1336 / #1935 — see `_invokeSidecarGetter` above.
  if (typeof key === "string") {
    const wasmSc = _wasmStructProps.get(obj);
    const getter = wasmSc?.[`__get_${key}` as string];
    if (getter !== undefined) {
      const v = _invokeSidecarGetter(getter, obj, exports);
      if (v !== _MISS) return v;
    }
  } else if (typeof key === "symbol") {
    const accessor = _wasmStructAccessors.get(obj)?.get(key);
    if (accessor?.get !== undefined) {
      const v = _invokeSidecarGetter(accessor.get, obj, exports);
      if (v !== _MISS) return v;
    }
  }
  // Sidecar first (handles both string and symbol keys)
  const sc = _sidecarGet(obj, key);
  if (sc !== undefined) return sc;
  // An open `$Object`'s source properties live in its native MOP, never in its
  // physical Wasm struct fields. Consult that MOP before the per-shape
  // `__sget_<name>` family: numeric typed getters use `0` as their shape-miss
  // default, so a module that also contains a closed `{ value: number }` shape
  // could otherwise mask a real `$Object.value` with a false `0` hit. This also
  // keeps `$Object`'s implementation fields permanently outside the boundary
  // surface.
  if (exports && (typeof key === "string" || typeof key === "number") && _isNativeOpenObject(obj, exports)) {
    const get = exports.__extern_get as ((value: any, key: any) => any) | undefined;
    if (typeof get === "function") {
      try {
        return get(obj, _nativeBoundaryKey(key, exports));
      } catch {
        /* fall through to prototype lookup */
      }
    }
  }
  // Wasm struct field getter
  if (exports && (typeof key === "string" || typeof key === "number")) {
    const getter = exports[`__sget_${String(key)}`];
    if (typeof getter === "function") {
      try {
        // (#1712) Treat a nullish result as a MISS, not a hit: the
        // __sget_<name> per-shape dispatcher yields null/undefined when the
        // receiver's struct shape doesn't carry the field at all.
        const v = getter(obj);
        // (#5250) `0` is the shape-MISS default of a NUMERIC `__sget_<name>`
        // exactly as `null` is for a ref-typed one, and the getter is
        // module-GLOBAL — so one unrelated `{ month: 11 }` literal anywhere in
        // the program made `month` read as a present `0` on EVERY struct here
        // (and, since this resolver backs the host proxy's `has` trap, made
        // `"month" in { year: 1994 }` true). Gate the miss-shaped values on
        // the single-key field-name registry, and only when it positively says
        // absent, so every other read keeps its old cost and answer. The
        // `false` arm is defensive, not measured. Full measurement + controls:
        // tests/issue-5250-sget-numeric-shape-miss.test.ts.
        if (v !== undefined && v !== null) {
          if ((v === 0 || v === false) && _structOwnFieldStatus(obj, String(key), exports) === false) {
            // Shape miss: fall through to the prototype / sidecar walk below.
          } else {
            return v;
          }
        }
        // (#3051 Slice 3) `null` disambiguation: a compiled `null` literal is
        // stored as ref.null (reads back `null` — same as the dispatcher's
        // shape-miss), while compiled `undefined` is the distinguished host
        // undefined. When the receiver's OWN struct shape carries the field,
        // a `null` read is the REAL stored value, not a miss — e.g. the exec
        // result `{ groups: null }` must expose `groups === null` so V8's
        // @@replace step 14.j/l `ToObject(namedCaptures)` throws the
        // spec-mandated TypeError (result-coerce-groups-err). Shape check only
        // on the rare null path — the common hit path above is unchanged.
        if (v === null) {
          const fieldNames = _getStructFieldNames(obj, exports);
          if (fieldNames !== null && fieldNames.includes(String(key))) return null;
        }
      } catch {
        /* not a field of this struct type */
      }
    }
  }
  // Well-known symbol → @@name sidecar fallback (#1443).
  if (typeof key === "symbol") {
    const wasmKey = _symbolToWasm.get(key);
    if (wasmKey !== undefined) {
      const v = _sidecarGet(obj, wasmKey);
      if (v !== undefined) return v;
      // (#3123) Computed well-known-symbol LITERAL property → typed struct
      // FIELD named "@@<name>" — read via the per-shape `__sget_@@<name>`
      // getter (see the matching arm in `_safeGet`). Makes a non-callable
      // `{ [Symbol.iterator]: 0 }` observable so native GetMethod throws.
      const fieldGetter = exports?.[`__sget_${wasmKey}`];
      if (typeof fieldGetter === "function") {
        try {
          const fv = fieldGetter(obj);
          if (fv !== undefined && fv !== null) return fv;
        } catch {
          /* not a field of this struct shape */
        }
      }
    }
  }
  // (#3123) Compiled class methods/getters on a registered fnctor-subclass
  // instance — the own-C.prototype level, which must SHADOW the fnctor
  // parent's prototype chain below.
  {
    const v = _resolveClassMember(obj, key, exports);
    if (v !== _MISS) return v;
  }
  const bagValue = readNativeRegimeBag(obj, key, exports, _nativeBoundaryKey, _nativePrimitiveToHost); // (#6879)
  if (bagValue !== undefined) return bagValue;
  // (#1712) fnctor instances: resolve through the constructor's vivified
  // prototype object. Accessors run with the live-mirror proxy as the receiver.
  const protoDesc = _fnctorProtoLookup(obj, key, exports);
  if (protoDesc) {
    if (readEnv("DEBUG_1712"))
      console.error(
        "[protoHook]",
        String(key),
        "valType=",
        typeof protoDesc.value,
        "exports?",
        exports != null,
        "is_closure?",
        typeof exports?.__is_closure,
      );
    if (protoDesc.get) return protoDesc.get.call(_hostProxyCache.get(obj) ?? obj);
    return _maybeWrapCallableUnknownArity(protoDesc.value, { getExports: () => exports });
  }
  return undefined;
}

/**
 * (#5209) Get-or-create the ONE live export slot for a struct-backed host view.
 *
 * Views are cached for the lifetime of the struct but the export object is not
 * available for the whole of module init (see `init-marshal-registry.ts`), so a
 * view must never capture the export set it was born with. Sharing the slot via
 * `_hostProxyExportSlots` also means the refresh `_wrapForHost` already performs
 * on a cache hit upgrades every view of that struct at once.
 *
 * Created BEFORE any view is built and cached, so a view materialized during
 * module init from the partial, `ref.func`-registered helper set upgrades itself
 * as soon as a later wrap of the same struct carries the real exports.
 */
function _exportSlotFor(
  obj: object,
  exports: Record<string, Function> | undefined,
): { current: Record<string, Function> | undefined } {
  const existing = _hostProxyExportSlots.get(obj);
  if (existing) {
    if (exports !== undefined) existing.current = exports;
    return existing;
  }
  const slot = { current: exports };
  _hostProxyExportSlots.set(obj, slot);
  return slot;
}

// Present a WasmGC vec through a live real-array Proxy (#2801).
//
// (#5209) Exports arrive through a LIVE SLOT, never a captured snapshot. The
// view is cached for the lifetime of the vec, so a view built during module
// init — where the only readable exports are the six `ref.func` marshalling
// helpers the module registers on itself (#5193) — would otherwise stay stuck
// with that partial set forever, even after `setInstance` publishes the real
// export object. `_wrapForHost` owns the slot and refreshes it on every later
// wrap of the same struct.
function _wrapVecForHost(vec: any, exportSlot: { current: Record<string, Function> | undefined }): any {
  const cached = _hostProxyCache.get(vec);
  if (cached) return cached;
  const readExports = (): Record<string, Function> | undefined => exportSlot.current;
  const exports0 = exportSlot.current;
  const lenFn = exports0?.__vec_len as ((v: any) => number) | undefined;
  const getFn = exports0?.__vec_get as ((v: any, i: number) => any) | undefined;
  // Defensive: if the read exports are missing, fall back to the generic
  // object proxy rather than producing a broken array view.
  if (typeof lenFn !== "function" || typeof getFn !== "function") return undefined;
  // Keep the target's non-configurable length aligned with the live vec.
  const target: any[] = [];
  const liveLen = (): number => {
    try {
      const n = lenFn(vec);
      const len = typeof n === "number" && n >= 0 ? n : 0;
      if (target.length !== len) target.length = len;
      return len;
    } catch {
      if (target.length !== 0) target.length = 0;
      return 0;
    }
  };
  const elemAt = (i: number): any => {
    try {
      return _wrapForHost(getFn(vec, i), readExports());
    } catch {
      return undefined;
    }
  };
  const rawDesc = (key: string | symbol): PropertyDescriptor | undefined => _readOwnDescriptor(vec, key, readExports());
  const hostDesc = (key: string | symbol): PropertyDescriptor | undefined => {
    const desc = rawDesc(key);
    if (!desc) return undefined;
    if ("value" in desc) desc.value = _wrapForHost(desc.value, readExports());
    return desc;
  };
  const materializeNonConfigurable = (key: string | symbol, desc: PropertyDescriptor | undefined): void => {
    if (!desc || desc.configurable !== false) return;
    try {
      Object.defineProperty(target, key, desc);
    } catch {
      /* The target may already carry the matching non-configurable slot. */
    }
  };
  liveLen();
  // (#3201) Expando sidecar lookup. Compiled writes of non-index properties
  // onto a vec (`arr.getClass = Object.prototype.toString;` — the Sputnik
  // classifier idiom, 65+ test262 files across splice/slice/concat) land in
  // `_wasmStructProps` keyed by the RAW vec struct via `__extern_set*` →
  // `_safeSet`. The array-backed view must surface them: an own expando
  // shadows `Array.prototype` per ordinary property lookup order. Values were
  // callable-wrapped at write time (`_maybeWrapCallableUnknownArity`); a raw
  // struct value read back is defensively host-wrapped.
  const sidecarGet = (key: string | symbol): { hit: boolean; value?: any } => {
    const sc = _wasmStructProps.get(vec);
    if (!sc || !(key in sc)) return { hit: false };
    const val = (sc as Record<string | symbol, any>)[key as any];
    if (val != null && typeof val === "object" && _isWasmStruct(val)) {
      // A closure struct stored BEFORE setExports (module-init writes run
      // during instantiation) could not be callable-wrapped at write time —
      // wrap at read time, when the exports exist. Mirrors
      // `__extern_method_call`'s wrapHostValue.
      const callable = _maybeWrapCallableUnknownArity(val, { getExports: readExports });
      if (callable !== val) return { hit: true, value: callable };
      return { hit: true, value: _wrapForHost(val, readExports()) };
    }
    return { hit: true, value: val };
  };
  const handler: ProxyHandler<any[]> = {
    get(_t, key) {
      if (key === "length") return liveLen();
      if (typeof key === "string") {
        const idx = _asArrayIndex(key);
        if (idx !== undefined) {
          return idx < liveLen() ? elemAt(idx) : undefined;
        }
      }
      const sc = sidecarGet(key);
      if (sc.hit) return sc.value;
      // Array.prototype methods, Symbol.iterator, constructor, etc. — read from
      // the array target; native generics operate via the length/index traps.
      return (target as Record<string | symbol, any>)[key as any];
    },
    has(_t, key) {
      if (key === "length") return true;
      if (typeof key === "string") {
        const idx = _asArrayIndex(key);
        if (idx !== undefined) return idx < liveLen();
      }
      if (sidecarGet(key).hit) return true;
      return key in target;
    },
    ownKeys() {
      return wasmVecOwnKeys(_wasmSidecars, vec, target, liveLen(), false, rawDesc);
    },
    getOwnPropertyDescriptor(_t, key) {
      if (key === "length") {
        return { value: liveLen(), writable: true, enumerable: false, configurable: false };
      }
      if (typeof key === "string") {
        const idx = _asArrayIndex(key);
        if (idx !== undefined && idx < liveLen()) {
          return { value: elemAt(idx), writable: true, enumerable: true, configurable: true };
        }
      }
      return (
        wasmVecSidecarDescriptor(_wasmSidecars, vec, key, hostDesc, materializeNonConfigurable) ??
        Reflect.getOwnPropertyDescriptor(_t, key)
      );
    },
    defineProperty(_t, key, descriptor) {
      return Reflect.defineProperty(_t, key, descriptor);
    },
    deleteProperty(_t, key) {
      return Reflect.deleteProperty(_t, key);
    },
    // Keep the array facade live in both directions. The target stays a shape
    // facade; values and length are written through the generated vec bridge so
    // JS mutation is immediately visible to compiled code and identity never
    // moves to a copied mirror.
    set(_t, key, value) {
      if (key === "length") {
        const next = Number(value);
        const uint32 = next >>> 0;
        if (next !== uint32) throw new RangeError("Invalid array length");
        const setLen = readExports()?.__vec_set_len as ((v: any, n: number) => number) | undefined;
        return typeof setLen === "function" && setLen(vec, uint32) === 1;
      }
      if (typeof key === "string" && _asArrayIndex(key) !== undefined) {
        return _trySetWasmVecElement(vec, key, value, readExports());
      }
      _safeSet(vec, key, value, readExports());
      return true;
    },
  };
  const proxy = new Proxy(target, handler);
  _hostProxyCache.set(vec, proxy);
  _hostProxyReverse.set(proxy, vec);
  _linkedProviderMirrors.recordMirrorOwner(proxy, readExports()); // (#5222)
  return proxy;
}

// (#2841) Present a REAL host JS array (not a wasm vec) that may hold RAW
// wasm-struct elements as an array whose elements are `_wrapForHost`-wrapped on
// read. Root cause: when a wasm vec crosses a dynamic-dispatch boundary as an
// `any` argument, the host shim `__make_iterable` materialises it into a real
// JS array of OPAQUE wasm structs (#2836). When such an array is then read back
// as a struct field (acorn arrow-fn `node.params` — the paren `exprList` is
// passed to `parseArrowExpression` indirectly, so the param list is this host
// array, not a wasm vec), the `_wrapForHost` proxy returned it RAW, so its
// Identifier elements stayed opaque and `param.type` / `param.name` read back
// `undefined`. Decl / fn-expr params take the `parseBindingList` path and stay a
// genuine wasm vec (routed to `_wrapVecForHost`, which wraps elements), so only
// ARROW params were affected. This view wraps each struct element lazily on
// index read (mirroring `_wrapVecForHost`); primitives and already-plain
// elements pass through. The proxy target is a real `[]`-backed array so
// `Array.isArray` holds and native Array.prototype methods / iteration work via
// the index trap. Cached so repeated `node.params` reads keep identity.
function _wrapHostArrayElems(arr: any[], exports: Record<string, Function> | undefined): any[] {
  const cached = _hostProxyCache.get(arr);
  if (cached) return cached;
  const wrapElem = (el: any): any =>
    el != null && typeof el === "object" && _isWasmStruct(el) ? _wrapForHost(el, exports) : el;
  const handler: ProxyHandler<any[]> = {
    get(target, key) {
      if (typeof key === "string") {
        const idx = _asArrayIndex(key);
        if (idx !== undefined) return wrapElem(target[idx]);
      }
      return (target as Record<string | symbol, any>)[key as any];
    },
    getOwnPropertyDescriptor(target, key) {
      const desc = Object.getOwnPropertyDescriptor(target, key);
      if (desc && typeof key === "string" && _asArrayIndex(key) !== undefined && "value" in desc) {
        desc.value = wrapElem(desc.value);
      }
      return desc;
    },
  };
  const proxy = new Proxy(arr, handler);
  _hostProxyCache.set(arr, proxy);
  return proxy;
}

/**
 * Live-mirror Proxy over a WasmGC struct (#983).
 *
 * Host-side APIs like Array.prototype.X.call(arrayLike, …) and Object.assign
 * read/write `.length`, numeric indices and named fields on caller-supplied
 * objects. WasmGC structs are opaque to JS and those accesses throw
 * "WebAssembly objects are opaque". _wrapForHost returns a JS Proxy that
 * routes every trap through the existing sidecar infrastructure
 * (_sidecarGet/_sidecarSet) and the compiled-module __sget_* exports. This
 * lets host methods both read and WRITE through to the same WasmGC struct
 * that the test body observes via compiled __extern_get.
 *
 * Identity caveat: the proxy is a different JS object than the wasmGC
 * handle. Callers that care about identity (e.g. Object.assign returning
 * target) must use _unwrapForHost on the return value before handing it
 * back to the caller.
 */
function _wrapForHost(obj: any, exports: Record<string, Function> | undefined): any {
  if (obj == null || typeof obj !== "object") return obj;
  if (!_isWasmStruct(obj)) return obj;
  // (#5225) A struct minted by another module of this linked project must be
  // mirrored against the exports that can DECODE it, not against whichever
  // module happens to be reading. Every trap below (field reads, key
  // enumeration, callable members) resolves through these exports.
  exports = _decoderExportsFor(obj, exports);
  const primitiveValue = _nativePrimitiveToHost(obj, exports);
  if (primitiveValue !== _MISS) return primitiveValue;
  const errorValue = _nativeErrorToHost(obj, exports);
  if (errorValue !== _MISS) return errorValue;
  const promiseValue = _nativePromiseToHost(obj, exports);
  if (promiseValue !== _MISS) return promiseValue;
  const cached = _hostProxyCache.get(obj);
  if (cached) {
    const slot = _hostProxyExportSlots.get(obj);
    if (slot && exports !== undefined) slot.current = exports;
    return cached;
  }

  const exportSlot = _exportSlotFor(obj, exports); // (#5209) live, shared, refreshed

  // (#2801) A WasmGC vec must present to the host as a real JS array, not a
  // generic object proxy (which marshalled as `{}`). Detect via the positive
  // `__is_vec` discriminator and route to the array-backed view. Done before
  // the generic-proxy path so every consumer (struct field reads, set-algebra
  // adapters, spread) sees array semantics uniformly.
  if (exports) {
    try {
      const isVecFn = exports.__is_vec as ((v: any) => number) | undefined;
      if (typeof isVecFn === "function" && isVecFn(obj) === 1) {
        const vecView = _wrapVecForHost(obj, exportSlot);
        if (vecView !== undefined) return vecView;
      }
    } catch {
      // discriminator unavailable — fall through to the generic object proxy
    }
  }

  // (#4536) A TUPLE struct (compiler-owned `_0`,`_1`,… fields — e.g. the JSDoc
  // `[T[], T[]]` groupBy accumulator in webpack's ArrayHelpers) must present to
  // the host as a real JS array as well: Array.isArray / deep-equality walks
  // (upstream toStrictEqual shims) otherwise see `{_0:…,_1:…}` and fail.
  // Elements are wrapped like any other boundary value. Slot writes through
  // this array are NOT written back (same snapshot semantics as
  // _convertIterableForHost's #1438 tuple arm); nested mutations of the
  // wrapped elements still land on the underlying values.
  if (exports) {
    const tupleNames = _getStructFieldNames(obj, exports);
    if (tupleNames && tupleNames.length > 0 && tupleNames.every((n) => /^_\d+$/.test(n))) {
      const tupleArr: any[] = new Array(tupleNames.length);
      _hostProxyCache.set(obj, tupleArr);
      for (let i = 0; i < tupleNames.length; i++) {
        const getter = exports[`__sget_${tupleNames[i]}`] as Function | undefined;
        tupleArr[i] = getter ? _wrapForHost(getter(obj), exports) : undefined;
      }
      return tupleArr;
    }
  }

  const target: Record<string | symbol, any> = Object.create(null);
  const currentExports = (): Record<string, Function> | undefined => exportSlot.current;

  // (#1627) Resolution precedence lives in the module-level `_resolveHostField`
  // so callers that need the unmasked raw value (GetSetRecord) can reuse it.
  const safeGetField = (key: any): any => _resolveHostField(obj, key, currentExports());

  const isTombstoned = (key: string | symbol): boolean => {
    const tombstones = _wasmStructDeletedKeys.get(obj);
    return !!tombstones && tombstones.has(typeof key === "symbol" ? key : String(key));
  };

  const fieldNamesForHost = (): string[] => {
    const liveExports = currentExports();
    const names = _getStructFieldNames(obj, liveExports) ?? [];
    for (const key of _nativeOpenObjectKeys(obj, liveExports)) {
      if (!names.includes(key)) names.push(key);
    }
    return names.filter((name) => !isTombstoned(name));
  };

  const collectKeys = (): (string | symbol)[] => {
    const keys = new Set<string | symbol>();
    const fieldNames = fieldNamesForHost();
    for (const k of fieldNames) keys.add(k);
    const sc = _wasmStructProps.get(obj);
    if (sc) {
      for (const k of Object.getOwnPropertyNames(sc)) {
        if (isTombstoned(k)) continue;
        // #1336 — `__get_x` / `__set_x` are accessor descriptor entries; they
        // must NOT enumerate as own keys. Surface the underlying property name
        // (`x`) instead so Object.assign / spread copy honours the accessor.
        if (k.startsWith("__get_")) {
          keys.add(k.slice("__get_".length));
        } else if (k.startsWith("__set_")) {
          keys.add(k.slice("__set_".length));
        } else {
          keys.add(k);
        }
      }
      for (const k of Object.getOwnPropertySymbols(sc)) {
        if (!isTombstoned(k)) keys.add(k);
      }
    }
    // #1336 — Symbol-keyed accessors (set via Object.defineProperty with a
    // Symbol property name) live in `_wasmStructAccessors`, not `_wasmStructProps`.
    const accMap = _wasmStructAccessors.get(obj);
    if (accMap) {
      for (const k of accMap.keys()) {
        if (!isTombstoned(k)) keys.add(k);
      }
    }
    return Array.from(keys);
  };

  const handler: ProxyHandler<any> = {
    get(_t, key) {
      // (#4618) Once preventExtensions materialized the key set onto the
      // target (React dev's Object.freeze(element)), §10.5.8 requires [[Get]]
      // to return SameValue as the target's non-configurable non-writable
      // data property. Re-deriving the value below can mint a FRESH wrapper
      // each read, which fails SameValue — serve the locked target's own
      // value verbatim (prototype/dynamic keys still fall through).
      if (!Reflect.isExtensible(_t)) {
        const lockedDesc = Reflect.getOwnPropertyDescriptor(_t, key);
        if (lockedDesc !== undefined && "value" in lockedDesc) return lockedDesc.value;
      }
      const val = safeGetField(key);
      const primitiveValue = _nativePrimitiveToHost(val, currentExports());
      if (primitiveValue !== _MISS) return primitiveValue;
      if (readEnv("JS2WASM_DEBUG_3051")) {
        console.error(
          "[3051] proxy.get",
          String(key),
          "->",
          val === null ? "null" : typeof val,
          val != null && typeof val === "object" && _isWasmStruct(val) ? "(struct)" : "",
        );
      }
      // If val is a wasmGC closure struct (method stored as a field), wrap
      // it in a JS function that dispatches via the compiled __call_<name>
      // export so JS callers (including native ToPrimitive / Array built-ins)
      // can invoke it. Without this, JS sees `typeof val === "object"` and
      // ToPrimitive fails with "Cannot convert object to primitive value".
      const liveExports = currentExports();
      if (val != null && typeof val === "object" && _isWasmStruct(val) && liveExports) {
        // (#1712) Vec structs are DATA, never callables — wrapping one in the
        // closureBridge below made acorn's `this.scopeStack` field read return
        // a JS function, so `scopeStack.push(…)` threw "push is not a
        // function". `__is_vec` is the positive discriminator (`__is_closure`
        // can false-positive on layout-canonicalization collisions).
        try {
          const isVecFn = liveExports.__is_vec as ((v: any) => number) | undefined;
          if (typeof isVecFn === "function" && isVecFn(val) === 1) {
            return _wrapForHost(val, liveExports);
          }
        } catch {
          // fall through to the closure-bridge heuristics
        }
        // (#2794) Positive data-vs-closure discriminator. A struct field VALUE
        // that is a registered DATA struct (AST Node, class instance, object
        // literal) must be presented as an OBJECT proxy, not masked as a callable
        // `closureBridge` just because the module exports generic `__call_fn_N`
        // dispatchers. Without this, acorn's `decl.id` (an Identifier Node) read
        // back through this proxy arrived in `checkLValSimple` as a closureBridge
        // function (`expr.type === undefined`) and every var-declaration parse
        // threw "Binding rvalue". `__is_data_struct` is a POSITIVE marker (no
        // false-negative failure mode, unlike `__is_closure`): closure wrapper
        // structs are never in the data-struct set, so a genuine closure answers
        // 0 here and still reaches the bridge paths below.
        try {
          const isDataFn = liveExports.__is_data_struct as ((v: any) => number) | undefined;
          if (typeof isDataFn === "function" && isDataFn(val) === 1) {
            return _wrapForHost(val, liveExports);
          }
        } catch {
          // discriminator unavailable — fall through to the closure-bridge heuristics
        }
        // Resolve the export key — for string keys use directly, for well-known
        // symbols use the @@name form (e.g. Symbol.toPrimitive → "@@toPrimitive") (#1090)
        const exportKey = typeof key === "string" ? key : typeof key === "symbol" ? _symbolToWasm.get(key) : undefined;
        // (#3051 Slice 3) A closure struct that CARRIES its own properties —
        // sidecar entries beyond the codegen's name/length meta stamps, or
        // symbol-keyed accessors — must be presented as the full callable host
        // mirror (`_wrapCallableForHost`), not the property-less closureBridge
        // below. The canonical case is the @@split species protocol: the test
        // stores `rx.constructor = function(){}` (raw closure in the sidecar)
        // then `rx.constructor[Symbol.species] = fn` (symbol prop on the
        // closure's OWN sidecar). V8's SpeciesConstructor does
        // `Get(C, @@species)` on the value it read from `rx.constructor`; the
        // bare bridge hid the sidecar, so the species silently defaulted to
        // %RegExp% and `new RegExp(<opaque rx proxy>)` threw "Cannot convert
        // object to primitive value". The callable mirror delegates property
        // reads to `_wrapForHost(closure)` (sidecar-aware), is constructible
        // ([[Construct]] trap), and is identity-cached per closure.
        {
          const scOwn = _wasmStructProps.get(val);
          let carriesOwnProps = _wasmStructAccessors.has(val);
          if (!carriesOwnProps && scOwn) {
            for (const k of Object.keys(scOwn)) {
              if (k !== "name" && k !== "length") {
                carriesOwnProps = true;
                break;
              }
            }
            if (!carriesOwnProps && Object.getOwnPropertySymbols(scOwn).length > 0) carriesOwnProps = true;
          }
          if (carriesOwnProps) {
            const callable = _wrapCallableForHost(val, { getExports: currentExports });
            if (typeof callable === "function") return callable;
          }
        }
        if (exportKey !== undefined) {
          const callFn = liveExports[`__call_${exportKey}`];
          if (typeof callFn === "function") {
            const namedBridge = function closureBridge(this: any, ...args: any[]) {
              return callFn(obj);
            };
            // (#3051 Slice 3) `exec` protocol reads: marshal the RESULT object
            // so V8's Get + ToXxx protocol observes struct fields (mirrors the
            // Slice-1 `regexp.exec = fn` extern_set wrap).
            return exportKey === "exec"
              ? _wrapExecReturnForHost(namedBridge, { getExports: currentExports })
              : namedBridge;
          }
        }
        // Generic closure caller fallback — wraps any WasmGC closure struct
        // in a JS function so V8's native ToPrimitive sees it as callable (#1090).
        // Dispatch by the JS caller's `args.length` so 0-arg invocations use
        // __call_fn_0 and 1-arg use __call_fn_1 (#1352). Calling a 0-arg
        // closure (e.g. a generator like `keys`) via __call_fn_1 with a
        // dummy undefined arg returns a non-iterator, breaking native
        // Set.prototype.union/difference/symmetricDifference which expect
        // `keys()` to return a real iterator.
        const genericBridge = _wrapWasmClosureUnknownArity(val, { getExports: currentExports });
        if (genericBridge !== null) {
          // Reuse the authoritative dynamic wrapper instead of maintaining a
          // proxy-specific 0..2 dispatcher. Besides preserving method `this`
          // and [[Construct]] marshalling, it reads the closure's real declared
          // arity and selects a dispatcher large enough for under-applied calls
          // (`exports.createElement(type, config)` where createElement declares
          // a third `children` formal). The old local bridge selected
          // `__call_fn_method_2`, which cannot match an arity-3 closure and
          // silently returned null.
          // (#3051 Slice 3) See the named-arm exec wrap above.
          return key === "exec" ? _wrapExecReturnForHost(genericBridge, { getExports: currentExports }) : genericBridge;
        }
        // Non-closure WasmGC struct (e.g. nested object with valueOf/toString) —
        // wrap with _wrapForHost so its properties are accessible from JS (#1090)
        return _wrapForHost(val, liveExports);
      }
      // (#2841) A field value that is a REAL host JS array may hold raw
      // wasm-struct elements (acorn arrow-fn `node.params` — a host array from
      // #2836's `__make_iterable`, NOT a wasm vec). Return a view that wraps
      // those elements so `param.type` / `param.name` resolve through the proxy.
      // Genuine wasm vecs were already routed to `_wrapVecForHost` above; this
      // catches only true JS arrays the resolver returned directly.
      if (_nativeIsArray(val) && liveExports) {
        return _wrapHostArrayElems(val, liveExports);
      }
      // (#3051 Slice 3) Inherited `Object.prototype.toString` / `valueOf`
      // fallthrough. A Proxy's get trap intercepts INHERITED lookups too, so a
      // native ToPrimitive on the mirror of a plain-object struct saw
      // `toString === undefined` and threw "Cannot convert object to primitive
      // value" — but an ordinary object converts via the inherited
      // `Object.prototype.toString` ("[object Object]", §7.1.1.1). The @@split
      // default-constructor path (`new RegExp(<rx mirror>, flags)` when the
      // receiver has no species) must NOT throw (species-ctor-ctor-non-obj's
      // guard call). Scoped to exactly these two keys, only when nothing own
      // resolves — an OWN `toString: undefined` / `valueOf: undefined` (the
      // test262 `*-tostring-throws-toprimitive` poison pattern) SHADOWS the
      // inherited method per ordinary [[Get]], so ToPrimitive must still throw
      // TypeError. The first merge_group run of PR #2910 regressed exactly that
      // cluster (15 files: String.prototype.* this-value coercions,
      // Error.prototype.toString, Number.toFixed, TypedArray join) before this
      // own-property guard.
      if (
        val === undefined &&
        (key === "toString" || key === "valueOf") &&
        !_wasmStructHasOwn(obj, key, currentExports())
      ) {
        return (Object.prototype as Record<string, unknown>)[key as string];
      }
      return val;
    },
    set(_t, key, val) {
      const liveExports = currentExports();
      if (_isNativeOpenObject(obj, liveExports) && (typeof key === "string" || typeof key === "number")) {
        const set = liveExports?.__extern_set as ((value: any, key: any, next: any) => void) | undefined;
        if (typeof set === "function") {
          set(obj, _nativeBoundaryKey(key, liveExports!), _nativeBoundaryValue(val, liveExports!));
          return true;
        }
      }
      _safeSet(obj, key, val, currentExports());
      return true;
    },
    has(_t, key) {
      if (typeof key === "string" && _wasmStructDeletedKeys.get(obj)?.has(key)) return false;
      const liveExports = currentExports();
      if (_isNativeOpenObject(obj, liveExports) && (typeof key === "string" || typeof key === "number")) {
        const has = liveExports?.__extern_has as ((value: any, key: any) => number) | undefined;
        if (typeof has === "function") {
          try {
            return has(obj, _nativeBoundaryKey(key, liveExports!)) === 1;
          } catch {
            return false;
          }
        }
      }
      // (#4765) A DELETED key is absent for HasProperty too. `fieldNamesForHost()`
      // below is the STATIC struct shape and does not shrink on delete, so
      // `"k" in wrapped` stayed true after the host's own
      // `Array.prototype.{pop,splice,unshift}` removed `k` via
      // DeletePropertyOrThrow — the "…is removed" test262 family.
      // `_wasmStructHasOwn` (hasOwnProperty) and the compiled read already
      // consult this set; the proxy's `has` trap was the one that did not, and
      // it is what an `in` on an externref-typed receiver reaches.
      {
        const tomb = _wasmStructDeletedKeys.get(obj);
        if (tomb?.has(typeof key === "symbol" ? key : String(key))) return false;
      }
      if (safeGetField(key) !== undefined) return true;
      const sc = _wasmStructProps.get(obj);
      if (sc && key in sc) return true;
      const fieldNames = fieldNamesForHost();
      return typeof key === "string" && fieldNames.includes(key);
    },
    deleteProperty(_t, key) {
      const liveExports = currentExports();
      if (_isNativeOpenObject(obj, liveExports) && (typeof key === "string" || typeof key === "number")) {
        const del = liveExports?.__delete_property as ((value: any, key: any) => number) | undefined;
        if (typeof del === "function") {
          try {
            return del(obj, _nativeBoundaryKey(key, liveExports!)) !== 0;
          } catch {
            return false;
          }
        }
      }
      if (
        !wsh.deleteStructProperty(obj, key, liveExports, {
          hasOwn: _wasmStructHasOwn,
          sidecarDelete: _sidecarDelete,
          propDescs: _wasmPropDescs,
          accessors: _wasmStructAccessors,
          deletedKeys: _wasmStructDeletedKeys,
          integrity: [_wasmFrozenObjs, _wasmSealedObjs],
        })
      )
        return false;
      return true;
    },
    ownKeys(_t) {
      return collectKeys();
    },
    getOwnPropertyDescriptor(_t, key) {
      // (#3368) A deleted closed-struct field remains physically present in
      // WasmGC, but its tombstone makes it absent to every ECMAScript
      // reflection operation. Do not let the host proxy resurrect it during
      // Object.assign/object spread enumeration.
      if (isTombstoned(key)) return undefined;
      // (#4618) Once preventExtensions materialized the key set onto the
      // target (React dev's Object.freeze(element)), the §10.5.5 invariants
      // require the trap's answers to MATCH the locked target exactly — a
      // synthesized configurable descriptor for a now-non-configurable key
      // throws "'getOwnPropertyDescriptor' on proxy: trap returned
      // descriptor…". Serve the target's own descriptor verbatim.
      if (!Reflect.isExtensible(_t)) {
        return Reflect.getOwnPropertyDescriptor(_t, key);
      }
      // The extensible target permits synthesized descriptors; mirror them
      // onto it below so ownKeys invariants also hold.
      const sc = _wasmStructProps.get(obj);
      const hasInSidecar = !!sc && key in sc;
      const fieldNames = fieldNamesForHost();
      const hasInFields = typeof key === "string" && fieldNames.includes(key);
      // Hide physical method slots unless an explicit own shadow exists.
      if (
        typeof key === "string" &&
        !hasInSidecar &&
        !_wasmPropDescs.get(obj)?.has(_normalizeDescKey(key)) &&
        _resolveClassMember(obj, key, currentExports()) !== _MISS
      ) {
        return undefined;
      }
      const val = safeGetField(key);
      if (val === undefined && !hasInSidecar && !hasInFields) return undefined;
      // (#2714) Reflect the sidecar descriptor's stored enumerable flag so a
      // `defineProperty(o, k, { enumerable: false })` own prop reports as
      // non-enumerable here. Consumers that filter by enumerability —
      // `Object.assign` → CopyDataProperties, object spread `{ ...o }` (both
      // lowered via `__object_assign` over a `_wrapForHost` source) — must SKIP
      // it; hardcoding `enumerable: true` leaked non-enumerable sidecar props
      // into spread results (`spread-obj-skip-non-enumerable`). Declared struct
      // fields carry no flags entry and stay enumerable data props.
      const scFlags = _wasmPropDescs.get(obj)?.get(_normalizeDescKey(key));
      // (#4649) `writable`/`configurable` were hardcoded `true` while only
      // `enumerable` read the flags table, so a non-writable/non-configurable
      // define BEHAVED right but read back mutable (verifyProperty-value.js).
      const df = scFlags !== undefined && (scFlags & _SC_ACCESSOR) === 0 ? scFlags : undefined;
      const desc: PropertyDescriptor = {
        value: val,
        writable: df === undefined || (df & _SC_WRITABLE) !== 0,
        enumerable: scFlags === undefined || !!(scFlags & _SC_ENUMERABLE),
        configurable: df === undefined || (df & _SC_CONFIGURABLE) !== 0,
      };
      // Mirror onto target so V8's Proxy invariant checker is happy; §10.5.5
      // forbids reporting a non-configurable descriptor the target lacks, so a
      // REFUSED mirror serves the target's own descriptor instead (#4649).
      try {
        Object.defineProperty(target, key, desc);
      } catch {
        return Reflect.getOwnPropertyDescriptor(target, key) ?? desc;
      }
      return desc;
    },
    getPrototypeOf(_t) {
      // §10.5.1: once the target is non-extensible the trap result must be
      // SameValue as the target's own [[Prototype]] — `preventExtensions` below
      // pins the answer onto the target precisely so that stays true.
      if (!Reflect.isExtensible(_t)) return Reflect.getPrototypeOf(_t);
      return Object.prototype;
    },
    defineProperty(_t, key, descriptor) {
      // Route through sidecar descriptor validation so non-configurable/non-writable
      // constraints are enforced when native Object.defineProperty/defineProperties
      // is called on the proxy (#1092).
      const nKey = _normalizeDescKey(key);
      const sDescs = _getSidecarDescs(obj);
      const existingVal = _sidecarGet(obj, key);
      // (#1629) Pass the current descriptor so the same-getter/setter identity
      // exception (§10.1.6.3) can recognise an idempotent redefine of a
      // non-configurable accessor through the proxy. Omitting it made
      // `Object.is(desc.get, undefined)` always false → spurious "Cannot
      // redefine property" when redefining with the SAME getter/setter.
      const existingDesc = _readOwnDescriptor(obj, nKey, currentExports());
      const newFlags = _validatePropertyDescriptor(sDescs, nKey, descriptor, existingVal, existingDesc);
      sDescs.set(nKey, newFlags);
      if (descriptor.value !== undefined) _sidecarSet(obj, key, descriptor.value);
      if (descriptor.get !== undefined || descriptor.set !== undefined) {
        if (typeof key === "symbol") {
          let accMap = _wasmStructAccessors.get(obj);
          if (!accMap) {
            accMap = new Map();
            _wasmStructAccessors.set(obj, accMap);
          }
          accMap.set(key, { get: descriptor.get, set: descriptor.set });
        } else {
          const sc = _getSidecar(obj);
          if (descriptor.get) sc[`__get_${String(key)}`] = descriptor.get;
          if (descriptor.set) sc[`__set_${String(key)}`] = descriptor.set;
        }
      }
      // Mirror onto target for Proxy invariants
      try {
        Object.defineProperty(_t, key, descriptor);
      } catch {
        /* */
      }
      return true;
    },
    // (#4618) React dev freezes elements/props (`Object.freeze(element)`)
    // through this proxy. The default trap would preventExtensions the EMPTY
    // backing target, after which the `ownKeys` trap (which reports the
    // struct's live keys) violates the §10.5.11 invariant — V8 throws
    // "'ownKeys' on proxy: trap returned extra keys but proxy target is
    // non-extensible" on the NEXT enumeration. Materialize every currently
    // visible key onto the target FIRST, so the locked target carries the
    // exact key set the traps report.
    preventExtensions(t) {
      for (const key of collectKeys()) {
        if (Object.prototype.hasOwnProperty.call(t, key)) continue;
        const desc = handler.getOwnPropertyDescriptor?.(t, key);
        if (desc === undefined) continue;
        try {
          Object.defineProperty(t, key, desc);
        } catch {
          /* best-effort — an unmaterializable key keeps prior behavior */
        }
      }
      // (#5354) Pin the [[Prototype]] the `getPrototypeOf` trap answers onto
      // the target BEFORE locking it: §10.5.1 requires the trap to report the
      // target's own prototype once the target is non-extensible, and a
      // null-proto target would otherwise make every post-freeze
      // `instanceof` / `getPrototypeOf` throw the proxy invariant TypeError.
      try {
        Reflect.setPrototypeOf(t, Object.prototype);
      } catch {
        /* exotic target — the trap's non-extensible arm serves whatever it has */
      }
      _wasmNonExtensibleObjs.add(obj);
      return Reflect.preventExtensions(t);
    },
  };

  const proxy = new Proxy(target, handler);
  _hostProxyCache.set(obj, proxy);
  _hostProxyReverse.set(proxy, obj);
  _linkedProviderMirrors.recordMirrorOwner(proxy, exports); // (#5222)
  return proxy;
}

function _unwrapForHost(v: any, reader?: MarshalExportSource): any {
  // Callable mirrors are boundary views too. Compiled class objects and
  // closures deliberately surface to JavaScript as Functions, then may flow
  // straight back into another compiled call (React.createElement receives a
  // compiled class constructor through its host method bridge). Restricting
  // this reverse lookup to `typeof === "object"` left the Function facade in
  // the Wasm argument slot, splitting identity from the raw class/closure and
  // making element.type differ from the constructor that was passed in.
  if (!_canBeWeakKey(v)) return v;
  // (#5222) A mirror minted by a DIFFERENT module across the #2527 linked
  // provider seam must survive intact: the consumer has no decoder for the
  // provider's raw struct, so un-marshalling it here erases every member.
  if (_linkedProviderMirrors.isForeignModuleMirror(v, reader)) return v;
  const orig = _hostProxyReverse.get(v);
  if (orig !== undefined) return orig;
  return typeof v === "function" ? (_wasmClosureWrapperTargets.get(v) ?? v) : v;
}

function _wrapCallableForHost(
  closure: any,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
): any {
  if (closure == null || typeof closure !== "object") return closure;
  if (!_isWasmStruct(closure)) return closure;
  const cached = _hostCallableCache.get(closure);
  if (cached) return cached;

  // Reuse the full property-read/has/enumerate proxy unchanged: the callable
  // wrapper forwards every non-call/construct trap to it.
  const exports = callbackState?.getExports();
  const propProxy = _wrapForHost(closure, exports);

  // The Proxy target must itself be callable+constructible for the traps to be
  // installable and for `typeof proxy === "function"` to hold. A bare
  // `function(){}` is both [[Call]] and [[Construct]] capable.
  const fnTarget = function compiledFnTarget() {};
  // Surface .name / .length when the codegen stamped them on the closure
  // sidecar, so Function.prototype.toString / .name stay spec-shaped.
  // Best-effort; non-fatal if absent.
  const meta = _wasmStructProps.get(closure);
  if (meta) {
    if (typeof meta.name === "string") {
      try {
        Object.defineProperty(fnTarget, "name", { value: meta.name, configurable: true });
      } catch {
        /* Function.name redefinition is best-effort. */
      }
    }
    if (typeof meta.length === "number") {
      try {
        Object.defineProperty(fnTarget, "length", { value: meta.length, configurable: true });
      } catch {
        /* Function.length redefinition is best-effort. */
      }
    }
  }

  const handler: ProxyHandler<any> = {
    apply(_t, thisArg, args) {
      // Dispatch through the dynamic-arity bridge: it selects the highest
      // emitted `__call_fn_<arity>` and threads `thisArg` via the method
      // variant exactly like the rest of the host glue.
      const wrapped = _wrapWasmClosureUnknownArity(closure, callbackState);
      if (typeof wrapped !== "function") {
        throw new TypeError("compiled function is not callable (no __call_fn_* export)");
      }
      return wrapped.apply(thisArg, args);
    },
    construct(_t, args, _newTarget) {
      // Ordinary [[Construct]] (ECMA-262 §10.2.2) for a compiled function used
      // with `new` — the case V8 reaches inside NewPromiseCapability(C). Run the
      // body with a fresh ordinary object as the implicit `this`; return the
      // body's result if it is an object, else the fresh object. A throw from
      // the compiled body (e.g. the executor protocol abrupt-completion paths in
      // `capability-*` tests) MUST propagate so V8 observes spec ordering.
      const wrapped = _wrapWasmClosureUnknownArity(closure, callbackState);
      if (typeof wrapped !== "function") {
        throw new TypeError("compiled function is not a constructor (no __call_fn_* export)");
      }
      // (#2628) Link the fresh instance to the constructor closure's vivified
      // prototype so a subsequent prototype-method call resolves. Previously the
      // instance was a bare `{}` with no `[[Prototype]]` and no
      // `_fnctorInstanceCtor` entry, so `new this(...).m()` (acorn's
      // `new this(opts,input).parse()`) routed through `__extern_method_call`,
      // found no `m` on the bare object, and threw "m is not a function" — even
      // though `new Parser(...).m()` (the raw-struct `<Class>_new` path) works.
      // `Object.create(proto)` gives native prototype-chain reads; the
      // `_fnctorInstanceCtor` registration lets `_fnctorProtoLookup` wrap the
      // raw-struct method values into callables on dispatch (same machinery the
      // identifier-constructed fnctor instance uses for in-wasm method calls).
      const ctorProto = _getOrVivifyFnPrototype(closure, callbackState);
      const self: Record<string, any> =
        ctorProto != null && typeof ctorProto === "object" ? Object.create(ctorProto) : {};
      if (_canBeWeakKey(self)) _fnctorInstanceCtor.set(self, closure);
      const r = wrapped.apply(self, args);
      const inst = r != null && typeof r === "object" ? r : self;
      // The body may `return {...}` a different object; link it too so method
      // dispatch resolves on whichever instance escapes.
      if (inst !== self && _canBeWeakKey(inst) && !_fnctorInstanceCtor.has(inst)) {
        _fnctorInstanceCtor.set(inst, closure);
      }
      // (#3051 Slice 3) A raw wasm-struct return escapes to the HOST consumer
      // that ran Construct (e.g. V8's @@split species protocol driving the
      // constructed splitter's exec/lastIndex) — marshal it to its host mirror.
      if (inst !== self && _isWasmStruct(inst)) {
        return _wrapForHost(inst, callbackState?.getExports());
      }
      return inst;
    },
    // Property reads / writes / enumeration delegate to the standard
    // `_wrapForHost` proxy so `.prototype`, `.name`, static members, `has`,
    // `ownKeys`, descriptors, etc. behave identically to a non-callable wrap.
    get(_t, key, _recv) {
      const v = (propProxy as any)[key];
      if (v !== undefined) return v;
      // (#4618) The Function protocol must survive the delegation: a host
      // caller doing `spy.call(target, x)` (platform capability adapters,
      // Function.prototype.apply chains) reads `.call` off the mirror; the
      // struct delegate has no such key. Serve %Function.prototype% members —
      // invoked as `mirror.call(...)`, `this` binds to the mirror, so the
      // apply trap still runs the compiled body.
      if (typeof key === "string" && key in Function.prototype) {
        return (Function.prototype as unknown as Record<string, unknown>)[key];
      }
      return v;
    },
    set(_t, key, val) {
      (propProxy as any)[key] = val;
      return true;
    },
    has(_t, key) {
      return key in (propProxy as any);
    },
    getOwnPropertyDescriptor(_t, key) {
      const d = Object.getOwnPropertyDescriptor(propProxy as any, key);
      if (d) d.configurable = true; // a Proxy target's non-config props must be reported configurable
      return d;
    },
    defineProperty(_t, key, desc) {
      return Reflect.defineProperty(propProxy as any, key, desc);
    },
    deleteProperty(_t, key) {
      return Reflect.deleteProperty(propProxy as any, key);
    },
    ownKeys() {
      return Reflect.ownKeys(propProxy as any);
    },
    getPrototypeOf() {
      return Function.prototype;
    },
  };

  const proxy = new Proxy(fnTarget, handler);
  _hostCallableCache.set(closure, proxy);
  _hostProxyReverse.set(proxy, closure); // so _unwrapForHost round-trips
  _linkedProviderMirrors.recordMirrorOwner(proxy, callbackState?.getExports()); // (#5222)
  wsh.recordCallableOwner(proxy, callbackState);
  // The same closure can cross the boundary as this constructible proxy and as
  // a dynamic wasmClosureDynamicBridge. Canonicalize both representations to
  // the raw closure so strict constructor identity remains stable.
  _wasmClosureWrapperTargets.set(proxy, closure);
  return proxy;
}

/**
 * #2180 — a revoked Proxy throws a `TypeError` from EVERY internal method
 * ("Cannot perform 'get' on a proxy that has been revoked"). The boundary
 * helpers (`__extern_get` etc.) wrap their host reads in a try/catch that
 * silently falls through to a struct-getter path — which would swallow this
 * spec-mandated TypeError and return `undefined` instead. Detect it so callers
 * can re-throw, letting the user program's `assert.throws(TypeError, …)` see it.
 */
function _isRevokedProxyError(e: any): boolean {
  return e instanceof TypeError && typeof e.message === "string" && e.message.includes("proxy that has been revoked");
}

/** wasm:js-string polyfill for engines without native support (https://developer.mozilla.org/de/docs/WebAssembly/Guides/JavaScript_builtins) */
export const jsString = {
  concat: (a: string, b: string): string => {
    try {
      return a + b;
    } catch {
      // ToPrimitive failed on one operand (likely WasmGC struct) (#850)
      const sa = typeof a === "string" ? a : _toPrimitiveSync(a, "default");
      const sb = typeof b === "string" ? b : _toPrimitiveSync(b, "default");
      return String(sa) + String(sb);
    }
  },
  length: (s: string): number => s.length,
  equals: (a: string, b: string): number => (a === b ? 1 : 0),
  substring: (s: string, start: number, end: number): string => s.substring(start, end),
  charCodeAt: (s: string, i: number): number => s.charCodeAt(i),
};

const JS_STRINGS_NATIVE_BUILTIN = true;

/** Per-instance state shared across imports inside one `buildImports()`
 *  call. Currently used by the `web_storage` intent so localStorage /
 *  sessionStorage resolve to a stable per-instance polyfill in standalone
 *  mode (Node, Bun, WASI). */
interface InstanceState {
  webStorage: { local?: any; session?: any };
  // #1933 — per-instance state that previously lived at module scope and bled
  // across (or retained) concurrently-live instances. Threaded through
  // `resolveImport` (which already receives `instanceState`).
  /** symbol id → boxed symbol (lazily seeded with the well-known symbols). */
  symbolCache?: Map<number, symbol>;
  /** legacy RegExp static state (`RegExp.$1` etc.) — per instance, not shared. */
  legacyRegExpState: LegacyRegExpState;
}

function _createBoundaryObjectImport(
  operation: Extract<ImportIntent, { type: "boundary_object" }>["operation"],
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
): Function {
  return createBoundaryObjectAdapter(operation, {
    getExports: () => callbackState?.getExports(),
    isAdmitted: (obj, exports) => _canBeWeakKey(obj) && _nativeBoundaryHostObjectSet(exports).has(obj as object),
    toPropertyKey: (value, exports) => _nativeBoundaryToHost(value, exports) as PropertyKey,
    toHostValue: _nativeBoundaryToHost,
    fromHostValue: _nativeDynamicFromHost,
    toNativeVector: _nativeBoundaryVector,
    readArguments: (args, exports) => {
      const rawArgs = _unwrapForHost(args);
      if (_nativeIsArray(rawArgs)) {
        return Array.from(rawArgs, (value) => _nativeBoundaryToHost(_nativeDynamicFromHost(value, exports), exports));
      }
      const values: any[] = [];
      const length = exports.__extern_length as ((value: any) => number) | undefined;
      const getIndex = exports.__extern_get_idx as ((value: any, index: number) => any) | undefined;
      if (typeof length !== "function" || typeof getIndex !== "function") return values;
      const count = Math.max(0, Math.trunc(length(args)));
      for (let index = 0; index < count; index++) {
        values.push(_nativeBoundaryToHost(getIndex(args, index), exports));
      }
      return values;
    },
    toAccessor: (value, arity, markGetterReturn, exports) => {
      const primitive = _nativePrimitiveToHost(value, exports);
      if (primitive !== _MISS) return primitive;
      if (!_isWasmStruct(value)) return _unwrapForHost(value);
      const callable = _maybeWrapCallable(value, arity, callbackState);
      return markGetterReturn ? _markAccessorGetterReturn(callable) : callable;
    },
  });
}

function _createBoundaryCallbackImport(
  arity: number,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
): Function {
  return createBoundaryCallbackAdapter(arity, {
    getExports: () => callbackState?.getExports(),
    isAdmitted: (value, exports) => _canBeWeakKey(value) && _nativeBoundaryHostObjectSet(exports).has(value as object),
    toHostValue: _nativeBoundaryToHost,
    fromHostValue: _nativeDynamicFromHost,
  });
}

function _createBoundaryPromiseImport(
  operation: "resolve" | "reject",
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
): Function {
  return createBoundaryPromiseAdapter(operation, {
    getExports: () => callbackState?.getExports(),
    takeObserver: (id, exports) => {
      const state = _nativeBoundaryPromiseState(exports);
      const observer = state.observers.get(id);
      if (observer) state.observers.delete(id);
      return observer;
    },
    toHostValue: _nativeBoundaryToHost,
  });
}
function _wrapPlatformCapabilityClosure(
  value: unknown,
  arity: number,
  boundary: "timer" | undefined,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
): ((...args: any[]) => any) | null {
  if (boundary !== "timer") return _wrapWasmClosure(value, arity, callbackState);
  return wrapStandaloneTimerCallback(value, callbackState) ?? _wrapWasmClosure(value, arity, callbackState);
}

const coherentBuiltinRealms = new WeakSet<object>();

export function markCoherentBuiltinRealm(sandbox: object): void {
  coherentBuiltinRealms.add(sandbox);
}

/**
 * (#3325, #6979) An ambient `declare function f(...)` binds to the embedder's
 * dependency of the same name. Without one it keeps the historical no-op: the
 * test262 harness declares host print/log stubs it does not always supply, and
 * throwing regressed the merged-state test262 gate.
 */
function resolveDeclaredFunctionImport(name: string, deps: Record<string, any> | undefined): Function {
  const userDep = deps?.[name];
  const bind = typeof userDep === "function" ? (...args: any[]) => userDep(...args) : () => userDep;
  if (userDep !== undefined) return declaredHostFunction(bind, _nativeDynamicFromHost); // (#7095) marshalled
  return () => undefined;
}

function resolveImport(
  intent: ImportIntent,
  deps?: Record<string, any>,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
  globalSandbox?: Record<string, any>,
  instanceState?: InstanceState,
  // (#4150) Declared parameter count from the wasm import signature, including
  // the leading `self` for `extern_class` members. Lets the generic method shim
  // below drop its rest parameter. Undefined when unknown → rest form kept.
  paramCount?: number,
  getCaughtException?: () => unknown,
): Function {
  const builtin = <T>(name: string, fallback: T): T =>
    coherentBuiltinRealms.has(globalSandbox!) ? ((globalSandbox![name] as T | undefined) ?? fallback) : fallback;
  if (isBoundaryValueImportIntent(intent)) {
    return createBoundaryValueAdapter(intent, {
      object: (operation) =>
        withModuleTagThrow(
          _createBoundaryObjectImport(operation, callbackState),
          callbackState,
          _nativeDynamicFromHost,
        ),
      callback: (arity) =>
        withModuleTagThrow(_createBoundaryCallbackImport(arity, callbackState), callbackState, _nativeDynamicFromHost),
      promise: (operation) => _createBoundaryPromiseImport(operation, callbackState),
    });
  }
  const capability = resolvePlatformCapabilityImport(intent, {
    deps,
    globalSandbox,
    instanceState,
    getNodeRequire,
    wrapWasmClosure: (value, arity, boundary) => _wrapPlatformCapabilityClosure(value, arity, boundary, callbackState),
    wrapUnknownCallable: (value) => _maybeWrapCallableUnknownArity(value, callbackState),
  });
  if (capability)
    return wrapConsoleForHost(capability, intent, callbackState, _nativePrimitiveToHost, _MISS, _nativeDynamicFromHost);
  const compatibilitySemantic = resolveCompatibilitySemanticImport(intent);
  if (compatibilitySemantic) return compatibilitySemantic;
  if (intent.type === "declared_function") return resolveDeclaredFunctionImport(intent.name, deps);
  switch (intent.type) {
    case "caught_exception":
      return createCaughtExceptionImport(getCaughtException);
    case "extern_class":
      return resolveExternClassImport(
        intent,
        { deps, callbackState, legacyRegExpState: instanceState?.legacyRegExpState, paramCount, builtin },
        {
          miss: _MISS,
          isWasmStruct: _isWasmStruct,
          safeGet: _safeGet,
          safeSet: _safeSet,
          sidecarGet: _sidecarGet,
          unwrapForHost: _unwrapForHost,
          wrapForHost: _wrapForHost,
          hostToPrimitive: _hostToPrimitive,
          resolveHostField: _resolveHostField,
          maybeWrapCallableUnknownArity: _maybeWrapCallableUnknownArity,
          marshalWasmDateForHost: _marshalWasmDateForHost,
        },
      );
    case "builtin": {
      const name = intent.name;
      // #1644/#2678: spec BigInt-to-i64 and host Date.parse for wasm:js-string externrefs.
      if (name === "__date_parse_host") return (s: any): number => Date.parse(s);
      if (name.startsWith("__regexp_host_")) return resolveRegExpHostImport(name, instanceState)!;
      // Reverse a host-side facade before narrowing externref to a concrete GC representation.
      // A vec mirror may have been mutated by a host Array/TypedArray method;
      // replay its current elements before returning the original vec so the
      // concrete call_ref parameter observes both identity and data.
      if (name === "__unwrap_for_wasm")
        return (value: any): any => {
          const mirroredVec = vecForMirror(value);
          if (mirroredVec === undefined) return _unwrapForHost(value);
          const exports = callbackState?.getExports();
          const vecLen = exports?.__vec_len as ((vec: any) => number) | undefined;
          const vecGet = exports?.__vec_get as ((vec: any, index: number) => any) | undefined;
          const vecSet = exports?.__vec_set_elem as ((vec: any, index: number, element: any) => number) | undefined;
          if (
            exports !== undefined &&
            vecMirrorElementsChanged(value) &&
            typeof vecLen === "function" &&
            typeof vecGet === "function" &&
            typeof vecSet === "function"
          ) {
            const previous: Array<{ index: number; value: any }> = [];
            let allWritesSucceeded = false;
            try {
              const length = vecLen(mirroredVec);
              if (typeof length === "number" && length === Number(value.length)) {
                for (let i = 0; i < length; i++) {
                  const element = _nativeDynamicFromHost(value[i], exports);
                  previous[previous.length] = { index: i, value: vecGet(mirroredVec, i) };
                  if (vecSet(mirroredVec, i, element) !== 1) throw new Error("vec element set rejected");
                }
                allWritesSucceeded = true;
              }
              if (allWritesSucceeded) {
                recordVecMirrorElements(value);
              }
            } catch {
              // Restore the pre-replay values after a partial failure. The
              // mirror deliberately remains dirty so a later boundary may
              // retry instead of silently forgetting the host edits.
              for (let i = previous.length - 1; i >= 0; i--) {
                const prior = previous[i]!;
                try {
                  vecSet(mirroredVec, prior.index, prior.value);
                } catch {
                  /* leave dirty; no safer recovery is available */
                }
              }
            }
          }
          return mirroredVec;
        };
      const processRead = resolveProcessCapability(name, (value) => {
        const exports = callbackState?.getExports(); // (#6910) the native regime's value boundary
        return isNativeRegimeExports(exports) ? _nativeDynamicFromHost(value, exports) : value;
      });
      if (processRead) return processRead;
      const cryptoImport = resolveCryptoCapabilityImport(name, callbackState, _isWasmVec);
      if (cryptoImport) return cryptoImport;
      const stringMemory = resolveStringMemoryImport(name, callbackState);
      if (stringMemory) return stringMemory;
      const initExport = resolveInitExportImport(name, callbackState);
      if (initExport) return initExport;
      return resolveDeclaredFunctionImport(name, deps); // a hand-built manifest's ambient name
    }
    // (#4394) `intent.constructible` is set only by `__make_callback_ctor`, the
    // maker the compiler picks for an ordinary function definition — the one
    // callable form with [[Construct]]. Everything else keeps the arrow bridge.
    case "callback_maker":
      return createHostAsyncCallbackMaker(callbackState, _wrapVoidHostCallback, () => intent.constructible === true);
    case "getter_callback_maker":
      return (id: number, cap: any) => {
        // Regular function (not arrow) so 'this' is bound to the receiver;
        // rest params forward setter arguments (value) to the Wasm callback.
        // eslint-disable-next-line func-names
        const bridge = function (this: any, ...args: any[]) {
          const exports = callbackState?.getExports();
          // (#2128) A setter may run during START before exports are wired.
          // Park that write and replay it through the same normalized edge.
          if (exports === undefined && args.length > 0 && callbackState) {
            const defer = (callbackState as { deferToExports?: (fn: () => void) => void }).deferToExports;
            if (defer) {
              defer(() => {
                invokeNativeFunctionCallback(id, cap, [this, ...args], callbackState, ASYNC_CALLBACK_EXCEPTION_POLICY);
              });
              return undefined;
            }
          }
          return _invokeGetterCallbackBridge(bridge, id, cap, this, args, callbackState);
        };
        installNativeFunctionSourceFacade(bridge);
        _wasmGetterCallbackWrappers.add(bridge);
        return bridge;
      };
    case "box":
      if (intent.targetType === "boolean") return (v: number) => Boolean(v);
      // (#1644) __box_bigint: JS-BigInt-integration already delivers the wasm
      // i64 as a JS bigint at the boundary, so boxing is identity.
      if (intent.targetType === "bigint") return (v: bigint) => v;
      return createHostNumberBoxImport();
    case "unbox":
      if (intent.targetType === "boolean") return (v: any) => (v ? 1 : 0);
      if (intent.targetType === "symbol") {
        const symbolCache = _resolveSymbolCache(instanceState);
        return (value: unknown): number => wsh.unboxSymbol(symbolCache, value);
      }
      // (#1644) __to_bigint: §7.1.13 ToBigInt. Identity on a bigint; parse
      // strings / coerce booleans via the BigInt() constructor (SyntaxError on
      // bad string syntax); number and Symbol arguments throw TypeError. The
      // returned bigint crosses back to wasm as an i64 (JS-BigInt-integration).
      if (intent.targetType === "bigint") {
        return (v: any): bigint => {
          if (typeof v === "bigint") return v;
          if (typeof v === "number") {
            throw new TypeError("Cannot convert a Number to a BigInt");
          }
          if (typeof v === "symbol") {
            throw new TypeError("Cannot convert a Symbol value to a BigInt");
          }
          // string / boolean / object-with-primitive — defer to spec BigInt()
          // (throws SyntaxError on malformed numeric strings).
          return BigInt(v);
        };
      }
      return createHostNumberUnboxImport(callbackState, _toPrimitive, _hostToPrimitive);
    default:
      // #1858 C9a: fail loud instead of silently binding an unhandled import
      // intent to a no-op. A no-op `() => {}` returns `undefined` for every
      // call, so a missing/misnamed intent produced a wrong answer with no
      // diagnostic. Throw so the unhandled type surfaces at instantiation.
      throw new Error(`Unhandled ImportIntent type: ${(intent as any).type}`);
  }
}

/** Check a manifest against a policy blocklist before instantiation.
 *  Returns an array of violated import keys (empty if all clear). */
export function checkPolicy(manifest: ImportDescriptor[], policy: ImportPolicy): string[] {
  const violations: string[] = [];
  for (const imp of manifest) {
    if (imp.intent.type === "extern_class") {
      const key = imp.intent.member ? `${imp.intent.className}.${imp.intent.member}` : imp.intent.className;
      if (policy.blocked.has(key)) violations.push(key);
    }
    if (imp.intent.type === "declared_global") {
      if (policy.blocked.has(imp.intent.name)) violations.push(imp.intent.name);
    }
  }
  return violations;
}

/**
 * Build the WebAssembly import object from a closed manifest.
 *
 * After instantiation, prefer `setInstance(instance)`. It proves the
 * WebAssembly.Instance internal-slot brand before wiring the exports record.
 * `setExports(instance.exports)` remains available for legacy callback, vec,
 * closure, and string wiring.
 */
export interface BuildImportsOptions extends CompiledCapabilityAuthorityOptions {
  domRoot?: Element | ShadowRoot | DomCapabilityRoot;
  globalSandbox?: Record<string, any>;
  /**
   * Install compatibility-only ambient Iterator/RegExp shims. Defaults to
   * true for the historical low-level API; {@link buildCompiledImports}
   * derives false for native-first modules from their frozen target profile.
   */
  ambientCompatibility?: boolean;
  hostAccelerators?: readonly import("./target-profile.js").HostAcceleratorFamily[]; // (#6978) admitted by the binder
  /**
   * Runtime implementation for dynamic eval and new Function (#6779).
   *
   * `deny` (the default) fails closed. `evaluator` delegates to the explicit
   * evaluator below. `hostEval` tries a js2wasm child module, then the host
   * realm's eval/Function when that module cannot be built; `native` uses the
   * host realm's directly. Both reach host globals. `compat` = deprecated `hostEval`.
   */
  dynamicCode?: DynamicCodePolicy;
  /** Synchronous evaluator used only when `dynamicCode` is `evaluator`. */
  dynamicCodeEvaluator?: DynamicCodeEvaluator;
}

export type DynamicCodePolicy = dynamicCodePolicy.DynamicCodePolicy;

/** Live caller binding retained by the AOT module's host realm. */
export interface DynamicCodeBinding {
  readonly name: string;
  get(): unknown;
  set(value: unknown): void;
}

export interface DynamicCodeEvaluationContext {
  direct: boolean;
  strict?: boolean;
  /** Present only for `CompileOptions.directEval: "reified-host"`. */
  bindings?: readonly DynamicCodeBinding[];
}

export interface DynamicCodeEvaluator {
  evaluate(source: string, context: DynamicCodeEvaluationContext): unknown;
  createFunction(parameters: string, body: string): Function;
}

export function buildImports(
  manifest: readonly ImportDescriptor[],
  deps?: Record<string, any>,
  stringPool?: readonly string[],
  options?: BuildImportsOptions,
): {
  env: Record<string, Function>;
  "wasm:js-string": typeof jsString;
  string_constants: Record<string, WebAssembly.Global>;
  string_constants16: Record<string, WebAssembly.Global>;
  setInstance?: (instance: WebAssembly.Instance) => void;
  setExports?: (exports: Record<string, Function>) => void;
  startImportCounting?: () => void;
  takeImportCounts?: () => Record<string, number>;
} {
  // (#1933) Per-instance state for stateful imports. Created FIRST so the
  // RegExp-accessor install below (and every `resolveImport` call) can thread
  // it. Everything here was previously module-level and bled across / retained
  // concurrently-live instances; the per-instance Maps/state fix that.
  const instanceState: InstanceState = {
    webStorage: {},
    symbolCache: new Map<number, symbol>(),
    legacyRegExpState: _makeLegacyRegExpState(),
  };

  installAmbientCompatibility({
    enabled: options?.ambientCompatibility !== false,
    deps,
    legacyRegExpState: instanceState.legacyRegExpState,
    // (#6492 r17) Compiled code reads `Promise` through the sandbox, so a
    // polyfilled static has to be installed there or its receiver can never be
    // the object the test wrote to.
    globalSandbox: wsh.snapshotSandboxIntrinsics(options?.globalSandbox), // (#6651) record realm intrinsics first
    mirrorThenable: _mirrorPolyfillThenable,
  });

  const env: Record<string, Function> = {};
  let dataStructHostBridgeAuthority: DataStructHostBridgeAuthority | undefined;
  const timerCallbackBridge = createStandaloneTimerCallbackBridge();
  const domCapabilityRuntime = createCompiledDomCapabilityRuntime(options, options?.domRoot);
  // (#1712) Operations that NEED exports (e.g. Object.defineProperties with a
  // WasmGC-struct descriptor map — its keys/fields are only readable via the
  // __struct_field_names / __sget_* exports) but run during the module START
  // function park themselves here and are replayed the moment setExports
  // wires the instance.
  const lifecycle = createInstanceLifecycleAdapter({
    brandedExports: brandedInstanceExports,
    prepareExports: (exports, mayEstablishInstanceAuthority) =>
      hostBridgeExportView(exports, {
        expectedDataStructAuthority: dataStructHostBridgeAuthority,
        expectedDataStructToken: dataStructHostBridgeToken,
        establishDataStructAuthority: mayEstablishInstanceAuthority
          ? (authority) => (dataStructHostBridgeAuthority ??= authority)
          : undefined,
        mayEstablishDataStructAuthority: mayEstablishInstanceAuthority,
        recordExportView: (rawExports, finalExports) => {
          timerCallbackBridge.recordExportView(rawExports, finalExports, mayEstablishInstanceAuthority);
          domCapabilityRuntime?.recordExportView(rawExports, finalExports, mayEstablishInstanceAuthority);
        },
      }),
  });
  const callbackState = lifecycle.callbackState;
  _latestInstance = new WeakRef(callbackState);
  timerCallbackBridge.bindCallbackState(callbackState, (value, arity) => _wrapWasmClosure(value, arity, callbackState));
  domCapabilityRuntime?.bindCallbackState(callbackState);
  const hostImportCallState = createHostImportCallState();
  // (#6779) Validate the policy once per instance: a misspelt value throws and
  // `compat` warns. (#6979 S7-d) No env provider here consumes it any more —
  // no WasmGC profile emits the host `__extern_eval` imports; the linked
  // runtime-eval provider (`runtime-eval.ts`) owns dynamic code.
  dynamicCodePolicy.resolveDynamicCodePolicy(options?.dynamicCode);

  // (#1467 / #1933) Each instantiated module gets its own symbol id space and
  // per-instance symbol cache/registry, RegExp legacy state, and subclass/
  // parent registries — initialized in `instanceState` above (was module-level,
  // which crossed and retained concurrently-live instances).

  for (const imp of manifest) {
    if (imp.module !== "env") continue;
    if (options?.ambientCompatibility === false) {
      const policy = classifyHostImport(imp, undefined, options?.hostAccelerators);
      if (policy.classification === "unknown") {
        throw new Error(
          `Native-first adapter cannot bind ${imp.module}::${imp.name}: ${policy.reason} ` +
            `(the host-semantic implementation was removed, #${policy.ownerIssue}).`,
        );
      }
    }
    const importIndex = hostImportCallState.registerImport(imp.name);
    let fn: Function;

    const domBinding = domCapabilityRuntime?.bindImport(imp);
    const clockBinding = imp.intent.type === "date_now" ? options?.[CLOCK_CAPABILITY_AUTHORITY] : undefined;
    fn =
      domBinding ??
      clockBinding ??
      intlAccel.intlLocaleMethodImport(imp, options?.hostAccelerators) ??
      resolveImport(
        imp.intent,
        deps,
        callbackState,
        options?.globalSandbox,
        instanceState,
        imp.paramCount,
        hostImportCallState.getCaughtException,
      );

    if (intlAccel.isIntlAcceleratedImport(imp, options?.hostAccelerators)) {
      const [toHost, fromHost, vector] = [_nativeBoundaryToHost, _nativeDynamicFromHost, _nativeBoundaryVector];
      fn = intlAccel.marshalIntlHostImport(fn, callbackState, toHost, fromHost, _marshalWasmDateForHost, vector); // (#6986)
    } else {
      fn = marshalPlatformArgs(imp, fn, callbackState, _nativePrimitiveToHost, _MISS, _maybeWrapCallableUnknownArity);
    }
    // DOM containment wrapping
    if (options?.domRoot && !domCapabilityRuntime) {
      if (imp.intent.type === "extern_class") {
        fn = wrapWithDomContainment(fn, imp.intent, options.domRoot as Element | ShadowRoot);
      }
      if (imp.intent.type === "declared_global" && imp.intent.name === "document") {
        fn = () => options.domRoot;
      }
    }

    const wrappedImport = hostImportCallState.wrap(imp, fn, importIndex);
    fn = wrappedImport.fn;
    if (wrappedImport.fastLeaf) {
      env[imp.name] = fn;
      continue;
    }
    domCapabilityRuntime?.recordWrappedImport(imp, domBinding, fn);
    env[imp.name] = fn;
  }

  domCapabilityRuntime?.finalizeImports(env);

  const result: {
    env: Record<string, Function>;
    "wasm:js-string": typeof jsString;
    string_constants: Record<string, WebAssembly.Global>;
    string_constants16: Record<string, WebAssembly.Global>;
    setInstance?: (instance: WebAssembly.Instance) => void;
    setExports?: (exports: Record<string, Function>) => void;
    startImportCounting?: () => void;
    takeImportCounts?: () => Record<string, number>;
  } = {
    env,
    "wasm:js-string": jsString,
    string_constants: buildStringConstants(stringPool),
    // (#2880) surrogate-safe constants — hex-keyed; empty for surrogate-free
    // programs (an unused import namespace is ignored by V8).
    string_constants16: buildStringConstants16(stringPool),
  };
  installFreshDataStructAssociationToken(result.string_constants, DATA_STRUCT_HOST_BRIDGE_TOKEN_VALUE); // (#5337)
  const dataStructHostBridgeToken = result.string_constants[DATA_STRUCT_HOST_BRIDGE_TOKEN_VALUE];
  // Always provide setExports — needed for callbacks, native string marshaling,
  // and struct field getter discovery (__sget_*). Raw records cannot establish
  // first data-struct authority.
  result.setExports = lifecycle.setExports;
  result.setInstance = lifecycle.setInstance;
  result.startImportCounting = hostImportCallState.startImportCounting;
  result.takeImportCounts = hostImportCallState.takeImportCounts;
  return result;
}

/**
 * Wrap raw `instance.exports` so that any Wasm closure struct returned from
 * a callable export becomes a JS-callable function (#1308).
 *
 * Without this wrapper, `exports.makeFn()` returns the raw Wasm closure
 * struct — `typeof` reports `"object"`, the value is `[Object: null prototype] {}`,
 * and direct invocation throws "is not a function". With the wrapper, the
 * struct is replaced by a JS function that dispatches via the
 * `__call_fn_N` exports the codegen emits (`__call_fn_0` for zero-arg
 * closures, `__call_fn_1` for one-arg).
 *
 * Scope:
 * - Returned closures dispatch through the highest available arity bridge.
 * - Source rest parameters are packed into their internal Wasm vec by those
 *   bridges, while `__argc` / `__extras_argv` preserve `arguments` semantics.
 * - Returned value from the wrapped closure that is itself a Wasm
 *   struct is NOT recursively wrapped — only direct returns from
 *   top-level exports. Recursive wrapping can be added if needed.
 *
 * Usage:
 * ```ts
 * const { instance } = await WebAssembly.instantiate(binary, imports);
 * const exports = wrapExports(instance);
 * const negated = exports.negate(jsFn);  // typeof === "function"
 * negated();                              // dispatches via __call_fn_0
 * ```
 */
/**
 * TS-level classification of a single export param or result slot surfaced
 * via `CompileResult.exportSignatures`. It distinguishes source strings from
 * their native Wasm carrier as well as TypedArray from `number[]`.
 */
export interface WrapExportsSignature {
  /** Per-parameter boundary kind, positionally. */
  params: WrapExportsBoundaryKind[];
  /** Boundary kind of the return value. */
  result: WrapExportsBoundaryKind;
}

type WrapExportsBoundaryKind =
  | "boolean"
  | "uint8array"
  | "typed-array"
  | "string"
  | "symbol"
  | "promise"
  | "dynamic"
  | "aggregate"
  | "other";

/**
 * (#1700) Copy each `Uint8Array` / TypedArray / plain-array argument into a
 * fresh Wasm vec via `__new_vec_f64` + `__vec_set_byte`. Non-TypedArray
 * slots (`kind === "other"`) and `null` / `undefined` pass through. Other
 * values for a TypedArray slot throw `TypeError`, matching the shape of
 * `new Uint8Array(nonIterable)`.
 */
function marshalTypedArrayArgs(
  args: any[],
  sig: WrapExportsSignature,
  exportName: string,
  newVecF64: (len: number) => any,
  vecSetByte: (vec: any, idx: number, byte: number) => void,
): any[] {
  const out = new Array(args.length);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const kind = sig.params[i];
    if (kind !== "uint8array" && kind !== "typed-array") {
      out[i] = arg;
      continue;
    }
    if (arg == null) {
      // Pass null/undefined straight through — compiled function takes
      // a ref_null vec param and is responsible for its own null handling.
      out[i] = arg;
      continue;
    }
    if (!ArrayBuffer.isView(arg) && !_nativeIsArray(arg)) {
      throw new TypeError(`wrapExports: export "${exportName}" expects ${kind} for arg #${i}, got ${typeof arg}`);
    }
    const src = arg as ArrayLike<number>;
    const len = src.length | 0;
    const vec = newVecF64(len);
    // #1829 — only byte-mask for Uint8Array. For any other TypedArray the
    // `& 0xff` truncated every element to its low byte, silently corrupting
    // Uint16Array/Uint32Array (and signed/float) inputs. The vec backing store
    // is f64 and `__vec_set_byte` widens its i32 value arg via
    // `f64.convert_i32_u`, so an unmasked write round-trips unsigned integers
    // up to 2^32-1 at full precision. (Signed-negative and fractional float
    // elements still need a full-f64 vec setter — tracked as a follow-up; this
    // strictly improves on truncating every element to a byte.)
    const maskByte = kind === "uint8array";
    for (let j = 0; j < len; j++) {
      vecSetByte(vec, j, maskByte ? src[j]! & 0xff : src[j]!);
    }
    out[i] = vec;
  }
  return out;
}

/**
 * Wrap a Wasm instance or its exports so `Uint8Array` (and other TypedArray)
 * arguments and return values marshal correctly across the JS↔Wasm boundary.
 *
 * Prefer passing the genuine `WebAssembly.Instance`. Passing its raw exports
 * record retains the historical API, but (#6438) that overload can only CONSUME
 * a data-struct authority, never establish one: an export that returns an
 * object decodes only after `importObject.__setInstance(instance)` (or an
 * earlier `wrapExports(instance)` for the same module). Without that, a struct
 * result throws a `TypeError` instead of silently marshalling to `{}`.
 *
 * Pass the per-export type metadata from {@link CompileResult.exportSignatures}
 * as `options.signatures`; without it the wrapper is a passthrough. Returns a
 * new exports object; the original is left untouched.
 */
export interface WrapExportsOptions {
  /**
   * Result-object boundary policy:
   * - `"copy"` (compatibility default) materializes a detached JS value;
   * - `"live"` exposes the identity-cached `_wrapForHost` view and unwraps
   *   that view when it crosses back into Wasm;
   * - `false` exposes the raw opaque WasmGC handle.
   */
  marshal?: "copy" | "live" | false;
  /** Per-export TS-level type metadata used for TypedArray boundary fidelity. */
  signatures?: Record<string, WrapExportsSignature>;
  /** Generated per-slot value policies. Used unless `marshal` explicitly overrides them. */
  boundaryPolicies?: Readonly<Record<string, ExportBoundaryPolicy>>;
}

function marshalModeForBoundaryPolicy(policy: BoundaryValuePolicy | undefined): "copy" | "live" | false | undefined {
  if (policy === "copied-value") return "copy";
  if (policy === "live-view") return "live";
  if (policy === "opaque-handle") return false;
  return undefined;
}

export function wrapExports(
  instanceOrExports: WebAssembly.Instance | WebAssembly.Exports,
  options?: WrapExportsOptions,
): Record<string, any> {
  // #1504: marshal by default; `marshal: false` keeps raw WasmGC handles.
  const hasMarshalOverride = options !== undefined && Object.prototype.hasOwnProperty.call(options, "marshal");
  const marshal: "copy" | "live" | false = options?.marshal ?? "copy";
  const brandedExports = brandedInstanceExports(instanceOrExports);
  const rawExports = brandedExports ?? (instanceOrExports as WebAssembly.Exports);
  const exportsForMarshal = hostBridgeExportView(rawExports as unknown as Record<string, Function>, {
    mayEstablishDataStructAuthority: brandedExports !== undefined,
    mayConsumeGlobalDataStructAuthority: true,
  });
  // (#6438) The raw-exports overload may never ESTABLISH data-struct authority,
  // so a module that ships a decoder can have it masked to `undefined` in the
  // view above. Struct results would then marshal to `{}` in silence.
  const dataStructDecoderMasked =
    hasOwn(rawExports, "__struct_field_names") && typeof exportsForMarshal.__struct_field_names !== "function";
  const callFn0 = exportsForMarshal.__call_fn_0 as ((closure: any) => any) | undefined;
  const callFn1 = exportsForMarshal.__call_fn_1 as ((closure: any, arg: any) => any) | undefined;
  // (#1700) Vec allocator + byte-writer for Uint8Array args. Either may be
  // undefined, in which case the wrapper falls back
  // to passing the arg through unchanged.
  const newVecF64 = (rawExports as Record<string, any>).__new_vec_f64 as ((len: number) => any) | undefined;
  const vecSetByte = (rawExports as Record<string, any>).__vec_set_byte as
    | ((vec: any, idx: number, byte: number) => void)
    | undefined;
  const signatures = options?.signatures;
  const boundaryPolicies = options?.boundaryPolicies;

  // Build a JS-callable wrapper around a Wasm closure struct.
  const makeCallableClosureWrapper = (closure: any): ((...args: any[]) => any) => {
    const hasRest = exportsForMarshal.__closure_has_rest as ((value: any) => number) | undefined;
    if (typeof hasRest === "function" && hasRest(closure) === 1) {
      const dynamic = _wrapWasmClosureUnknownArity(closure, { getExports: () => exportsForMarshal });
      if (dynamic) return dynamic;
    }
    return function (this: any, ...args: any[]): any {
      if (args.length === 1 && typeof callFn1 === "function") {
        return callFn1(closure, args[0]);
      }
      if (typeof callFn0 === "function") {
        // 0-arg dispatch — also the fallback for higher-arity calls until
        // __extras_argv plumbing from JS lands. The closure body still
        // executes; user-supplied args are simply not propagated.
        return callFn0(closure);
      }
      throw new TypeError("Wasm closure returned to JS host is not callable: __call_fn_0/__call_fn_1 not exported");
    };
  };

  // #1504: discriminate a "named struct" / "vec" result from a closure struct.
  // Order of checks:
  // 1. If `__is_closure(val)` returns 1 → it's a closure, NOT marshalable
  //    (this is the authoritative codegen-side discriminator).
  // 2. If `__struct_field_names(val)` returns non-empty → named struct.
  // 3. If `__is_vec(val)` → vec wrapper.
  // 4. Otherwise it is a wasm struct that is neither a closure, a named struct,
  //    nor a vec — e.g. a class instance carrying only methods. It is an
  //    OBJECT, so it is marshalable; only a module too old to export
  //    `__vec_len` at all falls back to the closure-wrapping path (#1308).
  //
  // (#3637) Step 3 previously read "`__vec_len(val)` returns a number ≥ 0",
  // which is VACUOUSLY TRUE for every struct (see `_isWasmVec`) — so step 4 was
  // the arm actually taken for non-vec structs, and the closure-wrapping
  // fallback was dead code whenever `__vec_len` existed. Do NOT "fix" this by
  // narrowing step 3 to `__is_vec` alone: that would route field-less instances
  // into `makeCallableClosureWrapper` and hand JS a FUNCTION where the program
  // returned an object. The vacuous outcome was right here even though the test
  // was not, so step 4 is written out explicitly and the behaviour is unchanged.
  const isClosureFn = exportsForMarshal.__is_closure as ((v: any) => number) | undefined;
  const hasVecLen = typeof exportsForMarshal.__vec_len === "function";
  // (#6438) Predicates the fail-closed raw-record guard borrows from this module.
  const structDecodeProbes = {
    isStruct: _isWasmStruct,
    isVec: _isWasmVec,
    fieldNames: _structFieldNamesRaw,
    isClosure: isClosureFn,
  };
  const looksMarshalable = (val: any): boolean => {
    if (val == null || typeof val !== "object") return false;
    // No positively discovered compiler closure family means this module
    // cannot return a compiled closure. Do not let a user `__is_closure`
    // label or the historical old-module fallback turn class instances into
    // callable wrappers.
    if (typeof isClosureFn !== "function") return true;
    // `hostBridgeExportView` maps `__is_closure` to the authenticated compiler
    // classifier when a closure family was discovered, or to `undefined`
    // otherwise (see the `typeof isClosureFn !== "function"` branch above for
    // the latter). So a classifier that returns without throwing is
    // authoritative — a `0` verdict means "not a closure", full stop; do not
    // fall through to the `__vec_len` guess (#6441) just because this
    // field-less/array-free module never exports `__vec_len`.
    let closureVerdictKnown = false;
    try {
      if (isClosureFn(val) === 1) return false;
      closureVerdictKnown = true;
    } catch {
      /* module too old to answer the classifier cleanly — fall through to
       * the `__vec_len` guess below, same as the pre-#6441 behaviour. */
    }
    if (_structFieldNamesRaw(val, exportsForMarshal) != null) return true;
    if (_isWasmVec(val, exportsForMarshal)) return true;
    return closureVerdictKnown ? true : hasVecLen;
  };

  const wrapped: Record<string, any> = Object.create(null);
  for (const key of Object.keys(rawExports)) {
    const val = (rawExports as Record<string, any>)[key];
    // Pass non-callable exports (Globals, Memory, Tag) through unchanged.
    if (typeof val !== "function") {
      wrapped[key] = val;
      continue;
    }
    const sig = signatures && hasOwn(signatures, key) ? signatures[key] : undefined;
    // Unmarked internal helpers retain their exact passthrough. A user export
    // carries a signature whatever its name (#6875: `__npmCompatPerf(input)`
    // skipped argument marshalling, so a native-regime string arrived raw).
    if (key.startsWith("__") && sig === undefined) {
      wrapped[key] = val;
      continue;
    }
    // Wrap user exports: closures become callables; structs/vecs marshal to JS;
    // primitives, strings, and raw externrefs pass through.
    const exportBoundaryPolicy = boundaryPolicies && hasOwn(boundaryPolicies, key) ? boundaryPolicies[key] : undefined;
    const invoke = function (this: any, ...args: any[]): any {
      // A live boundary view is only a JS façade. Recover its canonical WasmGC
      // identity before calling a typed export; ordinary JS values are no-ops.
      let boundaryArgs = args.map((arg, index) => {
        // ToBoolean never calls user coercion hooks, including under a live
        // object policy or marshal:false.
        if (sig?.params[index] === "boolean") return arg ? 1 : 0;
        const paramMode = hasMarshalOverride
          ? marshal
          : marshalModeForBoundaryPolicy(exportBoundaryPolicy?.params[index]?.policy);
        return paramMode === "live" ? _unwrapForHost(arg) : arg;
      });
      const stringFromHost = exportsForMarshal.__str_from_extern as ((value: string) => any) | undefined;
      if (sig) {
        // Required Boolean slots also materialize omitted arguments as false.
        for (let index = boundaryArgs.length; index < sig.params.length; index++) {
          if (sig.params[index] === "boolean") boundaryArgs[index] = 0;
        }
        boundaryArgs = boundaryArgs.map((arg, index) => {
          if (sig.params[index] === "string" && typeof arg === "string" && typeof stringFromHost === "function") {
            return stringFromHost(arg);
          }
          if (sig.params[index] === "symbol") {
            const symbolId = _nativeSymbolIdFromHost(arg, exportsForMarshal);
            if (symbolId === _MISS) {
              throw new TypeError(`wrapExports: export "${key}" expects symbol for arg #${index}, got ${typeof arg}`);
            }
            return symbolId;
          }
          if (sig.params[index] === "promise") return _nativeDynamicFromHost(arg, exportsForMarshal);
          // (#6980) An `any` argument's null is the in-module `ref.null` every
          // null check tests (and the one `_nativePrimitiveToHost` maps back);
          // the tag-0 box is only for boundary-object reads, where a raw null
          // return means "not admitted".
          if (sig.params[index] === "dynamic") {
            return arg === null ? null : _nativeDynamicFromHost(arg, exportsForMarshal);
          }
          return arg;
        });
      }
      // (#1700) Argument marshalling: copy JS Uint8Array → Wasm vec via
      // `__new_vec_f64` + `__vec_set_byte`. Runs even under `marshal: false`
      // because the user must be able to call the export at all.
      const marshalled =
        sig && newVecF64 && vecSetByte
          ? marshalTypedArrayArgs(boundaryArgs, sig, key, newVecF64, vecSetByte)
          : boundaryArgs;
      let result: any;
      try {
        result = (val as Function).apply(this, marshalled);
        scheduleNativeMicrotaskCheckpoint(exportsForMarshal); // (#6982)
      } catch (error) {
        const payload = normalizeModuleCallbackException(
          error,
          { getExports: () => exportsForMarshal },
          "module-tag-payload",
        );
        const translated = _nativeErrorToHost(payload, exportsForMarshal);
        throw translated === _MISS ? payload : translated;
      }
      if (sig?.result === "boolean") {
        if (typeof result !== "number" || (result !== 0 && result !== 1) || Object.is(result, -0)) {
          throw new TypeError(`wrapExports: export "${key}" returned a noncanonical Boolean wire value`);
        }
        return result === 1;
      }
      if (sig?.result === "string" && result != null) {
        const stringToHost = exportsForMarshal.__str_to_extern as ((value: any) => string) | undefined;
        if (typeof stringToHost === "function") return stringToHost(result);
      }
      if (sig?.result === "symbol") {
        const symbolValue = _nativeSymbolFromId(Number(result), exportsForMarshal);
        if (symbolValue !== _MISS) return symbolValue;
      }
      if (result == null || !_isWasmStruct(result)) return result;
      const boundaryError = _nativeErrorToHost(result, exportsForMarshal);
      if (boundaryError !== _MISS) return boundaryError;
      const boundaryPrimitive = _nativePrimitiveToHost(result, exportsForMarshal);
      if (boundaryPrimitive !== _MISS) return boundaryPrimitive;
      const boundaryPromise = _nativePromiseToHost(result, exportsForMarshal);
      if (boundaryPromise !== _MISS) return boundaryPromise;
      const marshalable = looksMarshalable(result);
      const resultMarshal = hasMarshalOverride
        ? marshal
        : (marshalModeForBoundaryPolicy(exportBoundaryPolicy?.result.policy) ?? marshal);
      if (dataStructDecoderMasked && resultMarshal !== false) {
        // (#6438) `marshal: false` still hands back the raw handle; every
        // decoding mode refuses rather than answering `{}` / `[{}, …]`. The
        // NOT-marshalable arm is covered too: with the decoder masked and no
        // `__vec_len` export, `looksMarshalable` falls through and a plain
        // struct would be handed to JS as a callable (#1308 fallback) — just as
        // wrong, and just as silent. `__is_closure` still exempts real closures.
        const undecodable = rawExportsStructDecodeError(result, exportsForMarshal, key, structDecodeProbes);
        if (undecodable) throw undecodable;
      }
      if (resultMarshal === "copy" && marshalable) {
        const plain = _wasmToPlain(result, exportsForMarshal);
        // (#1700) Uint8Array fidelity on the return side. The Wasm signature
        // is ambiguous (Uint8Array and number[] share `(ref null $Vec[f64])`)
        // so we wrap based on the TS-level metadata, not a runtime probe.
        if (sig && sig.result === "uint8array" && _nativeIsArray(plain)) {
          return new Uint8Array(plain as number[]);
        }
        return plain;
      }
      if (resultMarshal === "live" && marshalable) {
        return _wrapForHost(result, exportsForMarshal);
      }
      if (marshalable) {
        // Struct/vec but `marshal: false` → return the raw WasmGC handle
        // so advanced callers can use the exported `__sget_*` / `__vec_*`
        // helpers directly without the copy overhead.
        return result;
      }
      // Not marshalable → treat as a closure (regression guard for #1308).
      return makeCallableClosureWrapper(result);
    };
    wrapped[key] = invoke;
  }
  return wrapped;
}

/**
 * Wrap an instance using the provider/interop policy captured at compile time.
 * Compatibility builds retain detached copies. A native-first JS build uses
 * live boundary objects automatically: Wasm owns state and identity, while
 * JavaScript sees `_wrapForHost` only at the edge.
 */
export function wrapCompiledExports(
  result: CompileResult,
  instanceOrExports: WebAssembly.Instance | WebAssembly.Exports,
  options: Omit<WrapExportsOptions, "signatures" | "boundaryPolicies"> = {},
): Record<string, any> {
  const profile = result.targetProfile;
  const policyDiagnostics = validateExportBoundaryPolicies(result.exportSignatures, result.exportBoundaryPolicies);
  if (policyDiagnostics.length > 0) {
    throw new Error(`Invalid export boundary policy manifest: ${policyDiagnostics.join("; ")}`);
  }
  if (options.marshal === "live" && profile?.hostValueInterop === "off") {
    throw new Error('Live JS boundary objects require hostBridge: "always" for this target');
  }
  return wrapExports(instanceOrExports, {
    ...options,
    signatures: result.exportSignatures,
    boundaryPolicies: result.exportBoundaryPolicies,
  });
}

/** Instantiate a Wasm module, trying native wasm:js-string builtins first
 *  (Chrome 130+, Firefox 135+), falling back to the JS polyfill.
 *  Uses importedStringConstants to provide string literals as globals. */
export async function instantiateWasm(
  binary: ArrayBuffer | ArrayBufferView,
  env: Record<string, Function>,
  stringConstants?: Record<string, WebAssembly.Global>,
  // (#2880) hex-keyed namespace for surrogate-containing string constants.
  // Optional + default-empty so existing 3-arg callers keep working unchanged.
  stringConstants16?: Record<string, WebAssembly.Global>,
): Promise<{ instance: WebAssembly.Instance; nativeBuiltins: boolean }> {
  const sc = stringConstants ?? {};
  const sc16 = stringConstants16 ?? {};
  const bytes = binary as BufferSource;
  // The data-struct bridge re-exports the exact imported Global as its
  // per-buildImports association capability. Native imported-string
  // constants are engine-created and therefore cannot preserve that object
  // identity; keep this narrow family on the explicit polyfill import path.
  const preserveDataStructAssociation = sc[DATA_STRUCT_HOST_BRIDGE_TOKEN_VALUE] !== undefined;
  if (JS_STRINGS_NATIVE_BUILTIN && !preserveDataStructAssociation) {
    try {
      const { instance } = await (WebAssembly.instantiate as Function)(
        bytes,
        { env, string_constants: sc, [STRING_CONSTANTS16_NS]: sc16 },
        { builtins: ["js-string"], importedStringConstants: "string_constants" },
      );
      return { instance, nativeBuiltins: true };
    } catch {
      // Fall through to the JS polyfill path.
    }
  }
  const { instance } = await WebAssembly.instantiate(bytes, {
    env,
    "wasm:js-string": jsString,
    string_constants: sc,
    [STRING_CONSTANTS16_NS]: sc16,
  } as WebAssembly.Imports);
  return { instance, nativeBuiltins: false };
}

/** Instantiate a precompiled Wasm module from a Response/URL using streaming compilation
 *  when available, falling back to byte instantiation if needed.
 *  Shared runtime helpers stay outside the module-specific payload. */
export async function instantiateWasmStreaming(
  source: Response | Promise<Response> | RequestInfo | URL,
  env: Record<string, Function>,
  stringConstants?: Record<string, WebAssembly.Global>,
  // (#2880) hex-keyed namespace for surrogate-containing string constants.
  stringConstants16?: Record<string, WebAssembly.Global>,
): Promise<{ instance: WebAssembly.Instance; nativeBuiltins: boolean }> {
  const sc = stringConstants ?? {};
  const sc16 = stringConstants16 ?? {};
  const response = source instanceof Response ? source : source instanceof Promise ? await source : await fetch(source);
  const byteFallback = response.clone();
  const preserveDataStructAssociation = sc[DATA_STRUCT_HOST_BRIDGE_TOKEN_VALUE] !== undefined;

  if (typeof WebAssembly.instantiateStreaming === "function") {
    if (JS_STRINGS_NATIVE_BUILTIN && !preserveDataStructAssociation) {
      try {
        const { instance } = await (WebAssembly.instantiateStreaming as Function)(
          response,
          { env, string_constants: sc, [STRING_CONSTANTS16_NS]: sc16 },
          { builtins: ["js-string"], importedStringConstants: "string_constants" },
        );
        return { instance, nativeBuiltins: true };
      } catch {
        // Fall back to clone and try non-streaming below.
      }
    } else {
      try {
        const { instance } = await WebAssembly.instantiateStreaming(response, {
          env,
          "wasm:js-string": jsString,
          string_constants: sc,
          [STRING_CONSTANTS16_NS]: sc16,
        } as WebAssembly.Imports);
        return { instance, nativeBuiltins: false };
      } catch {
        // Fall back to byte instantiation below.
      }
    }
  }

  const bytes = new Uint8Array(await byteFallback.arrayBuffer());
  return instantiateWasm(bytes, env, sc, sc16);
}

/** Compile TypeScript source and instantiate the Wasm module. */
export async function compileAndInstantiate(source: string, deps?: Record<string, any>): Promise<WebAssembly.Exports> {
  const result = await compileSource(source);
  if (!result.success) {
    throw new Error(result.errors.map((e) => e.message).join("\n"));
  }
  const imports = buildCompiledImports(result, deps);
  const binary = new Uint8Array(result.binary);
  const { instance } = await instantiateWasm(binary, imports.env, imports.string_constants, imports.string_constants16);
  imports.setInstance?.(instance);
  return instance.exports;
}
