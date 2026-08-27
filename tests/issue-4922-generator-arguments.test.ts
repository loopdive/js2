import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

// #4922 — object-literal generator methods with an implicit `arguments`
// object must keep their argument-vector globals valid when the body adds
// late string imports. The sync and async-generator variants share the eager
// legacy-buffer path whenever the method reads `arguments`.
const GENERATOR_ARGUMENT_ROWS = [
  "language/arguments-object/gen-meth-args-trailing-comma-multiple.js",
  "language/arguments-object/gen-meth-args-trailing-comma-null.js",
  "language/arguments-object/gen-meth-args-trailing-comma-single-args.js",
  "language/arguments-object/gen-meth-args-trailing-comma-spread-operator.js",
  "language/arguments-object/gen-meth-args-trailing-comma-undefined.js",
  "language/arguments-object/async-gen-meth-args-trailing-comma-multiple.js",
  "language/arguments-object/async-gen-meth-args-trailing-comma-null.js",
  "language/arguments-object/async-gen-meth-args-trailing-comma-single-args.js",
  "language/arguments-object/async-gen-meth-args-trailing-comma-undefined.js",
] as const;

const TEST262_ROOT = join("test262", "test");
const CORPUS_AVAILABLE = existsSync(join(TEST262_ROOT, GENERATOR_ARGUMENT_ROWS[0]));

describe.skipIf(!CORPUS_AVAILABLE)("#4922 generator method arguments global indices", () => {
  it.each(GENERATOR_ARGUMENT_ROWS)(
    "passes the exact Test262 row %s",
    async (relativePath) => {
      const result = await runTest262File(join(TEST262_ROOT, relativePath), "issue-4922", 120_000);
      expect(result.status, `${relativePath}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
    },
    180_000,
  );
});
