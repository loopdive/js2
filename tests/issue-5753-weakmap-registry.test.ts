// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

async function run(source: string, target: "standalone" | "wasi" = "standalone"): Promise<number> {
  const result = await compile(source, { fileName: "weakmap-registry.ts", target });
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const module = new WebAssembly.Module(result.binary);
  expect(WebAssembly.Module.imports(module).filter((i) => i.module !== "wasi_snapshot_preview1")).toEqual([]);
  const wasi = buildWasiPolyfill();
  const instance = new WebAssembly.Instance(module, { wasi_snapshot_preview1: wasi });
  if (instance.exports.memory) wasi.setMemory(instance.exports.memory as WebAssembly.Memory);
  return (instance.exports.test as () => number)();
}

describe("WeakMap upsert canonical symbol registry", () => {
  for (const computed of [false, true]) {
    const method = computed ? "getOrInsertComputed" : "getOrInsert";
    const value = computed ? "function(k: any): number { calls++; return 7; }" : "7";
    for (const key of ["Symbol.for('registered')", "Symbol.for('')", "registered", "true ? registered : null"]) {
      it(`${method} rejects ${key} without invoking a callback`, async () => {
        expect(
          await run(`export function test(): number {
          const registered = Symbol.for('registered'); const wm = new WeakMap(); let calls = 0;
          try { wm.${method}(${key}, ${value}); return -1; }
          catch (e) { if (!(e instanceof TypeError)) return -2; }
          return calls === 0 && !wm.has(registered) ? 1 : -3;
        }`),
        ).toBe(1);
      });
    }
    for (const first of ["new Map().getOrInsert({}, 3);", "wm.getOrInsert({}, 3);", ""]) {
      it(`${method} retains registry guard after first kernel ${first || "symbol"}`, async () => {
        expect(
          await run(`export function test(): number {
          const wm = new WeakMap(); let calls = 0; ${first}
          try { wm.${method}(Symbol.for(''), ${value}); return -1; }
          catch (e) { return e instanceof TypeError && calls === 0 ? 1 : -2; }
        }`),
        ).toBe(1);
      });
    }
    it(`${method} rejects primitive aliases`, async () => {
      expect(
        await run(`export function test(): number {
        const wm = new WeakMap(); let calls = 0; let rejected = 0;
        const keys: any[] = [1, false, undefined, 'string', null, 1n, NaN, -0];
        for (const key of keys) {
          try { wm.${method}(key, ${value}); }
          catch(e) { if (e instanceof TypeError) rejected++; }
        }
        return rejected === 8 && calls === 0 ? 1 : -1;
      }`),
      ).toBe(1);
    });
    for (const key of ["{}", "new Number(1)", "Symbol('x')", "Symbol.iterator"]) {
      it(`${method} accepts ${key} after registering the same description`, async () => {
        expect(
          await run(`export function test(): number {
        const wm = new WeakMap(); let calls = 0;
        Symbol.for('x'); const key = ${key};
          const first = wm.${method}(key, ${value});
          const second = wm.${method}(key, ${computed ? "function(): number { calls++; return 99; }" : "99"});
        return first === 7 && second === 7 && ${computed ? "calls === 1" : "true"} ? 1 : -3;
      }`),
        ).toBe(1);
      });
    }
    it(`${method} keeps same-description symbols distinct`, async () => {
      expect(
        await run(`export function test(): number {
        const wm = new WeakMap(); const a = Symbol('x'); const b = Symbol('x'); let calls = 0;
        const first = wm.${method}(a, ${value});
        const second = wm.${method}(b, ${computed ? "function(): number { calls++; return 9; }" : "9"});
        return first === 7 && second === 9 && ${computed ? "calls === 2" : "true"} ? 1 : -1;
      }`),
      ).toBe(1);
    });
    it(`${method} rejects a registered parameter alias`, async () => {
      expect(
        await run(`function insert(key: any): number {
        const wm = new WeakMap(); let calls = 0;
        try { wm.${method}(key, ${value}); return -1; }
        catch(e) { return e instanceof TypeError && calls === 0 ? 1 : -2; }
      }
      export function test(): number { return insert(Symbol.for('')); }`),
      ).toBe(1);
    });
  }
  it("computed receives the exact key and skips an existing key", async () => {
    expect(
      await run(`export function test(): number {
      const wm = new WeakMap(); const key = Symbol('x'); let calls = 0;
      const first = wm.getOrInsertComputed(key, function(k: any): number { calls++; return k === key ? 7 : -1; });
      const second = wm.getOrInsertComputed(key, function(): number { calls++; return -2; });
      return first === 7 && second === 7 && calls === 1 ? 1 : -3;
    }`),
    ).toBe(1);
  });
  it("WASI rejects registered symbols while accepting unregistered symbols", async () => {
    expect(
      await run(
        `export function test(): number {
      const wm = new WeakMap(); const key = Symbol('');
      if (wm.getOrInsert(key, 7) !== 7) return -1;
      try { wm.getOrInsert(Symbol.for(''), 9); return -2; }
      catch(e) { return e instanceof TypeError ? 1 : -3; }
    }`,
        "wasi",
      ),
    ).toBe(1);
  });
});
