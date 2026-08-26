import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// §23.1.3.16 takes `searchElement` as an ordinary parameter, so `includes()`
// with no argument searches for `undefined`. The compiler used to reject the
// zero-argument form outright ("includes requires 1 argument"), which made the
// whole call evaluate as `undefined` — test262's
// built-ins/Array/prototype/includes/no-arg.js and
// .../length-zero-returns-false.js both report it as
// "Expected SameValue(«undefined», «false»)".
//
// The numeric cases are the ones that regress silently if the search value is
// left to its zero default: `[0].includes()` would compare against f64 0 and
// answer true.
describe("Array.prototype.includes with no argument (ES2016)", () => {
  it("is false for a numeric array containing 0", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [0, 1, 2];
        return arr.includes() ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("is false for an empty array", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [];
        return arr.includes() ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("is false for a string array", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: string[] = ["a", "b"];
        return arr.includes() ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("is true when an element is undefined", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: any[] = [1, undefined, 3];
        return arr.includes() ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("leaves the one-argument form unchanged", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [0, 1, 2];
        return (arr.includes(1) ? 2 : 0) + (arr.includes(9) ? 1 : 0);
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});

// §7.2.12 SameValueZero compares Type(x) before value, so a non-number search
// value can never match an element of a numeric array. TypeScript types the
// parameter as the element type, which is stricter than the language — these
// used to be hard TS2345s that compiled the whole program to zero bytes
// (test262 `includes/samevaluezero.js` is a COMPILE_ERROR row for exactly
// this). Coercing the value instead would be worse than refusing: `"42"` would
// become f64 42 and wrongly match.
//
// Known hole: none of these may be written `arr.includes("42" as any)`. The
// refusal is driven by the argument's STATIC tag, so `as any` erases it to
// "mixed" and the old coercing path runs — `[42].includes("42" as any)` still
// answers true. Closing that needs a tagged runtime comparison, not a static
// one; test262 never writes the annotation, so no conformance row depends on it.
describe("Array.prototype.includes with a non-numeric search value", () => {
  it("is false for a numeric string that would coerce to a member", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [42, 0, 1];
        return arr.includes("42") ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("is false for booleans that would coerce to 0 and 1", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [0, 1];
        return (arr.includes(true) ? 2 : 0) + (arr.includes(false) ? 1 : 0);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("is false for null, which would coerce to 0", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [0, 1, 2];
        return arr.includes(null) ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("still evaluates the search argument for its side effects", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [1, 2];
        var calls: number = 0;
        function probe(): string { calls = calls + 1; return "1"; }
        var found: boolean = arr.includes(probe());
        return (found ? 10 : 0) + calls;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
