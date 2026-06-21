---
name: project-merge-queue-requeue-cancels-run
description: "Merge_group runs cancelled mid-flight (head never completes, main stuck) = queue membership churn — every dequeue/enqueue/re-add invalidates the in-flight group. Don't poke a queue with a run in flight."
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

**Root cause**: GitHub invalidates/rebuilds a merge group whenever queue
**membership or order changes**. So *anything* that dequeues/enqueues/re-adds a
PR while a run is in flight cancels that run before it can complete. The
culprits 2026-06-20 (in order of impact):
- **`queue-unstick.yml` (THE engine, root cause of the 2h stall)** — fires on
  EVERY `workflow_run` completion (so ~every 2 min during active CI). Its
  `unstick-merge-queue.mjs` does **dequeue + re-enqueue of the head** to clear a
  *wedge* (the zero-runs GITHUB_TOKEN wedge). But when the head is legitimately
  RUNNING (not wedged), that dequeue/requeue **cancels its in-flight run** →
  head goes AWAITING_CHECKS again → unstick fires again → perpetual churn. It
  cannot tell "wedged" (needs a nudge) from "running" (must be left alone). FIX:
  `gh api -X PUT repos/loopdive/js2/actions/workflows/queue-unstick.yml/disable`
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

**Fix / discipline**:
1. **Don't touch a queue while a run is in flight.** No dequeue/enqueue/label
   churn mid-run. Pick the action, then leave it ALONE for a full run (~15 min).
2. To drain when it's stuck: **dequeue ALL, then PAT-enqueue ONE PR, then hands
   off** until it merges; repeat. PAT/App enqueue (not GITHUB_TOKEN — see
   [[project_merge_queue_wedge_github_token]]) creates a fresh run and clears the
   dangling cancelled-check state.
3. A cancelled run leaves a dangling "expected" check; the head can sit
   AWAITING_CHECKS until the ruleset `check_response_timeout_minutes` (60) fires.
   Dequeue+PAT-re-enqueue resets it instead of waiting.
4. If genuinely clean PRs (quality green, 0 failed shard jobs) stay stuck, they
   are mergeable — admin-merge is justified to bypass a self-inflicted queue
   tangle.

**Three merge-queue failure modes — keep them straight**:
- WEDGE: 0 runs created → GITHUB_TOKEN enqueue. [[project_merge_queue_wedge_github_token]]
- DUP-ID CHURN: runs fire, `quality` fails "N duplicate IDs" → stale issue-ID
  collision. [[project_merge_queue_dup_issue_id_churn]]
- CANCELLATION CHURN (this): runs fire but cancelled mid-flight, 0 failed jobs →
  queue membership churn. STOP poking; one PR at a time; hands off.
