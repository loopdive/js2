import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

async function runWasiNumber(source: string): Promise<{ value: number; envImports: string[]; wat: string }> {
  const result = await compile(source, { fileName: "issue-1644.ts", target: "wasi" });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  const envImports = result.imports.filter((i) => i.module === "env").map((i) => i.name);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const test = instance.exports.test as () => number;
  return { value: test(), envImports, wat: result.wat };
}

// #1644 Slice A — bigint-branded i64 boxing.
//
// A bigint-branded i64 must box at the externref frontier as a JS *bigint*
// (via __box_bigint), not as a JS number. The two CI guards from the architect
// spec §7 are:
//   1. native `type i64 = number` arithmetic + boxing is byte-identical to
//      before (the brand defaults off, so this path is untouched).
//   2. a bigint literal round-trips as a JS bigint (`BigInt("10") === 10n`).
describe("#1644 Slice A — bigint i64 brand boxing", () => {
  it("bigint literal returned as any boxes to a JS bigint (not a number)", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        const x: bigint = 10n;
        return x;
      }
    `);
    const v = exports.test();
    expect(typeof v).toBe("bigint");
    expect(v).toBe(10n);
  });

  it("bigint arithmetic result boxes to a JS bigint", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        const a: bigint = 5n;
        const b: bigint = 3n;
        return a + b;
      }
    `);
    const v = exports.test();
    expect(typeof v).toBe("bigint");
    expect(v).toBe(8n);
  });

  it("BigInt(x) result boxes to a JS bigint", async () => {
    const exports = await compileToWasm(`
      export function test(): any {
        return BigInt(255);
      }
    `);
    const v = exports.test();
    expect(typeof v).toBe("bigint");
    expect(v).toBe(255n);
  });

  it("large bigint preserves full i64 precision through the boundary", async () => {
    // 9_007_199_254_740_993n is 2^53 + 1 — not representable as an f64, so the
    // legacy number-boxing path would have lost the low bit.
    const exports = await compileToWasm(`
      export function test(): any {
        const x: bigint = 9007199254740993n;
        return x;
      }
    `);
    const v = exports.test();
    expect(typeof v).toBe("bigint");
    expect(v).toBe(9007199254740993n);
  });

  // Guard 1: native `type i64 = number` must be completely unaffected — the
  // brand is optional and defaults off, so this still does plain i64 numeric
  // arithmetic and number boxing (returns a JS number, NOT a bigint).
  it("native `type i64 = number` arithmetic is unaffected (returns a number)", async () => {
    const exports = await compileToWasm(`
      type i64 = number;
      export function test(): i64 {
        const a: i64 = 5;
        const b: i64 = 3;
        return a + b;
      }
    `);
    const v = exports.test();
    expect(typeof v).toBe("number");
    expect(v).toBe(8);
  });
});

describe("#1644 Slice E1 — standalone bigint externref carrier", () => {
  it("WASI bigint boxes and unboxes through an any-returning function without BigInt host imports", async () => {
    // `asAny` must really return through the externref carrier. The original
    // `function asAny(x: bigint): any { return x; }` no longer does: return-type
    // inference narrows its result to i64 (it can only return a bigint) and the
    // call is inlined, so no box was emitted and the `$BigInt` pin went red
    // although nothing regressed. A second, non-bigint return arm keeps the
    // result genuinely `any`.
    const { value, envImports, wat } = await runWasiNumber(`
      function asAny(x: bigint, keep: boolean): any { return keep ? x : "not a bigint"; }
      export function test(): number {
        const round: bigint = asAny(10n, true);
        return round === 10n ? 1 : 0;
      }
    `);
    expect(value).toBe(1);
    expect(envImports).not.toContain("__box_bigint");
    expect(envImports).not.toContain("__to_bigint");
    expect(wat).toContain("$BigInt");
  });

  it('WASI dynamic typeof sees boxed bigint as "bigint", not "object"', async () => {
    const { value, envImports } = await runWasiNumber(`
      function asAny(x: bigint): any { return x; }
      export function test(): number {
        const x: any = asAny(5n);
        return typeof x === "bigint" ? 1 : 0;
      }
    `);
    expect(value).toBe(1);
    expect(envImports).not.toContain("__typeof_bigint");
  });

  it("WASI boxed 0n is falsy", async () => {
    const { value } = await runWasiNumber(`
      function asAny(x: bigint): any { return x; }
      export function test(): number {
        const x: any = asAny(0n);
        return x ? 1 : 0;
      }
    `);
    expect(value).toBe(0);
  });

  it("WASI boxed bigint strict equality compares the i64 payload", async () => {
    const { value } = await runWasiNumber(`
      function asAny(x: bigint): any { return x; }
      export function test(): number {
        const a: any = asAny(1n);
        const b: any = asAny(1n);
        return a === b ? 1 : 0;
      }
    `);
    expect(value).toBe(1);
  });

  it("WASI BigInt(string-literal) folds decimal and prefixed numeric strings", async () => {
    const { value, envImports } = await runWasiNumber(`
      export function test(): number {
        const a = BigInt("42");
        const b = BigInt("0xff");
        return a === 42n && b === 255n ? 1 : 0;
      }
    `);
    expect(value).toBe(1);
    expect(envImports).not.toContain("__bigint_ctor");
  });

  it("WASI BigInt(number) uses the native integer gate", async () => {
    const { value, envImports } = await runWasiNumber(`
      export function test(): number {
        try {
          BigInt(1.5);
          return 0;
        } catch {
          return 1;
        }
      }
    `);
    expect(value).toBe(1);
    expect(envImports).not.toContain("__bigint_ctor");
  });
});
