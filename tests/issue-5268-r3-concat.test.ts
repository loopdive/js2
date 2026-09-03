// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#5268 r3 step R3-5) Two concat-protocol residuals, both verified RED on the
 * pre-change tree (`.tmp/basetree`, a `git archive` of the branch base):
 *
 * - §23.1.3.1.1 step 3: a PRESENT `@@isConcatSpreadable` of `null` (or any
 *   other falsy non-undefined value) must NOT spread. The absence test treated
 *   a wasm `ref.null` as "absent" and fell back to `IsArray`, so `[].concat`
 *   spread a two-element array into the result.
 * - OrdinaryToPrimitive step 5.b.i `IsCallable`: a `valueOf: null` field is an
 *   absent method, not a method. The `__call_valueOf` dispatcher `ref.cast` it
 *   unguarded and TRAPPED ("illegal cast in __call_valueOf") — the base run of
 *   the second case here dies with exactly that.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-5268-r3-concat.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    nativeStrings: true,
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  expect(result.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, (...args: number[]) => number>;
  let threw = false;
  try {
    exports.__module_init!();
  } catch {
    threw = true;
  }
  const length = exports.__stdout_prepare!() | 0;
  let sink = "";
  for (let i = 0; i < length; i++) sink += String.fromCharCode(exports.__stdout_char!(i) & 0xffff);
  const lines = sink.split("\n").filter((l) => l.length > 0);
  if (threw) lines.push("THREW");
  return lines;
}

describe("#5268 r3 — concat residuals (standalone)", () => {
  it("a present falsy @@isConcatSpreadable does not spread; an absent one still consults IsArray", async () => {
    // RED on base: every `len=` line printed 2 (the array was spread).
    const lines = await runLines(`
      var item = [1, 2];
      item[Symbol.isConcatSpreadable] = null;
      LOG("null=" + [].concat(item).length);
      item[Symbol.isConcatSpreadable] = false;
      LOG("false=" + [].concat(item).length);
      item[Symbol.isConcatSpreadable] = 0;
      LOG("zero=" + [].concat(item).length);
      LOG("absent=" + [].concat([3, 4]).length);
      var spread = { length: 2, 0: "a", 1: "b" };
      spread[Symbol.isConcatSpreadable] = true;
      LOG("true=" + [].concat(spread).length);
    `);
    expect(lines).toEqual(["null=1", "false=1", "zero=1", "absent=2", "true=2"]);
  });

  it("a non-callable valueOf falls through to toString instead of trapping", async () => {
    // RED on base: "illegal cast in __call_valueOf".
    const lines = await runLines(`
      var src = { length: { valueOf: null, toString: function () { return "2"; } }, 0: "a", 1: "b" };
      src[Symbol.isConcatSpreadable] = true;
      LOG("len=" + [].concat(src).length);
      LOG("valueOf=" + ("" + { valueOf: function () { return 7; } }));
      LOG("toString=" + ("" + { toString: function () { return "T"; } }));
    `);
    expect(lines).toEqual(["len=2", "valueOf=7", "toString=T"]);
  });
});
