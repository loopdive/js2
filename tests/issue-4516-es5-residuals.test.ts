// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Focused coverage for the final ES5 standalone residual cluster. The exact
// rows pin the externally visible fixes; the small controls exercise the
// conservative declines around the new native paths.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

const TEST262_ROOT = "test262";
const TEST262 = join(TEST262_ROOT, "test");
const TEST262_READY = existsSync(join(TEST262_ROOT, "harness", "assert.js"));

const EXACT_ROWS = [
  "language/statements/with/S12.10_A1.5_T1.js",
  "language/statements/function/S13.2.2_A11.js",
  "built-ins/Object/S9.9_A6.js",
  "built-ins/Function/15.3.5.4_2-95gs.js",
  "annexB/language/eval-code/direct/func-switch-case-eval-func-init.js",
  "annexB/language/eval-code/direct/func-switch-case-eval-func-existing-var-no-init.js",
] as const;

async function runStandaloneModule(source: string): Promise<Record<string, any>> {
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-4516-es5-residuals.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports.map((entry) => `${entry.module}::${entry.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return instance.exports as Record<string, any>;
}

async function runStandaloneScript(source: string): Promise<void> {
  const result = await compile(source, {
    allowJs: true,
    deferTopLevelInit: true,
    fileName: "issue-4516-es5-residuals-script.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports.map((entry) => `${entry.module}::${entry.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  (instance.exports as { __module_init: () => void }).__module_init();
}

describe.skipIf(!TEST262_READY)("ES5 standalone residual cluster", () => {
  it.each(EXACT_ROWS)("passes the exact residual row %s", async (file) => {
    const result = await runTest262File(join(TEST262, file), "issue-4516-es5-residuals", 120_000, "standalone");
    expect(result.status, `${file}: ${result.reason ?? result.error ?? ""}`).toBe("pass");
  });

  it("keeps a closed object for-in on its static path", async () => {
    await runStandaloneScript(`
      var obj = { first: 1, second: 2 };
      var count = 0;
      for (var key in obj) { count = count + 1; }
      if (count !== 2) throw new Error("closed for-in count: " + count);
    `);
  });

  it("keeps a callable fnctor member working beside the missing-call guard", async () => {
    const exports = await runStandaloneModule(`
      function Factory() {
        this.run = function () { return 7; };
      }
      var instance = new Factory();
      export function test() { return instance.run() === 7 ? 1 : 0; }
    `);
    expect(exports.test()).toBe(1);
  });

  it("declines the synthetic Function self-binding proof after reassignment", async () => {
    const exports = await runStandaloneModule(`
      var generated = Function("return 7;");
      generated = function () { return 9; };
      export function test() { return generated(); }
    `);
    expect(exports.test()).toBe(9);
  });

  it("keeps primitive Object coercion on the wrapper path", async () => {
    const exports = await runStandaloneModule(`
      export function test() {
        return Object(3).constructor === Number && Object(true).constructor === Boolean ? 1 : 0;
      }
    `);
    expect(exports.test()).toBe(1);
  });
});
