---
id: 2867
title: "Standalone: Promise / async microtask leaks Promise_resolve/reject/then + __make_callback host imports"
status: in-progress
assignee: ttraenkler/senior-dev-promise
created: 2026-06-30
updated: 2026-06-30
priority: medium
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: l
related: [2860, 1326]
umbrella: 2860
architect_spec: candidate
---

# Standalone: Wasm-native Promise / microtask carrier

## Problem

Promise construction and `.then`/`.catch`/`.finally`, plus async-function await
points, leak `env::Promise_resolve`, `Promise_reject`, `Promise_then`,
`Promise_then2`, and `__make_callback` to the JS host. Under standalone there is
no host microtask queue.

### Impact (measured 2026-06-30) — ~375 standalone-only failures (non-generator)

`Promise_then2` 766, `Promise_resolve` 788, `Promise_reject` 809,
`__make_callback` 1,198 across the gap (overlapping with async-generator #2865);
~375 have Promise/async as the dominant blocker once generators are excluded
(231 fail, 144 CE). (#1326c began standalone microtask/then work — verify what
landed.)

## Root cause

No standalone microtask queue + Promise state machine. Needs:
- a native `$Promise` struct (state: pending/fulfilled/rejected, value, reaction
  list).
- a native **microtask queue** drained at top-of-job / after the main module
  body (a Wasm-side ring buffer of pending reactions).
- `await` lowering in async functions that suspends the async frame (shares the
  resumable-frame machinery with #2864 generators) and resumes from the
  microtask drain.
- `Promise.resolve/reject/all/race/allSettled/any` as native statics.

## Implementation Plan

**`architect_spec: candidate`** — overlaps the generator-frame design (#2864).
Recommend the architect design the **resumable-frame substrate once** and share
it between async functions, generators, and async generators. Check #1326c
(`1326c-microtask-queue-and-promise-then-standalone.md`) for the partial
microtask work already present before re-deriving.

Sketch:
- `$Promise` + microtask ring in the object-runtime; drain entry called after
  module main + at each await resume.
- Replace the `Promise_*`/`__make_callback` host-import emission sites (search
  `src/codegen/**` for these names) with calls into the native carrier under
  `ctx.standalone`.
- `then`/reaction scheduling enqueues a native reaction record (closure +
  capability) instead of `__make_callback`.

### Architect resolution (2026-06-30) — MOSTLY ALREADY BUILT; gate it

**The native Promise/microtask carrier from #1326 + #1326c is DONE — but gated on
`ctx.wasi`, NOT `ctx.standalone`.** The single gate is:

```ts
// src/codegen/async-scheduler.ts:3044
export function isStandalonePromiseActive(ctx: CodegenContext): boolean {
  return ctx.wasi === true;   // broaden to: ctx.wasi || ctx.standalone
}
```

#### PR-A (gate-broaden + drain-wire)
1. Broaden `isStandalonePromiseActive` to `ctx.wasi || ctx.standalone`.
2. Drain wiring for the non-WASI export path (`__drain_microtasks` already
   exported when the queue registers).
3. Audit `async-scheduler.ts` for `ctx.wasi`-specific assumptions in the core
   Promise path.

#### PR-B (await on the canonical `$Frame` — after #2864 Phase F1)
Unify the async-function `await` lowering onto #2864's `$Frame`.

---

## ⚠️ Senior-dev verify-first findings (2026-06-30) — PR-A as specified REGRESSES the standalone floor; ESCALATED

Branch `issue-2867-standalone-promise-carrier`. The one-line gate-broaden
(`isStandalonePromiseActive` → `ctx.wasi || ctx.standalone`) is implemented and
**correct at the compile level** (standalone `Promise.resolve(1).then(x=>x+1)`
goes from 4 host imports — `Promise_resolve/then/reject` + `__make_callback` — to
**0 host imports / native `$Promise`**; the carrier resolves correctly: `test()`
returns 0 before `__drain_microtasks()` and 2 after). Existing
`issue-1326`/`issue-1326c` unit tests stay green; the WASI path is untouched.

**BUT the architect's premise is inverted for the test262 HARNESS.** The "375
Promise failures" are NOT failures in the standalone lane — they are host-import
**leaks that currently PASS**. Root cause: the test262 standalone harness
(`test262-worker.mjs` + `runTest262File(..., "standalone")`) instantiates with
`buildImports(result.imports, …)` — it **satisfies whatever imports the compile
declared with real JS-host Promise implementations** (it is NOT strict /
host-free; `doCompile` does not set `strictNoHostImports` for standalone). So
today's leaking Promise tests run on real host Promises and report
`status: pass`. `build-test262-report.mjs` counts `full_summary.pass` purely by
`status`, ignoring `host_import_leak_class` — so those leaky passes are already
**in the standalone floor count**.

Broadening the gate swaps real host Promises for the native carrier, which in the
harness is NOT yet a faithful replacement, so it **regresses** the floor.

**Measured (in-process `runTest262File(..., "standalone")`, the exact path the
#2095 baseline validator uses; OLD = gate reverted, NEW = gate broadened):**

| Set | OLD pass | NEW pass | OLD fail | NEW fail | OLD CE | NEW CE |
|---|---|---|---|---|---|---|
| 200-sample of Promise+await+async-function | 96 | **30** | 49 | 102 | 53 | 66 |
| 120 files: Promise/{resolve,reject,prototype/then} | 82 | **27** | 8 | 60 | 27 | 33 |

A −55-on-120-files drop on Promise core alone extrapolates to a multi-hundred
standalone-floor regression — far beyond the high-water tolerance of 50 → the PR
would be auto-parked, and it violates the "0 test262 regressions" acceptance.

**Why the native carrier regresses in the harness (two distinct causes):**
1. **Verdict-path drain gap.** The harness records the verdict synchronously as
   `ret = test()`; the generated `test()` computes `return __fail ? __fail : 1`
   from a module-level `__fail` *inside* its own body, **before** any microtask
   drains. With host Promises this didn't matter (the leaky path passed
   regardless). With the native carrier, `.then`/`$DONE` reactions sit un-drained
   in the ring when the verdict is read → the assertion never runs. The
   `__drain_microtasks` **export** exists, but the drain must fire **between the
   user body and the `__fail` read inside `test()`** — i.e. a source-injection in
   the harness wrapper (`test262-runner.ts` + `test262-shared.ts`) or a codegen
   change that injects the drain before each export return. The export-path hook
   alone (calling drain *after* `test()` returns) does NOT change the recorded
   verdict.
2. **Native then-callback codegen bugs.** +6 NEW compile errors on this subset:
   `Compiling function "test" failed: not enough arguments on the stack` in the
   native `.then`-callback path — real codegen defects the host path never hit.
3. (Separate, pre-existing) async-function `await` still returns `NaN` under
   **both** wasi and standalone (`async function f(){return await x}`) — that is
   PR-B / #2864 frame work, not introduced here.

**Conclusion / recommendation (ESCALATED to tech lead):** PR-A is not the
"cheapest big win, low risk" the spec assumed — in the harness accounting it is a
**net regression**. Making it net-positive requires, beyond the boolean flip:
(a) a verdict-path drain (harness-source or codegen injection, affecting all
targets — risk), AND (b) fixing the native then-callback codegen bugs, AND
arguably (c) PR-B for await. Even a perfect verdict-drain only recovers
reaction-gated fails; the +CE and native semantic bugs keep it below the
host-satisfied baseline on the measured subset. The gate-broaden commit is pushed
as a sync point but **NOT opened as a PR** (it would auto-park on the
standalone-floor gate). Awaiting tech-lead direction on scope (expand PR-A to
include the verdict-drain + native-carrier hardening, or re-sequence behind a
harness/floor-accounting change that makes host-free-ness the measured metric).

## Test plan

Standalone fail/CE → pass:
- `test/built-ins/Promise/**` (resolve/reject/then/finally/all/race/allSettled/any)
- `test/language/expressions/await/**`, `test/language/statements/async-function/**`

Full `merge_group` + standalone high-water. Sequence before async generators
(#2865 depends on this + #2864). Preserve the #2375 caution: Promise proto
value-read path must not collide with runtime async-capability state (the
null-deref noted in property-access.ts:736).
