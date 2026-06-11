import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #1993 — default (no-comparator) Array.prototype.sort compares by ToString
//         (§23.1.3.30), so [10,9,1,100].sort() is lexicographic, not numeric.
// #2000 — Array(len) throws a catchable RangeError for non-integer / negative
//         / out-of-range lengths (§23.1.1.1 step 4.b).
async function compileAndRun(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  return instance.exports as Record<string, Function>;
}

describe("#1993 — default numeric sort is lexicographic (ToString order)", () => {
  it("[10,9,1,100].sort() === [1,10,100,9]", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [10,9,1,100]; a.sort(); return a.join(","); }`,
    );
    expect(e.test!()).toBe("1,10,100,9");
  });

  it("[2,10,1].sort() === [1,10,2]", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [2,10,1]; a.sort(); return a.join(","); }`,
    );
    expect(e.test!()).toBe("1,10,2");
  });

  it("single-digit arrays match numeric order (ToString === numeric there)", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [3,1,2]; a.sort(); return a.join(","); }`,
    );
    expect(e.test!()).toBe("1,2,3");
  });

  it("negative numbers sort lexicographically", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [-1,-10,-2]; a.sort(); return a.join(","); }`,
    );
    expect(e.test!()).toBe("-1,-10,-2");
  });

  it("with-comparator sort is unchanged (numeric ascending)", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [10,9,1,100]; a.sort((x,y)=>x-y); return a.join(","); }`,
    );
    expect(e.test!()).toBe("1,9,10,100");
  });

  it("with-comparator descending is unchanged", async () => {
    const e = await compileAndRun(
      `export function test(): string { const a = [1,2,3]; a.sort((x,y)=>y-x); return a.join(","); }`,
    );
    expect(e.test!()).toBe("3,2,1");
  });

  it("empty and single-element arrays are stable", async () => {
    const empty = await compileAndRun(
      `export function test(): number { const a: number[] = []; a.sort(); return a.length; }`,
    );
    expect(empty.test!()).toBe(0);
    const single = await compileAndRun(
      `export function test(): string { const a = [5]; a.sort(); return a.join(","); }`,
    );
    expect(single.test!()).toBe("5");
  });
});

describe("#2000 — Array(len) throws RangeError on invalid lengths", () => {
  it("Array(3.5) throws (caught → -1)", async () => {
    const e = await compileAndRun(
      `export function test(): number { try { const a = Array(3.5); return a.length; } catch(e) { return -1; } }`,
    );
    expect(e.test!()).toBe(-1);
  });

  it("Array(-1) throws (caught → -1)", async () => {
    const e = await compileAndRun(
      `export function test(): number { try { const a = Array(-1); return a.length; } catch(e) { return -1; } }`,
    );
    expect(e.test!()).toBe(-1);
  });

  it("Array(NaN) throws (caught → -1)", async () => {
    const e = await compileAndRun(
      `export function test(): number { try { const a = Array(NaN); return a.length; } catch(e) { return -1; } }`,
    );
    expect(e.test!()).toBe(-1);
  });

  it("Array(3) keeps length 3", async () => {
    const e = await compileAndRun(`export function test(): number { const a = Array(3); return a.length; }`);
    expect(e.test!()).toBe(3);
  });

  it("Array(0) and new Array(5) are unchanged", async () => {
    const zero = await compileAndRun(`export function test(): number { const a = Array(0); return a.length; }`);
    expect(zero.test!()).toBe(0);
    const five = await compileAndRun(`export function test(): number { const a = new Array(5); return a.length; }`);
    expect(five.test!()).toBe(5);
  });
});
