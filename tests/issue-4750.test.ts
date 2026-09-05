// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4750 pins §20.1.2.1 step 1 (ToObject(target)) in both compiler lanes. The
// nullish target rows are the regression; the object target and nullish-source
// rows protect the existing copy/ignore semantics from an over-broad guard.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join(__dirname, "..", "test262");
const HAVE_TEST262 = existsSync(join(TEST262, "harness", "assert.js"));
const abs = (relative: string) => join(TEST262, "test", relative);

const PINS = [
  "built-ins/Object/assign/Target-Null.js",
  "built-ins/Object/assign/Target-Undefined.js",
  "built-ins/Object/assign/Target-Object.js",
  "built-ins/Object/assign/Source-Null-Undefined.js",
] as const;

describe.skipIf(!HAVE_TEST262)("#4750 Object.assign target ToObject", () => {
  for (const relative of PINS) {
    it(`host: ${relative}`, { timeout: 180_000 }, async () => {
      const result = await runTest262File(abs(relative), "issue-4750", 120_000);
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });

    it(`standalone: ${relative}`, { timeout: 180_000 }, async () => {
      const result = await runTest262File(abs(relative), "issue-4750", 120_000, "standalone");
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});
