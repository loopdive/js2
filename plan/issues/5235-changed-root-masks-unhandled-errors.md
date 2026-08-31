---
id: 5235
title: "Required changed-root test gate masks real unhandled rejections"
status: ready
sprint: current
created: 2026-08-31
updated: 2026-08-31
priority: high
horizon: s
feasibility: medium
reasoning_effort: max
task_type: infrastructure
area: testing, ci
language_feature: n/a
goal: dogfood
related: [3008, 3552, 4003]
requested_by: ttraenkler/codex-sol-ultra
---

# #5235 — stop suppressing the changed-root gate's entire async-error channel

## Problem

`scripts/hooks/changed-root-tests.sh:74-79` documents one infrastructure
failure it wants to tolerate: a spurious Vitest worker RPC timeout while all
assertions pass under load (#4003). The implementation at lines 80-85 applies
`--dangerouslyIgnoreUnhandledErrors` to every changed root test file.

That flag does not classify the one RPC timeout. It disables Vitest's complete
unhandled-rejection/uncaught-exception failure channel, including real
application/test faults. This script is the required PR gate wired at
`.github/workflows/ci.yml:523-540`.

## Deterministic reproduction

A temporary test with one green assertion plus:

```js
Promise.reject(new Error("AUDIT_SENTINEL_UNHANDLED_REJECTION"));
```

was run with the gate's pool and single-fork settings:

- without the dangerous flag: 1 assertion passed, 1 unhandled rejection,
  exit **1**;
- with the flag: the identical rejection was printed, 1 assertion passed,
  exit **0**.

Vitest itself warns that ignored unhandled errors can make tests false-positive.
This is the unsafe workaround for #4003, not a duplicate of #4003's RPC-timeout
root cause.

## Impact

A PR can add or modify a regression test that appears green while asynchronous
work throws after/beside its assertions. For a newly added or otherwise
unpinned root test, this is the only required generic gate that runs that file;
guard and explicitly pinned files can have additional owners. The log may show
a warning, but this required-check consumer receives success.

## Direction

Remove the blanket flag. Fix the birpc starvation/timeout or classify only the
exact infrastructure-only `onTaskUpdate` condition after proving that the test
process completed faithfully. A narrow wrapper must preserve all unrelated
unhandled errors as fatal.

## Acceptance criteria

- [ ] A green assertion plus a sentinel unhandled rejection exits non-zero.
- [ ] An ordinary green file exits 0 and an ordinary failed assertion exits
      non-zero under the changed-root command.
- [ ] Any special treatment for the exact worker RPC timeout is narrowly
      matched, observable, and has a positive/negative subprocess test.
- [ ] An unrelated unhandled rejection can never satisfy required CI even when
      its assertions are green.
- [ ] The #4003 under-load scenario has an explicit operational resolution so
      contributors are not pushed back toward bypassing hooks.
