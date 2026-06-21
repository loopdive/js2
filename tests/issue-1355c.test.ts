// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1355 Slice C — Proxy `getPrototypeOf` (§10.5.1 [[GetPrototypeOf]]) and
// `setPrototypeOf` (§10.5.2 [[SetPrototypeOf]]) traps, standalone.
//
// `Object.getPrototypeOf(proxy)` / `Reflect.getPrototypeOf` (and `__proto__`
// reads) fall back to the native `__getPrototypeOf` runtime helper for dynamic
// receivers; `Object.setPrototypeOf(proxy, v)` / `Reflect.setPrototypeOf` (and
// `__proto__` writes) fall back to `__object_setPrototypeOf`. A `ref.test
// $Proxy` front-guard prepended to each helper diverts a proxy receiver to the
// matching dispatch (`__proxy_gpo_dispatch` / `__proxy_spo_dispatch`), which
// reads the trap closure off `$ProxyTraps`, invokes it (handler bound as
// `this`) through the `__apply_closure` bridge — getPrototypeOf with
// `(target)`, setPrototypeOf with `(target, proto)` — and returns the trap's
// result. When the trap is absent, the dispatch forwards to the ordinary
// internal method on the target.
//
// Spec: ECMA-262 §10.5.1 ([[GetPrototypeOf]]), §10.5.2 ([[SetPrototypeOf]]).
//
// NOTE: §10.5.1/2 result-invariant checks (for a non-extensible target the trap
// result must equal the target's actual prototype) are NOT enforced in this
// slice — deferred to the invariant slice; the trap result is returned as-is.
// Assertions are value-based (read a field off / through the prototype) rather
// than `===` identity, which standalone prototype-object identity does not
// preserve across the getPrototypeOf boundary independently of Proxy.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1355 standalone Proxy — getPrototypeOf trap (§10.5.1)", () => {
  it("getPrototypeOf trap intercepts Object.getPrototypeOf", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({}, { getPrototypeOf: (t: any) => { hit = 1; return null; } });
        Object.getPrototypeOf(p);
        return hit;
      }`),
    ).toBe(1);
  });

  it("the trap's returned prototype flows back to the caller", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const proto: any = { tag: 99 };
        const p: any = new Proxy({}, { getPrototypeOf: (t: any) => proto });
        const r: any = Object.getPrototypeOf(p);
        return r.tag;
      }`),
    ).toBe(99);
  });

  it("an absent getPrototypeOf trap forwards to the target's prototype", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const proto: any = { k: 42 };
        const t: any = Object.create(proto);
        const p: any = new Proxy(t, {});
        const r: any = Object.getPrototypeOf(p);
        return r ? r.k : -1;
      }`),
    ).toBe(42);
  });
});

describe("#1355 standalone Proxy — setPrototypeOf trap (§10.5.2)", () => {
  it("setPrototypeOf trap intercepts Object.setPrototypeOf", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({}, { setPrototypeOf: (t: any, v: any) => { hit = 1; return true; } });
        Object.setPrototypeOf(p, null);
        return hit;
      }`),
    ).toBe(1);
  });

  it("the trap receives the new prototype argument", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let tag = 0;
        const proto: any = { tag: 7 };
        const p: any = new Proxy({}, { setPrototypeOf: (t: any, v: any) => { tag = v.tag; return true; } });
        Object.setPrototypeOf(p, proto);
        return tag;
      }`),
    ).toBe(7);
  });

  it("an absent setPrototypeOf trap forwards the set to the target", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const proto: any = { k: 13 };
        const t: any = {};
        const p: any = new Proxy(t, {});
        Object.setPrototypeOf(p, proto);
        return t.k; // inherited through the newly-set prototype
      }`),
    ).toBe(13);
  });

  it("getPrototypeOf and setPrototypeOf traps coexist with the Slice A/B traps", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let gpo = 0, spo = 0, del = 0, gopd = 0;
        const p: any = new Proxy({ x: 1 }, {
          getPrototypeOf: (t: any) => { gpo = 1; return null; },
          setPrototypeOf: (t: any, v: any) => { spo = 1; return true; },
          deleteProperty: (t: any, k: any) => { del = 1; return true; },
          getOwnPropertyDescriptor: (t: any, k: any) => { gopd = 1; return undefined; },
        });
        Object.getPrototypeOf(p);
        Object.setPrototypeOf(p, null);
        delete p.x;
        Object.getOwnPropertyDescriptor(p, "x");
        return gpo === 1 && spo === 1 && del === 1 && gopd === 1 ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
