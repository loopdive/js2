import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(src: string): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error(`compile error: ${r.errors[0]?.message}`);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  return (instance.exports as { test?: () => unknown }).test?.();
}

describe("#1629b — Object.getOwnPropertyDescriptor attribute readback", () => {
  it("reads writable:false after defineProperty on existing field", async () => {
    const src = `
      export function test(): number {
        const o = { foo: 1 };
        Object.defineProperty(o, "foo", { value: 101, writable: false });
        const desc = Object.getOwnPropertyDescriptor(o, "foo");
        if (desc === undefined) return 100;
        if ((desc as any).writable === false) return 0;
        return 1;
      }
    `;
    expect(await run(src)).toBe(0);
  });

  it("reads enumerable:false after defineProperty", async () => {
    const src = `
      export function test(): number {
        const o = { bar: 2 };
        Object.defineProperty(o, "bar", { value: 5, enumerable: false });
        const desc = Object.getOwnPropertyDescriptor(o, "bar");
        if (desc === undefined) return 100;
        if ((desc as any).enumerable === false) return 0;
        return 1;
      }
    `;
    expect(await run(src)).toBe(0);
  });

  it("reads configurable:false after defineProperty", async () => {
    const src = `
      export function test(): number {
        const o = { baz: 3 };
        Object.defineProperty(o, "baz", { value: 7, configurable: false });
        const desc = Object.getOwnPropertyDescriptor(o, "baz");
        if (desc === undefined) return 100;
        if ((desc as any).configurable === false) return 0;
        return 1;
      }
    `;
    expect(await run(src)).toBe(0);
  });

  it("preserves default writable:true when no defineProperty call", async () => {
    const src = `
      export function test(): number {
        const o = { x: 9 };
        const desc = Object.getOwnPropertyDescriptor(o, "x");
        if (desc === undefined) return 100;
        if ((desc as any).writable === true) return 0;
        return 1;
      }
    `;
    expect(await run(src)).toBe(0);
  });
});
