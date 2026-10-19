// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { copyIrPreparationData, type AllocSiteRegistry } from "./alloc-registry.js";
import { IR_ALLOCATION_SOURCE_FACTS, type AllocSite } from "./contracts/allocations.js";
import type { AllocSiteId, IrSiteId } from "../core/nodes.js";

/** Never copy SSA-dependent analysis evidence into a distinct allocation. */
export function cloneSourceAllocation(
  registry: AllocSiteRegistry,
  source: AllocSite,
  origin: IrSiteId | undefined = source.origin,
): AllocSiteId {
  const fresh = registry.fresh(source.kind, source.type, origin);
  const facts = registry.read<unknown>(source.id, IR_ALLOCATION_SOURCE_FACTS);
  if (facts !== undefined) registry.annotate(fresh, IR_ALLOCATION_SOURCE_FACTS, copyIrPreparationData(facts));
  return fresh;
}
