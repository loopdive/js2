import { describe, it, expect } from "vitest";
import { compile } from "../../src/index.js";
import { buildImports as buildRuntimeImports } from "../../src/runtime.js";
import { compileToWasm } from "./helpers.js";

// #1494 — `import.meta.url` is now a host import (`__get_import_meta_url`)
// rather than a baked-in literal. Tests that exercise the value supply it
// via `deps.importMetaUrl`; tests that exercise the AST shape go through
// the default helper (which leaves the value undefined).
async function compileWithMetaUrl(source: string, importMetaUrl?: string) {
  const result = await compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  const runtimeResult = buildRuntimeImports(result.imports ?? [], { importMetaUrl }, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, runtimeResult);
  runtimeResult.setInstance?.(instance);
  return instance.exports as Record<string, Function>;
}

describe("import.meta support", () => {
  it("import.meta.url reflects the loader-injected value", async () => {
    const exports = await compileWithMetaUrl(
      `
      export function test(): string {
        return import.meta.url;
      }
    `,
      "file:///example/module.wasm",
    );
    const result = exports.test();
    expect(typeof result).toBe("string");
    expect(result).toBe("file:///example/module.wasm");
  });

  it("typeof import.meta returns 'object'", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if (typeof import.meta === "object") return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("import.meta is truthy", async () => {
    const exports = await compileToWasm(`
      export function test(): number {
        if (import.meta) return 1;
        return 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });

  it("import.meta.url can be stored in a variable", async () => {
    const exports = await compileWithMetaUrl(
      `
      export function test(): string {
        const url = import.meta.url;
        return url;
      }
    `,
      "file:///example/module.wasm",
    );
    expect(exports.test()).toBe("file:///example/module.wasm");
  });
});
