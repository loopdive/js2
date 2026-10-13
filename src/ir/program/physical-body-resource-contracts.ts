// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { IrFuncRef, IrGlobalRef } from "../core/value-references.js";
import type { IrTypeRef } from "../core/types.js";
import type { ProgramAbiPlanEntry } from "./abi.js";
import type { NativeNumberFormatRequirements } from "./native-number-format-requirements.js";
import type { PreparedIrRuntimeManifest } from "../runtime/contracts/prepared.js";

export interface NativeStringValueAbiBinding {
  readonly resourceKey: string;
  readonly entry: ProgramAbiPlanEntry;
  readonly reference: IrFuncRef | IrGlobalRef | IrTypeRef;
}

/** Descriptive input only; the consumer retains the actual prepared support owner. */
export interface PhysicalNativeNumberFormatInput {
  readonly requirements: NativeNumberFormatRequirements;
  readonly support: PreparedIrRuntimeManifest;
}

export interface PhysicalNativeStringBindingInput {
  readonly bindings: readonly NativeStringValueAbiBinding[];
}
