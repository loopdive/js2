// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { RUNTIME_EVAL_IMPORT_MODULE } from "../scripts/runtime-eval-provider.mjs";
import { runTest262File } from "./test262-runner.js";

const TEST262 = existsSync(join(__dirname, "..", "test262", "harness", "assert.js"));
const OPTIONS = {
  target: "standalone",
  experimentalIR: false,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
} as const;

afterEach(async () => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
});

async function runtimeEvalImports(source: string): Promise<string[]> {
  const result = await compile(source, { ...OPTIONS, fileName: "issue-1240.ts" });
  if (!result.success || !result.binary) throw new Error(JSON.stringify((result.errors ?? []).slice(0, 5)));
  return WebAssembly.Module.imports(new WebAssembly.Module(result.binary))
    .filter((entry) => entry.module === RUNTIME_EVAL_IMPORT_MODULE)
    .map((entry) => entry.name);
}

describe.skipIf(!TEST262)("#1240 — exhaustive ES5 comment eval loops", () => {
  for (const row of ["language/comments/S7.4_A5.js", "language/comments/S7.4_A6.js"]) {
    it(row, { timeout: 60_000 }, async () => {
      const result = await runTest262File(
        join(__dirname, "..", "test262", "test", row),
        "issue-1240",
        30_000,
        "standalone",
      );
      expect(`${result.status}: ${result.error ?? ""}`).toBe("pass: ");
    });
  }

  it("removes the provider boundary for the proven one-code-unit multiline shape", async () => {
    const imports = await runtimeEvalImports(`
      for (var i = 0; i < 2; i++) eval("/*var " + String.fromCharCode(i) + "xx = 1*/");
    `);
    expect(imports).toEqual([]);
  });

  it("declines when String.fromCharCode is reassigned", async () => {
    const imports = await runtimeEvalImports(`
      String.fromCharCode = function () { return "*/yy = 7;/*"; };
      var yy = 0;
      eval("/*var " + String.fromCharCode(1) + "xx = 1*/");
    `);
    expect(imports.length).toBeGreaterThan(0);
  });

  it("declines when String is a local shadow", async () => {
    const imports = await runtimeEvalImports(`
      function f() {
        var String = { fromCharCode: function () { return "x"; } };
        return eval("/*var " + String.fromCharCode(1) + "xx = 1*/");
      }
      f();
    `);
    expect(imports.length).toBeGreaterThan(0);
  });

  it("declines when the one-code-unit binding is reassigned", async () => {
    const imports = await runtimeEvalImports(`
      var xx = String.fromCharCode(1);
      xx = "\\nyy = 7;";
      var yy = 0;
      eval("//var " + xx + "yy = -1");
    `);
    expect(imports.length).toBeGreaterThan(0);
  });
});
