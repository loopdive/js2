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
// JS-host Test262 is retired. Its former share of the existing budget now
// belongs to standalone; keep the 18-runner reserve for other required checks.
// Baseline, dispatch, refresh and merge-group runs all use this partition.
export const MERGE_GROUP_RUNNER_CAPACITY = 120;
export const MERGE_GROUP_RESERVED_RUNNERS = 18;
export const JS_HOST_CHUNKS = 0;
export const STANDALONE_CHUNKS = MERGE_GROUP_RUNNER_CAPACITY - MERGE_GROUP_RESERVED_RUNNERS;

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
 * Build the active standalone lane. A retired host selection cannot revive
 * JS-host shards, and an empty selection stays well-formed for skipped jobs.
 * @param {{ host?: boolean, standalone?: boolean }} [_lanes]
 */
export function buildMergeGroupMatrix(_lanes = {}) {
  return buildTargetEntries("standalone", "standalone", "test262-standalone", STANDALONE_CHUNKS);
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
