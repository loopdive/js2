// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { irCallableBindingKey } from "../core/callable-bindings.js";
import { createIrBindingId } from "../../shared/contracts/identity-values.js";
import type { IrBindingId } from "../../shared/contracts/ir-identity.js";
import type { IrSourceRecord, IrUnitInventory } from "../../shared/contracts/ir-unit-inventory.js";
import type { IrFuncRef } from "../core/value-references.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

/** Shared ABI identity is anchored at the entry source, never at a guessed requesting unit. */
export function preparedIrRuntimeAbiAnchor(inventory: IrUnitInventory): IrSourceRecord {
  const entries = inventory.sources.filter((source) => source.kind === "entry");
  if (entries.length !== 1)
    throw new PreparedIrProgramInvariantError("invalid-prepared-data", "runtime ABI requires one exact entry source");
  return entries[0]!;
}

export function preparedIrRuntimeCallableBindingId(inventory: IrUnitInventory, ref: IrFuncRef): IrBindingId {
  return createIrBindingId({
    ownerId: preparedIrRuntimeAbiAnchor(inventory).id,
    domain: "callable",
    role: irCallableBindingKey(ref.binding),
  });
}
