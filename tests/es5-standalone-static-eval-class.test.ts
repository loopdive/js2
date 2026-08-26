// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runTest262File } from "./test262-runner.js";

const ROWS = [
  "language/statements/class/elements/static-field-init-with-this.js",
  "language/expressions/class/elements/static-field-init-with-this.js",
  "language/statements/class/elements/private-static-setter-visible-to-direct-eval.js",
] as const;

describe("ES5 standalone folded direct eval in static class code", () => {
  it.each(ROWS)("passes %s", async (file) => {
    const result = await runTest262File(join("test262/test", file), "es5-static-eval-class", 120_000, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});

describe("ES5 host folded direct eval in static class code", () => {
  it.each(ROWS)("passes %s", async (file) => {
    const result = await runTest262File(join("test262/test", file), "es5-static-eval-class-host", 120_000);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
