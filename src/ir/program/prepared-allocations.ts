// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7354 Perf2) Every Prepared census (string demands, formatter support, ref cells, source closures) resolves
// allocation sites through a registry restored from the program's snapshot, and a compile runs these censuses dozens
// of times. Restoring is a validated deep copy, a pure function of the snapshot, so it runs once per snapshot that
// can no longer change.
import type { AllocSiteId } from "../core/nodes.js";
import { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import type { AllocRegistrySnapshot } from "../analysis/contracts/allocations.js";
import { settledChecks } from "./settled-verdict.js";

/** Read-only: the restored registry is shared by every reader of the same immutable snapshot. */
export interface PreparedAllocationSites {
  resolve(id: AllocSiteId): ReturnType<AllocSiteRegistry["resolve"]>;
}

const restored = settledChecks<AllocRegistrySnapshot, PreparedAllocationSites>();

export function preparedAllocationSites(snapshot: AllocRegistrySnapshot): PreparedAllocationSites {
  return restored.check(snapshot, () => AllocSiteRegistry.fromSnapshot(snapshot));
}
