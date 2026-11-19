// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7398) The Prepared requirement planners resolve allocation sites against the program's registry snapshot many
// times per compile, and each `AllocSiteRegistry.fromSnapshot` copies and re-validates every site. A snapshot that
// can no longer change is restored and validated once (#7354 Perf settled verdict); until then every use restores it
// in full, as before.
import { AllocSiteRegistry } from "../analysis/alloc-registry.js";
import type { AllocRegistrySnapshot } from "../analysis/contracts/allocations.js";
import { checkUnlessSettled, type PreparedIrSettlement } from "./settled-verdict.js";

/** What the planners read from a restored registry: site resolution only, so a shared restore cannot be changed. */
export type AllocSiteResolver = Pick<AllocSiteRegistry, "resolve">;

const restores = new WeakMap<
  AllocRegistrySnapshot,
  { readonly holder: PreparedIrSettlement; resolver: AllocSiteResolver | undefined }
>();

function resolver(registry: AllocSiteRegistry): AllocSiteResolver {
  return Object.freeze({ resolve: (id: Parameters<AllocSiteRegistry["resolve"]>[0]) => registry.resolve(id) });
}

/** Site resolution over `snapshot`, restored in full until the snapshot can no longer change, then once. */
export function restoredAllocRegistry(snapshot: AllocRegistrySnapshot): AllocSiteResolver {
  let entry = restores.get(snapshot);
  if (!entry) restores.set(snapshot, (entry = { holder: { settled: undefined }, resolver: undefined }));
  const restore = entry;
  let fresh: AllocSiteResolver | undefined;
  checkUnlessSettled(restore.holder, snapshot, () => {
    fresh = resolver(AllocSiteRegistry.fromSnapshot(snapshot));
  });
  if (fresh) restore.resolver = restore.holder.settled ? fresh : undefined;
  return fresh ?? restore.resolver!;
}
