---
id: 1657
title: "Skip merge_group test262 shards for non-src changes (keep required check green)"
status: done
completed: 2026-06-12
created: 2026-05-24
updated: 2026-05-24
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: ci, test262
sprint: 55
related: [1656]
---
# Skip merge_group test262 shards for non-src changes

## Problem / goal

The merge queue runs the full ~1.5h, 32-shard `test262-sharded.yml` matrix on
**every** queued PR — including website-only, plan-only, and docs-only PRs that
cannot possibly affect test262 conformance. The `pull_request` and `push`
triggers already have a `paths:` allowlist (the `&test262-paths` anchor:
`src/**`, `package.json`, lockfile, tsconfigs, `vitest.config.ts`, the test262
scripts/tests, and the workflow file itself), so PR-time is already filtered.
But the `merge_group` trigger has **no native `paths:` filter**, so every
queued change pays for the whole matrix.

Goal: make the `merge_group` run skip the heavy shards when no test262-relevant
path changed, while never breaking the branch-protection required checks.

## The trap (why this is not a one-line `paths:` add)

`merge_group` events do not support `paths:`. The naive fix — cascade-skipping
`test262-shard` — triggers the **cascade-skip trap** already documented in
`.github/workflows/test262-pr-stub.yml`:

- `merge-report` (the required check **"merge shard reports"**) has
  `needs: [test262-shard]`.
- If `test262-shard` is **skipped**, GitHub's `needs:` semantics treat skipped
  as not-success, so `merge-report` cascade-skips too.
- The required check **"merge shard reports"** is then **never produced**, and
  under the strict required-checks ruleset the PR becomes permanently
  **BLOCKED** (`mergeStateStatus: BLOCKED, checks_summary: []`).

So the skip must be **selective on the shards** while the required check name
is **always produced green**.

## Design — conservative path detector + always-green required check

1. **`scripts/test262-paths-match.sh`** — single source of truth that mirrors
   the `&test262-paths` allowlist. Reads changed paths on stdin, prints
   `true` if any path is test262-relevant, else `false`. (Must be kept in sync
   with the workflow's `paths:` anchor — a comment in both points at the other.)

2. **`changes` job** (merge_group, ~10s) — diffs
   `github.event.merge_group.base_sha .. github.event.merge_group.head_sha`
   and pipes the file list through the matcher, exposing
   `run_shards=true|false`. **Conservative fail-safe**: missing/empty base_sha,
   a failed diff, or an empty diff all emit `run_shards=true` (run test262).
   `false` is only emitted when zero test262-relevant paths are positively
   confirmed. Non-merge_group events always emit `true` (their native `paths:`
   filter / dispatch intent already governs).

3. **`test262-shard`** — `needs: [changes]`; the merge_group arm of its `if:`
   now also requires `needs.changes.outputs.run_shards == 'true'`. Other arms
   (pull_request / push / workflow_dispatch) unchanged.

4. **`merge-report`** — `needs: [changes, test262-shard]`, `if:` extended to run
   when shards succeeded **or** when `merge_group && run_shards=='false'`. A
   job-level `SHARDS_RAN` env (`'true'` iff shards succeeded) guards every
   artifact-touching step; on the skip path a single no-op step echoes the
   reason and exits 0, so the required check **"merge shard reports"** is still
   reported **green**.

5. **`regression-gate`** — `needs: [changes, test262-shard, merge-report]`, only
   runs when `test262-shard.result == 'success'`. On the skip path it cleanly
   `skipped`s (it is not a required check and a non-test262 change cannot cause
   a conformance regression by definition), so it never blocks.

Required-check **names are unchanged** (`cheap gate (main-ancestor + lint)`,
`merge shard reports`). The PR-time stub (`test262-pr-stub.yml`) is untouched.

## merge_group gating truth table

| queued change | `run_shards` | `test262-shard` | `merge-report` ("merge shard reports") |
|---|---|---|---|
| `src/**` / any `&test262-paths` | `true` | RUNS (matrix) | runs, real merged report → green |
| website / plan / docs only | `false` | SKIPPED | runs no-op step → green |
| base_sha empty / diff fails / empty diff | `true` (fail-safe) | RUNS (matrix) | runs, real merged report → green |

The invariant across all rows: **"merge shard reports" is produced green**, so
the PR is never wedged BLOCKED.

## Acceptance criteria

- A `src/**` (or any `&test262-paths`) change in the merge queue still runs the
  full shards + regression gate.
- A website/plan/docs-only change in the merge queue skips the shards yet still
  produces a green **"merge shard reports"** required check (PR stays mergeable).
- Missing/empty `base_sha`, a failed diff, or an empty diff all fall back to
  running the full shards (fail safe = run).
- Required-check names unchanged; PR-time stub behaviour unchanged.
- This PR itself touches `.github/workflows/test262-sharded.yml` (in the
  `&test262-paths` list), so it correctly runs full test262 at PR-time and in
  the queue — proving the src/workflow path still triggers shards.

## Files

- `scripts/test262-paths-match.sh` (new) — path matcher, single source of truth.
- `.github/workflows/test262-sharded.yml` — `changes` job; gated `test262-shard`,
  `merge-report`, `regression-gate`; embedded truth-table comment.
