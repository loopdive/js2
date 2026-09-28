// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { AllocSiteId, IrClosureSignature, IrInstr, IrInstrCall, IrType, IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import { irOrdinaryObjectCallableDeclaration } from "../runtime/ordinary-object-callables.js";
import type { OrdinaryObjectRuntimeFeature } from "../runtime/contracts/manifest.js";
import { nativeAsyncCallableValueTypes, nativeAsyncCallMismatch } from "../runtime/native-async-callables.js";
import { collectNativeStringValueDemands, type NativeStringValueDemands } from "./native-string-value-demands.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "./prepared-contracts.js";

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
interface Definition {
  readonly instruction: IrInstr;
  readonly occurrence: number;
}
interface Issued {
  readonly demands: NativeStringValueDemands;
  readonly sourceSnapshot: unknown;
  readonly dataSnapshot: unknown;
}
const issued = new WeakMap<NativeObjectAccessRequirements, Issued>();
function fail(detail: string): never {
  throw new Error("native object access requirements: " + detail);
}
function same(left: unknown, right: unknown, detail: string): void {
  if (preparedIrDataMismatch(left, right) !== undefined) fail(detail);
}
function original(value: IrValueId, definitions: ReadonlyMap<IrValueId, Definition>): Definition | undefined {
  const seen = new Set<IrValueId>();
  for (;;) {
    if (seen.has(value)) fail("cyclic representation-only SSA alias");
    seen.add(value);
    const row = definitions.get(value);
    if (row?.instruction.kind !== "coerce.to_externref") return row;
    value = row.instruction.value;
  }
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
function mask(call: IrInstrCall, definitions: ReadonlyMap<IrValueId, Definition>): number | undefined {
  const row = definitions.get(call.args[call.args.length - 1]!);
  if (row?.instruction.kind !== "const" || row.instruction.value.kind !== "f64") return undefined;
  const value = row.instruction.value.value;
  return Number.isInteger(value) && value >= 0 && value <= 1023 ? value : undefined;
}

function definitionsFor(demands: NativeStringValueDemands, unitId: IrUnitId, view: "program" | "projection") {
  const definitions = new Map<IrValueId, Definition>();
  for (const [occurrence, row] of demands.occurrences.entries()) {
    const buffer = demands.buffers[row.bufferIndex]!;
    if (buffer.ownerUnitId !== unitId || buffer.view !== view || row.instruction.result === null) continue;
    if (definitions.has(row.instruction.result)) fail("ambiguous prepared SSA definition");
    definitions.set(row.instruction.result, { occurrence, instruction: row.instruction });
  }
  return definitions;
}

function descriptorHalfIdentity(
  demands: NativeStringValueDemands,
  value: IrValueId,
  definitions: ReadonlyMap<IrValueId, Definition>,
) {
  const row = original(value, definitions)?.instruction;
  if (row?.kind === "const") return { kind: "constant", value: row.value };
  if (row?.kind !== "closure.new") return undefined;
  if (row.alloc === undefined) fail("descriptor closure is missing its allocation identity");
  const allocation = AllocSiteRegistry.fromSnapshot(demands.allocations).resolve(row.alloc);
  if (!allocation || allocation.kind !== "closure") fail("descriptor closure allocation is not live");
  return {
    kind: "closure",
    allocation: allocation.id,
    lifted: row.liftedFunc.binding,
    signature: row.signature,
    captures: row.captureFieldTypes,
  };
}

/** Projection may not erase, duplicate or reorder an actual semantic property operation. */
function pairedOperations(demands: NativeStringValueDemands): ReadonlyMap<number, number> {
  const result = new Map<number, number>();
  for (const owner of demands.owners) {
    const semanticDefs = definitionsFor(demands, owner.unitId, "program");
    const projectedDefs = definitionsFor(demands, owner.unitId, "projection");
    const rows = (view: "program" | "projection") =>
      demands.occurrences.flatMap((row, occurrence) => {
        const buffer = demands.buffers[row.bufferIndex]!;
        if (buffer.ownerUnitId !== owner.unitId || buffer.view !== view || row.instruction.kind !== "call") return [];
        const declaration = irOrdinaryObjectCallableDeclaration(row.instruction.target);
        return declaration ? [{ occurrence, call: row.instruction, feature: declaration.feature }] : [];
      });
    const semantic = rows("program"),
      projected = rows("projection");
    if (semantic.length !== projected.length) fail("semantic/projection property operation population differs");
    projected.forEach((row, index) => {
      const original = semantic[index]!;
      if (row.feature !== original.feature) fail("semantic/projection property operation order differs");
      same(row.call.target.binding, original.call.target.binding, "property binding changed across projection");
      same(row.call.site, original.call.site, "property source site changed across projection");
      if (row.feature.startsWith("js.object.define-")) {
        const originalMask = mask(original.call, semanticDefs),
          projectedMask = mask(row.call, projectedDefs);
        if (originalMask !== projectedMask) fail("descriptor presence/attribute mask changed across projection");
        if (row.feature === "js.object.define-accessor" && originalMask !== undefined) {
          for (const [bit, argument] of [
            [256, 2],
            [512, 3],
          ] as const) {
            if (!(originalMask & bit)) continue;
            same(
              descriptorHalfIdentity(demands, original.call.args[argument]!, semanticDefs),
              descriptorHalfIdentity(demands, row.call.args[argument]!, projectedDefs),
              "descriptor callable allocation changed across projection",
            );
          }
        }
      }
      result.set(row.occurrence, original.occurrence);
    });
  }
  return result;
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
    return buffer.view === "projection" && buffer.ownerUnitId === ownerUnitId && candidate.instruction === instruction;
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
  const paired = pairedOperations(demands);
  const ownerData = new Map<
    IrUnitId,
    { definitions: Map<IrValueId, Definition>; types: ReadonlyMap<IrValueId, IrType> }
  >();
  for (const owner of demands.owners)
    ownerData.set(owner.unitId, {
      definitions: definitionsFor(demands, owner.unitId, "projection"),
      types: nativeAsyncCallableValueTypes(owner.projectedFunction),
    });
  for (const [occurrence, row] of demands.occurrences.entries()) {
    const buffer = demands.buffers[row.bufferIndex]!,
      call = row.instruction;
    if (buffer.view !== "projection" || call.kind !== "call") continue;
    const declaration = irOrdinaryObjectCallableDeclaration(call.target);
    if (!declaration) continue;
    const feature = declaration.feature as OrdinaryObjectRuntimeFeature,
      unitId = buffer.ownerUnitId;
    const { definitions, types } = ownerData.get(unitId)!;
    const gap = (detail: string) => gaps.push({ occurrence, unitId, detail });
    const mismatch = nativeAsyncCallMismatch(call, declaration, types);
    if (mismatch) fail("ordinary callable differs from canonical declaration: " + mismatch);
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
    let descriptorMask: number | undefined;
    if (feature.startsWith("js.object.define-")) {
      descriptorMask = mask(call, definitions);
      if (descriptorMask === undefined) gap("descriptor mask needs its actual exact-integer producer");
      else if (feature === "js.object.define-accessor" && !(descriptorMask & 768))
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
      semanticOccurrence: paired.get(occurrence)!,
      ownerUnitId: unitId,
      feature,
      ...(creationOccurrence === undefined ? {} : { creationOccurrence }),
      ...(descriptorMask === undefined ? {} : { descriptorMask }),
    });
  }
  for (const use of uses.filter((row) => row.feature === "js.object.get")) {
    const call = demands.occurrences[use.occurrence]!.instruction as IrInstrCall;
    const { definitions } = ownerData.get(use.ownerUnitId)!;
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
  issued.set(pack, { demands, dataSnapshot: snapshot, sourceSnapshot: freezePreparedIrValue(demands) });
  return pack;
}
export function assertNativeObjectAccessRequirementsCurrent(pack: NativeObjectAccessRequirements): void {
  const owner = issued.get(pack);
  if (!owner || owner.demands !== pack.demands) fail("unissued or detached object-access requirements");
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
