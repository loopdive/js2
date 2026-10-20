// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { forEachInstrDeep, type IrInstr } from "../core/nodes.js";
import type { IrUnitId, IrBindingId } from "../../shared/contracts/ir-identity.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import {
  assertNativeJsClassAllocations,
  nativeJsClassEvidenceDomainFromProgram,
  nativeJsClassAllocationTopology,
  type NativeJsClassAllocationTopology,
} from "./native-js-class-allocation-validation.js";
import {
  collectNativeJsClassErrorDemands,
  assertNativeJsClassErrorDemandsCurrent,
  nativeJsClassRealmErrorDeclarations,
  type NativeJsClassErrorDemand,
} from "../runtime/native-js-class-error-callables.js";
import type { IrRuntimeCallableDeclaration } from "../runtime/callable-declarations.js";
import { irRuntimeSupportFunctions } from "./runtime-support.js";
import type { NativeJsClassEvidenceDomain } from "../analysis/allocation-evidence/native-js-class-effects.js";
import { copyIrPreparationData } from "../analysis/alloc-registry.js";
import { assertPreparedIrData, preparedIrDataMismatch } from "../../shared/contracts/prepared-ir-data.js";
import { PreparedIrProgramInvariantError } from "../../shared/contracts/prepared-ir-invariant-error.js";

export type NativeJsClassInstruction = Extract<IrInstr, { kind: `js.class.${string}` }>;
export interface NativeJsClassOccurrence {
  readonly unitId: IrUnitId;
  readonly blockId: number;
  readonly ordinal: number;
  readonly instruction: NativeJsClassInstruction;
}
/** Current logical census. It grants no layout, realm or emission authority. */
export interface NativeJsClassRequirements {
  readonly domain: NativeJsClassEvidenceDomain;
  readonly topology: NativeJsClassAllocationTopology;
  readonly errors: readonly NativeJsClassErrorDemand[];
  readonly realmErrors: readonly IrRuntimeCallableDeclaration[];
  readonly occurrences: readonly NativeJsClassOccurrence[];
  readonly boxes: readonly {
    readonly unitId: IrUnitId;
    readonly instruction: Extract<IrInstr, { kind: "box" }>;
    readonly allocationId: number;
  }[];
}
interface Owner {
  readonly program: PreparedIrProgram;
  readonly projection: PreparedIrProgramRuntimeProjection;
  readonly snapshot: unknown;
}
const owners = new WeakMap<NativeJsClassRequirements, Owner>();
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native JS class requirements: " + detail);
}
function inputs(program: PreparedIrProgram, projection: PreparedIrProgramRuntimeProjection) {
  return {
    ir: program.ir,
    allocations: program.allocations,
    abi: program.abi,
    inventory: program.inventory,
    startup: program.startup,
    runtimeSupport: program.runtimeSupport,
    derivedUnits: program.derivedUnits,
    views: program.runtime.map((view) => ({
      backend: view.backend,
      target: view.target,
      functions: view.prepared.functions,
    })),
    selected: { backend: projection.backend, target: projection.target, functions: projection.prepared.functions },
  };
}
function calculate(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeJsClassRequirements | undefined {
  // Closed DATA screening precedes every semantic read. No getter can supply a census.
  assertPreparedIrData(program);
  if (!program.runtime.includes(projection)) invalid("foreign selected projection");
  if (!assertNativeJsClassAllocations(program)) return undefined;
  const module = {
    ...program.ir,
    functions: [...projection.prepared.functions, ...irRuntimeSupportFunctions(program.runtimeSupport)],
  };
  const domain = nativeJsClassEvidenceDomainFromProgram(program, module);
  if (!domain) invalid("missing canonical selected domain");
  const topology = nativeJsClassAllocationTopology(program, module);
  if (!topology) invalid("missing independent aggregate topology");
  const occurrences: NativeJsClassOccurrence[] = [];
  const boxes: { unitId: IrUnitId; instruction: Extract<IrInstr, { kind: "box" }>; allocationId: number }[] = [];
  for (const fn of module.functions)
    for (const block of fn.blocks) {
      let ordinal = 0;
      for (const root of block.instrs)
        forEachInstrDeep(root, (instruction) => {
          const current = ordinal++;
          if (instruction.kind === "box") {
            if (instruction.alloc === undefined || !Number.isSafeInteger(instruction.alloc))
              invalid("box lacks a genuine allocation site");
            boxes.push(Object.freeze({ unitId: fn.unitId, instruction, allocationId: instruction.alloc }));
          }
          if (instruction.kind.startsWith("js.class."))
            occurrences.push(
              Object.freeze({
                unitId: fn.unitId,
                blockId: block.id,
                ordinal: current,
                instruction: instruction as NativeJsClassInstruction,
              }),
            );
        });
    }
  if (!occurrences.length) invalid("class domain lacks selected operations");
  return Object.freeze({
    domain,
    topology,
    errors: collectNativeJsClassErrorDemands(module.functions),
    realmErrors: nativeJsClassRealmErrorDeclarations(module.functions),
    occurrences: Object.freeze(occurrences),
    boxes: Object.freeze(boxes),
  });
}
export function collectNativeJsClassRequirements(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeJsClassRequirements | undefined {
  const requirements = calculate(program, projection);
  if (requirements)
    owners.set(requirements, { program, projection, snapshot: copyIrPreparationData(inputs(program, projection)) });
  return requirements;
}
export function assertNativeJsClassRequirementsCurrent(
  requirements: NativeJsClassRequirements,
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): void {
  const owner = owners.get(requirements);
  if (!owner || owner.program !== program || owner.projection !== projection)
    invalid("unissued or foreign requirements");
  assertPreparedIrData(program);
  if (preparedIrDataMismatch(owner.snapshot, inputs(program, projection)) !== undefined)
    invalid("changed logical source");
  const functions = [...projection.prepared.functions, ...irRuntimeSupportFunctions(program.runtimeSupport)];
  assertNativeJsClassErrorDemandsCurrent(functions, requirements.errors);
  const current = calculate(program, projection);
  if (
    !current ||
    preparedIrDataMismatch(current.domain, requirements.domain) !== undefined ||
    preparedIrDataMismatch(current.topology, requirements.topology) !== undefined ||
    preparedIrDataMismatch(current.errors, requirements.errors) !== undefined ||
    preparedIrDataMismatch(current.realmErrors, requirements.realmErrors) !== undefined ||
    current.occurrences.length !== requirements.occurrences.length
  )
    invalid("changed class domain");
  for (let i = 0; i < current.occurrences.length; i++) {
    const a = current.occurrences[i]!,
      b = requirements.occurrences[i]!;
    if (a.unitId !== b.unitId || a.blockId !== b.blockId || a.ordinal !== b.ordinal || a.instruction !== b.instruction)
      invalid("changed operation identity");
  }
  if (current.boxes.length !== requirements.boxes.length) invalid("changed box census");
  for (let i = 0; i < current.boxes.length; i++) {
    const a = current.boxes[i]!,
      b = requirements.boxes[i]!;
    if (a.unitId !== b.unitId || a.instruction !== b.instruction || a.allocationId !== b.allocationId)
      invalid("changed box identity/site");
  }
}

/** Detached DATA description, independently re-derived at physical acquisition.
 * It contains no issued token, physical coordinate or admission verdict. */
export interface NativeJsClassPhysicalDescription {
  readonly unitIds: readonly IrUnitId[];
  readonly bindingIds: readonly IrBindingId[];
  readonly callableKeys: readonly string[];
  readonly globalKeys: readonly string[];
}
export function describeNativeJsClassPhysicalRequirements(
  requirements: NativeJsClassRequirements,
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeJsClassPhysicalDescription {
  assertNativeJsClassRequirementsCurrent(requirements, program, projection);
  const ids = new Set<IrBindingId>();
  for (const { definition } of requirements.domain.definitions) {
    for (const id of Object.values(definition.realm)) ids.add(id);
    for (const binding of [definition.outerBinding, definition.innerBinding])
      if (binding?.storage === "module") {
        if (!binding.valueGlobal || !binding.tdzGlobal) invalid("missing actual module binding references");
        ids.add(binding.valueGlobal.binding.bindingId);
        ids.add(binding.tdzGlobal.binding.bindingId);
      }
  }
  for (const declaration of [...requirements.realmErrors, ...requirements.errors.map((row) => row.declaration)]) {
    const entry = program.abi.entries.find(
      (row) =>
        row.contract.kind === "callable" && preparedIrDataMismatch(row.contract.ref, declaration.ref) === undefined,
    );
    if (!entry || entry.plan.slotPolicy !== "required" || entry.plan.slotSpace !== "function")
      invalid("missing actual error callable binding");
    ids.add(entry.plan.id);
  }
  const entries = [...ids].map((id) => {
    const entry = program.abi.entries.find((row) => row.plan.id === id);
    if (!entry || entry.plan.slotPolicy !== "required" || !entry.plan.structuralReferenceKey)
      invalid("missing actual class support binding");
    return entry;
  });
  return {
    unitIds: projection.prepared.functions.map((fn) => fn.unitId),
    bindingIds: [...ids],
    callableKeys: entries
      .filter((row) => row.contract.kind === "callable")
      .map((row) => row.plan.structuralReferenceKey!),
    globalKeys: entries.filter((row) => row.contract.kind === "global").map((row) => row.plan.structuralReferenceKey!),
  };
}
