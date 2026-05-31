import { describe, it, expect } from "vitest";
import { compile } from "./src/index.js";
import { buildImports } from "./src/runtime.js";

describe("#1630 — Object.assign writeback into typed wasmGC struct", () => {
  async function runReturn(src: string): Promise<{ ret?: unknown; error?: string }> {
    const result = await compile(src, { skipSemanticDiagnostics: true });
    if (!result.success) return { error: result.errors?.[0]?.message ?? "compile failed" };
    const importObj = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await WebAssembly.instantiate(result.binary, importObj as any);
    if (typeof (importObj as any).setExports === "function") {
      (importObj as any).setExports(instance.exports);
    }
    try {
      const ret = (instance.exports as { test: () => unknown }).test();
      return { ret };
    } catch (e: unknown) {
      return { error: String(e) };
    }
  }

  it("plain data-property copy reflects into struct fields read via Wasm", async () => {
    const src = `
      const t: { a: number, b: number } = { a: 0, b: 0 };
      const src: { a: number, b: number } = { a: 7, b: 9 };
      export function test(): number {
        Object.assign(t, src);
        return t.a + t.b;
      }
    `;
    const { ret, error } = await runReturn(src);
    expect(error).toBeUndefined();
    expect(ret).toBe(16);
  });

  it("struct-typed sources copy their data properties into struct target", async () => {
    const src = `
      const t: { x: number, y: number, z: number } = { x: 0, y: 0, z: 0 };
      const s: { x: number, y: number, z: number } = { x: 1, y: 2, z: 3 };
      export function test(): number {
        Object.assign(t, s);
        return t.x * 100 + t.y * 10 + t.z;
      }
    `;
    const { ret, error } = await runReturn(src);
    expect(error).toBeUndefined();
    expect(ret).toBe(123);
  });

  it("multi-source assign: later sources overwrite earlier ones", async () => {
    const src = `
      const t: { a: number, b: number } = { a: 0, b: 0 };
      const s1: { a: number, b: number } = { a: 1, b: 2 };
      const s2: { a: number, b: number } = { a: 10, b: 20 };
      export function test(): number {
        Object.assign(t, s1, s2);
        return t.a * 100 + t.b;
      }
    `;
    const { ret, error } = await runReturn(src);
    expect(error).toBeUndefined();
    expect(ret).toBe(1020);
  });

  it("Object.assign returns the target object", async () => {
    const src = `
      const t: { a: number } = { a: 0 };
      const s: { a: number } = { a: 5 };
      export function test(): number {
        const ret: any = Object.assign(t, s);
        return ret === t ? 1 : 0;
      }
    `;
    const { ret, error } = await runReturn(src);
    expect(error).toBeUndefined();
    expect(ret).toBe(1);
  });

  it("null/undefined sources are skipped without error", async () => {
    const src = `
      const t: { a: number } = { a: 3 };
      export function test(): number {
        Object.assign(t, null as any, undefined as any, { a: 7 });
        return t.a;
      }
    `;
    const { ret, error } = await runReturn(src);
    expect(error).toBeUndefined();
    expect(ret).toBe(7);
  });
});
