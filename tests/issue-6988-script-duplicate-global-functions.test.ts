// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Octane mandreel (standalone): a classic Script whose only `export`s are the
 * synthetic harness entry points (`inferModuleStrictArguments: false`) may
 * declare the same top-level function twice, or a `var` and a `function` with
 * one name — §16.1.7 GlobalDeclarationInstantiation binds the LAST function
 * declaration and `var` initialisers overwrite it at run time. The early-error
 * pass treated such a file as a Module (`ts.isExternalModule` sees the
 * `export`) and rejected every pair with "Duplicate identifier". A real module
 * compile must still reject them (§16.2.1.1). Expected values are node's.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const SCRIPT = { inferModuleStrictArguments: false } as const;

async function runMain(source: string, target: Lane): Promise<number> {
  const result = await compile(source, {
    fileName: "dup-globals.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    ...(target === "standalone" ? { target: "standalone", runtimeEvalProvider: false } : {}),
    ...SCRIPT,
  });
  expect(result.success, result.errors.map((e) => e.message).join("\n")).toBe(true);
  if (target === "standalone") {
    const module = await WebAssembly.compile(result.binary);
    expect(WebAssembly.Module.imports(module)).toEqual([]);
    const instance = await WebAssembly.instantiate(module, {});
    return (instance.exports as { main: () => number }).main();
  }
  const { buildImports, instantiateWasm } = await import("../src/index.js");
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(
    result.binary,
    imports.env,
    imports.string_constants,
    imports.string_constants16,
  );
  imports.setInstance?.(instance);
  return (instance.exports as { main: () => number }).main();
}

// The var + function pair is standalone-only: on the JS-host lane a top-level
// `var` of a function's name does not yet see the hoisted function before its
// initialiser runs. (`function h(){}` + `var h = function(){}` trips the IR ABI
// seal in every lane, plain Scripts included — tracked in the issue file.)
type Lane = "standalone" | "gc";
const CASES: { name: string; expected: number; source: string; lanes?: readonly Lane[] }[] = [
  {
    name: "duplicate function declarations: the last one wins, even for earlier calls",
    expected: 33,
    source: `
      function f() { return 1; }
      var early = f();
      function f() { return 3; }
      export function main() { return early * 10 + f(); }`,
  },
  {
    name: "var initialiser overwrites a same-named function at run time",
    expected: 52,
    lanes: ["standalone"],
    source: `
      var before = typeof g === "function" ? g() : -1;
      var g = 5;
      function g() { return 2; }
      export function main() { return (typeof g === "number" ? g : -100) * 10 + before; }`,
  },
  {
    name: "duplicate declarations with different arities",
    expected: 9,
    source: `
      function add(a) { return a; }
      function add(a, b) { return a + b; }
      export function main() { return add(4, 5); }`,
  },
];

describe("Script goal: duplicate global function / var declarations (last wins)", () => {
  for (const target of ["standalone", "gc"] as const) {
    for (const c of CASES) {
      if (c.lanes && !c.lanes.includes(target)) continue;
      it(`${target}: ${c.name}`, async () => {
        expect(await runMain(c.source, target)).toBe(c.expected);
      });
    }
  }

  it("a real module (no Script-goal opt-in) still rejects duplicate top-level functions", async () => {
    const result = await compile(
      `function f() { return 1; }\nfunction f() { return 2; }\nexport function main() { return f(); }`,
      { fileName: "dup-module.ts" },
    );
    expect(result.success).toBe(false);
    expect(result.errors.map((e) => e.message).join("\n")).toMatch(/Duplicate|Duplicate function implementation/);
  });
});
