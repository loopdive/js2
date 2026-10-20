// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
export {
  type LinearReferenceErrorRequirements,
  type LinearReferenceErrorDependencies,
  type LinearReferenceErrorReservations,
  reserveLinearReferenceErrorResources,
  requireLinearReferenceErrorResources,
  linearReferenceErrorConstructorIndex,
  fillLinearReferenceErrorResources,
  requireCompletedLinearReferenceErrorResources,
  linearReferenceErrorConstructorBodyMatches,
} from "../../wasmgc/resources/native-reference-error.js";
