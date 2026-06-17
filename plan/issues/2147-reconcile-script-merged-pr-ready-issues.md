---
id: 2147
title: "reconcile-tasklist.mjs: flag ready issues whose number appears in a merged PR title"
status: done
sprint: 63
created: 2026-06-12
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/dev-b
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

## Resolution (2026-06-16, dev-b)

Extended `scripts/reconcile-tasklist.mjs` with a second drift check:

- New helpers `listIssues()`, `mergedPrIssueRefs()`, `mergedPrStaleIssues()`.
  Fetches merged PR titles via `gh pr list --state merged -L 200 --json title`,
  extracts every `#NNNN` reference, and reports issues still at
  `ready`/`in-progress` whose number is cited by a merged **code** PR.
- **Plan/docs exclusion** — `PLAN_DOCS_TITLE_RE` drops `plan:`/`docs:`/
  `chore(plan)`/`chore(docs)` (and scoped variants) titles so a planning commit
  that merely *mentions* an issue can't false-flag it (acceptance: zero false
  flags on plan-only PRs).
- **At-risk filter** — only `ready`/`in-progress` issues are flagged
  (`done`/`wont-fix`/`in-review`/`blocked`/`backlog` aren't claimable, so a
  stale reference can't poison dispatch).
- Wired into all three output modes (human report, `--quiet` one-liner,
  `--json`). Report-only — does NOT write frontmatter (PO owns the flips).
- Resilient: skips silently with a reason when `gh` is unavailable/
  unauthenticated (CI) or `--no-merged-prs` is passed; never fails the
  SessionStart hook.

Tests: `tests/issue-2147.test.ts` (4 cases — code PR flags a ready issue;
plan/docs PR does NOT flag; `done` issue never flagged; in-progress flagged +
`--no-merged-prs` skip path) all pass via a fixture issues dir and a shimmed
`gh` on PATH.

**Acceptance:**
- [x] Running the script after a merge citing #NNNN flags the issue within one
  session (it runs in the SessionStart hook).
- [x] Zero false flags on plan-only PRs (plan:/docs: titles excluded).
