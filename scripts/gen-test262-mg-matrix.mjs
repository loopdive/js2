#!/usr/bin/env node
// gen-test262-mg-matrix.mjs — computes the merge_group-CONSOLIDATED test262
// shard matrix (#3431).
//
// Why merge_group has its own matrix: the queue previously allowed five
// speculative groups to build concurrently. At 114 jobs per group that meant
// up to 570 shard jobs competing for the 120-runner pool; enqueue/dequeue churn
// also invalidated descendant groups and restarted work that could never land.
// The active main ruleset was therefore changed to `max_entries_to_build: 1`.
// With only one stable group in flight, throughput now comes from parallelism
// *inside* that group rather than from keeping the per-group matrix small.
//
// The pool has 120 four-core runners and every shard intentionally uses all
// four cores (`COMPILER_POOL_SIZE=4`). Reserve runners for the overlapping
// CI quality/equivalence jobs, the differential workflow, the Test262 gate,
// and short-lived orchestration jobs. The rest are assigned to Test262, so a
// serial queue entry can use the fleet without starving its other required
// checks.
//
// RESERVE SIZING (#3914, measured 2026-07-31). The reserve was 14, which put
// the matrix at 106 shards. That is over the real ceiling: merge_group run
// 30631849709 started 101 of its 106 shard jobs at t+44-52 s but **5 of them
// at t+90-184 s**, and the last-finishing job in the whole run was one of the
// starved ones (standalone 2/34: started t+134 s, ran 575 s, ended t+709 s).
// Concurrent demand at t+45 s is 106 shards + 13 ci.yml merge_group jobs
// (`changes`, `quality`, `cancel-test262-on-quality-failure`, `linear-tests`,
// `equivalence-shard` x8, `equivalence-gate`) + this workflow's `cheap gate`
// and `changes` = ~121, i.e. just over the 120 ceiling. A 14-runner reserve
// therefore bought 4 extra shards and paid for them with ~89 s of start skew
// on the critical path. 18 is the honest number.
//
// js-host and standalone get DIFFERENT counts because their measured work is
// not equal. RATIO (re-derived from merge_group run 30631849709, 2026-07-31,
// the 72/34 matrix). `Run shard` step timings:
//   js-host:    29,353 runner-seconds total, mean 408 s, max 468 s (72 jobs)
//   standalone: 16,000 runner-seconds total, mean 471 s, max 542 s (34 jobs)
// That is a **1.835** work ratio, NOT the 2.13 the 72/34 split was scaled
// from (measured on run 29807524490 at 34/19, before the lanes' relative cost
// shifted). At 72/34 the lanes are therefore inverted again: standalone is the
// long pole by ~74 s of `Run shard` time. 66/36 = 1.833 matches the measured
// ratio, and at 102 shards both lanes land on ~444 s of mean shard work —
// ~510 s at the observed per-lane max/mean skew (1.147 host, 1.151
// standalone), i.e. within ~2 s of each other, with a ~39 s fixed per-job
// overhead (setup + checkout + install + bundle + upload, median measured)
// on top. Ample margin under the 25-minute job timeout.
//
// Net expected effect vs. 72/34 + reserve 14: the critical shard job goes from
// "starts t+134 s, ends t+709 s" to "starts t+45 s, ends t+~596 s" — about
// 113 s off every src-touching merge_group run. Under a serial queue that is
// a direct throughput gain.
//
// The host lane is costlier primarily because both lanes still compile the
// honest full in-Wasm harness, while the host target emits JS/Wasm interop glue.
// In run 29807524490 host compilation totaled 77.7M ms vs. 42.3M ms for
// standalone; execution was only 2.4M vs. 0.7M ms. Host also reaches more
// passing tests and therefore performs more strict-mode recompilations.
//
// RE-DERIVING THIS: pull the `Run shard` step durations for a completed
// merge_group run, sum them per lane, and split the shard budget by the two
// sums. If one lane's max job is consistently more than ~1 min past the
// other's, the ratio has drifted again — that is the signal to redo it, and
// it has now drifted four times (2.13 -> 1.835 -> 1.31 -> 1.03), so treat it
// as a recurring check rather than a constant.
//
// The underlying partition (assignBalancedChunk, test262-shared.ts) is a
// pure function of (chunkIndex, totalChunks): it re-derives the FULL test262
// corpus and greedily bin-packs it into `totalChunks` bins by historical
// duration, so it produces a strict, non-overlapping, full-coverage
// partition for ANY totalChunks >= 1 — changing the shard count here cannot
// drop or duplicate tests. See tests/issue-3431-mg-matrix.test.ts for a
// dry-run check of this script's output shape, and
// tests/test262-chunk-dynamic.test.ts for the runtime entry point each
// matrix cell invokes (index/total supplied via env vars instead of being
// baked into a per-shard filename).

export const MERGE_GROUP_RUNNER_CAPACITY = 120;
export const MERGE_GROUP_RESERVED_RUNNERS = 18;
// THIRD ratio drift (2026-08-14, the #4157 tuned-defaults flip): standalone
// `Run shard` work grew ~40 % under tuned emission (#4157 entry 43) while
// js-host medians stayed flat (8.1 -> 8.2 min measured across the flip in
// merge_group runs 31741566801 vs 31743784768). Re-derived split: host
// 29,353 rs vs standalone 16,000 x 1.4 = 22,400 rs -> ratio 1.31 -> 58/44 of
// the same 102-shard budget (means ~506 s vs ~509 s, balanced). The practical
// stake is wave survival, not just throughput: GitHub-hosted runner shutdown
// waves (five windows on 2026-08-13) kill long jobs preferentially, and
// post-flip 36-way standalone shards ran 20-36+ min — 2-4x the exposure of
// every PR that merged through the same windows. 44-way puts standalone jobs
// back at the ~15-min profile that demonstrably survives.
// FOURTH ratio drift (2026-08-15): the THIRD split above was an ESTIMATE
// (standalone 16,000 rs x 1.4 for the tuned-emission flip) and it overshot.
// Measured `Run shard` totals across three green merge_group runs at 58/44:
//   run 31870031833 (pr-4536): js-host 22,923 rs, mean 395 s, max 536 s
//                              standalone 21,769 rs, mean 495 s, max 568 s
//   run 31872537807 (pr-4537): js-host 22,452 rs, mean 387 s, max 445 s
//                              standalone 21,384 rs, mean 486 s, max 576 s
//   run 31873778381 (pr-4538): js-host 22,261 rs, mean 384 s, max 431 s
//                              standalone 21,730 rs, mean 494 s, max 560 s
// True work ratio is **1.02-1.05** (call it 1.03), not the assumed 1.31.
// BOTH lanes moved, which is why the estimate missed: standalone grew roughly
// as predicted (16,000 -> ~21.6k rs) but js-host also FELL hard (29,353 ->
// ~22.5k rs) as the compile-speedup work landed (#4425/#4431/#4432 among
// others), so scaling only the standalone side could not land on the right
// ratio. At 58/44 standalone is therefore still the tail of every run (~490 s
// vs ~385 s per shard, i.e. ~105 s of avoidable tail; the last finisher was a
// standalone shard on all three runs). 52/50 of the same 102-shard budget puts
// both lanes at ~428-441 s mean. Unchanged: MERGE_GROUP_RUNNER_CAPACITY (120)
// and MERGE_GROUP_RESERVED_RUNNERS (18). Shorter standalone shards also cut
// exposure to the hosted-runner shutdown waves the THIRD note was worried
// about (~495 -> ~435 s).
export const JS_HOST_CHUNKS = 52;
export const STANDALONE_CHUNKS = 50;

/**
 * @param {string} targetName matrix job-name suffix, e.g. "js-host"
 * @param {string} test262Target TEST262_TARGET env value, e.g. "gc"
 * @param {string} resultPrefix TEST262_RESULT_PREFIX env value
 * @param {number} chunkTotal number of shards for this target
 */
export function buildTargetEntries(targetName, test262Target, resultPrefix, chunkTotal) {
  const entries = [];
  for (let i = 0; i < chunkTotal; i++) {
    entries.push({
      target_name: targetName,
      test262_target: test262Target,
      result_prefix: resultPrefix,
      chunk_index: i,
      chunk_total: chunkTotal,
      // 1-based label to match the existing test262-chunkN naming convention
      // used by the static (pull_request/push/workflow_dispatch) matrix.
      chunk_label: i + 1,
    });
  }
  return entries;
}

/**
 * Build the merge_group matrix, optionally restricted to the lanes whose
 * results the queued change can actually move.
 *
 * The `changes` job classifies the queued diff with
 * `scripts/test262-paths-match.sh --target host|standalone` and passes the
 * verdict in; a lane that provably cannot move (e.g. js-host for a change that
 * only refreshes tests/test262-slow-tests-standalone.json) is dropped from the
 * matrix entirely rather than scheduled and thrown away.
 *
 * SHARD COUNTS ARE NOT REBALANCED when a lane is dropped. Each lane keeps its
 * own chunk_total so its partition (assignBalancedChunk, a pure function of
 * (chunkIndex, totalChunks)) stays IDENTICAL to a full run — a single-lane run
 * must be directly comparable to the baseline that a two-lane run produced.
 * Spending the freed runners on more shards for the surviving lane would
 * re-partition it, which is a change we have no measurement for; the win here
 * is the ~66 or ~36 jobs not run at all.
 *
 * @param {{ host?: boolean, standalone?: boolean }} [lanes]
 */
export function buildMergeGroupMatrix(lanes = {}) {
  const { host = true, standalone = true } = lanes;
  // Neither lane selected should be unreachable (the caller gates the whole
  // job on run_shards), but an EMPTY matrix is a workflow-level error in
  // GitHub Actions, not a skipped job — so fail safe to the full matrix and
  // let the job's own `if:` decide whether to run at all.
  if (!host && !standalone) return buildMergeGroupMatrix({ host: true, standalone: true });
  return [
    ...(host ? buildTargetEntries("js-host", "gc", "test262", JS_HOST_CHUNKS) : []),
    ...(standalone ? buildTargetEntries("standalone", "standalone", "test262-standalone", STANDALONE_CHUNKS) : []),
  ];
}

/**
 * Parse `--lanes host,standalone` (default: both). Unknown lane names are a
 * hard error rather than a silent drop — silently emitting a narrower matrix
 * than the caller asked for would skip conformance coverage.
 */
export function parseLanes(argv) {
  const flag = argv.find((a) => a === "--lanes" || a.startsWith("--lanes="));
  if (!flag) return { host: true, standalone: true };
  const raw = flag.startsWith("--lanes=") ? flag.slice("--lanes=".length) : argv[argv.indexOf(flag) + 1];
  const names = String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const n of names) {
    if (n !== "host" && n !== "standalone") {
      throw new Error(`gen-test262-mg-matrix: unknown lane '${n}' (expected host or standalone)`);
    }
  }
  // An empty/absent value means "no lane selected"; buildMergeGroupMatrix
  // fail-safes that back to the full matrix.
  return { host: names.includes("host"), standalone: names.includes("standalone") };
}

function main() {
  const matrix = { include: buildMergeGroupMatrix(parseLanes(process.argv)) };
  const json = JSON.stringify(matrix);
  if (process.argv.includes("--github-output")) {
    // Single-line JSON — safe for a GITHUB_OUTPUT `key=value` assignment.
    console.log(`matrix=${json}`);
  } else {
    console.log(JSON.stringify(matrix, null, 2));
  }
}

// Only run when executed directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
