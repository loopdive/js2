---
name: reference_autoenqueue_grace0_races_mergestate_recompute
description: "auto-enqueue's grace-0 workflow_run trigger fires ~1s after CI and beats GitHub's async mergeStateStatus recompute, so it no-ops and green PRs wait for the ~30-min cron"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-25T23:35:19.404Z
---

`auto-enqueue.yml` fires on `workflow_run` completion with **grace 0** (#2786).
Measured 2026-07-26 on PR #3619: the CI run finished at **23:32:20Z**, the
auto-enqueue run fired at **23:32:21Z — one second later** — and reported
`Done: 0 branch-updated, 0 enqueued`. The same PR read `CLEAN` two minutes later
at 23:34:29Z.

**Mechanism:** GitHub recomputes `mergeStateStatus` **asynchronously** after the
last required check reports. At the instant the responsive run queries, the PR is
still `BLOCKED`/`UNKNOWN`, so the enqueuer correctly sees "not enqueueable" and
no-ops. The PR then waits for the **~30-min cron backstop**.

**Why this matters:** grace 0 was adopted precisely to make enqueue responsive and
to stop relying on an agent surviving. This race silently defeats that — the
responsive path structurally loses whenever recompute is slower than ~1s, and the
system quietly degrades to the cron. It is a **systematic** source of the
"green PR sits un-enqueued" strays the shepherd sweep exists to mop up, NOT a
rare flake.

**Candidate fixes** (untried): a small grace window, or re-poll
`mergeStateStatus` inside `scripts/enqueue-green-prs.mjs` until it leaves
`UNKNOWN` before deciding.

**Diagnostic:** when a PR is green but never enqueued, check whether an
auto-enqueue run fired within a few seconds of CI completion and reported
`0 enqueued`. That is this race, not a broken PR.

Distinct from [[reference_workflow_touching_prs_never_autoenqueue]] (ruleset
blocks the app token — that one NEVER succeeds, cron included).
