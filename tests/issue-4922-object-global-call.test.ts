// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4922 — a callable assigned to the test262 realm global must be unwrapped
// for calls originating in its owning module, while a standalone child module
// must retain the callable facade when it reads the parent realm's binding.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join(__dirname, "..", "test262");
const HAVE_TEST262 = existsSync(join(TEST262, "harness", "assert.js"));

const ROWS = [
  "language/types/object/S8.6.2_A5_T1.js",
  "language/types/object/S8.6.2_A5_T2.js",
  "language/types/object/S8.6.2_A5_T3.js",
  "language/types/object/S8.6.2_A5_T4.js",
] as const;

describe.skipIf(!HAVE_TEST262)("#4922 realm-global callable normalization", () => {
  it.each(ROWS)("host preserves %s", async (file) => {
    const result = await runTest262File(join(TEST262, "test", file), "issue-4922", 30_000);
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it.each(ROWS)("standalone preserves %s", async (file) => {
    const result = await runTest262File(join(TEST262, "test", file), "issue-4922", 30_000, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });
});
