---
id: 4753
title: "ES2015 authoritative Test262 close-out handoff"
status: in_progress
created: 2026-08-26
updated: 2026-08-26
priority: high
horizon: l
feasibility: medium
reasoning_effort: max
task_type: conformance
area: test262, integration
es_edition: es2015
goal: test262-conformance
related: [4444, 4751, 4752]
---

# #4753 — ES2015 authoritative Test262 close-out handoff

## Objective

Prove and, where necessary, complete 100% ES2015 Test262 conformance on the
combined implementation branch represented by upstream PR #4974:

<https://github.com/loopdive/js2/pull/4974>

Success requires zero non-passing rows in each required project lane under the
maintained `scripts/run-test262-vitest.sh` runner. Focused issue tests and stale
benchmark artifacts are supporting evidence only; they cannot close this issue.

## Current state

- Combined branch: `codex/es6-conformance-combined` on the `ttraenkler/js2`
  fork, targeting `loopdive/js2:main` in PR #4974.
- Handoff head before this issue commit: `df70faa5e`.
- The first combined CI run found one integration-only dead helper. Issue
  #4752 deleted it; the dead-export gate now reports 23 known entries and 0
  new entries.
- Generator close suites #4716/#4718 pass 26/26 after that repair.
- TypeScript 5/7, host-import policy, LOC/function budgets, oracle/coercion
  ratchets, issue integrity/IDs, formatting, and the full pre-push pipeline
  pass locally.
- The file-edition map has 11,778 ES2015 labels. The maintained runner excludes
  `intl402`; exactly 74 labelled files are under that root, leaving the
  documented 11,704-test ES2015 bucket.
- A detached measurement worktree was prepared at
  `/private/tmp/js2-es6-authoritative-measure` on `df70faa5e`. Its dependency
  provisioning linked `node_modules`, but `test262` still needs to be linked
  from `/Users/thomas/Code/js2/test262` before measurement.

## Implementation plan

1. Refresh the measurement worktree to the latest PR #4974 head and provision
   `node_modules`, `test262`, and the shared Test262 cache without modifying the
   dirty root worktree.
2. Generate an exact temporary filter from
   `website/public/benchmarks/results/test262-file-editions.json`: retain rows
   whose edition index is `ES2015` and whose path does not start with
   `intl402/`. Assert exactly 11,704 distinct paths and verify positive-control
   paths exist before running.
3. Run the maintained runner with two workers and `--official-scope-only` for
   the host (`TEST262_TARGET=gc`) and standalone (`TEST262_TARGET=standalone`,
   default QuickJS eval provider) lanes. Preserve both timestamped JSONL files
   and reports. Record pass/fail/compile-error/skip denominators separately.
4. Rerun every non-passing row alone before attribution. Partition confirmed
   residuals into narrow semantic clusters, allocate one issue markdown per
   cluster, and dispatch Luna/max agents in separate git worktrees. Agents must
   commit clean branch tips for integration into PR #4974; do not open separate
   component PRs.
5. Integrate each branch into `codex/es6-conformance-combined`, rerun its exact
   pins and controls plus repository gates, then repeat both complete 11,704-row
   lanes. Continue until both authoritative reports contain zero non-passing
   rows.

## Suggested measurement commands

Use the repository's configured Node/pnpm path, then create a temporary filter
outside the repository. The run environment must include:

```text
TEST262_WORKERS=2
TEST262_PATH_FILTER_FILE=<absolute path to the verified 11,704-row filter>
TEST262_TARGET=gc               # first lane
TEST262_TARGET=standalone       # second lane
pnpm run test:262 -- --official-scope-only
```

The runner holds a global Test262 lock, so the two complete lanes run
sequentially. Do not substitute the legacy runner or infer full-bucket results
from focused tests.

## Acceptance

- Fresh host report: 11,704/11,704 pass, 0 fail, 0 compile error, 0 skip.
- Fresh standalone report: 11,704/11,704 pass, 0 fail, 0 compile error, 0 skip.
- Every implementation cluster has an issue plan and exact regression tests.
- Combined PR #4974 is green and remains the sole upstream ES6 implementation
  PR, with `loopdive/js2:main` as its base.

## Handoff

Do not mark this issue or the ES6 conformance goal done until both complete
reports satisfy the denominators above. The immediate next action is to update
the detached measurement worktree to the latest PR head, link `test262`, create
and validate the exact filter, and start the host lane.
