---
id: 5183
title: "Merge queue landed three PRs out of FAILED merge groups — required merge_group checks did not block the merge"
status: ready
sprint: current
created: 2026-08-29
updated: 2026-08-29
priority: critical
horizon: m
feasibility: medium
reasoning_effort: high
task_type: bugfix
area: ci, merge-queue
goal: correctness
related: [2547, 5173, 5175]
---

# #5183 — Merge queue lands PRs out of failed groups

## What happened (2026-08-29, three instances in one night)

Three PRs merged to `main` although their merge-group runs FAILED required
checks:

| PR | group run | failed checks in the group | merged as |
| --- | --- | --- | --- |
| #5199 | 33232469498 | `merge shard reports` (24 unclassified root-causes), `check for test262 regressions` (net −947) | `7e0dbb303e` |
| #5209 | 33233874554 (parked!) then carried in #5211's group | same two | `2fe59c4c10` |
| #5211 | 33234653745 | same two — `merge shard reports` job 99055521433, regressions job 99055521440; the "promote merged report to main baseline" job was `skipped` | in main |

#5209 additionally carried the auto-park `hold` label at merge time — the
label neither prevented re-queueing nor merging.

**Fourth instance (added 2026-08-29 07:06):** #5216 merged at 06:57 while
carrying the `hold` label AND with auto-merge explicitly disabled (the
coordinator had disabled it at ~06:45 to release the branch; `auto_merge:
null` was confirmed before the merge). Its earlier group (run 33236737382)
had failed the same two verdict checks. Whatever merged it did so from a
queue entry that survived both the park and the auto-merge removal.

Verified from the runs themselves (not inferred): the failing step in each is
the VERDICT step ("Standalone root-cause map has 24 unclassified failures;
threshold is 0" / "Fail on regressions"), not setup. The regression they
should have blocked — the 2,580-CE stack-balance (#1058) family, net −947
passes — is live on `main` as of `ddab1b0743`, with the baseline stale
(promote skipped in every failed group).

## Why this is critical

The merge_group re-validation is the ONLY gate that sees the merged state
(PR-level test262 checks are designed green no-ops — see CLAUDE.md). If PRs
merge while that gate is red, every guard downstream of it — auto-park
(#2547), the catastrophic guard (#1668), the net gate — is decorative. This
regression got in and STAYED in through three consecutive red groups.

## Investigation entry points

1. **Which check contexts are required, exactly, versus what the merge_group
   workflow now publishes.** `gh api repos/loopdive/js2/rules/branches/main`
   (docs/ci-policy.md §7 lists six required contexts). If a required context's
   JOB is failing but the queue sees a DIFFERENT (green or skipped) check run
   with the required name on the group head — e.g. after a job rename, a
   matrix restructure, or the #3597 step-naming work — branch protection is
   satisfied by the wrong run. The `test262-pr-stub.yml` pattern (a stub that
   publishes a green context where the real workflow skips) is a candidate
   mechanism for this failure mode reaching merge groups.
2. **Timeline per group**: did the merge happen BEFORE the failing checks
   reported (a race where the queue saw only green-so-far + required-satisfied
   stubs)? Compare check-run timestamps against the merge commit times.
3. **The `hold` label path**: auto-park labels and comments (#2547) are
   advisory to the enqueuer (`auto-enqueue` skips `hold`), but nothing appears
   to eject an already-queued PR when the label lands, and the label does not
   gate the merge itself. #5209 was dequeued and still merged via #5211's
   group — establish how it re-entered.

## Acceptance criteria

1. The mechanism is identified and stated with evidence from the three runs.
2. A red required merge-group check blocks the merge again — demonstrated on
   a deliberately-red test group or by construction with the ruleset.
3. The three bypasses are documented in `docs/ci-policy.md` as an incident
   note, with the fix.
4. Decide and document whether #5199/#5209/#5211 need revert-or-forward-fix
   action beyond the already-owned regression work (the −947 family has an
   owner; this issue is about the GATE).

## Notes

Found during the #5173/#5209 park post-mortem (see that issue's §7 for the
full evidence chain). The regression itself is owned separately (dev lane on
the stack-balance family + #5180); do not fold that fix in here.
