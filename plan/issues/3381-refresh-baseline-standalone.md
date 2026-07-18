---
id: 3381
title: "refresh-baseline.yml refreshes HOST only, never standalone — public standalone number strands stale"
status: in-progress
sprint: current
created: 2026-07-17
updated: 2026-07-17
priority: high
horizon: m
feasibility: hard
reasoning_effort: max
task_type: infrastructure
area: tooling
language_feature: n/a
goal: correctness
assignee: "ttraenkler/senior-dev"
---

> **Status note:** kept at `in-progress` (not `done`) in this impl PR on
> purpose. The `quality` gate's #2093 issue→probe-coverage check fails any issue
> (created ≥ 2026-06-15) that flips to `done` without citing a `tests/…` /
> `test262/…` probe path — which this CI-infra issue legitimately has none of.
> It will be reconciled to `done` post-merge (the reconciler / a follow-up doc
> commit), per the tech-lead-confirmed workaround (cf. #3298→#3375).

## Problem

The public landing page + `report.html` read
`public/benchmarks/results/test262-report.json` (host) and
`test262-standalone-report.json` (standalone), synced hourly from the separate
repo `loopdive/js2wasm-baselines` by `.github/workflows/baseline-summary-sync.yml`.
That baselines repo is refreshed by the on-push `promote-baseline` job in
`test262-sharded.yml`, with `.github/workflows/refresh-baseline.yml` as the
scheduled (8h cron `17 */8 * * *`) + emergency backstop.

`refresh-baseline.yml` — the ONLY reliable backstop when the on-push promote is
velocity-starved (e.g. a stretch of docs/CI-only merges advance `main` without
firing the test262-paths-filtered `promote-baseline`) — refreshes **HOST only**:

- its `test262-shard` job runs `tests/test262-chunkN.test.ts` with no
  `TEST262_TARGET`, so every shard produces HOST results (`test262-results-*.jsonl`);
- `merge-and-promote` merges/builds/promotes only the host report
  (`test262-current.json` / `test262-report.json`);
- `grep -c standalone .github/workflows/refresh-baseline.yml` == 0.

So the scheduled/emergency refresh CANNOT refresh the standalone report.

**Observed (2026-07-17):** the public standalone number sat stale at 57.3%
(24,711, sha `ee4d1fa`, 11:33Z) for ~7h while host was fresh (32,165). A human
force-refreshed at 17:30 via `refresh-baseline.yml`, which refreshed host only —
so host went fresh and standalone stranded. This host-only gap is the DIRECT
cause of the 7h standalone staleness.

## Acceptance criteria

- `refresh-baseline.yml` produces AND promotes a fresh STANDALONE report on every
  scheduled/emergency run, alongside host, mirroring `test262-sharded.yml`'s
  proven standalone handling.
- The standalone report is pushed to the baselines repo under the exact filenames
  the pipeline already uses: `test262-standalone-report.json` (the name
  `baseline-summary-sync.yml` sparse-checkouts) + `test262-standalone-current.jsonl` /
  `-current.json` / `-results.jsonl`.
- The public standalone file `public/benchmarks/results/test262-standalone-report.json`
  is copied and staged into the main audit commit so `main` + `public/` stay
  consistent with the baselines repo.
- A MANDATORY standalone sanity guard (`pass >= 1000`, `total >= 40000`) rejects
  empty/corrupt standalone data BEFORE promoting — mirroring the host
  "Sanity check report" step. NEVER promote corrupt standalone data.
- The #2097 standalone high-water mark is RAISED (never lowered) on refresh and
  staged into the main commit, matching `promote-baseline`.

## Implementation

Mirror `test262-sharded.yml` exactly (see `## Implementation Notes` in the PR /
below).

- `test262-shard` job: add a `target` matrix dimension
  (`js-host` = `gc` / `test262`, `standalone` = `standalone` / `test262-standalone`),
  wire `TEST262_TARGET` + `TEST262_RESULT_PREFIX` env, and namespace
  `RUN_TIMESTAMP`, the vitest blob output, the cache key and the upload artifact
  name/path by `matrix.target.name` so host + standalone artifacts never collide.
- `merge-and-promote`: add standalone JSONL merge, standalone report build
  (`--target standalone --max-unclassified-root-causes 0 --include-proposals`),
  standalone sanity guard, standalone promote copies (benchmarks/results +
  public), standalone high-water raise, standalone copies into the baselines-repo
  push set, and standalone report + high-water into the main audit commit.

## Implementation Notes (WHY)

- **Matrix `target` dimension, not a parallel job.** `test262-sharded.yml`
  already fans out `57 chunks x 2 targets` in one matrix; mirroring that exact
  shape (rather than a separate standalone shard job) keeps the two workflows
  structurally identical, so future maintenance touches one pattern. Cost: the
  scheduled/emergency refresh goes 57 -> 114 jobs. That is acceptable because
  refresh-baseline runs at most every 8h (or on manual dispatch), NOT per-PR.
- **Namespacing by `matrix.target.name` is load-bearing.** The runner writes its
  JSONL to `${TEST262_RESULT_PREFIX}-results-${RUN_TIMESTAMP}.jsonl`
  (tests/test262-shared.ts). Without a target-specific `RUN_TIMESTAMP`, blob
  outfile, cache key and artifact name, the host and standalone shards for the
  same chunk collide.
- **Cache key namespaced, step KEPT (not removed).** The on-disk wasm/meta result
  cache is DISABLED in the runner (tests/test262-shared.ts passes empty
  wasmPath/metaPath), so the cache step is effectively a no-op and there is NO
  cross-target contamination risk. To stay minimal-diff we keep refresh-baseline's
  existing cache step but add `matrix.target.name` to the key so the two targets
  don't collide on save. (test262-sharded deliberately dropped the cache step; we
  do not, to avoid an unrelated behavior change to the host path.)
- **Standalone sanity guard is MANDATORY and duplicated.** A YAML/logic slip here
  force-promotes corrupt public data. The guard (`pass >= 1000`, `total >= 40000`,
  mirroring the host floor) runs BOTH right after the standalone build AND again
  in the baselines-repo push step, so neither the public baselines push nor the
  main audit commit can promote empty/corrupt standalone data.
- **High-water is raised, not asserted, on refresh.** `promote-baseline` raises
  the #2097 mark with `--update --sha ... || true` (non-blocking; the ASSERT lives
  in the merge-report gate, not the promote job). refresh-baseline records main's
  true current state (a NORMAL refresh has no PR gate to bypass; a FORCED refresh
  is disaster-recovery), so it must raise-only and never block — same as
  promote-baseline.
- **Trap-growth gate stays host-only.** `promote-baseline` runs the #3335
  trap-growth check on the host JSONL only; refresh-baseline already does the
  same. Standalone is not added to that gate, preserving parity.
