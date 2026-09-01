// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// These rows exercise descriptor fidelity across standalone vector and
// function-object paths. Preserve non-default vector expando attributes and
// the mandatory writable prototype property on ordinary function objects.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join(process.cwd(), "test262");
const TEST262_READY = existsSync(join(TEST262, "harness", "assert.js"));
const ROWS = [
  "built-ins/Object/defineProperty/15.2.3.6-4-280.js",
  "built-ins/Object/defineProperties/15.2.3.7-6-a-269.js",
  "language/statements/function/13.2-18-1.js",
] as const;

describe.skipIf(!TEST262_READY)("ES5 standalone descriptor residuals", () => {
  it.each(ROWS)("passes %s", async (row) => {
    const result = await runTest262File(join(TEST262, "test", row), "es5-descriptor-residuals", 120_000, "standalone");
    expect(`${result.status}: ${result.error ?? ""}`, result.error ?? result.reason ?? "").toBe("pass: ");
  });
});
