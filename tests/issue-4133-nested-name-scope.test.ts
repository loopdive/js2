// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4133 (nested layer) — a NESTED function declaration's bare name must not
// capture calls in other modules.
//
// `ctx.funcMap` and `ctx.closureMap` are keyed by BARE name and are global for
// the whole graph, but a nested declaration is in scope only inside its
// enclosing function. Without a scope check, an unrelated module calling its
// own `equal` was retargeted to a nested `equal` from a different package —
// and, because nested functions take their captures as leading synthetic
// params, the call site also prepended THAT function's captures read from the
// declaring frame.
//
// Real-world instance: uri-js's UMD factory declares a nested `equal` that
// captures `SCHEMES`/`URI_PARSE`/`UNRESERVED`; ESLint's rule-tester calls
// fast-deep-equal's `equal`. The compile emitted `local.get 51` into a 4-slot
// frame and died at binary emit.
//
// NON-VACUITY: on the unfixed base the first rung returns 1000 — `factory()`
// evaluates to 0 because its own nested `equal` lost to the other module's —
// where node gives 1306. It compiles and validates cleanly either way, so only
// the VALUE detects it.

import { describe, expect, it } from "vitest";

import { compileMulti } from "../src/index.js";

async function run(files: Record<string, string>, entry: string): Promise<Record<string, unknown>> {
  const result = await compileMulti(files, entry, { target: "gc" });
  expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
  const imports = { ...(result.importObject as Record<string, Record<string, unknown>>) };
  for (const imp of WebAssembly.Module.imports(new WebAssembly.Module(result.binary))) {
    const mod = (imports[imp.module] ??= {});
    if (mod[imp.name] !== undefined) continue;
    if (imp.kind === "function") mod[imp.name] = () => undefined;
    else if (imp.kind === "global") mod[imp.name] = new WebAssembly.Global({ value: "externref" }, undefined);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, imports as WebAssembly.Imports);
  return instance.exports as Record<string, unknown>;
}

/** Wide enough that the captured slots sit past any sibling's own frame. */
const WIDE = Array.from({ length: 20 }, (_, i) => `  const p${i} = ${i};`).join("\n");
const SINK = Array.from({ length: 20 }, (_, i) => `p${i}`).join(" + ");

// uri-js shaped: a factory whose nested `equal` captures factory locals.
const FACTORY = `
export function factory(): number {
${WIDE}
  const SCHEMES = 100;
  const TABLE = 200;
  function equal(a: number, b: number): number { return a + b + SCHEMES + TABLE; }
  function useIt(v: number): number { return equal(v, 1); }
  const sink = ${SINK};
  return useIt(5) + sink * 0;
}`;

const ENTRY = `import { factory } from "./a.js";
import { equal } from "./b.js";
function assertASTDidntChange(x: number, y: number): number { return equal(x, y); }
export function main(): number { return factory() + assertASTDidntChange(3, 3) * 1000; }`;

describe("#4133 — a nested declaration's name is scoped to its enclosing function", () => {
  it("another module's `equal` (a named function expression) is not captured by it", async () => {
    const exports = await run(
      {
        "./a.ts": FACTORY,
        // fast-deep-equal's real shape: a named function EXPRESSION.
        "./b.ts": `export const equal = function equal(a: number, b: number): number { return a === b ? 1 : 0; };`,
        "./main.ts": ENTRY,
      },
      "./main.ts",
    );
    // node: factory() = equal(5,1) = 5+1+300 = 306; assert(3,3) = 1 -> 1306.
    expect((exports.main as () => number)()).toBe(1306);
  });

  it("the nested function still wins for calls inside its own factory", async () => {
    const exports = await run(
      {
        "./a.ts": FACTORY,
        "./b.ts": `export const equal = function equal(a: number, b: number): number { return a === b ? 1 : 0; };`,
        "./main.ts": `import { factory } from "./a.js";
export function main(): number { return factory(); }`,
      },
      "./main.ts",
    );
    expect((exports.main as () => number)()).toBe(306);
  });

  it("captures a lexical value that collides with an unrelated function name", async () => {
    const exports = await run(
      {
        "./a.ts": `export function f(): number { return 99; }`,
        "./b.ts": `export function run(): number {
  const f = [2, 3];
  function y(): number { return f.map((value) => value + 1).length + f[0]! * 10; }
  return y();
}`,
        "./main.ts": `import { f } from "./a.js";
import { run } from "./b.js";
export function main(): number { return run() + f() * 0; }`,
      },
      "./main.ts",
    );
    expect((exports.main as () => number)()).toBe(22);
  });
});
