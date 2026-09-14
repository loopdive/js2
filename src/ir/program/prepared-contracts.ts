// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId, IrSourceId, IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrTerminalUnitRecord, IrUnitInventory } from "../../shared/contracts/ir-unit-inventory.js";
import type { IrPreparationFailure } from "../../shared/contracts/ir-preparation-failure.js";
import type { IrClassShape, IrType, IrTypeRef } from "../core/types.js";
import type { IrFuncRef, IrGlobalRef } from "../core/value-references.js";
import type { IrCanonicalPromiseAbi } from "../core/async-plan.js";
import type { PreparedIrModule as IrModule, PreparedIrRuntimeManifest } from "../runtime/contracts/prepared.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import type { AllocRegistrySnapshot } from "../analysis/contracts/allocations.js";
import type { ProgramAbiDerivedUnitRecord, ProgramAbiPlanEntry } from "./abi.js";
import type { PreparedComponentAbiLookup } from "./abi-lookup.js";
import type { IrModuleInitPlan } from "./startup.js";
import type { IrRuntimeSupport } from "./runtime-support.js";

/** Semantic contracts enrich the existing ABI entries; there is no second binding authority. */
export type PreparedIrAbiContract =
  | {
      readonly kind: "callable";
      readonly ref: IrFuncRef;
      readonly params: readonly IrType[];
      readonly results: readonly IrType[];
      readonly promise?: IrCanonicalPromiseAbi;
    }
  | { readonly kind: "global"; readonly ref: IrGlobalRef; readonly type: IrType; readonly mutable: boolean }
  | { readonly kind: "type"; readonly ref: IrTypeRef; readonly type: IrType }
  | { readonly kind: "class"; readonly ref: IrTypeRef; readonly shape: IrClassShape }
  | { readonly kind: "export"; readonly externalName: string; readonly targetId: IrBindingId }
  | { readonly kind: "support"; readonly role: string };

export interface PreparedIrAbiEntry {
  readonly plan: ProgramAbiPlanEntry;
  readonly contract: PreparedIrAbiContract;
}

/** Data only. Lookup methods are reconstructed from these entries after decoding. */
export interface PreparedIrAbiSnapshot {
  readonly entries: readonly PreparedIrAbiEntry[];
}

/** One complete producer input while the frontend still owns preparation. */
export interface PreparedIrProgramProducerInput {
  readonly inventory: IrUnitInventory;
  readonly ir: IrModule;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  readonly abi: PreparedComponentAbiLookup;
  readonly policy: RuntimeManifestPolicy;
}

export type PreparedIrProgramFailure = IrPreparationFailure & {
  readonly unitId: IrUnitId;
  readonly location: PreparedIrSourceLocation;
  readonly sourceFile: string;
};

/** Backend attachment phase, distinct from the semantic functions and async plans. */
export interface PreparedIrProgramRuntimeProjection {
  readonly backend: RuntimeManifestPolicy["backend"];
  readonly target: RuntimeManifestPolicy["target"];
  readonly prepared: PreparedIrRuntimeManifest;
}

/**
 * The single source-to-backend handoff. The original terminal inventory is the
 * complete denominator; pass-created bodies join it through derivedUnits.
 * declaredSignatures/declaredGlobals in ir remain partial pass tables, never
 * proof of complete call/global closure. The ABI entries provide that proof.
 *
 * Construct only through whole-program preparation. No source/checker objects,
 * emitter callbacks, direct-body alternatives, or mutable allocator handles
 * belong in this snapshot. Runtime attachments retain their exact plan/manifest
 * joins and must be revalidated by the runtime producer after codec replay.
 */
export interface PreparedIrProgram {
  readonly schema: "prepared-ir-program-v1";
  readonly inventory: IrUnitInventory;
  readonly units: ReadonlyMap<IrUnitId, IrTerminalUnitRecord>;
  readonly ir: IrModule;
  readonly abi: PreparedIrAbiSnapshot;
  readonly derivedUnits: readonly ProgramAbiDerivedUnitRecord[];
  /** Includes empty sources and preserves semantic module evaluation order. */
  readonly startup: readonly IrModuleInitPlan[];
  readonly allocations: AllocRegistrySnapshot;
  readonly runtimeSupport?: IrRuntimeSupport;
  readonly runtime: readonly PreparedIrProgramRuntimeProjection[];
  readonly reconciliation: "complete";
  readonly sealed: true;
}

export type IrProgramPreparationResult =
  | { readonly kind: "prepared"; readonly program: PreparedIrProgram }
  | PreparedIrProgramFailure;

export interface PreparedIrProgramOwner {
  readonly unitId: IrUnitId;
  readonly location: PreparedIrSourceLocation;
  readonly sourceFile: string;
}

export interface PreparedIrSourceLocation {
  readonly sourceId: IrSourceId;
  readonly line: number;
  readonly column: number;
  readonly declarationStart: number;
  readonly declarationEnd: number;
}
