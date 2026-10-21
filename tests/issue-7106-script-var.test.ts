// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7106 — a SCRIPT's top-level `var` declarations are claimable in
// `<module-init>`. Every test262 body is a script, so before this every
// `var x = 1;` demoted the whole unit (`vardecl-var-kind`). Three arms:
//   - the module-init `var` gate opens for scripts (the binding resolver still
//     refuses a declaration it cannot place);
//   - a repeated `var x` is one binding — the first declaration is canonical
//     and each later one is a write (or, bare, a no-op);
//   - a `var` whose sole-home slot legacy allocated as `externref` binds as a
//     `dynamic` module binding (the IR dynamic carrier off fast mode).

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const OPTIONS = {
  fileName: "issue-7106-script-var.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  inferModuleStrictArguments: false,
  scriptGoal: true,
  deferTopLevelInit: true,
  trackIrOutcomes: true,
} as const;

const CASES: Record<string, string> = {
  unique: `var a = 1; var b = a + 1; var done = b === 2; if (!done) { throw "#1"; }`,
  redeclared: `var x = 1; if (x + 1 !== 2) { throw "#2"; } var x = 5; var x; if (x !== 5) { throw "#3"; }`,
  readByFunction: `var x = 1; function f() { return x; } var x = 2; if (f() !== 2) { throw "#4"; }`,
  heterogeneous: `var x = 1; var x = "s"; if (x !== "s") { throw "#5"; }`,
  dynamicWrites: `var o = undefined; o = 4; if (o !== 4) { throw "#6"; } o = true; if (o !== true) { throw "#7"; }`,
};

async function runModuleInit(target: "standalone" | undefined, source: string): Promise<string[]> {
  const result = await compile(source, { ...OPTIONS, ...(target ? { target } : {}) });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = target ? {} : buildImports(result.imports, {}, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  (instance.exports.__module_init as (() => void) | undefined)?.();
  return (result.irOutcomes ?? []).filter((o) => o.irBodyEmitted).map((o) => o.displayName);
}

describe("#7106 — script `var` declarations in <module-init>", () => {
  for (const target of ["standalone", undefined] as const) {
    const lane = target ?? "gc";
    for (const [name, source] of Object.entries(CASES)) {
      it(`${name} claims <module-init> and runs (${lane})`, async () => {
        expect(await runModuleInit(target, source)).toContain("<module-init>");
      });
    }
    it(`a failing check still throws from the IR body (${lane})`, async () => {
      await expect(runModuleInit(target, CASES.dynamicWrites!.replace("o !== 4", "o !== 5"))).rejects.toThrow();
    });
  }

  it("keeps a var merged with a function declaration on legacy", async () => {
    const result = await compile(`var g = 1; function g() { return 2; } if (g !== 1) { throw "#8"; }`, {
      ...OPTIONS,
      target: "standalone",
    });
    const init = (result.irOutcomes ?? []).find((o) => o.displayName === "<module-init>");
    expect(init?.irBodyEmitted).not.toBe(true);
  });
});
