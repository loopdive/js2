// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2376 — standalone `Date.prototype` value reads (S5), extending #2374
// (String/Number/Boolean), #2193 (Array/Object) and #2175 (RegExp).
//
// Reading `Date.prototype.<method>` (or bare `Date.prototype`) AS A VALUE — not
// invoking it — refused in standalone:
//   "Codegen error: Date.prototype built-in static property value read is not
//    supported in --target standalone (#1907 / #1888 S6-b)".
// Root cause: tryEnsureNativeProtoBrand (property-access.ts) only wired
// String/Number/Boolean/Array/Object/RegExp $NativeProto glue; the Date brand is
// pre-reserved in native-proto.ts but never got a registered member-CSV glue.
// Fix: register native-proto glue for Date (array-object-proto.ts) and wire it
// into tryEnsureNativeProtoBrand. Date carries no vec/runtime brand
// entanglement (unlike the TypedArray views, see #2375), so the proto-object
// materialization is clean.
//
// Measured: 60 Date test262 flips, 0 regressions on a 58-test passing sample,
// WAT byte-identical on the green Date-method path (purely additive).
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

describe("#2376 — standalone Date.prototype value reads", () => {
  it("Date.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = Date.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Date.prototype.getFullYear value read compiles (was a hard compile refusal)", async () => {
    // PR-A scope (same as #2193/#2374): the bare method-VALUE read no longer
    // refuses at compile time. Per-member native bodies are a follow-up.
    const r = await compile(`export function test(): number { const m: any = Date.prototype.getFullYear; return 1; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  });

  it("Date.prototype.setUTCFullYear.length folds the spec arity (3)", async () => {
    expect(await runStandalone(`export function test(): number { return Date.prototype.setUTCFullYear.length; }`)).toBe(
      3,
    );
  });

  it("Date.prototype.getTime.length folds the spec arity (0)", async () => {
    expect(await runStandalone(`export function test(): number { return Date.prototype.getTime.length; }`)).toBe(0);
  });

  it("Date.prototype.setHours.length folds the spec arity (4)", async () => {
    expect(await runStandalone(`export function test(): number { return Date.prototype.setHours.length; }`)).toBe(4);
  });

  it("Date.prototype === Date.prototype (reference identity, single global)", async () => {
    expect(
      await runStandalone(`export function test(): number { return Date.prototype === Date.prototype ? 1 : 0; }`),
    ).toBe(1);
  });

  it("no regression: instance Date methods still work", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const d = new Date(2020, 0, 15);
          d.setFullYear(2021);
          return d.getFullYear() === 2021 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("no regression: String.prototype value read (the #2374 path) still resolves", async () => {
    expect(
      await runStandalone(`export function test(): number { const p = String.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });
});
