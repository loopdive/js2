---
id: 1958
title: "PR-pipeline rot prevention — 4 mechanisms observed live 2026-06-12"
status: done
sprint: 61
created: 2026-06-12
updated: 2026-07-22
completed: 2026-06-12
priority: high
feasibility: medium
reasoning_effort: medium
---

## Problem

Four distinct mechanisms that silently rot the PR pipeline were observed live
on 2026-06-12. Each strands green PRs and (today) needs a human to clear it.

### (a) CLA-CHECK SHA STRANDING

When the merge queue or a drift-update adds a `Merge branch 'main'` commit on
top of a PR branch, the new head SHA has no `cla-check` commit status —
`cla-check.yml` runs on `pull_request_target` and posts the status to the PR
head SHA only; it does not re-fire when a merge commit changes the head. So
`enqueuePullRequest` fails with `Required status check "cla-check" is expected`
even though CLA was already accepted on the prior head. (Incident: senior-1 on
PR #1365 / #2061.)

### (b) QUEUE WEDGE DETECTION GAP

`queue-unstick.yml` / `unstick-merge-queue.mjs` exist for the #1958 wedge
(entry AWAITING_CHECKS, no merge_group runs), but the 01:36Z run reported
success while PR #1364 was wedged 00:44→02:10.

### (c) FORK-PR action_required GATING

Fork PRs land their CI runs in `action_required` until a maintainer approves
them. The team's dev agents all push to `ttraenkler/js2`, so every run stalls;
~90 runs stranded on 2026-06-12 until a tech-lead session swept them, and that
sweep dies with the session.

### (d) DRAFT ROT

Green drafts are invisible to auto-enqueue by design, but nothing flags them;
PRs #1345 / #1335 (the acorn dogfood blocker) rotted ~1 day as drafts.

## Fix (this PR)

### (a) — `scripts/enqueue-green-prs.mjs`

When `enqueuePullRequest` fails and the only blocker is a stale/missing
`cla-check` status on the head (we already verified every visible check is
pass/skipping), rerun the PR's latest `cla-check` run. The
`pull_request_target` re-run re-resolves `pr.head.sha` and reposts
`cla-check=success` on the current head, so the next sweep enqueues cleanly.
Added `actions: write` to `auto-enqueue.yml`.

### (b) — `scripts/unstick-merge-queue.mjs`

Root cause: each merge group spawns ~4-5 workflow runs, so the old
`per_page=50` single-page fetch covered only ~10 PRs of history — and that
fetch ENOBUFS-crashed on the ~1 MB/page payload. Fixes:

- raise `execFileSync` `maxBuffer` to 64 MB (the fetch was crashing);
- project the runs API server-side with `-q` (id/head_branch/created_at only)
  and paginate (`RUN_PAGES`×100, default 4) so the window covers the whole
  recent queue;
- de-alias stale prior-enqueue runs (only runs created at/after the entry's
  current `enqueuedAt` count as healthy) and log matched/stale run IDs so a
  future missed-wedge is debuggable from the cycle log;
- fix the `REPO` default from the dead `loopdive/js2wasm` to `loopdive/js2`
  (a hand-run without `GH_REPO` was querying the wrong repo).

### (c) — new `scripts/approve-fork-runs.mjs` + `.github/workflows/approve-fork-runs.yml`

Scheduled (10 min) + `workflow_run`-triggered job that approves
`action_required` runs whose `head_repository.full_name == ttraenkler/js2`
ONLY (trusted fork; arbitrary forks are never auto-approved). Uses the
`AUTO_ENQUEUE_TOKEN` PAT — the default `GITHUB_TOKEN` cannot approve fork runs
(403); the script logs a clear pointer if the secret is unset.

### (d) — disabled 2026-07-22

The stale-draft notifier was removed after it repeatedly commented on dormant
draft PRs. Auto-enqueue still ignores drafts, but it no longer scans, labels, or
comments on them. The workflow's now-unused `issues: write` permission was also
removed. Authors decide when a draft is ready without scheduled bot reminders.

## Validation

- Both scripts pass `node --check`.
- `unstick-merge-queue.mjs` dry-run against the live queue now fetches 400
  merge_group runs (was ENOBUFS-crashing) and correctly detects the live
  AWAITING_CHECKS heads.
- `approve-fork-runs.mjs` dry-run confirms the trusted-fork projection
  (`head_repository.full_name`) resolves and the trusted-fork filter is applied.
- `enqueue-green-prs.mjs` dry-run exercises the back-off guard; the (a) path is
  guarded behind it and parse-clean.
