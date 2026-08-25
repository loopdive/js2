// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4701 — an inferred numeric formal must retain a string written through its
// own mapped arguments object. The three numeric rows are controls for the
// existing f64 reverse-sync path; descriptor-sidecar rows remain #4699-owned.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262 = resolve(process.cwd(), "test262");
const ROOT = join(TEST262, "test", "language", "arguments-object", "mapped");
const cases = [
  "writable-enumerable-configurable-descriptor.js",
  "mapped-arguments-nonconfigurable-1.js",
  "mapped-arguments-nonconfigurable-2.js",
  "mapped-arguments-nonconfigurable-4.js",
];

const maybe = existsSync(TEST262) ? describe : describe.skip;

maybe("#4701 mapped-arguments formal carrier", () => {
  for (const name of cases) {
    it(name, async () => {
      const result = await runTest262File(join(ROOT, name), "language/arguments-object/mapped", 30_000, "standalone");
      expect(result.status, result.error ?? result.reason ?? "").toBe("pass");
    });
  }
});
