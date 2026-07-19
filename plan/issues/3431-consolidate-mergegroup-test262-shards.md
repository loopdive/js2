---
id: 3431
title: "Consolidate test262 shards for merge_group validation (~60min -> ~20-30min)"
status: done
sprint: current
created: 2026-07-18
updated: 2026-07-18
completed: 2026-07-18
priority: high
horizon: m
feasibility: easy
reasoning_effort: medium
task_type: infrastructure
area: ci
language_feature: n/a
goal: ci-reliability
depends_on: []
assignee: "ttraenkler/ci-shard-fix"
---

# #3431 — Consolidate test262 shards for merge_group validation

## Problem

`test262-sharded.yml` runs a 57-shard x 2-target (js-host + standalone) =
114-job test262 matrix. The merge queue can build up to
`max_entries_to_build: 5` groups concurrently (docs/ci-policy.md #1956),
each running the full 114-job matrix — up to 570 concurrent jobs contending
for runner slots. The merge-queue check timeout was already raised to 120
min as a stopgap, and the queue was observed draining at roughly 1 PR/hour.

## Evidence (2026-07-18, `gh run view` on real merge_group runs)

**Isolated (uncontended) run** (29631214965): all 114 jobs started within
~2.5 minutes of each other and the shard matrix finished in ~15-19 minutes
total. Per-job step timing (job "test262 js-host shard 38") showed setup
(checkout + setup-node + corepack + install + build bundle) taking only
~28 seconds — the actual `vitest run` step accounted for essentially the
entire job duration. So **fixed per-job overhead is not the bottleneck**
(it's ~30-45s/job, not the "~1-2 min" originally assumed).

Per-target timing at the current 57-way split (same run):

| target     | avg      | max      |
| ---------- | -------- | -------- |
| js-host    | 13.6 min | 15.9 min |
| standalone | 5.8 min  | 7.0 min  |

**Contended run** (29632953272, overlapping with another concurrent
merge_group build 29632727762): job start times trickled from `05:51:46` to
`06:11:57` — a ~20-minute spread instead of the near-instant start seen when
uncontended — stretching the run to 38.5 minutes total (`conclusion:
failure`). Several other merge_group runs from the same period show the same
pattern (17-38 min durations clustered together, several `cancelled`/
`failure`), consistent with queue-contention "waves" rather than steady-state
per-shard cost.

**Conclusion**: the ~60min+/1-PR-per-hour problem is driven by **job-count
contention** across concurrently-building queue entries (up to 5 x 114 = 570
jobs), not by fixed per-job setup cost. Reducing the per-entry job count
directly reduces that contention footprint.

## Fix

Split `merge_group` into its own **consolidated** shard job
(`test262-shard-mg`), separate from the existing `test262-shard` job (which
keeps its original 57x2=114-job matrix, UNCHANGED, for `push`/
`workflow_dispatch`). `pull_request` behavior is also completely unchanged
(it never runs the heavy matrix at all, per #2519's slim-down).

`scripts/gen-test262-mg-matrix.mjs` computes the merge_group matrix. js-host
and standalone get **different** shard counts, because they have very
different per-shard runtimes at the same split (see evidence table above):

- `JS_HOST_CHUNKS = 40` — scaled estimate: avg ~19.4 min, max ~22.7 min
- `STANDALONE_CHUNKS = 19` — scaled estimate: avg ~17.4 min, max ~21.0 min

Both stay under the existing 25-minute per-shard timeout with headroom, so
**no timeout change was needed**. Total merge_group job count: `40 + 19 =
59`, a **48% reduction** from 114.

Every matrix cell invokes a new dynamic entry point,
`tests/test262-chunk-dynamic.test.ts`, instead of a hand-written
per-chunk file — it reads `TEST262_CHUNK_INDEX`/`TEST262_CHUNK_TOTAL` from
the environment and calls the existing `runTest262Chunk(idx, total)`
(`tests/test262-shared.ts`), which is a pure function of
`(chunkIndex, totalChunks)` and does not depend on the calling filename.

### Invariants verified

- **Corpus coverage is count-agnostic.** `assignBalancedChunk` in
  `test262-shared.ts` re-derives the full test262 corpus for every call and
  greedily bin-packs every test into exactly one of `totalChunks` bins by
  historical duration — a strict, non-overlapping, full-coverage partition
  for ANY `totalChunks >= 1`. This is already exercised in production:
  `tests/test262-local-shard*.test.ts` runs the identical corpus at
  `totalChunks=16` for local dev vs. 57 in CI.
- **`merge-report` aggregation is count-agnostic already.** It globs shard
  artifacts by pattern (`test262-*-shard-*`, `find ... -name
  'test262-results-*.jsonl'`) rather than hardcoding 114/57 — no changes
  needed there beyond wiring the new job into `needs:`/`SHARDS_RAN`. The new
  job reuses the exact same artifact-naming convention
  (`test262-${target}-shard-${chunk_label}`), so the glob picks up either
  job's output with zero changes. Only one of `test262-shard` /
  `test262-shard-mg` ever runs per workflow event (mutually exclusive `if:`
  conditions), so there is no naming-collision risk even though the two
  jobs' `chunk_label` ranges overlap (1..57 vs. 1..40/1..19).
- **RAM does not scale with shard size.** `CompilerPool` processes tests as
  a stream through a fixed-size worker pool (`COMPILER_POOL_SIZE`, unchanged
  at 4 to match the #3425 baseline-compatibility contract); results are
  appended to the JSONL incrementally (`openSync(..., "a")`), not buffered.
  Bigger shards mean more wall time, not more peak memory.
- **Both events' behavior is otherwise identical.** `pull_request` /`push`/
  `workflow_dispatch` still use `test262-shard`'s static 57x2 matrix,
  completely unchanged.

### Files changed

- `.github/workflows/test262-sharded.yml` — `changes` job gains a
  `mg_shard_matrix` output (computed via the new script, merge_group-only);
  `test262-shard`'s `if:` drops the merge_group arm; new `test262-shard-mg`
  job (consolidated matrix, merge_group-only); `merge-report` and
  `regression-gate` `needs:`/`SHARDS_RAN` updated to accept success from
  either shard job.
- `scripts/gen-test262-mg-matrix.mjs` — new. Pure matrix-generation logic
  (importable + testable without the test262 submodule).
- `tests/test262-chunk-dynamic.test.ts` — new. Runtime entry point for the
  consolidated matrix's cells.
- `tests/issue-3431-mg-matrix.test.ts` — new. Validates the generator's
  output shape (unique/contiguous chunk indices, target/result-prefix
  parity with the static matrix's convention) and the dynamic entry point's
  env-var validation contract.

## Rollback

Single workflow file (`.github/workflows/test262-sharded.yml`) plus three
new, additive files. To roll back: revert the workflow diff (restores
`test262-shard`'s original `if:` including the merge_group arm, removes
`test262-shard-mg`, restores `merge-report`/`regression-gate`'s original
`needs:`/`SHARDS_RAN`) and optionally delete the three new files (they are
inert if unreferenced by the workflow).

## Test Results

- `pnpm run typecheck` — clean (no new errors).
- `npx vitest run tests/issue-3431-mg-matrix.test.ts` — 7/7 pass.
- Dry-ran `scripts/gen-test262-mg-matrix.mjs` — 59 entries (40 js-host + 19
  standalone), verified unique `(target, chunk_index)` pairs and contiguous
  `0..chunk_total-1` coverage per target.
- Parsed the full modified `test262-sharded.yml` with `js-yaml` (via `npx
  js-yaml`) — valid YAML, correct `needs:`/`if:`/`strategy.matrix` wiring
  confirmed by inspecting the parsed JSON (`test262-shard-mg` needs
  `[changes]`, `if:` gates on `merge_group` + `run_shards=='true'`,
  `strategy.matrix` is `fromJson(needs.changes.outputs.mg_shard_matrix)`;
  `merge-report`/`regression-gate` both `needs: [changes, test262-shard,
  test262-shard-mg]`).
- `actionlint`/`yamllint` were not available in this environment (not
  installed); relying on the required CI checks (`gate`, `quality`) on the
  PR itself to catch any workflow-syntax issue, plus the YAML-parse +
  wiring dry-run above.
- Local `biome lint` OOM'd on this box (severe memory pressure, ~68MB free
  at the time — reproduced even on a single trivial file, unrelated to
  these changes) — CI's `quality` job runs the real lint gate.
