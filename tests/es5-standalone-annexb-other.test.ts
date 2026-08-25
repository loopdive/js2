// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Focused standalone coverage for the five-file Annex B "other" wave:
 * legacy for-in initializers, catch/var scope restoration, and dynamic
 * undefined arguments reaching String.prototype.substr.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runScript(body: string): Promise<number> {
  const source = `${body}\nexport function test(): number { return result; }\n`;
  const compiled = await compile(source, {
    allowJs: true,
    fileName: "es5-standalone-annexb-other.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
    deferTopLevelInit: true,
    inferModuleStrictArguments: false,
  });
  expect(compiled.success, compiled.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(compiled.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(compiled.binary, {});
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  return (instance.exports as { test: () => number }).test();
}

describe("ES5 Annex B standalone other bucket", () => {
  it("runs the legacy for-in initializer before the receiver", async () => {
    const result = await runScript(`
      var effects = 0, stored;
      for (var key = (++effects, -1) in stored = key, { a: 0, b: 1, c: 2 }) {}
      var result = effects === 1 && stored === -1 ? 1 : 0;
    `);
    expect(result).toBe(1);
  });

  it("restores an outer var after a catch parameter redeclaration", async () => {
    const result = await runScript(`
      foo = "prior to throw";
      try { throw new Error(); } catch (foo) { var foo = "initializer in catch"; }
      var result = foo === "prior to throw" ? 1 : 0;
    `);
    expect(result).toBe(1);
  });

  it("keeps a closure on the restored outer catch binding", async () => {
    const result = await runScript(`
      function capturedFoo() { return foo; }
      foo = "prior to throw";
      try { throw new Error(); } catch (foo) { var foo = "initializer in catch"; }
      var result = capturedFoo() === "prior to throw" ? 1 : 0;
    `);
    expect(result).toBe(1);
  });

  it("distinguishes dynamic undefined from explicit NaN in substr length", async () => {
    const result = await runScript(`
      var result = 0;
      for (var length of [0, undefined]) {
        if (length === undefined) result = "abc".substr(1, length).length;
      }
      result = result === 2 && "abc".substr(1, NaN).length === 0 ? 1 : 0;
    `);
    expect(result).toBe(1);
  });
});
