// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runTest262File } from "./test262-runner.js";

describe("ES5 standalone accessor capture carriers", () => {
  it("preserves a Date assigned through an inherited setter", async () => {
    const file = resolve("test262/test/built-ins/Object/defineProperty/15.2.3.6-4-589.js");
    const result = await runTest262File(file, "es5-date-accessor-carrier", 30_000, "standalone");
    expect(result.status, result.error).toBe("pass");
  }, 60_000);
});
