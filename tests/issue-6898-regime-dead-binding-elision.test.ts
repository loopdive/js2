// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6898 (#5385) — the native regime runs the #3418 dead-binding elision in a
// JavaScript environment too.
//
// Every test262 row is prefixed with the harness shim
// `var $262 = { evalScript: function (s) { … eval(s) … } }`. On standalone the
// elision drops it when the test never mentions `$262`; the regime kept it, so
// its direct `eval` linked `js2wasm:runtime-eval` and put the whole module into
// runtime-eval mode (eval-visible globals widened to externref, every top-level
// function a live binding). That one mode was behind the ES5 rows of #6880
// groups 1, 3, 4, 6 and 7.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const previous = process.env.JS2WASM_NATIVE_REGIME_JS;
beforeAll(() => {
  process.env.JS2WASM_NATIVE_REGIME_JS = "1";
});
afterAll(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
  else process.env.JS2WASM_NATIVE_REGIME_JS = previous;
});

const SHIM = `
var $262 = {
  global: globalThis,
  evalScript: function (sourceText) { return eval(sourceText); },
  gc: function () {},
};
`;

async function runtimeEvalImports(body: string): Promise<string[]> {
  const result = await compile(`${SHIM}\n${body}`, {
    fileName: "issue-6898.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    semanticProviders: "native-first",
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  expect(result.targetProfile?.nativeRegime).toBe(true);
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .filter((entry) => entry.module === "js2wasm:runtime-eval")
    .map((entry) => entry.name);
}

describe("#6898 regime dead-binding elision", () => {
  it("elides an unused harness-style eval shim: no runtime-eval import", async () => {
    const imports = await runtimeEvalImports(`
      var o = {};
      function f() { "use strict"; return this === o; }
      if (!f.call(o)) throw new Error("receiver");
    `);
    expect(imports).toEqual([]);
  });

  it("keeps the shim, and its runtime-eval link, when the program uses it", async () => {
    const imports = await runtimeEvalImports(`
      var r = $262.evalScript("1");
    `);
    expect(imports.length).toBeGreaterThan(0);
  });

  it("keeps a live direct eval outside the shim", async () => {
    const imports = await runtimeEvalImports(`
      var direct = function (text) { return eval(text); };
      var r = direct("1");
    `);
    expect(imports.length).toBeGreaterThan(0);
  });
});
