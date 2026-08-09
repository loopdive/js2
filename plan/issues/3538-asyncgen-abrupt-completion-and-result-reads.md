---
id: 3538
title: "Async-gen abrupt completion + IteratorResult dynamic reads — the 280-test yield*-error cohort (F2 harvest, #3417/#3178)"
status: done
assignee: ttraenkler/fable-3417
sprint: 75
priority: high
horizon: m
feasibility: hard
task_type: bugfix
area: codegen, standalone, async
language_feature: async-generators, destructuring
goal: standalone-mode
parents: [3178]
related: [3417, 3388, 3389, 2906, 2979, 3050, 2674, 3469]
created: 2026-07-23
completed: 2026-07-23
# (#3102) Intended in-subsystem growth: the abrupt-completion machinery belongs
# in the async frame module (new synthetic dispatch arm + catch completion),
# and the done/value destructure routing belongs in the destructure module.
loc-budget-allow:
  - src/codegen/async-frame.ts
  - src/codegen/destructuring-params.ts
---

# #3538 — async-gen abrupt completion + IteratorResult dynamic reads

## Problem (measured, verify-first)

The single biggest honest-FAIL bucket in the F2 newly-scored standalone async
cohort (#3417): **280 tests**, ONE error string
(`Test262:AsyncTestFailure:Test262Error: TypeError: value is not iterable`),
35 procedurally-generated `yield-star-{getiter,next}-*` templates × 8 contexts
(async-gen expr/named + 6 class async-gen method variants). §27.6.3.7 error
SEMANTICS were already correct (#3388 landed them — the first `next()` rejects
with a proper TypeError); the cohort failed on what happens NEXT.

## Root causes (three, coupled — all measured on minimal probes)

1. **Uncaught throw did not COMPLETE the generator.** The resume machine's
   outer `catch $exn` rejected the current `next()` promise but left
   `frame.STATE` at the throwing state — a second `next()` re-drove the same
   failing step (or, worse, ran the statement AFTER the `yield*`, since the
   rtDelegate init pre-plans the continuation). §27.6.3.5 step 4.f–g: a throw
   completion sets [[AsyncGeneratorState]] = "completed"; the subsequent
   `next()` must fulfil `{value: undefined, done: true}`.
2. **No leads-free completion target existed.** The obvious target,
   `settleDoneStateId` (what the #3389 `.return()`/`.throw()` drivers point
   at), is a REAL CFG state that carries any trailing body statements after
   the last yield as leads — dispatching there RE-EXECUTES body code (probed:
   `yield* obj; throw new Error("TRAILING-RAN")` — the trailing throw ran on
   the second `next()`). This was also a latent #3389 bug.
3. **`{done, value}` destructure off a native IteratorResult read
   undefined/undefined.** The test templates' verification shape is
   `iter.next().then(({ done, value }) => { assert.sameValue(done, true);
   assert.sameValue(value, undefined); })`. The destructure-param path reads
   props via raw `__extern_get`, which only understands `$Object` receivers —
   the native `__NativeGeneratorResult_externref` struct missed → both
   bindings undefined. Additionally the done-result's `value` field held a
   null externref, which under the S1 undefined-singleton regime reads back
   as JS *null*, failing `sameValue(value, undefined)`.

## Fix (src, three parts — composing existing substrate, no new machinery)

- **`src/codegen/async-frame.ts`**
  - New synthetic **COMPLETED pseudo-state** (`info.completedStateId ==
    cfg.states.length`, one past the dense real ids; async-gen only): its
    dispatch arm — appended at `buildStateArm`'s base case — fulfils
    `{value: undefined, done: true}` and runs NO leads.
  - The outer `catch $exn` now also re-points `frame.STATE` at the COMPLETED
    arm (async-gen only; plain async functions byte-identical — no re-entry
    exists for them).
  - The #3389 `.return()`/`.throw()` drivers complete via
    `completedStateId ?? settleDoneStateId` — fixing their latent
    trailing-leads re-execution.
  - `settleDone` (and the COMPLETED arm) store the **canonical undefined
    singleton** in the result's `value` field (S1 regime; legacy keeps the
    null extern byte-identical) — `sameValue(result.value, undefined)` holds.
- **`src/codegen/destructuring-params.ts`**: object-pattern param elements
  named `done`/`value` route their read through the finalize-filled
  `__get_member_<name>` dispatcher (#2674) instead of raw `__extern_get`. The
  dispatcher already handles the gen-result structs (boolean-branded `done`
  via `__box_boolean` #3050, sentinel-aware f64 `value` #2979) and falls back
  to `__extern_get` for every non-struct receiver — identical semantics
  there. Finalize-fill also solves compile-order (a destructure site compiled
  before the generator registers its result type still gets the arm). Other
  keys keep the raw read (minimal dispatch surface — widen only with corpus
  evidence).
- **`src/codegen/shared.ts` + `member-get-dispatch.ts`**: late-bound
  `reserveMemberGetDispatchLate` delegate (a static import of
  member-get-dispatch.ts from destructuring-params.ts is an eval-time module
  cycle — `COLLECTION_KIND` TDZ ReferenceError).

## Test-expectation update (rep change, not a regression)

`tests/issue-3388-asyncgen-yieldstar-rtdelegate.test.ts`: the done-result
`value` read through the f64 probe (`__async_gen_result_value`) now reports
`ToNumber(undefined) = NaN` instead of `0` (the old null-extern rep) — the
same convention the #2979 sentinel producer established. 4 expectations
updated.

## Validation (measured)

- Minimal probes: first `next()` rejects TypeError (ctor identity holds);
  second fulfils `{done: true, value: undefined}`; trailing body statement
  after `yield*` does NOT run.
- Real corpus: **70/70 PASS** on a stride-4 sample of the 280-file cohort
  (all 8 contexts, via `assembleOriginalHarness` + standalone compile +
  zero-import instantiate + drain + sink readout — the #3469 channel).
- Scoped suites green: issue-3388 (updated), 3389 ×2, 3469 sink, 2906
  producer/consumer/3a/3b/multiawait, 3132 (×3), 3228, 2169/2158/2512/2545/
  2567/rest-in-rest destructuring (34 tests), `tests/equivalence/`.
- Pre-existing failures on clean main (control-verified, NOT this change):
  issue-2865 WASI (2), issue-3132-s2 mixed-module (1), issue-2906-gap3
  try/finally (3).
- `tsc --noEmit` clean; change-scoped `check:loc-budget` passes via the
  frontmatter allowance above (in-subsystem growth).

## Downstream notes

- The residual `{done:1, value:...}` READ of a done result through the f64
  probe is NaN by design; consumers must check `done` first (they do).
- Member-access reads `r.done` on an UNTYPED receiver still route to the
  legacy `__gen_result_*` HOST imports in standalone (a separate, pre-existing
  `host_import_leak` cohort — NOT addressed here; candidate follow-up:
  property-access should prefer the #2674 dispatcher the way destructure now
  does).
- Sync-generator STATIC typed reads still surface `done` as 0/1 i32 and
  exhausted `value` as NaN through TYPED locals (pre-existing, separate from
  the dynamic path fixed here).
