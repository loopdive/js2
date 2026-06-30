// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2861 — standalone `ArrayBuffer.prototype` / `DataView.prototype` value reads,
// extending the native-proto-glue chain (#2376 Date, #2377 Error/Map/Set, #2378
// Function/Symbol/BigInt/Weak, #2374 String/Number/Boolean, #2193 Array/Object,
// #2651 TypedArray views, #2175 RegExp).
//
// Reading `ArrayBuffer.prototype.<member>` (or bare `ArrayBuffer.prototype`) AS A
// VALUE — not invoking it — refused in standalone:
//   "Codegen error: ArrayBuffer.prototype built-in static property value read is
//    not supported in --target standalone (#1907 / #1888 S6-b)".
// Root cause: tryEnsureNativeProtoBrand (property-access.ts) never wired the
// ArrayBuffer / DataView $NativeProto glue, though both ctor brands are
// pre-reserved in native-proto.ts. Fix: register native-proto glue for both
// (array-object-proto.ts, with the accessor getters byteLength/buffer/byteOffset
// marked so their `.length` meta folds to 0) and wire into
// tryEnsureNativeProtoBrand. Both protos carry no vec/runtime brand entanglement
// — the byte vec lives on the INSTANCE, never the proto — so the value-object
// materialization is clean (member bodies degrade to a catchable TypeError until
// native bodies land, the #2193/#2651 pattern).
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

describe("#2861 — standalone ArrayBuffer.prototype value reads", () => {
  it("ArrayBuffer.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = ArrayBuffer.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("ArrayBuffer.prototype.slice value read compiles (was a hard compile refusal)", async () => {
    const r = await compile(
      `export function test(): number { const m: any = ArrayBuffer.prototype.slice; return 1; }`,
      { target: "standalone" },
    );
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  });

  it("ArrayBuffer.prototype.slice.length folds the spec arity (2)", async () => {
    expect(await runStandalone(`export function test(): number { return ArrayBuffer.prototype.slice.length; }`)).toBe(
      2,
    );
  });

  it("ArrayBuffer.prototype.resize.length folds the spec arity (1)", async () => {
    expect(await runStandalone(`export function test(): number { return ArrayBuffer.prototype.resize.length; }`)).toBe(
      1,
    );
  });

  it("ArrayBuffer.prototype.byteLength is an accessor getter — .length folds to 0", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return (ArrayBuffer.prototype as any).byteLength.length; }`,
      ),
    ).toBe(0);
  });

  it("ArrayBuffer.prototype === ArrayBuffer.prototype (reference identity, single global)", async () => {
    expect(
      await runStandalone(
        `export function test(): number { return ArrayBuffer.prototype === ArrayBuffer.prototype ? 1 : 0; }`,
      ),
    ).toBe(1);
  });
});

describe("#2861 — standalone DataView.prototype value reads", () => {
  it("DataView.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = DataView.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("DataView.prototype.getInt8 value read compiles (was a hard compile refusal)", async () => {
    const r = await compile(`export function test(): number { const m: any = DataView.prototype.getInt8; return 1; }`, {
      target: "standalone",
    });
    expect(r.success, JSON.stringify(r.errors)).toBe(true);
    expect((r.imports ?? []).map((i) => i.name)).toEqual([]);
  });

  it("DataView.prototype.getInt8.length folds the spec arity (1)", async () => {
    expect(await runStandalone(`export function test(): number { return DataView.prototype.getInt8.length; }`)).toBe(1);
  });

  it("DataView.prototype.setFloat64.length folds the spec arity (2)", async () => {
    expect(await runStandalone(`export function test(): number { return DataView.prototype.setFloat64.length; }`)).toBe(
      2,
    );
  });

  it("DataView.prototype.byteLength is an accessor getter — .length folds to 0", async () => {
    expect(
      await runStandalone(`export function test(): number { return (DataView.prototype as any).byteLength.length; }`),
    ).toBe(0);
  });

  it("DataView.prototype.buffer is an accessor getter — .length folds to 0", async () => {
    expect(
      await runStandalone(`export function test(): number { return (DataView.prototype as any).buffer.length; }`),
    ).toBe(0);
  });
});

describe("#2861 — no regression on instance use / sibling proto glue", () => {
  it("instance ArrayBuffer.byteLength still works", async () => {
    expect(
      await runStandalone(`export function test(): number { const b = new ArrayBuffer(16); return b.byteLength; }`),
    ).toBe(16);
  });

  it("instance DataView round-trips through getInt32/setInt32", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const b = new ArrayBuffer(8);
          const dv = new DataView(b);
          dv.setInt32(0, 12345);
          return dv.getInt32(0);
        }
      `),
    ).toBe(12345);
  });

  it("sibling: TypedArray view proto value read (the #2651 path) still resolves", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = Int8Array.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("sibling: Date.prototype value read (the #2376 path) still resolves", async () => {
    expect(
      await runStandalone(`export function test(): number { const p: any = Date.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });
});
