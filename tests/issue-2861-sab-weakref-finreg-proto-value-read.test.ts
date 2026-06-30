// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2861 (slice 2) — standalone `SharedArrayBuffer.prototype` / `WeakRef.prototype`
// / `FinalizationRegistry.prototype` value reads, extending the ArrayBuffer +
// DataView slice and the native-proto-glue chain (#2376 Date, #2651 TypedArray,
// #2374 String/Number/Boolean, #2193 Array/Object, #2175 RegExp).
//
// Reading `<Builtin>.prototype.<member>` (or bare `<Builtin>.prototype`) AS A
// VALUE refused in standalone with the "built-in static property value read is
// not supported in --target standalone (#1907 / #1888 S6-b)" compile error.
// Fix: register native-proto glue for SharedArrayBuffer (mirrors ArrayBuffer's
// getter shape), WeakRef (single `deref` method) and FinalizationRegistry
// (`register`/`unregister`; brand newly appended to native-proto.ts slot 40),
// and wire them into tryEnsureNativeProtoBrand. All three carry their state on
// the INSTANCE (held value / shared byte vec / registry cells), never the proto,
// so the value-object materialization is clean. Member-CLOSURE bodies degrade to
// a catchable TypeError until native bodies land (the #2193/#2651 pattern).
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

describe("#2861 slice 2 — standalone SharedArrayBuffer.prototype value reads", () => {
  it("SharedArrayBuffer.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const p: any = SharedArrayBuffer.prototype; return p ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("SharedArrayBuffer.prototype.slice.length folds the spec arity (2)", async () => {
    expect(
      await runStandalone(`export function test(): number { return SharedArrayBuffer.prototype.slice.length; }`),
    ).toBe(2);
  });

  it("SharedArrayBuffer.prototype.grow.length folds the spec arity (1)", async () => {
    expect(
      await runStandalone(`export function test(): number { return SharedArrayBuffer.prototype.grow.length; }`),
    ).toBe(1);
  });

  it("SharedArrayBuffer.prototype.byteLength is an accessor getter — .length folds to 0", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (SharedArrayBuffer.prototype as any).byteLength.length; }`,
      ),
    ).toBe(0);
  });
});

describe("#2861 slice 2 — standalone WeakRef.prototype value reads", () => {
  it("WeakRef.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = WeakRef.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("WeakRef.prototype.deref value read compiles (was a hard compile refusal)", async () => {
    const r = await compile(`export function test(): number { const m: any = WeakRef.prototype.deref; return 1; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  });

  it("WeakRef.prototype.deref.length folds the spec arity (0)", async () => {
    expect(await runStandalone(`export function test(): number { return WeakRef.prototype.deref.length; }`)).toBe(0);
  });
});

describe("#2861 slice 2 — standalone FinalizationRegistry.prototype value reads", () => {
  it("FinalizationRegistry.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { const p: any = FinalizationRegistry.prototype; return p ? 1 : 0; }`,
      ),
    ).toBe(1);
  });

  it("FinalizationRegistry.prototype.register.length folds the spec arity (2)", async () => {
    expect(
      await runStandalone(`export function test(): number { return FinalizationRegistry.prototype.register.length; }`),
    ).toBe(2);
  });

  it("FinalizationRegistry.prototype.unregister.length folds the spec arity (1)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return FinalizationRegistry.prototype.unregister.length; }`,
      ),
    ).toBe(1);
  });
});

describe("#2861 slice 2 — no regression on sibling proto glue", () => {
  it("sibling: ArrayBuffer.prototype value read (the #2861 slice-1 path) still resolves", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = ArrayBuffer.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("sibling: WeakSet.prototype value read still resolves", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = WeakSet.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });
});
