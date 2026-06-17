// #2162 — Wasm-native Map.prototype.forEach dispatch (standalone / nativeStrings).
//
// The #1103a native Map runtime served get/set/has/delete/clear/size but NOT
// iteration, so `m.forEach(cb)` in standalone leaked a `Map_forEach` host import
// a pure-Wasm engine can't satisfy (and silently no-op'd). This slice drives the
// callback over the `$Map` entries vector directly — the same insertion-ordered,
// tombstone-skipping walk `__map_iter_next` uses — and invokes the callback
// closure as `cb(value, key, map)` per live entry (spec 24.1.3.5).
//
// Each test compiles with `target: "wasi"` and asserts (a) valid Wasm, (b) ZERO
// `Map_*` host imports, and (c) the expected accumulated value.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function runMap(source: string): Promise<{ value: number; mapImports: number; valid: boolean }> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const valid = WebAssembly.validate(result.binary);
  const module = await WebAssembly.compile(result.binary);
  const mapImports = WebAssembly.Module.imports(module).filter((i) => /^Map_/.test(i.name)).length;

  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  const value = (exports.test as () => number)();
  return { value, mapImports, valid };
}

describe("#2162 native Map.forEach (standalone)", () => {
  it("sums values — host-import-free", async () => {
    const { value, mapImports, valid } = await runMap(
      `export function test(): number {
         let s = 0;
         const m = new Map<number, number>();
         m.set(1, 10); m.set(2, 20); m.set(3, 30);
         m.forEach((v) => { s += v; });
         return s;
       }`,
    );
    expect(valid).toBe(true);
    expect(mapImports).toBe(0);
    expect(value).toBe(60);
  });

  it("passes value AND key to the callback", async () => {
    const { value, valid } = await runMap(
      `export function test(): number {
         let s = 0;
         const m = new Map<number, number>();
         m.set(2, 10); m.set(3, 20);
         m.forEach((v, k) => { s += v + k; });
         return s;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(35); // (10+2) + (20+3)
  });

  it("visits in insertion order", async () => {
    const { value, valid } = await runMap(
      `export function test(): number {
         let acc = 0;
         const m = new Map<number, number>();
         m.set(1, 3); m.set(2, 5); m.set(3, 7);
         m.forEach((v) => { acc = acc * 10 + v; });
         return acc;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(357);
  });

  it("skips deleted (tombstoned) entries", async () => {
    const { value, valid } = await runMap(
      `export function test(): number {
         let s = 0;
         const m = new Map<number, number>();
         m.set(1, 10); m.set(2, 20); m.set(3, 30);
         m.delete(2);
         m.forEach((v) => { s += v; });
         return s;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(40); // 10 + 30
  });

  it("empty map invokes the callback zero times", async () => {
    const { value, valid } = await runMap(
      `export function test(): number {
         let s = 0;
         const m = new Map<number, number>();
         m.forEach((v) => { s += v; });
         return s;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(0);
  });

  it("works with string keys", async () => {
    const { value, valid } = await runMap(
      `export function test(): number {
         let n = 0;
         const m = new Map<string, number>();
         m.set("a", 1); m.set("b", 2);
         m.forEach((v) => { n += v; });
         return n;
       }`,
    );
    expect(valid).toBe(true);
    expect(value).toBe(3);
  });
});
