---
id: 2147
title: "reconcile-tasklist.mjs: flag ready issues whose number appears in a merged PR title"
status: ready
sprint: 63
created: 2026-06-12
updated: 2026-06-12
priority: medium
feasibility: easy
reasoning_effort: low
task_type: infra
area: tooling
language_feature: compiler-internals
goal: process
related: []
origin: "2026-06-12 sprint-62 planning triage — 11 issues (#1991, #2002-#2006, #2018-#2020, #2027, #2078) sat at ready though their fix PRs had merged; a dev WILL claim already-fixed work"
---

# #2147 — stale `ready` frontmatter poisons dispatch

## Problem

The sprint-62 planning triage found 11 sprint-61 issues still `ready` whose
fixes had already merged (PRs #1321/#1326/#1329/#1333/#1352/#1354). The
existing reconciler (`scripts/reconcile-tasklist.mjs`) only cross-checks
TaskList entries against issue frontmatter — it never checks issue
frontmatter against merged PRs, so the drift source is unwatched.

## Approach

Extend the reconciler: fetch merged PR titles (`gh pr list --state merged`),
extract `#NNNN` references, and report every issue at `ready`/`in-progress`
whose number appears in a merged PR title. Wire into the session-start hook
output (report-only; flipping stays manual/PO).

## Acceptance criteria

- Running the script after a merge that cites #NNNN flags the issue within
  one session.
- Zero false flags on plan-only PRs (`plan:`/`docs:`-prefixed titles
  excluded or down-ranked).

## Notes

Routine dev, S-size, sprint 63. PO owns the flips.
