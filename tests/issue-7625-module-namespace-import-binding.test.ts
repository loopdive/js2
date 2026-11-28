// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7625 — a binding that names a module namespace through an import must read that namespace object.
//
// `import { ns } from "./mid"`, where mid has `export * as ns from "./dep"` (or `import * as ns …; export { ns }`),
// compiled to `ref.null extern`, so every use threw. Separately, two routes to one module's namespace built two
// objects. Each row compiles a small graph with `compileMulti` and compares `main()` with node's answer for the same
// sources (recorded from node 22 on 2026-11-28), on gc and standalone, with the IR path on and off.
//
// The identity rows return `10 * (a is non-null) + (a === b)` and are decoded into two separate assertions, so a null
// namespace cannot pass by being `===` to another null.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const mid = `export * as ns from "./dep";`;
const dep = `export let g = 7;`;
const readsG = (binding: string) => `export function main(): number { return ${binding}.g * 10 + 3; }`;
const identityOf = (a: string, b: string) =>
  `export function main(): number { const a: any = ${a}; const b: any = ${b}; ` +
  `return (a !== null && a !== undefined ? 10 : 0) + (a === b ? 1 : 0); }`;

interface Row {
  readonly name: string;
  readonly node: number;
  readonly files: Record<string, string>;
  /** `main()` encodes `10 * nonNull + same`; assert the two facts separately. */
  readonly identity?: true;
  /**
   * The row calls a namespace function (`ns.f()`), which with the IR path off throws until #7622 builds the IR
   * identity context without `experimentalIR`. That cell is an expected failure until #7622 lands.
   */
  readonly needs7622?: true;
}

const ROWS: readonly Row[] = [
  {
    name: "a_read",
    node: 73,
    files: { "entry.ts": `import { ns } from "./mid"; ${readsG("ns")}`, "mid.ts": mid, "dep.ts": dep },
  },
  {
    name: "a_renamed_import",
    node: 73,
    files: { "entry.ts": `import { ns as q } from "./mid"; ${readsG("q")}`, "mid.ts": mid, "dep.ts": dep },
  },
  {
    name: "a_renamed_reexport",
    node: 73,
    files: {
      "entry.ts": `import { m2 } from "./mid2"; ${readsG("m2")}`,
      "mid2.ts": `export { ns as m2 } from "./mid";`,
      "mid.ts": mid,
      "dep.ts": dep,
    },
  },
  {
    name: "a_export_star_carries",
    node: 73,
    files: {
      "entry.ts": `import { ns } from "./mid2"; ${readsG("ns")}`,
      "mid2.ts": `export * from "./mid";`,
      "mid.ts": mid,
      "dep.ts": dep,
    },
  },
  {
    name: "a_as_value",
    node: 73,
    files: {
      "entry.ts": `import { ns } from "./mid"; function take(o: any): number { return o.g; } export function main(): number { return take(ns) * 10 + 3; }`,
      "mid.ts": mid,
      "dep.ts": dep,
    },
  },
  {
    name: "a_keys",
    node: 13,
    files: {
      "entry.ts": `import { ns } from "./mid"; export function main(): number { const k = Object.keys(ns); return k.length * 10 + (k[0] === "g" ? 3 : 0); }`,
      "mid.ts": mid,
      "dep.ts": dep,
    },
  },
  {
    name: "n2 (import * as ns; export { ns })",
    node: 73,
    files: {
      "entry.ts": `import { ns } from "./mid"; ${readsG("ns")}`,
      "mid.ts": `import * as ns from "./dep"; export { ns };`,
      "dep.ts": dep,
    },
  },
  {
    name: "n3 (dep exports only a const)",
    node: 73,
    files: {
      "entry.ts": `import { ns } from "./mid"; ${readsG("ns")}`,
      "mid.ts": mid,
      "dep.ts": `export const g = 7;`,
    },
  },
  {
    name: "n4 (dep exports only a function)",
    node: 73,
    needs7622: true,
    files: {
      "entry.ts": `import { ns } from "./mid"; export function main(): number { return ns.f() * 10 + 3; }`,
      "mid.ts": mid,
      "dep.ts": `export function f(): number { return 7; }`,
    },
  },
  {
    name: "n1 guard (nested m.ns)",
    node: 73,
    files: { "entry.ts": `import * as m from "./mid"; ${readsG("m.ns")}`, "mid.ts": mid, "dep.ts": dep },
  },
  {
    name: "n5 guard (typeof ns)",
    node: 1,
    files: {
      "entry.ts": `import { ns } from "./mid"; export function main(): number { return typeof ns === "object" ? 1 : 0; }`,
      "mid.ts": mid,
      "dep.ts": `export const g = 7;`,
    },
  },
  {
    name: "a_id_nonnull_vs_nested",
    node: 11,
    identity: true,
    files: {
      "entry.ts": `import * as d from "./dep"; import * as m from "./mid"; ${identityOf("d", "m.ns")}`,
      "mid.ts": mid,
      "dep.ts": dep,
    },
  },
  {
    name: "a_id_nonnull_two_files",
    node: 11,
    identity: true,
    files: {
      "entry.ts": `import * as d from "./dep"; import { e } from "./other"; ${identityOf("d", "e()")}`,
      "other.ts": `import * as d2 from "./dep"; export function e(): any { return d2; }`,
      "dep.ts": dep,
    },
  },
  {
    name: "a_id_named_vs_star",
    node: 11,
    identity: true,
    files: {
      "entry.ts": `import { ns } from "./mid"; import * as d from "./dep"; ${identityOf("ns", "d")}`,
      "mid.ts": mid,
      "dep.ts": dep,
    },
  },
  // A module augmentation merges a `ModuleDeclaration` into dep's module symbol. That symbol must stay on the module
  // namespace path, never on the TypeScript-`namespace` path, whose namespace objects share the same cache.
  {
    name: "module augmentation keeps the module namespace path",
    node: 73,
    needs7622: true,
    files: {
      "entry.ts": `import * as d from "./dep"; declare module "./dep" { export function h(): number; } export function main(): number { return d.f() * 10 + 3; }`,
      "dep.ts": `export function f(): number { return 7; }`,
    },
  },
];

async function runMain(files: Record<string, string>, target: "gc" | "standalone", experimentalIR: boolean) {
  const result = await compileMulti(files, "entry.ts", { target, experimentalIR });
  expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
  const host = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: host.env, string_constants: host.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

const decoded = (row: Row, value: number) =>
  row.identity ? { nonNull: Math.floor(value / 10) === 1, same: value % 10 === 1 } : value;

for (const target of ["gc", "standalone"] as const) {
  for (const experimentalIR of [true, false]) {
    describe(`#7625 module namespace import bindings (${target}, IR ${experimentalIR ? "on" : "off"})`, () => {
      for (const row of ROWS) {
        const test = row.needs7622 && !experimentalIR ? it.fails : it;
        test(row.name, async () => {
          expect(decoded(row, await runMain(row.files, target, experimentalIR))).toEqual(decoded(row, row.node));
        });
      }
    });
  }
}
