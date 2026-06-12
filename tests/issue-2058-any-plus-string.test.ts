// #2058 — `+` / `+=` with a runtime string in an `any`/externref position must
// CONCATENATE (§13.15.3 ApplyStringOrNumericBinaryOperator), not coerce to f64.
// Before the fix `1 + (s: any = "2")` produced `3` instead of `"12"` because the
// numeric paths unconditionally unboxed the externref operand to f64.
//
// JS-host mode delegates `+` to `__host_add` (JS `+`), which gives ToPrimitive,
// the string-if-either-is-string rule, and object valueOf/toString ordering for
// free. Standalone/WASI builds the operation in-module from the union-native
// typeof/unbox probes + native string concat (no JS host import leak).
import { describe, expect, it } from "vitest";
import { assertEquivalent } from "./equivalence/helpers.js";
import { compile } from "../src/index.js";

describe("#2058 any + runtime string concatenation (JS-host / default mode)", () => {
  it("1 + (any string) concatenates", async () => {
    await assertEquivalent(`export function plus(s: any): any { return 1 + s; }`, [{ fn: "plus", args: ["2"] }]);
  });

  it("(any) + (any), both strings, concatenates", async () => {
    await assertEquivalent(`export function plusBoth(a: any, b: any): any { return a + b; }`, [
      { fn: "plusBoth", args: ["1", "2"] },
    ]);
  });

  it("(any) + (any), both numbers, stays numeric", async () => {
    await assertEquivalent(`export function plusBoth(a: any, b: any): any { return a + b; }`, [
      { fn: "plusBoth", args: [40, 2] },
    ]);
  });

  it("string + (any number) concatenates (ToString the number)", async () => {
    await assertEquivalent(`export function f(s: string, n: any): any { return s + n; }`, [
      { fn: "f", args: ["v", 2] },
    ]);
  });

  it("(any) + literal string concatenates", async () => {
    await assertEquivalent(`export function f(a: any): any { return "x" + a; }`, [{ fn: "f", args: [5] }]);
  });

  it("null + 1 → 1 (ToNumber null is 0)", async () => {
    await assertEquivalent(`export function f(a: any): any { return a + 1; }`, [{ fn: "f", args: [null] }]);
  });

  it("undefined + 1 → NaN", async () => {
    await assertEquivalent(`export function f(a: any): any { return a + 1; }`, [{ fn: "f", args: [undefined] }]);
  });

  it('"x" + null → "xnull"', async () => {
    await assertEquivalent(`export function f(a: any, b: any): any { return a + b; }`, [
      { fn: "f", args: ["x", null] },
    ]);
  });

  it("compound x += (any string) concatenates", async () => {
    await assertEquivalent(`export function compound(s: any): any { let x: any = 1; x += s; return x; }`, [
      { fn: "compound", args: ["2"] },
    ]);
  });

  it("compound x += (any number) stays numeric", async () => {
    await assertEquivalent(`export function compound(s: any): any { let x: any = 40; x += s; return x; }`, [
      { fn: "compound", args: [2] },
    ]);
  });

  it("regression: provably-numeric number + number unchanged", async () => {
    await assertEquivalent(`export function f(a: number, b: number): number { return a + b; }`, [
      { fn: "f", args: [3, 4] },
    ]);
  });

  it("regression: provably-string string + string unchanged", async () => {
    await assertEquivalent(`export function f(a: string, b: string): string { return a + b; }`, [
      { fn: "f", args: ["ab", "cd"] },
    ]);
  });
});

// Standalone (pure-WasmGC) mode: the per-site add must build in-module with no
// JS host and no unsatisfiable `env::__host_add` import. Numeric results are
// JS-comparable; the concat arm is asserted only for validity (its native-string
// result is not directly JS-comparable across the boundary).
describe("#2058 any + runtime string concatenation (standalone / pure WasmGC)", () => {
  async function compileStandalone(src: string) {
    const result = await compile(src, { target: "standalone" });
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);
    return result;
  }

  it("any + any numeric: validates and computes the sum", async () => {
    const result = await compileStandalone(
      `export function f(): number { const a: any = 40; const b: any = 2; const r: any = a + b; return r; }`,
    );
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.f as () => number)()).toBe(42);
  });

  it("any + runtime string: compiles + validates with no host import leak", async () => {
    await compileStandalone(`export function f(s: any): any { return 1 + s; }`);
  });

  it("compound += any numeric: validates and runs", async () => {
    const result = await compileStandalone(
      `export function f(): number { let x: any = 1; const s: any = 2; x += s; return x; }`,
    );
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    expect((instance.exports.f as () => number)()).toBe(3);
  });
});
