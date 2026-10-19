// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Slice 10 (#1169i) — host-class names known to the IR. Mirrors the legacy
 * `ctx.externClasses` registration set (see `registerBuiltinExternClasses`
 * in `src/codegen/index.ts:5527-5715`). Functions that USE values of
 * these classes (construction, method calls, property access, RegExp
 * literals) become IR-claimable; the actual lowering throws cleanly if
 * the resolver doesn't carry metadata for the class, falling the
 * function back to legacy via `safeSelection`.
 *
 * Kept in sync with the legacy registration list — drift produces
 * over-claims that fall back at lowering, which is acceptable but
 * suboptimal.
 */
const KNOWN_EXTERN_CLASSES = new Set<string>([
  "RegExp",
  "Date",
  "Error",
  "TypeError",
  "RangeError",
  "SyntaxError",
  "ReferenceError",
  "URIError",
  "EvalError",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "ArrayBuffer",
  "SharedArrayBuffer",
  "DataView",
  "Uint8Array",
  "Int8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
  "Promise",
]);

// Typed arrays are handled by the legacy backend's native vec constructor
// path, not by the IR extern-class registry. Treating them as generic extern
// classes therefore claims `new Uint8Array(...)` without a matching builder
// producer. Keep them pre-claim until a representation-polymorphic IR typed-
// array constructor lands.
export const NATIVE_TYPED_ARRAY_CLASSES = new Set<string>([
  "Uint8Array",
  "Int8Array",
  "Uint8ClampedArray",
  "Uint16Array",
  "Int16Array",
  "Uint32Array",
  "Int32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

// The measured #3529 constructor gap: these ambient constructors are owned
// by the legacy exception runtime and have no IrClass/extern producer.
export const LEGACY_ERROR_CONSTRUCTOR_CLASSES = new Set<string>(["Error", "TypeError", "RangeError"]);

// (#6981) Known extern classes whose construction has a host-free IR arm.
export const HOST_FREE_EXTERN_CONSTRUCTORS = new Set<string>(["Map", "RegExp", "Date"]);

export function isKnownExternClass(name: string): boolean {
  return KNOWN_EXTERN_CLASSES.has(name);
}
