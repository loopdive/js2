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
