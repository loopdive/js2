// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4157) Pin one or more of the tuned-set performance flags for a test file.
 *
 * ## Why this exists
 *
 * The eleven flags in `src/perf-flags.ts` flipped to **default ON**. They change
 * the emitted shape — they inline calls, elide provably-dead null guards, add
 * helper functions (so absolute function indices shift) — without changing any
 * answer.
 *
 * A test that asserts a **value** is unaffected. A test that asserts a *shape*
 * as a PROXY for its own feature is not: it starts failing on evidence that has
 * nothing to do with the feature it names. The failures are all of that form —
 *
 *   - `expected '(func $f …)' to match /\bcall\b/`   — the call was INLINED
 *   - `expected [] to deeply equal ['Base_init']`    — the call EDGE was inlined
 *   - `expected 53 to be 50` / `to contain 'call 66'`— an absolute index SHIFTED
 *   - `to match /ref\.is_null[\s\S]*throw/`          — the guard was ELIDED
 *
 * — i.e. the tuned pass working, observed through another feature's instrument.
 *
 * ## Why pinning, and not relaxing the assertion
 *
 * Those assertions are the entire evidence those tests carry: `#3522`'s
 * "prepared exactly once" lists, `#1761`'s "non-provable length must NOT
 * presize" soundness boundary, `#4150`'s "the fast path emitted no call". Loosen
 * them and the test still passes while proving nothing — the exact failure mode
 * `plan/issues/4157-…` records twice. Pinning keeps each assertion literally
 * true of the configuration it was written against, and names the interference
 * at the call site.
 *
 * ## What pinning costs, and it is a real cost
 *
 * A pinned file no longer exercises the SHIPPED default. That is acceptable only
 * because these are shape assertions: the value-level coverage of the same
 * feature lives in `tests/equivalence/`, which runs at the default and was swept
 * clean. Pin the narrowest set of flags that removes the interference — never
 * the whole table by reflex — and say which one and why.
 */
import { afterAll, beforeAll } from "vitest";

/**
 * Set `flags` for the whole file and restore the previous values afterwards.
 *
 * Call at module top level, BEFORE any `describe`, so this `beforeAll` is
 * registered (and therefore runs) ahead of a suite's own compiling hooks.
 *
 * `delete` rather than `= undefined` on restore: assigning to `process.env`
 * stringifies, and the literal `"undefined"` reads as a SET variable — which,
 * under the tuned-set token rule, means ON.
 */
export function pinPerfFlags(flags: Record<string, string>): void {
  const saved: Record<string, string | undefined> = {};
  beforeAll(() => {
    for (const [key, value] of Object.entries(flags)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
  });
  afterAll(() => {
    for (const key of Object.keys(flags)) {
      const previous = saved[key];
      // biome-ignore lint/performance/noDelete: only `delete` truly unsets an env var
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
}
