// #2162 — Wasm-native Set.prototype.forEach dispatch (standalone / nativeStrings).
//
// The #1103a/#1510 native Set runtime served add/has/delete/clear/size but NOT
// iteration, so `s.forEach(cb)` in standalone fell through to the generic path
// and produced invalid Wasm. The shared collection-forEach machinery (added for
// Map.forEach, #1527) already supports a Set via its `isSet` flag (value passed
// as BOTH value and key per 24.2.3.6); this slice wires Set's method dispatch
// (tryCompileNativeSetMethodCall) to it.
//
// Each test compiles with `target: "wasi"` and asserts (a) valid Wasm, (b) ZERO
// `Set_*` / `Map_*` host imports, and (c) the expected accumulated value.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function runSet(source: string): Promise<{ value: number; collImports: number; valid: boolean }> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
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

describe("#2162 native Set.forEach (standalone)", () => {
  it("sums values — host-import-free", async () => {
    const { value, collImports, valid } = await runSet(
      `export function test(): number {
         let s = 0;
         const set = new Set<number>();
         set.add(10); set.add(20); set.add(30);
         set.forEach((v) => { s += v; });
         return s;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(60);
  });

  it("passes value as BOTH value and key (24.2.3.6)", async () => {
    const { value, valid } = await runSet(
      `export function test(): number {
         let ok = 1;
         const set = new Set<number>();
         set.add(5); set.add(7);
         set.forEach((v, k) => { if (v !== k) ok = 0; });
         return ok;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(1);
  });

  it("visits in insertion order", async () => {
    const { value, valid } = await runSet(
      `export function test(): number {
         let acc = 0;
         const set = new Set<number>();
         set.add(3); set.add(5); set.add(7);
         set.forEach((v) => { acc = acc * 10 + v; });
         return acc;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(357);
  });

  it("skips deleted (tombstoned) entries", async () => {
    const { value, valid } = await runSet(
      `export function test(): number {
         let s = 0;
         const set = new Set<number>();
         set.add(10); set.add(20); set.add(30);
         set.delete(20);
         set.forEach((v) => { s += v; });
         return s;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(40); // 10 + 30
  });

  it("dedupes repeated adds (SameValueZero) before iterating", async () => {
    const { value, valid } = await runSet(
      `export function test(): number {
         let n = 0;
         const set = new Set<number>();
         set.add(1); set.add(1); set.add(2);
         set.forEach(() => { n += 1; });
         return n;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(2);
  });

  it("empty set invokes the callback zero times", async () => {
    const { value, valid } = await runSet(
      `export function test(): number {
         let s = 0;
         const set = new Set<number>();
         set.forEach((v) => { s += v; });
         return s;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(0);
  });

  it("works with string elements", async () => {
    const { value, valid } = await runSet(
      `export function test(): number {
         let n = 0;
         const set = new Set<string>();
         set.add("a"); set.add("b"); set.add("a");
         set.forEach(() => { n += 1; });
         return n;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(2);
  });
});
