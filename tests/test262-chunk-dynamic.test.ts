/**
 * Test262 DYNAMIC chunk — index/total supplied via TEST262_CHUNK_INDEX /
 * TEST262_CHUNK_TOTAL env vars instead of being baked into the filename.
 *
 * Used ONLY by the merge_group-consolidated shard matrix (#3431,
 * scripts/gen-test262-mg-matrix.mjs) to run fewer, bigger shards without
 * touching the static 57-way tests/test262-chunkN.test.ts set that
 * pull_request/push/workflow_dispatch keep using unchanged. The underlying
 * partition logic (assignBalancedChunk in test262-shared.ts) is a pure
 * function of (chunkIndex, totalChunks) — it does not read the calling
 * filename — so this file is a drop-in equivalent to the static
 * test262-chunkN.test.ts files, just parameterized at runtime.
 *
 * NO-OP OUTSIDE ITS MATRIX CONTEXT (#3431): when this file is picked up by
 * any plain vitest invocation that does NOT set the chunk env vars — e.g. the
 * `quality` job's #3008 "changed root test files must pass" gate (which runs
 * every root tests/*.test.ts file a PR adds/modifies), or a full tests/**
 * sweep — it must be an inert skip, not a hard failure. Calling
 * runTest262Chunk() here would need the shard-matrix env to slice the corpus
 * meaningfully; without it the only correct behavior is to skip. The
 * hard-throw is retained for the DIFFERENT case where the env vars ARE
 * present but INVALID (a genuinely malformed in-matrix config that should
 * fail loudly).
 */
import { describe, it } from "vitest";
import { runTest262Chunk } from "./test262-shared.js";

const rawIndex = process.env.TEST262_CHUNK_INDEX ?? "";
const rawTotal = process.env.TEST262_CHUNK_TOTAL ?? "";

if (rawIndex === "" && rawTotal === "") {
  // No shard-matrix context — inert skip (see the file header). Registering a
  // skipped placeholder keeps vitest's exit code 0 (a file with zero
  // executed tests and no failures passes) so the #3008 gate stays green.
  describe.skip("test262 dynamic chunk (no TEST262_CHUNK_INDEX/TOTAL — shard-matrix only)", () => {
    it("only runs under the #3431 merge_group consolidated shard matrix", () => {});
  });
} else {
  const idx = Number.parseInt(rawIndex, 10);
  const total = Number.parseInt(rawTotal, 10);

  if (!Number.isInteger(idx) || !Number.isInteger(total) || total <= 0 || idx < 0 || idx >= total) {
    throw new Error(
      `test262-chunk-dynamic.test.ts requires valid TEST262_CHUNK_INDEX/TEST262_CHUNK_TOTAL env vars ` +
        `(got TEST262_CHUNK_INDEX=${JSON.stringify(rawIndex)}, TEST262_CHUNK_TOTAL=${JSON.stringify(rawTotal)}).`,
    );
  }

  runTest262Chunk(idx, total);
}
