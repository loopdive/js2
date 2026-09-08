// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IntrinsicId, IntrinsicSignatureVersion } from "../../core/intrinsic-vocabulary.js";
import type { IrType } from "../../core/types.js";

/**
 * Provider requirements reachable from the thirty-three intrinsic entry points.
 * `math.reduce-trig` is the sole provider-only dependency in this slice.
 */
export const PURE_MATH_RUNTIME_FEATURES = Object.freeze([
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
  "math.reduce-trig",
  "math.round",
  "math.sign",
  "math.sin",
  "math.sinh",
  "math.sqrt",
  "math.tan",
  "math.tanh",
  "math.trunc",
] as const);

export const NUMERIC_COERCION_RUNTIME_FEATURES = Object.freeze(["js.to_uint32"] as const);

/** Feature rows mirror the number-boundary intrinsic IDs 1:1. */
export const NUMBER_BOUNDARY_RUNTIME_FEATURES = Object.freeze(["js.number.box", "js.number.unbox"] as const);

/** (#3526 F1-S2) The boolean-boundary feature row, 1:1 with its one ID. */
export const BOOLEAN_BOUNDARY_RUNTIME_FEATURES = Object.freeze(["js.boolean.box"] as const);

/** (#3526 F1-S4) The extern undefined-probe feature row, 1:1 with its one ID. */
export const EXTERN_BOUNDARY_RUNTIME_FEATURES = Object.freeze(["js.extern.is_undefined"] as const);

export const INTRINSIC_RUNTIME_FEATURES = Object.freeze([
  ...NUMERIC_COERCION_RUNTIME_FEATURES,
  ...NUMBER_BOUNDARY_RUNTIME_FEATURES,
  ...BOOLEAN_BOUNDARY_RUNTIME_FEATURES,
  ...EXTERN_BOUNDARY_RUNTIME_FEATURES,
  ...PURE_MATH_RUNTIME_FEATURES,
] as const);

export type PureMathRuntimeFeature = (typeof PURE_MATH_RUNTIME_FEATURES)[number];

export type NumericCoercionRuntimeFeature = (typeof NUMERIC_COERCION_RUNTIME_FEATURES)[number];

export type NumberBoundaryRuntimeFeature = (typeof NUMBER_BOUNDARY_RUNTIME_FEATURES)[number];

export type BooleanBoundaryRuntimeFeature = (typeof BOOLEAN_BOUNDARY_RUNTIME_FEATURES)[number];

export type ExternBoundaryRuntimeFeature = (typeof EXTERN_BOUNDARY_RUNTIME_FEATURES)[number];

export type RuntimeFeature = (typeof INTRINSIC_RUNTIME_FEATURES)[number];

/**
 * The certified deterministic Math slice is host-free by construction.
 * Its exhaustive host-capability vocabulary is therefore empty. A later R6
 * family must widen this union before it can request an external capability;
 * `Math.random` cannot accidentally enter through a stringly import name.
 */
export const PURE_MATH_HOST_CAPABILITIES = Object.freeze([] as const);

export type HostCapability = (typeof PURE_MATH_HOST_CAPABILITIES)[number];

export interface IntrinsicSignature {
  readonly version: IntrinsicSignatureVersion;
  readonly params: readonly IrType[];
  readonly result: IrType;
}

export interface IntrinsicSourceLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

export interface IntrinsicUse {
  readonly id: IntrinsicId;
  readonly version: IntrinsicSignatureVersion;
  readonly argumentTypes: readonly IrType[];
  readonly resultType: IrType;
  readonly location: IntrinsicSourceLocation;
}

export interface IntrinsicDefinition {
  readonly id: IntrinsicId;
  readonly signature: IntrinsicSignature;
  readonly feature: RuntimeFeature;
}

export type IntrinsicVerificationCode =
  | "unknown-intrinsic"
  | "invalid-intrinsic-location"
  | "intrinsic-version-mismatch"
  | "intrinsic-signature-mismatch"
  | "intrinsic-effect-mismatch";

export interface IntrinsicVerificationFailure {
  readonly code: IntrinsicVerificationCode;
  readonly detail: string;
}
