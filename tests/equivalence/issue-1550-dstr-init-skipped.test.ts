import { describe, it } from "vitest";
import { assertEquivalent } from "./helpers.js";

// #1550 — destructuring default initializers must fire ONLY when the read
// value is `undefined`, never for JS `null` (or 0/false/"" etc).
// ECMA-262 §13.3.3.6/§13.3.3.7 (binding) and §13.15.5.5 (assignment).
describe("#1550 dstr default init-skipped (null must not fire default)", () => {
  it("array binding declaration keeps null (default skipped)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let [a = 99]: (number | null)[] = [null];
        return a === null ? 0 : (a as number);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array binding declaration fires default for undefined", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let [a = 99]: (number | undefined)[] = [undefined];
        return a as number;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object binding declaration keeps null (default skipped)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let { a = 99 }: { a: number | null } = { a: null };
        return a === null ? 0 : (a as number);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object binding declaration fires default for undefined", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let { a = 99 }: { a?: number } = {};
        return a as number;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function array param keeps null (default skipped)", async () => {
    await assertEquivalent(
      `
      function f([a = 99]: (number | null)[]): number {
        return a === null ? 0 : (a as number);
      }
      export function test(): number { return f([null]); }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("function object param keeps null (default skipped)", async () => {
    await assertEquivalent(
      `
      function f({ a = 99 }: { a: number | null }): number {
        return a === null ? 0 : (a as number);
      }
      export function test(): number { return f({ a: null }); }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array assignment pattern keeps null (default skipped)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let a: number | null = 5;
        [a = 99] = [null];
        return a === null ? 0 : (a as number);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("object assignment pattern keeps null (default skipped)", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let a: number | null = 5;
        ({ a = 99 } = { a: null });
        return a === null ? 0 : (a as number);
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("array binding default not eagerly evaluated for non-undefined values", async () => {
    // Mirrors the canonical test262 init-skipped counter pattern: none of the
    // initializers should run because every element is non-undefined.
    await assertEquivalent(
      `
      function f(
        [a = 1, b = 1, c = 1, d = 1]: (number | null | boolean | string)[] =
          [null, 0, false, ""],
      ): number {
        // a stays null, b stays 0, c stays false, d stays "" — all kept.
        return (a === null && (b as number) === 0 && c === false && d === "") ? 1 : 0;
      }
      export function test(): number { return f(); }
      `,
      [{ fn: "test", args: [] }],
    );
  });

  it("default value is kept for a present non-undefined value", async () => {
    await assertEquivalent(
      `
      export function test(): number {
        let { a = 99 }: { a?: number } = { a: 7 };
        return a as number;
      }
      `,
      [{ fn: "test", args: [] }],
    );
  });
});
