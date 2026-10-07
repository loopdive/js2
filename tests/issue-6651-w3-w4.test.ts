// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6651 slices W3 + W4, standalone.
//
// W3 — Annex B sloppy early errors: duplicate plain FunctionDeclarations in a
// switch CaseBlock (§B.3.3.5) and a nested-label FunctionDeclaration at
// statement-list level (`l1: l2: function f(){}`), each with the strict /
// non-plain / iteration-body twins that must STILL be SyntaxErrors.
//
// W4 — a native `$Proxy` binding carries its TARGET's checker type, so the
// typed call lowerings cast it to the target's closure (or native-proto glue)
// shape: `new Proxy(sum.bind(…), {})(2)` dereferenced null and
// `new Proxy(Object.prototype.hasOwnProperty, {}).call(o, "foo")` trapped with
// `illegal cast`. "RED on base" marks a probe that trapped on `origin/main` @
// e24d111705; the expected value is node's.
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

const OPTS = {
  target: "standalone",
  fileName: "p.js",
  allowJs: true,
  skipSemanticDiagnostics: true,
  deferTopLevelInit: true,
} as never;

async function probe(source: string): Promise<number | string> {
  const r = await compile(source, OPTS);
  try {
    const { instance } = await WebAssembly.instantiate(r.binary, (r as { importObject?: object }).importObject ?? {});
    const ex = instance.exports as { __module_init?: () => void; readResult: () => number };
    ex.__module_init?.();
    return ex.readResult();
  } catch (e) {
    return `THROW ${String((e as Error)?.message ?? e)}`;
  }
}

async function earlyErrors(source: string): Promise<string[]> {
  const r = await compile(source, OPTS);
  return ((r as { errors?: { message: string; severity?: string }[] }).errors ?? [])
    .filter((e) => e.severity === undefined || e.severity === "error")
    .map((e) => e.message);
}

const END = `export function readResult() { return __r; }\n`;
const T = 120_000;

describe("#6651 W3 — Annex B sloppy early errors", () => {
  it(
    "duplicate plain function declarations in a sloppy switch are legal; non-plain/strict/lexical twins are not",
    async () => {
      expect(await earlyErrors("let x; switch (x) { case 1: function a() {} case 2: function a() {} }")).toEqual([]);
      for (const bad of [
        '"use strict"; let x; switch (x) { case 1: function a() {} case 2: function a() {} }',
        "let x; switch (x) { case 1: function* a() {} case 2: function a() {} }",
        "let x; switch (x) { case 1: function a() {} case 2: async function a() {} }",
        "let x; switch (x) { case 1: function a() {} case 2: let a; }",
        "let x; switch (x) { case 1: function a() {} case 2: var a; }",
      ]) {
        expect((await earlyErrors(bad)).length, bad).toBeGreaterThan(0);
      }
    },
    T,
  );

  it(
    "a nested-label function declaration is judged at the OUTERMOST label's position",
    async () => {
      expect(await earlyErrors("label1: label2: function f() {}")).toEqual([]);
      for (const bad of [
        "while (false) label1: label2: function f() {}",
        "if (false) label1: label2: function f() {}",
        '"use strict"; label1: label2: function f() {}',
      ]) {
        expect((await earlyErrors(bad)).length, bad).toBeGreaterThan(0);
      }
    },
    T,
  );
});

describe("#6651 W4 — trapless [[Call]] through a proxy binding (standalone)", () => {
  it(
    "a proxy (and proxy-of-proxy) over a bound function forwards call and .call (RED on base)",
    async () => {
      const src = `var __r = 0;
var sum = function (a, b) { return this.foo + a + b; };
var sumBound = sum.bind({ foo: 10 }, 1);
var t = new Proxy(sumBound, {});
var p = new Proxy(t, { apply: null });
if (t(2) === 13) __r |= 1;
if (p(2) === 13) __r |= 2;
if (p.call({ foo: 20 }, 3) === 14) __r |= 4;\n${END}`;
      expect(await probe(src)).toBe(7);
    },
    T,
  );

  it(
    "a proxy (and proxy-of-proxy) over a builtin method forwards .call and Reflect.apply (RED on base)",
    async () => {
      const src = `var __r = 0;
var hasOwn = Object.prototype.hasOwnProperty;
var t = new Proxy(hasOwn, {});
var p = new Proxy(t, {});
var obj = { foo: 1 };
if (p.call(obj, "foo") === true) __r |= 1;
if (Reflect.apply(p, obj, ["bar"]) === false) __r |= 2;
if (t.call(obj, "foo") === true) __r |= 4;\n${END}`;
      expect(await probe(src)).toBe(7);
    },
    T,
  );

  it(
    "an apply trap still runs for direct, .call and .apply invocations; a revoked proxy throws TypeError (RED on base)",
    async () => {
      const src = `var __r = 0;
var f = function (a, b) { return (this && this.k ? this.k : 0) + a + (b || 0); };
var seen = 0;
var p = new Proxy(f, { apply: function (t, thisArg, args) { seen++; return t.apply(thisArg, args) * 2; } });
if (p(1, 2) === 6) __r |= 1;
if (p.call({ k: 10 }, 1, 2) === 26) __r |= 2;
if (p.apply({ k: 1 }, [1, 2]) === 8) __r |= 4;
if (seen === 3) __r |= 8;
var r = Proxy.revocable(f, {});
var rp = r.proxy;
r.revoke();
try { rp(1); } catch (e) { if (e instanceof TypeError) __r |= 16; }
var g = new Proxy(Math.max, {});
if (g(1, 5, 3) === 5) __r |= 32;\n${END}`;
      expect(await probe(src)).toBe(63);
    },
    T,
  );
});
