---
id: 1954
title: "CI: opt-in path-scoped PR-time test262 runs (wire #1521's TEST262_PATH_FILTER into the shard matrix)"
status: done
created: 2026-06-11
updated: 2026-06-11
completed: 2026-06-11
priority: medium
feasibility: easy
reasoning_effort: medium
sprint: 61
depends_on: [1521]
area: ci
---
## Problem

Every push to every PR runs the full 114-job test262 matrix. For narrowly
scoped PRs (one builtin family, one RegExp phase) most of that volume is
spent re-validating ~43k unaffected tests at PR-time, even though the merge
queue runs the authoritative full matrix again anyway.

The runner-side mechanism already exists (#1521): `TEST262_PATH_FILTER`
(pipe-separated substrings, matched against the test262-relative path) is
applied in `runTest262Chunk` *before* source read/compile, so filtered-out
tests cost nothing. It was never wired into the CI workflow.

## Fix (implemented by this issue's PR)

In `test262-sharded.yml`, a step on the shard job (pull_request only) reads an
opt-in scope directive from the PR body:

```
test262-scope: built-ins/RegExp|language/statements/for-of
```

- Directive present → exported as `TEST262_PATH_FILTER` for the shard run;
  the run validates only matching tests. The regression gate is informative
  at PR-time in scoped mode (the scoped JSONL is necessarily a subset).
- No directive (default) → full run, identical to today.
- **Never applied to merge_group / push / dispatch** — the queue always
  validates the full corpus, so nothing can merge with an unvalidated
  regression; a scoped PR's miss is caught at queue-time and bounces.

## Guard rails

- Scoping is explicitly opt-in per PR; agents/devs should only scope PRs whose
  blast radius is genuinely local (builtin-family fixes, test-only changes).
- The merged JSONL from a scoped run carries only the scoped subset; the
  regression-gate diff naturally restricts itself to entries present in both
  baseline and candidate, so it gates the scoped area and stays silent on the
  rest (queue-time covers the rest).
- dev-self-merge note: `net_per_test` from a scoped PR run reflects the scope
  only; the queue's full run remains the authority.
