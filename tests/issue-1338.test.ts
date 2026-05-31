import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

describe("#1338 — Array.from fast path: externref element type default value", () => {
  async function run(src: string): Promise<any> {
    const r = await compile(src, { fileName: "test.ts" });
    if (!r.success) throw new Error(`CE: ${r.errors[0]?.message}`);
    const imports = buildImports(r.imports, undefined, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, imports);
    return (instance.exports as any).test?.();
  }

  it("Array.from over mixed-typed (externref) array validates and copies length", async () => {
    const ret = await run(`
      export function test(): number {
        const array: any[] = [0, 'foo', undefined, Infinity];
        const result = Array.from(array);
        return result.length;
      }
    `);
    expect(ret).toBe(4);
  });

  it("Array.from over numeric array still works (f64 fast path)", async () => {
    const ret = await run(`
      export function test(): number {
        const array: number[] = [1, 2, 3, 4, 5];
        const result = Array.from(array);
        return result.length;
      }
    `);
    expect(ret).toBe(5);
  });

  it("Array.from over string array (externref) validates", async () => {
    const ret = await run(`
      export function test(): number {
        const array: string[] = ['a', 'b', 'c'];
        const result = Array.from(array);
        return result.length;
      }
    `);
    expect(ret).toBe(3);
  });
});
