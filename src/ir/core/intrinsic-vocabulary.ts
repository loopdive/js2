// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Closed semantic vocabulary for the first R6 runtime-contract slice.
 *
 * These identifiers name meaning, never a concrete helper, import, or module
 * index. The initial vocabulary deliberately matches the exact deterministic,
 * exact-arity f64 Math surface certified by `IR_MATH_METHOD_TABLE`. Widening
 * `PURE_MATH_INTRINSIC_IDS` remains the exact source-Math catalogue; other
 * reviewed semantic families are composed into `INTRINSIC_IDS` separately.
 */

export const PURE_MATH_INTRINSIC_IDS = Object.freeze([
  "math.abs",
  "math.acos",
  "math.acosh",
  "math.asin",
  "math.asinh",
  "math.atan",
  "math.atan2",
  "math.atanh",
  "math.cbrt",
  "math.ceil",
  "math.clz32",
  "math.cos",
  "math.cosh",
  "math.exp",
  "math.expm1",
  "math.floor",
  "math.fround",
  "math.imul",
  "math.log",
  "math.log10",
  "math.log1p",
  "math.log2",
  "math.max",
  "math.min",
  "math.pow",
  "math.round",
  "math.sign",
  "math.sin",
  "math.sinh",
  "math.sqrt",
  "math.tan",
  "math.tanh",
  "math.trunc",
] as const);

export const NUMERIC_COERCION_INTRINSIC_IDS = Object.freeze(["js.to_uint32"] as const);

/**
 * (#3526 F1-S1) The synchronous number boundary — the f64⇄externref carrier
 * pair the front-end used to emit as a direct named call to
 * `__box_number` / `__unbox_number` after reading a resolver mode predicate.
 * The IDs name meaning only; which provider (host import vs union-native
 * function) answers them is a frozen-manifest decision, not a front-end one.
 */
export const NUMBER_BOUNDARY_INTRINSIC_IDS = Object.freeze(["js.number.box", "js.number.unbox"] as const);

export type NumberBoundaryIntrinsicId = (typeof NUMBER_BOUNDARY_INTRINSIC_IDS)[number];

/**
 * (#3526 F1-S2) The synchronous BOOLEAN boundary — the branded-i32→externref
 * carrier the front-end used to emit as a direct named call to
 * `__box_boolean` after reading the `hasHostBooleanBox` resolver predicate.
 *
 * A deliberate SIBLING of the number constants, not a widening of them: this
 * family is one-armed. There is no `js.boolean.unbox` because there is no
 * front-end producer for one — `__unbox_boolean` is a union member with no IR
 * consumer, and the boolean capability has no widening follow-up.
 */
export const BOOLEAN_BOUNDARY_INTRINSIC_IDS = Object.freeze(["js.boolean.box"] as const);

export type BooleanBoundaryIntrinsicId = (typeof BOOLEAN_BOUNDARY_INTRINSIC_IDS)[number];

/**
 * (#3526 F1-S4) The externref UNDEFINED PROBE — the last surviving pre-F1
 * two-armed shape in from-ast. `x !== undefined` on an externref-shaped value
 * used to pick between the `env.__extern_is_undefined` host import and the
 * host-free lanes' real Wasm function IN THE FRONT-END, by reading the
 * `externIsUndefinedIsNative` resolver predicate.
 *
 * A SIBLING of the number/boolean constants, never a widening of them: this
 * family has no boxing at all. It is one-armed at the ID level (one probe) but
 * TWO-armed at the provider level, unlike `js.boolean.box` — both a host
 * capability and a runtime symbol can answer it, so its policy carries the
 * same three-valued shape the number boundary's unbox arm does.
 */
export const EXTERN_BOUNDARY_INTRINSIC_IDS = Object.freeze(["js.extern.is_undefined"] as const);

export type ExternBoundaryIntrinsicId = (typeof EXTERN_BOUNDARY_INTRINSIC_IDS)[number];

export const INTRINSIC_IDS = Object.freeze([
  ...NUMERIC_COERCION_INTRINSIC_IDS,
  ...NUMBER_BOUNDARY_INTRINSIC_IDS,
  ...BOOLEAN_BOUNDARY_INTRINSIC_IDS,
  ...EXTERN_BOUNDARY_INTRINSIC_IDS,
  ...PURE_MATH_INTRINSIC_IDS,
] as const);

export type IntrinsicId = (typeof INTRINSIC_IDS)[number];

export const INTRINSIC_SIGNATURE_VERSION = 1 as const;

export type IntrinsicSignatureVersion = typeof INTRINSIC_SIGNATURE_VERSION;
