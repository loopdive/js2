---
id: 2562
title: "Baseline goes time-stale during docs/CI-only merge stretches (cron refresh + src-aware drift warning)"
status: done
created: 2026-06-20
updated: 2026-06-20
completed: 2026-06-20
priority: high
feasibility: medium
reasoning_effort: high
goal: ci-hardening
sprint: Backlog
assignee: ttraenkler/sd-baseline
---

# #2562 — Baseline time-staleness: cron refresh + src-aware drift warning

## Problem

The test262 baseline (`loopdive/js2wasm-baselines` `test262-current.jsonl`) only
re-promotes on **test262-relevant (src)** merges, via the `promote-baseline` job
in `test262-sharded.yml` (its `push:` trigger has a `paths:` filter restricted
to src/config). During a stretch of **docs/CI-only merges** (0 src files — e.g.
#1769/#1799/#1800 on 2026-06-20) main advances but the baseline does **not**
re-promote, so it goes **clock-time stale** (observed 2.5h) — even though src is
unchanged, so the comparison is still **content-valid**.

The time-based **drift WARNING** (#1235) fires whenever the baselines-repo JSONL
is ≥30 _minutes_ older than main HEAD — a pure clock signal that says nothing
about whether src changed, so it cried wolf during docs-only stretches.

`refresh-baseline.yml` was `workflow_dispatch`-only (no cron), so nothing
re-promoted the baseline during a non-src stretch. Not a broken pipeline — a
coverage gap plus a noisy clock-time warning.

## Scope (NARROWED — gate untouched)

> The ratio/threshold **gate logic is deliberately NOT modified** (user veto
> 2026-06-20): loosening the regression-gate's sensitivity risks letting real
> regressions through. The flaky test262 file that was blocking #1742/#1711 is
> fixed separately by de-flaking the actual test (#27). This issue is purely the
> staleness/cron improvement and a smarter (informational) drift WARNING.

### Part 1 — Scheduled NORMAL refresh (anti-staleness)

`refresh-baseline.yml` (renamed _Baseline Refresh (scheduled + emergency)_) gets
a `schedule:` cron (`17 */8 * * *` — every 8h, offset from the :23/:37 baseline
crons) plus a **non-emergency NORMAL mode**:

- A run is **FORCED** (emergency, ignores the regression gate) **only** on a
  confirmed `workflow_dispatch` (`force_baseline_refresh=true` +
  `confirm_force="YES"`). The workflow-level `IS_FORCED` env encodes this once.
- A `schedule` run (or a non-forced manual dispatch) is a **NORMAL** refresh: it
  records main's **actual current** test262 state. This is **not** a
  force-promote — main is already-merged code, so recording its true conformance
  can never silently bake a regression past a PR gate. The `validate-inputs` job
  only requires the `"YES"` confirmation on the forced path.
- The baselines-repo commit subject now records the **main-sha**
  (`... pass (<github.sha>)`), matching the `promote-baseline` format, and the
  report build passes `--baseline-sha`. This lets the #1668 stale-baseline guard
  and the Part-2 src-aware warning parse the main commit the baseline came from.

### Part 2 — Src-aware drift WARNING (informational only)

In `test262-sharded.yml`'s `regression-gate` job, the _Check baseline staleness_
step now measures staleness by the count of **test262-relevant (src) commits**
between the baseline's recorded main-sha and `origin/main` (via
`scripts/test262-paths-match.sh`, the same filter the #1668 guard uses), not by
clock minutes:

- `src_commits_behind == 0` → baseline is **content-current**: suppress the
  noisy time-based drift warning. (If the gate fails anyway, the footer notes the
  failure is likely a real regression, not drift.)
- `src_commits_behind  > 0` → genuinely behind src: emit the drift warning.

**This changes only the WARNING / footer text — it does NOT touch the gate's
pass/fail decision.** `diff-test262.ts` runs exactly as on `main` (no new flag,
no threshold change). The gate's regression-detection sensitivity is unchanged.

## Files changed

- `.github/workflows/refresh-baseline.yml` — `schedule` cron + NORMAL mode,
  `IS_FORCED` env, conditional confirmation, main-sha in commit subjects,
  `--baseline-sha` on report build.
- `.github/workflows/test262-sharded.yml` — src-aware staleness step
  (`baseline_content_current` / `src_commits_behind` / `stale_minutes` outputs)
  driving the drift WARNING + the failed-job footer **only**. The
  `diff-test262.ts` invocation is reverted to its `main` form (no gate change).

> `scripts/diff-test262.ts` and `tests/issue-1943.test.ts` are intentionally
> **unchanged from `main`** — the gate logic is out of scope per the veto.

## Acceptance criteria

- [x] A scheduled (cron) NORMAL baseline refresh exists and records main's
      actual current state (not force/emergency); confirmation is required only
      for the forced/emergency path.
- [x] The drift WARNING is driven by **src-commit count**, not clock time; 0
      src-behind ⇒ no noisy time-based warning.
- [x] The regression-gate's pass/fail logic (ratio / bucket / net) is **byte-for-byte
      unchanged from `main`** — no gate sensitivity change.
