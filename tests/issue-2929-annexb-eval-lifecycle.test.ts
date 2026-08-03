// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function compileStandalone(source: string) {
  const result = await compile(source, {
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary)).toBe(true);
  return result;
}

async function runInline(source: string): Promise<number> {
  const result = await compileStandalone(source);
  expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports.run as () => number)();
}

async function expectRuntimeEval(source: string, entry = "__runtime_direct_eval"): Promise<void> {
  const result = await compileStandalone(source);
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
  expect(imports.some((entry) => entry.name === "__extern_eval")).toBe(false);
  expect(imports).toContainEqual({
    module: "js2wasm:runtime-eval",
    name: entry,
    kind: "function",
  });
}

describe("#2929 Annex-B eval binding lifecycle", () => {
  it("initializes a fresh direct-eval outer binding to undefined", async () => {
    await expectRuntimeEval(
      `
        eval(
          "var before = f; { function f() { return 8; } } " +
          "before === undefined && f() === 8 ? 1 : 0"
        );
      `,
      "__runtime_indirect_eval",
    );
  });

  it("updates an existing direct-eval var when the block executes", async () => {
    await expectRuntimeEval(`
        (function () {
          var f: any = "before";
          eval(
            "var before = f; { function f() { return 9; } } " +
            "before === 'before' && f() === 9 ? 1 : 0"
          );
        }());
      `);
  });

  it("routes a same-name eval var and block function through declaration instantiation", async () => {
    await expectRuntimeEval(`
      var after: any;
      (function () {
        eval("{ function f() { return 9; } } after = f; var f = 123;");
      }());
    `);
  });

  it("keeps the simple late-read block-function fast path import-free", async () => {
    await expect(
      runInline(`
        export function run(): number {
          return eval("{ function f() { return 10; } } f()") as number;
        }
      `),
    ).resolves.toBe(10);
  });

  it("updates an existing var from a bare-if function declaration", async () => {
    await expect(
      runInline(`
        export function run(): number {
          var after: any;
          (function () {
            if (true) function f() { return 42; }
            after = f;
            var f = 123;
          }());
          return typeof after === "function" ? after() : -1;
        }
      `),
    ).resolves.toBe(42);
  });

  it("keeps host literal indirect Annex-B eval on the established compile-away path", async () => {
    const result = await compile(
      `
        var observed = 0;
        (0, eval)("if (true) function f() { return 7; } observed = f();");
        export function run(): number { return observed; }
      `,
      { inferModuleStrictArguments: false, skipSemanticDiagnostics: true },
    );
    expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
    expect(
      WebAssembly.Module.imports(new WebAssembly.Module(result.binary)).some((entry) => entry.name === "__extern_eval"),
    ).toBe(false);
    const imports = result.importObject as WebAssembly.Imports & { __setExports?: (exports: unknown) => void };
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setExports?.(instance.exports);
    expect((instance.exports.run as () => number)()).toBe(7);
  });
});
