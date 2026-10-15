// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6999 — on standalone, `<` `<=` `>` `>=` over `any` / `unknown` /
// `string | number` operands compared numerically (two strings → NaN → false):
// the #2059 runtime-dispatched arm (`emitAnyRelational`, §7.2.13 both-strings →
// lexicographic, else numeric) was gated on `anyValueTypeIdx < 0`, which is
// never true on standalone. Standalone-only: the js-host lane keeps its bytes.
import { describe, expect, it } from "vitest";
import { compile } from "../../src/index.js";
import { evaluateAsJs } from "./helpers.js";

async function assertStandaloneEquivalent(source: string): Promise<void> {
  const result = await compile(source, { fileName: "issue-6999.ts", target: "standalone" });
  expect(result.success, result.errors.map((e) => `L${e.line}: ${e.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, {});
  const exports = instance.exports as Record<string, () => unknown>;
  exports.__module_init?.();
  expect(exports.test!()).toBe(evaluateAsJs(source).test!());
}

const test = (body: string, prelude = ""): string => `${prelude}\nexport function test(): number { ${body} }`;

const CASES: [string, string][] = [
  [
    "issue repro: any strings",
    test(`const a: any = "b", b: any = "a"; return (a > b ? 1 : 0) + ((a as any) < "b" ? 0 : 10);`),
  ],
  ['("2" as any) < ("10" as any) is lexicographic', test(`return ("2" as any) < ("10" as any) ? 1 : 0;`)],
  [
    "string | number parameters",
    test(
      `return (f("b", "a") ? 1 : 0) + (f("10", 9) ? 10 : 0);`,
      `function f(a: string | number, b: string | number): boolean { return a > b }`,
    ),
  ],
  [
    "sort of any[] strings with a relational comparator",
    test(
      `const arr: any[] = ["b", "a", "c"]; arr.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); return arr[0] == "a" && arr[1] == "b" && arr[2] == "c" ? 1 : 0;`,
    ),
  ],
  [
    "sort of mixed numeric-looking any[] strings",
    test(
      `const arr: any[] = ["10", "9", "1", "b", "a"]; arr.sort((x, y) => (x < y ? -1 : x > y ? 1 : 0)); return arr.join(",") === "1,10,9,a,b" ? 1 : 0;`,
    ),
  ],
  ['"a" <= "a" and "a" < "b"', test(`const a: any = "a", b: any = "b"; return (a <= a ? 1 : 0) + (a < b ? 10 : 0);`)],
  ['"10" < "9" (both strings → lexicographic)', test(`const a: any = "10", b: any = "9"; return a < b ? 1 : 0;`)],
  ['"10" < 9 (mixed → numeric)', test(`const a: any = "10", b: any = 9; return a < b ? 1 : 0;`)],
  ["null < 1", test(`const a: any = null; return a < 1 ? 1 : 0;`)],
  ["undefined < 1", test(`const a: any = undefined; return a < 1 ? 1 : 0;`)],
  [">= on any strings", test(`const a: any = "b", b: any = "a"; return (a >= b ? 1 : 0) + (b >= a ? 10 : 0);`)],
  [
    "IR-claimed top-level any comparator",
    test(`return lt("a", "b") ? 1 : 0;`, `function lt(a: any, b: any): boolean { return a < b }`),
  ],
  [
    "unknown operands",
    test(
      `const a: unknown = "b", b: unknown = "a"; return ((a as any) > (b as any) ? 1 : 0) + (lt(a, b) ? 10 : 0);`,
      `function lt(a: unknown, b: unknown): boolean { return (a as any) < (b as any) }`,
    ),
  ],
  [
    "string | boolean union",
    test(
      `return (f("b", true) ? 1 : 0) + (f("1", true) ? 10 : 0) + (f("0", true) ? 100 : 0);`,
      `function f(a: string | boolean, b: string | boolean): boolean { return a >= b }`,
    ),
  ],
  [
    "string | number against a string literal",
    test(
      `return (f("b") ? 1 : 0) + (f(5) ? 10 : 0) + (f("10") ? 100 : 0);`,
      `function f(a: string | number): boolean { return a < "9" }`,
    ),
  ],
  [
    "any object whose valueOf returns a string",
    test(`const o: any = { valueOf() { return "b" } }; const s: any = "a"; return (o > s ? 1 : 0) + (s < o ? 10 : 0);`),
  ],
  [
    "non-numeric string vs number is NaN-false both ways",
    test(`const a: any = "x"; return (a < 1 ? 1 : 0) + (a >= 1 ? 10 : 0);`),
  ],
  ["control: any numbers", test(`const a: any = 3; const b: any = 10; return (a < b ? 1 : 0) + (a > b ? 10 : 0);`)],
  [
    "numeric local against an any string (mixed → numeric)",
    test(
      `return (f("10") ? 1 : 0) + (f("2") ? 10 : 0) + (f("x") ? 100 : 0);`,
      `function f(x: any): boolean { const n = 3; return n < x }`,
    ),
  ],
  [
    "untyped JS numeric fields keep numeric semantics (NaN is incomparable)",
    test(
      `const o: any = { a: 1, b: NaN }; return (o.a < 2 ? 1 : 0) + (o.b < 2 ? 10 : 0) + (o.b >= 2 ? 100 : 0) + (o.a >= o.a ? 1000 : 0);`,
    ),
  ],
];

describe("#6999 standalone relational on dynamic strings", () => {
  for (const [name, src] of CASES) {
    it(`standalone: ${name}`, async () => {
      await assertStandaloneEquivalent(src);
    }, 60_000);
  }
});
