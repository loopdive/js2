// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CreateDerivedIrUnitIdInput, CreateIrBindingIdInput, IrBindingId, IrUnitId } from "./identity.js";

/** Canonical ID primitives shared by frontend inventory and source-free replay. */
export const irIdentityComponent = (value: string): string => encodeURIComponent(value);

export function canonicalIrIdentityNumber(value: number, label: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, received ${value}`);
  }
  return value.toString(10).padStart(16, "0");
}

export function createDerivedIrUnitId(input: CreateDerivedIrUnitIdInput): IrUnitId {
  return `ir-unit:v1:derived:${irIdentityComponent(input.parentId)}:${irIdentityComponent(input.role)}:${canonicalIrIdentityNumber(input.ordinal, "derived unit ordinal")}` as IrUnitId;
}

export function createIrBindingId(input: CreateIrBindingIdInput): IrBindingId {
  return `ir-binding:v1:${input.domain}:${irIdentityComponent(input.ownerId)}:${irIdentityComponent(input.role)}:${canonicalIrIdentityNumber(input.ordinal ?? 0, "binding ordinal")}` as IrBindingId;
}
