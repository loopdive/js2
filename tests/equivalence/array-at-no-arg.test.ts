import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// §23.1.3.1 takes `index` as an ordinary parameter, so `at()` with no argument
// is `at(0)` — ToIntegerOrInfinity(undefined) is +0. The native WasmGC vec
// lowering used to reject the zero-argument form outright ("at() requires 1
// argument"), and the caller swallowed that diagnostic into a degraded
// fallback: `[10,20,30].at()` evaluated to the relative INDEX `0` rather than
// the element `10`. Same defect shape as the `includes()` zero-argument gap
// fixed in #2872 (see array-includes-no-arg.test.ts) — the sibling file this
// one is modelled on.
//
// Deliberately NOT covered here: `at()` on an EMPTY array. Index 0 is out of
// bounds, and the native vec renders an out-of-bounds read of a number vec as
// NaN rather than `undefined` — a pre-existing, general residual (`[10].at(5)`
// does the same), unrelated to the argument count. Pinning it as an equivalence
// row would fail for a reason this issue does not own; it is pinned instead as
// an equality against `at(0)` in tests/issue-5095-array-at-no-argument.test.ts.
describe("Array.prototype.at with no argument (ES2022)", () => {
  it("returns the first element of a numeric array", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [10, 20, 30];
        return arr.at() as number;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  // TypeScript types `at` as requiring its argument, so the zero-argument form
  // is only writable where the harness tolerates the diagnostic — return
  // position. (test262 is plain JS and has no such constraint.)
  it("agrees with the at(0) spelling", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [10, 20, 30];
        return ((arr.at() as number) === (arr.at(0) as number) ? 10 : 0) + (arr.at() as number);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("returns the first element of a string array", async () => {
    await assertEquivalent(
      `export function test(): string {
        var arr: string[] = ["a", "b", "c"];
        return arr.at() as string;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("returns element 0 of a TypedArray, which shares the lowering", async () => {
    await assertEquivalent(
      `export function test(): number {
        var t: Int32Array = new Int32Array(3);
        t[0] = 7;
        t[1] = 8;
        return t.at() as number;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("leaves the explicit-index forms unchanged", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [10, 20, 30];
        var last: number = arr.at(-1) as number;
        var mid: number = arr.at(1) as number;
        return last * 100 + mid;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
