---
id: 3457
title: "ci(test262): make the merge_group regression-ratio gate flap-tolerant (stop false-parking symmetric content-current churn)"
status: done
assignee: ttraenkler/senior-dev-3457
sprint: current
created: 2026-07-19
updated: 2026-07-19
completed: 2026-07-19
priority: medium
horizon: m
feasibility: medium
reasoning_effort: medium
task_type: ci
area: ci
language_feature: n/a
goal: maintainability
depends_on: [1943]
---

# Make the merge_group regression-ratio gate flap-tolerant (L-adjacent)

Surfaced during the 2026-07-18/19 merge-queue firefight. Related to
`plan/ci-acceleration-review.md` (guard-fragility theme, §2.4).

## Problem (confirmed)

The auto-park regression gate uses a **raw 10 % regression-ratio threshold**
(the documented ratio gate enforced by #1943). It **false-parks** PRs whenever
content-current async / `$DONE` flap produces **SYMMETRIC** churn — improvements
≈ regressions, so the **NET is neutral** — because the raw ratio counts the
regression side without netting it against the equal improvement side.

Confirmed false-parks: **#3351 / #3318 / #3359** — all net-neutral, with flat
trap-category counts baseline→candidate, roughly half of the churn being
`compile_timeout` runner-load noise. **#3359** reproduced the same churn even
against the fresh QUIET baseline `03ca4729`, proving the churn is flap, not a
real regression. Only the raw ratio gate fails them; they are not real
regressions, and each false-park costs a `hold` + a full re-validation run.

## Fix (spec)

1. **Require ASYMMETRIC churn before parking** — park only when regressions
   _materially exceed_ improvements, not on a raw ratio. Net-neutral symmetric
   flap must pass.
2. **Exclude `compile_timeout` / `ct_flake` ≤ 5000 ms noise from the regression
   numerator** — runner-load contention timeouts are not content regressions
   (same root cause as the #3447 contention-tolerant compile-timeout guard).
3. **(Optional)** require a regressed test to **reproduce across N runs** before
   it counts toward the gate — a one-run flip is flap, not signal.

## Acceptance criteria

1. A net-neutral PR with symmetric improvement/regression churn (repro:
   #3351/#3318/#3359 signature) passes the merge_group regression gate.
2. `compile_timeout` / `ct_flake` ≤ 5000 ms entries are excluded from the
   regression numerator.
3. A genuine one-directional regression (regressions ≫ improvements, real trap
   categories) still parks — the gate does not go blind.
4. Thresholds + the asymmetry rule documented in-workflow with the
   #3351/#3318/#3359 false-park evidence.

## Related

- #1943 (established the 10 % ratio / 50-per-bucket gate this refines).
- #3404 (sibling: promote tolerates single-shard _upload_ flake — a different
  flake, not this content-churn gate).
- #3447 (same spirit: contention-tolerant compile-timeout count guard).
- #3376 (logged the flap evidence during the firefight).
- Review: `plan/ci-acceleration-review.md` §2.4 (guard fragility / contention
  pricing).

## Implementation Plan (senior-dev, 2026-07-19)

### Root cause (precise)

The fine gate lives in `scripts/diff-test262.ts`, invoked from the "Compare
against current main baseline" step (`id: regression_diff`) of
`.github/workflows/test262-sharded.yml` and hard-failed by the downstream
"Fail on regressions" step. In the NON-rebase branch of `run()` the gate has
TWO independent hard-fail conditions:

1. **Net gate** — `netPerTest = stableImprovements − regressionsWasmChange < 0`.
2. **Ratio gate** (`evaluateRegressionThresholds`, #1943) — fires whenever
   `regressionsWasmChange > 0` AND `regressions/improvements ≥ 10 %`,
   **independently of net**. This is the over-park bug: a net-POSITIVE PR
   (#3409 net +30, ratio 11.8 %; #3406 net +29, ratio 17 %) trips condition (2)
   even though condition (1) passes.

`regressionsWasmChange` already excludes `compile_timeout`, wasm-identical
noise, host-canary-quarantined paths, leaky→host-free, and vacuity flips — so
AC2 (compile_timeout excluded from the numerator) is ALREADY satisfied by the
existing `noiseFiltered` filter (`r.to !== "compile_timeout"`). Verified, no
change needed there.

### Change (net-aware / flap-tolerant ratio gate — #3457)

`evaluateRegressionThresholds` now computes `net = improvements − regressions`
and classifies the ratio breach:

- **`net ≥ 0`** → the ratio breach is a **WARNING, not a failure**. Net
  conformance held or rose; the regressions are outnumbered by improvements in
  the same run (symmetric flap / net-positive). This is the AC1 fix.
- **`net < 0` AND `regressions ≥ SMALL_SAMPLE_FLOOR (10)`** → ratio breach is a
  **hard FAILURE** (a genuine, statistically-meaningful one-directional
  regression). AC3.
- **`net < 0` AND `regressions < 10`** → ratio breach is a **WARNING**: below
  the floor a single flaky flip dominates the ratio, so it is statistically
  meaningless. The independent net gate (net<0) already hard-fails this diff, so
  we don't ALSO report a noisy ratio as a separate hard failure. AC-small-sample.

**Floor = 10.** Reasoning: below ~10 transitions a single flake shifts the ratio
by ≥10 points (1 flake on a 9-improvement PR = 11 %), so the ratio is noise; 10
is well under the 50-per-bucket concentration limit so a genuinely concentrated
break still trips the (unchanged) bucket gate; and the net gate independently
catches any true net-negative change regardless of the floor. The floor gates
only the RATIO signal — it never lets a net-negative change pass.

**Return shape**: `evaluateRegressionThresholds` now returns
`{ failures: string[]; warnings: string[] }` (was `string[]`). The CLI prints
`GATE WARN (#3457): …` for warnings and `GATE FAIL: …` for failures. The
per-bucket (>50) concentration check stays a hard failure, unconditional on net.

### Gates PRESERVED unchanged (verified)

- **Net gate** (`netPerTest < 0`) — untouched; still the primary hard fail.
- **#3189 uncatchable-trap growth ratchet** (`evaluateTrapCategoryGrowth`) —
  untouched; still a SEPARATE hard fail independent of net (a net-positive PR
  that adds a null_deref/illegal_cast/oob/unreachable still parks). AC-trap.
- **Per-bucket >50 concentration** — untouched hard fail.
- **Rebase-mode gate** (`evaluateRebaseGate`, #3086/#3303 regressions-allow) —
  untouched; the net-aware ratio logic is in the NON-rebase branch only, so the
  `regressions-allow:` escape hatch composes cleanly (it only lives in rebase
  mode).
- **`scripts/check-baseline-trap-growth.ts`** (promote-side trap ratchet) —
  NOT touched.

### oracle_version — NO bump (verified)

This is a PR-level GATE-DECISION change, not a per-test verdict change. The
per-SHA verdict caches (status / error_category in the JSONL) are unaffected, so
cached rows stay valid. `scripts/check-verdict-oracle-bump.mjs` only triggers on
edits to `PURE_VERDICT_FILES` / `MIXED_VERDICT_FILES`
(negative-verdict.mjs, test262-worker.mjs, test262-shared.ts,
test262-vitest.test.ts, test262-runner.ts) — `scripts/diff-test262.ts` is NOT in
that surface, so the oracle-bump gate does not fire.

### `--baseline-content-current`

The `baseline_content_current` signal exists as a **workflow step output**
(staleness step) used only for the drift FOOTER message; it is NOT a
`diff-test262.ts` CLI flag today (the comment at yml:1223 is aspirational). The
net-≥0 waiver added here addresses the same content-current flake class more
directly and generally, so no new flag is wired. The existing footer path is
left untouched.

### Tests

`tests/issue-1943.test.ts` updated for the new return shape + net-aware
semantics; new cases in `tests/issue-3457.test.ts`: net-positive-high-ratio →
PASS (warning); net-negative + regressions≥floor → FAIL; net-negative +
regressions<floor → PASS (small-sample floor); bucket>50 → FAIL regardless of
net; net-zero symmetric churn → PASS.
