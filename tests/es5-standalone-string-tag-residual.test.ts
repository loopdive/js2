// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runTest262File } from "./test262-runner.js";

describe("ES5 standalone string-tag residuals", () => {
  it("passes the authoritative Arguments trim row", async () => {
    const file = resolve("test262/test/built-ins/String/prototype/trim/15.5.4.20-2-51.js");
    const result = await runTest262File(file, "es5-string-tag-residual", 30_000, "standalone");
    expect(result.status, result.error).toBe("pass");
  });

  it("preserves Math's @@toStringTag through a borrowed String.prototype.split", async () => {
    const file = resolve("test262/test/built-ins/String/prototype/split/instance-is-math.js");
    const result = await runTest262File(file, "es5-string-tag-residual", 30_000, "standalone");
    expect(result.status, result.error).toBe("pass");
  });
});
