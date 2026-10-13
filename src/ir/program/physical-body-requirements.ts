// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrFunction, type IrInstrIntrinsic } from "../core/nodes.js";
import { irCallableBindingKey } from "../core/callable-bindings.js";
import { irGlobalBindingKey } from "../core/global-binding-keys.js";
import type { PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import type { RuntimeManifestPolicy } from "../../runtime/contracts/provider-policy.js";
import type {
  PhysicalNativeNumberFormatInput,
  PhysicalNativeStringBindingInput,
} from "./physical-body-resource-contracts.js";
import type { PreparedLinearMemoryPlan } from "./prepared-linear-memory-contracts.js";
import type { HostNumberBoundarySetup } from "./host-number-boundary-setup.js";
import type { NativeVectorResourcePlan } from "./native-vector-resources.js";
import type { Gaps } from "./linear-allocation-outcome.js";
import { physicalVectorCarrierGaps } from "./physical-vector-carriers.js";

function missingIntrinsicMaterialization(
  instruction: IrInstrIntrinsic,
  provider: NonNullable<IrInstrIntrinsic["provider"]>,
  reserved: ReadonlySet<string>,
  projection: PreparedIrProgramRuntimeProjection,
  nativeStrings: PhysicalNativeStringBindingInput | undefined,
  hostNumberBoundary: HostNumberBoundarySetup | undefined,
): boolean {
  return (
    !(
      provider.kind === "callable" &&
      reserved.has(irCallableBindingKey(provider.target.binding)) &&
      ((nativeStrings &&
        (instruction.id === "js.number.unbox" ||
          (instruction.id === "js.number.box" && projection.prepared.manifest.policy.numberBoundary.box === "native") ||
          ((instruction.id === "js.boolean.box" || instruction.id === "js.boolean.unbox") &&
            nativeStrings.bindings.some(
              (row) =>
                row.reference.kind === "func" &&
                irCallableBindingKey(row.reference.binding) === irCallableBindingKey(provider.target.binding),
            )))) ||
        (instruction.id === "js.number.box" &&
          hostNumberBoundary?.imports.some(
            (row) => row.referenceKey === irCallableBindingKey(provider.target.binding),
          )))
    ) &&
    provider.kind !== "backend-op" &&
    provider.kind !== "backend-sequence" &&
    provider.kind !== "backend-composite"
  );
}

/** Census body carriers and referenced resources against the actual planned owners. */
export function physicalBodyResourceRequirements(
  functions: readonly IrFunction[],
  formatter: PhysicalNativeNumberFormatInput | undefined,
  resources: {
    readonly backend: RuntimeManifestPolicy["backend"];
    readonly vectors: NativeVectorResourcePlan;
    readonly linearMemory: PreparedLinearMemoryPlan | undefined;
    readonly reservedTypes: ReadonlySet<string>;
    readonly reserved: ReadonlySet<string>;
    readonly reservedGlobals: ReadonlySet<string>;
    readonly projection: PreparedIrProgramRuntimeProjection;
    readonly nativeStrings: PhysicalNativeStringBindingInput | undefined;
    readonly hostNumberBoundary: HostNumberBoundarySetup | undefined;
  },
  gaps: Gaps,
): boolean {
  const {
    backend,
    vectors,
    linearMemory,
    reservedTypes,
    reserved,
    reservedGlobals,
    projection,
    nativeStrings,
    hostNumberBoundary,
  } = resources;
  let exceptionRequired = false;
  for (const fn of [...functions, ...(formatter ? formatter.support.functions : [])]) {
    const diagnosticUnit =
      formatter && fn === formatter.support.functions[0]
        ? formatter.requirements.calls.find((row) => row.view === "projection")!.ownerUnitId
        : fn.unitId;
    for (const gap of physicalVectorCarrierGaps(fn, {
      backend,
      vectors,
      linearMemory,
      typeBindings: reservedTypes,
    }))
      gaps.add(gap.detail, diagnosticUnit);
    for (const buffer of [
      ...fn.blocks.map((block) => block.instrs),
      ...(fn.asyncPlan?.states.map((s) => s.body) ?? []),
    ]) {
      for (const root of buffer) {
        forEachInstrDeep(root, (instruction) => {
          if (instruction.kind === "call" || instruction.kind === "closure.new") {
            const ref = instruction.kind === "call" ? instruction.target : instruction.liftedFunc;
            if (!reserved.has(irCallableBindingKey(ref.binding))) {
              gaps.add(
                `body ${fn.name} references ${ref.binding.kind} callable ${ref.name} that the plan cannot reserve`,
                diagnosticUnit,
              );
            }
          } else if (instruction.kind === "global.get" || instruction.kind === "global.set") {
            if (!reservedGlobals.has(irGlobalBindingKey(instruction.target.binding))) {
              gaps.add(
                `body ${fn.name} references global ${instruction.target.name} that the plan cannot reserve`,
                diagnosticUnit,
              );
            }
          } else if (instruction.kind === "intrinsic") {
            const provider = instruction.provider;
            if (!provider)
              gaps.add(`body ${fn.name} intrinsic ${instruction.id} has no physical provider`, diagnosticUnit);
            else if (
              missingIntrinsicMaterialization(
                instruction,
                provider,
                reserved,
                projection,
                nativeStrings,
                hostNumberBoundary,
              )
            ) {
              gaps.add(
                `body ${fn.name} intrinsic ${instruction.id} needs ${provider.kind} provider materialization`,
                diagnosticUnit,
              );
            }
          } else if (instruction.kind === "throw" || instruction.kind === "try") {
            exceptionRequired = true;
          }
        });
      }
    }
  }
  return exceptionRequired;
}
