// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// An existing object cannot acquire/lose these internal slots. Prototypes,
// descriptors, entries and values remain live data and must never be cached here.
const slots = Object.freeze({
  collections: new WeakMap<object, boolean>(),
  dates: new WeakMap<object, boolean>(),
  get: WeakMap.prototype.get,
  set: WeakMap.prototype.set,
  apply: Reflect.apply,
  collectionProbes: Object.freeze([Map.prototype.has, Set.prototype.has, WeakMap.prototype.has, WeakSet.prototype.has]),
  dateProbe: Date.prototype.getTime,
});

export function hasNativeCollectionState(value: object): boolean {
  const { collections, get, set, apply, collectionProbes } = slots;
  const cached = apply(get, collections, [value]) as boolean | undefined;
  if (cached !== undefined) return cached;
  let present = false;
  for (let index = 0; index < collectionProbes.length; index++) {
    try {
      apply(collectionProbes[index]!, value, [value]);
      present = true;
      break;
    } catch {
      // The native probe authenticates internal slots even with an erased prototype.
    }
  }
  apply(set, collections, [value, present]);
  return present;
}

export function hasNativeDateState(value: object): boolean {
  const { dates, get, set, apply, dateProbe } = slots;
  const cached = apply(get, dates, [value]) as boolean | undefined;
  if (cached !== undefined) return cached;
  let present = false;
  try {
    apply(dateProbe, value, []);
    present = true; // Invalid Date (NaN) still has the Date slot.
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
  apply(set, dates, [value, present]);
  return present;
}
