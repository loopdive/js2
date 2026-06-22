import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/**
 * #2605 — standalone boxed-boolean `===`/`!==` against a boolean.
 *
 * The test262 Set-method rows assert `assert.sameValue(x instanceof Set, true)`,
 * which the harness lowers to `assert_sameValue_bool(actual: any, expected:
 * boolean)` → `actual !== expected`. The boolean argument crosses into an `any`
 * parameter as a boxed value; the dynamic-equality tag dispatch then compared a
 * boxed **boolean** `true` (tag boolean) against a boolean coerced via
 * `__box_number` (tag number) and fell to reference identity → wrong `false`.
 * The fix boxes a boolean operand via `__box_boolean` so the "both typeof
 * boolean" arm fires.
 *
 * #2606 Bug A — standalone `Set`/`Map` `null`/`undefined` element coercion.
 *
 * `s.add(null)` / `s.has(null)` / `s.has(undefined)` failed to compile
 * standalone ("any.convert_extern expected externref, found ref.null"). The
 * fix routes null/undefined literals to a canonical `ref.null NONE_HEAP`, and
 * `__same_value_zero` now treats two nulls as SameValueZero-equal.
 */

async function runStandalone(src: string): Promise<number | undefined> {
  const r = await compile(src, { fileName: "test.ts", target: "standalone", nativeStrings: true });
  if (!r.success) throw new Error("compile error: " + (r.errors[0]?.message ?? "unknown"));
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports.test as () => number | undefined)?.();
}

describe("#2605 standalone boxed-boolean equality across an any boundary", () => {
  it("boxed boolean === boolean (true) returns equal", async () => {
    const src = `
      function cmp(actual: any, expected: boolean): number { return actual === expected ? 1 : 0; }
      export function test(): number {
        const a: boolean = true;
        return cmp(a, true);
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("boxed boolean !== boolean (false vs true) returns differ", async () => {
    const src = `
      function neq(actual: any, expected: boolean): number { return actual !== expected ? 1 : 0; }
      export function test(): number {
        const a: boolean = false;
        return neq(a, true);
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("set-algebra result `combined instanceof Set` compares true through an any param", async () => {
    // Mirrors the test262 harness assert_sameValue_bool shape.
    const src = `
      function asb(actual: any, expected: boolean): number { return actual === expected ? 0 : 1; }
      export function test(): number {
        const s1 = new Set([1, 2]);
        const s2 = new Set([2, 3]);
        let combined = s1.union(s2);
        return asb(combined instanceof Set, true);
      }`;
    expect(await runStandalone(src)).toBe(0);
  });
});

describe("#2606 Bug A — standalone Set null/undefined element coercion", () => {
  it("s.add(null); s.has(null) → true (compiles + SameValueZero null)", async () => {
    const src = `
      export function test(): number {
        const s = new Set<any>();
        s.add(null);
        return s.has(null) ? 1 : 0;
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("s.add(undefined); s.has(undefined) → true", async () => {
    const src = `
      export function test(): number {
        const s = new Set();
        s.add(undefined);
        return s.has(undefined) ? 1 : 0;
      }`;
    expect(await runStandalone(src)).toBe(1);
  });

  it("non-null element present, s.has(null) → false (no spurious null match)", async () => {
    const src = `
      export function test(): number {
        const s = new Set<any>();
        s.add(1);
        return s.has(null) ? 1 : 0;
      }`;
    expect(await runStandalone(src)).toBe(0);
  });

  it("Map.set(null, v); Map.get(null) round-trips a null key", async () => {
    const src = `
      export function test(): number {
        const m = new Map();
        m.set(null, 7);
        return m.has(null) ? 1 : 0;
      }`;
    expect(await runStandalone(src)).toBe(1);
  });
});
