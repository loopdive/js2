// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const ROOT = resolve("test262/test");
const ROWS = ["built-ins/Function/S15.3.2.1_A1_T13.js", "built-ins/Function/prototype/S15.3.5.2_A1_T1.js"] as const;

describe.skipIf(!existsSync(ROOT))("ES5 Function constructor residuals", () => {
  for (const row of ROWS) {
    it(
      row,
      async () => {
        const result = await runTest262File(resolve(ROOT, row), "built-ins/Function", 120_000, "standalone");
        expect(result.status, result.error).toBe("pass");
      },
      130_000,
    );
  }
});
