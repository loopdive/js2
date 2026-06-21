// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2193 (PR-A) — standalone `Array.prototype` / `Object.prototype` value reads.
//
// Reading a builtin's `.prototype` AS A VALUE refused in standalone:
//   "Codegen error: Array.prototype built-in static property value read is not
//    supported (#1907 / #1888 S6-b)".
// Root cause: property-access.ts resolves `<Builtin>.prototype` value reads only
// for builtins whose $NativeProto glue is registered — only RegExp registered.
// Fix: register native-proto glue for Array/Object (array-object-proto.ts) and
// wire it into tryEnsureNativeProtoBrand, so the read resolves to a host-free
// $NativeProto object (with reference identity). The proto OBJECT only needs the
// member CSV + name (emitLazyNativeProtoGet never calls emitMemberBody); per-
// member native bodies are a follow-up (#2193 PR-C). This was the #43 harvest's
// 2nd-biggest tractable standalone bucket (~83).
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

describe("#2193 (PR-A) — standalone builtin .prototype value reads", () => {
  it("Array.prototype reads to a truthy value (was a compile refusal)", async () => {
    expect(await runStandalone(`export function test(): number { const p = Array.prototype; return p ? 1 : 0; }`)).toBe(
      1,
    );
  });

  it("Object.prototype reads to a truthy value", async () => {
    expect(
      await runStandalone(`export function test(): number { const p = Object.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Array.prototype === Array.prototype (reference identity, single global)", async () => {
    expect(
      await runStandalone(`export function test(): number { return Array.prototype === Array.prototype ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Object.prototype === Object.prototype (reference identity)", async () => {
    expect(
      await runStandalone(`export function test(): number { return Object.prototype === Object.prototype ? 1 : 0; }`),
    ).toBe(1);
  });

  it("Object.prototype.hasOwnProperty.call(o, key) — the common assert shape", async () => {
    // `assert(Object.prototype.hasOwnProperty.call(o, "x"))` is a frequent
    // test262 idiom; the inner Object.prototype value read used to refuse.
    expect(
      await runStandalone(`
        export function test(): number {
          const o: any = { x: 1 };
          return Object.prototype.hasOwnProperty.call(o, "x") ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("no regression: instance array methods still work", async () => {
    expect(await runStandalone(`export function test(): number { return [3, 1, 2].sort()[0]; }`)).toBe(1);
  });

  it("no regression: RegExp.prototype value read (the #2175 path) still resolves", async () => {
    expect(
      await runStandalone(`export function test(): number { const p = RegExp.prototype; return p ? 1 : 0; }`),
    ).toBe(1);
  });
});

// PR-B — a value-materialized Array.prototype member method is CALLABLE via
// `.call` / `.apply`. The blocker was the reflective `call_ref`'s trailing
// operand: it pushed the wrapper struct instead of the funcref from the
// wrapper's field 0, so validation reported the classic `expected (ref
// $funcType) found (ref $wrapStruct)` off-by-one. Extracting the funcref (the
// canonical closure-call tail) before call_ref fixes it.
describe("#2193 (PR-B) — value-materialized proto method called via .call/.apply", () => {
  it("Array.prototype.slice.call(a, 1, 3) === a.slice(1, 3)", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a = [10, 20, 30, 40, 50];
          const m = Array.prototype.slice;
          const r = m.call(a, 1, 3);
          const s = a.slice(1, 3);
          return r[0] === s[0] && r[1] === s[1] && r.length === s.length ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it(".call threads thisArg → receiver: slice values are correct", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a = [10, 20, 30, 40, 50];
          const m = Array.prototype.slice;
          const r = m.call(a, 1, 3);
          // r === [20, 30]
          return r.length === 2 && r[0] === 20 && r[1] === 30 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it(".apply with a static array arg list reshapes [thisArg, ...args]", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a = [10, 20, 30, 40, 50];
          const m = Array.prototype.slice;
          const r = m.apply(a, [1, 3]);
          return r.length === 2 && r[0] === 20 && r[1] === 30 ? 1 : 0;
        }
      `),
    ).toBe(1);
  });

  it("no regression: the plain instance a.slice(1, 3) path still works", async () => {
    expect(
      await runStandalone(`
        export function test(): number {
          const a = [10, 20, 30, 40, 50];
          const s = a.slice(1, 3);
          return s[0] + s[1];
        }
      `),
    ).toBe(50);
  });
});
