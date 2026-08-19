---
id: 4441
title: "merge_group shard split — FOURTH ratio re-derivation: 58/44 estimate overshot, measured 1.03 → 52/50"
status: done
sprint: 78
created: 2026-08-15
updated: 2026-08-18
completed: 2026-08-15
priority: medium
horizon: s
feasibility: easy
reasoning_effort: medium
task_type: ci
area: infra
goal: velocity
---

# #4441 — merge_group shard split: measured re-derivation to 52/50

The `JS_HOST_CHUNKS`/`STANDALONE_CHUNKS` split in
`scripts/gen-test262-mg-matrix.mjs` was rebalanced to 58/44 on 2026-08-14
(the "THIRD ratio drift" note) using an **estimated** ×1.4 standalone growth
(ratio 1.31). Measurement across three green merge_group runs on 2026-08-15
shows the estimate overshot: the standalone lane is still the wall-clock tail
of every run, and the js-host lane's cost has dropped substantially since the
2026-07-31 numbers (compile-speedup lane #4425/#4431/#4432 among others).

## Measurements (2026-08-15, `Run shard` step durations per the generator's
own re-derivation procedure)

| run | js-host (58 shards) | standalone (44 shards) | ratio |
| --- | --- | --- | --- |
| 31870031833 (pr-4536) | 22,923 rs, mean 395 s, max 536 s | 21,769 rs, mean 495 s, max 568 s | 1.053 |
| 31872537807 (pr-4537) | 22,452 rs, mean 387 s, max 445 s | 21,384 rs, mean 486 s, max 576 s | 1.050 |
| 31873778381 (pr-4538) | 22,261 rs, mean 384 s, max 431 s | 21,730 rs, mean 494 s, max 560 s | 1.024 |

- True host/standalone work ratio: **1.02–1.05** (assumed: 1.31).
- Per-shard imbalance today: standalone ~490 s vs js-host ~385 s — ~105 s of
  avoidable tail on every merge_group run (the last finisher is always a
  standalone shard; verified again on run 31873778381).
- Balanced split of the same 102-shard budget: **52 js-host / 50 standalone**
  → both lanes land at ~428–441 s mean. Same total runner budget; no change
  to `MERGE_GROUP_RUNNER_CAPACITY` (120) or `MERGE_GROUP_RESERVED_RUNNERS`
  (18).
- Also serves the 2026-08-14 note's wave-survival concern: standalone shards
  get SHORTER (~495 → ~435 s), reducing exposure to hosted-runner shutdown
  waves.

## Implementation Plan (Fable, 2026-08-15)

1. In `scripts/gen-test262-mg-matrix.mjs`:
   - `JS_HOST_CHUNKS = 58` → `52`; `STANDALONE_CHUNKS = 44` → `50`.
   - Add a "FOURTH ratio drift (2026-08-15)" comment block above the
     constants, following the established style: cite the three run ids and
     the measured totals/means from the table above, state ratio 1.03 →
     52/50, note that the THIRD derivation was an estimate (×1.4) that
     overshot, and note the js-host total's drop (29,353 → ~22.5k rs) so the
     next re-deriver knows both lanes moved. Keep the existing "RE-DERIVING
     THIS" paragraph — it is the procedure that was used.
2. Check `tests/issue-3431-mg-matrix.test.ts` (and grep for other consumers
   of `JS_HOST_CHUNKS`/`STANDALONE_CHUNKS` or hard-coded 58/44/102): update
   any count assertions to the new constants — prefer asserting
   `JS_HOST_CHUNKS + STANDALONE_CHUNKS === 102` and importing the constants
   over re-hard-coding numbers, but follow the test's existing style.
3. Do NOT touch `buildMergeGroupMatrix`'s lane-drop behavior (single-lane
   runs keep their own chunk_total — that invariant is load-bearing for
   baseline comparability, see the comment in the function).
4. Partition safety is already guaranteed (`assignBalancedChunk` is a pure
   function of (chunkIndex, totalChunks) — any total is a full, disjoint
   partition), so no test-coverage risk from changing counts; say so in the
   PR body rather than re-proving it.
5. Validation: `pnpm run typecheck`; run the matrix shape test file; run the
   generator locally (`node scripts/gen-test262-mg-matrix.mjs --lanes
   "host standalone"` or per its CLI, check it emits 52+50 entries).
6. The real proof is the next merge_group runs' lane means converging
   (~430–440 s both lanes); note in the issue that this should be spot-checked
   after a few queue merges and the ratio re-derived again if drift recurs —
   it has now drifted four times, it is a recurring check, not a constant.

## Acceptance criteria

1. Generator emits 52 js-host + 50 standalone entries; shape test green.
2. Comment block documents the fourth derivation with the run ids + numbers.
3. Typecheck + quality gates green. No other workflow behavior changed.

## Results (2026-08-15)

- `scripts/gen-test262-mg-matrix.mjs`: `JS_HOST_CHUNKS` 58 -> **52**,
  `STANDALONE_CHUNKS` 44 -> **50** (total unchanged at 102 =
  `MERGE_GROUP_RUNNER_CAPACITY` 120 - `MERGE_GROUP_RESERVED_RUNNERS` 18).
  Added the "FOURTH ratio drift (2026-08-15)" block with the three run ids,
  per-lane totals/means/maxes, the measured 1.02-1.05 ratio, and the note that
  the THIRD split was an estimate (x1.4) that overshot while js-host itself
  fell 29,353 -> ~22.5k rs. Updated the RE-DERIVING paragraph's drift count
  (twice -> four times, 2.13 -> 1.835 -> 1.31 -> 1.03).
- Dry run, `node scripts/gen-test262-mg-matrix.mjs --github-output`: 102
  entries total — **52 js-host + 50 standalone**, single-line `matrix=` output
  intact. Lane-drop runs unchanged in behavior: host-only 52, standalone-only
  50, each keeping its own `chunk_total`.
- `tests/issue-3431-mg-matrix.test.ts`: the only assertion pinning the old
  numbers was `toBeCloseTo(58 / 44, 2)` -> `toBeCloseTo(52 / 50, 2)`; drift-
  history comment extended. The `toHaveLength(102)` /
  `CAPACITY - RESERVED` assertions needed no change. **12/12 tests pass.**
- `.github/workflows/test262-sharded.yml`: the `test262-shard-mg` header
  comment still claimed "js-host=66 and standalone=36 ... 1.835:1" (stale since
  the THIRD drift). Rewritten to cite 52/50 at 1.03:1 and to point at the
  generator as the single source of truth, so it stops re-staling. Comment
  only — no workflow behavior touched.
- Grep found no other consumer of `JS_HOST_CHUNKS`/`STANDALONE_CHUNKS` or of
  the 58/44 pair; other `102` references (`scripts/set-merge-queue-config.sh`,
  `docs/ci-policy.md`) are about the unchanged total.
- Gates: `pnpm run typecheck` clean; `npm run lint` (biome src/tests/scripts)
  exit 0; `npx prettier --check` clean on all three changed files.
  `buildMergeGroupMatrix`'s lane-drop behavior untouched.
- **Follow-up (recurring, not one-off):** spot-check the next few merge_group
  runs' per-lane `Run shard` means — both should converge on ~430-440 s. The
  ratio has now drifted four times; re-derive again if one lane's max is
  consistently >~1 min past the other's.
