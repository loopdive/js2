---
id: 3612
title: "baseline-summary-sync clobbers fresher conformance docs — read-then-write race re-applies a stale README snapshot over a newer main tip"
status: ready
sprint: current
priority: medium
horizon: s
task_type: ci
goal: ci-infra
related: [3611, 1951, 3115, 3601, 3603]
created: 2026-07-25
---

## Problem

The hourly `baseline-summary-sync.yml` (#1951) can **revert freshly-corrected
published conformance numbers** on `main`. Observed 2026-07-25:

- #3601 (merge `31139d0a9`) landed the standalone de-vacuification; #3603
  (merge `c25fc91a0`) raised the #2097 high-water file
  (`benchmarks/results/test262-standalone-highwater.json`) to the measured
  `official_pass: 22394` AND set the README standalone line to
  `22,394 / 43,106 (52.0 %)`.
- The next scheduled sync commit `d8e381fb0` ("scheduled baseline summary
  sync — 30405/43098 pass [skip ci] (#1951)") **reverted the README standalone
  line back to the stale estimate `18,400 / 43,106 (42.7 %)`** — a ~9-point
  understatement — while leaving the high-water file itself correct.

This will recur every time the published numbers move while a scheduled sync
run is in flight or its checkout predates the correction.

## Root cause — read-then-write race in the sync job

`baseline-summary-sync.yml` runs `node scripts/sync-conformance-numbers.mjs`
**once, early**, against the job's initial `fetch-depth: 1` checkout. The
resulting README/docs are captured into `PROMOTE_FILES` + `PROMOTE_SNAPSHOT`.
The Option-A re-anchor loop then does `git checkout -f -B _summary_sync_tmp
deploykey/main` (a **newer** tip) and copies the **stale snapshot** README
over it before committing.

This is precisely the #3115 stale-checkout hazard. The workflow already
guards it for three other pure-source baselines — inside the re-anchor loop it
**recomputes** `check-coercion-sites.mjs --update`, `check-loc-budget.mjs
--update`, and `check-func-budget.mjs --update-on-decrease` against the
re-anchored tree — but `sync-conformance-numbers.mjs` (which reads the
committed high-water file and writes README/CLAUDE/ROADMAP/goal-graph) has
**no such recompute**, so a README computed from a pre-correction high-water
clobbers a fresher one.

Same family as #3611 (published conformance numbers are written by several
independent paths — promote-baseline, the scheduled sync, and manual/PR
corrections — that silently overwrite each other with no freshness ordering).

## Fix directions (either suffices; both are cheap)

1. **Recompute at write time (mirror the #3115 guard):** inside the re-anchor
   loop, after checking out `deploykey/main`, re-run
   `node scripts/sync-conformance-numbers.mjs` against the re-anchored tree
   and `git add` the docs it touches — instead of (or after) copying the
   snapshot copies of README.md/ROADMAP.md/CLAUDE.md/plan/goals/goal-graph.md.
   The script is pure (committed high-water + baselines report in), so the
   recompute is trivially safe.
2. **Monotonicity guard in the script:** `sync-conformance-numbers.mjs`
   refuses to write a standalone (or host) pass count **lower** than the one
   already present in the target file unless the authoritative source file in
   the same tree actually says so — i.e. never let a stale input regress a
   committed number without the high-water file itself having moved down.

## Acceptance criteria

- A scheduled sync run whose checkout predates a conformance correction can
  no longer revert README/docs numbers below what the re-anchored `main` tip's
  high-water file supports.
- The immediate 2026-07-25 damage is repaired separately (README resync PR —
  see this issue's filing PR).
