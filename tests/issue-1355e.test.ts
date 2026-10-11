// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1355 Slice E — Proxy `ownKeys` (§10.5.11 [[OwnPropertyKeys]]) trap, standalone.
//
// `Object.keys(proxy)` lowers to the native `__object_keys` runtime helper for a
// dynamic receiver; `Object.getOwnPropertyNames(proxy)` / `Reflect.ownKeys`
// lower to `__getOwnPropertyNames`. A `ref.test $Proxy` front-guard prepended to
// each helper diverts a proxy receiver to a matching dispatch
// (`__proxy_ownkeys_keys_dispatch` / `__proxy_ownkeys_names_dispatch`). Both read
// the SAME `ownKeys` trap closure off `$ProxyTraps` and invoke it `(target)`
// (handler bound as `this`) through the `__apply_closure` bridge; they diverge
// only in the trap-ABSENT forward target (`__object_keys` vs
// `__getOwnPropertyNames`).
//
// §10.5.11 step 8 / CreateListFromArrayLike (§7.3.18 step 2) requires the trap
// result to be an Object — otherwise a TypeError. This slice enforces that
// top-level Object-type check (acceptance criterion #3 of #1355,
// `built-ins/Proxy/ownKeys/return-not-list-object-throws.js`): the result is an
// Object iff it is non-null and not a boxed primitive (number / boolean /
// string).
//
// Spec: ECMA-262 §10.5.11 ([[OwnPropertyKeys]]), §7.3.18 (CreateListFromArrayLike).
//
// DEFERRED to the dedicated invariant slice (NOT enforced here): the per-element
// String|Symbol type check (CreateListFromArrayLike element-type step) and the
// §10.5.11 result-invariants (no duplicate keys; non-extensible target → result
// must equal the target's exact own keys). The trap result is otherwise returned
// as-is.
//
// NOTE: as in #1100, the proxy is bound to a `const p: any` local so member
// access lowers to the dynamic boundary the untyped JS of test262 always takes.
// Reading individual string-key *elements* of the result via `[i]` is a separate
// pre-existing standalone limitation (the `$ObjVec` string-element readback gap,
// independent of Proxy), so these tests assert via `.length`, side-effects, and
// the throw path rather than element identity.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(src: string): Promise<unknown> {
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

describe("#1355 standalone Proxy — ownKeys trap (§10.5.11)", () => {
  it("ownKeys trap intercepts Object.keys", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({ a: 1, b: 2 }, { ownKeys: (t: any) => { hit = 1; return ["x", "y", "z"]; } });
        Object.keys(p);
        return hit;
      }`),
    ).toBe(1);
  });

  it("the ownKeys trap's array result flows through Object.keys (length observed)", async () => {
    // (#6770 S7) §20.1.2.17 Object.keys keeps only the trap's keys whose
    // [[GetOwnProperty]] answers an ENUMERABLE descriptor, so the trap's keys
    // must exist on the target (node answers 0 for a `{a, b}` target). Four
    // target keys, three returned: the trap's list, not the target's, is used.
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({ x: 1, y: 2, z: 3, w: 4 }, { ownKeys: (t: any) => ["x", "y", "z"] });
        return Object.keys(p).length;
      }`),
    ).toBe(3);
  });

  it("absent ownKeys trap forwards Object.keys to the target's ordinary keys", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({ a: 1, b: 2 }, {});
        return Object.keys(p).length;
      }`),
    ).toBe(2);
  });

  it("the trap receives the target (can re-key it) — handler-side keys re-derivable", async () => {
    // The trap reads the target's own keys (assign-then-return form; the
    // direct-tail-return-of-call closure shape is a separate pre-existing
    // closure-bridge limitation) and returns them; Object.keys(p) observes 2.
    expect(
      await runStandalone(`export function test(): number {
        const target: any = { foo: 1, bar: 2 };
        const p: any = new Proxy(target, { ownKeys: (t: any) => { const z: any = Object.keys(t); return z; } });
        return Object.keys(p).length;
      }`),
    ).toBe(2);
  });

  it("ownKeys trap returning a non-object (undefined) throws a TypeError (criterion #3)", async () => {
    // §10.5.11 step 8 / CreateListFromArrayLike step 2: Type(result) must be
    // Object. `return undefined` → TypeError. Mirrors test262
    // built-ins/Proxy/ownKeys/return-not-list-object-throws.js.
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, { ownKeys: (t: any) => undefined });
        try { Object.keys(p); return 0; } catch (e) { return 1; }
      }`),
    ).toBe(1);
  });

  it("ownKeys trap returning a boolean primitive throws a TypeError", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({}, { ownKeys: (t: any) => true });
        try { Object.keys(p); return 0; } catch (e) { return 1; }
      }`),
    ).toBe(1);
  });

  it("ownKeys trap intercepts Object.getOwnPropertyNames", async () => {
    expect(
      await runStandalone(`export function test(): number {
        let hit = 0;
        const p: any = new Proxy({ a: 1 }, { ownKeys: (t: any) => { hit = 1; return ["x"]; } });
        const r = Object.getOwnPropertyNames(p);
        return hit * 100 + r.length;
      }`),
    ).toBe(101);
  });

  it("absent ownKeys trap forwards Object.getOwnPropertyNames to the target", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const p: any = new Proxy({ a: 1, b: 2, c: 3 }, {});
        return Object.getOwnPropertyNames(p).length;
      }`),
    ).toBe(3);
  });

  it("plain (non-proxy) Object.keys / getOwnPropertyNames are unaffected (no regression)", async () => {
    expect(
      await runStandalone(`export function test(): number {
        const o: any = { a: 1, b: 2 };
        const names: any = { x: 1, y: 2, z: 3 };
        return Object.keys(o).length * 10 + Object.getOwnPropertyNames(names).length;
      }`),
    ).toBe(23);
  });
});
