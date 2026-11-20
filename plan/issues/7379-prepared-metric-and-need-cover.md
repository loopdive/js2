---
id: 7379
title: "Prepared path: publish the stand-in pass count and an all-gaps need cover on every merge"
status: backlog
sprint: Backlog
created: 2026-11-19
updated: 2026-11-19
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: ir, test262, ci
goal: ir-full-coverage
related: [7354, 7106, 7349, 7350, 7352]
---

# Prepared path: a metric that moves, and a census that shows every gap

Source: `plan/log/ir-migration-strategy-review-2026-11-19.md` (strategy review, 2026-11-19, main `89e47482`). Recommendation R2.

## Problem

- The CI figure for the Prepared path read 415 / 9,029 ES5 (all of them `negative:` tests) in all 15 per-merge runs
  from 2026-11-16 to 11-19, before and after the 10 merged #7354 PRs (job "merge complete IR standalone
  measurement"). A metric that stays at zero until every prelude slice lands cannot steer work or catch a regression.
- The census of PR #7308 records only the first gap per file. By syntax (TypeScript parse of all 8,717 positive ES5
  files, 2026-11-19), only 1,491 of 8,254 first-gap files (18 %) are freed by solving their own first-gap family;
  files need a median of 3 mechanism groups. Planning from the first-gap lists overstates each lane about fivefold,
  the same error `plan/log/ir-behind-the-selector-2026-11-13.md` found on the ordinary pipeline.
- `benchmarks/results/test262-ir-status.json` on main still says `state: "unavailable"`.

## To decide

- Which figures are published per merge: real-prelude pass, stand-in pass (148 today), compile crashes (495 today),
  and the cumulative need cover.
- Whether the need cover is syntactic (cheap, an upper bound) or comes from a "continue past the first gap" mode of
  the Prepared producer.
- Where the series is stored so the site and the lanes read one file.

## Acceptance criteria

1. Each merge to main records real-prelude pass, stand-in pass and crash count for ES5 on the Prepared path in a
   committed or published artifact with history.
2. A committed script produces, per file, the full set of mechanisms it needs, and a cumulative cover table.
3. Lane planning documents cite the cover table, not the first-gap lists, for yield.
4. A drop in stand-in pass or a rise in crashes fails or flags the merge.
