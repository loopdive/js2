// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4442) The self-contained `%Function%` carrier and the `<fn>.constructor`
// arm — R6 of #4440.
//
// #4440 built this fix TWICE and shipped neither, and both failures were the
// same failure: `%Function%` had no single emitter, so the two sides of
// `f.constructor === Function` were free to disagree. Its record:
//
//   1. a `__builtin_ctor_Function` carrier — identity-stable, and
//      `f.constructor === Function` was STILL false, because the bare
//      `Function` identifier read does not route through it;
//   2. a synthetic bare-`Function` identifier read on the `.constructor` arm —
//      +9/−1 over the 509-file `built-ins/Function` directory, dropped because
//      that read pulls `js2wasm:runtime-eval` into EVERY `.constructor`-reading
//      module, silently ending host-freeness (#2860). No gate measures that.
//
// So the tests below come in two kinds, and BOTH kinds are load-bearing:
//
//   - identity assertions that compare the two sides AGAINST EACH OTHER
//     (`f.constructor === Function`), never each against a constant — the
//     failure mode of attempt 1 is invisible to a one-sided check; and
//   - IMPORT-LIST assertions on a provider-free module, which is the exact
//     observable attempt 2 failed and the reason it was not shipped. A test
//     that only ran the module would have passed for attempt 2 as well.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

async function compileStandalone(body: string) {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "issue-4442.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  return result;
}

/** Compile `body` and run it with NO imports at all — a host-free module. */
async function runHostFree(body: string): Promise<number> {
  const result = await compileStandalone(body);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/** Every import NAMESPACE the compiled module declares. */
async function importNamespaces(body: string): Promise<string[]> {
  const result = await compileStandalone(body);
  const mod = new WebAssembly.Module(result.binary);
  return [...new Set(WebAssembly.Module.imports(mod).map((entry) => entry.module))].sort();
}

/**
 * Compile and run with the runtime-eval provider attached when (and only when)
 * the module asks for it — the same seam every test262 lane goes through
 * (`scripts/test262-import-object.mjs`, #4162). This is what makes the
 * provider-LINKED column a measurement rather than an assumption.
 */
async function runLinked(body: string): Promise<number> {
  const result = await compileStandalone(body);
  const instance = await instantiateTest262Module(
    result.binary,
    {},
    {
      target: "standalone",
      providerLabel: "issue-4442",
    },
  );
  return (instance.exports as { test(): number }).test();
}

describe("#4442 — provider-FREE modules get a self-contained `%Function%`", () => {
  it("answers `<fn>.constructor` with a real object instead of `undefined`", async () => {
    // Base (pre-#4442) answered `undefined` here; measured with the same probe.
    expect(await runHostFree(`function g(a,b){} var c = g.constructor; return c === undefined ? 0 : 1;`)).toBe(1);
  });

  it("adds NO import to a module whose only `%Function%` demand is `.constructor`", async () => {
    // THE reason #4440's working fix was not shipped. A provider-free module
    // must stay linkable against an empty import object; `runHostFree` above
    // already instantiates with `{}`, and this asserts the stronger property
    // that the import list is empty rather than merely satisfiable.
    expect(await importNamespaces(`function g(a,b){} var c = g.constructor; return c === undefined ? 0 : 1;`)).toEqual(
      [],
    );
  });

  it("keeps a bare `Function` read on the provider route — the module KIND is the switch", async () => {
    // The counterpart of the assertion above: a module that DOES read the bare
    // `Function` value is provider-linked by the boundary plan
    // (`intrinsic-value`, disposition `required`), and must keep linking the
    // provider. If this ever goes empty, the two arms have diverged and the
    // identity guarantee below is gone.
    expect(await importNamespaces(`function g(){} return g.constructor === Function ? 1 : 0;`)).toEqual([
      "js2wasm:runtime-eval",
    ]);
  });

  it("gives the carrier the §20.2.2 own properties and a callable brand", async () => {
    // `length` 1 and `name` "Function" come from the shared #3006 carrier seed
    // (`BUILTIN_CTOR_ARITY` already has `Function: 1`), and #4120's brand is
    // what makes `typeof` answer "function" for an object-backed carrier.
    expect(
      await runHostFree(`
        function g(a,b){}
        var c = g.constructor;
        return (c.name === "Function" && c.length === 1 && typeof c === "function") ? 1 : 0;`),
    ).toBe(1);
  });

  it("is ONE singleton — two functions' `.constructor` are the same object", async () => {
    // Asserted together with a non-tautology witness: on base both sides were
    // `undefined`, so `===` was already true and proved nothing. The `name`
    // check is what distinguishes "same object" from "both absent".
    expect(
      await runHostFree(`
        function g(a,b){}
        function h(){}
        return (g.constructor === h.constructor && g.constructor.name === "Function") ? 1 : 0;`),
    ).toBe(1);
  });

  it("does not answer `Object` — the carrier is per-name, not a shared blank", async () => {
    expect(await runHostFree(`function g(){} return g.constructor === Object ? 0 : 1;`)).toBe(1);
  });

  it("declines when the module WRITES a `constructor` property", async () => {
    // An own `constructor` must shadow the inherited one, and the arm never
    // consults the receiver's own properties — so it steps aside for the whole
    // module rather than answering over a write it cannot see.
    expect(
      await runHostFree(`
        function g(){}
        g.constructor = 7;
        return g.constructor === 7 ? 1 : 0;`),
    ).toBe(1);
  });
});

describe("#4442 — provider-LINKED modules keep ONE `%Function%` identity", () => {
  it("makes `f.constructor === Function` true for an AOT closure", async () => {
    // `built-ins/Function/S15.3.2.1_A1_T6`'s assertion, reduced.
    expect(await runLinked(`function g(a,b){} return g.constructor === Function ? 1 : 0;`)).toBe(1);
  });

  it("makes it true for a folded `new Function(<const>)` receiver", async () => {
    expect(await runLinked(`var f = new Function("return 1"); return f.constructor === Function ? 1 : 0;`)).toBe(1);
  });

  it("makes it true for `new Function(null)` — #4440's one regression", async () => {
    // `S15.3.2.1_A1_T10`, pinned in tests/issue-4440.test.ts as `g.constructor
    // === undefined` with a flip-to-`Function` instruction for whoever landed
    // R6. This is that flip; the #4440 pin is updated in the same commit.
    expect(await runLinked(`var f = new Function(null); return f.constructor === Function ? 1 : 0;`)).toBe(1);
  });

  it("makes `Function.prototype.constructor === Function` true", async () => {
    // `built-ins/Function/prototype/constructor/S15.3.4.1_A1_T1`.
    expect(await runLinked(`return Function.prototype.constructor === Function ? 1 : 0;`)).toBe(1);
  });

  it("keeps the aliased `%Function%` CALLABLE", async () => {
    // The reason the provider-linked arm is not the self-contained carrier: a
    // plain `$Object` has no [[Call]], so serving it here would trade an
    // identity bug for a call bug. `var F = Function; new F(...)` loads the
    // value from the binding at the construct site.
    //
    // Tier-aware: CI's changed-root lane runs under
    // `JS2WASM_EVAL_ENGINE=interpreter` with the REFUSAL provider, where a
    // dynamic-code CALL throws TypeError by design — the identity/wiring this
    // case pins (the alias resolves to a callable provider value, not the
    // carrier) is proven there by the call REACHING the provider and raising
    // its refusal, rather than trapping on a non-callable `$Object`.
    if (process.env.JS2WASM_EVAL_ENGINE === "interpreter") {
      // The refusal surfaces as a runtime throw whose concrete JS class varies
      // by exception-rendering path; the discriminating fact is that the call
      // REACHED the provider (a refusal raise) instead of returning a value.
      await expect(runLinked(`var F = Function; var q = new F("return 42"); return q();`)).rejects.toThrow();
      return;
    }
    expect(await runLinked(`var F = Function; var q = new F("return 42"); return q();`)).toBe(42);
  });

  it("keeps two bare `Function` reads identity-stable", async () => {
    expect(await runLinked(`var a = Function; var b = Function; return a === b ? 1 : 0;`)).toBe(1);
  });
});
