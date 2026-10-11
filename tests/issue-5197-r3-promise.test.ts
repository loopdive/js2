// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #5197 r3 — ES2015 standalone `built-ins/Promise/**` residue: SpeciesConstructor +
// NewPromiseCapability in `then`, the PromiseResolve constructor check, FIFO
// reactions, `Get(array, "then")` on a resolved aggregate, [[AlreadyResolved]]
// after `resolve(thenable)`, and a function `C` in `Promise.<m>.call(C, …)`.
//
// Each probe is a plain JS module compiled `--target standalone` (host-free —
// the module must import nothing) whose `readResult()` encodes one bit per
// sub-assertion; node is the oracle for every expected value. The "pin" rows
// were measured RED on `origin/main` @ a2546f6fc5 (see the r3 implementation
// record in plan/issues/5197-es2015-standalone-promise-r2.md); the "guard" rows
// answer the node value on both trees and must keep doing so.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function run(name: string, source: string): Promise<string> {
  const r = await compile(source, {
    target: "standalone",
    fileName: `${name}.js`,
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(r.success, r.success ? "" : `compile error: ${r.errors?.[0]?.message}`).toBe(true);
  const mod = await WebAssembly.compile(r.binary);
  const imports = WebAssembly.Module.imports(mod).map((i) => `${i.module}::${i.name}`);
  expect(imports, "standalone module must have zero host imports").toEqual([]);
  const { instance } = await WebAssembly.instantiate(r.binary, r.importObject);
  const ex = instance.exports as { __module_init?: () => void; __drain_microtasks?: () => void; readResult(): unknown };
  ex.__module_init?.();
  ex.__drain_microtasks?.();
  return String(ex.readResult());
}

const PROBES: ReadonlyArray<
  readonly [name: string, kind: "pin" | "guard", expected: string, what: string, source: string]
> = [
  [
    "p1",
    "pin",
    "111",
    "then reads constructor once (1); constructor=null -> TypeError (10); a throwing constructor getter propagates (100)",
    `var __r = 0;
var p = Promise.resolve(1);
var n = 0;
Object.defineProperty(p, "constructor", { get: function () { n++; return Promise; } });
p.then();
__r += n;
var q = new Promise(function () {});
q.constructor = null;
try { q.then(); __r += 20; } catch (e) { if (e instanceof TypeError) __r += 10; else __r += 30; }
var r = Promise.resolve(2);
Object.defineProperty(r, "constructor", { get: function () { throw 7; } });
try { r.then(); __r += 200; } catch (e) { if (e === 7) __r += 100; else __r += 300; }
export function readResult() { return __r; }
`,
  ],
  [
    "p2",
    "pin",
    "110",
    "Promise[@@species] = throwing ctor makes then throw (10); restored species returns (100)",
    `var __r = 0;
var Bad = function () { throw 5; };
var orig = Object.getOwnPropertyDescriptor(Promise, Symbol.species);
Object.defineProperty(Promise, Symbol.species, { value: Bad });
var p = Promise.resolve(1);
try { p.then(); __r += 1; } catch (e) { if (e === 5) __r += 10; else __r += 20; }
Object.defineProperty(Promise, Symbol.species, orig);
try { p.then(); __r += 100; } catch (e) { __r += 1000; }
export function readResult() { return __r; }
`,
  ],
  [
    "p3",
    "pin",
    "12",
    "Promise.resolve(p) with p.constructor = null answers a NEW promise (2); a plain promise passes through (10)",
    `var __r = 0;
var p1 = new Promise(function () {});
p1.constructor = null;
var p2 = Promise.resolve(p1);
__r += (p1 === p2) ? 1 : 2;
var p3 = new Promise(function () {});
var p4 = Promise.resolve(p3);
__r += (p3 === p4) ? 10 : 20;
export function readResult() { return __r; }
`,
  ],
  [
    "p4",
    "pin",
    "123",
    "three reactions on one pending promise run in attach order",
    `var seq = "";
var res; var p = new Promise(function (r) { res = r; });
p.then(function () { seq += "1"; });
p.then(function () { seq += "2"; });
p.then(function () { seq += "3"; });
res();
__drain_microtasks();
export function readResult() { return parseInt(seq, 10); }
`,
  ],
  [
    "p5",
    "pin",
    "1",
    "Promise.all([]) resolves its aggregate through Resolve: an installed Array.prototype.then is called",
    `var __r = 0; var value = {};
Array.prototype.then = function (resolve) { resolve(value); };
var promise = Promise.all([]);
delete Array.prototype.then;
promise.then(function (v) { __r += (v === value) ? 1 : 2; }, function () { __r += 4; });
__drain_microtasks();
export function readResult() { return __r; }
`,
  ],
  [
    "p6",
    "pin",
    "1",
    "executor: resolve(thenable); throw -> the throw is ignored, fulfilled via the thenable",
    `var __r = 0;
var thenable = { then: function (resolve) { resolve(42); } };
new Promise(function (resolve, reject) { resolve(thenable); throw new Error("x"); })
  .then(function (v) { __r += v === 42 ? 1 : 2; }, function () { __r += 4; });
__drain_microtasks();
export function readResult() { return __r; }
`,
  ],
  [
    "p9",
    "pin",
    "1001",
    "Promise.all.call(P, iter) with a function P steps the iterator once, no close, rejects with the resolve throw",
    `var nextCount = 0, returnCount = 0, threw = 0, rej = 0;
var iter = {};
iter[Symbol.iterator] = function () { return { next: function () { nextCount++; return { done: true }; }, return: function () { returnCount++; return {}; } }; };
var P = function (executor) { return new Promise(function (_, reject) { executor(function () { throw 9; }, reject); }); };
P.resolve = Promise.resolve;
try { var r = Promise.all.call(P, iter); r.then(function () { rej = 5; }, function (e) { rej = e === 9 ? 1 : 2; }); } catch (e) { threw = 1; }
__drain_microtasks();
export function readResult() { return nextCount + returnCount * 10 + threw * 100 + rej * 1000; }
`,
  ],
  [
    "p11",
    "pin",
    "11111",
    "a closure constructor's @@species class is constructed once with one executor argument; then answers its instance",
    `var __r = 0; var callCount = 0; var argLength = -1; var gce; var thisValue;
var p1 = new Promise(function () {});
var SC = class extends Promise { constructor(a) { super(a); callCount += 1; thisValue = this; gce = a; argLength = arguments.length; } };
p1.constructor = function () {};
p1.constructor[Symbol.species] = SC;
var p2 = p1.then();
__r += callCount;
__r += (thisValue instanceof SC) ? 10 : 0;
__r += argLength === 1 ? 100 : 0;
__r += (typeof gce === "function" && gce.length === 2) ? 1000 : 0;
__r += (p2 instanceof SC) ? 10000 : 0;
export function readResult() { return __r; }
`,
  ],
  [
    "p12",
    "pin",
    "11",
    "P.resolve(o) on a subclass constructs P; P's return override is then's result and receives the resolved value",
    `var __r = 0; var createBad = false; var object = {};
class P extends Promise {
  constructor(executor) {
    if (createBad) { executor(function (v) { __r += v === object ? 1 : 2; }, function (e) { __r += 4; }); return object; }
    return super(executor);
  }
}
var p = P.resolve(object);
createBad = true; var q = p.then(); createBad = false;
__r += q === object ? 10 : 20;
__drain_microtasks();
export function readResult() { return __r; }
`,
  ],
  [
    "p13",
    "pin",
    "111",
    "new (class extends Promise {...})(fn) compiles; then drives the capability-executor protocol",
    `var __r = 0; var cf;
var promise = new class extends Promise { constructor(executor) { if (cf) { cf(executor); return {}; } return super(executor); } }(function () {});
__r += (promise instanceof Promise) ? 1 : 2;
var cp = "";
cf = function (executor) { cp += "a"; executor(); cp += "b"; executor(function () {}, function () {}); cp += "c"; };
var r = promise.then();
__r += cp === "abc" ? 10 : 20;
cp = "";
try { cf = function (executor) { cp += "a"; executor(undefined, function () {}); cp += "b"; }; promise.then(); __r += 200; } catch (e) { __r += (e instanceof TypeError && cp === "ab") ? 100 : 400; }
export function readResult() { return __r; }
`,
  ],
  [
    "p14",
    "pin",
    "1",
    "thenable job: resolve(thenable); throw -> the throw is ignored",
    `var __r = 0;
var thenable = { then: function (resolve) { resolve(3); } };
var twe = { then: function (resolve) { resolve(thenable); throw new Error("ignored"); } };
new Promise(function (resolve) { resolve(twe); }).then(function (v) { __r += v === 3 ? 1 : 2; }, function () { __r += 4; });
__drain_microtasks();
export function readResult() { return __r; }
`,
  ],
  [
    "p15",
    "pin",
    "1234",
    "S25.4.5.3_A5.1_T1 shape: reaction order is FIFO",
    `var seq = "";
var pResolve; var p = new Promise(function (resolve) { pResolve = resolve; });
seq += "1";
p.then(function () { seq += "3"; });
Promise.resolve().then(function () { p.then(function () { seq += "4"; }); seq += "2"; pResolve(); });
__drain_microtasks();
export function readResult() { return parseInt(seq, 10); }
`,
  ],
  [
    "p17",
    "pin",
    "1",
    "a poisoned Array.prototype.then getter rejects the Promise.all([]) aggregate",
    `var __r = 0;
var value = {};
Object.defineProperty(Array.prototype, 'then', { get: function () { throw value; }, configurable: true });
var promise = Promise.all([]);
delete Array.prototype.then;
promise.then(function () { __r += 2; }, function (v) { __r += (v === value) ? 1 : 4; });
__drain_microtasks();
export function readResult() { return __r; }
`,
  ],
  [
    "p18",
    "pin",
    "11",
    "a @@species getter runs once (1); a non-constructor @@species is a TypeError (10)",
    `var __r = 0; var n = 0;
var p = Promise.resolve(1);
var f = function () {};
p.constructor = f;
Object.defineProperty(f, Symbol.species, { get: function () { n++; return undefined; } });
p.then();
__r += n;
var g = function () {};
var q = Promise.resolve(2);
q.constructor = g;
g[Symbol.species] = 5;
try { q.then(); __r += 100; } catch (e) { __r += (e instanceof TypeError) ? 10 : 20; }
export function readResult() { return __r; }
`,
  ],
  [
    "p22b",
    "pin",
    "10111",
    "class X extends Promise: X.resolve(1).then() instanceof X and Promise, x.constructor === X",
    `var __r = 0;
class X extends Promise {}
var x = X.resolve(1);
var y = x.then();
__r += (y instanceof X) ? 1 : 0;
__r += (y instanceof Promise) ? 10 : 0;
__r += (x.constructor === X) ? 100 : 0;
__r += (Promise[Symbol.species] === Promise) ? 10000 : 0;
export function readResult() { return __r; }
`,
  ],
  [
    "p23",
    "pin",
    "1111",
    "P.resolve(1) and Promise.resolve.call(P, 2) both construct the subclass P",
    `var __r = 0;
class P extends Promise {}
var p = P.resolve(1);
__r += (p instanceof P) ? 1 : 0;
__r += (p.constructor === P) ? 10 : 0;
var q = Promise.resolve.call(P, 2);
__r += (q instanceof P) ? 100 : 0;
__r += (q.constructor === P) ? 1000 : 0;
export function readResult() { return __r; }
`,
  ],
  [
    "p10",
    "pin",
    "1",
    "Promise.all('') fulfils with an empty array read by the handler",
    `var __r = 0;
try {
  Promise.all("").then(function (v) { __r += v.length === 0 ? 1 : 2; }, function () { __r += 4; });
} catch (e) { __r += 8; }
__drain_microtasks();
export function readResult() { return __r; }
`,
  ],
  [
    "p21",
    "pin",
    "1",
    "Promise.all('ab') fulfils with a 2-element array read by the handler",
    `var __r = 0;
Promise.all("ab").then(function (v) { __r += v.length === 2 ? 1 : 2; }, function () { __r += 4; });
__drain_microtasks();
export function readResult() { return __r; }
`,
  ],
  [
    "p7",
    "guard",
    "111",
    "GetCapabilitiesExecutor and a plain function inherit Function.prototype",
    `var __r = 0; var ex;
function NotPromise(executor) { ex = executor; executor(function () {}, function () {}); }
Promise.resolve.call(NotPromise);
__r += Object.getPrototypeOf(ex) === Function.prototype ? 1 : 2;
__r += typeof ex === "function" ? 10 : 20;
__r += Object.getPrototypeOf(function () {}) === Function.prototype ? 100 : 200;
__r += Object.getPrototypeOf(ex) === null ? 1000 : 0;
export function readResult() { return __r; }
`,
  ],
  [
    "p16",
    "guard",
    "11",
    "a Promise.all resolve-element function inherits Function.prototype",
    `var __r = 0; var ref;
var thenable = { then: function (fulfill) { ref = fulfill; } };
function NotPromise(executor) { executor(function () {}, function () {}); }
NotPromise.resolve = function (v) { return v; };
Promise.all.call(NotPromise, [thenable]);
__r += Object.getPrototypeOf(ref) === Function.prototype ? 1 : 2;
__r += typeof ref === "function" ? 10 : 20;
__r += Object.getPrototypeOf(ref) === null ? 100 : 0;
export function readResult() { return __r; }
`,
  ],
  [
    "p20",
    "guard",
    "1",
    "Promise.all over an array literal of strings answers a 2-element array",
    `var __r = 0;
Promise.all(["a", "b"]).then(function (v) { __r += v.length === 2 ? 1 : 2; }, function () { __r += 4; });
__drain_microtasks();
export function readResult() { return __r; }
`,
  ],
];

describe("#5197 r3 — standalone Promise residue (node is the oracle)", () => {
  for (const [name, kind, expected, what, source] of PROBES) {
    it(`${name} (${kind}): ${what}`, async () => {
      expect(await run(name, source)).toBe(expected);
    }, 120_000);
  }
});
