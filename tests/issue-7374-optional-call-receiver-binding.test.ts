// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7374 — `g()?.toFixed(0)` and `new C().a?.toFixed(0)` returned `undefined` for a defined receiver: the optional call
// dispatched through the receiver-method ladder, which re-reads its receiver, so only an identifier or `this` was
// taken. The ladder now reads the receiver value the nullish test already evaluated, so a call or getter runs once.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

async function runMain(source: string, target: Target): Promise<number> {
  const result = await compile(source, { fileName: "test.ts", target });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: built.env, string_constants: built.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

// [shape, program, node's `main()`]
const PROGRAMS: readonly (readonly [string, string, number])[] = [
  [
    "a call receiver that returns a number runs once",
    "let n = 0; function g(): number | undefined { n++; return 2; } " +
      "export function main(): number { const r = g()?.toFixed(0); return (r === '2' ? 1 : 0) + n * 10; }",
    11,
  ],
  [
    "a call receiver that returns `undefined` runs once",
    "let n = 0; function g(): number | undefined { n++; return undefined; } " +
      "export function main(): number { const r = g()?.toFixed(0); return (r === undefined ? 1 : 0) + n * 10; }",
    11,
  ],
  [
    "a `number | null` call receiver",
    "let n = 0; function g(k: number): number | null { n++; return k > 0 ? k : null; } " +
      "export function main(): number { " +
      "return (g(5)?.toFixed(0) === '5' ? 1 : 0) + (g(0)?.toFixed(0) === undefined ? 10 : 0) + n * 100; }",
    211,
  ],
  [
    "a call receiver whose argument has a side effect, in order",
    "let log = ''; function g(): number | undefined { log += 'g'; return 3; } " +
      "function d(): number { log += 'd'; return 2; } " +
      "export function main(): number { const r = g()?.toFixed(d()); return (r === '3.00' ? 1 : 0) + (log === 'gd' ? 10 : 0); }",
    11,
  ],
  [
    "a defined class field",
    "class C { a: number | undefined = 4; } export function main(): number { return new C().a?.toFixed(0) === '4' ? 1 : 0; }",
    1,
  ],
  [
    "an undefined class field",
    "class C { a: number | undefined = undefined; } " +
      "export function main(): number { return new C().a?.toFixed(0) === undefined ? 1 : 0; }",
    1,
  ],
  [
    "a getter receiver is read once",
    "let reads = 0; const o = { get v(): number | undefined { reads++; return 7; } }; " +
      "export function main(): number { const r = o.v?.toFixed(1); return (r === '7.0' ? 1 : 0) + reads * 10; }",
    11,
  ],
  [
    "`this.a?.toFixed()` in a method",
    "class C { a: number | undefined = 3; m() { return this.a?.toFixed(1); } } " +
      "export function main(): number { return new C().m() === '3.0' ? 1 : 0; }",
    1,
  ],
  [
    "an element receiver evaluates its index once",
    "let n = 0; const a: (number | undefined)[] = [1.5, undefined]; function i(k: number) { n++; return k; } " +
      "export function main(): number { " +
      "return (a[i(0)]?.toFixed(1) === '1.5' ? 1 : 0) + (a[i(1)]?.toFixed(1) === undefined ? 10 : 0) + n * 100; }",
    211,
  ],
  [
    "a nested optional chain",
    "let n = 0; const a = () => ({ b(): number | undefined { n++; return 6; } }); " +
      "export function main(): number { return (a()?.b()?.toFixed(0) === '6' ? 1 : 0) + n * 10; }",
    11,
  ],
  [
    "a dynamic getter receiver is read once",
    "let reads = 0; const box: any = { get value() { reads++; return 'abc'; } }; " +
      "export function main(): number { const r = box.value?.at(-1); return (r === 'c' ? 1 : 0) + reads * 10; }",
    11,
  ],
  [
    "a #7370 identifier receiver still calls",
    "function f(x: number | undefined) { return x?.toFixed(1); } " +
      "export function main(): number { return (f(2) === '2.0' ? 1 : 0) + (f(undefined) === undefined ? 10 : 0); }",
    11,
  ],
];

describe.each(["gc", "standalone"] as const)("#7374 — `?.` binds a non-repeatable receiver once (%s)", (target) => {
  it.each(PROGRAMS)("%s answers like node", async (_, source, expected) => {
    expect(await runMain(source, target)).toBe(expected);
  });
});
