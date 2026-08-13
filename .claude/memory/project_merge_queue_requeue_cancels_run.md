---
name: project-merge-queue-requeue-cancels-run
description: "Merge_group runs cancelled mid-flight (head never completes, main stuck) = queue membership churn. Re-adding the PR that is IN the in-flight group cancels its run; a tail append of another PR does not. Don't poke the head while its run is in flight."
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

# Merge-queue CANCELLATION churn (3rd failure mode, distinct from wedge & dup-ID)

**Symptom**: head sits `AWAITING_CHECKS`; merge_group runs ARE created but never
finish — each is cancelled ~5–15 min in (partway through the 114-job matrix),
the head's run restarts or rotates to the next PR, main never advances. Looks
like repeated test262 "failures" but they are NOT failures.

**THE diagnostic that ends the confusion**: open a "failed" merge_group run's
jobs and count `conclusion=="failure"` jobs. ZERO failed jobs = CANCELLED (queue
rebuild), ≥1 = REAL failure. **CRITICAL — use the PAGINATED API, NOT
`gh run view --json jobs`.** `gh run view <id> --json jobs` only returns ~the
first page (~30 jobs) and does NOT paginate, so on a 114+-job merge_group run it
UNDER-counts and a REAL failure looks like a cancellation (this fooled me on
#1787 2026-06-20: `gh run view` showed `30 success / 0 failure`, but the run had
**2 genuinely-failed jobs** — a real −50-test regression). Authoritative:
`gh api "repos/<repo>/actions/runs/<id>/jobs?per_page=100" --paginate -q '.jobs[]|select(.conclusion=="failure")|.name'`.
(The auto-park workflow uses exactly this paginated fetch — trust it.)
If genuinely ZERO failed jobs across all pages → CANCELLED; `quality` (ci.yml) shows `success` every cycle. Real
regression = a shard job with `conclusion=failure`; cancellation = only
success+(missing) jobs.

**Root cause**: GitHub invalidates/rebuilds a merge group when the queue
**membership or order changes in a way that affects that group**. The culprits
2026-06-20 (in order of impact):
- **`queue-unstick.yml` (THE engine, root cause of the 2h stall — GONE as of
  2026-08-02, see the re-verification below)** — fires on
  EVERY `workflow_run` completion (so ~every 2 min during active CI). Its
  `unstick-merge-queue.mjs` does **dequeue + re-enqueue of the head** to clear a
  *wedge* (the zero-runs GITHUB_TOKEN wedge). But when the head is legitimately
  RUNNING (not wedged), that dequeue/requeue **cancels its in-flight run** →
  head goes AWAITING_CHECKS again → unstick fires again → perpetual churn. It
  cannot tell "wedged" (needs a nudge) from "running" (must be left alone). FIX:
  `gh api -X PUT repos/loopdive/js2wasm/actions/workflows/queue-unstick.yml/disable`
  while draining; verify `.state == disabled_manually` (a `gh workflow disable`
  can silently not stick — confirm via API). The unstick script needs a guard:
  only nudge a head whose AWAITING_CHECKS age exceeds a run's worth of time AND
  that has zero in-flight merge_group runs.
- **auto-enqueue** (`enqueue-green-prs.mjs`) re-adding ejected/trailing PRs —
  races its own back-off guard; secondary contributor.
- **the operator** (me) dequeuing/enqueuing/holding/drafting on every check —
  added to the churn (I wrongly blamed this as primary; unstick was the engine).
  Still: an 11-PR queue drained fine at 05:00 before any poking; once unstick is
  off, leave the queue alone.

## RE-VERIFIED 2026-08-02 — the rule is NARROWER than it was written

Two things changed since 2026-06-20, and the original phrasing ("*anything*
that dequeues/enqueues/re-adds a PR while a run is in flight cancels that run")
was over-broad even then.

**1. The engine is gone.** `queue-unstick.yml` and `scripts/unstick-merge-queue.mjs`
no longer exist on `main` — the workflow that fired on EVERY `workflow_run`
completion and dequeue+re-enqueued the head is deleted, not merely disabled.
The only queue-touching workflow left is `auto-enqueue.yml`.

**2. Appending to the TAIL does not cancel anything.** GitHub's docs: a new
entry's group contains "the target branch and pull requests **ahead of** it in
the queue", so adding behind the head leaves the head's group intact. What DOES
rebuild: removing an entry (the ones behind it are recreated) and reordering —
*"jumping to the top of a merge queue will cause a full rebuild of all
in-progress pull requests, as the reordering of the queue introduces a break in
the commit graph."*

**3. This repo runs with NO speculation** (ruleset, verified 2026-08-02):
`max_entries_to_build: 1`, `max_entries_to_merge: 1`, `grouping_strategy:
ALLGREEN`, `check_response_timeout_minutes: 120` (the "60" cited below is
stale). The building group is the head PR alone, so a tail append has nothing
behind it to rebuild.

**What is still true — the actual rule:**
> Re-enqueueing a PR that is **currently in the in-flight merge group** is a
> dequeue + re-add of that entry and DOES cancel its run. Appending a different,
> not-yet-queued PR to the tail does not. Never dequeue/re-add/reorder the head
> while its run is in flight.

**Empirics (2026-08-02, last ~1.5 days, 500 `merge_group` runs):** 488 success,
8 failure, **2 cancelled (0.4 %)** — both with 97 success / 0 failed jobs, i.e.
the cancellation signature below. In June this was the norm; it is now rare.
NOT verified: what triggered those 2 (a PR ahead merging, a dequeue, and
auto-park are all candidates), and there is no controlled experiment proving a
tail append never cancels — only GitHub's documented model plus the low rate.

**Unchanged by this re-verification:** "the single enqueuer is the server-side
`auto-enqueue.yml`; devs/agents do not enqueue." That rule's real justification
is #2786 (a dev's backgrounded CI watcher dies on stand-down, stranding green
PRs), not cancellation churn — so it stands on its own.

**Fix / discipline**:
1. **Don't touch the HEAD while its run is in flight.** No dequeue/re-add/
   reorder mid-run. Pick the action, then leave it ALONE for a full run
   (~15 min). Appending a new PR behind it is safe.
2. To drain when it's stuck: **dequeue ALL, then PAT-enqueue ONE PR, then hands
   off** until it merges; repeat. PAT/App enqueue (not GITHUB_TOKEN — see
   [[project_merge_queue_wedge_github_token]]) creates a fresh run and clears the
   dangling cancelled-check state.
3. A cancelled run leaves a dangling "expected" check; the head can sit
   AWAITING_CHECKS until the ruleset `check_response_timeout_minutes` (120 as of
   2026-08-02) fires.
   Dequeue+PAT-re-enqueue resets it instead of waiting.
4. If genuinely clean PRs (quality green, 0 failed shard jobs) stay stuck, they
   are mergeable — admin-merge is justified to bypass a self-inflicted queue
   tangle.

**Three merge-queue failure modes — keep them straight**:
- WEDGE: 0 runs created → GITHUB_TOKEN enqueue. [[project_merge_queue_wedge_github_token]]
- DUP-ID CHURN: runs fire, `quality` fails "N duplicate IDs" → stale issue-ID
  collision. [[project_merge_queue_dup_issue_id_churn]]
- CANCELLATION CHURN (this): runs fire but cancelled mid-flight, 0 failed jobs →
  the HEAD's group was rebuilt (re-add / reorder / removal ahead of it). STOP
  poking the head; one PR at a time; hands off. Rare since `queue-unstick.yml`
  was deleted — see the 2026-08-02 re-verification above.
