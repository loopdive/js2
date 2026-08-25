// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Focused standalone ES5 pins for the remaining Error/Date smalls. These rows
// run through the same original Test262 harness as the authoritative lane, so
// they preserve the module-init and builtin-carrier shape of the census.
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

function pinRow(relativePath: string, note: string): void {
  it(`${relativePath} — ${note}`, { timeout: 60_000 }, async () => {
    const filePath = join(__dirname, "..", "test262", "test", relativePath);
    const result = await runTest262File(filePath, "es5-error-date-residual", 30_000, "standalone");
    expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
  });
}

describe.skipIf(!TEST262)("ES5 standalone Error/Date residuals", () => {
  pinRow("built-ins/Error/length.js", "Error constructor length is one");
  pinRow("built-ins/Date/S15.9.2.1_A2.js", "Date() returns a parseable current-date string");
});
