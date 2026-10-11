// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { compile } from "../src/index.js";
import { runTest262File } from "./test262-runner.js";

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
 *   - `flat(depth)` with an EXPLICIT depth arg → native recursive
 *     FlattenIntoArray (`array-flat-native.ts`), compiles + runs.
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
  return compile(`export function test(): number { ${body} }`, {
    fileName: "t.ts",
    target: "standalone",
  });
}

function noFlatImports(r: Awaited<ReturnType<typeof compile>>): string[] {
  return r.imports.map((i) => i.name).filter((n) => n === "__array_flat" || n === "__array_flatMap");
}

describe("#2717 — native standalone flat/flatMap (no unsatisfiable import)", () => {
  const runCases: Array<[string, string, number]> = [
    ["flat() flattens one level", `const a: number[][] = [[1,2],[3,4]]; return a.flat().length;`, 4],
    ["flat(1) explicit depth", `const a: number[][] = [[1,2],[3,4]]; return a.flat(1).length;`, 4],
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

  it("preserves a scalar callback's custom species result", async () => {
    const relativePath = "built-ins/Array/prototype/flatMap/target-array-with-non-writable-property.js";
    const result = await runTest262File(
      resolve("test262/test", relativePath),
      "issue-2717-standalone",
      120_000,
      "standalone",
    );
    expect(result.status, `${relativePath}: ${result.error ?? result.reason ?? ""}`).toBe("pass");
  });

  it("runs a dynamic scalar-or-array callback through the native recursive flatten", async () => {
    // (#2717) formerly fail-loud; `array-flat-native.ts` decides IsArray per call.
    const r = await compileStandalone(`
      const a: number[] = [1, 2];
      const cb: (x: number) => number | number[] = (x) => (x > 1 ? [x, x] : x);
      return a.flatMap(cb).length;
    `);
    expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
    expect(noFlatImports(r)).toEqual([]);
    const { instance } = await WebAssembly.instantiate(r.binary, (r.importObject ?? {}) as WebAssembly.Imports);
    expect((instance.exports as { test: () => number }).test()).toBe(3);
  });

  it("keeps an Array-subclass callback fail-loud under custom species", async () => {
    const r = await compileStandalone(`
      class SubArray extends Array<number> {}
      const a: number[] = [1, 2];
      a.constructor = SubArray;
      return a.flatMap((x) => new SubArray([x, x])).length;
    `);
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/non-array-returning callback/);
    expect(noFlatImports(r)).toEqual([]);
  });

  it("keeps a transitive Array-subclass callback fail-loud", async () => {
    const r = await compileStandalone(`
      class BaseArray extends Array<number> {}
      class SubArray extends BaseArray {}
      const a: number[] = [1, 2];
      a.constructor = SubArray;
      return a.flatMap((x) => new SubArray([x, x])).length;
    `);
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/non-array-returning callback/);
    expect(noFlatImports(r)).toEqual([]);
  });

  it("keeps a builtin-aliased Array-subclass callback fail-loud under custom species", async () => {
    const r = await compileStandalone(`
      const ArrayAlias = Array;
      class AliasSubArray extends ArrayAlias<number> {}
      const a: number[] = [1, 2];
      a.constructor = AliasSubArray;
      return a.flatMap((x) => new AliasSubArray([x, x])).length;
    `);
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/non-array-returning callback/);
    expect(noFlatImports(r)).toEqual([]);
  });

  it("keeps a user-aliased Array-subclass callback fail-loud under custom species", async () => {
    const r = await compileStandalone(`
      class BaseArray extends Array<number> {}
      const UserAlias = BaseArray;
      class AliasSubArray extends UserAlias {}
      const a: number[] = [1, 2];
      a.constructor = AliasSubArray;
      return a.flatMap((x) => new AliasSubArray([x, x])).length;
    `);
    expect(r.success).toBe(false);
    expect(r.errors.map((e) => e.message).join("\n")).toMatch(/non-array-returning callback/);
    expect(noFlatImports(r)).toEqual([]);
  });

  // (#2717) `flat(depth)` with an explicit depth used to be a loud case here;
  // the native recursive FlattenIntoArray (`array-flat-native.ts`) now serves
  // it — see the `flat(1) explicit depth` entry in `runCases` above and
  // `tests/issue-2717-native-flatten.test.ts`.
});

describe("#2717 — host/gc mode flat/flatMap unchanged", () => {
  async function runHost(body: string): Promise<number> {
    const { buildImports } = await import("../src/runtime.js");
    const r = await compile(`export function test(): number { ${body} }`, {
      fileName: "t.ts",
    });
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
