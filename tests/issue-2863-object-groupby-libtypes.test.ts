// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2863 Phase 3 (lib-types) — `Object.groupBy(...)` no longer fails at the TS
// type-check layer.
//
// `Object.groupBy` (ES2024) is declared in `lib.es2024.object.d.ts`, which was
// NOT in the checker's ES base lib list (only `lib.es2024.collection.d.ts`,
// which carries `Map.groupBy`, was). So every `Object.groupBy(...)` call raised
// "Property 'groupBy' does not exist on type 'ObjectConstructor'" → a hard
// compile error, masking the working #965 host runtime (`__object_groupBy`) and
// blocking all `test/built-ins/Object/groupBy/**` tests before codegen ran.
//
// Fix: add `lib.es2024.object.d.ts` to `ES_BASE_LIB_NAMES` (src/checker/index.ts).
// Host (gc) mode now type-checks + runs via the existing runtime; standalone
// still loudly refuses `__object_groupBy` (the native carrier is separate work,
// #2919/#2921) — that boundary is asserted here so a future native impl doesn't
// silently regress the refusal contract.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";

async function runHost(source: string, fn = "test", args: unknown[] = []): Promise<unknown> {
  const result = await compile(source);
  expect(result.success, JSON.stringify(result.errors)).toBe(true);
  const imports = buildImports(result.imports, undefined, result.stringPool);
  const { instance } = await WebAssembly.instantiate(result.binary, imports);
  imports.setExports?.(instance.exports as Record<string, Function>);
  return (instance.exports as Record<string, (...a: unknown[]) => unknown>)[fn]!(...args);
}

describe("#2863 — Object.groupBy lib-types (host mode)", () => {
  it("Object.groupBy compiles (was 'Property groupBy does not exist')", async () => {
    const result = await compile(
      `export function test(): number { const o = Object.groupBy([1, 2, 3, 4], (x) => (x % 2 === 0 ? "e" : "o")); return (o as any).e.length; }`,
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
  });

  it("even/odd grouping returns the right bucket length", async () => {
    const src = `export function test(): number {
      const o = Object.groupBy([1, 2, 3, 4, 5, 6], (x) => (x % 2 === 0 ? "even" : "odd"));
      return (o as any).even.length;
    }`;
    expect(await runHost(src)).toBe(3);
  });

  it("group keys are stringified property keys", async () => {
    const src = `export function test(): number {
      const o = Object.groupBy([0, 1, 2, 3, 4], (x) => x % 2);
      // keys "0" and "1"; bucket "0" holds 0,2,4
      return (o as any)["0"].length;
    }`;
    expect(await runHost(src)).toBe(3);
  });

  it("Map.groupBy still compiles (regression guard for the pre-existing lib entry)", async () => {
    const result = await compile(
      `export function test(): number { const m = Map.groupBy([1, 2, 3, 4], (x) => (x % 2 === 0 ? "e" : "o")); return (m.get("e") as any).length; }`,
    );
    expect(result.success, JSON.stringify(result.errors)).toBe(true);
  });
});

describe("#2863 — Object.groupBy standalone boundary (still refuses)", () => {
  it("standalone refuses __object_groupBy (no host carrier yet)", async () => {
    const result = await compile(
      `export function test(): number { const o = Object.groupBy([1, 2, 3], (x) => (x % 2 === 0 ? "e" : "o")); return (o as any).e ? 1 : 0; }`,
      { target: "standalone" },
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => /__object_groupBy/.test(e.message))).toBe(true);
  });
});
