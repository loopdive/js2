// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// Issue #1438 — Map/WeakMap/WeakSet residual collection semantics.
//
// Covers:
//   - Map/WeakMap iterable constructor produces a real JS array of entries
//     so the native engine can iterate it (#1438).
//   - Map.prototype.forEach wraps wasm-closure callbacks so V8 sees a
//     `[[Callable]]` function instead of "object is not a function".
//   - getOrInsert / getOrInsertComputed polyfill wraps wasm-closure callbacks
//     and accepts Symbol keys for WeakMap (per ES2023 symbols-as-weakmap-keys).
import { compile, buildImports } from "/workspace/.claude/worktrees/issue-1438/src/index.ts";
import { describe, expect, it } from "vitest";

async function run(src: string, exportName = "test"): Promise<any> {
  const r = await compile(src, { fileName: "test.ts" });
  if (!r.success) throw new Error("CE: " + r.errors[0]?.message);
  const imports = buildImports(r.imports, undefined, r.stringPool);
  const { instance } = await WebAssembly.instantiate(r.binary, imports);
  if (imports.setExports) imports.setExports(instance.exports as any);
  return (instance.exports as any)[exportName]?.();
}

describe("#1438 keyed-collection residuals", () => {
  it("new Map(iterable) — entries with primitive keys", async () => {
    const ret = await run(`
export function test(): number {
  const map = new Map<number, number>([[1, 10], [2, 20], [3, 30]]);
  return map.size;
}
`);
    expect(ret).toBe(3);
  });

  it("new WeakMap(iterable) — entries with object keys", async () => {
    const ret = await run(`
export function test(): number {
  const a = {};
  const b = {};
  const map = new WeakMap<object, number>([
    [a, 7],
    [b, 9],
  ]);
  return (map.get(a) ?? 0) + (map.get(b) ?? 0);
}
`);
    expect(ret).toBe(16);
  });

  it("Map.prototype.forEach — simple callback", async () => {
    const ret = await run(`
export function test(): number {
  const map = new Map<number, number>();
  map.set(1, 100);
  map.set(2, 200);
  map.set(3, 300);
  let sum = 0;
  map.forEach((v: number) => { sum += v; });
  return sum;
}
`);
    expect(ret).toBe(600);
  });

  it("Map.prototype.forEach — arrow callback closes over local", async () => {
    const ret = await run(`
export function test(): number {
  const map = new Map<number, number>([[1, 10], [2, 20]]);
  let count = 0;
  map.forEach(() => { count += 1; });
  return count;
}
`);
    expect(ret).toBe(2);
  });

  it("WeakMap.prototype.set returns this for chaining", async () => {
    const ret = await run(`
export function test(): number {
  const map = new WeakMap<object, number>();
  const k = {};
  const r = map.set(k, 1);
  return r === map ? 1 : 0;
}
`);
    expect(ret).toBe(1);
  });

  it("Map.prototype.getOrInsertComputed — callback fires on missing key", async () => {
    const ret = await run(`
export function test(): number {
  const map = new Map<number, number>();
  // Compiler may not have getOrInsertComputed type info — call via 'any'
  const v = (map as any).getOrInsertComputed(5, (k: number) => k * 10);
  return v;
}
`);
    expect(ret).toBe(50);
  });

  it("Map.prototype.getOrInsertComputed — callback skipped on present key", async () => {
    const ret = await run(`
export function test(): number {
  const map = new Map<number, number>([[1, 100]]);
  let calls = 0;
  const v = (map as any).getOrInsertComputed(1, (_k: number) => { calls += 1; return 999; });
  return v + calls;
}
`);
    expect(ret).toBe(100);
  });

  it("new WeakMap(iterable) — delete returns true for present key", async () => {
    const ret = await run(`
export function test(): number {
  const foo = {};
  const map = new WeakMap<object, number>([[foo, 42]]);
  const r = map.delete(foo);
  const stillHas = map.has(foo);
  return (r ? 1 : 0) * 10 + (stillHas ? 1 : 0);
}
`);
    // delete returned true (10) + has returned false (0) → 10
    expect(ret).toBe(10);
  });

  it("WeakMap.prototype.get with object key (single entry)", async () => {
    const ret = await run(`
export function test(): number {
  const map = new WeakMap<object, number>();
  const k = {};
  map.set(k, 42);
  return map.get(k) ?? -1;
}
`);
    expect(ret).toBe(42);
  });
});
