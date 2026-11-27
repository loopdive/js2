---
id: 7565
title: "equivalence-gate under five minutes in the merge queue: forked shards, split the one giant file"
status: in-progress
created: 2026-11-27
updated: 2026-11-27
assignee: ttraenkler/equiv-speed
priority: high
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci
goal: ci-hardening
sprint: current
horizon: s
related: [7563, 7558, 6785]
---

# #7565 — `equivalence-gate` under five minutes in the merge queue

## Problem

Owner decision (2026-11-27, "Ja, Engpass angehen"). The merge queue is the
only gate and merges one pull request per run, so a run lasts as long as its
slowest required job. After #7563 (`quality` ≈ 3 min) that job is
`equivalence-gate` (`.github/workflows/ci.yml`): it waits for the 8-shard
matrix `equivalence-shard`, and shard 7 takes about 9.4 minutes. Target:
`equivalence-gate` done within about 5 minutes of the run's start, with no
check dropped or weakened.

## Step 0 — measurement

Source: REST `actions/runs/<id>/jobs` for the 16 latest `merge_group` runs of
`ci.yml` (2026-11-27 06:47 to 10:08; they read `cancelled` because the group
merged before non-required jobs finished — every equivalence shard
succeeded, except shard 7 of 45975136389, cancelled). Job wall time per
shard, minutes:

| Shard | median | min–max | tests (run 45978056241) | test step s |
| --- | ---: | ---: | ---: | ---: |
| 1 | 4.3 | 3.0–5.2 | 386 | 217 |
| 2 | 4.8 | 3.0–5.6 | 482 | 300 |
| 3 | 5.1 | 3.4–5.7 | 533 | 292 |
| 4 | 6.5 | 4.8–7.5 | 657 | 302 |
| 5 | 4.0 | 3.0–5.1 | 432 | 255 |
| 6 | 3.1 | 2.3–3.4 | 365 | 131 |
| **7** | **9.4** | 6.7–12.1 | **1,712** | **517** |
| 8 | 2.7 | 2.1–3.0 | 302 | 113 |

- `changes` takes 0.8–1.3 min before any shard starts; `equivalence-gate`
  itself is 0.1 min. Gate end: median **11.6 min** after run start.
- Setup per shard (job setup, checkout, setup-node, `pnpm install`) is
  ~30 s; the rest is the vitest step.
- **Assignment.** `SHARD=i/8` is passed to vitest as `--shard`; vitest
  (`BaseSequencer.shard`, 3.2.7) sorts files by sha1 of their repo path and
  cuts the list into 8 equal-COUNT slices (35 files each, 30 in the last).
  A file's position is stable; a new file shifts each slice boundary by at
  most one file. Nothing weighs files by cost.
- **What makes shard 7 slow: one file.** `vitest list --shard=7/8` (no
  tests run) counts 1,131 of shard 7's 1,712 tests in
  `issue-7164-externref-vec-length-growth.test.ts` — about 800 of them
  compile a module each. The other 34 files hold 581 tests, similar to the
  other shards. Shard 7's step is 517 s against a 113–302 s spread
  elsewhere; at the other shards' 0.4–0.6 s/test its other 34 files are
  ~230–290 s, so the one file is **~230–290 s on its own** (an inference —
  the JSON reporter prints no per-file time to the log; a local run of the
  file alone was not finished in 530 s on this loaded 4-core box). The
  next-largest file is `issue-7166-sort-reverse-identity.test.ts` (367 of
  shard 4's 657 tests), estimated ~150 s.
- **Single fork.** `scripts/equivalence-gate.mjs` runs vitest with
  `singleFork` + `--no-file-parallelism`, a leftover of the #1659 OOM on the
  old 7 GB runners. The public-repo `ubuntu-latest` runner has 4 vCPU and
  16 GB, so 3 of 4 cores idle. `vitest.config.ts` (#4413) measured the root
  suite at 2.08x with 4 forks on 4 cores, and sizes forks by free RAM at
  1.5 GB each.
- **Floors.** The merged check (#6785) unions the 8 partials and checks
  `passingFloor` (1,740) and `fileCount` (223) — counts, not ids — plus
  "every `*.test.ts` on disk is in some partial" and "every `i/N` slot has a
  partial". `missingShards` reads N from the partial labels; no shard count
  is baked into `scripts/equivalence-baseline.json` or its reader. The
  baseline has no `knownFailures` entry for any `issue-7164` file.

## Implementation Plan

### Design

1. **Forked shards** (`scripts/equivalence-gate.mjs`). Drop `singleFork` and
   `--no-file-parallelism`; vitest's fork pool then runs files in parallel,
   sized by `vitest.config.ts` (`VITEST_MAX_FORKS`, else cores − 1 capped by
   free RAM). The CI step sets `VITEST_MAX_FORKS=$(nproc)`: the runner does
   nothing else. Vitest starts the largest files first, so a big file does
   not trail the shard.
   *Isolation:* each file runs in its own process (vitest `isolate`, forks
   pool). In `tests/equivalence/` only `multi-file-compilation.test.ts`
   touches the filesystem (its own `tmpdir()/js2wasm-test-<ms>` directory);
   the compiler's on-disk caches (`src/temporal-provider.ts`,
   `src/test262-harness-provider.ts`) publish by staging + rename and already
   handle a lost race; there are no servers, ports or child processes. The
   root suite and local `npm test` already run these files multi-fork.
2. **Split the one giant file** along its existing `describe` groups into
   three files of roughly equal compile count (~250 / ~300 / ~310), moving
   the shared lane table, `pinLane`, the `ENC` hash and the thrice-copied
   `read` summary loop into one helper module
   `tests/equivalence/issue-7164-lanes.ts` (removes the duplicate). Test
   names do not change; ids move to the new file names, and no known
   failure references them. Comments naming the old file
   (`issue-7164-length-update-sweep-cases.ts`, `scripts/record-7164-bases.mts`)
   are updated.
3. **Per-file times in the log.** After each run the gate prints the slowest
   files (from the vitest JSON report's `startTime`/`endTime`) and emits a
   `::warning` for any file over 90 s, naming it — so the next giant is
   visible in the first queue run that carries it instead of needing this
   kind of archaeology. A warning, not a failure: timing is noisy.

Why not the other options:

- *Weighted assignment / committed timing file.* The imbalance is one file,
  not the slicing; with forks a shard costs about max(largest file,
  sum / 2), so count-equal slices are within budget once no file exceeds
  it. A timing file is a pin that rots, and a cache-fed one must be the same
  in all 8 shards or a file runs zero or two times.
- *More shards.* Costs runners the test262 matrix needs and cannot split a
  file.

New files: vitest hashes them into a slot like any other; the partition
property (every file in exactly one shard) does not depend on the file list.
A new file heavier than ~90 s shows up as a warning.

### Runner budget

No runners added: 8 shards as today, each shorter. `MERGE_GROUP_RESERVED_RUNNERS`
(18) and the test262 shard count (102) are unchanged. Runner-minutes per
queue run drop from ~41 to ~25.

### Expected time

`changes` 1.2 + setup 0.5 + slowest shard step + gate 0.2. Slowest shard
step: the other shards at ~2x are 60–150 s; the 7164 parts (~80–100 s each)
and 7166 (~150 s) bound a shard from below. ≈ 1.2 + 0.5 + 2.5–3 + 0.2 ≈
**4.4–4.9 min** (from 11.6).

### Fail-closed walk

The job graph does not change: `equivalence-shard` (`needs: changes`,
`fail-fast: false`) and `equivalence-gate` (`needs: [changes,
equivalence-shard]`, `if: always() && …`, fails unless the matrix result is
`success`, then the merged floor check) keep their ids, `if:`s and `needs`.
`tests/issue-7551-job-skip-propagation.test.ts` already covers them.

### Acceptance criteria

- `equivalence-gate` done ≤ ~5 min after run start in `merge_group` (only a
  live queue run proves this; the gate's new per-file lines then replace the
  estimates above).
- Every equivalence test file still runs exactly once per queue run: a test
  runs vitest's real `BaseSequencer.shard` over the real file list for N = 8
  and checks every file lands in exactly one shard.
- `scripts/*-baseline.json` unchanged; required context still exactly
  `equivalence-gate`.
- Code quality: one helper module replaces the three copies of the summary
  loop and the per-section lane setup; the three 7164 files follow one shape;
  the gate change is the fork flags plus one report function.
- `SHARD=1/8 node scripts/equivalence-gate.mjs` still works locally;
  CLAUDE.md and `docs/ci-policy.md` describe the forked shards.
