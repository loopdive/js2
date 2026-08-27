// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runTest262File } from "./test262-runner.js";

const ROWS = ["S15.10.2.8_A3_T15.js", "S15.10.2.8_A3_T16.js"] as const;

describe("ES5 standalone dynamic RegExp nested groups", () => {
  it.each(ROWS)("accepts %s without rejecting nested groups", async (file) => {
    const path = resolve("test262/test/built-ins/RegExp", file);
    const result = await runTest262File(path, "es5-regexp-nested-groups", 120_000, "standalone");
    expect(result.status, result.error).toBe("pass");
  });
});
