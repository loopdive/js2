/**
 * #3078 — Number.prototype.toExponential(undefined) / toPrecision(undefined)
 * must be spec-equivalent to the NO-ARGUMENT call, NOT to
 * ToIntegerOrInfinity(undefined) = 0.
 *
 * ECMA-262:
 *   §21.1.3.3 Number.prototype.toExponential(fractionDigits) — an explicit
 *     `undefined` yields the variable-precision exponential (as many digits as
 *     needed), identical to `toExponential()`. NOT 0 fixed digits.
 *   §21.1.3.5 Number.prototype.toPrecision(precision) step 2 — "If precision is
 *     undefined, return ! ToString(x)." NOT ToInteger(undefined)=0 (which would
 *     trip the [1,100] RangeError gate).
 *
 * Pre-fix bug: codegen gated only on `arguments.length > 0`, so an explicit
 * `undefined` argument compiled through the ToNumber funnel → f64 NaN →
 * normaliseNaN→0. `toExponential(undefined)` therefore returned "1e+2" (0
 * digits) and `toPrecision(undefined)` THREW RangeError (0 ∉ [1,100]).
 *
 * `undefined` and `NaN` both compile to f64 NaN and are indistinguishable at
 * the value site, so the fix detects the STATIC `undefined` literal at the AST
 * level (`isStaticUndefinedArg`) and routes it to the no-argument branch (the
 * NaN "no-arg" sentinel / ToString path). An EXPLICIT NaN argument still maps
 * to 0 (regression-guarded here + in tests/issue-1735.test.ts).
 *
 * Test262 fixed:
 *   - built-ins/Number/prototype/toExponential/undefined-fractiondigits.js
 *   - built-ins/Number/prototype/toPrecision/undefined-precision-arg.js
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

describe("#3078 — Number.prototype.toExponential/toPrecision(undefined) ≡ no-arg", () => {
  it("(123.456).toExponential(undefined) → '1.23456e+2' (variable digits, like no-arg)", async () => {
    const src = `export function r(): string { return (123.456).toExponential(undefined); }`;
    expect(await runFn(src, "r")).toBe("1.23456e+2");
  });

  it("(123.456).toPrecision(undefined) → '123.456' (ToString, like no-arg)", async () => {
    const src = `export function r(): string { return (123.456).toPrecision(undefined); }`;
    expect(await runFn(src, "r")).toBe("123.456");
  });

  it("(39).toPrecision(undefined) → '39'", async () => {
    const src = `export function r(): string { return (39).toPrecision(undefined); }`;
    expect(await runFn(src, "r")).toBe("39");
  });

  it("computed member — (123.456)['toExponential'](undefined) → '1.23456e+2'", async () => {
    const src = `export function r(): string { return (123.456)["toExponential"](undefined); }`;
    expect(await runFn(src, "r")).toBe("1.23456e+2");
  });

  it("computed member — (123.456)['toPrecision'](undefined) → '123.456'", async () => {
    const src = `export function r(): string { return (123.456)["toPrecision"](undefined); }`;
    expect(await runFn(src, "r")).toBe("123.456");
  });

  // Regression guards: an EXPLICIT NaN is NOT undefined — it maps to 0
  // (ToIntegerOrInfinity), NOT the no-arg sentinel. `isStaticUndefinedArg`
  // matches only the literal `undefined` / `void 0`, so these are untouched.
  it("(123.456).toExponential(NaN) → '1e+2' (NaN→0, still distinct from undefined)", async () => {
    const src = `export function r(): string { return (123.456).toExponential(Number.NaN); }`;
    expect(await runFn(src, "r")).toBe("1e+2");
  });

  it("(1.5).toPrecision(NaN) STILL throws RangeError (NaN→0, 0 ∉ [1,100])", async () => {
    const src = `export function r(): string { return (1.5).toPrecision(Number.NaN); }`;
    await expect(runFn(src, "r")).rejects.toThrow();
  });

  // The genuine no-arg call is unchanged.
  it("(123.456).toExponential() (no arg) → '1.23456e+2' (unchanged)", async () => {
    const src = `export function r(): string { return (123.456).toExponential(); }`;
    expect(await runFn(src, "r")).toBe("1.23456e+2");
  });
});
