import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";
import { buildImports } from "../src/runtime.ts";

// #1320 — Array.from(obj) where obj is a plain JS object whose own
// [Symbol.iterator] compiles to a Wasm closure struct (typeof "object", not a
// JS function). Native Array.from rejects such an object with
// "items[Symbol.iterator] … must be a function"; the runtime bridge must drive
// the closure-backed iterator protocol manually instead.
async function run(src: string, fn = "test"): Promise<unknown> {
  const r = await compile(src, { fileName: "test.ts", skipSemanticDiagnostics: true } as never);
  if (!r.success) throw new Error("CE: " + (r.errors?.[0]?.message ?? "unknown"));
  const imports = buildImports(r.imports, undefined, r.stringPool) as never as {
    env: Record<string, Function>;
    setExports?: (e: Record<string, Function>) => void;
  } & WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, () => unknown>)[fn]?.();
}

describe("#1320 Array.from over a closure-backed @@iterator", () => {
  it("does not throw 'iterator is not a function' for an empty closure iterator", async () => {
    const src = `
      var items: any = {};
      items[Symbol.iterator] = function() {
        return { next: function() { return { done: true, value: undefined }; } };
      };
      export function test(): number { return Array.from(items).length; }
    `;
    // Empty iterator → zero-length array, and crucially no TypeError thrown.
    await expect(run(src)).resolves.toBe(0);
  });

  it("invokes the closure @@iterator exactly once (callCount observable)", async () => {
    const src = `
      var callCount = 0;
      var items: any = {};
      items[Symbol.iterator] = function() {
        callCount++;
        return { next: function() { return { done: true, value: undefined }; } };
      };
      export function test(): number {
        Array.from(items);
        return callCount;
      }
    `;
    await expect(run(src)).resolves.toBe(1);
  });
});
