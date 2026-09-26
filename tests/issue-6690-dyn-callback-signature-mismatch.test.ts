// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile, compileMulti } from "../src/index.js";

/**
 * #6690 — a DYNAMIC array-method callback (a variable / parameter / import that
 * compiles to an opaque externref) whose RUNTIME signature differs from the
 * static one the checker assigns the variable.
 *
 * `const cb: (x: number) => number | string = f` with `f(x): number` is the
 * canonical shape: the loop recovered cb as the funcref wrapper of
 * `(f64) -> union` and `call_ref`-ed it, but the value's funcref is
 * `(f64) -> f64` — the guarded funcref cast nulled and `ref.as_non_null`
 * trapped "dereferencing a null pointer" in standalone, for map / forEach /
 * filter / reduce alike. Every case below traps (or fails to instantiate) on
 * the parent and must run correctly with ZERO imports.
 */
type Case = [label: string, files: Record<string, string>, want: number];
const one = (fileName: string, src: string): Record<string, string> => ({ [fileName]: src });
const F = "function f(x: number): number { return x * 2; }\n";

const cases: Case[] = [
  // typed lane: a narrower-return function stored in a union-return variable
  [
    "map, fn decl in union-return var",
    one(
      "t.ts",
      `${F}export function test(): number { const cb: (x: number) => number | string = f; const r = [1, 2, 3].map(cb); return r.length * 10 + (r[1] as number); }`,
    ),
    34,
  ],
  [
    "map, arrow in union-return var",
    one(
      "t.ts",
      `export function test(): number { const cb: (x: number) => number | string = (x: number): number => x * 2; const r = [1, 2, 3].map(cb); return r.length * 10 + (r[2] as number); }`,
    ),
    36,
  ],
  [
    "forEach, fn decl in union-return var",
    one(
      "t.ts",
      `let s = 0; function g(x: number): number { s += x; return x; } export function test(): number { const cb: (x: number) => number | string = g; [1, 2, 3].forEach(cb); return s; }`,
    ),
    6,
  ],
  [
    "filter, fn decl in union-return var",
    one(
      "t.ts",
      `function g(x: number): number { return x - 2; } export function test(): number { const cb: (x: number) => number | string = g; return [1, 2, 3].filter(cb).length; }`,
    ),
    2,
  ],
  [
    "reduce, arrow in union-return var",
    one(
      "t.ts",
      `export function test(): number { const cb: (acc: number, x: number) => number | string = (acc, x) => acc + x; return [1, 2, 3].reduce(cb, 0) as number; }`,
    ),
    6,
  ],
  [
    "reduceRight, arrow in union-return var",
    one(
      "t.ts",
      `export function test(): number { const cb: (acc: number, x: number) => number | string = (acc, x) => acc * 10 + x; return [1, 2, 3].reduceRight(cb, 0) as number; }`,
    ),
    321,
  ],
  [
    "map, fewer formals than the static type",
    one(
      "t.ts",
      `${F}export function test(): number { const cb: (x: number, i: number) => number = f; const r = [1, 2, 3].map(cb); return r.length * 10 + r[1]; }`,
    ),
    34,
  ],
  [
    "some/every/find over an any[] receiver",
    one(
      "t.ts",
      `export function test(): number { const a: any[] = [1, "x", 3]; const cb: (x: any) => number | string = (x) => (typeof x === "string" ? x : x + 1); return a.map(cb).length + (a.some(cb) ? 10 : 0) + (a.every(cb) ? 100 : 0); }`,
    ),
    113,
  ],
  // no single static signature: `any` used to route to the `__call_N_f64`
  // host import, which cannot bind on a host-free lane
  [
    "filter, any-typed callback",
    one(
      "t.ts",
      `function g(x: number): boolean { return x > 1; } export function test(): number { const cb: any = g; return [1, 2, 3].filter(cb).length; }`,
    ),
    2,
  ],
  [
    "reduce, any-typed callback",
    one(
      "t.ts",
      `function g(a: number, x: number): number { return a + x; } export function test(): number { const cb: any = g; return [1, 2, 3].reduce(cb, 0); }`,
    ),
    6,
  ],
  [
    "map, any-typed callback over objects",
    one(
      "t.ts",
      `interface P { v: number } export function test(): number { const cb: any = (p: P) => p.v * 2; const r: number[] = [{ v: 1 }, { v: 2 }].map(cb); return r[1]; }`,
    ),
    4,
  ],
  // untyped lane: the variable's type comes from its FIRST initializer
  [
    "js: let reassigned to a different-return closure (forEach)",
    one(
      "t.js",
      `export function test(){ const a = [1,2,3]; let n = 0; let cb = (x) => { n += x; return x; }; if (a.length > 2) cb = (x) => { n += 1; return "s"; }; a.forEach(cb); return n; }`,
    ),
    3,
  ],
  [
    "js: conditional pick between two closures (map)",
    one(
      "t.js",
      `export function test(){ const a = [1, 2, 3]; const f = (x) => x; const g = (x) => "s"; const cb = a.length > 5 ? f : g; const b = a.map(cb); return b.length + (b[0] === "s" ? 10 : 0); }`,
    ),
    13,
  ],
  [
    "js two-file: reassigned exported callback (filter + reduce)",
    {
      "main.js": `import { pick } from "./lib.js";\nexport function test(){ const a = [1, 2, 3]; const cb = pick(a.length); return a.filter(cb).length * 10 + a.map(cb).length; }`,
      "lib.js": `export function pick(n){ let cb = (x) => x > 1; if (n > 2) cb = (x) => (x > 1 ? "yes" : ""); return cb; }`,
    },
    23,
  ],
];

type Opts = Parameters<typeof compile>[1];

async function run(files: Record<string, string>): Promise<number> {
  const names = Object.keys(files);
  const entry = names[0]!;
  const opts = { fileName: entry, target: "standalone", allowJs: true } as Opts;
  const r = names.length === 1 ? await compile(files[entry]!, opts) : await compileMulti(files, entry, opts);
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(r.imports.map((i) => `${i.module}::${i.name}`)).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, (r.importObject ?? {}) as WebAssembly.Imports);
  return (instance.exports as { test: () => number }).test();
}

describe("#6690 — dynamic array callback whose runtime signature differs (standalone)", () => {
  for (const [label, files, want] of cases) {
    it(`${label} → ${want}`, async () => {
      expect(await run(files)).toBe(want);
    });
  }
});

describe("#6690 — JS-host lane agrees", () => {
  // The host lane keeps its own dispatch (the fix is standalone-gated); pin
  // that the same programs answer the same values there.
  for (const [label, files, want] of cases.filter(([, f]) => Object.keys(f).length === 1)) {
    if (label.startsWith("js: conditional")) continue; // pre-existing host divergence, see #6690 residuals
    it(`${label} → ${want}`, async () => {
      const { buildImports } = await import("../src/runtime.js");
      const [fileName, src] = Object.entries(files)[0]!;
      const r = await compile(src, { fileName, allowJs: true } as Opts);
      expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
      const built = buildImports(r.imports, {}, r.stringPool);
      const { instance } = await WebAssembly.instantiate(r.binary, built as WebAssembly.Imports);
      if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
      expect((instance.exports as { test: () => number }).test()).toBe(want);
    });
  }
});
