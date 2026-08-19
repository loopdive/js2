---
id: 4153
title: "`test262-sharded.yml`'s own header claims PR-time shard runs; the job `if:` conditions make them merge_group-only"
status: done
completed: 2026-08-04
sprint: 78
created: 2026-08-04
updated: 2026-08-18
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

## Guard — `tests/issue-4153-test262-sharded-pr-gating.test.ts`

A prose-only fix has no guard of its own, which is precisely how the *first*
comment rotted for months without anyone noticing. Correcting the wording
without pinning it just resets the clock.

`tests/issue-4153-test262-sharded-pr-gating.test.ts` pins the comment and the
conditions to each other. Three arms, each able to fail independently:

1. **The conditions** — `test262-shard`'s `if:` admits `push` and
   `workflow_dispatch` and never mentions `pull_request`; `test262-shard-mg`'s
   `if:` requires `merge_group`. Read from the jobs themselves.
2. **The header** — the exact stale claim is absent and the header states the
   matrix does not run at PR time. Arm 1 alone would let the comment rot again
   while the conditions stayed correct — the original defect.
3. **The wiring** — `merge-report`'s `SHARDS_RAN` is derived from the two
   matrix jobs' results, which is *why* a PR-time skip surfaces as a green
   no-op rather than a failure.

If PR-time shards are ever deliberately restored, arms 1 and 2 fail together
and force the header to be updated with them. That is the intent, not a false
positive.

**Non-vacuity — demonstrated, not assumed.** String assertions over a
1,100-line file pass easily for the wrong reason, so both arms were mutated and
observed to go red on this checkout (2026-08-04):

| mutation | result |
| --- | --- |
| stale claim spliced back into the `on:` header | 2 failed / 5 passed |
| `workflow_dispatch` → `pull_request` in `test262-shard`'s `if:` | 1 failed / 6 passed |

Unmutated: 7/7 pass in ~5 ms. The suite also asserts its own extraction
(non-empty job block containing the job key) before trusting it, so a rename
that broke slicing surfaces as a failure rather than as silent green.

## Acceptance criteria

- [x] The header describes the actual `if:` gating.
- [x] It states plainly that a green PR-level test262 check is not conformance
      evidence.
- [x] No workflow behaviour changed.
- [x] A permanent guard stops the header and the `if:` conditions drifting
      apart again, and its non-vacuity is demonstrated rather than asserted.
