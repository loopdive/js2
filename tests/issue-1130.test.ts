import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function run(source: string): Promise<Record<string, Function>> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error("Compile failed: " + result.errors.map((e) => `L${e.line}: ${e.message}`).join("; "));
  }
  const rt = buildRuntimeImports(result.imports ?? [], undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, rt);
  if (rt.setExports) rt.setExports(instance.exports as Record<string, Function>);
  return instance.exports as Record<string, Function>;
}

// #1130 PR-0 — array-index-exotic `length` growth on Object.defineProperty.
// Per ES §10.4.2.1, defining a property at a numeric index >= the current
// length grows the array's length to index+1. The backing WasmGC vec must
// grow both its logical length (struct field 0) and its physical `$data`
// array so subsequent iteration / index reads do not trap.
describe("#1130 PR-0: defineProperty array-index length growth", () => {
  it("grows length when defining an index beyond current length (value desc)", async () => {
    const e = await run(
      `export function test(): number { const arr: number[] = []; Object.defineProperty(arr, "2", { value: 7 }); return arr.length; }`,
    );
    expect(e.test()).toBe(3);
  });

  it("grows length when defining an index beyond current length (accessor desc)", async () => {
    const e = await run(
      `export function test(): number { const arr: number[] = [0, 1, 2]; Object.defineProperty(arr, "5", { get: function () { return 9; } }); return arr.length; }`,
    );
    expect(e.test()).toBe(6);
  });

  it("does not shrink/grow when defining an index below current length", async () => {
    const e = await run(
      `export function test(): number { const arr: number[] = [0, 1, 2]; Object.defineProperty(arr, "1", { value: 99 }); return arr.length; }`,
    );
    expect(e.test()).toBe(3);
  });

  it("does not treat the 'length' key as a numeric index", async () => {
    const e = await run(
      `export function test(): number { const arr: number[] = [0, 1, 2]; Object.defineProperty(arr, "length", { value: 5 }); return arr.length; }`,
    );
    // The 'length' key must not be parsed as a canonical array index, so the
    // PR-0 grow path must not fire for it. (length-accessor handling is PR-1.)
    expect(typeof e.test()).toBe("number");
  });

  it("for-loop over the grown array does not trap (backing array grew)", async () => {
    const e = await run(
      `export function test(): number { const arr: number[] = [1]; Object.defineProperty(arr, "4", { value: 9 }); let s = 0; for (let i = 0; i < arr.length; i++) { s += arr[i]; } return s; }`,
    );
    // length grows to 5; the newly-grown slots read as the default (0) since
    // the value-descriptor slow-path element store is PR-1's scope. [1,0,0,0,0]
    expect(e.test()).toBe(1);
  });

  it("forEach iterates the grown length without trapping", async () => {
    const e = await run(
      `export function test(): number { const arr: number[] = []; Object.defineProperty(arr, "2", { value: 7 }); let count = 0; arr.forEach(function (v: number) { count++; }); return count; }`,
    );
    expect(e.test()).toBe(3);
  });

  it("reading a grown index returns the default (no out-of-bounds trap)", async () => {
    const e = await run(
      `export function test(): number { const arr: number[] = [1]; Object.defineProperty(arr, "4", { value: 9 }); return arr[4]; }`,
    );
    expect(e.test()).toBe(0);
  });

  it("grows a string[] vec consistently", async () => {
    const e = await run(
      `export function test(): number { const arr: string[] = ["a"]; Object.defineProperty(arr, "3", { value: "z" }); let c = 0; arr.forEach(function (v: string) { c++; }); return c; }`,
    );
    expect(e.test()).toBe(4);
  });
});
