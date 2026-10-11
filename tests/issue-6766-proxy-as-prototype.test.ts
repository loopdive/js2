// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#6766) A Proxy as `[[Prototype]]` under `--target standalone`.
 *
 * `$Object.$proto` cannot hold a `$Proxy` (a sibling struct, not a subtype), so
 * the prototype writers unwrapped it or stored null: no trap fired on an
 * inherited read/write/`in`, and `Object.getPrototypeOf(heir)` was not the
 * proxy. The fix stores a LINK `$Object` carrying the proxy and gives every
 * prototype walker a per-hop arm (object-runtime-proxy-chain.ts).
 *
 * "RED on base" pins assert node's answer and fail on the base sources; the
 * guards answer the same on both trees. Measured 2026-09-30 against
 * `origin/main` @ `eb57f327` (see the issue file's record for the base values).
 */
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

/** Compile `body` as module-scope JavaScript; return the `__r` value. */
async function run(body: string): Promise<unknown> {
  const source = `var __r = 0;\n${body}\nexport function readResult() { return __r; }\n`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-6766.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => error.message).join("\n")).toBe(true);
  expect(WebAssembly.validate(result.binary), "module failed WebAssembly.validate").toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject);
  const exports = instance.exports as { __module_init?: () => void; readResult: () => unknown };
  exports.__module_init?.();
  return exports.readResult();
}

describe("#6766 — a Proxy in the prototype chain", () => {
  it("RED on base (0): an inherited write reaches the set trap with the handler as `this`", async () => {
    expect(
      await run(`
      var log = 0, ctx = 0;
      var target = {};
      var handler = { set: function (t, k, v, r) { log += 1; ctx = (this === handler) ? 1 : 2; return true; } };
      var proxy = new Proxy(target, handler);
      var receiver = Object.create(proxy);
      receiver.prop = 'value';
      __r = log * 10 + ctx;`),
    ).toBe(11);
  });

  it("RED on base (NaN): an inherited read reaches the get trap with the HEIR as receiver", async () => {
    expect(
      await run(`
      var handler = { get: function (t, k, r) { return r === proxy ? 1 : 2; } };
      var proxy = new Proxy({}, handler);
      var child = Object.create(proxy);
      __r = child.attr * 10 + proxy.attr;`),
    ).toBe(21);
  });

  it("RED on base (6): getPrototypeOf answers the proxy; isPrototypeOf and setPrototypeOf agree", async () => {
    expect(
      await run(`
      var proxy = new Proxy({}, {});
      var child = Object.create(proxy);
      var a = (Object.getPrototypeOf(child) === proxy) ? 1 : 0;
      var b = (proxy.isPrototypeOf(child)) ? 2 : 0;
      var pp = {}; var c2 = Object.create(pp);
      var c = (Object.getPrototypeOf(c2) === pp) ? 4 : 0;
      var s = {}; Object.setPrototypeOf(s, proxy);
      var d = (Object.getPrototypeOf(s) === proxy) ? 8 : 0;
      __r = a + b + c + d;`),
    ).toBe(15);
  });

  it("RED on base (1): the chain is not cut — trap-absent reads forward to the target", async () => {
    expect(
      await run(`
      var target = { attr: 5 };
      var proxy = new Proxy(target, {});
      var child = Object.create(proxy);
      var g = Object.getPrototypeOf(child);
      var a = (g === null) ? 1 : 0;
      var b = (g === undefined) ? 2 : 0;
      var c = (g === target) ? 4 : 0;
      var d = (g === proxy) ? 8 : 0;
      var e = (child.attr === 5) ? 16 : 0;
      __r = a + b + c + d + e;`),
    ).toBe(24);
  });

  it("RED on base (14): `in` over an heir reaches the has trap; a trap-absent write lands on the HEIR", async () => {
    expect(
      await run(`
      var seen = 0;
      var target = { t: 1 };
      var p = new Proxy(target, { has: function (t, k) { seen += 1; return k === "virtual"; } });
      var heir = Object.create(p);
      var a = ("virtual" in heir) ? 1 : 0;
      var b = ("t" in heir) ? 0 : 2;
      var q = Object.create(new Proxy(target, {}));
      q.z = 3;
      var c = (Object.prototype.hasOwnProperty.call(q, "z") ? 4 : 0) + (Object.prototype.hasOwnProperty.call(target, "z") ? 0 : 8);
      __r = a + b + c + seen * 100;`),
    ).toBe(215);
  });
});

describe("#6766 — keys, revocation, refusal", () => {
  it("RED on base (26): traps see ToPropertyKey keys; a revoked proxy in the chain throws on the hop", async () => {
    expect(
      await run(`
      var h = Object.create(new Proxy({}, { get: function (t, k, r) { return k; }, has: function (t, k) { return k === "0"; } }));
      var a = (h[0] === "0") ? 1 : 0;
      var h2 = Object.create(new Proxy({ x: 6 }, {}));
      var b = (h2["x"] === 6) ? 2 : 0;
      var c = (0 in h) ? 4 : 0;
      var d = ("zz" in h) ? 0 : 8;
      var k = "x";
      var e = (h2[k] === 6) ? 16 : 0;
      var revoked = Proxy.revocable({}, {});
      var h3 = Object.create(revoked.proxy);
      revoked.revoke();
      var f = 0;
      try { h3.foo; } catch (err) { f = (err instanceof TypeError) ? 32 : 64; }
      __r = a + b + c + d + e + f;`),
    ).toBe(63);
  });

  it("RED on base (1111): a refusing set trap throws in strict code and answers false to Reflect.set", async () => {
    expect(
      await run(`
      var h = Object.create(new Proxy({}, { set: function () { return false; } }));
      var r = 0;
      try { h.x = 1; r = 1; } catch (e) { r = (e instanceof TypeError) ? 2 : 3; }
      var ok = Reflect.set(h, "y", 1) ? 10 : 20;
      var t = {};
      var h2 = Object.create(new Proxy(t, {}));
      var ok2 = Reflect.set(h2, "z", 5) ? 100 : 200;
      var own = Object.prototype.hasOwnProperty.call(h2, "z") && !Object.prototype.hasOwnProperty.call(t, "z") ? 1000 : 2000;
      __r = r + ok + ok2 + own;`),
    ).toBe(1122);
  });
});

describe("#6766 — guards: ordinary chains answer the same on both trees", () => {
  it("guard: a plain Object.create chain read", async () => {
    expect(await run(`var pp = { a: 7 }; var c = Object.create(pp); __r = c.a;`)).toBe(7);
  });

  it("guard: an Object.create(null) write", async () => {
    expect(
      await run(`var n = Object.create(null); n.x = 3; __r = n.x + (Object.getPrototypeOf(n) === null ? 10 : 0);`),
    ).toBe(13);
  });

  it("guard: Object.setPrototypeOf(o, {}) identity and inherited read", async () => {
    expect(
      await run(
        `var o = {}; var q = { b: 2 }; Object.setPrototypeOf(o, q); __r = (Object.getPrototypeOf(o) === q ? 1 : 0) + o.b * 10;`,
      ),
    ).toBe(21);
  });
});
