---
id: 3476
title: Landing-page baseline frozen — promote-baseline env-gate skips on queue merges
status: done
completed: 2026-07-23
sprint: 75
priority: high
horizon: m
goal: ci-infra
---

## Problem

The committed root baseline in `loopdive/js2wasm-baselines`
(`test262-current.{json,jsonl}`, `test262-standalone-current.{json,jsonl}`,
plus the `test262-report.json` / `test262-standalone-report.json` aliases)
feeds the landing page (js2.loopdive.com) via `deploy-pages.yml`. It froze at
**2026-07-19T05:50Z / sha `2f274075a`** for ~12h across ~30 merged PRs, so the
landing page understated conformance (missing #3419's +433 name/length tests,
etc.).

## Root cause (precise)

`#3467` moved the full test262 shard matrix into the pre-merge `merge_group`
validation; the post-merge **push to main** (actor `github-merge-queue[bot]`)
skips the shard matrix. But the *real* freeze cause is narrower: the
`promote-baseline` job (`test262-sharded.yml`) carries
`environment: baseline-promote`, and that **deployment gate SKIPS the job on
every `github-merge-queue[bot]` push** (its `if:`/`needs` pass, yet the job
shows empty steps — verified run 29682548248). Since ~all pushes to main are
queue merges, the root baseline never gets re-promoted. The `write-run-cache-bot`
job DOES run on those pushes (repo-level `BASELINE_DEPLOY_KEY`, no environment)
and writes the host `runs/<sha>` per-SHA cache — but never the 4 landing-page
root files, and nothing for standalone.

## Fix

### Part A — permanent pipeline fix (this PR)

Expand `write-run-cache-bot` into a full **queue-time baselines-repo promote**.
It already downloads the `test262-group-<sha>` artifact — which contains BOTH
host and standalone merged JSONLs (uploaded together by `merge-report`) — so:
- Independent standalone floor gate (`sa` step output) so a standalone anomaly
  never blocks the #3467 host per-SHA cache write.
- Heal + build reports for BOTH lanes (parity with promote-baseline #2099).
- Refresh the 4 root files + report aliases (host always; standalone when its
  lane clears the floor), append `runs/index.json`, write the host `runs/<sha>`
  cache — all in ONE commit.
- Preserve safety: 40k corruption floors, the #3335 trap-growth gate (host is
  the #3189 ratchet floor), and the #2942 re-anchor / latest-wins ordering
  guard (needed now that the job rewrites generated files).
- `promote-baseline`'s env / `MAIN_DEPLOY_KEY` main-repo summary path is left
  intact for non-queue pushes / workflow_dispatch — the two jobs are mutually
  exclusive by actor, so no double-write. `ir_first` / `github-actions[bot]`
  guards untouched.

Note: `deploy-pages.yml` overwrites the main-repo committed summary with the
baselines-repo version at build time, so refreshing the baselines repo is what
actually drives the deployed page; the main-repo committed summary stays a
secondary (non-queue) consumer.

### Part B — immediate one-off refresh (DONE, direct baselines push)

Refreshed the 4 root files + reports for main tip `f48e67e01` from the
`test262-group-f48e67e01` artifact (both lanes; host reused the already-healed
`runs/f48e67e01.jsonl` blob, standalone raw from the artifact). Pushed to
`loopdive/js2wasm-baselines` main as **47224a2** via the Git-Data / surgical
`read-tree HEAD` path, with the mandatory tree-integrity gates PASSED against
the remote: **18 root entries, 1161 runs/ entries, 9 files Modified, ZERO
deletions** (no wipe). deploy-pages re-triggered (run 29698761900).
- Live numbers now published: **host 28294/43106 (+460)**, **standalone
  27378/43106 (+2495)** over the frozen 27834 / 24883.
- Standalone was NOT healed for the one-off (host per-SHA cache already healed);
  Part A heals both going forward. Not fabricated — from the real merge_group
  results for the main tip.

## Status

- Part B: DONE (baselines main @ 47224a2, deploy-pages re-run).
- Part A: implemented on branch `issue-3468-landing-baseline`
  (`.github/workflows/test262-sharded.yml`, write-run-cache-bot job). YAML
  lint-clean. Draft PR to loopdive/js2wasm; goes through the merge queue — do
  NOT admin-merge. First real validation is the next queue merge after it lands
  (the job runs post-merge; watch that the root baseline advances + deploy-pages
  reflects it).

## Resume state (if handed off)

- Worktree: `/workspace/.claude/worktrees/agent-a714820da8b061940` (harness
  isolation dir), branch `issue-3468-landing-baseline`.
- Remaining: none for the change itself — just CI-watch the PR through the
  queue, then confirm the first post-merge queue push actually promotes the
  root baseline (check baselines main advances beyond 47224a2 with a
  `refresh landing-page baseline` commit).
