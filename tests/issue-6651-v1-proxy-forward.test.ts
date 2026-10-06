// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slice V1 — trapless Proxy forwarding over a Proxy / native-carrier
// target, standalone. One `it` per mechanism; each probe answers a NUMBER bit
// mask (a standalone module's string is a WasmGC array the host cannot decode),
// and comparisons go through `sv` so the checker cannot fold them. Eval-free.
//
// "RED on base" marks a probe whose answer differs on `origin/main` @
// d1f1fbdebc (measured by running this file against a base-source tree); the
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

describe("#6651 V1 — trapless Proxy forwarding (standalone)", () => {
  it(
    "HasOwnProperty / propertyIsEnumerable run [[GetOwnProperty]] on a Proxy (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}var target = { attr: 1 };
var p = new Proxy(target, {});
var hop = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
if (sv(Object.prototype.hasOwnProperty.call(p, "attr"), true)) __r |= 1;
if (sv(hop(p, "attr"), true)) __r |= 2;
if (sv(Object.prototype.hasOwnProperty.call(p, "nope"), false)) __r |= 4;
if (sv(Object.prototype.propertyIsEnumerable.call(p, "attr"), true)) __r |= 8;
Object.defineProperty(target, "hidden", { value: 2, enumerable: false, configurable: true });
if (sv(Object.prototype.propertyIsEnumerable.call(p, "hidden"), false)) __r |= 16;
var pp = new Proxy(new Proxy(target, {}), { getOwnPropertyDescriptor: undefined });
if (sv(Object.prototype.hasOwnProperty.call(pp, "attr"), true)) __r |= 32;\n${END}`;
      expect(await probe(src)).toBe(63);
    },
    T,
  );

  it(
    "a trap receives ToPropertyKey(key), and a trapless [[Get]] reaches a String-wrapper target (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}var seen;
var t = new Proxy({}, { get: function (_t, k) { seen = k; return 1; } });
t[10];
if (sv(typeof seen, "string")) __r |= 1;
if (sv(seen, "10")) __r |= 2;
var sp = new Proxy(new Proxy(new String("str"), {}), { get: null });
if (sv(sp.length, 3)) __r |= 4;
if (sv(sp[0], "s")) __r |= 8;
if (sv(sp[4], undefined)) __r |= 16;\n${END}`;
      expect(await probe(src)).toBe(31);
    },
    T,
  );

  it(
    "Object.defineProperty with an accessor literal on a Proxy reaches the target's [[DefineOwnProperty]] (RED on base)",
    async () => {
      const src = `var __r = 0;\n${SV}var array = [];
var p = new Proxy(new Proxy(array, {}), { defineProperty: undefined });
try { Object.defineProperty(p, "length", { get: function () {} }); } catch (e) { if (e instanceof TypeError) __r |= 1; }
var o = {};
var q = new Proxy(o, {});
Object.defineProperty(q, "g", { get: function () { return 7; }, configurable: true });
if (sv(o.g, 7)) __r |= 2;\n${END}`;
      expect(await probe(src)).toBe(3);
    },
    T,
  );

  it(
    "guard: a plain (non-Proxy) hasOwnProperty / defineProperty answer is unchanged",
    async () => {
      const src = `var __r = 0;\n${SV}var o = { a: 1 };
if (sv(Object.prototype.hasOwnProperty.call(o, "a"), true)) __r |= 1;
if (sv(Object.prototype.propertyIsEnumerable.call(o, "a"), true)) __r |= 2;
Object.defineProperty(o, "g", { get: function () { return 5; }, configurable: true });
if (sv(o.g, 5)) __r |= 4;\n${END}`;
      expect(await probe(src)).toBe(7);
    },
    T,
  );
});
