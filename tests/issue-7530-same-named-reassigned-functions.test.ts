// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7530 — a reassigned top-level function of one module must not share its live-binding global with a same-named
// function of another.
//
// Registration minted one `__mod_<name>` per NAME and marked the name live graph-wide, so a module whose own `f` is
// never reassigned still read another module's reassigned `f`. Each row compiles a small graph with `compileMulti`
// and compares `main()` with node's answer for the same sources (node 22, 2026-11-28), on gc and standalone, with
// the IR path on and off. The rows under "fixed" failed before the change; the rows under "kept" passed before it
// and pin what must not move.
//
// Three shapes read differently from the issue's rows, for defects that need no name clash:
// - D calls `get` before the module that declares `swap` reassigns `f`, so `get`'s call stays direct (the same
//   answer in one file). Row D′ declares `swap` first and pins the clash.
// - G and I call a renamed import (`k()`) of a reassigned function, which stays direct even with no clash, and in I
//   the call is inlined from the third file's own `k` (#7621). G and I read `k` as a value here (`const h = k`); I
//   read that way passed before, and is kept.

import { describe, expect, it } from "vitest";

import { compile, compileMulti } from "../src/index.js";
import { buildCompiledImports, buildImports } from "../src/runtime.js";

const depSwapsExported = `export function f(): number { return 1; } export function swap(): void { f = () => 2; }`;
const depCallF = `function f(): number { return 4; } export function callF(): number { return f(); }`;
const depBlockF = `export function d(): number { let r = 0; { function f(): number { return 3; } r = f(); } return r; }`;

const FIXED: [name: string, node: number, files: Record<string, string>][] = [
  [
    "A dep reassigns its own f; entry calls its own f",
    12,
    {
      "entry.ts": `import { swap } from "./dep"; function f(): number { return 1; } export function main(): number { swap(); return f() * 10 + 2; }`,
      "dep.ts": `function f(): number { return 3; } export function swap(): void { f = () => 4; }`,
    },
  ],
  [
    "C both reassign their own f",
    24,
    {
      "entry.ts": `import { swap, callF } from "./dep"; function f(): number { return 1; } export function main(): number { f = () => 2; swap(); return f() * 10 + callF(); }`,
      "dep.ts": `function f(): number { return 3; } export function swap(): void { f = () => 4; } export function callF(): number { return f(); }`,
    },
  ],
  [
    "D′ dep reads its own f before and after its swap",
    314,
    {
      "entry.ts": `import { get, swap } from "./dep"; function f(): number { return 1; } export function main(): number { const a = get(); swap(); return a * 100 + f() * 10 + get(); }`,
      "dep.ts": `function f(): number { return 3; } export function swap(): void { f = () => 4; } export function get(): number { return f(); }`,
    },
  ],
  [
    "F import of a reassigned f, and a third file's own f",
    125,
    {
      "entry.ts": `import { f, swap } from "./dep"; import { h } from "./c"; export function main(): number { const a = f(); swap(); return a * 100 + f() * 10 + h(); }`,
      "dep.ts": depSwapsExported,
      "c.ts": `function f(): number { return 5; } export function h(): number { return f(); }`,
    },
  ],
  [
    "G renamed import k of a reassigned f, read as a value, beside the entry's own f",
    127,
    {
      "entry.ts": `import { f as k, swap } from "./dep"; function f(): number { return 7; } export function main(): number { const a = k(); swap(); const h = k; return a * 100 + h() * 10 + f(); }`,
      "dep.ts": depSwapsExported,
    },
  ],
  [
    "H entry imports a never-reassigned f; dep reassigns its own f",
    12,
    {
      "entry.ts": `import { f } from "./lib"; import { swap } from "./dep"; export function main(): number { swap(); return f() * 10 + 2; }`,
      "lib.ts": `export function f(): number { return 1; }`,
      "dep.ts": `function f(): number { return 3; } export function swap(): void { f = () => 4; }`,
    },
  ],
  [
    "X dep reassigns its own f inside a returned closure",
    12,
    {
      "entry.ts": `import { mk } from "./dep"; function f(): number { return 1; } export function main(): number { mk()(); return f() * 10 + 2; }`,
      "dep.ts": `function f(): number { return 3; } export function mk(): () => void { return () => { f = () => 4; }; }`,
    },
  ],
  [
    "Y2 cyclic import, both files declare f; dep reassigns its own",
    41,
    {
      "entry.ts": `import { g } from "./dep"; function f(): number { return 1; } export function k(): number { return f(); } export function main(): number { return g() * 10 + f(); }`,
      "dep.ts": `import { k } from "./entry"; function f(): number { return 3; } export function g(): number { f = () => 4; return f() + k() * 0; }`,
    },
  ],
  [
    "Z dep's module init calls, then reassigns, its own f",
    31,
    {
      "entry.ts": `import { r } from "./dep"; function f(): number { return 1; } export function main(): number { return r * 10 + f(); }`,
      "dep.ts": `function f(): number { return 3; } export const r = f(); f = () => 4;`,
    },
  ],
];

const KEPT: [name: string, node: number, files: Record<string, string>][] = [
  [
    "I renamed import k of a reassigned f, read as a value; a third file's own k",
    25,
    {
      "entry.ts": `import { f as k, swap } from "./dep"; import { h } from "./c"; export function main(): number { swap(); const g = k; return g() * 10 + h(); }`,
      "dep.ts": depSwapsExported,
      "c.ts": `function k(): number { return 5; } export function h(): number { return k(); }`,
    },
  ],
  [
    "B entry reassigns its own f; dep calls its own f",
    34,
    {
      "entry.ts": `import { callF } from "./dep"; function f(): number { return 1; } export function main(): number { f = () => 3; return f() * 10 + callF(); }`,
      "dep.ts": depCallF,
    },
  ],
  [
    "B2 entry reads, then reassigns its own f",
    14,
    {
      "entry.ts": `import { callF } from "./dep"; function f(): number { return 1; } export function main(): number { const a = f(); f = () => 3; return a * 10 + callF(); }`,
      "dep.ts": depCallF,
    },
  ],
  [
    "B3 entry reassigns its own f, then dep calls its own f",
    42,
    {
      "entry.ts": `import { callF } from "./dep"; function f(): number { return 1; } export function main(): number { f = () => 3; return callF() * 10 + 2; }`,
      "dep.ts": depCallF,
    },
  ],
  [
    "E import of a reassigned f, no clash",
    12,
    {
      "entry.ts": `import { f, swap } from "./dep"; export function main(): number { const a = f(); swap(); return a * 10 + f(); }`,
      "dep.ts": depSwapsExported,
    },
  ],
  [
    "Y3 cyclic import: dep reassigns its exported f",
    12,
    {
      "entry.ts": `import { f, swap } from "./dep"; export const base = 10; export function main(): number { const a = f(); swap(); return a * 10 + f(); }`,
      "dep.ts": `import { base } from "./entry"; export function f(): number { return 1; } export function swap(): void { f = () => 2 + base * 0; }`,
    },
  ],
  [
    "Y5 lib reassigns, dep imports f from lib",
    15,
    {
      "entry.ts": `import { g } from "./dep"; import { swap } from "./lib"; export function main(): number { const a = g(); swap(); return a * 10 + g(); }`,
      "lib.ts": `export function f(): number { return 1; } export function swap(): void { f = () => 5; }`,
      "dep.ts": `import { f } from "./lib"; export function g(): number { return f(); }`,
    },
  ],
  [
    "AB2 block function f in a module beside let f in another",
    23,
    {
      "entry.ts": `import { d } from "./dep"; let f = 1; export function main(): number { f = 2; return f * 10 + d(); }`,
      "dep.ts": depBlockF,
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

// A Script whose top-level `f` is live only because eval may rebind it, with an Annex B block `f` joining the same
// binding. Its `.call` keeps the named-this trampoline (#6880) only while the binding stays eval-only; marked as
// assigned, the call drops its receiver and the initializer throws. With the IR path off the receiver is dropped
// before and after this change, so the row runs with the IR path on only.
const ANNEX_B_EVAL_ONLY = `
function never(s) { return eval(s); }
var o = {};
function f() { "use strict"; return this === o; }
{ function f() { "use strict"; return this === o; } }
if (!f.call(o)) throw new TypeError("receiver dropped");
`;

async function instantiateScript(source: string, target: "gc" | "standalone"): Promise<void> {
  const result = await compile(source, { fileName: "issue-7530.js", target, experimentalIR: true });
  expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
  const imports = buildCompiledImports(result) as Record<string, unknown> & {
    setInstance?: (instance: WebAssembly.Instance) => void;
  };
  // The eval never runs; its provider imports only need to link.
  const evalStub: Record<string, () => never> = {};
  for (const entry of WebAssembly.Module.imports(new WebAssembly.Module(result.binary))) {
    if (entry.module !== "js2wasm:runtime-eval") continue;
    evalStub[entry.name] = () => {
      throw new Error(`unexpected runtime-eval call: ${entry.name}`);
    };
  }
  if (Object.keys(evalStub).length > 0) imports["js2wasm:runtime-eval"] = evalStub;
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  imports.setInstance?.(instance);
}

for (const target of ["gc", "standalone"] as const) {
  for (const experimentalIR of [true, false]) {
    const lane = `${target}, IR ${experimentalIR ? "on" : "off"}`;
    describe(`#7530 same-named reassigned functions (${lane})`, () => {
      it.each(FIXED)("fixed: %s", async (_name, node, files) => {
        expect(await runMain(files, target, experimentalIR)).toBe(node);
      });
      it.each(KEPT)("kept: %s", async (_name, node, files) => {
        expect(await runMain(files, target, experimentalIR)).toBe(node);
      });
      if (experimentalIR) {
        it("kept: an Annex B block function keeps an eval-only binding eval-only", async () => {
          await instantiateScript(ANNEX_B_EVAL_ONLY, target);
        });
      }
    });
  }
}
