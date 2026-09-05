// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4783 covers the direct-call Number formatter ToNumber(Symbol) boundary.
// Keep the exact failing rows and nearby positive formatter controls in the
// authoritative assembled-harness path for both the JS-host and standalone
// targets.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TEST262 = join(__dirname, "..", "test262");
const HAVE_TEST262 = existsSync(join(TEST262, "harness", "assert.js"));
const abs = (relative: string) => join(TEST262, "test", relative);

const PINS = [
  "built-ins/Number/prototype/toExponential/return-abrupt-tointeger-fractiondigits-symbol.js",
  "built-ins/Number/prototype/toFixed/toFixed-tonumber-throws-typeerror-symbol.js",
  "built-ins/Number/prototype/toPrecision/return-abrupt-tointeger-precision-symbol.js",
  "built-ins/Number/prototype/toExponential/nan.js",
  "built-ins/Number/prototype/toFixed/return-type.js",
  "built-ins/Number/prototype/toPrecision/nan.js",
] as const;

const SYMBOL_CALLS = [
  "export function test(): string { return NaN.toExponential(Symbol('x')); }",
  "export function test(): string { return (0).toFixed(Symbol('x')); }",
  "export function test(): string { return Number.prototype.toPrecision(Symbol('x')); }",
] as const;

describe("#4783 Number formatter Symbol arguments", () => {
  it("uses the standalone native TypeError path without env imports", async () => {
    for (const source of SYMBOL_CALLS) {
      const result = await compile(source, { target: "standalone", skipSemanticDiagnostics: true });
      expect(result.success).toBe(true);
      expect(result.imports.filter((entry) => entry.module === "env")).toEqual([]);
    }
  });

  for (const relative of PINS) {
    it.skipIf(!HAVE_TEST262)(`host: ${relative}`, { timeout: 180_000 }, async () => {
      const result = await runTest262File(abs(relative), "issue-4783", 120_000);
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });

    it.skipIf(!HAVE_TEST262)(`standalone: ${relative}`, { timeout: 180_000 }, async () => {
      const result = await runTest262File(abs(relative), "issue-4783", 120_000, "standalone");
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }
});
