// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrBindingId } from "../../shared/contracts/ir-identity.js";
import type { ProgramAbiPlanEntry } from "./abi.js";

export type PreparedComponentAbiEntry = Pick<
  ProgramAbiPlanEntry,
  "id" | "intent" | "slotPolicy" | "structuralReferenceKey"
> & {
  readonly aliasOf?: IrBindingId;
};

/**
 * Minimal read-only Program ABI surface needed by dependency discovery.
 *
 * `ProgramAbiMap` and a sealed prepared scope adapt directly. Planning-time
 * callers also need reverse structural-key lookup for import/runtime/intrinsic
 * refs, whose IR binding deliberately carries no `IrBindingId`; exposing that
 * lookup on `ProgramAbiSession` is the smallest remaining production adapter.
 * Omitting both reverse-lookup forms is safe but conservative: every such ref
 * blocks.
 */
export interface PreparedComponentAbiLookup {
  get(id: IrBindingId): PreparedComponentAbiEntry | undefined;
  bindingIdsForStructuralReference?(key: string): readonly IrBindingId[];
  entries?(): readonly PreparedComponentAbiEntry[];
}

export interface CanonicalAbiEntry {
  readonly requested: PreparedComponentAbiEntry;
  readonly canonical: PreparedComponentAbiEntry;
}

export type CanonicalAbiResolution =
  | { readonly kind: "resolved"; readonly entry: CanonicalAbiEntry }
  | { readonly kind: "missing" }
  | { readonly kind: "cycle" };

export function canonicalAbiEntry(abi: PreparedComponentAbiLookup, id: IrBindingId): CanonicalAbiResolution {
  const requested = abi.get(id);
  if (!requested) return { kind: "missing" };
  let canonical = requested;
  const visited = new Set<IrBindingId>();
  while (canonical.slotPolicy === "alias") {
    if (visited.has(canonical.id)) return { kind: "cycle" };
    visited.add(canonical.id);
    if (!canonical.aliasOf) return { kind: "missing" };
    const target = abi.get(canonical.aliasOf);
    if (!target) return { kind: "missing" };
    canonical = target;
  }
  return { kind: "resolved", entry: { requested, canonical } };
}
