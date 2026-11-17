// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { IR_CLASS_SHAPE_CELL } from "../core/types.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#map = new Map(entries);
    Object.freeze(this);
  }

  /** Brand check through the private field: the prototype alone can be borrowed by any object. */
  static branded(value: object): value is FrozenMap<unknown, unknown> {
    return #map in value;
  }

  get size(): number {
    return this.#map.size;
  }
  has(key: K): boolean {
    return this.#map.has(key);
  }
  get(key: K): V | undefined {
    return this.#map.get(key);
  }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.#map) callbackfn.call(thisArg, value, key, this);
  }
  entries(): MapIterator<[K, V]> {
    return this.#map.entries();
  }
  keys(): MapIterator<K> {
    return this.#map.keys();
  }
  values(): MapIterator<V> {
    return this.#map.values();
  }
  [Symbol.iterator](): MapIterator<[K, V]> {
    return this.#map[Symbol.iterator]();
  }
  get [Symbol.toStringTag](): string {
    return "FrozenMap";
  }
}

class FrozenSet<T> implements ReadonlySet<T> {
  readonly #set: Set<T>;

  constructor(values: Iterable<T>) {
    this.#set = new Set(values);
    Object.freeze(this);
  }

  /** Brand check through the private field: the prototype alone can be borrowed by any object. */
  static branded(value: object): value is FrozenSet<unknown> {
    return #set in value;
  }

  get size(): number {
    return this.#set.size;
  }
  has(value: T): boolean {
    return this.#set.has(value);
  }
  forEach(callbackfn: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown): void {
    for (const value of this.#set) callbackfn.call(thisArg, value, value, this);
  }
  entries(): SetIterator<[T, T]> {
    return this.#set.entries();
  }
  keys(): SetIterator<T> {
    return this.#set.keys();
  }
  values(): SetIterator<T> {
    return this.#set.values();
  }
  [Symbol.iterator](): SetIterator<T> {
    return this.#set[Symbol.iterator]();
  }
  get [Symbol.toStringTag](): string {
    return "FrozenSet";
  }
}

Object.freeze(FrozenMap.prototype);

Object.freeze(FrozenMap);

Object.freeze(FrozenSet.prototype);

Object.freeze(FrozenSet);

export function preparedIrReadonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  return new FrozenMap(entries);
}

/**
 * The keys and values of a genuine frozen collection (private brand and exact prototype), or undefined for anything
 * else. Its private storage never changes after construction; a borrowed prototype proves nothing.
 */
export function preparedIrFrozenCollectionMembers(value: object): readonly unknown[] | undefined {
  const prototype = Object.getPrototypeOf(value);
  const map = FrozenMap.branded(value) && prototype === FrozenMap.prototype;
  const set = FrozenSet.branded(value) && prototype === FrozenSet.prototype;
  // Brand + exact prototype suffice: the constructor freezes `this` before anyone holds it, so no own key can exist.
  if (!map && !set) return undefined;
  return map ? [...(value as ReadonlyMap<unknown, unknown>)].flat() : [...(value as ReadonlySet<unknown>)];
}

/** Exact data comparison for replay/projection evidence, including recursive layouts and collection entries. */
export function preparedIrDataMismatch(left: unknown, right: unknown): string | undefined {
  const visited = new WeakMap<object, WeakSet<object>>();
  const compare = (expected: unknown, actual: unknown, path: string): string | undefined => {
    if (typeof expected === "function" || typeof actual === "function") return `${path} (executable function)`;
    if (expected === null || actual === null || typeof expected !== "object" || typeof actual !== "object") {
      return Object.is(expected, actual) ? undefined : path;
    }
    const prior = visited.get(expected);
    if (prior?.has(actual)) return undefined;
    if (prior) prior.add(actual);
    else visited.set(expected, new WeakSet([actual]));
    const expectedMap = FrozenMap.branded(expected) || expected instanceof Map;
    const actualMap = FrozenMap.branded(actual) || actual instanceof Map;
    if (expectedMap || actualMap) {
      if (!expectedMap || !actualMap) return `${path} (map kind)`;
      return compare([...expected], [...actual], `${path}.entries`);
    }
    const expectedSet = FrozenSet.branded(expected) || expected instanceof Set;
    const actualSet = FrozenSet.branded(actual) || actual instanceof Set;
    if (expectedSet || actualSet) {
      if (!expectedSet || !actualSet) return `${path} (set kind)`;
      return compare([...expected], [...actual], `${path}.values`);
    }
    if (Array.isArray(expected) !== Array.isArray(actual)) return `${path} (array kind)`;
    for (const value of [expected, actual]) {
      const prototype = Object.getPrototypeOf(value);
      if (
        hasNativeCollectionState(value) ||
        (!Array.isArray(value) && prototype !== null && prototype !== Object.prototype)
      ) {
        return `${path} (non-data object)`;
      }
    }
    const expectedKeys = Reflect.ownKeys(expected);
    const actualKeys = Reflect.ownKeys(actual);
    if (expectedKeys.length !== actualKeys.length) return `${path} (field population)`;
    for (const key of expectedKeys) {
      const before = Object.getOwnPropertyDescriptor(expected, key);
      const after = Object.getOwnPropertyDescriptor(actual, key);
      const field = `${path}.${String(key)}`;
      if (!before || !after || !("value" in before) || !("value" in after)) return field;
      const mismatch = compare(before.value, after.value, field);
      if (mismatch !== undefined) return mismatch;
    }
    return undefined;
  };
  return compare(left, right, "$root");
}

export function invalidPreparedData(detail: string): never {
  throw new PreparedIrProgramInvariantError("invalid-prepared-data", detail);
}

function isRecursiveIrClassShape(value: object): boolean {
  const own = (key: PropertyKey): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
  };
  const classId = own("classId");
  return (
    own(IR_CLASS_SHAPE_CELL) === true &&
    typeof classId === "string" &&
    classId.startsWith("ir-class:v1:") &&
    typeof own("className") === "string" &&
    Array.isArray(own("fields")) &&
    Array.isArray(own("methods")) &&
    Array.isArray(own("constructorParams"))
  );
}

function immutableCopy(
  value: unknown,
  ancestors = new Set<object>(),
  activeCopies = new Map<object, unknown>(),
): unknown {
  if (typeof value === "function") invalidPreparedData("prepared data cannot contain executable functions");
  if (value === null || typeof value !== "object") return value;
  if (ancestors.has(value)) {
    const recursiveShapeCopy = activeCopies.get(value);
    if (recursiveShapeCopy !== undefined && isRecursiveIrClassShape(value)) return recursiveShapeCopy;
    invalidPreparedData("prepared data must be acyclic outside exact IR class shapes");
  }
  const nextAncestors = new Set(ancestors).add(value);
  if (FrozenMap.branded(value)) {
    return preparedIrReadonlyMap(
      [...value].map(
        ([key, item]) =>
          [immutableCopy(key, nextAncestors, activeCopies), immutableCopy(item, nextAncestors, activeCopies)] as const,
      ),
    );
  }
  if (FrozenSet.branded(value)) {
    return new FrozenSet([...value].map((item) => immutableCopy(item, nextAncestors, activeCopies)));
  }
  if (Array.isArray(value)) return Object.freeze(value.map((item) => immutableCopy(item, nextAncestors, activeCopies)));
  if (value instanceof Map) {
    return preparedIrReadonlyMap(
      [...value].map(
        ([key, item]) =>
          [immutableCopy(key, nextAncestors, activeCopies), immutableCopy(item, nextAncestors, activeCopies)] as const,
      ),
    );
  }
  if (value instanceof Set) {
    return new FrozenSet([...value].map((item) => immutableCopy(item, nextAncestors, activeCopies)));
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidPreparedData(`prepared data contains unsupported mutable ${prototype?.constructor?.name ?? "object"}`);
  }
  const copy = Object.create(null) as Record<PropertyKey, unknown>;
  activeCopies.set(value, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) {
      invalidPreparedData(`prepared data property ${String(key)} must be a non-executable data property`);
    }
    Object.defineProperty(copy, key, {
      value: immutableCopy(descriptor.value, nextAncestors, activeCopies),
      enumerable: descriptor.enumerable,
      configurable: false,
      writable: false,
    });
  }
  activeCopies.delete(value);
  // A fresh null-prototype record has no collection slot, now or ever: record the fact instead of probing for it.
  const { apply, set, cache } = nativeCollectionBrand;
  apply(set, cache, [copy, false]);
  return Object.freeze(copy);
}

export function freezePreparedIrValue(value: unknown): unknown {
  return immutableCopy(value);
}

// Internal collection slots cannot change on an existing object. Only that
// brand is cached: prototypes, descriptors, values and entries stay live data.
const nativeCollectionBrand = Object.freeze({
  cache: new WeakMap<object, boolean>(),
  get: WeakMap.prototype.get,
  set: WeakMap.prototype.set,
  apply: Reflect.apply,
  probes: Object.freeze([Map.prototype.has, Set.prototype.has, WeakMap.prototype.has, WeakSet.prototype.has]),
});

function hasNativeCollectionState(value: object): boolean {
  const { cache, get, set, apply, probes } = nativeCollectionBrand;
  const cached = apply(get, cache, [value]) as boolean | undefined;
  if (cached !== undefined) return cached;
  let hasSlots = false;
  for (let index = 0; index < probes.length; index++) {
    try {
      apply(probes[index]!, value, [value]);
      // Probe success authenticates the slot, even when membership is false.
      hasSlots = true;
      break;
    } catch {
      // Native methods authenticate internal slots even when the prototype was erased.
    }
  }
  apply(set, cache, [value, hasSlots]);
  return hasSlots;
}

/** Freeze producer-owned attachments without replacing authenticated plan/manifest identities. */
export function freezePreparedIrRuntimeValue<T>(value: T): T {
  const visited = new Set<object>();
  const active = new Set<object>();
  const freeze = (item: unknown): void => {
    if (typeof item === "function") invalidPreparedData("runtime data cannot contain executable functions");
    if (item === null || typeof item !== "object") return;
    if (active.has(item)) {
      if (!isRecursiveIrClassShape(item))
        invalidPreparedData("runtime data must be acyclic outside exact IR class shapes");
      return;
    }
    if (visited.has(item)) return;
    active.add(item);
    if (FrozenMap.branded(item)) {
      for (const [key, entry] of item) {
        freeze(key);
        freeze(entry);
      }
    } else if (FrozenSet.branded(item)) {
      for (const entry of item) freeze(entry);
    } else {
      const prototype = Object.getPrototypeOf(item);
      if (
        hasNativeCollectionState(item) ||
        (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null)
      )
        invalidPreparedData("runtime data contains mutable or executable context state");
      for (const key of Reflect.ownKeys(item)) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor || !("value" in descriptor))
          invalidPreparedData(`runtime property ${String(key)} must be non-executable data`);
        freeze(descriptor.value);
      }
    }
    active.delete(item);
    Object.freeze(item);
    visited.add(item);
  };
  freeze(value);
  return value;
}
