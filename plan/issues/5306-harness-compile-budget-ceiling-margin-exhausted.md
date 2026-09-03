---
id: 5306
title: "check:harness-compile-budget sits 29 traversals under its ceiling on main (150,774 / 150,803) — the next harness-path PR trips a gate that measures drift since 2026-08-20, not its own change"
status: ready
sprint: current
created: 2026-09-03
updated: 2026-09-03
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: infra
area: ci
goal: ir-full-coverage
related: [3437, 3433, 3374, 5297]
requested_by: ttraenkler/orchestrator
---

# The pre-merge compile-work budget has silently used up its margin

`pnpm run check:harness-compile-budget` (#3437) compiles a fixed
harness-shaped assembly and counts shared `forEachChild` traversals
(`src/ts-api.ts`). It fails when the count exceeds the committed budget plus
15 %. The committed budget is `131,133` (`scripts/harness-compile-budget.json`,
last rebanked 2026-08-20), so the ceiling is `150,803`.

Measured 2026-09-03 on PR #5541's branch (#5297) with the `quality` job's
own command, twice — with and without that PR's new test file, identical:

| | traversals |
| --- | --: |
| budget (committed 2026-08-20) | 131,133 |
| ceiling (+15 %) | 150,803 |
| measured on `origin/main` `986bbf7705` | **150,774** |
| margin left | **29** (0.02 %) |

The number does not depend on #5297 (same count with its test file deleted),
so it is main's. Fourteen days of ordinary IR-migration landings consumed
19,641 traversals of headroom (+15 %) without any single PR being flagged.

## Why this is a defect and not "the gate working"

The gate exists to catch **one PR** introducing an O(call-sites × file-size)
scan (#3433's class, fixed by #3374). A budget that is 99.98 % consumed no
longer does that: the next PR that touches the harness compile path fails
`quality` for the cumulative drift of every PR before it, and its author has
no local reproduction that isolates their own contribution. That is the
"red gate costs a full cycle plus a branch re-sync" outcome the pre-commit
gates are supposed to prevent (CLAUDE.md, "Hooks and ratchet gates").

Whether the 15 % growth is itself a regression (a new per-file scan hiding
in the last two weeks of IR landings) or the expected cost of the IR path
compiling more of the harness is **not established** — that is the first
thing to measure.

## Acceptance criteria

1. **Bisect the growth**, not just rebank it. Run the gate's `--json` output
   at the 2026-08-20 rebank commit, at `986bbf7705`, and at the
   merge commits in between (a coarse bisection over the ~60 merges is
   enough). Report the top three commits by traversal delta with their PR
   numbers. If one commit contributes more than a third of the growth,
   file it as its own issue with the scan named.
2. **Rebank** with `pnpm run check:harness-compile-budget -- --update` only
   after (1), in a PR whose body carries the bisection table, so the new
   budget is a measured number, not a ceiling reset.
3. **Add a soft-warning band**: when `measured > budget × (1 + marginPct/2)`
   the gate prints a `::warning::` naming the remaining margin, so the
   drift is visible in every PR's `quality` log long before it fails. No
   new required check.
4. Record in `scripts/harness-compile-budget.json`'s `note` the date and
   the measured number the budget was rebanked from (the current note says
   "post-#3433 main" with no figure).

## Non-goals

- Raising `marginPct`. A wider band hides the same drift longer.
- Rebanking from a PR branch. The budget is main's number; `--update` runs
  on `origin/main` and the result is reviewed.
