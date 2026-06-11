---
id: 1958
title: "CI: merge_group checks_requested events intermittently dropped — queue wedges with AWAITING_CHECKS groups that have no check suites"
status: ready
created: 2026-06-11
updated: 2026-06-11
priority: high
feasibility: medium
reasoning_effort: medium
sprint: 61
area: ci
---
## Problem (observed 2026-06-11, twice)

GitHub intermittently fails to deliver `merge_group checks_requested` events
for this repo. The queue then sits with entries in AWAITING_CHECKS whose
group head commits have **no github-actions check suite at all** (only the
third-party app suites: cloudflare/cursor/claude, all `queued runs:0`), and
no workflow runs are ever created for the group refs.

Evidence:

- Window 1: last merge_group run 23:33Z; head entry #1283 stuck >5h;
  recycling the head (dequeue+enqueue, fresh group ref `aabcaa7f…` built)
  produced a group but again no check suite after 20+ min. Unstuck by
  admin-merging two validated PRs at 03:25Z — the main advance rebuilt all
  groups and fresh events were delivered (runs resumed 03:44Z).
- Window 2: after #1343 merged at 04:40Z, no merge_group runs were created
  again; by 05:30Z five concurrent groups (post-#1956 `build=5`) all sat
  AWAITING_CHECKS with no suites.
- Same night, a `pull_request` event was also dropped once (PR #1314's
  initial push produced no workflow runs; an empty-commit `synchronize`
  fixed it) — so this is a delivery-layer problem, not merge_group-specific
  config. githubstatus.com reported all systems operational throughout.

## Current mitigations (already live)

- `check_response_timeout_minutes` lowered 240 → 60 (#1956 ruleset flip):
  a no-show group fails out of the queue after 1h instead of 4h.
- `auto-enqueue.yml` re-enqueues open green PRs every 10 min, so timed-out
  entries re-enter automatically → wedges self-heal on a ~1h carousel
  instead of permanently.
- Main advances (any push) rebuild all groups and re-fire events — observed
  to recover delivery.

## Proposed fix: queue watchdog in merge-group-sweeper.yml (#1952)

The sweeper already runs on a 15-min schedule with an API token. Extend it:

1. Query the merge queue (GraphQL `mergeQueue.entries` with state +
   `headCommit`/position).
2. For each AWAITING_CHECKS entry older than ~10 min, check the group head
   commit's check-suites for a `github-actions` suite
   (`/commits/<sha>/check-suites`).
3. If absent → the event was dropped: `dequeuePullRequest` +
   `enqueuePullRequest` (a fresh group re-rolls delivery). Cap at 1
   recycle/entry/sweep and log loudly. Needs `pull-requests: write` and the
   GraphQL mutations to work with GITHUB_TOKEN (verify; else a PAT/app token).
4. If recycling twice doesn't produce a suite, emit a `::error::` for
   human triage (likely a GitHub support ticket — collect group SHAs and
   delivery timestamps from this issue as evidence).

## Acceptance criteria

- A dropped-event wedge clears within one sweeper cycle (≤15 min) without
  human intervention.
- No recycle ever happens for a group that HAS a github-actions suite
  (in-progress validations are untouched).
