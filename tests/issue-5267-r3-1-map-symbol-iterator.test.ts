// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5267 R3-1 — `map[Symbol.iterator]()` must yield the SAME live record
// `map.entries()` yields (§24.1.3.12), and an exhausted collection iterator
// must STAY exhausted after the collection grows (§24.1.5.1).
//
// Before this change the `@@iterator` call routed a Map/Set receiver through
// the dynamic `__iterator` ladder, whose product answered `null` from `.next()`
// (`MapIteratorPrototype/next/iteration.js` failed with "Cannot access property
// on null or undefined"), and `__map_iter_next`'s done branch left the cursor
// parked at the old entry count, so a later `add` revived the iterator
// (`Set/prototype/values/values-iteration-mutable.js`).

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildWasiPolyfill } from "../src/runtime.js";

interface StandaloneRun {
  value: number;
  valid: boolean;
  /** Every `env::*` function import the module declares. Must be empty. */
  hostImports: string[];
}

/** Compile `source` on the standalone (wasi) lane, run `test()`, list imports. */
async function runStandalone(source: string): Promise<StandaloneRun> {
  const result = await compile(source, { fileName: "test.ts", target: "wasi" });
  if (!result.success) {
    throw new Error(`compile failed: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  const valid = WebAssembly.validate(result.binary);
  const module = await WebAssembly.compile(result.binary);
  const hostImports = WebAssembly.Module.imports(module)
    .filter((i) => i.module !== "wasi_snapshot_preview1")
    .map((i) => `${i.module}::${i.name}`);
  const wasi = buildWasiPolyfill();
  const instance = await WebAssembly.instantiate(module, { wasi_snapshot_preview1: wasi });
  const exports = instance.exports as Record<string, unknown>;
  if (exports.memory) wasi.setMemory(exports.memory as WebAssembly.Memory);
  const value = (exports.test as () => number)();
  return { value, valid, hostImports };
}

describe("#5267 R3-1 — Map/Set @@iterator yields the live entries/values record", () => {
  it("map[Symbol.iterator]().next() reads the first entry", async () => {
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         const m = new Map<string, number>([["a", 1], ["b", 2]]);
         const it: any = (m as any)[Symbol.iterator]();
         const r: any = it.next();
         const pair: any = r.value;
         // 1000 * (done ? 1 : 0) + 100 * value + key-present
         return (r.done ? 1000 : 0) + (pair[1] as number) * 100 + (pair[0] === "a" ? 7 : 0);
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(107);
  });

  it("set[Symbol.iterator]() steps the elements and then reports done", async () => {
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         const s = new Set<number>([7, 8]);
         const it: any = (s as any)[Symbol.iterator]();
         const a: any = it.next();
         const b: any = it.next();
         const c: any = it.next();
         return (a.value as number) * 100 + (b.value as number) * 10 + (c.done ? 1 : 0);
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(781);
  });

  it("an exhausted Set iterator stays exhausted after a later add", async () => {
    const { value, valid, hostImports } = await runStandalone(
      `export function test(): number {
         const s = new Set<number>([1]);
         const it = s.values();
         it.next();
         const done1: any = it.next();
         s.add(4);
         const done2: any = it.next();
         return (done1.done ? 10 : 0) + (done2.done ? 5 : 0) + (done2.value === undefined ? 1 : 0);
       }`,
    );
    expect(valid).toBe(true);
    expect(hostImports).toEqual([]);
    expect(value).toBe(16);
  });
});
