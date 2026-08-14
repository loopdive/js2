import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

const forkMaxOldSpaceSize = process.env.VITEST_FORK_MAX_OLD_SPACE_SIZE || "512";

/**
 * (#4413) How many test files may run at once.
 *
 * This was hard-wired to 1, described as "the same strategy as the test262
 * chunk runner". It is not: test262's throughput comes from
 * `describe.concurrent` plus a CompilerPool of worker processes running
 * INSIDE one fork. The unit suite inherited the one-fork restriction without
 * that compensating mechanism — and **0 of its 2,928 files use
 * `describe.concurrent`**, so `maxConcurrency: 32` below does nothing for
 * them. The result was a strictly serial suite: one file at a time, one test
 * at a time, ~25% utilisation of a 4-core box.
 *
 * Measured on 24 representative files (4 cores / 16 GB), identical results
 * (155 passed / 9 failed) at every setting:
 *
 *   maxForks=1   229 s   1.00x
 *   maxForks=4   110 s   2.08x
 *   maxForks=8   116 s   1.97x   peak 5.7 GB of 16 GB
 *
 * So the OOM worry does not hold at these fork counts, and past 4 there is
 * nothing left to win on 4 cores. Default to `parallelism - 1`, leaving a
 * core for the editor/agent; `VITEST_MAX_FORKS` overrides.
 *
 * **test262 runs stay at 1**, and that part of the original reasoning IS
 * load-bearing: `run-test262-vitest.sh` hands vitest 16 shard files, each of
 * which spins up its own CompilerPool. Letting three of those run at once
 * would put ~9 compiler workers on 4 cores — oversubscribed, and the memory
 * profile the single-fork rule was actually protecting.
 */
const isTest262Run = Boolean(process.env.TEST262_TARGET || process.env.TEST262_RESULT_PREFIX);
const maxForks = isTest262Run ? 1 : Math.max(1, Number(process.env.VITEST_MAX_FORKS) || availableParallelism() - 1);

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // The dogfood upstream suites extract a real npm/git checkout under
    // `tests/dogfood/.<name>-upstream-suite/` (#3958 React, #3977 lit). Those
    // trees contain hundreds of the upstream project's OWN `*.test.ts` files,
    // which `tests/**/*.test.ts` happily collects — vitest then tries to run
    // them directly, against a browser harness they need and we do not provide,
    // and 44 files fail for reasons that have nothing to do with the compiler.
    // The suites are driven by their own `*-upstream-suite.test.ts` entry point;
    // the extracted tree is INPUT DATA, never a test target. Only visible once a
    // suite has run at least once in a given workspace, which is why it survived
    // a clean CI run.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "tests/dogfood/.*-upstream-suite/**",
      "tests/dogfood/.*-implementation/**",
      "tests/dogfood/.*-upstream-suite-impl/**",
    ],
    pool: "forks",
    poolOptions: {
      forks: {
        // Each test file gets its own fork process — when it finishes, the OS
        // reclaims all memory. See the `maxForks` derivation above for why
        // this is no longer pinned to 1 outside test262 runs.
        singleFork: false,
        maxForks,
        minForks: 0,
        execArgv: [`--max-old-space-size=${forkMaxOldSpaceSize}`, "--expose-gc"],
      },
    },
    // Lets describe.concurrent tests run up to 32 at once — CompilerPool limits
    // actual concurrent compilations to POOL_SIZE (availableParallelism - 1).
    // Without this, vitest runs it() blocks within a describe() sequentially,
    // leaving pool workers idle and stretching test262 runs to 150+ minutes.
    maxConcurrency: 32,
    // 35s — must sit above the compiler's internal 30s timeout so that
    // `compile_timeout` status can be recorded before vitest force-kills the
    // test. With describe.concurrent (see PR #14), a 10s ceiling flipped
    // tests from pass→compile_timeout under CPU contention (issue #1171).
    testTimeout: 35000,
  },
});
