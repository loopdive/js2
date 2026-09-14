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
