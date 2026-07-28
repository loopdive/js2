---
name: reference-compile-time-guard-1942-flake-skips-promote
description: "The merge-shard-reports 'Compile-time regression guard (#1942)' is load-flaky (pass→compile_timeout>25 or agg compile-time>+20%); when it fails on push-to-main it SKIPS 'promote merged report to main baseline', so the landing-page baseline silently stops refreshing. Force-refresh the baseline manually to unblock the deliverable."
metadata:
  node_type: memory
  type: reference
  originSessionId: 00d53514-a026-4121-9d65-d0a8c54ba5a5
  modified: 2026-07-18T14:15:02.872Z
---

On push-to-main, `test262-sharded.yml`'s `merge shard reports` job runs guards
in sequence; **Step 16 "Compile-time regression guard (#1942)"** fails when
`pass→compile_timeout > 25` OR aggregate compile-time Δ `> +20%` over the shared
both-compiled set (thresholds `COMPILE_TIMEOUT_THRESHOLD=25`,
`AGG_COMPILE_TIME_PCT_THRESHOLD=20`, reading `/tmp/cat-diff.txt`). Both signals
are **load-sensitive** — under runner starvation compile times spike and cross
the 30s per-test timeout, producing false `pass→compile_timeout` (see
[[feedback_regression_analysis]]). When this step fails, the later
`promote merged report to main baseline` step is **skipped**, so the
landing-page/pass-badge baseline silently stops refreshing even though every
test262 shard passed.

Observed 2026-07-18: push-to-main runs FAILED at 10:16Z & 05:09Z but SUCCEEDED
at 04:30 & 04:01 — intermittent, i.e. a flake gate, not a hard block. Diagnose
via check-runs on the SHA (`gh api repos/.../commits/<sha>/check-runs`), NOT
`gh run view --json jobs` (truncates at 30 → shows only shards, hides the guard
job). See [[reference_park_diagnosis_check_runs_on_sha_not_run_jobs]].

**How to apply:** if a landing-page metric goes stale after merges, check whether
`merge shard reports` failed on the compile-time guard and skipped promote.
Remedy = **manual force-refresh** of the baseline (the "FORCED baseline refresh
by ttraenkler … [skip ci]" commits are this), or the surgical hand-promote in
[[reference_surgical_baselines_push_partial_clone]]. A durable fix would make
the guard load-aware / raise the flake threshold, but that itself must ride the
slow queue. Related: [[project_standalone_floor_only_on_merge_group]].
