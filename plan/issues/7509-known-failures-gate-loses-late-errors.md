---
id: 7509
title: "known-failures gate loses an error a test schedules after its file's last hook"
status: done
sprint: current
created: 2026-11-26
updated: 2026-11-26
completed: 2026-11-26
priority: high
horizon: s
feasibility: easy
reasoning_effort: high
task_type: bugfix
area: ci
goal: core-semantics
related: [7501, 7014, 6783]
---

# #7509: the known-failures gate loses an error scheduled after a file's last hook

## Problem

The gate runs vitest with forks and isolation. vitest tears a file's worker
down as soon as the file's last hook ends. An error that a test schedules to
fire later (a timer that rejects, a callback that throws) therefore never
fires, and the run has no record of it at all. The gate's integrity rule
refuses every unattributed error, but it cannot refuse an error that never
reaches it.

This is the opposite blind spot to #7501: an error that is lost, not one that
is left unnamed. RV7455 found it on PR #7455 (comment 7190718997): a file whose
timer rejects after its last test produced no run-end record, on that PR and on
main alike.

## Repro

```js
// late.test.js
import { it, expect } from "vitest";
it("ok", () => {
  setTimeout(() => Promise.reject(new Error("late rejection")), 50);
  expect(1).toBe(1);
});
```

Run it through `runFiles` from `scripts/known-failures-gate.mjs`.

| | main 1a726b3e64 | this change |
|---|---|---|
| a repo test file (`tests/zz-late-probe.test.ts`, scratch, not committed) run through the real gate wiring | file `passed`, **no integrity error** | refused: `Error: late rejection from zz-late-probe` |
| the scratch project in the new pin | pin fails (no error recorded) | pin passes |

## Fix

- `scripts/lib/known-failures-late-errors.mjs`: a setup file with one
  `afterAll` that waits a fixed grace period of 100 ms
  (`LATE_ERROR_GRACE_MS`). It is registered first, so under
  vitest's default stack order it runs after the file's own `afterAll` hooks.
  An error that fires during the wait is an unhandled error inside the worker,
  which vitest reports and the gate refuses.
- `vitest.config.ts` adds the setup file only when `KNOWN_FAILURES_PROGRESS`
  is set, which happens only under the gate. vitest 3.2.7 has no
  `--setupFiles` CLI flag, so the config is the only seam. Ordinary
  `vitest run` invocations are unchanged.

Why a fixed grace rather than a deterministic hook: vitest 3.2.7 has no hook
that runs after a file's last test and waits for the timers it left pending.
Waiting until the process's active handles drain
(`process.getActiveResourcesInfo()`) would also wait on vitest's own handles
and on any server a test leaves open, so it could hang instead of ending.

## Cost and limits

- About 100 ms per file under the gate: about 4 min of fork time over the
  ~4,870 root files, spread across the shards (about 20 s per shard at 2
  forks). It also applies to the PR-time `issue-tests-shard` job in `ci.yml`,
  which runs the same gate.
- An error scheduled more than the grace period after the last hook is still
  lost.

## Acceptance criteria

- `tests/issue-7014-integrity.test.ts`:
  - "refuses a rejection a file schedules after its last test" passes, and
    fails without the setup file (checked: it fails when the scratch config
    drops `setupFiles`);
  - "vitest.config.ts adds the late-error setup file only under the gate"
    passes.
- The gate's integrity rule is unchanged: it refuses every unattributed error.
