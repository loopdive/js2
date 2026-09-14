// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IntrinsicDefinition } from "./runtime/contracts/intrinsics.js";
import type { IntrinsicId } from "./core/intrinsic-vocabulary.js";
import { INTRINSIC_DEFINITIONS as canonicalIntrinsicDefinitions } from "./core/intrinsics.js";
export {
  PURE_MATH_RUNTIME_FEATURES,
  NUMERIC_COERCION_RUNTIME_FEATURES,
  NUMBER_BOUNDARY_RUNTIME_FEATURES,
  BOOLEAN_BOUNDARY_RUNTIME_FEATURES,
  EXTERN_BOUNDARY_RUNTIME_FEATURES,
  INTRINSIC_RUNTIME_FEATURES,
  PURE_MATH_HOST_CAPABILITIES,
} from "./runtime/contracts/intrinsics.js";
export type {
  PureMathRuntimeFeature,
  NumericCoercionRuntimeFeature,
  NumberBoundaryRuntimeFeature,
  BooleanBoundaryRuntimeFeature,
  ExternBoundaryRuntimeFeature,
  RuntimeFeature,
  HostCapability,
  IntrinsicSignature,
  IntrinsicSourceLocation,
  IntrinsicUse,
  IntrinsicDefinition,
  IntrinsicVerificationCode,
  IntrinsicVerificationFailure,
} from "./runtime/contracts/intrinsics.js";
export {
  PURE_MATH_INTRINSIC_IDS,
  NUMERIC_COERCION_INTRINSIC_IDS,
  NUMBER_BOUNDARY_INTRINSIC_IDS,
  BOOLEAN_BOUNDARY_INTRINSIC_IDS,
  EXTERN_BOUNDARY_INTRINSIC_IDS,
  INTRINSIC_IDS,
  INTRINSIC_SIGNATURE_VERSION,
} from "./core/intrinsic-vocabulary.js";
export type {
  NumberBoundaryIntrinsicId,
  BooleanBoundaryIntrinsicId,
  ExternBoundaryIntrinsicId,
  IntrinsicId,
  IntrinsicSignatureVersion,
} from "./core/intrinsic-vocabulary.js";
export {
  F64_TO_EXTERNREF_INTRINSIC_SIGNATURE,
  EXTERNREF_TO_F64_INTRINSIC_SIGNATURE,
  I32_TO_EXTERNREF_INTRINSIC_SIGNATURE,
  EXTERNREF_TO_I32_INTRINSIC_SIGNATURE,
  EXTERNREF_PAIR_TO_I32_INTRINSIC_SIGNATURE,
  EXTERNREF_PAIR_TO_REF_EXTERN_INTRINSIC_SIGNATURE,
  EXTERNREF_I32_TO_F64_INTRINSIC_SIGNATURE,
  EXTERNREF_GLOBAL_INTRINSIC_SIGNATURE,
  F64_TO_U32_INTRINSIC_SIGNATURE,
  F64_UNARY_INTRINSIC_SIGNATURE,
  F64_BINARY_INTRINSIC_SIGNATURE,
  isIntrinsicId,
} from "./core/intrinsics.js";
export { IntrinsicEffectEvidence, intrinsicEffectEvidence, verifyIntrinsicUse } from "./analysis/intrinsics.js";

/** Historical runtime-feature view of the single canonical semantic table. */
export const INTRINSIC_DEFINITIONS: Readonly<Record<IntrinsicId, IntrinsicDefinition>> = canonicalIntrinsicDefinitions;
