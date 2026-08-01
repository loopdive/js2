// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Built-in type-tag registry for `instanceof` short-circuit evaluation.
 *
 * Built-in JS types like `Array`, `Error`, `TypeError`, `Map` etc. are not
 * emitted as user classes (no entry in `ctx.classTagMap`), so the existing
 * struct-tag-based `instanceof` codegen cannot resolve them. The compiler
 * falls back to a `__instanceof` host import, which is unavailable in
 * standalone / WASI mode.
 *
 * This module provides:
 *   - a stable registry of well-known built-in type names (with hierarchy info)
 *   - static-evaluation helpers that let `compileHostInstanceOf` short-circuit
 *     to a constant `i32.const 0` or `i32.const 1` whenever the LHS TypeScript
 *     type (or stack value type) is provably (in)compatible with the RHS
 *     constructor.
 *
 * The numeric tag values are reserved as **negative integers** so they cannot
 * collide with user-class tags assigned by `ctx.classTagCounter` (which starts
 * at 0 and increments). This leaves room for a future Phase 2 that actually
 * stores these tags in WasmGC structs (e.g., a $Error wrapper struct for
 * thrown exceptions).
 *
 * Phase-1 scope (this module): the registry and static elimination only.
 * Phase-2 scope (later): tagged WasmGC wrapper structs for thrown errors so
 *   `catch (e) { if (e instanceof TypeError) ... }` works without a JS host.
 *
 * See plan/issues/sprints/50/1325-instanceof-builtin-type-tag-registry.md.
 */

/**
 * Reserved tag values for built-in JS constructors. Negative integers so they
 * do not collide with user class tags (which start at 0 and count up).
 *
 * Phase 1 does NOT yet write these tags into WasmGC structs — they are only
 * used for static reasoning. Phase 2 will tag thrown-error wrapper structs
 * with these values so pure-Wasm `catch (e) instanceof TypeError` works.
 */
export const BUILTIN_TYPE_TAGS = {
  // Roots
  Object: -1,
  Function: -2,

  // Indexed collections
  Array: -3,

  // Wrapper types (#1455)
  Boolean: -4,
  Number: -5,
  String: -6,

  // Errors (Error is the parent of all *Error subclasses)
  Error: -10,
  TypeError: -11,
  RangeError: -12,
  SyntaxError: -13,
  URIError: -14,
  EvalError: -15,
  ReferenceError: -16,
  AggregateError: -17,
  // (#3234) SuppressedError (ES2026 error aggregation) — an Error subclass; its
  // native `$Error_struct` carries this tag so `instanceof SuppressedError` and
  // `instanceof Error` discriminate host-free (the DisposableStack dispose driver
  // builds SuppressedError instances natively for multi-error aggregation).
  SuppressedError: -18,

  // Keyed collections
  Map: -20,
  Set: -21,
  WeakMap: -22,
  WeakSet: -23,
  WeakRef: -24,

  // Built-in objects
  Date: -30,
  RegExp: -31,
  Promise: -40,

  // Binary data
  ArrayBuffer: -50,
  SharedArrayBuffer: -51,
  DataView: -52,

  // Typed arrays (#1455). %TypedArray% intrinsic is not in this registry —
  // tests rarely use `arr instanceof %TypedArray%`; concrete typed arrays
  // are sufficient for the spec-completeness gap addressed by #1455.
  Int8Array: -70,
  Uint8Array: -71,
  Uint8ClampedArray: -72,
  Int16Array: -73,
  Uint16Array: -74,
  Int32Array: -75,
  Uint32Array: -76,
  Float32Array: -77,
  Float64Array: -78,
  BigInt64Array: -79,
  BigUint64Array: -80,
} as const;

export type BuiltinTypeName = keyof typeof BUILTIN_TYPE_TAGS;

/**
 * Parent constructor in the built-in inheritance chain. Each *Error subclass
 * has Error as parent; Error, Array, Map, etc. all conceptually descend from
 * Object (we record this only when relevant for `instanceof` reasoning).
 *
 * `undefined` parent means "root" — nothing further up the chain (other than
 * Object, which we don't bother chaining to since `x instanceof Object` is
 * almost always true at runtime and we don't want false negatives from
 * incomplete chain data).
 */
const BUILTIN_PARENT: Partial<Record<BuiltinTypeName, BuiltinTypeName>> = {
  // #1721 — `Function` descends from `Object`, so a subclass of Function is
  // statically an instance of Object too (every function IS an object). This
  // is the one chain edge that produces a provably-true (never false-negative)
  // `instanceof Object` result, so it is safe to record here even though the
  // module deliberately leaves the other builtins' Object edges to runtime.
  Function: "Object",
  TypeError: "Error",
  RangeError: "Error",
  SyntaxError: "Error",
  URIError: "Error",
  EvalError: "Error",
  ReferenceError: "Error",
  AggregateError: "Error",
  SuppressedError: "Error",
};

/**
 * Returns true if `name` is a known built-in JS constructor name in the
 * registry. Caller should already have checked it isn't a user class.
 */
export function isBuiltinTypeName(name: string): name is BuiltinTypeName {
  return Object.prototype.hasOwnProperty.call(BUILTIN_TYPE_TAGS, name);
}

/**
 * Returns true if `child` is `parent` or transitively a built-in subclass of
 * `parent` (per the registry's BUILTIN_PARENT chain). Used to statically
 * decide e.g. `new TypeError() instanceof Error` → true.
 *
 * Returns false for unknown names (caller should still fall through to the
 * host import or to a `false` constant).
 */
export function isBuiltinSubtype(child: string, parent: string): boolean {
  if (!isBuiltinTypeName(child) || !isBuiltinTypeName(parent)) return false;
  let cur: BuiltinTypeName | undefined = child;
  while (cur !== undefined) {
    if (cur === parent) return true;
    cur = BUILTIN_PARENT[cur];
  }
  return false;
}

/**
 * Returns the parent constructor name for a built-in, or undefined if it has
 * no parent in the registry. Exposed for tests / debugging.
 */
export function getBuiltinParent(name: string): BuiltinTypeName | undefined {
  if (!isBuiltinTypeName(name)) return undefined;
  return BUILTIN_PARENT[name];
}

/**
 * Built-in constructors for which we emit subclass support via the existing
 * `__new_<Name>(args...) -> externref` host imports. The subclass instance
 * is represented as externref (NOT a WasmGC struct), and the host returns a
 * real JS object with the right internal slots.
 *
 * Scope:
 *   - #1366a: Error family (Error, TypeError, RangeError, …).
 *   - #1366b: container builtins (Array, Map, Set, WeakMap, WeakSet, Promise,
 *     RegExp, ArrayBuffer). These all route through the same single-arg
 *     `__new_<Name>(arg) -> externref` host import; the runtime's
 *     `extern_class new` resolver (`runtime.ts:1604`) constructs the real
 *     built-in via `new globalThis[Name](...)` after stripping trailing nulls.
 *
 * Limitations (deferred to #1366c/d):
 *   - `instanceof Sub` for non-Error subclasses: the host instance's
 *     `[[Prototype]]` is the parent's, not Sub's, so `subInst instanceof Sub`
 *     resolves via the static reasoning path (`expressions.ts:714`) rather
 *     than runtime prototype-chain walking.
 *   - `Symbol.species` is honoured by the host's spec-conforming method
 *     impls automatically (since the instance IS a real Array/Map/etc.), but
 *     methods that return "a new instance of the same kind" return the
 *     parent type, not Sub.
 *   - Dynamic spread (`super(...args)` or `new Sub(...args)`) only forwards up
 *     to the parent constructor's statically known import arity. Array-literal
 *     spread is flattened, but arbitrary iterable spreading is still deferred.
 */
export const BUILTIN_PARENTS_HOST_CONSTRUCTIBLE: ReadonlySet<BuiltinTypeName> = new Set<BuiltinTypeName>([
  // #1366a — Error family
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "AggregateError",
  // #1366b — container / wrapper builtins
  "Array",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Promise",
  "RegExp",
  "ArrayBuffer",
  // #1455 — additional host-constructible builtins for subclass-builtins
  "DataView",
  "WeakRef",
  "SharedArrayBuffer",
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
  // #1455 — wrapper types + Date. `new Sub()` lowers to `new Wrapper()` /
  // `new Date()` and the instance's [[Prototype]] is set to `Sub.prototype`.
  "Boolean",
  "Number",
  "String",
  "Date",
  // #1721 — root constructors. `class Sub extends Object {}` / `extends
  // Function {}` lower to `new Object()` / `new Function()` so the instance is
  // a real host object/function whose [[Prototype]] is then set to
  // `Sub.prototype`. Missed by #1455 (which registered Map/TypedArray/etc. but
  // not the two roots), so `new Sub() instanceof Sub` returned false for both.
  "Object",
  "Function",
]);

/**
 * Returns true if `name` is a built-in JS constructor that can act as a
 * parent for a host-constructible subclass (#1366a/#1366b). The subclass
 * instance is externref-backed and `super(...)` lowers to `__new_<Name>(...)`.
 */
export function isHostConstructibleBuiltin(name: string): boolean {
  return isBuiltinTypeName(name) && BUILTIN_PARENTS_HOST_CONSTRUCTIBLE.has(name as BuiltinTypeName);
}

/**
 * (#2620) The native-collection builtins. In `nativeStrings` mode
 * (`--target standalone`/`wasi`) these are served by the WasmGC-native
 * Map/Set runtime (map-runtime.ts / set-runtime.ts / weak-collections-runtime.ts,
 * #1103a/#2162) and are deliberately NOT registered as externClasses — base
 * `new Set([...])` is intercepted to the native `$Map`-backed instance instead
 * of leaking a `__new_Set` host import.
 *
 * A *subclass* (`class X extends Set {}`), however, still routes through the
 * generic host-constructible path (these names ARE in
 * `BUILTIN_PARENTS_HOST_CONSTRUCTIBLE`): under standalone that both leaks the
 * `__new_<Name>` host import AND desyncs the synthetic `<Class>_<method>`
 * accessor across the late-import shift (the #2043 index-shift class → invalid
 * Wasm). A native subclass (native construction + direct `[[SetData]]`
 * set-algebra + native iteration + `instanceof` discrimination) is the
 * value-rep/collection-runtime substrate (#2162-scale), tracked separately.
 * Until then, a standalone subclass of one of these is refused at compile time
 * (clean CE, never invalid Wasm / never a leaked host import). See the
 * refusal in class-bodies.ts.
 */
export const NATIVE_COLLECTION_BUILTINS: ReadonlySet<string> = new Set<string>(["Set", "Map", "WeakMap", "WeakSet"]);

/**
 * (#2620) Returns true if `name` is a native-collection builtin
 * (Set/Map/WeakMap/WeakSet) — used to refuse a standalone subclass of one of
 * them (see {@link NATIVE_COLLECTION_BUILTINS}).
 */
export function isNativeCollectionBuiltin(name: string): boolean {
  return NATIVE_COLLECTION_BUILTINS.has(name);
}

// (#2029 → RESOLVED by #3972) `PRIMITIVE_WRAPPER_SUBCLASS_UNSUPPORTED` /
// `isPrimitiveWrapperSubclassUnsupported` lived here and drove a compile-time
// refusal of `class N extends Number|Boolean {}` under `--target
// standalone`/`wasi`. The defect was an ABI mismatch, not a missing substrate:
// the standalone `__new_Number`/`__new_Boolean` internals take an **f64**, while
// the synthetic `<Class>_new` forwarder passes its externref local, so the
// module failed to validate (`call param types must match`).
//
// `emitStandaloneWrapperSuperCtor` (object-runtime.ts) now registers a DEFINED
// `(externref × n) -> externref` shim that ignores the forwarder's externref
// args and supplies the f64 itself, so the forwarder's signature is honoured and
// a real native wrapper box comes back. With the mismatch gone there is nothing
// left to refuse, so the set and its predicate are retired rather than emptied.
// `String` was never in the set (its `__new_String(externref) -> externref`
// already matched the forwarder) and is unaffected.
