// #3413 — detectI32LoopVar may store a canonical for-loop counter as i32, but
// repeated `var i` declarations all denote one function-scoped binding. Its
// Wasm local type must not change as later loop declarations are emitted.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function compileJs(source: string) {
  return compile(source, {
    allowJs: true,
    fileName: "test.js",
    emitWat: true,
    skipSemanticDiagnostics: true,
  });
}

describe("#3413 i32 loop counters with dynamic bounds", () => {
  it("validates a harness-shaped function that redeclares one var counter", async () => {
    const result = await compileJs(`
      function testWithAllTypedArrayConstructors(f, ctors, factories, include, exclude) {
        var selected = factories;
        if (include) {
          selected = [];
          for (var i = 0; i < factories.length; ++i) {
            selected.push(factories[i]);
          }
        }
        if (exclude) {
          selected = selected.slice();
          for (var i = selected.length - 1; i >= 0; --i) {
            selected.splice(i, 1);
          }
        }
        for (var k = 0; k < selected.length; ++k) {
          for (var i = 0; i < ctors.length; ++i) {
            f(ctors[i], selected[k]);
          }
        }
      }
    `);

    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary), result.wat).toBe(true);
  });

  it("preserves fractional values assigned by a later var redeclaration", async () => {
    const result = await compileJs(`
      export function test() {
        for (var i = 0; i < 1; ++i) {}
        for (var i = 0.5; i < 1; ++i) {
          return i;
        }
        return -1;
      }
    `);

    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary), result.wat).toBe(true);
    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports as { test: () => number }).test()).toBe(0.5);
  });

  it("keeps the single-binding i32 loop fast path", async () => {
    const result = await compileJs(`
      function scan(values) {
        for (var i = 0; i < values.length; ++i) {}
      }
    `);

    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary), result.wat).toBe(true);
    expect(result.wat).toContain("(local $i i32)");
  });
});
