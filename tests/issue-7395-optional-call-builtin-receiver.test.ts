// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7395 — `s?.toUpperCase()`, `a?.push(3)` and `m?.get(k)` on a defined string, array, Map or Set receiver returned
// `undefined` (or skipped the call): the optional-call lowering had no arm for a built-in receiver, its string arm
// was gated on the retired `ctx.fast` mode, and the native Map/Set dispatch read the receiver as `T | undefined`.
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
    "string `toUpperCase` on a parameter",
    "function f(s: string | undefined) { return s?.toUpperCase(); } " +
      "export function main(): number { return (f('abc') === 'ABC' ? 1 : 0) + (f(undefined) === undefined ? 10 : 0); }",
    11,
  ],
  [
    "string `slice` on a field",
    "class W { s: string | undefined; constructor(s: string | undefined) { this.s = s; } } " +
      "function f(w: W) { return w.s?.slice(1); } " +
      "export function main(): number { return (f(new W('abc')) === 'bc' ? 1 : 0) + (f(new W(undefined)) === undefined ? 10 : 0); }",
    11,
  ],
  [
    "string `indexOf` (an i32 result) on a parameter",
    "function f(s: string | undefined) { return s?.indexOf('b'); } " +
      "export function main(): number { return (f('abc') === 1 ? 1 : 0) + (f(undefined) === undefined ? 10 : 0); }",
    11,
  ],
  [
    "string `charAt` on a getter runs the getter once",
    "class C { n = 0; get s(): string | undefined { this.n++; return 'xy'; } } " +
      "export function main(): number { const c = new C(); const r = c.s?.charAt(1); return (r === 'y' ? 1 : 0) + c.n * 10; }",
    11,
  ],
  [
    "array `push` with the result dropped",
    "function f(a: number[] | undefined): number { a?.push(3); return a ? a.length : -1; } " +
      "export function main(): number { return f([1, 2]) * 10 + (f(undefined) === -1 ? 1 : 0); }",
    31,
  ],
  [
    "array `join` on a module global",
    "let g: string[] | undefined = ['p', 'q']; function set(v: string[] | undefined) { g = v; } " +
      "export function main(): number { const d = g?.join('+'); set(undefined); const u = g?.join('+'); " +
      "return (d === 'p+q' ? 1 : 0) + (u === undefined ? 10 : 0); }",
    11,
  ],
  [
    "array `indexOf` through a property chain",
    "function f(o: { a: number[] | undefined }) { return o.a?.indexOf(2); } " +
      "export function main(): number { return (f({ a: [1, 2] }) === 1 ? 1 : 0) + (f({ a: undefined }) === undefined ? 10 : 0); }",
    11,
  ],
  [
    "Map `get` (an anyref result) on a parameter",
    "function f(m: Map<string, number> | undefined) { return m?.get('k'); } " +
      "export function main(): number { return (f(new Map([['k', 7]])) === 7 ? 1 : 0) + (f(undefined) === undefined ? 10 : 0); }",
    11,
  ],
  [
    "Map `set` on a parameter",
    "function f(m: Map<string, number> | undefined): number { m?.set('z', 1); return m ? m.size : -1; } " +
      "export function main(): number { return f(new Map()) * 10 + (f(undefined) === -1 ? 1 : 0); }",
    11,
  ],
  [
    "Set `add` on a field",
    "class W { s: Set<number> | undefined = new Set([5]); } " +
      "export function main(): number { const w = new W(); w.s?.add(6); return w.s!.size; }",
    2,
  ],
  [
    "Set `has` tested directly",
    "function f(s: Set<number> | undefined): number { return s?.has(1) ? 1 : 0; } " +
      "export function main(): number { return f(new Set([1])) + f(undefined) * 10; }",
    1,
  ],
  // #7401's three reproducers, verbatim.
  [
    "local Set `add`",
    "export function main(): number { const s: Set<number> | undefined = new Set([1]); s?.add(5); return s!.size; }",
    2,
  ],
  [
    "local Map `set`",
    "export function main(): number { const m: Map<string, number> | undefined = new Map(); m?.set('a', 1); return m!.size; }",
    1,
  ],
  [
    "local Set `has`",
    "export function main(): number { const s: Set<number> | undefined = new Set([1]); return s?.has(1) ? 1 : 0; }",
    1,
  ],
];

describe.each(["gc", "standalone"] as const)("#7395 — `?.` calls a method on a built-in receiver (%s)", (target) => {
  it.each(PROGRAMS)("%s answers like node", async (_, source, expected) => {
    expect(await runMain(source, target)).toBe(expected);
  });
});
