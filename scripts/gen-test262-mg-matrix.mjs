#!/usr/bin/env node
// gen-test262-mg-matrix.mjs — computes the merge_group-CONSOLIDATED test262
// shard matrix (#3431).
//
// Why a separate, smaller matrix just for merge_group: the merge queue can
// build up to `max_entries_to_build: 5` groups concurrently (docs/ci-policy.md
// #1956), each running the full test262-sharded.yml workflow. At the
// pull_request-era 57-shard x 2-target = 114-job matrix, 5 concurrent groups
// contend for up to 570 runner slots at once, and evidence from real
// merge_group runs (2026-07-18, runs 29632953272 et al.) shows job start
// times trickling over ~20 minutes under that contention — vs. an isolated,
// uncontended 114-job run finishing in ~15-19 minutes total. That contention
// wave, not fixed per-job setup cost (measured at ~30-45s: checkout + node +
// pnpm + bundle build), is what stretches merge_group validation to ~60+
// minutes and drains the queue at ~1 PR/hour.
//
// Fewer, bigger shards reduce the per-entry job count, and therefore the
// contention footprint under a busy queue, at the cost of a longer
// best-case (uncontended) per-shard runtime. js-host and standalone get
// DIFFERENT shard counts because they have very different per-shard runtimes
// at the SAME split — measured from a real, uncontended 57-way merge_group
// run (run 29631214965, 2026-07-18):
//   js-host:    avg 13.6 min/shard, max 15.9 min/shard (57-way)
//   standalone: avg  5.8 min/shard, max  7.0 min/shard (57-way)
// Scaling those linearly (assignBalancedChunk in test262-shared.ts balances
// by measured historical test duration, so total per-target work is
// ~constant regardless of shard count):
//   JS_HOST_CHUNKS = 40    -> est. avg ~19.4 min, max ~22.7 min  (< 25 min cap)
//   STANDALONE_CHUNKS = 19 -> est. avg ~17.4 min, max ~21.0 min  (< 25 min cap)
// Both stay under the existing 25-minute per-shard timeout (test262-shard-mg
// uses 28 min for a small safety margin instead of raising the timeout
// aggressively) with no change needed to pull_request/push/workflow_dispatch,
// which keep the full 57-shard matrix untouched.
//
// Job count: 40 + 19 = 59, vs. 114 today — a 48% reduction in the merge_group
// matrix's job count (and therefore its contention footprint under a busy
// queue), while every individual shard estimate stays inside the existing
// timeout.
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

export const JS_HOST_CHUNKS = 40;
export const STANDALONE_CHUNKS = 19;

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

export function buildMergeGroupMatrix() {
  return [
    ...buildTargetEntries("js-host", "gc", "test262", JS_HOST_CHUNKS),
    ...buildTargetEntries("standalone", "standalone", "test262-standalone", STANDALONE_CHUNKS),
  ];
}

function main() {
  const matrix = { include: buildMergeGroupMatrix() };
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
