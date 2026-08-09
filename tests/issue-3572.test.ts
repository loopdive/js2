// #3572 — native WeakMap/WeakSet iterable constructor (standalone / nativeStrings).
//
// #2162 wired `new WeakMap()`/`new WeakSet()` onto the native weak-collection
// runtime, but ONLY the no-arg form. The iterable forms
// (`new WeakSet([o1,o2])`, `new WeakMap([[k,v],…])`, `new WeakSet(null)`, …)
// fell through to the generic externClass ctor, which emits a
// `WeakSet_new`/`WeakMap_new` host import a pure-Wasm engine can't satisfy
// (compile_error under standalone). This wires the array-literal / null /
// undefined / non-literal-array forms onto `__weakset_add` / `__map_set`,
// mirroring `new Set([…])` / `new Map([[k,v],…])`.
//
// Each test compiles with `target: "wasi"` (nativeStrings; same regime as
// standalone for this code path) and asserts (a) valid Wasm, (b) ZERO
// `WeakMap_*`/`WeakSet_*`/`Map_*` host imports, and (c) the expected value.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

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

describe("#3572 native WeakSet iterable constructor (standalone)", () => {
  it("new WeakSet([o1, o2]) — seeds, host-import-free", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const o1 = {}; const o2 = {};
         const w = new WeakSet([o1, o2]);
         return (w.has(o1) && w.has(o2)) ? 1 : 0;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(1);
  });

  it("new WeakSet([]) — empty, host-import-free", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const w = new WeakSet<object>([]);
         const o = {};
         return w.has(o) ? 1 : 0;  // not present → 0
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(0);
  });

  it("new WeakSet(null) — spec-empty, host-import-free, still usable", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const w = new WeakSet(null);
         const o = {};
         w.add(o);
         return w.has(o) ? 1 : 0;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(1);
  });

  it("new WeakSet(arrVar) — non-literal array arg seeds, host-import-free", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const o1 = {}; const o2 = {};
         const arr = [o1, o2];
         const w = new WeakSet(arr);
         return (w.has(o1) && w.has(o2)) ? 1 : 0;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(1);
  });
});

describe("#3572 native WeakMap iterable constructor (standalone)", () => {
  it("new WeakMap([[k1,10],[k2,20]]) — seeds, host-import-free", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const k1 = {}; const k2 = {};
         const w = new WeakMap<object, number>([[k1, 10], [k2, 20]]);
         return (w.get(k1) as number) + (w.get(k2) as number);
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(30);
  });

  it("new WeakMap(undefined) — spec-empty, host-import-free, still usable", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const w = new WeakMap<object, number>(undefined);
         const k = {};
         w.set(k, 7);
         return w.get(k) as number;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(7);
  });

  it("new WeakMap([[k, v]]) then overwrite — host-import-free", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const k = {};
         const w = new WeakMap<object, number>([[k, 5]]);
         w.set(k, 9);
         return w.get(k) as number;
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(9);
  });
});

describe("#3572 no-arg regression guard", () => {
  it("new WeakSet() / new WeakMap() still native (no regression)", async () => {
    const { value, collImports, valid } = await runWeak(
      `export function test(): number {
         const ws = new WeakSet<object>();
         const wm = new WeakMap<object, number>();
         const o = {}; ws.add(o); wm.set(o, 3);
         return (ws.has(o) ? 1 : 0) + (wm.get(o) as number);
       }`,
    );
    expect(valid).toBe(true);
    expect(collImports).toBe(0);
    expect(value).toBe(4);
  });
});
