// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#7354 Perf) The one mechanism by which a fail-closed currentness check of the Prepared path runs once instead of at
// every use: a check that is a pure function of input which can no longer change keeps its verdict.
//
// A leaf of its own, as `dynamic-add-helper.ts` is: the IR's requirement checks and the WasmGC backend's reservation
// checks both settle through it, and the backend may not import an IR module for that. The one IR fact it needs —
// which objects are genuine frozen collections, and which are already known to be deeply frozen — are the caller's
// (`preparedIrFrozenCollectionMembers`, `isDeeplyFrozenPreparedIrValue`, IR program data), bound once per side with
// `preparedIrSettledVerdicts`.

/** The keys and values of a genuine frozen collection, or undefined for any other object. */
export type FrozenCollectionMembers = (value: object) => readonly unknown[] | undefined;
/** Whether the IR already knows `value` to be deeply frozen prepared data (a permanent fact). */
export type DeeplyFrozen = (value: object) => boolean;

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

// An inherited application field can be a getter, or an object whose contents change without
// changing its descriptor. Only the standard host prototype surface is eligible for reuse.
const recordKeys = new Set(
  "constructor __defineGetter__ __defineSetter__ hasOwnProperty __lookupGetter__ __lookupSetter__ isPrototypeOf propertyIsEnumerable toLocaleString toString valueOf __proto__".split(
    " ",
  ),
);
const arrayKeys = new Set<PropertyKey>([
  ..."length constructor at concat copyWithin entries every fill filter find findIndex findLast findLastIndex flat flatMap forEach includes indexOf join keys lastIndexOf map pop push reduce reduceRight reverse shift slice some sort splice toLocaleString toReversed toSorted toSpliced toString unshift values with".split(
    " ",
  ),
  Symbol.iterator,
  Symbol.unscopables,
]);
const initialPrototypeState =
  Reflect.ownKeys(Object.prototype).every((key) => typeof key === "string" && recordKeys.has(key)) &&
  Reflect.ownKeys(Array.prototype).every((key) => arrayKeys.has(key))
    ? Object.freeze(sharedPrototypeState())
    : undefined;

function normalPrototypeState(): readonly unknown[] | undefined {
  if (!initialPrototypeState || Object.getPrototypeOf(Array.prototype) !== Object.prototype) return undefined;
  const current = sharedPrototypeState();
  return current.length === initialPrototypeState.length &&
    current.every((entry, index) => Object.is(entry, initialPrototypeState[index]))
    ? initialPrototypeState
    : undefined;
}

/**
 * The holder of a settled verdict: the shared prototype state its check passed under while the checked input could
 * no longer change. The verdict holds for every later use that observes the same state.
 */
export interface PreparedIrSettlement {
  settled: readonly unknown[] | undefined;
}

/** The settled results of ONE pure computation over its input (a check's result is `void`). */
export interface PreparedIrSettledChecks<Input extends object, Output = void> {
  check(input: Input, compute: () => Output): Output;
}

export interface PreparedIrSettledVerdicts {
  /**
   * Whether no own part of `value` can ever change: frozen arrays and plain records of data properties, and genuine
   * frozen collections of prepared data. Freezing cannot be undone, so the answer is permanent. What a record or array
   * lacks still resolves through `Object.prototype`/`Array.prototype`; `sharedPrototypeState` covers that. Internal
   * slots are not inspected: a check reads a collection's entries only through its prototype, and the only collections
   * admitted are branded frozen ones with their own frozen prototype.
   */
  isImmutable(value: unknown): boolean;
  /**
   * Runs `check` unless `holder` settled it. `check` must be a pure function of `input` (plus append-only registries
   * keyed by `input`'s own frozen objects). Immutability is decided BEFORE the check runs, so the verdict is over the
   * state that every later call observes; input that can still change is re-checked at every use.
   */
  checkUnlessSettled(holder: PreparedIrSettlement, input: unknown, check: () => void): void;
  /**
   * The holder for a check that holds by construction when its subject is issued (a fresh derivation is its own
   * re-derivation): settled at once if `input` can no longer change, else checked at every use.
   */
  settledAtIssue(input: unknown): PreparedIrSettlement;
  /** A fresh holder table for ONE pure computation, each result held by the input object it ran over. */
  settledChecks<Input extends object, Output = void>(): PreparedIrSettledChecks<Input, Output>;
}

export function preparedIrSettledVerdicts(
  collectionMembers: FrozenCollectionMembers,
  deeplyFrozen: DeeplyFrozen,
): PreparedIrSettledVerdicts {
  const isImmutable = (value: unknown): boolean => {
    const visited = new Set<object>();
    const immutable = (item: unknown): boolean => {
      if (typeof item === "function") return false;
      if (item === null || typeof item !== "object" || visited.has(item) || deeplyFrozen(item)) return true;
      visited.add(item);
      const members = collectionMembers(item);
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
  };
  const checkUnlessSettled = (holder: PreparedIrSettlement, input: unknown, check: () => void): void => {
    const prototypes = normalPrototypeState();
    if (prototypes && holder.settled === prototypes) return;
    const settles = prototypes !== undefined && isImmutable(input);
    check();
    holder.settled = settles ? prototypes : undefined;
  };
  return {
    isImmutable,
    checkUnlessSettled,
    settledAtIssue: (input) => ({ settled: isImmutable(input) ? normalPrototypeState() : undefined }),
    settledChecks: <Input extends object, Output = void>() => {
      const holders = new WeakMap<Input, PreparedIrSettlement & { output?: Output }>();
      return {
        check(input: Input, compute: () => Output): Output {
          let holder = holders.get(input);
          if (!holder) holders.set(input, (holder = { settled: undefined }));
          let output = holder.output as Output;
          checkUnlessSettled(holder, input, () => {
            output = compute();
          });
          if (holder.settled) holder.output = output;
          else holders.delete(input);
          return output;
        },
      };
    },
  };
}
