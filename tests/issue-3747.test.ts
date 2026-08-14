// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #3747 — CommonJS/UMD callable values must survive property storage and
// cross-module default-import linking.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function run(files: Record<string, string>): Promise<number> {
  const result = await compileMulti(files, "./entry.ts", {
    allowJs: true,
    skipSemanticDiagnostics: true,
  });
  expect(result.success).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports.test as () => number)();
}

describe("#3747 CommonJS callable value linking", () => {
  it("links module.exports = identifier through a default import", async () => {
    expect(
      await run({
        "./entry.ts": `import value from "./module.js";
          export function test(): number { return value(6); }`,
        "./module.js": `function increment(value) { return value + 1; }
          module.exports = increment;`,
      }),
    ).toBe(7);
  });

  it("preserves a closure returned by a factory and assigned to module.exports", async () => {
    expect(
      await run({
        "./entry.ts": `import value from "./module.js";
          export function test(): number { return value(6); }`,
        "./module.js": `function factory(operator) {
            var offset = 1;
            return function (value) { return operator(value) + offset; };
          }
          var result = factory(function (value) { return value; });
          module.exports = result;`,
      }),
    ).toBe(7);
  });

  it("links a CommonJS var-require factory that returns the exported closure", async () => {
    expect(
      await run({
        "./entry.ts": `import value from "./module.js";
          export function test(): number { return value(6); }`,
        "./module.js": `var factory = require("./factory.js");
          var result = factory(function (value) { return value; });
          module.exports = result;`,
        "./factory.js": `function factory(operator) {
            var offset = 1;
            return function (value) { return operator(value) + offset; };
          }
          module.exports = factory;`,
      }),
    ).toBe(7);
  });

  // The explicit local `{ exports: {} }` carrier is the unresolved core of
  // #3747. Keep it executable as an expected failure; the ambient CommonJS
  // rewrite cases below are separate and now pass.
  it.fails("preserves a UMD-shaped factory result assigned through module.exports", async () => {
    expect(
      await run({
        "./entry.ts": `import value from "./module.js";
          export function test(): number { return value(6); }`,
        "./module.js": `var module = { exports: {} };
          var exports = module.exports;
          (function (factory) { module.exports = factory(); }(function () {
            var offset = 1;
            return function (value) { return value + offset; };
          }));
          export default module.exports;`,
      }),
    ).toBe(7);
  });

  it("rewrites an ambient CommonJS UMD branch to a live default export", async () => {
    expect(
      await run({
        "./entry.ts": `import value from "./module.js";
          export function test(): number { return value(6); }`,
        "./module.js": `(function (global, factory) {
            typeof exports === "object" && typeof module !== "undefined"
              ? module.exports = factory()
              : global.value = factory();
          }(this, function () {
            var offset = 1;
            return function (value) { return value + offset; };
          }));`,
      }),
    ).toBe(7);
  });

  it("materializes the ambient UMD default import as a value with properties", async () => {
    expect(
      await run({
        "./entry.ts": `import value from "./module.js";
          function inspect(imported: any): number {
            return imported == null ? -1 : imported.answer;
          }
          export function test(): number {
            return inspect(value);
          }`,
        "./module.js": `(function (global, factory) {
            typeof exports === "object" && typeof module !== "undefined"
              ? module.exports = factory()
              : global.value = factory();
          }(this, function () {
            function value(input) { return input + 1; }
            value.answer = 42;
            return value;
          }));`,
      }),
    ).toBe(42);
  });
});
