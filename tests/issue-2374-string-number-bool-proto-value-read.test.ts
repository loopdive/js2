// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2374 — standalone `String.prototype` / `Number.prototype` / `Boolean.prototype`
// value reads (S4 wrapper protos), extending #2193 (Array/Object) and #2175
// (RegExp).
//
// Reading `String.prototype.<method>` (or Number/Boolean) AS A VALUE — not
// invoking it — refused in standalone:
//   "Codegen error: String.prototype built-in static property value read is not
//    supported in --target standalone (#1907 / #1888 S6-b)".
// Root cause: tryEnsureNativeProtoBrand (property-access.ts) only wired
// Array/Object/RegExp $NativeProto glue; the String/Number/Boolean brands are
// pre-reserved in native-proto.ts but never get a registered member-CSV glue.
// Fix: register native-proto glue for String/Number/Boolean
// (array-object-proto.ts) and wire it into tryEnsureNativeProtoBrand, so the
// read resolves to a host-free $NativeProto object. The proto OBJECT only needs
// the member CSV + name (emitLazyNativeProtoGet never calls emitMemberBody);
// per-member native bodies are a follow-up.
//
// Measured: 51 String + 11 Number + 5 Boolean test262 flips, 0 regressions on a
// 68-test passing sample.
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

describe("#2374 — standalone String/Number/Boolean.prototype value reads", () => {
  it("String.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(
      await runStandalone(`export function test(): number { const p = String.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("String.prototype.search value read compiles (was a hard compile refusal)", async () => {
    // PR-A scope (same as #2193 Array/Object): the bare method-VALUE read no
    // longer refuses at compile time. Per-member native bodies are a follow-up,
    // so the materialized value is a placeholder (parity with
    // `Array.prototype.slice`); the win is that the module COMPILES host-free.
    const r = await compile(`export function test(): number { const m: any = String.prototype.search; return 1; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  });

  it("String.prototype.toUpperCase.length folds the spec arity (0)", async () => {
    expect(await runStandalone(`export function test(): number { return String.prototype.toUpperCase.length; }`)).toBe(
      0,
    );
  });

  it("String.prototype.replace.length folds the spec arity (2)", async () => {
    expect(await runStandalone(`export function test(): number { return String.prototype.replace.length; }`)).toBe(2);
  });

  it("Number.prototype reads to a truthy value", async () => {
    expect(
      await runStandalone(`export function test(): number { const p = Number.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Number.prototype.toFixed.length folds the spec arity (1)", async () => {
    expect(await runStandalone(`export function test(): number { return Number.prototype.toFixed.length; }`)).toBe(1);
  });

  it("Boolean.prototype reads to a truthy value", async () => {
    expect(
      await runStandalone(`export function test(): number { const p = Boolean.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Boolean.prototype.valueOf value read compiles (was a hard compile refusal)", async () => {
    const r = await compile(`export function test(): number { const m: any = Boolean.prototype.valueOf; return 1; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  });

  it("String.prototype === String.prototype (reference identity, single global)", async () => {
    expect(
      await runStandalone(`export function test(): number { return String.prototype === String.prototype ? 1 : 0; }`),
    ).toBe(1);
  });

  it("no regression: instance string methods still work", async () => {
    expect(
      await runStandalone(`export function test(): number { return "ABC".toLowerCase() === "abc" ? 1 : 0; }`),
    ).toBe(1);
  });

  it("no regression: Array.prototype value read (the #2193 path) still resolves", async () => {
    expect(await runStandalone(`export function test(): number { const p = Array.prototype; return p ? 1 : 0; }`)).toBe(
      1,
    );
  });
});
