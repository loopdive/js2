---
id: 2523
title: "enqueue/unstick must use a GitHub App token, not GITHUB_TOKEN (merge-queue wedge fix)"
status: in-progress
priority: high
feasibility: medium
reasoning_effort: medium
task_type: ci
area: ci
goal: dev-velocity
sprint: 65
related: [2519, 2517]
---

# #2523 — Enqueue via a GitHub App token, never GITHUB_TOKEN

## Problem (root cause of the 2026-06-19/20 night-long merge-queue wedge)

A PR enqueued via **`GITHUB_TOKEN`** (i.e. by `github-actions[bot]`) does **not**
trigger `merge_group` workflows — GitHub's "a workflow run cannot trigger another
workflow run" rule suppresses the `merge_group` `checks_requested` event. The
required checks are never produced, so the queue head sits `AWAITING_CHECKS`
forever with **zero merge_group runs** (looks exactly like a webhook/event
outage; it is not).

`auto-enqueue.yml` and `queue-unstick.yml` used
`GH_TOKEN: ${{ secrets.AUTO_ENQUEUE_TOKEN || secrets.GITHUB_TOKEN }}`. With
`AUTO_ENQUEUE_TOKEN` unset (the repo only had `BASELINE_DEPLOY_KEY`), they fell
back to `GITHUB_TOKEN` and every PR they enqueued/requeued wedged. Dev
self-enqueues (user PAT) worked, which made it look intermittent.

**Confirmed** 2026-06-20: dequeue all → `enqueuePullRequest` one PR via a user
PAT → a `merge_group` run fires within ~60s and completes. GITHUB_TOKEN-enqueued
heads = 0 runs.

## Fix

Mint a **GitHub App installation token** via `actions/create-github-app-token@v3`
in both enqueue workflows and use it as `GH_TOKEN`. **No `|| GITHUB_TOKEN`
fallback** — a missing/invalid app secret must fail the job loudly rather than
silently re-introduce the wedge. App tokens are a distinct actor, so their
enqueues DO fire `merge_group` runs; the App private key is long-lived and the
installation token is auto-minted per run (no PAT-style expiry/rotation burden).

Secrets required: `ENQUEUE_APP_ID`, `ENQUEUE_APP_PRIVATE_KEY`.

## Token audit — which workflows need the App token? (answers "do the same with other tokens?")

Principle: **only an action that creates an event which must TRIGGER a run** needs
a non-GITHUB_TOKEN actor. GITHUB_TOKEN is auto-minted per run and self-expires
(≤24h) — zero rotation burden — so there is no *durability* reason to convert
anything; the only reason is the trigger restriction.

| Workflow | Action | Decision |
|----------|--------|----------|
| `auto-enqueue.yml` | enqueue PR → merge_group | **App token** (this PR) |
| `queue-unstick.yml` | dequeue+enqueue → merge_group | **App token** (this PR) |
| `auto-refresh-prs.yml` | `update-branch` push → should re-trigger PR checks | same class, but **dormant** (manual `workflow_dispatch`, last run 2026-05-22) — follow-up only |
| `baseline-floor-staleness-alert.yml`, `refresh-baseline.yml`, `baseline-summary-sync.yml`, `test262-sharded.yml` | `gh workflow run` (workflow_dispatch) | **keep GITHUB_TOKEN** — `workflow_dispatch`/`repository_dispatch` are explicit exceptions and DO trigger ([GitHub changelog 2022-09-08](https://github.blog/changelog/2022-09-08-github-actions-use-github_token-with-workflow_dispatch-and-repository_dispatch/)) |
| `benchmark-refresh.yml`, `ci-status-*.yml`, baseline `git push` (promote) | data/skip-ci pushes | **keep GITHUB_TOKEN** — these must NOT trigger runs (recursive) |
| `merge-group-sweeper.yml` | cancel runs | **keep GITHUB_TOKEN** — not a trigger |
| `approve-fork-runs.yml` | approve fork runs | **keep GITHUB_TOKEN** — not a trigger |
| `test262-differential.yml` | read-only | **keep GITHUB_TOKEN** |

## Setup (stakeholder — one-time, GitHub UI)

1. Create a GitHub App (org or personal): **Settings → Developer settings →
   GitHub Apps → New**. Repository permissions: **Pull requests: Read & write**,
   **Contents: Read & write**, **Checks: Read**, **Actions: Read & write**,
   **Issues: Read & write**. (Merge-queue enqueue rides on contents+PR write.)
   No webhook needed; uncheck "Active".
2. Generate a **private key** (PEM) and note the **App ID**.
3. **Install** the App on `loopdive/js2` (only-select-repos → js2).
4. Provide the App ID + private key; the secrets get set:
   `gh secret set ENQUEUE_APP_ID -R loopdive/js2 -b <id>` and
   `gh secret set ENQUEUE_APP_PRIVATE_KEY -R loopdive/js2 < key.pem`.
5. Re-enable `auto-enqueue.yml` + `queue-unstick.yml` (disabled during the manual
   PAT drain), confirm an auto-enqueue run mints the token and a fresh PR's
   `merge_group` run fires.

## Acceptance criteria

- [x] `auto-enqueue.yml` + `queue-unstick.yml` mint an App token, no GITHUB_TOKEN
      fallback.
- [x] Token audit recorded (other workflows correctly stay on GITHUB_TOKEN).
- [ ] `ENQUEUE_APP_ID` / `ENQUEUE_APP_PRIVATE_KEY` set; workflows re-enabled;
      auto-enqueue verified to fire a merge_group run (post-setup).
