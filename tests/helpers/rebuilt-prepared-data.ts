// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * An equal prepared-data tree in which every object is new.
 *
 * Tests that check an owner or attachment is authenticated by identity, not by equal data, need such a copy.
 * `freezePreparedIrValue` alone no longer makes one: since #7354 Perf6 (480572a14e, effbcccab7) it returns data that is
 * already deeply frozen unchanged, so the "copy" keeps every identity. Rebuild first, then freeze.
 *
 * Prepared data is acyclic (outside IR class shapes, which these callers do not hold) and contains only arrays,
 * null-prototype records and frozen maps/sets.
 */
export function rebuiltPreparedData<T>(value: T): T {
  return rebuild(value) as T;
}

function rebuild(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(rebuild);
  const tag = Object.prototype.toString.call(value);
  if (value instanceof Map || tag === "[object FrozenMap]")
    return new Map([...(value as Iterable<[unknown, unknown]>)].map(([key, item]) => [rebuild(key), rebuild(item)]));
  if (value instanceof Set || tag === "[object FrozenSet]")
    return new Set([...(value as Iterable<unknown>)].map(rebuild));
  const copy = Object.create(null) as Record<PropertyKey, unknown>;
  for (const key of Reflect.ownKeys(value)) copy[key] = rebuild((value as Record<PropertyKey, unknown>)[key]);
  return copy;
}
