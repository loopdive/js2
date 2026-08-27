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

  // §23.1.3.16 step 7a reads each index with Get, which returns `undefined` for
  // a hole — so a sparse array containing only holes and numbers still includes
  // `undefined`. In an f64 vec a hole reads as NaN and `undefined` coerces to
  // NaN, so the both-NaN arm of the SameValueZero comparison is what carries
  // this. Forcing the comparison false for a statically-`undefined` search value
  // broke it (test262 `includes/sparse.js` regressed from pass to fail); this
  // pins both spellings — explicit `undefined` and the absent argument.
  it("is true for a hole in a numeric sparse array", async () => {
    await assertEquivalent(
      `export function test(): number {
        // No annotation: \`number[]\` would make the holes a hard TS2322, and
        // test262 is plain JS with no annotation to begin with.
        var arr = [, , , 42, , ];
        return (arr.includes(undefined) ? 2 : 0) + (arr.includes() ? 1 : 0);
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

// (#4765 slice 1) An `Array.prototype` method read as a VALUE. `arr.m(x)` is
// inlined against the WasmGC vec, so the method never needed to exist as a
// value — and it didn't: `[].includes` read as `null`, so
// `[].includes.call(obj, "a")` died with "Cannot read properties of null
// (reading 'call')". The sibling spelling `Array.prototype.includes.call(obj, …)`
// already worked, which is why the gap stayed invisible.
describe("Array.prototype methods read as values (host lane)", () => {
  it("is callable through .call on an array-like object", async () => {
    await assertEquivalent(
      `export function test(): number {
        var obj: any = { length: 3, 0: "a", 1: "b", 2: "c" };
        // No \`as any\` on the receiver: the intercept keys on the STATIC array
        // fact, and a cast erases it. test262 is plain JS, so this is the shape
        // that matters.
        var arr: string[] = [];
        var found: any = arr.includes.call(obj, "b");
        var missing: any = arr.includes.call(obj, "z");
        return (found ? 2 : 0) + (missing ? 1 : 0);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("has the same identity as the Array.prototype spelling", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: string[] = [];
        return (arr.includes as any) === (Array.prototype as any).includes ? 1 : 0;
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("leaves the inlined call path alone", async () => {
    await assertEquivalent(
      `export function test(): number {
        var arr: number[] = [4, 5, 6];
        return (arr.includes(5) ? 2 : 0) + (arr.includes(9) ? 1 : 0);
      }`,
      [{ fn: "test", args: [] }],
    );
  });

  it("evaluates a side-effecting receiver exactly once", async () => {
    await assertEquivalent(
      `export function test(): number {
        var calls: number = 0;
        function mk(): number[] { calls = calls + 1; return [1, 2]; }
        var f: any = mk().includes;
        return (f ? 10 : 0) + calls;
      }`,
      [{ fn: "test", args: [] }],
    );
  });
});
