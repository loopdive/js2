// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export { copyIrPreparationData, ALLOC_NAMESPACES, AllocSiteRegistry } from "./analysis/alloc-registry.js";
export type {
  AllocSite,
  AllocRegistryProvenanceSnapshot,
  AllocRegistryMetadataSnapshot,
  AllocRegistrySnapshot,
} from "./analysis/contracts/allocations.js";
