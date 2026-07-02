---
id: 2978
title: "Standalone async scheduler: for-await over a sync iterator yielding rejected promises loops forever (3GB JS-heap OOM)"
status: ready
created: 2026-07-02
updated: 2026-07-02
priority: high
feasibility: hard
task_type: bug
area: codegen
goal: standalone
related: [2934]
umbrella: 2860
horizon: l
---

# Standalone async scheduler: rejected-promise for-await loops forever (OOM)

## Problem

Under `--target standalone`, a `for await` loop over a **sync** iterator whose
`next()` yields `{ value: Promise.reject("reject"), done: false }` never
terminates: the rejection does not propagate as an abrupt completion that stops
the drive loop, so the scheduler keeps re-entering `next()` and allocating.
Measured: **~3 GB JS heap in ~14 s**, killed by V8's
"Ineffective mark-compacts near heap limit" OOM — which **races the runner's
15 s per-test timeout**, i.e. in CI this is a **worker-killing OOM flake**, not
a clean `fail`.

Repro (minimal, verified 2026-07-02 by dev-2934f):

```ts
var returnCount = 0;
const syncIterator = {
  [Symbol.iterator]() {
    return {
      next() {
        return { value: Promise.reject("reject"), done: false };
      },
      return() {
        returnCount += 1;
      },
    };
  },
};
async function t() {
  try {
    for await (let _ of syncIterator as any);
  } catch (e) {}
}
t();
```

Spec behavior (§27.1.4.4 `AsyncFromSyncIteratorContinuation` + the test's own
doc block): the rejected `valueWrapper` must reject the step promise; the
driver's `onRejected` closes the sync iterator (`return()` — the test asserts
`returnCount === 1`) and the `for await` completes abruptly with the rejection
(`caught === true`). Our lowering instead keeps driving.

Canonical test262 file:
`test/built-ins/AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js`.

## Why this is currently INVISIBLE in CI (and must stay that way until fixed)

Today that module is **invalid Wasm** (see #2934 (3b): the for-of IteratorClose
lowering emits an unconditional `drop` after `call <iter>_return`, which
underflows for a **void** `return()` method). The runner therefore fail-fasts at
validation and never runs the OOM loop.

## PAIRING CONSTRAINT (hard ordering — recorded in #2934 (3b) too)

The one-line validity fix for #2934 (3b) — in
`src/codegen/statements/loops.ts` (~5035), guard the post-`return()` `drop` on
the callee's result arity (`retFt.results.length > 0`) — is **verified and
trivially re-creatable** (all validity probes green, close-count semantics
correct, 21/21 iterator equivalence tests). **It MUST NOT land alone.** Making
the module valid exposes the OOM loop to CI shard workers. Land the (3b)
drop-arity fix **together with, or after,** this scheduler fix.

## Where to look (architect eyes wanted — /architect-spec pass on dispatch)

- `src/codegen/async-cps.ts` / `src/codegen/async-scheduler.ts` — how a
  rejected awaited value is (not) turned into an abrupt completion of the
  driving loop's continuation; suspect the rejection settles into a state the
  drive loop treats as "pending/next" instead of "reject → IteratorClose →
  rethrow".
- The for-await lowering's interaction with the SYNC-iterator wrap
  (AsyncFromSyncIterator): where `PromiseResolve(value)`'s rejection handler
  should (a) call `return()` on the sync iterator exactly once and (b)
  propagate the reason to the loop's catch.
- Also audit sibling always-reject shapes: `for await` over an ASYNC iterator
  whose `next()` returns a rejected promise, and `await` of a rejected promise
  inside the loop body (both should already work — confirm no shared-scheduler
  looping).

## Acceptance

- The repro above terminates with `returnCount === 1`, `caught === true`
  (`e === "reject"`), bounded memory.
- `for-await-next-rejected-promise-close.js`: standalone invalid → **pass**
  (with the #2934 (3b) drop-arity fix landed in the same PR or before this).
- No CI worker OOM: the test completes well inside the 15 s timeout.
- 0 test262 regressions; async/generator equivalence tests green.
