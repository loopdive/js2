// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 A2c — the IR lowers a global-scope eval statement through the one
// global-eval arm (`exactGlobalEvalStatement` → `globalEvalRoute`) exactly when
// legacy would hand it to the runtime-eval provider: a literal indirect eval, or
// a sloppy direct eval at script global, whose Script parses, raises no static
// SyntaxError and declares a global var. Any other literal may fold at compile
// time, so the module init holding it stays direct and no runtime call appears.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";

const SUPPORT = "__runtime_eval_global_call_indirect_eval";

async function moduleInit(source: string) {
  const result = await compile(source, {
    target: "standalone",
    trackIrOutcomes: true,
    fileName: "test.js",
    allowJs: true,
    emitWat: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.irPostClaimErrors ?? []).toEqual([]);
  const outcome = (result.irOutcomes ?? []).find((entry) => (entry.displayName ?? entry.name) === "<module-init>");
  return { claimed: outcome?.irBodyEmitted === true, detail: String(outcome?.detail ?? ""), wat: result.wat };
}

describe("#7106 A2c — global-scope eval statements in the IR", () => {
  it.each([
    ["an indirect eval declaring a var", 'var f = 1;\n(0, eval)("var f = 5");\n'],
    ["an indirect eval declaring a function", 'var g;\n(0, eval)("function g() { return 7; }");\n'],
    ["a sloppy direct eval at script global", 'var y;\neval("var y = 2");\n'],
  ])("claims the module init holding %s and calls the support function", async (_, source) => {
    const init = await moduleInit(source);
    expect(init.claimed, init.detail).toBe(true);
    expect(init.wat).toContain(`call $${SUPPORT}`);
  });

  it.each([
    // No declaration: the Script may fold, so the IR must not turn it into a runtime call.
    ["a literal that only assigns", 'var x = 1;\n(0, eval)("x = 2");\n'],
    // Static SyntaxErrors: legacy throws them without running the provider.
    ["a source that does not parse", 'var a;\n(0, eval)("var a b");\n'],
    ["a var colliding with a global lexical", 'let q = 1;\n(0, eval)("var q = 2");\n'],
    // Not a global variable environment for a direct eval.
    ["a direct eval inside a block", 'var w;\n{\n  eval("var w = 1");\n}\n'],
    ["a direct eval in a strict script", '"use strict";\nvar s;\neval("var s = 1");\n'],
    // Not a literal: the site has no recorded source.
    ["a computed source", 'var src = "var c = 1";\nvar c;\n(0, eval)(src);\n'],
  ])("keeps the module init direct for %s", async (_, source) => {
    const init = await moduleInit(source);
    expect(init.claimed).toBe(false);
  });

  it("folds a literal that only assigns, with no runtime call", async () => {
    const init = await moduleInit('var x = 1;\n(0, eval)("x = 2");\n');
    expect(init.wat).not.toContain(`call $${SUPPORT}`);
  });
});
