// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #6969 — standalone `parseInt` / `parseFloat` run §19.2.5 / §19.2.4 step 1
 * `ToString(string)` on a NON-string argument instead of `ref.cast`-ing the
 * externref to `$AnyString` (which trapped `illegal cast`). Reached whenever the
 * call site holds the argument as an externref: a member-held closure's
 * parameter (Octane box2d `F.parseUInt = function (y) { return
 * Math.abs(parseInt(y)) }`), an `any` element read, `parseInt(undefined)`.
 * Expected values are node's (NaN is reported as -999).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(source: string, octane: boolean): Promise<number> {
  const result = await compile(source, {
    fileName: "issue-6969.js",
    target: "standalone",
    allowJs: true,
    skipSemanticDiagnostics: true,
    // Octane harness options: Script goal, no runtime-eval provider.
    ...(octane ? { inferModuleStrictArguments: false, runtimeEvalProvider: false } : {}),
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  const module = await WebAssembly.compile(result.binary);
  expect(WebAssembly.Module.imports(module), "standalone Wasm imports").toEqual([]);
  const instance = await WebAssembly.instantiate(module, {});
  return (instance.exports as { main: () => number }).main();
}

const PRELUDE = `
  var F = {};
  F.pi = function (y, r) { return parseInt(y, r); };
  F.pf = function (y) { return parseFloat(y); };
  function n(x) { return x !== x ? -999 : x; }
`;

const CASES: { name: string; expected: number; body: string }[] = [
  { name: "member-held closure, negative number (box2d parseUInt)", expected: -7, body: "return n(F.pi(-7));" },
  { name: "member-held closure, positive number", expected: 3, body: "return n(F.pi(3));" },
  { name: "fractional number truncates via ToString", expected: 7, body: "return n(F.pi(7.5));" },
  { name: "1e21 stringifies to 1e+21", expected: 1, body: "return n(F.pi(1e21));" },
  { name: "number with radix", expected: 597, body: "return n(F.pi(255, 16));" },
  { name: "undefined is NaN", expected: -999, body: "return n(F.pi(undefined));" },
  { name: "null is NaN at radix 10", expected: -999, body: "return n(F.pi(null));" },
  { name: 'null at radix 36 parses "null"', expected: 1112745, body: "return n(F.pi(null, 36));" },
  { name: 'true at radix 36 parses "true"', expected: 1389110, body: "return n(F.pi(true, 36));" },
  { name: "array stringifies through ToPrimitive", expected: 5, body: "return n(F.pi([5]));" },
  {
    name: "object: ToPrimitive(string) prefers toString",
    expected: 17,
    body: 'return n(F.pi({ valueOf: function () { return 42; }, toString: function () { return "17"; } }));',
  },
  { name: "plain object is NaN", expected: -999, body: "return n(F.pi({}));" },
  { name: "parseFloat of a number held as externref", expected: 2.5, body: "return n(F.pf(2.5));" },
  { name: "parseFloat of a tiny number (exponent form)", expected: -1e-7, body: "return n(F.pf(-1e-7));" },
  { name: "parseFloat of undefined is NaN", expected: -999, body: "return n(F.pf(undefined));" },
  {
    name: "mixed-element array read (any element)",
    expected: 567,
    body: 'var a = [5, "6", 7.5]; function g(y) { return parseInt(y); } return g(a[0]) * 100 + g(a[1]) * 10 + g(a[2]);',
  },
  // Review P1: step 1 is ABSTRACT ToString, which throws a TypeError for a
  // Symbol (unlike `String(sym)`). The head rendered "Symbol(5)" and returned 0.
  {
    name: "member-held parseInt(Symbol) throws TypeError",
    expected: 1,
    body: 'try { F.pi(Symbol("5")); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }',
  },
  {
    name: "member-held parseFloat(Symbol) throws TypeError",
    expected: 1,
    body: 'try { F.pf(Symbol("5")); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }',
  },
  {
    name: "Symbol produced by ToPrimitive throws TypeError",
    expected: 1,
    body: 'try { F.pf({ toString: function () { return Symbol("5"); } }); return 0; } catch (e) { return e instanceof TypeError ? 1 : 2; }',
  },
  {
    name: "control: the object conversion's own TypeError propagates",
    expected: 1,
    body: 'try { F.pi({ toString: function () { throw new TypeError("t"); } }); return 0; } catch (e) { return e instanceof TypeError && e.message === "t" ? 1 : 2; }',
  },
  {
    name: "control: the object conversion's RangeError propagates unchanged",
    expected: 1,
    body: 'try { F.pf({ toString: function () { throw new RangeError("r"); } }); return 0; } catch (e) { return e instanceof RangeError ? 1 : 2; }',
  },
  { name: "control: parseFloat of a number value", expected: 72.5, body: "return n(F.pf(72.5));" },
  { name: "control: string argument", expected: 31, body: 'return n(F.pi("0x1F"));' },
  { name: "control: parseFloat string prefix", expected: 3.5, body: 'return n(F.pf(" 3.5x"));' },
];

describe("#6969 standalone parseInt/parseFloat ToString a non-string argument", () => {
  for (const octane of [false, true]) {
    for (const testCase of CASES) {
      it(`${octane ? "octane options" : "module"}: ${testCase.name}`, async () => {
        const source = `${PRELUDE}\nexport function main() { ${testCase.body} }`;
        expect(await runStandalone(source, octane)).toBe(testCase.expected);
      });
    }
  }
});
