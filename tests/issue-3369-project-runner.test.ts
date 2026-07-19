// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { restoreHostBuiltins } from "./test262-restore-builtins.js";
import { runTest262File } from "./test262-runner.js";

const SAMPLE_COMPILE_TIMEOUT_MS = 30_000;

function sortedArraySample(): string[] {
  const root = resolve("test262/test/language/expressions/array");
  return readdirSync(root, { recursive: true })
    .filter((path): path is string => typeof path === "string" && path.endsWith(".js") && !path.includes("_FIXTURE"))
    .map((path) => join("language/expressions/array", path))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 50);
}

describe("#3369 project-runner array parity", () => {
  it("passes 50/50 on the same sorted sample as the original harness", async () => {
    const samplePaths = sortedArraySample();
    expect(samplePaths).toHaveLength(50);

    const failures = [];
    for (const path of samplePaths) {
      const result = await runTest262File(resolve("test262/test", path), "language", SAMPLE_COMPILE_TIMEOUT_MS);
      restoreHostBuiltins();
      if (result.status !== "pass") {
        failures.push({ path, status: result.status, error: result.error, reason: result.reason });
      }
    }
    expect(failures).toEqual([]);
  }, 600_000);
});
