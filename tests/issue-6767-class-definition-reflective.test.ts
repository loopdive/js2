// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6767 — the reflective residue of class definitions on standalone
// (`language/statements/class/definition/**`).
//
// Every "RED on base" case was measured failing against a `git archive
// origin/main` tree (eb57f327) and passing on the branch; the two guards answer
// the same on both trees. `node` is the oracle for every expected value (the
// host-lane checks run the same source through `new Function`).
//
//   Step 1 — a class OBJECT answers reflection for its declared statics
//            (`class-static-descriptor.ts`), a helper parameter fed
//            `C.prototype` is not narrowed to `$C`, and `C[4]()` as a call
//            argument no longer leaves a stray receiver on the stack.
//   Step 2 — a base class and its prototype report their real [[Prototype]].
//   Step 3 — heritage proofs: a prototype-less bound function and `Math.*`.
//
// RESIDUAL pins record what this issue measured and deliberately left, so a
// later fix shows up as a failing pin instead of going unnoticed.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";

async function runStandalone(body: string): Promise<unknown> {
  const source = `var __r = 0;\n${body}\nexport function readResult() { return __r; }\n`;
  const result = await compile(source, {
    target: "standalone",
    fileName: "issue-6767.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    deferTopLevelInit: true,
  });
  expect(result.success, result.errors.map((error) => `L${error.line}: ${error.message}`).join("\n")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary, result.importObject ?? {});
  const exports = instance.exports as { __module_init?: () => void; readResult: () => unknown };
  exports.__module_init?.();
  return exports.readResult();
}

function runHost(body: string): unknown {
  return new Function(`var __r = 0;\n${body}\nreturn __r;`)();
}

/** The issue's p11 probe: static-member descriptors and the base-class prototype links. */
const P11 = `
class C { method() { return 1; } static staticMethod() { return 2; } get x() { return 1; } static get sx() { return 1; } }
var d = Object.getOwnPropertyDescriptor(C, 'staticMethod');
var r1 = (d === undefined) ? 1 : 0;
var r2 = (typeof d === 'object' && d !== null && typeof d.value === 'function') ? 2 : 0;
var d2 = Object.getOwnPropertyDescriptor(C, 'sx');
var r3 = (d2 === undefined) ? 4 : 0;
var r4 = (Object.getPrototypeOf(C.prototype) === Object.prototype) ? 8 : 0;
var r5 = (Object.getPrototypeOf(C) === Function.prototype) ? 16 : 0;
var names = Object.getOwnPropertyNames(C);
var r6 = (names.indexOf('staticMethod') >= 0) ? 32 : 0;
var r7 = (names.indexOf('prototype') >= 0) ? 64 : 0;
var r8 = (C.hasOwnProperty('staticMethod')) ? 128 : 0;
__r = r1 + r2 + r3 + r4 + r5 + r6 + r7 + r8;
`;

/** The issue's p12 probe. Bit 16 (`Class.eval === 3`) is the recorded collision residual. */
const P12 = `
class Class { method() {} get accessor() { return 1; } set accessor(x) {} 1() { return 7; } get eval() { return 1; } static get eval() { return 3; } }
var instance = new Class;
var r1 = (instance.method.hasOwnProperty('caller') === false && instance.method.hasOwnProperty('arguments') === false) ? 1 : 0;
var acc = Object.getOwnPropertyDescriptor(Class.prototype, 'accessor');
var r2 = (acc && acc.get && acc.get.name === 'get accessor') ? 2 : 0;
var r3 = (acc && acc.set && acc.set.name === 'set accessor') ? 4 : 0;
var d1 = Object.getOwnPropertyDescriptor(Class.prototype, '1');
var r4 = (d1 && typeof d1.value === 'function' && d1.value() === 7) ? 8 : 0;
var r5 = (Class.eval === 3) ? 16 : 0;
var r6 = (new Class().eval === 1) ? 32 : 0;
var r7 = (Object.getOwnPropertyDescriptor(Class, 'eval') !== undefined) ? 64 : 0;
var thrown = 0;
try { class D extends (function(){}).bind() {} } catch (e) { thrown = e instanceof TypeError ? 1 : 2; }
var r8 = thrown === 1 ? 128 : 0;
var thrown2 = 0;
try { class E extends 7 {} } catch (e) { thrown2 = e instanceof TypeError ? 1 : 2; }
var r9 = thrown2 === 1 ? 256 : 0;
__r = r1 + r2 + r3 + r4 + r5 + r6 + r7 + r8 + r9;
`;

/** `assertMethodDescriptor(object, name)` from definition/methods.js — runtime receiver AND key. */
const HELPER_DESCRIPTORS = `
function md(object, name) {
  var desc = Object.getOwnPropertyDescriptor(object, name);
  if (desc === undefined) return 1;
  if (desc.configurable !== true || desc.enumerable !== false) return 2;
  if ('value' in desc ? desc.writable !== true || typeof desc.value !== 'function' : typeof desc.get !== 'function') return 3;
  if ('prototype' in (desc.value || desc.get)) return 4;
  return 0;
}
class C {
  constructor(x) { this._x = x; }
  method() { return 1; }
  static staticMethod() { return 2; }
  static get staticX() { return this._x; }
  static set staticX(v) { this._x = v; }
}
var a = 9, b = 9, c = 9;
try { a = md(C.prototype, 'method'); } catch (e) { a = 8; }
try { b = md(C, 'staticMethod'); } catch (e) { b = 8; }
try { c = md(C, 'staticX'); } catch (e) { c = 8; }
__r = a * 100 + b * 10 + c;
`;

/** `verifyProperty`'s own-property and configurability probes, through bound natives. */
const BOUND_HASOWN_AND_DELETE = `
class C { static sm() { return 2; } static get sx() { return 1; } }
var hop = Function.prototype.call.bind(Object.prototype.hasOwnProperty);
function del(o, k) { delete o[k]; }
var r = 0;
r += hop(C, 'sm') ? 1 : 0;
r += hop(C, 'sx') ? 2 : 0;
r += hop(C, 'nope') ? 0 : 4;
del(C, 'sx');
r += hop(C, 'sx') ? 0 : 8;
r += Object.getOwnPropertyDescriptor(C, 'sx') === undefined ? 16 : 0;
__r = r;
`;

/** The class object's own statics through the rest of the dynamic MOP. */
const DYNAMIC_MOP = `
var last = 0;
class Z { static get g() { return this === Z ? 5 : 6; } static set s(v) { last = v; } static m() { return 3; } }
function rd(o, k) { return o[k]; }
function wr(o, k, v) { o[k] = v; }
function has(k, o) { return k in o; }
var r = 0;
try { r += rd(Z, 'g') === 5 ? 1 : 0; } catch (e) {}
try { r += typeof rd(Z, 'm') === 'function' && rd(Z, 'm')() === 3 ? 2 : 0; } catch (e) {}
try { wr(Z, 's', 42); r += last === 42 ? 4 : 0; } catch (e) {}
try { r += has('m', Z) && has('g', Z) && !has('zz', Z) ? 8 : 0; } catch (e) {}
__r = r;
`;

/** \`C[4]()\` as an argument of a dynamic method call (definition/numeric-property-names.js). */
const STATIC_ELEMENT_CALL_ARGUMENT = `
var o = {};
o.f = function (a) { return a; };
class B { static 4() { return 4; } }
class C extends B { static 4() { return super[4](); } static m() { return 8; } }
var r = 0;
try { r += o.f(C[4]()) === 4 ? 1 : 0; } catch (e) {}
try { r += o.f(C["m"]()) === 8 ? 2 : 0; } catch (e) {}
__r = r;
`;

/** Step 2 on the \`var C = class C {}\` spelling basics.js uses. */
const BASE_CLASS_PROTOTYPES = `
var C = class C {};
class D {}
var r = 0;
r += Object.getPrototypeOf(C.prototype) === Object.prototype ? 1 : 0;
r += Object.getPrototypeOf(C) === Function.prototype ? 2 : 0;
r += Object.getPrototypeOf(D.prototype) === Object.prototype ? 4 : 0;
r += Object.getPrototypeOf(D) === Function.prototype ? 8 : 0;
__r = r;
`;

/** Step 3 — every shape must throw a TypeError at class-definition time. */
const HERITAGE = `
function te(f) { try { f(); } catch (e) { return e instanceof TypeError ? 1 : 2; } return 0; }
var Base = function () {}.bind();
var Guarded = function () {}.bind();
Object.defineProperty(Guarded, 'prototype', { set: function () { throw new Error('setter ran'); } });
var r = 0;
r += te(function () { class C extends (function () {}).bind() {} }) === 1 ? 1 : 0;
r += te(function () { class C extends Base {} }) === 1 ? 2 : 0;
r += te(function () { class C extends Guarded {} }) === 1 ? 4 : 0;
r += te(function () { class C extends Math.abs {} }) === 1 ? 8 : 0;
__r = r;
`;

describe("#6767 — standalone class definition reflective residue", () => {
  it("p11 answers node's 250 (RED on base: 229)", async () => {
    expect(runHost(P11)).toBe(250);
    expect(await runStandalone(P11)).toBe(250);
  });

  it("p12 answers node's 511 (RED on base: 303; bit 16 was the R1 residual, fixed by #6772 S12)", async () => {
    expect(runHost(P12)).toBe(511);
    expect(await runStandalone(P12)).toBe(511);
  });

  it("step 1: a helper sees method/accessor descriptors on C and C.prototype (RED on base: 811)", async () => {
    expect(runHost(HELPER_DESCRIPTORS)).toBe(0);
    expect(await runStandalone(HELPER_DESCRIPTORS)).toBe(0);
  });

  it("step 1: bound hasOwnProperty sees statics, and a delete removes one (RED on base)", async () => {
    expect(runHost(BOUND_HASOWN_AND_DELETE)).toBe(31);
    expect(await runStandalone(BOUND_HASOWN_AND_DELETE)).toBe(31);
  });

  it("step 1: dynamic read / write / `in` reach the declared statics with C as receiver (RED on base: 2)", async () => {
    expect(runHost(DYNAMIC_MOP)).toBe(15);
    expect(await runStandalone(DYNAMIC_MOP)).toBe(15);
  });

  it("step 1: C[4]() / C['m']() as a call argument (RED on base)", async () => {
    expect(runHost(STATIC_ELEMENT_CALL_ARGUMENT)).toBe(3);
    expect(await runStandalone(STATIC_ELEMENT_CALL_ARGUMENT)).toBe(3);
  });

  it("step 2: a base class and its prototype report their real [[Prototype]] (RED on base)", async () => {
    expect(runHost(BASE_CLASS_PROTOTYPES)).toBe(15);
    expect(await runStandalone(BASE_CLASS_PROTOTYPES)).toBe(15);
  });

  it("step 3: prototype-less bound functions and Math.* throw at definition (RED on base)", async () => {
    expect(runHost(HERITAGE)).toBe(15);
    expect(await runStandalone(HERITAGE)).toBe(15);
  });

  // ── guards: the same answer on base and branch ──────────────────────────
  it("guard: gOPD(C.prototype, 'method') keeps its descriptor", async () => {
    const src = `
      class C { method() { return 1; } }
      var d = Object.getOwnPropertyDescriptor(C.prototype, 'method');
      __r = (d.writable === true && d.enumerable === false && d.configurable === true && d.value() === 1) ? 1 : 0;
    `;
    expect(runHost(src)).toBe(1);
    expect(await runStandalone(src)).toBe(1);
  });

  it("guard: class D extends B keeps its prototype chain and inherited statics", async () => {
    const src = `
      class B { m() { return 1; } static s() { return 2; } }
      class D extends B {}
      var r = 0;
      r += Object.getPrototypeOf(D.prototype) === B.prototype ? 1 : 0;
      r += new D().m() === 1 ? 2 : 0;
      r += D.s() === 2 ? 4 : 0;
      r += new D() instanceof B ? 8 : 0;
      __r = r;
    `;
    expect(runHost(src)).toBe(15);
    expect(await runStandalone(src)).toBe(15);
  });

  // ── RESIDUAL pins ───────────────────────────────────────────────────────
  it("a static accessor sharing an instance accessor's name reads the static half (node: 3; was RESIDUAL R1, fixed by #6772 S12)", async () => {
    // #5195 cluster B item 5: `get eval` and `static get eval` shared ONE
    // function slot; #6772 S12 gives the static half its own key.
    // definition/getters-restricted-ids.js.
    const src = `class C { get eval() { return 1; } static get eval() { return 3; } } __r = C.eval;`;
    expect(runHost(src)).toBe(3);
    expect(await runStandalone(src)).toBe(3);
  });

  it("getPrototypeOf of a DERIVED class object is its parent (node: 1; was RESIDUAL R4, fixed by #6772 S6)", async () => {
    // Step 2 routes only BASE classes; #6772 S6 answers the parent's class
    // object for a derived class whose heritage provably names that parent.
    const src = `class B {} class D extends B {} __r = Object.getPrototypeOf(D) === B ? 1 : 0;`;
    expect(runHost(src)).toBe(1);
    expect(await runStandalone(src)).toBe(1);
  });
});
