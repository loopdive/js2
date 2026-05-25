---
id: 1668
title: CI catastrophic-regression guard — block merge-queue on large test262 pass drops
sprint: 55
status: in-review
feasibility: easy
owner: tech-lead
---

## Problem

PR #608 (#1666) merged a codegen change that corrupted the test262 harness
(an eager `fixupModuleFuncIndices` in `addImport` fired in the default JS-host
GC path and shifted away the `call` pushing `Math.abs`'s argument, so
`f64.abs` ran with an empty stack). Because nearly every test calls
`assert.sameValue` → `Math.abs`, the corrupted harness failed globally:
**29,355 → 25,743 pass (68.0% → 59.6%), +3,931 identical compile_errors.**

It merged because the **`check for test262 regressions` (regression-gate) job
is advisory, NOT a required check** (required = `cheap gate`, `merge shard
reports`, `quality`, `cla-check`). The merge queue ignored the 3,600 detected
regressions. The gate was left advisory on purpose: baseline *drift* (#1235,
typically <50 tests) produces false-positive small regressions, so a strict
"fail on any regression" required check would block legitimate PRs.

## Fix

Add a **HARD catastrophic-regression guard inside the already-required
`merge shard reports` (`merge-report`) job** in `test262-sharded.yml`. After
building the merged report it diffs against the baseline JSONL
(`loopdive/js2wasm-baselines`) and fails when
`Regressions with wasm-hash change` exceeds a **high threshold (200)**.

- Threshold ≫ drift noise (<50), so legitimate PRs are never blocked.
- Catches catastrophes (hundreds–thousands), which are always a codegen/harness
  break — the #608 class.
- Lives in a required check → blocks the merge queue. No ruleset change.
- Skips on the no-shards path (`SHARDS_RAN != true`) like the rest of the job,
  so non-test262 PRs are unaffected.
- The fine-grained `regression-gate` stays advisory for the 1–200 range where
  human judgment + drift cross-check (per `/dev-self-merge`) applies.

## Follow-ups (separate issues)

- **Re-land #1666 correctly** — the WASI/standalone valid-wasm fix is real; the
  func-index fixup must be scoped so it never re-shifts already-emitted bodies
  in the default path. Reverted by PR #618.
- **`benchmarks/results/test262-current.json` is all-null** — the committed
  landing-page summary lost its pass/total/sha (promote-baseline). Cosmetic
  (the JSONL baseline the gates use is fine), but the badge is broken.

## Acceptance criteria

- [x] Guard step added to the required `merge-report` job.
- [x] Threshold tuned to ignore drift, catch catastrophes; grep extraction
      unit-checked (3931 → fail, 12 → pass).
- [ ] A future src PR's merge-group run shows the guard step reporting its count.
