---
id: 4003
title: "The pre-commit hook cannot pass under load: test:changed-root fails on a vitest RPC timeout while 31/31 tests PASS, and it selects another agent's tests"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
related: []
---

# The pre-commit hook cannot pass under load: test:changed-root fails on a vitest RPC timeout while 31/31 tests PASS, and it selects another agent's tests

## Problem

Measured twice on 2026-08-01 at load 13–15 on 8 cores. `test:changed-root` failed
with:

```
[vitest-worker]: Timeout calling "onTaskUpdate"
```

**31/31 tests PASSED both times.** This is an RPC/reporter timeout — an
infrastructure failure being reported as a test failure.

Two compounding defects:

1. **It ran the WRONG tests.** The file it selected was the **#3912** test — a
   different agent's — chosen only because the changed-file set was computed
   against the fork's diverged `main` (see the gate-base issue filed alongside
   this one). So the hook ran someone else's tests, under contention, and failed
   on infrastructure.
2. **Each failed run leaves debris on the SHARED stash stack.** `lint-staged`
   takes a `git stash` backup before running; when the hook dies the stash is
   orphaned. Two `lint-staged automatic backup` entries were left this way.
   `refs/stash` is a **single stack across every worktree of the repo**, so this
   debris accumulates from every agent and is unattributable from the message
   alone — and blind `pop` has already destroyed ~786 lines here.

There is a third, separate timing hazard: the hook takes ~10 minutes under load
while the agent tool timeout is 2 minutes, so a foreground commit is a coin flip
and losing it produces exactly the debris above.

## Consequence

`--no-verify` becomes the rational choice, which is the wrong equilibrium: the
hook stops being a gate and becomes an obstacle that agents route around. The
disciplined form (run every hook step individually and green first, then
`--no-verify`, then disclose it) works but costs more than the hook saves.

## Fix directions

- Raise or disable the vitest reporter RPC timeout under load, or serialise the
  hook behind a lock so concurrent agents do not contend.
- Compute the changed-file set against `upstream/main`, not `origin/main`.
- Make `lint-staged` use a temp-dir backup rather than the shared `refs/stash`.

Reported by `L-evalink` 2026-08-01; independently corroborated by two other
agents leaving the same stash debris.
