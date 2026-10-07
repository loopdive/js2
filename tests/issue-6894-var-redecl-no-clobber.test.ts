// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6894 (#5385 slice) — an initializer-less top-level `var g;` is a no-op at
// its statement position (§14.3.2.1). §9.1.1.4.17 CreateGlobalVarBinding never
// resets an existing binding, so a hoisted `function g` (or an assignment that
// already ran) must survive the `var g;` statement.
//
// The `__module_init` prologue seeds every module-scope `var` slot with
// `undefined` (#4489), then the function bindings; the statement-position
// lowering of `var g;` still stored `undefined` again, clobbering the
// function. A live direct `eval` made it observable for `var g; function g`
// (the function then lives in the shared global slot instead of being called
// statically): `TypeError: called value is not a function` on the regime
// (harness/deepEqual-*.js, S13.2.1_A6_T3) and on standalone whenever the eval
// stayed reachable. `x = 5; var x;` lost the 5 on both lanes even without eval.
//
// The deepEqual-*.js rows carried a second, independent defect under a live
// eval: a function-valued property read off a top-level function returned a
// fresh runtime-eval carrier per read (identity lost, nested writes dropped);
// deepEqual-primitives.js a third: `typeof sym !== "object"` was false on the
// regime.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports } from "../src/runtime.js";

const previous = process.env.JS2WASM_NATIVE_REGIME_JS;
beforeAll(() => {
  process.env.JS2WASM_NATIVE_REGIME_JS = "1";
});
afterAll(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
  else process.env.JS2WASM_NATIVE_REGIME_JS = previous;
});

type Lane = "regime" | "standalone";

/** The eval is never executed; its provider imports only need to link. */
function stubRuntimeEval(binary: Uint8Array, imports: Record<string, any>): void {
  const stub: Record<string, () => never> = {};
  for (const entry of WebAssembly.Module.imports(new WebAssembly.Module(binary))) {
    if (entry.module !== "js2wasm:runtime-eval") continue;
    stub[entry.name] = () => {
      throw new Error(`unexpected runtime-eval call: ${entry.name}`);
    };
  }
  if (Object.keys(stub).length > 0) imports["js2wasm:runtime-eval"] = stub;
}

/** Compile a SCRIPT (the test262 shape) and run its top-level code; resolves to "ok" or the thrown error. */
async function runScript(lane: Lane, source: string): Promise<string> {
  const result = await compile(source, {
    fileName: "issue-6894.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    hostBridge: "always",
    ...(lane === "regime" ? { semanticProviders: "native-first" as const } : { target: "standalone" as const }),
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  expect(result.targetProfile?.nativeRegime).toBe(true);
  const imports = buildCompiledImports(result) as Record<string, any>;
  stubRuntimeEval(result.binary, imports);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setInstance?: (instance: WebAssembly.Instance) => void }).setInstance?.(instance);
  try {
    (instance.exports as { __module_init?: () => void }).__module_init?.();
    return "ok";
  } catch (error) {
    return error instanceof WebAssembly.Exception ? "wasm exception" : String(error);
  }
}

/** Keeps the direct eval reachable so the dead-binding elision cannot remove it. */
const LIVE_EVAL = `var ev = function (s) { return eval(s); };\nvar sink = [ev];\n`;

describe("#6894 — initializer-less top-level var does not clobber an existing binding", () => {
  for (const lane of ["regime", "standalone"] as const) {
    it(`${lane}: var g; keeps the hoisted function g under a live eval`, async () => {
      expect(
        await runScript(
          lane,
          `${LIVE_EVAL}var g;\nfunction g() { return 1; }\nif (g() !== 1) throw new Error("bad");\n`,
        ),
      ).toBe("ok");
    });

    it(`${lane}: a member set before the function's textual position survives (deepEqual shape)`, async () => {
      expect(
        await runScript(
          lane,
          `${LIVE_EVAL}var f;\nf.extra = function () { return 7; };\nfunction f() { return 1; }\n` +
            `if (f() !== 1 || f.extra() !== 7) throw new Error("bad");\n`,
        ),
      ).toBe("ok");
    });

    it(`${lane}: a function-valued property of a top-level function keeps its identity (deepEqual.js)`, async () => {
      // deepEqual.js runs `assert.deepEqual = …; assert.deepEqual._compare = …`
      // before assert.js declares `function assert`. Under a live eval the
      // function binding is the runtime-eval callable carrier, whose property
      // getter re-wrapped every callable read in a FRESH carrier, so the
      // `_compare` write landed in a throwaway bag.
      expect(
        await runScript(
          lane,
          `${LIVE_EVAL}assert.deepEqual = function (a, b) { return assert.deepEqual._compare(a, b); };\n` +
            `assert.deepEqual._compare = function (a, b) { return true; };\n` +
            `function assert(m) { if (m !== true) throw new Error("assert"); }\n` +
            `var fn = function () {};\nassert.d = fn;\n` +
            `if (assert.d !== fn || assert.d !== assert.d) throw new Error("identity");\n` +
            `assert(assert.deepEqual({}, {}));\n`,
        ),
      ).toBe("ok");
    });

    it(`${lane}: typeof of a symbol parameter is never "object" (deepEqual-primitives.js)`, async () => {
      // The regime's `__typeof_object` ends its callable ladder with the
      // boundary callable-kind arm, which returns unconditionally; the $Symbol
      // exclusion appended after it was dead code.
      expect(
        await runScript(
          lane,
          `function f(v) { if (typeof v !== "object") return "sym"; return "obj"; }\n` +
            `if (f(Symbol()) !== "sym" || f({}) !== "obj" || f(null) !== "obj") throw new Error("bad");\n`,
        ),
      ).toBe("ok");
    });

    it(`${lane}: x = 5; var x; keeps the assigned value`, async () => {
      expect(await runScript(lane, `x = 5;\nvar x;\nif (x !== 5) throw new Error("bad");\n`)).toBe("ok");
    });

    it(`${lane}: a never-assigned var still reads undefined`, async () => {
      expect(
        await runScript(
          lane,
          `${LIVE_EVAL}var u;\nif (u !== undefined || typeof u !== "undefined") throw new Error("bad");\n`,
        ),
      ).toBe("ok");
    });

    it(`${lane}: let without initializer in a loop still resets each iteration`, async () => {
      expect(
        await runScript(
          lane,
          `var seen = 0;\nfor (var i = 0; i < 2; i++) { let y; if (y !== undefined) throw new Error("bad"); y = i; seen++; }\n` +
            `if (seen !== 2) throw new Error("bad");\n`,
        ),
      ).toBe("ok");
    });
  }
});
