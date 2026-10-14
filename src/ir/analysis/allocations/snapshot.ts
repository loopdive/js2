// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { AllocSiteId } from "../../core/nodes.js";
import type { AllocProvenanceLookup, AllocRegistrySnapshot, AllocSite } from "../contracts/allocations.js";

/** Invocation-local structural reads over screened, stable preparation DATA; not semantic admission. */
export interface AllocationSnapshotRead extends AllocProvenanceLookup {
  canonicalIndex(id: AllocSiteId): number;
  siteAtCanonicalIndex(index: number): AllocSite;
  metadata(id: number, namespace: string): { readonly present: boolean; readonly value: unknown };
}

/** Strict snapshot domain; generic legacy reconstruction keeps its separate retired-alias domain. */
export function createVerifiedAllocationSnapshot(snapshot: AllocRegistrySnapshot): AllocationSnapshotRead {
  verifyRegistrySnapshot(snapshot);
  const isKnown = (id: AllocSiteId): boolean => {
    const index = id as number;
    return index >= 0 && index < snapshot.entries.length;
  };
  return Object.freeze({
    isKnown,
    resolve(id: AllocSiteId): AllocSite | null {
      if (!isKnown(id) || snapshot.entries[id as number]!.state === "retired") return null;
      return canonicalSiteFromSnapshot(id, snapshot);
    },
    canonicalIndex: (id: AllocSiteId) => canonicalIndexFromSnapshot(id, snapshot),
    siteAtCanonicalIndex: (index: number) => snapshotSiteAtCanonicalIndex(index, snapshot),
    metadata: (id: number, namespace: string) => metadataValue(snapshot, id, namespace),
  });
}

export function canonicalSiteFromSnapshot(id: AllocSiteId, snapshot: AllocRegistrySnapshot): AllocSite {
  return snapshotSiteAtCanonicalIndex(canonicalIndexFromSnapshot(id, snapshot), snapshot);
}

export function canonicalIndexFromSnapshot(id: AllocSiteId, snapshot: AllocRegistrySnapshot): number {
  let current = id as number;
  const seen = new Set<number>();
  while (true) {
    if (current < 0 || current >= snapshot.entries.length || !snapshot.entries[current]) {
      throw new Error(`linear-memory frozen allocation facts have unknown site ${id as number}`);
    }
    if (seen.has(current)) throw new Error(`linear-memory frozen allocation facts have cyclic alias at ${current}`);
    seen.add(current);
    const entry = snapshot.entries[current]!;
    if (entry.state === "live") return current;
    if (entry.state === "retired") {
      throw new Error(`linear-memory frozen allocation facts reference retired site ${current}`);
    }
    current = entry.to as number;
  }
}

function snapshotSiteAtCanonicalIndex(index: number, snapshot: AllocRegistrySnapshot): AllocSite {
  const entry = snapshot.entries[index];
  if (!entry || entry.state !== "live") {
    throw new Error(`linear-memory frozen allocation facts have no live canonical site ${index}`);
  }
  return entry.site;
}

export function metadataValue(
  snapshot: AllocRegistrySnapshot,
  id: number,
  namespace: string,
): { readonly present: boolean; readonly value: unknown } {
  const row = snapshot.metadata.find((candidate) => (candidate.id as number) === id);
  if (!row) return { present: false, value: undefined };
  const entry = row.entries.find(([key]) => key === namespace);
  return entry ? { present: true, value: entry[1] } : { present: false, value: undefined };
}

export function sameDetachedValue(
  left: unknown,
  right: unknown,
  seen = new WeakMap<object, WeakSet<object>>(),
): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  let paired = seen.get(left);
  if (paired?.has(right)) return true;
  if (!paired) {
    paired = new WeakSet<object>();
    seen.set(left, paired);
  }
  paired.add(right);

  const leftTag = Object.prototype.toString.call(left);
  const rightTag = Object.prototype.toString.call(right);
  const leftMap = leftTag === "[object Map]" || leftTag === "[object FrozenMap]";
  const rightMap = rightTag === "[object Map]" || rightTag === "[object FrozenMap]";
  if (leftMap || rightMap) {
    if (!leftMap || !rightMap) return false;
    const leftEntries = [...(left as ReadonlyMap<unknown, unknown>)];
    const rightEntries = [...(right as ReadonlyMap<unknown, unknown>)];
    return (
      leftEntries.length === rightEntries.length &&
      leftEntries.every(
        ([leftKey, leftValue], index) =>
          sameDetachedValue(leftKey, rightEntries[index]![0], seen) &&
          sameDetachedValue(leftValue, rightEntries[index]![1], seen),
      )
    );
  }
  const leftSet = leftTag === "[object Set]" || leftTag === "[object FrozenSet]";
  const rightSet = rightTag === "[object Set]" || rightTag === "[object FrozenSet]";
  if (leftSet || rightSet) {
    if (!leftSet || !rightSet) return false;
    const leftValues = [...(left as ReadonlySet<unknown>)];
    const rightValues = [...(right as ReadonlySet<unknown>)];
    return (
      leftValues.length === rightValues.length &&
      leftValues.every((value, index) => sameDetachedValue(value, rightValues[index], seen))
    );
  }

  const leftKeys = Reflect.ownKeys(left).sort((a, b) => String(a).localeCompare(String(b)));
  const rightKeys = Reflect.ownKeys(right).sort((a, b) => String(a).localeCompare(String(b)));
  if (leftKeys.length !== rightKeys.length) return false;
  for (let index = 0; index < leftKeys.length; index++) {
    const leftKey = leftKeys[index]!;
    const rightKey = rightKeys[index]!;
    if (
      typeof leftKey !== typeof rightKey ||
      (typeof leftKey === "symbol" ? leftKey !== rightKey : leftKey !== rightKey)
    ) {
      return false;
    }
    const leftDescriptor = Object.getOwnPropertyDescriptor(left, leftKey);
    const rightDescriptor = Object.getOwnPropertyDescriptor(right, rightKey);
    if (!leftDescriptor || !rightDescriptor || !("value" in leftDescriptor) || !("value" in rightDescriptor)) {
      return false;
    }
    if (!sameDetachedValue(leftDescriptor.value, rightDescriptor.value, seen)) return false;
  }
  return true;
}

function verifyRegistrySnapshot(snapshot: AllocRegistrySnapshot): void {
  if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0 || snapshot.entries.length !== snapshot.size) {
    throw new Error("linear-memory frozen allocation facts have an incomplete registry snapshot");
  }
  for (let index = 0; index < snapshot.entries.length; index++) {
    const entry = snapshot.entries[index]!;
    if (entry.state === "live" && (entry.site.id as number) !== index) {
      throw new Error(`linear-memory frozen allocation facts site identity mismatch at ${index}`);
    }
    if (entry.state === "aliased") canonicalIndexFromSnapshot(entry.to, snapshot);
  }
  const metadataIds = new Set<number>();
  for (const row of snapshot.metadata) {
    const id = row.id as number;
    if (!Number.isSafeInteger(id) || id < 0 || id >= snapshot.size) {
      throw new Error(`linear-memory frozen allocation facts metadata has unknown site ${id}`);
    }
    if (metadataIds.has(id)) throw new Error(`linear-memory frozen allocation facts duplicate metadata site ${id}`);
    metadataIds.add(id);
    const namespaces = new Set<string>();
    for (const [namespace] of row.entries) {
      if (namespaces.has(namespace)) {
        throw new Error(`linear-memory frozen allocation facts duplicate metadata namespace ${namespace}`);
      }
      namespaces.add(namespace);
    }
  }
}
