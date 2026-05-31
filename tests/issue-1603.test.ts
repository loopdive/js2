// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Tests for #1603 — optional-chaining short-circuit emitted invalid wasm.
 *
 * `obj?.prop` on a nullable-union receiver compiled the property access
 * against the bare `T | null` union, whose anonymous symbol failed struct
 * resolution. The receiver ref was then left on the else-branch stack while
 * the `if` block result type was forced to externref, producing a wasm that
 * failed validation (`ref.is_null` / fallthru type error) at instantiate time.
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

describe("#1603 — optional chaining on nullable-union receiver", () => {
  it("instantiates valid wasm for `a?.b` when a is a null class union", async () => {
    const src = `
      class C { b: number = 5; }
      export function test(): number {
        const a: C | null = null;
        const x = a?.b;
        // Reaching this point at all means instantiation succeeded.
        return x === undefined ? 1 : 0;
      }
    `;
    // The point of #1603 is that this compiles AND instantiates without a
    // wasm validation error — previously it threw at WebAssembly.instantiate.
    await expect(run(src)).resolves.toBeDefined();
  });

  it("instantiates valid wasm for `a?.b` on an inline nullable object type", async () => {
    const src = `
      export function test(): number {
        const a: { b: number } | null = null;
        const x = a?.b;
        return x === undefined ? 1 : 0;
      }
    `;
    await expect(run(src)).resolves.toBeDefined();
  });

  it("reads the property when the receiver is non-null", async () => {
    const src = `
      class C { b: number = 7; }
      export function test(): number {
        const a: C | null = new C();
        return a?.b ?? -1;
      }
    `;
    expect(await run(src)).toBe(7);
  });
});
