---
id: 4009
title: "tests/issue-2161-b1-boxed-string.test.ts fails on unmodified upstream/main — a red test on main is a broken signal for every branch"
status: ready
sprint: current
created: 2026-08-01
updated: 2026-08-01
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: testing
language_feature: n/a
goal: dogfood
related: []
---

# tests/issue-2161-b1-boxed-string.test.ts fails on unmodified upstream/main — a red test on main is a broken signal for every branch

## Problem

```
tests/issue-2161-b1-boxed-string.test.ts
  > "a plain (non-wrapper) object argument does not spuriously become a string"
```

fails on **unmodified `upstream/main`**. Confirmed by reverting an unrelated
change and re-running.

## Why this is worth more than one test

A red test on `main` is a **broken signal for every branch cut from it**. An agent
running the suite sees a failure it did not cause and either burns time diagnosing
someone else's bug, or learns to ignore suite failures — and the second is worse,
because it is how a real regression gets waved through. On 2026-08-01 an agent
lost a full test run to a *different* pre-existing bug that presented as an
unrelated stack overflow.

## Likely adjacent — check before assuming it is separate

The defect is a plain object argument **spuriously becoming a string**, which is
the same direction as a ToPrimitive/`ToString(this)` gap fixed the same day: four
generic reflective bodies skipped `ToPrimitive`, so an object receiver stringified
as `"[object Object]"`. Whether this test is a second instance of that or a
distinct route is **UNMEASURED**.

Also related in subject matter: an object-literal receiver carrying its own
`toString` still returns `null` for a transferred member, via a closed-struct
route that never reaches `__apply_closure`.

## First actions

1. Reproduce on a clean `upstream/main` checkout; re-run **solo** (contention on
   the shared box is live and produces phantom failures).
2. Determine **when** it started failing — a test that was green and silently went
   red is a different problem from one that never passed.
3. Fix the code, or fix the test if its expectation is wrong. **Do not skip or
   delete it**; if it must be quarantined, say so explicitly with a linked issue.

Reported by `L-evalink` 2026-08-01, confirmed by revert.
