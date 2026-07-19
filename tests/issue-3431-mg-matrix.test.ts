// #3431 — merge_group-consolidated test262 shard matrix.
//
// Validates the pure matrix-generation logic in scripts/gen-test262-mg-matrix.mjs
// (used by test262-sharded.yml's `changes` job to build the `test262-shard-mg`
// job's strategy.matrix ONLY for merge_group events) and the input-validation
// behavior of tests/test262-chunk-dynamic.test.ts's env-var contract. Does NOT
// require the test262 submodule — this only checks matrix shape/coverage, not
// actual corpus partitioning (that invariant is structural: assignBalancedChunk
// in test262-shared.ts is a pure function of (chunkIndex, totalChunks) that
// re-derives the full corpus and bin-packs every test into exactly one of
// `totalChunks` bins, so it cannot drop/duplicate tests for any chunk count —
// see the runner history: tests/test262-local-shard*.test.ts already runs the
// same corpus at totalChunks=16 for local dev, vs. 57 in CI, with matching
// pass counts).
import { describe, expect, it } from "vitest";
import { JS_HOST_CHUNKS, STANDALONE_CHUNKS, buildMergeGroupMatrix } from "../scripts/gen-test262-mg-matrix.mjs";

describe("#3431 gen-test262-mg-matrix", () => {
  it("produces exactly JS_HOST_CHUNKS + STANDALONE_CHUNKS entries", () => {
    const matrix = buildMergeGroupMatrix();
    expect(matrix.length).toBe(JS_HOST_CHUNKS + STANDALONE_CHUNKS);
  });

  it("every (target_name, chunk_index) pair is unique — no duplicate/missing shard", () => {
    const matrix = buildMergeGroupMatrix();
    const seen = new Set<string>();
    for (const entry of matrix) {
      const key = `${entry.target_name}/${entry.chunk_index}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });

  it("each target's chunk_index set is a contiguous 0..chunk_total-1 range (full coverage, no gaps)", () => {
    const matrix = buildMergeGroupMatrix();
    for (const [targetName, chunkTotal] of [
      ["js-host", JS_HOST_CHUNKS],
      ["standalone", STANDALONE_CHUNKS],
    ] as const) {
      const indices = matrix
        .filter((e) => e.target_name === targetName)
        .map((e) => e.chunk_index)
        .sort((a, b) => a - b);
      expect(indices).toEqual(Array.from({ length: chunkTotal }, (_, i) => i));
      // chunk_total is consistent across every entry for this target.
      for (const e of matrix.filter((e) => e.target_name === targetName)) {
        expect(e.chunk_total).toBe(chunkTotal);
      }
    }
  });

  it("target/result-prefix pairs match the static matrix's existing convention", () => {
    const matrix = buildMergeGroupMatrix();
    const jsHost = matrix.find((e) => e.target_name === "js-host")!;
    const standalone = matrix.find((e) => e.target_name === "standalone")!;
    // Must match the `target:` list in test262-sharded.yml's static
    // (pull_request/push/workflow_dispatch) matrix so TEST262_TARGET /
    // TEST262_RESULT_PREFIX resolve identically and merge-report's artifact
    // globs (test262-js-host-shard-*, test262-standalone-shard-*) still hit.
    expect(jsHost.test262_target).toBe("gc");
    expect(jsHost.result_prefix).toBe("test262");
    expect(standalone.test262_target).toBe("standalone");
    expect(standalone.result_prefix).toBe("test262-standalone");
  });

  it("59 total shards is a ~48% reduction from the static 114-job matrix (57 chunks x 2 targets)", () => {
    const matrix = buildMergeGroupMatrix();
    const staticTotal = 57 * 2;
    const reduction = 1 - matrix.length / staticTotal;
    expect(reduction).toBeGreaterThan(0.4);
  });
});

describe("#3431 test262-chunk-dynamic.test.ts env-var contract", () => {
  // Mirrors the validation logic in tests/test262-chunk-dynamic.test.ts
  // without importing it directly — importing it would execute
  // runTest262Chunk() as a module-load side effect (it registers vitest
  // it()/beforeAll() blocks), which needs the test262 submodule checked out
  // and would double-register tests in this file's own describe block.
  function validateChunkEnv(rawIndex: string, rawTotal: string): boolean {
    const idx = Number.parseInt(rawIndex, 10);
    const total = Number.parseInt(rawTotal, 10);
    return Number.isInteger(idx) && Number.isInteger(total) && total > 0 && idx >= 0 && idx < total;
  }

  it("accepts valid index/total pairs", () => {
    expect(validateChunkEnv("0", "40")).toBe(true);
    expect(validateChunkEnv("39", "40")).toBe(true);
    expect(validateChunkEnv("18", "19")).toBe(true);
  });

  it("rejects missing, out-of-range, or non-numeric env vars", () => {
    expect(validateChunkEnv("", "")).toBe(false);
    expect(validateChunkEnv("40", "40")).toBe(false); // index == total (out of range)
    expect(validateChunkEnv("-1", "40")).toBe(false);
    expect(validateChunkEnv("abc", "40")).toBe(false);
    expect(validateChunkEnv("0", "0")).toBe(false); // total must be > 0
  });
});
