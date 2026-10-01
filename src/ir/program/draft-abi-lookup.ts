// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { PreparedIrAbiEntry } from "./prepared-contracts.js";
import type { PreparedComponentAbiLookup } from "./abi-lookup.js";

/** Read surface during preparation over the same entry vector that will be sealed. */
export function preparedIrDraftAbiLookup(entries: readonly PreparedIrAbiEntry[]): PreparedComponentAbiLookup {
  return {
    get: (id) => entries.find((entry) => entry.plan.id === id)?.plan,
    entries: () => entries.map((entry) => entry.plan),
    bindingIdsForStructuralReference: (key) =>
      entries.filter((entry) => entry.plan.structuralReferenceKey === key).map((entry) => entry.plan.id),
  };
}
