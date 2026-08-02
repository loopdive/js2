---
id: 4078
title: "A long SINGLE-PROCESS test262 sweep poisons its own later results — 19 apparent regressions, 4 real; state leaks across files in the shared process"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: high
horizon: m
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: testing
language_feature: n/a
goal: dogfood
related: [4052]
---

# A long single-process test262 sweep over-counts failures

Measured 2026-08-02 by the `H-crashes` agent while running the regression
control for PR #4007 (#4072).

## The observation

A seeded 500-file regression sample over baseline-`pass` goal-scope files:

| stage | result |
| --- | --- |
| sweep (one process, serial) | 481 pass / 11 fail / 8 error |
| the 19 non-passes, **re-run solo** | **15 passed** |
| the 4 survivors, with the fix reverted | fail identically ⇒ pre-existing |

**0 attributable regressions, against an apparent 19.** ~79 % of the apparent
regressions were artifacts of the sweep itself.

## ⚠ This is NOT the known contention flake

The sweep was **fully serial, single-process** — no 4-way parallelism. Anyone
who has internalised *"parallel runs are flaky, serial runs are trustworthy"*
will walk straight into this.

The mechanism is **state accumulating across files in the shared process**.
Fingerprint: 8 of the 15 false failures shared one compiler-internal signature,

```
Invalid value used as weak map key
```

which appears **only deep into a long run**.

Adjacent to #4052 (`src/runtime.ts` internals are destructible by test262's own
harness — `verifyProperty` deletes realm intrinsics). Confirm whether that is
the same root cause or a second one; **do not assume**.

## Why it matters beyond one PR

Every agent that sizes a bucket, or declares a regression, from one long sweep
is working from an inflated number — inflated in the direction that looks like
*their own change* broke things. It cuts both ways: a long sweep can equally
**mask** a real failure behind an earlier file's corruption.

## Work

1. Root-cause the cross-file state leak (start at the `weak map key` signature).
2. Either isolate per-file state, or make the runner recycle the process on a
   bounded file count.
3. Until fixed, the runner should **warn** when a single-process sweep exceeds
   the threshold where poisoning was observed.

## Interim rule (already in force)

Re-run **every** apparent non-pass **solo** before believing it, then prove
attribution by reverting the change and confirming the survivors fail
identically. That single step turned 19 into 4.
