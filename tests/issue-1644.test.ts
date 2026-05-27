import { describe, it, expect } from "vitest";
import { compileToWasm } from "./equivalence/helpers.js";

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
