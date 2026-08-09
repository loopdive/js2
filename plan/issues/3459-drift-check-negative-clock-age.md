---
id: 3459
title: "merge_group drift check reports negative baseline clock age (-43m) — clock-skew bug in instrumentation"
status: done
completed: 2026-07-24
sprint: 76
created: 2026-07-19
updated: 2026-07-24
priority: low
horizon: s
feasibility: easy
task_type: bug
area: ci, merge-queue, instrumentation
goal: release-pipeline
related: [3456, 3378]
origin: "2026-07-19 pr-shepherd observation during #3375 regression triage: the baseline-drift check printed a NEGATIVE clock age."
---

# #3459 — baseline drift check prints negative clock age (-43m)

## Problem

During the `merge_group` re-validation that caught the #3375/#3370
`null_deref` regression, the baseline **drift/staleness check** printed a
**negative** baseline clock age (`-43m clock age`). A negative age is
nonsensical — it means the instrumentation computed `now - baseline_ts`
with skewed or wrongly-sourced timestamps (e.g. baseline timestamp read in
a different timezone/epoch unit than `now`, or the runner clock vs. the
commit-authored time).

This is **instrumentation-only** — it did **not** affect the regression
verdict (the gate correctly failed on the trap-growth + ratio signals). But
a negative "age" makes the staleness signal untrustworthy: a genuinely
stale baseline could be misreported, and it obscures the real
`baseline_staleness_commits` reading operators rely on when interpreting
`net_per_test` / regression counts.

## Where to look

The drift/staleness computation in the merge-shard-reports path of
`.github/workflows/test262-sharded.yml` (the "Build merged … report" /
baseline-age step) and/or the script it calls (the baseline fetch/compare
helper). Audit how the baseline timestamp is sourced and differenced
against `now` — unify the epoch unit (seconds vs ms) and the clock source,
and clamp/flag rather than print a negative age.

## Acceptance criteria

- [x] The baseline clock-age value is never negative.
- [x] The age is computed from a single, documented clock source and epoch
      unit.
- [x] A quick unit/sanity check covers the sign.

## Resolution (2026-07-24)

Root cause: the age was computed inline in `test262-sharded.yml`'s "Check
baseline staleness" step as `(MAIN_HEAD_TS - BASELINE_TS) / 60`, where
`BASELINE_TS` is the git `%ct` of the **baselines-repo** HEAD commit and
`MAIN_HEAD_TS` is the `%ct` of **this checkout's** main HEAD. Both are already
Unix epoch **seconds**, so the epoch unit matched — the defect was a clock-
**source** mismatch: the baselines-repo commit is produced by `promote-baseline`
*after* the main commit it was generated from, and on a `merge_group`
re-validation it can reflect a **newer** main state than the speculative
checkout's `origin/main`. So `MAIN_HEAD_TS - BASELINE_TS` was frequently
negative (the observed `-43m`).

Fix: extracted the computation into `scripts/baseline-clock-age.mjs`
(`computeClockAge`), which documents the single clock source/unit (git `%ct`,
Unix seconds) and **clamps** a fresher-than-main-HEAD baseline to age `0` with
an honest stderr note (`baselineAhead`) instead of emitting a negative age. The
staleness step now calls the helper. Unit + CLI tests in
`tests/issue-3459-baseline-clock-age.test.ts` cover the sign (the `-43m` repro,
identity, sub-minute truncation, invalid/sentinel timestamps). This also fixes
the minor functional side-effect where a negative value silently skipped the
`-ge 30` clock-based fallback warning.

## Notes

Low priority — cosmetic/observability, not a correctness gate. Surfaced by
the pr-shepherd while triaging the #3375 real-regression (see #3370 hold and
CI-FIX for the actual codegen bug). Related to the merge-queue instrumentation
touched in [[3456]] / #3378.
