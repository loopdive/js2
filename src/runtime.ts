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
import {
  createJavaScriptAdapterManifest,
  validateJavaScriptAdapterManifest,
  type JavaScriptAdapterManifestV1,
} from "./adapter-manifest.js";
import {
  createEvalShim,
  createNewFunctionShim,
  hasActiveUnshadowedTest262Assert,
  rawTest262AssertShimEnabled,
} from "./runtime-eval.js";
import * as wsh from "./runtime/wasm-struct-host-semantics.js";
import { STRING_CONSTANTS16_NS } from "./string-surrogate.js";
import {
  _GeneratorState,
  _AsyncGeneratorState,
  _getSynthArrayIteratorPrototype,
  _getGeneratorInstancePrototype,
  _getGeneratorFunctionPrototype,
  _getAsyncGeneratorInstancePrototype,
  _getAsyncGeneratorFunctionPrototype,
  _installIteratorHelperPolyfills,
  _resetIteratorRuntimeIntrinsicsForRealmIsolation,
} from "./runtime/iterator-polyfills.js";
import { buildStringConstants, buildStringConstants16 } from "./runtime/string-constants.js";
import { isHostStringSymbolDispatch, makeHostStringPredicateAdapter } from "./runtime/string-predicate-adapter.js";
import { fixedExternMethodCallArity, makeFixedExternMethodCall } from "./runtime/fixed-extern-method-call.js";
import { DATE_HOST_METHOD_UNHANDLED, tryCallWasmDateHostMethod } from "./runtime/date-host-method.js";
import { getWasmVecPrototypeMember as vecProtoGet, WASM_VEC_PROTOTYPE_MISS } from "./runtime/wasm-vec-prototype.js";
import { fnctorInstanceofResult, fnctorOrNative, type FnctorIoHooks } from "./runtime/fnctor-instanceof.js";
export { buildStringConstants, buildStringConstants16 };
export { _resetIteratorRuntimeIntrinsicsForRealmIsolation };
import {
  compiledClosureNativeSource,
  createNativeFunctionCallbackBridge,
  installNativeFunctionSourceFacade,
  invokeNativeFunctionCallback,
  normalizeModuleCallbackException,
} from "./runtime/native-function-source.js";
import * as test262Host from "./runtime/test262-harness-host.js"; // (#4394)
import { ASYNC_CALLBACK_EXCEPTION_POLICY } from "./ir/async-runtime-providers.js";
import { _arrayProtoSparseFastPaths } from "./runtime/array-proto-sparse.js"; // (#3103, #1234) sparse-aware Array.prototype fast paths
import { registerVecMirror, snapshotVecMirrors, reconcileVecMirrors } from "./runtime/vec-mirror-writeback.js"; // (#3603 S1) vec-mirror write-back
import { createHostCallImport, isHostCallImportName } from "./runtime/host-call-abi.js";
import { createBoundaryObjectAdapter } from "./runtime/boundary-object-adapter.js";
import { createBoundaryCallbackAdapter } from "./runtime/boundary-callback-adapter.js";
import { createBoundaryPromiseAdapter } from "./runtime/boundary-promise-adapter.js";
import { createBoundaryValueAdapter, isBoundaryValueImportIntent } from "./runtime/boundary-value-adapter.js";
import { createInstanceLifecycleAdapter } from "./runtime/instance-lifecycle-adapter.js";
import { resolvePlatformCapabilityImport } from "./runtime/platform-capability-adapter.js";
import {
  CLOCK_CAPABILITY_AUTHORITY,
  createCompiledDomCapabilityRuntime,
  DOM_CAPABILITY_AUTHORITY,
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
import { createClassMemberResolver, createResolvedClassMethodInvoker } from "./runtime/class-method-host-bridge.js";
import { resolveSubclassParent } from "./runtime/class-method-host-bridge.js";
import { getWebHostConstructors } from "./runtime/web-host-constructors.js";
import {
  _rerouteStringSymbolMethodPrimitive,
  _makeLegacyRegExpState,
  _updateLegacyRegExpState,
  type LegacyRegExpState,
} from "./runtime/legacy-regexp.js";
export { buildWasiPolyfill } from "./runtime/wasi-polyfill.js";

/**
 * Portable require() for loading Node.js builtin modules (#1044).
 * Works in both CJS (require is global) and ESM (createRequire from node:module).
 * Returns undefined in non-Node environments (browsers).
 */
let _nodeRequire: ((id: string) => any) | null | undefined;
function _getNodeRequire(): ((id: string) => any) | undefined {
  if (_nodeRequire !== undefined) return _nodeRequire ?? undefined;
  // CJS context
  if (typeof require === "function") {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _nodeRequire = require;
    return _nodeRequire;
  }
  // ESM context in Node.js: use process.getBuiltinModule (Node 22.3+)
  // to synchronously access createRequire without a static `import` of node:module
  try {
    const nodeModule = (globalThis.process as any)?.getBuiltinModule?.("module");
    if (nodeModule?.createRequire) {
      const baseUrl = `file://${globalThis.process.cwd()}/index.js`;
      _nodeRequire = nodeModule.createRequire(baseUrl);
      return _nodeRequire!;
    }
  } catch {
    // Not Node.js or getBuiltinModule not available
  }
  _nodeRequire = null;
  return undefined;
}

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
const _wasmStructProps = new WeakMap<object, Record<string | symbol, any>>();

// (#2739) Host-recorded [[Prototype]] link for an opaque WasmGC struct. A struct
// exported to JS has no host-observable [[Prototype]] (`Object.getPrototypeOf`
// returns null/the engine default), so `Object.setPrototypeOf(struct, proto)` /
// `Reflect.setPrototypeOf` / `struct.__proto__ = proto` record the user-intended
// prototype here, and the for-in walk + read path consult it via
// `_structUserProto`. A recorded value may be `null` (setPrototypeOf(o, null));
// presence is tested with `.has`, never `!== undefined`.
const _wasmStructProto = new WeakMap<object, any>();

// Links constructed instances to their closure constructor's prototype sidecar.
const _fnctorInstanceCtor = new WeakMap<object, object>();

/**
 * (#2743 a) Arguments objects are ordinary Objects (§10.4.4): their
 * `[[Prototype]]` is %Object.prototype% and `.constructor` resolves to %Object%.
 * The compiled `arguments` vec is an opaque WasmGC struct, so the host MOP can't
 * see those by itself — codegen registers each arguments vec here (host-mode
 * only; standalone keeps the bare vec) and the `__getPrototypeOf` /
 * `__extern_get` / `__hasOwnProperty` hooks treat a registered vec as an
 * ordinary Object inheriting from %Object.prototype%.
 */
const _argumentsObjects = new WeakSet<object>();

/**
 * (#2743 a) Own-property predicate for a registered arguments object. `length`
 * and `callee` are always own properties of an arguments object (§10.4.4 —
 * callee is present-but-poisoned in strict mode, an ordinary data property in
 * sloppy mode). The numeric indices `0 .. length-1` are also own, but the vec's
 * length is opaque to the host here, so they are not reported (no in-scope
 * conformance test checks `arguments.hasOwnProperty(<index>)`; the
 * length/callee keys are what the suite exercises). A genuinely-numeric-index
 * own check is a documented follow-up gap.
 */
function _argumentsHasOwn(_obj: any, key: any): boolean {
  return key === "length" || key === "callee";
}

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
  while (cur != null && typeof cur === "object" && guard++ < 16) {
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
    cur = Object.getPrototypeOf(cur);
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
const _wasmStructDeletedKeys = new WeakMap<object, Set<string | symbol>>();

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
const _wasmStructShadowedFields = new WeakMap<object, Set<string>>();

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
const _wasmPropDescs = new WeakMap<object, Map<string | symbol, number>>();

/**
 * Sidecar accessor storage for WasmGC structs.
 * Stores get/set functions for accessor properties (including Symbol-keyed ones).
 * Separate from _wasmStructProps because template literals can't stringify Symbols.
 */
const _wasmStructAccessors = new WeakMap<object, Map<string | symbol, { get?: Function; set?: Function }>>();

/** Tracks WasmGC struct objects that have been frozen via Object.freeze. */
const _wasmFrozenObjs = new WeakSet<object>();
/** Tracks WasmGC struct objects that have been sealed via Object.seal. */
const _wasmSealedObjs = new WeakSet<object>();
/** Tracks WasmGC struct objects that are non-extensible (freeze/seal/preventExtensions). */
const _wasmNonExtensibleObjs = new WeakSet<object>();

/**
 * User-class instanceof support for subclasses of builtins (#1455).
 *
 * When the compiler emits `class Sub extends Map {}`, the constructor calls
 * `__new_Map(arg)` to produce a real JS Map instance (externref). The instance
 * does NOT have `Sub.prototype` in its `[[Prototype]]` chain, so the natural
 * `v instanceof Sub` would return false. We tag each constructed instance via
 * `__tag_user_class(instance, "Sub", parentTag)` and consult the tag chain
 * inside the modified `__instanceof` host check.
 *
 * - `_userClassTags` — innermost user-class name attached to each externref
 *   instance (only set for externref-backed user subclasses).
 * - `_userClassParents` — user-class parent chain. When a user subclass
 *   extends another user subclass (e.g. `class A extends B extends Map`),
 *   walking the chain from "A" via parents finds "B" → null.
 */
const _userClassTags = new WeakMap<object, string>();
const _userClassParents = new Map<string, string | null>();

// (#1991) Object.prototype's own enumerable+non-enumerable data/accessor keys.
// `key in obj` walks to Object.prototype (§13.10.1 → §7.3.12), so every object
// value has these regardless of own properties — used by `__extern_has` to
// answer e.g. `"toString" in ({} as any)` for opaque WasmGC-struct receivers.
const _OBJECT_PROTO_KEYS: ReadonlySet<string> = new Set([
  "constructor",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__proto__",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

/**
 * (#2580 M3 B-protoextend) Inherited indexed property lookup via the
 * `Object.prototype` chain.
 *
 * A generic Array method invoked on an array-like *plain object* receiver
 * (`Array.prototype.indexOf.call({length:3}, v)`) reads `obj[i]` per §7.3.2
 * `Get`, which walks the receiver's `[[Prototype]]` chain. A plain object's
 * chain terminates at `%Object.prototype%`, so a test that writes
 * `Object.prototype[0] = true` makes `({length:3})[0]` resolve to `true`
 * (the `built-ins/Array/prototype/<m>/<m>-9-b-i-N` "element to be retrieved
 * is inherited data property on an Array-like object" cluster).
 *
 * In this compiler an array-like plain-object receiver is an *opaque WasmGC
 * struct* whose runtime `[[Prototype]]` is `null` — it does NOT inherit from
 * the host `Object.prototype`, so the own-only `obj[i]` / sidecar lookups in
 * `__extern_get_idx`/`__extern_has_idx` miss the inherited index and the
 * generic-method loop skips it (verified per-process: `(idx in obj)=false`
 * while `idx in Object.prototype === true`). `Object.prototype[i] = v` DOES
 * land on the real host `Object.prototype` (member-assignment lowers to a
 * host write), so consulting it here reads exactly what the test wrote.
 *
 * Scope: this is the FINAL fallback, reached only after own struct fields,
 * the sidecar, and accessor descriptors are exhausted — so a real array, a
 * `$Vec`, or any receiver carrying its own index never enters this arm (its
 * own element is found earlier). Real-array receivers with an
 * `Array.prototype[i]=v` inherited element already resolve through the native
 * array path (verified passing), so this arm intentionally consults only
 * `%Object.prototype%`, the single chain every object value shares — matching
 * the architect decision to route inherited reads through the ONE shared
 * `Object.prototype` walk rather than a per-receiver prototype field.
 *
 * `_protoIndexHas` answers `[[HasProperty]]` (§7.3.12 — presence is
 * value-independent, so an inherited slot holding `undefined` is still
 * present); `_protoIndexGet` runs `[[Get]]` (invokes an inherited accessor via
 * native `[]`). Only canonical non-negative integer indices participate
 * (negative / fractional keys are not array element indices).
 */
function _protoIndexHas(idx: number): boolean {
  if (!Number.isInteger(idx) || idx < 0) return false;
  // `idx in Object.prototype` walks Object.prototype's own keys; a user write
  // `Object.prototype[i] = v` (own data prop) or `defineProperty` (accessor)
  // both register here. `Object.create(null)`-style holes never match.
  return idx in (Object.prototype as Record<number, unknown>);
}

function _protoIndexGet(idx: number): unknown {
  if (!Number.isInteger(idx) || idx < 0) return undefined;
  return (Object.prototype as Record<number, unknown>)[idx];
}

/**
 * DataView subview metadata (#1064).
 *
 * The compiler emits `new DataView(buffer, byteOffset, byteLength)` as the raw
 * i32_byte vec struct — it never stores the user-specified view window. The
 * runtime bridge in `__extern_method_call` rebuilds a real JS DataView from
 * the struct's bytes, so without this sidecar it only ever sees the full
 * buffer and `sample.getUint16(1)` on a 2-byte subview silently reads 2 bytes
 * from the 12-byte buffer instead of throwing RangeError.
 *
 * Keyed on the vec struct. Written by `__dv_register_view` at DataView
 * construction. Read by the `__extern_method_call` DataView fallback below.
 * Sharing one buffer across multiple interleaved DataViews is a known
 * limitation — the latest registration wins.
 */
const _dvViewMeta = new WeakMap<object, { offset: number; length: number }>();

/**
 * Tracks ArrayBuffer-shaped wasmGC structs that have been detached via
 * `$DETACHBUFFER` (test262 harness) or `transfer()` (#1515).
 *
 * Per ECMA §25.1.5.1, all DataView and TypedArray operations on a detached
 * buffer must throw TypeError. We track by struct identity — the wasmGC
 * i32_byte vec struct that backs an ArrayBuffer.
 */
const _detachedBuffers = new WeakSet<object>();

/**
 * (#3097) Canonical host ArrayBuffer per compiled-ArrayBuffer vec struct.
 *
 * The compiler lowers `new ArrayBuffer(n)` to an i32_byte vec struct in the
 * JS-host lane. When that struct crosses the construct bridge as a ctor arg
 * (`new TA(buffer, offset, length)` / `new DataView(buffer, ...)` on a host
 * constructor), V8 sees an opaque non-buffer object and builds a LENGTH-0
 * array-like view instead of a buffer view. Marshal the struct to ONE
 * canonical host ArrayBuffer (identity-cached, one-time byte copy) so:
 *   - `new TA(buffer, 0, 4)` builds the correct windowed view, and
 *   - sibling views over the same compiled buffer share bytes (aliasing).
 *
 * One-way marshal by design: compiled-side vec writes made AFTER the first
 * crossing are not reflected into the host buffer (and vice versa) — true
 * bidirectional aliasing is #2773 value-rep substrate territory.
 *
 * `_abHostBufferReverse` maps the canonical host buffer back to its vec
 * struct so `__extern_get(hostTA, "buffer")` can return the ORIGINAL struct:
 * compiled-side identity (`sample.buffer === buffer`) holds, and re-crossing
 * (`new TA2(sample.buffer)`) canonicalizes to the SAME host buffer.
 */
const _abHostBufferCache = new WeakMap<object, ArrayBuffer>();
const _abHostBufferReverse = new WeakMap<ArrayBuffer, object>();

/**
 * (#3097) Marshal a compiled-ArrayBuffer i32_byte vec struct to its canonical
 * host ArrayBuffer. Returns undefined when `vec` is not an i32_byte vec struct
 * (the `__dv_byte_len` export answers -1 for any other value — it is the
 * positive discriminator, mirroring `__is_vec`). A struct already detached
 * (test262 `$DETACHBUFFER` / `transfer()`) marshals as a DETACHED host buffer
 * so host-side construction throws the spec TypeError.
 */
function _compiledAbToHostBuffer(vec: any, exports: Record<string, Function> | undefined): ArrayBuffer | undefined {
  if (!exports || vec == null || typeof vec !== "object" || !_isWasmStruct(vec)) return undefined;
  const cached = _abHostBufferCache.get(vec);
  if (cached !== undefined) return cached;
  const lenFn = exports.__dv_byte_len as ((v: any) => number) | undefined;
  const getFn = exports.__dv_byte_get as ((v: any, i: number) => number) | undefined;
  if (typeof lenFn !== "function" || typeof getFn !== "function") return undefined;
  let n: number;
  try {
    n = lenFn(vec);
  } catch {
    return undefined;
  }
  if (typeof n !== "number" || n < 0) return undefined;
  // (#3058) A `$__resizable_ab` struct (compiled `new ArrayBuffer(n,
  // {maxByteLength})`) marshals to a HOST resizable ArrayBuffer so host
  // TypedArray/DataView views built over it length-track a later
  // `rab.resize()` natively (the resize arm in __extern_method_call keeps the
  // canonical host buffer's byteLength in sync via hostAb.resize()).
  const maxLenFn = exports.__ab_max_len as ((v: any) => number) | undefined;
  let maxLen = -1;
  if (typeof maxLenFn === "function") {
    try {
      maxLen = maxLenFn(vec);
    } catch {
      maxLen = -1;
    }
  }
  // (lib.d.ts here predates the ES2024 options overload — cast the ctor.)
  const AbCtor = ArrayBuffer as unknown as new (len: number, opts?: { maxByteLength?: number }) => ArrayBuffer;
  let ab = typeof maxLen === "number" && maxLen >= 0 ? new AbCtor(n, { maxByteLength: maxLen }) : new ArrayBuffer(n);
  const view = new Uint8Array(ab);
  for (let i = 0; i < n; i++) view[i] = getFn(vec, i) & 0xff;
  _abHostBufferCache.set(vec, ab);
  _abHostBufferReverse.set(ab, vec);
  if (_detachedBuffers.has(vec) || _sidecarGet(vec, "__detached__")) {
    try {
      (ab as { transfer?: () => ArrayBuffer }).transfer?.();
    } catch {
      /* engine without ArrayBuffer.prototype.transfer — leave attached */
    }
  }
  return ab;
}

/**
 * (#3335) Marshal one argument of a dynamic [[Construct]] on a HOST callee
 * (`__construct` / `__construct_closure` / `__reflect_construct`).
 *
 * Order of conversions:
 *   1. compiled-ArrayBuffer vec struct → canonical host ArrayBuffer (#3097);
 *   2. compiled ARRAY (vec struct) → real host Array via the same
 *      `__vec_len`/`__vec_get` materialization `_materializeIterable` uses.
 *
 * Without step 2, a host built-in receiving a raw vec struct treats it as a
 * non-array-like (its `length` reads as undefined → 0): the six test262
 * BigInt `TypedArray.prototype.set` files constructed a LENGTH-0
 * `new BigInt64Array(compiledArr)` whose later `.set(src, 0)` threw the host
 * RangeError "offset is out of bounds" — a message the #3189 ratchet (and
 * the poison classifier) bins as an uncatchable oob TRAP. Materializing the
 * array restores honest host semantics: either a correctly-sized view (when
 * element marshalling suffices) or a deterministic, CATCHABLE host TypeError.
 *
 * Non-vec structs and host values pass through unchanged; compiled-closure
 * callees never reach this (they re-enter Wasm with raw structs).
 */
function _marshalHostConstructArg(
  a: any,
  exports: Record<string, Function> | undefined,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
  hostCallee?: any,
): any {
  const buf = _compiledAbToHostBuffer(a, exports);
  if (buf !== undefined) return buf;
  if (a != null && typeof a === "object" && _isWasmStruct(a)) {
    const mat = _materializeIterable(a, callbackState);
    if (mat !== a) return mat;
    // Array.from in a compiled callback can return a data-struct array-like
    // rather than a vec (its numeric elements live in the live host mirror).
    // A native cross-realm TypedArray constructor accepts that array-like just
    // fine; preserve its length/index properties instead of treating the
    // opaque backing struct as an unmarshalable value.
    if (_isHostTypedArrayCtor(hostCallee)) {
      const mirror = _wrapForHost(a, exports);
      if (mirror !== a && typeof mirror.length === "number") return mirror;
    }
    // (#3335) Refuse loudly: the arg is a compiled struct NONE of the
    // marshal probes can decode (not an AB vec, not a readable vec — e.g.
    // the opaque box a value acquires crossing a host bound-function
    // round-trip). Handing it to a host %TypedArray% constructor makes V8
    // treat it as a non-array-like → a silent LENGTH-0 view whose later
    // `.set()` throws "offset is out of bounds", which the #3189 ratchet
    // and the poison classifier bin as an UNCATCHABLE oob trap. A
    // deterministic, catchable TypeError is the honest bridging failure —
    // and it is realm-state-independent, so the failure mode cannot flap
    // between runs (the 45→51 oob baseline flap this guard resolves).
    if (_isHostTypedArrayCtor(hostCallee)) {
      const nm = typeof hostCallee.name === "string" && hostCallee.name ? hostCallee.name : "TypedArray";
      throw new TypeError(`cannot marshal opaque compiled value to host ${nm} constructor`);
    }
  }
  return a;
}

/** (#3335) Is `fn` a host %TypedArray% subclass constructor (Int8Array … BigUint64Array)? */
const _HOST_TYPED_ARRAY_CTOR_NAMES = new Set([
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
]);

function _isHostTypedArrayCtor(fn: any): boolean {
  if (typeof fn !== "function") return false;
  try {
    const taBase = Object.getPrototypeOf(Int8Array);
    if (fn === taBase || Object.getPrototypeOf(fn) === taBase) return true;
    // The Test262 runner executes the harness in an isolated realm. Its
    // intrinsic constructors are not identity-equal to this module's global
    // constructors, but retain the standard name and BYTES_PER_ELEMENT
    // contract. Recognize that cross-realm shape so dynamic `new TA(values)`
    // still marshals compiled arrays into real host arrays before construction.
    const name = typeof fn.name === "string" ? fn.name : "";
    const proto = fn.prototype;
    return (
      _HOST_TYPED_ARRAY_CTOR_NAMES.has(name) &&
      proto != null &&
      typeof proto === "object" &&
      proto.constructor === fn &&
      typeof fn.BYTES_PER_ELEMENT === "number" &&
      typeof proto.BYTES_PER_ELEMENT === "number"
    );
  } catch {
    return false;
  }
}

/**
 * (#3058) `maxByteLength` of a compiled-ArrayBuffer vec struct: field 2 of a
 * `$__resizable_ab` (≥ 0), or -1 when the struct is a fixed buffer / the module
 * has no resizable-buffer type (no `__ab_max_len` export). The -1 sentinel is
 * the host-side `resizable` discriminator, mirroring the compile-time
 * `ref.test $__resizable_ab` identity.
 */
function _abMaxByteLength(vec: any, exports: Record<string, Function> | undefined): number {
  const fn = exports?.__ab_max_len as ((v: any) => number) | undefined;
  if (typeof fn !== "function") return -1;
  try {
    const m = fn(vec);
    return typeof m === "number" ? m : -1;
  } catch {
    return -1;
  }
}

/**
 * (#3058) ArrayBuffer.prototype.resize (§25.1.6.4) on a compiled-ArrayBuffer
 * i32_byte vec struct receiver — the host-lane arm of the #3054-C resizable
 * machinery. Spec-ordered validation:
 *   2. RequireInternalSlot([[ArrayBufferMaxByteLength]]) → TypeError when the
 *      receiver is a fixed buffer (maxByteLength sentinel -1).
 *   4. ToIndex(newLength) → RangeError on negative / non-index.
 *   5. IsDetachedBuffer → TypeError.
 *   6. newByteLength > maxByteLength → RangeError.
 * Then `__rab_resize` swaps the struct's `data`/`length` fields IN PLACE (the
 * compiled-side identity every native read site sees), and the canonical host
 * ArrayBuffer (if the struct already crossed the #3097 marshal bridge) is
 * resized in lock-step so host TypedArray/DataView views length-track.
 *
 * Returns true when the receiver was a byte-vec struct and the resize was
 * handled (including by throwing); false → caller falls through.
 */
function _abResizeStruct(obj: any, newLengthArg: any, exports: Record<string, Function> | undefined): boolean {
  if (!exports || obj == null || typeof obj !== "object" || !_isWasmStruct(obj)) return false;
  const lenFn = exports.__dv_byte_len as ((v: any) => number) | undefined;
  if (typeof lenFn !== "function") return false;
  let n: number;
  try {
    n = lenFn(obj);
  } catch {
    return false;
  }
  if (typeof n !== "number" || n < 0) return false; // not an AB-backing byte vec
  // §25.1.6.4 step 2 — a fixed-length buffer has no [[ArrayBufferMaxByteLength]].
  const maxLen = _abMaxByteLength(obj, exports);
  if (maxLen < 0) {
    throw new TypeError("ArrayBuffer.prototype.resize called on a non-resizable buffer");
  }
  // step 4 — ToIndex(newLength).
  let newLen = newLengthArg === undefined ? 0 : Number(newLengthArg);
  if (Number.isNaN(newLen)) newLen = 0;
  newLen = Math.trunc(newLen);
  if (Object.is(newLen, -0)) newLen = 0;
  if (newLen < 0 || newLen > Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Invalid array buffer length");
  }
  // step 5 — detached buffer.
  if (_detachedBuffers.has(obj) || _sidecarGet(obj, "__detached__")) {
    throw new TypeError("ArrayBuffer.prototype.resize called on a detached buffer");
  }
  // step 6 — out of declared bounds.
  if (newLen > maxLen) {
    throw new RangeError("ArrayBuffer.prototype.resize: newLength exceeds maxByteLength");
  }
  const resizeFn = exports.__rab_resize as ((v: any, l: number) => number) | undefined;
  if (typeof resizeFn !== "function") {
    // Unreachable when maxLen >= 0 (both exports are emitted together); be safe.
    throw new TypeError("ArrayBuffer.prototype.resize called on a non-resizable buffer");
  }
  const status = resizeFn(obj, newLen);
  if (status === 1) throw new TypeError("ArrayBuffer.prototype.resize called on a non-resizable buffer");
  if (status !== 0) throw new RangeError("ArrayBuffer.prototype.resize: newLength exceeds maxByteLength");
  // Keep the canonical host buffer (if any) in lock-step so host TA/DataView
  // views over it length-track. The cache key is the struct identity, which
  // `__rab_resize` preserves (it swaps FIELDS, not the struct).
  const hostAb = _abHostBufferCache.get(obj);
  if (hostAb) {
    try {
      (hostAb as ArrayBuffer & { resize?: (l: number) => void }).resize?.(newLen);
    } catch {
      /* non-resizable host buffer (pre-#3058 cache shape) — views can't track */
    }
  }
  return true;
}

/**
 * (#3097) `byteLength` for an ArrayBuffer/DataView-backing i32_byte vec struct
 * read through the GENERIC extern getter (an `any`-typed receiver — e.g.
 * `sample.buffer.byteLength` after the exit-boundary un-marshal returned the
 * vec struct). The struct has no real `byteLength` field and no
 * `__sget_byteLength` export, so the read otherwise resolves undefined → NaN.
 * Honors a `_dvViewMeta` window when the struct was registered as a DataView.
 * Returns undefined for any non-byte-vec value (`__dv_byte_len` answers -1).
 */
function _byteVecByteLength(obj: any, exports: Record<string, Function> | undefined): number | undefined {
  if (!exports || obj == null || typeof obj !== "object" || !_isWasmStruct(obj)) return undefined;
  const lenFn = exports.__dv_byte_len as ((v: any) => number) | undefined;
  if (typeof lenFn !== "function") return undefined;
  let n: number;
  try {
    n = lenFn(obj);
  } catch {
    return undefined;
  }
  if (typeof n !== "number" || n < 0) return undefined;
  const meta = _dvViewMeta.get(obj);
  if (meta) return meta.length >= 0 ? meta.length : Math.max(0, n - meta.offset);
  return n;
}

const _SC_WRITABLE = 1;
const _SC_ENUMERABLE = 2;
const _SC_CONFIGURABLE = 4;
const _SC_DEFINED = 8;
const _SC_ACCESSOR = 16;

/** Normalize property key for descriptor Map lookups — JS treats numeric keys
 * like 0 and "0" as the same property, but Map uses ===. (#1092) */
function _normalizeDescKey(key: any): string | symbol {
  if (typeof key === "symbol") return key;
  return String(key);
}

function _getSidecarDescs(obj: object): Map<string | symbol, number> {
  if (!_canBeWeakKey(obj)) return new Map();
  let m = _wasmPropDescs.get(obj);
  if (!m) {
    m = new Map();
    _wasmPropDescs.set(obj, m);
  }
  return m;
}

/**
 * (#2744) TestIntegrityLevel (§7.3.16) for a WasmGC struct / vec receiver,
 * computed over OUR descriptor table (`_getSidecarDescs`) rather than "was
 * Object.freeze/seal called" (the `_wasmFrozenObjs`/`_wasmSealedObjs` caches).
 *
 *   sealed (`frozen=false`): non-extensible AND every own property is
 *     non-configurable.
 *   frozen (`frozen=true`): sealed AND every own DATA property is non-writable.
 *
 * This answers correctly for objects made non-extensible and then reconfigured
 * via `Object.defineProperty` (e.g. `preventExtensions(o)` on an object whose
 * props were defined non-writable+non-configurable → `isFrozen` is true), which
 * the WeakSet cache cannot. Own keys = static struct fields (`_getStructFieldNames`)
 * + dynamic sidecar props (`_wasmStructProps`), minus tombstoned (`delete`d) keys.
 * A property with NO descriptor entry is a default data property
 * (writable+enumerable+configurable) → not sealed/frozen.
 */
function _testIntegrityLevel(obj: any, frozen: boolean, exports: Record<string, Function> | undefined): boolean {
  // An extensible object can never be sealed or frozen (§7.3.16 step 4).
  if (!_wasmNonExtensibleObjs.has(obj)) return false;
  const descs = _getSidecarDescs(obj);
  // Use the canonical own-key enumeration (skips internal `__get_`/`__set_`
  // accessor-storage keys, tombstoned `delete`d keys, and includes symbols /
  // class methods consistently with Object.keys/getOwnPropertyNames).
  for (const key of _ownStructKeys(obj, exports)) {
    const flags = descs.get(_normalizeDescKey(key));
    // No descriptor → default data property (writable+configurable): fails both.
    if (flags === undefined) return false;
    // Both sealed and frozen require every own property be non-configurable.
    if (flags & _SC_CONFIGURABLE) return false;
    // Frozen additionally requires data properties be non-writable. Accessor
    // properties (no writable attribute) are exempt from the writable check.
    if (frozen && !(flags & _SC_ACCESSOR) && flags & _SC_WRITABLE) return false;
  }
  return true;
}

/**
 * Validate a defineProperty call against existing sidecar property descriptor.
 * Implements ES spec 9.1.6.3 ValidateAndApplyPropertyDescriptor for WasmGC structs.
 * Throws TypeError if the redefinition violates non-configurable constraints.
 * Returns the new flags to store.
 */
function _validatePropertyDescriptor(
  descs: Map<string | symbol, number>,
  prop: string | symbol,
  desc: PropertyDescriptor,
  existingValue?: any,
  existingDesc?: PropertyDescriptor,
): number {
  const existing = descs.get(_normalizeDescKey(prop));
  const hasValue = _hasOwn(desc, "value");
  const hasWritable = _hasOwn(desc, "writable");
  const hasEnumerable = _hasOwn(desc, "enumerable");
  const hasConfigurable = _hasOwn(desc, "configurable");
  const hasGet = _hasOwn(desc, "get");
  const hasSet = _hasOwn(desc, "set");

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

function _toPropertyDescriptorValidate(
  rawDesc: any,
  getField: (o: any, f: string) => any,
  wrapCallable?: (v: any, arity: number) => any,
  hasField?: (o: any, f: string) => boolean,
): PropertyDescriptor {
  // Primitive rawDesc (number/string/boolean/symbol/bigint) violates
  // ECMA-262 10.1 step 1 — throw TypeError. We intentionally allow null/undefined
  // through as an empty descriptor because reads from WasmGC struct fields whose
  // backing value is absent can surface null even when the source-level literal
  // was a valid (if opaque-to-JS) object; throwing here would mask harmless
  // struct storage gaps as spec violations. Callers that want strict spec
  // behavior on null/undefined should filter before calling.
  if (rawDesc != null && typeof rawDesc !== "object" && typeof rawDesc !== "function") {
    throw new TypeError("TypeError: Property description must be an object: " + String(rawDesc));
  }
  const desc: PropertyDescriptor = {};
  if (rawDesc == null) return desc;
  const has = (field: string): boolean => {
    if (hasField) return hasField(rawDesc, field);
    return field in Object(rawDesc);
  };
  const hasEnumerable = has("enumerable");
  const hasConfigurable = has("configurable");
  const hasValue = has("value");
  const hasWritable = has("writable");
  const hasGet = has("get");
  const hasSet = has("set");
  const val = hasValue ? getField(rawDesc, "value") : undefined;
  const wr = hasWritable ? getField(rawDesc, "writable") : undefined;
  const en = hasEnumerable ? getField(rawDesc, "enumerable") : undefined;
  const conf = hasConfigurable ? getField(rawDesc, "configurable") : undefined;
  let getFn = hasGet ? getField(rawDesc, "get") : undefined;
  let setFn = hasSet ? getField(rawDesc, "set") : undefined;
  // (#1629a) When the source descriptor is a WasmGC struct, `get`/`set` arrive
  // as Wasm-closure structs (not JS callables). Wrap them into JS Functions so
  // the spec-mandated `typeof === "function"` checks below pass and so that the
  // resulting property descriptor invokes the closure correctly when called.
  if (wrapCallable) {
    if (getFn != null && typeof getFn !== "function") getFn = wrapCallable(getFn, 0);
    if (setFn != null && typeof setFn !== "function") setFn = wrapCallable(setFn, 1);
  }
  const hasData = hasValue || hasWritable;
  const hasAccessor = hasGet || hasSet;
  if (hasData && hasAccessor) {
    throw new TypeError(
      "TypeError: Invalid property descriptor. Cannot both specify accessors and a value or writable attribute",
    );
  }
  // (#3116) Stringify defensively: `String(x)` on a null-prototype / opaque
  // WasmGC value throws "Cannot convert object to primitive value" INSIDE the
  // error-message construction, replacing the spec TypeError with a confusing
  // one (and masking the real rejection reason).
  const safeStr = (x: any): string => {
    try {
      return String(x);
    } catch {
      return "[object Object]";
    }
  };
  if (hasGet && getFn !== undefined && typeof getFn !== "function") {
    throw new TypeError("TypeError: Getter must be a function: " + safeStr(getFn));
  }
  if (hasSet && setFn !== undefined && typeof setFn !== "function") {
    throw new TypeError("TypeError: Setter must be a function: " + safeStr(setFn));
  }
  if (hasValue) desc.value = val;
  if (hasWritable) desc.writable = !!wr;
  if (hasEnumerable) desc.enumerable = !!en;
  if (hasConfigurable) desc.configurable = !!conf;
  if (hasGet) desc.get = getFn;
  if (hasSet) desc.set = setFn;
  return desc;
}

/** Return true when `obj` is a WasmGC struct (opaque to JS). */
// #2180 — user `new Proxy` / `Proxy.revocable` objects we construct. A Proxy
// over a WasmGC-struct target otherwise trips `_isWasmStruct`'s probe: it has a
// null prototype (inherited from the struct target) and a property set on it
// forwards to the opaque struct and throws "opaque" — so the heuristic
// misclassifies the Proxy AS a struct, routing `delete`/`in`/etc. to the
// sidecar instead of letting the host fire the user trap. Excluding registered
// user proxies keeps them on the host MOP path.
const _userProxies = new WeakSet<object>();

/**
 * (#2617) Is `obj` a tracked user Proxy (built from `new Proxy(...)` /
 * `Proxy.revocable(...)` and registered in `_userProxies`)?
 */
function _isUserProxy(obj: any): boolean {
  return obj != null && typeof obj === "object" && _userProxies.has(obj);
}

/**
 * (#2617) Shared re-throw gate for the boundary helpers' `catch (e)`.
 *
 * Each boundary helper (`__extern_get` / `__extern_has` / `__delete_property` /
 * `__getPrototypeOf` / …) wraps its host MOP read in a try/catch that, on
 * failure, falls through to a generic struct/undefined path. That fallthrough
 * is correct for a genuine WasmGC struct, but WRONG for a **user Proxy**: an
 * exception from the host MOP on a user Proxy is exactly what the program must
 * observe — either the user trap's own abrupt completion, or the host engine's
 * §10.5 invariant TypeError. Swallowing it returns a wrong value instead of the
 * throw. So re-throw when the receiver is a user Proxy (or the pre-existing
 * revoked-proxy case). Return normally (caller falls through) otherwise, so the
 * non-proxy struct fast path is byte-for-byte unchanged.
 */
function _rethrowIfProxyOrRevoked(e: any, obj: any): void {
  if (_isRevokedProxyError(e) || _isUserProxy(obj)) throw e;
}

const _VEC_HOST_BRIDGE_EXPORTS = [
  ["__vec_len", "$v0"],
  ["__vec_get", "$v1"],
  ["__is_vec", "$v2"],
  ["__vec_mut_supported", "$v3"],
  ["__vec_push", "$v4"],
  ["__vec_pop", "$v5"],
] as const;

const _CLOSURE_HOST_BRIDGE_EXPORTS = [
  ["__call_fn_0", "$c0"],
  ["__call_fn_1", "$c1"],
  ["__call_fn_2", "$c2"],
  ["__call_fn_3", "$c3"],
  ["__call_fn_4", "$c4"],
  ["__call_fn_method_0", "$c5"],
  ["__call_fn_method_1", "$c6"],
  ["__call_fn_method_2", "$c7"],
  ["__call_fn_method_3", "$c8"],
  ["__call_fn_method_4", "$c9"],
  ["__call_fn_method_5", "$ca"],
  ["__call_fn_method_6", "$cb"],
  ["__call_fn_method_7", "$cc"],
  ["__call_fn_method_8", "$cd"],
  ["__closure_arity", "$ce"],
  ["__is_closure", "$cf"],
  ["__closure_has_rest", "$cg"],
] as const;

const _DATA_STRUCT_HOST_BRIDGE_EXPORTS = [
  ["__is_data_struct", "$d0"],
  ["__struct_field_names", "$d1"],
] as const;

const _CLOSURE_HOST_BRIDGE_MANIFEST = ["__\0js2_closure_host_bridge", "$cm"] as const;
const _CLOSURE_HOST_BRIDGE_MARKER = ["__\0js2_closure_host_bridge_marker", "$ct"] as const;
const _CLOSURE_HOST_BRIDGE_BINDINGS = ["__\0js2_closure_host_bridge_bindings", "$cu"] as const;
const _CLOSURE_HOST_BRIDGE_MANIFEST_MAGIC = 0x5a200000;
const _CLOSURE_HOST_BRIDGE_MANIFEST_MAGIC_MASK = 0xfff00000;
const _CLOSURE_HOST_BRIDGE_MANIFEST_BITS_MASK = 0x0001ffff;
const _CLOSURE_HOST_BRIDGE_MANIFEST_RESERVED_MASK = 0x000e0000;
const _DATA_STRUCT_HOST_BRIDGE_MANIFEST = ["__\0js2_data_struct_host_bridge", "$dm"] as const;
const _DATA_STRUCT_HOST_BRIDGE_MARKER = ["__\0js2_data_struct_host_bridge_marker", "$dt"] as const;
const _DATA_STRUCT_HOST_BRIDGE_BINDINGS = ["__\0js2_data_struct_host_bridge_bindings", "$du"] as const;
const _DATA_STRUCT_HOST_BRIDGE_TOKEN = ["__\0js2_data_struct_host_bridge_token", "$dv"] as const;
const _DATA_STRUCT_HOST_BRIDGE_TOKEN_VALUE = "\0js2_data_struct_host_bridge_token";
const _DATA_STRUCT_HOST_BRIDGE_MANIFEST_MAGIC = 0x5a300000;
const _DATA_STRUCT_HOST_BRIDGE_MANIFEST_MAGIC_MASK = 0xfff00000;
const _DATA_STRUCT_HOST_BRIDGE_MANIFEST_BITS_MASK = 0x00000003;
const _DATA_STRUCT_HOST_BRIDGE_MANIFEST_RESERVED_MASK = 0x000ffffc;
const _immutableI32GlobalVerdict = new WeakSet<WebAssembly.Global>();
let _immutableI32GlobalProbeModule: WebAssembly.Module | undefined;
const _emptyFuncrefTableVerdict = new WeakSet<WebAssembly.Table>();
const _bindingFuncrefTableVerdict = new WeakSet<WebAssembly.Table>();
const _dataBindingFuncrefTableVerdict = new WeakSet<WebAssembly.Table>();
let _emptyFuncrefTableProbeModule: WebAssembly.Module | undefined;
let _bindingFuncrefTableProbeModule: WebAssembly.Module | undefined;
let _dataBindingFuncrefTableProbeModule: WebAssembly.Module | undefined;
const _reflectApply = Reflect.apply;
const _objectHasOwnProperty = Object.prototype.hasOwnProperty;
const _instanceExportsGetter = Object.getOwnPropertyDescriptor(WebAssembly.Instance.prototype, "exports")?.get;

/**
 * Test ownership without consulting mutable Function.prototype.call or a
 * subsequently replaced Reflect.apply.
 */
function _hasOwn(value: unknown, key: PropertyKey): boolean {
  return _reflectApply(_objectHasOwnProperty, value, [key]) as boolean;
}

/**
 * Read exports through the WebAssembly.Instance internal-slot brand check.
 *
 * `instanceof` is insufficient: an ordinary object can inherit from
 * WebAssembly.Instance.prototype, and a Proxy around an instance retains that
 * prototype. The captured intrinsic application also remains valid if user
 * code later replaces Function.prototype.call.
 */
function _brandedInstanceExports(value: unknown): WebAssembly.Exports | undefined {
  if (!_instanceExportsGetter) return undefined;
  try {
    return _reflectApply(_instanceExportsGetter, value, []) as WebAssembly.Exports;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the terminal compiler alias in one collision-safe physical family.
 */
function _terminalHostBridgeAlias(exports: Record<string, any>, physicalBase: string): unknown {
  let physicalName = physicalBase;
  let helper: unknown;
  while (_hasOwn(exports, physicalName)) {
    helper = exports[physicalName];
    physicalName += "$";
  }
  return helper;
}

/** Prove a Global's exact type and mutability through Wasm import validation. */
function _isImmutableI32Global(value: unknown): value is WebAssembly.Global {
  if (!(value instanceof WebAssembly.Global)) return false;
  if (_immutableI32GlobalVerdict.has(value)) return true;
  try {
    _immutableI32GlobalProbeModule ??= new WebAssembly.Module(
      Uint8Array.from([0, 97, 115, 109, 1, 0, 0, 0, 2, 8, 1, 1, 101, 1, 103, 3, 127, 0]),
    );
    new WebAssembly.Instance(_immutableI32GlobalProbeModule, { e: { g: value } });
    _immutableI32GlobalVerdict.add(value);
    return true;
  } catch {
    return false;
  }
}

/** Prove a Table's exact funcref limits through Wasm import validation. */
function _isExactFuncrefTable(value: unknown, size: 0 | 2 | 17): value is WebAssembly.Table {
  try {
    if (!(value instanceof WebAssembly.Table) || value.length !== size) return false;
    const verdict =
      size === 0
        ? _emptyFuncrefTableVerdict
        : size === 2
          ? _dataBindingFuncrefTableVerdict
          : _bindingFuncrefTableVerdict;
    if (verdict.has(value)) return true;
    const bytes =
      size === 0
        ? [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 101, 1, 116, 1, 112, 1, 0, 0]
        : size === 2
          ? [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 101, 1, 116, 1, 112, 1, 2, 2]
          : [0, 97, 115, 109, 1, 0, 0, 0, 2, 10, 1, 1, 101, 1, 116, 1, 112, 1, 17, 17];
    let probe =
      size === 0
        ? _emptyFuncrefTableProbeModule
        : size === 2
          ? _dataBindingFuncrefTableProbeModule
          : _bindingFuncrefTableProbeModule;
    if (!probe) {
      probe = new WebAssembly.Module(Uint8Array.from(bytes));
      if (size === 0) _emptyFuncrefTableProbeModule = probe;
      else if (size === 2) _dataBindingFuncrefTableProbeModule = probe;
      else _bindingFuncrefTableProbeModule = probe;
    }
    new WebAssembly.Instance(probe, { e: { t: value } });
    verdict.add(value);
    return true;
  } catch {
    return false;
  }
}

interface ClosureHostBridgeMetadata {
  bits: number;
  bindings: WebAssembly.Table;
}

interface DataStructHostBridgeMetadata {
  bits: number;
  marker: WebAssembly.Table;
  manifest: WebAssembly.Global;
  bindings: WebAssembly.Table;
  token: WebAssembly.Global;
}

interface DataStructHostBridgeAuthority extends DataStructHostBridgeMetadata {
  helpers: readonly (Function | undefined)[];
}

const _dataStructHostBridgeAuthorityByManifest = new WeakMap<WebAssembly.Global, DataStructHostBridgeAuthority>();

/** Read and authenticate compiler-authored closure-helper metadata. */
function _closureHostBridgeMetadata(exports: Record<string, any>): ClosureHostBridgeMetadata | undefined {
  const [markerLogicalName, markerPhysicalBase] = _CLOSURE_HOST_BRIDGE_MARKER;
  if (!_hasOwn(exports, markerLogicalName)) return undefined;
  const marker = _terminalHostBridgeAlias(exports, markerPhysicalBase);
  if (!_isExactFuncrefTable(marker, 0)) return undefined;

  const [logicalName, physicalBase] = _CLOSURE_HOST_BRIDGE_MANIFEST;
  if (!_hasOwn(exports, logicalName)) return undefined;
  const manifest = _terminalHostBridgeAlias(exports, physicalBase);
  if (!_isImmutableI32Global(manifest) || typeof manifest.value !== "number") return undefined;
  const value = manifest.value | 0;
  if ((value & _CLOSURE_HOST_BRIDGE_MANIFEST_MAGIC_MASK) !== _CLOSURE_HOST_BRIDGE_MANIFEST_MAGIC) return undefined;
  if ((value & _CLOSURE_HOST_BRIDGE_MANIFEST_RESERVED_MASK) !== 0) return undefined;
  const bits = value & _CLOSURE_HOST_BRIDGE_MANIFEST_BITS_MASK;

  const [bindingsLogicalName, bindingsPhysicalBase] = _CLOSURE_HOST_BRIDGE_BINDINGS;
  if (!_hasOwn(exports, bindingsLogicalName)) return undefined;
  const bindings = _terminalHostBridgeAlias(exports, bindingsPhysicalBase);
  if (!_isExactFuncrefTable(bindings, 17)) return undefined;
  try {
    for (let bit = 0; bit < _CLOSURE_HOST_BRIDGE_EXPORTS.length; bit++) {
      const binding = bindings.get(bit);
      if ((bits & (1 << bit)) !== 0 ? typeof binding !== "function" : binding !== null) return undefined;
    }
  } catch {
    return undefined;
  }
  return { bits, bindings };
}

/**
 * Read and authenticate compiler-authored data-struct helper metadata.
 *
 * The exported binding table is necessarily mutable. Its shape and current
 * contents therefore cannot authenticate callable identity by themselves.
 * Establish authority only from the frozen `WebAssembly.Instance.exports`
 * object, then pin the exact marker/global/table and callable identities in
 * runtime-owned state. A later caller-supplied projection may use the same
 * immutable manifest as its lookup key, but cannot redirect either callable by
 * mutating or replacing the exported table.
 */
function _dataStructHostBridgeMetadata(
  exports: Record<string, any>,
  expectedAuthority?: DataStructHostBridgeAuthority,
  expectedToken?: WebAssembly.Global,
  mayEstablishAuthority = false,
  mayConsumeGlobalAuthority = false,
): DataStructHostBridgeAuthority | undefined {
  const [markerLogicalName, markerPhysicalBase] = _DATA_STRUCT_HOST_BRIDGE_MARKER;
  if (!_hasOwn(exports, markerLogicalName)) return undefined;
  const marker = _terminalHostBridgeAlias(exports, markerPhysicalBase);
  if (!_isExactFuncrefTable(marker, 0)) return undefined;

  const [logicalName, physicalBase] = _DATA_STRUCT_HOST_BRIDGE_MANIFEST;
  if (!_hasOwn(exports, logicalName)) return undefined;
  const manifest = _terminalHostBridgeAlias(exports, physicalBase);
  if (!_isImmutableI32Global(manifest) || typeof manifest.value !== "number") return undefined;
  const value = manifest.value | 0;
  if ((value & _DATA_STRUCT_HOST_BRIDGE_MANIFEST_MAGIC_MASK) !== _DATA_STRUCT_HOST_BRIDGE_MANIFEST_MAGIC) {
    return undefined;
  }
  if ((value & _DATA_STRUCT_HOST_BRIDGE_MANIFEST_RESERVED_MASK) !== 0) return undefined;
  const bits = value & _DATA_STRUCT_HOST_BRIDGE_MANIFEST_BITS_MASK;

  const [bindingsLogicalName, bindingsPhysicalBase] = _DATA_STRUCT_HOST_BRIDGE_BINDINGS;
  if (!_hasOwn(exports, bindingsLogicalName)) return undefined;
  const bindings = _terminalHostBridgeAlias(exports, bindingsPhysicalBase);
  if (!_isExactFuncrefTable(bindings, 2)) return undefined;
  try {
    for (let bit = 0; bit < _DATA_STRUCT_HOST_BRIDGE_EXPORTS.length; bit++) {
      const binding = bindings.get(bit);
      if ((bits & (1 << bit)) !== 0 ? typeof binding !== "function" : binding !== null) return undefined;
    }
  } catch {
    return undefined;
  }

  const [tokenLogicalName, tokenPhysicalBase] = _DATA_STRUCT_HOST_BRIDGE_TOKEN;
  if (!_hasOwn(exports, tokenLogicalName)) return undefined;
  const token = _terminalHostBridgeAlias(exports, tokenPhysicalBase);
  if (!(token instanceof WebAssembly.Global)) return undefined;
  if (expectedToken !== undefined && token !== expectedToken) return undefined;

  const helpers: (Function | undefined)[] = [];
  for (let bit = 0; bit < _DATA_STRUCT_HOST_BRIDGE_EXPORTS.length; bit++) {
    const [, physicalBase] = _DATA_STRUCT_HOST_BRIDGE_EXPORTS[bit]!;
    const helper = _terminalHostBridgeAlias(exports, physicalBase);
    if ((bits & (1 << bit)) !== 0) {
      if (typeof helper !== "function" || helper !== bindings.get(bit)) return undefined;
      helpers.push(helper);
    } else {
      helpers.push(undefined);
    }
  }

  const authority =
    expectedAuthority ??
    (mayConsumeGlobalAuthority ? _dataStructHostBridgeAuthorityByManifest.get(manifest) : undefined);
  if (authority !== undefined) {
    if (
      authority.bits !== bits ||
      authority.marker !== marker ||
      authority.manifest !== manifest ||
      authority.bindings !== bindings ||
      authority.token !== token
    ) {
      return undefined;
    }
    for (let bit = 0; bit < helpers.length; bit++) {
      if (authority.helpers[bit] !== helpers[bit] || authority.helpers[bit] !== bindings.get(bit)) return undefined;
    }
    return authority;
  }

  // Only a branded instance path may establish first authority. Raw records
  // can contain genuine donor functions and immutable globals, so their shape
  // is not evidence of origin.
  if (!mayEstablishAuthority) return undefined;
  const established = Object.freeze({
    bits,
    marker,
    manifest,
    bindings,
    token,
    helpers: Object.freeze(helpers),
  });
  _dataStructHostBridgeAuthorityByManifest.set(manifest, established);
  return established;
}

/**
 * Compose vec, closure, and data-struct projections from one raw export object.
 *
 * Vec keeps its collision-only logical-name gate. Closure and data-struct
 * availability come only from their compiler-authored manifests;
 * user-controlled helper-like names never establish ownership. All overrides
 * land in one prototype view so no bridge family hides another's raw own
 * properties.
 */
interface HostBridgeAuthorityOptions {
  expectedDataStructAuthority?: DataStructHostBridgeAuthority;
  expectedDataStructToken?: WebAssembly.Global;
  establishDataStructAuthority?: (authority: DataStructHostBridgeAuthority) => void;
  mayEstablishDataStructAuthority?: boolean;
  mayConsumeGlobalDataStructAuthority?: boolean;
  recordExportView?: (rawExports: Record<string, any>, finalExports: Record<string, any>) => void;
}

function _hostBridgeExportView<T extends Record<string, any>>(exports: T, options: HostBridgeAuthorityOptions = {}): T {
  const overrides = new Map<string, unknown>();
  for (const [logicalName, physicalBase] of _VEC_HOST_BRIDGE_EXPORTS) {
    if (!_hasOwn(exports, logicalName)) continue;
    const helper = _terminalHostBridgeAlias(exports, physicalBase);
    if (typeof helper !== "function" || exports[logicalName] === helper) continue;
    overrides.set(logicalName, helper);
  }

  const closureMetadata = _closureHostBridgeMetadata(exports);
  for (let bit = 0; bit < _CLOSURE_HOST_BRIDGE_EXPORTS.length; bit++) {
    const [logicalName, physicalBase] = _CLOSURE_HOST_BRIDGE_EXPORTS[bit]!;
    if (!_hasOwn(exports, logicalName)) continue;
    let helper: unknown;
    if (closureMetadata !== undefined && (closureMetadata.bits & (1 << bit)) !== 0) {
      helper = _terminalHostBridgeAlias(exports, physicalBase);
      if (typeof helper !== "function" || helper !== closureMetadata.bindings.get(bit)) helper = undefined;
    }
    if (exports[logicalName] === helper) continue;
    overrides.set(logicalName, helper);
  }

  const dataStructMetadata = _dataStructHostBridgeMetadata(
    exports,
    options.expectedDataStructAuthority,
    options.expectedDataStructToken,
    options.mayEstablishDataStructAuthority,
    options.mayConsumeGlobalDataStructAuthority,
  );
  if (dataStructMetadata !== undefined) options.establishDataStructAuthority?.(dataStructMetadata);
  for (let bit = 0; bit < _DATA_STRUCT_HOST_BRIDGE_EXPORTS.length; bit++) {
    const [logicalName, physicalBase] = _DATA_STRUCT_HOST_BRIDGE_EXPORTS[bit]!;
    if (!_hasOwn(exports, logicalName)) continue;
    let helper: unknown;
    if (dataStructMetadata !== undefined && (dataStructMetadata.bits & (1 << bit)) !== 0) {
      helper = _terminalHostBridgeAlias(exports, physicalBase);
      if (typeof helper !== "function" || helper !== dataStructMetadata.bindings.get(bit)) helper = undefined;
    }
    if (exports[logicalName] === helper) continue;
    overrides.set(logicalName, helper);
  }

  if (overrides.size === 0) {
    options.recordExportView?.(exports, exports);
    return exports;
  }
  const view = Object.create(exports) as T;
  for (const [logicalName, helper] of overrides) {
    Object.defineProperty(view, logicalName, {
      value: helper,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  options.recordExportView?.(exports, view);
  return view;
}

// (#3673) Memoized classification for `_isWasmStruct`. The predicate is on the
// hot path of EVERY boundary helper (`__extern_get`/`_safeGet`/`_safeSet` call
// it several times per crossing), and the original probe-set-and-catch
// implementation forced a V8 exception throw/catch plus a fresh Symbol PER CALL
// for every WasmGC struct receiver — measured at 57% of total CPU during a
// compiled-acorn parse. Classification is stable for a given object identity
// (a struct never becomes a plain object and vice versa), so cache the verdict
// in a single WeakMap (one probe per call — ~20k calls per small acorn parse
// makes the second probe of a two-WeakSet scheme measurable). Note
// `_userProxies` membership also answers false, and a proxy can only be cached
// here as non-struct — consistent either way.
const _wasmStructVerdict = new WeakMap<object, boolean>();

function _isWasmStruct(obj: any): boolean {
  if (obj == null || typeof obj !== "object") return false;
  const verdict = _wasmStructVerdict.get(obj);
  if (verdict !== undefined) return verdict;
  if (_userProxies.has(obj)) return false;
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
      // Ordering is untouched: the memo and the `_userProxies` WeakSet are still
      // consulted first, so a user proxy's [[GetPrototypeOf]] trap is invoked
      // exactly as often as before.
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
function _isWasmVec(v: any, exports: Record<string, Function> | undefined): boolean {
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
function _canBeWeakKey(obj: any): boolean {
  return obj != null && (typeof obj === "object" || typeof obj === "function");
}

/**
 * IsConcatSpreadable (§23.1.3.1.1) for an opaque WasmGC struct receiver: true
 * iff `Symbol.isConcatSpreadable` resolves to a truthy value. The flag is stored
 * in the sidecar under both the real symbol and the `@@isConcatSpreadable`
 * string mirror (see `_symbolIdToKeys`). Returns false when the property is
 * absent or falsy, so a plain array-like is NOT spread unless explicitly tagged.
 */
function _isConcatSpreadable(
  obj: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): boolean {
  const v = _safeGet(obj, Symbol.isConcatSpreadable, callbackState) ?? _sidecarGet(obj, "@@isConcatSpreadable");
  return v !== undefined && v !== null && !!v;
}

const _wasmClosureWrapperSource = new WeakMap<Function, { closure: any; arity: number }>();
const _wasmClosureDynamicWrapperCache = new WeakMap<object, Function>();
const _wasmClosureWrapperCache = new WeakMap<object, Map<number, Function>>();
const _wasmClosureWrapperTargets = new WeakMap<Function, object>();
const _wasmAccessorGetterReturnWrappers = new WeakSet<Function>();
const _wasmGetterCallbackWrappers = new WeakSet<Function>();
// #3214 B2 — `__make_callback(-1, closure)` bridges a reusable canonical void
// IR closure without minting a legacy `__cb_N` export. Cache the
// non-constructible JS arrow per raw closure so repeated boundary conversion
// preserves identity. The compiler-owned -2 sentinel proves an inline closure
// is consumed once and intentionally bypasses this cache.
const _wasmVoidHostCallbackCache = new WeakMap<object, Function>();
const _test262ErrorConstructors = new WeakSet<Function>();

_test262ErrorConstructors.add(test262Host.HostTest262Error);

// (#3369) Callback bridges must remain usable while the evaluated program has
// installed non-writable numeric properties on Array.prototype. `[].push(x)`
// and direct indexed assignment perform [[Set]] and can be rejected by such an
// inherited property. Define dense own argument slots explicitly instead.
// Capture the intrinsics before user code runs so the helper is also immune to
// later rebinding of Array/Reflect properties.
const _IntrinsicArray = Array;
const _intrinsicReflectApply = Reflect.apply;
const _intrinsicReflectConstruct = Reflect.construct;
const _intrinsicReflectDefineProperty = Reflect.defineProperty;
function _denseOwnArgs(args: ArrayLike<any>, length: number): any[] {
  const dense = new _IntrinsicArray<any>(length);
  for (let i = 0; i < length; i++) {
    _intrinsicReflectDefineProperty(dense, i, {
      value: i < args.length ? args[i] : undefined,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return dense;
}

// Arguments crossing from a host callback back into a compiled closure may be
// live `_wrapForHost` proxies for WasmGC structs. The closure dispatch exports
// accept the underlying typed structs, not their JS-facing proxy views. Build
// the same prototype-safe dense argument list as `_denseOwnArgs`, while
// restoring each proxy to its canonical Wasm value at this boundary.
function _denseOwnWasmArgs(args: ArrayLike<any>, length: number): any[] {
  const dense = _denseOwnArgs(args, length);
  for (let i = 0; i < length; i++) {
    _intrinsicReflectDefineProperty(dense, i, {
      value: _unwrapForHost(dense[i]),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return dense;
}

function _hostEqComparableValue(v: any): any {
  if (typeof v === "function") {
    return _wasmClosureWrapperTargets.get(v as Function) ?? v;
  }
  // (#1712) Canonicalize a `_wrapForHost` proxy back to its underlying raw
  // WasmGC struct before the reference compare. The two dynamic read paths
  // that feed `===`/`!==` disagree on representation: an instance-field read
  // (`this.type`) returns the raw struct, while a module-global + property
  // read (`types$1.eof`) returns the cached host proxy for the SAME struct
  // (the proxy is identity-stable per struct via `_hostProxyCache`). Without
  // this unwrap `proxy === rawStruct` is `false` even though both denote one
  // object — which is exactly why acorn's `parseTopLevel` guard
  // `this.type !== types$1.eof` never tripped and the tokenizer looped forever.
  // `_unwrapForHost` maps any host proxy to its unique struct (1:1 via
  // `_hostProxyReverse`) and passes a non-proxy through unchanged, so two
  // genuinely distinct structs still compare unequal.
  if (v != null && typeof v === "object") {
    return _unwrapForHost(v);
  }
  return v;
}

function _hostStrictEqual(a: any, b: any): boolean {
  const comparableA = _hostEqComparableValue(a);
  const comparableB = _hostEqComparableValue(b);
  if (comparableA === comparableB) return true;

  // The original test262 harness declares `function Test262Error`, while the
  // host exception bridge deliberately constructs a real Error subclass so an
  // abrupt completion can cross Wasm→host iterator calls and back. Treat that
  // bridge constructor as the same function identity only when the other side
  // is the compiled Test262Error closure. Other host/user constructors retain
  // ordinary reference identity.
  const hostCtor =
    typeof a === "function" && _test262ErrorConstructors.has(a)
      ? a
      : typeof b === "function" && _test262ErrorConstructors.has(b)
        ? b
        : undefined;
  if (hostCtor) {
    const other = hostCtor === a ? b : a;
    if (typeof other === "function") {
      const closure = _wasmClosureWrapperTargets.get(other);
      // sta.js installs the distinctive static `Test262Error.thrower` helper on
      // the declaration. Closure function names are not stored in the sidecar,
      // so this own static member is the stable harness identity marker.
      if (closure && _wasmStructProps.get(closure)?.thrower !== undefined) return true;
    }
  }
  return false;
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
            ? argcCallFn(methodArity, receiver, closure, ...methodPadded)
            : methodCallFn(receiver, closure, ...methodPadded);
        return _wasmAccessorGetterReturnWrappers.has(wrapped)
          ? _maybeWrapAccessorGetterCallable(ret, callbackState)
          : ret;
      }
    }
    const ret = callFn(closure, ...padded);
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
  if (_canBeWeakKey(closure)) {
    if (!byArity) {
      byArity = new Map();
      _wasmClosureWrapperCache.set(closure as object, byArity);
    }
    byArity.set(arity, wrapped);
    _wasmClosureWrapperTargets.set(wrapped, closure as object);
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
): ((...args: any[]) => any) | null {
  if (closure != null && typeof closure === "object") {
    const cached = _wasmClosureDynamicWrapperCache.get(closure);
    if (cached) return cached as (...args: any[]) => any;
  }
  if (!callbackState) return null;
  const exports = callbackState.getExports();
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
  const dispatch = function wasmClosureDynamicDispatch(this: any, ...args: any[]): any {
    // (#3051 Slice 3) Host-side [[Construct]] (`new bridge(...)` — e.g. V8's
    // `Construct(C_species, «rx, flags»)` in the RegExp @@split protocol): a
    // raw wasm-struct return must be marshalled to its host mirror so the
    // native consumer can read the constructed object. `new`-path only —
    // plain-call returns stay raw (marshalling generic call exits regressed
    // ~85 dstr files, #3123/#2835).
    const viaNew = new.target !== undefined;
    const marshalNew = (ret: any): any =>
      viaNew && ret != null && typeof ret === "object" && _isWasmStruct(ret)
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
      if (realArityCache >= 0) {
        const exact = Math.max(args.length, realArityCache);
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
        return marshalNew(
          typeof argcCallFn === "function"
            ? argcCallFn(args.length, receiver, closure, ...padded)
            : methodCallFn(receiver, closure, ...padded),
        );
      }
    }
    // Free-function / extracted-method (`const f = o.m; f()`) path: dispatch by the
    // caller's arg count so unbound-`this` + low-arity generator semantics hold
    // (a 0-arg generator invoked via `__call_fn_1` yields a non-iterator).
    let arity = Math.min(args.length, maxArity);
    while (arity > 0 && typeof exports[`__call_fn_${arity}`] !== "function") arity--;
    const callFn = exports[`__call_fn_${arity}`];
    if (typeof callFn !== "function") return undefined;
    const padded = _denseOwnWasmArgs(args, arity);
    return marshalNew(callFn(closure, ...padded));
  };
  const wrapped = function wasmClosureDynamicBridge(this: any, ...args: any[]): any {
    try {
      const result =
        new.target === undefined
          ? _intrinsicReflectApply(dispatch, this, args)
          : _intrinsicReflectConstruct(dispatch, args, new.target);
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
  if (closure != null && typeof closure === "object") {
    _wasmClosureDynamicWrapperCache.set(closure, wrapped);
    _wasmClosureWrapperTargets.set(wrapped, closure);
  }
  return wrapped;
}

/**
 * (#1382) Phase 1 — bridge a possibly-Wasm-closure value into a JS-callable.
 *
 * Centralises the "is this an opaque WasmGC closure struct? if so, wrap it"
 * check that the per-host-import call sites need before handing the value
 * to the native engine. Returns the value unchanged when it's already
 * JS-callable, null/undefined (caller-side TypeError is correct), or any
 * non-struct value. Returns a cached JS Function bridging into
 * `__call_fn_<arity>` for Wasm closure structs.
 *
 * The wrapper is cached per (closure, arity), which preserves accessor
 * descriptor identity for `Object.getOwnPropertyDescriptor(...).get`.
 */
/**
 * (#2837) True if `val` is a raw wasm closure (a WasmGC struct the runtime can
 * wrap into a host callable), i.e. not already a JS function. Used to detect
 * descriptor get/set fields that need wrapping before a native
 * `Object.defineProperties` (which rejects `[object Object]` getters/setters).
 */
function _isWasmClosureValue(
  val: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): boolean {
  if (val == null || typeof val !== "object") return false;
  const exports = callbackState?.getExports();
  const isClosureFn = exports?.__is_closure as ((v: any) => number) | undefined;
  if (typeof isClosureFn === "function") {
    try {
      return isClosureFn(val) === 1;
    } catch {
      /* fall through */
    }
  }
  return _isWasmStruct(val);
}

/**
 * (#2837) True if `descsObj` carries at least one accessor descriptor whose
 * `get`/`set` is a raw wasm closure. Such a descriptors object (e.g. a host
 * `$Object` built by `__new_plain_object` and populated via `__extern_set` — the
 * acorn `prototypeAccessors` idiom) cannot go through native
 * `Object.defineProperties` (it throws "Getter must be a function"); it must take
 * the manual per-key path that wraps the closures to host callables.
 */
function _descsHaveWasmClosureAccessor(
  descsObj: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): boolean {
  if (descsObj == null || typeof descsObj !== "object") return false;
  // NON-INVOKING scan: read via `Object.getOwnPropertyDescriptor` (never fires a
  // getter), NOT `getField` (which WOULD invoke host getters — that double-invoke
  // perturbed `Object/defineProperties` tests with Error-object descriptors and
  // ToPrimitive side effects, #2837 regression). Only a DATA descriptor whose
  // stored value is a nested descriptor object with a wasm-closure get/set (our
  // `$Object` shape, populated via `__extern_set`) qualifies; an ACCESSOR
  // descriptor (a real host getter, e.g. the Error test's `prop`) is skipped
  // without invocation, so arbitrary host descriptor objects take the native path
  // unchanged.
  let keys: string[];
  try {
    keys = Object.getOwnPropertyNames(descsObj);
  } catch {
    return false;
  }
  for (const key of keys) {
    let outer: PropertyDescriptor | undefined;
    try {
      outer = Object.getOwnPropertyDescriptor(descsObj, key);
    } catch {
      continue;
    }
    if (!outer || !("value" in outer)) continue; // accessor / no stored value → skip (no invoke)
    const rawDesc = outer.value;
    if (rawDesc == null || typeof rawDesc !== "object") continue;
    for (const acc of ["get", "set"] as const) {
      let inner: PropertyDescriptor | undefined;
      try {
        inner = Object.getOwnPropertyDescriptor(rawDesc, acc);
      } catch {
        continue;
      }
      if (inner && "value" in inner && _isWasmClosureValue(inner.value, callbackState)) {
        return true;
      }
    }
  }
  return false;
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
 * call it. We use `__is_closure` as the authoritative closure discriminator
 * (avoids wrapping vec wrappers, named structs, plain objects) and the
 * highest available `__call_fn_<arity>` export as the dispatcher.
 *
 * The `__call_fn_N` dispatcher (emitClosureCallExportN in codegen) iterates
 * closures of arity ≤ N; lower-arity closures see their extra args dropped
 * at the wasm-side dispatch arm. So wrapping with the max arity is safe and
 * forwards a reasonable arg count for any caller.
 *
 * Returns the value unchanged when it is not a closure, when callbackState
 * is unavailable, or when no `__call_fn_*` export was emitted.
 */
function _maybeWrapCallableUnknownArity(
  val: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (val == null) return val;
  if (typeof val === "function") return val;
  if (typeof val !== "object") return val;
  if (!callbackState) return val;
  const exports = callbackState.getExports();
  if (!exports) return val;
  const isClosureFn = exports.__is_closure as ((v: any) => number) | undefined;
  if (typeof isClosureFn !== "function") return val;
  try {
    if (isClosureFn(val) !== 1) return val;
  } catch {
    return val;
  }
  return _wrapWasmClosureUnknownArity(val, callbackState) ?? val;
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

/**
 * (#2702) Tri-state result of `V instanceof target` per ECMA-262 §13.10.2
 * (InstanceofOperator) + §7.3.20 (OrdinaryHasInstance). The wasm caller turns
 * this into a value or a *wasm-thrown* `TypeError` (a host-thrown JS error
 * loses its identity crossing the wasm catch boundary, so the throw must
 * originate in wasm — the caller emits it when this returns `2`):
 *
 *   0 → false
 *   1 → true
 *   2 → throw TypeError  (RHS not an object, or not callable with no
 *                         `@@hasInstance`, or a non-callable `@@hasInstance`,
 *                         or OrdinaryHasInstance's `prototype` is not an object)
 *
 * A throwing `@@hasInstance` getter or handler call propagates as a wasm
 * exception (ReturnIfAbrupt) — it is NOT swallowed.
 */
const _INSTANCEOF_THROW = 2;
function _fnctorInstanceofResult(
  v: any,
  target: Function,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): number | undefined {
  return fnctorInstanceofResult(v, target, callbackState?.getExports(), _fnctorInstanceofHooks);
}

function _instanceofResult(
  v: any,
  rawTarget: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
  // `strict` distinguishes the two call paths. The STRING path (`__instanceof`)
  // resolves `target` from `globalThis[ctorName]`, so a non-callable object
  // there is GENUINELY non-callable (`x instanceof Math`) → always throw. The
  // DYNAMIC path (`__instanceof_check`) receives an arbitrary runtime value.
  // (#2740) `null`/`undefined`, primitives, and non-callable HOST objects are
  // decidably non-callable on both paths → TypeError. The one remaining
  // conservative case is a WasmGC data struct: class constructors, class
  // instances, and object literals share one representation (`__is_closure`
  // === 0, `__is_data_struct` === 1), so a genuinely-callable class value held
  // in an any-typed variable cannot be told apart from a plain object until
  // the class-value rep unification (#2763/#3134). On the dynamic path such a
  // struct only throws when it carries its OWN `@@hasInstance` (i.e. opts into
  // the protocol); otherwise it conservatively answers `false`.
  strict = false,
): number {
  // A wasm-closure target must look like a function to the spec checks below.
  const wrapped = _maybeWrapCallableUnknownArity(rawTarget, callbackState);
  const target = typeof wrapped === "function" ? wrapped : rawTarget;

  // §13.10.2 step 1: If Type(target) is not Object, throw a TypeError.
  // A genuine primitive (number / string / boolean / symbol / bigint) always
  // throws. `null`/`undefined`, however, are also produced by features our
  // backend does not yet lower, and the pre-#2702 dynamic path returned
  // `false` for them — so on the DYNAMIC path we keep that conservative
  // `false`. (#2740 verified 2026-07-12: the body-only `Function("...")` /
  // `new Function()` forms now yield real closure wrappers, but the
  // params+body form `Function("name", "this.name=name;")` STILL lowers to
  // `null` — throwing here regresses `primitive instanceof FACTORY` → must be
  // `false`, S15.3.5.3_A1_T1..T8. Do not lift this until that form returns a
  // real callable.) The STRING path (`strict`) and the codegen
  // unconditional-throw path (a statically primitive/`undefined`/`null` RHS)
  // still throw for a genuinely non-object RHS.
  if (target === null || target === undefined) {
    return strict ? _INSTANCEOF_THROW : 0;
  }
  if (typeof target !== "object" && typeof target !== "function") {
    return _INSTANCEOF_THROW;
  }

  // §13.10.2 step 2: instOfHandler = GetMethod(target, @@hasInstance). Reading
  // may invoke an accessor that throws — propagate it (ReturnIfAbrupt).
  const handler = (target as Record<symbol, unknown>)[Symbol.hasInstance];
  if (handler !== undefined && handler !== null && handler !== Function.prototype[Symbol.hasInstance]) {
    // A *custom* @@hasInstance must be callable (GetMethod), else TypeError.
    // §13.10.2 step 4a mandates the handler be invoked with EXACTLY ONE argument
    // (V). The property read may already have wrapped the wasm closure at the
    // method bridge's max arity (=4), which would surface as `arguments.length
    // === 4` inside the handler. Recover the raw closure and re-bridge at the
    // known arity 1 so the wasm dispatcher routes via `__call_fn_method_1`
    // (→ `__argc === 1`) instead of the unknown-arity max bridge (#2764).
    const rawHandler = typeof handler === "function" ? (_wasmClosureWrapperTargets.get(handler) ?? handler) : handler;
    const wrappedHandler = _maybeWrapCallable(rawHandler, 1, callbackState);
    const hfn =
      typeof wrappedHandler === "function" ? wrappedHandler : typeof handler === "function" ? handler : undefined;
    if (typeof hfn !== "function") return _INSTANCEOF_THROW;
    // step 3: Return ToBoolean(Call(instOfHandler, target, «V»)). `this` is the
    // ORIGINAL target so a WasmGC-struct receiver round-trips to the same ref.
    return (hfn as (this: unknown, v: unknown) => unknown).call(rawTarget, v) ? 1 : 0;
  }

  // §13.10.2 step 4: If IsCallable(target) is false, throw a TypeError.
  if (typeof target !== "function") {
    if (strict) return _INSTANCEOF_THROW;
    // Dynamic path: `target` is an object (primitives were thrown at step 1).
    // An OWN `@@hasInstance` (even null/undefined) means it is deliberately
    // used as a non-callable RHS → TypeError.
    if (_hasOwn(target, Symbol.hasInstance)) {
      return _INSTANCEOF_THROW;
    }
    // (#2740) A HOST object (not a WasmGC struct) is native JS — if it were
    // callable, `typeof` would say "function". So a host object here is
    // decidably non-callable → TypeError (`x instanceof Math` routed through
    // an any-typed variable, §13.10.2 step 4). EXCEPTION: a `_wrapForHost`
    // proxy presents as a host object (proto `Object.prototype`, writable) but
    // wraps a WasmGC struct whose callability is NOT decidable — fall through
    // to the conservative struct handling below for those.
    if (!_isWasmStruct(target) && !_hostProxyReverse.has(target)) {
      return _INSTANCEOF_THROW;
    }
    // A WasmGC struct of unknown callability must stay conservative: class
    // constructors, class instances and object literals are all `__is_data_
    // struct` === 1 / `__is_closure` === 0 — indistinguishable until the
    // class-value rep unification (#2763/#3134). Throwing here would turn
    // `x instanceof C` (a class held in an any-typed variable, spec answer
    // true/false) into a spurious TypeError. Return `false` instead.
    return 0;
  }

  // §13.10.2 step 5: Return OrdinaryHasInstance(target, V). (§7.3.20)
  //
  // ORDER MATTERS (#2702): §7.3.20 step 3 ("If Type(O) is not Object, return
  // false") is evaluated BEFORE step 4 ("Let P be ? Get(C, 'prototype')"). So a
  // primitive V short-circuits to `false` WITHOUT ever reading `target.prototype`
  // — the `prototype` getter must not run, and a primitive `prototype` value
  // must NOT throw, when V is itself a primitive (e.g. `0 instanceof
  // Function.prototype`). Checking the prototype first would invert the spec and
  // either fire a `prototype` accessor or throw on a non-object prototype that
  // the spec never reaches.
  if (v === null || v === undefined || (typeof v !== "object" && typeof v !== "function")) {
    return 0;
  }

  const fnctorResult = _fnctorInstanceofResult(v, target as Function, callbackState);
  if (fnctorResult !== undefined) return fnctorResult;

  // §7.3.20 step 4/5: P = Get(target, "prototype"); if Type(P) is not Object →
  // TypeError. Reached only for an object V, per the step-3 short-circuit above.
  let proto: unknown;
  try {
    proto = (target as { prototype?: unknown }).prototype;
  } catch (e) {
    throw e;
  }
  if (proto === null || proto === undefined || (typeof proto !== "object" && typeof proto !== "function")) {
    return _INSTANCEOF_THROW;
  }

  // (#1729/#1992) WasmGC-struct-backed values (object literals, arrays, closures)
  // are opaque to V8's native `instanceof`. Recognise the universal Object /
  // Function memberships explicitly, mirroring the `__instanceof` string path.
  if (typeof v === "object" && _isWasmStruct(v)) {
    if (target === Object) return 1;
    if (target === Function) {
      const exports = callbackState?.getExports();
      const isClosureFn = exports?.__is_closure as ((x: unknown) => number) | undefined;
      try {
        if (typeof isClosureFn === "function" && isClosureFn(v) === 1) return 1;
      } catch {
        /* fall through */
      }
      return 0;
    }
  }

  // (#4394) `err instanceof Test262Error` against the MODULE's own carrier —
  // the prototype walk below can never reach a compiled closure.
  if (test262Host.isModuleTest262ErrorInstance(v, rawTarget)) return 1;

  try {
    return v instanceof (target as { new (...a: unknown[]): unknown }) ? 1 : 0;
  } catch (e) {
    // OrdinaryHasInstance prototype-chain walk raised — a TypeError here is the
    // spec's §7.3.20 step 5 "prototype is not an object" path (e.g. native
    // `[] instanceof Function.prototype` after setting `.prototype` to a string).
    if (e instanceof TypeError) return _INSTANCEOF_THROW;
    throw e;
  }
}

/**
 * (#1382) Per-method callback-slot table — maps a method name to the index
 * of its callback argument and the arity at which the engine will invoke
 * it. Consulted by `__proto_method_call` and `__extern_method_call` so a
 * Wasm-closure callback gets pre-wrapped into a JS Function before the
 * native engine tries to call it.
 *
 * Anything not in the table is passed through unchanged (preserving the
 * pre-#1382 behaviour for methods that don't take callbacks). Adding a new
 * method requires only adding a row here; no codegen changes needed.
 */
const _PROTO_CB_SLOTS: Record<string, { argIdx: number; arity: number }> = {
  // Array.prototype — callback at args[0], invoked as (value, index, array)
  forEach: { argIdx: 0, arity: 3 },
  map: { argIdx: 0, arity: 3 },
  filter: { argIdx: 0, arity: 3 },
  find: { argIdx: 0, arity: 3 },
  findIndex: { argIdx: 0, arity: 3 },
  findLast: { argIdx: 0, arity: 3 },
  findLastIndex: { argIdx: 0, arity: 3 },
  every: { argIdx: 0, arity: 3 },
  some: { argIdx: 0, arity: 3 },
  flatMap: { argIdx: 0, arity: 3 },
  // reduce/reduceRight — callback at args[0], invoked as (acc, value, index, array)
  reduce: { argIdx: 0, arity: 4 },
  reduceRight: { argIdx: 0, arity: 4 },
  // sort — comparator at args[0], invoked as (a, b)
  sort: { argIdx: 0, arity: 2 },
  // String.prototype.replace/replaceAll — replacement may be a fn; spec
  // arity is variadic. Use 4 as a sensible cap (match + 1 capture + offset
  // + string). Full variadic support is Phase 2.
  replace: { argIdx: 1, arity: 4 },
  replaceAll: { argIdx: 1, arity: 4 },
  // Map/WeakMap.prototype.getOrInsertComputed (TC39 Stage 3 upsert
  // proposal — see `__extern_method_call` polyfill) — callback at
  // args[1], invoked as `callback(key)`.
  getOrInsertComputed: { argIdx: 1, arity: 1 },
  // Promise.prototype — onFulfilled/onRejected/onFinally at args[0]
  // (then's second arg is also a callback but covered by 1-arg patterns;
  // dynamic-import `import(spec)['then'](x => x)` is the motivating case).
  then: { argIdx: 0, arity: 1 },
  catch: { argIdx: 0, arity: 1 },
  finally: { argIdx: 0, arity: 0 },
};

/**
 * (#2794) Array.prototype READ-ONLY methods that return a PRIMITIVE (number /
 * boolean / string) and take NO callback. When a compiled program reads an
 * instance array field through dynamic `this` dispatch
 * (`this.scopeStack[i].lexical.indexOf(name)` in acorn's `declareName`), the
 * receiver reaches `__extern_method_call` as an opaque WasmGC vec struct that
 * the host cannot index natively — only `push`/`pop` were wired (via
 * `__vec_push`/`__vec_pop`). These methods are served by MATERIALIZING the vec
 * to a real JS array (`__vec_len` + `__vec_get`) and applying the native method.
 * Restricted to primitive-returning, callback-free methods so the result
 * round-trips cleanly back into Wasm (an array-returning method like `slice`
 * would hand a host JS array back to Wasm, which is a separate representation
 * concern — out of scope here).
 */
const _VEC_PRIMITIVE_READ_METHODS = new Set(["indexOf", "lastIndexOf", "includes", "join"]);

type WasmVecMutationResult = { handled: false } | { handled: true; value: any };

/**
 * Mutate a WasmGC vec before generic host method lookup can observe its
 * materialized Array mirror. Calling `mirror.push(...)` appears successful but
 * only changes the temporary JS array; Acorn's nested RegExp name vector then
 * remains empty (#2802/#1712).
 */
function _tryWasmVecMutation(
  obj: any,
  method: string,
  args: any[] | undefined,
  exports: Record<string, Function> | undefined,
): WasmVecMutationResult {
  if ((method !== "push" && method !== "pop") || !exports) return { handled: false };

  let rawVec = _unwrapForHost(obj);
  if (typeof rawVec === "function") {
    const wrapperTarget = _wasmClosureWrapperTargets.get(rawVec);
    if (wrapperTarget) rawVec = wrapperTarget;
  }
  if (!_isWasmStruct(rawVec)) return { handled: false };

  const mutSupFn = exports.__vec_mut_supported as ((value: any) => number) | undefined;
  let supported = false;
  try {
    supported = typeof mutSupFn === "function" && mutSupFn(rawVec) === 1;
  } catch {
    supported = false;
  }
  if (!supported) return { handled: false };

  if (method === "push" && typeof exports.__vec_push === "function") {
    const pushFn = exports.__vec_push as (value: any, item: any) => number;
    const lenFn = exports.__vec_len as ((value: any) => number) | undefined;
    if (typeof lenFn !== "function") return { handled: false };
    let newLen = lenFn(rawVec);
    for (const arg of args ?? []) {
      newLen = pushFn(rawVec, _unwrapForHost(arg));
      if (newLen < 0) return { handled: false };
    }
    return { handled: true, value: newLen };
  }

  if (method === "pop" && typeof exports.__vec_pop === "function") {
    return { handled: true, value: exports.__vec_pop(rawVec) };
  }
  return { handled: false };
}

/**
 * (#1382) Materialize a Wasm vec into a real JS array via the `__vec_len`
 * + `__vec_get` exports. Non-vec values pass through:
 *   - JS arrays returned as-is.
 *   - JS-iterable objects (anything with `Symbol.iterator`) returned as-is.
 *   - null / non-object values returned as-is (caller handles the type check).
 *
 * Used by `__array_from` so `Array.from(wasmVec, mapFn)` sees a real
 * iterable instead of an opaque WasmGC struct ref. Same machinery the
 * Promise combinators use (#1368).
 */
/**
 * (#1320/#1684) Read a field off an iterator-result value that may be an
 * opaque WasmGC struct. For an object-literal `{ value, done }` returned from
 * a compiled closure, the field lives in the struct slot and is reachable only
 * via the exported `__sget_<field>` getter — plain `result[field]` on an
 * opaque struct returns the zero-initialised default (value=0, done never
 * truthy). For real JS objects (plain-object-literal returns built via
 * `__new_plain_object`, or host-supplied iterators) `_safeGet` reads directly.
 */
function _readIterResultField(result: any, field: string, exports: Record<string, Function> | undefined): any {
  if (result != null && typeof result === "object" && _isWasmStruct(result)) {
    const getter = exports?.[`__sget_${field}`];
    if (typeof getter === "function") {
      try {
        return getter(result);
      } catch {
        /* not a struct field — fall through to _safeGet */
      }
    }
  }
  return _safeGet(result, field);
}

/**
 * (#3195) Resolve a member (`next` / `done` / `value` / `return`) of a closure-
 * iterator object or its result record. Tries native access first, then the
 * safe getter, then the `__sget_<key>` struct export — so it reads both plain-JS
 * and opaque-WasmGC-struct iterators/results. Functionally equivalent to
 * {@link _readIterResultField} for both shapes (a wasm struct's native/`_safeGet`
 * reads yield `undefined`, so both fall through to `__sget_<key>`).
 */
function _resolveIterProp(target: any, key: string, exports: Record<string, Function> | undefined): any {
  let direct: any;
  try {
    direct = target?.[key];
  } catch {
    direct = undefined;
  }
  if (direct !== undefined) return direct;
  const safe = _safeGet(target, key);
  if (safe !== undefined) return safe;
  const sget = exports?.[`__sget_${key}`];
  if (typeof sget === "function") return sget(target);
  return undefined;
}

/**
 * (#3195) The single closure-iterator step loop shared by the three drainers
 * (`_drainClosureIterableToArray`, `_drainWasmClosureIterable`, and the nested
 * `_walkWasmIterator`). Given an already-obtained `iteratorObj`, step it through
 * the closure protocol — native `next()` OR `__call_fn_0` on a wasm-struct
 * `next` — reading each result's `done`/`value` via {@link _resolveIterProp},
 * collecting values into a real JS array.
 *
 * The callers' historical divergences are the options (verified 1:1 against the
 * three originals, #1849 review):
 *  - `cap`: defensive runaway guard (`1e6` for the single-value #1 cases,
 *    `1 << 16` elsewhere).
 *  - `limit`: stop after `limit` values (`Infinity` = full drain).
 *  - `closeOnStop`: §7.4.6 IteratorClose (`return()`) when the loop stops on a
 *    finite `limit` or the `cap` (a NormalCompletion stop) — NOT on natural
 *    `done`. Only the bounded destructuring walk sets it. A non-Object
 *    `return()` result throws a TypeError (§7.4.6 step 9).
 *  - `nullOnMalformedNext`: return `null` (abort — caller keeps the original)
 *    instead of breaking with the values so far, when no usable `.next()` is
 *    found (`_drainClosureIterableToArray`).
 *  - `nullOnMissingCallFn0`: return `null` when the `next` is a wasm-struct
 *    closure but `__call_fn_0` is unavailable (`_drainWasmClosureIterable`'s
 *    wrapper path); others break instead.
 */
function _stepClosureIterator(
  iteratorObj: any,
  exports: Record<string, Function> | undefined,
  opts: {
    cap?: number;
    limit?: number;
    closeOnStop?: boolean;
    nullOnMalformedNext?: boolean;
    nullOnMissingCallFn0?: boolean;
  } = {},
): any[] | null {
  const callFn0 = exports?.["__call_fn_0"];
  const cap = opts.cap ?? 1 << 16;
  const limit = opts.limit ?? Infinity;
  const out: any[] = [];
  let stopped = false;
  let iterCount = 0;
  while (true) {
    if (out.length >= limit) {
      stopped = true;
      break;
    }
    if (iterCount++ >= cap) {
      stopped = true;
      break;
    }
    const nextFn = _resolveIterProp(iteratorObj, "next", exports);
    let result: any;
    if (typeof nextFn === "function") {
      result = nextFn.call(iteratorObj);
    } else if (nextFn != null && typeof nextFn === "object" && _isWasmStruct(nextFn)) {
      // Wasm-struct next — invoke via __call_fn_0. Spec-mandated throws from the
      // user's next() propagate.
      if (typeof callFn0 !== "function") {
        if (opts.nullOnMissingCallFn0) return null;
        break;
      }
      result = callFn0(nextFn);
    } else {
      // No usable .next — malformed iterator.
      if (opts.nullOnMalformedNext) return null;
      break;
    }
    if (result == null) break;
    if (_resolveIterProp(result, "done", exports)) break;
    out.push(_resolveIterProp(result, "value", exports));
  }
  if (opts.closeOnStop && stopped) {
    // §7.4.6 IteratorClose: call return(); a non-Object return result IS
    // observable on this NormalCompletion stop (step 9 → TypeError). Absent
    // return method → NormalCompletion, no call.
    const returnFn = _resolveIterProp(iteratorObj, "return", exports);
    let innerResult: any;
    let called = false;
    if (typeof returnFn === "function") {
      innerResult = returnFn.call(iteratorObj);
      called = true;
    } else if (
      returnFn != null &&
      typeof returnFn === "object" &&
      _isWasmStruct(returnFn) &&
      typeof callFn0 === "function"
    ) {
      innerResult = callFn0(returnFn);
      called = true;
    }
    if (called && (innerResult === null || (typeof innerResult !== "object" && typeof innerResult !== "function"))) {
      throw new TypeError("iterator close: return() did not return an Object");
    }
  }
  return out;
}

/**
 * (#1320/#1684) Drain a closure-backed iterable into a real JS array.
 *
 * When compiled code does `obj[Symbol.iterator] = function () { … }`, the
 * value stored on the plain JS object is an opaque WasmGC closure struct, not
 * a JS function. Native `Array.from` reads `obj[Symbol.iterator]`, sees a
 * non-function, and throws "items[Symbol.iterator] … be a function" (#1320
 * Layer 1). The iterator object the closure returns — and each `{ value, done }`
 * result — may themselves be WasmGC structs whose fields only read back through
 * `__sget_*` (#1320 Layer 2 / #1684).
 *
 * This drives the iterator protocol entirely through `__call_fn_0` + the
 * struct-aware field reader, collecting yielded values into a plain array that
 * native `Array.from` / `Iterator.from` can consume. Mirrors the closure
 * dispatch already done by the `__iterator` host import.
 *
 * Returns null when the object is not a closure-backed iterable (caller keeps
 * the original value).
 */
function _drainClosureIterableToArray(obj: any, exports: Record<string, Function> | undefined): any[] | null {
  const callFn0 = exports?.__call_fn_0;
  if (typeof callFn0 !== "function") return null;
  const iterFn = _safeGet(obj, Symbol.iterator) ?? _safeGet(obj, "@@iterator");
  if (iterFn == null || typeof iterFn !== "object" || !_isWasmStruct(iterFn)) return null;
  const iterator = callFn0(iterFn);
  if (iterator == null) return null;
  // (#3195) Drain through the shared step loop. A generous cap is safe — the
  // test262 cases that reach here yield a single value; a malformed `next()`
  // aborts (returns null → caller keeps the original value).
  return _stepClosureIterator(iterator, exports, { cap: 1_000_000, nullOnMalformedNext: true });
}

/**
 * (#3643 Slice B) Make a NON-iterable WasmGC struct readable as an array-like
 * by native `Array.from` / `Array.fromAsync`.
 *
 * §23.1.2.1 step 6: when the source has no `@@iterator`, `Array.from` uses
 * LengthOfArrayLike + indexed reads. WasmGC structs are opaque to JS, so those
 * reads answered `undefined` and produced `[]` — measured:
 * `Array.from({length: 2, 0: "a", 1: "b"})` → `[]` (host `["a","b"]`), while
 * `Array.prototype.slice.call` on the IDENTICAL receiver was already correct,
 * because it goes through `_wrapForHost`. This routes the non-iterable struct
 * through that same proxy so the spec's own step 6 runs, rather than
 * re-implementing it.
 *
 * Deliberately narrow — it only fires when ALL of these hold, so no currently
 * working path changes shape:
 *   - the value is an opaque WasmGC struct (plain JS objects/arrays untouched),
 *   - it is NOT a vec (`_materializeIterable` already turned those into real
 *     arrays before this point),
 *   - it has no callable `@@iterator` (a wasm-closure `@@iterator` is drained
 *     by `_drainWasmClosureIterable` before this is reached; a native one is
 *     left to the iterable path).
 */
function _arrayFromNonIterableSource(
  v: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (v == null || typeof v !== "object" || !_isWasmStruct(v)) return v;
  const exports = callbackState?.getExports();
  if (!exports) return v;
  try {
    if (_isWasmVec(v, exports)) return v;
    const symIter = _safeGet(v, Symbol.iterator, callbackState) ?? _safeGet(v, "@@iterator", callbackState);
    if (symIter != null) return v;
    return _wrapForHost(v, exports);
  } catch {
    // Any probe failure leaves the value exactly as before this change.
    return v;
  }
}

function _materializeIterable(
  iter: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (iter == null) return iter;
  if (Array.isArray(iter)) return iter;
  if (typeof iter !== "object") return iter;
  // (#1382) Check `_isWasmStruct` BEFORE `Symbol.iterator in iter` —
  // the `in` operator on an opaque WasmGC struct throws "WebAssembly
  // objects are opaque", aborting the host call. `_isWasmStruct`
  // handles the throw internally and returns true for opaque structs.
  if (_isWasmStruct(iter)) {
    const exports = callbackState?.getExports();
    if (!exports) return iter;
    const vecLen = exports.__vec_len;
    const vecGet = exports.__vec_get;
    // (#3637) POSITIVE discriminator. The old `typeof vecLen(iter) === "number"`
    // guard was vacuous (see `_isWasmVec`), so EVERY wasm struct materialised to
    // `[]` here — a plain object, a class instance, or a struct whose
    // `@@iterator` is a wasm closure all came back as an empty array instead of
    // being drained or reported not-iterable. A non-vec struct now falls
    // through to the closure-drain path below, and failing that is returned
    // unchanged so the caller's own not-iterable handling runs.
    if (typeof vecLen === "function" && typeof vecGet === "function" && _isWasmVec(iter, exports)) {
      const len = vecLen(iter) as number;
      if (typeof len !== "number" || len < 0) return iter;
      const result: any[] = new Array(len);
      for (let i = 0; i < len; i++) {
        result[i] = vecGet(iter, i);
      }
      return result;
    }
  }
  // Plain JS object (or a non-vec wasm struct, #3637). If its
  // `[Symbol.iterator]` is a Wasm closure struct
  // (compiled `obj[Symbol.iterator] = function(){…}`), native Array.from would
  // see a non-function and throw — drain it through __call_fn_0 instead
  // (#1320/#1684). Otherwise pass through (real JS iterables: Maps, Sets,
  // generators, host objects).
  const symIter = _safeGet(iter, Symbol.iterator) ?? _safeGet(iter, "@@iterator");
  if (symIter != null && typeof symIter === "object" && _isWasmStruct(symIter)) {
    const drained = _drainClosureIterableToArray(iter, callbackState?.getExports());
    if (drained != null) return drained;
  }
  return iter;
}

/**
 * (#1320) Drain a plain JS object whose own `[Symbol.iterator]` is a compiled
 * Wasm closure. Depending on the assignment path, the property may hold either
 * the raw closure struct or a JS wrapper produced by `_wrapWasmClosure`. Native
 * `Array.from` / `Iterator.from` cannot drive the raw Wasm iterator/result
 * structs, so we invoke the closure-backed protocol manually and collect the
 * yielded values into a real JS array.
 *
 * Returns `null` when this path does not apply — caller falls back to native
 * `Array.from`:
 *   - the value has no own/inherited `@@iterator`, OR
 *   - the `@@iterator` is already a real non-Wasm-wrapper JS function, OR
 *   - the closure-call export is unavailable.
 *
 * Throws from the user's `@@iterator()` / `.next()` propagate unchanged (a
 * custom iterator that throws must surface that throw, per §7.4).
 */
function _drainWasmClosureIterable(
  obj: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any[] | null {
  if (obj == null || typeof obj !== "object") return null;
  let iterFn: any;
  try {
    iterFn = obj[Symbol.iterator];
  } catch {
    return null;
  }
  const iterWrapper = typeof iterFn === "function" ? _wasmClosureWrapperSource.get(iterFn) : undefined;
  const iterIsRawClosure = iterFn != null && typeof iterFn === "object" && _isWasmStruct(iterFn);
  // Only handle the broken case: an @@iterator that came from a Wasm closure.
  // Real JS functions / generators take the native path.
  if (iterFn == null || (!iterWrapper && !iterIsRawClosure)) return null;
  const exports = callbackState?.getExports();
  const callFn0 = exports?.["__call_fn_0"];
  if (iterIsRawClosure && typeof callFn0 !== "function") return null;
  let iteratorObj = iterWrapper ? iterFn.call(obj) : callFn0!(iterFn);
  if ((iteratorObj == null || typeof iteratorObj !== "object") && iterWrapper && typeof callFn0 === "function") {
    try {
      const fallbackIterator = callFn0(iterWrapper.closure);
      if (fallbackIterator != null && typeof fallbackIterator === "object") iteratorObj = fallbackIterator;
    } catch {
      // Preserve the native failure path below when the fallback also fails.
    }
  }
  if (iteratorObj == null || typeof iteratorObj !== "object") return null;
  // (#3195) Drain via the shared step loop. `nullOnMissingCallFn0` preserves
  // this path's abort when a result's `next` is a wasm-struct closure but
  // `__call_fn_0` is unavailable (the wrapper path may leave it undefined).
  return _stepClosureIterator(iteratorObj, exports, { nullOnMissingCallFn0: true });
}

/**
 * (#1438) Recursively convert a wasm vec / tuple struct to a real JS array
 * suitable for the native `new Map(iterable)`, `new WeakMap(iterable)` etc.
 * constructors. Inner tuples (heterogeneous `[k, v]` structs) are converted
 * to real `[k, v]` arrays. Inner vecs become nested arrays. JS-iterables and
 * primitives pass through unchanged.
 *
 * This is intentionally similar to `__make_iterable`'s `convertToJS` but
 * exported as a top-level helper so the `extern_class` constructor path can
 * use it directly (without going through the host import).
 */
function _convertIterableForHost(obj: any, exports: Record<string, Function> | undefined): any {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) {
    // Pre-existing JS array — still walk for nested wasm structs so e.g.
    // `[[wasmStructKey, value]]` passed from JS works.
    return obj.map((v) => _convertIterableForHost(v, exports));
  }
  // Only convert if this is a wasm-opaque struct. Plain JS objects with
  // Symbol.iterator (Maps, Sets, generators, ...) pass through.
  if (!_isWasmStruct(obj)) {
    if (Symbol.iterator in obj) return obj;
    return obj;
  }
  if (!exports) return obj;
  // Tuple struct (heterogeneous `[k, v]`) — fields are `_0`, `_1`, ...
  const fieldNames = exports.__struct_field_names as Function | undefined;
  if (typeof fieldNames === "function") {
    const names = fieldNames(obj) as string | null;
    if (typeof names === "string" && names.length > 0) {
      const parts = names.split(",");
      const isNumeric = parts.every((p: string) => /^_\d+$/.test(p));
      if (isNumeric) {
        const arr: any[] = new Array(parts.length);
        for (let i = 0; i < parts.length; i++) {
          const getter = exports[`__sget_${parts[i]}`] as Function | undefined;
          arr[i] = getter ? _convertIterableForHost(getter(obj), exports) : undefined;
        }
        return arr;
      }
    }
  }
  // Vec struct (homogeneous arrays).
  // (#2836) Gate on the POSITIVE `__is_vec` discriminator — `__vec_len` returns
  // `0` for ANY non-vec struct, so without this guard a plain object element is
  // mis-flattened to an empty array, erasing its fields. Mirrors the same fix in
  // `__make_iterable`'s `convertToJS`.
  const vecLen = exports.__vec_len as Function | undefined;
  const vecGet = exports.__vec_get as Function | undefined;
  const isVec = exports.__is_vec as Function | undefined;
  if (typeof vecLen === "function" && typeof vecGet === "function" && (typeof isVec !== "function" || isVec(obj))) {
    try {
      const len = vecLen(obj) as number;
      if (typeof len === "number" && len >= 0) {
        const arr: any[] = new Array(len);
        for (let i = 0; i < len; i++) {
          arr[i] = _convertIterableForHost(vecGet(obj, i), exports);
        }
        return arr;
      }
    } catch {
      // (#3637) NOT "not a vec" — `__vec_len` never throws for a non-vec, it
      // returns 0 (`__is_vec` on the guard above is what answers that). Only a
      // genuine element-read trap lands here.
    }
  }
  return obj;
}

function _getSidecar(obj: object): Record<string | symbol, any> {
  if (!_canBeWeakKey(obj)) return Object.create(null) as Record<string | symbol, any>;
  let sc = _wasmStructProps.get(obj);
  if (!sc) {
    sc = Object.create(null) as Record<string | symbol, any>;
    _wasmStructProps.set(obj, sc);
  }
  return sc;
}

function _sidecarGet(obj: any, key: any): any {
  if (!_canBeWeakKey(obj)) return undefined;
  const sc = _wasmStructProps.get(obj);
  return sc?.[key];
}

function _sidecarSet(obj: any, key: any, val: any): void {
  if (!_canBeWeakKey(obj)) return;
  _getSidecar(obj)[key] = val;
  // (#1334) Re-assigning a previously-deleted property clears its tombstone
  // so subsequent presence checks (`hasOwnProperty`, etc.) report it own again.
  const tomb = _wasmStructDeletedKeys.get(obj);
  if (tomb) {
    tomb.delete(typeof key === "symbol" ? key : String(key));
  }
}

function _sidecarDelete(obj: any, key: any): boolean {
  if (!_canBeWeakKey(obj)) return false;
  const sc = _wasmStructProps.get(obj);
  if (sc && key in sc) {
    delete sc[key];
    return true;
  }
  return false;
}

/**
 * Sentinel for OrdinaryToPrimitive's `tryMethod`: distinguishes "method is
 * absent / returned an Object / dispatch trapped" (try the next method) from a
 * method that legitimately returned the primitive `undefined`. Without it, a
 * real `undefined` return is wrongly treated as "absent" and the next method is
 * consulted (#1826). Per §7.1.1.1 steps 5-6, any non-Object return is the result.
 */
// #1935 — single in-band "absent" sentinel for the host runtime. Returning
// `undefined` to signal "no such getter / method / property" is a bug: user
// code can legitimately return `undefined`, and the in-band signal then
// misreads that as absence (a getter returning `undefined` shadowed by the
// underlying field; a `valueOf` returning `undefined` treated as "no valueOf").
// `_MISS` is a unique symbol that user code can never produce, so it
// unambiguously means absence. (Was `_PRIM_ABSENT`, scoped to ToPrimitive;
// unified here and now also used by the property-getter lookup path.)
const _MISS: unique symbol = Symbol("runtime-absent-sentinel");
// Back-compat alias so the existing ToPrimitive call sites keep reading
// naturally; both names refer to the same unique symbol.
const _PRIM_ABSENT: typeof _MISS = _MISS;

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
function _toPrimitive(
  obj: any,
  hint: "number" | "string" | "default",
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  // Unwrap host proxy to raw WasmGC struct for sidecar lookups (#1090).
  // Proxies are created by _wrapForHost and _hostProxyReverse maps them back.
  const raw = _hostProxyReverse.get(obj) ?? obj;
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
 * (#1716) ToPropertyKey (§7.1.19): coerce a value intended as a property key.
 * For a WasmGC-struct key, run ToPrimitive(hint "string") via the
 * callbackState-aware walker so a key with a compiled `valueOf` / `toString` /
 * `[Symbol.toPrimitive]` is invoked — then ToString the resulting primitive.
 * Symbols pass through unchanged (they ARE valid property keys). Non-struct
 * values are returned as-is; native `Object.defineProperty` etc. then apply
 * their own ToPropertyKey, which is correct for plain JS objects.
 *
 * Used by the Object.* / Reflect.* runtime intent handlers that forward a raw
 * key to a native operation that would otherwise throw "Cannot convert object
 * to primitive value" on an opaque struct key.
 */
function _toPropertyKey(key: any, callbackState?: { getExports: () => Record<string, Function> | undefined }): any {
  if (key == null || typeof key !== "object") return key;
  if (typeof key === "symbol") return key;
  if (!_isWasmStruct(key)) return key;
  const prim = _toPrimitiveSync(key, "string", callbackState);
  if (typeof prim === "symbol") return prim;
  // ToString the primitive (numbers/booleans/etc. → string key per §7.1.19).
  return prim == null ? prim : typeof prim === "string" ? prim : String(prim);
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
function _hostToPrimitive(
  obj: any,
  hint: "number" | "string" | "default",
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (obj == null || typeof obj !== "object") return obj;

  // Check Symbol.toPrimitive via real JS property access (goes through proxy if applicable)
  const raw = _hostProxyReverse.get(obj) ?? obj;
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
  }

  // OrdinaryToPrimitive §7.1.1.1
  // Track whether any user-defined method was found AND invoked-but-returned-
  // a-non-primitive. Distinct from "no method found at all" — only the latter
  // triggers the WasmGC `"[object Object]"` fallback (#1319). The former
  // represents the spec violation in §7.1.1.1 step 6 and must throw TypeError
  // (#1253).
  let methodInvokedReturnedObject = false;
  const methodNames = hint === "string" ? ["toString", "valueOf"] : ["valueOf", "toString"];
  for (const mName of methodNames) {
    // Check real JS property first (goes through proxy which may wrap closures)
    let fn: any;
    try {
      fn = obj[mName];
    } catch {
      /* property access on opaque struct */
    }
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
const _csvSplitCache = new Map<string, readonly string[]>();

function _structFieldNamesRaw(obj: any, exports: Record<string, Function> | undefined): readonly string[] | null {
  if (!exports) return null;
  const fn = exports.__struct_field_names;
  if (typeof fn !== "function") return null;
  const csv = fn(obj);
  if (csv == null || typeof csv !== "string" || csv === "") return null;
  let names = _csvSplitCache.get(csv);
  if (!names) {
    names = csv.split(",");
    _csvSplitCache.set(csv, names);
  }
  return names;
}

function _getStructFieldNames(obj: any, exports: Record<string, Function> | undefined): string[] | null {
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
function _structOwnFieldStatus(
  obj: any,
  key: string,
  exports: Record<string, Function> | undefined,
): boolean | undefined {
  const names = _structFieldNamesRaw(obj, exports);
  if (!names) return undefined;
  if (!names.includes(key)) return false;
  const presence = exports![`__shas_${key}`];
  return typeof presence !== "function" || presence(obj) !== 0;
}

function _structHasOwnFieldName(obj: any, key: string, exports: Record<string, Function> | undefined): boolean {
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
function _wasmStructHasOwn(obj: any, key: any, exports: Record<string, Function> | undefined): boolean {
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
  // (#1047) registered class prototype — only allowlisted methods qualify.
  const protoMethods = _prototypeMethodNames.get(obj);
  if (protoMethods !== undefined) {
    const prop = String(key);
    return protoMethods.includes(prop) && !_isDeletedClassProp(obj, prop);
  }
  const staticMethods = _staticMethodNames.get(obj);
  if (staticMethods !== undefined) {
    const prop = String(key);
    return staticMethods.includes(prop) && !_isDeletedClassProp(obj, prop);
  }
  // Static struct field shape (the per-receiver oracle, A1 — NOT a module-global
  // `__sget_<key>` existence probe). Single-key check (#3673) — avoids the
  // full per-field presence sweep.
  return _structHasOwnFieldName(obj, String(key), exports);
}

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
    ambientCompatibility: options.ambientCompatibility ?? targetProfile.semanticProviders !== "native-first",
  });
}

/**
 * (#1634) Spec InstallErrorCause(O, options) — §20.5.8.1. If `options` is an
 * object and HasProperty(options, "cause") is true, set a non-enumerable own
 * data property `cause` on `O` with the value Get(options, "cause").
 *
 * `options` may arrive as an opaque WasmGC struct (object literal compiled
 * inline, e.g. `new AggregateError([], "m", { cause })`). We read the raw
 * `cause` field via the `__sget_cause` export — NOT `_structToPlainObject`,
 * which recursively converts nested structs and would break reference identity
 * (test262 checks `error.cause === cause`). Plain JS objects use native
 * `in` / property access.
 */
function _installErrorCause(inst: any, options: any, exports: Record<string, Function> | undefined): void {
  if (options == null || typeof options !== "object") return;
  let hasCause = false;
  let causeVal: any;
  if (_isWasmStruct(options)) {
    const sidecar = _wasmStructProps.get(options);
    if (_structHasOwnFieldName(options, "cause", exports)) {
      hasCause = true;
      const getter = exports?.__sget_cause;
      if (typeof getter === "function") causeVal = getter(options);
    } else if (sidecar && "cause" in sidecar) {
      hasCause = true;
      causeVal = sidecar.cause;
    }
  } else if ("cause" in options) {
    hasCause = true;
    causeVal = options.cause;
  }
  if (hasCause) {
    Object.defineProperty(inst, "cause", {
      value: causeVal,
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
}

/**
 * Recursively convert a WasmGC value (struct, vec/array, or primitive) to a
 * plain JS value suitable for JSON.stringify.  Handles:
 *   - WasmGC structs  -> plain objects (via _structToPlainObject)
 *   - WasmGC vecs     -> JS arrays (via __vec_len / __vec_get)
 *   - primitives / normal JS objects -> returned as-is
 */
function _wasmToPlain(val: any, exports: Record<string, Function> | undefined, seen?: Set<any>): any {
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
  if (Array.isArray(val)) {
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

// ---------------------------------------------------------------------------
// (#1636 Slice A) JSON.stringify live-value walk
//
// Spec §25.5.2.4 SerializeJSONProperty / §25.5.2.5 SerializeJSONObject /
// §25.5.2.6 SerializeJSONArray, implemented over live WasmGC values so that
// (1) the replacer sees the original holder identity, (2) `toJSON` is
// observable on values that carry it, (3) cycles are detected as the walk
// recurses (instead of `_wasmToPlain` infinite-looping pre-flatten), and
// (4) the replacer is invoked even when it's a WasmGC closure (host
// JSON.stringify ignores those because their typeof is "object").
//
// This path is taken whenever the replacer is a function. Other paths
// (no replacer / property-list array) continue to flatten via
// `_wasmToPlain` and hand off to host JSON.stringify — fast and identical
// in behaviour for those cases.
// ---------------------------------------------------------------------------

type _JsonRep = { kind: "fn"; fn: (...a: any[]) => any } | { kind: "list"; keys: string[] } | { kind: "none" };

function _normaliseJsonReplacer(
  replacer: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): _JsonRep {
  if (replacer == null) return { kind: "none" };
  if (typeof replacer === "number" && isNaN(replacer)) return { kind: "none" };
  if (typeof replacer === "function") return { kind: "fn", fn: replacer };
  if (Array.isArray(replacer)) {
    return { kind: "list", keys: _buildJsonPropertyList(replacer) };
  }
  if (typeof replacer === "object" && _isWasmStruct(replacer)) {
    const exports = callbackState?.getExports();
    // Try function bridge first (Wasm closure → JS callable via __call_fn_2).
    const wrapped = exports ? _wrapWasmClosure(replacer, 2, callbackState) : null;
    if (wrapped) return { kind: "fn", fn: wrapped };
    // (#2671) §25.5.2.1 step 4.b — only an *array* replacer becomes a
    // PropertyList; any other object (`JSON.stringify(obj, {})`,
    // `new String('s')`, …) is silently ignored. Gate the PropertyList path on
    // the *positive* `__is_vec` discriminator (`ref.test` over all registered
    // vec types); a plain object struct answers 0 and correctly falls through to
    // `{ kind: "none" }` (no replacer). Genuine array replacers cross the host
    // boundary as real JS arrays and are handled by the
    // `Array.isArray(replacer)` branch above, so this branch is reached only by
    // object structs (and, defensively, any true wasm vec struct, which
    // `__is_vec` still routes to the PropertyList path).
    //
    // (#3637) This comment used to justify the gate by noting that
    // `_wasmToPlain` "mis-materialises `{}` as `[]`" — true when written, and
    // the clearest surviving statement of the vacuity, but no longer accurate:
    // `_wasmToPlain` is itself `__is_vec`-gated now, so the gate here is
    // defence-in-depth rather than a workaround for a broken callee.
    const isVecFn = exports?.__is_vec;
    if (typeof isVecFn === "function" && isVecFn(replacer) === 1) {
      const asPlain = _wasmToPlain(replacer, exports);
      if (Array.isArray(asPlain)) {
        return { kind: "list", keys: _buildJsonPropertyList(asPlain) };
      }
    }
  }
  return { kind: "none" };
}

// (#2671) Build the JSON.stringify PropertyList from a replacer array per
// §25.5.2.1 step 4.b.iv. For each element: a String stays as-is; a Number is
// ToString'd; a String/Number *wrapper object* (`new String`/`new Number`) is
// ToString'd via its [[StringData]]/[[NumberData]]; anything else (undefined,
// holes, booleans, symbols, plain objects) is ignored. Each resulting key is
// appended only if not already present — the list is de-duplicated, and the
// holder is read at most once per distinct key (`['key','key']` → one read).
function _buildJsonPropertyList(arr: any[]): string[] {
  const keys: string[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    let key: string | undefined;
    if (typeof v === "string") key = v;
    else if (typeof v === "number") key = String(v);
    else if (v instanceof String || v instanceof Number) key = String(v);
    if (key !== undefined && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

function _liveIsArray(v: any, exports: Record<string, Function> | undefined): boolean {
  if (Array.isArray(v)) return true;
  if (!_isWasmStruct(v) || !exports) return false;
  // (#3637) POSITIVE `__is_vec` discriminator. The old test was
  // "no named struct fields AND responds to `__vec_len`" — the second half is
  // vacuous (see `_isWasmVec`), so the `_getStructFieldNames` filter was doing
  // ALL the work and every FIELD-LESS struct (a class instance carrying only
  // methods) was classified as an array. That drove the whole JSON live walk:
  // `JSON.stringify(new Empty(), fn)` serialized as `[]`, and `_liveGet` read
  // its properties through `__vec_get` instead of `__sget_*`.
  return _isWasmVec(v, exports);
}

function _liveGet(obj: any, key: string | number, exports: Record<string, Function> | undefined): any {
  if (obj == null) return undefined;
  // Plain JS object / array: direct property access.
  if (!_isWasmStruct(obj)) {
    return obj[key as any];
  }
  // WasmGC value: try sidecar first so user-added props shadow struct fields
  // per spec §10.1.1 default [[Set]].
  const sc = _wasmStructProps.get(obj);
  if (sc && key in sc) return sc[key as any];
  if (!exports) return undefined;
  // Vec wrapper: numeric key → __vec_get; "length" → __vec_len.
  if (_liveIsArray(obj, exports)) {
    if (key === "length") {
      const fn = exports.__vec_len;
      return typeof fn === "function" ? fn(obj) : undefined;
    }
    const idx = typeof key === "number" ? key : Number(key);
    if (Number.isFinite(idx) && Number.isInteger(idx) && idx >= 0) {
      const fn = exports.__vec_get;
      if (typeof fn === "function") {
        try {
          return fn(obj, idx);
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }
  // Named struct: __sget_<key>.
  // (#2671) Gate the read on the canonical own-property check. A module-global
  // `__sget_<key>` getter invoked on a struct that lacks the field returns a
  // zero-value default (`0`/`null`) rather than `undefined`. The JSON live walk
  // reads each PropertyList key via `_liveGet`, so an absent key was serialized
  // with a bogus default (`JSON.stringify({a:{}}, ['c','b','a'])` →
  // `{"c":0,"b":0,...}`) instead of being dropped per SerializeJSONObject
  // step 6.a. `_wasmStructHasOwn` returns true for every real struct field, so
  // present fields are unaffected; only genuinely-absent keys now read as
  // `undefined`, which SerializeJSONProperty correctly omits.
  if (!_wasmStructHasOwn(obj, key, exports)) return undefined;
  const getter = exports[`__sget_${String(key)}`];
  if (typeof getter === "function") {
    try {
      return getter(obj);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// #1636 Slice B — does the live value graph reach any node with a callable
// `toJSON`? Used to decide between the fast `_wasmToPlain` path and the live
// SerializeJSONProperty walk when no replacer is supplied. Bounded recursion
// (cycle-safe via `seen`) and lazy (returns true on first match) so the
// no-toJSON common case stays cheap.
function _hasReachableToJSON(v: any, exports: Record<string, Function> | undefined, seen: Set<any>): boolean {
  if (v == null || typeof v !== "object") return false;
  if (seen.has(v)) return false;
  seen.add(v);
  // Plain JS object/array: enumerate own keys.
  if (!_isWasmStruct(v)) {
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        if (_hasReachableToJSON(v[i], exports, seen)) return true;
      }
      return false;
    }
    const tj = (v as Record<string, unknown>).toJSON;
    if (typeof tj === "function") return true;
    for (const k of Object.keys(v)) {
      if (_hasReachableToJSON((v as Record<string, unknown>)[k], exports, seen)) return true;
    }
    return false;
  }
  if (!exports) return false;
  // WasmGC struct or vec — probe toJSON via _liveGet; recurse into entries.
  const tj = _liveGet(v, "toJSON", exports);
  if (_isJsonCallable(tj, exports)) return true;
  if (_liveIsArray(v, exports)) {
    const lenFn = exports.__vec_len;
    const getFn = exports.__vec_get;
    if (typeof lenFn === "function" && typeof getFn === "function") {
      let len = 0;
      try {
        len = lenFn(v) as number;
      } catch {
        return false;
      }
      for (let i = 0; i < len; i++) {
        try {
          if (_hasReachableToJSON(getFn(v, i), exports, seen)) return true;
        } catch {
          /* skip */
        }
      }
    }
    return false;
  }
  const keys = _liveGetEnumerableKeys(v, exports);
  for (const k of keys) {
    if (k === "toJSON") continue; // already checked
    if (_hasReachableToJSON(_liveGet(v, k, exports), exports, seen)) return true;
  }
  return false;
}

function _isJsonCallable(v: any, exports: Record<string, Function> | undefined): boolean {
  if (typeof v === "function") return true;
  if (v == null || typeof v !== "object") return false;
  if (!_isWasmStruct(v) || !exports) return false;
  const isClosureFn = exports.__is_closure as ((x: any) => number) | undefined;
  if (typeof isClosureFn !== "function") return false;
  try {
    return isClosureFn(v) === 1;
  } catch {
    return false;
  }
}

function _invokeJsonCallable(
  fn: any,
  thisVal: any,
  args: any[],
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (typeof fn === "function") {
    return fn.apply(thisVal, args);
  }
  // WasmGC closure. #2013/#2015 — when a meaningful receiver is supplied
  // (`thisVal`), dispatch through `__call_fn_method_<arity>` so the closure
  // body's `this` (the `__current_this` global) observes it. The JSON.parse
  // reviver's `this` IS the holder (§25.5.1.1 step 3 — InternalizeJSONProperty
  // calls reviver with the holder as receiver), so a reviver that does
  // `Object.defineProperty(this, …)` / `this.x` now sees the holder instead of
  // throwing "called on non-object". Bare-callback semantics (undefined /
  // globalThis receiver) keep the plain `__call_fn_<arity>` path unchanged.
  const exports = callbackState?.getExports();
  if (!exports) return undefined;
  const arity = args.length;
  const hasReceiver = thisVal !== undefined && thisVal !== null && thisVal !== globalThis;
  if (hasReceiver) {
    const methodCallFn = exports[`__call_fn_method_${arity}`];
    if (typeof methodCallFn === "function") {
      const rawThis = typeof thisVal === "object" ? _unwrapForHost(thisVal) : thisVal;
      return methodCallFn(_isWasmStruct(rawThis) ? rawThis : thisVal, fn, ...args);
    }
  }
  const callFn = exports[`__call_fn_${arity}`];
  if (typeof callFn === "function") {
    return callFn(fn, ...args);
  }
  // Fall back to the highest-arity dispatcher available, padding extras.
  for (let a = 4; a >= 0; a--) {
    const cf = exports[`__call_fn_${a}`];
    if (typeof cf === "function") {
      const padded = _denseOwnArgs(args, a);
      return cf(fn, ...padded);
    }
  }
  return undefined;
}

/**
 * #2013 — true when `reviver` is a usable JSON.parse reviver callback: a JS
 * function, or a WasmGC closure struct the host can dispatch via `__call_fn_2`.
 * A `null`/`undefined` reviver (the common no-arg / explicit-undefined case)
 * returns false so `JSON.parse` returns the unfiltered value unchanged.
 */
function _isCallableReviver(
  reviver: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): boolean {
  if (reviver == null) return false;
  if (typeof reviver === "function") return true;
  // WasmGC closure → callable via the __call_fn_2 bridge.
  if (typeof reviver === "object" && _isWasmStruct(reviver)) {
    const exports = callbackState?.getExports();
    return typeof exports?.__call_fn_2 === "function";
  }
  return false;
}

/**
 * #2013 — §25.5.1.1 InternalizeJSONProperty. `holder` is a plain JS object (the
 * parse result is host `JSON.parse` output, so values are plain JS — no WasmGC
 * walking needed). For each own enumerable property of the value at
 * `holder[key]` (array indices in order, then object keys in insertion order),
 * recurse, then write the recursive result back — via CreateDataProperty when
 * it is defined (step 2.b.iii.4 / 2.c.iii.3.a) or `[[Delete]]` when it is
 * `undefined` (step 2.b.iii.3.a / 2.c.iii.2.a). **Both operations are
 * spec-silent on failure**: `CreateDataProperty`/`[[Delete]]` return a boolean
 * that InternalizeJSONProperty ignores ("If status is false … no exception").
 * A reviver that makes a property non-configurable mid-walk must therefore NOT
 * throw and must leave the old value in place — so we use `Reflect.defineProperty`
 * with a fresh fully-configurable data descriptor (CreateDataProperty) and
 * `Reflect.deleteProperty` (both return false without throwing), NOT plain
 * assignment / `delete` (which would succeed on a writable non-configurable prop
 * and diverge from the spec). Finally call the reviver with `(key, value)` on
 * `holder` as `this` and return its result. The reviver may be a JS function or
 * a WasmGC closure (dispatched via `_invokeJsonCallable`).
 */
function _internalizeJSONProperty(
  holder: any,
  key: string,
  reviver: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  const value = holder[key];
  if (value !== null && typeof value === "object") {
    // CreateDataProperty(O, P, V) — §7.3.5: define a fresh {writable, enumerable,
    // configurable} data property; returns the [[DefineOwnProperty]] status,
    // which the caller ignores (silent on a non-configurable existing prop).
    const createDataProperty = (o: any, p: string, v: any): void => {
      Reflect.defineProperty(o, p, { value: v, writable: true, enumerable: true, configurable: true });
    };
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        const elem = _internalizeJSONProperty(value, String(i), reviver, callbackState);
        if (elem === undefined) {
          Reflect.deleteProperty(value, String(i));
        } else {
          createDataProperty(value, String(i), elem);
        }
      }
    } else {
      // Own enumerable string keys, insertion order (JSON.parse yields plain
      // objects whose key order is the source/text order).
      for (const k of Object.keys(value)) {
        const newElem = _internalizeJSONProperty(value, k, reviver, callbackState);
        if (newElem === undefined) {
          Reflect.deleteProperty(value, k);
        } else {
          createDataProperty(value, k, newElem);
        }
      }
    }
  }
  // §25.5.1.1 step 3 — call reviver(key, value) with `this` = holder.
  return _invokeJsonCallable(reviver, holder, [key, value], callbackState);
}

function _liveGetEnumerableKeys(obj: any, exports: Record<string, Function> | undefined): string[] {
  if (!_isWasmStruct(obj)) {
    // Plain JS object — Object.keys gives enumerable own keys.
    return Object.keys(obj);
  }
  const fieldNames = _getStructFieldNames(obj, exports);
  const keys: string[] = [];
  if (fieldNames) {
    for (const k of fieldNames) keys.push(k);
  }
  const sc = _wasmStructProps.get(obj);
  if (sc) {
    for (const k of Object.keys(sc)) {
      if (!keys.includes(k)) keys.push(k);
    }
  }
  return keys;
}

const _JSON_QUOTE_ESCAPES: Record<string, string> = {
  '"': '\\"',
  "\\": "\\\\",
  "\b": "\\b",
  "\f": "\\f",
  "\n": "\\n",
  "\r": "\\r",
  "\t": "\\t",
};

function _quoteJSON(s: string): string {
  // Delegate to host JSON.stringify for spec-faithful escaping (§25.5.2.3).
  return JSON.stringify(s);
}

function _serializeJSONProperty(
  key: string | number,
  holder: any,
  rep: _JsonRep,
  gap: string,
  indent: string,
  stack: Set<any>,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): string | undefined {
  const exports = callbackState?.getExports();
  // Step 1. Let value be ? Get(holder, key).
  let value = _liveGet(holder, key, exports);
  // Step 2. If Type(value) is Object or BigInt, try toJSON.
  if (value != null && (typeof value === "object" || typeof value === "bigint")) {
    const toJSON = _liveGet(value, "toJSON", exports);
    if (_isJsonCallable(toJSON, exports)) {
      value = _invokeJsonCallable(toJSON, value, [String(key)], callbackState);
    }
  }
  // Step 3. If ReplacerFunction is not undefined, call it.
  if (rep.kind === "fn") {
    value = _invokeJsonCallable(rep.fn, holder, [String(key), value], callbackState);
  }
  // Step 4. (Wrapper unwrap — Slice C; for now only handle JS Number/String/Boolean wrappers.)
  if (value !== null && typeof value === "object" && !_isWasmStruct(value)) {
    if (value instanceof Number) value = Number(value);
    else if (value instanceof String) value = String(value);
    else if (value instanceof Boolean) value = Boolean(value);
    else if (typeof BigInt !== "undefined" && value instanceof (BigInt as any)) value = (value as any).valueOf();
  }
  // Step 5-11. Switch on the value type.
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "string") return _quoteJSON(value);
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
  if (typeof value === "bigint") {
    throw new TypeError("Do not know how to serialize a BigInt");
  }
  if (value !== undefined && (typeof value === "object" || _isWasmStruct(value))) {
    // Functions are not serialisable.
    if (typeof value === "function") return undefined;
    if (_isJsonCallable(value, exports)) return undefined;
    // Cycle detection per §25.5.2.5 / §25.5.2.6 step 1.
    if (stack.has(value)) {
      throw new TypeError("Converting circular structure to JSON");
    }
    stack.add(value);
    try {
      if (_liveIsArray(value, exports)) {
        return _serializeJSONArray(value, rep, gap, indent, stack, callbackState);
      }
      return _serializeJSONObject(value, rep, gap, indent, stack, callbackState);
    } finally {
      stack.delete(value);
    }
  }
  return undefined; // function / symbol / undefined — caller drops the key
}

function _serializeJSONObject(
  obj: any,
  rep: _JsonRep,
  gap: string,
  indent: string,
  stack: Set<any>,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): string {
  const exports = callbackState?.getExports();
  const stepback = indent;
  const newIndent = indent + gap;
  let keys: string[];
  if (rep.kind === "list") {
    keys = rep.keys;
  } else {
    keys = _liveGetEnumerableKeys(obj, exports);
  }
  const partial: string[] = [];
  for (const key of keys) {
    const strP = _serializeJSONProperty(key, obj, rep, gap, newIndent, stack, callbackState);
    if (strP !== undefined) {
      let member = _quoteJSON(key) + ":";
      if (gap !== "") member += " ";
      member += strP;
      partial.push(member);
    }
  }
  if (partial.length === 0) return "{}";
  let final: string;
  if (gap === "") {
    final = "{" + partial.join(",") + "}";
  } else {
    const separator = ",\n" + newIndent;
    const properties = partial.join(separator);
    final = "{\n" + newIndent + properties + "\n" + stepback + "}";
  }
  return final;
}

function _serializeJSONArray(
  arr: any,
  rep: _JsonRep,
  gap: string,
  indent: string,
  stack: Set<any>,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): string {
  const exports = callbackState?.getExports();
  const stepback = indent;
  const newIndent = indent + gap;
  let len: number;
  if (Array.isArray(arr)) {
    len = arr.length;
  } else {
    const vecLen = exports?.__vec_len;
    len = typeof vecLen === "function" ? Number(vecLen(arr)) : 0;
    if (!Number.isFinite(len) || len < 0) len = 0;
  }
  const partial: string[] = [];
  for (let i = 0; i < len; i++) {
    const strP = _serializeJSONProperty(i, arr, rep, gap, newIndent, stack, callbackState);
    partial.push(strP === undefined ? "null" : strP);
  }
  if (partial.length === 0) return "[]";
  let final: string;
  if (gap === "") {
    final = "[" + partial.join(",") + "]";
  } else {
    const separator = ",\n" + newIndent;
    const properties = partial.join(separator);
    final = "[\n" + newIndent + properties + "\n" + stepback + "]";
  }
  return final;
}

/** Symbol.dispose / Symbol.asyncDispose may not exist in older runtimes (ES2026). */
const _disposeSym: symbol = (Symbol as any).dispose ?? Symbol.for("Symbol.dispose");

// (#1467) Per-module symbol-id → description map. Populated by the codegen
// pre-call to `__symbol_register_desc(id, desc)` immediately before
// `__box_symbol(id)` returns a JS Symbol for that id. The cache is keyed by
// id (i32) so that boxing the same id twice returns the same identity-stable
// JS Symbol — preserving the same identity rule as the legacy single-arg
// `__box_symbol(id)` host.
let _symbolCache: Map<number, symbol> | undefined;
const _symbolDescRegistry: Map<number, string | null> = new Map();
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

/**
 * (#3676) Resolve the per-instance symbol-id → JS Symbol cache, seeding the
 * well-known ids on first use.
 *
 * Extracted from `__box_symbol` because it now has a SECOND consumer
 * (`__symbol_for_id`), and the seeding guard is `size === 0`. Left inline, a
 * `Symbol.for(...)` call that ran before the first `__box_symbol` would put an
 * entry in the map, making it non-empty, so the well-known seeding would be
 * skipped forever and `__box_symbol(1)` would hand back `Symbol("wasm_1")`
 * instead of the real `Symbol.iterator`. React's module init does exactly that
 * ordering (twelve `Symbol.for` calls on line 12 before anything else), so this
 * is a live hazard, not a theoretical one. Seeding through one shared helper
 * makes the order irrelevant.
 *
 * Seeds ids 1..14 exactly as the original inline block did — id 15
 * (`@@matchAll`) was NOT seeded there and is deliberately still not, to keep
 * this a pure refactor of the existing behaviour.
 */
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

/**
 * Resolve a class from a namespace path (#1044).
 * For Node builtins like `import * as http from 'http'`, resolves `http.Server`
 * by trying: deps override → require(root)[className].
 */
function _resolveNamespacedClass(
  namespacePath: string[],
  className: string,
  deps?: Record<string, any>,
): Function | undefined {
  // Check if deps provides the namespace root
  const root = namespacePath[0];
  let ns = deps?.[root];
  if (ns == null) {
    // Try require() for Node builtins (works in both CJS and ESM via createRequire)
    const req = _getNodeRequire();
    if (req) {
      try {
        ns = req(root);
      } catch {
        // Not available
      }
    }
  }
  if (ns == null) return undefined;
  // Walk the namespace path beyond the root (e.g. for nested namespaces)
  for (let i = 1; i < namespacePath.length; i++) {
    ns = ns?.[namespacePath[i]];
    if (ns == null) return undefined;
  }
  const Ctor = ns[className];
  return typeof Ctor === "function" ? Ctor : undefined;
}

/** Safe property get: works on both JS objects and WasmGC structs. */
function _safeGet(
  obj: any,
  key: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
  rawCallable = false,
): any {
  if (obj == null) return undefined;
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
  // #2014: a small integer key (1-15) collides with the well-known-symbol ID
  // range below. A genuine numeric data property (`o[2]` on `{ 2: "two" }`) is
  // stored under the string field name "2" and exposed as `__sget_2`, so try
  // that real-property getter BEFORE interpreting the key as a symbol ID —
  // otherwise `o[2]` is mis-resolved as Symbol(2) and returns undefined.
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
        if (isVec(obj) === 1) return index < vecLen(obj) ? vecGet(obj, index) : undefined;
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
  // (#2706 / #1830) A genuine integer-index key (`o[5]`) on a WasmGC struct is
  // NOT a well-known-symbol ID. `runtime.ts` only runs in host mode, where the
  // compiler boxes every well-known-symbol access into a REAL JS Symbol via
  // `__box_symbol` (verified: `o[Symbol.species]` arrives as
  // `typeof key === "symbol"`, never a number). So a NUMBER key reaching here is
  // always a real integer index — the old `1 <= key <= 15 → _symbolIdToKeys`
  // remap mis-routed `o[5]=55` onto the `@@species` slot, leaking a `"@@species"`
  // string from for-in / Object.keys and making `5 in o` false even though
  // `o[5]` round-tripped its value. Dropping the remap lets the numeric key fall
  // through to the sidecar (stored under `"5"`) so enumeration / `in` / Object.keys
  // see `"5"` (ordered by `_orderOwnKeysSpec`). Real symbol keys still resolve via
  // the `typeof key === "symbol"` arm below; only standalone mode (object-runtime.ts,
  // never this file) uses i32 symbol ids.
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
    // Registered class prototypes and class objects intentionally hide their
    // physical instance fields, so keep their existing allowlist semantics.
    if (typeof key === "string" && !_prototypeMethodNames.has(obj) && !_staticMethodNames.has(obj)) {
      const fieldExports = callbackState?.getExports();
      if (_structHasOwnFieldName(obj, key, fieldExports)) {
        const getter = fieldExports?.[`__sget_${key}`];
        if (typeof getter === "function") return getter(obj);
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
    const vecPrototypeValue = vecProtoGet(obj, key, _argumentsObjects.has(obj), callbackState?.getExports());
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
  // For JS Symbols, also check the Wasm "@@name" equivalent
  if (typeof key === "symbol") {
    const wasmKey = _symbolToWasm.get(key);
    if (wasmKey) return _sidecarGet(obj, wasmKey);
  }
  return undefined;
}

/**
 * (#2668 Slice A) Mirror a defineProperty'd data VALUE into the real WasmGC
 * struct field via the compiled `__sset_<key>` export, when one exists for this
 * key. This is the value-only writeback `_safeSet` performs (runtime.ts ~4023),
 * factored out so the `__defineProperty_desc` / `__defineProperty_value`
 * runtime appliers can use it WITHOUT going through `_safeSet`'s
 * writable/non-extensible flag enforcement (those appliers have ALREADY run
 * `_validatePropertyDescriptor`). Why it is needed: a `const o: any = {}` whose
 * field is later defined gets a *typed* struct shape (e.g.
 * `(struct (field $property ...))`), and the member read `o.property`
 * ref-tests as that struct type and lowers to a static `struct.get` — it never
 * consults the sidecar. The inline-literal define fast path emits a direct
 * `struct.set`; the runtime-descriptor path (dynamic descriptors: `var d =
 * {...}`, `Math`, a `Date` instance) only wrote the sidecar, so the static
 * read returned the field's stale initializer (the #2668 `15.2.3.6-3-*`
 * cluster). Writing the field here keeps both the sidecar and the typed field
 * in sync. No-op (silently caught) when `obj` is not a struct, the key isn't a
 * field of this struct's concrete runtime type, or no exports are available.
 */
function _structFieldWriteback(
  obj: any,
  key: string | symbol,
  val: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): void {
  if (typeof key !== "string") return;
  if (!_isWasmStruct(obj)) return;
  const exports = callbackState?.getExports();
  const setter = exports?.[`__sset_${key}`];
  if (typeof setter !== "function") return;
  try {
    setter(obj, _unwrapForHost(val));
  } catch {
    /* not a field of this struct's runtime type */
  }
}

/**
 * `key`'s descriptor on `obj` or its prototype chain, WITHOUT firing a Proxy MOP
 * trap (bailing on a Proxy link keeps #2017's trap ordering) and without
 * throwing on an opaque WasmGC handle. Shared by `_safeSet`'s strict pre-check
 * (#2017 / #2745 d) and its sloppy setter-propagation arm (#2899).
 */
function _lookupDescriptorNoProxy(obj: any, key: PropertyKey): PropertyDescriptor | undefined {
  try {
    for (let cur = obj; cur != null && (typeof cur === "object" || typeof cur === "function"); ) {
      if (_isUserProxy(cur)) return undefined;
      const d = Object.getOwnPropertyDescriptor(cur, key);
      if (d) return d;
      cur = Object.getPrototypeOf(cur);
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
  if (strict && (typeof key === "string" || typeof key === "symbol") && !_isUserProxy(obj)) {
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
    // #2180/#2617 — writing to a revoked proxy throws TypeError; a tracked user
    // Proxy's `set` trap may also throw (abrupt completion) or the host engine
    // may raise the §10.5.9 strict-write invariant TypeError. Propagate both
    // instead of silently diverting to the sidecar. The gate is strictly
    // `_isUserProxy(obj)`, so the sloppy-mode struct / frozen-builtin cases
    // below (Math.E=1, Number.NaN=1) are byte-for-byte unchanged (#2017).
    _rethrowIfProxyOrRevoked(e, obj);
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
const _hostProxyCache = new WeakMap<object, any>();
const _hostProxyReverse = new WeakMap<object, any>();
const _fnctorInstanceofHooks: FnctorIoHooks = {
  rawInstance: (value) => _hostProxyReverse.get(value) ?? value,
  rawClosureTarget: (target) => _wasmClosureWrapperTargets.get(target),
  canBeWeakKey: _canBeWeakKey,
  instanceConstructor: (instance) => _fnctorInstanceCtor.get(instance),
  expectedPrototype: (target, exports) => _getOrVivifyFnPrototype(target, { getExports: () => exports }),
  instancePrototype: _fnctorCtorProto,
  parentPrototype: _structUserProto,
};
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

// (#2671) RegExp.lastIndex value-preserving slot. §22.2.7.2 RegExpBuiltinExec
// reads lastIndex as `ToLength(? Get(R, "lastIndex"))`; the setter stores the
// value verbatim. When a WasmGC struct is assigned (`r.lastIndex =
// {valueOf(){…}}`) the eventual ToLength must fire the struct's `valueOf`
// exactly once and propagate a throwing `valueOf` as the program's own error.
//
// Default (deferred) representation: store the struct behind a coercion shim
// whose ToPrimitive bridges to `_hostToPrimitive`. The wasm/builtin read paths
// (native exec, the protocol methods' RegExpExec) coerce it through the
// get-import (unwrap → raw struct → wasm ToNumber) or via the shim's
// ToPrimitive, firing valueOf once and propagating a throw; the get-import
// unwraps the shim to the raw struct so an explicit `r.lastIndex` read keeps
// object identity (`assert.sameValue(r.lastIndex, obj)`).
//
// (#3084) A set DURING a regex protocol call (inside a user-overridden `exec`
// invoked by RegExp.prototype[@@match/@@replace/@@split]) ALSO defers.
// §22.2.6.8/11/14 store the assigned value verbatim; the property is only read
// as `ToLength(? Get(rx, "lastIndex"))` in the EMPTY-match advance branch, and
// V8's slow (modified-RegExp) protocol path performs exactly that read —
// measured: empty match fires the shim's valueOf via the native ToLength;
// non-empty match never reads it (so a throwing valueOf must NOT fire,
// Symbol.match/g-match-no-coerce-lastindex.js). The former eager
// protocol-depth coercion here fired valueOf unconditionally at assignment
// time, which was spec-incorrect for the non-empty-match case.
// Primitive numbers are always stored verbatim.
const _lastIndexShimRaw = new WeakMap<object, any>();
function _makeLastIndexShim(
  struct: any,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  const shim = {
    [Symbol.toPrimitive](hint: "number" | "string" | "default"): any {
      return _hostToPrimitive(struct, hint === "default" ? "number" : hint, callbackState);
    },
    valueOf(): any {
      return _hostToPrimitive(struct, "number", callbackState);
    },
    toString(): string {
      return String(_hostToPrimitive(struct, "string", callbackState));
    },
  };
  _lastIndexShimRaw.set(shim, struct);
  return shim;
}
// (#1694 A.i / #1632b-1) Per-closure cache of the callable+constructible
// host wrapper produced by `_wrapCallableForHost`, so repeated wraps of the
// same closure return the same Proxy (constructor identity / @@species stays
// stable).
const _hostCallableCache = new WeakMap<object, any>();

/**
 * #1047 — registered prototype refs → method-only own-key list. Populated by
 * the compiler-emitted `__register_prototype` host import inside the lazy
 * prototype initializer (`emitLazyProtoGet`). When `_wrapForHost` wraps a
 * registered prototype, its Proxy enumerates only this list instead of the
 * underlying struct fields — hiding instance-field leakage from tests like
 * `hasOwnProperty.call(C.prototype, "instanceField")`.
 */
const _prototypeMethodNames = new WeakMap<object, string[]>();

/**
 * #1364b — set of method/static names that have been deleted from a registered
 * class prototype or class object. `delete C.prototype.m` or `delete C.m` must
 * make the property non-discoverable to subsequent `Object.getOwnPropertyDescriptor`
 * lookups (spec §10.1.10 — successful delete removes the own property). Without
 * this, `verifyProperty(C, "m", ...)` failed its second-pass invariant check
 * which deletes the property then asserts the descriptor is `undefined`.
 *
 * We track deletions on a side-set rather than mutating `_prototypeMethodNames`/
 * `_staticMethodNames` so the enumeration order (`__getOwnPropertyNames`) and
 * any future undo path remain trivial.
 */
const _deletedClassPropNames = new WeakMap<object, Set<string>>();

function _markDeletedClassProp(obj: object, name: string): void {
  let set = _deletedClassPropNames.get(obj);
  if (!set) {
    set = new Set();
    _deletedClassPropNames.set(obj, set);
  }
  set.add(name);
}

function _isDeletedClassProp(obj: object, name: string): boolean {
  const set = _deletedClassPropNames.get(obj);
  if (set !== undefined && set.has(name)) return true;
  // Unify with the existing `__delete_property` tombstone so codegen-emitted
  // `delete C.m` (which routes through `__delete_property`, not the proxy
  // trap) also marks the method/static as gone. `_wasmStructDeletedKeys` is
  // declared further down the module but is in lexical scope at call time.
  const tomb = _wasmStructDeletedKeys.get(obj);
  return tomb !== undefined && tomb.has(name);
}

/**
 * #1364a — cache of method-name → bridge JS function for class prototypes.
 * The proxy's `get` and `getOwnPropertyDescriptor` traps both produce the
 * same JS function for `C.prototype.m`, so `assert.sameValue(c.m, C.prototype.m)`
 * holds and the descriptor's `value` matches subsequent property reads.
 *
 * The bridge is a placeholder closure: tests that only check descriptor
 * flags (`{enumerable: false, configurable: true, writable: true}` via
 * `verifyProperty`) pass. JS-side method invocation through this bridge
 * (`C.prototype.m.call(c)`) needs richer dispatch deferred to a follow-up.
 */
const _prototypeMethodBridges = new WeakMap<object, Map<string, Function>>();

function _getProtoMethodBridge(proto: object, name: string): Function {
  let map = _prototypeMethodBridges.get(proto);
  if (!map) {
    map = new Map();
    _prototypeMethodBridges.set(proto, map);
  }
  let fn = map.get(name);
  if (!fn) {
    fn = function classMethodBridge(this: any) {
      throw new TypeError(
        `js2wasm: calling user-class method '${name}' via JS-side prototype access ` +
          `is not yet supported (#1364b). Call ${name} directly on the instance.`,
      );
    };
    Object.defineProperty(fn, "name", { value: name, configurable: true });
    map.set(name, fn);
  }
  return fn;
}

/**
 * (#1395) `_staticMethodNames` is the static-method analog of
 * `_prototypeMethodNames` above. Populated by the `__register_class_object`
 * host import on first lazy access of a class identifier. Consulted by
 * `__getOwnPropertyDescriptor` when the receiver is a class-object singleton
 * — returns a method descriptor with the spec-correct flags
 * (`{enumerable: false, configurable: true, writable: true}` per ECMA-262
 * §15.7.1) so `verifyProperty(C, "m", ...)` tests pass.
 */
const _staticMethodNames = new WeakMap<object, string[]>();

/**
 * (#1455) Registry of synthetic constructors for user classes that extend
 * host built-ins (`class Sub extends Map / Float32Array / WeakRef / ...`).
 * Populated lazily by the `__set_subclass_proto` host import: on first call
 * for a given `subName`, a `class Sub extends Parent {}` is created and stored
 * here. The map is keyed by the user-visible class name so `__instanceof`
 * can resolve `instance instanceof Sub` without `Sub` being on globalThis.
 *
 * The synthetic class is real — its prototype inherits from Parent.prototype,
 * which means setting `instance.[[Prototype]]` to `Sub.prototype` preserves
 * the existing `instance instanceof Parent` answer while making
 * `instance instanceof Sub` true.
 */
const _subclassCtors = new Map<string, Function[]>();

/**
 * (#1395) Cache of static-method-name → bridge JS function for class objects.
 * Mirrors `_prototypeMethodBridges` so `verifyProperty` and
 * `assert.sameValue(C.m, C.m)` both see the same Function reference across
 * repeated reads. JS-side invocation through the bridge will throw — Phase 2
 * may swap the bridge body for actual dispatch once the closure-caching
 * landscape (#1394) settles.
 */
const _classMethodBridges = new WeakMap<object, Map<string, Function>>();

function _getClassMethodBridge(classObj: object, name: string): Function {
  let map = _classMethodBridges.get(classObj);
  if (!map) {
    map = new Map();
    _classMethodBridges.set(classObj, map);
  }
  let fn = map.get(name);
  if (!fn) {
    fn = function classStaticMethodBridge(this: any) {
      throw new TypeError(
        `js2wasm: calling user-class static method '${name}' via JS-side ` +
          `class-object access is not yet supported (#1395 follow-up). ` +
          `Call ${name} directly on the class.`,
      );
    };
    Object.defineProperty(fn, "name", { value: name, configurable: true });
    map.set(name, fn);
  }
  return fn;
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

function _readOwnDescriptor(
  obj: any,
  prop: string | symbol,
  exports: Record<string, Function> | undefined,
): PropertyDescriptor | undefined {
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
  // 2a. Registered class prototype method (#1364a): spec non-enumerable,
  // configurable, writable.
  const protoMethods = _prototypeMethodNames.get(obj);
  if (protoMethods !== undefined && protoMethods.includes(propStr) && !_isDeletedClassProp(obj, propStr)) {
    return {
      value: _getProtoMethodBridge(obj, propStr),
      writable: true,
      enumerable: false,
      configurable: true,
    };
  }
  // 2b. Registered class-object static method (#1395).
  const staticMethods = _staticMethodNames.get(obj);
  if (staticMethods !== undefined && staticMethods.includes(propStr) && !_isDeletedClassProp(obj, propStr)) {
    return {
      value: _getClassMethodBridge(obj, propStr),
      writable: true,
      enumerable: false,
      configurable: true,
    };
  }
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

function _wasmStructPropertyIsEnumerable(obj: any, key: any, exports: Record<string, Function> | undefined): number {
  const prop = typeof key === "symbol" ? key : String(key);
  const tomb = _wasmStructDeletedKeys.get(obj);
  if (tomb && tomb.has(prop)) return 0;

  const descs = _wasmPropDescs.get(obj);
  const flags = descs?.get(_normalizeDescKey(prop));
  if (flags !== undefined) return flags & _SC_ENUMERABLE ? 1 : 0;

  const sc = _wasmStructProps.get(obj);
  if (sc && prop in sc) return 1;

  const desc = _readOwnDescriptor(obj, prop, exports);
  return desc?.enumerable ? 1 : 0;
}

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
 * (#2131) Apply the OrdinaryOwnPropertyKeys ordering (ES §10.1.11.1) to a
 * key list: canonical array-index keys first in ascending numeric order,
 * then the remaining keys in their existing (insertion) order. Mirrors the
 * #1837 standalone fix for the JS-host enumeration paths, which previously
 * emitted raw struct-field declaration order. Returns the input array
 * unchanged when no array-index key is present (the common pure-string case).
 */
function _orderOwnKeysSpec<T extends string | symbol>(keys: T[]): T[] {
  let hasIndexKey = false;
  for (const k of keys) {
    if (typeof k === "string" && _isCanonicalArrayIndexKey(k)) {
      hasIndexKey = true;
      break;
    }
  }
  if (!hasIndexKey) return keys;
  const indices: string[] = [];
  const rest: T[] = [];
  for (const k of keys) {
    if (typeof k === "string" && _isCanonicalArrayIndexKey(k)) indices.push(k);
    else rest.push(k);
  }
  indices.sort((a, b) => Number(a) - Number(b));
  return [...(indices as unknown as T[]), ...rest];
}

function _ownStructKeys(obj: any, exports: Record<string, Function> | undefined): (string | symbol)[] {
  const keys: (string | symbol)[] = [];
  const push = (k: string | symbol) => {
    if (!keys.includes(k)) keys.push(k);
  };
  // String keys: class allowlist OR struct field names, then sidecar + native.
  const protoMethods = _prototypeMethodNames.get(obj);
  const staticMethods = _staticMethodNames.get(obj);
  if (protoMethods !== undefined) {
    for (const n of protoMethods) if (!_isDeletedClassProp(obj, n)) push(n);
  } else if (staticMethods !== undefined) {
    for (const n of staticMethods) if (!_isDeletedClassProp(obj, n)) push(n);
  } else {
    for (const n of _getStructFieldNames(obj, exports) ?? []) push(n);
  }
  const sc = _wasmStructProps.get(obj);
  if (sc) {
    for (const k of Object.getOwnPropertyNames(sc)) {
      if (k.startsWith("__get_") || k.startsWith("__set_")) continue;
      push(k);
    }
  }
  // Native JS string props added directly to the struct object.
  try {
    for (const k of Object.getOwnPropertyNames(obj)) push(k);
  } catch {
    // ignore if not enumerable on this object
  }
  // Symbol keys: sidecar symbols + accessor-table symbols + native symbols.
  if (sc) {
    for (const s of Object.getOwnPropertySymbols(sc)) push(s);
  }
  const acc = _wasmStructAccessors.get(obj);
  if (acc) {
    for (const s of acc.keys()) if (typeof s === "symbol") push(s);
  }
  try {
    for (const s of Object.getOwnPropertySymbols(obj)) push(s);
  } catch {
    // ignore
  }
  return _orderOwnKeysSpec(keys); // (#2131) array-index keys first, ascending
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
  isRegisteredInstance: (value) => _fnctorInstanceCtor.has(value as object) || _userClassTags.has(value as object),
  getClassName: (value) => _userClassTags.get(value as object),
  marshalBridgeResult: _marshalBridgeResult,
});
const _invokeClassMethod = createResolvedClassMethodInvoker(_resolveClassMember, _MISS, _unwrapForHost);
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

/** Convert a native `$AnyString` carrier to its JS primitive at the edge. */
function _nativeStringToHost(value: any, exports: Record<string, Function> | undefined): any | typeof _MISS {
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
  if (!exports || !_isNativeOpenObject(obj, exports)) return [];
  const keys = exports.__object_keys as ((value: any) => any) | undefined;
  if (typeof keys !== "function") return [];
  try {
    const view = _wrapForHost(keys(obj), exports);
    if (!Array.isArray(view)) return [];
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
        if (v !== undefined && v !== null) return v;
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
  // (#1712) fnctor instances: resolve through the constructor's vivified
  // prototype object. Accessors run with the live-mirror proxy as the receiver.
  const protoDesc = _fnctorProtoLookup(obj, key, exports);
  if (protoDesc) {
    if (process.env.DEBUG_1712)
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
 * (#1627) Build a clean, GetSetRecord-faithful set-like object from a WasmGC
 * struct argument to a Set set-algebra method. The default `_wrapForHost` proxy
 * masks EVERY wasm-struct field value as a callable `closureBridge` (the generic
 * `__call_fn_N` fallback) — so native V8's GetSetRecord wrongly sees a
 * non-callable object (`has = {}`) as callable and a `{valueOf}` size object as
 * a function instead of a coercible object. This adapter reads each of the three
 * GetSetRecord fields RAW and presents it faithfully:
 *   - genuine closure  → the working proxy bridge (callable, generator-aware),
 *   - non-closure wasm struct (`{}`, `{valueOf(){…}}`) → a `_wrapForHost` proxy
 *     OBJECT (typeof "object", non-callable, exposes valueOf/toString),
 *   - primitive / undefined → as-is.
 * Native `Set.prototype[m]` then runs its own spec GetSetRecord on this object,
 * so the callability throws + size ToNumber coercion happen per spec. Scoped to
 * the 7 set-algebra methods only — no change to `_wrapForHost`'s own behaviour.
 */
/**
 * (#3049) Iterator-record faithfulness shim for the ES2025 Iterator helpers
 * (`Iterator.prototype.map/filter/take/…`), which drive the RECEIVER via the
 * spec iterator record (Call(next, iter) → Get(result, "done"/"value")).
 * Compiled shapes break that: a raw-struct receiver has opaque reads; a
 * `next` whose value is a Wasm closure struct isn't host-callable ("object is
 * not a function" — the this-plain-iterator cluster); Wasm-struct step
 * results have opaque done/value (infinite drive loop). The shim bridges the
 * record methods callable and host-mirrors struct step results. Mirrors the
 * `_setLikeRecordForHost` (#1627) precedent — scoped to the Iterator-helper
 * dispatch sites only; no change to `_wrapForHost` itself.
 */
const _ITER_HELPER_NAMES = [
  "map",
  "filter",
  "take",
  "drop",
  "flatMap",
  "reduce",
  "toArray",
  "forEach",
  "some",
  "every",
  "find",
] as const;
function _isIteratorHelperFn(f: any): boolean {
  if (typeof f !== "function") return false;
  const I: any = (globalThis as any).Iterator;
  const p = I?.prototype;
  if (p == null || typeof p !== "object") return false;
  for (const n of _ITER_HELPER_NAMES) {
    if (p[n] === f) return true;
  }
  return false;
}
function _iteratorRecordForHost(
  v: any,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
): any {
  if (v == null || typeof v !== "object") return v;
  const exports = callbackState?.getExports();
  const base = _isWasmStruct(v) ? _wrapForHost(v, exports) : v;
  const wrapStep = (r: any): any =>
    r != null && typeof r === "object" && _isWasmStruct(r) ? _wrapForHost(r, exports) : r;
  const shim: any = Object.create(base);
  // LAZY accessors, resolved only when the helper itself performs the spec
  // `Get(iterator, "next")` — an EAGER read here fired user getter effects
  // BEFORE the helper's own argument validation, breaking the
  // `argument-effect-order.js` family (spec §: IsCallable(mapper) throws
  // before GetIteratorDirect ever touches `next`). defineProperty (not `=`)
  // because `base` may carry `next` as a getter-only accessor
  // (`{ get next() {…} }`), which a proto-chain-walking assignment rejects.
  const defineLazy = (k: string): void => {
    Object.defineProperty(shim, k, {
      get() {
        let f: any = base[k]; // user getter effects fire exactly at the spec Get
        if (f != null && typeof f === "object" && _isWasmStruct(f)) {
          f = _maybeWrapCallableUnknownArity(f, callbackState);
        }
        if (typeof f !== "function") return f; // non-callable: let the helper throw per spec
        const fn = f as Function;
        return function (this: any, ...args: any[]) {
          return wrapStep(fn.apply(base, args));
        };
      },
      set(val: any) {
        Object.defineProperty(shim, k, { value: val, writable: true, enumerable: true, configurable: true });
      },
      enumerable: false,
      configurable: true,
    });
  };
  defineLazy("next");
  defineLazy("return");
  defineLazy("throw");
  return shim;
}

function _setLikeRecordForHost(
  arg: any,
  exports: Record<string, Function> | undefined,
  state: { getExports: () => Record<string, Function> | undefined } | undefined,
): any {
  const proxy = _wrapForHost(arg, exports);
  const isClosureFn = exports?.__is_closure as ((v: any) => number) | undefined;
  const fixField = (key: string): any => {
    const raw = _resolveHostField(arg, key, exports);
    if (raw != null && typeof raw === "object" && _isWasmStruct(raw)) {
      let isClosure = false;
      if (typeof isClosureFn === "function") {
        try {
          isClosure = isClosureFn(raw) === 1;
        } catch {
          /* discriminator unavailable — fall through to proxy */
        }
      }
      // A non-closure wasm struct must NOT be presented as a function: expose it
      // as a plain object so GetSetRecord throws on `has`/`keys` (non-callable)
      // and coerces `size` via its valueOf/toString.
      if (!isClosure) return _wrapForHost(raw, exports);
    }
    // Genuine closure or primitive/undefined: the existing proxy bridge already
    // handles these correctly (callable closureBridge / raw value).
    return proxy[key];
  };
  const rec: { size: any; has: any; keys: any } = {
    size: fixField("size"),
    has: fixField("has"),
    keys: fixField("keys"),
  };
  // (#2761 sub-cause C) Bridge the `keys()` iterator. GetSetRecord drives the
  // keys() RESULT as a spec iterator record (Call(next,iter) + IteratorClose's
  // Get(iter,"return")). A compiled `{ next(){…}, return(){…} }` iterator's
  // methods are opaque wasm-closure struct fields ("string 'next' is not a
  // function" — the `set-like-iter-return.js` pair), so route the result through
  // the `_iteratorRecordForHost` shim (bridges next/return/throw callable). Only
  // the RETURN value is wrapped, so a non-callable `keys` still fails IsCallable.
  if (typeof rec.keys === "function") {
    const rawKeys = rec.keys as (this: any, ...a: any[]) => any;
    rec.keys = function keysIterBridge(this: any, ...a: any[]): any {
      return _iteratorRecordForHost(rawKeys.apply(this, a), state);
    };
  }
  return rec;
}

// (#2801) Parse a property key into a canonical array index (uint32), or
// `undefined` if it is not one. Mirrors the spec's CanonicalNumericIndexString
// + array-index range so only genuine element keys (`"0"`, `"1"`, …) route to
// `__vec_get`, while `"length"`, `"01"`, `"-1"`, `"1.5"` fall through to the
// Array.prototype method path.
function _asArrayIndex(key: string): number | undefined {
  if (key === "0") return 0;
  // Reject leading-zero / sign / non-digit forms — canonical indices only.
  if (key.length === 0 || key.charCodeAt(0) === 48 /* '0' */) return undefined;
  const n = Number(key);
  if (Number.isInteger(n) && n >= 0 && n < 4294967295 && String(n) === key) return n;
  return undefined;
}

// (#3116) Default attribute flags for a live array element that has never been
// reconfigured: data property, writable+enumerable+configurable (§10.4.2).
const _SC_ELEM_DEFAULT = _SC_DEFINED | _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE;
// Allocation guard for beyond-length element defines / length grows (mirrors
// the 16M guard in maybeEmitVecLengthDefine; element defines double capacity,
// so use half). Defines beyond this fall back to the generic sidecar arm.
const _VEC_DEFINE_GROW_LIMIT = 8388608;

/**
 * (#3116) §10.4.2 Array exotic [[DefineOwnProperty]] for a native WasmGC vec
 * receiver in JS-host mode.
 *
 * Root cause this implements: defineProperty/defineProperties on a compiled
 * array reaches the runtime with the RAW vec struct; the generic opaque-struct
 * arm could only store values in the host-side sidecar, but element/length
 * reads compile to direct vec accesses (struct.get / array.get / __vec_get)
 * that never consult the sidecar — so defined values were invisible and the
 * `length` machinery (§10.4.2.1 ArraySetLength: RangeError validation, shrink
 * honoring non-configurable elements, non-writable length) did not exist.
 *
 * Split representation: VALUES live in the vec itself (written through the
 * `__vec_set_elem` / `__vec_set_len` exports so both static and dynamic read
 * lanes observe them); ATTRIBUTES live in the per-object sidecar descriptor
 * table (`_getSidecarDescs`), with "no entry" meaning the §10.4.2 default
 * (data, writable+enumerable+configurable). `_validatePropertyDescriptor`
 * provides the §10.1.6.3 rejection matrix; existing in-bounds elements are
 * seeded with the default flags first so redefinition validation sees a data
 * property, not a first definition.
 *
 * Returns true when fully handled. Returns false → caller falls through to
 * the generic struct arm (receiver is not a vec / mutation exports missing /
 * unsupported element kind / non-index non-length key / grow limit exceeded).
 * Ordering: throws (TypeError/RangeError) only fire on genuine vec receivers,
 * before any mutation, matching DefinePropertyOrThrow.
 */
function _vecDefineOwnProperty(
  obj: any,
  key: any,
  desc: PropertyDescriptor,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): boolean {
  if (typeof key === "symbol") return false;
  const exports = callbackState?.getExports();
  if (!exports) return false;
  const isVec = exports.__is_vec as ((v: any) => number) | undefined;
  const mutSup = exports.__vec_mut_supported as ((v: any) => number) | undefined;
  const lenFn = exports.__vec_len as ((v: any) => number) | undefined;
  const getFn = exports.__vec_get as ((v: any, i: number) => any) | undefined;
  const setElem = exports.__vec_set_elem as ((v: any, i: number, x: any) => number) | undefined;
  const setLen = exports.__vec_set_len as ((v: any, n: number) => number) | undefined;
  if (
    typeof isVec !== "function" ||
    typeof mutSup !== "function" ||
    typeof lenFn !== "function" ||
    typeof getFn !== "function" ||
    typeof setElem !== "function" ||
    typeof setLen !== "function"
  ) {
    return false;
  }
  try {
    if (isVec(obj) !== 1 || mutSup(obj) !== 1) return false;
  } catch {
    return false;
  }

  const keyStr = String(key);
  const sDescs = _getSidecarDescs(obj);
  const oldLen = lenFn(obj);
  const hasValue = _hasOwn(desc, "value");
  const hasWritable = _hasOwn(desc, "writable");
  const hasGet = _hasOwn(desc, "get");
  const hasSet = _hasOwn(desc, "set");

  // ── "length" → §10.4.2.1 ArraySetLength ─────────────────────────────
  if (keyStr === "length") {
    // length is a non-configurable, non-enumerable DATA property.
    if (hasGet || hasSet) throw new TypeError("Cannot redefine property: length");
    if (desc.configurable === true) throw new TypeError("Cannot redefine property: length");
    if (desc.enumerable === true) throw new TypeError("Cannot redefine property: length");
    const lenFlags = sDescs.get("length");
    const lenWritable = lenFlags === undefined ? true : !!(lenFlags & _SC_WRITABLE);
    if (!hasValue) {
      // Attribute-only define ({writable:false} — freeze/seal shape).
      if (hasWritable) {
        if (!lenWritable && desc.writable === true) {
          throw new TypeError("Cannot redefine property: length");
        }
        sDescs.set("length", desc.writable ? _SC_DEFINED | _SC_WRITABLE : _SC_DEFINED);
      }
      return true;
    }
    // Steps 3-8: newLen = ToUint32(value), numberLen = ToNumber(value);
    // SameValueZero mismatch → RangeError (catches negatives, non-integers,
    // NaN, > 2^32-1). ToNumber goes through the wasm-aware ToPrimitive so an
    // object value with compiled valueOf/toString converts per §7.1.1
    // (15.2.3.7-6-a-14x) instead of throwing "Cannot convert object".
    const numberLen = Number(_toPrimitiveSync(desc.value, "number", callbackState));
    const newLen = numberLen >>> 0;
    if (newLen !== numberLen) throw new RangeError("Invalid array length");
    if (newLen > oldLen && newLen > _VEC_DEFINE_GROW_LIMIT) return false; // allocation guard
    if (newLen !== oldLen && !lenWritable) {
      throw new TypeError("Cannot redefine property: length");
    }
    // Shrink: delete elements from the top, stopping at the first
    // non-configurable one (steps 19.b-d: length lands at that index + 1 and
    // the define reports failure → DefinePropertyOrThrow TypeError).
    let finalLen = newLen;
    let blocked = false;
    if (newLen < oldLen) {
      for (let i = oldLen - 1; i >= newLen; i--) {
        const f = sDescs.get(String(i));
        const configurable = f === undefined ? true : !!(f & _SC_CONFIGURABLE);
        if (!configurable) {
          finalLen = i + 1;
          blocked = true;
          break;
        }
        sDescs.delete(String(i));
      }
    }
    if (finalLen !== oldLen) setLen(obj, finalLen);
    if (hasWritable) {
      sDescs.set("length", desc.writable ? _SC_DEFINED | _SC_WRITABLE : _SC_DEFINED);
    }
    if (blocked) throw new TypeError("Cannot redefine property: length");
    return true;
  }

  // ── array-index keys ─────────────────────────────────────────────────
  const idx = _asArrayIndex(keyStr);
  if (idx === undefined) return false; // named prop → generic struct arm
  if (idx >= oldLen && idx + 1 > _VEC_DEFINE_GROW_LIMIT) return false; // allocation guard

  // NOTE on existing-element synthesis: an in-bounds element with no explicit
  // descriptor entry is treated as a FIRST definition (omitted attributes
  // default false), not a redefinition of a default data property. The codegen
  // pre-grows the vec to idx+1 (`maybeEmitVecLengthGrowth`) BEFORE the runtime
  // call, so `idx < oldLen` cannot distinguish a genuine element from a
  // compiler-created hole — seeding default (configurable) flags for a hole
  // suppressed the §10.1.6.3 non-configurable rejection matrix for
  // fresh-index defines (15.2.3.6-4-252 regression). Read-side descriptor
  // synthesis (_readOwnDescriptor) still reports w/e/c=true for untouched
  // in-bounds elements, which matches §10.4.2 defaults for literal elements.
  const nKey = _normalizeDescKey(keyStr);
  const hadEntry = sDescs.has(nKey);

  let existingVal: any;
  let existingDesc: PropertyDescriptor | undefined;
  if (idx < oldLen) {
    try {
      existingVal = getFn(obj, idx);
    } catch {
      existingVal = undefined;
    }
    if (hadEntry) {
      existingDesc = _readOwnDescriptor(obj, nKey, exports);
    }
  } else {
    // §10.4.2 step 2/4: adding an element at idx >= length requires length to
    // be writable.
    const lenFlags = sDescs.get("length");
    const lenWritable = lenFlags === undefined ? true : !!(lenFlags & _SC_WRITABLE);
    if (!lenWritable) {
      throw new TypeError("Cannot redefine property: " + keyStr);
    }
  }

  const newFlags = _validatePropertyDescriptor(sDescs, nKey, desc, existingVal, existingDesc);
  sDescs.set(nKey, newFlags);

  // Apply the value into the vec itself so element reads observe it.
  if (hasValue) {
    if (setElem(obj, idx, desc.value) !== 1) {
      // Element kind can't hold this value (e.g. string into an f64 vec after
      // unbox) — fall back to sidecar storage so at least dynamic reads see it.
      _sidecarSet(obj, keyStr, desc.value);
    }
  }
  // NOTE: a VALUE-less define beyond length (accessor / bare attributes) does
  // NOT extend the vec length here, although §10.4.2 says length becomes
  // idx+1. The element read lane cannot serve accessors (typed vec reads),
  // so extending length would turn a previously-OOB read (undefined — which
  // matches a getter returning undefined) into a hole-default read (null/0)
  // — a strict behavioral regression (15.2.3.6-4-312). The descriptor flags
  // above still make the §10.1.6.3 redefinition matrix correct; length
  // extension for accessor defines is deferred to the read-lane accessor
  // follow-up (#3022).

  // Accessor storage mirrors the generic struct arm (`__get_<k>`/`__set_<k>`
  // in the props sidecar) so dynamic reads/hasOwnProperty observe it. NOTE:
  // static/typed element reads bypass accessors — known limitation; the flags
  // above still make the validation matrix (shrink-blocking, redefinition
  // rules) spec-correct.
  if (hasGet || hasSet) {
    const sc = _wasmStructProps.get(obj) ?? {};
    _wasmStructProps.set(obj, sc);
    if (keyStr in sc && typeof (sc as any)[keyStr] !== "function") delete (sc as any)[keyStr];
    if (hasGet) {
      if (desc.get === undefined) delete (sc as any)[`__get_${keyStr}`];
      else (sc as any)[`__get_${keyStr}`] = desc.get;
    }
    if (hasSet) {
      if (desc.set === undefined) delete (sc as any)[`__set_${keyStr}`];
      else (sc as any)[`__set_${keyStr}`] = desc.set;
    }
    if (!(keyStr in sc)) (sc as any)[keyStr] = undefined;
  }
  return true;
}

// (#2801) Present a WasmGC vec (array) to the host as a REAL JS array view.
//
// Root cause this fixes: when a host reads an array-typed field through the
// `_wrapForHost` proxy (e.g. acorn `CallExpression.arguments`,
// `ArrayExpression.elements`), the value is a WasmGC vec struct. The previous
// code wrapped it with the *generic* object proxy (`_wrapForHost`), which has
// no `length` / numeric-index surface, so it marshalled as an empty object
// `{}` (`Array.isArray` false, `length` undefined) — the parsed AST was
// structurally wrong. A vec must instead present as an array.
//
// This returns a Proxy whose TARGET is a real `[]` (so `Array.isArray` is
// true and `instanceof Array` holds) and whose traps serve `length` + numeric
// indices LIVE from the underlying vec (`__vec_len` / `__vec_get`, elements
// recursively `_wrapForHost`-wrapped). Native generic Array.prototype methods
// (`map`, `forEach`, `slice`, `indexOf`, iteration, spread, `JSON.stringify`)
// work because they read `length` + indices through these traps. The proxy is
// registered in `_hostProxyReverse` → raw vec, so the existing
// `__extern_method_call` mutation path (`scopeStack.push(...)` →
// `_unwrapForHost` → `__vec_push`) still recovers the live vec and grows it;
// because reads are live (not a snapshot), a later push is reflected.
function _wrapVecForHost(vec: any, exports: Record<string, Function>): any {
  const cached = _hostProxyCache.get(vec);
  if (cached) return cached;
  const lenFn = exports.__vec_len as ((v: any) => number) | undefined;
  const getFn = exports.__vec_get as ((v: any, i: number) => any) | undefined;
  // Defensive: if the read exports are missing, fall back to the generic
  // object proxy rather than producing a broken array view.
  if (typeof lenFn !== "function" || typeof getFn !== "function") return undefined;
  // Keep the real-array target's non-configurable `length` slot aligned with
  // the live vec. Engines and assertion/inspection tooling may consult the
  // target's array exotic state directly instead of invoking every Proxy trap;
  // a permanently-empty target therefore made a valid live vec appear as `[]`.
  // Elements remain trap-backed—only the target's shape length is mirrored.
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
      return _wrapForHost(getFn(vec, i), exports);
    } catch {
      return undefined;
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
      const callable = _maybeWrapCallableUnknownArity(val, { getExports: () => exports });
      if (callable !== val) return { hit: true, value: callable };
      return { hit: true, value: _wrapForHost(val, exports) };
    }
    return { hit: true, value: val };
  };
  const handler: ProxyHandler<any[]> = {
    get(_t, key) {
      if (key === "length") return liveLen();
      if (typeof key === "string") {
        const idx = _asArrayIndex(key);
        if (idx !== undefined) return idx < liveLen() ? elemAt(idx) : undefined;
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
      const n = liveLen();
      const keys: (string | symbol)[] = [];
      for (let i = 0; i < n; i++) keys.push(String(i));
      keys.push("length");
      return keys;
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
      return undefined;
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
        const setLen = exports.__vec_set_len as ((v: any, n: number) => number) | undefined;
        return typeof setLen === "function" && setLen(vec, uint32) === 1;
      }
      if (typeof key === "string" && _asArrayIndex(key) !== undefined) {
        return _trySetWasmVecElement(vec, key, value, exports);
      }
      _safeSet(vec, key, value, exports);
      return true;
    },
  };
  const proxy = new Proxy(target, handler);
  _hostProxyCache.set(vec, proxy);
  _hostProxyReverse.set(proxy, vec);
  return proxy;
}

/**
 * (#2761 sub-cause B) Copy a vec's dynamic non-index own sidecar props onto a JS
 * array materialized from it. `__make_iterable`'s `convertToJS` builds a plain
 * `new Array(len)` of ELEMENTS only, so an array consumed as a SET-LIKE
 * (`arr.size/has/keys`, the `set-like-array.js` family) loses those props →
 * native `GetSetRecord` reads `size` as NaN. Mirrors `_wrapVecForHost`'s (#3201)
 * sidecar surfacing, eagerly onto the real array; closure values are
 * host-callable-wrapped. Skips index/`length`/`__get_`/`__set_` keys; a vec with
 * no sidecar (the common case) early-returns (free for ordinary arrays).
 */
function _copyVecSidecarOntoArray(vec: any, arr: any[], exports: Record<string, Function> | undefined): void {
  const sc = _wasmStructProps.get(vec);
  if (!sc) return;
  const wrapVal = (val: any): any => {
    if (val != null && typeof val === "object" && _isWasmStruct(val)) {
      const callable = _maybeWrapCallableUnknownArity(val, { getExports: () => exports });
      if (callable !== val) return callable;
      return _wrapForHost(val, exports);
    }
    return val;
  };
  const arrProps = arr as unknown as Record<PropertyKey, any>;
  const scProps = sc as unknown as Record<PropertyKey, any>;
  for (const key of Object.getOwnPropertyNames(sc)) {
    if (key === "length") continue;
    if (key.startsWith("__get_") || key.startsWith("__set_")) continue;
    if (_asArrayIndex(key) !== undefined) continue;
    arrProps[key] = wrapVal(scProps[key]);
  }
  for (const key of Object.getOwnPropertySymbols(sc)) {
    arrProps[key] = wrapVal(scProps[key]);
  }
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

function _wrapForHost(obj: any, exports: Record<string, Function> | undefined): any {
  if (obj == null || typeof obj !== "object") return obj;
  if (!_isWasmStruct(obj)) return obj;

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

  // (#2801) A WasmGC vec must present to the host as a real JS array, not a
  // generic object proxy (which marshalled as `{}`). Detect via the positive
  // `__is_vec` discriminator and route to the array-backed view. Done before
  // the generic-proxy path so every consumer (struct field reads, set-algebra
  // adapters, spread) sees array semantics uniformly.
  if (exports) {
    try {
      const isVecFn = exports.__is_vec as ((v: any) => number) | undefined;
      if (typeof isVecFn === "function" && isVecFn(obj) === 1) {
        const vecView = _wrapVecForHost(obj, exports);
        if (vecView !== undefined) return vecView;
      }
    } catch {
      // discriminator unavailable — fall through to the generic object proxy
    }
  }

  const target: Record<string | symbol, any> = Object.create(null);
  const exportSlot = { current: exports };
  _hostProxyExportSlots.set(obj, exportSlot);
  const currentExports = (): Record<string, Function> | undefined => exportSlot.current;

  // (#1627) Resolution precedence lives in the module-level `_resolveHostField`
  // so callers that need the unmasked raw value (GetSetRecord) can reuse it.
  const safeGetField = (key: any): any => _resolveHostField(obj, key, currentExports());

  // #1047 — if `obj` was registered as a class prototype, surface only the
  // method names in the allowlist. Otherwise fall back to the struct-field
  // enumeration used for regular instances.
  const isTombstoned = (key: string | symbol): boolean => {
    const tombstones = _wasmStructDeletedKeys.get(obj);
    return !!tombstones && tombstones.has(typeof key === "symbol" ? key : String(key));
  };

  const fieldNamesForHost = (): string[] => {
    const protoMethods = _prototypeMethodNames.get(obj);
    if (protoMethods !== undefined) {
      // #1364b — filter out names that have been `delete`d from this class
      // proto / class object so subsequent enumeration matches spec.
      return protoMethods.filter((n) => !_isDeletedClassProp(obj, n));
    }
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
      const val = safeGetField(key);
      const primitiveValue = _nativePrimitiveToHost(val, currentExports());
      if (primitiveValue !== _MISS) return primitiveValue;
      if (process.env.JS2WASM_DEBUG_3051) {
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
      if (Array.isArray(val) && liveExports) {
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
      // #1047 — for registered class prototypes, the allowlist is
      // authoritative: an instance field with a default value of 0/null
      // would otherwise appear truthy via safeGetField.
      const protoMethods = _prototypeMethodNames.get(obj);
      if (protoMethods !== undefined) {
        if (typeof key === "string" && protoMethods.includes(key) && !_isDeletedClassProp(obj, key)) return true;
        const sc = _wasmStructProps.get(obj);
        return !!sc && key in sc;
      }
      // #1364b — class object: a deleted static-method name must not appear in
      // `obj.method in C` checks anymore.
      if (typeof key === "string" && _isDeletedClassProp(obj, key)) return false;
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
      // (#3479 Slice C / #3512) Registered class OBJECT: the static-method
      // allowlist + sidecar are AUTHORITATIVE — mirrors the #1047 class-prototype
      // branch above and the class-object arm of `_wasmStructHasOwn` (2778). The
      // constructor's host proxy must NOT expose the class's INSTANCE struct
      // fields (`foo = "x"`) as own properties: `hasOwnProperty.call(C, "foo")`
      // and `"foo" in C` are false (instance fields live on instances, not on C).
      // Slice A (#3479) added the static-method answer via the allowlist but then
      // fell through to `safeGetField`/`fieldNamesForHost`, which read the
      // instance-field shape → the symmetric leak this closes. (`_isDeletedClassProp`
      // already returned false above for a deleted static name.)
      const staticMethods = _staticMethodNames.get(obj);
      if (staticMethods !== undefined) {
        if (typeof key === "string" && staticMethods.includes(key)) return true;
        const sc = _wasmStructProps.get(obj);
        return !!sc && key in sc;
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
      // Always report success — Array.prototype.pop etc. call
      // `delete O[len-1]` on sparse arrayLikes where the index may not be
      // present in the sidecar. Returning false here throws a Proxy
      // invariant TypeError. Sidecar delete is best-effort.
      _sidecarDelete(obj, key);
      // #1364b — if `obj` is a registered class prototype or class object and
      // `key` is a method/static name from its allowlist, mark it deleted so
      // subsequent `Object.getOwnPropertyDescriptor(obj, key)` returns
      // `undefined` (configurable: true semantics). verifyProperty's invariant
      // pass does exactly this round-trip.
      if (typeof key === "string") {
        const protoMethods = _prototypeMethodNames.get(obj);
        if (protoMethods !== undefined && protoMethods.includes(key)) {
          _markDeletedClassProp(obj, key);
        } else {
          const staticMethods = _staticMethodNames.get(obj);
          if (staticMethods !== undefined && staticMethods.includes(key)) {
            _markDeletedClassProp(obj, key);
          }
        }
      }
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
      // (#3479) Registered class-OBJECT static method — return the spec
      // descriptor the direct `__getOwnPropertyDescriptor` path already produces
      // (_readOwnDescriptor:4381 → {writable:true, enumerable:false,
      // configurable:true} with the static-method bridge value). `[[GetOwnProperty]]`
      // is what `Object.prototype.hasOwnProperty.call(C, "m")` (propertyHelper's
      // `.call.bind` form) invokes, so without this the host proxy reports static
      // methods absent even though `in` / `Object.getOwnPropertyDescriptor` see them.
      if (typeof key === "string" && !_isDeletedClassProp(obj, key)) {
        const staticMethods = _staticMethodNames.get(obj);
        if (staticMethods !== undefined && staticMethods.includes(key)) {
          const cd = _readOwnDescriptor(obj, key, currentExports());
          if (cd !== undefined) {
            try {
              Object.defineProperty(target, key, cd);
            } catch {
              /* already defined with different flags — ignore */
            }
            return cd;
          }
        }
      }
      // For Proxy invariants, getOwnPropertyDescriptor must match target's
      // non-configurable keys. Our target is an empty extensible object, so
      // we can return any descriptor we like. We must also reflect the
      // descriptor back onto target so ownKeys invariants are satisfied when
      // the host enumerates via Object.keys/getOwnPropertyNames (some
      // engines cross-check).
      const sc = _wasmStructProps.get(obj);
      const hasInSidecar = !!sc && key in sc;
      const fieldNames = fieldNamesForHost();
      const hasInFields = typeof key === "string" && fieldNames.includes(key);
      // #1047 — for registered class prototypes, only consult the allowlist
      // and the sidecar. Do NOT call safeGetField (which would read default
      // struct field values for leaking instance fields like `a = 0`).
      const protoMethods = _prototypeMethodNames.get(obj);
      if (protoMethods !== undefined) {
        if (!hasInFields && !hasInSidecar) return undefined;
      }
      // (#3479 Slice C / #3512) Registered class OBJECT: symmetric to the #1047
      // prototype restriction — only the static-method allowlist (already handled
      // above) and the sidecar are own properties of the constructor. Do NOT
      // report the class's INSTANCE struct fields (`hasInFields`) via the
      // constructor's `[[GetOwnProperty]]`, so `Object.getOwnPropertyDescriptor(C,
      // "foo")` / `hasOwnProperty.call(C, "foo")` are `undefined`/false.
      const staticMethods = _staticMethodNames.get(obj);
      if (staticMethods !== undefined && !hasInSidecar) return undefined;
      const val = safeGetField(key);
      if (protoMethods === undefined && val === undefined && !hasInSidecar && !hasInFields) return undefined;
      // (#2714) Reflect the sidecar descriptor's stored enumerable flag so a
      // `defineProperty(o, k, { enumerable: false })` own prop is reported as
      // non-enumerable through the host proxy. Native consumers that filter by
      // enumerability — `Object.assign` -> CopyDataProperties, object spread
      // `{ ...o }` (both lowered via `__object_assign` over a `_wrapForHost`
      // source) — must SKIP a non-enumerable own key. Hardcoding
      // `enumerable: true` here leaked non-enumerable sidecar props into spread
      // results (`spread-obj-skip-non-enumerable`, #2714). Declared struct
      // fields carry no sidecar flags entry and stay enumerable data props,
      // matching their spec semantics.
      //
      // (#3647) Registered class-PROTOTYPE members are the exception — the
      // sentence above used to lump them in with declared struct fields. A
      // MethodDefinition (§14.6 DefineMethod; likewise §14.4/§14.5 generator,
      // async and get/set members) is created `enumerable: false`, which
      // `_readOwnDescriptor` arm 2a (#1364a) has always reported and the
      // static-method arm above already defers to (#3479); only the prototype
      // case fell through here and hardcoded `true`. That is observable because
      // `Object.prototype.propertyIsEnumerable.call(C.prototype,"m")` reaches
      // NO `__propertyIsEnumerable` import on host — `__proto_method_call` runs
      // the ENGINE's method against this proxy, so §20.1.3.4 reads
      // `[[GetOwnProperty]]`, i.e. this trap. Only the `enumerable` bit is
      // corrected: `value` keeps `safeGetField` because arm 2a returns a method
      // BRIDGE value, which would also move accessor members' `value`.
      // `hasInFields` (not a raw `includes`) keeps `delete C.prototype.m`
      // (#1364b) working; an explicit `defineProperty(…,{enumerable:true})`
      // still wins via the sidecar flags entry below.
      const isRegisteredProtoMember = protoMethods !== undefined && hasInFields;
      const scFlags = _wasmPropDescs.get(obj)?.get(_normalizeDescKey(key));
      const desc: PropertyDescriptor = {
        value: val,
        writable: true,
        enumerable: scFlags === undefined ? !isRegisteredProtoMember : !!(scFlags & _SC_ENUMERABLE),
        configurable: true,
      };
      // Mirror onto target so V8's Proxy invariant checker is happy
      try {
        Object.defineProperty(target, key, desc);
      } catch {
        /* already defined with different flags — ignore */
      }
      return desc;
    },
    getPrototypeOf() {
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
  };

  const proxy = new Proxy(target, handler);
  _hostProxyCache.set(obj, proxy);
  _hostProxyReverse.set(proxy, obj);
  return proxy;
}

function _unwrapForHost(v: any): any {
  if (v == null || typeof v !== "object") return v;
  const orig = _hostProxyReverse.get(v);
  return orig ?? v;
}

// (#1694 A.i / #1632b-1) Host-callable/constructible representation of a
// compiled Wasm closure.
//
// `_wrapForHost` wraps an opaque WasmGC struct in a Proxy whose target is
// `Object.create(null)` — a plain, NON-callable object. A JS Proxy is
// `[[Call]]`-able / `[[Construct]]`-able only when its *target* is itself
// callable, so a closure wrapped that way is neither callable nor
// constructible. When such a value reaches a host built-in that must call or
// construct it — the canonical case is `Promise.all.call(NotPromise, …)`,
// where V8's NewPromiseCapability(C) performs `Construct(C, «executor»)` — V8
// rejects it with "… is not a constructor".
//
// `_wrapCallableForHost` wraps the closure in a Proxy whose target is a real
// `function`, so the Proxy may legally carry `apply` and `construct` traps and
// `typeof proxy === "function"` holds (required for V8's IsCallable /
// IsConstructor checks). All property operations (.prototype, .name, static
// members, has, ownKeys, …) delegate to the SAME `_wrapForHost(closure)` proxy,
// reusing its read/has/enumerate machinery verbatim — no logic is duplicated or
// extracted. Cached per closure so repeated wraps return the same Proxy
// (constructor identity / @@species comparisons stay stable) and mirrored into
// `_hostProxyReverse` so `_unwrapForHost` round-trips the value back to the raw
// struct when it flows back into Wasm.
//
// This is the ordinary-`[[Construct]]` representation (#1632b-1, runtime-only):
// the `construct` trap emulates ECMA-262 §10.2.2 OrdinaryCallEvaluateBody for a
// plain compiled function used with `new` — invoke the closure body with a
// fresh ordinary object as the implicit receiver, then return the body's value
// if it is an object, else the fresh receiver. The compiled-*class*-as-dynamic-
// constructor case (a dedicated `__construct_closure` export) is the separate
// codegen follow-up #1632b-2 and is intentionally NOT handled here; A.i's
// `NotPromise` is always an ordinary function, so this fallback closes it.
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
      return (propProxy as any)[key];
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
  // The same closure can cross the boundary as this constructible proxy and as
  // a dynamic wasmClosureDynamicBridge. Canonicalize both representations to
  // the raw closure so strict constructor identity remains stable.
  _wasmClosureWrapperTargets.set(proxy, closure);
  return proxy;
}

// ── #2180 — host-mode user `new Proxy` / `Proxy.revocable` construction ──────
//
// A compiled `new Proxy(target, handler)` reaches the host with `target` and
// `handler` as raw WasmGC structs (object literals compile to opaque structs).
// Two problems must be solved for the host's native Proxy MOP to behave per
// §10.5 / §28.2:
//
//  1. **Trap discovery.** The host reads `handler[trapName]` to find each trap.
//     On a raw struct every read returns `undefined` (opaque), so NO trap ever
//     fires and every operation silently falls through to the target. We build
//     a plain-object *bridge handler* whose trap methods forward to the Wasm
//     closures stored on the struct, invoked via `_wrapForHost`'s closure
//     bridge (which threads `this` = the original handler struct).
//
//  2. **Identity.** Spec trap signatures hand the user `target`/`handler`
//     identities (`get(t, p, recv)` with `t === target`, `this === handler`).
//     The user's source holds the *raw* structs, so the values the trap sees
//     must compare equal to those raw structs. We therefore use the raw struct
//     as the host `[[ProxyTarget]]` (preserving `t === target`) and re-thread
//     `this`/the target arg back to the raw handler/target inside each bridge.
//
// Construction also enforces the §28.2.1.1 step-1/2 `TypeError`s: both target
// and handler must be objects (a WasmGC struct counts as an object).
const _PROXY_TRAP_NAMES = [
  "apply",
  "construct",
  "defineProperty",
  "deleteProperty",
  "get",
  "getOwnPropertyDescriptor",
  "getPrototypeOf",
  "has",
  "isExtensible",
  "ownKeys",
  "preventExtensions",
  "set",
  "setPrototypeOf",
] as const;

function _isObjectLike(v: any): boolean {
  if (v === null || v === undefined) return false;
  const t = typeof v;
  return t === "object" || t === "function";
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

/**
 * (#2617) The strict-mode `delete obj[k]` result-coercion TypeError that the
 * (always-strict) bundled runtime raises when a Proxy `deleteProperty` trap
 * merely RETURNS FALSE (V8: "'deleteProperty' on proxy: trap returned falsish
 * for property ..."). This is NOT the trap throwing — in the user program's
 * non-strict context `delete` must yield `false`, not throw. Detected by message
 * so it can be mapped to a `return 0` instead of propagated. A trap that *itself*
 * throws produces a different error (its own value) and is propagated.
 */
function _isStrictDeleteFalsishError(e: any): boolean {
  return (
    e instanceof TypeError &&
    typeof e.message === "string" &&
    (e.message.includes("trap returned falsish") || e.message.includes("Cannot delete property"))
  );
}

/**
 * #2180 — build a real host Proxy from a user `new Proxy(target, handler)`.
 * `ctor` is "Proxy" or "Proxy.revocable" for the spec-mandated TypeError text.
 * Returns the constructed Proxy (revocable=false) — callers that need the
 * `{proxy, revoke}` pair call `_hostProxyConstructRevocable`.
 */
function _hostProxyConstruct(
  target: any,
  handler: any,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
  ctor: string,
): any {
  if (!_isObjectLike(target)) {
    throw new TypeError(`Cannot create ${ctor} with a non-object as target`);
  }
  if (!_isObjectLike(handler)) {
    throw new TypeError(`Cannot create ${ctor} with a non-object as handler`);
  }
  // (#2618) A Proxy whose target is CALLABLE is itself callable / constructable
  // (§10.5.12 / §10.5.13). The host engine derives the proxy's [[Call]] /
  // [[Construct]] exotic-ness from its [[ProxyTarget]] — but a raw wasm-closure
  // struct is NOT callable to V8, so `new Proxy(rawClosure, h)()` fails the host
  // IsCallable check ("... is not a function" / "call is not a function"). When
  // the user's target is a wasm closure, use its JS-callable wrapper as the
  // [[ProxyTarget]] so the proxy gains [[Call]]/[[Construct]] and host-side
  // `p(...)` / `p.call(...)` dispatch correctly. The bridge handler substitutes
  // the RAW struct back as the `target` argument of the apply/construct traps
  // (see `rawTarget` in `_buildProxyBridgeHandler`) so the user-observable trap
  // `target` is identity-equal to the value the program passed to `new Proxy`
  // (`assert.sameValue(t, target)` in apply/construct/call-parameters.js). A
  // non-callable target keeps the raw struct as before (identity-preserving, no
  // behavior change).
  const { proxyTarget, rawTarget } = _proxyTargetFor(target, callbackState);
  // (#3127) When the [[ProxyTarget]] stays the RAW WasmGC struct (non-callable
  // target, no wrapper substitution), the host engine's ordinary internal
  // methods cannot see its fields — the struct is opaque to V8, so a
  // trap-ABSENT `p.x` read `undefined` for every field (`new Proxy(t, {}).x`
  // === 0 after unbox). Hand the struct to the bridge builder so it can
  // install a struct-aware default `get` forwarder for that case.
  const structTarget = rawTarget === undefined && _isWasmStruct(target) ? target : undefined;
  const bridgeHandler = _buildProxyBridgeHandler(handler, callbackState, rawTarget, structTarget);
  const proxy = new Proxy(proxyTarget, bridgeHandler);
  _userProxies.add(proxy);
  return proxy;
}

/** #2180 — `Proxy.revocable(target, handler)` → `{ proxy, revoke }`. */
function _hostProxyConstructRevocable(
  target: any,
  handler: any,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
): any {
  if (!_isObjectLike(target)) {
    throw new TypeError("Cannot create proxy with a non-object as target");
  }
  if (!_isObjectLike(handler)) {
    throw new TypeError("Cannot create proxy with a non-object as handler");
  }
  // (#2618) Mirror `_hostProxyConstruct`: a callable target makes the revocable
  // proxy callable/constructable; use its JS wrapper as [[ProxyTarget]] and
  // restore the raw struct in the apply/construct traps.
  const { proxyTarget, rawTarget } = _proxyTargetFor(target, callbackState);
  // (#3127) Same struct-aware trap-absent `get` forwarding as `_hostProxyConstruct`.
  const structTarget = rawTarget === undefined && _isWasmStruct(target) ? target : undefined;
  const bridgeHandler = _buildProxyBridgeHandler(handler, callbackState, rawTarget, structTarget);
  const rv = Proxy.revocable(proxyTarget, bridgeHandler);
  if (rv && typeof rv.proxy === "object" && rv.proxy !== null) _userProxies.add(rv.proxy);
  return rv;
}

/**
 * (#2618) Decide the host [[ProxyTarget]] for a user `new Proxy(target, …)`.
 * If `target` is a wasm-closure struct, V8 cannot treat it as callable, so a
 * proxy built on it is not callable/constructable host-side. Wrap it into a
 * JS-callable function and use THAT as [[ProxyTarget]] (gives the proxy
 * [[Call]]/[[Construct]]); return `rawTarget` = the original struct so the
 * apply/construct trap bridge can substitute it back for target identity. For a
 * non-callable target (or when exports aren't wired yet so the wrap can't be
 * built), keep the raw target unchanged and signal "no substitution"
 * (`rawTarget === undefined`).
 */
function _proxyTargetFor(
  target: any,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
): { proxyTarget: any; rawTarget: any } {
  const callable = _maybeWrapCallableUnknownArity(target, callbackState);
  if (typeof callable === "function" && callable !== target) {
    return { proxyTarget: callable, rawTarget: target };
  }
  return { proxyTarget: target, rawTarget: undefined };
}

/**
 * #2180 — read a (possibly closure-valued) field off a WasmGC struct WITHOUT
 * routing through `_wrapForHost` (whose mirror double-wraps a closure field
 * into a non-callable object — the very bug that left every user trap
 * undiscovered). Prefers the per-shape `__sget_<name>` field getter, then the
 * sidecar store. Returns `undefined` when the field is absent.
 */
function _structFieldRaw(obj: any, name: string, exports: Record<string, Function> | undefined): any {
  if (exports) {
    const getter = exports[`__sget_${name}`];
    if (typeof getter === "function") {
      try {
        const v = getter(obj);
        if (v !== undefined && v !== null) return v;
      } catch {
        /* field not present on this struct shape */
      }
    }
  }
  return _sidecarGet(obj, name);
}

/**
 * #2180 — translate a (possibly WasmGC-struct) user handler into a plain-object
 * handler the host engine can read trap functions from. Each present trap is
 * read directly off the struct and wrapped into a JS callable that dispatches
 * the underlying Wasm closure with `this` = the raw handler struct (so the
 * user-observable `this` inside the trap is identity-equal to the `handler`
 * value the compiled program holds). A trap the user did not define is omitted,
 * so the host falls back to its default (ordinary) behavior for that operation
 * — matching the spec, where a missing trap means "use the target's internal
 * method".
 */
function _buildProxyBridgeHandler(
  handler: any,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
  // (#2618) When the proxy's [[ProxyTarget]] is a substituted JS-callable
  // WRAPPER (because the user's target was a wasm closure V8 can't treat as
  // callable), the engine passes that wrapper as `args[0]` to the
  // `apply`/`construct` traps. `rawTarget` is the original struct the user
  // passed to `new Proxy`; the apply/construct bridge substitutes it back so
  // `assert.sameValue(trapTarget, target)` holds. `undefined` ⇒ no substitution
  // (non-callable target, identity-preserving — the prior behavior).
  rawTarget?: any,
  // (#3127) The user's target when it is a RAW WasmGC struct kept as the
  // [[ProxyTarget]] (no callable substitution). Such a target is OPAQUE to the
  // host engine's ordinary internal methods, so "missing trap ⇒ target's
  // default behavior" (§7.3.10) silently reads `undefined` for every field —
  // `new Proxy(structTarget, {}).x` returned 0 instead of the field value.
  // When set, the builders install a struct-aware default `get` forwarder for
  // the trap-absent case. `undefined` ⇒ non-struct target (host default is
  // already correct) or substituted callable wrapper (readable by the host).
  structTarget?: any,
): any {
  // Plain JS handler (created host-side, not a WasmGC struct) already exposes
  // its traps directly. BUT if the [[ProxyTarget]] is a substituted callable
  // wrapper, even a plain-JS handler's apply/construct trap would observe the
  // wrapper as `target` — so wrap just those two traps to restore the raw
  // target. With no substitution this returns the handler verbatim (identity /
  // `this` untouched, exactly as before). (#3127) Trap-absent struct-target
  // forwarding for plain-JS handlers is a known residual gap — compiled
  // programs produce WasmGC-struct handlers, so the struct-handler paths below
  // cover the live shapes.
  if (!_isWasmStruct(handler)) {
    return rawTarget === undefined ? handler : _wrapPlainHandlerForRawTarget(handler, rawTarget);
  }

  const exports = callbackState?.getExports();

  // (#2618) START-timing: a TOP-LEVEL `new Proxy(target, handler)` — the
  // dominant test262 shape (`var p = new Proxy(...)` at module scope; every
  // non-realm `built-ins/Proxy/{apply,construct}/*` file does this) — runs
  // inside the wasm module's START function, BEFORE `setExports` wires
  // `__is_closure` and the `__sget_*` field getters. With `exports` still
  // undefined we can neither (a) read each trap field off the WasmGC handler
  // struct (`__sget_<name>` unavailable, so `_structFieldRaw` falls through to a
  // sidecar miss) nor (b) classify a found field as a wasm closure
  // (`__is_closure` unavailable → `_maybeWrapCallableUnknownArity` returns the
  // raw struct). The previous eager build therefore lost EVERY user trap on a
  // top-level proxy: the host fell back to its default internal methods (so
  // `p.x` / `p()` / `new p()` silently returned the WRONG value — verified:
  // top-level `new Proxy({a:1},{get:()=>99}).x` returned the target's value,
  // not 99). The program only INVOKES the proxy later, from an exported
  // function, by which time exports ARE wired — so deferring trap resolution
  // to invocation time recovers correct behaviour.
  //
  // Fix: when exports are not yet available, build a lazy bridge whose traps
  // resolve the underlying user trap on first invocation through the
  // now-wired exports. Fully self-contained — no global proxy registry, no
  // setExports replay. The common case (exports present at construct time, i.e.
  // a proxy built inside an exported function) is unchanged: the eager branch
  // below is byte-for-byte the prior logic.
  if (!exports) {
    return _buildLazyProxyBridgeHandler(handler, callbackState, rawTarget, structTarget);
  }

  const bridge: Record<string, any> = {};
  for (const name of _PROXY_TRAP_NAMES) {
    const rawTrap = _structFieldRaw(handler, name, exports);
    if (rawTrap == null) {
      // undefined/null → genuine absence, host forwards to target (§7.3.10).
      // (#3127) EXCEPT `get` on a raw WasmGC-struct [[ProxyTarget]]: the host's
      // ordinary [[Get]] cannot see the opaque struct's fields, so forward the
      // read through the canonical struct-field resolution (`_resolveHostField`
      // — accessor getter → sidecar → `__sget_*` field getter → well-known-
      // symbol sidecar → vivified prototype; the same precedence `_wrapForHost`
      // uses). Invariant validation still runs against the opaque target, which
      // exposes no own descriptors — so no §10.5.8 conflicts arise.
      if (name === "get" && structTarget !== undefined) {
        bridge[name] = (_t: any, key: any, _receiver: any): any =>
          _resolveHostField(structTarget, key, callbackState?.getExports());
      }
      continue;
    }
    const callable = _maybeWrapCallableUnknownArity(rawTrap, callbackState);
    if (typeof callable !== "function") {
      // (#2616) §7.3.10 GetMethod: a present-but-non-callable trap value (`{}`,
      // `1`, `"x"`, …) is NOT absence — it must throw a TypeError when the owning
      // internal method runs. Previously this was silently omitted, so the host
      // engine used its default (ordinary) behavior and the spec-mandated
      // TypeError never fired. Install a bridge trap that throws on invocation;
      // the throw surfaces at operation time (`p.attr`, `p(...)`, `new p(...)`),
      // which is exactly when test262 checks for it. The host TypeError
      // propagates through the Proxy MOP and the lastCaughtException bridge so
      // `e instanceof TypeError` holds in the compiled program.
      bridge[name] = () => {
        throw new TypeError(`'${name}' on proxy: trap is not a function`);
      };
      continue;
    }
    // Forward to the user trap with `this` = the raw handler struct. The
    // closure bridge installs that struct as `__current_this`, so the trap
    // body's `this` is the same value the program sees as `handler` and
    // `assert.sameValue(this, handler)` passes. Spec-correct args (raw target,
    // property key, receiver = our user Proxy) flow through unchanged.
    //
    // (#2618) For the `apply`/`construct` traps, when the [[ProxyTarget]] is a
    // substituted callable wrapper, V8 passes that wrapper as args[0]; restore
    // the raw struct so the trap's `target` parameter is identity-equal to the
    // value the program passed to `new Proxy` (apply/construct/call-parameters).
    const substituteTarget = rawTarget !== undefined && (name === "apply" || name === "construct");
    bridge[name] = function (this: any, ...args: any[]): any {
      if (substituteTarget && args.length > 0) args[0] = rawTarget;
      return (callable as Function).apply(handler, args);
    };
  }
  return bridge;
}

/**
 * (#2618) Wrap a plain-JS handler so its `apply`/`construct` traps see the raw
 * wasm-struct target instead of the substituted callable wrapper installed as
 * [[ProxyTarget]]. Every other trap is copied through unchanged so identity /
 * `this` are preserved.
 */
function _wrapPlainHandlerForRawTarget(handler: any, rawTarget: any): any {
  const wrapped: Record<string, any> = {};
  for (const k of Reflect.ownKeys(handler)) wrapped[k as string] = (handler as any)[k];
  for (const tn of ["apply", "construct"] as const) {
    const userTrap = (handler as any)[tn];
    if (typeof userTrap === "function") {
      wrapped[tn] = function (this: any, _t: any, ...rest: any[]): any {
        return userTrap.call(this, rawTarget, ...rest);
      };
    }
  }
  return wrapped;
}

/**
 * (#2618) START-timing bridge for a WasmGC-struct handler built BEFORE
 * `setExports` (a top-level `new Proxy(...)`). Trap fields can't be read or
 * classified at construct time, so install a thunk for EVERY MOP name; each
 * thunk resolves the underlying user trap lazily on first invocation — by which
 * point the program is running an exported function and exports are wired.
 *
 * Lazy semantics deliberately mirror the eager builder so behaviour is
 * identical whether the proxy was built before or after `setExports`:
 *  - field absent (undefined/null) at resolve time → forward to the target's
 *    DEFAULT internal method (§7.3.10 missing trap), exactly as omitting the
 *    bridge key would have made the host do.
 *  - field present but non-callable → TypeError (§7.3.10 GetMethod), same text
 *    as the eager throwing stub.
 *  - field a callable closure → forward to it with `this` = the raw handler
 *    struct (identity-preserving), same as the eager path.
 */
function _buildLazyProxyBridgeHandler(
  handler: any,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
  rawTarget?: any,
  // (#3127) See `_buildProxyBridgeHandler` — the raw WasmGC-struct target kept
  // as [[ProxyTarget]], for struct-aware trap-absent `get` forwarding.
  structTarget?: any,
): any {
  const bridge: Record<string, any> = {};
  for (const name of _PROXY_TRAP_NAMES) {
    const substituteTarget = rawTarget !== undefined && (name === "apply" || name === "construct");
    bridge[name] = function (this: any, ...args: any[]): any {
      const lateExports = callbackState?.getExports();
      const rawTrap = _structFieldRaw(handler, name, lateExports);
      if (rawTrap == null) {
        // Trap genuinely absent → forward to the target's default internal
        // method. `args[0]` is the [[ProxyTarget]] (the callable WRAPPER when a
        // wasm-closure target was substituted) — forward through it unchanged so
        // a default apply/construct lands on a host-callable value.
        // (#3127) EXCEPT `get` on a raw WasmGC-struct [[ProxyTarget]] — opaque
        // to the host's ordinary [[Get]]; read through the canonical
        // struct-field resolution (see the eager builder).
        if (name === "get" && structTarget !== undefined) {
          return _resolveHostField(structTarget, args[1], lateExports);
        }
        return _proxyForwardDefault(name, args);
      }
      // (#2618) restore the raw target for apply/construct (see eager path) only
      // when actually invoking the user trap, so the trap's `target` parameter
      // is identity-equal to what the program passed to `new Proxy`.
      if (substituteTarget && args.length > 0) args[0] = rawTarget;
      const callable = _maybeWrapCallableUnknownArity(rawTrap, callbackState);
      if (typeof callable !== "function") {
        throw new TypeError(`'${name}' on proxy: trap is not a function`);
      }
      return (callable as Function).apply(handler, args);
    };
  }
  return bridge;
}

/**
 * (#2618) Forward a Proxy MOP to the target's DEFAULT internal method, used by
 * the lazy bridge when a trap turns out to be absent at resolve time. The host
 * passes the bridge trap the spec-mandated argument list whose first element is
 * always the [[ProxyTarget]]; mapping each trap name to the corresponding
 * Reflect.* default reproduces "missing trap ⇒ ordinary behaviour" (§7.3.10).
 */
function _proxyForwardDefault(name: string, args: any[]): any {
  const target = args[0];
  switch (name) {
    case "get":
      return Reflect.get(target, args[1], args[2] ?? target);
    case "set":
      return Reflect.set(target, args[1], args[2], args[3] ?? target);
    case "has":
      return Reflect.has(target, args[1]);
    case "deleteProperty":
      return Reflect.deleteProperty(target, args[1]);
    case "defineProperty":
      return Reflect.defineProperty(target, args[1], args[2]);
    case "getOwnPropertyDescriptor":
      return Reflect.getOwnPropertyDescriptor(target, args[1]);
    case "ownKeys":
      return Reflect.ownKeys(target);
    case "getPrototypeOf":
      return Reflect.getPrototypeOf(target);
    case "setPrototypeOf":
      return Reflect.setPrototypeOf(target, args[1]);
    case "isExtensible":
      return Reflect.isExtensible(target);
    case "preventExtensions":
      return Reflect.preventExtensions(target);
    case "apply":
      return Reflect.apply(target, args[1], args[2] ?? []);
    case "construct":
      return Reflect.construct(target, args[1] ?? [], args[2] ?? target);
    default:
      return undefined;
  }
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

/** Convert a WasmGC vec struct (or JS array) to a plain JS array.
 *  Used by array method host imports that need a real JS array. */
function _toJsArray(arr: any, exports: Record<string, Function> | undefined): any[] {
  if (arr == null) return [];
  if (Array.isArray(arr)) return arr;
  if (exports) {
    const vecLen = exports.__vec_len;
    const vecGet = exports.__vec_get;
    // (#3637) POSITIVE discriminator — the bare `typeof len === "number"` test
    // this replaces was vacuous (see `_isWasmVec`), so ANY non-vec wasm struct
    // handed to an array-method host import silently became `[]` instead of the
    // documented "wrap single value" fallback.
    if (typeof vecLen === "function" && typeof vecGet === "function" && _isWasmVec(arr, exports)) {
      try {
        const len = vecLen(arr) as number;
        if (typeof len === "number" && len >= 0) {
          const result: any[] = new Array(len);
          for (let i = 0; i < len; i++) {
            result[i] = vecGet(arr, i);
          }
          return result;
        }
      } catch {
        // (#3637) NOT "not a vec" — `_isWasmVec` on the guard above owns that
        // question; `__vec_len` returns 0 for a non-vec instead of throwing.
        // Only a genuine element-read trap lands here.
      }
    }
  }
  return [arr]; // Fallback: wrap single value
}

/**
 * (#1996) Recursion cap for `_toJsArrayDeep`. Generous enough for any
 * realistic nesting while preventing unbounded recursion on a pathological
 * input. Vec refs are acyclic, so this is a safety ceiling, not a semantic
 * limit.
 */
const VEC_UNWRAP_MAX_DEPTH = 64;

/**
 * (#1996) Recursively materialize a WasmGC vec into a JS array, unwrapping
 * any nested vec-ref elements into real JS arrays so native `Array.prototype`
 * methods (`flat`, `flatMap`, `JSON.stringify`) recognize them via
 * `Array.isArray`. Without this, `_toJsArray` converts only the outer vec and
 * leaves inner elements as opaque WasmGC refs, which `flat()` cannot flatten
 * and `JSON.stringify` renders as `null`.
 *
 * `maxDepth` bounds the recursion so already-flat scalar elements aren't probed
 * past the depth the caller cares about (flat's depth argument). A non-vec
 * value passes through unchanged.
 */
function _toJsArrayDeep(arr: any, exports: Record<string, Function> | undefined, maxDepth: number): any {
  if (arr == null) return arr;
  if (Array.isArray(arr)) {
    if (maxDepth <= 0) return arr;
    return arr.map((el) => _toJsArrayDeep(el, exports, maxDepth - 1));
  }
  // Only probe opaque WasmGC structs as candidate vecs — scalars (numbers,
  // strings, booleans) and JS objects pass straight through.
  if (maxDepth <= 0 || !_isWasmStruct(arr) || !exports) return arr;
  const vecLen = exports.__vec_len;
  const vecGet = exports.__vec_get;
  if (typeof vecLen !== "function" || typeof vecGet !== "function") return arr;
  // (#3637) "A non-vec value passes through unchanged" (the doc comment above)
  // was FALSE for a non-vec *struct*: with no discriminator at all, `__vec_len`
  // answered its not-a-vec default 0 and the struct came back as `[]`. Measured
  // pre-fix: `[{x: 1}].flat()` → `[]` (the object element was destroyed, then
  // flattened away). `_isWasmVec` makes the documented behaviour true.
  if (!_isWasmVec(arr, exports)) return arr;
  try {
    const len = vecLen(arr) as number;
    if (typeof len !== "number" || len < 0) return arr;
    const result: any[] = new Array(len);
    for (let i = 0; i < len; i++) {
      result[i] = _toJsArrayDeep(vecGet(arr, i), exports, maxDepth - 1);
    }
    return result;
  } catch {
    return arr; // Not a vec — pass through
  }
}

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
  /** symbol id → user-registered description (`null` = Symbol() w/ no desc). */
  symbolDescRegistry?: Map<number, string | null>;
  /**
   * (#3676) `Symbol.for` registry key → the i32 id the compiled module uses for
   * that registered symbol. Ids are allocated NEGATIVE so they can never
   * collide with the well-known ids (1..15) or with the in-module
   * `__symbol_counter` global, which starts at 100 and only ever ascends.
   */
  symbolForIds?: Map<string, number>;
  /** legacy RegExp static state (`RegExp.$1` etc.) — per instance, not shared. */
  legacyRegExpState: LegacyRegExpState;
  /** user-class name → registered subclass constructors (#1933 retention leak). */
  subclassCtors?: Map<string, Function[]>;
  /** user-class name → parent class name (or null). */
  userClassParents?: Map<string, string | null>;
  /**
   * (#2637 B2) `class extends Promise` name → the host-bridged wasm
   * constructor-body callable (`$<Class>_new`, registered via
   * `__register_promise_subclass_ctor`). Consulted by `__promise_subclass_ctor`
   * so V8's `NewPromiseCapability(C)` runs the user ctor body on the capability
   * promise. Per-instance (not module-scope) to avoid cross-module retention.
   */
  promiseSubclassBodies?: Map<string, Function>;
  /** (#2637 B2) `class extends Promise` name → synthesized JS subclass ctor (cached). */
  promiseSubclassCtors?: Map<string, any>;
}

// (#1638) Date.prototype string-formatter mode selectors. Kept in sync with
// DATE_FORMAT_MODE in src/codegen/expressions/builtins.ts.
const _DATE_FMT_ISO = 0;
const _DATE_FMT_UTC = 1;
const _DATE_FMT_STRING = 2;
const _DATE_FMT_DATE = 3;
const _DATE_FMT_TIME = 4;
const _DATE_FMT_JSON = 5;
const _DATE_FMT_LOCALE_STRING = 6;
const _DATE_FMT_LOCALE_DATE = 7;
const _DATE_FMT_LOCALE_TIME = 8;

const _DATE_DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const _DATE_MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const _DATE_INVALID_SENTINEL = -9223372036854775808n;

/** Zero-pad a non-negative integer to `width` digits. */
function _datePad(n: number, width: number): string {
  return String(Math.abs(n)).padStart(width, "0");
}

/**
 * (#1638) Build the spec-correct string for a Date method from the i64
 * timestamp (ms since epoch) and a mode selector. All fields are computed in
 * UTC, matching the compiler's UTC-only Date model (getTimezoneOffset() === 0).
 *
 * Per ECMA-262 §21.4.4: an Invalid Date (sentinel timestamp) yields
 * "Invalid Date" for the string formatters, throws RangeError for
 * toISOString, and (via toJSON) returns null at the call site — toJSON is
 * handled in codegen, this helper only fields the string-producing modes.
 */
function _formatDate(ts: bigint, mode: number): string {
  const invalid = ts === _DATE_INVALID_SENTINEL;

  if (mode === _DATE_FMT_ISO) {
    if (invalid) throw new RangeError("Invalid time value");
    const d = new Date(Number(ts));
    return d.toISOString();
  }

  if (invalid) {
    // toString / toDateString / toTimeString / toUTCString / toLocale*
    // all return "Invalid Date" for an Invalid Date receiver (§21.4.4.41.4).
    return "Invalid Date";
  }

  const ms = Number(ts);
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const date = d.getUTCDate();
  const day = d.getUTCDay();
  const hours = d.getUTCHours();
  const minutes = d.getUTCMinutes();
  const seconds = d.getUTCSeconds();

  const wday = _DATE_DAY_NAMES[day];
  const mon = _DATE_MONTH_NAMES[month];
  // DateString / UTCString family (§21.4.4.41.1, §21.4.4.43) require a minimum
  // of four digits with a leading sign on negative years: -1 → "-0001",
  // -12345 → "-12345". The ISO path (toISOString) uses its own ±YYYYYY 6-digit
  // form and is handled by `d.toISOString()` above, so it is unaffected.
  const yearStr = year < 0 ? "-" + _datePad(year, 4) : _datePad(year, 4);
  const dd = _datePad(date, 2);
  const hh = _datePad(hours, 2);
  const mm = _datePad(minutes, 2);
  const ssStr = _datePad(seconds, 2);
  const timePart = `${hh}:${mm}:${ssStr}`;

  // §21.4.4.41.1 DateString: "Www Mmm DD YYYY"
  const dateStr = `${wday} ${mon} ${dd} ${yearStr}`;
  // §21.4.4.41.2 TimeString + TimeZoneString: "HH:mm:ss GMT+0000 (Coordinated Universal Time)"
  const timeStr = `${timePart} GMT+0000 (Coordinated Universal Time)`;

  switch (mode) {
    case _DATE_FMT_STRING:
    case _DATE_FMT_LOCALE_STRING:
      // toString: DateString + " " + TimeString
      return `${dateStr} ${timeStr}`;
    case _DATE_FMT_DATE:
    case _DATE_FMT_LOCALE_DATE:
      return dateStr;
    case _DATE_FMT_TIME:
    case _DATE_FMT_LOCALE_TIME:
      return timeStr;
    case _DATE_FMT_UTC:
      // §21.4.4.43 UTCString: "Www, DD Mmm YYYY HH:mm:ss GMT"
      return `${wday}, ${dd} ${mon} ${yearStr} ${timePart} GMT`;
    case _DATE_FMT_JSON:
      // toJSON for a valid Date is toISOString; invalid handled above/at call site.
      return d.toISOString();
    default:
      return `${dateStr} ${timeStr}`;
  }
}

function _temporalTrunc(v: any): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.trunc(n);
}

function _temporalPad(n: number, width: number): string {
  return String(Math.abs(Math.trunc(n))).padStart(width, "0");
}

function _temporalYearString(yearRaw: any): string {
  const year = _temporalTrunc(yearRaw);
  if (year >= 0 && year <= 9999) return _temporalPad(year, 4);
  return (year < 0 ? "-" : "+") + _temporalPad(year, 6);
}

function _temporalPlainDateToString(year: any, month: any, day: any): string {
  return `${_temporalYearString(year)}-${_temporalPad(_temporalTrunc(month), 2)}-${_temporalPad(_temporalTrunc(day), 2)}`;
}

function _temporalPlainDateMonthCode(month: any): string {
  return `M${_temporalPad(_temporalTrunc(month), 2)}`;
}

function _temporalPlainTimeToString(
  hour: any,
  minute: any,
  second: any,
  millisecond: any,
  microsecond: any,
  nanosecond: any,
): string {
  const base = `${_temporalPad(_temporalTrunc(hour), 2)}:${_temporalPad(_temporalTrunc(minute), 2)}:${_temporalPad(
    _temporalTrunc(second),
    2,
  )}`;
  const fraction =
    _temporalPad(_temporalTrunc(millisecond), 3) +
    _temporalPad(_temporalTrunc(microsecond), 3) +
    _temporalPad(_temporalTrunc(nanosecond), 3);
  const trimmed = fraction.replace(/0+$/, "");
  return trimmed.length > 0 ? `${base}.${trimmed}` : base;
}

// ---- Temporal ISO 8601 / RFC 9557 strict string parsing (#661 / PR #1274) ----
//
// Spec-first implementation of the string grammar from tc39/proposal-temporal:
//   - "RFC 9557 / ISO 8601 grammar" (sec-temporal-iso8601grammar), incl. the
//     early errors: DateYear "-000000" is a Syntax Error; IsValidDate rejects
//     impossible month/day combos and Feb 29 in non-leap years.
//   - ParseISODateTime (sec-temporal-parseisodatetime): annotation handling —
//     a second `u-ca` calendar annotation throws RangeError when either has
//     the `!` critical flag; any unknown annotation key with the critical
//     flag throws RangeError; TimeSecond 60 is clamped to 59.
//   - ParseTemporalDurationString (sec-temporal-parsetemporaldurationstring):
//     fractions only on the smallest present time unit, 1-9 digits, period
//     or comma; fractional hours/minutes/seconds balance into smaller units;
//     magnitudes are floored before the sign factor is applied.
//   - IsValidDuration (sec-temporal-isvalidduration): mixed signs are
//     invalid; |years|/|months|/|weeks| must be < 2^32; the normalized
//     nanosecond total must be < 10^9 * 2^53 (computed exactly via BigInt
//     per the spec NOTE about 64-bit float imprecision).
//
// Grammar fragments (sec-temporal-iso8601grammar). Each of the date, time,
// and offset parts may independently use basic (no separators) or extended
// (mandatory separators) format.
const _tYearSrc = "(\\d{4}|[+-]\\d{6})";
const _tMonthSrc = "(0[1-9]|1[0-2])";
const _tDaySrc = "(0[1-9]|[12]\\d|3[01])";
const _tHourSrc = "([01]\\d|2[0-3])";
const _tMinuteSrc = "([0-5]\\d)";
const _tSecondSrc = "([0-5]\\d|60)";
const _tFracSrc = "(?:[.,](\\d{1,9}))";
const _tDateExtSrc = `${_tYearSrc}-${_tMonthSrc}-${_tDaySrc}`;
const _tDateBasicSrc = `${_tYearSrc}${_tMonthSrc}${_tDaySrc}`;
const _tTimeExtSrc = `${_tHourSrc}(?::${_tMinuteSrc}(?::${_tSecondSrc}${_tFracSrc}?)?)?`;
const _tTimeBasicSrc = `${_tHourSrc}(?:${_tMinuteSrc}(?:${_tSecondSrc}${_tFracSrc}?)?)?`;
// UTCOffset[+SubMinutePrecision] — parsed for validity, value ignored.
const _tOffsetSrc =
  "[+-](?:[01]\\d|2[0-3])(?::[0-5]\\d(?::[0-5]\\d(?:[.,]\\d{1,9})?)?|[0-5]\\d(?:[0-5]\\d(?:[.,]\\d{1,9})?)?)?";
// TimeZoneAnnotation ::: `[` `!`? (UTCOffset[~SubMinutePrecision] | TimeZoneIANAName) `]`
const _tTzAnnotationRe = new RegExp(
  "^\\[!?(?:[+-](?:[01]\\d|2[0-3])(?::?[0-5]\\d)?|[A-Za-z._][A-Za-z._0-9+-]*(?:\\/[A-Za-z._][A-Za-z._0-9+-]*)*)\\]$",
);
// Annotation ::: `[` `!`? AnnotationKey `=` AnnotationValue `]`
const _tAnnotationRe = /^\[(!?)([a-z_][a-z0-9_-]*)=([A-Za-z0-9]+(?:-[A-Za-z0-9]+)*)\]$/;
const _tBracketSplitRe = /\[[^\]]*\]/g;

/**
 * Validate the bracketed suffix of an ISO string per the grammar
 * `TimeZoneAnnotation? Annotations?` and the ParseISODateTime annotation
 * rules (duplicate critical u-ca, unknown critical key). Throws RangeError.
 */
function _temporalValidateBrackets(suffix: string): void {
  if (suffix.length === 0) return;
  const brackets = suffix.match(_tBracketSplitRe) ?? [];
  if (brackets.join("") !== suffix) throw new RangeError("invalid annotation syntax in Temporal string");
  let calendar: string | undefined;
  let calendarWasCritical = false;
  for (let i = 0; i < brackets.length; i++) {
    const bracket = brackets[i]!;
    if (i === 0 && _tTzAnnotationRe.test(bracket) && !_tAnnotationRe.test(bracket)) {
      continue; // single leading TimeZoneAnnotation
    }
    const annotation = _tAnnotationRe.exec(bracket);
    if (!annotation) throw new RangeError("invalid annotation in Temporal string");
    const critical = annotation[1] === "!";
    const key = annotation[2]!;
    if (key === "u-ca") {
      if (calendar === undefined) {
        calendar = annotation[3]!;
        calendarWasCritical = critical;
      } else if (critical || calendarWasCritical) {
        throw new RangeError("duplicate critical calendar annotation in Temporal string");
      }
    } else if (critical) {
      throw new RangeError(`unknown critical annotation key "${key}" in Temporal string`);
    }
  }
  // CanonicalizeCalendar / CalendarFromIdentifier: an unrecognized calendar
  // type is a RangeError. Recognized set = CLDR/BCP 47 calendar types used
  // by test262 (ASCII case-insensitive).
  if (calendar !== undefined && !_temporalKnownCalendars.has(calendar.toLowerCase())) {
    throw new RangeError(`unknown calendar "${calendar}" in Temporal string`);
  }
}

const _temporalKnownCalendars = new Set([
  "iso8601",
  "buddhist",
  "chinese",
  "coptic",
  "dangi",
  "ethioaa",
  "ethiopic",
  "ethiopic-amete-alem",
  "gregory",
  "hebrew",
  "indian",
  "islamic",
  "islamic-civil",
  "islamic-rgsa",
  "islamic-tbla",
  "islamic-umalqura",
  "islamicc",
  "japanese",
  "persian",
  "roc",
]);

/** IsValidDate (sec-temporal-iso8601grammar-static-semantics-isvaliddate). */
function _temporalCheckDateValid(yearText: string, year: number, month: number, day: number): void {
  if (yearText === "-000000") throw new RangeError("Temporal year -000000 is not allowed");
  if (day === 31 && (month === 2 || month === 4 || month === 6 || month === 9 || month === 11)) {
    throw new RangeError("invalid day of month in Temporal string");
  }
  if (month === 2 && day === 30) throw new RangeError("invalid day of month in Temporal string");
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (month === 2 && day === 29 && !leap) throw new RangeError("invalid day of month in Temporal string");
}

/** ParseISODateTime fraction handling: 1-9 digits padded to ms/us/ns. */
function _temporalFractionParts(frac: string | undefined): [number, number, number] {
  const padded = (frac ?? "").padEnd(9, "0");
  return [Number(padded.slice(0, 3) || "0"), Number(padded.slice(3, 6) || "0"), Number(padded.slice(6, 9) || "0")];
}

const _tPlainDateRe = new RegExp(
  `^(?:${_tDateExtSrc}|${_tDateBasicSrc})(?:[Tt ](?:${_tTimeExtSrc}|${_tTimeBasicSrc})(${_tOffsetSrc}|[Zz])?)?`,
);

/**
 * ToTemporalDate(string) → ParseISODateTime with TemporalDateTimeString[~Zoned]
 * (sec-temporal-totemporaldate / sec-temporal-parseisodatetime). The [~Zoned]
 * goal has no UTCDesignator alternative, so a `Z`/`z` suffix is a RangeError.
 */
/**
 * ToTemporalDate / ToTemporalTime / ToTemporalDuration accept only Objects
 * (property bags, handled at compile time) or Strings here; any other
 * primitive is a TypeError before parsing (e.g. PlainDate.from(19761118)).
 * Dynamic (non-literal) object bags are not supported by the minimal native
 * lowering — they also throw here, as they did before strict parsing.
 */
function _temporalRequireString(item: any, what: string): string {
  if (typeof item !== "string") {
    throw new TypeError(`${what} must be a string or property bag, not ${typeof item}`);
  }
  return item;
}

function _temporalParsePlainDate(item: any): [number, number, number] {
  const text = _temporalRequireString(item, "Temporal.PlainDate argument");
  const bracketStart = text.indexOf("[");
  const core = bracketStart < 0 ? text : text.slice(0, bracketStart);
  const suffix = bracketStart < 0 ? "" : text.slice(bracketStart);
  const match = _tPlainDateRe.exec(core);
  if (!match || match[0] !== core) throw new RangeError("invalid Temporal.PlainDate string");
  const yearText = match[1] ?? match[4]!;
  // Groups: date-ext 1-3, date-basic 4-6, time-ext 7-10, time-basic 11-14, offset/Z 15.
  const offsetOrZ = match[15];
  if (offsetOrZ === "Z" || offsetOrZ === "z") {
    throw new RangeError("UTC designator Z is not valid for Temporal.PlainDate");
  }
  _temporalValidateBrackets(suffix);
  const year = Number(yearText);
  const month = Number(match[2] ?? match[5]!);
  const day = Number(match[3] ?? match[6]!);
  _temporalCheckDateValid(yearText, year, month, day);
  // ISODateTimeWithinLimits / ISODateWithinLimits: the representable
  // PlainDate range is -271821-04-19 .. +275760-09-13 (epoch ±10^8 days).
  if (
    year < -271821 ||
    year > 275760 ||
    (year === -271821 && (month < 4 || (month === 4 && day < 19))) ||
    (year === 275760 && (month > 9 || (month === 9 && day > 13)))
  ) {
    throw new RangeError("Temporal.PlainDate is outside the representable range");
  }
  return [year, month, day];
}

function _temporalPlainDateFromStringField(item: any, field: any): number {
  return _temporalParsePlainDate(item)[_temporalTrunc(field)] ?? 0;
}

const _tPlainTimeDateTimeRe = new RegExp(
  `^(?:${_tDateExtSrc}|${_tDateBasicSrc})[Tt ](?:${_tTimeExtSrc}|${_tTimeBasicSrc})(${_tOffsetSrc}|[Zz])?$`,
);
const _tPlainTimeOnlyRe = new RegExp(`^([Tt])?(?:${_tTimeExtSrc}|${_tTimeBasicSrc})(${_tOffsetSrc}|[Zz])?$`);
// Early errors for AnnotatedTime without a TimeDesignator: the source text
// must not also parse as DateSpecMonthDay or DateSpecYearMonth.
const _tMonthDayAmbiguityRe = /^(?:--)?(?:0[1-9]|1[0-2])-?(?:0[1-9]|[12]\d|3[01])$/;
const _tYearMonthAmbiguityRe = /^(?:\d{4}|[+-]\d{6})-?(?:0[1-9]|1[0-2])$/;

/**
 * ToTemporalTime(string) → ParseTemporalTimeString with
 * TemporalTimeString ::: AnnotatedTime | AnnotatedDateTime[~Zoned, +TimeRequired]
 * (sec-temporal-iso8601grammar). Z is rejected ([~Z] / [~Zoned]); a
 * date-only string is rejected (+TimeRequired); TimeSecond 60 clamps to 59
 * (ParseISODateTime).
 */
function _temporalParsePlainTime(item: any): [number, number, number, number, number, number] {
  const text = _temporalRequireString(item, "Temporal.PlainTime argument");
  const bracketStart = text.indexOf("[");
  const core = bracketStart < 0 ? text : text.slice(0, bracketStart);
  const suffix = bracketStart < 0 ? "" : text.slice(bracketStart);
  _temporalValidateBrackets(suffix);

  let hour: string | undefined;
  let minute: string | undefined;
  let second: string | undefined;
  let frac: string | undefined;
  let offsetOrZ: string | undefined;

  const dt = _tPlainTimeDateTimeRe.exec(core);
  if (dt) {
    const yearText = dt[1] ?? dt[4]!;
    _temporalCheckDateValid(yearText, Number(yearText), Number(dt[2] ?? dt[5]!), Number(dt[3] ?? dt[6]!));
    hour = dt[7] ?? dt[11];
    minute = dt[8] ?? dt[12];
    second = dt[9] ?? dt[13];
    frac = dt[10] ?? dt[14];
    offsetOrZ = dt[15];
  } else {
    const t = _tPlainTimeOnlyRe.exec(core);
    if (!t) throw new RangeError("invalid Temporal.PlainTime string");
    const designator = t[1];
    hour = t[2] ?? t[6];
    minute = t[3] ?? t[7];
    second = t[4] ?? t[8];
    frac = t[5] ?? t[9];
    offsetOrZ = t[10];
    if (!designator) {
      const timeAndOffset = core;
      if (_tMonthDayAmbiguityRe.test(timeAndOffset) || _tYearMonthAmbiguityRe.test(timeAndOffset)) {
        throw new RangeError("ambiguous Temporal.PlainTime string");
      }
    }
  }
  if (offsetOrZ === "Z" || offsetOrZ === "z") {
    throw new RangeError("UTC designator Z is not valid for Temporal.PlainTime");
  }
  let secondNum = second === undefined ? 0 : Number(second);
  if (secondNum === 60) secondNum = 59;
  const [ms, us, ns] = _temporalFractionParts(frac);
  return [Number(hour ?? "0"), minute === undefined ? 0 : Number(minute), secondNum, ms, us, ns];
}

function _temporalPlainTimeFromStringField(item: any, field: any): number {
  return _temporalParsePlainTime(item)[_temporalTrunc(field)] ?? 0;
}

/** IsValidDuration (sec-temporal-isvalidduration). */
function _temporalIsValidDuration(values: readonly number[]): boolean {
  let sign = 0;
  for (const v of values) {
    if (!Number.isFinite(v)) return false;
    if (v < 0) {
      if (sign > 0) return false;
      sign = -1;
    } else if (v > 0) {
      if (sign < 0) return false;
      sign = 1;
    }
  }
  const TWO_32 = 4294967296;
  if (Math.abs(values[0]!) >= TWO_32 || Math.abs(values[1]!) >= TWO_32 || Math.abs(values[2]!) >= TWO_32) {
    return false;
  }
  // Normalized nanoseconds, computed exactly with BigInt per the spec NOTE.
  try {
    const big = (n: number): bigint => BigInt(n);
    const total =
      big(values[3]!) * 86400000000000n +
      big(values[4]!) * 3600000000000n +
      big(values[5]!) * 60000000000n +
      big(values[6]!) * 1000000000n +
      big(values[7]!) * 1000000n +
      big(values[8]!) * 1000n +
      big(values[9]!);
    const limit = 1000000000n * 9007199254740992n; // 10^9 * 2^53
    const abs = total < 0n ? -total : total;
    if (abs >= limit) return false;
  } catch {
    return false;
  }
  return true;
}

const _tDurationRe =
  /^([+-])?[Pp](?:(\d+)[Yy])?(?:(\d+)[Mm])?(?:(\d+)[Ww])?(?:(\d+)[Dd])?(?:([Tt])(?:(\d+)(?:[.,](\d{1,9}))?[Hh])?(?:(\d+)(?:[.,](\d{1,9}))?[Mm])?(?:(\d+)(?:[.,](\d{1,9}))?[Ss])?)?$/;

/**
 * ParseTemporalDurationString (sec-temporal-parsetemporaldurationstring).
 * The grammar requires at least one unit, a time unit after `T`, and allows
 * a fraction only on the smallest (last) present time unit. Fractional
 * hours/minutes/seconds balance into smaller units; magnitudes are floored
 * before the sign factor. The result must satisfy IsValidDuration.
 */
function _temporalParseDuration(item: any): number[] {
  const text = _temporalRequireString(item, "Temporal.Duration argument");
  const match = _tDurationRe.exec(text);
  if (!match) throw new RangeError("invalid Temporal.Duration string");
  const [, signText, years, months, weeks, days, timeDesignator, hours, fHours, minutes, fMinutes, seconds, fSeconds] =
    match;
  const hasDatePart = years !== undefined || months !== undefined || weeks !== undefined || days !== undefined;
  const hasTimePart = hours !== undefined || minutes !== undefined || seconds !== undefined;
  if (!hasDatePart && !hasTimePart) throw new RangeError("invalid Temporal.Duration string");
  if (timeDesignator !== undefined && !hasTimePart) throw new RangeError("invalid Temporal.Duration string");
  // Grammar: DurationHoursPart with a fraction admits no minutes/seconds;
  // DurationMinutesPart with a fraction admits no seconds.
  if (fHours !== undefined && (minutes !== undefined || seconds !== undefined)) {
    throw new RangeError("invalid Temporal.Duration string: fraction is only allowed on the smallest unit");
  }
  if (fMinutes !== undefined && seconds !== undefined) {
    throw new RangeError("invalid Temporal.Duration string: fraction is only allowed on the smallest unit");
  }
  const toInt = (digits: string | undefined): number => (digits === undefined || digits === "" ? 0 : Number(digits));
  const yearsMV = toInt(years);
  const monthsMV = toInt(months);
  const weeksMV = toInt(weeks);
  const daysMV = toInt(days);
  const hoursMV = toInt(hours);
  // The spec computes the fractional balancing with exact mathematical
  // values. Equivalent here: convert the single fractional part to an exact
  // integer count of nanoseconds (the division is exact because 10^scale
  // with scale <= 9 divides unit * 10^11), then distribute by integer
  // division — this matches floor(minutesMV), remainder(...)*60, etc.
  const exactFracNs = (digits: string, unitNs: bigint): number =>
    Number((BigInt(digits) * unitNs) / 10n ** BigInt(digits.length));
  let minutesMV = toInt(minutes);
  let secondsMV = seconds !== undefined ? toInt(seconds) : 0;
  let remNs = 0;
  if (fHours !== undefined) {
    let fracNs = exactFracNs(fHours, 3600000000000n);
    minutesMV = Math.floor(fracNs / 60000000000);
    fracNs %= 60000000000;
    secondsMV = Math.floor(fracNs / 1000000000);
    remNs = fracNs % 1000000000;
  } else if (fMinutes !== undefined) {
    const fracNs = exactFracNs(fMinutes, 60000000000n);
    secondsMV = Math.floor(fracNs / 1000000000);
    remNs = fracNs % 1000000000;
  } else if (fSeconds !== undefined) {
    remNs = exactFracNs(fSeconds, 1000000000n);
  }
  const millisecondsMV = Math.floor(remNs / 1000000);
  const microsecondsMV = Math.floor((remNs % 1000000) / 1000);
  const nanosecondsMV = remNs % 1000;
  const factor = signText === "-" ? -1 : 1;
  const values = [
    yearsMV * factor,
    monthsMV * factor,
    weeksMV * factor,
    daysMV * factor,
    hoursMV * factor,
    minutesMV * factor,
    secondsMV * factor,
    millisecondsMV * factor,
    microsecondsMV * factor,
    nanosecondsMV * factor,
  ];
  if (!_temporalIsValidDuration(values)) throw new RangeError("Temporal.Duration out of range");
  return values;
}

function _temporalDurationFromStringField(item: any, field: any): number {
  return _temporalParseDuration(item)[_temporalTrunc(field)] ?? 0;
}

function _temporalDurationSign(...fields: any[]): number {
  for (const field of fields) {
    const n = Number(field);
    if (n > 0) return 1;
    if (n < 0) return -1;
  }
  return 0;
}

function _temporalDurationToString(...fieldsRaw: any[]): string {
  const fields = fieldsRaw.map(_temporalTrunc);
  const sign = _temporalDurationSign(...fields) < 0 ? "-" : "";
  const abs = fields.map((field) => Math.abs(field));
  const [years, months, weeks, days, hours, minutes, seconds, milliseconds, microseconds, nanoseconds] = abs;
  let result = `${sign}P`;
  if (years) result += `${years}Y`;
  if (months) result += `${months}M`;
  if (weeks) result += `${weeks}W`;
  if (days) result += `${days}D`;
  const fraction =
    _temporalPad(milliseconds ?? 0, 3) + _temporalPad(microseconds ?? 0, 3) + _temporalPad(nanoseconds ?? 0, 3);
  const fractionTrimmed = fraction.replace(/0+$/, "");
  const secondPart = fractionTrimmed.length > 0 ? `${seconds ?? 0}.${fractionTrimmed}` : `${seconds ?? 0}`;
  const hasTime = !!hours || !!minutes || !!seconds || fractionTrimmed.length > 0;
  if (hasTime) {
    result += "T";
    if (hours) result += `${hours}H`;
    if (minutes) result += `${minutes}M`;
    if (seconds || fractionTrimmed.length > 0) result += `${secondPart}S`;
  }
  return result === `${sign}P` ? `${sign}PT0S` : result;
}

function _temporalDateFromParts(year: number, month: number, day: number): Date {
  const d = new Date(0);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCFullYear(year, month - 1, day);
  return d;
}

function _temporalDaysInMonth(year: number, month: number): number {
  return _temporalDateFromParts(year, month + 1, 0).getUTCDate();
}

function _temporalPlainDateAddField(
  yearRaw: any,
  monthRaw: any,
  dayRaw: any,
  yearsRaw: any,
  monthsRaw: any,
  weeksRaw: any,
  daysRaw: any,
  signRaw: any,
  fieldRaw: any,
): number {
  const sign = _temporalTrunc(signRaw) < 0 ? -1 : 1;
  let year = _temporalTrunc(yearRaw) + sign * _temporalTrunc(yearsRaw);
  let month = _temporalTrunc(monthRaw) + sign * _temporalTrunc(monthsRaw);
  year += Math.floor((month - 1) / 12);
  month = ((((month - 1) % 12) + 12) % 12) + 1;
  const constrainedDay = Math.min(_temporalTrunc(dayRaw), _temporalDaysInMonth(year, month));
  const date = _temporalDateFromParts(
    year,
    month,
    constrainedDay + sign * (_temporalTrunc(daysRaw) + 7 * _temporalTrunc(weeksRaw)),
  );
  const field = _temporalTrunc(fieldRaw);
  if (field === 0) return date.getUTCFullYear();
  if (field === 1) return date.getUTCMonth() + 1;
  return date.getUTCDate();
}

function _temporalPlainTimeAddField(...args: any[]): number {
  const [hour, minute, second, millisecond, microsecond, nanosecond, dh, dm, ds, dms, dus, dns, signRaw, fieldRaw] =
    args.map(_temporalTrunc);
  const sign = signRaw < 0 ? -1 : 1;
  const dayNs = 86_400_000_000_000;
  let total =
    hour * 3_600_000_000_000 +
    minute * 60_000_000_000 +
    second * 1_000_000_000 +
    millisecond * 1_000_000 +
    microsecond * 1_000 +
    nanosecond;
  total +=
    sign * (dh * 3_600_000_000_000 + dm * 60_000_000_000 + ds * 1_000_000_000 + dms * 1_000_000 + dus * 1_000 + dns);
  total = ((total % dayNs) + dayNs) % dayNs;
  const hourOut = Math.floor(total / 3_600_000_000_000);
  total %= 3_600_000_000_000;
  const minuteOut = Math.floor(total / 60_000_000_000);
  total %= 60_000_000_000;
  const secondOut = Math.floor(total / 1_000_000_000);
  total %= 1_000_000_000;
  const millisecondOut = Math.floor(total / 1_000_000);
  total %= 1_000_000;
  const microsecondOut = Math.floor(total / 1_000);
  const nanosecondOut = total % 1_000;
  return [hourOut, minuteOut, secondOut, millisecondOut, microsecondOut, nanosecondOut][_temporalTrunc(fieldRaw)] ?? 0;
}

/**
 * Keep intrinsic constructor identity inside a supplied per-test sandbox.
 * Host objects naturally expose host-realm constructors; compiled code in the
 * isolated realm resolves the corresponding bare identifier from the sandbox.
 * Only canonical host intrinsics are substituted, so user constructors pass
 * through unchanged.
 */
function _sandboxConstructorValue(value: any, key: any, globalSandbox?: Record<string, any>): any {
  if (globalSandbox && key === "constructor" && typeof value === "function") {
    const name = (value as { name?: string }).name;
    if (name && value === (globalThis as any)[name]) {
      const sandboxValue = globalSandbox[name];
      if (sandboxValue !== undefined) return sandboxValue;
    }
  }
  return value;
}

function _wrapRawCallableHostValue(
  value: any,
  exports: Record<string, Function> | undefined,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): any {
  if (!_isWasmStruct(value)) return value;
  const callable = _maybeWrapCallableUnknownArity(value, callbackState);
  return callable !== value ? callable : _wrapForHost(value, exports ?? callbackState?.getExports());
}

function _deferStringDataArg(
  value: any,
  callbackState: { getExports: () => Record<string, Function> | undefined } | undefined,
  fallback: (value: any) => any,
): any {
  // (#3903) `_isWasmStruct` first — it exits on `typeof value !== "object"`,
  // which is the case for every primitive separator/limit argument on the
  // `split`/`replace` hot path. Resolving `getExports()` up front made that
  // free check pay for a closure call on every crossing. Pure reorder: both
  // operands are side-effect-free.
  if (!_isWasmStruct(value)) return fallback(value);
  const exports = callbackState?.getExports();
  const isData = exports?.__is_data_struct as ((value: any) => number) | undefined;
  if (typeof isData === "function") {
    try {
      if (isData(value) === 1) return _wrapForHost(value, exports);
    } catch {
      /* fall through to the pre-existing coercion path */
    }
  }
  return fallback(value);
}

/** Build the live-method fallback used when raw lookup returns a JS callable. */
function _makeRawCallableInvoker(
  arity: number,
  callbackState?: { getExports: () => Record<string, Function> | undefined },
): Function {
  return function externCallRawCallable(callableValue: any, receiver: any, ...args: any[]): any {
    const exports = callbackState?.getExports();
    const callable = _maybeWrapCallableUnknownArity(callableValue, callbackState);
    if (typeof callable !== "function") throw new TypeError("value is not callable");
    const wrappedReceiver = _wrapRawCallableHostValue(receiver, exports, callbackState);
    const wrappedArgs: any[] = [];
    for (let i = 0; i < arity; i++) {
      wrappedArgs.push(_wrapRawCallableHostValue(args[i], exports, callbackState));
    }
    const result = callable.apply(wrappedReceiver, wrappedArgs);
    return result === wrappedReceiver ? receiver : _unwrapForHost(result);
  };
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
      if (Array.isArray(rawArgs)) {
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
  dynamicCode: DynamicCodePolicy = "compat",
  dynamicCodeEvaluator?: DynamicCodeEvaluator,
  getCaughtException?: () => unknown,
): Function {
  if (isBoundaryValueImportIntent(intent)) {
    return createBoundaryValueAdapter(intent, {
      object: (operation) => _createBoundaryObjectImport(operation, callbackState),
      callback: (arity) => _createBoundaryCallbackImport(arity, callbackState),
      promise: (operation) => _createBoundaryPromiseImport(operation, callbackState),
    });
  }
  const capability = resolvePlatformCapabilityImport(intent, {
    deps,
    globalSandbox,
    instanceState,
    getNodeRequire: _getNodeRequire,
    wrapWasmClosure: (value, arity, boundary) => _wrapPlatformCapabilityClosure(value, arity, boundary, callbackState),
    wrapUnknownCallable: (value) => _maybeWrapCallableUnknownArity(value, callbackState),
  });
  if (capability) return capability;
  const compatibilitySemantic = resolveCompatibilitySemanticImport(intent, {
    strictEqual: _hostStrictEqual,
    isWasmStruct: _isWasmStruct,
    toPrimitive: (value, hint) => _toPrimitiveSync(value, hint, callbackState),
    createProxy: (target, handler) => _hostProxyConstruct(target, handler, callbackState, "Proxy"),
  });
  if (compatibilitySemantic) return compatibilitySemantic;
  switch (intent.type) {
    case "caught_exception":
      return () => getCaughtException?.();
    case "string_method": {
      const method = intent.method;
      // Methods whose first argument participates in Symbol.* protocol
      // dispatch per ECMA-262 (e.g. String.prototype.replace checks
      // searchValue[@@replace] before string coercion). For these methods
      // we must NOT coerce the first arg to a primitive: wrap WasmGC structs
      // with `_wrapForHost` so the Proxy translates `arg[Symbol.replace]` →
      // `arg["@@replace"]` and invokes any user-defined method (#1443).
      // (#3903) Everything that depends only on `method` is decided ONCE here,
      // at import-resolution time, instead of on every crossing. A string
      // benchmark makes 10k-50k crossings per `run()`, so anything left in the
      // per-call body is multiplied by that. See the per-crossing breakdown in
      // plan/issues/3903-host-call-lane-string-boundary.md.
      const isSymbolDispatch = isHostStringSymbolDispatch(method);
      const usesNaNOmitSentinel = method === "includes" || method === "startsWith" || method === "endsWith";
      const isSplit = method === "split";
      const tracksLegacyRegExpState =
        method === "match" || method === "search" || method === "replace" || method === "split";
      // Coerce wasmGC struct args via ToPrimitive before passing to JS host (#983, #1128).
      // (#3903) HOISTED out of the per-call body. Allocating this arrow per
      // crossing cost ~40 ns/call in a plain build and ~490 ns/call in any
      // build that applies esbuild's `keepNames` (every function literal then
      // pays an `Object.defineProperty(fn, "name", …)` at allocation) — which
      // is exactly the transform `tsx` applies to the benchmark harness.
      const coerce = (v: any): any => {
        if (v != null && typeof v === "object" && _isWasmStruct(v)) {
          const prim = _toPrimitive(v, "string", callbackState);
          if (prim !== undefined) return prim;
          // Fall through to host ToPrimitive — throws TypeError if no conversion (#1128)
          return _hostToPrimitive(v, "string", callbackState);
        }
        return v;
      };
      const fixedPredicate = makeHostStringPredicateAdapter(method, coerce);
      if (fixedPredicate) return fixedPredicate;
      // Also hoisted (#3903): was re-allocated per call as the `.map` callback
      // of the Symbol-dispatch branch below.
      const deferDataArg = (value: any): any => _deferStringDataArg(value, callbackState, coerce);
      return (s: any, ...a: any[]) => {
        const recv = coerce(s);
        let args: any[];
        if (isSymbolDispatch && a.length > 0) {
          // Wrap (don't coerce) the first arg so JS's String.prototype.<method>
          // can dispatch on Symbol.<method> via the wasm-struct proxy (#1443).
          const first = a[0];
          let wrapped: any;
          const primReroute = _rerouteStringSymbolMethodPrimitive(method, first);
          if (primReroute !== undefined) {
            // #3095 — per spec (ECMA-262 String.prototype.{match,matchAll,
            // search,replace,replaceAll,split}), when the search value is NOT
            // an Object, its Symbol.<method> property must NOT be observably
            // accessed. The JS host (Node) still walks the primitive's wrapper
            // prototype via GetMethod, so a user-defined `Number.prototype[
            // Symbol.match]` etc. getter would be triggered. Replicate the
            // "regexp is not an Object" branch by pre-building the RegExp the
            // spec would create: match/matchAll/search treat the primitive as a
            // *pattern*, replace/replaceAll/split as a *literal string*. Passing
            // a real RegExp makes Node dispatch on RegExp.prototype's built-in
            // Symbol methods, never touching the primitive's prototype. Only
            // engaged when the Symbol property actually exists on the primitive
            // (checked via `in`, which does not trigger getters), so the common
            // no-override case is byte-identical to before.
            wrapped = primReroute;
          } else if (first != null && typeof first === "object" && _isWasmStruct(first)) {
            wrapped = _wrapForHost(first, callbackState?.getExports?.());
          } else {
            wrapped = first;
          }
          // (#3903) Same result as `[wrapped, ...a.slice(1).map(…)]`, without
          // the three intermediate arrays (slice + map + spread target).
          const n = a.length;
          args = new Array(n);
          args[0] = wrapped;
          for (let i = 1; i < n; i++) args[i] = deferDataArg(a[i]);
        } else {
          // (#3903) `a.map(coerce)` allocates an extra array and goes through
          // Array.prototype.map's generic element visit; a plain loop over the
          // rest array is the same observable behaviour (coerce never throws
          // for holes — a rest array has none).
          const n = a.length;
          args = new Array(n);
          for (let i = 0; i < n; i++) args[i] = coerce(a[i]);
        }
        // #3761 — split uses -1 for omission/2^32 - 1; explicit NaN remains ToUint32(NaN) = 0.
        // #2002 — includes/startsWith/endsWith use NaN as the "position not
        // provided" sentinel for the same reason: a trailing NaN means the
        // arg was omitted, so drop it and let the JS method apply its spec
        // default (0 for includes/startsWith, length for endsWith) instead of
        // ToInteger(NaN)=0.
        if (args.length >= 2 && (isSplit || usesNaNOmitSentinel)) {
          const last = args[args.length - 1];
          const omitLast = isSplit ? last === -1 : typeof last === "number" && Number.isNaN(last);
          if (omitLast) {
            args.pop();
          }
        }
        const recvStr = typeof recv === "string" ? recv : String(recv);
        // (#3903) Arity-dispatched invocation. Each arm is the *same*
        // `recvStr[method](…)` member call the spread form performed — the
        // property load stays dynamic (a monkey-patched String.prototype method
        // is still honoured) and no `Function.prototype.call` is involved, so
        // there is no new observable surface. It just avoids building the
        // spread's argument list, which was ~17 ns of every crossing.
        let ret: any;
        switch (args.length) {
          case 0:
            ret = (recvStr as any)[method]();
            break;
          case 1:
            ret = (recvStr as any)[method](args[0]);
            break;
          case 2:
            ret = (recvStr as any)[method](args[0], args[1]);
            break;
          case 3:
            ret = (recvStr as any)[method](args[0], args[1], args[2]);
            break;
          default:
            ret = (recvStr as any)[method](...args);
            break;
        }
        // (#1333) Annex B — String.prototype.{match,search,replace,split,matchAll}
        // invokes RegExpBuiltinExec under the hood, which updates the legacy slots.
        if (tracksLegacyRegExpState && args[0] instanceof RegExp) {
          try {
            const re = args[0] as RegExp;
            const probe = new RegExp(re.source, re.flags.replace(/[gy]/g, ""));
            const m2 = probe.exec(recvStr);
            if (m2) _updateLegacyRegExpState(recvStr, m2, instanceState?.legacyRegExpState);
          } catch {
            // ignore — best-effort
          }
        }
        return ret;
      };
    }
    case "extern_class": {
      if (intent.className === "Document" && intent.action === "get" && intent.member === "body") {
        return (self: any) => self.body;
      }
      if (intent.className === "Document" && intent.action === "method" && intent.member === "createElement") {
        return (self: any, tagName: any, options?: any) =>
          options == null ? self.createElement(tagName) : self.createElement(tagName, options);
      }
      if (intent.action === "method" && intent.member === "addEventListener") {
        return (self: any, type: any, listener: any, options?: any) =>
          options == null ? self.addEventListener(type, listener) : self.addEventListener(type, listener, options);
      }
      if (intent.action === "new") {
        // (#1568) `__new_BigInt(v)` / `__new_Symbol(v)` — Object(bigint) /
        // Object(symbol) auto-boxing (§7.1.18 ToObject, Table 13). BigInt and
        // Symbol are NOT constructors, so `new BigInt(v)` throws; box via the
        // spec's literal `Object(v)`, yielding an object (typeof "object") whose
        // valueOf() returns the underlying primitive. This handler must precede
        // the generic `builtinCtors` lookup below — neither name is a member of
        // that map (they aren't constructors), so without this early return the
        // resolver throws "No dependency provided for extern class BigInt".
        // (Regressed when the extern_class block moved during a runtime refactor;
        // restored here — see tests/issue-1568.test.ts.)
        if (intent.className === "BigInt" || intent.className === "Symbol") {
          return (v: any): any => Object(v);
        }
        // Test262Error is a simple Error subclass used by the test262 harness
        // (#4394) Was a fresh `class Test262Error extends Error` minted per
        // resolver call, so two modules — or two imports in one module — saw
        // different constructor identities. Bound to the hoisted single class.
        const Test262Error = test262Host.HostTest262Error;
        const builtinCtors: Record<string, Function> = {
          Number,
          Boolean,
          String,
          // (#1721) Root constructors so `class Sub extends Object {}` /
          // `extends Function {}` route through `__new_Object()` /
          // `__new_Function()` instead of throwing "No dependency provided for
          // extern class". The instance's [[Prototype]] is then set to
          // `Sub.prototype` by `__set_subclass_proto`.
          Object,
          Function,
          // (#1366b) Array and Promise added so `class Sub extends Array {}` /
          // `class Sub extends Promise {}` route through `__new_Array(arg)` /
          // `__new_Promise(executor)` host imports. Without these entries the
          // resolver throws "No dependency provided for extern class 'Array'".
          Array,
          Promise,
          Map,
          Set,
          WeakMap,
          WeakSet,
          WeakRef,
          RegExp,
          ArrayBuffer,
          DataView,
          Date,
          // (#1455) TypedArray constructors for subclass-builtins host
          // construction (`class Sub extends Float32Array {}` etc.).
          Int8Array,
          Uint8Array,
          Uint8ClampedArray,
          Int16Array,
          Uint16Array,
          Int32Array,
          Uint32Array,
          Float32Array,
          Float64Array,
          ...(typeof BigInt64Array !== "undefined" ? { BigInt64Array } : {}),
          ...(typeof BigUint64Array !== "undefined" ? { BigUint64Array } : {}),
          Error,
          TypeError,
          RangeError,
          SyntaxError,
          URIError,
          EvalError,
          ReferenceError,
          AggregateError,
          Test262Error,
          // (#1455) SharedArrayBuffer for `class Sub extends SharedArrayBuffer {}`
          ...(typeof SharedArrayBuffer !== "undefined" ? { SharedArrayBuffer } : {}),
          // TC39 Explicit Resource Management (stage 3 / Node.js 22+)
          ...(typeof DisposableStack !== "undefined" ? { DisposableStack } : {}),
          ...(typeof AsyncDisposableStack !== "undefined" ? { AsyncDisposableStack } : {}),
          ...(typeof SuppressedError !== "undefined" ? { SuppressedError } : {}),
          // Intl constructors (#1070)
          ...(typeof Intl !== "undefined" && typeof Intl.ListFormat !== "undefined"
            ? { ListFormat: Intl.ListFormat }
            : {}),
          ...(typeof Intl !== "undefined" && typeof Intl.NumberFormat !== "undefined"
            ? { NumberFormat: Intl.NumberFormat }
            : {}),
          // (#1792) node:url — WHATWG URL / URLSearchParams globals (Node 18+ /
          // every browser). Registered as extern-class host constructors so
          // `new URL(...)` / `new URLSearchParams(...)` bind to the real host
          // constructor; property/method reads flow through __extern_get /
          // __extern_method_call.
          ...(typeof URL !== "undefined" ? { URL } : {}),
          ...(typeof URLSearchParams !== "undefined" ? { URLSearchParams } : {}),
          ...getWebHostConstructors(),
        };
        let Ctor = deps?.[intent.className] ?? builtinCtors[intent.className];
        // #1044 — Resolve via namespace path (e.g. require('http').Server)
        if (!Ctor && intent.namespacePath && intent.namespacePath.length > 0) {
          Ctor = _resolveNamespacedClass(intent.namespacePath, intent.className, deps);
        }
        if (!Ctor)
          return (...args: any[]) => {
            throw new Error(`No dependency provided for extern class "${intent.className}"`);
          };
        // Strip trailing null/undefined args — the compiler pads missing
        // optional args with ref.null.extern, but constructors like RegExp
        // reject explicit null (e.g. new RegExp("x", null) throws).
        // EXCEPT for String/Number/Boolean: new String(undefined) must produce "undefined",
        // not "" (which new String() with no args produces).
        const isWrapperCtor =
          intent.className === "String" || intent.className === "Number" || intent.className === "Boolean";
        // (#1438) Keyed-collection constructors take an iterable — Map and
        // WeakMap take `[key, value]` pairs, Set/WeakSet take values. When the
        // wasm caller passes a vec struct (or tuple struct), native V8 doesn't
        // know how to iterate it. Materialize the first arg via
        // _materializeIterable so the engine sees a real JS array. Inner
        // wasm tuple structs are converted recursively below.
        const isIterableCtor =
          intent.className === "Map" ||
          intent.className === "Set" ||
          intent.className === "WeakMap" ||
          intent.className === "WeakSet";
        // (#1455) DataView / TypedArray constructors expect a real JS
        // ArrayBuffer, but our compiler emits `new ArrayBuffer(N)` as a
        // wasm-vec struct. When the first arg is a wasm-vec carrying byte
        // data, convert it to a real ArrayBuffer using the exported
        // `__dv_byte_*` accessors before invoking the host constructor.
        const isBufferConsumer =
          intent.className === "DataView" ||
          intent.className === "Int8Array" ||
          intent.className === "Uint8Array" ||
          intent.className === "Uint8ClampedArray" ||
          intent.className === "Int16Array" ||
          intent.className === "Uint16Array" ||
          intent.className === "Int32Array" ||
          intent.className === "Uint32Array" ||
          intent.className === "Float32Array" ||
          intent.className === "Float64Array" ||
          intent.className === "BigInt64Array" ||
          intent.className === "BigUint64Array";
        // (#1716) Constructors that run ToPrimitive / ToString on their
        // arguments (rather than consuming them as iterables / buffers / struct
        // identities). When a WasmGC struct is passed as such an arg, V8's
        // native `new Ctor(struct)` invokes ToString/ToPrimitive on the opaque
        // struct and throws "Cannot convert object to primitive value" — it
        // can't reach the compiled valueOf / toString / @@toPrimitive. Coerce
        // these struct args through `_hostToPrimitive` (the #1319 OrdinaryToPrimitive
        // walker) FIRST so the user methods run. RegExp/Date/String use a "string"/
        // "default" ToString-shaped coercion; Number uses "number".
        // NB: `Boolean` is deliberately excluded — `new Boolean(obj)` applies
        // ToBoolean (every object is truthy), NOT ToPrimitive, so coercing the
        // struct to a primitive could flip the result. Iterable/buffer consumers
        // are excluded too — they need the struct identity, not a primitive.
        const coercesArgsToPrimitive =
          intent.className === "RegExp" ||
          intent.className === "Date" ||
          intent.className === "String" ||
          intent.className === "Number";
        const argCoercionHint: "number" | "string" | "default" =
          intent.className === "Number" ? "number" : intent.className === "Date" ? "default" : "string";
        // (#2637 B1) The Promise constructor consumes its first argument as an
        // executor callback (`new Promise((resolve, reject) => …)`). For a
        // `class Sub extends Promise { constructor(a) { super(a); … } }`, the
        // user constructor body forwards the executor to this `__new_Promise`
        // host import as a BOXED wasm closure (an opaque struct, not a raw JS
        // function). V8's `Promise` ctor then throws "Promise resolver
        // [object Object] is not a function". Unwrap the executor to a
        // host-callable here, mirroring the `Promise_new` host shim
        // (`new Promise(_maybeWrapCallable(executor, 2, callbackState))`).
        // `_maybeWrapCallable` is a no-op for a value already a raw function
        // (edge case a) and for null/undefined, so genuine `new Promise(fn)` and
        // the no-arg `super()` form are unaffected; only the `Promise` parent is
        // touched (edge case b: `extends Array/Map/...` unchanged); the
        // host-only construction path leaves standalone untouched (edge case c,
        // #1941).
        const isPromiseExecutorCtor = intent.className === "Promise";
        return (...args: any[]) => {
          if (isPromiseExecutorCtor && args.length > 0) {
            args[0] = _maybeWrapCallable(args[0], 2, callbackState);
          }
          if (!isWrapperCtor) {
            let len = args.length;
            while (len > 0 && args[len - 1] == null) len--;
            args = args.slice(0, len);
          }
          if (coercesArgsToPrimitive && args.length > 0) {
            for (let i = 0; i < args.length; i++) {
              const a = args[i];
              if (a != null && typeof a === "object" && _isWasmStruct(a)) {
                // Throws TypeError per §7.1.1 step 6 if no chain yields a
                // primitive — the spec-correct outcome here too.
                args[i] = _hostToPrimitive(a, argCoercionHint, callbackState);
              }
            }
          }
          if (isIterableCtor && args.length > 0 && args[0] != null) {
            const exports = callbackState?.getExports();
            // Convert outer wasm vec (or tuple struct) into a JS array of
            // converted entries. For Map/WeakMap each entry must itself be
            // an iterable (tuple → [k, v] array).
            args[0] = _convertIterableForHost(args[0], exports);
          } else if (isBufferConsumer && args.length > 0 && _isWasmStruct(args[0])) {
            const exports = callbackState?.getExports();
            const dvLen = exports?.__dv_byte_len as ((v: any) => number) | undefined;
            const dvGet = exports?.__dv_byte_get as ((v: any, i: number) => number) | undefined;
            if (typeof dvLen === "function" && typeof dvGet === "function") {
              const bufLen = dvLen(args[0]);
              if (bufLen >= 0) {
                const bytes = new Uint8Array(bufLen);
                for (let i = 0; i < bufLen; i++) bytes[i] = dvGet(args[0], i) & 0xff;
                args[0] = bytes.buffer;
              }
            }
          }
          return new Ctor(...args);
        };
      }
      // (#2671) `RegExp.lastIndex` is a value-preserving data slot: §22.2.7.2
      // RegExpBuiltinExec (and @@match/@@replace/@@split/@@search via RegExpExec)
      // read it as `ToLength(? Get(R, "lastIndex"))` at exec time — the spec
      // stores whatever was assigned verbatim. A WasmGC-struct value
      // (`r.lastIndex = {valueOf(){…}}`) is opaque to V8's ToNumber ("Cannot
      // convert object to primitive value"), so on WRITE store a struct behind a
      // lastIndex coercion shim (`_makeLastIndexShim`) whose ToPrimitive bridges
      // to the struct via `_hostToPrimitive` — native exec / @@replace can then
      // ToLength it, firing valueOf once and surfacing a *throwing* valueOf as
      // the program's own error. On READ unwrap the shim back to the raw struct
      // so an explicit `r.lastIndex` read sees the SAME object the program stored
      // (`assert.sameValue(r.lastIndex, obj)`). Primitive numbers pass through
      // untouched.
      if (intent.className === "RegExp" && intent.member === "lastIndex") {
        if (intent.action === "get") {
          return (self: any) => {
            const stored = _safeGet(self, "lastIndex");
            const raw = stored != null && typeof stored === "object" ? _lastIndexShimRaw.get(stored) : undefined;
            return raw !== undefined ? raw : stored;
          };
        }
        if (intent.action === "set") {
          return (self: any, v: any) => {
            if (!_isWasmStruct(v)) {
              _safeSet(self, "lastIndex", v);
            } else {
              // (#3084) ALWAYS defer, protocol call or not — §22.2.6.8/11/14
              // store the value verbatim; only the empty-match advance reads it
              // (ToLength → shim fires). See the _makeLastIndexShim doc block.
              _safeSet(self, "lastIndex", _makeLastIndexShim(v, callbackState));
            }
          };
        }
      }
      // (#4150) `extern_class` get/set has a STATIC string member name and a
      // receiver that is almost always an ordinary host object (a DOM node, a
      // host record). For that shape `_safeGet`/`_safeSet` reduce to a plain
      // property access — every other branch in them is keyed on the receiver
      // being a WasmGC struct or the key needing ToPropertyKey coercion, and
      // neither can happen here. Taking the direct access first skips the whole
      // preamble; the helpers still run for struct receivers, host-proxy views,
      // sidecar-only properties and failed writes, so behaviour is unchanged.
      // Measured: `_safeSet` alone was ~2/3 of `dom/modify-text`'s runtime.
      if (intent.action === "get") {
        const member = intent.member!;
        return (self: any) => {
          if (self !== null && typeof self === "object" && !_isWasmStruct(self)) {
            // Mirrors `_safeGet`'s own non-struct tail: native read first, and
            // only `undefined` falls through to the sidecar lookup.
            const direct = self[member];
            if (direct !== undefined) return direct;
          }
          return _safeGet(self, member);
        };
      }
      if (intent.action === "set") {
        const member = intent.member!;
        return (self: any, v: any) => {
          // `_unwrapForHost(self) === self` is the explicit form of "the helper's
          // proxy-unwrap step would be a no-op", so a `_wrapForHost` view still
          // takes the full path and writes through to its raw vec.
          if (
            self !== null &&
            typeof self === "object" &&
            !_isWasmStruct(self) &&
            !_isWasmStruct(v) &&
            _unwrapForHost(self) === self
          ) {
            try {
              self[member] = v;
              return;
            } catch {
              // Frozen/sealed/accessor/proxy-trap failure — the helper owns the
              // sidecar fallback and the rethrow rules.
            }
          }
          _safeSet(self, member, v);
        };
      }
      const m = intent.member!;
      // (#1352) Set's new methods (union, intersection, difference,
      // symmetricDifference, isSubsetOf, isSupersetOf, isDisjointFrom) accept
      // ANY set-like argument (object with `size` + `has(v)` + `keys()`),
      // not just Set instances. When the argument is a wasm struct, native
      // V8 Set.prototype.union and friends call `Get(arg, "size")` etc. and
      // see undefined because wasmGC structs are opaque to JS — that's the
      // ~101 test262 fails in built-ins/Set/prototype/*. Bridge by wrapping
      // wasm-struct args in `_wrapForHost`, which exposes sidecar fields as
      // proxy properties so the native GetSetRecord works against any
      // set-like shape (per ES2025 §24.2.5.x).
      if (
        intent.className === "Set" &&
        (m === "union" ||
          m === "intersection" ||
          m === "difference" ||
          m === "symmetricDifference" ||
          m === "isSubsetOf" ||
          m === "isSupersetOf" ||
          m === "isDisjointFrom")
      ) {
        return (self: any, ...args: any[]) => {
          if (self == null) return undefined;
          const exports = callbackState?.getExports();
          // (#1627) A wasm-struct set-like argument is presented through a
          // GetSetRecord-faithful adapter rather than the raw `_wrapForHost`
          // proxy: the proxy masks every struct field as a callable, defeating
          // native GetSetRecord's `has`/`keys` IsCallable throws and `size`
          // ToNumber coercion. The adapter exposes only size/has/keys, with
          // non-closure objects kept non-callable so native validation fires.
          const wrappedArgs = args.map((a) =>
            _isWasmStruct(a) ? _setLikeRecordForHost(a, exports, callbackState) : a,
          );
          const fn = self[m] ?? _sidecarGet(self, m);
          if (typeof fn === "function") return fn.call(self, ...wrappedArgs);
          return undefined;
        };
      }
      // (#1438) Map.prototype.forEach / Set.prototype.forEach take a
      // callback and an optional thisArg. The callback can be a wasm
      // closure struct (no `[[Call]]`); wrap it as a JS Function so the
      // native engine invokes it as `cb(value, key, map)` (3 args for
      // Map, `cb(value, value, set)` for Set). Without this, native V8
      // throws "object is not a function".
      if ((intent.className === "Map" || intent.className === "Set") && m === "forEach") {
        return (self: any, ...args: any[]) => {
          if (self == null) return undefined;
          const exports = callbackState?.getExports();
          let cb = args[0];
          if (cb != null && _isWasmStruct(cb)) {
            const wrapped = _wrapWasmClosure(cb, 3, callbackState);
            if (wrapped) cb = wrapped;
          }
          const thisArg = args.length > 1 ? args[1] : undefined;
          const fn = self[m] ?? _sidecarGet(self, m);
          if (typeof fn === "function") return fn.call(self, cb, thisArg);
          return undefined;
        };
      }
      // (#1794) node:events EventEmitter listener-registering methods — the
      // listener argument may be a WasmGC closure struct (no [[Call]]); Node
      // validates `typeof listener === "function"` and throws
      // ERR_INVALID_ARG_TYPE on the raw struct. Wrap it as a JS callable via
      // the identity-CACHED dynamic bridge (`_wasmClosureDynamicWrapperCache`),
      // so `on(h)` and `off(h)` receive the SAME wrapper and removeListener
      // identity-matches. Direct arrow args already crossed via
      // `__make_callback`; this covers variable-held closures.
      if (
        intent.className === "EventEmitter" &&
        (m === "on" ||
          m === "once" ||
          m === "off" ||
          m === "addListener" ||
          m === "removeListener" ||
          m === "prependListener" ||
          m === "prependOnceListener")
      ) {
        return (self: any, ...args: any[]) => {
          if (self == null) return undefined;
          const wrappedArgs = args.map((a) => _maybeWrapCallableUnknownArity(a, callbackState));
          const fn = self[m] ?? _sidecarGet(self, m);
          if (typeof fn === "function") return fn.call(self, ...wrappedArgs);
          return undefined;
        };
      }
      // (#4150) The generic method shim is the DOM lane's hot path — 5,000 of
      // `dom/set-attributes`'s 7,000 crossings land here — and its rest
      // parameter allocated a fresh args array on every one of them. #3903
      // removed the inner spread but left the rest param and the `.apply`.
      // The wasm import signature fixes the argument count exactly
      // (`paramCount` counts `self` plus the method's own parameters), so build
      // a fixed-signature closure for the common arities and route the args
      // through the SAME body. `genericMethodCall` below is that shared body,
      // unchanged in behaviour: null check, sidecar fallback, wasm-struct arg
      // wrapping, the #3903 arity switch, and the #1333 legacy-RegExp hook.
      const invokeMethod = (self: any, args: any[]): any => {
        if (self == null) return undefined;
        // Method call — check sidecar if direct method missing
        const fn = self[m] ?? _sidecarGet(self, m);
        if (typeof fn === "function") {
          // (#1332) Wrap wasmGC-struct args via _wrapForHost so a native
          // prototype method (e.g. RegExp.prototype.exec/test) can ToString
          // or read properties off an opaque wasm struct argument. Mirrors
          // the Set-method path above and __extern_method_call.
          // (#3903) `args.some(a => _isWasmStruct(a))` allocated a closure on
          // every crossing; a plain loop is the same predicate. This shim is
          // the DOM lane's hot path — `dom/create-elements` makes 2,000
          // `extern_class` crossings per `run()` against a mock whose whole
          // body is one allocation, so per-crossing overhead is essentially
          // the entire measurement there.
          const exports = callbackState?.getExports();
          let hasStructArg = false;
          for (let i = 0; i < args.length; i++) {
            if (_isWasmStruct(args[i])) {
              hasStructArg = true;
              break;
            }
          }
          let callArgs = args;
          if (hasStructArg) {
            callArgs = new Array(args.length);
            for (let i = 0; i < args.length; i++) {
              callArgs[i] = _isWasmStruct(args[i]) ? _wrapForHost(args[i], exports) : args[i];
            }
          }
          // (#3903) Arity switch instead of `fn.call(self, ...callArgs)` — same
          // `Function.prototype.call` invocation, without materialising the
          // spread's argument list on every crossing.
          let ret: any;
          switch (callArgs.length) {
            case 0:
              ret = fn.call(self);
              break;
            case 1:
              ret = fn.call(self, callArgs[0]);
              break;
            case 2:
              ret = fn.call(self, callArgs[0], callArgs[1]);
              break;
            case 3:
              ret = fn.call(self, callArgs[0], callArgs[1], callArgs[2]);
              break;
            default:
              ret = fn.call(self, ...callArgs);
              break;
          }
          // (#1333) Annex B §22.2.7.2 — RegExpBuiltinExec updates the legacy
          // static slots after every successful match. Hook exec/test on a
          // RegExp receiver with a string first arg.
          if ((m === "exec" || m === "test") && self instanceof RegExp && typeof callArgs[0] === "string") {
            const input = callArgs[0] as string;
            if (m === "exec" && ret != null) {
              _updateLegacyRegExpState(input, ret as RegExpExecArray, instanceState?.legacyRegExpState);
            } else if (m === "test" && ret === true) {
              // .test() also updates the slots per spec. Re-run exec on a
              // non-sticky/non-global clone so we don't perturb self.lastIndex.
              try {
                const clone = new RegExp(self.source, self.flags.replace(/[gy]/g, ""));
                const m2 = clone.exec(input);
                if (m2) _updateLegacyRegExpState(input, m2, instanceState?.legacyRegExpState);
              } catch {
                // best-effort — bad source/flags shouldn't break .test()
              }
            }
          }
          return ret;
        }
        return undefined;
      };
      // Fixed-signature wrappers over the SAME body. `paramCount` includes
      // `self`, so a 0-arg method has paramCount 1.
      //
      // These do not merely forward into `invokeMethod` — boxing the arguments
      // into an array literal to do that measured WORSE than the rest form
      // (dom/set-attributes 2.54x -> 3.31x), because the literal escapes into a
      // non-inlined callee and becomes a real heap allocation where V8 had been
      // sinking the rest array. Instead each arm inlines the ordinary case —
      // resolve the method, confirm no argument is a WasmGC struct, call it
      // directly — and hands anything unusual to the shared body, which still
      // owns the sidecar fallback, the `_wrapForHost` argument wrapping and the
      // #1333 legacy-RegExp hook. The array is then allocated only on the paths
      // that were already doing extra work.
      const needsLegacyRegExpHook = m === "exec" || m === "test";
      if (!needsLegacyRegExpHook) {
        switch (paramCount) {
          case 1:
            return (self: any) => {
              if (self != null) {
                const fn = self[m];
                if (typeof fn === "function") return fn.call(self);
              }
              return invokeMethod(self, []);
            };
          case 2:
            return (self: any, a: any) => {
              if (self != null && !_isWasmStruct(a)) {
                const fn = self[m];
                if (typeof fn === "function") return fn.call(self, a);
              }
              return invokeMethod(self, [a]);
            };
          case 3:
            return (self: any, a: any, b: any) => {
              if (self != null && !_isWasmStruct(a) && !_isWasmStruct(b)) {
                const fn = self[m];
                if (typeof fn === "function") return fn.call(self, a, b);
              }
              return invokeMethod(self, [a, b]);
            };
          case 4:
            return (self: any, a: any, b: any, c: any) => {
              if (self != null && !_isWasmStruct(a) && !_isWasmStruct(b) && !_isWasmStruct(c)) {
                const fn = self[m];
                if (typeof fn === "function") return fn.call(self, a, b, c);
              }
              return invokeMethod(self, [a, b, c]);
            };
        }
      }
      return (self: any, ...args: any[]) => invokeMethod(self, args);
    }
    case "builtin": {
      const name = intent.name;
      const fixedMethodArity = fixedExternMethodCallArity(name);
      if (fixedMethodArity !== undefined) {
        const canonical = resolveImport(
          { type: "builtin", name: "__extern_method_call" },
          deps,
          callbackState,
          globalSandbox,
          instanceState,
          undefined,
          dynamicCode,
          dynamicCodeEvaluator,
        );
        return makeFixedExternMethodCall(fixedMethodArity, canonical);
      }
      // #1644/#2678: spec BigInt-to-i64 and host Date.parse for wasm:js-string externrefs.
      if (name === "__date_parse_host") return (s: any): number => Date.parse(s);
      if (name === "__bigint_ctor") {
        return (v: any): bigint => {
          // ToPrimitive(value, number). WasmGC structs / proxies need our
          // host ToPrimitive; plain host primitives/objects use the native one.
          let prim = v;
          if (v != null && typeof v === "object") {
            const p = _toPrimitive(v, "number", callbackState);
            prim = p !== undefined ? p : _hostToPrimitive(v, "number", callbackState);
          }
          if (typeof prim === "number") {
            // NumberToBigInt: RangeError unless a safe integer.
            if (!Number.isInteger(prim)) {
              throw new RangeError(
                "The number " + prim + " cannot be converted to a BigInt because it is not an integer",
              );
            }
            return BigInt(prim);
          }
          if (typeof prim === "symbol") {
            throw new TypeError("Cannot convert a Symbol value to a BigInt");
          }
          // bigint → identity; boolean → 0n/1n; string → StringToBigInt
          // (BigInt() throws SyntaxError on a malformed numeric string).
          return BigInt(prim);
        };
      }
      // (#2846 follow-up) Same §21.2.1.1 semantics as __bigint_ctor, but
      // returned as externref so arbitrary-width host BigInts are not narrowed
      // through Wasm i64 before entering a nullable/dynamic value carrier.
      if (name === "__bigint_ctor_ref") {
        return (v: any): bigint => {
          let prim = v;
          if (v != null && typeof v === "object") {
            const p = _toPrimitive(v, "number", callbackState);
            prim = p !== undefined ? p : _hostToPrimitive(v, "number", callbackState);
          }
          if (typeof prim === "number") {
            if (!Number.isInteger(prim)) {
              throw new RangeError(
                "The number " + prim + " cannot be converted to a BigInt because it is not an integer",
              );
            }
            return BigInt(prim);
          }
          if (typeof prim === "symbol") {
            throw new TypeError("Cannot convert a Symbol value to a BigInt");
          }
          return BigInt(prim);
        };
      }
      // Batched string concat: __concat_3, __concat_4, ... (#958)
      if (name.startsWith("__concat_")) {
        return (...args: any[]) => {
          // Coerce each arg; wasmGC structs route through _toPrimitive (#983).
          // User-thrown errors from valueOf/toString propagate.
          // #1342 — Symbol primitives must throw TypeError on implicit string
          // coercion per spec §13.5 (template literals, `+` operator). Explicit
          // `String(sym)` and `sym.toString()` still work — those don't go
          // through this helper.
          let out = "";
          for (const a of args) {
            if (a == null) {
              out += String(a);
            } else if (typeof a === "string") {
              out += a;
            } else if (typeof a === "symbol") {
              throw new TypeError("Cannot convert a Symbol value to a string");
            } else if (typeof a === "object" && _isWasmStruct(a)) {
              const prim = _toPrimitive(a, "default", callbackState);
              if (prim !== undefined) {
                if (typeof prim === "symbol") {
                  throw new TypeError("Cannot convert a Symbol value to a string");
                }
                out += String(prim);
              } else {
                // Fall through to host ToPrimitive — throws TypeError if no conversion (#1128)
                const prim2 = _hostToPrimitive(a, "default", callbackState);
                if (typeof prim2 === "symbol") {
                  throw new TypeError("Cannot convert a Symbol value to a string");
                }
                out += String(prim2);
              }
            } else {
              out += String(a);
            }
          }
          return out;
        };
      }
      if (name === "number_toString") return (v: number) => String(v);
      // #1321: 2-arg variant for `(value).toString(radix)`. The 1-arg
      // `number_toString` only handled base 10; the codegen previously dropped
      // the radix on the floor, silently producing decimal output for any radix.
      if (name === "number_toString_radix") return (v: number, r: number) => v.toString(r);
      // (#1644 Slice D) BigInt.prototype.toString — bigint flows as i64 across
      // the boundary thanks to JS-BigInt-integration. Default radix is 10; the
      // 2-arg variant accepts a radix (2-36) and propagates RangeError per
      // §21.2.3.4. Codegen validates radix range before calling.
      if (name === "bigint_toString") return (v: bigint) => v.toString();
      if (name === "bigint_toString_radix") return (v: bigint, r: number) => v.toString(r);
      if (name === "number_toFixed") return (v: number, d: number) => v.toFixed(d);
      // #1321: NaN-as-no-arg sentinel (matches `number_toExponential` pattern).
      // Compiled `(123.456).toPrecision()` (no args) pushes f64.const NaN on the
      // stack rather than crashing Wasm validation by calling the 2-arg import
      // with only one operand.
      // (#49) Per ECMA-262 §21.1.3.3 / §21.1.3.5, the spec returns
      // Number::toString(x) BEFORE the fractionDigits/precision range check
      // when `x` is non-finite. V8's native toExponential/toPrecision do
      // the range check first and throw RangeError, which makes
      // `(NaN).toExponential(Infinity)` throw instead of returning "NaN"
      // (test262 toExponential/{nan,infinity}.js, toPrecision/{nan,infinity,
      // tointeger-precision,undefined-precision-arg}.js). Mirror the spec
      // ordering by short-circuiting the non-finite case to String(v).
      // Also: the NaN-as-no-arg sentinel only applies when x IS finite —
      // for non-finite x we use String(v) regardless of the second arg.
      if (name === "number_toPrecision")
        return (v: number, p: number) => {
          if (!Number.isFinite(v)) return String(v);
          return isNaN(p) ? String(v) : v.toPrecision(p);
        };
      if (name === "number_toExponential")
        return (v: number, d: number) => {
          if (!Number.isFinite(v)) return String(v);
          return isNaN(d) ? v.toExponential() : v.toExponential(d);
        };
      if (name === "JSON_stringify")
        return (v: any, replacer: any, space: any) => {
          const exports = callbackState?.getExports();
          // #1636 Slice A — normalise replacer into a discriminated record.
          // Function replacers (including Wasm closures) and property-list
          // arrays go through the live-value walk so the holder identity,
          // toJSON, and cycle detection are observable per §25.5.2.4.
          const rep = _normaliseJsonReplacer(replacer, callbackState);
          // Coerce space to primitive — handles WasmGC structs and JS objects
          // with WasmGC closure valueOf/toString (#1090).
          let sp: any = space;
          if (sp != null && typeof sp === "object") {
            const prim = _toPrimitive(sp, "number", callbackState);
            if (prim !== undefined) {
              sp = prim;
            } else {
              try {
                sp = _hostToPrimitive(sp, "number", callbackState);
              } catch {
                /* let downstream handle the coercion error */
              }
            }
          }
          if (sp == null || (typeof sp === "number" && isNaN(sp))) sp = undefined;
          // §25.5.2.1 step 6-7 — derive the gap string.
          let gap = "";
          if (typeof sp === "number") {
            const n = Math.min(10, Math.floor(sp));
            if (n > 0) gap = " ".repeat(n);
          } else if (typeof sp === "string") {
            gap = sp.length <= 10 ? sp : sp.substring(0, 10);
          }
          // Fast path: no function replacer, no property-list filter, and
          // no plain-object input → defer to host JSON.stringify on the
          // flattened value. Preserves the currently-passing cases and the
          // existing perf characteristic for the common case.
          if (rep.kind === "none") {
            // #1636 Slice B — if any reachable value has a callable `toJSON`,
            // route through the live walk so §25.5.2.4 step 2 fires; the
            // flatten path would drop the method before host JSON.stringify
            // sees it.
            if (!_hasReachableToJSON(v, exports, new Set())) {
              // (#2671) Pass a fresh path-scoped `seen` set so a circular
              // structure raises a TypeError (§25.5.2.5/6 step 1) instead of a
              // host stack-overflow RangeError.
              const plain = _wasmToPlain(v, exports, new Set());
              return JSON.stringify(plain, undefined, sp);
            }
          }
          // Live walk per §25.5.2.4. The synthetic wrapper holds the root
          // value under the empty-string key (step 8 of §25.5.2.1).
          const wrapper: any = { "": v };
          return _serializeJSONProperty("", wrapper, rep, gap, "", new Set(), callbackState);
        };
      if (name === "JSON_parse")
        return (s: any, reviver?: any) => {
          // #2013 — §25.5.1 JSON.parse(text, reviver). Parse first, then if a
          // callable reviver is supplied apply InternalizeJSONProperty so the
          // callback observes (key, value) per holder and its return value
          // substitutes (or, when `undefined`, deletes) each property.
          const unfiltered = JSON.parse(s);
          if (!_isCallableReviver(reviver, callbackState)) return unfiltered;
          // §25.5.1 steps 7-10: root holder is { "": unfiltered }.
          const root: any = { "": unfiltered };
          return _internalizeJSONProperty(root, "", reviver, callbackState);
        };
      if (name === "__extern_direct_eval") {
        const bindingByCell = new WeakMap<object, DynamicCodeBinding>();
        return (
          src: any,
          _globalObject: any,
          _thisArg: any,
          _activationState: any,
          activationNames: any,
          activationSlots: any,
          lexicalNames: any,
          lexicalSlots: any,
          outerNames: any,
          outerSlots: any,
          callerStrict: number,
          _mappedParamNames: any,
        ): any => {
          if (typeof src !== "string") return src;
          if (dynamicCode === "deny") throw new EvalError("dynamic code generation is disabled by the host");
          if (dynamicCode !== "evaluator" || !dynamicCodeEvaluator) {
            throw new EvalError(
              'reified host direct eval requires buildImports(..., { dynamicCode: "evaluator", dynamicCodeEvaluator })',
            );
          }
          const exports = callbackState?.getExports();
          const vecLen = exports?.__runtime_eval_vec_len;
          const vecGet = exports?.__runtime_eval_vec_get;
          const cellGet = exports?.__runtime_eval_cell_get;
          const cellSet = exports?.__runtime_eval_cell_set;
          if (
            typeof vecLen !== "function" ||
            typeof vecGet !== "function" ||
            typeof cellGet !== "function" ||
            typeof cellSet !== "function"
          ) {
            throw new EvalError("reified host direct-eval bridge exports are unavailable on the AOT instance");
          }
          const bindings: DynamicCodeBinding[] = [];
          const appendLayer = (names: any, slots: any): void => {
            if (names == null || slots == null) return;
            const count = vecLen(names) >>> 0;
            if (count !== vecLen(slots) >>> 0) {
              throw new EvalError("reified host direct-eval binding vectors are misaligned");
            }
            for (let index = 0; index < count; index++) {
              const bindingName = String(vecGet(names, index));
              if (bindingName === "__js2wasm_eval_nonglobal__") continue;
              const cell = vecGet(slots, index);
              if ((typeof cell !== "object" || cell === null) && typeof cell !== "function") {
                throw new EvalError(`reified host direct-eval binding '${bindingName}' has no canonical cell`);
              }
              let binding = bindingByCell.get(cell as object);
              if (!binding) {
                binding = {
                  name: bindingName,
                  get: () => cellGet(cell),
                  set: (value: unknown) => cellSet(cell, value),
                };
                bindingByCell.set(cell as object, binding);
              }
              bindings.push(binding);
            }
          };

          // Environment lookup is inner-to-outer. Build the list outer-first;
          // the evaluator's later duplicate wins for a lexical shadow.
          appendLayer(outerNames, outerSlots);
          appendLayer(activationNames, activationSlots);
          appendLayer(lexicalNames, lexicalSlots);
          return dynamicCodeEvaluator.evaluate(src, {
            direct: true,
            strict: callerStrict !== 0,
            bindings,
          });
        };
      }
      if (name === "__extern_eval") {
        if (dynamicCode === "deny") {
          return (src: any) => {
            if (typeof src !== "string") return src;
            throw new EvalError("dynamic code generation is disabled by the host");
          };
        }
        if (dynamicCode === "native") {
          return (src: any) => {
            if (typeof src !== "string") return src;
            // A Wasm host-import boundary cannot carry the caller's lexical
            // environment, so this is necessarily indirect eval. When the
            // module is hosted in a Worker, the global below is the Worker
            // realm rather than the main page/process realm.
            // biome-ignore lint/style/noCommaOperator: (0, eval) forces indirect eval
            // biome-ignore lint/security/noGlobalEval: explicit opt-in host-eval engine
            return (0, eval)(src);
          };
        }
        if (dynamicCode === "evaluator") {
          return (src: any, isDirect: number = 0) => {
            if (typeof src !== "string") return src;
            if (!dynamicCodeEvaluator) throw new EvalError("no dynamic-code evaluator was supplied by the host");
            return dynamicCodeEvaluator.evaluate(src, { direct: isDirect !== 0 });
          };
        }
        // #1164: dynamic eval via Wasm module compilation.  The primary
        // path compiles the eval string through js2wasm and instantiates
        // it as a fresh Wasm module via the JS Wasm API — no `(0, eval)`,
        // no JS global leakage, CSP-compatible (`wasm-unsafe-eval` only).
        //
        // We retain the legacy `(0, eval)(...)` host path as a fallback
        // for sources the Wasm pipeline cannot yet compile (e.g. test262
        // harness-rewritten code containing identifiers that resolve to
        // host-only state, or syntax constructs js2wasm doesn't support).
        // The fallback is gated on JS host availability; in standalone /
        // WASI mode neither path works and the import is simply absent.
        const wasmEvalShim = createEvalShim({});
        return (src: any, _isDirect: number = 0) => {
          // Spec: if input is not a string, return it unchanged.
          if (typeof src !== "string") return src;
          // Try the Wasm-module path first.  Compile failures, instantiation
          // failures, and "import not provided" errors fall through to the
          // host-eval fallback so test262 harness-aware eval keeps working.
          try {
            return wasmEvalShim(src, _isDirect);
          } catch (e: any) {
            // SyntaxError from the Wasm-module path means js2wasm couldn't
            // compile the source as JS at all — propagate it (real JS would
            // throw too).  Other errors (ReferenceError from missing imports,
            // generic Error from instantiation) fall back to host eval.
            const isSyntaxError = e instanceof SyntaxError;
            if (isSyntaxError) {
              // If the host-eval fallback can compile it, prefer that result;
              // js2wasm is more strict than V8/SpiderMonkey on some forms.
              return _legacyHostEval(src);
            }
            return _legacyHostEval(src);
          }
        };

        // Legacy host-eval fallback (#1006 + #1073 harness shims).  Used when
        // the Wasm-module path can't handle the source — e.g. it references
        // wasm-compiled harness identifiers that aren't in scope of a fresh
        // Wasm module compilation.
        function _legacyHostEval(src: string): any {
          // Indirect eval — runs in global scope. Direct-eval scope access
          // is unreachable through a host import boundary; #1006 scopes this
          // explicitly to JS-host mode, standalone mode traps on instantiation.
          //
          // #1073: Prepend JS-side shims for test262 harness identifiers that
          // wrapTest text-rewrites into eval'd strings. Without these, the
          // eval'd code raises ReferenceError for wasm-compiled identifiers
          // like assert_sameValue, assert_throws, etc.
          const harnessIds = [
            "assert_sameValue",
            "assert_notSameValue",
            "assert_true",
            "assert_throws",
            "assert_throwsAsync",
            "isSameValue",
            "assert_sameValue_str",
            "assert_notSameValue_str",
            "assert_sameValue_bool",
            "assert_notSameValue_bool",
            "assert_compareArray",
            "compareArray",
            "__fail",
            "__assert_count",
            "fnGlobalObject",
            "verifyProperty",
            "verifyEnumerable",
            "verifyNotEnumerable",
            "verifyWritable",
            "verifyNotWritable",
            "verifyConfigurable",
            "verifyNotConfigurable",
            "Test262Error",
            "$DONE",
          ];
          // Strip TypeScript annotations that wrapTest injects (e.g. `as number`,
          // `as any`) — the eval'd code runs as plain JS and rejects TS syntax.
          const jsSrc = src.replace(/\bas\s+number\b/g, "").replace(/\bas\s+any\b/g, "");
          // Raw Test262 `assert(...)` / `assert.<knownMember>(...)` calls
          // survive some wrapTest paths unchanged.  Detect executable,
          // unshadowed calls from syntax rather than treating comment/string
          // text (or a locally-bound `assert`) as a harness dependency.
          // Measurement kill switch: preserves the prior runtime behavior for
          // same-population attribution runs without changing the classifier's
          // syntax contract or any non-harness dynamic-code policy.
          const rawAssertShimEnabled = rawTest262AssertShimEnabled();
          const needsShim =
            (rawAssertShimEnabled && hasActiveUnshadowedTest262Assert(jsSrc)) ||
            harnessIds.some((id) => jsSrc.includes(id));
          // biome-ignore lint/style/noCommaOperator: (0, eval) forces indirect eval (global scope) per §19.2.1.1
          // biome-ignore lint/security/noGlobalEval: intentional test262 runtime eval for harness compatibility
          if (!needsShim) return (0, eval)(jsSrc);

          // Build a JS-side harness that mirrors the wasm-compiled preamble.
          // State (__fail, __assert_count) is local to this eval — if an
          // assertion fails, we throw so the outer wasm try/catch observes it.
          //
          // Test262Error extends Error so `String(e)` and `e.message` yield a
          // readable string when the throw propagates back through the wasm
          // boundary; a plain constructor serializes to "[object Object]".
          // We also provide `assert` as an object with dot-notation methods,
          // so any harness call that slips through wrapTest's rewrites (e.g.
          // inside backslash-continued string literals, template literals, or
          // nested eval) still resolves instead of raising ReferenceError.
          const shim = `\
var __fail = 0, __assert_count = 1;
function Test262Error(msg) {
  var e = new Error(msg || '');
  e.name = 'Test262Error';
  if (Object.setPrototypeOf) Object.setPrototypeOf(e, Test262Error.prototype);
  return e;
}
Test262Error.prototype = Object.create(Error.prototype);
Test262Error.prototype.constructor = Test262Error;
Test262Error.prototype.name = 'Test262Error';
Test262Error.prototype.toString = function() { return 'Test262Error: ' + (this.message || ''); };
function isSameValue(a, b) {
  if (a === b) { if (a !== 0) return true; return 1/a === 1/b; }
  return a !== a && b !== b;
}
function assert_sameValue(a, b) {
  __assert_count++;
  if (!isSameValue(a, b)) { if (!__fail) __fail = __assert_count; }
}
function assert_notSameValue(a, b) {
  __assert_count++;
  if (isSameValue(a, b)) { if (!__fail) __fail = __assert_count; }
}
function assert_true(v) {
  __assert_count++;
  if (!v) { if (!__fail) __fail = __assert_count; }
}
function assert_throws(fn) {
  __assert_count++;
  try { fn(); } catch(e) { return; }
  if (!__fail) __fail = __assert_count;
}
function assert_throwsAsync(fn) {
  __assert_count++;
  try { fn(); } catch(e) { return; }
  if (!__fail) __fail = __assert_count;
}
function assert_sameValue_str(a, b) {
  __assert_count++;
  if (a !== b) { if (!__fail) __fail = __assert_count; }
}
function assert_notSameValue_str(a, b) {
  __assert_count++;
  if (a === b) { if (!__fail) __fail = __assert_count; }
}
function assert_sameValue_bool(a, b) {
  __assert_count++;
  if (a !== b) { if (!__fail) __fail = __assert_count; }
}
function assert_notSameValue_bool(a, b) {
  __assert_count++;
  if (a === b) { if (!__fail) __fail = __assert_count; }
}
function compareArray(a, b) {
  if (a.length !== b.length) return false;
  for (var i = 0; i < a.length; i++) { if (a[i] !== b[i]) return false; }
  return true;
}
function assert_compareArray(a, b) {
  __assert_count++;
  if (!compareArray(a, b)) { if (!__fail) __fail = __assert_count; }
}
function fnGlobalObject() { return globalThis; }
function verifyProperty() {}
function verifyEnumerable() {}
function verifyNotEnumerable() {}
function verifyWritable() {}
function verifyNotWritable() {}
function verifyConfigurable() {}
function verifyNotConfigurable() {}
function $DONE(err) {
  __assert_count++;
  if (err) { if (!__fail) __fail = __assert_count; }
}
var assert = function(v, msg) {
  __assert_count++;
  if (!v) { if (!__fail) __fail = __assert_count; }
};
assert.sameValue = assert_sameValue;
assert.notSameValue = assert_notSameValue;
assert.throws = function(ErrorType, fn) {
  __assert_count++;
  try { fn(); } catch(e) { return; }
  if (!__fail) __fail = __assert_count;
};
assert.throwsAsync = assert.throws;
assert.compareArray = assert_compareArray;
assert._isSameValue = isSameValue;
`;
          const wrapped =
            shim + jsSrc + `;\nif (__fail) throw new Test262Error('eval harness assertion ' + __fail + ' failed');`;
          // biome-ignore lint/style/noCommaOperator: (0, eval) forces indirect eval (global scope) per §19.2.1.1
          // biome-ignore lint/security/noGlobalEval: intentional test262 runtime eval for harness compatibility
          return (0, eval)(wrapped);
        }
      }
      if (name === "__extern_new_function") {
        if (dynamicCode === "deny") {
          return () => {
            throw new EvalError("dynamic code generation is disabled by the host");
          };
        }
        if (dynamicCode === "native") {
          // biome-ignore lint/security/noGlobalEval: explicit opt-in host-eval engine
          return (params: any, body: any) => new Function(String(params ?? ""), String(body ?? ""));
        }
        if (dynamicCode === "evaluator") {
          return (params: any, body: any) => {
            if (!dynamicCodeEvaluator) throw new EvalError("no dynamic-code evaluator was supplied by the host");
            return dynamicCodeEvaluator.createFunction(String(params ?? ""), String(body ?? ""));
          };
        }
        // (#2960) Dynamic `new Function(params, body)` — meta-circular
        // construction via js2wasm's own compiler (see createNewFunctionShim).
        // Returns a real JS-callable function the parent module can invoke.
        // Falls back to native `Function(params, body)` when the js2wasm
        // pipeline can't compile the body (mirrors __extern_eval's host
        // fallback — keeps harness-shaped dynamic functions working).
        const wasmNewFnShim = createNewFunctionShim({});
        return (params: any, body: any) => {
          // (#3058) A body carrying a `class` expression/declaration can never
          // round-trip through the meta-circular Wasm path usefully: the child
          // module's compiled class value is an opaque struct the PARENT module
          // cannot construct (its dyn-new tag dispatch only knows its own class
          // tags), and a class extending a host builtin (the test262
          // resizableArrayBufferUtils `subClass` shape — `return class MyUint8Array
          // extends Uint8Array {}`) additionally loses the builtin's statics and
          // [[Construct]] semantics. The host `Function` fallback below produces a
          // genuine host class that interops through the extern paths, so route
          // class-carrying bodies there directly.
          const bodyStr = String(body ?? "");
          if (!/\bclass\b/.test(bodyStr)) {
            try {
              return wasmNewFnShim(params, bodyStr);
            } catch {
              /* fall through to the host constructor */
            }
          }
          // biome-ignore lint/security/noGlobalEval: intentional test262 runtime new Function
          return new Function(String(params ?? ""), bodyStr);
        };
      }
      if (name === "__extern_get")
        return (obj: any, key: any) => {
          // (#2743 a) A registered arguments object is an ordinary Object whose
          // `[[Prototype]]` is %Object.prototype%. The vec is opaque to the
          // host, so resolve the inherited members it would otherwise miss:
          //   - `.constructor` → %Object%;
          //   - `hasOwnProperty` → a vec-aware predicate (the opaque struct
          //     hides the own `length`/`callee`/index keys from the host MOP).
          // `length` and the numeric indices stay on the existing vec path
          // (they fall through below).
          if (obj != null && typeof obj === "object" && _argumentsObjects.has(obj)) {
            if (key === "constructor") return Object;
            if (key === "hasOwnProperty") return (k: any) => _argumentsHasOwn(obj, k);
          }
          if (obj != null && typeof obj === "object") {
            try {
              if (Object.getPrototypeOf(obj) !== null && key in Object(obj)) {
                const v = obj[key];
                // (#3097) Exit-boundary un-marshal: a canonical host
                // ArrayBuffer (minted at the construct bridge for a compiled
                // buffer struct) presents to COMPILED code as the original vec
                // struct — `sample.buffer === buffer` identity holds, and
                // re-crossing (`new TA2(sample.buffer)`) canonicalizes to the
                // SAME host buffer.
                if (v instanceof ArrayBuffer) {
                  const rawVec = _abHostBufferReverse.get(v);
                  if (rawVec !== undefined) return rawVec;
                }
                return v;
              }
            } catch (e) {
              // #2180/#2617 — a revoked-proxy TypeError, OR any exception from a
              // tracked user Proxy's get trap (abrupt completion), must propagate
              // — not be swallowed by the struct-getter fallback below.
              _rethrowIfProxyOrRevoked(e, obj);
              /* otherwise fall through to the generic path */
            }
          }
          const val = _safeGet(obj, key, callbackState);
          if (val !== undefined) return val;
          // (#1712) `<fn>.prototype` on a Wasm closure struct: auto-vivify an
          // identity-stable real JS object in the closure's sidecar so
          // prototype-method writes, Object.defineProperties, and
          // `var pp = P.prototype` aliasing all see one live object.
          if (key === "prototype") {
            const proto = _getOrVivifyFnPrototype(obj, callbackState);
            if (proto !== undefined) return proto;
          }
          // Try struct getter exports as fallback for WasmGC opaque fields
          if (obj == null || typeof obj !== "object") return undefined;
          try {
            if (Object.getPrototypeOf(obj) !== null) return undefined;
          } catch {
            return undefined;
          }
          if (_isWasmStruct(obj)) {
            const sc = _wasmStructProps.get(obj);
            const descs = _wasmPropDescs.get(obj);
            const flags = descs?.get(_normalizeDescKey(key));
            const owns = typeof key === "string" && _structHasOwnFieldName(obj, key, callbackState?.getExports());
            if (wsh.masksField(sc, key, flags, owns, _SC_ACCESSOR)) return undefined;
          }
          if (_isWasmStruct(obj) && typeof key === "string") {
            // A delete tombstone outranks the immutable backing field (#2179).
            const tomb = _wasmStructDeletedKeys.get(obj);
            if (tomb && tomb.has(key)) return undefined;
            const exports = callbackState?.getExports();
            const getter = exports?.[`__sget_${key}`];
            const fieldValue = wsh.readField(getter, obj, _structOwnFieldStatus(obj, key, exports));
            if (fieldValue !== wsh.NO_GENERATED_FIELD) return fieldValue;
            // Generic `.byteLength` on an ArrayBuffer/DataView byte vec (#3097).
            if (key === "byteLength") {
              const bl = _byteVecByteLength(obj, exports);
              if (bl !== undefined) return bl;
            }
            // Compiled-AB max/resizable semantics use __ab_max_len (#3058).
            if (key === "maxByteLength" || key === "resizable") {
              const bl = _byteVecByteLength(obj, exports);
              if (bl !== undefined) {
                const ml = _abMaxByteLength(obj, exports);
                if (key === "resizable") return ml >= 0;
                if (_detachedBuffers.has(obj) || _sidecarGet(obj, "__detached__")) return 0;
                return ml >= 0 ? ml : bl;
              }
            }
            // The resize value is deliberately non-constructible (#3058).
            if (key === "resize") {
              const bl = _byteVecByteLength(obj, exports);
              if (bl !== undefined) {
                return (newLength: any) => {
                  _abResizeStruct(obj, newLength, exports);
                  return undefined;
                };
              }
            }
            const fields = key === "constructor" ? _getStructFieldNames(obj, callbackState?.getExports()) : null;
            if (key === "constructor" && wsh.ordinaryFields(fields)) return Object;
          }
          return undefined;
        };
      // (#1712) Synthesized fnctor constructors register each instance →
      // constructor-closure link so instance property misses can resolve
      // through the closure's vivified `.prototype` object.
      if (name === "__register_fnctor_instance")
        return (inst: any, ctor: any) => {
          if (_canBeWeakKey(inst) && ctor != null) _fnctorInstanceCtor.set(inst, ctor);
        };
      // (#2743 a) Mark a compiled `arguments` vec as an ordinary Object so the
      // MOP hooks (`__getPrototypeOf` / `__extern_get` / `__hasOwnProperty`)
      // link it to %Object.prototype% and resolve `.constructor` → %Object%.
      // Emitted right after the vec `struct.new` (host-mode only).
      if (name === "__register_arguments")
        return (vec: any) => {
          if (_canBeWeakKey(vec)) _argumentsObjects.add(vec);
        };
      // (#2743 b) `%Array.prototype.values%` — the value of
      // `arguments[Symbol.iterator]` and `[][Symbol.iterator]` (§10.4.4.6 /
      // §10.4.4.7). Returning the host intrinsic gives both sites the same
      // identity (`[][Symbol.iterator] === Array.prototype.values`), which is
      // what the conformance tests compare. Used by the vec computed-get when
      // the key is a `Symbol.iterator` (host-mode only).
      if (name === "__array_proto_values") return () => Array.prototype.values;
      if (name === "__extern_set")
        return (obj: any, key: any, val: any) => {
          // (#860) When a Wasm closure struct is stored as a property value
          // on an extern host object, the host has no [[Call]] for the
          // struct — `p1.then = fn; Promise.race([p1])` traps with
          // "object is not a function". Wrap it via __call_fn_<arity> so
          // host-driven invocation reaches the closure body.
          // OrdinaryToPrimitive methods have a fixed zero-argument call shape.
          // Prefer the exact dispatcher so a method-only object literal does
          // not depend on the broader unknown-arity export family being live.
          let wrappedVal =
            key === "valueOf" || key === "toString"
              ? _maybeWrapCallable(val, 0, callbackState)
              : _maybeWrapCallableUnknownArity(val, callbackState);
          // (#3051) `regexp.exec = fn` override: the native RegExp protocol
          // (@@replace/@@split/@@match/@@search) calls this and reads the
          // returned match-result object via Get + ToXxx. A compiled result
          // object literal is an opaque WasmGC struct, so wrap the return in a
          // host proxy for the spec coercions to observe its fields.
          // (Slice 3) Guard widened from `obj instanceof RegExp` to any object:
          // the @@split species protocol drives `exec` on FAKE-regexp plain
          // objects (`splitter = Construct(C_species, …)` returning
          // `{ exec, get/set lastIndex }` — a host plain object under #1239),
          // whose exec result needs the identical marshalling.
          if (typeof wrappedVal === "function" && key === "exec" && obj !== null && typeof obj === "object") {
            wrappedVal = _wrapExecReturnForHost(wrappedVal, callbackState);
          }
          _safeSet(obj, key, wrappedVal, undefined, callbackState);
        };
      // (#2017) Strict-mode property write — identical to `__extern_set` except a
      // [[Set]] failure (getter-only accessor / non-writable / non-extensible)
      // throws a catchable TypeError (§10.1.9). ESM module code is always strict,
      // so the compiler routes user `obj.k = v` assignments here; the host-import
      // exception bridge (lastCaughtException + the compiled catch_all) makes the
      // throw catchable by the user's try/catch.
      if (name === "__extern_set_strict")
        return (obj: any, key: any, val: any) => {
          let wrappedVal =
            key === "valueOf" || key === "toString"
              ? _maybeWrapCallable(val, 0, callbackState)
              : _maybeWrapCallableUnknownArity(val, callbackState);
          // (#3051) See __extern_set: wrap a `regexp.exec` override's return so
          // the native RegExp protocol can read the compiled result object.
          // (Slice 3) Widened to any object receiver — see __extern_set.
          if (typeof wrappedVal === "function" && key === "exec" && obj !== null && typeof obj === "object") {
            wrappedVal = _wrapExecReturnForHost(wrappedVal, callbackState);
          }
          _safeSet(obj, key, wrappedVal, undefined, callbackState, /* strict */ true);
        };
      if (name === "__extern_length") {
        // Helper: coerce length value to number (#1090) — handles nested WasmGC
        // structs with valueOf/toString that need ToPrimitive dispatch.
        // Applies spec ToLength (§7.1.20): NaN → 0, negative → 0, clamp to
        // [0, 2^53-1] (Number.MAX_SAFE_INTEGER). Older callers used i32 indices
        // with `i32.trunc_sat_f64_s`, which saturates 2^53-1 to INT32_MAX —
        // safe behaviour for that path. Newer callers (#1360 array-like
        // search loop) use f64 indices to walk lengths up to MAX_SAFE_INTEGER
        // without truncation.
        // (#3903) Both helpers HOISTED out of the per-call body: `mixed/csv-parse`
        // makes 21,000 `__extern_length` crossings per `run()`, and each one was
        // allocating these two closures before doing any work.
        const toLength = (n: number): number => {
          if (Number.isNaN(n)) return 0;
          if (!Number.isFinite(n)) return n > 0 ? 0x1fffffffffffff : 0; // 2^53-1
          const i = Math.trunc(n);
          if (i <= 0) return 0;
          return Math.min(i, 0x1fffffffffffff); // 2^53-1
        };
        const coerceLen = (v: any): number => {
          if (v == null) return 0;
          if (typeof v === "number") return v;
          if (typeof v === "string") return Number(v);
          if (typeof v === "object") {
            // Try our ToPrimitive for WasmGC structs (#1090)
            const prim = _toPrimitive(v, "number", callbackState);
            if (prim !== undefined) return Number(prim);
            try {
              const prim2 = _hostToPrimitive(v, "number", callbackState);
              return Number(prim2);
            } catch {
              /* fall through */
            }
            return Number(v);
          }
          return Number(v);
        };
        return (obj: any) => {
          if (obj == null || Array.isArray(obj)) return obj == null ? 0 : obj.length;
          // Reading .length on an opaque wasmGC struct throws — resolve through
          // the #1629-safe own-descriptor reader (#983 sidecar + vec live length
          // + shape-gated struct field), then the inherited chain.
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            // (#3201) Own `length` via _readOwnDescriptor — NOT a raw
            // `__sget_length` try/catch probe. The raw probe was the #1629
            // anti-pattern and produced a REAL miss here: on a fnctor instance
            // struct whose shape happens to cast-succeed for some registered
            // `__sget_length` getter, the probe "succeeds" reading a
            // zero-initialized unrelated slot and returns own length 0, which
            // SHADOWS the inherited `length` on the ctor prototype
            // (`Con.prototype = { length: 2 }; new Con()` — the
            // indexOf/15.4.4.14-2-* array-like `.call` cluster). The
            // descriptor reader serves the vec live length (step 0), sidecar
            // values (step 1), and genuine struct `length` fields shape-gated
            // via _getStructFieldNames (step 3), so every previously-correct
            // own read stays served.
            const own = _readOwnDescriptor(obj, "length", exports);
            if (own) return toLength(coerceLen(own.get ? own.get.call(obj) : own.value));
            // (#3139) Inherited `length` through the fnctor instance→ctor
            // prototype chain (§7.3.2 Get is prototype-inclusive). The classic
            // shape: `foo.prototype = new Array(1,2,3); var f = new foo();
            // Array.prototype.every.call(f, cb)` — the compiled array-generic
            // loop reads the receiver's length via THIS import, and the live
            // length lives on the Array-valued prototype (the walk's vec arm
            // serves it). Own reads above always shadow. Requires the #3138
            // call-site instance→ctor registration to have linked the instance.
            const pd = _fnctorProtoLookup(obj, "length", exports);
            if (pd) return toLength(coerceLen(pd.get ? pd.get.call(obj) : pd.value));
            return 0;
          }
          const len = obj.length;
          if (len !== undefined) return toLength(coerceLen(len));
          const sc = _sidecarGet(obj, "length");
          if (sc !== undefined) return toLength(coerceLen(sc));
          // Try struct getter export for WasmGC structs with a 'length' field
          const exports = callbackState?.getExports();
          const getter = exports?.__sget_length;
          if (typeof getter === "function") return toLength(coerceLen(getter(obj))) ?? 0;
          return 0;
        };
      }
      // __extern_get_idx: numeric index access bypassing the well-known symbol ID
      // check in _safeGet. Needed for array-like loops where i can be 1-12 and
      // _safeGet would otherwise interpret the number as a Symbol ID.
      // Also uses __sget_N struct getter exports to access WasmGC struct fields.
      if (name === "__extern_get_idx")
        return (obj: any, idx: number): any => {
          if (obj == null) return undefined;
          // Direct numeric index (works for real JS arrays and array-likes)
          const v = obj[idx];
          if (v !== undefined) return v;
          // Check sidecar with numeric key
          const sv = _sidecarGet(obj, idx);
          if (sv !== undefined) return sv;
          // Also try string key
          const strKey = String(idx);
          const vs = obj[strKey];
          if (vs !== undefined) return vs;
          const svs = _sidecarGet(obj, strKey);
          if (svs !== undefined) return svs;
          // (#2580 B-acc) Accessor descriptor defined via Object.defineProperty
          // on this index (e.g. `defineProperty(o, "1", {get})`). The descriptor
          // lives in the struct-prop sidecar (`__get_<idx>`) or the symbol/accessor
          // map; INVOKE the getter per §6.2.5.5 (`Get` runs `[[Get]]`). A
          // setter-only accessor has no getter → §6.2.5.5 returns undefined, which
          // the index-loop reads as a *present* element holding undefined (its
          // HasProperty is true via __extern_has_idx below). Route through _safeGet,
          // which already performs the `__get_<key>` / `_wasmStructAccessors`
          // invocation with the receiver bound.
          if (_isWasmStruct(obj)) {
            const wasmSc = _wasmStructProps.get(obj);
            if (wasmSc && (`__get_${strKey}` in wasmSc || `__set_${strKey}` in wasmSc)) {
              return _safeGet(obj, strKey, callbackState);
            }
          }
          // Try struct getter export __sget_N (for WasmGC struct fields like "0", "1", etc.)
          // (#3200) Shape-gated via _readOwnDescriptor: `__sget_<k>` is a
          // ref.test dispatch chain that answers null — or a zero-initialized
          // slot on a structurally-colliding shape — WITHOUT trapping when the
          // receiver's own shape lacks the field. Returning that raw probe
          // result here masked INHERITED indices served by the fnctor /
          // Object.prototype walks below (the map/filter/forEach `-c-i-*`
          // array-like families). `_readOwnDescriptor` consults the field-name
          // registry (#1589A discipline) so only a genuinely-own field answers.
          const exports = callbackState?.getExports();
          if (_isWasmStruct(obj)) {
            const od = _readOwnDescriptor(obj, strKey, exports);
            if (od) return od.get ? od.get.call(obj) : od.value;
          } else {
            const getter = exports?.[`__sget_${strKey}`];
            if (typeof getter === "function") return getter(obj);
          }
          // (#3139) Inherited index through the fnctor instance→ctor prototype
          // chain (`foo.prototype = new Array(11,22,33); new foo()[1]` → 22).
          // Sits BEFORE the Object.prototype extended-index table below because
          // the receiver's own [[Prototype]] chain shadows %Object.prototype%.
          if (_isWasmStruct(obj)) {
            const pd = _fnctorProtoLookup(obj, strKey, exports);
            if (pd) return pd.get ? pd.get.call(obj) : pd.value;
          }
          // (#2580 M3 B-protoextend) Inherited indexed data/accessor on the
          // Object.prototype chain. Reached only after own fields + sidecar +
          // own accessor descriptors miss — so a real array / $Vec / receiver
          // with its own element never gets here. `Get` (§7.3.2) walks the
          // proto chain; an array-like plain-object receiver inherits
          // `Object.prototype[i]` written by the test (`Object.prototype[0]=v`).
          if (_protoIndexHas(idx)) return _protoIndexGet(idx);
          return undefined;
        };
      // __extern_has_idx: HasProperty(O, ToString(idx)) for array-like callback
      // loops. Spec §23.1.3.X uses HasProperty to skip holes (e.g. Array.prototype
      // .filter.call({length:"2",1:11}, cb) must not visit index 0).
      //
      // Mirrors __extern_get_idx's lookup paths. _safeSet re-maps numeric keys
      // 1-14 onto well-known symbol sidecar entries, so checking plain `idx in obj`
      // misses index values in that range — must also consult the symbol-keyed
      // sidecar and the wasm struct getter exports.
      if (name === "__extern_has_idx")
        return (obj: any, idx: number): number => {
          if (obj == null) return 0;
          const strKey = String(idx);
          try {
            if (idx in obj) return 1;
          } catch {
            /* opaque struct */
          }
          try {
            if (strKey in obj) return 1;
          } catch {
            /* opaque struct */
          }
          if (_sidecarGet(obj, idx) !== undefined) return 1;
          if (_sidecarGet(obj, strKey) !== undefined) return 1;
          // (#2580 B-acc) Accessor-descriptor presence. A property defined via
          // `Object.defineProperty(o, "<idx>", {get/set})` is PRESENT for
          // HasProperty (§7.3.12) regardless of whether `Get` yields a value — a
          // setter-only accessor has no readable value, so `_sidecarGet` above is
          // undefined, yet the property exists and the generic-method loop MUST
          // visit it. The descriptor's get/set live in the struct-prop sidecar
          // (`__get_<idx>` / `__set_<idx>`) or, for symbol keys, in
          // `_wasmStructAccessors` (not reachable by a numeric index, so only the
          // string-keyed sidecar matters here).
          {
            const wasmSc = _wasmStructProps.get(obj);
            if (wasmSc && (`__get_${strKey}` in wasmSc || `__set_${strKey}` in wasmSc)) return 1;
          }
          // _safeSet routes numeric keys 1-15 onto Symbol.<wellKnown> sidecar
          // entries. Reverse that mapping so index 1-15 values remain visible.
          // #1830 — range covers every id in `_symbolIdToKeys` (15 = @@matchAll).
          if (idx >= 1 && idx <= 15) {
            const symKeys = _symbolIdToKeys.get(idx);
            if (symKeys) {
              if (_sidecarGet(obj, symKeys.sym) !== undefined) return 1;
              if (_sidecarGet(obj, symKeys.wasm) !== undefined) return 1;
            }
          }
          const exports = callbackState?.getExports();
          if (typeof exports?.[`__sget_${strKey}`] === "function") {
            try {
              // (#1589A) HasProperty (spec §7.3.12) is true for any own
              // property regardless of value — including null/undefined.
              // (#3200) BUT "the getter returned at all" is NOT proof of
              // ownness: `__sget_<k>` is a ref.test dispatch chain that
              // NEVER traps — it answers null (or a zero-initialized slot on
              // a structurally-colliding shape) for a receiver whose own
              // shape lacks the field. The old unconditional `return 1` made
              // HasProperty answer true for EVERY struct whenever any shape
              // in the module had the field — visiting holes/inherited-only
              // indices as own. Gate on _readOwnDescriptor (field-name
              // registry, #1589A discipline); a miss falls through to the
              // prototype-chain arms below.
              if (_isWasmStruct(obj)) {
                if (_readOwnDescriptor(obj, strKey, exports) !== undefined) return 1;
              } else if (exports[`__sget_${strKey}`](obj) !== undefined) {
                return 1;
              }
            } catch {
              /* getter not defined for this struct variant — fall through */
            }
          }
          // (#3139) Inherited index through the fnctor instance→ctor prototype
          // chain (HasProperty §7.3.12 is prototype-inclusive). Before the
          // Object.prototype table for the same shadowing reason as get_idx.
          if (_isWasmStruct(obj) && _fnctorProtoLookup(obj, strKey, exports) !== undefined) return 1;
          // (#2580 M3 B-protoextend) Inherited index on the Object.prototype
          // chain. HasProperty (§7.3.12) walks `[[Prototype]]`; an array-like
          // plain-object receiver inherits `Object.prototype[i]`. Presence is
          // value-independent, so this also visits an inherited slot holding
          // `undefined`. Reached only after every own / sidecar / accessor
          // probe misses, so it cannot mask an own hole.
          if (_protoIndexHas(idx)) return 1;
          return 0;
        };
      // __extern_has(obj, key) → i32. Runtime fallback for `key in obj` when
      // RHS is externref and the compile-time static resolution has no info
      // (e.g. regex `result.groups`, untyped objects). Mirrors `__extern_has_idx`
      // but for string keys. Returns 0 on opaque structs / null receivers so it
      // never throws into Wasm — matching V8's `in` operator semantics for
      // non-object operands would also throw, but at this dispatch point the
      // caller already confirmed RHS is an object-shaped externref.
      if (name === "__extern_has")
        return (obj: any, key: any): number => {
          if (obj == null) return 0;
          // WasmGC struct keys → primitive via ToPrimitive (mirrors _safeGet, #1716)
          if (key != null && typeof key === "object" && _isWasmStruct(key)) {
            const prim = _toPrimitiveSync(key, "string", callbackState);
            if (prim != null && typeof prim !== "object") key = prim;
          }
          // (#2130) WasmGC struct receivers route through the shared own-property
          // predicate (tombstone-aware, per-receiver shape oracle) — NOT a
          // module-global `__sget_<key>` existence probe, which reported every
          // receiver as having any field name present in any struct type and
          // never consulted the delete tombstone. So `delete o.a; "a" in o` is
          // now `false`, and object-rest `"e" in rest` is `false` (rest's plain
          // object never has `e`; the source struct's shape no longer leaks).
          if (typeof obj === "object" && _isWasmStruct(obj)) {
            if (_wasmStructHasOwn(obj, key, callbackState?.getExports())) return 1;
            // (#1991) `in` walks the [[Prototype]] chain (§13.10.1 → §7.3.12):
            // every object inherits the Object.prototype members.
            if (typeof key === "string" && _OBJECT_PROTO_KEYS.has(key)) return 1;
            return 0;
          }
          // Plain JS object (or host-supplied object) — native HasProperty walks
          // its own prototype chain. HasProperty is value-independent (§7.3.12),
          // so the sidecar fallback is key-based, not value-based (A8): a
          // user-assigned `o.x = undefined` must still report present.
          try {
            if (key in obj) return 1;
          } catch (e) {
            // #2180/#2617 — `key in revokedProxy` throws TypeError; a user
            // Proxy's `has` trap may also throw (abrupt completion). Propagate
            // both instead of swallowing into the sidecar fallback.
            _rethrowIfProxyOrRevoked(e, obj);
            /* opaque struct or non-object obj */
          }
          const sc = _wasmStructProps.get(obj);
          if (sc && key in sc) return 1;
          // Inherited Object.prototype members for any non-null object value.
          if (typeof key === "string" && (typeof obj === "object" || typeof obj === "function") && obj !== null) {
            if (_OBJECT_PROTO_KEYS.has(key)) return 1;
          }
          return 0;
        };
      // (#2663 Slice 4) __with_has_binding(obj, key) -> i32. The ECMAScript
      // Object Environment Record HasBinding (§9.1.1.2.1) used by the `with`
      // statement: value-independent HasProperty, THEN filtered by the
      // receiver's @@unscopables blocklist. A bare name inside `with (obj) {}`
      // shadows the outer binding only when HasBinding is true.
      //   1. found = HasProperty(obj, N)                (= __extern_has)
      //   2. if not found -> 0
      //   3. unscopables = Get(obj, @@unscopables)
      //   4. if Type(unscopables) is Object and ToBoolean(Get(unscopables, N))
      //        -> 0   (the @@unscopables entry hides the binding)
      //   5. -> 1
      // Host-mode only: the standalone with-gate emits `__extern_has` (refused
      // under --target standalone, like Slices 1-3), so this import is never
      // requested in a no-JS-host build.
      if (name === "__with_has_binding") {
        // Reuse the value-independent HasProperty (`__extern_has`) and the
        // sidecar-aware reader (`__extern_get`, the `extern_get` intent) so a
        // WasmGC-struct `with` receiver whose @@unscopables / properties live in
        // the host sidecar resolve identically to a plain host object.
        const hasProp = resolveImport(
          { type: "builtin", name: "__extern_has" } as ImportIntent,
          deps,
          callbackState,
          globalSandbox,
          instanceState,
          undefined,
          dynamicCode,
          dynamicCodeEvaluator,
        ) as (o: any, k: any) => number;
        const getProp = resolveImport(
          { type: "extern_get" } as ImportIntent,
          deps,
          callbackState,
          globalSandbox,
          instanceState,
          undefined,
          dynamicCode,
          dynamicCodeEvaluator,
        ) as (o: any, k: any) => any;
        const toBool = resolveImport(
          { type: "builtin", name: "__to_boolean" } as ImportIntent,
          deps,
          callbackState,
          globalSandbox,
          instanceState,
          undefined,
          dynamicCode,
          dynamicCodeEvaluator,
        ) as (v: any) => number;
        return (obj: any, key: any): number => {
          // (1)+(2) value-independent HasProperty.
          if (!hasProp(obj, key)) return 0;
          // (3) unscopables = Get(obj, @@unscopables). A throw (opaque struct
          // with no sidecar entry) ⇒ no blocklist.
          let unsc: any;
          try {
            unsc = getProp(obj, Symbol.unscopables);
          } catch {
            unsc = undefined;
          }
          // (4) If Type(unscopables) is Object: blocked = ToBoolean(Get(unsc, N)).
          if (unsc !== null && (typeof unsc === "object" || typeof unsc === "function")) {
            let blocked: any;
            try {
              blocked = getProp(unsc, key);
            } catch {
              blocked = undefined;
            }
            if (toBool(blocked)) return 0; // @@unscopables hides the binding.
          }
          return 1; // (5)
        };
      }
      if (name === "__extern_toString")
        return (v: any) => {
          if (v == null) return String(v);
          // ToPrimitive for WasmGC structs must run BEFORE any .toString
          // property read — reading .toString on an opaque struct throws
          // "WebAssembly objects are opaque" (#850, #983)
          if (typeof v === "object" && _isWasmStruct(v)) {
            const prim = _toPrimitive(v, "string", callbackState);
            if (prim !== undefined) return String(prim);
            // Fall through to host ToPrimitive — throws TypeError if no conversion (#1128)
            try {
              const prim2 = _hostToPrimitive(v, "string", callbackState);
              return String(prim2);
            } catch {
              return "[object Object]";
            }
          }
          if (typeof v.toString === "function") return v.toString();
          if (typeof v === "object") {
            const prim = _toPrimitive(v, "string", callbackState);
            if (prim !== undefined) return String(prim);
          }
          try {
            return String(v);
          } catch {
            return "[object Object]";
          }
        };
      // (#2666) ToPropertyKey (§7.1.19) as a standalone host import so codegen
      // can coerce a computed property key EXACTLY ONCE before a read-modify-write
      // (`o[key] += v`, `o[key]++`). Without this the key object flows raw into
      // both `__extern_get` and `__extern_set`, each of which runs ToPropertyKey
      // internally → `key.toString` fires twice (eval-order bug). Coercing once
      // here and reusing the primitive result is idempotent (ToPropertyKey of a
      // string is the string; of a Symbol is the Symbol). Preserves Symbols.
      if (name === "__to_property_key") return (v: any) => _toPropertyKey(v, callbackState);
      // (#2022) ToString of a `+`-concat operand. `+` applies ToPrimitive with
      // the DEFAULT hint (valueOf before toString), even when the other operand
      // is a string — unlike `String(x)` / template literals which use the
      // string hint. So `({ toString:()=>"P!", valueOf:()=>7 }) + ""` is "7",
      // not "P!". Mirrors `__extern_toString` but with the "default" hint.
      if (name === "__extern_to_string_default")
        return (v: any) => {
          if (v == null) return String(v);
          if (typeof v === "object" && _isWasmStruct(v)) {
            const prim = _toPrimitive(v, "default", callbackState);
            if (prim !== undefined) {
              if (typeof prim === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
              return String(prim);
            }
            try {
              const prim2 = _hostToPrimitive(v, "default", callbackState);
              if (typeof prim2 === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
              return String(prim2);
            } catch {
              return "[object Object]";
            }
          }
          if (typeof v === "object") {
            const prim = _toPrimitive(v, "default", callbackState);
            if (prim !== undefined) {
              if (typeof prim === "symbol") throw new TypeError("Cannot convert a Symbol value to a string");
              return String(prim);
            }
          }
          try {
            return String(v);
          } catch {
            return "[object Object]";
          }
        };
      // (#1998/#1997) Array.prototype.join / toString element stringifier. Per
      // ES2024 §23.1.3.18 step 7.c/d, `undefined` and `null` elements join as
      // the empty String; every other element goes through ToString. This
      // differs from `__extern_toString` (used by `+`), where null/undefined
      // yield "null"/"undefined". A boxed `null`/`undefined` element arrives as
      // a defined externref, so the empty-string rule is applied here, in JS.
      // Nested arrays (`[[1,2],[3]].toString()` → "1,2,3") are WasmGC vec
      // structs; ToString on a vec recurses into Array.prototype.join, which we
      // reproduce by materialising the vec and joining with the default ",".
      if (name === "__extern_join_str") {
        const joinElem = (v: any): string => {
          if (v == null) return "";
          if (typeof v === "object" && _isWasmStruct(v)) {
            // A WasmGC vec → recurse: ToString(array) === array.join(",").
            const exports = callbackState?.getExports();
            // (#3637) POSITIVE discriminator: without it `__vec_len`'s not-a-vec
            // default of 0 made this loop run zero times for a plain object
            // element, so ToString(element) was "" instead of the ToPrimitive
            // answer. Measured pre-fix: `[1, {x: 1}].join("-")` → `"1-"`, where
            // the host answers `"1-[object Object]"`.
            if (
              exports &&
              typeof exports.__vec_len === "function" &&
              typeof exports.__vec_get === "function" &&
              _isWasmVec(v, exports)
            ) {
              try {
                const len = exports.__vec_len(v) as number;
                if (typeof len === "number" && len >= 0) {
                  let out = "";
                  for (let i = 0; i < len; i++) {
                    if (i > 0) out += ",";
                    out += joinElem(exports.__vec_get(v, i));
                  }
                  return out;
                }
              } catch {
                /* (#3637) NOT "not a vec" — `__vec_len` returns 0 rather than
                   throwing for a non-vec; `_isWasmVec` on the guard above is
                   what decides that. Only a genuine element-read trap lands
                   here, and falling through to ToPrimitive is still right. */
              }
            }
            const prim = _toPrimitive(v, "string", callbackState);
            if (prim !== undefined) return String(prim);
            try {
              return String(_hostToPrimitive(v, "string", callbackState));
            } catch {
              return "[object Object]";
            }
          }
          if (typeof v.toString === "function") return v.toString();
          if (typeof v === "object") {
            const prim = _toPrimitive(v, "string", callbackState);
            if (prim !== undefined) return String(prim);
          }
          try {
            return String(v);
          } catch {
            return "[object Object]";
          }
        };
        return joinElem;
      }
      // (#1638) Date.prototype string formatters. The Wasm side holds the
      // timestamp as an i64 and passes it here with a mode selector; we build
      // the spec-correct string from a UTC Date. The invalid-Date sentinel
      // (i64 min) maps to the spec's "Invalid Date" handling per mode.
      if (name === "__date_format") {
        return (ts: bigint, mode: number): string => _formatDate(ts, mode);
      }
      if (name === "__temporal_plain_date_to_string") return _temporalPlainDateToString;
      if (name === "__temporal_plain_date_month_code") return _temporalPlainDateMonthCode;
      if (name === "__temporal_plain_date_from_string_field") return _temporalPlainDateFromStringField;
      if (name === "__temporal_plain_date_add_field") return _temporalPlainDateAddField;
      if (name === "__temporal_plain_time_to_string") return _temporalPlainTimeToString;
      if (name === "__temporal_plain_time_from_string_field") return _temporalPlainTimeFromStringField;
      if (name === "__temporal_plain_time_add_field") return _temporalPlainTimeAddField;
      if (name === "__temporal_duration_to_string") return _temporalDurationToString;
      if (name === "__temporal_duration_from_string_field") return _temporalDurationFromStringField;
      if (name === "__temporal_duration_sign") return _temporalDurationSign;
      if (name === "__extern_toLocaleString")
        return (v: any) => {
          if (v == null) return String(v);
          if (typeof v === "object" && _isWasmStruct(v)) {
            const exports = callbackState?.getExports();
            const plain = _wasmToPlain(v, exports);
            if (plain !== v && plain != null && typeof plain.toLocaleString === "function") {
              return plain.toLocaleString();
            }
            return String(v);
          }
          return v.toLocaleString();
        };
      if (name === "__extern_is_undefined") return (v: any) => (v === undefined ? 1 : 0);
      // (#3714) ECMA-262 Type(x) is Object — used by the private-field
      // brand-check (`#x in obj`, §12.10.3 step 5) to distinguish "a real
      // object of the wrong class" (false, no throw) from "not an object at
      // all" (TypeError) when a WasmGC `ref.test` alone can't see past an
      // opaque externref. Deliberately NOT `typeof v === "object"` alone —
      // that's `true` for `null` too, but `null` is not an ECMAScript Object.
      if (name === "__extern_is_object")
        return (v: any) => (v !== null && (typeof v === "object" || typeof v === "function") ? 1 : 0);
      // (#1328) Array.isArray on an externref value (e.g. a RegExp match
      // result returned from the host). The compile-time type can't decide
      // this for `externref`, so defer to the real spec predicate.
      if (name === "__extern_is_array") return (v: any) => (Array.isArray(v) ? 1 : 0);
      if (name === "__get_undefined") return () => undefined;
      // (#1343) ToBoolean for externref values per ECMA-262 §7.1.2.
      // The pre-existing externref path for `Boolean(x)` only checked
      // `ref.is_null` — which returns false for JS `undefined` (since
      // undefined arrives as a defined externref via `__get_undefined`,
      // not a null reference). Rather than emit a chain of host probes
      // (`__extern_is_undefined`, length checks, etc.) we centralise
      // the spec rules in a single import:
      //   undefined → false
      //   null → false
      //   boolean → identity
      //   +0, -0, NaN → false; other numbers → true
      //   "" → false; other strings → true
      //   bigint 0n → false; other bigints → true
      //   symbol → true
      //   object → true
      // The exception is when the host's truthiness coercion itself throws
      // (Symbol.toPrimitive trap, Proxy traps); we let those propagate so
      // the `Boolean(...)` call surface matches spec semantics.
      if (name === "__to_boolean") return (v: any): number => (v ? 1 : 0);
      if (name === "__throw_type_error")
        return (msg: any) => {
          throw new TypeError(msg == null ? "" : String(msg));
        };
      if (name === "__throw_reference_error")
        return (msg: any) => {
          throw new ReferenceError(msg == null ? "" : String(msg));
        };
      // __to_primitive: full ToPrimitive per ECMA-262 §7.1.1 (#1090)
      // Takes (externref obj, externref hint_string) → externref primitive
      // Throws TypeError if conversion fails or Symbol.toPrimitive is non-callable
      if (name === "__to_primitive")
        return (obj: any, hintStr: any): any => {
          if (obj == null || typeof obj !== "object") return obj;
          const hint: "number" | "string" | "default" =
            hintStr === "string" ? "string" : hintStr === "number" ? "number" : "default";
          return _hostToPrimitive(obj, hint, callbackState);
        };
      // __box_symbol: convert i32 symbol ID → real JS Symbol (cached by ID)
      // so symbols preserve identity when crossing the Wasm/JS boundary (#864)
      //
      // (#1467) Per-id description map: `__symbol_register_desc(id, desc)`
      // registers a user-supplied description for the next `__box_symbol(id)`
      // so `Symbol(s).description === s` round-trips correctly even though the
      // compiler represents symbols as i32 IDs internally. Special sentinel
      // `''` (empty string) marks "Symbol() called with no arg" so
      // `.description === undefined` works distinctly from "uninitialized".
      if (name === "__box_symbol") {
        // #1933 — per-instance symbol cache (was module-level `_symbolCache`,
        // reset per buildImports → clobbered concurrent instances). Falls back
        // to a local map when no instanceState is threaded (legacy callers).
        const symbolCache = _resolveSymbolCache(instanceState);
        const symbolDescRegistry =
          instanceState?.symbolDescRegistry ??
          (instanceState
            ? (instanceState.symbolDescRegistry = new Map<number, string | null>())
            : new Map<number, string | null>());
        return (id: number) => {
          let sym = symbolCache.get(id);
          if (sym === undefined) {
            const reg = symbolDescRegistry.get(id);
            // reg === undefined → caller never registered (use legacy wasm_<id>)
            // reg === null     → Symbol() with no description → undefined
            // reg is a string  → user-supplied description
            sym = reg === undefined ? Symbol(`wasm_${id}`) : reg === null ? Symbol() : Symbol(reg);
            symbolCache.set(id, sym);
          }
          return sym;
        };
      }
      // (#1467) Register a description for the symbol at `id` so subsequent
      // `__box_symbol(id)` calls produce Symbol(desc) preserving Description.
      // Pass `null` (ref.null extern) to mark "Symbol() with no description".
      if (name === "__symbol_register_desc") {
        // #1933 — per-instance description registry (was module-level).
        const symbolDescRegistry =
          instanceState?.symbolDescRegistry ??
          (instanceState
            ? (instanceState.symbolDescRegistry = new Map<number, string | null>())
            : new Map<number, string | null>());
        return (id: number, desc: any): void => {
          if (id <= 15) return; // never override well-known symbols (#1830: 15 = @@matchAll)
          if (desc == null) {
            symbolDescRegistry.set(id, null);
          } else {
            symbolDescRegistry.set(id, String(desc));
          }
        };
      }
      if (name === "__object_create") return (proto: any) => Object.create(proto);
      if (name === "__new_plain_object") return (): any => ({});
      if (name === "__register_prototype")
        return (proto: any, csv: any): void => {
          // #1047 — populate the prototype method-name allowlist consulted by
          // `_wrapForHost` so `C.prototype` enumerates methods only.
          if (proto == null || typeof proto !== "object") return;
          const names = typeof csv === "string" && csv.length > 0 ? csv.split(",") : [];
          _prototypeMethodNames.set(proto, names);
        };
      if (name === "__register_class_object")
        return (classObj: any, csv: any): void => {
          // (#1395) Populate the static-method-name allowlist consulted by
          // `__getOwnPropertyDescriptor` and `__getOwnPropertyNames` so
          // `Object.getOwnPropertyDescriptor(C, "m")` returns the spec
          // descriptor for static methods.
          if (classObj == null || typeof classObj !== "object") return;
          const names = typeof csv === "string" && csv.length > 0 ? csv.split(",") : [];
          _staticMethodNames.set(classObj, names);
        };
      if (name === "__register_class_static_method")
        return function registerClassStaticMethod(classObj: any, methodName: any, closure: any): void {
          // (#4371) Pair the class object's existing name allowlist with the
          // actual compiled closure. Keeping the value in the descriptor-aware
          // sidecar preserves the WasmGC class singleton/type (dynamic `new`
          // relies on it), while `_wrapForHost` already knows how to turn this
          // raw closure struct into a callable JavaScript function on read.
          if (classObj == null || typeof classObj !== "object") return;
          if (typeof methodName !== "string" || methodName.length === 0) return;
          _sidecarSet(classObj, methodName, closure);
          _getSidecarDescs(classObj).set(methodName, _SC_DEFINED | _SC_WRITABLE | _SC_CONFIGURABLE);
        };
      if (name === "__unbox_string")
        return (s: any): any => {
          if (typeof s === "string") return s; // already a string primitive
          // WasmGC structs with valueOf/toString closures need ToPrimitive (#1090)
          if (s != null && typeof s === "object" && _isWasmStruct(s)) {
            const prim = _toPrimitive(s, "string", callbackState);
            if (prim !== undefined) return String(prim);
            try {
              const prim2 = _hostToPrimitive(s, "string", callbackState);
              return String(prim2);
            } catch {
              /* fall through to String() */
            }
          }
          return String(s); // extract primitive from String wrapper object
        };
      if (name === "__object_freeze")
        return (obj: any) => {
          if (obj == null) return obj;
          if (_isWasmStruct(obj)) {
            // Mark all known fields as non-writable + non-configurable in sidecar
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports) ?? [];
            const sDescs = _getSidecarDescs(obj);
            for (const field of fieldNames) {
              const existing = sDescs.get(field) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
              sDescs.set(field, (existing & ~(_SC_WRITABLE | _SC_CONFIGURABLE)) | _SC_DEFINED);
            }
            // Also freeze any sidecar properties
            const sc = _wasmStructProps.get(obj);
            if (sc) {
              for (const key of Object.keys(sc)) {
                const existing = sDescs.get(key) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
                sDescs.set(key, (existing & ~(_SC_WRITABLE | _SC_CONFIGURABLE)) | _SC_DEFINED);
              }
            }
            _wasmFrozenObjs.add(obj);
            _wasmNonExtensibleObjs.add(obj);
            return obj;
          }
          try {
            return Object.freeze(obj);
          } catch {
            return obj;
          }
        };
      if (name === "__object_seal")
        return (obj: any) => {
          if (obj == null) return obj;
          if (_isWasmStruct(obj)) {
            // Mark all known fields as non-configurable in sidecar
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports) ?? [];
            const sDescs = _getSidecarDescs(obj);
            for (const field of fieldNames) {
              const existing = sDescs.get(field) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
              sDescs.set(field, (existing & ~_SC_CONFIGURABLE) | _SC_DEFINED);
            }
            const sc = _wasmStructProps.get(obj);
            if (sc) {
              for (const key of Object.keys(sc)) {
                const existing = sDescs.get(key) ?? _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED;
                sDescs.set(key, (existing & ~_SC_CONFIGURABLE) | _SC_DEFINED);
              }
            }
            _wasmSealedObjs.add(obj);
            _wasmNonExtensibleObjs.add(obj);
            return obj;
          }
          try {
            return Object.seal(obj);
          } catch {
            return obj;
          }
        };
      if (name === "__object_preventExtensions")
        return (obj: any) => {
          if (obj == null) return obj;
          if (_isWasmStruct(obj)) {
            _wasmNonExtensibleObjs.add(obj);
            return obj;
          }
          try {
            return Object.preventExtensions(obj);
          } catch (e) {
            // #2617 — a user Proxy's preventExtensions trap may throw, or the
            // host engine's §10.5 invariant may throw; propagate for a tracked
            // user Proxy. Non-proxy objects keep the swallow-and-return-self
            // behavior (sloppy-mode-tolerant).
            _rethrowIfProxyOrRevoked(e, obj);
            return obj;
          }
        };
      // Runtime Object.isFrozen/isSealed/isExtensible — used when compile-time tracking
      // cannot determine the state (e.g. argument is not a simple identifier).
      // null/undefined return 0/1 conservatively to match tests where unresolvable
      // identifiers (Object, this, etc.) compile to null in our Wasm.
      if (name === "__object_isFrozen")
        return (obj: any) => {
          // (#1462) ES2015+ §19.1.2.13: if Type(O) is not Object, return true.
          // Primitives (numbers, strings, booleans, symbols, bigints) and
          // null/undefined are conceptually immutable — `isFrozen` returns
          // true for them. Test262 covers this under `Object/isFrozen/`.
          if (obj == null) return 1;
          if (typeof obj !== "object" && typeof obj !== "function") return 1;
          // (#2744) WasmGC struct/vec: WeakSet fast-path (Object.freeze was
          // called) OR TestIntegrityLevel over the live descriptor table (covers
          // preventExtensions + defineProperty(non-writable, non-configurable)).
          if (_isWasmStruct(obj))
            return _wasmFrozenObjs.has(obj) || _testIntegrityLevel(obj, true, callbackState?.getExports()) ? 1 : 0;
          return Object.isFrozen(obj) ? 1 : 0;
        };
      if (name === "__object_isSealed")
        return (obj: any) => {
          // (#1462) ES2015+ §19.1.2.14: if Type(O) is not Object, return true.
          if (obj == null) return 1;
          if (typeof obj !== "object" && typeof obj !== "function") return 1;
          // (#2744) WasmGC struct/vec: WeakSet fast-path (Object.seal/freeze was
          // called) OR TestIntegrityLevel (non-extensible + all own props
          // non-configurable) over the live descriptor table.
          if (_isWasmStruct(obj))
            return _wasmSealedObjs.has(obj) ||
              _wasmFrozenObjs.has(obj) ||
              _testIntegrityLevel(obj, false, callbackState?.getExports())
              ? 1
              : 0;
          return Object.isSealed(obj) ? 1 : 0;
        };
      if (name === "__object_isExtensible")
        return (obj: any) => {
          // (#1462) ES2015+ §19.1.2.12: if Type(O) is not Object, return false.
          // Primitives have no extensible state to add properties to.
          if (obj == null) return 0;
          if (typeof obj !== "object" && typeof obj !== "function") return 0;
          if (_isWasmStruct(obj)) return _wasmNonExtensibleObjs.has(obj) ? 0 : 1;
          return Object.isExtensible(obj) ? 1 : 0;
        };
      // Object.keys/values/entries host imports — handle WasmGC structs via
      // exported getters so opaque struct fields are visible at runtime.
      if (name === "__object_keys")
        return (obj: any) => {
          // ES §20.1.2.18 Object.keys → ToObject (§7.1.18) throws on null/undefined.
          if (obj == null) throw new TypeError(`Cannot convert ${obj === null ? "null" : "undefined"} to object`);
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports);
            const descs = _wasmPropDescs.get(obj);
            const tomb = _wasmStructDeletedKeys.get(obj);
            const sc = _wasmStructProps.get(obj);
            // Enumerable iff not deleted and (no descriptor entry ⇒ enumerable by
            // default, else the descriptor's ENUMERABLE flag).
            const isEnumerable = (k: string): boolean => {
              if (tomb && tomb.has(k)) return false;
              const flags = descs?.get(_normalizeDescKey(k));
              return flags === undefined || !!(flags & _SC_ENUMERABLE);
            };
            if (fieldNames || sc) {
              const result: string[] = [];
              // (#2179) Static struct fields — UNCHANGED legacy filter (drop
              // deleted keys + non-enumerable redefinitions).
              if (fieldNames) for (const k of fieldNames) if (isEnumerable(k)) result.push(k);
              // (#4298) ADD every own enumerable sidecar key beyond the static
              // struct shape. Ordinary assignment creates an enumerable own data
              // property even though it has no explicit descriptor-table entry;
              // requiring `_wasmPropDescs` here made `Object.keys` return `[]`
              // for React's dynamically assembled props while direct reads still
              // worked. The for-in path already treats a descriptor-less sidecar
              // entry as enumerable, so this also restores agreement between the
              // two enumeration surfaces. Explicit non-enumerable descriptors,
              // tombstones and accessor bookkeeping remain filtered. React's
              // dynamically assembled props and Redux's `finalReducers[key]`
              // both depend on this exact Object.keys round trip.
              if (sc) {
                for (const k of Object.getOwnPropertyNames(sc)) {
                  if (k.startsWith("__get_") || k.startsWith("__set_")) continue;
                  if (result.includes(k) || (fieldNames && fieldNames.includes(k))) continue;
                  if (isEnumerable(k)) result.push(k);
                }
              }
              return _orderOwnKeysSpec(result); // (#2131)
            }
          }
          return Object.keys(obj);
        };
      if (name === "__object_values")
        return (obj: any) => {
          // ES §20.1.2.22 Object.values → ToObject (§7.1.18) throws on null/undefined.
          if (obj == null) throw new TypeError(`Cannot convert ${obj === null ? "null" : "undefined"} to object`);
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports);
            if (fieldNames) {
              const descs = _wasmPropDescs.get(obj);
              const tomb = _wasmStructDeletedKeys.get(obj); // (#2179) skip deleted keys
              return _orderOwnKeysSpec(
                fieldNames.filter((k) => {
                  if (tomb && tomb.has(k)) return false;
                  if (!descs) return true;
                  const flags = descs.get(k);
                  return flags === undefined || !!(flags & _SC_ENUMERABLE);
                }),
              ).map((key) => {
                const getter = exports?.[`__sget_${key}`];
                return typeof getter === "function" ? getter(obj) : undefined;
              }); // (#2131) value order follows spec key order
            }
          }
          return Object.values(obj);
        };
      if (name === "__object_entries")
        return (obj: any) => {
          // ES §20.1.2.5 Object.entries → ToObject (§7.1.18) throws on null/undefined.
          if (obj == null) throw new TypeError(`Cannot convert ${obj === null ? "null" : "undefined"} to object`);
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports);
            if (fieldNames) {
              const descs = _wasmPropDescs.get(obj);
              const tomb = _wasmStructDeletedKeys.get(obj); // (#2179) skip deleted keys
              return _orderOwnKeysSpec(
                fieldNames.filter((k) => {
                  if (tomb && tomb.has(k)) return false;
                  if (!descs) return true;
                  const flags = descs.get(k);
                  return flags === undefined || !!(flags & _SC_ENUMERABLE);
                }),
              ).map((key) => {
                const getter = exports?.[`__sget_${key}`];
                const val = typeof getter === "function" ? getter(obj) : undefined;
                return [key, val];
              }); // (#2131) entry order follows spec key order
            }
          }
          return Object.entries(obj);
        };
      if (
        name === "__array_from_iter" ||
        name === "__array_from_iter_n" ||
        name === "__array_from_iter_strict" ||
        name === "__array_from_iter_n_strict"
      ) {
        // Cache the original Array.prototype[Symbol.iterator] so we can
        // detect when user code (e.g. test262 iter-get-err-array-prototype)
        // has overridden it. When overridden, we must invoke the protocol
        // rather than fast-pathing the array — otherwise a throwing custom
        // @@iterator on Array.prototype is silently swallowed (#1454).
        const _origArrayIter: any = (Array.prototype as any)[Symbol.iterator];
        // (#3023) Robust iterator-protocol walk for an ITERATOR OBJECT whose
        // methods may be wasm closures. A compiled object-literal iterator
        // (`{ next() {…}, return() {…} }`, e.g. from `it[Symbol.iterator] =
        // function () { return { next, return } }`) lowers to a closed nominal
        // WasmGC struct: its `.next` / `.return` are NOT native JS properties,
        // so a plain `iteratorObj.next()` throws "next is not a function".
        // Resolve each member through native → sidecar (`_safeGet`) → wasm
        // struct getter (`__sget_*`) → wasm-closure call (`__call_fn_0`),
        // collect at most `limit` values, and perform §7.4.6 IteratorClose
        // (`.return()`) ONLY on an abrupt bounded/defensive-cap stop (never on
        // natural `done:true`, a null result, or a missing `.next`). Shared by
        // both the wasm-closure-`@@iterator` path and `_drainIterable` (a
        // native `@@iterator` that RETURNS a wasm-struct iterator).
        // (#3195) The bounded destructuring walk: consume at most `limit`
        // IteratorStep calls; §8.5.3 closes the iterator when stopped by a finite
        // `limit` / the defensive cap (a NormalCompletion stop — `closeOnStop`),
        // while `limit === Infinity` (rest/spread) drains to natural done WITHOUT
        // closing. Shares the single step loop with the other two drainers.
        const _walkWasmIterator = (iteratorObj: any, limit: number): any[] =>
          _stepClosureIterator(iteratorObj, callbackState?.getExports(), { limit, closeOnStop: true }) as any[];
        // Materialize an iterable/array-like to a real JS array, consuming AT
        // MOST `limit` iterator steps. `limit === Infinity` (the unbounded
        // case, used by rest patterns and spread) is byte-for-byte the legacy
        // __array_from_iter behavior. A finite `limit` calls the iterator's
        // .next() at most `limit` times — required for array binding patterns
        // without a rest element, where the spec (§8.5.3) consumes exactly one
        // IteratorStep per slot (INCLUDING elision holes), not a full drain
        // (#1592). Stopping at the bound is a NormalCompletion: it must NOT
        // trigger IteratorClose (only the defensive MAX_ITER cap does).
        const _arrayFromIter = (obj: any, limit: number, strictIterator = false): any => {
          // For proper iterators (e.g. generators) this invokes the iterator
          // protocol and propagates any throws from .next() — needed for
          // spec-compliant destructuring of throwing iterators (#1150).
          if (obj == null) {
            if (strictIterator) throw new TypeError(`${obj} is not iterable`);
            return [];
          }
          // (#2202) An opaque WasmGC vec ref (e.g. an inline `[1]` spread source
          // that stayed a native vec instead of being marshaled to a JS array)
          // is not `Array.isArray` and has no `Symbol.iterator`, so it would fall
          // through to the array-like length probe and yield an empty/wrong list,
          // dropping the spread's elements from `arguments`. Materialize it to a
          // real JS array first via the `__vec_len`/`__vec_get` exports (the same
          // machinery `__array_from` / `Array.from(wasmVec)` use), then continue.
          if (typeof obj === "object" && _isWasmStruct(obj)) {
            const exps = callbackState?.getExports();
            const vecLen = exps?.__vec_len;
            const vecGet = exps?.__vec_get;
            // (#3637) POSITIVE discriminator. Vacuously, every wasm struct was
            // "a vec of length 0" here, so spreading a plain object produced an
            // empty list instead of reaching the iterator-protocol handling
            // below (which raises the spec-mandated TypeError). Measured
            // pre-fix: `[...{a: 1}]` → `[]`, `var [p] = {a: 1}` → `undefined`,
            // where the host throws TypeError in both cases.
            if (typeof vecLen === "function" && typeof vecGet === "function" && _isWasmVec(obj, exps)) {
              try {
                const vlen = vecLen(obj) as number;
                if (typeof vlen === "number" && vlen >= 0) {
                  const out: any[] = [];
                  const n = limit < vlen ? limit : vlen;
                  for (let i = 0; i < n; i++) out.push(vecGet(obj, i));
                  return out;
                }
              } catch {
                /* (#3637) NOT "not a vec" — that is `_isWasmVec`'s job on the
                   guard above; `__vec_len` returns 0 instead of throwing. Only
                   a genuine element-read trap reaches here. */
              }
            }
          }
          if (Array.isArray(obj)) {
            // #1454: Real arrays normally take a fast path, but if the user has
            // overridden Array.prototype[Symbol.iterator] (or installed an own
            // @@iterator on the array), spec §22.1.5 requires going through
            // the iterator protocol so a throwing getter / non-default iterator
            // is observable. Read the @@iterator descriptor first (this fires
            // any accessor) — a throw here propagates as iter-get-err.
            const ownIter = (obj as any)[Symbol.iterator];
            if (ownIter !== _origArrayIter) {
              // Non-default iterator: fall through to the protocol path below
              // by treating the array as a generic iterable (bounded by limit).
              return _drainIterable(obj, limit, strictIterator, ownIter);
            }
            // Default array iterator: a finite bound just slices the prefix;
            // the iterator protocol on a default array is side-effect-free so
            // slicing is observationally identical to stepping `limit` times.
            return limit < obj.length ? obj.slice(0, limit) : obj;
          }
          // Compiled sources that do `iter[Symbol.iterator] = fn` often land the
          // function under a stringified "Symbol(Symbol.iterator)" key rather
          // than the real well-known symbol. Array.from would then reject on
          // "iterator method exists but not callable". Detect that up front and
          // route around it: when the user installed a callable @@iterator, we
          // must INVOKE it (so spec-mandated throws from `iter[Symbol.iterator]()`
          // propagate, e.g. test262 dstr/*-iter-*-err.js); when no callable is
          // present, fall back to array-like index enumeration so plain non-
          // iterable objects don't error out.
          if (typeof obj === "object") {
            const iterFn = (obj as any)[Symbol.iterator];
            if (iterFn !== undefined && typeof iterFn !== "function") {
              // Wasm closures land here as opaque externref objects (typeof
              // 'object'). Try to invoke them through the closure-call exports
              // — if the closure throws (e.g. a custom @@iterator that throws
              // Test262Error), propagate the throw. (#1016)
              if (_isWasmStruct(iterFn)) {
                const exps = callbackState?.getExports();
                const callFn0 = exps?.["__call_fn_0"];
                if (typeof callFn0 === "function") {
                  // Invoke the wasm @@iterator closure. If it throws (test262
                  // dstr/*-init-iter-get-err, *-iter-val-err), propagate so the
                  // surrounding destructure assertion observes it. If it
                  // returns an iterator object, walk the standard iterator
                  // protocol manually — the iterator's `.next` is typically
                  // ALSO a wasm closure (typeof 'object'), so a plain
                  // `Array.from(iteratorObj)` would re-enter this fallback and
                  // miss .next() throws (test262 dstr/*-iter-step-err). (#1016)
                  const iteratorObj = callFn0(iterFn);
                  if (iteratorObj != null && typeof iteratorObj === "object") {
                    // (#3023) Robust protocol walk (bounded materialization +
                    // §7.4.6 IteratorClose on the abrupt bounded stop). The
                    // iterator's `.next` is typically ALSO a wasm closure, so a
                    // plain `Array.from(iteratorObj)` would re-enter this fallback
                    // and miss .next() throws (test262 dstr/*-iter-step-err).
                    return _walkWasmIterator(iteratorObj, limit);
                  }
                }
              }
              if (strictIterator) throw new TypeError("@@iterator is not callable");
              const out: any[] = [];
              const lenRaw = typeof (obj as any).length === "number" ? (obj as any).length >>> 0 : 0;
              const len = Math.min(lenRaw, limit);
              for (let i = 0; i < len; i++) out.push((obj as any)[i]);
              return out;
            }
            if (typeof iterFn === "function") {
              return _drainIterable(obj, limit, strictIterator, iterFn);
            }
            if (strictIterator) throw new TypeError("value is not iterable");
          }
          return _drainIterable(obj, limit, strictIterator);
        };
        // Walk a plain iterable's @@iterator protocol, collecting at most
        // `limit` values. Replaces `Array.from(obj)` so a finite bound can stop
        // early (Array.from can't be bounded). Throws from @@iterator / .next()
        // / the .value getter propagate unchanged (#1150/#1454). With
        // limit === Infinity this matches Array.from's full drain.
        function _drainIterable(obj: any, limit: number, strictIterator = false, knownIterFn?: any): any[] {
          const itFn = knownIterFn ?? (obj as any)?.[Symbol.iterator];
          // No callable @@iterator — let Array.from handle array-likes / the
          // legacy unbounded shapes exactly as before.
          if (typeof itFn !== "function") {
            if (strictIterator) throw new TypeError("@@iterator is not callable");
            return Array.from(obj);
          }
          const it = itFn.call(obj);
          // (#3023) A native `@@iterator` may still RETURN a wasm-struct
          // iterator (a compiled object-literal `{ next() {…} }` lowers to a
          // closed nominal WasmGC struct whose `.next` is not a native JS
          // property). A plain `it.next()` — or `Array.from(obj)` for the
          // unbounded rest/spread case — would throw "next is not a function";
          // route such iterators through the robust walk, which resolves
          // `.next`/`.value`/`.done`/`.return` via sidecar / `__sget_*` /
          // `__call_fn_0` and performs §7.4.6 IteratorClose on the bounded stop
          // (limit === Infinity drains to natural done WITHOUT closing).
          if (it != null && typeof it === "object" && typeof (it as any).next !== "function") {
            return _walkWasmIterator(it, limit);
          }
          // Plain JS iterator: step the iterator we already obtained. For the
          // unbounded case this matches `Array.from`'s full drain; a finite
          // `limit` stops early (Array.from can't be bounded). Throws from
          // `.next()` / the `.value` getter propagate unchanged (#1150/#1454).
          const out: any[] = [];
          while (out.length < limit) {
            const r = it.next();
            if (r == null || r.done) break;
            out.push(r.value);
          }
          return out;
        }
        if (name === "__array_from_iter") return (obj: any): any => _arrayFromIter(obj, Infinity);
        if (name === "__array_from_iter_strict") return (obj: any): any => _arrayFromIter(obj, Infinity, true);
        // (#3643 Slice A) Bounded STRICT drain — the array-binding-pattern
        // counterpart of `__array_from_iter_strict`. §8.6.2 `BindingPattern :
        // ArrayBindingPattern` performs GetIterator (§7.4.2) on the RHS, which
        // throws TypeError for a non-iterable. The non-strict `__array_from_iter_n`
        // instead falls through to `_drainIterable`'s `Array.from(obj)` array-like
        // fallback, which answers `[]` for `{a:1}` — so `var [p] = {a:1}` silently
        // bound `undefined` instead of throwing. Array SPREAD already used the
        // strict unbounded drain (`[...{b:1}]` threw correctly); destructuring is
        // the arm that was never wired to it. Kept as a SEPARATE import rather than
        // a strictness flag on `__array_from_iter_n` because that import is shared
        // with `__array_from_mapped` (`Array.from(arrayLike, mapFn)`) and
        // `__iterator_rest`, both of which MUST keep the array-like fallback.
        if (name === "__array_from_iter_n_strict")
          return (obj: any, n: number): any => _arrayFromIter(obj, n < 0 ? Infinity : n >>> 0, true);
        return (obj: any, n: number): any => _arrayFromIter(obj, n < 0 ? Infinity : n >>> 0);
      }
      if (name === "__extern_slice")
        return (arr: any, start: number) => {
          if (Array.isArray(arr)) return arr.slice(start);
          if (typeof arr === "string") return Array.from(arr).slice(start);
          // Handle WasmGC structs (tuples) — extract fields from index onwards
          if (_isWasmStruct(arr)) {
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(arr, exports);
            if (fieldNames && exports) {
              const result: any[] = [];
              for (let i = Math.max(0, start); i < fieldNames.length; i++) {
                const getter = exports[`__sget_${fieldNames[i]}`];
                if (typeof getter === "function") {
                  let val = getter(arr);
                  if (_isWasmStruct(val)) val = _structToPlainObject(val, exports) ?? val;
                  result.push(val);
                }
              }
              return result;
            }
          }
          if (arr != null && typeof arr[Symbol.iterator] === "function") return Array.from(arr).slice(start);
          return [];
        };
      if (name === "__extern_rest_object")
        return (obj: any, excludedKeysStr: string) => {
          if (obj == null) return {};
          const excluded = new Set(excludedKeysStr ? String(excludedKeysStr).split(",") : []);
          const result: Record<string, any> = {};
          // ES §14.7.4 CopyDataProperties copies only ENUMERABLE own properties.
          // Sidecar descriptors (set via Object.defineProperty) may mark a key
          // non-enumerable; consult the descriptor map to skip those. Plain
          // struct fields and sidecar entries without an explicit descriptor
          // default to enumerable. (#1552)
          const descs = _isWasmStruct(obj) ? _wasmPropDescs.get(obj) : undefined;
          const isEnumerable = (key: string): boolean => {
            if (!descs) return true;
            const flags = descs.get(_normalizeDescKey(key));
            if (flags === undefined) return true;
            return !!(flags & _SC_ENUMERABLE);
          };
          // For WasmGC structs, use exported getters to read fields
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            const fieldNames = _getStructFieldNames(obj, exports);
            if (fieldNames) {
              for (const key of fieldNames) {
                if (!excluded.has(key) && isEnumerable(key)) {
                  const getter = exports?.[`__sget_${key}`];
                  if (typeof getter === "function") result[key] = getter(obj);
                }
              }
            }
          } else {
            for (const key of Object.keys(obj)) {
              if (!excluded.has(key)) result[key] = obj[key];
            }
          }
          // Also copy sidecar properties (for WasmGC structs with dynamic props)
          const sc = _wasmStructProps.get(obj);
          if (sc) {
            for (const key of Object.keys(sc)) {
              if (!excluded.has(key) && !(key in result) && isEnumerable(key)) result[key] = sc[key];
            }
          }
          return result;
        };
      // Object.defineProperty host import — flags is a bitmask:
      //   bit 0: writable, bit 1: enumerable, bit 2: configurable
      //   bit 3: writable specified, bit 4: enumerable specified, bit 5: configurable specified
      //   bit 6: is accessor (get/set), bit 7: has value
      if (name === "__defineProperty_desc")
        return (obj: any, prop: any, desc: any) => {
          if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
            throw new TypeError("Object.defineProperty called on non-object");
          }
          // (#1716) ToPropertyKey on a struct key invokes its valueOf/toString/
          // @@toPrimitive instead of collapsing to "[object Object]".
          prop = _toPropertyKey(prop, callbackState);
          const key = typeof prop === "symbol" ? prop : prop != null ? String(prop) : "";
          // Field reader that round-trips both plain JS objects (native `o[f]`,
          // which fires accessors / walks the prototype chain per
          // ToPropertyDescriptor) and WasmGC structs (sidecar + the compiled
          // module's `__sget_<field>` exports for typed struct fields that
          // never reach the sidecar). Mirrors the reader in __defineProperties.
          // Own-level presence ONLY (no prototype walk). (#1629) Presence MUST
          // consult the struct's real shape, not a probe through `__sget_${f}`:
          // a `__sget_*` getter is module-global (one per field NAME across all
          // struct types) and DOES NOT trap on a struct that lacks the field — it
          // falls through to ref.null/0, so a try/catch probe returns `true` for
          // every ubiquitous descriptor name (value/get/set/writable) on any
          // struct, producing spurious ToPropertyDescriptor data⇄accessor
          // conflicts. `__struct_field_names(o)` returns THIS instance's concrete
          // field names — the precise membership test.
          const ownHasField = (o: any, f: string): boolean => {
            if (!_isWasmStruct(o)) return f in Object(o);
            const sc = _wasmStructProps.get(o);
            if (sc && f in sc) return true;
            return _structHasOwnFieldName(o, f, callbackState?.getExports());
          };
          const getField = (o: any, f: string): any => {
            if (!_isWasmStruct(o)) return o[f];
            // (#2680) ToPropertyDescriptor's Get (§7.3.3) is prototype-inclusive.
            // Resolve an own-level MISS through the descriptor's #1712 fnctor
            // prototype chain (wasmGC-aware) BEFORE the own-level __sget fallback:
            // that fallback calls a module-global `__sget_<f>` on the INSTANCE,
            // which returns a spurious ref.null (not `undefined`) for a field the
            // instance lacks (#1629) and would mask the inherited value. Own
            // attributes (sidecar / struct shape) shadow the prototype per spec
            // and take the own-read path below.
            if (!ownHasField(o, f)) {
              const pd = _fnctorProtoLookup(o, f, callbackState?.getExports());
              if (pd) return pd.get ? pd.get.call(o) : pd.value;
            }
            const sc = _wasmStructProps.get(o);
            if (sc && f in sc) return sc[f];
            // _safeGet fires struct accessor getters (__get_<f>) and the
            // sidecar; fall back to the compiled module's __sget_<field>
            // export for typed struct fields that never reach the sidecar.
            let v = _safeGet(o, f);
            if (v === undefined) {
              const g = callbackState?.getExports()?.[`__sget_${f}`];
              if (typeof g === "function") v = g(o);
            }
            return v;
          };
          const hasField = (o: any, f: string): boolean => {
            if (ownHasField(o, f)) return true;
            if (!_isWasmStruct(o)) return false;
            // (#2680) own-level miss → prototype-inclusive HasProperty (§7.3.12)
            // via the #1712 link (wasmGC-aware, #1629-safe — never an __sget_*
            // probe).
            return _fnctorProtoLookup(o, f, callbackState?.getExports()) !== undefined;
          };
          // (#1629a) When the descriptor is a WasmGC struct, its get/set fields
          // are Wasm-closure structs, not JS callables. Wrap them so the spec
          // typeof check passes and the resulting accessor is invocable.
          const wrap = (v: any, arity: number) => _maybeWrapCallable(v, arity, callbackState);
          // For a plain JS object whose descriptor is also a plain JS object,
          // native Object.defineProperty follows the descriptor's prototype
          // chain and accessor getters correctly — use it directly.
          if (!_isWasmStruct(obj) && !_isWasmStruct(desc)) {
            Object.defineProperty(obj, key, desc);
            return obj;
          }
          // The descriptor is a WasmGC struct (e.g. an object-literal-valued
          // descriptor in `Object.create(p, { k: descStruct })`). Native
          // Object.defineProperty sees it as null-proto/no-keys and drops every
          // attribute. Materialize a plain descriptor via getField first.
          if (!_isWasmStruct(obj)) {
            const d2 = _toPropertyDescriptorValidate(desc, getField, wrap, hasField);
            Object.defineProperty(obj, key, d2);
            return obj;
          }
          // WasmGC struct obj: apply via sidecar
          const d = _toPropertyDescriptorValidate(desc, getField, wrap, hasField);
          // (#3116) Array exotic receiver: element/length defines apply into
          // the vec itself (§10.4.2) so vec-lane reads observe them.
          if (_vecDefineOwnProperty(obj, key, d, callbackState)) return obj;
          const sDescs = _getSidecarDescs(obj);
          const nKey = _normalizeDescKey(key);
          const existingDesc = _readOwnDescriptor(obj, nKey, callbackState?.getExports());
          const existingVal = _sidecarGet(obj, key);
          const newFlags = _validatePropertyDescriptor(sDescs, nKey, d, existingVal, existingDesc);
          sDescs.set(nKey, newFlags);
          const hasValue = _hasOwn(d, "value");
          const hasGet = _hasOwn(d, "get");
          const hasSet = _hasOwn(d, "set");
          if (hasValue) {
            _sidecarSet(obj, key, d.value);
            // (#2668 Slice A) Keep the typed struct field in sync so a static
            // `struct.get` read of `o.<key>` sees the defined value, not the
            // field's stale initializer.
            _structFieldWriteback(obj, key, d.value, callbackState);
          } else if (!(newFlags & _SC_ACCESSOR) && existingDesc === undefined) _sidecarSet(obj, key, undefined);
          if (hasGet || hasSet) {
            const sc = _wasmStructProps.get(obj) ?? {};
            _wasmStructProps.set(obj, sc);
            if (typeof key === "symbol") {
              let accMap = _wasmStructAccessors.get(obj);
              if (!accMap) {
                accMap = new Map();
                _wasmStructAccessors.set(obj, accMap);
              }
              const prev = accMap.get(key) ?? {};
              accMap.set(key, {
                get: hasGet ? d.get : prev.get,
                set: hasSet ? d.set : prev.set,
              });
              _sidecarSet(obj, key, undefined);
            } else {
              if (key in sc && typeof sc[key] !== "function") delete sc[key];
              if (hasGet) {
                if (d.get === undefined) delete sc[`__get_${key}`];
                else sc[`__get_${key}`] = d.get;
              }
              if (hasSet) {
                if (d.set === undefined) delete sc[`__set_${key}`];
                else sc[`__set_${key}`] = d.set;
              }
              if (!(key in sc)) sc[key] = undefined;
            }
          }
          return obj;
        };
      if (name === "__defineProperty_value")
        return (obj: any, prop: any, value: any, flags: number) => {
          if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
            throw new TypeError("Object.defineProperty called on non-object");
          }
          prop = _toPropertyKey(prop, callbackState); // (#1716) ToPropertyKey on struct key
          const desc: PropertyDescriptor = {};
          if (flags & (1 << 7)) desc.value = _maybeWrapCallableUnknownArity(value, callbackState);
          if (flags & (1 << 3)) desc.writable = !!(flags & 1);
          if (flags & (1 << 4)) desc.enumerable = !!(flags & (1 << 1));
          if (flags & (1 << 5)) desc.configurable = !!(flags & (1 << 2));
          try {
            Object.defineProperty(obj, prop, desc);
          } catch (e) {
            if (e instanceof TypeError) {
              // Distinguish WasmGC "opaque" errors from spec-mandated errors.
              const msg = (e as Error).message || "";
              if (msg.includes("opaque") || msg.includes("WebAssembly")) {
                // (#3116) Array exotic receiver: element/length defines apply
                // into the vec itself (§10.4.2) so vec-lane reads observe them.
                if (_vecDefineOwnProperty(obj, prop, desc, callbackState)) return obj;
                // WasmGC struct — validate against sidecar descriptors, then store.
                // Pass existing sidecar value for SameValue check on non-writable props.
                const sDescs = _getSidecarDescs(obj);
                const nProp = _normalizeDescKey(prop);
                const existingDesc = _readOwnDescriptor(obj, nProp, callbackState?.getExports());
                const existingVal = _sidecarGet(obj, prop);
                const newFlags = _validatePropertyDescriptor(sDescs, nProp, desc, existingVal, existingDesc);
                sDescs.set(nProp, newFlags);
                if (_hasOwn(desc, "value")) {
                  _sidecarSet(obj, prop, desc.value);
                  // (#2668 Slice A) Mirror into the typed struct field for static reads.
                  _structFieldWriteback(obj, prop, desc.value, callbackState);
                } else if (!(newFlags & _SC_ACCESSOR) && existingDesc === undefined) _sidecarSet(obj, prop, undefined);
              } else {
                // Spec-mandated TypeError (non-configurable redefinition on real JS objects)
                throw e;
              }
            } else {
              // Non-TypeError — store value in sidecar
              if (desc.value !== undefined) _sidecarSet(obj, prop, desc.value);
            }
          }
          return obj;
        };
      if (name === "__defineProperty_accessor")
        return (obj: any, prop: any, getter: any, setter: any, flags: number) => {
          if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
            throw new TypeError("Object.defineProperty called on non-object");
          }
          prop = _toPropertyKey(prop, callbackState); // (#1716) ToPropertyKey on struct key
          // (#1382) When the accessor descriptor's `get`/`set` is a Wasm
          // closure struct (not a JS function), wrap it into a JS Function
          // so subsequent property reads/writes invoke through the
          // `__call_fn_<arity>` bridge instead of trapping inside V8 with
          // "getter is not a function". Plain JS functions and undefined
          // values pass through unchanged.
          //   - get: arity-0 (called as `get.call(this)`)
          //   - set: arity-1 (called as `set.call(this, value)`)
          // Note: `this`-binding inside the wrapped accessor is currently
          // dropped (the bridge ignores `this`). Tracked as Phase 2 / a
          // follow-up; accessors that close over their `this` keep the
          // existing accessor-shim path (__make_getter_callback).
          const wrappedGetter = _markAccessorGetterReturn(_maybeWrapCallable(getter, 0, callbackState));
          const wrappedSetter = _maybeWrapCallable(setter, 1, callbackState);
          const desc: PropertyDescriptor = {};
          if (wrappedGetter != null) desc.get = wrappedGetter;
          if (wrappedSetter != null) desc.set = wrappedSetter;
          if (flags & (1 << 4)) desc.enumerable = !!(flags & (1 << 1));
          if (flags & (1 << 5)) desc.configurable = !!(flags & (1 << 2));
          try {
            Object.defineProperty(obj, prop, desc);
          } catch (e) {
            if (e instanceof TypeError) {
              const msg = (e as Error).message || "";
              if (msg.includes("opaque") || msg.includes("WebAssembly")) {
                // (#3116) Array exotic receiver: index-keyed accessor defines
                // route through §10.4.2 so the validation matrix (shrink
                // blocking, redefinition rules) sees them.
                if (_vecDefineOwnProperty(obj, prop, desc, callbackState)) return obj;
                // WasmGC struct — store accessor in sidecar
                const sDescs = _getSidecarDescs(obj);
                const nProp = _normalizeDescKey(prop);
                const existingDesc = _readOwnDescriptor(obj, nProp, callbackState?.getExports());
                const newFlags = _validatePropertyDescriptor(sDescs, nProp, desc, undefined, existingDesc);
                sDescs.set(nProp, newFlags);
                const sc = _wasmStructProps.get(obj) ?? {};
                _wasmStructProps.set(obj, sc);
                if (typeof prop === "symbol") {
                  // Symbol keys can't be used in template literals — use separate accessor map
                  let accMap = _wasmStructAccessors.get(obj);
                  if (!accMap) {
                    accMap = new Map();
                    _wasmStructAccessors.set(obj, accMap);
                  }
                  accMap.set(prop, { get: desc.get, set: desc.set });
                  // Also mark in sidecar so property enumeration knows it exists
                  _sidecarSet(obj, prop, undefined);
                } else {
                  // (#1629 S3) data→accessor flip: if a prior data
                  // `defineProperty` mirrored a plain value into the value
                  // sidecar at `sc[prop]`, it would shadow the new getter —
                  // `_safeGet` consults `_sidecarGet` (which reads `sc[prop]`)
                  // *before* the `__get_<prop>` getter. Drop the stale value so
                  // the accessor wins. (A bare struct field's value lives in the
                  // struct, not `sc`, so this is a no-op in the common case.)
                  if ((desc.get || desc.set) && prop in sc && typeof sc[prop as string] !== "function") {
                    delete sc[prop as string];
                  }
                  if (desc.get) sc[`__get_${prop}`] = desc.get;
                  if (desc.set) sc[`__set_${prop}`] = desc.set;
                  // Mark the property key as "own" for hasOwnProperty checks.
                  // `prop in sc` must be true even though the value is undefined —
                  // _sidecarGet returns undefined which causes _safeGet to fall
                  // through to the getter check (correct). (#929)
                  if (!(prop in sc)) sc[prop as string] = undefined;
                }
              } else {
                throw e;
              }
            }
          }
          return obj;
        };
      if (name === "__defineProperties")
        return function definePropertiesHandler(obj: any, descsObj: any) {
          if (obj == null || (typeof obj !== "object" && typeof obj !== "function")) {
            throw new TypeError("Object.defineProperties called on non-object");
          }
          // (#1712) A WasmGC-struct descriptor map is only readable through
          // the __struct_field_names / __sget_* exports. During the module
          // START function those don't exist yet (WebAssembly.instantiate
          // hasn't returned), which previously made acorn's module-level
          // `Object.defineProperties(Parser.prototype, prototypeAccessors)`
          // a silent no-op (zero keys found). Park the application and let
          // setExports replay it once the instance is wired.
          if (
            descsObj != null &&
            _isWasmStruct(descsObj) &&
            callbackState?.getExports() === undefined &&
            typeof (callbackState as any)?.deferToExports === "function"
          ) {
            (callbackState as any).deferToExports(() => definePropertiesHandler(obj, descsObj));
            return obj;
          }
          // #1362 — §20.1.2.3 step 2: `props = ToObject(Properties)` throws
          // TypeError on null/undefined. Previously the runtime silently
          // returned obj for null/undefined props, masking
          // `Object.defineProperties(o, undefined)` test262 negative tests.
          if (descsObj == null) {
            throw new TypeError("Object.defineProperties: Properties argument cannot be null or undefined");
          }
          // Helper to get keys from plain or opaque objects.
          // #1362 — include Symbol keys per §20.1.2.3 step 3 (uses
          // [[OwnPropertyKeys]] which spans both string and Symbol keys);
          // previously only string keys were enumerated, dropping any
          // Symbol-keyed descriptor entries silently.
          const getKeys = (o: any): (string | symbol)[] => {
            if (_isWasmStruct(o)) {
              const exps = callbackState?.getExports();
              const fieldNames: (string | symbol)[] = _getStructFieldNames(o, exps) ?? [];
              const sc = _wasmStructProps.get(o);
              if (sc) {
                for (const k of Object.keys(sc)) if (!fieldNames.includes(k)) fieldNames.push(k);
                for (const k of Object.getOwnPropertySymbols(sc)) fieldNames.push(k);
              }
              const accMap = _wasmStructAccessors.get(o);
              if (accMap) for (const k of accMap.keys()) if (!fieldNames.includes(k)) fieldNames.push(k);
              return fieldNames;
            }
            // Reflect.ownKeys spans string + symbol keys per spec.
            return Reflect.ownKeys(o);
          };
          // Helper to get a field value from plain or opaque object.
          // Field key may be string or symbol per #1362 (Object.defineProperties
          // spans both per §20.1.2.3 / [[OwnPropertyKeys]]).
          // Own-level presence ONLY (no prototype walk). (#1629) `__sget_*`
          // getters are global per field-name and don't trap on a struct missing
          // the field, so a try/catch probe falsely reports presence — use the
          // concrete struct shape via __struct_field_names instead.
          const ownHasField = (o: any, field: string | symbol): boolean => {
            if (!_isWasmStruct(o)) return field in Object(o);
            const sc = _wasmStructProps.get(o);
            if (sc && field in sc) return true;
            if (typeof field !== "string") return false;
            return _structHasOwnFieldName(o, field, callbackState?.getExports());
          };
          const getField = (o: any, field: string | symbol): any => {
            if (!_isWasmStruct(o)) return o[field];
            // (#2680) ToPropertyDescriptor's Get (§7.3.3) is prototype-inclusive.
            // Resolve an own-level MISS through the descriptor's #1712 fnctor
            // prototype chain (wasmGC-aware) BEFORE the own-level __sget fallback
            // (which returns a spurious ref.null on the instance for a missing
            // field, #1629). Own attributes shadow the prototype per spec.
            if (!ownHasField(o, field)) {
              const pd = _fnctorProtoLookup(o, field, callbackState?.getExports());
              if (pd) return pd.get ? pd.get.call(o) : pd.value;
            }
            const sc = _wasmStructProps.get(o);
            if (sc && field in sc) return sc[field];
            let v = _sidecarGet(o, field);
            if (v === undefined && typeof field === "string") {
              const exps = callbackState?.getExports();
              const g = exps?.[`__sget_${field}`];
              if (typeof g === "function") v = g(o);
            }
            return v;
          };
          const hasField = (o: any, field: string | symbol): boolean => {
            if (ownHasField(o, field)) return true;
            if (!_isWasmStruct(o)) return false;
            // (#2680) own-level miss → prototype-inclusive HasProperty (§7.3.12)
            // via the #1712 link (wasmGC-aware, #1629-safe — never an __sget_*
            // probe).
            return _fnctorProtoLookup(o, field, callbackState?.getExports()) !== undefined;
          };
          // (#1629 S2) When a per-property descriptor is itself a WasmGC struct,
          // its `get`/`set` fields arrive as Wasm-closure structs, not JS
          // callables. Wrap them so ToPropertyDescriptor's spec `typeof ===
          // "function"` checks fire — this is what makes the value+get / value+set
          // "cannot both specify accessors and a value" TypeError detectable in
          // the plural path, matching the single-key __defineProperty handler.
          const wrap = (v: any, arity: number) => _maybeWrapCallable(v, arity, callbackState);
          // If descsObj is a WasmGC struct, native Object.defineProperties sees it as empty
          // and silently no-ops. Apply descriptors directly instead.
          //
          // (#1629 S2) Two-pass per ES §20.1.2.3.1 ObjectDefineProperties:
          // step 4 runs ToPropertyDescriptor for *every* enumerable own key and
          // collects them into a `descriptors` list; step 5 then applies each via
          // DefinePropertyOrThrow. So all input-parsing (ToPropertyDescriptor,
          // which throws on bad shape) happens before *any* mutation — a later
          // key's TypeError must not leave earlier keys installed.
          if (_isWasmStruct(descsObj)) {
            const keys = getKeys(descsObj);
            const isObjWasm = _isWasmStruct(obj);
            const sDescs = isObjWasm ? _getSidecarDescs(obj) : null;
            // Pass 1 — gather + ToPropertyDescriptor for all keys (may throw).
            const gathered: { key: string | symbol; desc: PropertyDescriptor }[] = [];
            for (const key of keys) {
              const rawDesc = getField(descsObj, key as string);
              gathered.push({ key, desc: _toPropertyDescriptorValidate(rawDesc, getField, wrap, hasField) });
            }
            // Pass 2 — apply each (DefinePropertyOrThrow). Validation against an
            // existing non-configurable property may still throw here, matching
            // the spec's step-5 DefinePropertyOrThrow ordering.
            for (const { key, desc } of gathered) {
              if (isObjWasm) {
                // (#3116) Array exotic receiver: element/length defines apply
                // into the vec itself (§10.4.2).
                if (_vecDefineOwnProperty(obj, key, desc, callbackState)) continue;
                const nKey = _normalizeDescKey(key as string);
                const existingDesc2 = _readOwnDescriptor(obj, nKey, callbackState?.getExports());
                const existingVal2 = _sidecarGet(obj, key as string);
                const newFlags = _validatePropertyDescriptor(sDescs!, nKey, desc, existingVal2, existingDesc2);
                sDescs!.set(nKey, newFlags);
                if (_hasOwn(desc, "value")) _sidecarSet(obj, key as string, desc.value);
                else if (!(newFlags & _SC_ACCESSOR) && existingDesc2 === undefined)
                  _sidecarSet(obj, key as string, undefined);
              } else {
                Object.defineProperty(obj, key, desc);
              }
            }
            return obj;
          }
          // (#2837) A host `$Object` descsObj (built by `__new_plain_object`,
          // populated via `__extern_set` — the acorn `prototypeAccessors` idiom)
          // can carry accessor descriptors whose get/set are RAW wasm closures.
          // Native `Object.defineProperties` rejects those ("Getter must be a
          // function"). Route through the manual per-key path that wraps wasm
          // closures to host callables (no-op for real JS functions). Gated on
          // detection so the common host-literal path is byte-identical.
          if (_descsHaveWasmClosureAccessor(descsObj, callbackState)) {
            const keys = getKeys(descsObj);
            const gathered: { key: string | symbol; desc: PropertyDescriptor }[] = [];
            for (const key of keys) {
              const rawDesc = getField(descsObj, key as string);
              gathered.push({ key, desc: _toPropertyDescriptorValidate(rawDesc, getField, wrap, hasField) });
            }
            for (const { key, desc } of gathered) {
              Object.defineProperty(obj, key, desc);
            }
            return obj;
          }
          try {
            Object.defineProperties(obj, descsObj);
          } catch (e) {
            if (e instanceof TypeError) {
              const msg = (e as Error).message || "";
              if (msg.includes("opaque") || msg.includes("WebAssembly")) {
                // Opaque obj or descsObj — validate all descriptors per ECMA-262 10.1
                // ToPropertyDescriptor (throws TypeError on bad shape) before applying.
                const sDescs = _getSidecarDescs(obj);
                const keys = getKeys(descsObj);
                const validated: { key: string | symbol; desc: PropertyDescriptor }[] = [];
                for (const key of keys) {
                  const rawDesc = getField(descsObj, key as string);
                  const desc = _toPropertyDescriptorValidate(rawDesc, getField, wrap, hasField);
                  validated.push({ key: key as string, desc });
                }
                for (const { key, desc } of validated) {
                  // (#3116) Array exotic receiver: element/length defines apply
                  // into the vec itself (§10.4.2).
                  if (_vecDefineOwnProperty(obj, key, desc, callbackState)) continue;
                  const nKey = _normalizeDescKey(key);
                  const existingDesc2 = _readOwnDescriptor(obj, nKey, callbackState?.getExports());
                  const existingVal2 = _sidecarGet(obj, key);
                  const newFlags = _validatePropertyDescriptor(sDescs, nKey, desc, existingVal2, existingDesc2);
                  sDescs.set(nKey, newFlags);
                  if (_hasOwn(desc, "value")) _sidecarSet(obj, key, desc.value);
                  else if (!(newFlags & _SC_ACCESSOR) && existingDesc2 === undefined) _sidecarSet(obj, key, undefined);
                }
              } else {
                // Spec-mandated TypeError on real JS objects
                throw e;
              }
            } else {
              // Non-TypeError — apply via sidecar
              const keys = getKeys(descsObj);
              for (const key of keys) {
                const rawDesc = getField(descsObj, key as string);
                if (rawDesc && typeof rawDesc === "object") {
                  const val = getField(rawDesc, "value");
                  if (val !== undefined) _sidecarSet(obj, key as string, val);
                }
              }
            }
          }
          return obj;
        };
      if (name === "__getOwnPropertyDescriptor")
        return (obj: any, prop: any) => {
          if (obj == null) return undefined;
          prop = _toPropertyKey(prop, callbackState); // (#1716) ToPropertyKey on struct key
          // Non-WasmGC objects: native JS handles it
          if (!_isWasmStruct(obj)) {
            return Object.getOwnPropertyDescriptor(obj, prop);
          }
          // (#1629 S1) WasmGC struct: single canonical read-back path, shared
          // with Object.getOwnPropertyDescriptors.
          const desc = _readOwnDescriptor(obj, prop, callbackState?.getExports());
          // (#4371) A declared class static is stored as its raw Wasm closure
          // so compiled reads/calls stay in the existing closure ABI. A
          // descriptor object, however, is an ordinary host object; expose its
          // `value` with the same callable JS wrapper a normal property read
          // would produce. This preserves the public `typeof desc.value ===
          // "function"` contract without replacing the canonical sidecar
          // value (which the in-Wasm extracted-call path needs).
          if (desc && "value" in desc) {
            const staticMethods = _staticMethodNames.get(obj);
            if (staticMethods?.includes(String(prop))) {
              // Reuse the canonical class-object proxy read. Besides the
              // generic __is_closure route, it has the per-name
              // `__call_<method>` bridge needed by modules whose only closure
              // value is this static and therefore do not export a generic
              // closure discriminator.
              const wrapped = _wrapForHost(obj, callbackState?.getExports());
              const callable = wrapped?.[prop];
              desc.value = typeof callable === "function" ? callable : _getClassMethodBridge(obj, String(prop));
            } else {
              desc.value = _maybeWrapCallableUnknownArity(desc.value, callbackState);
            }
          }
          return desc;
        };
      if (name === "__getOwnPropertyNames")
        return (obj: any) => {
          // ES §20.1.2.10 Object.getOwnPropertyNames → ToObject (§7.1.18) throws on null/undefined.
          if (obj == null) throw new TypeError(`Cannot convert ${obj === null ? "null" : "undefined"} to object`);
          if (!_isWasmStruct(obj)) return Object.getOwnPropertyNames(obj);
          const exports = callbackState?.getExports();
          // #1047 — registered class prototype: return only the allowlist
          // (filtered through the #1364b deletion set).
          const protoMethods = _prototypeMethodNames.get(obj);
          if (protoMethods !== undefined) {
            const names = protoMethods.filter((n) => !_isDeletedClassProp(obj, n));
            const sc = _wasmStructProps.get(obj);
            if (sc) {
              for (const k of Object.getOwnPropertyNames(sc)) {
                if (k.startsWith("__get_") || k.startsWith("__set_")) continue;
                if (!names.includes(k)) names.push(k);
              }
            }
            return names;
          }
          // (#1395) Class-object receiver: return the static-method allowlist
          // (filtered through the #1364b deletion set).
          const staticMethods = _staticMethodNames.get(obj);
          if (staticMethods !== undefined) {
            const names = staticMethods.filter((n) => !_isDeletedClassProp(obj, n));
            const sc = _wasmStructProps.get(obj);
            if (sc) {
              for (const k of Object.getOwnPropertyNames(sc)) {
                if (k.startsWith("__get_") || k.startsWith("__set_")) continue;
                if (!names.includes(k)) names.push(k);
              }
            }
            return names;
          }
          const fieldNames: string[] = _getStructFieldNames(obj, exports) ?? [];
          // Also include sidecar property names (string keys only)
          // Filter out internal accessor keys (__get_<prop>, __set_<prop>) stored by
          // __defineProperty_accessor — these are implementation artifacts, not own property names.
          // The real property name (without prefix) is stored separately when the sidecar is set. (#929)
          const sc = _wasmStructProps.get(obj);
          if (sc) {
            for (const k of Object.getOwnPropertyNames(sc)) {
              if (k.startsWith("__get_") || k.startsWith("__set_")) continue;
              if (!fieldNames.includes(k)) fieldNames.push(k);
            }
          }
          // Also include any native JS properties added directly to the WasmGC object
          // (V8 allows Object.defineProperty on WasmGC structs as JS objects)
          try {
            for (const k of Object.getOwnPropertyNames(obj)) {
              if (!fieldNames.includes(k)) fieldNames.push(k);
            }
          } catch {
            // ignore if not enumerable on this object
          }
          return fieldNames;
        };
      if (name === "__getOwnPropertySymbols")
        return (obj: any) => {
          if (!_isWasmStruct(obj)) return Object.getOwnPropertySymbols(obj);
          const sc = _wasmStructProps.get(obj);
          return sc ? Object.getOwnPropertySymbols(sc) : [];
        };
      if (name === "__getPrototypeOf")
        return (obj: any) => {
          // (#1462) ES2015+ §19.1.2.9: Object.getPrototypeOf(O) performs
          // ToObject(O) first, which throws TypeError on null/undefined.
          // Primitives box to wrapper objects whose prototype is the
          // matching built-in (Number.prototype, String.prototype, …).
          if (obj === null) throw new TypeError("Cannot convert null to object");
          if (obj === undefined) throw new TypeError("Cannot convert undefined to object");
          // (#2743 a) A registered arguments object's `[[Prototype]]` is
          // %Object.prototype% (§10.4.4). The opaque vec's native prototype is
          // null, so map it to the host realm's Object.prototype — the same
          // identity `Object.getPrototypeOf({})` returns.
          if (obj != null && typeof obj === "object" && _argumentsObjects.has(obj)) {
            return Object.prototype;
          }
          try {
            return Object.getPrototypeOf(obj);
          } catch (e) {
            // #2617 — for a user Proxy, the host engine's §10.5.1 invariant
            // (getPrototypeOf trap result must be Object|null; trap may also
            // throw) is exactly what the program must observe. Propagate it
            // instead of coercing to null. Non-proxy opaque structs keep the
            // null fallback (their getPrototypeOf is genuinely absent).
            _rethrowIfProxyOrRevoked(e, obj);
            return null;
          }
        };
      // (#1516) `Object.getPrototypeOf(generatorFunc)` must return
      // `%GeneratorFunction.prototype%` (= `%Generator%`) whose `.prototype` is
      // `%GeneratorPrototype%`. The compiled-Wasm closure that backs a `function*`
      // declaration is opaque to the host, so codegen routes the well-typed
      // call site `Object.getPrototypeOf(g)` (where `g ∈ ctx.generatorFunctions`)
      // through this dedicated import instead of the generic `__getPrototypeOf`.
      if (name === "__get_generator_function_prototype") return () => _getGeneratorFunctionPrototype();
      if (name === "__get_async_generator_function_prototype") return () => _getAsyncGeneratorFunctionPrototype();
      // (#1639) `g.prototype` (member access on a generator-function object).
      // Spec §27.3.3 / §27.4.3: a (async) generator function's `.prototype` is a
      // *fresh per-function object* whose [[Prototype]] is %(Async)GeneratorPrototype%
      // — NOT the shared prototype itself. So tests walk:
      //   getPrototypeOf(g.prototype)              → %(Async)GeneratorPrototype%
      //   getPrototypeOf(getPrototypeOf(g.prototype)) → %(Async)IteratorPrototype%
      // The per-function object is cached so repeated reads of `g.prototype`
      // return the same identity. The compiled closure is opaque to the host,
      // so codegen routes the member access `g.prototype`
      // (g ∈ ctx.generatorFunctions) through this import.
      if (name === "__get_generator_prototype") return () => _getGeneratorInstancePrototype();
      if (name === "__get_async_generator_prototype") return () => _getAsyncGeneratorInstancePrototype();
      // __create_descriptor(value, flags) → {value, writable, enumerable, configurable}
      // flags: bit 0 = writable, bit 1 = enumerable, bit 2 = configurable
      if (name === "__create_descriptor")
        return (value: any, flags: number) => {
          return {
            value,
            writable: !!(flags & 1),
            enumerable: !!(flags & 2),
            configurable: !!(flags & 4),
          };
        };
      // Tagged template support: JS array builder and tagged template caller
      if (name === "__js_array_new") return () => [];
      if (name === "__js_array_push")
        return (arr: any[], val: any) => {
          _intrinsicReflectDefineProperty(arr, arr.length, {
            value: val,
            writable: true,
            enumerable: true,
            configurable: true,
          });
        };
      // isPrototypeOf: check if obj is in the prototype chain of candidate (#799)
      if (name === "__isPrototypeOf")
        return (obj: any, candidate: any): number => {
          if (obj == null) return 0;
          try {
            return Object.prototype.isPrototypeOf.call(obj, candidate) ? 1 : 0;
          } catch {
            return 0;
          }
        };
      // #1064: record DataView subview metadata (byteOffset, byteLength) on
      // the backing vec struct so the __extern_method_call DataView fallback
      // can build a correctly-windowed native DataView. A NaN `length` means
      // "use bufferByteLength - offset at dispatch time" (set by codegen when
      // the buffer arg is externref-typed and its length isn't known statically).
      if (name === "__dv_register_view")
        return (buf: any, offset: number, length: number) => {
          if (buf != null && typeof buf === "object") {
            const off = Number.isFinite(offset) ? (offset as number) | 0 : 0;
            const len = Number.isFinite(length) ? (length as number) | 0 : -1;
            _dvViewMeta.set(buf, { offset: off, length: len });
          }
        };
      // #3062: `DataView.prototype.byteLength` / `byteOffset` accessor value in
      // JS-host mode. In host mode a `new DataView(buffer, offset, length)`
      // returns the raw i32_byte buffer struct (no `$__dv_window` wrapper — that
      // shape is standalone-only); the view window is recorded out-of-band in
      // `_dvViewMeta` by `__dv_register_view` above. `dv.byteLength` /
      // `dv.byteOffset` would otherwise fall through to `__extern_get(struct,
      // "byteLength")` → undefined → NaN. Read the recorded window here.
      //   sel === 0 → byteOffset (meta.offset, or 0 if unregistered)
      //   sel !== 0 → byteLength (meta.length when concrete, else the
      //               `length === -1` NaN sentinel: bufferByteLength − offset).
      if (name === "__dv_view_byte_attr")
        return (view: any, sel: number): number => {
          if (view == null || typeof view !== "object") return 0;
          const meta = _dvViewMeta.get(view);
          const viewOffset = meta ? meta.offset : 0;
          if (sel === 0) return viewOffset;
          if (meta && meta.length >= 0) return meta.length;
          // Default-length view (length sentinel −1): windowed byteLength is the
          // remaining buffer past the offset. `__dv_byte_len` reads the backing
          // i32_byte vec's field-0 (byte count), or −1 if the struct isn't one.
          // Resolve exports FRESH at call time (the outer `exports` binding is
          // captured at buildImports time, before instantiation → undefined).
          const dvLen = callbackState?.getExports()?.__dv_byte_len as ((v: any) => number) | undefined;
          const bufLen = typeof dvLen === "function" ? dvLen(view) : 0;
          return bufLen >= 0 ? Math.max(0, bufLen - viewOffset) : 0;
        };
      // #1515: mark an ArrayBuffer-shaped wasmGC struct as detached. Invoked
      // by the `$DETACHBUFFER` test262 harness shim and from `transfer()`.
      // Subsequent DataView/TypedArray ops on the buffer throw TypeError.
      if (name === "__detach_buffer")
        return (buf: any): void => {
          if (buf != null && typeof buf === "object") {
            _detachedBuffers.add(buf);
            // (#3097) Propagate the detach to the canonical host ArrayBuffer
            // (if the buffer already crossed the construct bridge) so host
            // TypedArray/DataView views observe the detach and throw per spec.
            // A genuine host ArrayBuffer arg detaches natively for the same
            // reason.
            const hostAb = buf instanceof ArrayBuffer ? buf : _abHostBufferCache.get(buf);
            if (hostAb !== undefined) {
              try {
                (hostAb as { transfer?: () => ArrayBuffer }).transfer?.();
              } catch {
                /* engine without ArrayBuffer.prototype.transfer */
              }
            }
          }
        };
      // #1515: query whether a buffer is detached. Returns 1 if detached, 0 otherwise.
      if (name === "__is_detached_buffer")
        return (buf: any): number => {
          if (buf != null && typeof buf === "object" && _detachedBuffers.has(buf)) return 1;
          return 0;
        };
      if (name === "__extern_method_call")
        return (obj: any, method: string, args: any[]) => {
          if (obj == null) throw new TypeError("Cannot read properties of null (reading '" + method + "')");
          const primitive = wsh.tryPrimitiveStringMethod(obj, method, args, _isWasmStruct, _reflectApply);
          if (primitive !== undefined) return primitive === wsh.PRIMITIVE_STRING_UNDEFINED ? undefined : primitive;
          const exports = callbackState?.getExports();
          const wrapHostValue = (v: any): any => {
            if (!_isWasmStruct(v)) return v;
            const callable = _maybeWrapCallableUnknownArity(v, callbackState);
            return callable !== v ? callable : _wrapForHost(v, exports);
          };
          const wrappedObj = wrapHostValue(obj);
          const wrappedArgs = (args ?? []).map(wrapHostValue);
          const dateResult = tryCallWasmDateHostMethod(obj, method, wrappedArgs, exports, _isWasmStruct);
          if (dateResult !== DATE_HOST_METHOD_UNHANDLED) return dateResult;
          // Wrap callback slots before native method dispatch (#1382).
          {
            const slot = _PROTO_CB_SLOTS[method];
            if (slot && wrappedArgs.length > slot.argIdx) {
              wrappedArgs[slot.argIdx] = _maybeWrapCallable(wrappedArgs[slot.argIdx], slot.arity, callbackState);
            }
          }
          // Iterator helpers consume a host-visible iterator record (#3049).
          if ((method === "call" || method === "apply") && _isIteratorHelperFn(wrappedObj) && (args ?? []).length > 0) {
            wrappedArgs[0] = _iteratorRecordForHost(args[0], callbackState);
          }
          // #1637 — `Boolean.prototype.toString.call(prim)` / `.valueOf.call(prim)`
          // route here as obj=Boolean.prototype.method, method="call"/"apply".
          // Boolean primitives travel i32→externref via __box_number so the
          // receiver arrives as a number; §20.3.3.{2,3} thisBooleanValue accepts
          // a Boolean primitive or wrapper, so coerce a numeric/bigint receiver
          // back to a boolean primitive before the native method runs (V8 would
          // otherwise throw "requires that 'this' be a Boolean"). Mirrors the
          // __proto_method_call coercion (#1342) for the .call/.apply path.
          if (
            (method === "call" || method === "apply") &&
            (wrappedObj === Boolean.prototype.toString || wrappedObj === Boolean.prototype.valueOf)
          ) {
            const coerceRecv = (r: any) => (typeof r === "number" || typeof r === "bigint" ? Boolean(r) : r);
            if (method === "call") {
              if (wrappedArgs.length > 0) wrappedArgs[0] = coerceRecv(wrappedArgs[0]);
            } else if (method === "apply") {
              // apply(thisArg, argsArray): the receiver is arg 0.
              if (wrappedArgs.length > 0) wrappedArgs[0] = coerceRecv(wrappedArgs[0]);
            }
          }
          // (#1320) `Array.from.call(thisArg, items)` / `.apply(thisArg, [items])`
          // routes here with obj=Array.from. When `items` is a plain JS object
          // whose own @@iterator is a Wasm closure (typeof "object"), native
          // Array.from rejects it ("items[Symbol.iterator] … must be a
          // function"). Pre-drain the closure-backed iterator to a real array so
          // the native call sees an array-like it can iterate. The custom
          // `thisArg` constructor receiver is preserved (arg 0 of call/apply).
          if (
            (method === "call" || method === "apply") &&
            (wrappedObj === Array.from || wrappedObj === (Array as { of?: unknown }).of)
          ) {
            // call(thisArg, items)  → items at wrappedArgs[1]
            // apply(thisArg, [items]) → items at wrappedArgs[1][0]
            if (method === "call" && wrappedArgs.length > 1) {
              const drained = _drainWasmClosureIterable(wrappedArgs[1], callbackState);
              if (drained !== null) wrappedArgs[1] = drained;
            } else if (method === "apply" && Array.isArray(wrappedArgs[1]) && wrappedArgs[1].length > 0) {
              const drained = _drainWasmClosureIterable(wrappedArgs[1][0], callbackState);
              if (drained !== null) wrappedArgs[1] = [drained, ...wrappedArgs[1].slice(1)];
            }
          }
          // (#2802/#1712) Intercept vec push/pop BEFORE `wrappedObj[method]`.
          // `_wrapForHost` exposes a real Array facade, so generic lookup finds
          // Array.prototype.push/pop and mutates only that materialized mirror;
          // the existing not-a-function fallback below is then unreachable.
          const vecMutation = _tryWasmVecMutation(obj, method, args, exports);
          if (vecMutation.handled) return vecMutation.value;

          const fn = wrappedObj[method];
          // (#1320) Some chained `Array.from.call(C, items)` shapes lower as a
          // generic `method="from"` dispatch on `Array`. Drain Wasm-closure
          // iterables before the native Array.from performs GetMethod(items,
          // @@iterator), while preserving the native receiver.
          if (method === "from" && fn === Array.from && wrappedArgs.length > 0) {
            const callArgs = wrappedArgs.slice();
            const drained = _drainWasmClosureIterable(callArgs[0], callbackState);
            if (drained !== null) callArgs[0] = drained;
            const ret = (Array.from as (...xs: any[]) => any).apply(wrappedObj, callArgs);
            return ret === wrappedObj ? obj : _unwrapForHost(ret);
          }
          if (typeof fn !== "function") {
            const resolvedClassMethod = _invokeClassMethod(obj, method, exports, wrappedObj, wrappedArgs);
            if (resolvedClassMethod !== _MISS) return resolvedClassMethod;
            // A struct proxy can have been materialized during the module start
            // function, before setInstance() made generated __sget_* exports
            // available. Its cached host view may therefore miss a physical
            // closure field even though the current export view can read it.
            // Recover only on the existing non-callable path and require the
            // resolved value to pass the closure discriminator before calling.
            if (_isWasmStruct(obj)) {
              const rawMethod = _resolveHostField(obj, method, exports);
              const resolved = _maybeWrapCallableUnknownArity(_unwrapForHost(rawMethod), callbackState);
              if (typeof resolved === "function") {
                const ret = resolved.apply(obj, wrappedArgs);
                return ret === obj || ret === wrappedObj ? obj : _unwrapForHost(ret);
              }
            }
            // (#4149) Sibling case of the recovery above, and NOT covered by
            // it: here the field READ succeeded — `fn` is the stored value —
            // but it is a RAW closure struct rather than a callable. A closure
            // stored via __extern_set/__extern_set_strict while the module's
            // `start` was still running (module_init runs inside
            // WebAssembly.instantiate, BEFORE setInstance wires callbackState)
            // was saved unwrapped, because _maybeWrapCallableUnknownArity had
            // no exports to consult at store time. The alias-write shape
            // (`e.f = function…; m.exports.f()`) hits exactly this, including
            // when `obj` is not itself a wasm struct so the arm above never
            // ran. Wrap it lazily at call time, when exports ARE reachable.
            if (_isWasmStruct(fn)) {
              const resolved = _maybeWrapCallableUnknownArity(fn, callbackState);
              if (typeof resolved === "function") {
                const ret = resolved.apply(wrappedObj, wrappedArgs);
                return ret === obj || ret === wrappedObj ? obj : _unwrapForHost(ret);
              }
            }
            // (#1712) Static method on a callable closure struct (function-style
            // constructor): `wrapHostValue` wrapped the receiver into a bare JS
            // function bridge (`_wrapWasmClosureUnknownArity`), which has no view
            // of sidecar statics — `Parser.parse = function …` lands in the
            // struct's sidecar via __extern_set. Resolve the method through
            // `_safeGet` on the RAW struct (sidecar → accessors → vivified
            // fnctor prototype) and dispatch with the raw closure struct as the
            // receiver so `this` inside the static body (acorn's
            // `Parser.parse = function(i,o){ return new this(o,i).parse() }`)
            // observes the constructor closure.
            if (typeof wrappedObj === "function" && _isWasmStruct(obj)) {
              const resolved = _maybeWrapCallableUnknownArity(_safeGet(obj, method, callbackState), callbackState);
              if (typeof resolved === "function") {
                const ret = resolved.apply(obj, wrappedArgs);
                return ret === obj || ret === wrappedObj ? obj : _unwrapForHost(ret);
              }
            }
            // (#2628) Prototype method on a `__construct_closure`-built instance.
            // The construct trap returns a PLAIN JS object (not a wasm struct)
            // whose method values live on the constructor closure's vivified
            // prototype as RAW closure structs (`Parser.prototype.m = fn`), so
            // the native `wrappedObj[method]` read above yielded a non-callable
            // raw struct. The trap registered the instance in
            // `_fnctorInstanceCtor`, so resolve the method through
            // `_fnctorProtoLookup` (which walks the vivified prototype chain),
            // wrap it into a callable, and dispatch with the instance as `this`.
            // This is what makes `new this(...).m()` resolve like the
            // identifier-constructed `new Parser(...).m()` path does.
            {
              const protoDesc = _fnctorProtoLookup(obj, method);
              if (protoDesc) {
                const resolved = protoDesc.get
                  ? protoDesc.get.call(obj)
                  : _maybeWrapCallableUnknownArity(protoDesc.value, callbackState);
                if (typeof resolved === "function") {
                  const ret = resolved.apply(obj, wrappedArgs);
                  return ret === obj ? obj : _unwrapForHost(ret);
                }
              }
            }
            // (#1712) Read-only Array methods on WasmGC vec structs. Mutators
            // are intercepted before generic host lookup above; otherwise the
            // Array facade's native push/pop would mutate only a JS mirror.
            {
              // The receiver may be a _wrapForHost proxy (the field read that
              // produced it wrapped the struct for host visibility) — unwrap
              // to the raw vec struct before the export round-trip.
              let rawVec = _unwrapForHost(obj);
              // A vec struct whose canonicalized layout collides with a
              // closure capture struct false-positives __is_closure, so
              // wrapHostValue wrapped it into a callable bridge — reverse
              // that through the wrapper→closure map.
              if (typeof rawVec === "function") {
                const wrapperTarget = _wasmClosureWrapperTargets.get(rawVec);
                if (wrapperTarget) rawVec = wrapperTarget;
              }
              if (_isWasmStruct(rawVec) && exports) {
                // (#2794) Read-only, primitive-returning Array methods on an
                // opaque vec receiver (e.g. acorn `declareName`'s
                // `scope.lexical.indexOf(name)`). `__vec_mut_supported` gates only
                // push/pop; reads just need `__vec_len`/`__vec_get`. Confirm it is
                // genuinely a vec via the POSITIVE `__is_vec` discriminator, then
                // materialize to a real JS array and apply the native method.
                if (
                  _VEC_PRIMITIVE_READ_METHODS.has(method) &&
                  typeof exports.__vec_len === "function" &&
                  typeof exports.__vec_get === "function"
                ) {
                  const isVecFn = exports.__is_vec as ((v: any) => number) | undefined;
                  let isVec = false;
                  try {
                    isVec = typeof isVecFn === "function" && isVecFn(rawVec) === 1;
                  } catch {
                    isVec = false;
                  }
                  if (isVec) {
                    const len = (exports.__vec_len as (v: any) => number)(rawVec);
                    if (typeof len === "number" && len >= 0) {
                      const getFn = exports.__vec_get as (v: any, i: number) => any;
                      const arr = new Array(len);
                      for (let i = 0; i < len; i++) arr[i] = wrapHostValue(getFn(rawVec, i));
                      const nativeFn = (Array.prototype as Record<string, any>)[method];
                      if (typeof nativeFn === "function") {
                        return nativeFn.apply(arr, wrappedArgs);
                      }
                    }
                  }
                }
              }
            }
            // (#837) Map/WeakMap upsert proposal polyfill — Node 25 / V8
            // currently don't ship `getOrInsert` / `getOrInsertComputed`
            // (TC39 Stage 3). Implement the spec algorithm here so the
            // host imports work without runtime support. Falls through if
            // the receiver isn't a Map/WeakMap.
            //
            // Spec ordering matters: callback validation (`getOrInsertComputed`)
            // must run BEFORE any key handling, otherwise WeakMap with a
            // primitive key throws the wrong error first. test262
            // `not-a-function-callbackfn-throws.js` and
            // `throw-if-key-cannot-be-held-weakly.js` both pin this order.
            if (
              (method === "getOrInsert" || method === "getOrInsertComputed") &&
              (wrappedObj instanceof Map || wrappedObj instanceof WeakMap)
            ) {
              // (#1438) Wrap a wasm closure callback so `typeof` checks pass
              // and `Call(callback, undefined, [key])` dispatches into Wasm.
              let callback = wrappedArgs[1];
              if (method === "getOrInsertComputed") {
                if (callback != null && typeof callback !== "function" && _isWasmStruct(callback)) {
                  const wrapped = _wrapWasmClosure(callback, 1, callbackState);
                  if (wrapped) callback = wrapped;
                }
                if (typeof callback !== "function") {
                  throw new TypeError("Map.prototype.getOrInsertComputed: callbackfn is not callable");
                }
              }
              const key = wrappedArgs[0];
              // (#1438) Symbol keys are valid WeakMap keys per ES2023
              // (CanBeHeldWeakly accepts symbols that are not registered).
              if (
                wrappedObj instanceof WeakMap &&
                (key === null ||
                  key === undefined ||
                  (typeof key !== "object" && typeof key !== "function" && typeof key !== "symbol"))
              ) {
                throw new TypeError("Invalid value used as weak map key");
              }
              if (wrappedObj.has(key)) {
                return _unwrapForHost(wrappedObj.get(key));
              }
              const value =
                method === "getOrInsertComputed"
                  ? (callback as (k: unknown) => unknown).call(undefined, key)
                  : wrappedArgs[1];
              wrappedObj.set(key, value);
              return _unwrapForHost(value);
            }
            // (#3058) ArrayBuffer.prototype.resize on a compiled-AB vec struct
            // (the host-lane arm of the #3054-C resizable machinery). Handles
            // BOTH statically-typed and `any`-typed receivers — the static path
            // also lands here because the vec struct is opaque to the host.
            if (method === "resize" && _isWasmStruct(obj) && exports) {
              if (_abResizeStruct(obj, wrappedArgs[0], exports)) return undefined;
            }
            // DataView method fallback (#1056): the compiler emits DataView as an
            // i32_byte vec struct, so DataView.prototype methods aren't directly
            // callable on the wasmGC receiver. Detect the method pattern and
            // dispatch via a live Uint8Array view onto the struct's byte backing
            // store (__dv_byte_{len,get,set} exports).
            const dvMatch =
              typeof method === "string" &&
              /^(get|set)(Uint8|Int8|Uint16|Int16|Uint32|Int32|Float16|Float32|Float64|BigInt64|BigUint64)$/.exec(
                method,
              );
            if (dvMatch && _isWasmStruct(obj) && exports) {
              // #1515: spec §25.3.1.* SetViewValue/GetViewValue step 5 — if the
              // underlying buffer is detached, throw TypeError BEFORE any other
              // validation. Note: `obj` here is the DataView's backing vec
              // struct (which is also the buffer struct under our representation).
              // The detached state can be set by `$DETACHBUFFER` (test262 harness)
              // via either the WeakSet (host-import path) or a sidecar property
              // (user-land assignment path).
              if (_detachedBuffers.has(obj) || _sidecarGet(obj, "__detached__")) {
                throw new TypeError("Attempted to access detached ArrayBuffer");
              }
              const dvLen = exports.__dv_byte_len as ((v: any) => number) | undefined;
              const dvGet = exports.__dv_byte_get as ((v: any, i: number) => number) | undefined;
              const dvSet = exports.__dv_byte_set as ((v: any, i: number, b: number) => void) | undefined;
              if (typeof dvLen === "function" && typeof dvGet === "function") {
                const bufLen = dvLen(obj);
                if (bufLen >= 0) {
                  // #1064: honor the view window recorded by __dv_register_view
                  // at construction. Without this, getXxx/setXxx operate on the
                  // full backing buffer and out-of-range errors don't fire.
                  const meta = _dvViewMeta.get(obj);
                  const viewOffset = meta ? meta.offset : 0;
                  const viewLength = meta && meta.length >= 0 ? meta.length : bufLen - viewOffset;
                  const bytes = new Uint8Array(bufLen);
                  for (let i = 0; i < bufLen; i++) bytes[i] = dvGet(obj, i) & 0xff;
                  // `new DataView(buf, offset, length)` validates bounds; if
                  // meta is stale/inconsistent this may throw TypeError which
                  // the Wasm caller can catch via the standard exn bridge.
                  const realDv = new DataView(bytes.buffer, viewOffset, viewLength);
                  const nativeFn = (realDv as any)[method];
                  if (typeof nativeFn === "function") {
                    // #1525 — args may include wasmGC structs whose `valueOf` /
                    // `toString` live in opaque struct fields. V8's native
                    // DataView setter runs ToIndex/ToNumber on the args, which
                    // calls ToPrimitive. Use `wrappedArgs` (built above) so
                    // the proxy `get` trap exposes those methods as callable
                    // JS functions; otherwise V8 throws "Cannot convert object
                    // to primitive value" before walking valueOf/toString.
                    // #1515: BigInt setters require the value (2nd arg) to be
                    // a BigInt per spec §25.3.1.16/.17 step 8 — coerce numeric
                    // values via ToBigInt to match. The native setter would
                    // otherwise throw with the wrong error shape.
                    let callArgs = wrappedArgs ?? [];
                    if (dvMatch[1] === "set" && (dvMatch[2] === "BigInt64" || dvMatch[2] === "BigUint64")) {
                      const v = callArgs[1];
                      if (typeof v !== "bigint" && v !== undefined) {
                        // ToBigInt: Number → BigInt only for safe integers, else throws.
                        if (typeof v === "number") {
                          if (!Number.isInteger(v) || !Number.isFinite(v)) {
                            throw new RangeError("The number " + v + " cannot be converted to a BigInt");
                          }
                          callArgs = callArgs.slice();
                          callArgs[1] = BigInt(v);
                        } else if (typeof v === "boolean") {
                          callArgs = callArgs.slice();
                          callArgs[1] = v ? 1n : 0n;
                        } else if (typeof v === "string") {
                          callArgs = callArgs.slice();
                          callArgs[1] = BigInt(v); // throws SyntaxError if invalid
                        } else if (typeof v === "object" && v !== null) {
                          // Object → ToPrimitive(number) → ToBigInt. Let native handle this.
                          // Leave as-is; native setBigInt64 will run ToBigInt itself
                          // (the Proxy wrapper exposes valueOf/toString on wasmGC structs).
                        } else {
                          // null/undefined/symbol → TypeError per spec.
                          throw new TypeError("Cannot convert " + (v === null ? "null" : typeof v) + " to a BigInt");
                        }
                      }
                    }
                    const result = nativeFn.apply(realDv, callArgs);
                    if (dvMatch[1] === "set" && typeof dvSet === "function") {
                      const endByte = viewOffset + viewLength;
                      for (let i = viewOffset; i < endByte; i++) dvSet(obj, i, bytes[i]!);
                    }
                    // #1515: setters return undefined per spec.
                    if (dvMatch[1] === "set") return undefined;
                    return result;
                  }
                }
              }
            }
            throw new TypeError(method + " is not a function");
          }
          // (#3049) Direct helper-method dispatch (`iter.map(cb)` on an
          // externref/any receiver): shim the RECEIVER as a faithful iterator
          // record (see _iteratorRecordForHost) so the native/polyfill helper
          // can drive a compiled iterator.
          const dispatchRecv = _isIteratorHelperFn(fn) ? _iteratorRecordForHost(obj, callbackState) : wrappedObj;
          // (#3603 S1) `Array.prototype.push.call(vec, x)` arrives as obj=push,
          // method="call", args[0]=the vec's `__make_iterable` mirror — bracket
          // the dispatch so the mutation reaches the vec (silent no-op before).
          const mirrorSnaps = snapshotVecMirrors(dispatchRecv, wrappedArgs, exports);
          const ret = fn.apply(dispatchRecv, wrappedArgs);
          reconcileVecMirrors(mirrorSnaps, exports, _unwrapForHost);
          // (#1333) Annex B — RegExp.prototype.exec/test post-match slot update.
          if (
            (method === "exec" || method === "test") &&
            wrappedObj instanceof RegExp &&
            typeof wrappedArgs[0] === "string"
          ) {
            const input = wrappedArgs[0] as string;
            if (method === "exec" && ret != null) {
              _updateLegacyRegExpState(input, ret as RegExpExecArray, instanceState?.legacyRegExpState);
            } else if (method === "test" && ret === true) {
              try {
                const clone = new RegExp(wrappedObj.source, wrappedObj.flags.replace(/[gy]/g, ""));
                const m2 = clone.exec(input);
                if (m2) _updateLegacyRegExpState(input, m2, instanceState?.legacyRegExpState);
              } catch {
                // ignore
              }
            }
          }
          return ret === wrappedObj || ret === dispatchRecv ? obj : _unwrapForHost(ret);
        };
      // (#1439) RegExp.prototype[@@replace/@@match/@@search/@@split/@@matchAll]
      // protocol invocation. The compiler resolves `regex[Symbol.replace]` to
      // an `i32.const 8` (well-known symbol ID), so a direct call would
      // null-deref since RegExp is an externref (not a WasmGC struct) and
      // no Wasm function corresponds to the symbol key. Route the call
      // here: look up the symbol from `_symbolIdToKeys` and invoke
      // `regex[Symbol.X](arg0[, arg1])`. Wasm closures (the replaceValue
      // function arg of @@replace) are wrapped via `_wrapWasmClosure` so
      // V8's RegExp protocol can call them as regular JS functions.
      // Signature: (regex, symbolId, arg0, arg1) -> externref.
      if (name === "__regex_symbol_call")
        return (regex: any, symbolId: number, arg0: any, arg1: any): any => {
          if (regex == null) {
            throw new TypeError("Cannot read properties of " + (regex === null ? "null" : "undefined"));
          }
          const entry = _symbolIdToKeys.get(symbolId);
          if (!entry) return undefined;
          const sym = entry.sym;
          const fn = regex[sym];
          if (typeof fn !== "function") {
            throw new TypeError("regex[" + entry.wasm + "] is not a function");
          }
          // Unwrap any wasm closure / wasmGC struct args for callbacks &
          // ToPrimitive coercion (e.g. @@replace fn, custom toString objects).
          const exports = callbackState?.getExports();
          // Wrap a wasmGC arg into a JS-callable function when it's a
          // closure, OR into a property-exposing proxy when it's a regular
          // struct. Tries multiple arities for closures since the user
          // function may declare 1–4 params (replace callback spec passes
          // (match, ...captures, offset, string)).
          //
          // (#1329-b3) The wrapping callable also routes the closure's
          // RETURN value through `_wrapForHost` when it comes back as a
          // wasmGC struct. V8's @@replace then performs `ToString` on the
          // returned value (spec §22.2.5.8 step 14.k.vi — `replacement =
          // ToString(replValue)`); without the host proxy the engine sees
          // an opaque WebAssembly object and throws "Cannot convert object
          // to primitive value". The proxy exposes the struct's
          // `toString`/`valueOf` closure fields as callable, matching the
          // same `_wrapForHost` treatment we already apply to wasm-struct
          // args via `wrappedArg0`.
          const wrapCallable = (a: any): any => {
            if (a == null) return a;
            if (!_isWasmStruct(a)) return a;
            // Try arities 4 → 1; pick the first emitted dispatcher.
            const exps = callbackState?.getExports();
            // (#3051 Slice 2) A non-callable DATA struct passed as the second
            // @@replace/@@split arg — `re[@@replace]("s", {toString(){…}})` /
            // `re[@@split]("s", {valueOf(){…}})` — must NOT be wrapped as a
            // callable. §22.2.6.11 does `IsCallable(replaceValue)` (false here)
            // then `ToString(replaceValue)`; §22.2.6.14 does `ToUint32(limit)`.
            // But `_wrapWasmClosure` false-positives on ANY struct whenever the
            // module exports `__call_fn_N` (it checks dispatcher existence, not
            // closure-ness), so the object-literal arg got wrapped as a callable
            // `replacerBridge`, V8 saw `functionalReplace = true`, INVOKED it,
            // and `ToString` of the bogus return produced "null" (the
            // `arg-2-coerce` failure). Gate on the positive `__is_data_struct`
            // discriminator (the same marker `_wrapForHost`'s get-trap uses):
            // a data struct routes straight to `_wrapForHost` (property proxy)
            // so native `ToString` / `ToPrimitive` reaches its `toString` /
            // `valueOf` closure fields. Genuine function closures are never in
            // the data-struct set, so they still fall through to the callable
            // bridge below unchanged.
            try {
              const isDataFn = exps?.__is_data_struct as ((v: any) => number) | undefined;
              if (typeof isDataFn === "function" && isDataFn(a) === 1) {
                return _wrapForHost(a, exps);
              }
            } catch {
              // discriminator unavailable — fall through to the closure-bridge path
            }
            if (exps) {
              for (const ar of [4, 3, 2, 1] as const) {
                if (typeof exps[`__call_fn_${ar}`] === "function") {
                  // Confirm the struct is actually a closure by trying the
                  // wrap — _wrapWasmClosure returns null only when callbacks
                  // are absent, so a non-null return means we can dispatch.
                  const wrapped = _wrapWasmClosure(a, ar, callbackState);
                  if (wrapped) {
                    return function replacerBridge(...callArgs: any[]): any {
                      const ret = wrapped(...callArgs);
                      // Wrap an opaque WasmGC struct return value so the
                      // host's downstream `ToString` reaches the struct's
                      // `toString`/`valueOf` closure fields.
                      if (ret != null && _isWasmStruct(ret)) {
                        const exps2 = callbackState?.getExports();
                        return _wrapForHost(ret, exps2);
                      }
                      return ret;
                    };
                  }
                }
              }
            }
            return _wrapForHost(a, exports);
          };
          // Always wrap arg0 if it's a wasmGC struct so the spec's
          // ToString(arg) coercion finds the struct's toString/valueOf
          // closures via the host proxy.
          const wrappedArg0 = _isWasmStruct(arg0) ? _wrapForHost(arg0, exports) : arg0;
          // (#3084) No protocol-depth tracking here anymore: a `lastIndex` set
          // performed by a user-overridden `exec` invoked from these protocols
          // now ALWAYS stores the deferred shim; V8's spec-compliant slow path
          // fires it via `ToLength(? Get(rx, "lastIndex"))` exactly in the
          // empty-match advance branch (§22.2.6.8/11/14) and never otherwise.
          //
          // @@match/@@matchAll/@@search are 1-arg (string).
          // @@replace is 2-arg: (string, replaceValue) — replaceValue may
          //   be a function or a string.
          // @@split is 2-arg: (string, limit) — limit is a number.
          if (symbolId === 7 || symbolId === 9 || symbolId === 15) {
            return fn.call(regex, wrappedArg0);
          }
          if (symbolId === 8) {
            // Treat missing arg1 (null from ref.null.extern padding) as
            // undefined → ToString gives "undefined" per spec, matching
            // `regex[Symbol.replace](str)` with no replaceValue.
            if (arg1 == null) return fn.call(regex, wrappedArg0, undefined);
            return fn.call(regex, wrappedArg0, wrapCallable(arg1));
          }
          if (symbolId === 10) {
            // split: missing limit (null padding) → call without second arg
            // so the spec default 2^32-1 applies. JS `splitter.call(rx, S, null)`
            // would coerce null to 0 and return [] — wrong.
            if (arg1 == null) return fn.call(regex, wrappedArg0);
            // The limit goes through ToUint32 → ToNumber → ToPrimitive; when
            // it's a wasmGC struct (e.g. `{valueOf(){…}}`), wrap it so the
            // host proxy exposes the struct's valueOf/toString closure (#1331).
            return fn.call(regex, wrappedArg0, wrapCallable(arg1));
          }
          // Generic fallback
          if (arg1 == null) return fn.call(regex, wrappedArg0);
          return fn.call(regex, wrappedArg0, arg1);
        };
      // Type.prototype.method.call(receiver, ...args) dispatch for built-in types.
      // Used when e.g. Array.prototype.every.call(functionObj, fn) — the receiver
      // doesn't inherit from the Type, so obj.method() would fail.
      if (name === "__proto_method_call")
        return (typeName: string, methodName: string, receiver: any, args: any[]) => {
          const Type = (globalThis as any)[typeName];
          if (!Type || !Type.prototype) throw new TypeError(typeName + " is not a constructor");
          const method = Type.prototype[methodName];
          if (typeof method !== "function") throw new TypeError(methodName + " is not a function");
          // #983: wrap wasmGC receiver + arg structs in live-mirror Proxies.
          // Proxy get trap exposes closure-field methods as callable JS fns,
          // so native ToPrimitive on a wasmGC arg with closure valueOf works.
          const exports = callbackState?.getExports();
          let wrappedReceiver = _isWasmStruct(receiver) ? _wrapForHost(receiver, exports) : receiver;
          // #1342 — Boolean primitives travel through i32→externref via
          // __box_number, so `Boolean.prototype.toString.call(true)` arrives
          // here with `receiver = 1` (a number). Spec §20.3.3.2's
          // ToBooleanthisValue accepts both Boolean primitives and wrappers,
          // so we coerce numeric `0`/`1` back to a boolean primitive when the
          // dispatch target is Boolean.prototype. This unblocks the 23
          // assertion_fail tests under built-ins/Boolean/prototype/.
          if (typeName === "Boolean" && (typeof wrappedReceiver === "number" || typeof wrappedReceiver === "bigint")) {
            wrappedReceiver = Boolean(wrappedReceiver);
          }
          const wrappedArgs = (args ?? []).map((a) => (_isWasmStruct(a) ? _wrapForHost(a, exports) : a));
          // (#1382) Replace a Wasm-closure callback arg with a JS-callable
          // wrapper BEFORE dispatching into the native engine. Without this,
          // V8 throws "callback is not a function" when the host tries to
          // invoke the closure struct directly. Lookup is keyed on
          // methodName so methods without a callback slot are unaffected.
          {
            const slot = _PROTO_CB_SLOTS[methodName];
            if (slot && wrappedArgs.length > slot.argIdx) {
              wrappedArgs[slot.argIdx] = _maybeWrapCallable(wrappedArgs[slot.argIdx], slot.arity, callbackState);
            }
          }
          // #1234 — sparse-aware fast path for Array.prototype.{unshift,reverse,forEach}
          // on non-Array receivers with a HUGE `length`. V8's native algorithms walk
          // `for (k = 0; k < length;)` (or descending) per spec, which hangs when
          // `length ≈ 2^53` and the receiver has only a handful of defined integer-
          // indexed properties. Only intercept when the length exceeds a threshold
          // where V8's spec walk would be impractical — for normal-sized receivers
          // V8's native is correct and faster than our defined-property iteration.
          if (typeName === "Array" && !Array.isArray(wrappedReceiver) && wrappedReceiver != null) {
            const fast = _arrayProtoSparseFastPaths[methodName];
            if (fast) {
              const lenRaw = wrappedReceiver.length;
              const len = typeof lenRaw === "number" ? lenRaw : Number(lenRaw);
              // 1<<20 = 1,048,576. V8's native walks ~10 ns/iteration on modest
              // hardware, so a million iterations costs ~10 ms — well under the
              // 30 s pool ceiling and below any timing-sensitive test threshold.
              // Anything larger and we prefer the defined-property iteration.
              if (Number.isFinite(len) && len > 1 << 20) {
                const ret = fast(wrappedReceiver, wrappedArgs);
                return ret === wrappedReceiver ? receiver : _unwrapForHost(ret);
              }
            }
          }
          const ret = method.call(wrappedReceiver, ...wrappedArgs);
          return ret === wrappedReceiver ? receiver : _unwrapForHost(ret);
        };
      // Get actual JS built-in object by name (#965) — fixes WI3 null receiver for built-in classes
      // (#2623 P-7b design decision) This handler resolves the HOST realm on
      // purpose. A sandbox-first arm for `Promise` was prototyped and REVERTED:
      // partial (per-builtin) realm unification is inherently leaky — Promise
      // sandbox-first while Object/Boolean stayed host-realm regressed
      // `prototype/proto.js` + `catch/this-value-obj-coercible.js` (cross-
      // builtin proto/ToObject realm mixing). The vm sandbox is a LOCAL-runner
      // isolation mechanism, not a product surface; the CI lane is single-realm
      // (no sandbox) and relies on the worker's #1220 static snapshot/restore.
      // See "P-7b DESIGN DECISION" in plan/issues/2623-*.md.
      if (name === "__get_builtin") return (n: string) => (globalThis as any)[n];
      // Object.hasOwn(obj, key) — ES2022 static method (#965)
      // (#3060) Object.hasOwn(O, P) ≡ HasOwnProperty(ToObject(O), ToPropertyKey(P)),
      // the same predicate as Object.prototype.hasOwnProperty.call. The previous
      // body ran native `Object.hasOwn` on the RAW value, so a WasmGC struct
      // receiver (a statically-shaped object literal `{foo:42}`, or a `{}` given
      // an accessor via defineProperty) reported `false` for its own properties —
      // its fields/sidecar/descriptor data are invisible to native introspection.
      // Route through the shared `__hasOwnProperty` presence predicate instead:
      // arguments-object arm → non-struct `hasOwnProperty.call` arm → wasm-struct
      // `_wasmStructHasOwn` arm (tombstone + sidecar + descriptor + class methods
      // + struct shape).
      if (name === "__object_hasOwn")
        return (obj: any, key: any): number => {
          // ES2022 Object.hasOwn(O, P): step 1 is `Let obj be ? ToObject(O)`,
          // which THROWS a TypeError for null/undefined — and it happens BEFORE
          // step 2 `ToPropertyKey(P)`, so the key must NOT be coerced first
          // (test262 built-ins/Object/hasOwn/toobject_{null,undefined,before_topropertykey}).
          // The pre-#3060 body delegated to native `Object.hasOwn`, which threw
          // here; the struct-routing rewrite must preserve that throw rather than
          // swallow the null receiver as `false`.
          if (obj == null) {
            throw new TypeError("Cannot convert undefined or null to object");
          }
          key = _toPropertyKey(key, callbackState); // (#1716) ToPropertyKey on struct key
          if (typeof obj === "object" && _argumentsObjects.has(obj) && _argumentsHasOwn(obj, key)) {
            return 1;
          }
          if (!_isWasmStruct(obj)) {
            try {
              return _hasOwn(obj, key) ? 1 : 0;
            } catch {
              return 0;
            }
          }
          return _wasmStructHasOwn(obj, key, callbackState?.getExports()) ? 1 : 0;
        };
      // Object.is(x, y) — SameValue comparison (#965)
      if (name === "__object_is") return (x: any, y: any): number => (Object.is(x, y) ? 1 : 0);
      // Object.assign(target, ...sources) — shallow copy (#965)
      if (name === "__object_assign")
        return (target: any, sources: any[]): any => {
          // #983: if target is a wasmGC struct, assign through a live-mirror
          // Proxy so every source property Set writes back via the sidecar,
          // and return the original struct reference for caller identity.
          const exports = callbackState?.getExports();
          const targetIsStruct = _isWasmStruct(target);
          if (targetIsStruct) {
            const wrappedTarget = _wrapForHost(target, exports);
            const wrappedSources = (sources ?? []).map((s) => (_isWasmStruct(s) ? _wrapForHost(s, exports) : s));
            Object.assign(wrappedTarget, ...wrappedSources);
            // (#2804) Object.assign performs CopyDataProperties via [[Set]] (§7.3.25),
            // so each copied own enumerable source key becomes an ENUMERABLE own data
            // property on the target. The proxy `set` trap above writes the value to
            // the struct's sidecar (`_wasmStructProps`) but, being a plain dynamic
            // write, records NO descriptor entry — and `__object_keys` /
            // `__object_values` / `__object_entries` / `__getOwnPropertyNames` only
            // surface sidecar keys on a STRUCT target that carry a descriptor (#2746).
            // So the copied keys landed in the value store yet vanished from
            // enumeration (`Object.keys` dropped Object.assign's source keys — the
            // #2804 bug; for-in already surfaced them). Record an enumerable
            // writable+configurable descriptor for each newly-copied non-static-field
            // key so the enumeration helpers list them, matching the spec data-property
            // semantics and the for-in result. Existing struct fields enumerate from
            // the shape; keys with an existing descriptor (e.g. a defineProperty'd
            // non-enumerable prop) are left untouched.
            const targetDescs = _getSidecarDescs(target);
            const staticFieldNames = new Set(_getStructFieldNames(target, exports) ?? []);
            for (const ws of wrappedSources) {
              if (ws == null || (typeof ws !== "object" && typeof ws !== "function")) continue;
              let keys: (string | symbol)[];
              try {
                keys = Reflect.ownKeys(ws);
              } catch {
                continue;
              }
              for (const k of keys) {
                let enumerable: boolean;
                try {
                  enumerable = Object.getOwnPropertyDescriptor(ws, k)?.enumerable === true;
                } catch {
                  enumerable = false;
                }
                if (!enumerable) continue;
                if (typeof k === "string" && staticFieldNames.has(k)) continue;
                const nk = _normalizeDescKey(k);
                if (!targetDescs.has(nk)) {
                  targetDescs.set(nk, _SC_WRITABLE | _SC_ENUMERABLE | _SC_CONFIGURABLE | _SC_DEFINED);
                }
              }
            }
            return target;
          }
          // Non-struct target: wrap only wasmGC sources so their property
          // enumeration works, and return Object.assign's normal result
          // (which wraps primitives in a boxed object per spec).
          const wrappedSources = (sources ?? []).map((s) => (_isWasmStruct(s) ? _wrapForHost(s, exports) : s));
          return Object.assign(target as object, ...wrappedSources);
        };
      // Object.fromEntries(iterable) — create object from entries (#965)
      if (name === "__object_fromEntries") return (iterable: any): any => Object.fromEntries(iterable);
      // Object.getOwnPropertyDescriptors(obj) — all own descriptors (#965)
      // (#1629 S1) For WasmGC structs, enumerate own keys and read each
      // descriptor through the same canonical path as the single-key
      // Object.getOwnPropertyDescriptor, so the two agree on struct fields,
      // sidecar (defineProperty'd) props, accessors, and class methods.
      if (name === "__object_getOwnPropertyDescriptors")
        return (obj: any): any => {
          // ES §20.1.2.9 → ToObject(O) (§7.1.18) throws on null/undefined.
          if (obj == null) throw new TypeError(`Cannot convert ${obj === null ? "null" : "undefined"} to object`);
          if (!_isWasmStruct(obj)) return Object.getOwnPropertyDescriptors(obj);
          const exports = callbackState?.getExports();
          const result: Record<string | symbol, PropertyDescriptor> = {};
          for (const key of _ownStructKeys(obj, exports)) {
            const desc = _readOwnDescriptor(obj, key, exports);
            if (desc !== undefined) {
              if ("value" in desc) {
                const staticMethods = _staticMethodNames.get(obj);
                if (staticMethods?.includes(String(key))) {
                  const wrapped = _wrapForHost(obj, exports);
                  const callable = wrapped?.[key];
                  desc.value = typeof callable === "function" ? callable : _getClassMethodBridge(obj, String(key));
                } else {
                  desc.value = _maybeWrapCallableUnknownArity(desc.value, callbackState);
                }
              }
              // Per spec, the result is an ordinary object whose own
              // properties are enumerable, writable, configurable data
              // properties holding each descriptor object. Plain assignment
              // creates exactly such a property and keeps the keys reachable
              // by the host property-get path that compiled member access uses.
              (result as any)[key] = desc;
            }
          }
          return result;
        };
      // Object.groupBy(iterable, keyFn) — ES2024 grouping (#965)
      // (#1382) keyFn is invoked as `keyFn(value, index)` — arity 2.
      // Wrap Wasm-closure keyFn before handing it to the native engine.
      if (name === "__object_groupBy")
        return (iterable: any, keyFn: any): any =>
          (Object as any).groupBy(iterable, _maybeWrapCallable(keyFn, 2, callbackState));
      // Proxy.revocable(target, handler) — creates a revocable Proxy (#965)
      if (name === "__proxy_revocable")
        return (target: any, handler: any): any => {
          // #2180 — same construction path as `new Proxy`: validate the
          // target/handler are objects (else TypeError), bridge a WasmGC-struct
          // handler so the host can read its traps, and keep the raw target as
          // [[ProxyTarget]] for identity. Host enforces revoked-throws +
          // revoke idempotence on the returned pair.
          return _hostProxyConstructRevocable(target, handler, callbackState);
        };
      // ── Reflect.* host dispatch (#1466) ─────────────────────────────────
      // Each handler delegates to the host's Reflect.X so Proxy targets see
      // their traps fire and boolean returns are preserved. Wasm structs
      // arriving as `target` / `receiver` are wrapped via _wrapForHost so
      // host MOP operations can enumerate / mutate their sidecar fields.
      if (name === "__reflect_get")
        return (target: any, key: any, receiver: any): any => {
          key = _toPropertyKey(key, callbackState); // (#1716) ToPropertyKey on struct key
          const exports = callbackState?.getExports();
          const t = _isWasmStruct(target) ? _wrapForHost(target, exports) : target;
          const r =
            receiver === undefined || receiver === null
              ? t
              : _isWasmStruct(receiver)
                ? _wrapForHost(receiver, exports)
                : receiver;
          return Reflect.get(t, key, r);
        };
      if (name === "__reflect_set")
        return (target: any, key: any, value: any, receiver: any): number => {
          key = _toPropertyKey(key, callbackState); // (#1716) ToPropertyKey on struct key
          const exports = callbackState?.getExports();
          const t = _isWasmStruct(target) ? _wrapForHost(target, exports) : target;
          const v = _isWasmStruct(value) ? _wrapForHost(value, exports) : value;
          const r =
            receiver === undefined || receiver === null
              ? t
              : _isWasmStruct(receiver)
                ? _wrapForHost(receiver, exports)
                : receiver;
          return Reflect.set(t, key, v, r) ? 1 : 0;
        };
      if (name === "__reflect_has")
        return (target: any, key: any): number => {
          key = _toPropertyKey(key, callbackState); // (#1716) ToPropertyKey on struct key
          const exports = callbackState?.getExports();
          const t = _isWasmStruct(target) ? _wrapForHost(target, exports) : target;
          return Reflect.has(t, key) ? 1 : 0;
        };
      if (name === "__reflect_deleteProperty")
        return (target: any, key: any): number => {
          key = _toPropertyKey(key, callbackState); // (#1716) ToPropertyKey on struct key
          const exports = callbackState?.getExports();
          const t = _isWasmStruct(target) ? _wrapForHost(target, exports) : target;
          return Reflect.deleteProperty(t, key) ? 1 : 0;
        };
      if (name === "__reflect_defineProperty")
        return (target: any, key: any, desc: any): number => {
          key = _toPropertyKey(key, callbackState); // (#1716) ToPropertyKey on struct key
          const exports = callbackState?.getExports();
          const t = _isWasmStruct(target) ? _wrapForHost(target, exports) : target;
          const d = _isWasmStruct(desc) ? _wrapForHost(desc, exports) : desc;
          return Reflect.defineProperty(t, key, d) ? 1 : 0;
        };
      if (name === "__reflect_getOwnPropertyDescriptor")
        return (target: any, key: any): any => {
          key = _toPropertyKey(key, callbackState); // (#1716) ToPropertyKey on struct key
          const exports = callbackState?.getExports();
          const t = _isWasmStruct(target) ? _wrapForHost(target, exports) : target;
          return Reflect.getOwnPropertyDescriptor(t, key);
        };
      if (name === "__reflect_getPrototypeOf")
        return (target: any): any => {
          const exports = callbackState?.getExports();
          const t = _isWasmStruct(target) ? _wrapForHost(target, exports) : target;
          return Reflect.getPrototypeOf(t);
        };
      if (name === "__reflect_setPrototypeOf")
        return (target: any, proto: any): number => {
          const exports = callbackState?.getExports();
          const t = _isWasmStruct(target) ? _wrapForHost(target, exports) : target;
          return Reflect.setPrototypeOf(t, proto) ? 1 : 0;
        };
      if (name === "__reflect_ownKeys")
        return (target: any): any => {
          const exports = callbackState?.getExports();
          const t = _isWasmStruct(target) ? _wrapForHost(target, exports) : target;
          // Reflect.ownKeys returns string keys *and* Symbol keys (spec §28.1.13).
          return Reflect.ownKeys(t);
        };
      if (name === "__reflect_isExtensible")
        return (target: any): number => {
          const exports = callbackState?.getExports();
          const t = _isWasmStruct(target) ? _wrapForHost(target, exports) : target;
          return Reflect.isExtensible(t) ? 1 : 0;
        };
      if (name === "__reflect_preventExtensions")
        return (target: any): number => {
          const exports = callbackState?.getExports();
          const t = _isWasmStruct(target) ? _wrapForHost(target, exports) : target;
          return Reflect.preventExtensions(t) ? 1 : 0;
        };
      if (name === "__reflect_apply")
        return (fn: any, thisArg: any, argList: any): any => {
          const exports = callbackState?.getExports();
          // Per spec §28.1.1: argList undergoes CreateListFromArrayLike — host handles it.
          // We still wrap wasm structs so the host can enumerate them.
          const wrappedFn = _isWasmStruct(fn) ? _wrapForHost(fn, exports) : fn;
          const wrappedThis = _isWasmStruct(thisArg) ? _wrapForHost(thisArg, exports) : thisArg;
          const wrappedArgs = _isWasmStruct(argList) ? _wrapForHost(argList, exports) : argList;
          return Reflect.apply(wrappedFn, wrappedThis, wrappedArgs ?? []);
        };
      // (#1632a) Function.prototype.bind — produce a spec-compliant bound
      // function exotic. The host owns [[BoundTargetFunction]] /
      // [[BoundThis]] / [[BoundArguments]] / .name (`"bound " + target.name`) /
      // .length (max(0, target.length - bound.length)) / [[Call]] /
      // [[Construct]] via the native `Function.prototype.bind`.
      //
      // Wasm closure structs are wrapped via `_wrapWasmClosure` so the host
      // receives a real JS callable. `nameHint`/`lengthHint` are baked at
      // codegen time from the target's static declaration; the host stamps
      // them onto the wrapper so the bound function inherits them per spec.
      // When the hints are unavailable (`""` / `-1`), the wrapper keeps
      // whatever the host's `_wrapWasmClosure` chose (typically anonymous /
      // arity 0), which still gives bound `.name === "bound "` and
      // `.length === 0` — observably wrong but better than the identity-bind
      // fallback.
      if (name === "__bind_function")
        return (target: any, thisArg: any, argsArray: any, nameHint: any, lengthHint: number): any => {
          let callable: any = target;
          if (_isWasmStruct(target) && callbackState) {
            // (#2745 a/b) Bridge the Wasm-closure target with a dedicated
            // VARIADIC wrapper that forwards EVERY effective argument to the
            // closure with a correct `arguments` object. A bound function's
            // `[[Call]]` prepends the bound partial args (and `[[Construct]]`
            // also runs the body), so the wrapper can receive more args than
            // the target's declared arity — every one must reach the closure's
            // `arguments`. The old fixed-arity `_wrapWasmClosure(target,
            // lengthHint)` bridge truncated to `lengthHint` formals, so a target
            // reading `arguments[i]` past its formals (e.g. `function(){ return
            // arguments[0]; }`, arity 0) never saw the bound/call args.
            //
            // Dispatch rules:
            //   • `n = max(args.length, realArity)` — high enough that the
            //     closure (arity ≈ realArity) is matched by the dispatcher AND
            //     every passed arg is forwarded; clamped to an emitted arity.
            //   • Receiver-bound (`this` is a real object: an explicit object
            //     `boundThis`, or the fresh `[[Construct]]` object) →
            //     `__call_fn_method_n` (threads `this` via `__current_this`).
            //   • Otherwise (`undefined`/`null`/`globalThis` this) →
            //     `__call_fn_n` (plain dispatch).
            //   Both dispatchers now carry the #820l argc/extras plumbing
            //   (clamped-to-formals `__argc`), so `arguments` is exact.
            const realArity = typeof lengthHint === "number" && lengthHint >= 0 ? lengthHint : 0;
            const captured = target;
            const cbState = callbackState;
            const boundBridge = function boundWasmTargetBridge(this: any, ...args: any[]): any {
              const ex = cbState.getExports();
              if (!ex) {
                throw new TypeError("Function.prototype.bind: target closure is not callable");
              }
              const useMethod = this !== undefined && this !== null && this !== globalThis;
              const prefix = useMethod ? "__call_fn_method_" : "__call_fn_";
              // Choose dispatch arity: prefer max(args.length, realArity), clamp
              // DOWN to an emitted dispatcher; if that drops below realArity,
              // bump UP to the lowest emitted dispatcher ≥ realArity so the
              // target closure is still matched.
              let n = Math.max(args.length, realArity);
              while (n > 0 && typeof ex[`${prefix}${n}`] !== "function") n--;
              if (n < realArity) {
                let up = realArity;
                while (up <= 12 && typeof ex[`${prefix}${up}`] !== "function") up++;
                if (typeof ex[`${prefix}${up}`] === "function") n = up;
              }
              let callFn = ex[`${prefix}${n}`];
              let viaMethod = useMethod;
              if (typeof callFn !== "function") {
                // Method dispatcher of this arity missing — fall back to plain.
                callFn = ex[`__call_fn_${n}`];
                viaMethod = false;
              }
              if (typeof callFn !== "function") {
                throw new TypeError("Function.prototype.bind: target closure is not callable");
              }
              const padded = _denseOwnArgs(args, n);
              if (viaMethod) {
                const rawThis = this !== null && typeof this === "object" ? _unwrapForHost(this) : this;
                return callFn(_isWasmStruct(rawThis) ? rawThis : this, captured, ...padded);
              }
              return callFn(captured, ...padded);
            };
            callable = boundBridge;
            // Stamp hints onto the wrapper so the bound function inherits
            // them via the host's own `Function.prototype.bind` (which
            // computes `name = "bound " + target.name` and copies
            // `length = max(0, target.length - boundArgs.length)`).
            try {
              if (typeof nameHint === "string" && nameHint.length > 0) {
                Object.defineProperty(callable, "name", {
                  value: nameHint,
                  configurable: true,
                });
              }
              if (typeof lengthHint === "number" && lengthHint >= 0) {
                Object.defineProperty(callable, "length", {
                  value: lengthHint,
                  configurable: true,
                });
              }
            } catch {
              /* readonly host envs — ignore, bound fn just inherits wrapper defaults */
            }
          } else if (_isWasmStruct(target)) {
            // No callbackState at all (e.g. caller used raw `buildImports`
            // without setExports support). Degrade gracefully to identity-bind:
            // return the original target so callers that only need a non-null
            // function value continue to work. Pre-#1632a behaviour.
            return target;
          }
          if (typeof callable !== "function") {
            // Non-callable receiver (typed-struct that isn't a closure, or
            // anything else passing the `recvHasCallSig` codegen guard but
            // not actually callable at runtime). Spec §20.2.3.2 step 1
            // requires `IsCallable(F)` is false → throw TypeError.
            throw new TypeError("Function.prototype.bind called on non-callable");
          }
          const partial: any[] = Array.isArray(argsArray) ? argsArray : [];
          return Function.prototype.bind.apply(callable, [thisArg, ...partial]);
        };
      // (#1337) Invoke an arbitrary callable externref with an arguments array.
      // Used to call values that the codegen knows are JS-functional externrefs
      // (e.g. a `Function.prototype.bind` result) rather than wasm closure
      // structs — those can't be cast to a closure struct + call_ref. The host
      // handles [[Call]] with the function's own `this` binding (bound functions
      // already carry [[BoundThis]]; for plain functions `thisArg` is used).
      if (isHostCallImportName(name)) {
        return createHostCallImport(name, callbackState, {
          isWasmStruct: _isWasmStruct,
          maybeWrapCallable: _maybeWrapCallableUnknownArity,
          wrapForHost: _wrapForHost,
          unwrapForHost: _unwrapForHost,
        });
      }
      // (#4394) The `_newtarget` twin is the same operation with the third
      // argument syntactically PRESENT. §26.1.2 treats absent (step 2, defaults
      // to target) and present-not-a-constructor (step 3, TypeError) oppositely,
      // and the fixed-arity boundary pads an omitted newTarget with null — so
      // presence rides on the import NAME rather than on the value.
      if (name === "__reflect_construct" || name === "__reflect_construct_newtarget") {
        const newTargetIsPresent = name === "__reflect_construct_newtarget";
        return (ctor: any, args: any, newTarget: any): any => {
          const exports = callbackState?.getExports();
          const wrappedCtor = _isWasmStruct(ctor) ? _wrapForHost(ctor, exports) : ctor;
          let wrappedArgs = _isWasmStruct(args) ? _wrapForHost(args, exports) : args;
          // (#3097/#3335) Host ctor target: compiled-ArrayBuffer vec structs
          // marshal to their canonical host ArrayBuffer; compiled ARRAY vec
          // structs materialize to real host Arrays (see __construct).
          if (!_isWasmStruct(ctor) && Array.isArray(wrappedArgs)) {
            wrappedArgs = wrappedArgs.map((a: any) => _marshalHostConstructArg(a, exports, callbackState, wrappedCtor));
          }
          if (!newTargetIsPresent && (newTarget === undefined || newTarget === null)) {
            return Reflect.construct(wrappedCtor, wrappedArgs ?? []);
          }
          const wrappedNew = _isWasmStruct(newTarget) ? _wrapForHost(newTarget, exports) : newTarget;
          return Reflect.construct(wrappedCtor, wrappedArgs ?? [], wrappedNew);
        };
      }
      // (#1732 S1) __construct(callee, argsArray) — runtime [[Construct]] for a
      // `new f(...)` whose callee value cannot be proven constructable at
      // compile time (e.g. `var f = String.prototype.indexOf; new f`). Per
      // ECMA-262 §7.3.13 Construct → §10.2.2 [[Construct]] / §10.3.2 (built-in):
      // IsConstructor(F) false ⇒ throw a real TypeError. Builtin method values,
      // arrow functions, methods, and bound-without-construct functions all
      // lack [[Construct]] and must throw here. The thrown error is a genuine
      // host TypeError instance so test262 `assert.throws(TypeError, …)` /
      // `e instanceof TypeError` observe it.
      if (name === "__construct")
        return (callee: any, argsArray: any): any => {
          const exports = callbackState?.getExports();
          const wrappedCallee = _isWasmStruct(callee) ? _wrapForHost(callee, exports) : callee;
          // IsConstructor probe: Reflect.construct with `wrappedCallee` as the
          // newTarget throws TypeError when it has no [[Construct]] (the
          // standard "is this constructable?" test). A throw here means the
          // value is not a constructor → re-throw the spec TypeError with the
          // method's name.
          let isCtor = false;
          if (typeof wrappedCallee === "function") {
            try {
              // Probe via a no-op proxy target; only [[Construct]] presence is
              // tested, the proxy is never actually instantiated.
              Reflect.construct(function () {}, [], wrappedCallee);
              isCtor = true;
            } catch {
              isCtor = false;
            }
          }
          if (!isCtor) {
            const nm = wrappedCallee && wrappedCallee.name ? wrappedCallee.name : String(wrappedCallee);
            throw new TypeError(nm + " is not a constructor");
          }
          let wrappedArgs = _isWasmStruct(argsArray) ? _wrapForHost(argsArray, exports) : argsArray;
          // (#3097/#3335) HOST callee: a compiled-ArrayBuffer vec struct arg
          // must cross as its canonical host ArrayBuffer, and a compiled ARRAY
          // vec struct as a real host Array (`new TA(buffer, …)` / `new
          // TA(arr)` on an opaque struct builds a length-0 view). Compiled
          // callees keep raw structs — they re-enter Wasm.
          if (!_isWasmStruct(callee) && Array.isArray(wrappedArgs)) {
            wrappedArgs = wrappedArgs.map((a: any) =>
              _marshalHostConstructArg(a, exports, callbackState, wrappedCallee),
            );
          }
          return Reflect.construct(wrappedCallee, wrappedArgs ?? []);
        };
      // (#1632b-2 / #1528a residual) Dynamically CONSTRUCT a runtime function
      // VALUE — `var C = makeCtor(); new C(args)` where `C` is a factory-returned
      // `function C(){}` lowered to a WasmGC closure struct. Unlike `__construct`
      // above (which wraps with the NON-callable `_wrapForHost` and therefore
      // throws "not a constructor" for any closure — correct for arrows/bound/
      // methods, wrong for a genuine constructable function), this helper wraps a
      // closure with `_wrapCallableForHost`, whose `construct` trap runs the
      // closure body as ECMA-262 §10.2.2 OrdinaryCallEvaluateBody. Non-closure
      // structs and non-functions still throw the spec TypeError (preserves the
      // ctx-non-object / ctx-non-ctor cases). Also resolves the Promise-combinator
      // capability path (#2614): V8's NewPromiseCapability(C) → Construct(C,
      // «executor») routes a compiled executor through this same bridge.
      if (name === "__construct_closure")
        return (callee: any, argsArray: any): any => {
          const exports = callbackState?.getExports();
          // A WasmGC closure → the callable wrapper (constructible). A non-closure
          // struct stays on the non-callable `_wrapForHost`, so the IsConstructor
          // probe below throws the spec TypeError for a non-constructor value.
          let wrappedCallee: any = callee;
          if (_isWasmStruct(callee)) {
            const isClosureFn = exports?.__is_closure as ((v: any) => number) | undefined;
            let isClosure = false;
            if (typeof isClosureFn === "function") {
              try {
                isClosure = isClosureFn(callee) === 1;
              } catch {
                isClosure = false;
              }
            }
            wrappedCallee = isClosure ? _wrapCallableForHost(callee, callbackState) : _wrapForHost(callee, exports);
          }
          let isCtor = false;
          if (typeof wrappedCallee === "function") {
            try {
              Reflect.construct(function () {}, [], wrappedCallee);
              isCtor = true;
            } catch {
              isCtor = false;
            }
          }
          if (!isCtor) {
            const nm = wrappedCallee && wrappedCallee.name ? wrappedCallee.name : String(wrappedCallee);
            throw new TypeError(nm + " is not a constructor");
          }
          let wrappedArgs = _isWasmStruct(argsArray) ? _wrapForHost(argsArray, exports) : argsArray;
          // (#3097/#3335) HOST constructor (e.g. the harness TypedArray ctor
          // in `new TA(buffer, 0, 4)` / `new TA(arr)`): marshal compiled-
          // ArrayBuffer vec structs to their canonical host ArrayBuffer and
          // compiled ARRAY vec structs to real host Arrays — V8 treats the
          // raw struct as a non-buffer non-array-like and builds a LENGTH-0
          // view (whose later `.set()` throws the uncatchable-classified
          // "offset is out of bounds"). A compiled-closure callee keeps raw
          // structs (re-enters Wasm).
          if (!_isWasmStruct(callee) && Array.isArray(wrappedArgs)) {
            wrappedArgs = wrappedArgs.map((a: any) =>
              _marshalHostConstructArg(a, exports, callbackState, wrappedCallee),
            );
          }
          return Reflect.construct(wrappedCallee, wrappedArgs ?? []);
        };
      // Symbol.for(key) — global symbol registry (#965)
      // Symbol.for(key) — §20.4.2.2: stringKey = ? ToString(key). Passing a
      // Symbol makes ToString throw TypeError (not stringify). `Symbol.for`
      // itself performs ToString, so forwarding a real Symbol primitive
      // reproduces the spec throw; other values stringify normally.
      if (name === "__symbol_for") return (key: any): any => Symbol.for(key);
      // (#3676) `Symbol.for(key)` returning the module's CANONICAL i32 symbol
      // id rather than a raw host Symbol.
      //
      // The compiler represents a symbol VALUE as an i32 id everywhere:
      // `mapTsTypeToWasm` maps `symbol` → i32, and `compileSymbolCall`
      // (`Symbol()`) returns an unbranded i32 counter. `__symbol_for` was the
      // one producer handing back an `externref`, so `var S = Symbol.for("x")`
      // stored an externref into an i32 slot — coerced via `__unbox_number`,
      // i.e. `Number(Symbol())`, which throws TypeError §7.1.4 during
      // `__module_init`. That single mismatch is what stopped React 19 (twelve
      // `Symbol.for` calls on its first line) from instantiating at all.
      //
      // Ids are allocated NEGATIVE and are provably disjoint from every other
      // id source: well-knowns occupy 1..15 and the in-module `__symbol_counter`
      // global starts at 100 and only ascends. Each id is registered into the
      // SAME per-instance `symbolCache` that `__box_symbol` reads, so boxing the
      // id back across the boundary yields the genuine registry symbol and
      // `Symbol.for(k) === Symbol.for(k)` holds in both directions.
      // §20.4.2.2 step 1 (`stringKey = ? ToString(key)`) is preserved by letting
      // `Symbol.for` itself perform the coercion — a Symbol key still throws.
      if (name === "__symbol_for_id") {
        const symbolCache = _resolveSymbolCache(instanceState);
        const symbolForIds =
          instanceState?.symbolForIds ??
          (instanceState ? (instanceState.symbolForIds = new Map<string, number>()) : new Map<string, number>());
        return (key: any): number => {
          // ToString FIRST (spec order, and it may throw); key the map on the
          // coerced string so `Symbol.for(1)` and `Symbol.for("1")` agree.
          const sym = Symbol.for(key);
          const k = sym.description as string;
          let id = symbolForIds.get(k);
          if (id === undefined) {
            id = -(symbolForIds.size + 1);
            symbolForIds.set(k, id);
            symbolCache.set(id, sym);
          }
          return id;
        };
      }
      // (#3676) `Symbol.keyFor(sym)` taking the canonical i32 symbol id.
      // Companion to `__symbol_for_id`: resolves the id back through the shared
      // per-instance cache and applies the real `Symbol.keyFor`, so an
      // unregistered symbol (well-known, or one made by `Symbol()`) still yields
      // `undefined` per §20.4.2.6. An id with no cache entry never came from
      // this instance's registry, so it is likewise `undefined`.
      if (name === "__symbol_keyFor_id") {
        const symbolCache = _resolveSymbolCache(instanceState);
        return (id: number): any => {
          const sym = symbolCache.get(id);
          return sym === undefined ? undefined : Symbol.keyFor(sym);
        };
      }
      // Symbol.keyFor(sym) — reverse lookup in global registry (#965, #1342)
      // Spec §20.4.2.6: returns the key string for registered symbols, or
      // `undefined` for any other symbol. Returning `null` (the previous
      // behaviour) breaks `Symbol.keyFor(s) === undefined` checks in
      // test262 conformance tests.
      if (name === "__symbol_keyFor") return (sym: any): any => Symbol.keyFor(sym);
      // Symbol.prototype.description (#1467) — accessor on Symbol prototype.
      // Spec §20.4.3.2: get description on a Symbol-wrapper object via
      // ToObject + [[SymbolData]] read. The host accessor handles both raw
      // symbol primitives and Symbol-wrapper objects transparently.
      if (name === "__symbol_description")
        return (sym: any): any => {
          if (sym == null) {
            throw new TypeError("Cannot read property 'description' of " + String(sym));
          }
          // Spec: Symbol.prototype.description.call(symObj) unwraps Symbol-wrapper
          // objects (ToObject on receiver). The host accessor already implements
          // this, so we just call it through.
          return Object.getOwnPropertyDescriptor(Symbol.prototype, "description")!.get!.call(sym);
        };
      // (#3085) Symbol.prototype.toString → SymbolDescriptiveString (§20.4.3.3 /
      // §20.4.3.3.1): "Symbol(" + (desc ?? "") + ")". Host-mode companion to the
      // native `emitSymbolToString` (nativeStrings) path. Without this the generic
      // `.toString()` fallback emits "[object Object]", and `String(sym)`
      // stringifies the raw i32 symbol id. `Symbol.prototype.toString.call`
      // transparently unwraps Symbol-wrapper objects (ToObject on receiver).
      if (name === "__symbol_to_string") return (sym: any): any => Symbol.prototype.toString.call(sym);
      // Error.isError(value) — ES2025 static method (#1467).
      // Spec §20.5.2.1: returns true for any value with an [[ErrorData]]
      // internal slot. Cross-realm safe because it checks the slot, not
      // `instanceof Error`. We approximate via Object.prototype.toString
      // tag plus host `instanceof Error` for direct instances.
      if (name === "__error_isError")
        return (v: any): number => {
          if (v == null || typeof v !== "object") return 0;
          // Prefer ES2025 native if available (cross-realm safe).
          if (typeof (Error as any).isError === "function") {
            return (Error as any).isError(v) ? 1 : 0;
          }
          // Fallback: check Symbol.toStringTag chain for "Error" or instance.
          try {
            if (v instanceof Error) return 1;
          } catch {
            /* fall through */
          }
          try {
            const tag = Object.prototype.toString.call(v);
            if (tag === "[object Error]") return 1;
          } catch {
            /* fall through */
          }
          return 0;
        };
      // new AggregateError(errors, message, options?) — spec §20.5.7.1 (#1467).
      // Implements the spec construction sequence so that:
      //   • called without `new` constructs normally (caller dispatches both),
      //   • undefined errors → TypeError (per IterableToList of undefined),
      //   • message coerced via ToString (CreateMethodProperty, non-enumerable),
      //   • errors stored as a non-enumerable own data property (CreateMethodProperty),
      //   • Object.getPrototypeOf(result) === AggregateError.prototype.
      // (#2728) `Object(Symbol())` → Symbol-wrapper object (§7.1.18 ToObject,
      // Table 13), whose `typeof` is "object". Symbol is NOT a constructor, so
      // the generic `extern_class` `new Symbol(id)` path throws; box the i32
      // symbol id to the real JS Symbol (reusing the SAME per-instance
      // id→Symbol cache + description registry as `__box_symbol`, so the wrapped
      // symbol preserves identity/description) then `Object()` it into a wrapper
      // object. `Symbol.prototype.description` already unwraps such wrappers.
      // (#4394) `new Test262Error(msg)` in a module that DECLARES its own
      // `function Test262Error` — see runtime/test262-harness-host.ts.
      if (name === "__new_Test262Error_ctor") return test262Host.makeTest262ErrorWithModuleCtor;
      if (name === "__new_Symbol") {
        const symbolCache = _resolveSymbolCache(instanceState);
        const symbolDescRegistry =
          instanceState?.symbolDescRegistry ??
          (instanceState
            ? (instanceState.symbolDescRegistry = new Map<number, string | null>())
            : new Map<number, string | null>());
        return (id: number): any => {
          let sym = symbolCache.get(id);
          if (sym === undefined) {
            const reg = symbolDescRegistry.get(id);
            sym = reg === undefined ? Symbol(`wasm_${id}`) : reg === null ? Symbol() : Symbol(reg);
            symbolCache.set(id, sym);
          }
          return Object(sym);
        };
      }
      if (name === "__new_AggregateError")
        return (errors: any, message: any, options: any): any => {
          // Spec step 4: IterableToList(errors). `undefined`/`null` are NOT
          // iterable and must throw TypeError. This matches Node's native
          // AggregateError behaviour (`new AggregateError(undefined)` throws).
          if (errors === null || errors === undefined) {
            throw new TypeError("Cannot convert undefined or null to object");
          }
          // (#1467) The compiler wraps Wasm vec arguments via `__make_iterable`
          // before they reach this import, so `errors` is usually already a plain
          // JS array (or wrapped iterable) when called from compiled code. We
          // DELIBERATELY do NOT call `__make_iterable` recursively on each element
          // — its vec-shape detection misfires on host Error instances and
          // converts them into empty arrays. For values that arrive from user JS
          // `Array.isArray` is false and we walk the iterator protocol directly;
          // abrupt completions there must propagate (test262
          // errors-iterabletolist-failures).
          let errorsList: any[];
          if (Array.isArray(errors)) {
            errorsList = errors.slice();
          } else {
            let iter: any;
            try {
              iter = (errors as any)[Symbol.iterator];
            } catch {
              // Opaque WasmGC struct — `Symbol.iterator` access traps.
              iter = undefined;
            }
            if (typeof iter !== "function") {
              // (#1634) A bare opaque WasmGC *vec* struct (array literal `[1,2,3]`
              // that wasn't pre-wrapped) has no JS `Symbol.iterator`. Materialize
              // it via `__vec_len`/`__vec_get` (same machinery `__array_from`
              // uses) — but ONLY when it is genuinely vec-shaped (no named struct
              // fields). A non-vec object-literal struct (e.g. a user iterable
              // whose `@@iterator` lives in the sidecar) must NOT be silently
              // turned into an empty array; fall through to the TypeError so
              // abrupt/protocol-violation cases still throw (test262
              // errors-iterabletolist-failures).
              // (#3637) `_isWasmVec` is the positive discriminator; the old
              // "no named struct fields" heuristic also admitted field-less
              // non-vec structs, which `_materializeIterable` then flattened to
              // `[]` via the same vacuity this issue removes.
              const exports = callbackState?.getExports();
              const looksLikeVec = _isWasmVec(errors, exports);
              if (looksLikeVec) {
                const materialized = _materializeIterable(errors, callbackState);
                if (Array.isArray(materialized)) {
                  errorsList = materialized.slice();
                } else {
                  throw new TypeError("AggregateError: errors argument is not iterable");
                }
              } else {
                throw new TypeError("AggregateError: errors argument is not iterable");
              }
            } else {
              errorsList = [];
              const it = iter.call(errors);
              while (true) {
                const r = it.next();
                if (r == null || r.done) break;
                errorsList.push(r.value);
              }
            }
          }
          // Spec step 3: if message !== undefined, ToString(message); then
          // CreateNonEnumerableDataPropertyOrThrow(O, "message", msg).
          // Construct without message/options first; the engine's native
          // InstallErrorCause cannot read an opaque WasmGC `options` struct, so
          // we install `cause` ourselves below (#1634).
          //
          // (#1339-residuals) Codegen passes `ref.null.extern` for absent
          // optional args, which arrives here as JS `null`. Treat null as
          // absent so we don't install an own `message="null"` for the
          // common `new AggregateError([])` shape (test262
          // `properties-of-error-objects.js`).
          const inst = new AggregateError([]);
          if (message !== undefined && message !== null) {
            const msgStr = typeof message === "string" ? message : String(message);
            Object.defineProperty(inst, "message", {
              value: msgStr,
              writable: true,
              enumerable: false,
              configurable: true,
            });
          }
          // Spec step 6: CreateNonEnumerableDataPropertyOrThrow(O, "errors",
          // CreateArrayFromList(errorsList)). The Node native constructor
          // already sets `errors`, but with different attributes across
          // engines — overwrite to guarantee the spec descriptor.
          Object.defineProperty(inst, "errors", {
            value: errorsList,
            writable: true,
            enumerable: false,
            configurable: true,
          });
          // Spec step (InstallErrorCause): set own non-enumerable `cause` if
          // options has the property (HasProperty, not truthiness) (#1634).
          _installErrorCause(inst, options, callbackState?.getExports());
          return inst;
        };
      // new SuppressedError(error, suppressed, message, options?) — spec §20.5.10.1
      // (#1634). Mirrors __new_AggregateError: the generic 3-param extern-class
      // path dropped the `options` argument (no `cause` support) and could not
      // coerce `message` correctly. This dedicated import implements the spec
      // construction sequence:
      //   • error / suppressed stored as non-enumerable own data properties,
      //   • message coerced via ToString only if defined (no own prop otherwise),
      //   • InstallErrorCause(O, options): if options is an object and
      //     HasProperty(options, "cause"), set a non-enumerable `cause`.
      if (name === "__new_SuppressedError")
        return (error: any, suppressed: any, message: any, options: any): any => {
          if (typeof SuppressedError === "undefined") {
            throw new TypeError("SuppressedError is not supported by the host");
          }
          // Construct via the native engine so the prototype chain and brand
          // (`SuppressedError.prototype`, name "SuppressedError") are correct.
          // The engine cannot read an opaque WasmGC `options` struct, so we
          // install `cause` ourselves below (#1634).
          const inst = new (SuppressedError as unknown as new () => Error)();
          // Spec steps 4: CreateNonEnumerableDataPropertyOrThrow(O, "error", error).
          Object.defineProperty(inst, "error", {
            value: error,
            writable: true,
            enumerable: false,
            configurable: true,
          });
          // Spec step 3: CreateNonEnumerableDataPropertyOrThrow(O, "suppressed", suppressed).
          Object.defineProperty(inst, "suppressed", {
            value: suppressed,
            writable: true,
            enumerable: false,
            configurable: true,
          });
          // Spec step 5: if message is not undefined, msg = ToString(message);
          // CreateNonEnumerableDataPropertyOrThrow(O, "message", msg).
          //
          // (#1339-residuals) Codegen passes `ref.null.extern` for absent
          // optional args (JS `null` here); treat null as absent.
          if (message !== undefined && message !== null) {
            const msgStr = typeof message === "string" ? message : String(message);
            Object.defineProperty(inst, "message", {
              value: msgStr,
              writable: true,
              enumerable: false,
              configurable: true,
            });
          }
          // Spec step 6 (InstallErrorCause): set own non-enumerable `cause` if
          // options has the property (HasProperty, not truthiness) (#1634).
          _installErrorCause(inst, options, callbackState?.getExports());
          return inst;
        };
      // ArrayBuffer.isView(arg) — checks if arg is a TypedArray or DataView (#965)
      if (name === "__arraybuffer_isView") return (arg: any): number => (ArrayBuffer.isView(arg) ? 1 : 0);
      // Array.from(iterable, mapFn?) — creates array from iterable (#965).
      //
      // (#1382) Two interop hazards:
      //   1. `iterable` may be an opaque Wasm vec struct (no JS iterator)
      //      — materialize via `__vec_len` + `__vec_get` so `Array.from`
      //      sees a real iterable. Plain JS arrays / iterables pass
      //      through unchanged.
      //   2. `mapFn` may be a Wasm closure struct (no `[[Call]]`) — wrap
      //      in a JS Function via `_wrapWasmClosure` so `Array.from`
      //      can invoke it as `mapFn(value, index)`. Plain JS callers
      //      pass a real `function`, so the wrap is a no-op.
      if (name === "__array_from")
        return (iterable: any, mapFn: any): any[] => {
          const iter = _materializeIterable(iterable, callbackState);
          // (#1320) A plain JS object whose own @@iterator is a Wasm closure
          // (typeof "object") would make native Array.from throw
          // "items[Symbol.iterator] … must be a function". Drive the protocol
          // manually in that case, then apply mapFn over the collected values.
          const drained = _drainWasmClosureIterable(iter, callbackState);
          if (drained !== null) {
            if (mapFn == null) return drained;
            const fn = _isWasmStruct(mapFn) ? (_wrapWasmClosure(mapFn, 2, callbackState) ?? mapFn) : mapFn;
            return typeof fn === "function" ? drained.map((v, i) => fn(v, i)) : drained;
          }
          // (#3643 Slice B) §23.1.2.1 step 6: when the source is NOT iterable,
          // `Array.from` falls back to LengthOfArrayLike + indexed reads. A
          // WasmGC struct array-like (`{length: 2, 0: "a", 1: "b"}`) is opaque
          // to JS, so native `Array.from` read `length` as `undefined` and
          // answered `[]` — silently dropping every element. `_wrapForHost` is
          // the proven live-mirror proxy that already makes
          // `Array.prototype.slice.call(arrayLike)` work on the identical
          // receiver; routing the non-iterable struct through it lets native
          // `Array.from` perform the spec's own array-like walk rather than
          // re-implementing step 6 here.
          const src = _arrayFromNonIterableSource(iter, callbackState);
          if (mapFn == null) return Array.from(src);
          if (_isWasmStruct(mapFn)) {
            const wrapped = _wrapWasmClosure(mapFn, 2, callbackState);
            if (wrapped) return Array.from(src, wrapped);
          }
          return Array.from(src, mapFn);
        };
      // Array.fromAsync(items, mapFn?, thisArg?) — ES2024 §23.1.2.2 (#1517).
      //
      // Async sibling of Array.from. Three branches:
      //   1. items has Symbol.asyncIterator → `for await...of` iterates the
      //      async iterator, awaiting each yielded value.
      //   2. items has Symbol.iterator → iterate sync, but `await` each
      //      yielded value before storing (sync iterable of thenables).
      //   3. items is array-like (or non-null object without iterator) →
      //      ToObject + ToLength(o.length), walk indices, await each o[k].
      //
      // mapFn is awaited as well. Wasm closures are wrapped via
      // `_wrapWasmClosure` (arity 2 — mapFn receives (value, index)).
      // The host runtime returns a Promise<any[]>; the compiled caller
      // sees it as an externref and unwraps with the standard await
      // machinery.
      if (name === "__array_from_async")
        return (items: any, mapFn: any, thisArg: any): Promise<any[]> => {
          const wrappedMap = mapFn != null && _isWasmStruct(mapFn) ? _wrapWasmClosure(mapFn, 2, callbackState) : null;
          const callMap = async (v: any, k: number): Promise<any> => {
            if (mapFn == null) return v;
            const fn = wrappedMap ?? (mapFn as Function);
            return await fn.call(thisArg, v, k);
          };
          return (async () => {
            const result: any[] = [];
            if (items == null) {
              throw new TypeError("Array.fromAsync requires a non-null argument");
            }
            // Materialize opaque Wasm vec to a real iterable (#1382).
            const src = _materializeIterable(items, callbackState);
            // Async iterable branch.
            const asyncIter =
              typeof src === "object" && src != null && typeof (src as any)[Symbol.asyncIterator] === "function"
                ? (src as any)[Symbol.asyncIterator]()
                : null;
            if (asyncIter) {
              let k = 0;
              while (true) {
                const step = await asyncIter.next();
                if (step.done) break;
                const v = step.value;
                result.push(await callMap(v, k));
                k++;
              }
              return result;
            }
            // Sync iterable branch (await each value).
            const isIterable =
              typeof src === "object" && src != null && typeof (src as any)[Symbol.iterator] === "function";
            const isString = typeof src === "string";
            if (isIterable || isString) {
              let k = 0;
              for (const raw of src as Iterable<any>) {
                const v = await raw;
                result.push(await callMap(v, k));
                k++;
              }
              return result;
            }
            // Array-like branch.
            const o = Object(src) as any;
            const rawLen = o.length;
            const lenNum = Number(rawLen);
            const len = Number.isFinite(lenNum) ? Math.max(0, Math.trunc(lenNum)) : 0;
            for (let k = 0; k < len; k++) {
              const v = await o[k];
              result.push(await callMap(v, k));
            }
            return result;
          })();
        };
      // Array.of(...items) — creates array from arguments (#965)
      if (name === "__array_of") return (items: any[]): any[] => items;
      // Object.prototype methods for extern class dispatch (#799 WI2)
      if (name === "Object_hasOwnProperty") return (obj: any, key: any) => (_hasOwn(obj, key) ? 1 : 0);
      if (name === "Object_isPrototypeOf")
        return (obj: any, candidate: any) => {
          try {
            return Object.prototype.isPrototypeOf.call(obj, candidate) ? 1 : 0;
          } catch {
            return 0;
          }
        };
      if (name === "Object_propertyIsEnumerable")
        return (obj: any, key: any) => {
          if (_isWasmStruct(obj)) {
            return _wasmStructPropertyIsEnumerable(obj, key, callbackState?.getExports());
          }
          return Object.prototype.propertyIsEnumerable.call(obj, key) ? 1 : 0;
        };
      if (name === "Object_toString")
        return (obj: any) => {
          if (_isWasmStruct(obj)) return "[object Object]";
          return Object.prototype.toString.call(obj);
        };
      if (name === "Object_valueOf")
        return (obj: any) => {
          if (_isWasmStruct(obj)) {
            const prim = _toPrimitive(obj, "default", callbackState);
            return prim === undefined ? obj : prim;
          }
          return Object.prototype.valueOf.call(obj);
        };
      if (name === "Object_toLocaleString")
        return (obj: any) => {
          if (_isWasmStruct(obj)) {
            const prim = _toPrimitive(obj, "string", callbackState);
            if (prim !== undefined) return String(prim);
            // Fall through to host ToPrimitive (#1128)
            try {
              const prim2 = _hostToPrimitive(obj, "string", callbackState);
              return String(prim2);
            } catch {
              return "[object Object]";
            }
          }
          return Object.prototype.toLocaleString.call(obj);
        };
      if (name === "__tagged_template") return (tag: Function, strings: any[], subs: any[]) => tag(strings, ...subs);
      // (#1334) `delete obj[key]` host fallback for externref / WasmGC struct
      // receivers. The codegen side (`compileDeleteExpression`) only handles
      // direct struct-field deletion natively; everything else (sidecar-stored
      // properties from `Object.defineProperty`, plain JS objects, dynamic
      // keys) routes through this import.
      //
      // Spec §13.5.1 The delete Operator + §10.1.10 [[Delete]]:
      //   - Property is non-configurable → return false (strict mode also
      //     throws TypeError, but we keep the falsy return for sloppy/strict
      //     parity at the call site; throwing here would over-trigger).
      //   - Property doesn't exist → return true (vacuous).
      //   - Otherwise → remove the property and return true.
      //
      // Returns 0 (falsy) or 1 (truthy) to match the i32 result the codegen
      // currently expects.
      if (name === "__delete_property")
        return (obj: any, key: any): number => {
          if (obj == null) return 1; // delete on null/undefined: vacuously true (no real property)
          // Plain JS object — defer to native delete.
          if (!_isWasmStruct(obj)) {
            try {
              const k = typeof key === "symbol" ? key : String(key);
              return delete obj[k] ? 1 : 0;
            } catch (e) {
              // #2180 — deleting from a revoked proxy throws TypeError; propagate.
              if (_isRevokedProxyError(e)) throw e;
              // #2617 — a user Proxy's deleteProperty trap that THROWS (abrupt
              // completion) must propagate. BUT the bundled runtime is strict
              // (ES module), so `delete obj[k]` ALSO throws a TypeError when the
              // trap merely RETURNS FALSE ("trap returned falsish") — which in
              // the user program's NON-strict context must be a plain `false`
              // (return 0), not a throw (test262 deleteProperty/return-false-not-
              // strict.js, flags:[noStrict]). Distinguish: re-throw a user-Proxy
              // exception only when it is NOT the strict-delete result coercion.
              if (_isUserProxy(obj) && !_isStrictDeleteFalsishError(e)) throw e;
              // Trap returned false (or non-configurable refusal) → report failure.
              return 0;
            }
          }
          // WasmGC struct — operate on the sidecar storage.
          const k = typeof key === "symbol" ? key : String(key);
          // (#2726 g) §10.5.7 OrdinaryDelete step 2: if the receiver has no OWN
          // property P, [[Delete]] is a true no-op — it must NOT tombstone or
          // otherwise mutate the receiver. Without this guard, `delete o.p` of a
          // key that lives only on the prototype chain (e.g. `delete
          // __palette.red` where `red` is inherited from `Palette.prototype`)
          // recorded a tombstone on `o`, which then shadowed the still-present
          // inherited value on the next prototype-chain read (returning
          // undefined instead of the inherited value). Return true, mutate
          // nothing. Own properties fall through to the real delete below.
          if (!_wasmStructHasOwn(obj, k, callbackState?.getExports())) {
            return 1;
          }
          // Check the descriptor table for an explicit non-configurable flag.
          const descs = _wasmPropDescs.get(obj);
          if (descs) {
            const flags = descs.get(k as string);
            if (flags !== undefined && !(flags & _SC_CONFIGURABLE)) {
              // Non-configurable — refuse the delete.
              return 0;
            }
          }
          // Drop both the value sidecar entry and any descriptor metadata.
          _sidecarDelete(obj, k);
          if (descs) {
            descs.delete(k as string);
          }
          // Symbol-keyed accessor entry mirror (#1336 / runtime.ts:1117): clear
          // any accessor map entries for this key as well so subsequent
          // [[Get]] / [[Set]] no longer find them.
          if (typeof key === "symbol") {
            const accessorMap = _wasmStructAccessors.get(obj);
            if (accessorMap) accessorMap.delete(key);
          }
          // (#1334) Tombstone — record the key as deleted so the
          // struct-shape-derived presence checks (`__hasOwnProperty`,
          // `__for_in_keys`, etc.) treat the property as absent. The
          // sentinel struct field set is performed by the codegen path
          // for fields that exist in the struct shape; this tombstone
          // covers the case where the field is in the shape but wasn't
          // explicitly nullified, AND closes the gap where a sidecar /
          // descriptor-only entry on a `{}` whose shape includes the
          // field would otherwise still be reported as own.
          let tomb = _wasmStructDeletedKeys.get(obj);
          if (!tomb) {
            tomb = new Set<string | symbol>();
            _wasmStructDeletedKeys.set(obj, tomb);
          }
          tomb.add(typeof key === "symbol" ? key : (k as string));
          return 1;
        };
      // hasOwnProperty runtime check for externref/any receivers
      if (name === "__hasOwnProperty")
        return (obj: any, key: any): number => {
          if (obj == null) return 0;
          // (#2743 a) A registered arguments object's own properties (`length`,
          // `callee`) are invisible to the host on the opaque vec — answer from
          // the arguments-aware predicate before the generic struct path.
          if (typeof obj === "object" && _argumentsObjects.has(obj) && _argumentsHasOwn(obj, key)) {
            return 1;
          }
          if (!_isWasmStruct(obj)) {
            try {
              return _hasOwn(obj, key) ? 1 : 0;
            } catch {
              return 0;
            }
          }
          // (#2130) Single shared own-property predicate — tombstone, sidecar,
          // descriptor, class methods, struct shape.
          return _wasmStructHasOwn(obj, key, callbackState?.getExports()) ? 1 : 0;
        };
      // propertyIsEnumerable runtime check for externref/any receivers
      if (name === "__propertyIsEnumerable")
        return (obj: any, key: any): number => {
          if (obj == null) return 0;
          if (!_isWasmStruct(obj)) {
            try {
              return Object.prototype.propertyIsEnumerable.call(obj, key) ? 1 : 0;
            } catch {
              return 0;
            }
          }
          // (#1334) Deleted property — not own, hence not enumerable.
          return _wasmStructPropertyIsEnumerable(obj, key, callbackState?.getExports());
        };
      // (#2739) Record a WasmGC struct's user [[Prototype]] (Object.setPrototypeOf
      // / Reflect.setPrototypeOf / `o.__proto__ = v`). In gc/host mode the struct
      // is opaque, so codegen previously dropped `proto` on the floor; this stores
      // it in `_wasmStructProto` for the for-in walk + read path. Mirrors
      // §10.1.2.1 OrdinarySetPrototypeOf: a non-object/non-null proto is ignored;
      // a proto chain that would reach `obj` (cycle) is refused.
      if (name === "__host_set_struct_proto")
        return (obj: any, proto: any): any => {
          if (!_isWasmStruct(obj) || !_canBeWeakKey(obj)) return obj;
          if (proto !== null && typeof proto !== "object" && typeof proto !== "function") {
            // Neither Object nor Null: OrdinarySetPrototypeOf is a no-op here.
            return obj;
          }
          // Cycle check (§10.1.2.1 step 8): walk proto's chain; refuse on reaching obj.
          let p: any = proto;
          let guard = 0;
          while (p != null && guard++ < 100) {
            if (p === obj) return obj; // would create a cycle — no-op
            if (_isWasmStruct(p) && _canBeWeakKey(p) && _wasmStructProto.has(p)) {
              p = _wasmStructProto.get(p);
            } else {
              try {
                p = Object.getPrototypeOf(p);
              } catch {
                break;
              }
            }
          }
          _wasmStructProto.set(obj, proto);
          return obj;
        };
      // for-in key enumeration: returns a JS array of enumerable string keys
      if (name === "__for_in_keys")
        return (obj: any) => {
          if (obj == null) return [];
          // Plain JS object — try native for-in (includes prototype chain)
          if (!_isWasmStruct(obj)) {
            try {
              const keys: string[] = [];
              for (const k in obj) keys.push(k);
              return keys;
            } catch (e: any) {
              // Prototype chain may include an opaque WasmGC struct — fall through to manual walk
              if (
                !(e instanceof TypeError) ||
                !(typeof e.message === "string" && (e.message.includes("opaque") || e.message.includes("WebAssembly")))
              ) {
                throw e;
              }
            }
          }
          // Manual prototype chain walk — handles WasmGC structs and mixed chains
          const exports = callbackState?.getExports();
          const keys: string[] = [];
          const seen = new Set<string>();
          // (#2739) Visited-object guard: a hand-built or recorded prototype
          // link could in principle form a cycle; stop if we revisit an object.
          const visitedObjs = new Set<any>();
          let current: any = obj;
          while (current != null) {
            if (visitedObjs.has(current)) break;
            visitedObjs.add(current);
            if (_isWasmStruct(current)) {
              // WasmGC struct — get field names from exported helper.
              // (#2131) Per spec, EnumerateObjectProperties visits each
              // chain level's own keys in OrdinaryOwnPropertyKeys order:
              // collect this level's keys first, order, then push.
              const levelKeys: string[] = [];
              const fieldNames = _getStructFieldNames(current, exports) ?? [];
              // (#2731) A deleted-then-re-added struct-shape field is emitted from
              // the sidecar below (insertion-order END), not its fixed struct
              // slot. Skip it here so it isn't enumerated twice / at the wrong
              // position.
              const shadowedFields = _wasmStructShadowedFields.get(current);
              for (const k of fieldNames) {
                if (shadowedFields && shadowedFields.has(k)) continue;
                if (!seen.has(k) && !levelKeys.includes(k)) levelKeys.push(k);
              }
              // Also include enumerable sidecar properties
              const sc = _wasmStructProps.get(current);
              if (sc) {
                const descs = _wasmPropDescs.get(current);
                for (const k of Object.keys(sc)) {
                  if (seen.has(k) || levelKeys.includes(k)) continue;
                  // Check enumerability — sidecar props without explicit descriptor are enumerable
                  if (descs) {
                    const flags = descs.get(k);
                    if (flags !== undefined && flags & _SC_DEFINED && !(flags & _SC_ENUMERABLE)) continue;
                  }
                  levelKeys.push(k);
                }
              }
              for (const k of _orderOwnKeysSpec(levelKeys)) {
                keys.push(k);
                seen.add(k);
              }
              // (#2739 b) §13.7.5.15: a NON-enumerable own property still
              // shadows a same-named prototype property (it enters `visited`
              // without being yielded — 12.6.4-2.js). Mark every own key —
              // struct fields and ALL sidecar/descriptor-table keys, whether
              // enumerable or not — as seen before descending. A deleted
              // (tombstoned) key is NOT an own property and must not shadow.
              const tomb = _wasmStructDeletedKeys.get(current);
              for (const k of fieldNames) {
                if (!(tomb && tomb.has(k))) seen.add(k);
              }
              if (sc) {
                for (const k of Object.keys(sc)) {
                  if (k.startsWith("__get_") || k.startsWith("__set_")) continue;
                  if (!(tomb && tomb.has(k))) seen.add(k);
                }
              }
              const descTable = _wasmPropDescs.get(current);
              if (descTable) {
                for (const k of descTable.keys()) {
                  if (typeof k !== "string") continue;
                  if (!(tomb && tomb.has(k))) seen.add(k);
                }
              }
            } else {
              // Plain JS object — use Object.keys for own enumerable, respecting shadowing
              try {
                for (const k of Object.keys(current)) {
                  if (!seen.has(k)) {
                    keys.push(k);
                    seen.add(k);
                  }
                }
                // Mark all own properties (including non-enumerable) as seen for shadowing
                for (const k of Object.getOwnPropertyNames(current)) {
                  seen.add(k);
                }
              } catch {
                break;
              }
            }
            // (#2739) Advance through the user-intended prototype (consults the
            // recorded setPrototypeOf link + the #1712 fnctor proto), not the
            // native [[Prototype]] which is null for an opaque WasmGC struct.
            current = _structUserProto(current, exports);
          }
          return keys;
        };
      if (name === "__for_in_len")
        return (keys: any) => {
          if (keys == null || !Array.isArray(keys)) return 0;
          return keys.length;
        };
      if (name === "__for_in_get")
        return (keys: any, i: number) => {
          if (keys == null || !Array.isArray(keys)) return undefined;
          return keys[i];
        };
      // (#3323) for-in over an ARRAY receiver: return the full
      // OrdinaryOwnPropertyKeys string list — integer indices "0".."length-1"
      // ascending, THEN the own enumerable non-index string keys added via
      // `arr.k = v` / `Object.defineProperty(arr, "k", …)` (the accessor case),
      // in insertion order. The native `emitArrayForIn` index loop only emitted
      // the indices and dropped every string key, so `for (k in arr)` after a
      // `defineProperty(arr,"a",{get,enumerable})` yielded `[]` instead of
      // `["a"]` (test262 for-in/order-after-define-property.js assert #2).
      //
      // Accessor properties are stored in the sidecar as `__get_<k>`/`__set_<k>`
      // (the bound getter/setter) — normalize those to the user key `<k>` at that
      // insertion position and dedupe, so a redefine (which also leaves a bare
      // `<k>` marker) does not enumerate the key twice or reorder it.
      if (name === "__array_forin_keys")
        return (vec: any, len: number): string[] => {
          const keys: string[] = [];
          if (vec == null) return keys;
          // Integer index keys "0".."len-1" — `len` is the vec length, read in
          // Wasm and passed in (the opaque vec has no host-reachable length).
          const n = typeof len === "number" && len > 0 ? len | 0 : 0;
          for (let i = 0; i < n; i++) keys.push("" + i);
          // Own enumerable non-index string keys from the sidecar, insertion order.
          const sc = _wasmStructProps.get(vec);
          if (!sc) return keys;
          const descs = _wasmPropDescs.get(vec);
          const tomb = _wasmStructDeletedKeys.get(vec);
          const seen = new Set<string>();
          for (const raw of Object.getOwnPropertyNames(sc)) {
            let k = raw;
            if (raw.startsWith("__get_") || raw.startsWith("__set_")) k = raw.slice(6);
            // Integer-index keys are already emitted by the index loop above.
            if (_isCanonicalArrayIndexKey(k)) continue;
            if (seen.has(k)) continue;
            seen.add(k);
            if (tomb && tomb.has(k)) continue; // deleted → not an own property
            // Enumerability: a sidecar key WITHOUT an explicit descriptor is
            // enumerable; a defined descriptor must have the enumerable bit set.
            if (descs) {
              const flags = descs.get(k);
              if (flags !== undefined && flags & _SC_DEFINED && !(flags & _SC_ENUMERABLE)) continue;
            }
            keys.push(k);
          }
          return keys;
        };
      // Per-visit liveness check for for-in (#2066). The key set is snapshotted
      // up front (spec-permitted), but §14.7.5.10 requires that a property
      // deleted before it is visited is skipped. This re-tests, at visit time,
      // whether `key` still exists on the (own-or-inherited) live object — the
      // `in`-operator semantics that match for-in's enumeration set. Returns 1
      // if still present, 0 if it has since been deleted.
      if (name === "__for_in_has")
        return (obj: any, key: any): number => {
          if (obj == null) return 0;
          const k = typeof key === "symbol" ? key : String(key);
          if (!_isWasmStruct(obj)) {
            try {
              return k in (obj as object) ? 1 : 0;
            } catch {
              return 0;
            }
          }
          // WasmGC struct: an explicit delete records a tombstone — honor it.
          const tomb = _wasmStructDeletedKeys.get(obj);
          if (tomb && tomb.has(k)) return 0;
          // Otherwise the key was enumerated from the live shape and has not been
          // deleted, so it is still present.
          return 1;
        };
      // Promise combinators and constructors
      // Helper: convert WasmGC vec struct to JS array (vec structs are opaque
      // from JS; Promise.all/race/etc. need an iterable).
      const _vecToArray = (arr: any): any[] => {
        if (arr == null) return [];
        if (Array.isArray(arr)) return arr;
        const exports = callbackState?.getExports();
        if (exports) {
          const vecLen = exports.__vec_len as Function | undefined;
          const vecGet = exports.__vec_get as Function | undefined;
          // (#3637) POSITIVE discriminator — the vacuous probe turned every
          // non-vec struct into `[]` instead of the wrap-single-value fallback.
          if (typeof vecLen === "function" && typeof vecGet === "function" && _isWasmVec(arr, exports)) {
            const len = vecLen(arr) as number;
            if (typeof len === "number" && len >= 0) {
              const result: any[] = new Array(len);
              for (let i = 0; i < len; i++) {
                result[i] = vecGet(arr, i);
              }
              return result;
            }
          }
        }
        return [arr]; // Fallback: wrap single value
      };
      // (#1368, #1465) Spec-compliant Promise combinators.
      //
      // Signature is `(thisArg, iterable)`:
      //   1. Direct call `Promise.all(iter)` passes thisArg = null → helper
      //      defaults to global Promise (codegen emits `ref.null.extern`).
      //   2. `Sub.all(iter)` (subclass) routes thisArg = Sub through the helper
      //      (blocked on #1382 — wasm class identifiers don't bridge to JS yet).
      //   3. `Promise.all.call(C, iter)` is detected in codegen and forwarded
      //      with thisArg = C.
      //
      // We delegate to the native engine's `Promise.all.call(C, …)` etc., which
      // are spec-compliant for `[[AlreadyCalled]]`, `IteratorClose`, custom-this
      // resolve/reject capability, `Get(C, "resolve")` lookup, and the full
      // GetIterator protocol when given any JS iterable (string, arguments,
      // Set, Map, custom Symbol.iterator).
      //
      // Per spec (PerformPromiseAll step 4): GetIterator(iterable) MUST drive
      // the iterator protocol. So we must NOT silently wrap non-iterables in
      // an array — `Promise.all(123)` must reject with TypeError, not resolve
      // to [123]. The previous `_vecToArray` fallback violated this.
      //
      // (#1465) Iterable handling:
      //   - null/undefined → pass through; native rejects with TypeError (spec).
      //   - string → pass through; native iterates code units.
      //   - JS Array / object with Symbol.iterator → pass through.
      //   - WasmGC vec (detected via __vec_len/__vec_get accessors) → convert
      //     to a real JS array so native can iterate it.
      //   - Other primitives (number, boolean, symbol) → pass through; native
      //     rejects with TypeError per spec.
      // (#2671) A USER THENABLE element — a wasm object-literal `{ then:
      // function (onFulfilled, onRejected) {…} }` — must cross into the native
      // combinator with a host-visible callable `then`: V8's PerformPromiseAll
      // does `Invoke(C.resolve(elem), "then", «resolveElement, reject»)`, and a
      // RAW WasmGC struct exposes no properties, so the Invoke threw TypeError
      // and the aggregate rejected (the `call-resolve-element` / `new-resolve-
      // function` / `resolve-before-loop-exit` test262 family — the combinator
      // resolve-element protocol was unreachable). Wrap ONLY structs whose own
      // `then` resolves to a callable (host fn or wasm closure) in the
      // `_wrapForHost` live-mirror proxy — its `get` bridges the closure field
      // to a host-callable, and the #2015 receiver-unwrap in the method bridge
      // restores the raw struct as wasm-side `this`. Everything else passes
      // through RAW, exactly as before, preserving fulfilled-value identity
      // for non-thenable elements (`Promise.all([obj]) → values[0] === obj`).
      // A thenable's pre-fix behavior was an unconditional reject, so there is
      // no working identity to preserve for the wrapped class.
      const _wrapThenableElement = (v: any): any => {
        if (v == null || typeof v !== "object" || !_isWasmStruct(v)) return v;
        const exports = callbackState?.getExports();
        if (!exports) return v;
        try {
          // A struct-SHAPE `then` field is read via the compiled `__sget_then`
          // getter — `_safeGet` reads only the sidecar/accessor/proto layers by
          // design, so it alone misses the literal `{ then: function … }` shape.
          // A sidecar-assigned `obj.then = fn` falls back to `_safeGet`.
          let t: any;
          try {
            const sget = (exports as Record<string, Function>).__sget_then;
            if (typeof sget === "function") t = sget(v);
          } catch {
            t = undefined;
          }
          if (t == null) t = _safeGet(v, "then", callbackState);
          if (t != null && (typeof t === "function" || _isWasmClosureValue(t, callbackState))) {
            return _wrapForHost(v, exports);
          }
        } catch {
          /* not a thenable — pass through raw */
        }
        return v;
      };
      const _toIterable = (iter: any): any => {
        // null/undefined: per spec, GetIterator throws TypeError. Native does
        // this when given undefined — pass through and let it reject.
        if (iter == null) return iter;
        // Strings are iterable per spec (yield code units).
        if (typeof iter === "string") return iter;
        // Already JS-iterable: array, generator, custom Symbol.iterator,
        // arguments object, Set, Map, TypedArray, etc.
        if (typeof iter === "object") {
          // Real JS Array — fast path. (#2671) Re-materialize only when some
          // element is a wasm-struct thenable (see _wrapThenableElement); the
          // overwhelmingly common all-plain case returns the array unchanged.
          if (Array.isArray(iter)) {
            let needsWrap = false;
            for (const v of iter) {
              if (v !== _wrapThenableElement(v)) {
                needsWrap = true;
                break;
              }
            }
            return needsWrap ? iter.map(_wrapThenableElement) : iter;
          }
          // Detect WasmGC vec first via accessors (they return 0/null for
          // non-vec externrefs, so we materialize only when the round-trip
          // looks sane). We MUST attempt this before Symbol.iterator because
          // a wasm vec externref is an opaque host object — `Symbol.iterator
          // in vec` either throws or returns false, and we want to convert
          // it to a real JS array rather than fail.
          const exports = callbackState?.getExports();
          if (exports) {
            const vecLen = exports.__vec_len as Function | undefined;
            const vecGet = exports.__vec_get as Function | undefined;
            // (#3637) `__vec_len(non-vec)` returns 0 by design, which used to be
            // indistinguishable from an empty vec — so this site carried a
            // "sentinel probe" workaround: materialize when `len > 0`, or when
            // `len === 0` and the value has no `Symbol.iterator`. That second
            // arm still mapped every non-iterable wasm struct to `[]`, so
            // `Promise.all({a: 1})` RESOLVED to `[]` where §27.2.4.1
            // GetIterator requires a TypeError rejection. `__is_vec` answers the
            // question directly, so the workaround is gone: a real vec (empty or
            // not) materializes, everything else falls through to the
            // Symbol.iterator check and then to native's spec-correct rejection.
            if (typeof vecLen === "function" && typeof vecGet === "function" && _isWasmVec(iter, exports)) {
              try {
                const len = vecLen(iter) as number;
                if (typeof len === "number" && len >= 0) {
                  const result: any[] = new Array(len);
                  for (let i = 0; i < len; i++) {
                    // (#2671) Thenable struct elements get the live-mirror
                    // proxy so V8's resolve-element Invoke sees `.then`.
                    result[i] = _wrapThenableElement(vecGet(iter, i));
                  }
                  return result;
                }
              } catch {
                // Not a vec (vecLen threw) — fall through.
              }
            }
          }
          // Has Symbol.iterator — pass through. Guard with try/catch since
          // Proxy targets can throw on `has`.
          try {
            if (Symbol.iterator in iter) return iter;
          } catch {
            // Fall through to native rejection.
          }
          // Object that isn't iterable and isn't a vec: pass through; native
          // throws TypeError per spec.
          return iter;
        }
        // Non-object, non-string primitives (number, boolean, symbol, bigint):
        // pass through; native `Promise.all(123)` throws TypeError per spec.
        return iter;
      };
      const _resolveCtor = (thisArg: any, directCall: number): any => {
        // Step 1 of spec algorithm: `Let C be the this value`.
        // (#1116, #1465) The codegen passes `directCall=1` when the user wrote
        // `Promise.METHOD(iter)` (no explicit thisArg) — substitute
        // globalThis.Promise so the natural call site works.
        // For `directCall=0` (user wrote `.call(thisArg, iter)`), pass the
        // value through unchanged: V8's `Promise.METHOD.call(thisArg, …)`
        // then performs spec §27.2.4.X step 2 (`If Type(C) is not Object,
        // throw a TypeError exception`) — which is what test262
        // `ctx-non-object.js` / `ctx-non-ctor.js` files exercise for
        // undefined/null/primitive/non-constructor values.
        // (#2623 P-7b) HOST realm on purpose (see the __get_builtin design
        // note). In the single-realm CI lane this IS the object the user's
        // `Promise.resolve = fn` patch lands on (the declarations.ts
        // __module_init keep), so V8's `Get(C, "resolve")` in
        // PerformPromiseAll/Race (§27.2.4.1.1 step 5) observes the patch —
        // the `all/race/allSettled invoke-resolve.js` observable-resolve
        // contract. A sandbox-first arm here was prototyped and REVERTED:
        // capability-C sandbox + host-realm minting broke the §27.2.4.7
        // `nextPromise.constructor === C` identity fast path (the historical
        // `any/invoke-then` regression), and unifying minting too leaked
        // cross-builtin (see the design-decision section in the issue file).
        if (directCall) return Promise;
        // (#1694 A.i / #1632b-1) When the user passes a COMPILED FUNCTION as the
        // capability constructor — `Promise.all.call(NotPromise, …)` where
        // `NotPromise` is an ordinary `function` lowered to a Wasm closure
        // struct — V8's NewPromiseCapability(C) does `Construct(C, «executor»)`.
        // A bare `_wrapForHost` proxy is non-constructible, so V8 throws
        // "… is not a constructor". Wrap it in the callable/constructible proxy
        // so the construct succeeds and the closure body runs (executor
        // protocol). Only genuine closures (`__is_closure === 1`) get the
        // callable wrap; a plain object or non-closure struct stays
        // non-constructible, so the spec TypeError for `ctx-non-object` /
        // `ctx-non-ctor` still fires per §27.2.4.X step 2.
        if (thisArg != null && typeof thisArg === "object" && _isWasmStruct(thisArg)) {
          const exports = callbackState?.getExports();
          const isClosureFn = exports?.__is_closure as ((v: any) => number) | undefined;
          let isClosure = false;
          if (typeof isClosureFn === "function") {
            try {
              isClosure = isClosureFn(thisArg) === 1;
            } catch {
              isClosure = false;
            }
          }
          if (isClosure) return _wrapCallableForHost(thisArg, callbackState);
        }
        return thisArg;
      };
      // (#1116b) Synthesize (and cache) a JS subclass of Promise for a
      // Wasm-compiled `class MyPromise extends Promise`. The instance is
      // already a real host Promise (built via __new_Promise); this JS
      // constructor only needs to be [[Construct]]-able and carry a distinct
      // .prototype so the combinators' NewPromiseCapability + @@species
      // resolution work. Keyed on class name. Synthesized from the lexical
      // (intrinsic) `Promise`, never a user-shadowed global.
      // (#2637 B2.1) Registry of wasm constructor-body closures, keyed by
      // `class extends Promise` name. Codegen emits a one-time
      // `__register_promise_subclass_ctor(name, closure)` per such class with a
      // user constructor; `closure` materializes the `$<Class>_new` body so the
      // host can invoke it under `NewPromiseCapability(C)`. Shared across the
      // `__register_*` and `__promise_subclass_ctor` import handlers via this
      // import-builder closure scope, so a single Map instance is observed by
      // both. The body closure is a wasm closure struct (arity 1: the executor);
      // `_maybeWrapCallable` bridges it to `__call_fn_1(closure, executor)`.
      if (name === "__register_promise_subclass_ctor") {
        return (classNameRef: any, ctorClosure: any): void => {
          if (!instanceState) return;
          const className = String(classNameRef);
          // Bridge the wasm closure to a host-callable once at registration.
          // `_maybeWrapCallable` is a no-op for null (defensive) and caches the
          // wrapper per (closure, arity), so repeated registrations are cheap.
          const body = _maybeWrapCallable(ctorClosure, 1, callbackState);
          if (typeof body !== "function") return;
          (instanceState.promiseSubclassBodies ??= new Map()).set(className, body);
        };
      }
      // (#1116b) Synthesize (and cache) a JS subclass of Promise for a
      // Wasm-compiled `class MyPromise extends Promise`. The instance is a real
      // host Promise; this JS constructor carries a distinct `.prototype` so the
      // combinators' NewPromiseCapability + @@species resolution work, keyed on
      // class name, synthesized from the lexical (intrinsic) `Promise`.
      //
      // (#2637 B2.2) When a `$<Class>_new` body closure was registered (B2.1),
      // the synthesized ctor RUNS that body after `super(exec)` — so V8's
      // `NewPromiseCapability(C)` (`new C(internalExecutor)`) executes the user
      // constructor's side effects (`callCount += 1`, `executor = a`, proto
      // wiring) on V8's capability promise. Without a registered body (default
      // ctor, e.g. the #1977 `withResolvers/ctx-ctor` identity-only row) the
      // synthesized ctor is the bare forwarder, unchanged.
      if (name === "__promise_subclass_ctor") {
        return (classNameRef: any): any => {
          const className = String(classNameRef);
          const ctorCache: Map<string, any> = instanceState
            ? (instanceState.promiseSubclassCtors ??= new Map())
            : new Map();
          let C = ctorCache.get(className);
          if (C === undefined) {
            const bodies = instanceState?.promiseSubclassBodies;
            // Cast the base to a plain constructor: `class extends Promise {}`
            // trips TS2508 (Promise's lib.d.ts type is generic) but is valid
            // JS — the emitted runtime subclasses the intrinsic Promise.
            C = class extends (Promise as unknown as { new (...args: any[]): any }) {
              constructor(exec: any) {
                super(exec);
                // (#2637 B2.2/B2.3) Run the registered wasm ctor body on THIS
                // (V8's capability promise) if one was registered. The body
                // (`$<Class>_new`, run-on-host-`this` mode, B2.3) binds its
                // `this`/`$__self` to the host-provided promise and runs only
                // the side effects + proto wiring — it must NOT allocate its own
                // promise via `__new_Promise`. The executor `exec` is forwarded
                // as the body's sole arg. `__call_fn_method_1` (the method
                // dispatch reached via `body.call(this, …)`) installs `this` as
                // the wasm-side receiver (`__current_this`). A throwing body
                // propagates verbatim — V8's `Construct(C, «executor»)` surfaces
                // the user-observable throw; we do not swallow it. Without a
                // registered body (default-ctor subclass, e.g. the #1977
                // `withResolvers/ctx-ctor` identity-only row) this is the bare
                // forwarder, unchanged.
                const body = bodies?.get(className);
                if (typeof body === "function") {
                  body.call(this, exec);
                }
              }
            };
            try {
              Object.defineProperty(C, "name", { value: className, configurable: true });
            } catch {
              /* Function.name redefinition is best-effort; non-fatal. */
            }
            ctorCache.set(className, C);
          }
          return C;
        };
      }
      if (name === "Promise_all")
        return (thisArg: any, arr: any, directCall: number) => {
          const C = _resolveCtor(thisArg, directCall);
          return Promise.all.call(C, _toIterable(arr));
        };
      if (name === "Promise_race")
        return (thisArg: any, arr: any, directCall: number) => {
          const C = _resolveCtor(thisArg, directCall);
          return Promise.race.call(C, _toIterable(arr));
        };
      if (name === "Promise_allSettled")
        return (thisArg: any, arr: any, directCall: number) => {
          const C = _resolveCtor(thisArg, directCall);
          return Promise.allSettled.call(C, _toIterable(arr));
        };
      if (name === "Promise_any")
        return (thisArg: any, arr: any, directCall: number) => {
          const C = _resolveCtor(thisArg, directCall);
          return (Promise as any).any.call(C, _toIterable(arr));
        };
      // (#2623 P-7b) HOST-realm minting on purpose: minting and the capability
      // lane (`_resolveCtor`) MUST share one realm — a split breaks the
      // §27.2.4.7 `nextPromise.constructor === C` identity fast path (the
      // historical `any/invoke-then` regression). Both stay HOST; the
      // prototyped sandbox-first unification leaked cross-builtin and was
      // reverted (see the __get_builtin design note).
      if (name === "Promise_resolve") return (val: any) => Promise.resolve(val);
      if (name === "Promise_reject")
        return (val: any) => {
          // (#2978) Pre-mark the rejection as handled. Compiled code holds the
          // promise as an opaque externref and may drop it without attaching a
          // handler (e.g. the for-await sync drive's bounded step cap discards
          // one rejected promise per iteration) — without this, each discarded
          // rejection fires the host's unhandledRejection machinery, and a
          // capped loop emits a 100k-event storm that vitest/CI runners count
          // as errors. The no-op catch derives a separate promise; consumers of
          // the returned promise observe the rejection unchanged.
          const p = Promise.reject(val);
          p.catch(() => {});
          return p;
        };
      // (#1042) async/await CPS scheduling primitives. The state machine
      // allocates one pending outer Promise per async function, then settles
      // it from a continuation that runs as a microtask. We stash the
      // resolve/reject capabilities on the promise object so the settle
      // imports can fire them by reference.
      if (name === "Promise_new_pending")
        return () => {
          let r: (v: any) => void = () => {};
          let j: (e: any) => void = () => {};
          const p: any = new Promise((res: any, rej: any) => {
            r = res;
            j = rej;
          });
          p.__r = r;
          p.__j = j;
          return p;
        };
      if (name === "Promise_settle_resolve")
        return (p: any, val: any) => {
          if (p && typeof p.__r === "function") p.__r(val);
        };
      if (name === "Promise_settle_reject")
        return (p: any, reason: any) => {
          if (p && typeof p.__j === "function") p.__j(reason);
        };
      // (#1382) `executor` is called as `executor(resolve, reject)` — arity 2.
      if (name === "Promise_new") return (executor: any) => new Promise(_maybeWrapCallable(executor, 2, callbackState));
      // (#1382) `onFulfilled` / `onRejected` callbacks are arity-1 (the value or reason).
      if (name === "Promise_then") return (p: any, cb: any) => p.then(_maybeWrapCallable(cb, 1, callbackState));
      if (name === "Promise_then2")
        return (p: any, cb1: any, cb2: any) =>
          p.then(_maybeWrapCallable(cb1, 1, callbackState), _maybeWrapCallable(cb2, 1, callbackState));
      if (name === "Promise_catch") return (p: any, cb: any) => p.catch(_maybeWrapCallable(cb, 1, callbackState));
      // (#1382) `onFinally` is arity-0 (no arg per spec §27.2.5.3).
      if (name === "Promise_finally") return (p: any, cb: any) => p.finally(_maybeWrapCallable(cb, 0, callbackState));
      // Generator support: buffer management and generator creation
      //
      // Eager-generator hard cap (#991/#992): we lower generators to an array
      // that is fully populated before .next() can be called. An infinite
      // generator (e.g. `while (true) { yield; }`) would push forever, OOMing
      // the Node process and causing the parent test runner to register a
      // 30s timeout. Throwing a RangeError after a bounded number of yields
      // turns those tests into a quick runtime exception instead of a
      // worker-killing OOM. The cap is high enough (1M) that real-world
      // generators are never affected.
      const __EAGER_GEN_LIMIT = 1_000_000;
      if (name === "__gen_create_buffer") return () => [];
      if (name === "__gen_push_f64")
        return (buf: any[], v: number) => {
          if (buf.length >= __EAGER_GEN_LIMIT) {
            throw new RangeError("Eager generator buffer exceeded " + __EAGER_GEN_LIMIT + " yields");
          }
          buf.push(v);
        };
      if (name === "__gen_push_i32")
        return (buf: any[], v: number) => {
          if (buf.length >= __EAGER_GEN_LIMIT) {
            throw new RangeError("Eager generator buffer exceeded " + __EAGER_GEN_LIMIT + " yields");
          }
          buf.push(v);
        };
      if (name === "__gen_push_ref")
        return (buf: any[], v: any) => {
          if (buf.length >= __EAGER_GEN_LIMIT) {
            throw new RangeError("Eager generator buffer exceeded " + __EAGER_GEN_LIMIT + " yields");
          }
          buf.push(v);
        };
      if (name === "__gen_yield_star")
        return (buf: any[], rawIterable: any) => {
          // Iterate the inner iterable and push all values into the outer buffer.
          // Per §27.5.3 yield* output, the inner generator's RETURN value is the
          // value of the `yield*` expression and must NOT leak into the outer
          // stream — `for...of`/manual iteration already stops at the inner
          // `done:true` result, so only the yielded (`done:false`) values are
          // pushed here. (#2035)
          // (#3075) Under `--target standalone`/`wasi` the `yield*` operand is
          // an opaque WasmGC `$Vec` struct, not a JS iterable — it has no
          // `Symbol.iterator`, so this push loop silently drained ZERO values
          // (the buffered generator then reported done immediately, the vacuous
          // half of the for-await dstr cluster). Materialize it into a real JS
          // array through the module's `__vec_len`/`__vec_get` exports first;
          // non-vec / host iterables pass through unchanged.
          // (#3227 S3) `yield* <async generator>` inside an `async function*`:
          // the inner object carries only `Symbol.asyncIterator`, so the sync
          // for-of below drained ZERO values — the outer async generator then
          // reported `{value: undefined, done: true}` on the first `.next()`
          // (the yield-star half of the S3 flip cluster). Our async generators
          // are EAGERLY buffered (`_AsyncGeneratorState` → `{buf, index}`), so
          // the settled values are synchronously available: drain the
          // remaining buffer directly, then propagate a pendingThrow exactly
          // like the eager body would (§27.6.3.8 — an inner abrupt completion
          // propagates out of the `yield*`).
          const asyncState = rawIterable != null ? _AsyncGeneratorState.get(rawIterable) : undefined;
          if (asyncState !== undefined) {
            while (asyncState.index < asyncState.buf.length) {
              if (buf.length >= __EAGER_GEN_LIMIT) {
                throw new RangeError("Eager generator buffer exceeded " + __EAGER_GEN_LIMIT + " yields");
              }
              buf.push(asyncState.buf[asyncState.index++]);
            }
            if (asyncState.pendingThrow !== null && asyncState.pendingThrow !== undefined) {
              const e = asyncState.pendingThrow;
              asyncState.pendingThrow = null;
              throw e;
            }
            return;
          }
          const iterable = _materializeIterable(rawIterable, callbackState);
          if (iterable != null && typeof iterable[Symbol.iterator] === "function") {
            for (const v of iterable) {
              if (buf.length >= __EAGER_GEN_LIMIT) {
                throw new RangeError("Eager generator buffer exceeded " + __EAGER_GEN_LIMIT + " yields");
              }
              buf.push(v);
            }
          }
        };
      // __gen_set_return: (buf, value) → void. Stashes the generator's `return`
      // value on the buffer object (a non-enumerable side property) rather than
      // pushing it as a yielded element. `__create_generator` reads it into
      // `_GeneratorState.retVal` so the terminal `{value, done:true}` result
      // carries it exactly once. (#2035)
      if (name === "__gen_set_return")
        return (buf: any, v: any) => {
          if (buf != null) {
            Object.defineProperty(buf, "__genReturn", {
              value: v,
              writable: true,
              enumerable: false,
              configurable: true,
            });
          }
        };
      if (name === "__create_generator")
        return (buf: any[], pendingThrow: any) => {
          // (#1516) Generator instances now share `%GeneratorPrototype%` (built
          // by `_getGeneratorPrototype`) so `next`/`return`/`throw` are NOT own
          // properties — they live on the prototype and read instance state
          // from `_GeneratorState`. This makes
          // `Generator.prototype.next.call(non_gen)` throw TypeError per spec
          // §27.5.3.2 (GeneratorValidate), and installs the spec-mandated
          // property descriptors ({writable: true, enumerable: false,
          // configurable: true} for the methods, `Symbol.toStringTag` =
          // "Generator", etc.).
          //
          // %GeneratorPrototype% inherits from %IteratorPrototype% so
          // .map/.filter/.drop/.take/... (#1367) still resolve through the
          // chain.
          // (#1639) Instances inherit from the per-function instance prototype
          // (`genFn.prototype`), which in turn inherits from %GeneratorPrototype%,
          // so `Object.getPrototypeOf(instance) === genFn.prototype` per spec and
          // `next`/`return`/`throw` still resolve up the chain. State lives on the
          // instance, not the prototype, so the brand check
          // (`_GeneratorState.get(this)`) is unaffected.
          const proto = _getGeneratorInstancePrototype();
          const obj: any = Object.create(proto);
          // (#3032) LAZY thunk mode: a non-Array first arg is the generator-
          // expression CLOSURE itself (an opaque wasm ref), not an eager
          // buffer. Defer the body: on the first `next()` re-invoke the
          // closure through the module's `__call_fn_0` export with the
          // `__gen_set_eager` flag held — the closure then takes its
          // historical eager-buffer path and we adopt the inner generator's
          // state. `return`/`throw` before the first `next()` complete the
          // generator WITHOUT running the body (spec §27.5.3.2). This fixes
          // the eager-at-creation side effects of the buffer lowering
          // (test262 dstr fixture: `var iter = function*(){ iterations += 1 }()`
          // must keep iterations === 0 until a resume).
          if (buf !== null && buf !== undefined && !Array.isArray(buf)) {
            const st: {
              buf: any[];
              index: number;
              pendingThrow: any;
              retVal?: any;
              thunk?: any;
              materialize?: () => void;
            } = { buf: [], index: 0, pendingThrow: null, retVal: undefined, thunk: buf };
            st.materialize = () => {
              const DBG = process.env.GEN_DEBUG === "1";
              const thunk = st.thunk;
              st.thunk = undefined;
              st.materialize = undefined;
              const exports = callbackState?.getExports?.() as any;
              const setEager = exports?.__gen_set_eager as ((v: number) => void) | undefined;
              const callFn0 = exports?.__call_fn_0 as ((c: any) => any) | undefined;
              if (!setEager || !callFn0) {
                throw new TypeError(
                  "lazy generator: __call_fn_0/__gen_set_eager exports unavailable (host must wire setExports)",
                );
              }
              let inner: any;
              try {
                setEager(1);
                inner = callFn0(thunk);
              } finally {
                setEager(0);
              }
              const innerSt = _GeneratorState.get(inner);
              if (DBG) console.error("MATERIALIZE inner=", inner, "innerSt=", innerSt);
              if (innerSt) {
                st.buf = innerSt.buf;
                st.pendingThrow = innerSt.pendingThrow;
                st.retVal = innerSt.retVal;
              }
            };
            _GeneratorState.set(obj, st);
            return obj;
          }
          // (#2035) Read the generator's return value off the buffer's side
          // property (set by `__gen_set_return`) into the instance state so the
          // terminal `{value, done:true}` result carries it — without it ever
          // appearing as a yielded element.
          _GeneratorState.set(obj, {
            buf,
            index: 0,
            pendingThrow,
            retVal: (buf as any)?.__genReturn,
          });
          return obj;
        };
      if (name === "__create_async_generator")
        return (buf: any[], pendingThrow: any) => {
          // (#1516) Async generators share `%AsyncGeneratorPrototype%`. See the
          // matching comment on `__create_generator`. The instance is just a
          // plain object whose [[Prototype]] is the singleton — state lives in
          // `_AsyncGeneratorState`.
          // (#1639) See __create_generator — inherit from the instance prototype
          // so `Object.getPrototypeOf(instance) === asyncGenFn.prototype`.
          const proto = _getAsyncGeneratorInstancePrototype();
          const obj: any = Object.create(proto);
          _AsyncGeneratorState.set(obj, { buf, index: 0, pendingThrow });
          return obj;
        };
      // (#3123) Shared miss-arm for the __gen_* dispatchers: a registered
      // fnctor-subclass instance's `next`/`return`/`throw` is a compiled class
      // method/getter invisible to a native property read — resolve it through
      // the wasm-aware reader (class-member kind dispatch + fnctor prototype
      // walk). Gated on the registration WeakMap so every other receiver keeps
      // the exact pre-#3123 behavior.
      const genMemberFallback = (gen: any, key: string): any => {
        if (gen == null || typeof gen !== "object") return undefined;
        if (!_isWasmStruct(gen) || !_canBeWeakKey(gen) || !_fnctorInstanceCtor.has(gen)) return undefined;
        return _safeGet(gen, key, callbackState);
      };
      if (name === "__gen_next")
        return (gen: any) => {
          const next = gen.next ?? _sidecarGet(gen, "next") ?? genMemberFallback(gen, "next");
          if (typeof next === "function") return next.call(gen);
          throw new TypeError("generator.next is not a function");
        };
      if (name === "__gen_return")
        return (gen: any, val: any) => {
          const ret = gen.return ?? _sidecarGet(gen, "return") ?? genMemberFallback(gen, "return");
          if (typeof ret === "function") return ret.call(gen, val);
          return { value: val, done: true };
        };
      if (name === "__gen_throw")
        return (gen: any, err: any) => {
          const thr = gen.throw ?? _sidecarGet(gen, "throw") ?? genMemberFallback(gen, "throw");
          if (typeof thr === "function") return thr.call(gen, err);
          throw err;
        };
      if (name === "__gen_result_value")
        return (result: any) => {
          let val = result.value;
          if (val !== undefined) return val;
          val = _sidecarGet(result, "value");
          if (val !== undefined) return val;
          const exports = callbackState?.getExports();
          return exports?.__sget_value?.(result);
        };
      if (name === "__gen_result_value_f64")
        return (result: any) => {
          let val = result.value ?? _sidecarGet(result, "value");
          if (val === undefined) {
            const exports = callbackState?.getExports();
            val = exports?.__sget_value?.(result);
          }
          return Number(val);
        };
      if (name === "__gen_result_done")
        return (result: any) => {
          let done = result.done ?? _sidecarGet(result, "done");
          if (done === undefined) {
            const exports = callbackState?.getExports();
            done = exports?.__sget_done?.(result);
          }
          return done ? 1 : 0;
        };
      // Iterator protocol: host-delegated iteration for non-array types
      if (name === "__iterator")
        return (obj: any) => {
          // Check direct Symbol.iterator first, then sidecar (both JS Symbol and Wasm "@@iterator")
          const fn = obj[Symbol.iterator] ?? _sidecarGet(obj, Symbol.iterator) ?? _sidecarGet(obj, "@@iterator");
          if (typeof fn === "function") return fn.call(obj);
          // If fn is a WasmGC closure (not a JS function), call it via __call_fn_0
          if (fn != null && _isWasmStruct(fn)) {
            const exports = callbackState?.getExports();
            const callFn0 = (exports as any)?.__call_fn_0;
            if (typeof callFn0 === "function") {
              const iter = callFn0(fn);
              if (iter != null) return iter;
            }
          }
          // WasmGC struct fallback: check for @@iterator struct field via exported getter,
          // then try vec struct iteration.
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            // Try __call_@@iterator to invoke [Symbol.iterator]() on the struct
            const callIter = (exports as any)?.["__call_@@iterator"];
            if (typeof callIter === "function") {
              const iter = callIter(obj);
              if (iter != null) return iter;
            }
            // Fallback: synthesize an array iterator if the struct is a vec (array wrapper)
            // (#3637) POSITIVE discriminator. Without it every non-iterable wasm
            // struct got a synthesized ZERO-LENGTH iterator instead of the
            // §7.4.2 GetIterator TypeError below, so `for (x of {a: 1})` ran its
            // body zero times and completed normally, and `var [p] = {a: 1}`
            // bound `undefined`. Both must throw TypeError.
            const vecLen = exports?.__vec_len;
            const vecGet = exports?.__vec_get;
            if (typeof vecLen === "function" && typeof vecGet === "function" && _isWasmVec(obj, exports)) {
              const len = vecLen(obj);
              if (typeof len === "number" && len >= 0) {
                let i = 0;
                // (#1367) Synthesized iterators MUST inherit from
                // Iterator.prototype so .drop/.take/.map/.filter etc. resolve.
                // (#3049) …but at spec DEPTH: iter → %ArrayIteratorPrototype%
                // (shared stand-in) → %IteratorPrototype% (helpers), so the
                // spec-shaped double-getPrototypeOf walk lands on the helper
                // proto instead of overshooting it (see
                // _getSynthArrayIteratorPrototype).
                const iterProto = (
                  typeof (globalThis as any).Iterator === "function"
                    ? ((globalThis as any).Iterator as any).prototype
                    : null
                ) as any;
                const iterObj: any = iterProto ? Object.create(_getSynthArrayIteratorPrototype(iterProto)) : {};
                iterObj.next = () => {
                  if (i >= len) return { value: undefined, done: true };
                  const val = vecGet(obj, i);
                  i++;
                  return { value: val, done: false };
                };
                iterObj[Symbol.iterator] = function () {
                  return this;
                };
                return iterObj;
              }
            }
          }
          throw new TypeError(
            (typeof obj === "object" ? Object.prototype.toString.call(obj) : String(obj)) + " is not iterable",
          );
        };
      if (name === "__async_iterator")
        return (obj: any) => {
          const asyncIter =
            obj[Symbol.asyncIterator] ?? _sidecarGet(obj, Symbol.asyncIterator) ?? _sidecarGet(obj, "@@asyncIterator");
          if (asyncIter != null) {
            if (typeof asyncIter === "function") return asyncIter.call(obj);
            // (#1347b) `obj[Symbol.asyncIterator]` was assigned a WasmGC closure
            // struct in compiled code — it has no JS `[[Call]]`. Dispatch via
            // __call_fn_0 the same way the sync `__iterator` path does, instead
            // of letting `.call` throw "is not a function".
            if (_isWasmStruct(asyncIter)) {
              const callFn0 = (callbackState?.getExports() as any)?.__call_fn_0;
              if (typeof callFn0 === "function") {
                const iter = callFn0(asyncIter);
                if (iter != null) return iter;
              }
            }
          }
          const syncIter = obj[Symbol.iterator] ?? _sidecarGet(obj, Symbol.iterator) ?? _sidecarGet(obj, "@@iterator");
          if (typeof syncIter === "function") return syncIter.call(obj);
          if (syncIter != null && _isWasmStruct(syncIter)) {
            const callFn0 = (callbackState?.getExports() as any)?.__call_fn_0;
            if (typeof callFn0 === "function") {
              const iter = callFn0(syncIter);
              if (iter != null) return iter;
            }
          }
          // WasmGC struct fallback: check @@iterator struct field, then vec iteration
          if (_isWasmStruct(obj)) {
            const exports = callbackState?.getExports();
            // Try __call_@@iterator to invoke [Symbol.iterator]() on the struct
            const callIter = (exports as any)?.["__call_@@iterator"];
            if (typeof callIter === "function") {
              const iter = callIter(obj);
              if (iter != null) return iter;
            }
            // (#3637) POSITIVE discriminator — see `__iterator` above; the
            // vacuous probe handed back an empty async iterator for any
            // non-async-iterable struct instead of throwing TypeError.
            const vecLen = exports?.__vec_len;
            const vecGet = exports?.__vec_get;
            if (typeof vecLen === "function" && typeof vecGet === "function" && _isWasmVec(obj, exports)) {
              const len = vecLen(obj);
              if (typeof len === "number" && len >= 0) {
                let i = 0;
                return {
                  next() {
                    if (i >= len) return { value: undefined, done: true };
                    const val = vecGet(obj, i);
                    i++;
                    return { value: val, done: false };
                  },
                  [Symbol.iterator]() {
                    return this;
                  },
                };
              }
            }
          }
          throw new TypeError(
            (typeof obj === "object" ? Object.prototype.toString.call(obj) : String(obj)) + " is not iterable",
          );
        };
      if (name === "__iterator_next")
        // #1620 v2: returns the iterator step as a Wasm multi-value
        // [i32 done, externref value]. V8 destructures the returned 2-element
        // array onto the Wasm stack (the import is declared `(result i32 externref)`).
        // Folds in the old __iterator_done / __iterator_value extraction — those
        // separate imports are gone. No $IteratorResult struct crosses the JS hop.
        return (iter: any): [number, any] => {
          // Resolve iter.next: own → sidecar → __sget_next → WasmGC closure → __call_next.
          let raw: any;
          let next = iter.next ?? _sidecarGet(iter, "next");
          if (next === undefined) {
            const exports = callbackState?.getExports();
            next = exports?.__sget_next?.(iter);
          }
          if (typeof next === "function") {
            raw = next.call(iter);
          } else if (next != null && _isWasmStruct(next)) {
            const exports = callbackState?.getExports();
            const callFn0 = (exports as any)?.__call_fn_0;
            if (typeof callFn0 === "function") raw = callFn0(next);
          }
          // Try __call_next dispatch for WasmGC struct iterators.
          if (raw == null) {
            const exports = callbackState?.getExports();
            const callNext = (exports as any)?.["__call_next"];
            if (typeof callNext === "function") raw = callNext(iter);
          }
          if (raw == null) throw new TypeError("iterator.next is not a function");

          // Extract done: own → sidecar → __sget_done.
          let done = raw.done ?? _sidecarGet(raw, "done");
          if (done === undefined) {
            const exports = callbackState?.getExports();
            done = exports?.__sget_done?.(raw);
          }
          // Extract value: own → sidecar → __sget_value.
          let value = raw.value;
          if (value === undefined) {
            value = _sidecarGet(raw, "value");
            if (value === undefined) {
              const exports = callbackState?.getExports();
              value = exports?.__sget_value?.(raw);
            }
          }
          // Multi-value ABI: return an iterable of [i32 done, externref value].
          return [done ? 1 : 0, value];
        };
      if (name === "__iterator_rest")
        return (iter: any) => {
          // #1052 — drain an already-partially-consumed iterator into an Array
          // for the `[...rest]` binding. Returns a real JS Array so host-side
          // `instanceof Array` and `Array.isArray` observers see correct value.
          const out: any[] = [];
          if (iter == null) return out;
          const next = iter.next ?? _sidecarGet(iter, "next");
          if (typeof next !== "function") return out;
          for (;;) {
            const r = next.call(iter);
            if (r == null || r.done) break;
            out.push(r.value);
          }
          return out;
        };
      if (name === "__iterator_return")
        return (iter: any) => {
          // ES spec 7.4.6 IteratorClose + 7.3.11 GetMethod:
          //   GetMethod returns undefined for null/undefined `return`.
          //   GetMethod throws TypeError if `return` exists but is not callable.
          //   Errors from calling `return()` propagate; non-object results throw.
          // For close-by-throw, the compiler wraps this call in a nested
          // try/catch_all that suppresses any exception (per spec step 6:
          // outer throw wins). For close-by-break/continue/return, the
          // exception propagates to the user — also per spec (step 7). (#1347)
          let ret = iter?.return;
          if (ret === undefined) ret = _sidecarGet(iter, "return");
          if (ret === undefined) {
            const exports = callbackState?.getExports();
            ret = exports?.__sget_return?.(iter);
          }
          if (ret === undefined || ret === null) return; // GetMethod step 3: no-op
          if (typeof ret === "function") {
            const result = ret.call(iter);
            if (result !== null && result !== undefined && typeof result !== "object" && typeof result !== "function") {
              throw new TypeError("Iterator result is not an object");
            }
            return;
          }
          if (_isWasmStruct(ret)) {
            // WasmGC closure: call via __call_fn_0
            const exports = callbackState?.getExports();
            const callFn0 = (exports as any)?.__call_fn_0;
            if (typeof callFn0 === "function") {
              const result = callFn0(ret);
              if (
                result !== null &&
                result !== undefined &&
                typeof result !== "object" &&
                typeof result !== "function"
              ) {
                throw new TypeError("Iterator result is not an object");
              }
            }
            return;
          }
          // ret is non-null, non-callable → GetMethod throws TypeError
          throw new TypeError("Iterator return method is not callable");
        };
      // Convert a WasmGC vec struct to a real JS array so it's iterable by
      // native JS APIs (Map, Set, spread, for-of, etc.). (#854)
      // Uses __vec_len/__vec_get exports (bound lazily after instantiation).
      if (name === "__make_iterable") {
        // Convert WasmGC vec structs and tuple structs to JS arrays.
        // Needed because Map/Set expect [key, value] tuples that are also iterable.
        // Keep one host array per WasmGC array/tuple and refresh it on every
        // crossing. ECMAScript array identity must survive assignments through
        // `any` slots, while refreshing preserves mutations made on the Wasm
        // representation since the previous host observation (#3368).
        const convertedArrays = new WeakMap<object, any[]>();
        const convertToJS = (obj: any): any => {
          if (obj == null || typeof obj !== "object") return obj;
          // (#1438) `obj[Symbol.iterator]` throws "WebAssembly objects are
          // opaque" on wasmGC structs. Check `_isWasmStruct` FIRST so we
          // only walk the struct path for wasm structs and pass through
          // plain JS objects (including non-iterable ones used as WeakMap
          // keys) unchanged.
          if (!_isWasmStruct(obj)) {
            return obj;
          }
          const exports = callbackState?.getExports();
          if (!exports) return obj;
          // Try tuple struct FIRST (e.g. [string, number] for Map entries).
          // Must check before vec because __vec_len returns 0 for non-vec structs,
          // which would incorrectly produce an empty array.
          const fieldNames = exports.__struct_field_names as Function | undefined;
          if (typeof fieldNames === "function") {
            const names = fieldNames(obj) as string | null;
            if (typeof names === "string" && names.length > 0) {
              const parts = names.split(",");
              const isNumeric = parts.every((p: string) => /^_\d+$/.test(p));
              if (isNumeric) {
                const arr = convertedArrays.get(obj) ?? [];
                convertedArrays.set(obj, arr);
                arr.length = parts.length;
                for (let i = 0; i < parts.length; i++) {
                  const getter = exports[`__sget_${parts[i]}`] as Function | undefined;
                  arr[i] = getter ? convertToJS(getter(obj)) : undefined;
                }
                return arr;
              }
            }
          }
          // Try vec struct (homogeneous arrays).
          // (#2836) Gate on the POSITIVE `__is_vec` discriminator (a
          // `ref.test $__vec_base`). `__vec_len` returns its not-a-vec default
          // `0` for ANY non-vec struct, so without this guard a plain object
          // element (e.g. an acorn `Node`) is mis-detected as an empty vec and
          // flattened to `new Array(0)`, erasing its fields. The
          // `typeof isVec !== "function"` fallback preserves old behavior for a
          // module lacking the export (never happens when __vec_len/__vec_get
          // exist — all three are emitted together).
          const vecLen = exports.__vec_len as Function | undefined;
          const vecGet = exports.__vec_get as Function | undefined;
          const isVec = exports.__is_vec as Function | undefined;
          if (
            typeof vecLen === "function" &&
            typeof vecGet === "function" &&
            (typeof isVec !== "function" || isVec(obj))
          ) {
            const len = vecLen(obj) as number;
            if (typeof len === "number" && len >= 0) {
              const arr = convertedArrays.get(obj) ?? [];
              convertedArrays.set(obj, arr);
              // (#3603 S1) Record mirror → vec so a host mutation of this array
              // is replayed onto the vec instead of being silently dropped.
              registerVecMirror(arr, obj);
              arr.length = len;
              for (let i = 0; i < len; i++) {
                arr[i] = convertToJS(vecGet(obj, i));
              }
              // (#2761 B) Surface set-like own props (`arr.size/has/keys`).
              _copyVecSidecarOntoArray(obj, arr, exports);
              return arr;
            }
          }
          return obj;
        };
        return convertToJS;
      }
      // Array iterator methods: entries/keys/values returning proper JS iterators.
      // Access exports lazily (inside next()) because these may be called during
      // module init before setExports has been called.
      if (name === "__array_entries")
        return (arr: any) => {
          let i = 0;
          let len: number | undefined;
          return {
            next() {
              const exports = callbackState?.getExports();
              const vecLen = exports?.__vec_len;
              const vecGet = exports?.__vec_get;
              if (typeof vecLen !== "function" || typeof vecGet !== "function") return { value: undefined, done: true };
              if (len === undefined) len = vecLen(arr) as number;
              if (i >= len) return { value: undefined, done: true };
              const val = vecGet(arr, i);
              const entry = [i, val];
              i++;
              return { value: entry, done: false };
            },
            [Symbol.iterator]() {
              return this;
            },
          };
        };
      if (name === "__array_keys")
        return (arr: any) => {
          let i = 0;
          let len: number | undefined;
          return {
            next() {
              const exports = callbackState?.getExports();
              const vecLen = exports?.__vec_len;
              if (typeof vecLen !== "function") return { value: undefined, done: true };
              if (len === undefined) len = vecLen(arr) as number;
              if (i >= len) return { value: undefined, done: true };
              return { value: i++, done: false };
            },
            [Symbol.iterator]() {
              return this;
            },
          };
        };
      if (name === "__array_values")
        return (arr: any) => {
          let i = 0;
          let len: number | undefined;
          return {
            next() {
              const exports = callbackState?.getExports();
              const vecLen = exports?.__vec_len;
              const vecGet = exports?.__vec_get;
              if (typeof vecLen !== "function" || typeof vecGet !== "function") return { value: undefined, done: true };
              if (len === undefined) len = vecLen(arr) as number;
              if (i >= len) return { value: undefined, done: true };
              return { value: vecGet(arr, i++), done: false };
            },
            [Symbol.iterator]() {
              return this;
            },
          };
        };
      // Fallback for arr.concat(anyArg) when arg is not a known WasmGC array.
      // Converts the WasmGC receiver to a JS array via __vec_len/__vec_get exports,
      // then calls Array.prototype.concat with all arguments.
      if (name === "__array_concat_any")
        return (arr: any, args: any[]) => {
          const exports = callbackState?.getExports();
          const vecLen = exports?.__vec_len;
          const vecGet = exports?.__vec_get;
          // §23.1.3.1 step 5.b / IsConcatSpreadable: an argument that is not a
          // native Array is still spread when its Symbol.isConcatSpreadable
          // property is truthy. Native concat reads that flag for plain JS
          // objects already, but for an opaque WasmGC struct array-like (e.g.
          // `{0:'a', length:2}` with the flag set in the sidecar) it sees a
          // single opaque object and appends it whole — so spread those here.
          const concatLen = (x: any): number => {
            let raw = _safeGet(x, "length", callbackState);
            // `length` on a struct-backed array-like is a real WasmGC field, not
            // a sidecar entry — read it via the __sget_length getter export, the
            // same path __extern_length uses.
            if (raw === undefined) {
              const getter = exports?.__sget_length;
              if (typeof getter === "function") {
                try {
                  raw = (getter as (o: any) => unknown)(x);
                } catch {
                  /* not a field on this struct variant */
                }
              }
            }
            const n = typeof raw === "number" ? raw : Number(raw);
            if (Number.isNaN(n) || n <= 0) return 0;
            return Math.min(Math.trunc(n), 0x1fffffffffffff);
          };
          // §23.1.3.1.1 IsConcatSpreadable step 2: a true Array is ALWAYS
          // spread (the `@@isConcatSpreadable` sidecar only governs non-Array
          // objects). A WasmGC vec is the compiled representation of a true
          // Array, so an argument that responds to `__vec_len` must be spread
          // element-by-element via `__vec_get` — mirroring the receiver
          // conversion below. Without this a vec argument that doesn't carry a
          // sidecar flag falls through to `out.push(x)` and is appended whole
          // (#1969 — data loss → NaN). Returns the spread length, or -1 when
          // `x` is not a vec.
          const tryVecLen = (x: any): number => {
            if (
              x == null ||
              typeof x !== "object" ||
              Array.isArray(x) ||
              !_isWasmStruct(x) ||
              typeof vecLen !== "function" ||
              typeof vecGet !== "function" ||
              // (#3637) POSITIVE discriminator. "Returns … -1 when `x` is not a
              // vec" (the doc comment above) was FALSE: `__vec_len` answers 0
              // for a non-vec struct, so a plain-object argument reported spread
              // length 0 and was SILENTLY DROPPED instead of appended whole.
              // Measured pre-fix: `[0].concat({x: 1})` → `[0]`, where the host
              // answers `[0, {x: 1}]`.
              !_isWasmVec(x, exports)
            ) {
              return -1;
            }
            try {
              const n = vecLen(x);
              return typeof n === "number" && n >= 0 ? n : -1;
            } catch {
              // (#3637) NOT "not a vec" — `_isWasmVec` above already settled
              // that; `__vec_len` returns 0 for a non-vec rather than throwing.
              return -1; // genuine read trap — treat as non-spreadable
            }
          };
          const applyConcat = (out: any[], xs: any[]): any[] => {
            for (const x of xs) {
              // §23.1.3.1.1 IsConcatSpreadable step 2: a real Array (or a WasmGC
              // vec, the compiled form of one) is ALWAYS spread regardless of
              // the `@@isConcatSpreadable` sidecar. An `any`-typed array argument
              // reaches this custom concat as either a JS array (literals lower
              // to externref JS arrays) or an opaque vec struct — both must be
              // spread element-by-element, else the argument is appended whole
              // (#1969 — data loss → NaN).
              if (Array.isArray(x)) {
                for (let i = 0; i < x.length; i++) out.push(x[i]);
                continue;
              }
              const vlen = tryVecLen(x);
              if (vlen >= 0) {
                // tryVecLen only returns >= 0 when vecGet is a function.
                const get = vecGet as (v: any, i: number) => unknown;
                for (let i = 0; i < vlen; i++) out.push(get(x, i));
                continue;
              }
              if (
                x != null &&
                typeof x === "object" &&
                !Array.isArray(x) &&
                _isWasmStruct(x) &&
                _isConcatSpreadable(x, callbackState)
              ) {
                const n = concatLen(x);
                for (let i = 0; i < n; i++) {
                  let v = _safeGet(x, i, callbackState);
                  // Indexed struct fields ("0", "1", …) live in WasmGC fields, not
                  // the sidecar — fall back to the __sget_<i> getter export.
                  if (v === undefined) {
                    const idxGetter = exports?.[`__sget_${i}`];
                    if (typeof idxGetter === "function") {
                      try {
                        v = (idxGetter as (o: any) => unknown)(x);
                      } catch {
                        /* not a field on this struct variant */
                      }
                    }
                  }
                  out.push(v);
                }
              } else {
                out.push(x);
              }
            }
            return out;
          };
          // A host-produced receiver (for example String.prototype.split()) is
          // already a real JavaScript Array. __vec_len deliberately answers 0
          // for non-vec objects, so probing it as a WasmGC vec would discard the
          // receiver. Start from a shallow host-array copy instead.
          if (Array.isArray(arr)) {
            return applyConcat(arr.slice(), args);
          }
          if (typeof vecLen !== "function" || typeof vecGet !== "function") {
            return applyConcat([], args);
          }
          const len = vecLen(arr) as number;
          const jsArr: any[] = new Array(len);
          for (let i = 0; i < len; i++) {
            jsArr[i] = vecGet(arr, i);
          }
          return applyConcat(jsArr, args);
        };
      // Array.prototype.join(sep?) fallback for externref receivers (#1286).
      // When the receiver is a JS array (e.g., from Object.keys host import),
      // we can't go through the WasmGC-native compileArrayJoin path because
      // the externref isn't a WasmGC vec struct. Delegate to the host's own
      // Array.prototype.join implementation. Accepts the receiver as either
      // a JS array or a WasmGC vec — converts vec via __vec_len/__vec_get.
      if (name === "__array_join_any")
        return (arr: any, sep: any) => {
          if (arr == null) return "";
          // JS array: call native .join directly. Pass `undefined` (not the
          // string "undefined") when no separator was supplied so the spec's
          // default ',' takes effect.
          if (Array.isArray(arr)) {
            return sep === undefined || sep === null ? arr.join() : arr.join(String(sep));
          }
          // WasmGC vec: read via exports and join in JS.
          const exports = callbackState?.getExports();
          const jsArr = _toJsArray(arr, exports);
          return sep === undefined || sep === null ? jsArr.join() : jsArr.join(String(sep));
        };
      // Array.prototype.flat(depth?) — flatten nested arrays (#1136)
      // Converts WasmGC vec to JS array, then calls native flat()
      if (name === "__array_flat")
        return (arr: any, depth: any) => {
          const exports = callbackState?.getExports();
          // (#1996) Deeply unwrap nested vec refs so native flat() can flatten
          // them and JSON.stringify renders them as arrays, not null.
          const jsArr = _toJsArrayDeep(arr, exports, VEC_UNWRAP_MAX_DEPTH) as any[];
          // (#1995) An omitted depth arrives as JS null (ref.null.extern), not
          // undefined. `null` would coerce to depth 0 via ToIntegerOrInfinity,
          // so treat both null and undefined as "use the spec default of 1".
          return depth == null ? jsArr.flat() : jsArr.flat(depth);
        };
      // Array.prototype.flatMap(callback, thisArg?) — map then flatten (#1136)
      if (name === "__array_flatMap")
        return (arr: any, fn: Function, thisArg: any) => {
          const exports = callbackState?.getExports();
          const jsArr = _toJsArray(arr, exports);
          // (#1996) The callback may return a WasmGC vec; unwrap its result so
          // flatMap's single-level flatten recognizes it as an array.
          const wrapped = (...args: any[]): any => _toJsArrayDeep((fn as any)(...args), exports, VEC_UNWRAP_MAX_DEPTH);
          return thisArg !== undefined ? jsArr.flatMap(wrapped, thisArg) : jsArr.flatMap(wrapped);
        };
      // Callback bridges for functional array methods
      // Functional-array callbacks can be compiled closures represented by a
      // WasmGC struct rather than a native JS Function.  The legacy bridge
      // used to assume the caller had already wrapped that value, so a
      // module-initializer callback such as Axios's `kindOfTest` reached this
      // path as an object and failed with `fn is not a function`.  Normalize
      // the callback at the boundary; native functions remain unchanged and
      // closure wrapping is identity-cached by `_maybeWrapCallableUnknownArity`.
      if (name === "__call_1_f64")
        return (fn: Function, a: number) => {
          const callable = _maybeWrapCallableUnknownArity(fn, callbackState);
          return callable(a);
        };
      if (name === "__call_2_f64")
        return (fn: Function, a: number, b: number) => {
          const callable = _maybeWrapCallableUnknownArity(fn, callbackState);
          return callable(a, b);
        };
      if (name === "__call_1_i32")
        return (fn: Function, a: number) => {
          const callable = _maybeWrapCallableUnknownArity(fn, callbackState);
          return callable(a);
        };
      if (name === "__call_2_i32")
        return (fn: Function, a: number, b: number) => {
          const callable = _maybeWrapCallableUnknownArity(fn, callbackState);
          return callable(a, b);
        };
      if (name === "__typeof")
        return (v: any) => {
          // (#1594A) Closure structs report `typeof === "object"` in JS, but the
          // spec answer is "function". Probe via `__is_closure` (matches the
          // discriminator used by `_maybeWrapCallableUnknownArity`).
          if (v != null && typeof v === "object" && _isWasmStruct(v)) {
            const exports = callbackState?.getExports();
            const isClosureFn = exports?.__is_closure as ((x: any) => number) | undefined;
            if (typeof isClosureFn === "function") {
              try {
                if (isClosureFn(v) === 1) return "function";
              } catch {
                /* fall through to typeof */
              }
            }
          }
          return typeof v;
        };
      if (name === "__instanceof")
        return (v: any, ctorName: string) => {
          try {
            // (#1455) User subclasses of built-ins (e.g. `class Sub extends Map {}`)
            // are not on globalThis. Check the subclass registry first — it
            // returns a synthetic ctor `Sub` registered by `__set_subclass_proto`.
            // For a given v, walk its proto chain looking for any registered
            // sub-ctor whose prototype matches — this avoids ambiguity when
            // the same `subName` is used across multiple parents (test fixtures).
            // #1933 — per-instance subclass registry (was module-level
            // `_subclassCtors`, which leaked instances via retained ctor
            // closures and crossed instances). Falls back to the module map for
            // legacy callers without an instanceState.
            const bucket = (instanceState?.subclassCtors ?? _subclassCtors).get(ctorName);
            if (bucket !== undefined && bucket.length > 0) {
              for (const subCtor of bucket) {
                if (v instanceof subCtor) return 1;
              }
              // Fall through: maybe globalThis has the same name (unlikely).
            }
            const ctor = (globalThis as any)[ctorName];
            if (typeof ctor === "function" && v instanceof ctor) return 1;
            // (#4394) The host Test262Error by name — no registry knows it.
            if (ctorName === "Test262Error" && test262Host.isHostTest262Error(v)) return 1;
          } catch {
            /* fall through to user-class tag check */
          }
          // (#1455) User-class instanceof for subclasses of builtins. The
          // constructor tags the instance with the innermost class name; walk
          // the parent chain looking for `ctorName`.
          if (v != null && (typeof v === "object" || typeof v === "function")) {
            let tag: string | null | undefined = _userClassTags.get(v as object);
            const guard = new Set<string>();
            while (tag != null && !guard.has(tag)) {
              if (tag === ctorName) return 1;
              guard.add(tag);
              tag = (instanceState?.userClassParents ?? _userClassParents).get(tag) ?? null;
            }
          }
          // (#1729) `<obj> instanceof Object` is true for every object value
          // (§7.3.20 walks the prototype chain to Object.prototype). A
          // WasmGC-struct-backed value (object literal, array, class instance)
          // arriving here as an opaque externref is an object — V8's
          // `v instanceof Object` above returns false for the opaque ref, so
          // recognise it explicitly. Only for the `Object` RHS; primitives
          // never reach this branch as wasm structs.
          if (ctorName === "Object" && v != null && _isWasmStruct(v)) {
            return 1;
          }
          // (#1992) `<fn> instanceof Function` — a compiled closure is a WasmGC
          // struct, so V8's `v instanceof Function` above returns false for the
          // opaque externref. Recognise it via `__is_closure` (the same callable
          // discriminator `__typeof` uses to report "function"), so an
          // `any`-typed callable answers `true` as the spec requires. Closures
          // also have `Object` in their prototype chain — but only the explicit
          // `Function` / `Object` RHS reaches here as a wasm struct.
          if (ctorName === "Function" && v != null && typeof v === "object" && _isWasmStruct(v)) {
            const exports = callbackState?.getExports();
            const isClosureFn = exports?.__is_closure as ((x: any) => number) | undefined;
            if (typeof isClosureFn === "function") {
              try {
                if (isClosureFn(v) === 1) return 1;
              } catch {
                /* fall through to false */
              }
            }
          }
          // (#2702) §13.10.2 step 1/4: a RHS identifier that resolves to a
          // *non-callable* object — `x instanceof Math` / `instanceof JSON` —
          // must throw a TypeError (or honor a custom @@hasInstance) rather than
          // silently answering `false`. Delegate to the shared spec helper,
          // which returns `2` to tell the wasm caller to throw. Callable
          // constructors and names that don't resolve on `globalThis` keep the
          // historical `return 0` (no new throws on unresolved/false cases).
          {
            const ctorVal = (globalThis as any)[ctorName];
            if (ctorVal !== undefined && ctorVal !== null && typeof ctorVal !== "function") {
              return _instanceofResult(v, ctorVal, callbackState, /* strict */ true);
            }
          }
          return 0;
        };
      if (name === "__instanceof_check")
        return (v: any, ctor: any) => _instanceofResult(v, ctor, callbackState, /* strict */ false);
      if (name === "__instanceof_dyn")
        return (v: any, ctor: any) => {
          try {
            const wrappedCtor = _maybeWrapCallableUnknownArity(ctor, callbackState);
            if (typeof wrappedCtor === "function")
              return fnctorOrNative(v, wrappedCtor, _fnctorInstanceofResult(v, wrappedCtor, callbackState));
            if (typeof ctor === "function") return v instanceof ctor ? 1 : 0;
          } catch {
            return 0;
          }
          return 0;
        };
      // (#1455) Tag an externref-backed user-class instance with the innermost
      // user-class name and register its user-class parent (or null if the
      // direct parent is a builtin like Map).
      if (name === "__tag_user_class")
        return (instance: any, className: string, parentName: string | null | undefined) => {
          if (instance == null) return;
          if (typeof instance !== "object" && typeof instance !== "function") return;
          _userClassTags.set(instance as object, className);
          // Register the parent edge (idempotent). Null parent indicates the
          // direct parent is a builtin, so the chain terminates.
          const userClassParents = instanceState?.userClassParents ?? _userClassParents;
          if (!userClassParents.has(className)) {
            userClassParents.set(className, parentName == null ? null : parentName);
          }
        };
      // (#3123) `class C extends F` where F is a top-level PLAIN FUNCTION
      // (fnctor — the test262 harness `Iterator` shim shape): the ctor
      // registers each instance → F's closure struct so host-side member
      // resolution (`_fnctorProtoLookup` via `_safeGet` / `_resolveHostField` /
      // `__extern_method_call`) walks F's LIVE `.prototype` chain for
      // inherited reads (`inst.drop` → the runtime-assigned helper proto).
      if (name === "__register_fnctor_instance")
        return (instance: any, ctorClosure: any): void => {
          if (instance == null || typeof instance !== "object") return;
          if (ctorClosure == null || typeof ctorClosure !== "object") return;
          if (!_canBeWeakKey(instance)) return;
          _fnctorInstanceCtor.set(instance, ctorClosure);
        };
      // (#1455) Subclasses of host builtins: after `__new_<Parent>(args)`
      // returns the bare host instance whose [[Prototype]] is Parent.prototype,
      // we set the instance's prototype to a synthetic `Sub.prototype` that
      // inherits from Parent.prototype. The synthetic ctor is registered on
      // first call (idempotent), keyed by `name`, and reused thereafter so
      // `instance instanceof Sub` returns true (matched by `__instanceof`).
      if (name === "__set_subclass_proto")
        return (instance: any, subName: string, parentName: string) => {
          if (instance == null || typeof subName !== "string" || typeof parentName !== "string") {
            return instance;
          }
          const Parent: any = resolveSubclassParent(parentName, deps, _resolveNamespacedClass);
          if (typeof Parent !== "function") {
            // Cannot synthesize — return instance unchanged.
            return instance;
          }
          // Find a cached synthetic ctor whose parent matches. The cache is a
          // small array per `subName` so multiple parents (e.g. across test
          // fixtures that reuse the same class name) don't collide.
          // #1933 — per-instance registry so the synthetic ctors (which close
          // over this instance) don't retain it forever across hot-reloads.
          const subclassCtors = instanceState?.subclassCtors ?? _subclassCtors;
          let bucket = subclassCtors.get(subName);
          let Sub: any;
          if (bucket !== undefined) {
            for (const candidate of bucket) {
              if (Object.getPrototypeOf((candidate as any).prototype) === Parent.prototype) {
                Sub = candidate;
                break;
              }
            }
          }
          if (Sub === undefined) {
            try {
              // Synthesize a real JS subclass so `instance instanceof Sub`
              // works via the engine's standard prototype-walk semantics.
              Sub = class extends Parent {};
              try {
                Object.defineProperty(Sub, "name", { value: subName, configurable: true });
              } catch {
                /* ignore */
              }
              if (bucket === undefined) {
                bucket = [];
                subclassCtors.set(subName, bucket);
              }
              bucket.push(Sub);
            } catch {
              return instance;
            }
          }
          try {
            const proto = (Sub as any).prototype;
            if (proto != null && Object.getPrototypeOf(instance) !== proto) {
              Object.setPrototypeOf(instance, proto);
            }
          } catch {
            /* Object.setPrototypeOf may be unsupported on some exotic instances; ignore */
          }
          return instance;
        };
      // parseInt / parseFloat host imports
      //
      // #1436 — pass the argument directly to the native global function so
      // its internal ToString step throws TypeError on Symbol/BigInt per
      // ECMA-262 §19.2.5 / §19.2.4 (parseInt / parseFloat both invoke
      // ? ToString(string) which is the centralized ToString funnel).
      // Wrapping in `String(s)` swallowed that TypeError because the
      // `String` constructor returns SymbolDescriptiveString for Symbols
      // (and never throws) — `parseInt(Symbol())` then silently coerced to
      // NaN instead of propagating the spec-required TypeError.
      if (name === "parseInt")
        return (s: any, radix: number) => {
          const r = Number.isNaN(radix) ? undefined : radix;
          return parseInt(s as any, r as any);
        };
      if (name === "parseFloat")
        return (s: any) => {
          // For Boolean/Number/String wrapper objects (new Boolean(true), etc.),
          // use Number() coercion which calls valueOf() → 1/0/string.
          // parseFloat(String(new Boolean(true))) = parseFloat("true") = NaN, which
          // breaks arithmetic like `"1" / new Boolean(true)`. (#929)
          if (s != null && typeof s === "object") {
            try {
              return Number(s);
            } catch {
              /* fall through */
            }
          }
          // Direct pass-through — for Symbol the native parseFloat throws
          // TypeError via ToString per spec; the wasm catch_all sink will
          // observe it. (#1436)
          return parseFloat(s as any);
        };
      // URI encoding/decoding host imports.
      // #1436 — direct pass-through so the native ToString step throws
      // TypeError on Symbol/BigInt per ECMA-262 §19.2.6 (encodeURI /
      // decodeURI / encodeURIComponent / decodeURIComponent all invoke
      // ? ToString(uri) as their first step). Wrapping in `String(s)`
      // silently turned `encodeURI(Symbol())` into "Symbol(desc)" instead
      // of throwing TypeError.
      if (name === "decodeURI") return (s: any) => decodeURI(s as any);
      if (name === "decodeURIComponent") return (s: any) => decodeURIComponent(s as any);
      if (name === "encodeURI") return (s: any) => encodeURI(s as any);
      if (name === "encodeURIComponent") return (s: any) => encodeURIComponent(s as any);
      // (#3063) Legacy `escape` / `unescape` (§B.2.1 / §B.2.2) — pure string
      // transforms. Like the URI globals, direct pass-through so the native
      // ToString step throws TypeError on Symbol per spec step 1 (? ToString).
      if (name === "escape") return (s: any) => escape(s as any);
      if (name === "unescape") return (s: any) => unescape(s as any);
      // #1500 — `fetch` host import: bridge to globalThis.fetch when available.
      // The compiler routes bare `fetch(url, init?)` identifier calls through
      // this builtin; the host call returns a real JS `Promise<Response>` that
      // the existing `__await` machinery unwraps. `.json()` / `.text()` /
      // `.status` / `.ok` on the Response reach JS via the existing
      // `extern_class` dispatch for class `Response` (duck-typed) and the
      // `extern_get` path (primitive properties).
      //
      // Standalone-mode fallback per CLAUDE.md Architecture Principles: throw a
      // descriptive error when no host `fetch` exists (WASI / pure standalone).
      // A WASI HTTP wiring is out of scope for this issue.
      if (name === "fetch")
        return (url: any, init: any) => {
          const hostFetch = (globalThis as any).fetch;
          if (typeof hostFetch !== "function") {
            throw new Error(
              "js2wasm: fetch is not available in this environment (compile with a JS host or polyfill globalThis.fetch)",
            );
          }
          // Convert WasmGC struct init bag → plain JS so the host can read
          // .method / .headers / .body. Pass `undefined` rather than `null`
          // when init is absent so the host fetch sees the same default-arg
          // behavior as ordinary JS `fetch(url)`.
          const exports = callbackState?.getExports();
          const plainInit = init == null ? undefined : _isWasmStruct(init) ? _wasmToPlain(init, exports) : init;
          return hostFetch(url, plainInit);
        };
      // String.fromCharCode / String.fromCodePoint host imports
      if (name === "String_fromCharCode") return (code: number) => String.fromCharCode(code);
      if (name === "String_fromCodePoint") return (code: number) => String.fromCodePoint(code);
      // String comparison (lexicographic ordering)
      if (name === "string_compare") return (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      // ToUint32 for Math.clz32/imul — spec-correct conversion
      // (x >>> 0) applies the ToUint32 abstract operation per ES spec
      if (name === "__toUint32") return (x: number) => x >>> 0;
      // (#1490) Node.js process.* host imports — only meaningful when running
      // under Node (or any host that injects a `process` global). In other
      // environments (browser, standalone Wasm) these return safe defaults so
      // compiled programs do not crash on access.
      if (name === "__get_process_argv")
        return () => (typeof process !== "undefined" && process.argv ? process.argv : []);
      if (name === "__get_process_env") return () => (typeof process !== "undefined" && process.env ? process.env : {});
      if (name === "__get_process_cwd")
        return () => {
          if (typeof process !== "undefined" && typeof process.cwd === "function") {
            return process.cwd();
          }
          return "";
        };
      if (name === "__get_process_platform")
        return () => (typeof process !== "undefined" && process.platform ? process.platform : "");
      if (name === "__get_process_arch")
        return () => (typeof process !== "undefined" && (process as any).arch ? (process as any).arch : "");
      if (name === "__process_exit")
        return (code: number) => {
          // f64 → integer exit code (NaN/Infinity → 0 per spec coercion).
          const c = Number.isFinite(code) ? code | 0 : 0;
          if (typeof process !== "undefined" && typeof process.exit === "function") {
            process.exit(c);
            return;
          }
          // Hosts without process.exit (browser, standalone): throw so the
          // caller can observe the exit attempt rather than silently continuing.
          throw new Error(`process.exit(${c}) called but no host process.exit available`);
        };
      // (#1503) Web Crypto host imports — crypto.randomUUID() and
      // crypto.getRandomValues(typedArray). Prefer globalThis.crypto
      // (Web Crypto API; available in browsers + Node 19+); fall back to
      // `require('node:crypto')` for older Node. Pure-standalone hosts
      // (no crypto, no `require`) throw rather than silently degrading to
      // `Math.random()` — see issue notes on the security trap that
      // creates.
      if (name === "__crypto_random_uuid")
        return () => {
          const gc: any = (globalThis as any).crypto;
          if (gc && typeof gc.randomUUID === "function") {
            return gc.randomUUID();
          }
          const req = _getNodeRequire();
          if (req) {
            try {
              return req("node:crypto").randomUUID();
            } catch {
              /* fall through */
            }
          }
          throw new Error("crypto.randomUUID is not available in this host");
        };
      if (name === "__crypto_get_random_values")
        return (vec: any) => {
          const exports = callbackState?.getExports();
          // Prefer __vec_set_byte (handles all writable vec element types —
          // f64-backed Uint8Array etc., plus i32_byte ArrayBuffer). Fall
          // back to __dv_byte_set for i32_byte-only modules.
          const vecLen = exports?.__vec_len as ((v: any) => number) | undefined;
          const vecSet = exports?.__vec_set_byte as ((v: any, i: number, b: number) => void) | undefined;
          const dvLen = exports?.__dv_byte_len as ((v: any) => number) | undefined;
          const dvSet = exports?.__dv_byte_set as ((v: any, i: number, b: number) => void) | undefined;
          let n: number;
          let setByte: (v: any, i: number, b: number) => void;
          // (#3637) POSITIVE discriminator: `__vec_len` answers 0 for a non-vec,
          // so a DataView / i32_byte buffer in a module that ALSO exports
          // `__vec_len` took this branch with n = 0 and was filled with zero
          // random bytes instead of falling through to the `__dv_byte_*` path.
          if (typeof vecLen === "function" && typeof vecSet === "function" && _isWasmVec(vec, exports)) {
            n = vecLen(vec);
            setByte = vecSet;
          } else if (typeof dvLen === "function" && typeof dvSet === "function") {
            const m = dvLen(vec);
            if (m < 0) {
              throw new TypeError("crypto.getRandomValues: argument is not a Uint8Array / ArrayBufferView");
            }
            n = m;
            setByte = dvSet;
          } else {
            throw new TypeError("crypto.getRandomValues: argument is not a typed-array (Uint8Array required)");
          }
          if (n < 0 || !Number.isFinite(n)) {
            throw new TypeError("crypto.getRandomValues: argument is not a Uint8Array / ArrayBufferView");
          }
          const tmp = new Uint8Array(n);
          const gc: any = (globalThis as any).crypto;
          if (gc && typeof gc.getRandomValues === "function") {
            gc.getRandomValues(tmp);
          } else {
            const req = _getNodeRequire();
            let filled = false;
            if (req) {
              try {
                req("node:crypto").randomFillSync(tmp);
                filled = true;
              } catch {
                /* fall through to throw below */
              }
            }
            if (!filled) {
              throw new Error("crypto.getRandomValues: no secure RNG available in this host");
            }
          }
          for (let i = 0; i < n; i++) setByte(vec, i, tmp[i]!);
          return vec;
        };
      // Native string marshaling (fast mode)
      if (name === "__str_extern_len") return (s: string) => s.length;
      if (name === "__str_from_mem") {
        // Returns a function that reads i16 code units from wasm memory
        // The memory is bound lazily after instantiation
        return (ptr: number, len: number) => {
          const exports = callbackState?.getExports();
          const mem = exports?.__str_mem as WebAssembly.Memory | undefined;
          if (!mem) return "";
          if (len <= 0) return "";
          const byteLen = len * 2;
          if (ptr < 0 || ptr + byteLen > mem.buffer.byteLength) return "";
          const u16 = new Uint16Array(mem.buffer, ptr, len);
          // Avoid spread for large arrays (stack overflow at ~65k elements)
          if (len <= 4096) return String.fromCharCode(...u16);
          const parts: string[] = [];
          for (let i = 0; i < len; i += 4096) {
            const chunk = u16.subarray(i, Math.min(i + 4096, len));
            parts.push(String.fromCharCode(...chunk));
          }
          return parts.join("");
        };
      }
      if (name === "__str_to_mem") {
        return (s: string, ptr: number) => {
          const exports = callbackState?.getExports();
          const mem = exports?.__str_mem as WebAssembly.Memory | undefined;
          if (!mem) return;
          const byteLen = s.length * 2;
          if (ptr < 0 || ptr + byteLen > mem.buffer.byteLength) return;
          const u16 = new Uint16Array(mem.buffer, ptr, s.length);
          for (let i = 0; i < s.length; i++) {
            u16[i] = s.charCodeAt(i);
          }
        };
      }
      // (#3325) A user-level ambient `declare function f(...)` is a `builtin`
      // intent but NOT an internal helper special-cased above (every recognised
      // builtin returns before here). The call site emits `call $f_import`
      // correctly; the miss was that this fallback no-op'd and ignored `deps`.
      // Wire it to the supplied dependency — the natural FFI for embedders.
      const userDep = deps?.[name];
      if (typeof userDep === "function") return (...args: any[]) => userDep(...args);
      if (userDep !== undefined) return () => userDep;
      // No matching dep → keep the historical no-op. (An earlier revision threw
      // a clear error for a called-but-undepped user-facing ambient name, but
      // the test262 harness legitimately declares ambient functions it does not
      // always supply — e.g. host print/log stubs — and relies on the no-op, so
      // throwing regressed the merged-state test262 gate. The dep-wiring above
      // is the actual #3325 fix; a targeted "missing dep" diagnostic gated to
      // non-harness contexts is a possible follow-up.)
      return () => {};
    }
    // (#4394) `intent.constructible` is set only by `__make_callback_ctor`, the
    // maker the compiler picks for an ordinary function definition — the one
    // callable form with [[Construct]]. Everything else keeps the arrow bridge.
    case "callback_maker":
      return (id: number, cap: any) => {
        if (id === -2) return _wrapVoidHostCallback(cap, callbackState, false);
        if (id === -1) return _wrapVoidHostCallback(cap, callbackState);
        const policy = ASYNC_CALLBACK_EXCEPTION_POLICY;
        const constructible = intent.constructible === true;
        return createNativeFunctionCallbackBridge(id, cap, callbackState, policy, constructible);
      };
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
              const self = this;
              defer(() => {
                invokeNativeFunctionCallback(id, cap, [self, ...args], callbackState, ASYNC_CALLBACK_EXCEPTION_POLICY);
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
    case "typeof_check": {
      // (#3996) A compiled closure crossing an externref boundary is an opaque
      // WasmGC object to JavaScript, so the host's native `typeof` reports
      // "object" even though the value has ECMAScript [[Call]]. The module's
      // generated discriminator has the complete closure-type census and is
      // wired through setInstance after instantiation. Consult it for the two
      // overlapping categories; ordinary host values stay on native typeof.
      const isCompiledClosure = (value: any): boolean => {
        const classifier = callbackState?.getExports()?.__is_closure;
        if (typeof classifier !== "function") return false;
        try {
          return classifier(value) === 1;
        } catch {
          return false;
        }
      };
      if (intent.targetType === "function") {
        return (v: any) => (typeof v === "function" || isCompiledClosure(v) ? 1 : 0);
      }
      if (intent.targetType === "object") {
        return (v: any) => (typeof v === "object" && !isCompiledClosure(v) ? 1 : 0);
      }
      // biome-ignore lint/suspicious/useValidTypeof: targetType is a runtime string from compiled code
      return (v: any) => (typeof v === intent.targetType ? 1 : 0);
    }
    case "box":
      if (intent.targetType === "boolean") return (v: number) => Boolean(v);
      // (#1644) __box_bigint: JS-BigInt-integration already delivers the wasm
      // i64 as a JS bigint at the boundary, so boxing is identity.
      if (intent.targetType === "bigint") return (v: bigint) => v;
      return (v: number) => v;
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
      return (v: any) => {
        // For objects, try our ToPrimitive first — Number() on WasmGC structs
        // returns NaN without throwing (#866), and proxied structs may have
        // WasmGC closures for Symbol.toPrimitive that V8 can't call (#1090).
        if (v != null && typeof v === "object") {
          const prim = _toPrimitive(v, "number", callbackState);
          if (prim !== undefined) {
            // #1434 — Number() throws TypeError on Symbol/BigInt primitives.
            // Per ECMA-262 §7.1.4 ToNumber, Symbol MUST throw TypeError; the
            // unbox/number intent is the centralized ToNumber funnel, so we
            // let the exception propagate to Wasm catch_all instead of
            // silently turning it into NaN.
            return Number(prim);
          }
          // _toPrimitive returned undefined — try the full host ToPrimitive (#1090)
          // which checks real JS properties, sidecar, and Wasm exports.
          // Let TypeError propagate so Wasm catch_all can intercept it.
          const prim2 = _hostToPrimitive(v, "number", callbackState);
          return Number(prim2);
        }
        // #1434 — Symbol/BigInt primitives: Number() throws TypeError per
        // §7.1.4. The previous try/catch swallowed this and returned NaN,
        // letting `Number(Symbol())`, `+Symbol()`, `-Symbol()`, `~Symbol()`,
        // `0 + Symbol()` etc. silently coerce. Let the exception propagate.
        return Number(v);
      };
    case "any_to_index":
      // #3511 — Symbol-safe array-index probe. The dynamic-`any`-index element
      // access (`obj[key]` get/set/delete) ToNumber-probes the key to decide
      // vec-index vs property-key. Using the throwing `__unbox_number` (ToNumber)
      // for that probe made a **Symbol** (or BigInt) key throw "Cannot convert a
      // Symbol value to a number" BEFORE the `__extern_get(recv, key)` property
      // fallback — but `obj[symbol]` is an ordinary property access. This probe
      // NEVER throws: a value whose ToNumber would throw returns NaN, so the
      // caller's integer round-trip guard fails and routes to the property path.
      // For every non-throwing input it matches `__unbox_number` exactly (numeric
      // strings, booleans, null/undefined, object valueOf), so numeric/string
      // keys keep byte-identical index behavior.
      return (v: any) => {
        if (typeof v === "symbol" || typeof v === "bigint") return NaN;
        try {
          if (v != null && typeof v === "object") {
            const prim = _toPrimitive(v, "number", callbackState);
            if (prim !== undefined) return Number(prim);
            return Number(_hostToPrimitive(v, "number", callbackState));
          }
          return Number(v);
        } catch {
          // A ToPrimitive/ToNumber that throws (e.g. valueOf → Symbol/BigInt)
          // means the key is not an array index — treat as a property key.
          return NaN;
        }
      };
    case "truthy_check":
      return (v: any) => (v ? 1 : 0);
    case "extern_get":
      return (obj: any, key: any) => {
        if (obj != null && typeof obj === "object") {
          try {
            if (Object.getPrototypeOf(obj) !== null && key in Object(obj)) {
              const v = obj[key];
              // (#3097) Exit-boundary un-marshal: a canonical host ArrayBuffer
              // (minted at the construct bridge for a compiled buffer struct)
              // presents to COMPILED code as the original vec struct —
              // `sample.buffer === buffer` identity holds, and re-crossing
              // (`new TA2(sample.buffer)`) canonicalizes to the SAME host
              // buffer.
              if (v instanceof ArrayBuffer) {
                const rawVec = _abHostBufferReverse.get(v);
                if (rawVec !== undefined) return rawVec;
              }
              return _sandboxConstructorValue(v, key, globalSandbox);
            }
          } catch {
            /* fall through to the generic path */
          }
        }
        const val = _safeGet(obj, key, callbackState, intent.rawCallable === true);
        if (val !== undefined) {
          // (#779c) Sandbox-aware constructor identity. When a
          // `globalSandbox` is supplied (test262 per-test realm isolation),
          // the test's `Array` identifier resolves via `declared_global` to
          // `sandbox.Array`, but `obj.constructor` for host JS arrays
          // returns `globalThis.Array`. Substitute the sandbox version so
          // `arr.constructor === Array` holds. No-op without a sandbox.
          return _sandboxConstructorValue(val, key, globalSandbox);
        }
        if (obj == null || typeof obj !== "object") return undefined;
        try {
          if (Object.getPrototypeOf(obj) !== null) return undefined;
        } catch {
          return undefined;
        }
        const sc = _wasmStructProps.get(obj);
        const descs = _wasmPropDescs.get(obj);
        const flags = descs?.get(_normalizeDescKey(key));
        const owns = typeof key === "string" && _structHasOwnFieldName(obj, key, callbackState?.getExports());
        if (wsh.masksField(sc, key, flags, owns, _SC_ACCESSOR)) return undefined;
        if (typeof key === "string") {
          // A delete tombstone outranks the immutable backing field (#2179).
          const tomb = _wasmStructDeletedKeys.get(obj);
          if (tomb && tomb.has(key)) return undefined;
          const exports = callbackState?.getExports();
          const getter = exports?.[`__sget_${key}`];
          const fieldValue = wsh.readField(getter, obj, _structOwnFieldStatus(obj, key, exports));
          if (fieldValue !== wsh.NO_GENERATED_FIELD) return fieldValue;
          // Generic `.byteLength` on an ArrayBuffer/DataView byte vec (#3097).
          if (key === "byteLength") {
            const bl = _byteVecByteLength(obj, exports);
            if (bl !== undefined) return bl;
          }
          // Compiled-AB max/resizable/resize semantics (#3058).
          if (key === "maxByteLength" || key === "resizable") {
            const bl = _byteVecByteLength(obj, exports);
            if (bl !== undefined) {
              const ml = _abMaxByteLength(obj, exports);
              if (key === "resizable") return ml >= 0;
              if (_detachedBuffers.has(obj) || _sidecarGet(obj, "__detached__")) return 0;
              return ml >= 0 ? ml : bl;
            }
          }
          if (key === "resize") {
            const bl = _byteVecByteLength(obj, exports);
            if (bl !== undefined) {
              return (newLength: any) => {
                _abResizeStruct(obj, newLength, exports);
                return undefined;
              };
            }
          }
        }
        // (#3486) A registered fnctor instance's `.constructor` back-pointer.
        // `function MyError(m){this.message=m}; new MyError()` lowers to a
        // bespoke `$__fnctor_MyError` struct; the instance → ctor-closure link
        // is recorded by the `__register_fnctor_instance` import (#1712). Answer
        // `.constructor` with the SAME closure the bare `MyError` identifier
        // resolves to, wrapped through the identity-stable `_hostCallableCache`
        // so (a) `typeof inst.constructor === "function"` holds, (b) `.name`
        // reads the codegen-stamped sidecar name, and (c) the wrapper unwraps
        // to its closure target in `_hostStrictEqual`, which is what compiled
        // `===` on two externrefs routes through (`__host_eq`). That makes
        // `thrown.constructor === MyError` — the identity check inside
        // test262's `assert.throws` — genuinely true.
        //
        // Placed BEFORE the vec arm below: both are `_isWasmStruct` arms and the
        // instance→ctor link is the more specific identity. It cannot claim a
        // genuine vec (a vec is never a registered fnctor instance) and cannot
        // claim a class instance (those return through the sidecar / `__sget_`
        // paths above, long before here).
        if (key === "constructor" && obj != null && _isWasmStruct(obj) && _canBeWeakKey(obj)) {
          const ctorClosure = _fnctorInstanceCtor.get(obj);
          if (ctorClosure != null) {
            return ctorClosure;
          }
        }
        // #1057 — vec wrapper structs (results of String.prototype.split,
        // Array.prototype.map, etc.) must report `.constructor === Array`.
        // Only fire AFTER _safeGet and __sget_ fallback return nothing —
        // class instances with sidecar constructors or struct getters are
        // already handled above.
        //
        // (#3486) Gate on the POSITIVE `__is_vec` discriminator, not on
        // `typeof __vec_len(obj) === "number"`. That old test was VACUOUS:
        // `__vec_len`'s not-a-vec default is `0` (see the ref.test dispatch
        // chain in codegen/vec-access-exports.ts — it returns 0, it does not
        // throw), and `typeof 0 === "number"`, so EVERY WasmGC struct reaching
        // this arm was reported as an Array. That is the root cause of #3486:
        // a caught `new MyError()` answered `.constructor.name === "Array"`.
        // The same vacuity was already fixed at the other `__vec_len` call
        // sites by #2836; this arm was missed. `__is_vec` is emitted by the
        // same pass as `__vec_len` (`_emitVecAccessExportsInner`), so the
        // legacy branch below is reachable only if that pass half-emitted;
        // it is kept so such a module keeps its pre-#3486 bytes rather than
        // silently losing `vec.constructor === Array`.
        if (key === "constructor" && obj != null && _isWasmStruct(obj)) {
          const exports = callbackState?.getExports();
          const isVec = exports?.__is_vec as ((v: any) => number) | undefined;
          const vecLen = exports?.__vec_len;
          if (typeof isVec === "function") {
            try {
              if (isVec(obj) === 1) {
                // (#779c) Return sandbox.Array when test262 sandbox is active,
                // so `vec.constructor === Array` (sandbox.Array) holds.
                return globalSandbox?.Array ?? Array;
              }
            } catch {
              // Not a vec wrapper — fall through
            }
          } else if (typeof vecLen === "function") {
            try {
              const len = vecLen(obj);
              if (typeof len === "number") {
                return globalSandbox?.Array ?? Array;
              }
            } catch {
              // Not a vec wrapper — fall through
            }
          }
        }
        if (key === "constructor" && obj != null && _isWasmStruct(obj)) {
          const fields = _getStructFieldNames(obj, callbackState?.getExports());
          if (wsh.ordinaryFields(fields)) return globalSandbox?.Object ?? Object;
        }
        // (#1712) `<fn>.prototype` on a Wasm closure struct: auto-vivify an
        // identity-stable real JS object in the closure's sidecar (mirrors
        // the by-name __extern_get binding).
        if (key === "prototype") {
          const proto = _getOrVivifyFnPrototype(obj, callbackState);
          if (proto !== undefined) return proto;
        }
        return undefined;
      };
    case "extern_call_raw_callable":
      return _makeRawCallableInvoker(intent.arity, callbackState);
    case "extern_set":
      return (obj: any, key: any, val: any) => {
        // (#860) Wrap closure-as-value before storing — see __extern_set
        // binding above. Mirrors the by-name path.
        let wrappedVal =
          key === "valueOf" || key === "toString"
            ? _maybeWrapCallable(val, 0, callbackState)
            : _maybeWrapCallableUnknownArity(val, callbackState);
        // (#3051) `regexp.exec = fn` override — wrap the return so the native
        // RegExp protocol (@@replace/@@split/@@match/@@search) can read the
        // compiled match-result object (a WasmGC struct) via Get + ToXxx.
        if (typeof wrappedVal === "function" && key === "exec" && obj instanceof RegExp) {
          wrappedVal = _wrapExecReturnForHost(wrappedVal, callbackState);
        }
        _safeSet(obj, key, wrappedVal, undefined, callbackState);
      };
    case "extern_set_strict":
      // (#2017) Strict-mode [[Set]] (§10.1.9): a write to a getter-only accessor
      // / non-writable / non-extensible-new property throws a catchable
      // TypeError instead of silently failing. The compiler routes user
      // `obj.k = v` accessor writes here (ESM is always strict); the throw is
      // catchable in the user's try/catch via the host-import exception bridge.
      return (obj: any, key: any, val: any) => {
        let wrappedVal =
          key === "valueOf" || key === "toString"
            ? _maybeWrapCallable(val, 0, callbackState)
            : _maybeWrapCallableUnknownArity(val, callbackState);
        // (#3051) See extern_set — wrap a `regexp.exec` override's return so the
        // native RegExp protocol can read the compiled result object.
        if (typeof wrappedVal === "function" && key === "exec" && obj instanceof RegExp) {
          wrappedVal = _wrapExecReturnForHost(wrappedVal, callbackState);
        }
        _safeSet(obj, key, wrappedVal, undefined, callbackState, /* strict */ true);
      };
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

/** Wrap an extern_class import function with DOM containment logic.
 *  Restricts DOM access to the subtree rooted at `domRoot`. */
function wrapWithContainment(
  fn: Function,
  intent: ImportIntent & { type: "extern_class" },
  domRoot: Element | ShadowRoot,
): Function {
  const { className, action, member } = intent;

  // Traversal properties that could escape containment
  const traversalProps = new Set(["parentElement", "parentNode", "offsetParent"]);

  // Dangerous properties — block entirely (return null)
  const blockedProps = new Set(["ownerDocument", "baseURI", "getRootNode"]);

  // Mutation methods that need containment check
  const mutationMethods = new Set([
    "appendChild",
    "removeChild",
    "insertBefore",
    "replaceChild",
    "remove",
    "append",
    "prepend",
    "after",
    "before",
    "replaceWith",
    "insertAdjacentElement",
    "insertAdjacentHTML",
    "insertAdjacentText",
  ]);

  // Helper: check if domRoot contains an element (duck-typed for mock objects)
  function isContained(el: any): boolean {
    if (el === domRoot) return true;
    if (typeof (domRoot as any).contains === "function") {
      return (domRoot as any).contains(el);
    }
    return true; // If domRoot doesn't support contains, pass through
  }

  // Helper: check if a value is a DOM node
  function isNodeLike(v: any): boolean {
    if (v == null || typeof v !== "object") return false;
    // Prefer instanceof Node when available (browser environment)
    if (typeof Node !== "undefined") return v instanceof Node;
    // Fallback: check for nodeType (a number), the most reliable DOM indicator
    return typeof v.nodeType === "number";
  }

  // For "new" action — constructor (e.g. new Document)
  if (action === "new" && className === "Document") {
    return () => domRoot;
  }

  // For get actions
  if (action === "get" && member) {
    if (blockedProps.has(member)) {
      return (_self: any) => null;
    }
    if (traversalProps.has(member)) {
      return (self: any) => {
        const result = self[member];
        if (result == null) return result;
        if (isNodeLike(result) && !isContained(result)) return null;
        return result;
      };
    }
    // Safe property — containment check on self
    return (self: any) => {
      if (self !== domRoot && isNodeLike(self) && !isContained(self)) {
        throw new Error(`DOM containment violation: accessing "${member}" on element outside container`);
      }
      return self[member];
    };
  }

  // For set actions
  if (action === "set" && member) {
    return (self: any, v: any) => {
      if (self !== domRoot && isNodeLike(self) && !isContained(self)) {
        throw new Error(`DOM containment violation: setting "${member}" on element outside container`);
      }
      self[member] = v;
    };
  }

  // For method actions
  if (action === "method" && member) {
    // Document query methods — redirect to domRoot
    if (
      (className === "Document" || className === "document") &&
      (member === "querySelector" ||
        member === "querySelectorAll" ||
        member === "getElementById" ||
        member === "getElementsByClassName" ||
        member === "getElementsByTagName")
    ) {
      return (_self: any, ...args: any[]) => (domRoot as any)[member](...args);
    }
    // createElement is safe — just creates a detached element
    if ((className === "Document" || className === "document") && member === "createElement") {
      return fn;
    }

    if (mutationMethods.has(member)) {
      return (self: any, ...args: any[]) => {
        if (self !== domRoot && isNodeLike(self) && !isContained(self)) {
          throw new Error(`DOM containment violation: calling "${member}" on element outside container`);
        }
        return self[member](...args);
      };
    }

    // Other methods — containment check on self
    return (self: any, ...args: any[]) => {
      if (self !== domRoot && isNodeLike(self) && !isContained(self)) {
        throw new Error(`DOM containment violation: calling "${member}" on element outside container`);
      }
      return self[member](...args);
    };
  }

  // Default: return original
  return fn;
}

/**
 * These intents resolve to leaf functions that cannot throw or call user code,
 * so they cannot re-enter Wasm. Their import wrappers therefore do not need the
 * recursion-depth or catch-all bookkeeping used by general host operations.
 * Keep this predicate intent-based: `buildImports` is public and must not trust
 * a caller-supplied import name to imply safe behaviour.
 */
function isFastLeafHostImport(imp: ImportDescriptor): boolean {
  switch (imp.intent.type) {
    case "box":
    case "typeof_check":
    case "truthy_check":
      return true;
    case "unbox":
      return imp.intent.targetType === "boolean";
    case "builtin":
      return imp.intent.name === "__get_undefined";
    default:
      return false;
  }
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
  /**
   * Runtime implementation for dynamic eval and new Function.
   *
   * `compat` preserves the existing meta-circular-first path and its native
   * fallback. `native` delegates directly to the current realm's eval/Function.
   * `evaluator` delegates to the explicit evaluator below. `deny` fails closed.
   */
  dynamicCode?: DynamicCodePolicy;
  /** Synchronous evaluator used only when `dynamicCode` is `evaluator`. */
  dynamicCodeEvaluator?: DynamicCodeEvaluator;
}

export type DynamicCodePolicy = "compat" | "native" | "evaluator" | "deny";

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
    symbolDescRegistry: new Map<number, string | null>(),
    legacyRegExpState: _makeLegacyRegExpState(),
    subclassCtors: new Map<string, Function[]>(),
    userClassParents: new Map<string, string | null>(),
  };

  installAmbientCompatibility({
    enabled: options?.ambientCompatibility !== false,
    deps,
    legacyRegExpState: instanceState.legacyRegExpState,
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
    brandedExports: _brandedInstanceExports,
    prepareExports: (exports, mayEstablishInstanceAuthority) =>
      _hostBridgeExportView(exports, {
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
  timerCallbackBridge.bindCallbackState(callbackState, (value, arity) => _wrapWasmClosure(value, arity, callbackState));
  domCapabilityRuntime?.bindCallbackState(callbackState);
  let lastCaughtException: any = undefined;
  const envImportNames: string[] = [];
  let importCounts: Uint32Array | undefined;

  // (#1467 / #1933) Each instantiated module gets its own symbol id space and
  // per-instance symbol cache/registry, RegExp legacy state, and subclass/
  // parent registries — initialized in `instanceState` above (was module-level,
  // which crossed and retained concurrently-live instances).

  // Recursion depth guard: host imports can call back into Wasm exports
  // (e.g. callback_maker, valueOf/toString coercion, iterator protocol),
  // which can call back into host imports, creating infinite recursion.
  // Track depth across ALL host imports sharing a single counter.
  // Legitimate parser recursion can cross the generic host bridge once per
  // nested expression/parser method. Acorn's valid async-generator Test262
  // cases exceed 100 crossings before returning, so keep the cycle guard well
  // below V8's native stack limit without rejecting ordinary source depth.
  const MAX_HOST_RECURSION_DEPTH = 512;
  let hostCallDepth = 0;

  for (const imp of manifest) {
    if (imp.module !== "env") continue;
    if (options?.ambientCompatibility === false) {
      const policy = classifyHostImport(imp);
      if (policy.classification === "legacy-semantic" || policy.classification === "unknown") {
        throw new Error(
          `Native-first adapter cannot bind ${imp.module}::${imp.name}: ` +
            `${policy.classification} import owned by #${policy.ownerIssue}. ` +
            `Use the explicit compatibility profile until this semantic provider is native.`,
        );
      }
    }
    const importIndex = envImportNames.push(imp.name) - 1;
    let fn: Function;

    const domBinding = domCapabilityRuntime?.bindImport(imp);
    const clockBinding = imp.intent.type === "date_now" ? options?.[CLOCK_CAPABILITY_AUTHORITY] : undefined;
    fn =
      domBinding ??
      clockBinding ??
      resolveImport(
        imp.intent,
        deps,
        callbackState,
        options?.globalSandbox,
        instanceState,
        imp.paramCount,
        options?.dynamicCode,
        options?.dynamicCodeEvaluator,
        () => lastCaughtException,
      );

    // DOM containment wrapping
    if (options?.domRoot && !domCapabilityRuntime) {
      if (imp.intent.type === "extern_class") {
        fn = wrapWithContainment(fn, imp.intent, options.domRoot as Element | ShadowRoot);
      }
      if (imp.intent.type === "declared_global" && imp.intent.name === "document") {
        fn = () => options.domRoot;
      }
    }

    // Acorn executes millions of these leaf calls per parse. They cannot throw
    // or re-enter Wasm, so avoid constructing and invoking the general guarded
    // wrapper. Preserve import diagnostics and the Wasm signature's fixed
    // arity. The switch provides rollout containment.
    const fastLeaf = process.env.JS2WASM_FAST_LEAF_HOST_IMPORTS !== "0" && isFastLeafHostImport(imp);
    if (fastLeaf && imp.paramCount === 0) {
      const original = fn;
      env[imp.name] = function () {
        if (importCounts) importCounts[importIndex]++;
        return original();
      };
      continue;
    }
    if (fastLeaf && imp.paramCount === 1) {
      const original = fn;
      env[imp.name] = function (a: any) {
        if (importCounts) importCounts[importIndex]++;
        return original(a);
      };
      continue;
    }

    // Wrap host imports with recursion depth guard + exception capture for catch_all.
    //
    // (#4150) Arity-specialized. This wrapper sits on EVERY host import, so its
    // cost is paid on every wasm->JS crossing in every program — 7,000 times in
    // one `dom/set-attributes` call alone. The rest-parameter form allocated a
    // fresh args array per crossing and dispatched through `Function.apply`,
    // which V8 cannot inline as well as a fixed-arity direct call. Specializing
    // on the callee's declared arity removes both. Semantics are identical: the
    // counter, the depth check, `lastCaughtException` and the decrement are the
    // same in every arm, and a variadic or higher-arity callee still gets the
    // original rest form. Measured on dom/set-attributes: ~20-25% of the lane.
    {
      const original = fn;
      const guardEnter = (): void => {
        if (importCounts) importCounts[importIndex]++;
        if (hostCallDepth >= MAX_HOST_RECURSION_DEPTH) {
          const err = new RangeError("Maximum call stack size exceeded");
          lastCaughtException = err;
          throw err;
        }
        hostCallDepth++;
      };
      // The arity comes from the WASM IMPORT SIGNATURE (`paramCount`), not from
      // `original.length`. The wasm side is what does the calling and its call
      // sites are fixed-arity, so this count is exactly how many arguments the
      // wrapper can ever receive. `original.length` would be wrong: it excludes
      // rest and defaulted parameters, so a variadic callee under-reports
      // (`Math.max.length` is 2) and a wrapper sized from it would silently
      // drop arguments. Anything without a declared count keeps the rest form.
      const arity = imp.paramCount ?? -1;
      const variadic = arity < 0 || arity > 4;
      if (variadic) {
        fn = function (this: any, ...args: any[]) {
          guardEnter();
          try {
            return original.apply(this, args);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else if (arity === 0) {
        fn = function (this: any) {
          guardEnter();
          try {
            return original();
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else if (arity === 1) {
        fn = function (this: any, a: any) {
          guardEnter();
          try {
            return original(a);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else if (arity === 2) {
        fn = function (this: any, a: any, b: any) {
          guardEnter();
          try {
            return original(a, b);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else if (arity === 3) {
        fn = function (this: any, a: any, b: any, c: any) {
          guardEnter();
          try {
            return original(a, b, c);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else if (arity === 4) {
        fn = function (this: any, a: any, b: any, c: any, d: any) {
          guardEnter();
          try {
            return original(a, b, c, d);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      } else {
        fn = function (this: any, ...args: any[]) {
          guardEnter();
          try {
            return original.apply(this, args);
          } catch (e) {
            lastCaughtException = e;
            throw e;
          } finally {
            hostCallDepth--;
          }
        };
      }
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
  const dataStructHostBridgeToken = result.string_constants[_DATA_STRUCT_HOST_BRIDGE_TOKEN_VALUE];
  // Always provide setExports — needed for callbacks, native string marshaling,
  // and struct field getter discovery (__sget_*). Raw records cannot establish
  // first data-struct authority.
  result.setExports = lifecycle.setExports;
  result.setInstance = lifecycle.setInstance;
  result.startImportCounting = () => {
    importCounts = new Uint32Array(envImportNames.length);
  };
  result.takeImportCounts = () => {
    const counts: Record<string, number> = Object.create(null);
    if (importCounts) {
      for (let index = 0; index < envImportNames.length; index++) {
        if (importCounts[index] > 0) counts[envImportNames[index]] = importCounts[index];
      }
    }
    importCounts = undefined;
    return counts;
  };
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
  params: ("uint8array" | "typed-array" | "string" | "symbol" | "promise" | "dynamic" | "aggregate" | "other")[];
  /** Boundary kind of the return value. */
  result: "uint8array" | "typed-array" | "string" | "symbol" | "promise" | "dynamic" | "aggregate" | "other";
}

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
    if (!ArrayBuffer.isView(arg) && !Array.isArray(arg)) {
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
 * record retains the historical API.
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
  const brandedExports = _brandedInstanceExports(instanceOrExports);
  const rawExports = brandedExports ?? (instanceOrExports as WebAssembly.Exports);
  const exportsForMarshal = _hostBridgeExportView(rawExports as unknown as Record<string, Function>, {
    mayEstablishDataStructAuthority: brandedExports !== undefined,
    mayConsumeGlobalDataStructAuthority: true,
  });
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
  const looksMarshalable = (val: any): boolean => {
    if (val == null || typeof val !== "object") return false;
    // No positively discovered compiler closure family means this module
    // cannot return a compiled closure. Do not let a user `__is_closure`
    // label or the historical old-module fallback turn class instances into
    // callable wrappers.
    if (typeof isClosureFn !== "function") return true;
    if (typeof isClosureFn === "function") {
      try {
        if (isClosureFn(val) === 1) return false;
      } catch {
        /* fall through to next probe */
      }
    }
    if (_structFieldNamesRaw(val, exportsForMarshal) != null) return true;
    if (_isWasmVec(val, exportsForMarshal)) return true;
    return hasVecLen;
  };

  const wrapped: Record<string, any> = Object.create(null);
  for (const key of Object.keys(rawExports)) {
    const val = (rawExports as Record<string, any>)[key];
    // Pass non-callable exports (Globals, Memory, Tag) through unchanged.
    if (typeof val !== "function") {
      wrapped[key] = val;
      continue;
    }
    // Pass internal helpers through unchanged so the runtime can still
    // reach them by name (`__call_fn_0`, `__vec_get`, etc.).
    if (key.startsWith("__")) {
      wrapped[key] = val;
      continue;
    }
    // Wrap user exports: closures become callables; structs/vecs marshal to JS;
    // primitives, strings, and raw externrefs pass through.
    const sig = signatures ? signatures[key] : undefined;
    const exportBoundaryPolicy = boundaryPolicies?.[key];
    const invoke = function (this: any, ...args: any[]): any {
      // A live boundary view is only a JS façade. Recover its canonical WasmGC
      // identity before calling a typed export; ordinary JS values are no-ops.
      let boundaryArgs = args.map((arg, index) => {
        const paramMode = hasMarshalOverride
          ? marshal
          : marshalModeForBoundaryPolicy(exportBoundaryPolicy?.params[index]?.policy);
        return paramMode === "live" ? _unwrapForHost(arg) : arg;
      });
      const stringFromHost = exportsForMarshal.__str_from_extern as ((value: string) => any) | undefined;
      if (sig) {
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
          if (sig.params[index] === "dynamic") return _nativeDynamicFromHost(arg, exportsForMarshal);
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
      } catch (error) {
        const payload = normalizeModuleCallbackException(
          error,
          { getExports: () => exportsForMarshal },
          "module-tag-payload",
        );
        const translated = _nativeErrorToHost(payload, exportsForMarshal);
        throw translated === _MISS ? payload : translated;
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
      if (resultMarshal === "copy" && marshalable) {
        const plain = _wasmToPlain(result, exportsForMarshal);
        // (#1700) Uint8Array fidelity on the return side. The Wasm signature
        // is ambiguous (Uint8Array and number[] share `(ref null $Vec[f64])`)
        // so we wrap based on the TS-level metadata, not a runtime probe.
        if (sig && sig.result === "uint8array" && Array.isArray(plain)) {
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
  const preserveDataStructAssociation = sc[_DATA_STRUCT_HOST_BRIDGE_TOKEN_VALUE] !== undefined;
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
  const preserveDataStructAssociation = sc[_DATA_STRUCT_HOST_BRIDGE_TOKEN_VALUE] !== undefined;

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
