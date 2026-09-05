// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const HARNESS = join(__dirname, "..", "test262", "harness", "assert.js");
const TEST262 = existsSync(HARNESS);

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

function pinRow(rel: string): void {
  it(rel, { timeout: 60_000 }, async () => {
    const abs = join(__dirname, "..", "test262", "test", rel);
    const result = await runTest262File(abs, "issue-4679", 30_000, "standalone");
    expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
  });
}

describe.skipIf(!TEST262)("#4679 ES5 Array.prototype.concat callable values", () => {
  pinRow("built-ins/Array/prototype/concat/S15.4.4.4_A2_T1.js");
  pinRow("built-ins/Array/prototype/concat/S15.4.4.4_A2_T2.js");
  pinRow("built-ins/Array/prototype/concat/S15.4.4.4_A1_T2.js");
});
