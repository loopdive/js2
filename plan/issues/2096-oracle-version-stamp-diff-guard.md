---
id: 2096
title: "oracle_version stamping + cross-version diff guard (prerequisite for the #1945 oracle flip)"
status: ready
sprint: 63
created: 2026-06-11
updated: 2026-06-12
priority: high
feasibility: easy
reasoning_effort: low
task_type: infrastructure
area: testing
language_feature: n/a
goal: correctness
related: [2092]
origin: "2026-06-11 analysis program (report 06 §3); stub 08-C11"
---

# #2096 — oracle upgrades must not read as regressions

## Problem

Tightening the test262 oracle (the #1945 error-type upgrade that makes 10+
trap-vs-TypeError bugs visible) flips pass rows to fail. Without a version
stamp, every PR after the flip diffs apples to oranges and the regression
gate fires on oracle skew, not code changes.

## Root cause

JSONL rows and merged reports carry no oracle identity.

## Plan

Stamp `oracle_version` in result rows and baselines; teach
scripts/diff-test262.ts to refuse cross-version diffs unless
`ORACLE_REBASE=1`; `promote-baseline` re-seeds at the new version on the
flip PR's merge. Filed separately from #1945 so the protocol has an owner
even if #1945's steps split.

## Acceptance criteria

- Cross-version diff refused with a clear message; flip PR merges without
  tripping the regression gate; post-flip PRs diff clean

## Dupe check

#1945 (upstream slug, oracle precision) covers the oracle change itself;
the versioning protocol is unfiled. New (analysis program).
