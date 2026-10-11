// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6651 cluster H, slice H3) Two standalone answers that disagreed with the
 * spelling right next to them.
 *
 * ## 1. `__extern_get`'s missing NUMERIC-key arm on a vec receiver
 *
 * `__extern_has` grew one in #6485 (`0 in arr` hands the helper a boxed
 * **Number**, not the string `"0"`, and every index delegation sat behind
 * `ref.test $AnyString`). `__extern_get` never got the twin, so the two
 * disagreed: `in` reported a property the read could not fetch.
 *
 * The read site that reaches it is the one where NEITHER the receiver nor the
 * key is statically an array/number — `isNumericIndexExpression` declines a
 * `string|symbol` key, so the call site keeps `__extern_get` and boxes the key.
 * Measured on the branch base, standalone:
 *
 * | expression (`name` declared `string|symbol`, receiver `object`) | base | spec |
 * | --- | --- | --- |
 * | `readIt([10, 20], 0)`   | `undefined` | `10` |
 * | `readIt([10, 20], "0")` | `10`        | `10` |
 * | `readIt({0: 7}, 0)`     | `7`         | `7`  |
 *
 * The plain-object row is what makes it a vec-carrier bug and not a key-typing
 * bug. Its real-world caller is test262's `propertyHelper.js`, whose
 * `verifyProperty(obj, name, desc)` declares `@param {string|symbol} name` and
 * then compares `desc.value` against `obj[name]`: with the DESCRIPTOR reading
 * `1` correctly, `obj[name]` read `undefined`, which is why all four
 * `Array.prototype.{filter,map,slice,splice}` species rows reported
 * `0 value should be 1` while their `CreateDataPropertyOrThrow` was in fact
 * already correct. That trap — a harness helper mis-reading a value the test
 * had computed properly — is why this looked like a `defineProperty` defect.
 *
 * ## 2. `Object.getOwnPropertyDescriptors` walked only STRING own keys
 *
 * §20.1.2.9 step 3 walks `O.[[OwnPropertyKeys]]()`, which is indices, then
 * strings, then SYMBOLS. The self-hosted helper looped over
 * `__getOwnPropertyNames` alone, so an object whose own keys are all symbols
 * produced `{}`. Measured on the base tree, standalone: for `o[sym] = 1`,
 * `Object.getOwnPropertySymbols(gOPDs(o)).length` was `0`.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runLines(body: string): Promise<string[]> {
  const source = `function LOG(s) { console.log(s); }\n${body}\n`;
  const result = await compile(source, {
    allowJs: true,
    fileName: "issue-6651-vec-numeric-key-get.js",
    skipSemanticDiagnostics: true,
    target: "standalone",
    nativeStrings: true,
    hostBridge: "always",
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
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

/** The `propertyHelper.js` shape: a non-array receiver type + a non-numeric key type. */
const READ_IT = `
  /**
   * @param {object} obj
   * @param {string|symbol} name
   */
  function readIt(obj, name) { return obj[name]; }
`;

describe("#6651 H3 numeric key through a non-numeric key slot (standalone)", () => {
  it("reads an array element for a Number key that is statically string|symbol", async () => {
    // RED on base: `num=undefined`.
    const lines = await runLines(`${READ_IT}
      var a = [10, 20];
      LOG("num=" + readIt(a, 0) + " str=" + readIt(a, "0") + " obj=" + readIt({ 0: 7 }, 0));
    `);
    expect(lines).toEqual(["num=10 str=10 obj=7"]);
  });

  it("agrees with the descriptor on a species target whose index 0 was defined non-writable", async () => {
    // RED on base: `dyn=undefined` while `desc=1` — the exact
    // `target-array-with-non-writable-property.js` disagreement.
    const lines = await runLines(`${READ_IT}
      var a = [1];
      a.constructor = {};
      a.constructor[Symbol.species] = function (len) {
        var q = new Array(0);
        Object.defineProperty(q, 0, { value: 0, writable: false, configurable: true, enumerable: false });
        return q;
      };
      var r = a.filter(function () { return true; });
      LOG("desc=" + Object.getOwnPropertyDescriptor(r, 0).value + " lit=" + r[0] + " dyn=" + readIt(r, 0));
    `);
    expect(lines).toEqual(["desc=1 lit=1 dyn=1"]);
  });

  it("leaves a NON-index Number key on the named-property tail", async () => {
    // Guard, green on both sides: 1.5 and -1 are ToPropertyKey'd to names, not
    // indices, so the arm must decline rather than truncate into the vec.
    const lines = await runLines(`${READ_IT}
      var a = [10, 20];
      LOG("frac=" + readIt(a, 1.5) + " neg=" + readIt(a, -1) + " oob=" + readIt(a, 5));
    `);
    expect(lines).toEqual(["frac=undefined neg=undefined oob=undefined"]);
  });

  it("gets a boolean key ToPropertyKey'd as a NAME, not coerced to an index", async () => {
    // Guard, green on both sides: the `__typeof_number` gate (not a bare
    // ToNumber) is what keeps `readIt(a, true)` from reading index 1.
    const lines = await runLines(`${READ_IT}
      var a = [10, 20];
      LOG("bool=" + readIt(a, true));
    `);
    expect(lines).toEqual(["bool=undefined"]);
  });

  it("includes symbol-keyed descriptors in Object.getOwnPropertyDescriptors", async () => {
    // RED on base: `syms=0 val=undefined` — the result object was empty.
    const lines = await runLines(`
      var s = Symbol("a");
      var o = {};
      o[s] = 1;
      o.plain = 2;
      var d = Object.getOwnPropertyDescriptors(o);
      LOG("syms=" + Object.getOwnPropertySymbols(d).length +
          " names=" + Object.getOwnPropertyNames(d).length +
          " val=" + d[s].value);
    `);
    expect(lines).toEqual(["syms=1 names=1 val=1"]);
  });

  it("keeps a symbol-free receiver's descriptor map exactly as it was", async () => {
    // Guard, green on both sides: the added symbol loop runs zero times.
    //
    // The per-descriptor read is spelled with a DYNAMIC key on purpose. A
    // STATIC `d.a.value` on this runtime-built object answers `undefined` here
    // — measured identical on the base tree (`names=2 a=undefined w=undefined`)
    // and after, so it is a pre-existing residual of the static-property read
    // on a helper-produced receiver, NOT something this slice touches. Pinning
    // it either way would pin the wrong thing; it is recorded in the slice
    // receipt as a root-caused-but-not-taken item instead.
    const lines = await runLines(`
      var d = Object.getOwnPropertyDescriptors({ a: 1, b: 2 });
      var ka = "a";
      var kb = "b";
      LOG("names=" + Object.getOwnPropertyNames(d).length +
          " a=" + d[ka].value + " w=" + d[kb].writable);
    `);
    expect(lines).toEqual(["names=2 a=1 w=true"]);
  });
});
