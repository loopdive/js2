// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrType } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import {
  assertNativeObjectAccessRequirementsCurrent,
  type NativeObjectAccessRequirements,
  type NativeObjectGetterDemand,
} from "./native-object-access-requirements.js";
import {
  assertNativeSourceClosureRequirementsCurrent,
  type NativeSourceClosureRequirements,
} from "./native-source-closure-requirements.js";
import { preparedIrDataMismatch } from "./data.js";
import { objectResultIsBoolean, proveObjectGetterReturns } from "./native-object-result-values.js";

/** A semantic getter use is separate from the source .call/.apply ABI population. */
export interface NativeGetterInvocationUse {
  readonly getterIndex: number;
  readonly getOccurrence: number;
  readonly ownerUnitId: IrUnitId;
  readonly allocationOccurrence: number;
  readonly liftedUnitId: IrUnitId;
  readonly shapeId: string;
  readonly actualArity: 0;
}
function fail(detail: string): never {
  throw new Error(`native getter invocation requirements: ${detail}`);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) fail(detail);
}

function reconcileOccurrence(
  source: NativeSourceClosureRequirements,
  access: NativeObjectAccessRequirements,
  occurrence: number,
  ownerUnitId: IrUnitId,
) {
  const left = source.demands.occurrences[occurrence],
    right = access.demands.occurrences[occurrence];
  const sourceBuffer = left && source.demands.buffers[left.bufferIndex];
  const accessBuffer = right && access.demands.buffers[right.bufferIndex];
  if (
    !left ||
    !right ||
    !sourceBuffer ||
    !accessBuffer ||
    left.instruction !== right.instruction ||
    left.instructionIndex !== right.instructionIndex ||
    sourceBuffer.instructions !== accessBuffer.instructions ||
    sourceBuffer.view !== "projection" ||
    accessBuffer.view !== "projection" ||
    sourceBuffer.ownerUnitId !== ownerUnitId ||
    accessBuffer.ownerUnitId !== ownerUnitId
  )
    fail("getter occurrence is detached from the exact selected source owner/projection");
  same(sourceBuffer.root, accessBuffer.root, "getter occurrence has a different root coordinate");
  return left.instruction;
}

function reconcileAllocation(
  source: NativeSourceClosureRequirements,
  access: NativeObjectAccessRequirements,
  getter: NativeObjectGetterDemand,
) {
  for (const occurrence of [getter.getOccurrence, getter.creationOccurrence, getter.definitionOccurrence])
    reconcileOccurrence(source, access, occurrence, getter.ownerUnitId);
  const instruction = reconcileOccurrence(source, access, getter.allocationOccurrence, getter.ownerUnitId);
  if (instruction.kind !== "closure.new" || instruction.liftedFunc.binding.kind !== "unit")
    fail("getter is not its actual source closure allocation");
  const associations = source.allocations.filter((row) => row.occurrence === getter.allocationOccurrence);
  if (associations.length !== 1) fail("getter lacks its one-to-one source allocation association");
  const association = associations[0]!;
  if (
    association.ownerUnitId !== getter.ownerUnitId ||
    association.liftedUnitId !== getter.liftedUnitId ||
    instruction.liftedFunc.binding.unitId !== getter.liftedUnitId ||
    association.rawAllocationId !== getter.rawAllocationId ||
    association.allocationId !== getter.allocationId ||
    instruction.alloc !== getter.rawAllocationId ||
    getter.actualArity !== 0
  )
    fail("getter source allocation identity or actual arity differs");
  same(instruction.signature, getter.signature, "getter source signature differs");
  same(instruction.captures, getter.captures, "getter source capture operands differ");
  same(instruction.captureFieldTypes, getter.captureTypes, "getter source capture layout differs");
  const unit = source.units.find((row) => row.unitId === getter.liftedUnitId);
  if (!unit || unit.shapeId !== association.shapeId) fail("getter lacks its original lifted source shape");
  return association;
}

function signatureGaps(source: NativeSourceClosureRequirements, getter: NativeObjectGetterDemand) {
  const gaps: { unitId: IrUnitId; detail: string }[] = [];
  const metadata = source.demands.owners.find((row) => row.unitId === getter.liftedUnitId)?.projectedFunction
    .closureSubtype;
  const parameters = metadata?.parameters;
  const gap = (detail: string) =>
    gaps.push({ unitId: getter.ownerUnitId, detail: `getter ${getter.liftedUnitId} ${detail}` });
  if (
    !parameters ||
    parameters.kind !== "fixed" ||
    parameters.count !== getter.signature.params.length ||
    parameters.publicLength !== (getter.signature.defaultParamStart ?? parameters.count)
  )
    gap("needs its fixed-parameter/public-length producer contract");
  const supported = (type: IrType): boolean =>
    type.kind === "extern" ||
    type.kind === "callable" ||
    (type.kind === "val" && !type.typeRef && (type.val.kind === "externref" || type.val.kind === "f64"));
  if (
    !getter.signature.params.every(supported) ||
    (getter.signature.returnType &&
      !supported(getter.signature.returnType) &&
      !(
        objectResultIsBoolean(getter.signature.returnType) &&
        source.demands.projection.prepared.manifest.policy.booleanBoundary.box === "native" &&
        proveObjectGetterReturns(source, getter.liftedUnitId, getter.signature.returnType) !== undefined
      ))
  )
    gap("needs its actual argument/result conversion owner");
  if (
    getter.signature.params.some(
      (type, index) =>
        type.kind === "val" &&
        !type.typeRef &&
        type.val.kind === "f64" &&
        index < (getter.signature.defaultParamStart ?? getter.signature.params.length),
    )
  )
    gap("needs an undefined-preserving value carrier for a non-default f64 parameter");
  return gaps;
}

/** Consume only an issued C1 pack; this authenticates the invocation subset, not C1 gap completion. */
export function reconcileNativeGetterInvocationRequirements(
  source: NativeSourceClosureRequirements,
  access: NativeObjectAccessRequirements,
) {
  assertNativeSourceClosureRequirementsCurrent(source);
  assertNativeObjectAccessRequirementsCurrent(access);
  if (
    source.demands.program !== access.demands.program ||
    source.demands.projection !== access.demands.projection ||
    source.demands.allocations !== access.demands.allocations
  )
    fail("object access belongs to a different prepared program/projection/allocation owner");
  const getterUses: NativeGetterInvocationUse[] = [];
  const gaps: { unitId: IrUnitId; detail: string }[] = [];
  access.getters.forEach((getter, getterIndex) => {
    const allocation = reconcileAllocation(source, access, getter);
    getterUses.push({
      getterIndex,
      getOccurrence: getter.getOccurrence,
      ownerUnitId: getter.ownerUnitId,
      allocationOccurrence: allocation.occurrence,
      liftedUnitId: allocation.liftedUnitId,
      shapeId: allocation.shapeId,
      actualArity: 0,
    });
    gaps.push(...signatureGaps(source, getter));
  });
  return { getterUses, gaps };
}
