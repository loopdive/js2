// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6725 (jest mechanism of #6666) — a CommonJS `require("Y")` nested in a
// function body was never linked under `--target standalone`: only top-level
// `const X = require("Y")` enters the compileProject graph, so the lazy-getter
// shape every Babel/webpack build emits (jest's `build/index.js`) called an
// unbound `require` and threw `ReferenceError: require is not defined` at
// module init. The resolver now links such an edge statically.
//
// Also pins the #6666 diagnosability half: a standalone module whose only
// throws are compiler-synthesized still publishes a (lite) `__exn_render_*`
// pair, so the payload renders instead of "non-stringifiable payload".
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderHarnessThrownText } from "../scripts/lib/wasm-exn-render.mjs";
import { hoistStandaloneNestedRequires } from "../src/cjs-standalone-nested-require.ts";
import { compile, compileProject } from "../src/index.ts";

let dir = "";

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "issue-6725-"));
  writeFileSync(join(dir, "dep.js"), "exports.value = 7;\n");
  // jest's `build/index.js` shape: a webpack IIFE with a local `exports`, a
  // getter re-export, and a lazy getter that re-binds itself after its first
  // call (the #6666 repro, minus its unwrapped `exports` reference).
  writeFileSync(
    join(dir, "lib.js"),
    [
      '"use strict";',
      "var __webpack_exports__ = {};",
      "(() => {",
      "var exports = __webpack_exports__;",
      'Object.defineProperty(exports, "value", { enumerable: true, get: function () { return _dep().value; } });',
      'function _dep() { const data = require("./dep.js"); _dep = function () { return data; }; return data; }',
      "})();",
      "module.exports = __webpack_exports__;",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "entry.mjs"),
    'import lib from "./lib.js";\n/** @param {number} n @returns {number} */\nexport function probe(n) { return lib.value + n; }\n',
  );
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe("#6725 standalone function-nested require is linked", () => {
  it("the jest-shaped lazy getter (#6666 repro) returns 8", async () => {
    const result = await compileProject(join(dir, "entry.mjs"), {
      allowJs: true,
      skipSemanticDiagnostics: true,
      deferTopLevelInit: true,
      target: "standalone",
    });
    expect(result.success, JSON.stringify(result.errors?.slice(0, 3))).toBe(true);
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    const exports = instance.exports as Record<string, (n?: number) => unknown>;
    let value: unknown;
    try {
      exports.__module_init?.();
      value = exports.probe!(1);
    } catch (error) {
      value = renderHarnessThrownText(error, instance);
    }
    expect(value).toBe(8);
  });
});

describe("#6725 hoistStandaloneNestedRequires", () => {
  const resolvable = () => true;
  const nested = 'function f() {\n  return require("./dep.js").value;\n}\n';

  it("keeps every position and appends the linking declaration", () => {
    const out = hoistStandaloneNestedRequires(nested, resolvable);
    expect(out.slice(0, nested.length).length).toBe(nested.length);
    expect(out.slice(0, nested.length).split("\n").length).toBe(nested.split("\n").length);
    expect(out.slice(0, nested.length)).toContain("return __cjs_nreq0");
    expect(out.slice(nested.length)).toBe('\nconst __cjs_nreq0 = require("./dep.js");\n');
  });

  it("leaves shapes it cannot prove safe untouched", () => {
    const unchanged = [
      // top level: owned by rewriteCjsRequire / the #6663 fold
      'const d = require("./dep.js");\n',
      // optional-dependency idiom
      'function f() { try { return require("./dep.js"); } catch { return null; } }\n',
      // a Node builtin
      'function f() { return require("fs"); }\n',
      // the file owns `require`
      'define(function (require) { return function () { return require("./dep.js"); }; });\n',
      // a dynamic specifier
      "function f(n) { return require(n); }\n",
    ];
    for (const source of unchanged) expect(hoistStandaloneNestedRequires(source, resolvable)).toBe(source);
    // an unresolvable specifier stays lazy
    expect(hoistStandaloneNestedRequires(nested, () => false)).toBe(nested);
  });
});

describe("#6666 compiler-synthesized throws render without a source throw", () => {
  it("a null-guard TypeError renders through the lite renderer", async () => {
    const result = await compile("export function run(o: any): number { return o.x.y; }", {
      fileName: "issue-6666-render.ts",
      target: "standalone",
      hostBridge: "off",
      optimize: 3,
    });
    expect(result.success).toBe(true);
    const { instance } = await WebAssembly.instantiate(result.binary as Uint8Array, {});
    let rendered = "";
    try {
      (instance.exports.run as (o: unknown) => unknown)(null);
    } catch (error) {
      rendered = renderHarnessThrownText(error, instance);
    }
    expect(rendered).toMatch(/^TypeError: /);
    expect(rendered).not.toContain("non-stringifiable payload");
  });
});
