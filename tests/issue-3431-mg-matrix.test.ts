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
import {
  JS_HOST_CHUNKS,
  MERGE_GROUP_RESERVED_RUNNERS,
  MERGE_GROUP_RUNNER_CAPACITY,
  STANDALONE_CHUNKS,
  buildMergeGroupMatrix,
  parseLanes,
} from "../scripts/gen-test262-mg-matrix.mjs";

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
    expect(matrix.some((e) => e.target_name === "js-host")).toBe(false);
    const standalone = matrix.find((e) => e.target_name === "standalone")!;
    // Must match the `target:` list in test262-sharded.yml's static
    // (pull_request/push/workflow_dispatch) matrix so TEST262_TARGET /
    // TEST262_RESULT_PREFIX resolve identically and merge-report's artifact
    // globs (test262-js-host-shard-*, test262-standalone-shard-*) still hit.
    expect(standalone.test262_target).toBe("standalone");
    expect(standalone.result_prefix).toBe("test262-standalone");
  });

  it("uses the serial queue's runner budget while reserving capacity for other required checks", () => {
    const matrix = buildMergeGroupMatrix();
    expect(matrix).toHaveLength(102);
    expect(matrix.length).toBe(MERGE_GROUP_RUNNER_CAPACITY - MERGE_GROUP_RESERVED_RUNNERS);
    expect(JS_HOST_CHUNKS).toBe(0);
    expect(STANDALONE_CHUNKS).toBe(102);
  });
});

describe("per-lane merge_group matrix (single-lane runs)", () => {
  // The `changes` job drops a lane whose results the queued diff provably
  // cannot move (see scripts/test262-paths-match.sh --target). These pin the
  // two properties that make that safe.
  it("never revives the retired host lane, including a legacy host-only request", () => {
    const hostOnly = buildMergeGroupMatrix({ host: true, standalone: false });
    expect(hostOnly).toHaveLength(STANDALONE_CHUNKS);
    expect(hostOnly.every((e) => e.target_name === "standalone")).toBe(true);

    const standaloneOnly = buildMergeGroupMatrix({ host: false, standalone: true });
    expect(standaloneOnly).toHaveLength(STANDALONE_CHUNKS);
    expect(standaloneOnly.every((e) => e.target_name === "standalone")).toBe(true);
  });

  it("keeps the active lane partition identical for every legacy selection", () => {
    // Load-bearing: a single-lane run's results are diffed against a baseline
    // produced by two-lane runs. assignBalancedChunk is a pure function of
    // (chunk_index, chunk_total), so the freed runners must NOT be spent
    // re-partitioning the surviving lane into more shards.
    const full = buildMergeGroupMatrix();
    for (const lanes of [
      { host: true, standalone: false },
      { host: false, standalone: true },
    ]) {
      for (const entry of buildMergeGroupMatrix(lanes)) {
        const twin = full.find((e) => e.target_name === entry.target_name && e.chunk_index === entry.chunk_index);
        expect(twin).toEqual(entry);
      }
    }
  });

  it("defaults and fail-safes to standalone", () => {
    const both = buildMergeGroupMatrix();
    expect(buildMergeGroupMatrix({})).toEqual(both);
    // An empty matrix is a workflow-level error in GitHub Actions, not a
    // skipped job — and skipping coverage is the wrong direction anyway.
    expect(buildMergeGroupMatrix({ host: false, standalone: false })).toEqual(both);
  });

  it("parseLanes maps the CLI flag to lane selections, both-lanes by default", () => {
    expect(parseLanes(["node", "gen.mjs"])).toEqual({ host: true, standalone: true });
    expect(parseLanes(["node", "gen.mjs", "--lanes", "host,standalone"])).toEqual({
      host: true,
      standalone: true,
    });
    expect(parseLanes(["node", "gen.mjs", "--lanes=host"])).toEqual({ host: true, standalone: false });
    expect(parseLanes(["node", "gen.mjs", "--lanes", "standalone"])).toEqual({
      host: false,
      standalone: true,
    });
    // Empty value = "no lane selected" -> buildMergeGroupMatrix fail-safes it.
    expect(parseLanes(["node", "gen.mjs", "--lanes", ""])).toEqual({ host: false, standalone: false });
  });

  it("parseLanes rejects an unknown lane instead of silently narrowing coverage", () => {
    expect(() => parseLanes(["node", "gen.mjs", "--lanes", "hsot"])).toThrow(/unknown lane/);
    expect(() => parseLanes(["node", "gen.mjs", "--lanes", "host,gc"])).toThrow(/unknown lane/);
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
    expect(validateChunkEnv("0", "72")).toBe(true);
    expect(validateChunkEnv("71", "72")).toBe(true);
    expect(validateChunkEnv("33", "34")).toBe(true);
  });

  it("rejects missing, out-of-range, or non-numeric env vars", () => {
    expect(validateChunkEnv("", "")).toBe(false);
    expect(validateChunkEnv("72", "72")).toBe(false); // index == total (out of range)
    expect(validateChunkEnv("-1", "72")).toBe(false);
    expect(validateChunkEnv("abc", "72")).toBe(false);
    expect(validateChunkEnv("0", "0")).toBe(false); // total must be > 0
  });
});
