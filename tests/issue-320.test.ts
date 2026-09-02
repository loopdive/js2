import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildStringConstants } from "../src/runtime.js";

describe("Dead import and type elimination (#320)", () => {
  it("removes unused wasm:js-string imports when only concat is used", async () => {
    const result = await compile(`
      export function greet(name: string): string { return "Hello " + name; }
    `);
    expect(result.success).toBe(true);

    // Should have concat but NOT length, equals, substring, charCodeAt
    expect(result.wat).toContain('"concat"');
    expect(result.wat).not.toContain('"length"');
    expect(result.wat).not.toContain('"equals"');
    expect(result.wat).not.toContain('"substring"');
    expect(result.wat).not.toContain('"charCodeAt"');
  });

  it("keeps wasm:js-string imports that are actually called", async () => {
    const result = await compile(`
      export function test(a: string, b: string): number {
        const c = a + b;
        const len = c.length;
        const eq = a === b ? 1 : 0;
        return len + eq;
      }
    `);
    expect(result.success).toBe(true);

    // concat, length, equals are used by the function body
    expect(result.wat).toContain('"concat"');
    expect(result.wat).toContain('"length"');
    expect(result.wat).toContain('"equals"');
  });

  it("eliminates unused func types alongside dead imports", async () => {
    const result = await compile(`
      export function add(a: number, b: number): number { return a + b; }
      export function greet(name: string): string { return "Hi " + name; }
    `);
    expect(result.success).toBe(true);

    // Count type definitions - should have exactly 3:
    // concat type, add_type, greet_type (unused string import types eliminated)
    const typeLines = result.wat.split("\n").filter((l: string) => l.trim().startsWith("(type"));
    // Without elimination we'd have 7 types; with it we should have fewer
    expect(typeLines.length).toBeLessThan(7);
  });

  it("does not eliminate types referenced by struct fields", async () => {
    const result = await compile(`
      interface Point { x: number; y: number; }
      export function makePoint(): Point { return { x: 1, y: 2 }; }
      export function getX(p: Point): number { return p.x; }
    `);
    expect(result.success).toBe(true);

    // Should compile and validate
    const mod = new WebAssembly.Module(result.binary);
    expect(mod).toBeDefined();
  });

  it("produces valid wasm binary after elimination", async () => {
    const result = await compile(`
      export function add(a: number, b: number): number { return a + b; }
      export function greet(name: string): string { return "Hello " + name; }
    `);
    expect(result.success).toBe(true);

    // The binary should be valid wasm
    const mod = new WebAssembly.Module(result.binary);
    expect(mod).toBeDefined();
  });

  it("handles programs with no dead imports (no-op)", async () => {
    const result = await compile(`
      export function add(a: number, b: number): number { return a + b; }
    `);
    expect(result.success).toBe(true);

    // (#731, 8d17e2d8e0 "add function/class .name property infrastructure")
    // pre-registers every function/class name — and, once the pool is non-empty,
    // the implicit "" — as a `string_constants` global, so even pure arithmetic
    // now carries imports. The #320 intent is *dead-import elimination*, so pin
    // that instead: no `wasm:js-string` and no `env` import survive, and the only
    // imports left are exactly the two `.name` metadata globals.
    expect(result.wat).not.toContain('(import "wasm:js-string"');
    expect(result.wat).not.toContain('(import "env"');
    const importLines = result.wat
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.startsWith("(import"));
    expect(importLines).toEqual([
      '(import "string_constants" "add" (global $add externref))',
      '(import "string_constants" "" (global $ externref))',
    ]);

    const mod = new WebAssembly.Module(result.binary);
    expect(mod).toBeDefined();
  });

  it("correctly remaps function indices after import removal", async () => {
    const result = await compile(`
      export function greet(name: string): string { return "Hello " + name; }
    `);
    expect(result.success).toBe(true);

    // Should be instantiable and functional
    const mod = new WebAssembly.Module(result.binary);

    // Build minimal imports - only what survived elimination
    const imports: Record<string, Record<string, any>> = {
      "wasm:js-string": {
        concat: (a: string, b: string) => a + b,
      },
      string_constants: buildStringConstants(result.stringPool),
    };

    const instance = await WebAssembly.instantiate(mod, imports);
    const greet = (instance.exports as any).greet;
    expect(greet("World")).toBe("Hello World");
  });

  it("reduces binary size compared to baseline", async () => {
    const result = await compile(`
      export function greet(name: string): string { return "Hello " + name; }
    `);
    expect(result.success).toBe(true);

    // With elimination, binary should be small for this simple function
    // (< 300 bytes without the 4 unused string imports and their types)
    expect(result.binary.length).toBeLessThan(300);
  });
});
