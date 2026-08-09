// #3573 — Set/Map.prototype.forEach with a non-callable literal argument, and
// Symbol.matchAll value-read (standalone / nativeStrings).
//
// (1) forEach: the native forEach path (tryCompileNativeCollectionForEach) only
// handles Wasm-closure callbacks. A statically non-callable LITERAL argument
// (`null` / `undefined` / number / boolean / string) fell through to the host
// `Set_forEach`/`Map_forEach` import → compile_error under standalone. Spec
// 24.1.3.5 / 24.2.3.6 require a `TypeError` when callbackfn is not callable;
// we now emit that natively.
//
// (2) Symbol.matchAll: the builtin-value-read `WELL_KNOWN_SYMBOLS` mirror was
// missing `matchAll` (drifted from literals.ts), so `Symbol.matchAll` value
// reads refused under standalone. Restored.
//
// `skipSemanticDiagnostics: true` mirrors the test262 runner (JS tests pass
// `s.forEach(null)`, which strict TS would reject before codegen).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function run(source: string): Promise<{ value: number; collImports: number; valid: boolean }> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi", skipSemanticDiagnostics: true });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const valid = WebAssembly.validate(result.binary);
  const module = await WebAssembly.compile(result.binary);
  const collImports = WebAssembly.Module.imports(module).filter((i) => /^(Set|Map)_/.test(i.name)).length;
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  const value = (exports.test as () => number)();
  return { value, collImports, valid };
}

describe("#3573 Set/Map.forEach non-callable literal → native TypeError (standalone)", () => {
  for (const [label, arg] of [
    ["null", "null"],
    ["undefined", "undefined"],
    ["number", "3"],
    ["boolean", "true"],
    ["string", '"nope"'],
  ] as const) {
    it(`Set.forEach(${label}) throws, host-import-free`, async () => {
      const { value, collImports, valid } = await run(
        `export function test(): number {
           const s = new Set([1]);
           try { s.forEach(${arg}); return 0; } catch (e) { return 1; }
         }`,
      );
      expect(valid).toBe(true);
      expect(collImports).toBe(0);
      expect(value).toBe(1); // threw
    });
  }

  it("Map.forEach(null) throws, host-import-free", async () => {
    const { value, collImports, valid } = await run(
      `export function test(): number {
         const m = new Map([[1, 2]]);
         try { m.forEach(null); return 0; } catch (e) { return 1; }
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(1);
  });

  it("Set.forEach(closure) still drives the callback (regression guard)", async () => {
    const { value, collImports, valid } = await run(
      `export function test(): number {
         const s = new Set([1, 2, 3]);
         let sum = 0;
         s.forEach((v) => { sum += v; });
         return sum;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(6);
  });
});

describe("#3573 Symbol.matchAll value read (standalone)", () => {
  it("Symbol.matchAll reads host-import-free as a symbol", async () => {
    const { value, valid } = await run(
      `export function test(): number {
         return typeof Symbol.matchAll === "symbol" ? 1 : 0;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });
});
