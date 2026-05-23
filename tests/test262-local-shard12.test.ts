/** Test262 LOCAL shard 12/16 — round-robin distribution. Used by
 *  scripts/run-test262-vitest.sh for fast local runs. CI uses the
 *  50-chunk test262-chunkN.test.ts set instead.
 */
import { runTest262Chunk } from "./test262-shared.js";
runTest262Chunk(11, 16);
