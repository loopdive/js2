// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { IR_CLASS_SHAPE_CELL } from "../core/types.js";
import { PreparedIrProgramInvariantError } from "./errors.js";

class FrozenMap<K, V> implements ReadonlyMap<K, V> {
  readonly #map: Map<K, V>;

  constructor(entries: Iterable<readonly [K, V]>) {
    this.#map = new Map(entries);
    Object.freeze(this);
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
    const expectedMap = expected instanceof FrozenMap || expected instanceof Map;
    const actualMap = actual instanceof FrozenMap || actual instanceof Map;
    if (expectedMap || actualMap) {
      if (!expectedMap || !actualMap) return `${path} (map kind)`;
      return compare([...expected], [...actual], `${path}.entries`);
    }
    const expectedSet = expected instanceof FrozenSet || expected instanceof Set;
    const actualSet = actual instanceof FrozenSet || actual instanceof Set;
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
  const candidate = value as Record<PropertyKey, unknown>;
  return (
    candidate[IR_CLASS_SHAPE_CELL] === true &&
    typeof candidate.classId === "string" &&
    candidate.classId.startsWith("ir-class:v1:") &&
    typeof candidate.className === "string" &&
    Array.isArray(candidate.fields) &&
    Array.isArray(candidate.methods) &&
    Array.isArray(candidate.constructorParams)
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
  if (value instanceof FrozenMap) {
    return preparedIrReadonlyMap(
      [...value].map(
        ([key, item]) =>
          [immutableCopy(key, nextAncestors, activeCopies), immutableCopy(item, nextAncestors, activeCopies)] as const,
      ),
    );
  }
  if (value instanceof FrozenSet) {
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
  return Object.freeze(copy);
}

export function freezePreparedIrValue(value: unknown): unknown {
  return immutableCopy(value);
}

function hasNativeCollectionState(value: object): boolean {
  for (const has of [Map.prototype.has, Set.prototype.has, WeakMap.prototype.has, WeakSet.prototype.has]) {
    try {
      Reflect.apply(has, value, [value]);
      return true;
    } catch {
      // Native methods authenticate internal slots even when the prototype was erased.
    }
  }
  return false;
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
    if (item instanceof FrozenMap) {
      for (const [key, entry] of item) {
        freeze(key);
        freeze(entry);
      }
    } else if (item instanceof FrozenSet) {
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
