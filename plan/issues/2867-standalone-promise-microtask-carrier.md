---
id: 2867
title: "Standalone: Promise / async microtask leaks Promise_resolve/reject/then + __make_callback host imports"
status: blocked
assignee: ttraenkler/sendev-promise
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
blocked_on: [2864]
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

## Implementation notes (PR-B — sendev-promise, 2026-06-30)

PR-A (gate-broaden `isStandalonePromiseActive` → `ctx.wasi || ctx.standalone`)
is **unblocked** by #2360/#2879: the honest host-free metric counts a standalone
pass only when host-free, so a leaky-pass → native-carrier migration can only
move `host_free_pass` UP (a Promise test leaked on main → `host_free=0`; the
native carrier makes it either a real host-free pass `+1` or a host-free fail,
still `0`). The two real defects sr-promisegate found are fixed here.

### Defect 1 — late-import funcIdx-shift in the native `.then` path (the +CE)
`Promise.reject(<object>).then(fn1, fn2)` where a callback body pulls in a LATE
host import (`new Test262Error(...)` → `__new_Test262Error`) failed Wasm
validation with **"not enough arguments on the stack for call (need 1, got 0)"**.

Root cause: `compilePromiseThenReceiverBuffer` /
`compileStandalonePromiseThenCallback` (`src/codegen/expressions/calls.ts`) swap
`fctx.body` to a scratch buffer via a plain JS-local `savedBody`, compile the
receiver/closure into the buffer, then restore. While swapped, the **enclosing
function body** (held only in `savedBody`) is invisible to
`shiftLateImportIndices` — it walks `fctx.body` / `ctx.currentFunc.body` (both
now the buffer) and `ctx.liveBodies` (the buffers), but NOT the orphaned saved
array. A late import added during the callback compile shifts every defined
function +1, but the already-emitted `call __new_plain_object` (from an earlier
`var a = {}`) stayed at its pre-shift index, which now resolves to the 1-arg
`__obj_hash`. This is the #1384/#2503 detached-body class, for the swapped-OUT
body. Fix: register `savedBody` in `ctx.liveBodies` for the swap window (remove
after only if we added it — it may be an outer buffer for nested `.then`).

### Defect 2 — verdict-path drain gap (the false-pass / false-fail)
The test262 harness records `ret = test()` synchronously; the generated `test()`
reads `__fail` immediately after the user body. Native `.then` reactions are
QUEUED, not run synchronously, so the assertions inside them set `__fail` only
once the microtask ring drains. Under the host-leak path this silently passed
(the reaction never ran, `__fail` stayed 0 → false pass); under the native
carrier it false-failed.

Fix has two parts:
1. **`__drain_microtasks()` compiler intrinsic** (`compileCallExpression`,
   calls.ts): a call to the bare identifier `__drain_microtasks()` lowers to the
   native drain (`getDrainFuncIdxForWasiStart`) **only when a Promise queue was
   already registered**; otherwise it emits NOTHING. So it is a byte-neutral
   no-op for every JS-host compile and every Promise-free module — verified
   byte-identical on `gc`/`standalone`/`wasi` (`tests/issue-2867.test.ts`).
2. **Harness wrapper injection** (`wrapTest`, test262-runner.ts): a bare
   `__drain_microtasks();` statement between the user body and the `__fail` read
   (both the synchronous and top-level-await wrappers). Bare (not `try{}catch`)
   to keep the wrapper byte-identical off the Promise path — no empty-try churn
   across ~43k tests, so `gc` and non-Promise standalone output is unchanged.

### Measured (in-process `runTest262File(…, "standalone")`, the #2095 path)
120 files `Promise/{resolve,reject,prototype/then}`:
- gate-broaden only (no fixes): pass 27 / `host_free_pass` 14 / CE 33 — but 7 of
  the 14 were **false passes** (reaction never validated).
- with both fixes: pass 20 / **`host_free_pass` 7 (honest)** / CE 28. The +CE
  "not enough arguments" cluster is gone; the false passes are now honest fails.
  vs main (gate off, these all leaked → `host_free=0`): **+7 honest host-free**.

Remaining standalone CE/fail on this subset are pre-existing carrier-completeness
gaps **out of scope** for PR-B and `host_free=0` on main (no regression):
`Promise.{resolve,reject,then}` as a static **value-read** (#2375 caution),
`new Promise(executor)` capability records, `__get_builtin` dynamic-shape (#1472
Phase B), `__to_primitive` (#1806).

### Deferred — async-function `await` returns NaN (both wasi+standalone)
Tied to await-on-`$Frame`; the convergence point with #2864's resumable-frame
substrate. NOT touched here to avoid duplicating sr-frame's work — coordinate on
the shared `$Frame` lowering.

## Re-park diagnosis (PR #2367 merge_group, 2026-06-30) — root cause is #1897, not the drain

PR #2367 passed every PR-level check but **failed `merge shard reports`** in the
merge_group. Breakdown of the failed run (28428158322):

- **High-water floor (#2097/#2879 §2): PASSED** — `current pass=13136, mark=12883,
  delta=+253`. The host-free gain is real and banked.
- **#1897 standalone regression guard: FAILED** — `net -1337 (improvements 76 −
  regressions 1413)`. Top buckets: `class/elements` 224+212, `dynamic-import` 170,
  `object/dstr` 72, `Promise/prototype/then` 52.

**Diagnosis (data, not hypothesis).** Re-measured the regressed buckets on this
branch with the drain injection reverted, then classified each pass→fail flip
against the standalone baseline JSONL by `host_import_leak_class`:

- Removing the drain left `class/elements` (pass=29) and `Promise/then` (pass=9)
  **unchanged** — only `dynamic-import` improved (7→14). So the **gate-broaden
  itself**, not the drain, is the dominant regression source: it swaps the
  COMPLETE host Promise for the in-progress native carrier, so tests that only
  passed by leaning on the host now fail.
- 120-file sample of the regressed buckets: **19 pass→fail flips, ALL
  leaky-baseline** (the baseline pass carried an `env::` import), **0 genuine
  host-free regressions**.

Per **#2879 §4** a leaky-pass → host-free-fail is explicitly NOT a regression
("the floor is on host_free_pass, so it does not breach … treat Δhost_free_pass
≥ 0 as the pass/fail signal for standalone, not Δpass"). But the **#1897
standalone guard** (`scripts/diff-test262.ts` via the `Standalone regression
guard` step in `test262-sharded.yml`) counts **raw status pass→fail** and is NOT
host-free-aware — so it trips on exactly the migrations #2879 set out to credit.
This blocks every carrier-migration PR (#2864 generators slipped through only
because generators run synchronously and don't convert host-passes to fails at
this scale).

**Required unblock (escalated):** make the #1897 standalone guard host-free-aware
— exclude a pass→fail flip from the regression count when the BASELINE entry was
a leaky pass (`host_import_leak_class` set / had an `env::` import) and the new
result is host-free. This is the completion of #2879 §4 for the per-test guard,
and a shared-CI-gate change (owner sendev-hostfree / coordinator sign-off).

**Branch state:** gate-broaden + funcIdx-shift fix + `__drain_microtasks()`
intrinsic retained (all correct, tested). The broad `wrapTest` drain INJECTION is
reverted (deferred) — it is a secondary contributor and the honest-verdict drain
should re-land together with the #1897 host-free accounting fix, so the reactions
it runs are credited honestly rather than counted as regressions.

## CORRECTED re-park diagnosis (sendev-promise-unstick, 2026-06-30 ~14:50) — root cause is BASELINE DRIFT, not #2367

The #2890 host-free guard fix landed and the drain injection was re-landed
(HEAD `ad5b1f14a`), yet `merge shard reports` **kept failing** at 09:45/09:51.
Pulled the regressed-test delta from the failed merge_group runs and cross-checked
against UNRELATED PRs' runs in the same window. The prior diagnosis above
(attributing `class/elements` to the gate-broaden) is **wrong** — corrected here:

**The dominant ~1,200 regressions are systemic baseline DRIFT, categorically not
attributable to #2367:**

| Bucket | #2367 run (28435313054, 09:51) | NO-#2367 run (28429650086, 08:04) |
|---|---|---|
| `class/elements` stmt+expr | 214 + 202 | 224 + 212 |
| `dynamic-import` catch+usage | 100 + 70 | 100 + 70 |
| `object/dstr` | 72 | 72 |
| `Promise/prototype/then` | **excused, below 50** | 52 |
| Excused leaky->host-free | **73** | -- |

- **#2367 was bot-parked at 07:43**, so it was NOT in the 08:04 merge group -- yet
  that run shows the **identical** `class/elements`/`dynamic-import`/`dstr` cluster.
  Every failed merge_group run in the **07:35-09:51 window** (multiple unrelated
  PRs, bucket signatures `95e30cc5`/`01e72c3c`/`7ad07ec0`) carries the same
  ~1,400-regression cluster. Per `feedback_baseline_drift_cross_check`: identical
  clusters across unrelated PRs = drift, not a PR regression.
- **#2367 cannot produce those buckets by construction.** Its only code changes
  are `async-scheduler.ts` + `calls.ts` (Promise/`.then` paths) + the harness
  drain. `class/elements`, `dynamic-import`, `object/dstr` are non-async language
  features that never invoke Promise lowering. The `__drain_microtasks()`
  intrinsic is provably byte-neutral off the Promise path
  (`getDrainFuncIdxForWasiStart` returns `null` with no registered queue;
  `tests/issue-2867.test.ts` confirms byte-identity on `gc`/`standalone`/`wasi`).
- **#2890's accounting IS working as intended** -- 73 leaky->host-free Promise
  migrations excused; the `Promise/prototype/then` bucket dropped below the
  50-test threshold in #2367's run (it was 52 = a GATE FAIL in the no-#2367 drift
  run). So the host-free guard is NOT the unblock gap; suspect (a) is closed.

**Rules out all three architect suspects: NOT (a) second accounting path
[#2890 works], NOT (b) the drain regressing non-Promise tests [byte-neutral +
appears without #2367], NOT (c) floor drop [+262 high-water].**

**The drift has cleared.** merge_group runs pass from 09:56 onward; sibling
standalone-carrier PR #2377 (symbol) merged cleanly through the same gate after
09:56. A main-side baseline mismatch in the 07:35-09:51 window (a real standalone
regression on main vs a not-yet-refreshed baseline JSONL, or a nondeterministic
standalone compile for those buckets) inflated the count for every PR in that
window; a later `promote-baseline` on a main push re-synced it.

**Action taken:** no code change needed -- #2367 is innocent. Caught the branch up
to current `upstream/main` (`02ec97471`, merge `f4e2850ce`) so the merge_group
rebuilds on the post-drift base + refreshed baseline. `issue-2867.test.ts` green
(7/7). Escalated to the lead to remove the **bot park-hold** and re-enqueue ONCE
(drift cleared; do not re-enqueue in a loop). The +247 host-free gain is real and
ready to land.

## DEFINITIVE re-diagnosis (sendev-promisecarrier, 2026-06-30 ~16:00) — NOT drift; #2367 is a real −1404 standalone regression, BLOCKED on #2864

The "baseline drift" conclusion immediately above is **wrong** and caused the
harmful re-enqueue (12:36→13:04 merge_group all failed `merge shard reports`).
Proven by comparing the **actual merged-report artifacts** (not CI-log heuristics):

- #2377's own merge_group (sha `02ec`, current main tip) standalone report =
  **26407 pass** — its `Standalone regression guard (#1897)` + high-water floor
  both ran and PASSED. The regression-gate baseline (26407) equals this exactly →
  **baseline is fresh, not stale.**
- #2346 (exn-demask) merge_group on the same base = **26407 pass** (no pass
  regression). Main's standalone floor is intact at 26407.
- **#2367's merge_group (sha `ff63fd3`/`1b16cf1`, #2367 + current main) = 25003
  pass (−1404).** Identical signature only across the two #2367 runs (same PR
  re-validated), NOT across different PRs → the cross-PR drift heuristic does not
  apply.

**Flaw in the drift argument:** "#2367 only touches Promise paths so it can't
regress class/elements" is false — `class/elements` `static-async-method` /
`async-gen` variants and `for-await-of` / `dynamic-import` all drive the
async/Promise state machine the `isStandalonePromiseActive` flip rewires.

**Residual decomposition** (60-test random sample of the 1460 regressions,
compiled `--target standalone`, classified by host-import footprint):

| Cause | share | mechanism |
|---|---|---|
| **A — `new Promise(executor)`** | **~12% (7/60)** | `new-super.ts:2774` still routes `new Promise` to the host `Promise_new` import (a JS-Promise externref), but `.then` is now native → native `.then` does `ref.cast externref→$Promise` on a host promise → **illegal cast** (620 illegal_cast in the merged report). |
| **B — async/generator substrate** | **~88% (53/60)** | async-generators, async methods, for-await-of, dynamic-import, top-level-await. With the flag REVERTED these emit host `Promise_resolve`/`Promise_then2`/`Promise_reject`/`__make_callback` (verified) — leaky-baseline passes the harness satisfied with real host Promises. The flip removes the leak but the CPS async state-machine + async-iterator lowering are **not yet native** → mixed/broken module → ToPrimitive (246) + illegal_cast + assertion_fail. |

**Conclusion:** net-positive on standalone (>26407, the stated bar) is
**unreachable** without making the full async-function / generator / async-
generator substrate native = **#2864 (await-on-`$Frame`, PR-B)**. The `+247` was
never a standalone gain; on standalone #2367 is **+56 / −1460 = net −1404**. This
is exactly the #2864 wall flagged at dispatch.

**Recommendation:** keep #2367 **parked** (do NOT re-enqueue — it widens the gap).
Re-sequence: land #2864 substrate FIRST, then the `isStandalonePromiseActive`
flip. Cause A (native `new Promise(executor)`) is an independent smaller
increment (`new-super.ts`) but recovers only ~12% alone and still needs cause B.
`status` → `blocked` (blocked_on #2864); the optimistic `done` was set by the
impl PR before the merge_group regression surfaced.

## Scoping feasibility verdict (sendev-promisecarrier, 2026-06-30 ~16:30) — CANNOT scope to net-positive; #2864 is the hard prerequisite

Tested the coordinator's "scope the gate-flip to only the natively-working paths"
proposal. Verdict: **not feasible to a meaningful net-positive.** Hard numbers
from the merged-report delta (main #2377 = 26407 → #2367 = 25003):

**Why call-site scoping fails.** `async-cps.ts` (the async-fn / generator /
async-gen / for-await state machine) **does not gate on the flag at all** — it is
*always* host (`Promise_resolve`/`Promise_then2`/`__make_callback`). So the
regression is pure **native↔host promise-value mixing** at await / `.then` /
`wrapAsyncReturn` / host-import boundaries (e.g. a native `$Promise` from native
`Promise.resolve` handed to the host `dynamic_import`/`Promise_then2` import →
`ToPrimitive` / `illegal_cast`).

**Regression split (1460 total):**
| | substrate (async-fn/gen/for-await/dyn-import) | plain-promise |
|---|---|---|
| illegal_cast | 332 | 288 |
| assertion_fail | 530 | 47 |
| to_primitive | 225 | 21 |
| null_deref | 14 | 2 |
| **total** | **1101** | **359** |

- **1101 substrate regressions are unfixable by gating** — they already keep the
  host path; they regress only because native promise values leak into it. Fixing
  them = making the substrate consume/produce native promises = **#2864**.
- Even a perfect fix of all 359 plain-promise regressions, keeping all +56
  improvements, nets **+56 − 1101 = −1045**. Net-positive is unreachable.

**Module-level gate (native only for modules with NO async/gen/for-await) —
also not worth it.** It would eliminate the 1101 substrate regressions (those
modules go fully host/leaky), but: (a) it does NOT fix the 359 plain-promise
regressions (sync-Promise modules stay native → still broken — native
`new Promise().then()` illegal_cast + native then-callback defects), and (b) of
the +56 improvements, **54 are themselves substrate** (`async-private-gen-meth`,
async methods) → lost when their modules revert to host; only **~2** are genuine
sync-Promise wins (`Promise/prototype/finally/subclass-species-*`). So the
best-case module-gate result is ≈ **+2**, contingent on ALSO landing native
`new Promise` + native then-callback hardening, and on perfectly detecting every
async-feature trigger (a single miss re-introduces a multi-hundred substrate
regression). Cost/benefit is clearly negative.

**Conclusion.** The native Promise carrier and the host async-CPS substrate share
promise values across `await`/`.then`/return boundaries; partial activation mixes
representations. There is no call-site or module-level gate that yields a
worthwhile net-positive. **#2864/#2865 (async-fn + generator + async-generator
native `$Frame` substrate) is the explicit gated prerequisite** for landing the
`isStandalonePromiseActive` standalone flip. #2367 stays fully parked; do NOT
re-enqueue. This is a dedicated multi-window effort, not a now-task.
