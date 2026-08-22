// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4564 — standalone ToPrimitive coverage for closure/Date carriers and the
 * §13.15.3 addition cascade.
 *
 * The relational lowering already reduced ordinary object operands before
 * comparing, but `__to_primitive` returned closure and Date carriers unchanged.
 * Addition had a second gap: it selected numeric vs string behavior from the
 * raw operands instead of reducing both operands with hint `default` first.
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<unknown> {
  const result = await compile(`export function test(): number { ${body} }`, {
    fileName: "issue-4564.ts",
    target: "standalone",
    skipSemanticDiagnostics: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(result.imports.map((entry) => `${entry.module}::${entry.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

const MATRIX_CARRIERS = {
  fn: "function () { return 1; }",
  ob: "{}",
  ar: "[1, 2]",
  dt: "new Date(0)",
  nu: "1",
  st: '"1"',
} as const;

function truthTableBody(): string {
  const names = Object.keys(MATRIX_CARRIERS) as (keyof typeof MATRIX_CARRIERS)[];
  const declarations = names.map((name) => `var ${name} = ${MATRIX_CARRIERS[name]};`).join("\n");
  const hostDeclarations = declarations;
  const checks: string[] = [];
  for (const operator of ["<", "<=", ">", ">="] as const) {
    for (const left of names) {
      for (const right of names) {
        const expected = new Function(`${hostDeclarations}\nreturn (${left}) ${operator} (${right});`)() as boolean;
        checks.push(`if (((${left}) ${operator} (${right})) !== ${expected}) bad++;`);
      }
    }
  }
  const primitiveString = {
    fn: "fn.toString()",
    ob: '"[object Object]"',
    ar: '"1,2"',
    dt: "dt.toString()",
    nu: '"1"',
    st: '"1"',
  } as const;
  for (const left of names) {
    for (const right of names) {
      const expected = left === "nu" && right === "nu" ? "2" : `${primitiveString[left]} + ${primitiveString[right]}`;
      checks.push(`if (((${left}) + (${right})) !== (${expected})) bad++;`);
    }
  }
  return `${declarations}\nvar bad = 0;\n${checks.join("\n")}\nreturn bad;`;
}

describe("#4564 closure/Date ToPrimitive and object addition (standalone)", () => {
  it("matches all 180 carrier/operator truth-table cells", async () => {
    expect(await runStandalone(truthTableBody())).toBe(0);
  });

  it("reduces a closure through Function.prototype.toString for relational comparison", async () => {
    expect(await runStandalone(`var f = function () { return 1; }; return f >= f ? 1 : 0;`)).toBe(1);
  });

  it("accepts null returned by an own closure valueOf", async () => {
    expect(
      await runStandalone(
        `var f = function () { return 1; }; f.valueOf = function () { return null; }; return f < 1 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("accepts undefined returned by an own closure valueOf", async () => {
    expect(
      await runStandalone(
        `var f = function () { return 1; }; f.valueOf = function () { return undefined; }; var z = f + 1; return z !== z ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("throws when both own closure conversion methods return objects", async () => {
    await expect(
      runStandalone(
        `var f = function () { return 1; }; f.valueOf = function () { return {}; }; f.toString = function () { return {}; }; return f + 1;`,
      ),
    ).rejects.toThrow();
  });

  it("honors an inherited Function.prototype valueOf override", async () => {
    expect(
      await runStandalone(
        `(Function.prototype as any).valueOf = function () { return 7; }; var f = function () {}; return f + 1 === 8 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("honors an inherited Function.prototype toString override", async () => {
    expect(
      await runStandalone(
        `(Function.prototype as any).toString = function () { return "F"; }; var f = function () {}; return f + f === "FF" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("reduces callable operands before statically string-typed addition", async () => {
    expect(
      await runStandalone(
        `var f = function () {}; f.valueOf = function () { return 7; }; return f + "x" === "7x" && "x" + f === "x7" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("does not trust a reassigned closure binding as a closure carrier", async () => {
    expect(
      await runStandalone(
        `let f: typeof Array = function () {} as any; f = Array; return f + "" === "function () { [native code] }" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("does not trust a mutable closure binding in a with-scoped file", async () => {
    expect(
      await runStandalone(
        `var f: typeof Array = function () {} as any; with ({}) { f = Array; } return f + "" === "function () { [native code] }" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("does not trust a later initializer on a var redeclaration", async () => {
    expect(
      await runStandalone(
        `var f: typeof Array = function () {} as any; var f: typeof Array = Array; return f + "" === "function () { [native code] }" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("does not trust a var binding written by a for-of declaration", async () => {
    expect(
      await runStandalone(
        `var f: typeof Array = function () {} as any; for (var f of [Array]) {} return f + "" === "function () { [native code] }" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("keeps the static NativeFunction string path for non-closure builtin callables", async () => {
    expect(
      await runStandalone(
        `var n = "function () { [native code] }"; return "" + Array === n && "" + Object === n && "" + Date === n && "" + RegExp === n && "" + Error === n && "" + TypeError === n && "" + Number === n && "" + String === n && "" + Boolean === n ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("keeps the static NativeFunction string path for a callable Proxy", async () => {
    expect(
      await runStandalone(
        `var p = new Proxy(function () {}, {}); return "" + p === "function () { [native code] }" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("throws when both inherited Function conversion methods return objects", async () => {
    await expect(
      runStandalone(
        `(Function.prototype as any).valueOf = function () { return {}; }; (Function.prototype as any).toString = function () { return {}; }; var f = function () {}; return f + 1;`,
      ),
    ).rejects.toThrow();
  });

  it("uses the Date time value for a number-hint relational comparison", async () => {
    expect(await runStandalone(`var d = new Date(7); return d >= d && d < 8 ? 1 : 0;`)).toBe(1);
  });

  it("honors an own Date valueOf override for the number hint", async () => {
    expect(
      await runStandalone(
        `var d = new Date(7); d.valueOf = function () { return 42; }; return d > 41 && d < 43 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("uses intrinsic Date valueOf before an own toString for the number hint", async () => {
    expect(
      await runStandalone(`var d = new Date(1000); d.toString = function () { return "42"; }; return d > 500 ? 1 : 0;`),
    ).toBe(1);
  });

  it("accepts null returned by an own Date valueOf as the primitive result", async () => {
    expect(
      await runStandalone(`var d = new Date(7); d.valueOf = function () { return null; }; return d < 1 ? 1 : 0;`),
    ).toBe(1);
  });

  it("lets an inherited non-callable Date valueOf shadow the intrinsic", async () => {
    expect(
      await runStandalone(
        `var calls = 0; (Date.prototype as any).valueOf = 0; (Date.prototype as any).toString = function () { calls++; return "x"; }; var d = new Date(1000); var z = d < d; return !z && calls === 2 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("continues from an object-returning inherited Date toString to valueOf", async () => {
    expect(
      await runStandalone(
        `var log = ""; (Date.prototype as any).toString = function () { log += "s"; return {}; }; (Date.prototype as any).valueOf = function () { log += "v"; return 7; }; var d = new Date(1000); return d + d === 14 && log === "svsv" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("concatenates two ordinary-object primitive results instead of adding NaN", async () => {
    expect(
      await runStandalone(`var a = {}, b = {}; return (a + b) === "[object Object][object Object]" ? 1 : 0;`),
    ).toBe(1);
  });

  it("reduces the object arm of an object-or-number union before addition", async () => {
    expect(
      await runStandalone(
        `function add(x: {} | number): any { return x + x; } return add({}) === "[object Object][object Object]" && add(3) === 6 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("reduces both closure operands before choosing the string addition arm", async () => {
    expect(
      await runStandalone(
        `var f = function () { return 1; }; return (f + f) === (f.toString() + f.toString()) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("treats Date's default hint as string for addition", async () => {
    expect(await runStandalone(`var d = new Date(0); return (d + d) === (d.toString() + d.toString()) ? 1 : 0;`)).toBe(
      1,
    );
  });

  it("honors an own Date toString override for the default hint", async () => {
    expect(
      await runStandalone(
        `var d = new Date(0); d.toString = function () { return "D"; }; return (d + "!") === "D!" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("uses intrinsic Date toString before an own valueOf for the string hint", async () => {
    expect(
      await runStandalone(
        `var d = new Date(0); d.valueOf = function () { return 42; }; return String(d) === d.toString() ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("uses intrinsic Date toString before an own valueOf for the default hint", async () => {
    expect(
      await runStandalone(
        `var d = new Date(0); d.valueOf = function () { return 42; }; return (d + d) === (d.toString() + d.toString()) ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("String(Date) stringifies a non-string primitive returned by an own toString", async () => {
    expect(
      await runStandalone(
        `var d = new Date(0); d.toString = function () { return 17; }; return String(d) === "17" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("accepts null returned by an own Date toString as the primitive result", async () => {
    expect(
      await runStandalone(
        `var d = new Date(0); d.toString = function () { return null; }; return String(d) === "null" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("accepts undefined returned by an own Date toString as the primitive result", async () => {
    expect(
      await runStandalone(
        `var d = new Date(0); d.toString = function () { return undefined; }; return String(d) === "undefined" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("uses valueOf before toString for ordinary-object addition", async () => {
    expect(
      await runStandalone(
        `var o = { valueOf: function () { return 1; }, toString: function () { return "X"; } }; return (o + "Y") === "1Y" ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("accepts undefined returned by an ordinary object's valueOf", async () => {
    expect(
      await runStandalone(
        `var calls = 0; var o = { valueOf: function () { return undefined; }, toString: function () { calls++; return "9"; } }; var z = o + 1; return z !== z && calls === 0 ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("preserves RegExp source stringification through object addition", async () => {
    expect(
      await runStandalone(
        `var r = new RegExp("x", "gi"); return r + "" === r.toString() && "" + r === r.toString() ? 1 : 0;`,
      ),
    ).toBe(1);
  });

  it("honors a RegExp valueOf override before intrinsic toString", async () => {
    expect(
      await runStandalone(
        `var r = new RegExp("x"); r.valueOf = function () { return 7; }; return r + 1 === 8 ? 1 : 0;`,
      ),
    ).toBe(1);
  });
});
