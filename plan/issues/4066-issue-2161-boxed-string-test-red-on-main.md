---
id: 4066
title: "`tests/issue-2161-b1-boxed-string.test.ts` fails on unmodified upstream/main — a red test on main is a broken signal for every branch"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
priority: medium
horizon: s
feasibility: medium
reasoning_effort: high
task_type: bug
area: testing
language_feature: n/a
goal: dogfood
---
# `tests/issue-2161-b1-boxed-string.test.ts` fails on unmodified upstream/main — a red test on main is a broken signal for every branch

> Filed 2026-08-02 from a TaskList entry that had been carrying the full
> analysis but no issue file. The body below is the original measurement
> report, verbatim — it was written by the agent that did the measuring.

Reported by L-evalink 2026-08-01, confirmed by REVERTING its own change and re-running.
Pre-existing on `upstream/main`, not caused by any current work, nobody owns it.

FAILING CASE:
  tests/issue-2161-b1-boxed-string.test.ts
    > "a plain (non-wrapper) object argument does not spuriously become a string"

WHY IT MATTERS MORE THAN ONE TEST: a red test on `main` is a broken signal for every
branch cut from it. An agent that runs the suite sees a failure it did not cause,
and either (a) burns time diagnosing someone else's bug, or (b) learns to ignore
suite failures — which is worse, and is how a real regression gets waved through.
Today an agent lost a full test run to a different pre-existing bug (TaskList #55)
because it presented as an unrelated stack overflow.

LIKELY ADJACENT — check before assuming these are separate: the defect is about a
plain object argument spuriously becoming a string, which is the same *direction* as
the ToPrimitive/ToString(this) gap L-strwith fixed in the transferred-native-proto
work (the four generic reflective bodies skipped ToPrimitive in ToString(this), so an
object receiver stringified as "[object Object]"). Whether this test is a second
instance of that, or a distinct route, is UNMEASURED. Also related in subject matter:
the unclaimed follow-up that an object-literal receiver carrying its own `toString`
still returns null for a transferred member via a closed-struct route that never
reaches `__apply_closure`.

FIRST ACTIONS:
 1. Reproduce on a clean `upstream/main` checkout and confirm it is not
    environment-specific (contention on this box is live; re-run solo).
 2. Determine WHEN it started failing — bisect, or check whether the oracle/verdict
    logic changed under it. A test that was green and silently went red is a
    different problem from one that never passed.
 3. Decide: fix the code, or fix the test if its expectation is wrong. Do NOT skip
    or delete it — never delete test data; if it must be quarantined, say so
    explicitly with a linked issue.

Allocate an id at pickup: `CLAIM_ASSIGN_REMOTE=upstream node scripts/claim-issue.mjs
--allocate --by ttraenkler/<agent>`, and EXPORT GIT_AUTHOR_NAME/GIT_AUTHOR_EMAIL/
GIT_COMMITTER_* first or it exits 6.
