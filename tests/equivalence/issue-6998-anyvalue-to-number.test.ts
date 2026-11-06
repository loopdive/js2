// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6998 — on standalone a `string | number` (carried as `$AnyValue`) unboxed to
// a number read the box's `f64val` field for the string (tag 5) and object
// (tag 6) payloads, which is 0: `(a as any) * 2` with `"9"` gave 0, `"abc"` gave
// 0 instead of NaN, an object's `valueOf` was never called. Tags 5/6 now run
// ToPrimitive + ToNumber; unary `-` takes the same conversion instead of
// `__any_neg`. Standalone-only: the js-host lane keeps its bytes.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs } from "./helpers.js";

async function assertStandaloneEquivalent(source: string): Promise<void> {
  const result = await compile(source, { fileName: "issue-6998.ts", target: "standalone" });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  expect(exports.test!()).toBe(evaluateAsJs(source).test!());
}

const g = (ret: string, expr: string): string => `function g(a: string | number): ${ret} { return ${expr}; }\n`;
const MUL = g("number", "(a as any) * 2");
const test = (prelude: string, body: string): string => `${prelude}export function test(): number { ${body} }`;

const CASES: [string, string][] = [
  ['issue repro: f("9") * 2', test(MUL, `return g("9");`)],
  ['f("abc") is NaN', test(MUL, `return g("abc");`)],
  ['f(" 12 ") trims', test(MUL, `return g(" 12 ");`)],
  ['f("0x10") parses hex', test(MUL, `return g("0x10");`)],
  ['f("1e3") parses exponent', test(MUL, `return g("1e3");`)],
  ['f("") is 0', test(MUL, `return g("");`)],
  ["f(true) is 2", test(MUL, `return g(true as any);`)],
  ["f(null) is 0", test(MUL, `return g(null as any);`)],
  ["f(undefined) is NaN", test(MUL, `return g(undefined as any);`)],
  ["object literal valueOf", test(MUL, `return g({ valueOf() { return 7 } } as any);`)],
  ["class instance valueOf", test(`class V { valueOf(): number { return 7 } }\n` + MUL, `return g(new V() as any);`)],
  ["array [5]", test(MUL, `return g([5] as any);`)],
  ["Date time value", test(MUL, `return g(new Date(21) as any);`)],
  ["number payloads unchanged (f64 and i32)", test(MUL, `return g(1.5) + g(3);`)],
  ['unary minus on "9"', test(g("number", "-(a as any)"), `return g("9");`)],
  [
    'unary minus on "abc", true, 4',
    test(g("number", "-(a as any)"), `return g("abc") + g(true as any) * 10 + g(4) * 100;`),
  ],
  ["unary minus on null is -0", test(g("number", "-(a as any)"), `return 1 / g(null as any);`)],
  ['division "9" / 2', test(g("number", "(a as any) / 2"), `return g("9");`)],
  ['unary plus "9"', test(g("number", "+(a as any)"), `return g("9");`)],
  ['remainder "9" % 2', test(g("number", "(a as any) % 2"), `return g("9");`)],
  [
    'ToInt32: "9" | 0, "1e3" | 0, "4294967297" | 0',
    test(g("number", "(a as any) | 0"), `return g("9") + g("1e3") * 10 + g("4294967297") * 100000;`),
  ],
  ['bitwise ~"5" and "9" >> 1', test(g("number", "~(a as any) * 10 + ((a as any) >> 1)"), `return g("5");`)],
  ["Number(a) * 2", test(g("number", "Number(a) * 2"), `return g("9");`)],
  ['"90" < 10 is false', test(g("boolean", "(a as any) < 10"), `return g("90") ? 1 : 0;`)],
  ['subtraction "10" - 1', test(g("number", "(a as any) - 1"), `return g("10");`)],
  ['Math.floor("3.7")', test(g("number", "Math.floor(a as any)"), `return g("3.7");`)],
  [
    'isNaN("abc") / isNaN("3")',
    test(g("boolean", "isNaN(a as any)"), `return (g("abc") ? 1 : 0) + (g("3") ? 10 : 0);`),
  ],
  [
    "compound *= with a string payload",
    test(`function g(a: string | number): number { let t = 1; t *= (a as any); return t; }\n`, `return g("4");`),
  ],
  [
    "controls: ToBoolean and ToString of the union are unchanged",
    test(
      `function b(a: string | number): boolean { return !!(a as any); }\nfunction s(a: string | number): string { return String(a); }\n`,
      `return (b("") ? 1 : 0) + (b("0") ? 10 : 0) + (b(0) ? 100 : 0) + (s(9) === "9" ? 1000 : 0);`,
    ),
  ],
];

describe("#6998 $AnyValue string/object payloads convert with ToNumber (standalone)", () => {
  for (const [name, src] of CASES) {
    it(`standalone: ${name}`, async () => {
      await assertStandaloneEquivalent(src);
    }, 60_000);
  }
});
