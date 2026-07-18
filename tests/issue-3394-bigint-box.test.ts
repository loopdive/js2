// #3394 — a bigint (i64) value reaching an externref/anyref boundary was left
// raw or fed to a bare `extern.convert_any`, producing INVALID Wasm
// ("extern.convert_any expected anyref, found i64" / "call expected anyref,
// found i64"). Child of #2039's invalid-Wasm bucket (59 rows: Temporal 51,
// String 3, Map 2, Set 2, Object 1).
//
// Fix: box the i64 at three boundary-coercion sites —
//   1. Map/Set/WeakMap/WeakSet element (map-runtime `coerceArgToAnyref`),
//   2. `Object.create(proto, <primitive>)` 2nd arg (call-builtin-static),
//   3. array/tuple element destructuring (`boxToExternref`, the Temporal
//      heterogeneous-`[number|bigint, string]`-tuple rows).
// A branded bigint boxes via `__box_bigint`; a native `type i64 = number`
// boxes via `__box_number`.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

async function compileStandalone(source: string) {
  return compile(source, { fileName: "t.ts", target: "standalone" as const });
}

async function validStandalone(source: string): Promise<boolean> {
  const result = await compileStandalone(source);
  if (!result.success) throw new Error(`compile failed: ${result.errors[0]?.message}`);
  return WebAssembly.validate(result.binary);
}

async function runStandalone(source: string): Promise<unknown> {
  const result = await compileStandalone(source);
  if (!result.success) throw new Error(`compile failed: ${result.errors[0]?.message}`);
  const built = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, built.env, built.string_constants);
  built.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as { test: () => unknown }).test();
}

describe("#3394 bigint i64 at externref boundaries → valid Wasm", () => {
  // ── Valid-Wasm acceptance (the bucket's bar) ──────────────────────────

  it("Object.create(proto, <bigint>) compiles to valid Wasm", async () => {
    // test262 Object/create/properties-arg-to-object-bigint.js shape.
    expect(await validStandalone(`export function test(): any { return Object.create({}, 1n as any); }`)).toBe(true);
  });

  it("Map.set / Set.add with a bigint key compile to valid Wasm", async () => {
    expect(
      await validStandalone(
        `export function test(): number { const m = new Map<any,any>(); m.set(5n, 1); return m.size; }`,
      ),
    ).toBe(true);
    expect(
      await validStandalone(`export function test(): number { const s = new Set<any>(); s.add(5n); return s.size; }`),
    ).toBe(true);
  });

  it("destructuring a heterogeneous [number|bigint, string] tuple array compiles to valid Wasm", async () => {
    // test262 Temporal timezone-wrong-type.js shape: an inferred
    // `[number|bigint, string]`-tuple array destructured in a for-of.
    expect(
      await validStandalone(`
        const primitiveTests = [
          [1, "number"],
          [1n, "bigint"],
        ];
        for (const [timeZone, description] of primitiveTests) {
          const opts: any = { timeZone };
        }
        export function test(): number { return 0; }
      `),
    ).toBe(true);
  });

  it("a bigint array element destructure boxes as a real bigint (round-trip)", async () => {
    const got = await runStandalone(`
      const a = [[10n, "x"], [20n, "y"]];
      export function test(): number {
        let sum = 0;
        for (const [n, d] of a) { sum += typeof n === "bigint" ? Number(n) : -1; }
        return sum;   // 10 + 20 = 30
      }
    `);
    expect(got).toBe(30);
  });

  // ── Guard: native `type i64 = number` unaffected (boxes as number) ────

  it("native i64 (non-bigint) map value still compiles valid", async () => {
    expect(
      await validStandalone(`
        type i64 = number;
        export function test(): number {
          const n: i64 = 7;
          const m = new Map<any, any>();
          m.set(1, n);
          return m.size;
        }
      `),
    ).toBe(true);
  });
});
