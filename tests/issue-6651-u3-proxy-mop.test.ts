// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice U3 — the Proxy MOP residue of the uncovered ES2015 census (G4),
// standalone. One `it` per mechanism; each probe answers a NUMBER bit mask
// (a standalone module's string is a WasmGC array the host cannot decode), and
// comparisons go through `sv` so the checker cannot fold them. Eval-free.
//
// "RED on base" marks a probe whose answer differs on `origin/main` @
// 4d42eec28e (measured by running this file against a base-source tree); the
// expected value is node's. Guards answer the same on both trees.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function probe(source: string): Promise<number | string> {
  const r = await compile(source, {
    target: "standalone",
    fileName: "p.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  } as never);
  try {
    const { instance } = await WebAssembly.instantiate(r.binary, (r as { importObject?: object }).importObject ?? {});
    const ex = instance.exports as { __module_init?: () => void; readResult: () => number };
    ex.__module_init?.();
    return ex.readResult();
  } catch (e) {
    return `THROW ${String((e as Error)?.message ?? e)}`;
  }
}

const SV = `function sv(a, b) { if (a === b) return a !== 0 || 1 / a === 1 / b; return a !== a && b !== b; }\n`;
const END = `export function readResult() { return __r; }\n`;
const T = 120_000;

describe("#6651 U3 — Proxy MOP residue (standalone)", () => {
  it(
    "trapless [[Delete]] reaches a literal target, and a re-defined non-configurable key refuses (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}var t = { attr: 1, other: 2 };
var p = new Proxy(t, {});
if (sv(delete p.attr, true)) __r |= 1;
if (sv("attr" in t, false)) __r |= 2;
if (sv(Object.getOwnPropertyDescriptor(t, "attr"), undefined)) __r |= 4;
Object.defineProperty(t, "attr", { configurable: false, enumerable: true, value: 1 });
if (sv(Reflect.deleteProperty(p, "attr"), false)) __r |= 8;
if (sv(t.attr, 1)) __r |= 16;
if (sv(delete p.notThere, true)) __r |= 32;\n${END}`;
      expect(await probe(src)).toBe(63);
    },
    T,
  );

  it(
    "Object.keys on an auto-typed binding assigned inside a closure reads the live value (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}var d, e;
function f(x) { d = x; }
f({ a: 1, b: 2 });
if (sv(Object.keys(d).length, 2)) __r |= 1;
if (sv(Object.values(d)[1], 2)) __r |= 2;
try { Object.keys(e); } catch (err) { if (err instanceof TypeError) __r |= 4; }
var _desc;
var p = new Proxy({}, { defineProperty: function (t, k, desc) { _desc = desc; return true; } });
Object.defineProperty(p, "attr", { configurable: true, enumerable: true, writable: true, value: 1 });
if (sv(Object.keys(_desc).length, 4)) __r |= 8;
if (sv(_desc.value, 1)) __r |= 16;\n${END}`;
      expect(await probe(src)).toBe(31);
    },
    T,
  );

  it(
    "%Array.prototype% owns length 0 {w:T,e:F,c:F}, visible through Object.create (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}var t = Object.create(Array.prototype);
if ("length" in t) __r |= 1;
if (sv(Reflect.has(t, "length"), true)) __r |= 2;
var k = "length";
if (sv(t[k], 0)) __r |= 4;
var d = Object.getOwnPropertyDescriptor(Array.prototype, "length");
if (sv(d.value, 0) && d.writable === true && d.enumerable === false && d.configurable === false) __r |= 8;
var names = Object.getOwnPropertyNames(Array.prototype), c = 0;
for (var i = 0; i < names.length; i++) if (names[i] === "length") c++;
if (sv(c, 1)) __r |= 16;
var keys = 0;
for (var key in t) keys++;
if (sv(keys, 0)) __r |= 32;
if (sv([1, 2].length, 2)) __r |= 64;\n${END}`;
      expect(await probe(src)).toBe(127);
    },
    T,
  );

  it(
    "for-in, for-of and @@iterator over a trapless-get Proxy of an array (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}var x;
var p = new Proxy([1, 2, 3], { enumerate: function () { __r |= 1024; } });
var ks = "";
for (x in p) ks += x;
if (sv(ks, "012")) __r |= 1;
var s = 0;
for (x of p) s = s * 10 + x;
if (sv(s, 123)) __r |= 2;
var it = p[Symbol.iterator]();
var n = it.next();
if (sv(n.value, 1) && sv(n.done, false)) __r |= 4;
var po = new Proxy({ a: 1, b: 2 }, {});
var ko = "";
for (var k in po) ko += k;
if (sv(ko, "ab")) __r |= 8;\n${END}`;
      expect(await probe(src)).toBe(15);
    },
    T,
  );

  it(
    "a get trap still owns @@iterator (guard: same on base)",
    async () => {
      const src = `var __r = 0;\n${SV}var seen = 0;
var p = new Proxy([1, 2], { get: function (t, k, r) { seen++; return t[k]; } });
try { for (var v of p) {} } catch (e) { __r |= 1; }
if (seen > 0) __r |= 2;\n${END}`;
      const got = await probe(src);
      expect(typeof got === "number" && (got & 2) === 2).toBe(true);
    },
    T,
  );

  it(
    "Object.getPrototypeOf(target) after an in-trap setPrototypeOf on the Proxy target (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}var proto = {};
var outro = {};
var proxy = new Proxy(outro, {
  setPrototypeOf: function (t, v) { Object.setPrototypeOf(t, v); Object.preventExtensions(t); return true; }
});
if (sv(Reflect.setPrototypeOf(proxy, proto), true)) __r |= 1;
if (sv(Object.getPrototypeOf(outro), proto)) __r |= 2;
var plain = {};
if (sv(Object.getPrototypeOf(plain), Object.prototype)) __r |= 4;\n${END}`;
      expect(await probe(src)).toBe(7);
    },
    T,
  );

  it(
    "new <realm global>.Proxy(…) reaches the native Proxy: ownKeys list validation and a get trap (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}var other = globalThis;
var p = new other.Proxy({}, { ownKeys: function () { return undefined; } });
try { Object.keys(p); } catch (e) { if (e instanceof TypeError) __r |= 1; }
var q = new other.Proxy({}, { get: function () { return 7; } });
if (sv(q.anything, 7)) __r |= 2;\n${END}`;
      expect(await probe(src)).toBe(3);
    },
    T,
  );
});
