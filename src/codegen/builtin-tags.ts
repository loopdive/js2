// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Legacy static instanceof reasoning over the shared native builtin tag contract. */
export { BUILTIN_TYPE_TAGS, type BuiltinTypeName } from "../runtime/contracts/builtin-type-tags.js";
import { BUILTIN_TYPE_TAGS, type BuiltinTypeName } from "../runtime/contracts/builtin-type-tags.js";

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
 * The Error-family constructors whose instances are a native `$Error_struct`
 * carrying the constructor's `$tag` (field 0).
 */
export const ERROR_FAMILY_CTOR_NAMES = [
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "URIError",
  "EvalError",
  "ReferenceError",
  "AggregateError",
  // (#3234) SuppressedError is an Error subclass (BUILTIN_PARENT). Included so
  // `instanceof SuppressedError` matches its own tag, and `instanceof Error`
  // also matches a native SuppressedError (built by the dispose driver).
  "SuppressedError",
] as const;

/**
 * #1473 — Build the set of `$Error_struct` `$tag` values compatible with an
 * `instanceof <ctorName>` test in no-JS-host mode. For `instanceof Error` this
 * is every Error subtype tag; for `instanceof TypeError` it is TypeError's own
 * tag plus any descendant (none today). Mirrors `isBuiltinSubtype` over the
 * error portion of the BUILTIN_TYPE_TAGS registry. Shared by the name-based
 * `instanceof` path (identifiers.ts) and, since #7120, the generic runtime
 * operator's Error-family probe (native-dynamic-instanceof.ts).
 */
export function collectErrorInstanceOfTags(ctorName: string): number[] {
  const tags: number[] = [];
  for (const n of ERROR_FAMILY_CTOR_NAMES) {
    if (isBuiltinSubtype(n, ctorName)) {
      tags.push(BUILTIN_TYPE_TAGS[n]);
    }
  }
  return tags;
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
