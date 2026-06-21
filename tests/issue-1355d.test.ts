// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1355 Slice D — Proxy `isExtensible` (§10.5.3 [[IsExtensible]]) and
// `preventExtensions` (§10.5.4 [[PreventExtensions]]) traps, standalone.
//
// `Object.isExtensible(proxy)` / `Reflect.isExtensible` fall back to the native
// `__object_isExtensible` runtime helper for dynamic receivers;
// `Object.preventExtensions(proxy)` (and `Object.seal`/`Object.freeze`, which
// call PreventExtensions) / `Reflect.preventExtensions` fall back to
// `__object_preventExtensions`. A `ref.test $Proxy` front-guard prepended to
// each helper diverts a proxy receiver to the matching dispatch
// (`__proxy_isext_dispatch` / `__proxy_prevext_dispatch`), which reads the trap
// closure off `$ProxyTraps`, invokes it `(target)` (handler bound as `this`)
// through the `__apply_closure` bridge, and returns a booleanish result. When
// the trap is absent, the dispatch forwards to the target's ordinary internal
// method.
//
// Spec: ECMA-262 §10.5.3 ([[IsExtensible]]), §10.5.4 ([[PreventExtensions]]).
//
// NOTE: §10.5.3/4 result-invariant checks (the trap result must equal
// IsExtensible(target); preventExtensions cannot report success while the target
// stays extensible) are NOT enforced in this slice — deferred to the invariant
// slice; the trap result is returned as-is.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1355 standalone Proxy — isExtensible trap (§10.5.3)", () => {
  it("isExtensible trap intercepts Object.isExtensible", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({}, { isExtensible: (t: any) => { hit = 1; return true; } });
        Object.isExtensible(p);
        return hit;
      }`),
    ).toBe(1);
  });

  it("the trap's truthy result is returned by Object.isExtensible", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, { isExtensible: (t: any) => true });
        return Object.isExtensible(p) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("the trap's falsy result is returned by Object.isExtensible", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, { isExtensible: (t: any) => false });
        return Object.isExtensible(p) ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("an absent isExtensible trap forwards to the target (fresh object is extensible)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, {});
        return Object.isExtensible(p) ? 1 : 0;
      }`),
    ).toBe(1);
  });
});

describe("#1355 standalone Proxy — preventExtensions trap (§10.5.4)", () => {
  it("preventExtensions trap intercepts Object.preventExtensions", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({}, { preventExtensions: (t: any) => { hit = 1; return true; } });
        Object.preventExtensions(p);
        return hit;
      }`),
    ).toBe(1);
  });

  it("an absent preventExtensions trap forwards the operation to the target", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const t: any = { a: 1 };
        const p: any = new Proxy(t, {});
        Object.preventExtensions(p);
        return Object.isExtensible(t) ? 1 : 0; // target now non-extensible → 0
      }`),
    ).toBe(0);
  });

  it("isExtensible and preventExtensions traps coexist with the Slice A/B/C traps", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let ie = 0, pe = 0, del = 0, gpo = 0;
        const p: any = new Proxy({ x: 1 }, {
          isExtensible: (t: any) => { ie = 1; return true; },
          preventExtensions: (t: any) => { pe = 1; return true; },
          deleteProperty: (t: any, k: any) => { del = 1; return true; },
          getPrototypeOf: (t: any) => { gpo = 1; return null; },
        });
        Object.isExtensible(p);
        Object.preventExtensions(p);
        delete p.x;
        Object.getPrototypeOf(p);
        return ie === 1 && pe === 1 && del === 1 && gpo === 1 ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
