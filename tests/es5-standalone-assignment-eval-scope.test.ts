// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// ES5 standalone direct-eval assignment scope regressions. In both rows the
// left-hand Reference must be resolved before the RHS eval can declare a
// same-named var in the closure's direct-eval environment.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(TEST262_HARNESS);

// Keep the in-process runner responsive when both authoritative rows compile
// back-to-back in the same vitest worker.
afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

const ROWS = [
  "language/expressions/assignment/S11.13.1_A6_T1.js",
  "language/expressions/assignment/S11.13.1_A6_T2.js",
] as const;

describe.skipIf(!TEST262)("ES5 standalone assignment with direct-eval var scope", () => {
  for (const relativePath of ROWS) {
    it(relativePath, { timeout: 60_000 }, async () => {
      const filePath = join(__dirname, "..", "test262", "test", relativePath);
      const result = await runTest262File(filePath, "es5-assignment-eval-scope", 30_000, "standalone");
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});
