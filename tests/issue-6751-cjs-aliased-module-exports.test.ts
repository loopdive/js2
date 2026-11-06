// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6751 — lodash's CJS export goes through an alias of `module`:
//
//     var freeModule = freeExports && typeof module == 'object' && module;
//     (freeModule.exports = _)._ = _;
//
// The CJS rewrite only redirected the literal `module.exports` spelling to the
// default-export cell, so the aliased write landed on a throwaway `module`
// object and a standalone default import saw the empty `exports` object
// (`pkg.words(...)` → "called value is not a function").

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { rewriteCjsRequire } from "../src/cjs-rewrite.js";
import { compileProject } from "../src/index.js";

const TMP = resolve(dirname(fileURLToPath(import.meta.url)), "../.tmp/issue-6751-cjs-aliased-module-exports");

const ALIASED_LIB = `;(function() {
  var freeExports = typeof exports == 'object' && exports && !exports.nodeType && exports;
  var freeModule = freeExports && typeof module == 'object' && module && !module.nodeType && module;
  function lodash(v) { return v; }
  lodash.words = function (s) { return s.split(' '); };
  var _ = lodash;
  if (freeModule) { (freeModule.exports = _)._ = _; freeExports._ = _; }
}.call(this));
`;

// Control: the same library exporting through the literal spelling, which the
// rewrite already handled before the fix.
const DIRECT_LIB = `;(function() {
  function lodash(v) { return v; }
  lodash.words = function (s) { return s.split(' '); };
  lodash._ = lodash;
  module.exports = lodash;
}.call(this));
`;

const ENTRY = `import pkg from "./lib.js";
export function words() { return pkg.words("a b c").length; }
export function kind() { return typeof pkg === "function" ? 1 : 0; }
export function selfAlias() { return pkg._ === pkg ? 1 : 0; }
`;

async function runStandalone(name: string, lib: string): Promise<Record<string, number>> {
  const dir = join(TMP, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "lib.js"), lib);
  writeFileSync(join(dir, "entry.mjs"), ENTRY);
  const result = await compileProject(join(dir, "entry.mjs"), {
    allowJs: true,
    skipSemanticDiagnostics: true,
    target: "standalone",
    runtimeEvalProvider: false,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module)).toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  const exports = instance.exports as Record<string, () => number>;
  return { words: exports.words!(), kind: exports.kind!(), selfAlias: exports.selfAlias!() };
}

describe("#6751 — CJS export written through an alias of `module`", () => {
  it("standalone default import observes `freeModule.exports = _`", async () => {
    expect(await runStandalone("aliased", ALIASED_LIB)).toEqual({ words: 3, kind: 1, selfAlias: 1 });
  });

  it("control: the literal `module.exports = _` spelling keeps working", async () => {
    expect(await runStandalone("direct", DIRECT_LIB)).toEqual({ words: 3, kind: 1, selfAlias: 1 });
  });

  it("adopts the module object's exports slot only when `module` is aliased and the option is on", () => {
    const footer = "if (module.exports !== exports) __cjs_default_export = module.exports;";
    expect(rewriteCjsRequire(ALIASED_LIB, { aliasedModuleExports: true })).toContain(footer);
    // JS-host (option off) output is unchanged.
    expect(rewriteCjsRequire(ALIASED_LIB)).not.toContain(footer);
    expect(rewriteCjsRequire(ALIASED_LIB)).toContain("const module = {};");
    // No alias of `module`: nothing to observe, so no footer either.
    const literalOnly = "exports.a = 1;\nmodule.exports.b = 2;\n";
    expect(rewriteCjsRequire(literalOnly, { aliasedModuleExports: true })).toBe(rewriteCjsRequire(literalOnly));
  });
});
