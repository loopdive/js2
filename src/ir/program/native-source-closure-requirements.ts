// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrClosureSignature, IrFunction, IrType } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { preparedIrTypeKey } from "./abi-signatures.js";
import { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import type { AllocSiteId, IrValueId } from "../core/nodes.js";
import { preparedIrDataMismatch, freezePreparedIrValue } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";
import { collectNativeStringValueDemands, type NativeStringValueDemands } from "./native-string-value-demands.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import {
  collectNativeRefCellRequirements,
  nativeRefCellScalarInner,
  type NativeRefCellCensus,
} from "./native-ref-cell-requirements.js";

export interface NativeSourceClosureSignature {
  readonly id: string;
  readonly signature: IrClosureSignature;
}
export interface NativeSourceClosureShape {
  readonly id: string;
  readonly signatureId: string;
  readonly captures: readonly IrType[];
}
export interface NativeSourceClosureRequirements {
  readonly key: string;
  readonly demands: NativeStringValueDemands;
  readonly refCells: NativeRefCellCensus["refCells"];
  readonly refCellAllocations: NativeRefCellCensus["refCellAllocations"];
  readonly signatures: readonly NativeSourceClosureSignature[];
  readonly shapes: readonly NativeSourceClosureShape[];
  readonly units: readonly { readonly unitId: IrUnitId; readonly shapeId: string }[];
  readonly allocations: readonly {
    readonly occurrence: number;
    readonly shapeId: string;
    readonly liftedUnitId: IrUnitId;
    readonly ownerUnitId: IrUnitId;
    readonly allocationId: AllocSiteId;
    readonly rawAllocationId: AllocSiteId;
  }[];
  readonly gaps: readonly { readonly unitId: IrUnitId; readonly detail: string }[];
}
const sources = new WeakMap<
  NativeSourceClosureRequirements,
  {
    readonly demands: NativeStringValueDemands;
    readonly snapshot: unknown;
    readonly sourceSnapshot: unknown;
  }
>();
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", "native source closures: " + detail);
}
function same(a: unknown, b: unknown, detail: string): void {
  if (preparedIrDataMismatch(a, b) !== undefined) invalid(detail);
}
function signatureKey(signature: IrClosureSignature): string {
  return preparedIrTypeKey({ kind: "closure", signature });
}

function calculate(demands: NativeStringValueDemands): Omit<NativeSourceClosureRequirements, "demands"> {
  const signatures: NativeSourceClosureSignature[] = [],
    shapes: NativeSourceClosureShape[] = [];
  const units: NativeSourceClosureRequirements["units"][number][] = [];
  const allocations: NativeSourceClosureRequirements["allocations"][number][] = [];
  const cells = collectNativeRefCellRequirements(demands);
  const gaps: NativeSourceClosureRequirements["gaps"][number][] = [...cells.gaps];
  const signatureIds = new Map<string, string>(),
    shapeIds = new Map<string, string>();
  const registry = AllocSiteRegistry.fromSnapshot(demands.allocations);
  const executableSites = new Set<string>();
  const allocationOwners = new Map<AllocSiteId, IrUnitId>();
  const logicalSites = new Map<
    string,
    { readonly liftedUnitId: IrUnitId; readonly shapeId: string; readonly captures: readonly IrValueId[] }
  >();
  const anchor = demands.program.inventory.sources.find((source) => source.kind === "entry");
  if (!anchor) invalid("missing source anchor");
  const key = `native-source-closures:${JSON.stringify(anchor.id)}`;
  const scalar = (type: IrType, unitId: IrUnitId, role: string): void => {
    if (type.kind === "val" && !type.typeRef && type.val.kind !== "ref" && type.val.kind !== "ref_null") return;
    if (type.kind === "extern" || type.kind === "string" || nativeRefCellScalarInner(type)) return;
    if (type.kind === "callable") {
      signature(type.signature, unitId);
      return;
    }
    if (type.kind === "closure") signature(type.signature, unitId);
    if (
      type.kind === "vec" &&
      !type.layout &&
      type.elementType.kind === "val" &&
      !type.elementType.typeRef &&
      ["f64", "externref"].includes(type.elementType.val.kind)
    )
      return;
    gaps.push({ unitId, detail: `${role} ${type.kind} needs its actual native carrier owner` });
  };
  const signature = (value: IrClosureSignature, unitId: IrUnitId): string => {
    const k = signatureKey(value);
    const prior = signatureIds.get(k);
    if (prior) return prior;
    const id = `signature:${signatures.length}`;
    signatureIds.set(k, id);
    signatures.push({ id, signature: value });
    value.params.forEach((type) => scalar(type, unitId, "closure parameter"));
    if (value.returnType) scalar(value.returnType, unitId, "closure result");
    return id;
  };
  const shape = (value: NonNullable<IrFunction["closureSubtype"]>, unitId: IrUnitId): string => {
    const signatureId = signature(value.signature, unitId);
    const k = JSON.stringify([signatureId, value.captureFieldTypes.map(preparedIrTypeKey)]);
    if (value.hostOneShot || value.domCallbackAuthority)
      gaps.push({ unitId, detail: "certified callback carrier needs its exact boundary producer" });
    const prior = shapeIds.get(k);
    if (prior) return prior;
    const id = `shape:${shapes.length}`;
    shapeIds.set(k, id);
    value.captureFieldTypes.forEach((type) => scalar(type, unitId, "closure capture"));
    shapes.push({ id, signatureId, captures: value.captureFieldTypes });
    return id;
  };
  const type = (value: IrType, unitId: IrUnitId): void => {
    if (value.kind === "closure" || value.kind === "callable") signature(value.signature, unitId);
  };
  for (const owner of demands.owners) {
    for (const fn of [owner.programFunction, owner.projectedFunction]) {
      fn.params.forEach((param) => type(param.type, owner.unitId));
      fn.resultTypes.forEach((result) => type(result, owner.unitId));
    }
    const fn = owner.projectedFunction;
    if (fn.closureSubtype) {
      same(owner.programFunction.closureSubtype, fn.closureSubtype, "closure metadata changed across projection");
      units.push({ unitId: owner.unitId, shapeId: shape(fn.closureSubtype, owner.unitId) });
    }
  }
  for (const [index, occurrence] of demands.occurrences.entries()) {
    const buffer = demands.buffers[occurrence.bufferIndex];
    if (!buffer || buffer.instructions[occurrence.instructionIndex] !== occurrence.instruction)
      invalid("detached occurrence coordinate");
    const instruction = occurrence.instruction;
    if (instruction.resultType) type(instruction.resultType, buffer.ownerUnitId);
    if (instruction.kind !== "closure.new") continue;
    if (instruction.liftedFunc.binding.kind !== "unit") invalid("source allocation does not refer to a lifted unit");
    const liftedUnitId = instruction.liftedFunc.binding.unitId;
    const lifted = demands.owners.find((owner) => owner.unitId === liftedUnitId)?.projectedFunction;
    if (!lifted?.closureSubtype) invalid("source allocation lacks its actual lifted closure body");
    same(lifted.closureSubtype.signature, instruction.signature, "allocation/lifted signature mismatch");
    same(lifted.closureSubtype.captureFieldTypes, instruction.captureFieldTypes, "allocation/lifted capture mismatch");
    if (instruction.alloc === undefined || instruction.captures.length !== instruction.captureFieldTypes.length)
      invalid("source allocation lacks complete capture/allocation provenance");
    const allocation = registry.resolve(instruction.alloc);
    if (!allocation || allocation.kind !== "closure") invalid("source allocation lacks a live closure registry record");
    const row = demands.allocations.entries[allocation.id];
    if (row?.state !== "live" || row.site.id !== allocation.id)
      invalid("source allocation lacks its exact canonical registry row");
    same(row.site.type, instruction.resultType, "closure allocation registry type differs from its occurrence");
    const shapeId = shape({ ...instruction, captureFieldTypes: instruction.captureFieldTypes }, buffer.ownerUnitId);
    const priorOwner = allocationOwners.get(allocation.id);
    if (priorOwner !== undefined && priorOwner !== buffer.ownerUnitId)
      invalid("canonical closure allocation is borrowed by another executable owner");
    allocationOwners.set(allocation.id, buffer.ownerUnitId);
    const executableKey = JSON.stringify([buffer.ownerUnitId, buffer.view, buffer.root.kind, allocation.id]);
    if (executableSites.has(executableKey)) invalid("distinct executable closure allocations share one canonical ID");
    executableSites.add(executableKey);
    const logicalKey = JSON.stringify([buffer.ownerUnitId, allocation.id]);
    const association = { liftedUnitId, shapeId, captures: instruction.captures };
    const prior = logicalSites.get(logicalKey);
    if (prior) {
      same(
        { liftedUnitId: prior.liftedUnitId, shapeId: prior.shapeId },
        { liftedUnitId, shapeId },
        "closure allocation changes lifted owner/shape between representations",
      );
      if (preparedIrDataMismatch(prior.captures, instruction.captures) !== undefined)
        gaps.push({
          unitId: buffer.ownerUnitId,
          detail: "closure capture operands across representations need an authenticated transformation mapping",
        });
    } else logicalSites.set(logicalKey, association);
    allocations.push({
      occurrence: index,
      shapeId,
      liftedUnitId,
      ownerUnitId: buffer.ownerUnitId,
      allocationId: allocation.id,
      rawAllocationId: instruction.alloc,
    });
  }
  return {
    key,
    signatures,
    shapes,
    units,
    allocations,
    refCells: cells.refCells,
    refCellAllocations: cells.refCellAllocations,
    gaps,
  };
}

/** Descriptive derived requirements; the coordinator additionally authenticates the entire program. */
export function planNativeSourceClosureRequirements(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeSourceClosureRequirements | undefined {
  const demands = collectNativeStringValueDemands(program, projection);
  const data = calculate(demands);
  if (!data.signatures.length && !data.refCells.length && !data.refCellAllocations.length) return undefined;
  const snapshot = freezePreparedIrValue(data);
  const result = Object.freeze({ ...data, demands });
  sources.set(result, { demands, snapshot, sourceSnapshot: freezePreparedIrValue(demands) });
  return result;
}

export function assertNativeSourceClosureRequirementsCurrent(requirements: NativeSourceClosureRequirements): void {
  const source = sources.get(requirements);
  if (!source || source.demands !== requirements.demands) invalid("unissued or detached requirements");
  const { demands, ...data } = requirements;
  same(demands, source.sourceSnapshot, "borrowed source changed after selection");
  const fresh = collectNativeStringValueDemands(demands.program, demands.projection);
  if (
    fresh.allocations !== demands.allocations ||
    fresh.owners.length !== demands.owners.length ||
    fresh.buffers.length !== demands.buffers.length ||
    fresh.occurrences.length !== demands.occurrences.length ||
    fresh.owners.some(
      (owner, i) =>
        owner.programFunction !== demands.owners[i]?.programFunction ||
        owner.projectedFunction !== demands.owners[i]?.projectedFunction,
    ) ||
    fresh.buffers.some((buffer, i) => buffer.instructions !== demands.buffers[i]?.instructions) ||
    fresh.occurrences.some((row, i) => row.instruction !== demands.occurrences[i]?.instruction)
  )
    invalid("source identities changed");
  same(data, source.snapshot, "requirements changed");
  same(calculate(fresh), source.snapshot, "source closure population changed");
}
