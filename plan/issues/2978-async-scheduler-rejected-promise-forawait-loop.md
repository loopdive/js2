---
id: 2978
title: "Standalone async scheduler: for-await over a sync iterator yielding rejected promises loops forever (3GB JS-heap OOM)"
status: in-progress
assignee: ttraenkler/dev-2978
sprint: current
created: 2026-07-02
updated: 2026-07-06
priority: high
feasibility: hard
reasoning_effort: max
model: fable
architect_spec: done
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

## Implementation Plan (arch, 2026-07-05)

Two changes, ONE PR (hard ordering — see the pairing constraint above). Land the
trivial validity fix and the scheduler fix TOGETHER so making the module valid
never exposes the OOM loop to CI.

### Part A — the #2934(3b) validity fix (trivial, but MUST ship with Part B)

**Exact site:** `src/codegen/statements/loops.ts:5045-5047` — the IteratorClose
call in the vec/typed for-of drive:

```
{ op: "call", funcIdx: returnMethodIdx },
// Drop the return value (return() returns {value, done})
{ op: "drop" },                               // ← underflows for a VOID return()
```

The unconditional `drop` assumes `return()` yields a result. A user iterator with
a **void** `return()` (the repro's `return() { returnCount += 1; }`) has a
zero-result function type, so the `drop` underflows the operand stack → invalid
Wasm → the runner fail-fasts at validation (which is exactly why the OOM is
invisible today).

**Fix:** guard the `drop` on the callee's result arity. Resolve the function type
for `returnMethodIdx` (its `WasmFunction.typeIdx` → `ctx.mod.types[...]` func
`results`) and emit the `drop` only when `results.length > 0`:

```
{ op: "call", funcIdx: returnMethodIdx },
...(returnMethodResultArity > 0 ? [{ op: "drop" }] : []),
```

Audit the sibling IteratorClose sites in the same file that call
`__iterator_return` (loops.ts:5307, 5425, 5459) — `__iterator_return` is a fixed
multi-value helper (arity known), so those are fine; only the DIRECT
`returnMethodIdx` call at 5045 has the arity mismatch. dev-2934f verified this
one-liner: all validity probes green, close-count semantics correct, 21/21
iterator equivalence tests.

### Part B — the async-scheduler rejection→abrupt-completion fix (the OOM core)

**Spec §27.1.4.4 AsyncFromSyncIteratorContinuation:** for `for await` over a
**sync** iterator, each `next()` result's `value` is wrapped with
`PromiseResolve`. When that value is `Promise.reject(r)`, the resulting step
promise **rejects**; the async-from-sync driver's `onRejected` reaction must (a)
call `return()` on the underlying sync iterator exactly once (IteratorClose), and
(b) reject the `for await` iteration so the loop completes abruptly and control
lands in the user `catch`. Our standalone lowering instead settles the rejection
into a state the drive loop reads as "step done → call next() again" → infinite
re-entry → unbounded allocation.

**Where the machinery lives:**
- `src/codegen/async-cps.ts` — `forAwaitPoints` (async-cps.ts:83, 121-129): the
  native for-await drive lane. A for-await body with NO other await points is
  driven here (async-cps.ts:73-83 comment). This is where the per-iteration
  `next()`→await→continue loop is emitted; the rejection branch of the awaited
  step is the suspect — it must route to IteratorClose + rethrow, not loop back.
- `src/codegen/async-scheduler.ts` — the standalone Promise state machine:
  `buildPromiseResolveValueBody` (async-scheduler.ts:961) handles a resolve value
  that is itself a promise (the already-rejected inner arm at
  async-scheduler.ts:1015 "already rejected: schedule reject reaction with
  inner.value"), and `emitStandalonePromiseThen` (async-scheduler.ts:3139+) wires
  `onRejected` (async-scheduler.ts:3157, 3172, 3213). Confirm the for-await drive
  registers an `onRejected` reaction on the per-step promise and that the
  reaction transitions the drive state to REJECTED/abrupt — not to
  "pending/next".

**The fix (design):** in the for-await native drive (async-cps.ts), the awaited
per-step value must be settled through the promise state machine and its
**rejected** outcome must:
1. Set the loop's `doneFlag` such that the post-loop / abrupt path runs
   IteratorClose **once** — reuse the existing `returnIdx`/`returnMethodIdx`
   IteratorClose emitted by the for-of drive (loops.ts:5036-5051 / the
   finallyStack close at 5290-5320), gated so `return()` fires exactly once
   (the test asserts `returnCount === 1` — a double-close or zero-close both fail).
2. Re-throw the rejection reason as the loop's abrupt completion so the enclosing
   `try/catch` (the async function frame) catches it (`caught === true`,
   `e === "reject"`). This is a `throw` of the boxed reason at the drive's reject
   branch, NOT a `br` back to the loop header.
3. **Stop re-entering `next()`** — the reject branch must exit the drive loop, not
   continue it. The current infinite loop is the reject branch falling through to
   the "advance" path; the fix makes reject a terminal branch.

**Trace first (verify-before-implement):** compile the repro standalone and dump
the WAT of the for-await drive; find the branch after the awaited step settles and
confirm whether the REJECTED case has a `br` back to the loop header (the bug) vs
a throw/exit. Fix the branch, don't rebuild the drive.

### Edge cases / sibling shapes (audit, don't assume)

- **Async iterator** whose `next()` returns a rejected promise (vs the sync-wrap
  case): should already reject-and-close — confirm it doesn't share the looping
  bug (issue's own audit note).
- **`await` of a rejected promise inside the loop body** (not the step): must
  reject the body's continuation, independent of the step-reject path.
- **Exactly-once `return()`**: a rejection during IteratorClose's own `return()`
  must not re-trigger close (spec §7.4.6 — if IteratorClose is entered with a
  throw completion, the original throw wins and a throwing `return()` is
  swallowed). Verify `returnCount === 1` even if `return()` itself throws.
- **Normal completion unaffected**: `for await` over resolved promises still
  drains to `done` with no spurious `return()` call (doneFlag path).
- **Host lane parity**: the repro is standalone-specific (host lane delegates to
  V8's async-from-sync). Confirm the host lane already passes
  `for-await-next-rejected-promise-close.js` (or is skipped) so the fix is
  standalone-scoped.

### Verification plan

1. `.tmp/` — compile the exact repro standalone; assert termination with
   `returnCount === 1`, `caught === true`, `e === "reject"`, **bounded memory**
   (add a wall-clock/heap ceiling to the probe so a regression re-OOMs loudly, not
   silently for 14 s).
2. `built-ins/AsyncFromSyncIteratorPrototype/next/for-await-next-rejected-promise-close.js`
   standalone: invalid → **pass** (Part A makes it valid, Part B makes it correct).
3. Sibling shapes above as `.tmp/` probes.
4. Full async/generator equivalence suites + `merge_group` (the standalone-floor
   gate runs only in `merge_group` — this is where an OOM regression would surface;
   Part A+B must be validated there, not by a scoped sweep). Confirm no CI worker
   OOM: the test completes well inside the 15 s timeout.
