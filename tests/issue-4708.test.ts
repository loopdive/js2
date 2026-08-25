// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4708 owns only the two standalone native Set mutation rows. The broader
// `set.js` and `set-contract-expand.js` failures belong to the excluded
// dynamic-any/mutable-binding lane recorded by #4704.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join(__dirname, "..", "test262");
const HAVE_TEST262 = existsSync(join(TEST262, "harness", "assert.js"));

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

const abs = (relative: string) => join(TEST262, "test", relative);

function pin(relative: string, target?: "standalone"): void {
  it(`${target ?? "host"}: ${relative}`, { timeout: 60_000 }, async () => {
    const result = await runTest262File(abs(relative), "issue-4708", 30_000, target);
    expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
  });
}

describe.skipIf(!HAVE_TEST262)("#4708 — standalone Set live iteration", () => {
  pin("language/statements/for-of/set-contract.js", "standalone");
  pin("language/statements/for-of/set-expand.js", "standalone");

  // Host is a no-change control; this slice must not alter the generic bridge.
  pin("language/statements/for-of/set-contract.js");
  pin("language/statements/for-of/set-expand.js");

  // Existing native array/string for-of controls remain outside the Set path.
  for (const relative of [
    "language/statements/for-of/array.js",
    "language/statements/for-of/array-contract.js",
    "language/statements/for-of/array-contract-expand.js",
    "language/statements/for-of/array-expand-contract.js",
    "language/statements/for-of/string-bmp.js",
    "language/statements/for-of/string-astral.js",
  ]) {
    pin(relative, "standalone");
  }
});
