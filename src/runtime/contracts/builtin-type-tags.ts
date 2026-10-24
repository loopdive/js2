// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Canonical native builtin brands, shared by IR resources and legacy codegen. */
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
