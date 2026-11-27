import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { compileToWasm } from "./equivalence/helpers.js";

describe("Issue #379: Tuple/destructuring type errors", () => {
  it("empty array destructuring var [] = [] compiles in TS mode", async () => {
    const result = await compile(`
      export function test(): number {
        var [] = [];
        return 0;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("empty array destructuring var [] = [] compiles in JS mode", async () => {
    const result = await compile(
      `
      function test() {
        var [] = [];
        return 0;
      }
    `,
      { allowJs: true, fileName: "input.js" },
    );
    expect(result.success).toBe(true);
  });

  it("var [x] = [] -- destructure from empty array (test262 pattern)", async () => {
    // This triggers TS diagnostic 2493 which should be downgraded
    const result = await compile(`
      export function test(): number {
        var [x] = [];
        return 0;
      }
    `);
    // Should compile without fatal errors
    expect(result.success).toBe(true);
  });

  it("array destructuring with rest element compiles and runs", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var arr = [1, 2, 3, 4, 5];
        var [a, ...rest] = arr;
        return a;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("object destructuring with rest element compiles and runs", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var obj = { a: 10, b: 20, c: 30 };
        var { a, ...rest } = obj;
        return a;
      }
    `);
    expect(exports.test()).toBe(10);
  });

  it("basic array destructuring works", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var arr = [10, 20, 30];
        var [a, b, c] = arr;
        return a + b + c;
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("basic object destructuring works", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var obj = { x: 1, y: 2 };
        var { x, y } = obj;
        return x + y;
      }
    `);
    expect(exports.test()).toBe(3);
  });

  it("object destructuring of boolean (test262: obj-empty-bool)", async () => {
    const result = await compile(`
      export function test(): number {
        var result;
        var vals = false;
        result = ({} = vals);
        return 0;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("object destructuring of number (test262: obj-empty-num)", async () => {
    const result = await compile(`
      export function test(): number {
        var result;
        var vals = 42;
        result = ({} = vals);
        return 0;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("object rest on number (test262: obj-rest-number)", async () => {
    const result = await compile(`
      export function test(): number {
        var rest;
        var result;
        var vals = 51;
        result = ({...rest} = vals);
        return 0;
      }
    `);
    expect(result.success).toBe(true);
  });

  it("statement-level object rest element has no field error", async () => {
    const result = await compile(`
      export function test(): number {
        var obj = { a: 10, b: 20, c: 30 };
        var { a, ...rest } = obj;
        return a;
      }
    `);
    const fieldErrors = result.errors.filter((e) => e.message.includes("Unknown field in destructuring"));
    expect(fieldErrors).toHaveLength(0);
    expect(result.success).toBe(true);
  });

  it("destructuring with unknown source type in JS mode", async () => {
    const result = await compile(
      `
      function test(x) {
        var { a, b } = x;
        return 0;
      }
    `,
      { allowJs: true, fileName: "input.js" },
    );
    expect(result.success).toBe(true);
  });

  it("array destructuring on unknown type in JS mode", async () => {
    const result = await compile(
      `
      function test(x) {
        var [a, b] = x;
        return 0;
      }
    `,
      { allowJs: true, fileName: "input.js" },
    );
    expect(result.success).toBe(true);
  });

  it("rest element in array destructuring extracts rest correctly", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        var arr = [10, 20, 30, 40];
        var [a, ...rest] = arr;
        return a + rest[0] + rest[1];
      }
    `);
    expect(exports.test()).toBe(60);
  });

  it("empty array pattern with non-empty RHS compiles", async () => {
    const result = await compile(`
      export function test(): number {
        var [] = [1, 2, 3];
        return 42;
      }
    `);
    expect(result.success).toBe(true);
  });
});
