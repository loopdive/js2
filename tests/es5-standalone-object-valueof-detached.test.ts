// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runTest262File } from "./test262-runner.js";

const ROWS = [
  // Regression: the comma operator must preserve the absent receiver.
  "built-ins/Object/prototype/valueOf/S15.2.4.4_A14.js",
  // Neighbor controls: explicit null, detached identifier, and valid object
  // receivers must keep their existing semantics.
  "built-ins/Object/prototype/valueOf/S15.2.4.4_A13.js",
  "built-ins/Object/prototype/valueOf/S15.2.4.4_A15.js",
  "built-ins/Object/prototype/valueOf/S15.2.4.4_A1_T1.js",
] as const;

describe("ES5 standalone Object.prototype.valueOf receiver presence", () => {
  it.each(ROWS)(
    "passes %s",
    async (file) => {
      const result = await runTest262File(
        join("test262/test", file),
        "es5-object-valueof-detached",
        30_000,
        "standalone",
      );
      expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
    },
    60_000,
  );
});
