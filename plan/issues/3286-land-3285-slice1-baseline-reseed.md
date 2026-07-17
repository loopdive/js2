---
id: 3286
title: "Land #3285 slice-1 (PR #3104) — oracle-version bump alone doesn't clear the #3086 auto-rebase gate for wasm-changing verdict flips"
status: done
completed: 2026-07-17
assignee: ttraenkler/fable-s2
sprint: current
created: 2026-07-15
priority: high
feasibility: medium
model: opus
horizon: m
reasoning_effort: high
task_type: ci-infra
area: test-infrastructure
goal: test-infrastructure
related: [3285, 3287]
---

# #3286 — land #3285 slice-1 despite the CI-flagged "regression"

## Sequencing note — check this before choosing a landing path (added 2026-07-15)

**[[3287]] may make this issue's lever-dance path unnecessary or much
cheaper.** The ~2664 flips this issue is about are pass→fail because the
compiler currently throws the _wrong_ error type for those tests (#3287's
subject). If #3287's fixes land on `main` **before** PR #3104's harness
tightening does, every test #3287 fixed would already throw the correct
type — so tightening the check produces `pass→pass` (no flip) for those,
not `pass→fail`. The residual flip count (whatever #3287 doesn't cover) is
what actually needs a landing path here, and it may fall under
`ORACLE_REBASE_DRIFT_TOLERANCE` (25) / the per-bucket-50 limit / the #1668
catastrophic guard (200) without any lever-raising at all — turning this
into a normal PR.

**Before starting options A/B/C below**: rebase PR #3104 on current `main`,
re-run the regression diff, and check the residual flip count. Only reach
for the lever dance if a real residual remains after #3287's progress is
accounted for.

**Answered 2026-07-16 (see "Update" section below): a real residual of 2615
remains — #3287 barely dented the cluster (~2% reduction from ~2664-2668).
The lever dance is still required in full; this did not become a normal PR.**

## Update 2026-07-16 — residual measured post-#3287, lever dance still required

Merged post-#3287 `origin/main` (PR #3106 landed, commit `11800e99e66f9a`)
into PR #3104's branch (`issue-3285-assert-throws-error-type`, clean
merge, no conflicts). Ran the full local test262 suite (`pnpm run
test:262`, `COMPILER_POOL_SIZE=4`, include-proposals scope, 48088 common
tests) and diffed candidate (oracle v4) against the freshly-fetched
authoritative baseline (oracle v3, `loopdive/js2wasm-baselines`) via
`scripts/diff-test262.ts` with `ORACLE_REBASE=1` (forward-bump rebase
mode):

- **Residual non-excused wasm-change regressions: 2615** (pass 34348 →
  31733). This is only ~2-4% below the originally-estimated 2664-2668
  cluster — #3287's fixes closed a small slice (~49-53 tests) but left the
  overwhelming majority of the reclassification untouched.
- Still fails all three independent gates by a wide margin:
  - `regressionsWasmChange` 2615 ≫ `ORACLE_REBASE_DRIFT_TOLERANCE` (25).
  - Per-bucket concentration: `class/dstr` 168, `statements/class/dstr`
    168, `Temporal/ZonedDateTime/prototype` 115,
    `Temporal/PlainDateTime/prototype` 94, `object/dstr` 84,
    `Temporal/PlainDate/prototype` 73, `Temporal/PlainYearMonth/prototype`
    63, `Temporal/Instant/prototype` 59, `async-generator/dstr` 56,
    `Temporal/Duration/prototype` 52 — all still far over the 50-test
    limit, matching the buckets already documented above (168, 63-115, 84,
    56), confirming this is the same cluster, not a new one.
  - #1668 catastrophic guard (200) — 2615 is still ~13x over.
- Also observed (pre-existing on `main`, unrelated to #3104 — carried in
  via the merge, do not attribute to this PR): the #3189 uncatchable-trap
  ratchet flagged `oob` trap category growing 48→53 (+5) on `main` itself.
  Flagging for whoever owns that ratchet; out of scope here.
- **Conclusion: option (A)/(B)/(C) from the landing-path list below is
  still required as originally scoped — this did NOT get cheaper via
  #3287 and does NOT reduce to a normal PR under existing thresholds.** No
  landing action taken (measure-only per this task's scope); PR #3104
  remains `hold`-labeled, untouched, `mergeState=CLEAN`.

## Context

PR #3104 implements #3285 slice 1 (`transformAssertThrows` now threads the
expected error type through — `assert.throws(TypeError, fn)` compiles to a
real `e instanceof ErrorCtor` / name-fallback check instead of "did anything
throw"). The fix is validated correct: matcher sound across in-module/host/
subclass/`Test262Error` cases, 0 false-negatives in scoped batches. The
~2664-2668 test flips are legitimate false-positive corrections (previously-
inflated passes becoming honest fails) — exactly what #3285's own acceptance
criteria anticipated ("a drop is expected and correct... report the delta
rather than treating it as a regression").

The PR is currently `hold`-parked by `auto-park-bot` and **cannot land as-is**
— not because the fix is wrong, but because the CI landing mechanism has no
path for this specific shape of intentional reclassification.

## The blocking mechanism (verified empirically by two independent agents)

The `assert_throws`/`assert_throwsAsync` synthetic shims live in
`buildPreamble()` (`tests/test262-runner.ts`), which is compiled **into**
each test's wasm module. Tightening the shim's verdict logic therefore also
changes every affected test's `wasm_sha` — so all ~2664 flips register as
**wasm-CHANGE** regressions, not same-wasm oracle-skew.

`ORACLE_VERSION` was bumped 3→4 on the branch (necessary per
[[reference_verdict_logic_change_must_bump_oracle_version.md]]) — but this
alone is **not sufficient**. `scripts/diff-test262.ts`'s forward-bump
"rebase mode" only excuses flips carrying a `vacuous`/`vacuousReclassification`
marker (this is what let #3086 v2 land 1438 flips on a bare bump). #3285's
flips are plain `assertion_fail`/`type_error`, not vacuity-marked, so they
hit three independent gates:

- `regressionsWasmChange > ORACLE_REBASE_DRIFT_TOLERANCE` (25,
  `diff-test262.ts:1040`) — empirically confirmed: a 100-flip probe at
  oracle 3→4 produced `GATE FAIL: re-baseline residual 100 non-excused
wasm-change regressions exceeds drift tolerance 25 (#3086)`, exit 1. The
  real flip count (2664-2668) is far larger.
- Per-bucket concentration check (>50 in a single bucket — class/dstr 168,
  Temporal prototypes 63-115, object/dstr 84, async-generator/dstr 56).
- The #1668 catastrophic guard (threshold 200), which **also runs on every
  push to `main`** and gates the `promote-baseline` job independently of the
  PR-level `merge_group` check — so admin-merging past the PR-level gate
  does not help either (see PR #3104 comment thread for the full writeup;
  admin-merge would strand the baseline and wedge the queue for every
  subsequent test262-touching PR, which is strictly worse than the current
  single held PR).

## Landing-path options (as escalated on the PR, unresolved by design this window)

- **(A) Maintainer `force_baseline_refresh` workflow_dispatch at oracle v4** —
  re-seeds the committed baseline directly rather than going through the
  normal diff-and-promote path. Cleanest if this workflow input exists and
  is safe to invoke mid-queue; needs verifying it doesn't require the same
  catastrophic-guard clearance internally.
- **(B) Temporarily raise `ORACLE_REBASE_DRIFT_TOLERANCE`, the #1668
  catastrophic-guard threshold, and the per-bucket-50 limit** high enough to
  let the 2668 flips through `merge_group` and `promote-baseline`, land, let
  `promote-baseline` re-seed host+standalone baselines at v4, then **revert
  the levers in a follow-up PR**. This is the "-439 landing" dance — shared-
  system risk (weakens the regression guard for every other in-flight PR
  during the window) and needs to be driven end-to-end by whoever owns it,
  including the revert step.
- **(C) Add an excusing marker** (mirroring #3086's `vacuous` tag) for this
  class of "assertion tightened, wrong-error-type flips from correct to
  incorrect" reclassification, so future verdict-logic changes of this shape
  don't need the lever dance at all. Proper fix, bigger scope than slice 1 —
  likely the right long-term answer given #3285 has two more slices (fixes
  #2 and #3) coming that will hit the exact same wall.

No option was executed this window — deferred solely due to insufficient
remaining budget to safely drive a multi-step, queue-wide-risk operation
end-to-end, not due to any doubt about the fix's correctness.

## Related follow-up (not in scope here, don't fold in)

The dedicated #3003 gate (`scripts/check-verdict-oracle-bump.mjs`) that's
supposed to flag any verdict-logic change missing an oracle bump did **not**
fire for PR #3104 — its `VERDICT_SIGNAL_RE` matches `status:`-literal
assignments but not runtime type-check logic inside a shim body (where
#3104's actual verdict change lives). Worth its own issue; flagged here so
it isn't lost, but fixing the gate doesn't unblock this landing.

## Acceptance criteria

- PR #3104 merges to `main` via one of the options above (or a variant),
  with `promote-baseline` succeeding and the committed baseline
  (`benchmarks/results/test262-current.json` +
  `loopdive/js2wasm-baselines` jsonl) correctly reflecting oracle v4.
- Any temporarily-raised guard/tolerance is reverted in a follow-up commit
  once the re-seed is confirmed — the queue must not be left with a
  permanently weakened catastrophic guard.
- No subsequent PR gets spuriously auto-parked against stale-baseline drift
  from this landing (spot-check the next few merge_group runs after landing).
- #3285 slices 2 and 3 (`stripUndefinedAssert`, full `strip*` inventory) are
  reassessed against whichever landing mechanism worked here, since they are
  the same shape of change and will hit the same wall.

## Resolution — verified landed (2026-07-17, fable-s2)

**PR #3104 is MERGED** (`fd009846fe`). The landing path was none of options
A/B/C as originally drafted — it was the **#3303 PR-scoped regressions-allow
ceiling** (`1bd7943b80`), a mechanism built for exactly this shape: the PR
declares a ceiling on non-excused wasm-change regressions in its OWN issue
file's frontmatter (final landing state: ceiling 1450, reviewed floor 23515,
ctor-name whitelist — `dea01e5dd0`), clearing the drift-tolerance,
per-bucket, and #1668 gates in one reviewed, self-expiring declaration
instead of raising global levers.

Acceptance criteria, verified against upstream/main:

1. **Merged + baseline re-seeded** — `benchmarks/results/test262-current.json`
   on main carries `oracle_version: 6` (v4 = #3285 slice 1; v5 = #3227 S1;
   v6 = #2961), `baseline_generated_at 2026-07-16T22:18Z`; the last completed
   push-to-main test262-sharded run (21:33Z) succeeded through
   promote-baseline.
2. **No levers left raised** — `ORACLE_REBASE_DRIFT_TOLERANCE` is stock 25,
   `CATASTROPHIC_REGRESSION_THRESHOLD` is stock 200; the ceiling is PR-scoped
   (consulted only from issue files IN the PR diff) so nothing to revert.
   The stale `regressions-allow` leftover in the #3227 issue file was
   deliberately STRIPPED by the sendev-3165-conflict reconciliation — the
   follow-up-strips-the-key contract is being honored.
3. **No spurious auto-parks** — zero `hold`-labeled open PRs; multiple PRs
   (#3161/v5, #2961/v6, #3165, #3167) merged cleanly after the v4 re-seed.
4. **Slices 2/3 reassessment** — the landing mechanism for same-shape
   verdict-tightening changes is now: oracle-version bump + #3303 declared
   ceiling (measured, PR-scoped) + promote-baseline re-seed. #3285 slices 2
   (`stripUndefinedAssert`) and 3 (full `strip*` inventory) should declare
   their own measured ceilings — no lever dance required.

Residual follow-up already tracked elsewhere: the #3003 gate false-negative
(shim-body verdict changes unflagged) noted in this issue's "Related
follow-up" — not folded in, per scope.
