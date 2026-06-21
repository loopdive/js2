// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2377 — standalone `Error.prototype` / `Map.prototype` / `Set.prototype`
// value reads (S6), extending #2376 (Date), #2374 (String/Number/Boolean),
// #2193 (Array/Object) and #2175 (RegExp).
//
// Reading `Error.prototype.<method>` (or Map/Set) AS A VALUE — not invoking it —
// refused in standalone:
//   "Codegen error: <Builtin>.prototype built-in static property value read is
//    not supported in --target standalone (#1907 / #1888 S6-b)".
// Root cause: tryEnsureNativeProtoBrand (property-access.ts) only wired the
// String/Number/Boolean/Date/Array/Object/RegExp $NativeProto glue; the
// Error/Map/Set brands are pre-reserved in native-proto.ts but never got a
// registered member-CSV glue.
// Fix: register native-proto glue for Error/Map/Set (array-object-proto.ts) and
// wire them into tryEnsureNativeProtoBrand. These three carry no runtime-state
// entanglement that breaks the value-read materialization (measured clean) —
// unlike Promise (runtime null-deref) and the TypedArray views (#2375 init
// trap), which are deliberately excluded.
//
// Measured: 46 test262 flips (Set 27 + Map 15 + Error 4), 0 regressions.
import { describe, it, expect } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<number> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, JSON.stringify(r.errors)).toBe(true);
  expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  expect(WebAssembly.validate(r.binary), "module must be valid Wasm").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test(): number }).test();
}

describe("#2377 — standalone Error/Map/Set.prototype value reads", () => {
  it("Error.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = Error.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Error.prototype.toString value read compiles (was a hard compile refusal)", async () => {
    const r = await compile(`export function test(): number { const m: any = Error.prototype.toString; return 1; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  });

  it("Map.prototype reads to a truthy value", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = Map.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Map.prototype.set.length folds the spec arity (2)", async () => {
    expect(await runStandalone(`export function test(): number { return Map.prototype.set.length; }`)).toBe(2);
  });

  it("Set.prototype reads to a truthy value", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = Set.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Set.prototype.add.length folds the spec arity (1)", async () => {
    expect(await runStandalone(`export function test(): number { return Set.prototype.add.length; }`)).toBe(1);
  });

  it("Set.prototype === Set.prototype (reference identity, single global)", async () => {
    expect(
      await runStandalone(`export function test(): number { return Set.prototype === Set.prototype ? 1 : 0; }`),
    ).toBe(1);
  });

  it("no regression: instance Set methods still work", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const s = new Set<number>();
          s.add(7);
          s.add(7);
          return s.size === 1 && s.has(7) ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("no regression: Date.prototype value read (the #2376 path) still resolves", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = Date.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });
});
