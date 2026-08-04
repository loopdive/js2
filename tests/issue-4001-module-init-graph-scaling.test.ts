// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #4001 — the accumulated `__module_init` must be compiled and emitted a
// BOUNDED number of times, not once per source file.
//
// `ctx.moduleInitStatements` is graph-global and `collectDeclarations` fills it
// for every source before the first body compiles, so the per-source
// `compileDeclarations` loop used to compile the *whole program's* top-level
// code twice per source and `mintDefinedFunc` a fresh full-size `__module_init`
// each time. That is quadratic in both time and retained function bodies; on
// the 146-source ESLint `linter.js` graph it turned a ~4-minute compile into one
// that did not finish in 25 minutes.
//
// The guards below are structural (how many initializers exist) and
// behavioural (init still runs exactly once, in order), not timing-based, so
// they hold on a loaded CI box.

import { describe, expect, it } from "vitest";
import { compileMulti } from "../src/index.js";

/** Build an N-module graph where every module contributes top-level init. */
function graph(n: number): { files: Record<string, string>; entry: string } {
  const files: Record<string, string> = {};
  const imports: string[] = [];
  for (let i = 0; i < n; i++) {
    files[`./m${i}.ts`] = `
export const a${i} = ${i};
const c${i} = { k: a${i} + 1 };
export const d${i} = c${i}.k * 2;
export function f${i}(x: number): number { return x + d${i}; }
`;
    imports.push(`import { f${i} } from "./m${i}.js";`);
  }
  files["./main.ts"] = `${imports.join("\n")}
export const seed = 7;
export function total(): number { return ${Array.from({ length: n }, (_, i) => `f${i}(seed)`).join(" + ")}; }
`;
  return { files, entry: "./main.ts" };
}

/** Count `__module_init` function DEFINITIONS in the emitted WAT. */
function countModuleInitDefs(wat: string): number {
  return [...wat.matchAll(/\(func \$__module_init\b/g)].length;
}

/**
 * Instantiate, backfilling any import the module declares that the convenience
 * `importObject` does not supply. `string_constants` is currently missing there
 * on `main` — a separate pre-existing gap that also reds `multi-file.test.ts` —
 * and it must not silently disable these assertions.
 */
async function instantiate(binary: Uint8Array, importObject: WebAssembly.Imports): Promise<WebAssembly.Instance> {
  const imports = { ...(importObject as Record<string, Record<string, unknown>>) };
  for (const imp of WebAssembly.Module.imports(new WebAssembly.Module(binary))) {
    const mod = (imports[imp.module] ??= {});
    if (mod[imp.name] !== undefined) continue;
    if (imp.kind === "function") mod[imp.name] = () => undefined;
    else if (imp.kind === "global") mod[imp.name] = new WebAssembly.Global({ value: "externref" }, undefined);
  }
  const { instance } = await WebAssembly.instantiate(binary, imports as WebAssembly.Imports);
  return instance;
}

describe("#4001 — graph initializer is emitted once, not once per source", () => {
  it("emits exactly one __module_init however many sources the graph has", async () => {
    // The count must not track the source count. Before the fix a 6-source
    // graph carried 6 full-size initializers and a 24-source graph carried 24.
    for (const n of [2, 6, 24]) {
      const { files, entry } = graph(n);
      const result = await compileMulti(files, entry, { target: "gc" });
      expect(result.success, `n=${n}: ${result.errors.map((e) => e.message).join(" | ")}`).toBe(true);
      expect(countModuleInitDefs(result.wat), `n=${n} should carry a single __module_init`).toBe(1);
    }
  });

  it("does not grow the emitted binary superlinearly in source count", async () => {
    const small = await compileMulti(graph(4).files, "./main.ts", { target: "gc" });
    const large = await compileMulti(graph(32).files, "./main.ts", { target: "gc" });
    expect(small.success && large.success).toBe(true);

    // 8x the sources. With one initializer per source the emitted size grew
    // super-linearly because each copy held the WHOLE graph's init; with a
    // single initializer the growth is dominated by the per-source functions.
    // 8x sources must not cost more than 16x bytes — a deliberately loose
    // bound that the quadratic shape still blows through.
    const ratio = large.binary.byteLength / small.binary.byteLength;
    expect(ratio, `binary grew ${ratio.toFixed(1)}x for 8x the sources`).toBeLessThan(16);
  });

  it("still runs every module's initializer exactly once, in graph order", async () => {
    // The single surviving initializer must be the COMPLETE one. A dropped
    // module's init would change the digits; a re-run one would duplicate them.
    const result = await compileMulti(
      {
        "./a.ts": `export let log = 0;
export function bump(n: number): void { log = log * 10 + n; }
bump(1);`,
        "./b.ts": `import { bump } from "./a.js"; bump(2);`,
        "./c.ts": `import { bump } from "./a.js"; bump(3);`,
        "./main.ts": `import { log, bump } from "./a.js";
import "./b.js";
import "./c.js";
bump(4);
export function run(): number { return log; }`,
      },
      "./main.ts",
      { target: "gc" },
    );
    expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
    const instance = await instantiate(result.binary, result.importObject);
    expect((instance.exports as { run: () => number }).run()).toBe(1234);
  });

  it("preserves order-sensitive integrity state across the graph", async () => {
    // `definedPropertyFlags` / `frozenVars` encode PROGRAM ORDER, and the
    // two-pass init compile resets them deliberately (#2965/#3872). Compiling
    // the initializer a bounded number of times must not perturb that: the
    // defineProperty values below have to survive, and the freeze must not make
    // an earlier define look like a redefinition.
    const result = await compileMulti(
      {
        "./obj.ts": `export const target: { x: number; y: number } = { x: 1, y: 2 };
Object.defineProperty(target, "x", { value: 41 });
Object.freeze(target);`,
        "./main.ts": `import { target } from "./obj.js";
const other: { z: number } = { z: 3 };
Object.defineProperty(other, "z", { value: 9 });
export function run(): number { return target.x + other.z; }`,
      },
      "./main.ts",
      { target: "gc" },
    );
    expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
    const instance = await instantiate(result.binary, result.importObject);
    expect((instance.exports as { run: () => number }).run()).toBe(50);
  });

  it("still discovers module-level arrow closures for function bodies", async () => {
    // Module-init pass 1 exists to populate `closureMap` before any body
    // compiles. It now runs on the FIRST source only, so this asserts that one
    // run still covers closures declared in a LATER source.
    const result = await compileMulti(
      {
        "./dep.ts": `export const bump = (n: number): number => n + 1;
export const twice = (n: number): number => bump(bump(n));
export const base = twice(3);`,
        "./main.ts": `import { twice, base } from "./dep.js";
const local = (n: number): number => twice(n) + base;
export function run(): number { return local(2); }`,
      },
      "./main.ts",
      { target: "gc" },
    );
    expect(result.success, result.errors.map((e) => e.message).join(" | ")).toBe(true);
    const instance = await instantiate(result.binary, result.importObject);
    expect((instance.exports as { run: () => number }).run()).toBe(9);
  });
});
