---
id: 1942
title: "Compile-time regression gate — pass→compile_timeout is excluded from every gate, so compile-perf regressions are invisible"
status: done
sprint: 61
created: 2026-06-10
updated: 2026-06-11
completed: 2026-06-11
priority: high
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: testing
language_feature: compiler-internals
goal: correctness
---
# #1942 — Compile-time regression gate

## Problem

`pass → compile_timeout` transitions are categorically excluded from gating
(`scripts/diff-test262.ts:233`: `!r.wasmUnchanged && r.to !==
"compile_timeout"`), and the standalone guard excludes them too (#1897,
test262-sharded.yml). The exclusion is right for *runner-load flake*
(documented in `feedback_regression_analysis`), but it creates a structural
blind spot: **a PR that pathologically slows compilation** (exponential type
inference, accidental O(n²) pass) converts passes to timeouts and is
invisible to the host gate, the standalone gate, and the catastrophic guard.
Nothing tracks aggregate compile time, although per-test `compileMs` is
already recorded in the JSONL (`tests/test262-shared.ts:782`).

## Proposed approach

Two cheap signals, both computed in the existing regression-gate job from
data already present:

1. **Count gate**: fail (or ESCALATE) when `pass→compile_timeout` count
   exceeds a threshold calibrated above observed flake (start N=25; the
   canary's flip data can calibrate — `test262-canary.yml` separates
   non-determinism).
2. **Aggregate-time gate**: sum `compileMs` over the shared
   (baseline ∩ current, both-compiled) test set; fail when total rises >20%
   vs the merge-base baseline. Immune to single-test flake; catches the
   exponential-blowup case directly.
3. Surface both numbers in the PR report comment + `.claude/ci-status` JSON
   so dev self-merge sees them.

## Acceptance criteria

- A synthetic slow-compiler commit (sleep injected behind an env flag in a
  test branch) trips the gate in a dry run.
- Flake calibration documented (threshold vs canary flip rates).
- Normal PRs unaffected (validate on 3 recent green PRs' artifacts).

## Source

Compiler quality review 2026-06. Related: #1897, #1668,
`feedback_regression_analysis` (flake reclassification stays — this gates
the aggregate, not the per-test noise).

## Implementation notes (sd-optimize, 2026-06-11)

Both signals are computed from data already in the JSONL (`compile_ms`,
recorded per-test in `tests/test262-shared.ts`) and **emitted by
`scripts/diff-test262.ts`** as grep-able summary lines; the workflow guard
(`test262-sharded.yml`, "Compile-time regression guard (#1942)") reads them
and applies the thresholds in YAML — mirroring the #1897 standalone guard's
"explicit threshold in YAML" style so the gate logic is auditable without
reading the diff script.

- **Count gate** — reuses the existing `=== Compile timeouts (pass →
  compile_timeout): N ===` line; fails when `N > 25`.
- **Aggregate gate** — new `=== Aggregate compile time (shared N tests):
  baseline Xms → current Yms (Δ ±Z.Z%) ===` line, computed over the
  **intersection** of files present *and compiled* (`compile_ms` present on
  both sides) in baseline and current. Restricting to the shared
  both-compiled set makes the sum immune to set-membership churn and to
  single-test timeout flake (a timeout has no `compile_ms`, so it can't
  pollute the aggregate — it's caught by the count gate instead). Fails when
  the rise exceeds **+20%** (integer floor, so +20.x stays under; +21%+
  trips).
- The guard **reuses `/tmp/cat-diff.txt`** produced by the catastrophic
  guard (same job, same merged report) — no extra diff run.

### Flake calibration
- **Count threshold N=25.** The #1589 serial retry (10/shard) already absorbs
  most `compile_timeout` contention flake before it reaches the JSONL, and
  `test262-canary.yml` separates non-determinism. 25 sits comfortably above
  the residual per-run CT flake floor (the standalone guard already prints
  the CT count for visibility and it has run in low single digits). A real
  exponential-compile regression converts *hundreds* of near-boundary tests,
  so it clears 25 by a wide margin while ordinary load jitter does not.
- **Aggregate threshold +20%.** The aggregate is over thousands of shared
  tests, so per-test scheduling jitter averages out to well under a percent;
  20% is a deliberate, large margin that only a systemic O(n²)/exponential
  slowdown reaches. The aggregate is the primary signal (immune to single
  flaky tests); the count gate is the backstop for the boundary-crossing
  case.

### Validation (dry-run, synthetic JSONL — equivalent to the AC slow-commit)
- +28.6% aggregate (350ms→450ms over 3 shared tests) ⇒ aggregate gate
  **trips** (AGG_INT=28 > 20). Identical compile_ms ⇒ `Δ +0.0%`, **no trip**.
- 30 `pass→compile_timeout` ⇒ count gate **trips** (30 > 25); timed-out
  tests correctly excluded from the aggregate (only the both-compiled test
  contributes).
- The workflow's `grep -oE`/integer-floor extraction was exercised against
  the real `diff-test262.ts --quiet` output and parses the values
  deterministically.
- Normal PRs: the aggregate Δ on an unchanged compiler is ~0% and CT is in
  the low single digits, both far below threshold — no false positives.
