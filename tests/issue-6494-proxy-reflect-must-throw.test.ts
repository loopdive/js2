// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6494 — six `--target standalone` Proxy/Reflect paths whose whole spec step is
// "throw a TypeError" and which returned silently instead. Each `it` below pins
// one of the six, and the second `describe` pins the six shapes that ALREADY
// threw correctly on `origin/main` @ `c698c755bb` — the ones a widened check
// would break. Measured, not inferred: every probe here was run against that
// base commit first and answered "no throw" / "throw" exactly as labelled.
//
// What the four changes are, and the trap each one steps over:
//
//  1. `Reflect.get`/`Reflect.has` with a STATICALLY nullish target
//     (§28.1.6 / §28.1.9 step 1). The runtime guard
//     (`emitNativeReflectNonObjectGuard`) deliberately declines to brand
//     `null`/`undefined` at runtime, because this compiler's alias/element
//     widening nulls ORDINARY objects — branding them would turn working
//     programs into TypeErrors. The fix is therefore a COMPILE-TIME fact about
//     the argument expression: `Reflect.get(null, 'p')` cannot be a nulled real
//     object. The number/string spellings already threw; null/undefined were
//     the residual, and they are half the assertions in
//     `Reflect/{get,has}/target-is-not-object-throws.js`.
//
//  2. `Object.defineProperty(proxy, …)` when the `defineProperty` trap returns
//     false (§DefinePropertyOrThrow step 4). The applier result was tested with
//     `ref.is_null`, and a `false` trap return is a boxed `false`, not null —
//     so it sailed through. `Reflect.defineProperty` already read the same
//     value through `__is_truthy` and answered `false` correctly.
//
//  3. Strict `proxy.x = v` when the `set` trap returns false (§Set(O,P,V,true)
//     step 4). `$Proxy` is NOT a subtype of `$Object`, so `__extern_set_strict`
//     took its non-`$Object` arm into `__extern_set`, whose proxy guard runs
//     the trap and DROPS the answer. Only the trap-PRESENT arm is intercepted:
//     `__proxy_set_dispatch`'s trap-absent arm pushes `ref.null.extern` as a
//     placeholder, and `__is_truthy(null)` is 0 — reading it would throw on
//     every trap-absent proxy.
//
//  4. Revoked-proxy reachability (§10.5: every internal method throws).
//     `Object.defineProperty(p.proxy, …)` and `Array.prototype.map.call(p.proxy,
//     f)` both bypassed the revoked check — the first because the proxy-receiver
//     reroute recognised only `new Proxy(...)` and not `Proxy.revocable(...).proxy`
//     (so the inline `__defineProperty_value` fast path `ref.cast $Object`ed the
//     carrier and the trap ran ZERO times), the second because `__extern_length`
//     and `__extern_get_idx` carry no proxy front guard.
//
// SLOPPY mode is pinned too: §Set(O,P,V,false) must NOT throw, and the strict
// arm is reached only through `__extern_set_strict`.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** 1 = TypeError, 2 = some other throw, 0 = no throw. */
const TRY_HELPER = `
function tryIt(f: () => void): number {
  try { f(); } catch (e) { return (e instanceof TypeError) ? 1 : 2; }
  return 0;
}
`;

async function runStandalone(body: string): Promise<number> {
  const src = `${TRY_HELPER}\nexport function test(): number {\n${body}\n}\n`;
  const r = await compile(src, { target: "standalone" });
  expect(r.success, r.errors.map((e) => e.message).join("\n")).toBe(true);
  // The whole point of the standalone lane: no JS host may appear.
  expect(r.imports ?? [], "standalone module must import nothing").toEqual([]);
  expect(WebAssembly.validate(r.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => number }).test();
}

describe("#6494 standalone Proxy/Reflect — the six paths that must throw", () => {
  it("Reflect.get(<non-object>, k) throws for every non-object spelling", async () => {
    expect(
      await runStandalone(`
      const a = tryIt(() => { Reflect.get(1 as any, "p"); });
      const b = tryIt(() => { Reflect.get(null as any, "p"); });
      const c = tryIt(() => { Reflect.get(undefined as any, "p"); });
      const d = tryIt(() => { Reflect.get("" as any, "p"); });
      return a * 1000 + b * 100 + c * 10 + d;`),
    ).toBe(1111);
  });

  it("Reflect.has(<non-object>, k) throws for every non-object spelling", async () => {
    expect(
      await runStandalone(`
      const a = tryIt(() => { Reflect.has(1 as any, "p"); });
      const b = tryIt(() => { Reflect.has(null as any, "p"); });
      const c = tryIt(() => { Reflect.has(undefined as any, "p"); });
      const d = tryIt(() => { Reflect.has("" as any, "p"); });
      return a * 1000 + b * 100 + c * 10 + d;`),
    ).toBe(1111);
  });

  it("a revoked proxy throws when an internal method is reached via Array.prototype.map", async () => {
    expect(
      await runStandalone(`
      const r: any = Proxy.revocable([1, 2, 3], {});
      r.revoke();
      return tryIt(() => { Array.prototype.map.call(r.proxy, function (x: any) { return x; }); });`),
    ).toBe(1);
  });

  it("a revoked proxy throws through Object.defineProperty (Proxy.revocable(...).proxy receiver)", async () => {
    expect(
      await runStandalone(`
      const r: any = Proxy.revocable({}, {});
      r.revoke();
      return tryIt(() => { Object.defineProperty(r.proxy, "foo", { configurable: true, enumerable: true }); });`),
    ).toBe(1);
  });

  it("Object.defineProperty throws when the defineProperty trap returns false", async () => {
    expect(
      await runStandalone(`
      const p: any = new Proxy({}, { defineProperty: function () { return false; } });
      return tryIt(() => { Object.defineProperty(p, "x", { value: 1 }); });`),
    ).toBe(1);
  });

  it("a strict-mode write throws when the set trap returns false", async () => {
    expect(
      await runStandalone(`
      "use strict";
      const p: any = new Proxy({}, { set: function () { return false; } });
      return tryIt(() => { p.x = 1; });`),
    ).toBe(1);
  });

  it("the define trap actually RUNS through a Proxy.revocable(...).proxy receiver", async () => {
    // Regression pin for the measured "trap ran ZERO times" defect: before this
    // slice the inline fast path stored straight into the proxy carrier.
    expect(
      await runStandalone(`
      let n = 0;
      const r: any = Proxy.revocable({}, { defineProperty: function () { n = n + 1; return true; } });
      Object.defineProperty(r.proxy, "foo", { value: 1 });
      return n;`),
    ).toBe(1);
  });
});

describe("#6494 — the six shapes that already threw and must keep throwing", () => {
  it("deleteProperty trap returning false throws in strict mode", async () => {
    expect(
      await runStandalone(`
      "use strict";
      const p: any = new Proxy({}, { deleteProperty: function () { return false; } });
      return tryIt(() => { delete p.x; });`),
    ).toBe(1);
  });

  it("setPrototypeOf trap returning false throws", async () => {
    expect(
      await runStandalone(`
      const p: any = new Proxy({}, { setPrototypeOf: function () { return false; } });
      return tryIt(() => { Object.setPrototypeOf(p, null); });`),
    ).toBe(1);
  });

  it("preventExtensions trap returning false throws", async () => {
    expect(
      await runStandalone(`
      const p: any = new Proxy({}, { preventExtensions: function () { return false; } });
      return tryIt(() => { Object.preventExtensions(p); });`),
    ).toBe(1);
  });

  it("a present non-callable trap throws", async () => {
    expect(
      await runStandalone(`
      const p: any = new Proxy({}, { get: 1 } as any);
      return tryIt(() => { const v = p.x; return v; });`),
    ).toBe(1);
  });

  it("Reflect.construct with a non-constructor newTarget throws", async () => {
    expect(
      await runStandalone(`
      function f() {}
      return tryIt(() => { (Reflect as any).construct(f, [], 1); });`),
    ).toBe(1);
  });

  it("a revoked proxy read directly still throws", async () => {
    expect(
      await runStandalone(`
      const r: any = Proxy.revocable({}, {});
      r.revoke();
      return tryIt(() => { const v = r.proxy.x; return v; });`),
    ).toBe(1);
  });
});

describe("#6494 — the shapes a widened check would break", () => {
  it("a true-returning set trap does not throw and a true-returning define trap does not throw", async () => {
    expect(
      await runStandalone(`
      "use strict";
      const p: any = new Proxy({}, { set: function () { return true; } });
      const q: any = new Proxy({}, { defineProperty: function () { return true; } });
      let ok = 0;
      try { p.x = 1; ok = ok + 1; } catch (e) { return -1; }
      try { Object.defineProperty(q, "x", { value: 1 }); ok = ok + 1; } catch (e) { return -2; }
      return ok;`),
    ).toBe(2);
  });

  it("a trap-ABSENT proxy still writes through and still defines through", async () => {
    // The `ref.null.extern` placeholder trap: reading the trap-absent arm's
    // result would throw on every one of these.
    expect(
      await runStandalone(`
      "use strict";
      const t: any = {};
      const p: any = new Proxy(t, {});
      const u: any = {};
      const q: any = new Proxy(u, {});
      try { p.x = 7; } catch (e) { return -1; }
      try { Object.defineProperty(q, "y", { value: 9, writable: true, enumerable: true, configurable: true }); }
      catch (e) { return -2; }
      return (t.x === 7 ? 1 : 0) + (u.y === 9 ? 10 : 0);`),
    ).toBe(11);
  });

  it("Reflect.get / Reflect.has on ordinary objects keep answering", async () => {
    expect(
      await runStandalone(`
      const o: any = { x: 5 };
      const arr: any = [1, 2, 3];
      const g = Reflect.get(o, "x") as any;
      const h = Reflect.has(o, "x") ? 1 : 0;
      const ga = Reflect.get(arr, "length") as any;
      return g * 100 + h * 10 + ga;`),
    ).toBe(513);
  });

  it("a live (non-revoked) proxy over an array does not throw from the revoked-bit guard", async () => {
    // The revoked-bit guard on `__extern_length` / `__extern_get_idx` must not
    // disturb a live proxy — it has no `return` on that path.
    //
    // The pinned value records a PRE-EXISTING gap measured on `c698c755bb` and
    // unchanged by this slice: neither terminal routes a LIVE proxy into
    // `__proxy_get_dispatch`, so a generic `Array.prototype.*` over a proxy sees
    // length 0 and maps to an empty array. Node answers 3. Closing that needs the
    // array-like terminals to run the `get` trap, which changes what every live
    // proxy answers for `length`/index reads and is deliberately out of scope
    // here. The load-bearing assertion is the absence of `-1`: the guard does not
    // turn a live proxy into a throw.
    expect(
      await runStandalone(`
      const r: any = Proxy.revocable([1, 2, 3], {});
      let n = -1;
      try { n = (Array.prototype.map.call(r.proxy, function (x: any) { return x; }) as any).length; }
      catch (e) { return -1; }
      return n;`),
    ).toBe(0);
  });
});
