import { describe, expect, it } from "vitest";
import { compileAndInstantiate } from "../src/runtime-instantiate.js";

async function run(source: string): Promise<unknown> {
  const exp = (await compileAndInstantiate(source)) as { test?: () => unknown };
  return exp.test?.();
}

describe("#1553e — array-literal explicit undefined fires destructuring default", () => {
  it("[undefined] with f64 element kind: default fires", async () => {
    const src = `
      export function test(): number {
        let [x = 42] = [undefined];
        return x === 42 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("[1, undefined, 3] mid-position default fires", async () => {
    const src = `
      export function test(): number {
        let [, x = 9, ] = [1, undefined, 3];
        return x === 9 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("[1, undefined, 3] first-position skipped (real value 1)", async () => {
    const src = `
      let bumped = 0;
      function bump(): number { bumped++; return 42; }
      export function test(): number {
        let [x = bump()] = [1, undefined, 3];
        return x === 1 && bumped === 0 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("var [x = 23] = [undefined] — test262 pattern", async () => {
    const src = `
      export function test(): number {
        var [x = 23] = [undefined];
        return x === 23 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("const [x = 23] = [undefined] — test262 pattern", async () => {
    const src = `
      export function test(): number {
        const [x = 23] = [undefined];
        return x === 23 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("number[] explicit annotation with [undefined as any]", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [undefined as any];
        let [x = 42] = arr;
        return x === 42 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("number[] explicit annotation with mixed [undefined as any, 2]", async () => {
    const src = `
      export function test(): number {
        const arr: number[] = [undefined as any, 2];
        let [x = 42] = arr;
        return x === 42 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("[number?] tuple with undefined element fires default", async () => {
    const src = `
      export function test(): number {
        const arr: [number?] = [undefined as any];
        let [x = 42] = arr;
        return x === 42 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("undefined keyword wrapped in transparent expressions counts as undefined", async () => {
    // void 0 (VoidExpression), (undefined) (Parenthesized), and `undefined as any` (AsExpression)
    // should all be treated as explicit undefined for the sNaN sentinel emit.
    const src = `
      export function test(): number {
        const a: number[] = [void 0 as any];
        let [x = 1] = a;
        const b: number[] = [(undefined as any)];
        let [y = 2] = b;
        return x === 1 && y === 2 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("default initializer is NOT re-evaluated when element is present (skipped)", async () => {
    const src = `
      let calls = 0;
      function side(): number { calls++; return 99; }
      export function test(): number {
        let [x = side()] = [7];
        return x === 7 && calls === 0 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("[null] does NOT fire default — null is not undefined", async () => {
    const src = `
      export function test(): number {
        const arr = [null];
        let [x = 99] = arr;
        // x should be null, NOT 99 — defaults fire only for undefined per §13.3.3.6
        return x === null ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });

  it("explicit undefined in [, undefined, ] does not bleed beyond its slot", async () => {
    const src = `
      export function test(): number {
        let [a = 7, b = 8] = [1, undefined];
        return a === 1 && b === 8 ? 1 : 0;
      }
    `;
    expect(await run(src)).toBe(1);
  });
});
