/**
 * #1735 — Number.prototype.toExponential(NaN) must use ToIntegerOrInfinity,
 * which maps NaN → 0, NOT the codegen "no argument" sentinel.
 *
 * Per ECMA-262 §21.1.3.3 step 5, `f = ToIntegerOrInfinity(fractionDigits)`,
 * and ToIntegerOrInfinity(NaN) is +0 (§7.1.5). So `(123.456).toExponential(NaN)`
 * must format with 0 fraction digits → "1e+2", distinct from the genuine
 * no-argument call `(123.456).toExponential()` → "1.23456e+2" (variable digits).
 *
 * Pre-fix bug: codegen passes the f64 fractionDigits straight to the
 * `number_toExponential` runtime helper, which overloads NaN as its "no
 * argument supplied" sentinel (the no-arg codegen branch pushes `f64.const
 * NaN`). An *explicit* NaN argument therefore carried the same bits as the
 * sentinel and was wrongly treated as no-arg, returning variable digits.
 *
 * Fix: codegen normalises the digits/precision f64 local NaN → 0 (via a
 * self-compare `select`) before the range check + call, so the sentinel is
 * reserved strictly for the zero-argument case.
 *
 * Test262 affected:
 *   - built-ins/Number/prototype/toExponential/tointeger-fractiondigits.js
 *
 * Regression guard for the no-arg sentinel (#1321) and the non-finite-receiver
 * gate (#49) lives in tests/issue-49-number-format-nonfinite.test.ts —
 * `(1.5).toPrecision(NaN)` STILL throws RangeError (NaN→0, 0 ∉ [1,100]).
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runFn(source: string, exportName: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile failed: ${r.errors[0]?.message ?? "?"}`);
  const importResult = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, importResult as any);
  importResult.setExports?.(instance.exports as any);
  return (instance.exports as any)[exportName]();
}

describe("#1735 — toExponential(NaN) uses ToInteger(NaN)=0, not the no-arg sentinel", () => {
  it("(123.456).toExponential(NaN) → '1e+2' (0 fraction digits)", async () => {
    const src = `export function r(): string { return (123.456).toExponential(Number.NaN); }`;
    expect(await runFn(src, "r")).toBe("1e+2");
  });

  it("(123.456).toExponential(0/0) → '1e+2' (computed NaN coerces to 0)", async () => {
    const src = `export function r(): string { return (123.456).toExponential(0 / 0); }`;
    expect(await runFn(src, "r")).toBe("1e+2");
  });

  it("(0).toExponential(NaN) → '0e+0'", async () => {
    const src = `export function r(): string { return (0).toExponential(Number.NaN); }`;
    expect(await runFn(src, "r")).toBe("0e+0");
  });

  // The genuine no-argument call must STILL give variable digits — the
  // NaN→0 normalisation only runs in the arg-present branch, so the no-arg
  // sentinel (variable digits) is preserved.
  it("(123.456).toExponential() (no arg) → '1.23456e+2' (variable digits, unchanged)", async () => {
    const src = `export function r(): string { return (123.456).toExponential(); }`;
    expect(await runFn(src, "r")).toBe("1.23456e+2");
  });

  it("explicit integer arg unchanged: (123.456).toExponential(2) → '1.23e+2'", async () => {
    const src = `export function r(): string { return (123.456).toExponential(2); }`;
    expect(await runFn(src, "r")).toBe("1.23e+2");
  });

  it("explicit (123.456).toExponential(0) → '1e+2' (same as NaN→0)", async () => {
    const src = `export function r(): string { return (123.456).toExponential(0); }`;
    expect(await runFn(src, "r")).toBe("1e+2");
  });
});
