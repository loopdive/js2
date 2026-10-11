// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteId, IrFunction, IrType, IrValueId } from "../core/nodes.js";
import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { ValType } from "../../wasm/model/instructions.js";
import { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import { nativeAsyncCallableValueTypes } from "../runtime/native-async-callables.js";
import type { NativeStringValueDemands } from "./native-string-value-demands.js";
import { preparedIrDataMismatch } from "./data.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

export interface NativeRefCellDescription {
  readonly id: string;
  readonly inner: ValType;
}
export interface NativeRefCellAllocation {
  readonly occurrence: number;
  readonly ownerUnitId: IrUnitId;
  readonly rawAllocationId: AllocSiteId;
  readonly allocationId: AllocSiteId;
  readonly refCellId: string | null;
}
export interface NativeRefCellCensus {
  readonly refCells: readonly NativeRefCellDescription[];
  readonly refCellAllocations: readonly NativeRefCellAllocation[];
  readonly gaps: readonly { readonly unitId: IrUnitId; readonly detail: string }[];
}
function invalid(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", `native ref cells: ${detail}`);
}
function same(actual: unknown, expected: unknown, detail: string): void {
  if (preparedIrDataMismatch(actual, expected) !== undefined) invalid(detail);
}

/** No raw numeric reference coordinate grants a native cell carrier. */
export function nativeRefCellScalarInner(type: IrType): ValType | undefined {
  if (type.kind !== "boxed" || type.inner.kind !== "val" || type.inner.typeRef) return undefined;
  return ["i32", "i64", "f32", "f64", "externref"].includes(type.inner.val.kind) ? type.inner.val : undefined;
}

/** Complete current type/allocation observations, issued by the enclosing source requirements. */
export function collectNativeRefCellRequirements(demands: NativeStringValueDemands): NativeRefCellCensus {
  const refCells: NativeRefCellDescription[] = [],
    refCellAllocations: NativeRefCellAllocation[] = [];
  const gaps: { unitId: IrUnitId; detail: string }[] = [];
  const registry = AllocSiteRegistry.fromSnapshot(demands.allocations);
  const typeMaps = new Map<IrFunction, ReturnType<typeof nativeAsyncCallableValueTypes>>();
  const owners = new Map<AllocSiteId, IrUnitId>();
  const sites = new Set<string>();
  const logical = new Map<string, { readonly refCellId: string | null; readonly value: IrValueId }>();
  const addType = (type: IrType, unitId: IrUnitId): string | null => {
    const inner = nativeRefCellScalarInner(type);
    if (!inner) {
      gaps.push({ unitId, detail: "mutable capture/ref-cell inner type needs its actual native scalar carrier owner" });
      return null;
    }
    const id = inner.kind,
      previous = refCells.find((row) => row.id === id);
    if (previous) {
      if (preparedIrDataMismatch(previous.inner, inner) !== undefined)
        gaps.push({
          unitId,
          detail: "ref-cell field brands with one physical key need their exact shared carrier contract",
        });
    } else refCells.push({ id, inner });
    return id;
  };
  const seenTypes = new Set<IrType>();
  const visitType = (type: IrType, unitId: IrUnitId): void => {
    if (seenTypes.has(type)) return;
    seenTypes.add(type);
    if (type.kind === "boxed") addType(type, unitId);
    if (type.kind === "callable" || type.kind === "closure") {
      type.signature.params.forEach((child) => visitType(child, unitId));
      if (type.signature.returnType) visitType(type.signature.returnType, unitId);
    }
  };
  for (const owner of demands.owners)
    for (const fn of [owner.programFunction, owner.projectedFunction]) {
      fn.params.forEach((param) => visitType(param.type, owner.unitId));
      fn.resultTypes.forEach((type) => visitType(type, owner.unitId));
      fn.closureSubtype?.captureFieldTypes.forEach((type) => visitType(type, owner.unitId));
    }
  for (const [index, occurrence] of demands.occurrences.entries()) {
    const region = demands.buffers[occurrence.bufferIndex];
    if (!region || region.instructions[occurrence.instructionIndex] !== occurrence.instruction)
      invalid("detached instruction occurrence");
    const instruction = occurrence.instruction;
    if (instruction.resultType) visitType(instruction.resultType, region.ownerUnitId);
    if (instruction.kind !== "refcell.new") continue;
    if (instruction.alloc === undefined || instruction.resultType?.kind !== "boxed")
      invalid("allocation lacks its boxed type or allocation ID");
    const allocation = registry.resolve(instruction.alloc);
    if (!allocation || allocation.kind !== "refcell") invalid("allocation lacks a live refcell registry record");
    const row = demands.allocations.entries[allocation.id];
    if (row?.state !== "live" || row.site.id !== allocation.id)
      invalid("allocation lacks its exact canonical registry row");
    same(row.site.type, instruction.resultType, "allocation registry type differs from its actual occurrence");
    // Each view has its own exact definitions; do not resolve program operands through projection SSA IDs.
    const owner = demands.owners.find((candidate) => candidate.unitId === region.ownerUnitId);
    if (!owner) invalid("allocation has no actual owner");
    const fn = region.view === "program" ? owner.programFunction : owner.projectedFunction;
    let types = typeMaps.get(fn);
    if (!types) {
      types = nativeAsyncCallableValueTypes(fn);
      typeMaps.set(fn, types);
    }
    same(
      types.get(instruction.value),
      instruction.resultType.inner,
      "new value differs from its exact cell inner type",
    );
    const refCellId = addType(instruction.resultType, region.ownerUnitId);
    const priorOwner = owners.get(allocation.id);
    if (priorOwner !== undefined && priorOwner !== region.ownerUnitId)
      invalid("canonical cell allocation is borrowed by another owner");
    owners.set(allocation.id, region.ownerUnitId);
    const site = JSON.stringify([region.ownerUnitId, region.view, region.root.kind, allocation.id]);
    if (sites.has(site)) invalid("distinct executable cell allocations share one canonical ID");
    sites.add(site);
    const key = JSON.stringify([region.ownerUnitId, allocation.id]);
    const previous = logical.get(key);
    if (previous && (previous.refCellId !== refCellId || previous.value !== instruction.value))
      gaps.push({
        unitId: region.ownerUnitId,
        detail: "ref-cell operands across representations need an authenticated transformation mapping",
      });
    else logical.set(key, { refCellId, value: instruction.value });
    refCellAllocations.push({
      occurrence: index,
      ownerUnitId: region.ownerUnitId,
      rawAllocationId: instruction.alloc,
      allocationId: allocation.id,
      refCellId,
    });
  }
  return { refCells, refCellAllocations, gaps };
}
