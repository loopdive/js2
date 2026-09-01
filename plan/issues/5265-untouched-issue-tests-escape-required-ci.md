---
id: 5265
title: "CI residual: a source change can regress `tests/issue-*.test.ts` files it does not touch, and NO required check runs them — 5 such regressions measured in one PR"
status: ready
sprint: current
created: 2026-09-01
updated: 2026-09-01
priority: high
horizon: m
complexity: M
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci, tests
language_feature: compiler-internals
es_edition: multi
goal: ir-full-coverage
lane: ir-retirement-r4
related: [3008, 3340, 3347, 3552, 5259, 5266, 3523]
---

# A source change can silently regress issue tests it does not touch

## Problem

#3008 wired PR-touched `tests/issue-*.test.ts` into `quality` (changed-root,
FATAL) and #3552 added a curated required guard suite. Both are real
improvements and both are scoped to files that are either **touched by the PR**
or **on a hand-curated list**. The residual is the complement:

> a change to `src/` that breaks an issue test the PR does not touch, and that
> is not on the guard list, is invisible to every required check.

#5259 documents the same three composing conditions from the rot side (a file
red on main stays red); this issue is the other direction — a green file going
red — and #5259 explicitly scopes the CI change out ("covers the minimal
repair, not a CI redesign").

## Evidence — this is not hypothetical

During #3523 gap 4 (PR #5367, merged), the change added one observed-outcome
row per statement-free source. A deliberate base-vs-branch sweep over the 170
test files that reference `irOutcomes` / `IrObservedOutcome` /
`irBodyRouteAudit` found **5 real regressions in 3 files the PR never touched**:

| file | regressions | nature |
| --- | --- | --- |
| `tests/issue-4502.test.ts` | 3 | its `outcomeCodes` helper treated any non-`emitted` row as a capability gap, so the new observational row read as a CLOSED capability gap REOPENING — a false regression signal in the file whose whole purpose is catching that |
| `tests/issue-4267-overload-inventory-owner.test.ts` | 1 | fixture enumerating every row's `displayName` |
| `tests/issue-4268-generic-overload-optional-abi.test.ts` | 1 | same |

**PR #5367 was CLEAN — all six required checks green — while all five were
live.** They were found only because the sweep was run by hand. Had it not
been, they would have merged and surfaced post-merge, in files nobody was
looking at.

The same sweep confirmed 18 further failures across 8 other files as
**pre-existing** on `origin/main` (catalogued in #5266), so the sweep also
discriminates: it did not raise those as regressions.

## Acceptance criteria

Any of these that the team judges affordable; the goal is that the class stops
being invisible, not a specific mechanism:

1. A required (or reliably-reported) job that runs a MEANINGFUL superset of
   issue tests — e.g. all `tests/issue-*.test.ts` in a sharded job, with a
   known-red allowlist so the suite's current uncleanliness does not block it
   (the allowlist is then the debt register, and #5266 seeds it).
2. Or: a reverse-dependency selector — given the `src/` files a PR changes,
   run the issue tests that exercise them — so "untouched" stops meaning
   "unrun".
3. Or, minimally: promote the existing `issue-tests` job's changed-files step
   off `continue-on-error` once the suite is clean, and grow the pinned list
   (currently ONE file) on a schedule.
4. Whatever is chosen, document how a PR author is expected to detect this
   class today, since the honest current answer is "run a manual base-vs-branch
   sweep".

## Notes

The manual procedure that found the five, for whoever automates it: take the
test files matching the changed subsystem, run them on the branch, run them
again with the changed `src/` files replaced by their `origin/main` versions,
and diff the failing-test NAME sets. Comparing counts is not enough — the base
and branch failure sets overlapped heavily here.
