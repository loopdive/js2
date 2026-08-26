// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4738 — standalone String.prototype.repeat must throw a RangeError object
// for invalid counts, matching the host lane and the ES2015 test262 contract.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const INVALID_COUNT_FILES = [
  "built-ins/String/prototype/repeat/count-less-than-zero-throws.js",
  "built-ins/String/prototype/repeat/count-is-infinity-throws.js",
] as const;

const CONTROL_FILES = [
  "built-ins/String/prototype/repeat/count-coerced-to-zero-returns-empty-string.js",
  "built-ins/String/prototype/repeat/count-is-zero-returns-empty-string.js",
  "built-ins/String/prototype/repeat/repeat-string-n-times.js",
  "built-ins/String/prototype/repeat/return-abrupt-from-count-as-symbol.js",
] as const;

async function expectPass(file: string, target: "host" | "standalone"): Promise<void> {
  const result = await runTest262File(
    join("test262/test", file),
    "built-ins/String/prototype/repeat",
    120_000,
    target === "standalone" ? target : undefined,
  );
  expect(result.status, `${target} ${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
}

describe("#4738 — standalone String.prototype.repeat RangeError identity", () => {
  it.each(INVALID_COUNT_FILES)("passes the exact invalid-count row in both lanes: %s", async (file) => {
    await expectPass(file, "host");
    await expectPass(file, "standalone");
  });

  it.each(CONTROL_FILES)("keeps the repeat control passing in both lanes: %s", async (file) => {
    await expectPass(file, "host");
    await expectPass(file, "standalone");
  });
});
