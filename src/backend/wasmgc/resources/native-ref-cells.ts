// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteId } from "../../../ir/core/nodes.js";
import type { ValType } from "../../../wasm/model/instructions.js";
import type { PhysicalModuleReservations, TypeReservation } from "../../../wasm/physical/module-reservations.js";
import {
  assertNativeSourceClosureRequirementsCurrent,
  type NativeSourceClosureRequirements,
} from "../../../ir/program/native-source-closure-requirements.js";
import { preparedIrDataMismatch, freezePreparedIrValue } from "../../../ir/program/data.js";
import { createRefCellType, refCellTypeKey } from "../../../runtime/wasmgc/values/ref-cell-layouts.js";

export interface NativeRefCellReservations {
  readonly requirements: NativeSourceClosureRequirements;
  readonly types: readonly { readonly id: string; readonly type: TypeReservation }[];
}
interface Owner {
  readonly tx: PhysicalModuleReservations;
  readonly requirements: NativeSourceClosureRequirements;
  readonly description: NativeSourceClosureRequirements["refCells"];
}
const owners = new WeakMap<NativeRefCellReservations, Owner>();
function fail(detail: string): never {
  throw new Error(`native ref cells: ${detail}`);
}
const key = (requirements: NativeSourceClosureRequirements, id: string): string => `${requirements.key}:ref-cell:${id}`;

/** Type reservation only. Canonical IR lowering still owns each allocation, read and mutation. */
export function reserveNativeRefCells(
  tx: PhysicalModuleReservations,
  requirements: NativeSourceClosureRequirements,
): NativeRefCellReservations {
  assertNativeSourceClosureRequirementsCurrent(requirements);
  if (tx.state !== "reserving") fail("cell types require the reserving phase");
  if (requirements.gaps.length) fail(requirements.gaps.map((row) => row.detail).join("; "));
  const description = freezePreparedIrValue(requirements.refCells) as NativeSourceClosureRequirements["refCells"];
  tx.assertReservationKeysAvailable(description.map((row) => key(requirements, row.id)));
  const types = description.map((row) =>
    Object.freeze({
      id: row.id,
      type: tx.reserveType(key(requirements, row.id), createRefCellType(row.id, structuredClone(row.inner))),
    }),
  );
  const result = Object.freeze({ requirements, types: Object.freeze(types) });
  owners.set(result, { tx, requirements, description });
  return result;
}

export function requireNativeRefCells(
  tx: PhysicalModuleReservations,
  pack: NativeRefCellReservations,
  expectedRequirements: NativeSourceClosureRequirements,
): NativeRefCellReservations {
  const owner = owners.get(pack);
  if (
    !owner ||
    owner.tx !== tx ||
    owner.requirements !== expectedRequirements ||
    pack.requirements !== expectedRequirements
  )
    fail("foreign, copied or substituted cell requirements");
  assertNativeSourceClosureRequirementsCurrent(expectedRequirements);
  if (
    preparedIrDataMismatch(expectedRequirements.refCells, owner.description) !== undefined ||
    pack.types.length !== owner.description.length
  )
    fail("changed cell type population");
  for (const [index, row] of pack.types.entries()) {
    const expected = owner.description[index]!;
    if (row.id !== expected.id || row.type.key !== key(expectedRequirements, expected.id))
      fail("changed cell type association");
    if (tx.state === "reserving") tx.assertTypeReservation(row.type);
    else if (tx.physicalIndex(row.type) !== row.type.typeIndex) fail("changed cell type coordinate");
    if (
      preparedIrDataMismatch(row.type.object, createRefCellType(expected.id, structuredClone(expected.inner))) !==
      undefined
    )
      fail("changed mutable cell layout");
  }
  return pack;
}

/** Resolve an actual supported field type; an allocation additionally needs its retained source association. */
export function resolveNativeRefCell(
  tx: PhysicalModuleReservations,
  pack: NativeRefCellReservations,
  inner: ValType,
  allocation?: AllocSiteId,
): { readonly typeIdx: number; readonly fieldIdx: 0 } | null {
  requireNativeRefCells(tx, pack, pack.requirements);
  const id = refCellTypeKey(inner);
  const row = pack.types.find((candidate) => candidate.id === id);
  const expected = pack.requirements.refCells.find((candidate) => candidate.id === id);
  if (!row || !expected || preparedIrDataMismatch(inner, expected.inner) !== undefined) return null;
  if (allocation !== undefined) {
    const uses = pack.requirements.refCellAllocations.filter((use) => use.rawAllocationId === allocation);
    if (!uses.length || uses.some((use) => use.refCellId !== id))
      fail("allocation lacks its exact source cell association");
  }
  return { typeIdx: row.type.typeIndex, fieldIdx: 0 };
}
