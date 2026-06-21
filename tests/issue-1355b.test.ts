// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1355 Slice B — Proxy `getOwnPropertyDescriptor` trap (§10.5.5
// [[GetOwnProperty]]). `Object.getOwnPropertyDescriptor(proxy, key)` and
// `Reflect.getOwnPropertyDescriptor(proxy, key)` fall back to the native
// `__getOwnPropertyDescriptor` runtime helper for dynamic receivers; a
// `ref.test $Proxy` front-guard prepended to that helper diverts a proxy
// receiver to `__proxy_gopd_dispatch`, which reads the
// `getOwnPropertyDescriptor` trap closure off `$ProxyTraps`, invokes it
// (handler bound as `this`, args `(target, key)`) through the
// `__apply_closure` bridge, and returns the trap's descriptor externref (or
// undefined) directly. When the trap is absent, the dispatch forwards to the
// ordinary [[GetOwnProperty]] on the target.
//
// Spec: ECMA-262 §10.5.5 (Proxy [[GetOwnProperty]]).
//
// NOTE: §10.5.5 result-invariant checks (the trap must return an Object or
// undefined; consistency with non-configurable / non-extensible target
// properties) are NOT enforced in this slice — deferred to the invariant
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

describe("#1355 standalone Proxy — getOwnPropertyDescriptor trap (§10.5.5)", () => {
  it("getOwnPropertyDescriptor trap intercepts Object.getOwnPropertyDescriptor", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({ x: 5 }, { getOwnPropertyDescriptor: (t: any, k: any) => { hit = 1; return undefined; } });
        Object.getOwnPropertyDescriptor(p, "x");
        return hit;
      }`),
    ).toBe(1);
  });

  it("the trap receives the property key", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let seen = "";
        const p: any = new Proxy({}, { getOwnPropertyDescriptor: (t: any, k: any) => { seen = k; return undefined; } });
        Object.getOwnPropertyDescriptor(p, "abc");
        return seen === "abc" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("the trap's returned descriptor flows back to the caller", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, {
          getOwnPropertyDescriptor: (t: any, k: any) => ({ value: 42, configurable: true, enumerable: true, writable: true }),
        });
        const d: any = Object.getOwnPropertyDescriptor(p, "x");
        return d.value;
      }`),
    ).toBe(42);
  });

  it("the trap can read the descriptor off the target", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const t: any = { x: 9 };
        const p: any = new Proxy(t, {
          getOwnPropertyDescriptor: (tt: any, k: any) => Object.getOwnPropertyDescriptor(tt, k),
        });
        const d: any = Object.getOwnPropertyDescriptor(p, "x");
        return d.value;
      }`),
    ).toBe(9);
  });

  it("an absent getOwnPropertyDescriptor trap forwards to the ordinary [[GetOwnProperty]] on the target", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const t: any = { x: 7 };
        const p: any = new Proxy(t, {});
        const d: any = Object.getOwnPropertyDescriptor(p, "x");
        return d.value;
      }`),
    ).toBe(7);
  });

  it("does not disturb the Slice A deleteProperty trap on the same proxy", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let del = 0;
        let gopd = 0;
        const p: any = new Proxy({ x: 1 }, {
          deleteProperty: (t: any, k: any) => { del = 1; return true; },
          getOwnPropertyDescriptor: (t: any, k: any) => { gopd = 1; return undefined; },
        });
        Object.getOwnPropertyDescriptor(p, "x");
        delete p.x;
        return del === 1 && gopd === 1 ? 1 : 0;
      }`),
    ).toBe(1);
  });
});
