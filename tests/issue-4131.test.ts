// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#4131) Annex B B.3.3.1 step 3.f — a block/`if`/`case`-nested sloppy-mode
 * `function F` must WRITE the function object into the var-scoped binding for
 * `F` when the declaration is evaluated, including when that binding already
 * exists (`var f = 123` in the same function).
 *
 * The compiler only ever modelled the "CREATE a new web-compat binding" half
 * (`annexBBlockNestedEligible`, #2200 Phase 2), which bails outright when the
 * name already has a local. The `annexB/language/*-existing-var-update` family
 * therefore read the var's own value instead of the function.
 *
 * The five `annexB/language/function-code/if-decl-*-func-existing-var-update.js`
 * files nevertheless PASSED, by accident: their wrapper is an IIFE, the IIFE
 * inline path did NOT hoist `var` declarations, so at `after = f` no local named
 * `f` existed yet and identifier resolution fell through to the cached
 * function-closure singleton. Any change that makes the IIFE body hoist its vars
 * — as a real FunctionDeclarationInstantiation must — flips those five from
 * `pass` to a **null dereference**: `f` resolves to the uninitialised f64 slot,
 * `__box_number(0)` lands in `after`, and the call dispatch does `struct.get` on
 * a null cast result.
 *
 * These tests pin the SEMANTICS, not the accident: they use a NAMED wrapper
 * function (not an IIFE), which does hoist its vars, so they exercise the real
 * B.3.3.1 step 3 path and fail on a compiler that lacks the write-back.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runJs(source: string): Promise<unknown[]> {
  const out: unknown[] = [];
  const result = await compile(source, {
    allowJs: true,
    fileName: "/issue-4131.js",
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

describe("#4131 Annex B B.3.3.1 step 3 — update an EXISTING var binding", () => {
  it("if-clause declaration writes the function object into the existing var", async () => {
    const out = await runJs(`
      var after;
      function wrap() {
        if (true) function f() { return 'fd'; }
        after = f;
        var f = 123;
      }
      wrap();
      console.log(typeof after);
    `);
    expect(out).toEqual(["function"]);
  });

  it("if/else declaration in the else clause behaves the same", async () => {
    const out = await runJs(`
      var after;
      function wrap() {
        if (false) ; else function f() { return 'fd'; }
        after = f;
        var f = 123;
      }
      wrap();
      console.log(typeof after);
    `);
    expect(out).toEqual(["function"]);
  });

  it("a var with NO Annex B declaration keeps its numeric carrier", async () => {
    // Negative control for the carrier widening in mixed-assignment-carrier.ts:
    // the widening must fire ONLY for names an Annex B declaration writes back.
    const out = await runJs(`
      var after;
      function wrap() {
        var f = 123;
        after = f;
      }
      wrap();
      console.log(typeof after);
    `);
    expect(out).toEqual(["number"]);
  });

  it("a skipped if-clause leaves the existing var binding untouched", async () => {
    const out = await runJs(`
      var after;
      function wrap() {
        if (false) function f() { return 'fd'; }
        var f = 7;
        after = f;
      }
      wrap();
      console.log(typeof after);
    `);
    expect(out).toEqual(["number"]);
  });
});
