---
id: 3198
title: "default lane: Promise combinator callbacks never execute — vacuous slice (218 fails)"
status: blocked
created: 2026-07-12
updated: 2026-07-12
priority: medium
feasibility: hard
task_type: bug
area: codegen
es_edition: ES2018
language_feature: promise-combinators
goal: core-semantics
sprint: Backlog
horizon: m
umbrella: 3184
related: [3184, 3197, 2614, 2613, 2623, 2940]
blocked_on: "host-lane async-continuation drive primitive (shared with #3197)"
origin: "2026-07-12 Fable codebase audit §F1; slice of #3184"
---

# #3198 — Promise-combinator vacuous slice (218)

Sub-slice of **#3184**. This slice owns the **Promise-combinator** half; the
for-await-of half is **#3197**.

## Problem

`built-ins/Promise/{any,race,all,allSettled,prototype}` carries **218**
`vacuous: harness-wrapper callback never executed (#2940)` records on the
default (JS-host) lane: the combinator's resolve/reject/element callbacks —
and therefore every assertion — never run, yet the test reports success. This
is the second-biggest slice of the 1,544-record vacuous family after
for-await-of (#3197).

## Distinct from #2614 / #2613 (READ THIS BEFORE CLAIMING)

- **#2614** (`blocked`, assignee senior-developer) = "read the constructor's
  own `resolve` + callable resolve/reject element functions" (~45 fails). That
  is a spec-detail fix for combinator tests that **do run**. This slice is the
  **vacuous-drive** class — tests where the callback chain never executes at
  all. Mechanistically different, same method surface.
- **#2613** (`blocked`) = await-thenable assimilation (~15). Not this.
- The audit (§F1) explicitly recommends **un-blocking or re-slicing #2614**
  for this 218. Coordinate: confirm whether the vacuous root cause is shared
  with #3197's async-drive gap (likely) — if so, #3197's fix may flip a large
  share of this bucket for free; remeasure before implementing.

## Reproduction path (verified anchors)

Combinator dispatch is in `src/runtime.ts`: `Promise_all` (`:13450`),
`Promise_race` (`:13455`), `Promise_allSettled` (`:13460`), `Promise_any`
(`:13465`); the `NewPromiseCapability(C)` / `Construct(C, «executor»)` path
(#2614) at `:12445` and `:13341-13400`. Trace whether the combinator's
per-element `resolve`/`reject` callbacks are ever invoked, or whether the host
Promise bridge swallows the first tick.

## Acceptance criteria

1. Root-cause note: which link drops the callback (combinator entry →
   per-element resolve/reject → settle → $DONE).
2. ≥ 120 of the 218 vacuous Promise-combinator records flip to genuine pass OR
   honest assertion failures (no longer vacuous) on the default lane.
3. No standalone-lane regressions.
4. Do NOT absorb #2614's constructor-resolve-reading fix unless it falls out
   for free; if it does, note the overlap and coordinate the merge with the
   #2614 owner.

## Coordination (priority lowered: overlaps blocked/active Promise work)

Priority is **medium**: this slice's file (`src/runtime.ts` Promise region)
overlaps blocked #2614 (senior-developer) and active Promise-capability work
(dev-promise-cap). Confirm no in-flight lock on the combinator dispatch region
before claiming; prefer to land after or alongside #3197 (shared root cause).

## Root-cause note (2026-07-12, dev-promise-vac) — BLOCKED, not a combinator bug

**Verdict: this is NOT a `src/runtime.ts` combinator bug.** The combinators are
correct — they delegate to the host `Promise.all/race/allSettled/any`
(`src/runtime.ts` `Promise_all`/`Promise_race`/`Promise_allSettled`/`Promise_any`),
which correctly schedule their per-element and `.then` reactions. The 218
vacuous records are a manifestation of the **general host-lane
`.then`/async-continuation drive gap** — the SAME architectural gap as #3197
(for-await-of). Both are `vacuous: harness-wrapper callback never executed
(#2940)`; they are one problem, not two slices.

### Which link drops the callback (combinator entry → per-element → settle → $DONE)

None of the combinator-internal links drop it. The callback is dropped at the
**verdict-read boundary**, one level above the combinator:

1. On the DEFAULT (JS-host) lane, `Promise.X(...)` returns a **host** promise;
   `.then(cb)` (the callback that holds the assertions + `$DONE`) is lowered to
   host `p.then(cb)` (`Promise_then`), which schedules `cb` as a **host
   microtask**.
2. `__drain_microtasks()` — which the runner appends to async-test bodies to
   pump pending reactions before the vacuity gate — is a **compile-time no-op on
   the host lane**: `getDrainFuncIdxForWasiStart(ctx)` returns `null` off the
   native-`$Promise` carrier, so it emits nothing
   (`src/codegen/expressions/calls.ts:4928-4938`). The host owns its own
   microtask queue; wasm can't synchronously flush it.
3. The runner reads the verdict **synchronously**: `const ret = testFn();`
   (`tests/test262-runner.ts:3981`), with no `await`/tick. The vacuity gate that
   returns `-262` lives INSIDE `test()` (`tests/test262-runner.ts:3039-3047`).
4. So for any top-level `Promise.X(...).then(cb-with-$DONE)`, `cb` is still
   queued (never run) when the gate executes → `__assert_count === 1` /
   `__harness_cb_dead === __harness_cb_expected` → returns `-262` → scored
   `vacuous`.

### Empirical confirmation (probe, host lane, this branch)

Compiled `Promise.X(...).then(() => ran++)` + `__drain_microtasks()`, read `ran`
synchronously (mirrors the runner):

| body | host-lane `ran` |
| --- | --- |
| `Promise.resolve(7).then(cb)` | **0** |
| `Promise.all([1,2,3]).then(cb)` | **0** |
| `Promise.race([1,2,3]).then(cb)` | **0** |
| `async () => { ran++ }()` (sync body, no await) | 1 |

`Promise.resolve().then()` is undriven too, so the gap is **not
combinator-specific** — it is every host-lane `.then` continuation. (Probe was a
gitignored `.tmp`/`probe-*` scratch, not committed.)

### Blocked on (shared primitive with #3197)

The fix is host-lane async-continuation drive, NOT a combinator edit: either
activate the native `$Promise` carrier on the host lane (so `.then`
continuations land on the wasm microtask ring drained by
`__drain_microtasks()`), or a synchronous settled-`.then` bridge that enqueues
onto that ring at `.then`-call time. That is #2980 carrier-widen territory and
overlaps active `dev-promise-cap` + blocked #2614. Building it ad-hoc here would
collide, so #3198 is marked `blocked` behind that primitive.

**#2614 overlap did NOT surface into code.** #2614 (read the constructor's own
`resolve` + callable resolve/reject element functions) is a distinct spec-detail
fix for combinator tests that DO run; this slice is the never-runs drive class.
Those paths were read-only during diagnosis; nothing was touched.

### Recommendation

Resolve #3197 and #3198 together as ONE host-lane async-drive decision (now with
the stakeholder). When the host-lane drive primitive lands, remeasure #3198 —
much of the 218 likely flips for free alongside #3197's for-await bucket.

## Audit cross-link

`plan/log/2026-07-12-fable-codebase-audit.md` §F1.
