---
id: 2149
title: "emergency refresh-baseline.yml pushes the main audit commit with GITHUB_TOKEN → GH013-blocked → drift deadlock"
status: done
sprint: 62
created: 2026-06-14
updated: 2026-06-14
completed: 2026-06-14
priority: high
feasibility: medium
reasoning_effort: high
task_type: ci-infra
area: ci
related: [1078, 1080, 1668, 1861, 1951]
origin: "2026-06-13 drift deadlock — baseline froze; resolved manually via refresh + admin-merges"
---

# #2149 — refresh-baseline.yml main push uses GITHUB_TOKEN (GH013-blocked)

## Problem

On 2026-06-13 the regression baseline froze: the test262 promote pipeline's
push to `main` failed with **GH013** ("Changes must be made through a pull
request"), so the committed `benchmarks/results/test262-current.json` stopped
advancing while the `js2wasm-baselines` repo moved on. That blinds the
regression gates (stale-baseline guard trips) — the drift deadlock. It was
unstuck manually (forced refresh + admin merges).

## Root cause

The `merge-and-promote` job in `.github/workflows/refresh-baseline.yml` (the
ONE-CLICK EMERGENCY RECOVERY workflow) committed the main-repo audit refresh
and pushed it with:

```yaml
- name: Checkout
  with:
    token: ${{ secrets.GITHUB_TOKEN }}
...
- name: Commit FORCED baseline refresh (audit trail)
  run: |
    ...
    git pull --rebase origin main
    git push          # ← GITHUB_TOKEN origin push → GH013 BLOCKED
```

The ruleset on `main` only bypasses GH013 for **DeployKey (always)** actors.
A `GITHUB_TOKEN`-authenticated push to a protected branch is rejected. So the
emergency recovery tool itself could not land its baseline — exactly the
deadlock it exists to break.

`test262-sharded.yml`'s `promote-baseline` and `baseline-summary-sync.yml`'s
`sync` already push via the `MAIN_DEPLOY_KEY` SSH deploy key (deploy-key
bypass + the `baseline-promote` Environment). Only `refresh-baseline.yml` had
the GITHUB_TOKEN gap — a partial regression of the same kind #725/#896 (PR
a8f72e6cf) introduced and #490 first fixed.

## Fix (this PR)

- `.github/workflows/refresh-baseline.yml`:
  - Added `environment: baseline-promote` to `merge-and-promote` so the
    ENVIRONMENT-scoped `MAIN_DEPLOY_KEY` secret resolves.
  - Replaced the GITHUB_TOKEN `git pull --rebase origin main && git push` with
    the proven `MAIN_DEPLOY_KEY` SSH deploy-key push + Option-A re-anchor loop
    (#1861): snapshot the small promote JSON files, hard-checkout a clean tip
    of `main` per attempt, re-apply, commit `[skip ci]`, `git push deploykey
    HEAD:main`, retry on the merge-queue advance race. Fails loudly if the
    secret is missing.
- `docs/ci-policy.md`: documented the hard invariant — **baseline pushes to
  `main` MUST use `MAIN_DEPLOY_KEY`, never `GITHUB_TOKEN`** (GH013) — with the
  list of all three baseline-promoting jobs and a `gh api … bypass_actors`
  recovery check.

## Why not "route promotion through the merge queue" (the task's Option A)

The #1951 design DEFERS even `[skip ci]` main pushes while the merge queue is
non-empty, because any push to `main` makes GitHub rebuild EVERY queued merge
group (114-job validation × N PRs + ~10 min latency). Routing the baseline
THROUGH the queue as a PR would re-introduce exactly that full-validation cost
per promotion — fighting the existing architecture. The deploy-key bypass is
the intended, low-cost path; the only bug was one job not using it. Fixed at
the root rather than re-architecting around it.

## Verification

- YAML parses (js-yaml). `environment: baseline-promote` present on the job.
- No `GITHUB_TOKEN`-authenticated push to `main` remains in the workflow (the
  one remaining `git push` is the baselines-repo push under
  `/tmp/js2wasm-baselines`, which uses `BASELINE_DEPLOY_KEY`).
- The current ruleset still lists `DeployKey: always` in `bypass_actors`
  (verified via `gh api /repos/loopdive/js2/rulesets/16700772`), so the
  deploy-key path is unblocked.
- Full end-to-end exercise requires a `workflow_dispatch` run with the
  MAIN_DEPLOY_KEY environment secret — to be validated by the tech lead on the
  next emergency refresh (or a dry dispatch).
