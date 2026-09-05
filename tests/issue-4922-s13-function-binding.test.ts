// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = join(__dirname, "..", "test262");
const TEST262_AVAILABLE = existsSync(join(TEST262_ROOT, "harness", "assert.js"));
const ROWS = ["language/statements/function/S13_A19_T2.js", "language/statements/function/S13_A19_T1.js"] as const;

describe.skipIf(!TEST262_AVAILABLE)("#4922 same-name function bindings", () => {
  for (const row of ROWS) {
    it(row, { timeout: 60_000 }, async () => {
      const result = await runTest262File(join(TEST262_ROOT, "test", row), "issue-4922-s13", 120_000, "standalone");
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});
