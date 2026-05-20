---
id: 1522
sprint: 53
title: "Automate conformance number propagation after each test262 run"
status: ready
created: 2026-05-20
priority: high
feasibility: easy
reasoning_effort: low
task_type: tooling
area: build, docs
goal: maintainability
related: [1391, 1393]
---

# #1522 — Automate conformance number propagation after each test262 run

## Problem

The headline test262 pass/total/percentage number is currently hand-edited
into three places that disagree:

| Source                                 | Current value             |
|----------------------------------------|---------------------------|
| `ROADMAP.md`                           | **17,252 / 48,088 (35.9 %)** (Apr 2026, stale) |
| `plan/goals/goal-graph.md`             | **25,830 / 43,168 (59.8 %)** (2026-04-28) |
| `CLAUDE.md` Sprint History             | **28,171 / 43,160 (65.3 %)** (latest) |
| `benchmarks/results/test262-current.json` | source of truth (2026-05-20) |

Anyone (human or agent) reading these for "current state" plans against
ancient data. ROADMAP is off by ~11,000 tests — bigger than most language
features in flight.

## Acceptance criteria

1. A script (e.g. `scripts/sync-conformance-numbers.mjs`) reads
   `benchmarks/results/test262-current.json` and updates the
   "current state" line in `plan/goals/goal-graph.md`, the conformance
   section of `ROADMAP.md`, and the badge in `README.md`.
2. The script is invoked by:
   - `scripts/run-pages-build.mjs` (so `build:pages` regenerates them), AND
   - `.github/workflows/test262-sharded.yml` `promote-baseline` job after
     it writes the new `test262-current.json` to `main`.
3. Edits must be idempotent and produce a clean diff (no formatting churn).
4. CI fails if the script would change any of the tracked files (so
   forgotten manual edits cannot silently drift).
5. `CLAUDE.md` Sprint History line stays human-written but a separate
   `<!-- AUTO:conformance -->` block above it carries the live numbers.

## Implementation notes

- Use a small regex over the markdown — explicit anchor comments like
  `<!-- AUTO:conformance-start --> ... <!-- AUTO:conformance-end -->`
  scope where edits land. Refuse to write if anchors are missing.
- Tag each anchor block with the `baseline_sha` from the JSON so a reader
  can correlate the number with the run.
- Mirror the same approach already used by `sync-sprint-issue-tables.mjs`
  (`GENERATED_ISSUE_TABLES_START` / `..._END`).
