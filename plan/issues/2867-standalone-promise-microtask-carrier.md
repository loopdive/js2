---
id: 2867
title: "Standalone: Promise / async microtask leaks Promise_resolve/reject/then + __make_callback host imports"
status: ready
created: 2026-06-30
updated: 2026-07-02
priority: high
feasibility: hard
model: fable
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

## Test plan

Standalone fail/CE → pass:

- `test/built-ins/Promise/**` (resolve/reject/then/finally/all/race/allSettled/any)
- `test/language/expressions/await/**`, `test/language/statements/async-function/**`

Full `merge_group` + standalone high-water. Sequence before async generators
(#2865 depends on this + #2864). Preserve the #2375 caution: Promise proto
value-read path must not collide with runtime async-capability state (the
null-deref noted in property-access.ts:736).

## Implementation notes — Gap 1 LANDED (recursive thenable assimilation), sendev-carrier 2026-06-30

This is the **carrier-completion track** (the blocking half of the standalone
async unlock). The async-frame **drive layer** (#2895 slices 1a–1c, PRs
#2393/#2394) is done and host-free-validated on `--target wasi`; the standalone
count-move is gated on completing the native `$Promise` carrier so the slice-1d
gate-widen (`isStandalonePromiseActive` + `isStandaloneThenChainNativeActive` →
`standalone`) stops regressing. sendev-asyncdrive's A/B/C isolation proved the
drive layer alone = 0 regression and the broad carrier widen = −16 (async-function 74) / −29 (150-sample cluster); the carrier gaps are the cause.

**Gap 1 of 5 — recursive thenable assimilation in native `.then`/`.catch`.** The
dominant regressor (e.g. `language/statements/async-function/returns-async-function.js`:
`.then(retFn => retFn())` must settle with the inner value `1`, not the promise
object). Two coupled fixes, BOTH gated on the native-`$Promise` carrier
(`isStandalonePromiseActive`, wasi-only today → widens to standalone in lockstep
at slice 1d), so the default gc/host lane **and** the still-host-backed standalone
lane are byte-unchanged (the −16/−29 guard's "gc-lane unchanged" requirement):

1. `src/codegen/async-scheduler.ts` — new `__promise_resolve_value(promise, value)`
   runtime helper implementing the spec "Resolve(promise, value)" step: if `value`
   is a native `$Promise`, the chained promise ADOPTS its eventual state
   (FULFILLED → enqueue identity-fulfill reaction with `inner.value`; REJECTED →
   identity-reject; PENDING → prepend a `$PromiseCallback` reaction onto
   `inner.callbacks`) via a `caps{callback:null, chained:promise}` capture;
   otherwise it fulfils directly (drop-in for `__promise_fulfill`). The `.then`/
   `.catch` **handler** wrappers and the identity-fulfill passthrough now settle
   through it; because identity-fulfill itself routes back through resolve-value,
   a chain of promises-returning-promises is assimilated **recursively**. Reject
   reasons are never assimilated (identity-reject stays a direct reject). FuncIdx
   reserved up-front (slot `base+4`) for late-shift safety.
2. `src/codegen/closures.ts` — root cause of the corruption: a NON-async closure
   whose return type is `Promise<T>` (a `.then` handler `v => Promise.resolve(...)`)
   had `resolveWasmType(Promise<T>)` unwrap it to `T` (f64), coercing the returned
   `$Promise` externref to **NaN inside the body** before the settle site ever saw
   it. Now, under the carrier, such a closure resolves to `externref` so the real
   `$Promise` reaches `__promise_resolve_value`.

**Verification** (`tests/issue-2867.test.ts`, host-free wasi, `__drain_microtasks`):
inferred + explicit-`Promise<number>`-annotated + recursive-pending-inner handler
returns all adopt (→ correct value, was NaN); plain non-promise chains unchanged.
gc + standalone lanes proven inert (carrier-gated; `ensurePromiseSettleFunctions`
unreached without the native `.then` path). Typecheck clean, valid Wasm. The
pre-existing `tests/promise-combinators.test.ts` 2-failures reproduce on clean
`upstream/main` (gc/host `Promise.race` runtime shim — not this change).

**Remaining carrier gaps (still deferred, each measured vs the −16/−29 guard before
the slice-1d widen):** 2 async-fn throw→reject routing · 3 try/finally-across-await
(drive-layer-coupled, #2895) · 4 `Promise.all`/`race`/`allSettled`/`any` native
combinators · 5 `for-await-of`/async-generator native drive (drive-layer-coupled).
Do NOT widen the carrier gates until all gap fixes land and the corpus measures
net-positive. Gaps 3 & 5 touch the #2895 drive layer (owned by sendev-asyncdrive)
— coordinate, don't fork.

## Implementation notes — Gap 2 LANDED (throw→reject routing) + the call-site observability prerequisite, sendev-carrier-gaps 2026-07-01

**Gap 2 of 5 — async-fn throw → reject routing**, plus a **foundational
prerequisite** that was NOT in the original gap roadmap but blocks ALL of them:
a drive-lowered async result (a real `$Promise`) was **not observable via
`.then` at all** (the landed #2895 drive layer was only validated via
side-effects + `await`, never `.then`). Without this, the test262
`asyncTest(fn)` harness — which does `fn().then(verifyFulfill, $DONE)`, inline
`.then` on the async call — can read nothing, so any gap-completion + widen would
score 0 (the AG0 trap). Three coupled, **carrier-gated** fixes (wasi-only today →
widen at slice 1d; gc/host + still-host-backed standalone lanes byte-unchanged):

1. `src/codegen/expressions.ts` — **call-site double-wrap (the prerequisite).**
   A genuinely-suspending async fn under the drive layer ALREADY returns a real
   `$Promise` (externref). The legacy call-site contract (#1313/#1727) still
   applied `wrapAsyncReturn` for a _thenable_ consumer (`f().then(...)`), wrapping
   the `$Promise` in a SECOND native `$Promise` (`wrapAsyncReturn`'s `struct.new`
   arm) → `.then`/assignment read **NaN / illegal-cast** (Promise-of-Promise).
   New predicate `calleeIsDriveLowered(ctx, expr)` (mirrors the
   `function-body.ts` drive gate exactly: carrier active + async `function`
   declaration + `asyncFnNeedsCps`) → skip the wrap, leave the `$Promise`
   un-wrapped. Verified: `f().then(onF)` now threads the settled value; was NaN.
2. `src/codegen/async-frame.ts` — **async-body throw / rejected-await → reject.**
   Wrapped the resume-fn dispatch in `try/catch $exn → __promise_reject(result, e)`
   (a `throw` in the body or a re-thrown rejected await now settles the result
   `$Promise` REJECTED instead of escaping uncaught → trap / stranded-pending).
   The continuation re-throws a microtask-delivered rejection (MODE_THROW +
   ERROR_FIELD, set by the reject step adapter); the entry's rejected-now arm
   arms MODE_THROW (was: delivered the reason as a fulfil value — the slice-1
   placeholder).
3. `src/codegen/async-scheduler.ts` — **throwing `.then`/`.catch` handler → reject
   chain.** `emitThenWrapperFunction` now runs the user handler inside
   `try/catch $exn → __promise_reject(chained, e)` (spec PerformPromiseThen reject
   step) instead of letting a handler throw escape the microtask wrapper uncaught
   (which trapped the whole `__drain_microtasks` pass).

**Verification** (`tests/issue-2867-gap2.test.ts`, host-free wasi, `__drain_microtasks`,
all green): drive result observable via inline `.then` (was NaN); throw-after-pending-await
rejects (→ reject handler gets the reason); rejected genuinely-pending await rejects;
throwing `.then` handler rejects the chain (was a trap); normal fulfilment still routes
to the fulfil handler. The existing #2867 Gap-1 + #2895 drive-layer suites stay green;
`tests/async-await.test.ts` (gc/host) + `issue-2671-promise-executor` stay green; typecheck clean.

**KNOWN-OUT-OF-SCOPE / flagged for the tech lead (architectural — do NOT churn):**

- **`const p = f(); p.then(...)` (and any `Promise<T>`-typed _binding/param/field_) still
  corrupts** — `resolveWasmType(Promise<T>)` unwraps to `T` (f64) at index.ts:12046
  ("async fns compiled synchronously"), which is false under the carrier; the inline
  `.then($DONE,$DONE)` harness path (Gap-2 fix) is unaffected, but stored-promise
  consumption needs a **broad `resolveWasmType(Promise<T>) → externref` decision under the
  carrier** with wide blast radius (every Promise-typed slot) — the #2367-graveyard class.
- **Pre-existing AG0 value-consumer regression** (`tests/issue-2865-...`: 2 fails — `let p =
Promise.resolve(7); return await p` consumed as `f() as number`): reproduces IDENTICALLY on
  the unmodified Gap-1 base. The #2895 drive layer makes `return await <var>` genuinely-suspend
  (returns a `$Promise`), which the `f() as number` _value_-consumer idiom can't unwrap
  host-free — a #2895/sendev-asyncdrive contract item, not introduced here.

Both feed slice 1d. **Gaps 3/4/5 + the runner-drain hook + the gate-widen remain**; the widen
stays blocked until the stored-`Promise<T>` consumption decision lands and the corpus measures
net-positive. Gap 2 is independently-mergeable and inert.

## Implementation notes — Gap 4 LANDED (native Promise.all / Promise.race combinators), sendev-carriergap4 2026-07-01

**Gap 4 of 5 — native, host-free `Promise.all` / `Promise.race`.** Today these
leak `Promise_all` / `Promise_race` host imports **even on the carrier target**
(`--target wasi`): `declarations.ts`'s aggregator pre-registration only skipped
`resolve`/`reject` for wasi, so every `Promise.all` module was unsatisfiable
host-free. This slice lowers the **array-literal** form
(`Promise.all([a, b])` / `Promise.race([a, b])`) directly onto the EXISTING
carrier substrate — it forks nothing:

- New `src/codegen/promise-combinators.ts`. `ensureCombinatorFunctions(ctx)`
  registers two small struct types — `$CombinatorState{ resultPromise, resultsArr,
length, remaining(mut) }` and `$CombinatorElemCaps{ state, index }` — plus four
  shared runtime helpers with funcIdx slots reserved up-front (the generator
  slot-reservation idiom, late-shift-safe): `__combinator_subscribe` (normalises an
  input to a `$Promise`, builds the per-element caps, and either enqueues an
  already-settled reaction or prepends a `$PromiseCallback` onto a pending input's
  callbacks list), `__combinator_all_fulfill` (writes `results[index]`, decrements
  `remaining`, and on 0 fulfils the result `$Promise` with the results vec),
  `__combinator_race_fulfill` (one-shot fulfil — first wins), and
  `__combinator_reject` (one-shot reject — shared by all & race). All reuse
  `ensureAsyncDriveRuntime` (Promise type, reaction node, microtask ring,
  `__promise_fulfill`/`__promise_reject`).
- `expressions/calls.ts` aggregator branch: under `isStandalonePromiseActive` +
  array-literal arg (no spread/elision) + non-subclass receiver →
  `emitStandalonePromiseCombinator`; everything else (generic iterables,
  `allSettled`/`any`, subclass capability-ctor receivers) falls through to the
  host path unchanged.
- `declarations.ts`: skip the `Promise_all`/`Promise_race` host-import
  pre-registration under the carrier (mirrors the resolve/reject wasi skip); the
  host path still lazily `ensureLateImport`s for the genuine non-native cases.

**Result array representation:** the fulfilled `Promise.all` value is an
externref vec (`getOrRegisterVecType("externref")`) — i.e. boxed elements, so the
natural consumer type is `any[]`. A `number[]`-typed `.then` handler casts the
fulfilled value to an f64-element vec and traps (`illegal cast`); that is the
expected representation contract, not a combinator bug (`any[]` access unboxes
correctly).

**Verification** (`tests/issue-2867-gap4.test.ts`, host-free wasi,
`__drain_microtasks`, all green): all-fulfil (correct values array), all-reject
(first rejection), `all([])` immediate fulfil, **genuinely-pending all** (inputs
settle only on a later microtask → aggregate suspends and resumes across the
drain — the case the host import cannot serve host-free), race-fulfil (first
wins), race-reject. **Inertness proven by byte-hash:** gc/host
(`691d10aac350c024`) and `--target standalone` (`43d3f001a1be11aa`) binaries are
**identical** base-vs-branch (both still host-route the combinators); only the
wasi carrier lane changes. Typecheck clean; the pre-existing
`tests/promise-combinators.test.ts` 2 gc/host `Promise.race` runtime-shim failures
reproduce on the unmodified base (documented in the Gap-1 note — not this change).

**Scope deferred (follow-ups within this gap):** `allSettled` (needs per-element
`{status,value}` status objects) and `any` (needs `AggregateError`) — both add
object/error construction coupling; and the **generic-iterable** argument form
(non-array-literal) which needs host-free `GetIterator` driving. These stay on
the host path and are inert.

**Remaining for the unlock:** Gap 3 (try/finally-across-await, drive-layer
coupled) · Gap 5 (for-await-of / async-generator drive, drive-layer coupled) ·
the runner `__drain_microtasks` hook (sr-pathb's 1d-scaffolding, in branch
`issue-2895-async-drive-1b`) · then the slice-1d gate-widen, measured
NET-POSITIVE on the full `merge_group` standalone corpus AFTER #2402 (the stored
`Promise<T>` consumption contract, now LANDED on main). Gap 4 is
independently-mergeable and inert.

## Landed slices (reconcile 2026-07-02)

Stays **in-progress**. Merged so far:

- **Gap 1** — recursive thenable assimilation (PR #2400).
- **Gap 2** — async throw→reject routing + drive-result `.then` observability
  (PR #2401).
- **Gap 3** — try/finally-across-await: LANDED under **#2906 slice 2**
  (PR #2416, on the N-state resume machine) — the "Remaining for the unlock"
  list above predates it.
- **Gap 4** — native `Promise.all` / `Promise.race` combinators (PR #2403).
- Related hardening: native `Promise.then`/`.all` funcIdx-shift desync fix
  (PR #2419, filed as #2918); `__drain_microtasks` runner hook landed via #2895
  (PR #2404).

**Still open:** Gap 5 (for-await-of / async-generator drive — #2906 slices 3/4)
and the measured slice-1d gate-widen (`isStandalonePromiseActive` +
`isStandaloneThenChainNativeActive` → standalone), plus the deferred
`allSettled`/`any`/generic-iterable follow-ups above.
