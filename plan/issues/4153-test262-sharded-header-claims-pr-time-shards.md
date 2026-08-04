---
id: 4153
title: "`test262-sharded.yml`'s own header claims PR-time shard runs; the job `if:` conditions make them merge_group-only"
status: done
completed: 2026-08-04
sprint: current
created: 2026-08-04
updated: 2026-08-04
priority: medium
horizon: s
feasibility: easy
reasoning_effort: low
task_type: bug
area: ci
language_feature: none
goal: dogfood
related: [2519, 2547, 3431, 3467, 4074, 4141]
origin: "Found by the verification-plan architect pass on #4133/#4134, 2026-08-04; independently confirmed by reading the job conditions"
---

# #4153 — a stale comment that makes a green PR look like conformance evidence

## The defect

`.github/workflows/test262-sharded.yml` opened with:

```yaml
on:
  # Serial-queue model: full 57-shard test262 runs at PR-time AND in merge_group.
  # Each PR is validated alone (no ALLGREEN hiding) and developers see test262
  # regressions on PR push (not just at queue-time).
```

That is **not what the workflow does.** Verified by reading the job conditions
on 2026-08-04:

| job | `if:` admits | runs on a PR? |
| --- | --- | --- |
| `test262-shard` | `push` (non-bot) ∧ no mg-artifact hit, or `workflow_dispatch` | **no** |
| `test262-shard-mg` | `merge_group` | **no** |

So on a `pull_request` the two REQUIRED contexts this workflow publishes —
`merge shard reports` and `check for test262 regressions` — green-**skip** with
`SHARDS_RAN: false`, and `regression-gate` no-ops with `HOST_RAN=false`.

The comment describes the pre-#2519 model. The slim-down moved the heavy matrix
to `merge_group`-only and the comment outlived it by months.

## Why it is worth fixing rather than tolerating

A reader trusting that comment concludes a green PR-level test262 check means
"this PR causes no conformance regressions". It means nothing of the sort. The
real regression, trap-ratchet (#3189) and standalone-floor gates run only in the
`merge_group` re-validation on the merged state — which is precisely why
`auto-park` (#2547) exists and why a fully-green PR can still be parked.

This is not hypothetical. PR #4074 was parked three times on an apparent
`null_deref` regression that PR-level checks could not have surfaced; the cause
turned out to be a baseline/candidate scope asymmetry (#4141), not a regression
at all. The gap between "green PR" and "validated" is exactly the gap this
comment denies exists.

`CLAUDE.md` already documents the truth ("PR-level `check for test262
regressions` green is a DESIGNED no-op"), so the workflow's own header
contradicted the project's documentation. Of the two, the comment sitting three
lines above the `pull_request:` trigger is the one a reader will believe.

## Fix

Replaced the header with an accurate description: which jobs run where, what the
required contexts actually publish at PR time, and a pointer to why `auto-park`
exists. Kept a note recording what the old comment claimed and when it stopped
being true, so the next reader can tell "deliberately changed" from "nobody
updated it".

Comment-only — no behaviour change to any job.

## Acceptance criteria

- [x] The header describes the actual `if:` gating.
- [x] It states plainly that a green PR-level test262 check is not conformance
      evidence.
- [x] No workflow behaviour changed.
