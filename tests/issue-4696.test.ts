import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function run(source: string): Promise<number> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) throw new Error(result.errors.map((e) => e.message).join("; "));
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => number }).test();
}

describe("#4696 synchronous for-of IteratorClose", () => {
  it("closes a native generator binding on break", async () => {
    await expect(
      run(`export function test(): number {
        let started = 0, closed = 0;
        function* values() { started += 1; try { yield 1; } finally { closed += 1; } }
        var iterable = values();
        for (const value of iterable) break;
        return started * 10 + closed;
      }`),
    ).resolves.toBe(11);
  });

  it("closes a module generator binding on return", async () => {
    await expect(
      run(`
        let started = 0, closed = 0, iterations = 0;
        function* values() { started += 1; try { yield 1; } finally { closed += 1; } }
        const iterable = values();
        export function test(): number {
          function consume(): number { for (const value of iterable) { iterations += 1; return 1; } return 0; }
          const result = consume();
          return started * 100 + closed * 10 + iterations + result;
        }
      `),
    ).resolves.toBe(112);
  });
});
