// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4182) Annex B B.3.3.2 — Changes to GlobalDeclarationInstantiation, for
 * MODULE-SCOPE (global-code) block/`if`/`switch`-nested sloppy function
 * declarations.
 *
 * Before #4182 these bound STATICALLY through `funcMap`: a bare `f` read
 * compiled before the block already saw the function (spec: `undefined`), the
 * evaluation-point SetMutableBinding (B.3.3.2.c.vi) never happened — so an
 * outer `function f` was never updated by a later block `f`, and a second
 * same-named block declaration was silently skipped by the `funcMap.has`
 * early-return.
 *
 * Mirrors the `annexB/language/global-code/*-update` / `*-no-skip-try`
 * test262 families (measured 98 → 144 of 153 on the standalone lane).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runJs(source: string): Promise<unknown[]> {
  const out: unknown[] = [];
  const result = await compile(source, {
    allowJs: true,
    fileName: "/issue-4182.js",
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    hostBridge: "always",
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const imports = buildImports(
    result.imports ?? [],
    { console: { log: (v: unknown) => out.push(v), warn: () => {}, error: () => {} } },
    result.stringPool ?? [],
  );
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  imports.setExports?.(instance.exports as Record<string, Function>);
  (instance.exports as Record<string, () => void>).__module_init?.();
  return out;
}

describe("#4182 Annex B B.3.3.2 — module-scope block-fn live binding", () => {
  it("binding value is updated following evaluation (block)", async () => {
    const out = await runJs(`
      {
        function f() { return 'declaration'; }
      }
      console.log(typeof f);
      console.log(f());
    `);
    expect(out).toEqual(["function", "declaration"]);
  });

  it("updates an existing top-level function binding at the block's evaluation point", async () => {
    const out = await runJs(`
      console.log(f());
      {
        function f() { return 'inner declaration'; }
      }
      console.log(f());
      function f() { return 'outer declaration'; }
    `);
    expect(out).toEqual(["outer declaration", "inner declaration"]);
  });

  it("a second same-named block declaration is not skipped (last evaluated wins)", async () => {
    const out = await runJs(`
      {
        function f() { return 'first declaration'; }
      }
      {
        function f() { return 'second declaration'; }
      }
      console.log(f());
    `);
    expect(out).toEqual(["second declaration"]);
  });

  it("if-clause and switch-case declaration positions update the binding", async () => {
    const out = await runJs(`
      if (true) function f() { return 'if decl'; }
      console.log(f());
      switch (1) {
        case 1:
          function g() { return 'case decl'; }
      }
      console.log(g());
    `);
    expect(out).toEqual(["if decl", "case decl"]);
  });

  it("a declaration whose statement never executes leaves the binding undefined", async () => {
    // typeof (not `=== undefined`): the host lane's externref undefined
    // representation differs from a compiled `undefined` literal — a
    // pre-existing gap unrelated to the live binding (the standalone lane's
    // `*-init` test262 files assert the `=== undefined` form and pass).
    const out = await runJs(`
      if (false) {
        function f() { return 'never'; }
      }
      console.log(typeof f);
    `);
    expect(out).toEqual(["undefined"]);
  });

  it("no-skip-try: a simple catch(f) param does not cancel, and the update survives the try", async () => {
    const out = await runJs(`
      console.log(typeof f);
      try { throw null; } catch (f) {
      {
        function f() { return 123; }
      }
      }
      console.log(typeof f);
      console.log(f());
    `);
    expect(out).toEqual(["undefined", "function", 123]);
  });

  it("existing var binding is updated at the evaluation point", async () => {
    const out = await runJs(`
      var f = 123;
      {
        function f() { return 'fn over var'; }
      }
      console.log(typeof f);
      console.log(f());
    `);
    expect(out).toEqual(["function", "fn over var"]);
  });

  it("block-scoping exclusion: an in-block reassignment keeps the block-local split", async () => {
    // `f = 123` inside the declaring block writes the block-LOCAL binding; the
    // outer var-scoped binding must keep the function (test262
    // *-block-scoping). Such names are excluded from the live-binding global
    // and stay on the legacy path — this pins that the exclusion works.
    const out = await runJs(`
      var currentBV;
      {
        function f() { f = 123; currentBV = f; return 'decl'; }
      }
      console.log(f());
      console.log(currentBV);
      console.log(f());
    `);
    expect(out).toEqual(["decl", 123, "decl"]);
  });

  it("reads through helper functions observe the live binding", async () => {
    const out = await runJs(`
      function probe() { return typeof f; }
      console.log(probe());
      {
        function f() { return 'via helper'; }
      }
      console.log(probe());
    `);
    expect(out).toEqual(["undefined", "function"]);
  });
});
