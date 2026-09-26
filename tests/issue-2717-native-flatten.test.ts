// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2717 — the Wasm-native recursive FlattenIntoArray (`array-flat-native.ts`)
 * for `--target standalone`.
 *
 * Before it, standalone had only a depth-1 homogeneous-vec `flat()` and an
 * array-returning `flatMap`; everything else either refused to compile
 * (`[path].flat()` over an `any` element — hono's first standalone-dynamic
 * blocker; any explicit depth) or, on an `any` receiver, answered a silent
 * `undefined`/`0` through the closed-method dispatcher. Every case below is
 * a compile error or a wrong value on the parent, and must run correctly
 * here with ZERO imports (no `__array_flat*` host import in standalone).
 */
const cases: Array<[string, "t.js" | "t.ts", string, number]> = [
  // hono: `[path].flat()` where `path` is `any` (string OR string[]).
  [
    "[anyString].flat()",
    "t.js",
    `function id(x){ return x; } export function test(){ const p = id("/a"); let n = 0; for (const q of [p].flat()) n++; return n; }`,
    1,
  ],
  [
    "[anyArray].flat()",
    "t.js",
    `function id(x){ return x; } export function test(){ const p = id(["/a","/b"]); let n = 0; for (const q of [p].flat()) n++; return n; }`,
    2,
  ],
  [
    "any receiver .flat()",
    "t.js",
    `function id(x){ return x; } export function test(){ return id([1,[2,3],[4]]).flat().length; }`,
    4,
  ],
  [
    "any receiver .flat(Infinity)",
    "t.js",
    `function id(x){ return x; } export function test(){ return id([1,[2,[3,[4,[5]]]]]).flat(Infinity).length; }`,
    5,
  ],
  [
    "map(...).flat() over any",
    "t.js",
    `function id(x){ return x; } export function test(){ return id([{c:[1,2]},{}]).map((h) => h.c || []).flat().length; }`,
    2,
  ],
  [
    "any receiver .flatMap spread",
    "t.js",
    `function id(x){ return x; } export function test(){ return [1, ...id(["x","y"]).flatMap((v) => [" ", v])].length; }`,
    5,
  ],
  [
    "literal nested flat(Infinity) and flat()",
    "t.js",
    `export function test(){ const a = [1,[2,[3,[4]]]]; return a.flat(Infinity).length * 10 + a.flat().length; }`,
    43,
  ],
  ["holes are skipped", "t.js", `export function test(){ return [1,,[2,,3]].flat().length; }`, 3],
  ["negative depth is 0", "t.js", `export function test(){ return [1,[2,[3]]].flat(-1).length; }`, 2],
  [
    "heterogeneous element values survive",
    "t.js",
    `export function test(){ const b = [1,[2,[3]],"x"].flat(2); return b[0] + b[1]*10 + b[2]*100 + (b[3] === "x" ? 1000 : 0); }`,
    1321,
  ],
  [
    "typed number[][][] flat(2)",
    "t.ts",
    `export function test(): number { const a: number[][][] = [[[1],[2]],[[3]]]; return a.flat(2).length; }`,
    3,
  ],
  [
    "typed number[][] flat(1) element sum",
    "t.ts",
    `export function test(): number { const a: number[][] = [[1],[2,3]]; const b = a.flat(1); return b[0] + b[1] + b[2]; }`,
    6,
  ],
  [
    "typed flatMap with a scalar-or-array callback variable",
    "t.ts",
    `export function test(): number { const a: number[] = [1, 2, 3]; const cb: (x: number) => number | number[] = (x) => (x === 2 ? [x, x] : x); const b = a.flatMap(cb); return b.length * 10 + (b[1] as number); }`,
    42,
  ],
  [
    "Array.prototype.flat.call on an array-like",
    "t.js",
    `export function test(){ return Array.prototype.flat.call({ length: 2, 0: [1, 2], 1: 3 }).length; }`,
    3,
  ],
];

type Opts = Parameters<typeof compile>[1];

describe("#2717 — native recursive flat/flatMap in standalone", () => {
  for (const [label, fileName, src, want] of cases) {
    it(`${label} → ${want}, zero imports`, async () => {
      const r = await compile(src, {
        fileName,
        target: "standalone",
        allowJs: true,
      } as Opts);
      expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(r.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
      const { instance } = await WebAssembly.instantiate(r.binary, (r.importObject ?? {}) as WebAssembly.Imports);
      expect((instance.exports as { test: () => number }).test()).toBe(want);
    });
  }
});
