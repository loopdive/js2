// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrClassId, IrUnitId, IrUnitInventory } from "./identity.js";
import type { ProgramAbiDerivedUnitRecord } from "./program-abi.js";

export interface PreparedComponentOwnershipIndex {
  readonly unitTerminalOwner: ReadonlyMap<IrUnitId, IrUnitId | null>;
  readonly classTerminalOwner: ReadonlyMap<IrClassId, IrUnitId | null>;
}

/** Resolve every source/derived unit and class to its terminal component owner. */
export function buildPreparedComponentOwnershipIndex(
  inventory: IrUnitInventory,
  derivedUnits: readonly ProgramAbiDerivedUnitRecord[],
): PreparedComponentOwnershipIndex {
  const directUnitOwners = new Map<IrUnitId, IrUnitId | null>();
  for (const unit of inventory.allUnits) directUnitOwners.set(unit.id, unit.terminalOwnerId);
  for (const unit of derivedUnits) directUnitOwners.set(unit.id, unit.terminalOwnerId);

  const unitOwners = new Map<IrUnitId, IrUnitId | null>();
  const resolveUnit = (unitId: IrUnitId, visiting = new Set<IrUnitId>()): IrUnitId | null | undefined => {
    if (unitOwners.has(unitId)) return unitOwners.get(unitId)!;
    const direct = directUnitOwners.get(unitId);
    if (direct === undefined) return undefined;
    if (direct === null || direct === unitId) {
      unitOwners.set(unitId, direct);
      return direct;
    }
    if (visiting.has(unitId)) return undefined;
    const resolved = resolveUnit(direct, new Set(visiting).add(unitId));
    if (resolved === undefined) return undefined;
    unitOwners.set(unitId, resolved);
    return resolved;
  };
  for (const unitId of directUnitOwners.keys()) resolveUnit(unitId);

  const classRecords = new Map(inventory.classes.map((record) => [record.id, record] as const));
  const classOwners = new Map<IrClassId, IrUnitId | null>();
  const resolveClass = (classId: IrClassId, visiting = new Set<IrClassId>()): IrUnitId | null | undefined => {
    if (classOwners.has(classId)) return classOwners.get(classId)!;
    const record = classRecords.get(classId);
    if (!record) return undefined;
    if (record.lexicalOwnerId === null) {
      classOwners.set(classId, null);
      return null;
    }
    if (visiting.has(classId)) return undefined;
    const nextVisiting = new Set(visiting).add(classId);
    const nestedClass = classRecords.get(record.lexicalOwnerId as IrClassId);
    const resolved = nestedClass
      ? resolveClass(nestedClass.id, nextVisiting)
      : resolveUnit(record.lexicalOwnerId as IrUnitId);
    if (resolved === undefined) return undefined;
    classOwners.set(classId, resolved);
    return resolved;
  };
  for (const classId of classRecords.keys()) resolveClass(classId);
  return { unitTerminalOwner: unitOwners, classTerminalOwner: classOwners };
}
