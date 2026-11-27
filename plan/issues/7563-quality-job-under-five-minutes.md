---
id: 7563
title: "quality under five minutes in the merge queue: parallel lanes, one blobless history fetch"
status: in-progress
created: 2026-11-27
updated: 2026-11-27
assignee: ttraenkler/quality-speed
priority: high
feasibility: medium
reasoning_effort: high
task_type: ci
area: ci
goal: ci-hardening
sprint: current
horizon: s
related: [7558, 7556, 7551]
---

# #7563 — `quality` under five minutes in the merge queue

## Problem

Owner decision (2026-11-27, "Quality beschleunigen"). Since #7558 the merge
queue is the only gate and builds one entry at a time
(`max_entries_to_build: 1`), so a queue run lasts as long as its slowest
required job. Every other required job finishes in about 5 minutes;
`quality` (`.github/workflows/ci.yml`) takes about 14. That makes `quality`
the clock of the queue: 18 merges in 3 hours with ~100 PRs waiting.

Target: `quality` wall time in `merge_group` at most 5 minutes, with no check
dropped or weakened.

## Step 0 — measurement

Source: REST `actions/jobs/<id>` for the `quality` job of the last 37
`merge_group` runs of `ci.yml` with a successful `quality` job (2026-11-26
08:03 to 2026-11-27 08:42; most runs read `cancelled` because their group
merged before the non-required shards finished; the `quality` job itself
succeeded). The 12 runs from 05:36 onward carry the #7558 root-test steps;
the table uses those 12. Job wall time: **median 837 s, max 1,302 s, min
614 s.** The steps run strictly one after the other, so the job time is
their sum.

| Step | median s | max s | What it is |
| --- | ---: | ---: | --- |
| Changed root test files must pass (#3008) | 156 | 484 | one cold vitest process per changed `tests/*.test.ts`, serial; one file took 352 s alone |
| Select changed root test files (#3008/#7558) | 108 | 120 | ~98 s are two `git fetch` calls (`--depth=200` main, `--deepen=200` HEAD) that pull full blobs on a depth-2 clone; the selection itself is <1 s |
| Lint, format, and typecheck (parallel) | 96 | 129 | three processes in parallel on the 4-vCPU runner |
| Required guard suite (#3552) | 76 | 103 | 21 curated files, one single-fork vitest run |
| Import-cycle ratchet (#6797) | 67 | 75 | ~60 s is `git fetch --depth=200 origin main` (full blobs); the check is 4 s. Every later `git fetch` in the job is then a 2 s no-op |
| Dogfood emitted-binary validation floor (#5336) | 43 | 56 | compiles six npm-compat tarballs |
| Dead-export gate (#3090) | 36 | 45 | call-graph scan |
| IR fallback gate (#1376) | 24 | 33 | compiles the playground corpus |
| Benchmark staleness gate (#1580) | 19 | 25 | one vitest file |
| Compile and run the playground default example | 18 | 24 | one vitest file |
| Host-import allowlist + strict-mode gate (#1524) | 18 | 23 | two vitest files |
| IR alloc-provenance checker (#1586) | 15 | 18 | vitest |
| Prepare Test262 harness inputs for changed root tests | 15 | 18 | two submodules + two esbuild bundles |
| Setup Node and pnpm / checkout / pnpm install | 14 / 13 / 7 | 16 / 15 / 8 | setup-node and pnpm store caches hit in every run sampled; checkout is depth 2 |
| Native-first host semantic debt gate (#4401) | 11 | 13 | |
| 37 remaining steps | 1–7 each, ~70 together | | ratchets, issue gates, IR gates |

Two findings carry most of the gain:

1. **About 160 s per run is git transfer, not checking.** Both full-blob
   fetches of 200 commits exist only to give the change-scoped gates and the
   root-test selector commit history. Measured on this box (4 cores, the
   same repository, from a depth-2 fetch of main): `--depth=200` main 70 s and
   `--deepen=200` HEAD 56 s with blobs; with `--filter=blob:none` 15 s and
   14.5 s. The `git diff --name-only --diff-filter=AMR` selection over 40
   commits gives byte-identical output in both clones (169 paths).
2. **Everything else is serial only because it sits in one job.** The gates
   are independent; no step reads another's output except the two artifact
   uploads, which stay next to their producers.

## Implementation Plan

### Target structure (one module: `.github/workflows/ci.yml`)

- `quality-lane` — one matrix job holding today's `quality` steps unchanged,
  each step gated by `matrix.lane == '<lane>'` in addition to the existing
  npm-compat guard. Shared setup (checkout, npm-compat classifier,
  setup-node, install) appears once. `fail-fast: false`, so a failure reports
  every lane's verdict.
- `quality` — the required context, now an aggregator: `needs: quality-lane`,
  `if: always() && github.event_name != 'pull_request'`, one step that fails
  unless `needs.quality-lane.result == 'success'`. Same job id, no `name:`,
  so the check context stays exactly `quality`.
- One `Fetch main history (blobless)` step replaces the eleven per-step
  `git fetch … origin main` lines and the two fetches inside the root-test
  selector. It runs in the two lanes that need history (`ratchets`, and
  `root-tests` in the queue) and fails closed, as the selector already did.

### Per-step decision

| Step(s) | Decision | Lane |
| --- | --- | --- |
| Changed root test files must pass | **split**: three static shards; each takes every third file of the one selection (`awk`), the 20-file cap then applies per shard | `root-tests` 1/3, 2/3, 3/3 |
| Select changed root test files | **cheaper**: blobless fetch; selection and fail-closed contract unchanged. A shard with no files skips setup-node, install and the harness preparation | `root-tests` |
| Prepare Test262 harness inputs | **leave** (only where this shard has files) | `root-tests` |
| Lint, format, typecheck; playground example | **split** off | `lint` |
| Required guard suite, host-import allowlist, excusal tests, alloc checker | **split** off | `guards` |
| All IR gates, dead-exports, stack-balance, codegen fallbacks, harness compile budget, orphaned scripts, tracked-ignored | **split** off | `ir` |
| Import cycles, flat-dir, oracle, pushraw, LOC, per-function LOC, coercion, standalone arms, issue gates, CLAUDE.md paths, verdict oracle, conformance and badge sync, dogfood floor, benchmark staleness, the two push-only planning steps | **split** off; per-step fetches **removed** in favour of the one blobless fetch (they only feed the merge-base fallback; in the queue the gates diff against `HEAD^1`) | `ratchets` |

Nothing is narrowed, cached or removed as a duplicate: every check runs in
every `merge_group` exactly as today. The only check that changes behaviour
is the root-test cap, which gets wider (20 per shard instead of 20 in all).

### Expected wall time (medians from Step 0)

Each lane pays ~36 s of setup (job setup 1, checkout 13, classifier 1,
setup-node 14, install 7). Lane work: `lint` 114 s, `ir` ~120 s, `guards`
~113 s, `ratchets` ~20 s fetch + ~110 s, a non-empty `root-tests` shard ~20 s
fetch/select + 15 s prepare + its share of the files. Critical path ≈ 36 +
~130 + aggregator ~15 ≈ **3 min** median. Bound: the slowest single changed
root test file plus ~1.5 min; the observed worst file (352 s) still gives ~7
min, which no split below file level can fix.

### Runner budget

+7 concurrent runners (4 fixed lanes for ~2.5 min, 3 root-test shards for
~0.5 min when empty and up to the slowest file when not) plus the aggregator
for seconds, replacing one runner for ~14 min. Runner-minutes per queue run
stay about equal (~14), because ~2.5 min of git transfer disappears. These
start at the same moment as the 102 test262 runners, so the ~120-runner
account limit is touched during the first ~3 minutes of each queue run.

### Fail-closed walk

- `quality-lane` keeps `if: github.event_name != 'pull_request'`; on a pull
  request it and `quality` are skipped and `quality` still publishes a
  `skipped` check run, as today.
- In `merge_group`, `quality` runs under `always()` whatever `quality-lane`
  did; a failed, cancelled or skipped lane makes the aggregator exit 1.
- A step whose `matrix.lane` names no lane would silently never run; the test
  asserts every named lane exists and every lane owns at least one step.
- `cancel-test262-on-quality-failure` keeps `needs: quality`.

### Acceptance criteria

- `quality` median in `merge_group` ≤ 5 min over the first runs after merge
  (only a live queue run proves this).
- The required contexts and `scripts/*-baseline.json` are unchanged.
- `tests/issue-7551-job-skip-propagation.test.ts` proves: `quality` exists
  with that exact id and no `name:`; its verdict step fails for `failure`,
  `cancelled` and `skipped` and passes only for `success`; it needs every
  `quality-*` job; every lane named by a step exists in the matrix and owns a
  step; the root-test shards partition the selection; pull request still
  publishes `quality`.
- Code quality: one matrix job, no copied job bodies, no per-step fetch left,
  no dead step.
