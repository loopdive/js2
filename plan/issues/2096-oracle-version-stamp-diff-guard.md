---
id: 2096
title: "oracle_version stamping + cross-version diff guard (prerequisite for the #1945 oracle flip)"
status: done
sprint: 63
created: 2026-06-11
updated: 2026-06-16
completed: 2026-06-16
assignee: ttraenkler/dev-b
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

## Resolution (2026-06-16, dev-b)

Implemented the version-stamp protocol:

- **Single source of truth**: `tests/test262-oracle-version.ts` exports
  `ORACLE_VERSION` (opaque monotonic integer, currently `1`) plus an
  append-only `ORACLE_VERSION_HISTORY`. A "HOW TO BUMP" doc-comment ties the
  bump to the `ORACLE_REBASE=1` flip PR — this is the owner the issue asked for.
- **Row stamp**: `recordResult` (`tests/test262-shared.ts`) writes
  `oracle_version` on every JSONL row.
- **Report stamp**: `scripts/build-test262-report.mjs` carries
  `oracle_version` on the merged report and sets `oracle_version_mixed: true`
  when shards disagree (a mixed report must never be promoted).
- **Diff guard**: `scripts/diff-test262.ts` reads the oracle version from both
  JSONLs and **refuses a cross-version diff with exit 2** unless
  `ORACLE_REBASE=1`. A MIXED file is a hard error (exit 2) regardless of the
  flag. Unstamped (pre-#2096) files fall back to legacy same-oracle behaviour
  with an informational note. Exit 2 slots into the existing
  `test262-sharded.yml` contract, which already treats `diff_exit > 1` as a
  hard CI failure — so the gate halts on oracle skew instead of reading it as
  regressions.
- **Re-seed path**: `promote-baseline` needs no change — on the flip PR's
  merge it promotes main's JSONL, which already carries the bumped version.

Tests: `tests/issue-2096.test.ts` (7 cases) — same-version diff, cross-version
refuse, `ORACLE_REBASE=1` allow, mixed hard-refuse, unstamped legacy, and
report stamping/mixed-flag. All pass.
