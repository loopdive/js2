// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7117 — a method call on a dynamic receiver (`x.toString()`, `s.toUpperCase()`,
// `list.indexOf(2)`) lowers through the IR's generic `__ir_dyn_method_call_N` →
// `__extern_method_call`. On the host lane that is the real JS call. Off it, the
// native object runtime dispatches open-`$Object` methods only and answers
// `undefined` for a primitive or vec receiver, where legacy dispatches by
// brand. Measured on origin/main before this fix: all three functions were IR
// bodies on standalone and `run()` returned 101010 where node returns 111111.
import { describe, expect, it } from "vitest";

import { compile, type CompileResult } from "../src/index.js";

const SOURCE = `function t(x) {
  return x.toString();
}
function u(s) {
  return s.toUpperCase();
}
function k(list) {
  return list.indexOf(2);
}
export function run() {
  var n = 0;
  if (t([1, 2]) === "1,2") n += 1;
  if (t({ toString: function () { return "obj"; } }) === "obj") n += 10;
  if (u("ab") === "AB") n += 100;
  if (u({ toUpperCase: function () { return "X"; } }) === "X") n += 1000;
  if (k([1, 2]) === 1) n += 10000;
  if (k({ indexOf: function () { return 7; } }) === 7) n += 100000;
  return n;
}`;

function node(): number {
  return new Function(`"use strict";\n${SOURCE.replace(/\bexport /g, "")}\nreturn run();`)() as number;
}

function emitted(result: CompileResult, name: string): boolean | undefined {
  return (result.irOutcomes ?? []).find((row) => row.displayName === name)?.irBodyEmitted;
}

async function run(result: CompileResult, host: boolean): Promise<number> {
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const imports = (host ? result.importObject : {}) as WebAssembly.Imports & {
    __setExports?: (exports: WebAssembly.Exports) => void;
    __setInstance?: (instance: WebAssembly.Instance) => void;
  };
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.__setExports?.(instance.exports);
  imports.__setInstance?.(instance);
  return (instance.exports.run as () => number)();
}

describe("#7117 — IR dynamic method calls off the host lane", () => {
  it("keeps the functions legacy on standalone, so the results match node", async () => {
    const result = await compile(SOURCE, {
      fileName: "test.js",
      allowJs: true,
      target: "standalone",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    } as Parameters<typeof compile>[1]);
    for (const name of ["t", "u", "k"]) expect(emitted(result, name), name).toBe(false);
    expect(node()).toBe(111111);
    expect(await run(result, false)).toBe(111111);
  }, 35_000);

  it("keeps a USER method name on the IR path, where the open-$Object dispatch is exact", async () => {
    const source = `function label(o) {
  return o.label();
}
export function run() {
  var n = 0;
  if (label({ label: function () { return "a"; } }) === "a") n += 1;
  if (label({ x: 1, label: function () { return "b"; } }) === "b") n += 10;
  return n;
}`;
    const result = await compile(source, {
      fileName: "test.js",
      allowJs: true,
      target: "standalone",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    } as Parameters<typeof compile>[1]);
    expect(emitted(result, "label")).toBe(true);
    expect(await run(result, false)).toBe(11);
  }, 35_000);

  it("leaves the host lane, whose __extern_method_call is the real JS call, unchanged", async () => {
    // `semanticProviders: "host-assisted"` IS the host lane (allowHostImports).
    // A default build is the native-first regime, projected as standalone —
    // that case is below.
    const result = await compile(SOURCE, {
      fileName: "test.js",
      allowJs: true,
      semanticProviders: "host-assisted",
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    } as Parameters<typeof compile>[1]);
    for (const name of ["t", "u", "k"]) expect(emitted(result, name), name).toBe(true);
    expect(await run(result, true)).toBe(111111);
  }, 35_000);

  it("keeps the functions legacy on a default (native-first) build, where the gate fires too", async () => {
    // Measured on origin/main: the default build returned 101010 as well.
    const result = await compile(SOURCE, {
      fileName: "test.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    } as Parameters<typeof compile>[1]);
    for (const name of ["t", "u", "k"]) expect(emitted(result, name), name).toBe(false);
    expect(await run(result, true)).toBe(111111);
  }, 35_000);
});
