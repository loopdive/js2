import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// §23.1.3.13 `Array.prototype.indexOf` (and §23.1.3.20 `lastIndexOf`) take
// `searchElement` as an ordinary parameter, so the zero-argument form is legal
// and searches for `undefined` with STRICT equality. The native WasmGC vec
// lowering used to reject it outright ("indexOf requires 1 argument"), and the
// caller swallowed that diagnostic into a degraded fallback: `[10,20,30].indexOf()`
// evaluated to `0` rather than `-1`.
//
// Same defect shape, one method over, as the `includes()` gap fixed in #2872
// (array-includes-no-arg.test.ts) and the `at()` gap fixed in #5095
// (array-at-no-arg.test.ts) — the two sibling files this one is modelled on.
// The difference is what the default IS: `at()` defaults an INDEX to 0, while
// these two default a search VALUE to `undefined` and compare it with `===`.
//
// TypeScript types both methods as requiring their argument, so the
// zero-argument form is only writable where the harness tolerates the
// diagnostic — return position. (test262 is plain JS and has no such
// constraint.)
//
// Deliberately NOT covered here: an f64 (number) array whose elements really
// include `undefined`, e.g. `[10, undefined, 30].indexOf()`. Spec says `1`; the
// compiler answers `-1` because a hole and an `undefined` both read as NaN in an
// f64 vec and `===` makes NaN match nothing. That is a value-representation
// limit (issue #5121 "S2"), not an argument-count one — it is equally wrong for
// the explicit `indexOf(undefined)` spelling, so it is pinned as an equality
// between the two spellings in tests/issue-5121-array-indexof-no-argument.test.ts
// rather than blessed as a fixture here.
describe("Array.prototype.indexOf / lastIndexOf with no argument (§23.1.3.13, §23.1.3.20)", () => {
  it("answers -1 on a numeric array that holds no undefined", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [10, 20, 30];
        return arr.indexOf() as number;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("answers -1 for lastIndexOf on the same array", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [10, 20, 30];
        return arr.lastIndexOf() as number;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("agrees with the indexOf(undefined) spelling", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [10, 20, 30];
        return ((arr.indexOf() as number) === arr.indexOf(undefined) ? 100 : 0) + (arr.indexOf() as number);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  // The row that proves the absent argument is a SEARCH VALUE (`undefined`) and
  // not just a hard-wired -1: this array really contains one, so the answer is
  // its index.
  it("finds an element that IS undefined", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: (string | undefined)[] = ["x", undefined, "z"];
        return arr.indexOf() as number;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("finds the LAST element that is undefined", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: (string | undefined)[] = ["x", undefined, "z", undefined];
        return arr.lastIndexOf() as number;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("answers -1 on a string array with no undefined element", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: (string | undefined)[] = ["x", "y"];
        return arr.indexOf() as number;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("answers -1 on an empty array", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [];
        return (arr.indexOf() as number) * 10 + (arr.lastIndexOf() as number);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  // A boolean array lowers to an i32 vec, where no element can BE `undefined`.
  // Before the fix this answered 0 — the fallback's index, which also happens to
  // be where `false` sits, so the wrong answer looked plausible.
  it("answers -1 on a boolean array", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: boolean[] = [false, true];
        return arr.indexOf() as number;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("answers -1 on a TypedArray receiver, which shares the lowering", async () => {
    await assertEquivalent(
      `export function test(): number {
        var t: Int32Array = new Int32Array(3);
        t[0] = 7;
        return (t.indexOf() as number) * 10 + (t.lastIndexOf() as number);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("leaves the explicit-argument forms unchanged", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [10, 20, 30, 20];
        var first: number = arr.indexOf(20);
        var last: number = arr.lastIndexOf(20);
        var from: number = arr.indexOf(20, 2);
        return first * 100 + last * 10 + from;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
