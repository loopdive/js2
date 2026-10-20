// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { NativeStringValueDemands } from "./native-string-value-demands.js";
import type { NativeStringValueDeclaration } from "../../runtime/contracts/native-resource-declarations.js";

/** Descriptive fields consumed by shared primitive boundary ABI planning. */
export interface NativePrimitiveBoundaryPlan {
  readonly mode: "literals" | "number-boundary" | "realm-bootstrap";
  readonly declarations: readonly NativeStringValueDeclaration[];
}
export interface NativePrimitiveBoundaryAbiInput {
  readonly demands: NativeStringValueDemands;
  readonly plan: NativePrimitiveBoundaryPlan;
}
