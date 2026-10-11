// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6656 — the `String(x)` CALL with a statically bigint-typed argument must
 * produce a real string under `--target standalone`.
 *
 * `String(x)` had no i64 arm: the builtin returned the raw i64 as though it
 * were already a string. Every consumer that re-stringifies the result
 * (`"" + String(x)`, which is how issue-6656-bigint-tostring-exact.test.ts
 * reads its rows) hid the defect, but any consumer that treats the result AS a
 * string did not. Measured on main `95b9eee151` (`.tmp/s74c/str.mts`):
 * `String(123n) === "123"` answered false and `String(123n).length` produced a
 * module that failed validation.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SOURCE = `
const big = 9223372036854775807n;
export function eqSmall() { return String(123n) === "123" ? 1 : 0; }
export function eqLocal() { const x = 123n; return String(x) === "123" ? 1 : 0; }
export function eqMax() { return String(big) === "9223372036854775807" ? 1 : 0; }
export function eqNeg() { return String(-9007199254740993n) === "-9007199254740993" ? 1 : 0; }
export function lenSmall() { return String(123n).length; }
export function lenMax() { return String(big).length; }
export function ctrlNumber() { return String(123) === "123" ? 1 : 0; }
`;

describe("#6656 — String(bigint) returns a string (standalone)", () => {
  it("compares and measures String(bigint) as a string", { timeout: 120_000 }, async () => {
    const result = (await compile(SOURCE, {
      target: "standalone",
      hostBridge: "off",
      allowJs: true,
      skipSemanticDiagnostics: true,
    } as never)) as unknown as { success: boolean; errors: { message: string }[]; binary: Uint8Array };
    expect(result.success, (result.errors ?? []).map((e) => e.message).join("\n")).toBe(true);

    const module = new WebAssembly.Module(result.binary);
    const imports: Record<string, Record<string, () => null>> = {};
    for (const imported of WebAssembly.Module.imports(module)) {
      (imports[imported.module] ??= {})[imported.name] = () => null;
    }
    const exports = (await WebAssembly.instantiate(module, imports)).exports as Record<string, () => number>;
    const answers: Record<string, number> = {};
    for (const name of ["eqSmall", "eqLocal", "eqMax", "eqNeg", "lenSmall", "lenMax", "ctrlNumber"]) {
      answers[name] = exports[name]!();
    }
    expect(answers).toEqual({ eqSmall: 1, eqLocal: 1, eqMax: 1, eqNeg: 1, lenSmall: 3, lenMax: 19, ctrlNumber: 1 });
  });
});
