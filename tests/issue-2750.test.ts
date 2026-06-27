import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

// #2750 S2 — out-of-bounds index read on an externref-element array (`any[]`,
// `string[]`) must return JS `undefined`, not `null`. The element slot of a
// packed `number[]`/`boolean[]` cannot structurally hold `undefined`, so those
// keep their type-default sentinel — the full close is the deferred S5
// `noUncheckedIndexedAccess` epic, NOT this slice.
async function run(source: string, fn: string, args: unknown[] = []): Promise<unknown> {
  const result = await compile(source, { fileName: "test.ts" });
  if (!result.success) {
    throw new Error(`Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}`);
  }
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn](...args);
}

describe("#2750 S2 — externref-element OOB read returns undefined", () => {
  it("any[] out-of-bounds === undefined", async () => {
    const src = `export function test(): boolean { const a: any[] = [1]; return a[9] === undefined; }`;
    expect(await run(src, "test")).toBe(1); // true
  });

  it("any[] out-of-bounds !== null", async () => {
    const src = `export function test(): boolean { const a: any[] = [1]; return a[9] === null; }`;
    expect(await run(src, "test")).toBe(0); // false — was true (ref.null.extern) before the fix
  });

  it("string[] out-of-bounds === undefined", async () => {
    const src = `export function test(): boolean { const a: string[] = ["x"]; return a[9] === undefined; }`;
    expect(await run(src, "test")).toBe(1); // true
  });

  it("any[] negative index === undefined", async () => {
    const src = `export function test(): boolean { const a: any[] = [1, 2]; return a[-1] === undefined; }`;
    expect(await run(src, "test")).toBe(1); // true
  });

  it("any[] in-bounds read is unchanged", async () => {
    const src = `export function test(): number { const a: any[] = [42]; return a[0] as number; }`;
    expect(await run(src, "test")).toBe(42);
  });

  // Packed-array OOB is explicitly NOT changed by S2 — it keeps the type-default
  // sentinel (sNaN for number, 0/false for boolean). The real fix is the deferred
  // S5 `noUncheckedIndexedAccess` epic. These cases lock in the intentional gap so
  // a future change to packed reads is a conscious decision, not an accident.
  it("number[] OOB still returns the type-default sentinel, NOT undefined (deferred S5)", async () => {
    const src = `export function test(): boolean { const a: number[] = [1]; return a[9] === undefined; }`;
    expect(await run(src, "test")).toBe(0); // false — packed f64 slot can't hold undefined
  });

  it("boolean[] OOB still returns the type-default sentinel, NOT undefined (deferred S5)", async () => {
    const src = `export function test(): boolean { const a: boolean[] = [true]; return a[9] === undefined; }`;
    expect(await run(src, "test")).toBe(0); // false — packed i32 slot can't hold undefined
  });
});
