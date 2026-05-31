// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Tests for #1129 — ToObject (§7.1.18) / Object(primitive) auto-boxing.
 *
 * ECMAScript §20.1.1.1 Object(value):
 *   - Object() / Object(null) / Object(undefined) → fresh empty object
 *   - Object(number) → new Number(x) wrapper (typeof === "object")
 *   - Object(string) → new String(x) wrapper (typeof === "object")
 *   - Object(boolean) → new Boolean(x) wrapper (typeof === "object")
 *   - Object(object) → return unchanged
 */
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(source: string): Promise<unknown> {
  const r = await compile(source, { fileName: "test.ts" });
  if (!r.success) {
    throw new Error(`compile failed: ${r.errors[0]?.message ?? "unknown"}`);
  }
  const built = buildImports(r.imports, {}, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, {
    env: built.env,
    string_constants: built.string_constants,
  } as WebAssembly.Imports);
  if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>).test();
}

describe("#1129 — Object(primitive) auto-boxing", () => {
  it("Object(42) → typeof === 'object' (Number wrapper)", async () => {
    const src = `
      export function test(): string {
        const w = Object(42);
        return typeof w;
      }
    `;
    expect(await run(src)).toBe("object");
  });

  it("Object('abc') → typeof === 'object' (String wrapper)", async () => {
    const src = `
      export function test(): string {
        const w = Object("abc");
        return typeof w;
      }
    `;
    expect(await run(src)).toBe("object");
  });

  it("Object(true) → typeof === 'object' (Boolean wrapper)", async () => {
    const src = `
      export function test(): string {
        const w = Object(true);
        return typeof w;
      }
    `;
    expect(await run(src)).toBe("object");
  });

  it("Object(null) → typeof === 'object' (empty object, not TypeError)", async () => {
    const src = `
      export function test(): string {
        const w = Object(null);
        return typeof w;
      }
    `;
    expect(await run(src)).toBe("object");
  });

  it("Object(undefined) → typeof === 'object' (empty object)", async () => {
    const src = `
      export function test(): string {
        const w = Object(undefined);
        return typeof w;
      }
    `;
    expect(await run(src)).toBe("object");
  });

  it("Object() → typeof === 'object' (empty object, no arg)", async () => {
    const src = `
      export function test(): string {
        const w = Object();
        return typeof w;
      }
    `;
    expect(await run(src)).toBe("object");
  });

  it("Object(42).valueOf() === 42 (Number wrapper has correct value)", async () => {
    const src = `
      export function test(): number {
        const w = Object(42);
        return (w as any).valueOf() as number;
      }
    `;
    expect(await run(src)).toBe(42);
  });

  it("Object(false) is an object (Boolean wrapper, not the primitive)", async () => {
    // The wrapper is an object — Boolean(false) === false because it's an
    // object reference, distinct from the primitive false. Confirms that
    // Object(false) auto-boxes per §20.1.1.1 (not just returns the primitive).
    const src = `
      export function test(): string {
        const w = Object(false);
        return typeof w;
      }
    `;
    expect(await run(src)).toBe("object");
  });

  it("Object('abc').toString() === 'abc' (String wrapper round-trip)", async () => {
    // Verifies the wrapper carries the boxed primitive — toString() unwraps
    // it via the String.prototype dispatch (host method call).
    const src = `
      export function test(): string {
        const w = Object("abc");
        return (w as any).toString() as string;
      }
    `;
    expect(await run(src)).toBe("abc");
  });
});
