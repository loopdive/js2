---
id: 2895
title: "Standalone: genuinely-pending await needs true frame suspension (AG1 / PATH B) — await-on-$Frame + microtask resume"
status: ready
model: fable
created: 2026-06-30
updated: 2026-07-08
priority: medium
feasibility: hard
task_type: feature
area: codegen
goal: standalone
sprint: current
horizon: xl
related: [2864, 2865, 2867, 2367]
umbrella: 2860
architect_spec: authored
depends_on: [2865]
---

# Standalone: true async-frame suspension for genuinely-pending awaits (PATH B)

## Context

#2865 AG0 (PATH A) shipped the host-free **synchronous-settlement** subset:
under `--target standalone`/WASI, `await` now unwraps one level of the native
`$Promise` carrier (`expressions.ts` `emitStandaloneAwaitUnwrap`) and
`isStandalonePromiseActive` covers `ctx.standalone`, so `await Promise.resolve(x)`,
`await <literal>`, and `await <a sync-fulfilled promise>` run host-free with
correct values (no NaN). Async functions are still compiled **synchronously**
(the CPS state machine is gated off for standalone/WASI in `function-body.ts`).

## Problem (what AG0 does NOT cover)

A **genuinely-pending** await — a promise that only settles on a _later_
microtask/timer (executor that resolves async, `await fetch()`-style I/O,
`Promise.all` of pending promises, `.then` chains observed synchronously) —
cannot be served by one-level unwrap: the value is not present during the
synchronous body execution. AG0 returns the pending `$Promise.value` (null /
stale) for these. They were already wrong pre-AG0, so AG0 is not a regression,
but it does not fix them.

## Root cause / design (PATH B)

Build a real resumable async frame, host-free:

- Extend the #2864 `$Frame` br_table state machine with `await` as an additional
  **suspend-kind** (the AG2 "await-on-`$Frame` convergence"): at an await,
  spill live locals, register a reaction (continuation funcref + frame capture)
  on the awaited `$Promise`'s reaction list, and return the result `$Promise`.
- Rewrite `async-cps.ts` to consume/produce the **native** `$Promise` + the
  existing microtask ring (`async-scheduler.ts`) instead of the host
  `Promise_resolve`/`Promise_then2`/`__make_callback` imports.
- Microtask drain resumes the frame at the saved state with the settled value.
- Async functions then return real `$Promise`s even under standalone.

Reconcile the two existing substrates: the wasi/standalone-gated `$Frame`
(`generators-native.ts`) and the microtask/Promise machinery
(`async-scheduler.ts`, which today has no async-function frame driver).

## Architect spec

arch-asyncgen authored an AG0–AG5 spec that landed on a side branch (not main):
**`origin/async-gen-2865-spec`**. Pull the design from there (or re-spec)
before implementing PATH B.

## Test plan

- `test/language/expressions/await/**`, `test/language/statements/async-function/**`
  (the pending-await shapes AG0 leaves wrong).
- `test/built-ins/Promise/**` `.then`/`all`/`race` observed across a microtask.
- Full `merge_group` + standalone high-water. Sequence after #2865 AG0 (landed).

Also unblocks #2367 (native Promise carrier) and feeds #2865 (async generators).

## Implementation Plan (PATH B — grounded spec, sendev-flatten 2026-06-30)

Grounded against current `main` (incl. #2384 frame-core) + verified by the #2865
AG0 reconcile measurement. **THE async unlock**: every standalone async gain —
the host-free await win AND the ~986 async cluster — gates on this drive layer.
A bounded gate flip cannot bank it (proven: see #2865 AG0 note — the broad
`isStandalonePromiseActive=standalone` netted −31 because the `flags:[async]`
test262 harness can't drain a native async result without this layer).

### Why a drive layer is mandatory (root cause, measured)

The `flags:[async]` harness (`tests/test262-runner.ts` `asyncTest(fn)`) calls
`fn()` then `$DONE()` **synchronously, with no microtask drain**, and observes
`test()`'s return. So for standalone async to be _observable_ it must EITHER (a)
settle synchronously into a value the harness reads, OR (b) the harness must
drain microtasks after `test()`. PATH B does both: async fns return a real
`$Promise`, AND the runner drains `__drain_microtasks` for `flags:[async]`
standalone tests before reading the settle result. **The runner-drain hook is a
required deliverable of slice 1** (without it even a correct drive layer scores
0 on the harness — that is the trap AG0 fell into).

### Reuse (do NOT fork the substrate)

- **`frame-core.ts`** — the `$AsyncFrame` state struct satisfies `FrameLayout`:
  `STATE_FIELD`(0,i32 br_table selector), `SENT_FIELD`(1, the settled awaited
  value delivered on resume), `MODE_FIELD`(2), `ABRUPT_FIELD`(3),
  `ERROR_FIELD`(4, rejection reason), params at `PARAM_FIELD_OFFSET`(5), then
  live-across-await spills. Use `storeSpills` / `setStateInstrs` /
  `setStateFieldFromLocal` / `defaultSpillInstr` verbatim.
- **`async-scheduler.ts`** — `getOrRegisterPromiseType` ($Promise = {0:state i32,
  1:value externref, 2:callbacks externref linked-list of `$PromiseCallback`});
`PROMISE*STATE*{PENDING,FULFILLED,REJECTED}`; the microtask ring
(`**microtask_enqueue(funcref,externref,externref)`/`**drain_microtasks`);
  the existing settle+callback-drain sequence (~L821-872). Reuse the settle path.
- **`generators-native.ts` `ensureNativeGeneratorResumeFunction` (L1781)** — the
  br_table resume-fn builder PATH B mirrors: placeholder-slot reservation BEFORE
  body emit (funcIdx stability — late-import-shift class #1677/#1809/#1899),
  param+spill load from struct into locals, br_table over `STATE_FIELD`.

### Slice 1 — ONE genuinely-pending await in a plain async fn, host-free

1. **`$AsyncFrame` builder** (new `async-frame.ts`, mirrors generator
   `buildResumeInfo`): per-async-fn state struct (FrameLayout) + an
   `AsyncFrameInfo` carrying `stateTypeIdx`, `resumeFuncIdx`, spill metadata,
   and the result-`$Promise` field index.
2. **`__async_resume_f<name>(frame) -> void`** (mirror `ensureNativeGenerator­
ResumeFunction`): reserve slot first; load params+spills; **br_table over
   `STATE_FIELD`** to each continuation. Segment 0 = entry. Each segment runs to
   the next await or to completion.
3. **await-suspend lowering** (replaces the AG0 one-level unwrap when
   `isAsyncDriveActive(ctx)` — a NEW predicate, standalone||wasi):
   `assimilate(operand)` → if `ref.test ($Promise)` and state==PENDING:
   `storeSpills` + `setState(resumeIdx)` + register a reaction
   (`__async_step_f` funcref + this frame) onto the promise's callbacks list +
   `return`. If already FULFILLED: read `value`, jump to continuation inline
   (fast path). If REJECTED: set MODE_THROW + ERROR_FIELD, branch to throw path.
4. **`__async_step_f(frame, settledValue)`** microtask adapter: store
   `settledValue` into `SENT_FIELD`, call `__async_resume_f<name>(frame)`. This
   is the funcref enqueued on the microtask ring / promise reaction.
5. **settle-on-completion**: at async-fn `return v`, settle the frame's result
   `$Promise` FULFILLED+`v` and drain its callbacks (reuse async-scheduler
   settle). At `throw e`, settle REJECTED+`e`.
6. **call-site**: `f()` allocs the `$AsyncFrame` (params spilled into fields),
   creates the pending result `$Promise`, calls `__async_resume_f<name>` once
   (runs segment 0 until first real suspension), returns the result `$Promise`.
7. **runner drain hook** (`tests/test262-runner.ts`): for `flags:[async]`
   standalone/wasi tests, after `test()` call the module's `__drain_microtasks`
   export (already emitted by async-scheduler) before reading the settle. REQUIRED
   for any harness credit.
8. **re-widen the gates**: `isStandalonePromiseActive` and
   `isStandaloneThenChainNativeActive` (both `ctx.wasi`-only after the #2865 AG0
   reconcile) widen to include `ctx.standalone` ONLY once 1-7 land and the drive
   layer makes results observable — flip them together, never piecemeal (the
   piecemeal flip is exactly the AG0 −31).

### Verify-first discipline (NON-NEGOTIABLE — the AG0/−601/−2469 lesson)

- Build on CURRENT `main` (incl. #2384). Merge `upstream/main` first.
- Measure with the corpus `wrapTest`/`runTest262File(...,"standalone")` on REAL
  failing test262 paths (async-function/dstr, class async methods,
  `Promise.all().then` chains, async-generator/dstr) — NOT synthetic snippets.
- Compare merged-HEAD vs `upstream/main` baseline per-file (the harness in
  `.tmp/probe-perfile.mts` from the AG0 reconcile is a ready template): require
  **NET-POSITIVE**, gc-lane unchanged, and the full `merge_group` standalone
  report net-positive (the authoritative gate). Commit incrementally.
- Slice 1 acceptance: a plain async fn with ONE genuinely-pending await
  (executor that resolves on a later microtask) compiles `--target standalone`
  host-free (`result.imports` empty), resumes via the drive layer, and the
  harness (with the drain hook) reads the correct settled value.

### Sizing

`horizon: xl`. Slices 1-8 above; slice 1 is the minimal end-to-end. Start at a
FRESH budget window (a full per-agent share) — do not begin late in a draining
window (the XL would strand at the freeze). PR1 (#2384 frame-core) and the #2865
AG0 reconcile (PR #2380) are the landed predecessors.

## Implementation notes — PATH B build log (sendev-asyncdrive)

Building PATH B incrementally on `origin/main` (post-#2380 AG0 reconcile, which
landed: `isStandalonePromiseActive` + `isStandaloneThenChainNativeActive` are
`wasi`-only, `emitStandaloneAwaitUnwrap` is the AG0 one-level unwrap). Each
sub-slice is a separate, independently-mergeable PR; the broad carrier-gate
re-widen (1d) is LAST, only after the drive layer is measured net-positive (a
premature widen is the AG0 −31 regression — do NOT repeat it).

### Slice 1a — frame-layout foundation (THIS PR, inert / zero-risk)

- `src/codegen/async-frame.ts` (new): `isAsyncDriveActive(ctx)` (standalone||wasi
  drive-layer gate, distinct from the `isStandalonePromiseActive` _carrier_
  gate), `AsyncFrameInfo` (satisfies frame-core `FrameLayout`), and
  `buildAsyncFrameInfo(...)` which registers the per-async-fn `$AsyncFrame_<name>`
  state struct: fixed frame ABI fields (`STATE` i32, `SENT`/`ABRUPT`/`ERROR`
  externref — awaited values are always boxed, unlike a numeric generator
  carrier, `MODE` i32), captured params at `PARAM_FIELD_OFFSET`, live-across-await
  spills (computed from `analyzeAsyncBody` liveness minus params minus the
  resume binding — mirrors the generator `bodySpills`), then a trailing
  `result_promise` field (after spills so `spillFieldOffset` is stable, same
  discipline as generator `yield*` delegation slots).
- `src/codegen/async-scheduler.ts`: added public accessors
  `getOrRegisterPromiseCallbackTypeIdx` + `ensureAsyncDriveRuntime` (returns the
  stable `$Promise`/reaction-node typeIdxs and the settle/enqueue/drain funcIdxs)
  so the frame driver reuses the EXISTING Promise+microtask substrate verbatim
  rather than forking a parallel scheduler.
- `tests/issue-2895-async-frame.test.ts`: pins the gate + the `$AsyncFrame`
  struct ABI (5 leading frame fields, param field, spill of a live body local
  excluding param/resume-binding, trailing `(ref $Promise)`).
- **Inert**: nothing in the live compile path imports `async-frame.ts` yet, so
  output is byte-identical (the #2384 frame-core extraction pattern). No gate
  flip, no regression surface.

### Remaining slices (next sessions, build order)

1b. **resume fn + step adapters + settle** — `ensureAsyncResumeFunction(info)`
builds `__async_resume_f<name>(frame)` with the generator slot-reservation
funcIdx-stability idiom (reserve placeholder slot BEFORE body emit). For the
single-await canonical shape it is a 2-state machine: `br_table` over
`STATE_FIELD` → seg0 (entry: prefix + awaited-expr assimilate → if FULFILLED
set SENT and fall through, else `storeSpills` + set STATE=1 + register a
`$PromiseCallback{__async_step_fulfill_f<name>, frame, __async_step_reject_f
    <name>, frame, next}` reaction on the awaited promise's callbacks + `return`)
→ seg1 (continuation: bind `x = SENT`, suffix). `__async_step_*` adapters
store the settled value into `SENT`/`ERROR` then call resume. `return v` in
a resume body settles `frame.result_promise` via `__promise_fulfill` (new
`compileReturnStatement` hook keyed off a `fctx.asyncDriveResultLocal`,
mirroring the `fctx.isGenerator` arm); `throw e` → `__promise_reject`.
1c. **wire live + call-site + runner drain hook** — in `function-body.ts`, when
`isAsyncDriveActive(ctx) && asyncFnNeedsCps(...)`, alloc the frame (params
spilled), create the pending result `$Promise`, call `__async_resume_f` once
(runs seg0 to first real suspension), return the result promise. **Runner
drain hook** (`tests/test262-runner.ts`): for `flags:[async]`
standalone/wasi tests, drain `__drain_microtasks` after `test()` runs and
before reading `__fail` — REQUIRED for any harness credit (the trap AG0 fell
into). Verify-first on REAL failing test262 async paths (async-function/dstr,
class async methods, `Promise.all().then` chains, async-generator/dstr) via
the corpus `wrapTest`/`runTest262File(...,"standalone")`; require
NET-POSITIVE on the full `merge_group` standalone report.
1d. **re-widen carrier gates** — flip `isStandalonePromiseActive` +
`isStandaloneThenChainNativeActive` to include `ctx.standalone` TOGETHER,
only after 1c proves net-positive.

### Slice 1b/1c — resume fn + live wiring (LANDED + VALIDATED on wasi)

Built and validated the host-free drive layer end-to-end on the native-`$Promise`
carrier target (`--target wasi`, where the carrier gate is already on; the
`--target standalone` re-widen is slice 1d):

- `async-frame.ts`: `ensureAsyncResumeFunction` (2-state resume fn — `if(state==0)`
  entry → assimilate awaited `$Promise`, FULFILLED → deliver `SENT` + fall
  through, PENDING → `storeSpills` + STATE=1 + register a `$PromiseCallback`
  reaction + `return`; continuation reads `SENT`), `__async_step_f<name>_{fulfill,
reject}` microtask adapters, and `emitAsyncFrameStateMachine` call-site shim
  (alloc frame + pending result `$Promise`, kick resume once, return the promise).
  Uses the generator slot-reservation funcIdx-stability idiom.
- `function-body.ts`: wires it for `isStandalonePromiseActive(ctx) && asyncFnNeedsCps`
  — gating on the **carrier** predicate so 1d's standalone widen flips carrier +
  drive layer **together** (AG0-safe). The JS-host CPS branch is preserved.
- `control-flow.ts`: `return v` in a resume body settles `result_promise` via
  `__promise_fulfill` (keyed off `fctx.asyncDriveReturn`, mirrors the generator arm).

**Validated** (`tests/issue-2895-async-frame.test.ts`, all green, host-free —
`result.imports` empty, `WebAssembly.validate` true):

- FULFILLED fast path: `await g()` (sync-settled async fn) delivers the value.
- chained drive-lowered async fns thread the value through both frames.
- **GENUINELY-PENDING**: `await Promise.resolve(1).then(cb)` (pending until the
  microtask runs `cb`) SUSPENDS (continuation not run), and `__drain_microtasks`
  resumes the frame to deliver the settled value — the exact case AG0 cannot serve.

**Codegen lesson banked**: repeated `local.get <externref>; any.convert_extern;
ref.cast $T` confuses the `stack-balance` type-repair pass (it splices a bogus
`ref.cast_null; any.convert_extern`). Narrow the awaited `$Promise` into a single
typed `(ref $Promise)` local once and reuse it.

Remaining: **1d** — widen `isStandalonePromiseActive`/`isStandaloneThenChainNativeActive`
to `standalone` + the runner `__drain_microtasks` hook for `flags:[async]` tests,
measured NET-POSITIVE on the full `merge_group` standalone report.

### Slice 1d-scaffolding — `__drain_microtasks` intrinsic + runner hook (LANDED, inert)

sendev-carriergap4 2026-07-01. Rescued from the dormant `issue-2895-async-drive-1b`
branch and shipped as its own small inert PR (de-risks the eventual 1d widen
measurement — without a drain the `flags:[async]` harness can't observe a
genuinely-pending async result, the AG0 score-0 trap):

- `src/codegen/expressions.ts`: a `__drain_microtasks()` **compiler intrinsic** —
  under the native-`$Promise` carrier (`isStandalonePromiseActive`, wasi-only
  today) it lowers to the existing native `emitDrainMicrotasks`; on the gc/host
  lane (no native microtask ring) and `--target standalone` (carrier not yet
  widened) it is a **void no-op**, so those lanes stay byte-identical.
- `tests/test262-runner.ts`: for `flags:[async]` / `needsAsyncTest` tests, declare
  `__drain_microtasks` and call it after `test()` runs and before reading `__fail`.
  Inert on the measured (gc + standalone) lanes — the intrinsic emits nothing
  there; it only fires once 1d widens the carrier to standalone.

Verified (`tests/issue-2895-drain-hook.test.ts`): an in-source `__drain_microtasks()`
under wasi resumes a genuinely-pending continuation (→ 41); host-free
(`result.imports` empty); a `--target standalone` `__drain_microtasks()` is a
host-free void no-op. Existing carrier suites (`issue-2867-gap2`,
`issue-2895-async-frame`, `async-await`) stay green; typecheck clean.

**The slice-1d widen itself stays blocked** — it gates on the general multi-state
CFG-aware CPS resume machine (Gaps 3/5 = try/finally-across-await + for-await/
async-gen, which the single-await `splitBodyAtAwait` cannot express; tracked as a
new XL substrate issue) landing AND the full `merge_group` standalone corpus
measuring net-positive.


## Reconciliation note (shepherd, 2026-07-01; extended 2026-07-02)

Landed slices: the **resumable-frame core extraction** (PR #2384 — PR1, byte-identical for generators), **slice 1a** frame-layout foundation (PR #2393), **slices 1b/1c** host-free async resume fn + live wiring (PR #2394 — genuinely-pending await suspends & resumes), and the **`__drain_microtasks` intrinsic + test262 runner hook** (PR #2404 — 1d scaffolding, inert). Issue stays `in-progress` for the remaining PATH B work (the measured slice-1d carrier gate-widen; the general multi-state machine continues under #2906, slices 1+2 of which landed as PRs #2413/#2416).
