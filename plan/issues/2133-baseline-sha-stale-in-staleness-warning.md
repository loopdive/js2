---
id: 2133
title: "test262 regression-gate staleness warning reads frozen committed baseline_sha (reports '8h old, commit 3903ea6')"
status: done
sprint: 61
created: 2026-06-12
updated: 2026-06-12
completed: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
---

## Problem

PR #1376's regression check, re-run 3× across 2026-06-12 01:00–02:30, kept
reporting `⚠️ baseline is 8h+ old (commit 3903ea6)` even though the
js2wasm-baselines repo received fresh commits (pass 31050→31075) in that window.

## Root cause

Two separate baseline artifacts, and the staleness warning reads the wrong one:

1. **The diffed JSONL** comes from the baselines repo
   (`/tmp/js2wasm-baselines/test262-current.jsonl`) or the #1081 merge-base
   cache — both **fresh** (baselines HEAD carried advancing main SHAs:
   `682e22d7`, `68beba90`, `3d352c38`…).
2. **The staleness warning** in `diff-test262.ts` reads `baseline_sha` +
   `baseline_generated_at` from `--baseline-meta`, which the workflow pointed at
   the **committed** `benchmarks/results/test262-current.json`. That committed
   file is deliberately frozen: `promote-baseline` **skips the main commit when
   only `baseline_sha`/`timestamp` changed** (`compare-test262-artifact.mjs`
   excludes those keys, lines ~1529-1538 of test262-sharded.yml). So whenever
   test262 pass/fail counts are unchanged but main advances, the committed
   `baseline_sha` stays frozen — it was stuck at `3903ea64` / 17:40 / pass=31050
   while the real baseline was `682e22d7` / 03:00 / pass=31075.

The warning is **informational only** — it does NOT affect the regression
gate's exit code (`netPerTest < 0`), so it was never the actual blocker for
PR #1376 (that was a real `-2 wasm-hash-change` diff against the merge-base).
But the misleading "8h old" message made every regression report look
undecidable and eroded trust in the gate.

## Fix

In `test262-sharded.yml`, point `--baseline-meta` at the **same source as the
diffed JSONL**, newest-first:
1. the #1081 merge-base cache report (`runs/<merge-base>.json`) when that cache
   hit (the diff used that exact baseline) — added a `merge_base` step output
   and sparse-checkout of the `.json`;
2. else the fresh baselines-repo report (`/tmp/baseline-meta-fresh.json`,
   copied during the fetch step alongside the JSONL);
3. else the committed `test262-current.json` / `test262-report.json` (prior
   behaviour, last resort).

This makes the age/SHA in the warning reflect the baseline actually being
diffed, so a current baseline never reports as 8h-stale.

Note: the committed `test262-current.json` staying frozen is by design (avoids
a churn commit on every identical-result push). The hard stale-baseline guard
(#1668) already reads the advancing main-SHA from the baselines-repo commit
**subject**, not this committed file, so it was unaffected.

## Validation
- `test262-sharded.yml` parses as valid YAML.
- Confirmed the baselines-repo `test262-current.json` carries fresh metadata
  (`baseline_sha=682e22d7`, `2026-06-12T03:00`, pass=31075) vs the committed
  file's frozen `3903ea64` / 17:40 / pass=31050 — the exact divergence the fix
  closes.
