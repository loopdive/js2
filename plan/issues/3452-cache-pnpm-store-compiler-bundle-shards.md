---
id: 3452
title: "ci(test262): cache pnpm store / prebuilt compiler-bundle artifact across shard jobs"
status: ready
sprint: current
created: 2026-07-19
updated: 2026-07-19
priority: low
horizon: s
feasibility: medium
reasoning_effort: low
task_type: ci
area: ci
language_feature: n/a
goal: maintainability
---

# Cache pnpm store / prebuilt compiler-bundle artifact across shard jobs (L7 / opportunistic)

> **Low-priority / opportunistic.** Small wall-clock win; worth doing only when a
> CI-infra agent is already in the workflow. Do the high-value levers first —
> L1 (#3448), L2 (#3447), L6 (#3449).

Implements lever **L7** from `plan/ci-acceleration-review.md` (§3 table, row L7).

## Problem

Fixed per-job setup (install + build) is ~**30–45 s/job**. Across ~**160 jobs** per
merge (mg shards + push:main shards + ci.yml runs) that is **≈ 100+ runner-minutes
per merge** spent re-installing dependencies and rebuilding the compiler bundle that
is byte-identical across every job in a run.

This is a **runner-minute** saving, not a critical-path wall-clock saving — the
shards run in parallel, so shaving per-job setup mostly reduces total compute /
contention rather than the slowest-shard tail. Hence: opportunistic.

## Approach (sketch — for the implementing agent to spec)

- Cache the **pnpm store** keyed by the lockfile hash so `pnpm install` restores
  instead of resolving from scratch.
- Optionally build the **compiler bundle once** (per workflow run) and pass it to
  shard jobs as an artifact, so each shard restores a prebuilt bundle instead of
  rebuilding.
- Keep the cache/artifact key tight enough to avoid the "stale cache → false
  baseline" scar (`tests/test262-shared.ts:857-858`) — this caches *tooling*
  (deps/bundle), never test *results*.

## Acceptance criteria

1. pnpm-store and/or prebuilt-compiler-bundle reuse wired into the test262 shard
   jobs, keyed so a src/lockfile change invalidates it correctly.
2. Measured per-job setup reduction on a full run (target: shave the ~30–45 s/job
   install/build toward near-zero on cache hit).
3. No result-caching — tooling only; the "stale cache → false baseline" hazard is
   not reintroduced.
4. Net-neutral-or-better on cache-miss runs (restore/save overhead must not exceed
   the install/build it replaces).

## References

- Review: `plan/ci-acceleration-review.md` §3 (L7 row), §2.2 (per-job setup ~30–45 s).
- Contrast with L5/#29 disk-cache (superseded by L1/#3448 — see review §L5).
