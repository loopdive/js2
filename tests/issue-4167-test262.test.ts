// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { runTest262File } from "./test262-runner.js";

const CASES = [
  "built-ins/Promise/all/invoke-resolve-error-reject.js",
  "built-ins/Promise/all/invoke-resolve-get-error.js",
  "built-ins/Promise/race/invoke-then-error-reject.js",
  "built-ins/Promise/resolve/arg-poisoned-then.js",
] as const;

describe("#4167 authentic Test262 Promise rejection cohort", () => {
  for (const file of CASES) {
    it(`${file} no longer reports an opaque WebAssembly.Exception`, async () => {
      const result = await runTest262File(resolve("test262/test", file), "built-ins/Promise", 60_000);
      expect(String(result.error ?? result.reason ?? "")).not.toContain("[object WebAssembly.Exception]");
    });
  }

  it("the poisoned-then identity control now passes", async () => {
    const result = await runTest262File(
      resolve("test262/test/built-ins/Promise/resolve/arg-poisoned-then.js"),
      "built-ins/Promise",
      60_000,
    );
    expect(result.status, result.error).toBe("pass");
  });
});
