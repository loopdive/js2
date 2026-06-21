// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2378 — standalone `Function` / `Symbol` / `BigInt` / `WeakMap` / `WeakSet`
// `.prototype` value reads (S7), extending #2374/#2376/#2377 and #2193/#2175.
//
// Reading `<Builtin>.prototype.<method>` AS A VALUE — not invoking it — refused
// in standalone (#1907 / #1888 S6-b). Root cause: tryEnsureNativeProtoBrand
// (property-access.ts) had no glue for these five brands; their brands are
// pre-reserved in native-proto.ts but never got a member-CSV glue. Fix:
// register native-proto glue for each and wire it into tryEnsureNativeProtoBrand.
// None of these five carry runtime-state entanglement that breaks the
// value-read materialization (measured clean) — unlike Promise (runtime
// null-deref) / the TypedArray + ArrayBuffer/DataView buffer brands (#2375 init
// trap), which are deliberately excluded.
//
// Measured: 33 flips (Function 10 + WeakMap 9 + WeakSet 7 + Symbol 4 + BigInt 3),
// 0 regressions, 0 traps.
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

describe("#2378 — standalone Function/Symbol/BigInt/WeakMap/WeakSet.prototype value reads", () => {
  it("Function.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = Function.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Function.prototype.apply.length folds the spec arity (2)", async () => {
    expect(await runStandalone(`export function test(): number { return Function.prototype.apply.length; }`)).toBe(2);
  });

  it("Function.prototype.call value read compiles (was a hard compile refusal)", async () => {
    const r = await compile(`export function test(): number { const m: any = Function.prototype.call; return 1; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  });

  it("Symbol.prototype reads to a truthy value", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = Symbol.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("BigInt.prototype reads to a truthy value", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = BigInt.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("WeakMap.prototype reads to a truthy value", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = WeakMap.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("WeakSet.prototype reads to a truthy value", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = WeakSet.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("WeakMap.prototype === WeakMap.prototype (reference identity)", async () => {
    expect(
      await runStandalone(`export function test(): number { return WeakMap.prototype === WeakMap.prototype ? 1 : 0; }`),
    ).toBe(1);
  });

  it("no regression: instance Function.call still works", async () => {
    expect(
      await runStandalone(`
        function add(a: number, b: number): number { return a + b; }
        export function test(): number { return add.call(null as any, 2, 3) === 5 ? 1 : 0; }
      `),
    ).toBe(1);
  });

  it("no regression: Set.prototype value read (the #2377 path) still resolves", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = Set.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });
});
