// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2375 — native `Object.is` SameValue (§20.1.2.13) for same-type scalar args.
 *
 * `Object.is(x, y)` previously boxed both args to externref and called the host
 * `__object_is`, which is unsatisfiable in `--target standalone` (19
 * `built-ins/Object/is/*` tests compile_error'd on the real standalone baseline).
 *
 * This adds a pure-Wasm SameValue lowering for statically same-type scalar args:
 *   - number/number → `(x!==x && y!==y) | (bits(x)==bits(y))` (NaN equal, +0/-0
 *     distinguished via the IEEE-754 bit pattern)
 *   - boolean/boolean → i32 strict equality
 *   - string/string → native `__str_equals` over flattened native strings
 * Everything else (mixed types, object/symbol/any) keeps the host `__object_is`
 * path unchanged. Additive — turns compile_error → pass, zero host imports.
 */

async function standaloneBool(expr: string): Promise<{ value: boolean; usesHostIs: boolean }> {
  const src = `export function test(): number { return (${expr}) ? 1 : 0; }`;
  const r = await compile(src, { target: "standalone", nativeStrings: true });
  expect(r.success, r.success ? "" : r.errors.map((e) => e.message).join("\n")).toBe(true);
  const usesHostIs = r.imports.map((i) => `${i.module}::${i.name}`).some((l) => l === "env::__object_is");
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  const out = (instance.exports as { test: () => number }).test();
  return { value: out === 1, usesHostIs };
}

describe("#2375 — native Object.is(number, number) SameValue", () => {
  const cases: Array<[string, boolean]> = [
    ["Object.is(NaN, NaN)", true],
    ["Object.is(+0, +0)", true],
    ["Object.is(-0, -0)", true],
    ["Object.is(0, -0)", false],
    ["Object.is(-0, 0)", false],
    ["Object.is(42, 42)", true],
    ["Object.is(1, 2)", false],
    ["Object.is(Infinity, Infinity)", true],
    ["Object.is(Infinity, -Infinity)", false],
    ["Object.is(NaN, 1)", false],
    ["Object.is(3.14, 3.14)", true],
  ];
  for (const [expr, want] of cases) {
    it(`${expr} → ${want} (no host import)`, async () => {
      const { value, usesHostIs } = await standaloneBool(expr);
      expect(value).toBe(want);
      expect(usesHostIs).toBe(false);
    });
  }
});

describe("#2375 — native Object.is(boolean, boolean) / (string, string)", () => {
  const cases: Array<[string, boolean]> = [
    ["Object.is(true, true)", true],
    ["Object.is(false, false)", true],
    ["Object.is(true, false)", false],
    ['Object.is("ab", "ab")', true],
    ['Object.is("ab", "ac")', false],
    ['Object.is("", "")', true],
    ['Object.is("x", "")', false],
  ];
  for (const [expr, want] of cases) {
    it(`${expr} → ${want} (no host import)`, async () => {
      const { value, usesHostIs } = await standaloneBool(expr);
      expect(value).toBe(want);
      expect(usesHostIs).toBe(false);
    });
  }
});

describe("#2375 — host mode unaffected for mixed/dynamic args", () => {
  it("same-type scalars use the native path (no __object_is) in host mode too", async () => {
    const r = await compile(`export function test(): number { return Object.is(1, 1) ? 1 : 0; }`, {});
    expect(r.success).toBe(true);
    const usesHostIs = r.imports.map((i) => `${i.module}::${i.name}`).some((l) => l === "env::__object_is");
    expect(usesHostIs).toBe(false);
  });

  it("a mixed (any) receiver still routes to the host __object_is path", async () => {
    const r = await compile(
      `export function test(): number { const a: any = 1; const b: any = "x"; return Object.is(a, b) ? 1 : 0; }`,
      {},
    );
    expect(r.success).toBe(true);
    const usesHostIs = r.imports.map((i) => `${i.module}::${i.name}`).some((l) => l === "env::__object_is");
    expect(usesHostIs).toBe(true);
  });
});
