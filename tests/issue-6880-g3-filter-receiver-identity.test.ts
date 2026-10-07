// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #6880 group 3 (#5385 S3-j) — a callback HOF over an externref-carried array
// walks the array itself, not a snapshot.
//
// With a live direct `eval` (every test262 row has one through the harness
// `$262.evalScript` shim) the native regime widens script globals to externref.
// `srcArr.filter(cb)` then rebuilt the receiver into a fresh vec before the
// loop, so a callback that writes, deletes or truncates `srcArr` was invisible
// (`Array.prototype.filter` 15.4.4.20-9-{2,3,4}).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const previous = process.env.JS2WASM_NATIVE_REGIME_JS;
beforeAll(() => {
  process.env.JS2WASM_NATIVE_REGIME_JS = "1";
});
afterAll(() => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "JS2WASM_NATIVE_REGIME_JS");
  else process.env.JS2WASM_NATIVE_REGIME_JS = previous;
});

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

async function runScript(body: string): Promise<number> {
  const source = `
    var evalSink = function (text) { return eval(text); };
    ${body}
  `;
  const result = await compile(source, {
    fileName: "issue-6880.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
    semanticProviders: "native-first",
  });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  expect(result.targetProfile?.nativeRegime).toBe(true);
  const logs: string[] = [];
  const consoleProxy = { ...console, log: (...values: unknown[]) => void logs.push(values.join(" ")) };
  const imports = buildImports(result.imports, { console: consoleProxy }, result.stringPool) as Record<string, any>;
  stubRuntimeEval(result.binary, imports);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (imports as { setInstance?: (instance: WebAssembly.Instance) => void }).setInstance?.(instance);
  (instance.exports as { __module_init?: () => void }).__module_init?.();
  expect(logs).toHaveLength(1);
  return Number(logs[0]);
}

describe("#6880 g3 — filter over an eval-widened array global sees the callback's writes", () => {
  it.each([
    ["writes", "srcArr[2] = -1; srcArr[4] = -1;", 3],
    ["deletes", "delete srcArr[2]; delete srcArr[4];", 3],
    ["truncates", "srcArr.length = 2;", 2],
  ])("callback %s", async (_label, mutation, expected) => {
    const value = await runScript(`
      var srcArr = [1, 2, 3, 4, 5];
      function callbackfn(val) { ${mutation} return val > 0; }
      console.log(String(srcArr.filter(callbackfn).length));
    `);
    expect(value).toBe(expected);
  });
});
