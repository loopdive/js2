// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  createIrClassId,
  createIrSourceId,
  createIrUnitId,
  type IrClassId,
  type IrSourceId,
  type IrUnitId,
} from "../../src/ir/identity.js";
import type { IrFunctionIdentity } from "../../src/ir/identity.js";

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
