// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4642) Falling off the end of a LIFTED function body completed with `null`,
// not `undefined`.
//
// The issue arrived framed as "a provider-minted function's implicit completion
// value crosses as null" (`Function("")() === null`), with a leading hypothesis
// that the runtime-eval provider's result envelope encoded it wrongly. That
// hypothesis is FALSE, and the measurement that killed it is the first pin
// below: make the body string UNFOLDABLE (loop-carried, so `resolveConstantString`
// declines) and the same expression already answered `undefined` on base. Only
// the CONSTANT-body form was wrong — and a constant-body `Function(...)` never
// reaches the provider at all: #2924's `tryStaticNewFunction` synthesizes it
// into a lifted function declaration and compiles it AOT.
//
// Root cause, therefore, is one line of ordinary codegen:
// `appendDefaultReturn` (src/codegen/statements/nested-declarations.ts), the
// tail every LIFTED function declaration gets when its body does not end in a
// `return`, pushed a bare `ref.null.extern` for an `externref` return type.
// Under the standalone value model that IS JS `null` (#2864 — the tag-1
// `$undefined` singleton is reserved in every standalone module and
// `undefined === null` is false there). The top-level tail in
// `function-body.ts` had already been routed through `emitUndefined`; this
// lifted tail was the straggler.
//
// A/B measured with the file-copy revert of exactly that one file:
//
//   | probe                                            | base | fixed |
//   | ------------------------------------------------ | ---- | ----- |
//   | `Function("")()`                                  | null | undefined |
//   | `Function("return;")()`                           | undefined | undefined |
//   | `Function("var x = 1;")()`                        | null | undefined |
//   | `new Function("")()`                              | null | undefined |
//   | nested `function nd(a){ if (a) return {}; } nd(0)`| null | undefined |
//   | `for (…) Function(bodies[i])()` (unfoldable)      | undefined | undefined |
//
// Every pin here is HOST-FREE by construction (asserted below): the modules
// carry no `js2wasm:runtime-eval` import, so they are tier-independent and run
// identically under `JS2WASM_EVAL_ENGINE=interpreter` with the refusal
// provider. That is a property of the fix, not a convenience — it is the same
// fact that proves the provider was never involved.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";

async function compileStandalone(body: string) {
  const result = await compile(`export function test(): number { ${body} }`, {
    allowJs: true,
    fileName: "issue-4642.ts",
    skipSemanticDiagnostics: true,
    target: "standalone",
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  return result;
}

/** Compile `body` as `test()` and run it with NO imports at all. */
async function runHostFree(body: string): Promise<number> {
  const result = await compileStandalone(body);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test(): number }).test();
}

/** Compile `body` as `test()` and run it with the runtime-eval provider attached. */
async function runLinked(body: string): Promise<number> {
  const result = await compileStandalone(body);
  const instance = await instantiateTest262Module(result.binary, {}, { target: "standalone", providerLabel: "#4642" });
  return (instance.exports as { test(): number }).test();
}

/**
 * CI's changed-root lane runs `JS2WASM_EVAL_ENGINE=interpreter` with the
 * REFUSAL provider, where a DYNAMIC-body mint throws out of the module by
 * design. Under that tier the unfoldable arm below asserts the observable that
 * survives — the mint REACHES the provider and its refusal escapes. Same tier
 * seam as tests/issue-4442.test.ts / tests/issue-4464.test.ts.
 */
const REFUSAL_TIER = process.env.JS2WASM_EVAL_ENGINE === "interpreter";

/** Every import NAMESPACE the compiled module declares. */
async function importNamespaces(body: string): Promise<string[]> {
  const result = await compileStandalone(body);
  const mod = new WebAssembly.Module(result.binary);
  return [...new Set(WebAssembly.Module.imports(mod).map((entry) => entry.module))].sort();
}

/**
 * 1 = `undefined`, 2 = `null`, 3 = a number, 4 = anything else. Classifying
 * rather than asserting `=== undefined` keeps a regression legible: the whole
 * bug was `undefined` degrading into `null`, and both are falsy.
 */
const TAG = `function __tag(v) {
  if (typeof v === "undefined") return 1;
  if (v === null) return 2;
  if (typeof v === "number") return 3;
  return 4;
}`;

describe("#4642 — a lifted function that falls off its end completes with `undefined`", () => {
  it("answers `undefined` for a constant-body `Function(...)` product (the reported repro)", async () => {
    // Base: 2 (null). This is `Function("")()` from the issue title.
    expect(await runHostFree(`${TAG} return __tag(Function("")());`)).toBe(1);
  });

  it("keeps the whole reported string round-trip", async () => {
    // The issue's one-liner: `String(h()) + "|" + String(g())`, base
    // "undefined|null", spec "undefined|undefined".
    expect(
      await runHostFree(`
        function h(){}
        var g = Function("");
        var s = String(h()) + "|" + String(g());
        if (s === "undefined|undefined") return 1;
        if (s === "undefined|null") return 2;
        return 9;
      `),
    ).toBe(1);
  });

  it("answers `undefined` for every constant-body shape that falls off the end", async () => {
    // Base digits were 2,1,2,2,2,2 — only the EXPLICIT `return;` was right,
    // which is exactly why the defect read as an "implicit completion" bug.
    expect(
      await runHostFree(`${TAG}
        var code = 0;
        code = code * 10 + __tag(Function("")());
        code = code * 10 + __tag(Function("return;")());
        code = code * 10 + __tag(Function("var x = 1;")());
        code = code * 10 + __tag(Function("1+2;")());
        code = code * 10 + __tag(new Function("")());
        code = code * 10 + __tag(Function("a", "")(5));
        return code;
      `),
    ).toBe(111111);
  });

  it("answers `undefined` for a NESTED function declaration that falls off its end", async () => {
    // The general defect behind the Function(...) symptom — no `Function`
    // anywhere. Base: 2 (null). `{}` forces the externref return slot; the
    // `if (a)` keeps the fall-off reachable so nothing folds it away.
    expect(await runHostFree(`${TAG} function nd(a) { if (a) return {}; } return __tag(nd(0));`)).toBe(1);
  });

  it("still answers `undefined` for an UNFOLDABLE body string (the control that killed the provider hypothesis)", async () => {
    // Loop-carried body strings decline `resolveConstantString`, so these DO
    // reach the provider — and they already answered `undefined` on BASE. That
    // is the measurement that ruled the provider envelope out: had the envelope
    // been the defect, this arm would have failed on base too.
    const probe = `${TAG}
      var code = 0;
      var bodies = ["", "return undefined;", "return null;", "return 7;"];
      for (var i = 0; i < 4; i++) code = code * 10 + __tag(Function(bodies[i])());
      return code;
    `;
    if (REFUSAL_TIER) {
      let threw = false;
      try {
        await runLinked(probe);
      } catch {
        threw = true;
      }
      expect(threw, "refusal-tier: a dynamic-body mint must throw out of the module").toBe(true);
      return;
    }
    // 1 = undefined, 1 = undefined, 2 = null, 3 = number.
    expect(await runLinked(probe)).toBe(1123);
  });

  it("adds NO runtime-eval import for a constant-body `Function(...)` — the fold is AOT", async () => {
    // Load-bearing: this is what makes every pin above tier-independent, and
    // it is the evidence that the constant-body path never consults the
    // provider. If a future change routes it through the provider instead,
    // this pin fails FIRST and the tier arms above must be added back.
    expect(await importNamespaces(`return Function("")() === undefined ? 1 : 0;`)).not.toContain(
      "js2wasm:runtime-eval",
    );
  });
});
