// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1355 — Wasm-native Proxy, remaining traps (standalone). Builds on #1100
// Phase 1 (get/set/has). This file covers the trap groups landed by #1355,
// one `describe` block per slice.
//
// Slice A — `deleteProperty` (§10.5.10 [[Delete]]). `delete proxy.x` (and
// `Reflect.deleteProperty`) route through the native `__delete_property`
// runtime helper; a `ref.test $Proxy` front-guard prepended to that helper
// diverts a proxy receiver to `__proxy_delete_dispatch`, which reads the
// `deleteProperty` trap closure off `$ProxyTraps`, invokes it (handler bound
// as `this`, args `(target, key)`) through the `__apply_closure` bridge, and
// coerces the booleanish trap result back to the delete operator's i32. When
// the trap is absent, the dispatch forwards to the ordinary [[Delete]] on the
// target.
//
// Spec: ECMA-262 §10.5.10 (Proxy [[Delete]]), §13.5.1 (delete operator).
//
// NOTE: as in #1100, the proxy is bound to a `const p: any` local so member
// access lowers to the dynamic `__delete_property` boundary (the path
// test262's untyped JS always takes). A statically-typed proxy local bypasses
// the meta-object — out of scope.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1355 standalone Proxy — deleteProperty trap (§10.5.10)", () => {
  it("deleteProperty trap intercepts `delete proxy.x`", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({ x: 5 }, { deleteProperty: (t: any, k: any) => { hit = 1; return true; } });
        delete p.x;
        return hit;
      }`),
    ).toBe(1);
  });

  it("the trap's truthy result becomes the delete operator's result (true)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({ x: 5 }, { deleteProperty: (t: any, k: any) => true });
        return (delete p.x) ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("a falsy trap result makes strict module delete throw", async () => {
    await expect(
      runStandalone(`export function test(): number {
        const p: any = new Proxy({ x: 5 }, { deleteProperty: (t: any, k: any) => false });
        return (delete p.x) ? 1 : 0;
      }`),
    ).rejects.toBeDefined();
  });

  it("Reflect.deleteProperty returns the trap's falsy result without throwing", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({ x: 5 }, { deleteProperty: (t: any, k: any) => false });
        return Reflect.deleteProperty(p, "x") ? 1 : 0;
      }`),
    ).toBe(0);
  });

  it("the trap receives the property key", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let seen = "";
        const p: any = new Proxy({}, { deleteProperty: (t: any, k: any) => { seen = k; return true; } });
        delete p.foo;
        return seen === "foo" ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("the trap receives the target and can delete through it", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const t: any = { x: 9 };
        const p: any = new Proxy(t, { deleteProperty: (tt: any, k: any) => { delete tt[k]; return true; } });
        delete p.x;
        return t.x === undefined ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("an absent deleteProperty trap forwards to the ordinary [[Delete]] on the target", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const t: any = { x: 1 };
        const p: any = new Proxy(t, {});
        delete p.x;
        return t.x === undefined ? 1 : 0;
      }`),
    ).toBe(1);
  });

  it("deleteProperty trap via computed-key access `delete proxy[k]`", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const key: any = "y";
        const p: any = new Proxy({ y: 2 }, { deleteProperty: (t: any, k: any) => { hit = 1; return true; } });
        delete p[key];
        return hit;
      }`),
    ).toBe(1);
  });
});
