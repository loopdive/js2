// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** Compatibility transport; private construction and lifecycle stay in the productive owner. */
export {
  nativeNumberUndefinedOptimizationLevel,
  issueNativeNumberUndefinedOptimizationInput,
  applyIssuedNativeNumberUndefinedOptimization,
  nativeNumberUndefinedOptimizationObservation,
  type NativeNumberUndefinedOptimizationObservation,
} from "./pipeline-result-finalizer.js";
