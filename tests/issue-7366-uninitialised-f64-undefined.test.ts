// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7366 — an initializer-less module `let`/`var`, or a never-initialised class field, of type `number | undefined`
// sits in an f64 slot whose default was `0`, so it read `0` instead of `undefined`. The slot now starts as the
// UNDEF_F64_BITS sentinel the nullish tests of #7360 read. A plain `number` slot keeps its zero default.
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

const MAIN_STRICT = "export function main(): number { return g === undefined ? 1 : 2; }";

// [shape, program, node's `main()`]
const PROGRAMS: readonly (readonly [string, string, number])[] = [
  ["a module `let` under `===`", `let g: number | undefined; ${MAIN_STRICT}`, 1],
  ["a module `let` under `??`", "let g: number | undefined; export function main(): number { return g ?? 7; }", 7],
  ["a module `var` under `===`", `var g: number | undefined; ${MAIN_STRICT}`, 1],
  [
    "a module `let` assigned by a function later",
    "let g: number | undefined; function s(): void { g = 2; } " +
      "export function main(): number { const a = g ?? 7; s(); return a + (g ?? 7) * 100; }",
    207,
  ],
  [
    "a module `let` under `typeof`",
    "let g: number | undefined; export function main(): number { return typeof g === 'undefined' ? 1 : 2; }",
    1,
  ],
  [
    "a module `var` read before its declaration",
    "function r(): number { return g === undefined ? 1 : 2; } const a = r(); var g: number | undefined; " +
      "export function main(): number { return a; }",
    1,
  ],
  [
    "a module `var` in a block",
    "if (true) { var g: number | undefined; } export function main(): number { return g ?? 7; }",
    7,
  ],
  [
    "two `let`s in one statement",
    "let p: number | undefined, q: number | undefined; export function main(): number { q = 3; return (p ?? 7) + (q ?? 7) * 10; }",
    37,
  ],
  [
    "a module `let` later holding a genuine NaN",
    "let g: number | undefined; export function main(): number { const a = g === undefined ? 1 : 0; g = NaN; " +
      "return a + (g !== g ? 10 : 0) + (g === undefined ? 100 : 0); }",
    11,
  ],
  ["a module `let` of plain `number`", "let g: number; export function main(): number { g = 3; return g; }", 3],
  [
    "a never-initialised field",
    "class C { a: number | undefined; } export function main(): number { return new C().a === undefined ? 1 : 2; }",
    1,
  ],
  [
    "a private field",
    "class C { #a: number | undefined; get(): number { return this.#a ?? 7; } set(v: number): void { this.#a = v; } } " +
      "export function main(): number { const c = new C(); const x = c.get(); c.set(2); return x + c.get() * 100; }",
    207,
  ],
  [
    "a field the constructor reads before assigning it",
    "class C { a: number | undefined; b: number; constructor() { this.b = this.a === undefined ? 1 : 2; this.a = 5; } } " +
      "export function main(): number { const c = new C(); return c.b + (c.a ?? 0) * 10; }",
    51,
  ],
  [
    "a field the constructor assigns",
    "class C { a: number | undefined; constructor(v: number) { this.a = v; } } export function main(): number { return new C(3).a ?? 7; }",
    3,
  ],
  [
    "a subclass field",
    "class A { x = 1; } class B extends A { a: number | undefined; } " +
      "export function main(): number { return new B().a === undefined ? 1 : 2; }",
    1,
  ],
  ["an optional field", "class C { a?: number; } export function main(): number { return new C().a ?? 7; }", 7],
  [
    "plain `number` fields",
    "class C { a: number = 0; b!: number; } export function main(): number { const c = new C(); c.b = 4; return c.a + c.b; }",
    4,
  ],
  ["a local `let`", "export function main(): number { let x: number | undefined; return x === undefined ? 1 : 2; }", 1],
];

describe.each(["gc", "standalone"] as const)("#7366 — an uninitialised f64 slot holds `undefined` (%s)", (target) => {
  it.each(PROGRAMS)("%s answers like node", async (_, source, expected) => {
    expect(await runMain(source, target)).toBe(expected);
  });
});
