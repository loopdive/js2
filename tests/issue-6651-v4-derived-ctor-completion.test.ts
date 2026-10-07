/**
 * #6651 slice V4 — derived-constructor completion and revoked-proxy construct
 * (H4). Every case runs `--target standalone` and asserts the binary imports
 * NOTHING.
 *
 * 1. §10.2.1.3 [[Construct]] steps 10–13 for a derived constructor that never
 *    calls `super()`: a returned non-undefined, non-Object value (`null`
 *    included — its typeof is "object" but it is not an Object) is a TypeError;
 *    only an `undefined` completion reaches the uninitialised-`this`
 *    ReferenceError (`Function/internals/Construct/derived-return-val.js`).
 *
 * 2. §10.5.13 step 6.b forwards `new proxy()` to the target with the PROXY as
 *    newTarget, so OrdinaryCreateFromConstructor runs `Get(proxy,
 *    "prototype")` through the `get` trap. When that trap revokes the proxy and
 *    answers a non-Object, GetFunctionRealm(proxy) throws TypeError (§7.3.22
 *    step 4.a — `Construct/base-ctor-revoked-proxy{,-realm}.js`).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.ts";

type Compiled = { success: boolean; binary: Uint8Array; errors?: unknown; imports?: unknown[] };

async function run(src: string): Promise<unknown> {
  const r = (await compile(src, {
    fileName: "t.js",
    allowJs: true,
    target: "standalone",
    skipSemanticDiagnostics: true,
    inferModuleStrictArguments: false,
  })) as unknown as Compiled;
  expect(r.success, `compile failed: ${JSON.stringify(r.errors).slice(0, 300)}`).toBe(true);
  expect(r.imports ?? []).toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, {});
  return (instance.exports as { test: () => unknown }).test();
}

const CODE = `function code(f) {
  try { f(); return 0; } catch (e) { return e instanceof TypeError ? 1 : e instanceof ReferenceError ? 2 : 3; }
}`;

describe("#6651 V4 · 1 · derived constructor completion without super()", () => {
  it("`return null` is a TypeError, not the uninitialised-this ReferenceError", async () => {
    const src = `class C extends Object { constructor() { return null; } }
${CODE}
export function test() { return code(() => new C()); }`;
    expect(await run(src)).toBe(1);
  });

  it("GUARD: primitive return TypeError, undefined/fallthrough ReferenceError, super()+null TypeError", async () => {
    const src = `class D extends Object { constructor() { return 1; } }
class E extends Object { constructor() { return undefined; } }
class F extends Object { constructor() { super(); return null; } }
class G extends Object { constructor() { } }
${CODE}
export function test() {
  return code(() => new D()) * 1000 + code(() => new E()) * 100 + code(() => new F()) * 10 + code(() => new G());
}`;
    expect(await run(src)).toBe(1212);
  });
});

describe("#6651 V4 · 2 · construct through a proxy revoked by its own prototype read", () => {
  it("the `get` trap revoking during GetPrototypeFromConstructor throws TypeError", async () => {
    const src = `var handlers = { get: function() { handle.revoke(); } };
var handle = Proxy.revocable(function() {}, handlers);
var f = handle.proxy;
${CODE}
export function test() { return code(() => new f()); }`;
    expect(await run(src)).toBe(1);
  });

  it("GUARD: an already-revoked proxy still throws TypeError", async () => {
    const src = `var r = Proxy.revocable(function() {}, {});
r.revoke();
var g = r.proxy;
${CODE}
export function test() { return code(() => new g()); }`;
    expect(await run(src)).toBe(1);
  });

  it("the proxy's get trap is consulted once for the prototype; a trap-free proxy keeps target.prototype", async () => {
    const src = `function T() { this.x = 7; }
T.prototype.m = function () { return 5; };
var P1 = new Proxy(T, {});
var custom = { m: function () { return 9; } };
var gets = 0;
var P2 = new Proxy(T, { get: function (t, k) { gets++; return k === "prototype" ? custom : t[k]; } });
var P3 = new Proxy(T, { get: function (t, k) { return k === "prototype" ? 1 : t[k]; } });
function val(fn) {
  try { return fn(); } catch (e) { return e instanceof TypeError ? -1 : e instanceof ReferenceError ? -2 : -3; }
}
export function test() {
  var a, b, c;
  var r1 = val(() => { a = new P1(); return 1; });
  var r2 = val(() => { b = new P2(); return 1; });
  var r3 = val(() => { c = new P3(); return 1; });
  var r4 = val(() => a.m());
  var r5 = val(() => b.x + c.x);
  return gets * 1000000 + r1 * 100000 + r2 * 10000 + r3 * 1000 + r4 * 100 + r5;
}`;
    // gets=1: P2's trap ran once, for "prototype"; every construct completed
    // (r1..r3 = 1); r4 = 5 (target.prototype); r5 = 14 (the target body ran for
    // both trapped proxies, including P3 whose trap answers a non-Object).
    // Residual: an instance created from a CLOSED-struct prototype the trap
    // returned does not see that prototype's methods (`b.m()` — node 9).
    expect(await run(src)).toBe(1111514);
  });
});
