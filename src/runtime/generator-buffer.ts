// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Host eager-generator storage and synchronous completion protocol.
// Wasm carrier adaptation and per-instance export resolution remain runtime-owned.

// Eager-generator hard cap (#991/#992): we lower generators to an array
// that is fully populated before .next() can be called. An infinite
// generator (e.g. `while (true) { yield; }`) would push forever, OOMing
// the Node process and causing the parent test runner to register a
// 30s timeout. Throwing a RangeError after a bounded number of yields
// turns those tests into a quick runtime exception instead of a
// worker-killing OOM. The cap is high enough (1M) that real-world
// generators are never affected.
export const EAGER_GENERATOR_LIMIT = 1_000_000;

export function createEagerGeneratorBuffer(): unknown[] {
  return [];
}

export function appendEagerGeneratorValue(buffer: unknown[], value: unknown): void {
  if (buffer.length >= EAGER_GENERATOR_LIMIT) {
    throw new RangeError("Eager generator buffer exceeded " + EAGER_GENERATOR_LIMIT + " yields");
  }
  buffer.push(value);
}

/** Drain yielded values but return, rather than append, the terminal payload. */
export function drainSynchronousGeneratorDelegation(buffer: unknown[], iterable: Iterable<unknown>): unknown {
  const iterator = iterable[Symbol.iterator]();
  if (iterator === null || (typeof iterator !== "object" && typeof iterator !== "function")) {
    throw new TypeError("Delegation iterator must be an object");
  }
  const next = iterator.next;
  for (;;) {
    const result: any = Reflect.apply(next, iterator, [undefined]);
    if (result === null || (typeof result !== "object" && typeof result !== "function")) {
      throw new TypeError("Delegation iterator result must be an object");
    }
    if (result.done) return result.value;
    const value = result.value;
    appendEagerGeneratorValue(buffer, value);
  }
}
