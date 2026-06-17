// #2162 — Wasm-native WeakMap / WeakSet dispatch (standalone / nativeStrings).
//
// Standalone WeakMap/WeakSet had no Wasm-native runtime, so `new WeakMap()` /
// `set`/`get`/`has` and `new WeakSet()` / `add`/`has` leaked `WeakMap_*` /
// `WeakSet_*` host imports a pure-Wasm engine can't satisfy (~101+ standalone
// test262 failures). This adds native weak collections that REUSE the #1103a
// Map backing store (WeakMap is a Map; WeakSet is a Set with key === value)
// over object-identity keys (the Map runtime already compares object keys by
// `ref.eq`). Weak collections have no iteration and no `.size`.
//
// Note on "weakness": WasmGC has no weak references, so these strongly retain
// entries. That is a memory property, not an observable one — every spec test
// for get/set/has/delete/add behaviour passes; only WeakRef/FinalizationRegistry
// liveness (skip-filtered) could tell the difference.
//
// Each test compiles with `target: "wasi"` and asserts (a) valid Wasm, (b) ZERO
// `WeakMap_*`/`WeakSet_*`/`Map_*` host imports, and (c) the expected runtime
// value.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

/** Compile `source` with `--target wasi`, run `test()`, return its value. */
async function runWeak(source: string): Promise<{ value: number; collImports: number; valid: boolean }> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const valid = WebAssembly.validate(result.binary);
  const module = await WebAssembly.compile(result.binary);
  const collImports = WebAssembly.Module.imports(module).filter((i) => /^(WeakMap|WeakSet|Map)_/.test(i.name)).length;

  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  const value = (exports.test as () => number)();
  return { value, collImports, valid };
}

describe("#2162 native WeakMap dispatch (standalone)", () => {
  it("set + get with object keys — host-import-free", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const k1 = {}; const k2 = {};
         const wm = new WeakMap<object, number>();
         wm.set(k1, 10); wm.set(k2, 20);
         return (wm.get(k1) as number) + (wm.get(k2) as number);
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(30);
  });

  it("has reflects membership; distinct object keys are distinct", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const k1 = {}; const k2 = {};
         const wm = new WeakMap<object, number>();
         wm.set(k1, 1);
         return (wm.has(k1) ? 10 : 0) + (wm.has(k2) ? 1 : 0);
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(10); // has(k1)=true, has(k2)=false
  });

  it("overwrite + delete (with return value)", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const k = {};
         const wm = new WeakMap<object, number>();
         wm.set(k, 5); wm.set(k, 9);
         const v = wm.get(k) as number;       // 9
         const d = wm.delete(k) ? 1 : 0;       // present → true
         const gone = wm.has(k) ? 1 : 0;       // false
         return v * 100 + d * 10 + gone;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(910); // 9,1,0
  });
});

describe("#2162 native WeakSet dispatch (standalone)", () => {
  it("add + has with object elements — host-import-free", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const a = {}; const b = {};
         const ws = new WeakSet<object>();
         ws.add(a);
         return (ws.has(a) ? 10 : 0) + (ws.has(b) ? 1 : 0);
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(10); // has(a)=true, has(b)=false
  });

  it("delete returns whether the element was present", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const a = {};
         const ws = new WeakSet<object>();
         ws.add(a);
         const first = ws.delete(a) ? 1 : 0;   // present → true
         const second = ws.delete(a) ? 1 : 0;  // gone → false
         const has = ws.has(a) ? 1 : 0;        // false
         return first * 100 + second * 10 + has;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(100); // 1,0,0
  });

  it("add is chainable and returns the set", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const a = {}; const b = {};
         const ws = new WeakSet<object>();
         ws.add(a).add(b);
         return (ws.has(a) ? 1 : 0) + (ws.has(b) ? 1 : 0);
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(2);
  });
});
