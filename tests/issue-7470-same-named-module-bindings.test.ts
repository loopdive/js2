// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7470 — a top-level binding of one module must not share its Wasm global with a same-named binding of another.
//
// `ctx.moduleGlobals` is keyed by bare name, and registration used to reuse the first module's `__mod_<name>` for
// every later module that declared the name, so a write in one module was read back by the other (and a number in
// one with a string in the other trapped `illegal cast`). Each row compiles a small graph with `compileMulti` and
// compares `main()` with node's answer for the same sources (recorded from node 22 on 2026-11-26), on gc and
// standalone, with the IR path on and off. Every row failed before the fix except two. "Third file never written"
// held by accident (the shared global happened to hold the right value) and broke under a partial fix. "Re-export
// with rename to k" pins that a renamed name keeps working.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

const c3 = `let g = 3; export function h(): number { return g; }`;
const depLive = `export let g = 1; export function bump(): void { g = 2; }`;
const ROWS: [name: string, node: number, files: Record<string, string>][] = [
  [
    "let | undefined, dep writes its own",
    46,
    {
      "entry.ts": `import { setG } from "./dep"; let g: number | undefined; export function main(): number { setG(); return (g ?? 4) * 10 + 6; }`,
      "dep.ts": `let g: number | undefined; export function setG(): void { g = 6; }`,
    },
  ],
  [
    "let = 0",
    6,
    {
      "entry.ts": `import { setG } from "./dep"; let g = 0; export function main(): number { setG(); return g * 10 + 6; }`,
      "dep.ts": `let g = 0; export function setG(): void { g = 6; }`,
    },
  ],
  [
    "var = 0",
    6,
    {
      "entry.ts": `import { setG } from "./dep"; var g = 0; export function main(): number { setG(); return g * 10 + 6; }`,
      "dep.ts": `var g = 0; export function setG(): void { g = 6; }`,
    },
  ],
  [
    "let 1 / let 2",
    12,
    {
      "entry.ts": `import { getG } from "./dep"; let g = 1; export function main(): number { return g * 10 + getG(); }`,
      "dep.ts": `let g = 2; export function getG(): number { return g; }`,
    },
  ],
  [
    "const",
    12,
    {
      "entry.ts": `import { getG } from "./dep"; const g = 1; export function main(): number { return g * 10 + getG(); }`,
      "dep.ts": `const g = 2; export function getG(): number { return g; }`,
    },
  ],
  [
    "string let",
    1,
    {
      "entry.ts": `import { setG } from "./dep"; let g = "a"; export function main(): number { setG(); return g === "a" ? 1 : 0; }`,
      "dep.ts": `let g = "b"; export function setG(): void { g = "c"; }`,
    },
  ],
  [
    "number here, string there",
    16,
    {
      "entry.ts": `import { getG } from "./dep"; let g = 1; export function main(): number { return g * 10 + getG().length * 6; }`,
      "dep.ts": `let g = "x"; export function getG(): string { return g; }`,
    },
  ],
  [
    "closure reads its own module's g",
    36,
    {
      "entry.ts": `import { mk } from "./dep"; let g = 3; export function main(): number { const f = mk(); return g * 10 + f(); }`,
      "dep.ts": `let g = 6; export function mk(): () => number { return () => g; }`,
    },
  ],
  [
    "class method reads its own module's g",
    36,
    {
      "entry.ts": `import { C } from "./dep"; let g = 3; export function main(): number { return g * 10 + new C().m(); }`,
      "dep.ts": `let g = 6; export class C { m(): number { return g; } }`,
    },
  ],
  [
    "each module's undefined seed",
    75,
    {
      "entry.ts": `import { getG } from "./dep"; let g: number | undefined; export function main(): number { g = 7; return g * 10 + getG(); }`,
      "dep.ts": `let g: number | undefined; export function getG(): number { return g ?? 5; }`,
    },
  ],
  [
    "named import, third file declares g",
    23,
    {
      "entry.ts": `import { g, bump } from "./dep"; import { h } from "./c"; export function main(): number { bump(); return g * 10 + h(); }`,
      "dep.ts": depLive,
      "c.ts": c3,
    },
  ],
  [
    "named import, third file first",
    23,
    {
      "entry.ts": `import { h } from "./c"; import { g, bump } from "./dep"; export function main(): number { bump(); return g * 10 + h(); }`,
      "dep.ts": depLive,
      "c.ts": c3,
    },
  ],
  [
    "named import, third file never written",
    20,
    {
      "entry.ts": `import { h } from "./c"; import { g, bump } from "./dep"; export function main(): number { bump(); return g * 10 + h(); }`,
      "dep.ts": `export let g = 0; export function bump(): void { g = 2; }`,
      "c.ts": `let g = 0; g; export function h(): number { return 0; }`,
    },
  ],
  [
    "renamed import beside an own g",
    253,
    {
      "entry.ts": `import { h } from "./c"; import { g as k, bump } from "./dep"; let g = 5; export function main(): number { bump(); return k * 100 + g * 10 + h(); }`,
      "dep.ts": depLive,
      "c.ts": c3,
    },
  ],
  [
    "default import of a live binding",
    253,
    {
      "entry.ts": `import { h } from "./c"; import d, { bump } from "./dep"; let g = 5; export function main(): number { bump(); return d * 100 + g * 10 + h(); }`,
      "dep.ts": `let g = 1; export { g as default }; export function bump(): void { g = 2; }`,
      "c.ts": c3,
    },
  ],
  // A renamed export: the entry's `g` shows dep's `x`, while c's `g` is a separate binding. These crashed codegen
  // (let) or threw a TDZ error (const) when c's statements of `__module_init` compiled under the entry's view.
  [
    "renamed export of a let, third file declares g",
    23,
    {
      "entry.ts": `import { g, bump } from "./dep"; import { h } from "./c"; export function main(): number { bump(); return g * 10 + h(); }`,
      "dep.ts": `let x = 1; export { x as g }; export function bump(): void { x = 2; }`,
      "c.ts": c3,
    },
  ],
  [
    "renamed export of a const, third file declares g",
    23,
    {
      "entry.ts": `import { g } from "./dep"; import { h } from "./c"; export function main(): number { return g * 10 + h(); }`,
      "dep.ts": `const x = 2; export { x as g };`,
      "c.ts": c3,
    },
  ],
  [
    "default export of a renamed let, imported as g",
    23,
    {
      "entry.ts": `import g, { bump } from "./dep"; import { h } from "./c"; export function main(): number { bump(); return g * 10 + h(); }`,
      "dep.ts": `let x = 1; export { x as default }; export function bump(): void { x = 2; }`,
      "c.ts": c3,
    },
  ],
  [
    "re-export with rename to k",
    23,
    {
      "entry.ts": `import { k, bump } from "./mid"; import { h } from "./c"; export function main(): number { bump(); return k * 10 + h(); }`,
      "mid.ts": `export { g as k, bump } from "./dep";`,
      "dep.ts": depLive,
      "c.ts": c3,
    },
  ],
  [
    "re-export with rename to g",
    23,
    {
      "entry.ts": `import { g, bump } from "./mid"; import { h } from "./c"; export function main(): number { bump(); return g * 10 + h(); }`,
      "mid.ts": `export { x as g, bump } from "./dep";`,
      "dep.ts": `export let x = 1; export function bump(): void { x = 2; }`,
      "c.ts": c3,
    },
  ],
  [
    "imported function beside another module's same-named one is not inlined from it",
    12,
    {
      "entry.ts": `import { f } from "./a"; import { k } from "./b"; export function main(): number { return f() * 10 + k(); }`,
      "a.ts": `export function f(): number { return 1; }`,
      "b.ts": `function f(): number { return 2; } export function k(): number { return f(); }`,
    },
  ],
  [
    "let here, class of the same name there",
    63,
    {
      "entry.ts": `import { mk } from "./dep"; let g = 6; export function main(): number { return g * 10 + mk(); }`,
      "dep.ts": `class g { v(): number { return 3; } } export function mk(): number { return new g().v(); }`,
    },
  ],
  [
    "re-export chain",
    23,
    {
      "entry.ts": `import { h } from "./c"; import { g, bump } from "./mid"; export function main(): number { bump(); return g * 10 + h(); }`,
      "mid.ts": `export { g, bump } from "./dep";`,
      "dep.ts": depLive,
      "c.ts": c3,
    },
  ],
  [
    "namespace import, third file declares g",
    23,
    {
      "entry.ts": `import { h } from "./c"; import * as d from "./dep"; export function main(): number { d.bump(); return d.g * 10 + h(); }`,
      "dep.ts": depLive,
      "c.ts": c3,
    },
  ],
  [
    "namespace import beside an own g",
    253,
    {
      "entry.ts": `import { h } from "./c"; import * as d from "./dep"; let g = 5; export function main(): number { d.bump(); return d.g * 100 + g * 10 + h(); }`,
      "dep.ts": depLive,
      "c.ts": c3,
    },
  ],
  [
    "three files: number, string, number",
    71,
    {
      "entry.ts": `import { s } from "./dep"; import { h } from "./c"; let g = 7; export function main(): number { return g * 10 + s().length - 2 + h() - 2; }`,
      "dep.ts": `let g = "abc"; export function s(): string { return g; }`,
      "c.ts": `let g = 1; g = 2; export function h(): number { return g; }`,
    },
  ],
  [
    "TDZ in both modules",
    -89,
    {
      "entry.ts": `import { early } from "./dep"; function r(): number { return g; } let x = 0; try { x = r(); } catch (e) { x = -1; } let g = 1; export function main(): number { return x * 100 + early() * 10 + g; }`,
      "dep.ts": `function r(): number { return g; } let y = 0; try { y = r(); } catch (e) { y = -1; } let g = 2; export function early(): number { return y + g; }`,
    },
  ],
  [
    "TDZ in one module only",
    17,
    {
      "entry.ts": `import { getG } from "./dep"; let g = 1; export function main(): number { return g * 10 + getG(); }`,
      "dep.ts": `function r(): number { return g; } let y = 0; try { y = r(); } catch (e) { y = 5; } let g = 2; export function getG(): number { return y + g; }`,
    },
  ],
  [
    "closure over a function-local g",
    142,
    {
      "entry.ts": `import { getG } from "./dep"; let g = 1; export function main(): number { let k = 0; function inner(): number { let g = 4; const f = () => g; return f(); } k = inner(); return g * 100 + k * 10 + getG(); }`,
      "dep.ts": `let g = 2; export function getG(): number { return g; }`,
    },
  ],
  [
    "(#7531) a non-last module's var reads undefined",
    11,
    {
      "entry.ts": `import { peek } from "./dep"; var v: any = 1; export function main(): number { return peek() * 10 + v; }`,
      "dep.ts": `var w: any; export function peek(): number { return w === undefined ? 1 : 0; }`,
    },
  ],
];

async function runMain(
  files: Record<string, string>,
  target: "gc" | "standalone",
  experimentalIR: boolean,
): Promise<number> {
  const result = await compileMulti(files, "entry.ts", { target, experimentalIR });
  expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
  const host = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : { env: host.env, string_constants: host.string_constants };
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return (instance.exports.main as () => number)();
}

// With the IR path off, a namespace import (`import * as d`) throws on `d.bump()` even in a graph with no
// same-named binding, before and after this fix: a separate defect, so those rows run with the IR path on only.
const rowsFor = (experimentalIR: boolean) =>
  experimentalIR ? ROWS : ROWS.filter(([name]) => !name.startsWith("namespace import"));

for (const target of ["gc", "standalone"] as const) {
  for (const experimentalIR of [true, false]) {
    describe(`#7470 same-named module bindings (${target}, IR ${experimentalIR ? "on" : "off"})`, () => {
      it.each(rowsFor(experimentalIR))("%s", async (_name, node, files) => {
        expect(await runMain(files, target, experimentalIR)).toBe(node);
      });
    });
  }
}
