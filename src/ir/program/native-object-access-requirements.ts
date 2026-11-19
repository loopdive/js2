// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { AllocSiteId, IrClosureSignature, IrInstrCall, IrType, IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import { irOrdinaryObjectCallableDeclaration } from "../runtime/ordinary-object-callables.js";
import type { OrdinaryObjectRuntimeFeature } from "../runtime/contracts/manifest.js";
import { pairedSourceCalls, sourceCallDefinitions } from "./native-source-calls.js";
import { descriptorMask, ORDINARY_OBJECT_SOURCE_CALLS } from "./ordinary-object-source-calls.js";
import { collectNativeStringValueDemands, type NativeStringValueDemands } from "./native-string-value-demands.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";
import { checkUnlessSettled, settledAtIssue, type PreparedIrSettlement } from "./settled-verdict.js";

import {
  nativeValueBufferSelected,
  nativeValueOriginal,
  type NativeValueOccurrence as Definition,
} from "./native-value-definitions.js";

export interface NativeObjectAccessUse {
  readonly occurrence: number;
  readonly semanticOccurrence: number;
  readonly ownerUnitId: IrUnitId;
  readonly feature: OrdinaryObjectRuntimeFeature;
  /** A real create-call occurrence, not a fabricated structural allocation ID. */
  readonly creationOccurrence?: number;
  readonly descriptorMask?: number;
}
export interface NativeObjectGetterDemand {
  readonly getOccurrence: number;
  readonly ownerUnitId: IrUnitId;
  readonly receiver: IrValueId;
  readonly creationOccurrence: number;
  readonly definitionOccurrence: number;
  readonly getterValue: IrValueId;
  readonly allocationOccurrence: number;
  readonly rawAllocationId: AllocSiteId;
  readonly allocationId: AllocSiteId;
  readonly liftedUnitId: IrUnitId;
  readonly signature: IrClosureSignature;
  readonly captures: readonly IrValueId[];
  readonly captureTypes: readonly IrType[];
  readonly actualArity: 0;
}
export interface NativeObjectAccessRequirements {
  readonly key: string;
  readonly demands: NativeStringValueDemands;
  readonly uses: readonly NativeObjectAccessUse[];
  readonly getters: readonly NativeObjectGetterDemand[];
  readonly gaps: readonly { readonly occurrence: number; readonly unitId: IrUnitId; readonly detail: string }[];
  readonly completionScope: "ordinary-object-read-prerequisite";
}
interface Issued {
  readonly demands: NativeStringValueDemands;
  readonly sourceSnapshot: unknown;
  readonly dataSnapshot: unknown;
  /** The currentness check below, settled at issue once the requirements can no longer change. */
  readonly authentication: PreparedIrSettlement;
}
const issued = new WeakMap<NativeObjectAccessRequirements, Issued>();
function fail(detail: string): never {
  throw new Error("native object access requirements: " + detail);
}
function same(left: unknown, right: unknown, detail: string): void {
  if (preparedIrDataMismatch(left, right) !== undefined) fail(detail);
}
function original(value: IrValueId, definitions: ReadonlyMap<IrValueId, Definition>): Definition | undefined {
  return nativeValueOriginal(value, definitions, () => fail("cyclic representation-only SSA alias"));
}
function createFeature(row: Definition | undefined): OrdinaryObjectRuntimeFeature | undefined {
  if (row?.instruction.kind !== "call") return undefined;
  const feature = irOrdinaryObjectCallableDeclaration(row.instruction.target)?.feature;
  return feature === "js.object.create-default" ||
    feature === "js.object.create-null" ||
    feature === "js.object.create-with-prototype"
    ? feature
    : undefined;
}
function getterAllocation(
  demands: NativeStringValueDemands,
  ownerUnitId: IrUnitId,
  getterValue: IrValueId,
  definitions: ReadonlyMap<IrValueId, Definition>,
) {
  const row = original(getterValue, definitions);
  if (!row || row.instruction.kind !== "closure.new") return undefined;
  const instruction = row.instruction;
  const binding = instruction.liftedFunc.binding;
  if (binding.kind !== "unit") return undefined;
  const liftedUnitId = binding.unitId;
  const lifted = demands.owners.find((owner) => owner.unitId === liftedUnitId)?.projectedFunction;
  if (!lifted?.closureSubtype || instruction.alloc === undefined) fail("getter has no actual lifted body/allocation");
  same(lifted.closureSubtype.signature, instruction.signature, "getter allocation/lifted signature differs");
  same(lifted.closureSubtype.captureFieldTypes, instruction.captureFieldTypes, "getter capture shape differs");
  if (instruction.captures.length !== instruction.captureFieldTypes.length) fail("getter capture operands incomplete");
  const registry = AllocSiteRegistry.fromSnapshot(demands.allocations),
    allocation = registry.resolve(instruction.alloc);
  if (!allocation || allocation.kind !== "closure") fail("getter allocation lacks a live closure registry record");
  const site = demands.allocations.entries[allocation.id];
  if (site?.state !== "live" || site.site.id !== allocation.id) fail("getter canonical allocation row differs");
  same(site.site.type, instruction.resultType, "getter registry/occurrence type differs");
  const aliases = demands.occurrences.filter((candidate) => {
    const buffer = demands.buffers[candidate.bufferIndex]!;
    return (
      buffer.view === "projection" &&
      buffer.ownerUnitId === ownerUnitId &&
      nativeValueBufferSelected(demands, buffer) &&
      candidate.instruction === instruction
    );
  });
  if (aliases.length !== 1) fail("getter allocation occurrence is not unique in its selected owner");
  return {
    allocationOccurrence: row.occurrence,
    rawAllocationId: instruction.alloc,
    allocationId: allocation.id,
    liftedUnitId,
    signature: instruction.signature,
    captures: instruction.captures,
    captureTypes: instruction.captureFieldTypes,
  };
}

function calculate(demands: NativeStringValueDemands) {
  const uses: NativeObjectAccessUse[] = [],
    getters: NativeObjectGetterDemand[] = [],
    gaps: NativeObjectAccessRequirements["gaps"][number][] = [];
  const definitionsOf = new Map(
    demands.owners.map((owner) => [owner.unitId, sourceCallDefinitions(demands, owner.unitId, "projection")]),
  );
  for (const { occurrence, semanticOccurrence, ownerUnitId: unitId, feature } of pairedSourceCalls(demands, [
    ORDINARY_OBJECT_SOURCE_CALLS,
  ])) {
    const call = demands.occurrences[occurrence]!.instruction as IrInstrCall;
    const definitions = definitionsOf.get(unitId)!;
    const gap = (detail: string) => gaps.push({ occurrence, unitId, detail });
    const creation = feature.startsWith("js.object.create-")
      ? { instruction: call, occurrence }
      : original(call.args[0]!, definitions);
    const creationOccurrence = createFeature(creation) ? creation!.occurrence : undefined;
    if (creationOccurrence === undefined)
      gap("receiver needs its actual ordinary creation/alias provenance (slots and external flows are unresolved)");
    if (feature === "js.object.create-default")
      gap("default prototype requires its actual implicit-prototype companion");
    if (feature === "js.object.create-with-prototype" && !createFeature(original(call.args[0]!, definitions)))
      gap("explicit prototype needs its actual ordinary/null receiver provenance");
    let mask: number | undefined;
    if (feature.startsWith("js.object.define-")) {
      mask = descriptorMask(call, definitions);
      if (mask === undefined) gap("descriptor mask needs its actual exact-integer producer");
      else if (feature === "js.object.define-accessor" && !(mask & 768))
        fail("accessor descriptor has no explicit getter/setter presence");
    }
    if (!feature.startsWith("js.object.create-")) {
      const key = original(call.args[1]!, definitions)?.instruction;
      const keyType = key?.resultType;
      if (
        key?.kind !== "string.const" &&
        keyType?.kind !== "string" &&
        !(keyType?.kind === "val" && keyType.val.kind === "i32" && keyType.val.symbol)
      )
        gap("property key needs its actual canonical String/Symbol producer");
    }
    uses.push({
      occurrence,
      semanticOccurrence,
      ownerUnitId: unitId,
      feature,
      ...(creationOccurrence === undefined ? {} : { creationOccurrence }),
      ...(mask === undefined ? {} : { descriptorMask: mask }),
    });
  }
  for (const use of uses.filter((row) => row.feature === "js.object.get")) {
    const call = demands.occurrences[use.occurrence]!.instruction as IrInstrCall;
    const definitions = definitionsOf.get(use.ownerUnitId)!;
    const roots = new Set<number>();
    let current = use.creationOccurrence;
    while (current !== undefined) {
      if (roots.has(current)) fail("cyclic ordinary creation/prototype association");
      roots.add(current);
      const creation = demands.occurrences[current]!.instruction as IrInstrCall;
      if (irOrdinaryObjectCallableDeclaration(creation.target)?.feature !== "js.object.create-with-prototype") break;
      const parent = original(creation.args[0]!, definitions);
      current = createFeature(parent) ? parent!.occurrence : undefined;
    }
    for (const descriptor of uses.filter(
      (row) =>
        row.ownerUnitId === use.ownerUnitId &&
        row.feature === "js.object.define-accessor" &&
        row.creationOccurrence !== undefined &&
        roots.has(row.creationOccurrence),
    )) {
      if (descriptor.descriptorMask === undefined || !(descriptor.descriptorMask & 256)) continue;
      const definition = demands.occurrences[descriptor.occurrence]!.instruction as IrInstrCall,
        getterValue = definition.args[2]!;
      const allocation = getterAllocation(demands, use.ownerUnitId, getterValue, definitions);
      if (!allocation) {
        const value = original(getterValue, definitions)?.instruction;
        if (value?.kind === "const" && value.value.kind === "undefined") continue;
        gaps.push({
          occurrence: descriptor.occurrence,
          unitId: use.ownerUnitId,
          detail: "getter needs its actual selected source closure allocation/undefined provenance",
        });
        continue;
      }
      getters.push({
        getOccurrence: use.occurrence,
        ownerUnitId: use.ownerUnitId,
        receiver: call.args[2]!,
        creationOccurrence: descriptor.creationOccurrence!,
        definitionOccurrence: descriptor.occurrence,
        getterValue,
        ...allocation,
        actualArity: 0,
      });
    }
  }
  return { uses, getters, gaps };
}

/** Issued descriptive demands; the parent still must close every receiver/provider gap. */
export function deriveNativeObjectAccessRequirements(
  program: PreparedIrProgram,
  projection: PreparedIrProgramRuntimeProjection,
): NativeObjectAccessRequirements {
  const demands = collectNativeStringValueDemands(program, projection),
    data = calculate(demands);
  const anchor = program.inventory.sources.find((source) => source.kind === "entry");
  if (!anchor) fail("missing actual source anchor");
  const snapshot = freezePreparedIrValue(data) as typeof data;
  const pack = Object.freeze({
    key: `native-object-access:${JSON.stringify(anchor.id)}`,
    demands,
    ...snapshot,
    completionScope: "ordinary-object-read-prerequisite" as const,
  });
  issued.set(pack, {
    demands,
    dataSnapshot: snapshot,
    sourceSnapshot: freezePreparedIrValue(demands),
    authentication: settledAtIssue(pack),
  });
  return pack;
}
export function assertNativeObjectAccessRequirementsCurrent(pack: NativeObjectAccessRequirements): void {
  const owner = issued.get(pack);
  if (!owner || owner.demands !== pack.demands) fail("unissued or detached object-access requirements");
  checkUnlessSettled(owner.authentication, pack, () => checkCurrent(pack, owner));
}
function checkCurrent(pack: NativeObjectAccessRequirements, owner: Issued): void {
  same(pack.demands, owner.sourceSnapshot, "borrowed source changed after selection");
  const fresh = collectNativeStringValueDemands(pack.demands.program, pack.demands.projection);
  same(fresh, pack.demands, "complete occurrence census changed");
  if (
    fresh.allocations !== pack.demands.allocations ||
    fresh.owners.some(
      (row, i) =>
        row.programFunction !== pack.demands.owners[i]?.programFunction ||
        row.projectedFunction !== pack.demands.owners[i]?.projectedFunction,
    ) ||
    fresh.buffers.some((row, i) => row.instructions !== pack.demands.buffers[i]?.instructions) ||
    fresh.occurrences.some((row, i) => row.instruction !== pack.demands.occurrences[i]?.instruction)
  )
    fail("borrowed source identities changed");
  same(
    { uses: pack.uses, getters: pack.getters, gaps: pack.gaps },
    owner.dataSnapshot,
    "issued object requirements changed",
  );
  same(calculate(fresh), owner.dataSnapshot, "current object requirements differ");
}
