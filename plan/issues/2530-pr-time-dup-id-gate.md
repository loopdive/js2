---
id: 2530
title: "ci: surface issue-ID collisions at PR time (merge with main), not only in the merge_group"
status: done
assignee: ttraenkler/sd3
created: 2026-06-20
updated: 2026-06-20
completed: 2026-06-20
priority: high
feasibility: medium
task_type: infrastructure
area: ci
related: [1616, 2522]
origin: "merge-queue dup-ID churn incident 2026-06-20 (prevention a)"
---

# #2530 — PR-time duplicate issue-ID gate against a simulated merge with main

## Problem

A merge-queue incident on 2026-06-20 was caused by issue-ID collisions. A PR
adds `plan/issues/<id>-<slug>.md` whose `id:` was free when the branch was cut,
but a parallel PR merged that same id to `main` first. The PR-time `quality`
job's "Issue integrity + link gate" (#1616,
`scripts/check-committed-issue-integrity.mjs`) runs only on the PR's **stale
branch tip**, where the colliding file from main is not present — so it passes.
The collision then fails repeatedly in the `merge_group` (which validates
`main + PR`) and wedges the queue with "N duplicate IDs"
(see `.claude/memory/project_merge_queue_dup_issue_id_churn.md`).

## Fix

New step in the `quality` job (`.github/workflows/ci.yml`), gated to
`pull_request` only, that runs `scripts/check-merged-issue-integrity.mjs`:

1. Fetches fresh `origin/main` (deepened so the real merge base is present).
2. Computes the tree that *would* result from merging `origin/main` into the PR
   head via `git merge-tree --write-tree` — no index/worktree mutation.
3. Runs the existing committed-integrity checker
   (`check-committed-issue-integrity.mjs`) against that merged tree OID.

A stale-base id collision therefore fails the PR's **own** `quality` check,
before it can reach — and wedge — the merge queue. No new required check is
added: the gate rides inside the already-required `quality` check.

### Robustness

- **Shallow clone**: a `git fetch --depth=1 origin main` updates `FETCH_HEAD`
  but may not create `refs/remotes/origin/main`; the script falls back to
  `FETCH_HEAD`. The CI step deepens to `--depth=200` so the common case gets a
  true 3-way merge.
- **Merge base outside shallow history**: `git merge-tree` errors with "refusing
  to merge unrelated histories" and emits no tree, which would hard-fail every
  PR. The script retries with `--allow-unrelated-histories`, which unions both
  trees with an empty merge base — exactly (and conservatively) what dup-id
  detection needs: it can never hide a collision and never invents one.
- **Unresolvable base / missing `git merge-tree` (< 2.38)**: skips cleanly
  (exit 0) — never blocks a build it cannot reason about. The per-branch #1616
  check still gates.
- Skipped on `push` / `merge_group` (the head already contains main there; the
  existing #1616 check covers it).

## Validation

Hermetic git sandboxes (job tmp, not committed) reproduce the exact incident:

| Scenario | Per-branch #1616 check | Merged-tree gate |
|---|---|---|
| Collision, shallow clone | PASS (blind spot) | **FAIL** — `DUPLICATE IDs (1): #9999` |
| Collision, deep clone (3-way) | PASS (blind spot) | **FAIL** — same signal |
| Clean PR (distinct ids), shallow clone | n/a | **PASS** — no false positive |

So the gate catches exactly the collision class that wedges the queue and never
false-positives on a clean PR.

## Files

- `scripts/check-merged-issue-integrity.mjs` — new wrapper.
- `.github/workflows/ci.yml` — new "Issue integrity vs. merged main (#2530)"
  step in the `quality` job.
