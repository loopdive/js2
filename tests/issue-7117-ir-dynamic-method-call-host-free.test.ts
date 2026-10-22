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
  const imports = (host ? result.importObject : {}) as WebAssembly.Imports;
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  (result.importObject as { setInstance?: (i: WebAssembly.Instance) => void } | undefined)?.setInstance?.(instance);
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

  it("leaves the host lane, whose __extern_method_call is the real JS call, unchanged", async () => {
    const result = await compile(SOURCE, {
      fileName: "test.js",
      allowJs: true,
      skipSemanticDiagnostics: true,
      trackIrOutcomes: true,
    } as Parameters<typeof compile>[1]);
    expect(await run(result, true)).toBe(111111);
  }, 35_000);
});
