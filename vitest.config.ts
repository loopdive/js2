import { defineConfig } from "vitest/config";

const forkMaxOldSpaceSize = process.env.VITEST_FORK_MAX_OLD_SPACE_SIZE || "512";

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
        // reclaims all memory (same strategy as the test262 chunk runner).
        // maxForks=1 ensures only one fork at a time (no parallel OOM).
        singleFork: false,
        maxForks: 1,
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
