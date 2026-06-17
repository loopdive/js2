---
id: 2097
title: "absolute standalone pass-count floor — high-water-mark backstop against compounding small regressions"
status: done
sprint: 62
created: 2026-06-11
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/dv2
priority: medium
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: testing
language_feature: n/a
goal: host-independence
related: [2095]
origin: "2026-06-11 analysis program (report 06 §4); stub 08-C12"
---

# #2097 — a moving floor ratchets nothing

## Problem

The #1897 standalone regression floor is MOVING (re-seeded from the new
baseline on every push to main), so a sequence of small net-negative PRs
each within tolerance compounds without any ratchet catching the trend.

## Root cause

Tolerance-vs-rolling-baseline design — no absolute reference.

## Plan

Commit a standalone high-water mark (like
benchmarks/results/test262-current.json); a weekly job (or a step in the
sharded workflow) asserts standalone pass-count ≥ high-water − 50, with
the mark auto-raised on improvement.

## Acceptance criteria

- High-water file committed and auto-raised; breach fails loudly with the
  trend window in the message

## Dupe check

#1897 (merged) is the per-PR rolling gate; the absolute backstop is
unfiled. New (analysis program).

## Resolution (2026-06-16, dv2)

**Committed high-water mark.** `benchmarks/results/test262-standalone-highwater.json`
holds the absolute standalone pass-count floor reference
(`{ pass, sha, generated_at, tolerance }`), seeded at the current published
standalone baseline (`pass: 21184`, full corpus). It only ever ratchets UP.

**Check script.** `scripts/check-standalone-highwater.mjs`:
- reads the merged standalone report's `full_summary.pass` (matching the
  standalone JSONL row count),
- asserts `pass ≥ mark.pass − tolerance` (default 50) — on breach it fails
  loudly with the slide magnitude, the mark's commit/timestamp (the trend
  window), and a re-seed pointer; exit 1,
- with `--update`, RAISES the committed mark when pass improved (never lowers).

**CI wiring** (`.github/workflows/test262-sharded.yml`):
- A `Standalone pass-count high-water floor (#2097)` step inside the **required**
  `merge shard reports` job (right after the standalone report build) runs the
  assert, so a compounding slide below `mark − tolerance` blocks the merge
  queue — independent of the moving #1897 per-PR floor.
- In `promote-baseline` (push:main), a `Raise standalone pass-count high-water
  mark (#2097)` step runs `--update`, and the raised file is staged into the
  same atomic main-repo summary commit (`stage_files`). So the mark auto-rises
  with conformance and is never silently lowered.

### Acceptance criteria — met
- ✅ High-water file committed and auto-raised (promote-baseline `--update`;
  ratchet verified: raises on improvement, refuses to lower).
- ✅ Breach fails loudly with the trend window (commit + timestamp + slide
  magnitude) in the message; gated inside the required `merge shard reports`
  check.

### Files
- `benchmarks/results/test262-standalone-highwater.json` — committed mark.
- `scripts/check-standalone-highwater.mjs` — assert + ratchet.
- `.github/workflows/test262-sharded.yml` — required-check assert step +
  promote-baseline auto-raise + stage.
- `tests/issue-2097-standalone-highwater.test.ts` — decision-logic unit tests.

### Test Results
- `tests/issue-2097-standalone-highwater.test.ts` — 7/7 pass.
- Script smoke (within-tolerance pass, breach exit 1, ratchet raise/refuse) —
  all correct.
