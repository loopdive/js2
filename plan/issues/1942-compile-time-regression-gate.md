---
id: 1942
title: "Compile-time regression gate — pass→compile_timeout is excluded from every gate, so compile-perf regressions are invisible"
status: backlog
sprint: Backlog
created: 2026-06-10
updated: 2026-06-10
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
