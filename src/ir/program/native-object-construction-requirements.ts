// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import type { AllocSiteId, IrInstrObjectNew, IrObjectShape } from "../core/nodes.js";
import { irTypeEquals, type IrType } from "../core/types.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import { nativeAsyncCallableValueTypes } from "../runtime/native-async-callables.js";
import {
  SOURCE_OBJECT_CONSTRUCTION,
  isSourceObjectConstruction,
  type IrSourceObjectConstruction,
} from "../runtime/object-construction.js";
import {
  assertNativeObjectAccessRequirementsCurrent,
  type NativeObjectAccessRequirements,
} from "./native-object-access-requirements.js";
import { freezePreparedIrValue, preparedIrDataMismatch } from "./data.js";

export type NativeObjectFieldCarrier = "number" | "boolean" | "native-string" | "live-reference";
export interface NativeObjectConstructionDemand {
  readonly key: string;
  readonly occurrence: number;
  readonly semanticOccurrence: number;
  readonly ownerUnitId: IrUnitId;
  readonly rawAllocationId: AllocSiteId;
  readonly allocationId: AllocSiteId;
  readonly shape: IrObjectShape;
  /** Carrier coordinates follow the existing canonical field/operand layout. */
  readonly carriers: readonly NativeObjectFieldCarrier[];
  /** Installation order is independent of those physical argument coordinates. */
  readonly keys: readonly string[];
  readonly sourcePrototype: "implicit-default-unresolved";
}
export interface NativeObjectConstructionRequirements {
  readonly access: NativeObjectAccessRequirements;
  readonly constructors: readonly NativeObjectConstructionDemand[];
  readonly gaps: readonly { readonly occurrence: number; readonly detail: string }[];
  readonly completionScope: "explicit-prototype-initialization-prerequisite";
}
const issued = new WeakMap<
  NativeObjectConstructionRequirements,
  { readonly access: NativeObjectAccessRequirements; readonly snapshot: unknown }
>();
function fail(detail: string): never {
  throw Error("native object construction requirements: " + detail);
}
function carrier(type: IrType): NativeObjectFieldCarrier | undefined {
  if (type.kind === "string") return "native-string";
  if (type.kind === "object") return "live-reference"; // No assertion of native origin or foreign entry admission.
  if (type.kind !== "val" || type.typeRef) return undefined;
  if (type.val.kind === "f64") return "number";
  if (type.val.kind === "i32" && type.val.boolean === true && !type.val.symbol) return "boolean";
  return undefined;
}
function calculate(access: NativeObjectAccessRequirements) {
  const demands = access.demands,
    registry = AllocSiteRegistry.fromSnapshot(demands.allocations);
  const constructors: NativeObjectConstructionDemand[] = [],
    gaps: NativeObjectConstructionRequirements["gaps"][number][] = [];
  const seen = new Set<AllocSiteId>();
  for (const owner of demands.owners) {
    const rows = (view: "program" | "projection") =>
      demands.occurrences.flatMap((row, occurrence) => {
        const buffer = demands.buffers[row.bufferIndex]!;
        return buffer.ownerUnitId === owner.unitId && buffer.view === view && row.instruction.kind === "object.new"
          ? [{ occurrence, instruction: row.instruction as IrInstrObjectNew, root: buffer.root, path: buffer.path }]
          : [];
      });
    const semantic = rows("program"),
      projected = rows("projection");
    if (semantic.length !== projected.length) fail("semantic/projection construction population differs");
    const types = nativeAsyncCallableValueTypes(owner.projectedFunction);
    for (const [index, row] of projected.entries()) {
      const instruction = row.instruction,
        original = semantic[index]!;
      if (
        preparedIrDataMismatch(
          { instruction, root: row.root, path: row.path },
          { instruction: original.instruction, root: original.root, path: original.path },
        ) !== undefined
      )
        fail("semantic/projection construction differs");
      const gap = (detail: string) => gaps.push({ occurrence: row.occurrence, detail });
      const allocation = instruction.alloc === undefined ? null : registry.resolve(instruction.alloc);
      if (
        !allocation ||
        allocation.kind !== "object" ||
        instruction.resultType?.kind !== "object" ||
        !irTypeEquals(allocation.type, instruction.resultType) ||
        !irTypeEquals(instruction.resultType, { kind: "object", shape: instruction.shape })
      ) {
        gap("construction lacks its exact live object allocation/type");
        continue;
      }
      if (seen.has(allocation.id)) fail("distinct construction occurrences share a canonical allocation");
      seen.add(allocation.id);
      const facts = registry.read<IrSourceObjectConstruction>(allocation.id, SOURCE_OBJECT_CONSTRUCTION);
      if (!isSourceObjectConstruction(facts, instruction.shape.fields)) {
        gap("construction lacks valid source order facts");
        continue;
      }
      if (facts!.kind !== "data") {
        gap("construction requires " + facts!.kind + " semantics");
        continue;
      }
      if (instruction.values.length !== instruction.shape.fields.length) fail("construction operand arity differs");
      const carriers: NativeObjectFieldCarrier[] = [];
      for (const [fieldIndex, field] of instruction.shape.fields.entries()) {
        const actual = types.get(instruction.values[fieldIndex]!);
        if (!actual || !irTypeEquals(actual, field.type)) fail("construction field/SSA operand type differs");
        const selected = carrier(actual);
        if (selected) carriers.push(selected);
      }
      if (carriers.length !== instruction.shape.fields.length) {
        gap("construction has an unowned field carrier");
        continue;
      }
      constructors.push({
        key: "native-object-initialize:" + JSON.stringify([owner.unitId, allocation.id, facts!.keys]),
        occurrence: row.occurrence,
        semanticOccurrence: original.occurrence,
        ownerUnitId: owner.unitId,
        rawAllocationId: instruction.alloc!,
        allocationId: allocation.id,
        shape: instruction.shape,
        carriers,
        keys: facts!.keys,
        sourcePrototype: "implicit-default-unresolved",
      });
      gap("source default prototype requires completed native Object/Function realm; explicit-prototype kernel only");
    }
  }
  return { constructors, gaps };
}
/** The actual property census owns the selected program, projection and allocation facts. */
export function deriveNativeObjectConstructionRequirements(
  access: NativeObjectAccessRequirements,
): NativeObjectConstructionRequirements {
  assertNativeObjectAccessRequirementsCurrent(access);
  const snapshot = freezePreparedIrValue(calculate(access)) as ReturnType<typeof calculate>;
  const pack = Object.freeze({
    access,
    ...snapshot,
    completionScope: "explicit-prototype-initialization-prerequisite" as const,
  });
  issued.set(pack, { access, snapshot });
  return pack;
}
export function assertNativeObjectConstructionRequirementsCurrent(pack: NativeObjectConstructionRequirements): void {
  const owner = issued.get(pack);
  if (!owner || owner.access !== pack.access) fail("unissued or substituted construction requirements");
  assertNativeObjectAccessRequirementsCurrent(pack.access);
  if (
    pack.completionScope !== "explicit-prototype-initialization-prerequisite" ||
    preparedIrDataMismatch({ constructors: pack.constructors, gaps: pack.gaps }, owner.snapshot) !== undefined ||
    preparedIrDataMismatch(calculate(pack.access), owner.snapshot) !== undefined
  )
    fail("stale construction requirements");
}
