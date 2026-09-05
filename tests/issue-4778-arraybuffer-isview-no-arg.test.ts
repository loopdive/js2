// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4778 pins the omitted-argument edge of §25.1.4.1. The existing argument-
// bearing standalone lowering is covered by #2594; this test keeps the new
// zero-argument arm narrow and proves that it does not emit a host import.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join(__dirname, "..", "test262");
const HAVE_TEST262 = existsSync(join(TEST262, "harness", "assert.js"));
const abs = (relative: string) => join(TEST262, "test", relative);

const PINS = [
  "built-ins/ArrayBuffer/isView/no-arg.js",
  "built-ins/ArrayBuffer/isView/arg-is-not-object.js",
  "built-ins/ArrayBuffer/isView/arg-is-arraybuffer.js",
  "built-ins/ArrayBuffer/isView/arg-has-no-viewedarraybuffer.js",
] as const;

describe("#4778 ArrayBuffer.isView omitted argument", () => {
  it("standalone lowering emits no host imports", async () => {
    const result = await compile("export function test(): boolean { return ArrayBuffer.isView(); }", {
      target: "standalone",
    });
    expect(result.success).toBe(true);
    expect(result.imports.map((entry) => `${entry.module}::${entry.name}`)).toEqual([]);
  });

  for (const relative of PINS) {
    it.skipIf(!HAVE_TEST262)(`host: ${relative}`, { timeout: 180_000 }, async () => {
      const result = await runTest262File(abs(relative), "issue-4778", 120_000);
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });

    it.skipIf(!HAVE_TEST262)(`standalone: ${relative}`, { timeout: 180_000 }, async () => {
      const result = await runTest262File(abs(relative), "issue-4778", 120_000, "standalone");
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});
