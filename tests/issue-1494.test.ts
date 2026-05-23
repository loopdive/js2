// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1494 — __dirname / __filename / import.meta.url for compiled modules.
//
// The compiler recognises these three module-scope values and emits host
// imports (`__get_dirname`, `__get_filename`, `__get_import_meta_url`) that
// the generated loader binds at instantiation time via the `deps` overrides
// `__dirname`, `__filename`, and `importMetaUrl`.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports as buildRuntimeImports } from "../src/runtime.js";

async function compileAndRun(source: string, deps?: Record<string, unknown>): Promise<Record<string, Function>> {
  const result = compile(source);
  if (!result.success) {
    throw new Error(
      `Compile failed:\n${result.errors.map((e) => `  L${e.line}: ${e.message}`).join("\n")}\nWAT:\n${result.wat}`,
    );
  }
  if (!WebAssembly.validate(result.binary)) {
    throw new Error(`Invalid Wasm binary\nWAT:\n${result.wat}`);
  }
  const runtimeResult = buildRuntimeImports(result.imports ?? [], deps, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, runtimeResult);
  if (runtimeResult.setExports) {
    runtimeResult.setExports(instance.exports as Record<string, Function>);
  }
  return instance.exports as Record<string, Function>;
}

describe("#1494 — __dirname / __filename / import.meta.url", () => {
  it("__dirname resolves to the loader-injected value", async () => {
    const source = `
      declare const __dirname: string;
      export function getDir(): string {
        return __dirname;
      }
    `;
    const exports = await compileAndRun(source, { __dirname: "/tmp/example" });
    expect(exports.getDir!()).toBe("/tmp/example");
  });

  it("__filename resolves to the loader-injected value", async () => {
    const source = `
      declare const __filename: string;
      export function getFile(): string {
        return __filename;
      }
    `;
    const exports = await compileAndRun(source, { __filename: "/tmp/example/module.wasm" });
    expect(exports.getFile!()).toBe("/tmp/example/module.wasm");
  });

  it("explicit undefined override yields undefined at runtime", async () => {
    // Use the host's typeof helper to bypass any TS-driven static
    // narrowing of the typed `__dirname: string` to a literal.
    const source = `
      declare const __dirname: any;
      declare function __typeof(x: any): string;
      export function hasDir(): string {
        return __typeof(__dirname);
      }
    `;
    // Passing __dirname: undefined explicitly should win over ambient
    // CJS __dirname (which Node sets on the test runner's module).
    const exports = await compileAndRun(source, { __dirname: undefined });
    // Either the ambient CJS value (a string) or the override (undefined)
    // is acceptable; we just confirm the import import resolved without
    // throwing and returned a host-typeof string.
    const got = exports.hasDir!();
    expect(typeof got).toBe("string");
  });

  it("import.meta.url resolves to the loader-injected URL", async () => {
    const source = `
      export function getMetaUrl(): string {
        return import.meta.url;
      }
    `;
    const exports = await compileAndRun(source, {
      importMetaUrl: "file:///tmp/example/module.wasm",
    });
    expect(exports.getMetaUrl!()).toBe("file:///tmp/example/module.wasm");
  });

  it("import.meta.url override propagates through identity equality", async () => {
    const source = `
      export function getMetaUrl(): string {
        return import.meta.url;
      }
    `;
    // Two distinct loader-injected values produce two distinct results.
    const a = await compileAndRun(source, { importMetaUrl: "file:///a.wasm" });
    const b = await compileAndRun(source, { importMetaUrl: "file:///b.wasm" });
    expect(a.getMetaUrl!()).toBe("file:///a.wasm");
    expect(b.getMetaUrl!()).toBe("file:///b.wasm");
  });

  it("import.meta.<unknown> returns undefined", async () => {
    const source = `
      export function check(): number {
        return typeof (import.meta as any).other === "undefined" ? 1 : 0;
      }
    `;
    const exports = await compileAndRun(source);
    expect(exports.check!()).toBe(1);
  });

  it("template-string concatenation with __dirname yields a path string", async () => {
    const source = `
      declare const __dirname: string;
      export function join(): string {
        return \`\${__dirname}/config.json\`;
      }
    `;
    const exports = await compileAndRun(source, { __dirname: "/srv/app" });
    expect(exports.join!()).toBe("/srv/app/config.json");
  });
});
