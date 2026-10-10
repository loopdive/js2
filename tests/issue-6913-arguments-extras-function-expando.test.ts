// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6913 — a function expression's per-source closure facts (`needsCallSiteArity
// === false`, `inlineBody`) were published on the SHARED per-signature wrapper
// struct type, so a declared function of the same signature inherited them:
// `[11].filter(callbackfn)` dropped the third argument that `arguments[2]`
// reads once ANY function in the module had an expando (every test262 harness
// assigns `assert._isSameValue = function (a, b) {…}`), and `[1, 2].map(d)`
// spliced in another function's body.

import { afterAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildCompiledImports, wrapCompiledExports } from "../src/runtime.js";

type Lane = "gc" | "standalone" | "native-first";

const previous = process.env.JS2WASM_NATIVE_REGIME_JS;
afterAll(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
  else process.env.JS2WASM_NATIVE_REGIME_JS = previous;
});

async function run(source: string, lane: Lane, fileName = "issue-6913.js"): Promise<unknown> {
  const options =
    lane === "standalone"
      ? { target: "standalone" as const }
      : lane === "native-first"
        ? { semanticProviders: "native-first" as const }
        : {};
  // The regime env flag is scoped to the native-first lane only.
  if (lane === "native-first") process.env.JS2WASM_NATIVE_REGIME_JS = "1";
  else Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
  const result = await compile(source, { fileName, ...options });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  if (lane === "standalone") {
    const { instance } = await WebAssembly.instantiate(result.binary, {});
    return (instance.exports as { test: () => unknown }).test();
  }
  const imports = buildCompiledImports(result);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setInstance?.(instance);
  return (wrapCompiledExports(result, instance) as { test: () => unknown }).test();
}

const EXPANDO = "assert._isSameValue = function (a, b) { return a === b; };";
const program = (expando: boolean, call: string) => `
function assert(m) { return m; }
${expando ? EXPANDO : ""}
function callbackfn(val, idx) { return val > 10 && arguments[2][idx] === val; }
var result = ${call};
export function test() { return result; }
`;

describe("#6913 arguments beyond the formals with a function expando in the module", () => {
  for (const lane of ["standalone", "native-first", "gc"] as const) {
    it(`filter callback sees arguments[2] (${lane})`, async () => {
      expect(await run(program(true, "[11].filter(callbackfn).length"), lane)).toBe(1);
      expect(await run(program(false, "[11].filter(callbackfn).length"), lane)).toBe(1);
    });

    it(`map callback sees arguments[2] (${lane})`, async () => {
      expect(await run(program(true, "[11].map(callbackfn)[0] ? 1 : 0"), lane)).toBe(1);
    });

    it(`direct call passes the extra argument (${lane})`, async () => {
      expect(await run(program(true, "callbackfn(11, 0, [11]) ? 1 : 0"), lane)).toBe(1);
    });

    it(`a same-signature function expression's body is not inlined for a declaration (${lane})`, async () => {
      const source = `
        const o: any = {};
        o.f = function (x: number): number { return x * 2; };
        function d(x: number): number { return x + 100; }
        const r = [1, 2].map(d);
        export function test(): number { return r[0] + r[1] + o.f(1); }
      `;
      expect(await run(source, lane, "issue-6913.ts")).toBe(205);
    });
  }
});
