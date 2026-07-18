// #3416 — preserve callable identity and defer dynamic TypedArray overloads
// while the literal harness iterates and binds heterogeneous argument factories.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";
import { join } from "node:path";
import { createTestSandbox, runTest262File } from "./test262-runner.js";

describe("#3416 host dynamic closure bind", () => {
  it("hoists a function before a top-level factory-array initializer", async () => {
    const result = await compile(
      `
      function makePassthrough(TA, value) { return value; }
      function makeOther(TA, value) { return [value]; }
      var factories = [makePassthrough, makeOther];
      export function direct() {
        var factory = factories[0];
        return typeof factory === "function" ? factory(42, 7) : -1;
      }
      function choose(include) {
        var selected = factories;
        if (include) selected = [];
        var factory = selected[0];
        var bound = factory.bind(undefined, 42);
        return bound(7);
      }
      export function test() {
        return choose(undefined);
      }
    `,
      {
        allowJs: true,
        fileName: "test.js",
        skipSemanticDiagnostics: true,
        deferTopLevelInit: true,
      },
    );
    expect(result.success).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const exports = instance.exports as { __module_init: () => void; direct: () => number; test: () => number };
    exports.__module_init();
    expect(exports.direct()).toBe(7);
    expect(exports.test()).toBe(7);
  });

  it("binds a closure loaded from a harness-shaped factory array", async () => {
    const result = await compile(
      `
      function makePassthrough(TA, value) { return value; }
      function run(factories) {
        var argFactory = factories[0];
        var boundArgFactory = argFactory.bind(undefined, 42);
        return boundArgFactory(7);
      }
      export function test() {
        return run([makePassthrough]);
      }
    `,
      { allowJs: true, fileName: "test.js", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, Function>);
    expect((instance.exports as { test: () => number }).test()).toBe(7);
  });

  it("preserves each closure selected dynamically from a heterogeneous array", async () => {
    const result = await compile(
      `
      function one(TA, value) { return 1; }
      function two(TA, value) { return 2; }
      function three(TA, value) { return 3; }
      var factories = [one, two, three];
      export function test() {
        var result = 0;
        for (var k = 0; k < factories.length; ++k) {
          var factory = factories[k];
          var bound = factory.bind(undefined, 42);
          result = result * 10 + bound(7);
        }
        return result;
      }
    `,
      { allowJs: true, fileName: "test.js", skipSemanticDiagnostics: true, deferTopLevelInit: true },
    );
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const imports = buildImports(result.imports, undefined, result.stringPool);
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const exports = instance.exports as { __module_init: () => void; test: () => number };
    exports.__module_init();
    expect(exports.test()).toBe(123);
  });

  it("copies bytes between host ArrayBuffers through host TypedArray views", async () => {
    const result = await compile(
      `
      export function test(destBuffer, srcBuffer) {
        var destView = new Uint8Array(destBuffer);
        var srcView = new Uint8Array(srcBuffer);
        for (var i = 0; i < srcView.length; ++i) destView[i] = srcView[i];
        return destView[0] * 1000 + destView[1] * 100 + destView[2] * 10 + destView[3];
      }
    `,
      { allowJs: true, fileName: "test.js", skipSemanticDiagnostics: true },
    );
    expect(result.success).toBe(true);
    expect(WebAssembly.validate(result.binary)).toBe(true);

    const sandbox = createTestSandbox();
    const imports = buildImports(result.imports, undefined, result.stringPool, { globalSandbox: sandbox });
    const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
    imports.setExports?.(instance.exports as Record<string, Function>);
    const source = new sandbox.Uint8Array([1, 2, 3, 4]).buffer;
    const dest = new sandbox.ArrayBuffer(4, { maxByteLength: 8 });
    expect((instance.exports as { test: (dest: ArrayBuffer, source: ArrayBuffer) => number }).test(dest, source)).toBe(
      1234,
    );
    expect(Array.from(new sandbox.Uint8Array(dest))).toEqual([1, 2, 3, 4]);
  });

  it("passes the literal TypedArray bound-argument-factory flow", async () => {
    const path = join(
      import.meta.dirname,
      "..",
      "test262",
      "test",
      "built-ins",
      "TypedArray",
      "prototype",
      "subarray",
      "minus-zero.js",
    );
    const result = await runTest262File(path, "built-ins/TypedArray");
    expect(result.status, result.error).toBe("pass");
  });
});
