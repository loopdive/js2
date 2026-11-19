// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Internal-slot probes for IR preparation data. A native method authenticates its receiver's slot even when the
// prototype was erased or borrowed, but it answers "no" only by throwing, which is costly on every plain record.
// An object's internal slots are fixed when it is created, so each answer is cached per object: only the slot is
// cached, never prototypes, descriptors, values or entries.

const intrinsics = Object.freeze({
  get: WeakMap.prototype.get,
  set: WeakMap.prototype.set,
  apply: Reflect.apply,
  isArray: Array.isArray,
  getTime: Date.prototype.getTime,
  collectionProbes: Object.freeze([Map.prototype.has, Set.prototype.has, WeakMap.prototype.has, WeakSet.prototype.has]),
});
const collectionSlots = new WeakMap<object, boolean>();
const dateSlots = new WeakMap<object, boolean>();

function cached(cache: WeakMap<object, boolean>, value: object, probe: () => boolean): boolean {
  const { apply, get, set } = intrinsics;
  const known = apply(get, cache, [value]) as boolean | undefined;
  if (known !== undefined) return known;
  const answer = probe();
  apply(set, cache, [value, answer]);
  return answer;
}

/**
 * Whether `value` carries a Map, Set, WeakMap or WeakSet slot. An Array exotic object (or a proxy for one) is created
 * without them, so it is answered without a probe.
 */
export function hasNativeCollectionSlots(value: object): boolean {
  const { apply, isArray, collectionProbes } = intrinsics;
  if (isArray(value)) return false;
  return cached(collectionSlots, value, () => {
    // An index loop: the probe must not depend on a mutable Array.prototype.
    for (let index = 0; index < collectionProbes.length; index++) {
      try {
        apply(collectionProbes[index]!, value, [value]);
        // Probe success authenticates the slot, even when membership is false.
        return true;
      } catch {
        // Not this collection.
      }
    }
    return false;
  });
}

/**
 * Whether `value` carries a Date slot (an invalid Date too: its NaN is still an answer). Only the intrinsic's
 * incompatible-receiver TypeError means "no"; any other error propagates and is not cached.
 */
export function hasNativeDateSlot(value: object): boolean {
  const { apply, isArray, getTime } = intrinsics;
  if (isArray(value)) return false;
  return cached(dateSlots, value, () => {
    try {
      apply(getTime, value, []);
      return true;
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return false;
    }
  });
}

/** Records the slot-free fact of an object this module's caller just created with no native constructor. */
export function recordNoNativeCollectionSlots(value: object): void {
  intrinsics.apply(intrinsics.set, collectionSlots, [value, false]);
}
