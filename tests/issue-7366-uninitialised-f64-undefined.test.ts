// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7366 — an initializer-less module `let`/`var`, or a never-initialised class field, of type `number | undefined`
// sits in an f64 slot whose default was `0`, so it read `0` instead of `undefined`. The slot now starts as the
// UNDEF_F64_BITS sentinel the nullish tests of #7360 read. A plain `number` slot keeps its zero default.
import { describe, expect, it } from "vitest";
import { compile, compileMulti, type CompileResult } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

type Target = "gc" | "standalone";

async function runMain(source: string, target: Target): Promise<number> {
  return instantiateMain(await compile(source, { fileName: "test.ts", target }), target);
}

async function instantiateMain(result: CompileResult, target: Target): Promise<number> {
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
  // Review round 1 (RV7320).
  [
    "a never-initialised field before an initialised one",
    "class C { a: number | undefined; y = 2; } " +
      "export function main(): number { const c = new C(); return (c.a === undefined ? 10 : 20) + c.y; }",
    12,
  ],
  [
    "a module `var` read before its initializer runs",
    "function r(): number { return g ?? 7; } const a = r(); var g: number | undefined = 5; " +
      "export function main(): number { return a * 10 + (g ?? 0); }",
    75,
  ],
  [
    "a module `var` under `typeof` before its initializer runs",
    "function r(): number { return typeof g === 'undefined' ? 1 : 2; } const a = r(); var g: number | undefined = 5; " +
      "export function main(): number { return a * 10 + (g ?? 0); }",
    15,
  ],
  [
    "a module `var` in a block, read before its initializer runs",
    "function r(): number { return g ?? 7; } const a = r(); { var g: number | undefined = 3; } " +
      "export function main(): number { return a * 10 + (g ?? 0); }",
    73,
  ],
  [
    "a module `var` assigned before its bare declaration",
    "g = 5; var g: number | undefined; export function main(): number { return g ?? 7; }",
    5,
  ],
  [
    "a top-level `for (let …)` head",
    "let r = 0; for (let g: number | undefined; r < 1; r++) { r += g === undefined ? 10 : 20; } " +
      "export function main(): number { return r; }",
    11,
  ],
  [
    "a `for (let …)` head in a function",
    "export function main(): number { let r = 0; for (let g: number | undefined; r < 3; r++) { r += g ?? 10; g = 1; } return r; }",
    11,
  ],
  [
    "a `for (let …)` head entered twice",
    "export function main(): number { let s = 0; for (let i = 0; i < 2; i++) { " +
      "for (let g: number | undefined, n = 0; n < 2; n++) { s += g ?? 50; g = 1; } } return s; }",
    102,
  ],
  [
    "a top-level `for (let …)` head captured by a closure",
    "let r = 0; let f: (() => number) | undefined; for (let g: number | undefined; r < 1; r++) { f = () => g ?? 10; r += f(); } " +
      "export function main(): number { return r; }",
    11,
  ],
  [
    "a static field under `??`",
    "class C { static a: number | undefined; } export function main(): number { return C.a ?? 7; }",
    7,
  ],
  [
    "a static field under `typeof`",
    "class C { static a: number | undefined; } export function main(): number { return typeof C.a === 'undefined' ? 1 : 2; }",
    1,
  ],
  [
    "a static field assigned later",
    "class C { static a: number | undefined; } " +
      "export function main(): number { const r = C.a ?? 7; C.a = 3; return r * 10 + (C.a ?? 0); }",
    73,
  ],
  ["an optional static field", "class C { static a?: number; } export function main(): number { return C.a ?? 7; }", 7],
  [
    "a private static field",
    "class C { static #a: number | undefined; static get(): number { return C.#a ?? 7; } } " +
      "export function main(): number { return C.get(); }",
    7,
  ],
  [
    "a static field read by a later static initializer",
    "class C { static b = 3; static a: number | undefined; static c = C.a === undefined ? 10 : 20; } " +
      "export function main(): number { return (C.a ?? 7) + C.b + C.c; }",
    20,
  ],
  [
    "an inherited static field",
    "class A { static a: number | undefined; } class B extends A {} export function main(): number { return B.a ?? 7; }",
    7,
  ],
  [
    "a static field of a class expression",
    "const C = class { static a: number | undefined; }; export function main(): number { return C.a ?? 7; }",
    7,
  ],
  [
    "a static field of plain `number`",
    "class C { static a: number; } export function main(): number { C.a = 3; return C.a; }",
    3,
  ],
];

// [shape, files, node's `main()` of `./main.ts`] — `__module_init` is one function for the whole graph, so the seed
// has to cover the files the entry imports, not only the entry.
const GRAPHS: readonly (readonly [string, Record<string, string>, number])[] = [
  [
    "a `let` of an imported file",
    {
      "./dep.ts": "export let g: number | undefined; export function get(): number { return g ?? 7; }",
      "./main.ts": "import { get } from './dep'; export function main(): number { return get(); }",
    },
    7,
  ],
  [
    "a `var` of an imported file",
    {
      "./dep.ts": "export var g: number | undefined; export function get(): number { return g === undefined ? 1 : 2; }",
      "./main.ts": "import { get } from './dep'; export function main(): number { return get(); }",
    },
    1,
  ],
  [
    "a `var` of an imported file read before its initializer runs",
    {
      "./dep.ts":
        "export function early(): number { return g ?? 7; } export const r = early(); export var g: number | undefined = 5;",
      "./main.ts": "import { r, g } from './dep'; export function main(): number { return r * 10 + (g ?? 0); }",
    },
    75,
  ],
  [
    "a static field of an imported class",
    {
      "./dep.ts": "export class C { static a: number | undefined; }",
      "./main.ts": "import { C } from './dep'; export function main(): number { return C.a ?? 7; }",
    },
    7,
  ],
  [
    "`let`s of three files",
    {
      "./a.ts": "export let x: number | undefined; export function gx(): number { return x ?? 1; }",
      "./b.ts":
        "import { gx } from './a'; export let y: number | undefined; export function gy(): number { return (y ?? 20) + gx(); }",
      "./main.ts":
        "import { gy } from './b'; let z: number | undefined; export function main(): number { return (z ?? 300) + gy(); }",
    },
    321,
  ],
];

describe.each(["gc", "standalone"] as const)("#7366 — an uninitialised f64 slot holds `undefined` (%s)", (target) => {
  it.each(PROGRAMS)("%s answers like node", async (_, source, expected) => {
    expect(await runMain(source, target)).toBe(expected);
  });

  it.each(GRAPHS)("%s answers like node", async (_, files, expected) => {
    expect(await instantiateMain(await compileMulti(files, "./main.ts", { target }), target)).toBe(expected);
  });
});
