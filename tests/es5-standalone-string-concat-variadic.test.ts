// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runTest262File } from "./test262-runner.js";

describe("ES5 standalone variadic String.prototype.concat", () => {
  it("preserves all 128 arguments for a borrowed concat", async () => {
    const file = resolve("test262/test/built-ins/String/prototype/concat/S15.5.4.6_A2.js");
    const result = await runTest262File(file, "es5-string-concat-variadic", 30_000, "standalone");
    expect(result.status, result.error).toBe("pass");
  });
});
