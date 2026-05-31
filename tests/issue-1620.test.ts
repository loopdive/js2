import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #1620 v2 — __iterator_next returns Wasm multi-value (i32 done, externref value),
// eliminating the __iterator_done / __iterator_value host imports. The custom
// iterable case is the real exerciser of __iterator_next (string for-of uses the
// array fast-path and never calls it).
async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  if (typeof (imports as any).setExports === "function") {
    (imports as any).setExports(instance.exports);
  }
  return (instance.exports as any)[fn](...args);
}

describe("#1620 multi-value __iterator_next", () => {
  it("eliminates __iterator_done / __iterator_value imports", async () => {
    const result = await compile(`
      export function test(): string {
        let r: string = "";
        for (const ch of "hi") { r = r + ch; }
        return r;
      }
    `);
    expect(result.success).toBe(true);
    expect(result.wat).toContain("__iterator_next");
    expect(result.wat).not.toContain("__iterator_done");
    expect(result.wat).not.toContain("__iterator_value");
  });

  it("iterates a custom iterable via the __iterator_next host bridge", async () => {
    // Object literal with a [Symbol.iterator] returning a manual iterator —
    // forces the for-of through __iterator_next (no array fast-path).
    const src = `
      export function sum(): number {
        const obj = {
          [Symbol.iterator]() {
            let i = 0;
            return {
              next() {
                if (i < 4) { i = i + 1; return { value: i, done: false }; }
                return { value: 0, done: true };
              },
            };
          },
        };
        let total: number = 0;
        for (const n of obj) { total = total + n; }
        return total;
      }
    `;
    expect(await run(src, "sum")).toBe(10); // 1+2+3+4
  });

  it("custom iterable supports break (done short-circuit)", async () => {
    const src = `
      export function firstTwo(): number {
        const obj = {
          [Symbol.iterator]() {
            let i = 0;
            return {
              next() { i = i + 1; return { value: i, done: false }; },
            };
          },
        };
        let count: number = 0;
        let total: number = 0;
        for (const n of obj) {
          if (count === 2) break;
          total = total + n;
          count = count + 1;
        }
        return total;
      }
    `;
    expect(await run(src, "firstTwo")).toBe(3); // 1+2
  });
});
