// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster H, slice H2) §10.4.2.1 step 1 — a SYMBOL property key on an
 * Array exotic object is neither an array index nor `"length"`, so
 * `[[DefineOwnProperty]]` / `[[GetOwnProperty]]` are the ORDINARY ones.
 *
 * The standalone vec overlay (`vec-overlay.ts`) guarded all four of its natives
 * with `stringKeyGuard`, whose bail RETURNS. For `__vec_dp_value` and
 * `__vec_dp_accessor` that meant the definition was silently DROPPED; for
 * `__vec_gopd` it answered `undefined` for a property the store actually held;
 * and the `__extern_get` / `__vec_prop_get` read prologue skipped the companion
 * consult for a symbol key, so even a definition that had landed was invisible.
 *
 * Measured on the branch base (one standalone module, all eight questions):
 *
 * | question                                                  | base        | spec    |
 * | --------------------------------------------------------- | ----------- | ------- |
 * | `gOPD(arr, sym)` after an accessor define                  | `undefined` | object  |
 * | `arr[sym]` after an accessor define                        | `undefined` | `false` |
 * | the getter ran                                             | never       | once    |
 * | `arr[sym]` after a DATA define                             | `undefined` | `11`    |
 * | `gOPD(arr, sym)` after a plain `arr[sym] = 9` assignment   | `undefined` | object  |
 * | the same three on a PLAIN object (the control)             | correct     | correct |
 *
 * The plain-object column is what makes this a carrier bug rather than a
 * symbol-key bug: the `$Object` define/gOPD natives were always right, and the
 * array-carrier overlay was refusing to reach them.
 *
 * The last row is the #4010 two-table seam: a symbol expando written by plain
 * ASSIGNMENT lands in the #3537 bag, not in the #3251 companion, so the gOPD
 * symbol arm has to fall through to the bag rather than answer the companion's
 * miss. Both directions are pinned below.
 *
 * This is #6485's recorded `is-concat-spreadable-get-order` residual: that test
 * installs `Object.defineProperty(arr, Symbol.isConcatSpreadable, {get})` and
 * asserts the getter is observed in §23.1.3.1's order.
 *
 * Negative direction, pinned in the last two cases: a STRING key must keep the
 * index / `"length"` semantics the overlay exists for (`arr.length` stays live,
 * an index write still lands in the vec), which is what the added symbol arms
 * must not disturb.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-6651-vec-symbol-key-overlay.js",
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

describe("#6651 H2 symbol-keyed properties on an array carrier (standalone)", () => {
  it("an ACCESSOR define on an array installs a real getter", async () => {
    // RED on base: `desc=undefined get=undefined hits=0`.
    const lines = await runLines(`
      var arr = [1, 2];
      var hits = 0;
      Object.defineProperty(arr, Symbol.isConcatSpreadable, {
        get: function () { hits += 1; return false; },
        configurable: true
      });
      LOG("desc=" + typeof Object.getOwnPropertyDescriptor(arr, Symbol.isConcatSpreadable) +
          " get=" + arr[Symbol.isConcatSpreadable] + " hits=" + hits);
    `);
    expect(lines).toEqual(["desc=object get=false hits=1"]);
  });

  it("a DATA define on an array is visible to the read path", async () => {
    // RED on base: `get=undefined`.
    const lines = await runLines(`
      var arr = [4];
      Object.defineProperty(arr, Symbol.isConcatSpreadable, { value: 11, configurable: true });
      LOG("get=" + arr[Symbol.isConcatSpreadable]);
    `);
    expect(lines).toEqual(["get=11"]);
  });

  it("gOPD finds a symbol expando written by plain assignment (the #4010 bag seam)", async () => {
    // RED on base for `desc`: the read already answered 9 from the #3537 bag
    // while gOPD answered `undefined` for the very same property.
    const lines = await runLines(`
      var arr = [3];
      arr[Symbol.isConcatSpreadable] = 9;
      LOG("get=" + arr[Symbol.isConcatSpreadable] +
          " desc=" + typeof Object.getOwnPropertyDescriptor(arr, Symbol.isConcatSpreadable));
    `);
    expect(lines).toEqual(["get=9 desc=object"]);
  });

  it("the PLAIN-OBJECT control was always correct and stays correct", async () => {
    // Green on both sides. It is the reason this is a carrier bug: the
    // `$Object` define/gOPD natives the overlay now delegates to are the same
    // ones that already answered these three questions.
    const lines = await runLines(`
      var o = {};
      Object.defineProperty(o, Symbol.isConcatSpreadable, { value: 7, configurable: true });
      var p = {};
      Object.defineProperty(p, Symbol.isConcatSpreadable, { get: function () { return 13; }, configurable: true });
      LOG("data=" + o[Symbol.isConcatSpreadable] + " acc=" + p[Symbol.isConcatSpreadable] +
          " desc=" + typeof Object.getOwnPropertyDescriptor(o, Symbol.isConcatSpreadable));
    `);
    expect(lines).toEqual(["data=7 acc=13 desc=object"]);
  });

  it("a gOPD for a symbol the array does NOT have still answers undefined", async () => {
    // The miss direction: the new arm must not manufacture a descriptor.
    const lines = await runLines(`
      var arr = [1];
      LOG("desc=" + Object.getOwnPropertyDescriptor(arr, Symbol.isConcatSpreadable));
    `);
    expect(lines).toEqual(["desc=undefined"]);
  });

  it("string keys keep the index / length semantics (the negative direction)", async () => {
    // Green on both sides. A fix that routed every non-index key to the
    // companion would break `arr.length` (live vec field) or the index write.
    const lines = await runLines(`
      var arr = [1, 2, 3];
      arr[1] = 9;
      arr.push(4);
      Object.defineProperty(arr, "q", { value: 5, configurable: true });
      LOG("len=" + arr.length + " one=" + arr[1] + " q=" + arr.q +
          " lenDesc=" + Object.getOwnPropertyDescriptor(arr, "length").value);
    `);
    expect(lines).toEqual(["len=4 one=9 q=5 lenDesc=4"]);
  });
});
