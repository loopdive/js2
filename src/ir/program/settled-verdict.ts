// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7354 Perf) The one mechanism by which a fail-closed currentness check of the Prepared path runs once instead of at
// every use: a check that is a pure function of input which can no longer change keeps its verdict.
import { preparedIrFrozenCollectionMembers } from "./data.js";

/**
 * Whether no own part of `value` can ever change: frozen arrays and plain records of data properties, and genuine
 * frozen collections of prepared data. Freezing cannot be undone, so the answer is permanent. What a record or array
 * lacks still resolves through `Object.prototype`/`Array.prototype`; `sharedPrototypeState` covers that. Internal
 * slots are not inspected: a check reads a collection's entries only through its prototype, and the only collections
 * admitted are branded frozen ones with their own frozen prototype.
 */
export function isImmutablePreparedIrValue(value: unknown): boolean {
  const visited = new Set<object>();
  const immutable = (item: unknown): boolean => {
    if (typeof item === "function") return false;
    if (item === null || typeof item !== "object" || visited.has(item)) return true;
    visited.add(item);
    const members = preparedIrFrozenCollectionMembers(item);
    if (members) return members.every(immutable);
    const prototype = Object.getPrototypeOf(item);
    if (
      !Object.isFrozen(item) ||
      (prototype !== (Array.isArray(item) ? Array.prototype : Object.prototype) && prototype !== null)
    )
      return false;
    return Reflect.ownKeys(item).every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!;
      return "value" in descriptor && immutable(descriptor.value);
    });
  };
  return immutable(value);
}

/**
 * The own properties (key, value, getter, setter) of `Object.prototype` and `Array.prototype`, the two shared
 * prototypes an immutable record or array reads a field it lacks through. A settled verdict holds only while this is
 * unchanged; a change sends the holder back to full authentication. Nothing else is tracked: the Map/Set/iterator
 * built-ins and `Function.prototype.call` that the frozen collections and the checks read through are TRUSTED. The
 * same gap exists without settling: patching `Map.prototype[Symbol.iterator]` after a check is accepted by the
 * per-use re-check too, because that re-check reads through the same patched built-ins.
 */
function sharedPrototypeState(): readonly unknown[] {
  const state: unknown[] = [];
  for (const prototype of [Object.prototype, Array.prototype])
    for (const key of Reflect.ownKeys(prototype)) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, key)!;
      state.push(key, descriptor.value, descriptor.get, descriptor.set);
    }
  return state;
}

/**
 * The holder of a settled verdict: the shared prototype state its check passed under while the checked input could
 * no longer change. The verdict holds for every later use that observes the same state.
 */
export interface PreparedIrSettlement {
  settled: readonly unknown[] | undefined;
}

/**
 * Runs `check` unless `holder` settled it. `check` must be a pure function of `input` (plus append-only registries
 * keyed by `input`'s own frozen objects). Immutability is decided BEFORE the check runs, so the verdict is over the
 * state that every later call observes; input that can still change is re-checked at every use.
 */
export function checkUnlessSettled(holder: PreparedIrSettlement, input: unknown, check: () => void): void {
  const prototypes = sharedPrototypeState();
  if (
    holder.settled?.length === prototypes.length &&
    holder.settled.every((entry, index) => Object.is(entry, prototypes[index]))
  )
    return;
  const settles = isImmutablePreparedIrValue(input);
  check();
  holder.settled = settles ? prototypes : undefined;
}

/**
 * The holder for a check that holds by construction when its subject is issued (a fresh derivation is its own
 * re-derivation): settled at once if `input` can no longer change, else checked at every use.
 */
export function settledAtIssue(input: unknown): PreparedIrSettlement {
  return { settled: isImmutablePreparedIrValue(input) ? sharedPrototypeState() : undefined };
}

/** The settled verdicts of ONE check, each held by the input object it was reached over. */
export class PreparedIrSettledChecks<Input extends object> {
  readonly #holders = new WeakMap<Input, PreparedIrSettlement>();

  check(input: Input, check: () => void): void {
    let holder = this.#holders.get(input);
    if (!holder) this.#holders.set(input, (holder = { settled: undefined }));
    checkUnlessSettled(holder, input, check);
  }
}
