// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  createIrClassId,
  createIrSourceId,
  createIrUnitId,
  type IrClassId,
  type IrSourceId,
  type IrUnitId,
} from "../../src/ir/identity.js";
import type { IrFunctionIdentity, IrUnitRecord } from "../../src/ir/identity.js";

/**
 * The single lifted arrow declared at `ordinal` inside the terminal `ownerId`.
 *
 * Lifted arrows are inventoried `arrow-function` units, **not** derived
 * `lifted-closure` units. `createDerivedIrUnitId({ parentId, role:
 * "lifted-closure", ordinal })` names an identity production never publishes:
 * `planProgramAbiUnitCallable` (`src/codegen/program-abi-planning.ts`) admits a
 * *registered derived* unit only under the roles `lifted-closure`,
 * `ir-async-state` and `monomorphization-clone`, and nothing registers a lifted
 * arrow under a derived role any more — `buildIrUnitInventory` lists it as a
 * structural `arrow-function` unit instead.
 *
 * The provenance those derived ids encoded — enclosing terminal owner plus
 * declaration ordinal — is carried by the inventory record itself, so select on
 * that and never on a display name: a lifted arrow's compatibility label can
 * collide with a source function's, in which case the arrow's physical slot is
 * relabelled `__\0js2_ir_prepared_derived_<n>`.
 */
export function liftedArrowUnit(units: readonly IrUnitRecord[], ownerId: IrUnitId, ordinal: number): IrUnitRecord {
  const matches = units.filter(
    (unit) => unit.kind === "arrow-function" && unit.terminalOwnerId === ownerId && unit.ordinal === ordinal,
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one lifted arrow at ordinal ${ordinal} beneath ${ownerId}, found ${matches.length}`,
    );
  }
  return matches[0]!;
}

export interface TestIrFunctionIdentityFactory {
  readonly sourceId: IrSourceId;
  next(name: string): IrFunctionIdentity;
  unit(ordinal: number): IrUnitId;
}

/** Deterministic, checkout-independent identities for hand-built IR fixtures. */
export function createTestIrFunctionIdentityFactory(sourceKey: string): TestIrFunctionIdentityFactory {
  const sourceId = createIrSourceId({
    kind: "synthetic",
    order: 0,
    sourceKey: `@test/${sourceKey}`,
  });
  let nextOrdinal = 0;
  const unit = (ordinal: number): IrUnitId =>
    createIrUnitId({
      sourceId,
      lexicalOwnerId: null,
      kind: "synthetic-support",
      ordinal,
    });
  return Object.freeze({
    sourceId,
    next(name: string): IrFunctionIdentity {
      return Object.freeze({ unitId: unit(nextOrdinal++), name });
    },
    unit,
  });
}

/** Deterministic source-qualified class identity for hand-built IR fixtures. */
export function createTestIrClassId(sourceKey: string, ordinal = 0): IrClassId {
  const sourceId = createIrSourceId({
    kind: "synthetic",
    order: 0,
    sourceKey: `@test/${sourceKey}`,
  });
  return createIrClassId({
    sourceId,
    lexicalOwnerId: null,
    declarationKind: "declaration",
    ordinal,
  });
}
