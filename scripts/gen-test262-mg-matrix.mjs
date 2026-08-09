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
// it has now drifted twice (2.13 -> 1.835), so treat it as a recurring check
// rather than a constant.
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
export const JS_HOST_CHUNKS = 66;
export const STANDALONE_CHUNKS = 36;

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
