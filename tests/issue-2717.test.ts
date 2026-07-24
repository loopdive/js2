// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2717 — Array.prototype.flat / flatMap on the host-free lanes.
 *
 * Originally both delegated to the host imports `__array_flat` / `__array_flatMap`
 * with no `ctx.standalone` guard, so under `--target standalone`/`wasi` (no JS
 * host) the emitted module failed to instantiate. #3363 added a native depth-1
 * homogeneous flatten for `flat()`, and this issue adds the native `flatMap`
 * arm: `flatMap(cb)` ≡ `map(cb).flat(1)`, reusing the native `map` + that
 * depth-1 flatten.
 *
 * Current standalone/WASI behavior:
 *   - `flat()` (default depth, nested-array receiver) → native, compiles + runs.
 *   - `flat(depth)` with an EXPLICIT depth arg → still refuses loudly (the native
 *     arm is depth-1-only; a variable-depth recursive flatten is a follow-up).
 *   - `flatMap(cb)` with an array-returning / scalar callback → native.
 *   - `flatMap(cb)` whose INLINE callback contains a bare empty array literal
 *     `[]` (e.g. `x => cond ? [] : [x]`) → native, compiles + runs. (#3532 fixed
 *     the underlying vec-type mismatch — `[]` under flatMap's `U | readonly U[]`
 *     union context now adopts the sibling's element type — so the former
 *     a-priori refusal guard was removed.)
 *
 * In every case NO unsatisfiable `__array_flat*` host import is emitted, and the
 * result is either a correct value OR a tracked compile error — never a module
 * that traps at instantiation (#2711 fail-loud policy).
 *
 * Host/gc mode is byte-unchanged (the native arms are gated on standalone||wasi).
 */

async function compileStandalone(body: string) {
  return compile(`export function test(): number { ${body} }`, { fileName: "t.ts", target: "standalone" });
}

function noFlatImports(r: Awaited<ReturnType<typeof compile>>): string[] {
  return r.imports.map((i) => i.name).filter((n) => n === "__array_flat" || n === "__array_flatMap");
}

describe("#2717 — native standalone flat/flatMap (no unsatisfiable import)", () => {
  const runCases: Array<[string, string, number]> = [
    ["flat() flattens one level", `const a: number[][] = [[1,2],[3,4]]; return a.flat().length;`, 4],
    ["flatMap() array callback (length)", `const a: number[] = [1,2,3]; return a.flatMap(x => [x, x*2]).length;`, 6],
    [
      "flatMap() array callback (sum)",
      `const a: number[] = [1,2,3]; const b = a.flatMap(x => [x, x*2]); let s = 0; for (let i = 0; i < b.length; i++) s += b[i]; return s;`,
      18,
    ],
    ["flatMap() string array callback", `const a: string[] = ["a","bb"]; return a.flatMap(s => [s, s + s]).length;`, 4],
    ["flatMap() scalar callback ≡ map", `const a: number[] = [1,2,3]; return a.flatMap(x => x).length;`, 3],
    // (#3532) An inline callback with a bare empty array literal `[]` in a
    // conditional under flatMap's `U | readonly U[]` union context now compiles
    // and runs — the former a-priori refusal (empty-array-literal guard) was
    // removed once `resolveEmptyArrayElemWasm` fixed the underlying vec-type
    // mismatch. 1,3 odd -> [1],[3]; 2 even -> []  ⇒ flattened [1,3], length 2.
    [
      "flatMap() empty-array-literal callback",
      `const a: number[] = [1,2,3]; return a.flatMap(x => (x % 2 === 0 ? [] : [x])).length;`,
      2,
    ],
  ];
  for (const [label, body, want] of runCases) {
    it(`${label} → ${want}, no host import`, async () => {
      const r = await compileStandalone(body);
      expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
      expect(noFlatImports(r)).toEqual([]);
      const { instance } = await WebAssembly.instantiate(r.binary, (r.importObject ?? {}) as WebAssembly.Imports);
      expect((instance.exports as { test: () => number }).test()).toBe(want);
    });
  }

  const loudCases: Array<[string, string, RegExp]> = [
    [
      "flat(depth) explicit arg",
      `const a: number[][] = [[1,2],[3,4]]; return a.flat(1).length;`,
      /flat\(\) is not yet supported in --target standalone/,
    ],
    // NOTE (#3532): the empty-array-literal flatMap callback used to be a loud
    // case here (guarded a-priori). It now compiles + runs correctly — see the
    // "flatMap() empty-array-literal callback" entry in `runCases` above.
  ];
  for (const [label, body, re] of loudCases) {
    it(`${label} → tracked compile error, never an unsatisfiable __array_flat* import`, async () => {
      const r = await compileStandalone(body);
      expect(r.success).toBe(false);
      expect(r.errors.map((e) => e.message).join("\n")).toMatch(re);
      // The guard runs BEFORE ensureLateImport, so the unsatisfiable host import
      // is never registered.
      expect(noFlatImports(r)).toEqual([]);
    });
  }
});

describe("#2717 — host/gc mode flat/flatMap unchanged", () => {
  async function runHost(body: string): Promise<number> {
    const { buildImports } = await import("../src/runtime.js");
    const r = await compile(`export function test(): number { ${body} }`, { fileName: "t.ts" });
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    const built = buildImports(r.imports, {}, r.stringPool);
    const { instance } = await WebAssembly.instantiate(r.binary, built as WebAssembly.Imports);
    if (built.setExports) built.setExports(instance.exports as Record<string, Function>);
    return (instance.exports as { test: () => number }).test();
  }
  const cases: Array<[string, string, number]> = [
    ["flat() flattens one level", `const a: number[][] = [[1,2],[3,4]]; return a.flat().length;`, 4],
    ["flatMap() maps + flattens", `const a: number[] = [1,2,3]; return a.flatMap(x => [x, x*2]).length;`, 6],
  ];
  for (const [label, body, want] of cases) {
    it(`${label} → ${want}`, async () => {
      expect(await runHost(body)).toBe(want);
    });
  }
});
