// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrModule } from "../core/nodes.js";
import type { IrType } from "../core/types.js";
import type { IrGlobalRef } from "../core/value-references.js";
import type { IrSourceId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrUnitInventory } from "../../shared/contracts/ir-unit-inventory.js";
import type { AllocRegistrySnapshot } from "../analysis/contracts/allocations.js";
import type { IrModuleInitPlan } from "./startup.js";
import type { ProgramAbiDerivedUnitRecord } from "./abi.js";
import type { IrProgramCallableBindingRecord } from "./callable-bindings.js";
import type { IrPreparationControls } from "./controls.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import type { IrRuntimeSupport } from "./runtime-support.js";

/** Only semantic storage facts cross the frontend boundary, never declarations. */
export interface TypedIrProgramGlobal {
  readonly binding: {
    readonly globalRef: IrGlobalRef;
    readonly tdzGlobalRef: IrGlobalRef | null;
    readonly type: IrType;
  };
  readonly identity: { readonly sourceId: IrSourceId; readonly storageOwnerUnitId: IrUnitId };
}

/**
 * Internal preparation data produced by JavaScript source-to-IR, or lossless
 * replay through compiler-owned transport/decoding; not a sealed program or
 * runtime authority. This is not a public boundary for intentionally crafted
 * live JavaScript objects. IR invariant validation, explicit unsupported
 * outcomes and lossless preservation of supported data remain required;
 * arbitrary getters, Proxies and fabricated-object authentication are outside
 * this input contract.
 */
export interface TypedIrProgramInput {
  readonly inventory: IrUnitInventory;
  readonly ir: IrModule;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  readonly startup: readonly IrModuleInitPlan[];
  readonly callables: readonly IrProgramCallableBindingRecord[];
  readonly globals: readonly TypedIrProgramGlobal[];
  readonly allocations: AllocRegistrySnapshot;
  readonly runtimeSupport?: IrRuntimeSupport;
}

export interface TypedIrProgramOptions {
  readonly policy: RuntimeManifestPolicy;
  readonly runtimePolicies: readonly RuntimeManifestPolicy[];
  readonly controls: IrPreparationControls;
}
