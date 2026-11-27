// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 O1 — `Object.defineProperty` and `Object.getOwnPropertyDescriptor` through the strict Prepared entry
// (src/ir/realm-static-call.ts, src/ir/program/dynamic-object-statics.ts, the realm's descriptor bodies), with the
// test262 runner's options. Each accepted program runs twice against node: its answer returns, a wrong one throws. A
// TypeError the specification demands is caught by the program itself, so it is part of node's answer.
import { afterEach, describe, expect, it, vi } from "vitest";
import { agreesWithNode, nodeOut, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";
import { compile } from "../src/test262/test262-prepared-entry.js";
import { CATCHES, FIELDS } from "./helpers/object-static-probes.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;
const agrees = (body: string) => agreesWithNode(body, true, runnerOptions());

describe("#7354 O1 — Object.defineProperty", () => {
  it.each([
    ["(1) a value is defined", "var o = {}; Object.defineProperty(o, 'p', {value: 1}); var out = String(o.p);"],
    [
      "(2) absent attributes are false: a sloppy write is ignored",
      "var o = {}; Object.defineProperty(o, 'p', {value: 1}); o.p = 2; var out = String(o.p);",
    ],
    [
      "(2) strict: the write to a read-only property is a TypeError, the value stays",
      `'use strict'; ${CATCHES} var o = {}; Object.defineProperty(o, 'p', {value: 1});` +
        " var out = t(function(){ o.p = 2; }) + String(o.p);",
    ],
    [
      "(3) a writable property takes a write and a redefinition",
      `${FIELDS} var o = {}; Object.defineProperty(o, 'p', {value: 1, writable: true}); o.p = 2;` +
        " var out = String(o.p); Object.defineProperty(o, 'p', {value: 3});" +
        " out = out + String(o.p) + fields(Object.getOwnPropertyDescriptor(o, 'p'));",
    ],
    [
      "(4) non-configurable: the same value redefines; another value, enumerable, get, configurable, writable throw",
      `${CATCHES} ${FIELDS} var o = {}; Object.defineProperty(o, 'p', {value: 1});` +
        " var out = t(function(){ Object.defineProperty(o, 'p', {value: 1}); })" +
        " + t(function(){ Object.defineProperty(o, 'p', {value: 2}); })" +
        " + t(function(){ Object.defineProperty(o, 'p', {enumerable: true}); })" +
        " + t(function(){ Object.defineProperty(o, 'p', {get: function(){ return 5; }}); })" +
        " + t(function(){ Object.defineProperty(o, 'p', {configurable: true}); })" +
        " + t(function(){ Object.defineProperty(o, 'p', {writable: true}); }) + fields(Object.getOwnPropertyDescriptor(o, 'p'));",
    ],
    [
      "(5) a target that is no object is a TypeError, after every argument is evaluated",
      `${CATCHES} var n = 0; function d(){ n = n + 1; return {value: 1}; }` +
        " var out = t(function(){ Object.defineProperty(1, 'p', d()); }) + t(function(){ Object.defineProperty(undefined, 'p', d()); })" +
        " + t(function(){ Object.defineProperty('s', 'p', d()); }) + t(function(){ Object.defineProperty(null, 'p', d()); })" +
        " + t(function(){ Object.defineProperty(true, 'p', d()); }) + String(n);" +
        // The target's TypeError comes before ToPropertyKey: the key's toString is not called.
        " var m = 0; var k = {toString: function(){ m = m + 1; return 'p'; }};" +
        " out = out + t(function(){ Object.defineProperty(1, k, {}); }) + String(m);",
    ],
    [
      "(6) a descriptor that is no literal: written to after creation, and filled in by a function",
      `${FIELDS} var o = {}; var d = {value: 1}; d.enumerable = true; Object.defineProperty(o, 'p', d);` +
        " function fill(r, v){ r.value = v; r.writable = 1; r.configurable = 'yes'; } var e = {}; fill(e, 4); Object.defineProperty(o, 'q', e);" +
        " var out = fields(Object.getOwnPropertyDescriptor(o, 'p')) + '|' + fields(Object.getOwnPropertyDescriptor(o, 'q'));",
    ],
    [
      "(7) accessor and data fields together, a getter that is no function: TypeError; `set: undefined` defines",
      `${CATCHES} ${FIELDS} var o = {}; var nothing = null;` +
        " var out = t(function(){ Object.defineProperty(o, 'a', {value: 1, get: function(){}}); })" +
        " + t(function(){ Object.defineProperty(o, 'b', {get: 1}); }) + t(function(){ Object.defineProperty(o, 'c', {set: nothing}); })" +
        " + t(function(){ Object.defineProperty(o, 'd', {writable: true, set: function(v){}}); })" +
        " + t(function(){ Object.defineProperty(o, 'e', {set: undefined}); }) + fields(Object.getOwnPropertyDescriptor(o, 'e'))" +
        " + fields(Object.getOwnPropertyDescriptor(o, 'a')) + fields(Object.getOwnPropertyDescriptor(o, 'b'));",
    ],
    [
      "(8) a descriptor that is no object is a TypeError",
      `${CATCHES} var o = {}; var out = t(function(){ Object.defineProperty(o, 'p', 1); })` +
        " + t(function(){ Object.defineProperty(o, 'p', 'x'); }) + t(function(){ Object.defineProperty(o, 'p', null); })" +
        " + t(function(){ Object.defineProperty(o, 'p'); }) + String(o.p);",
    ],
    [
      "(9) the answer is the object, also for a function object",
      "var o = {}; function f(){} var out = (Object.defineProperty(o, 'p', {}) === o ? 'y' : 'n')" +
        " + (Object.defineProperty(f, 'q', {value: 2}) === f ? 'y' : 'n') + String(f.q) + String(o.p);",
    ],
  ])("%s", async (_name, body) => agrees(body), SLOW);
});

describe("#7354 O1 — Object.getOwnPropertyDescriptor", () => {
  it.each([
    [
      "(10) each define's record, an absent key, a literal's property, a function's own `length`",
      `${FIELDS} var o = {a: 1}; Object.defineProperty(o, 'p', {value: 1});` +
        " Object.defineProperty(o, 'q', {value: 2, writable: true, enumerable: true});" +
        " Object.defineProperty(o, 'r', {get: undefined, configurable: true}); function f(x, y){}" +
        " var out = fields(Object.getOwnPropertyDescriptor(o, 'p')) + '|' + fields(Object.getOwnPropertyDescriptor(o, 'q'))" +
        " + '|' + fields(Object.getOwnPropertyDescriptor(o, 'r')) + '|' + fields(Object.getOwnPropertyDescriptor(o, 'zz'))" +
        " + '|' + fields(Object.getOwnPropertyDescriptor(o, 'a')) + '|' + fields(Object.getOwnPropertyDescriptor(f, 'length'));",
    ],
    [
      "(11) the record is a fresh object: writing it changes nothing",
      "var o = {p: 1}; var d = Object.getOwnPropertyDescriptor(o, 'p'); d.value = 9;" +
        " var e = Object.getOwnPropertyDescriptor(o, 'p'); var out = String(o.p) + (d === e ? 'y' : 'n') + String(e.value);",
    ],
    [
      "a target that is no object: undefined/null throw, a number or a Boolean has no own property",
      `${CATCHES} var out = t(function(){ Object.getOwnPropertyDescriptor(undefined, 'p'); })` +
        " + t(function(){ Object.getOwnPropertyDescriptor(null, 'p'); })" +
        " + String(Object.getOwnPropertyDescriptor(1, 'p')) + String(Object.getOwnPropertyDescriptor(true, 'toString'));",
    ],
  ])("%s", async (_name, body) => agrees(body), SLOW);
});

// (#7354 O1) The real-compile counterpart of the four retired "executes actual source slots" tests of
// tests/issue-3518-native-object-realm-declarations.test.ts (their STATE_SOURCE, as a script): a closure that captures
// its factory's parameter and one that captures nothing, each returned as a value and called through it; two closures
// of one factory keep their own captures and are distinct objects; the standalone module imports nothing. Their "a
// call before initialize traps" fact belongs to the hand-built module, whose realm a test initialised by hand; a
// compiled program initialises the realm in its module-init before any source code runs, so no source program can
// call a closure before it.
describe("#7354 O1 — retired #3518 fixture: closures returned from functions, called through values", () => {
  const body =
    "function makeCaptured(seed){ return function captured(value){ return seed + value; }; }" +
    " function makeEmpty(){ return function empty(value){ return value + 7; }; }" +
    " var a = makeCaptured(13), b = makeCaptured(100), e = makeEmpty(), c = makeCaptured(21);" +
    " var out = String(a(7)) + ',' + String(b(7)) + ',' + String(e(3)) + ',' + String(c(2))" +
    " + (a === b ? ',same' : ',distinct') + ',' + a.name + e.name;";
  it("calls each closure with its own capture", async () => agrees(body), SLOW);
  // The retired tests' `displaced` runs stored strings as UTF-8; the same program under that storage.
  it(
    "calls each closure with its own capture under UTF-8 string storage",
    async () => agreesWithNode(body, true, { ...runnerOptions(), utf8Storage: true }),
    SLOW,
  );
  it(
    "emits a module without imports",
    async () => {
      const result = await compile(`${body}\nif (out !== ${JSON.stringify(nodeOut(body))}) throw 1;`, runnerOptions());
      expect(WebAssembly.Module.imports(new WebAssembly.Module(result.binary))).toEqual([]);
    },
    SLOW,
  );
});

// (#7354 O1 review) The native statics apply only to the unchanged global `Object` (`builtin-global-binding.ts`): a
// program's own binding of the name at any level, or an assignment to it anywhere, leaves `Object.m(…)` to the
// ordinary paths, which refuse it by name here; node's answer differs from the native static's in each.
describe("#7354 O1 — a shadowed or assigned Object never takes the native statics", () => {
  it.each([
    ["a function declaration before", "function Object(){} var o = {}; Object.defineProperty(o, 'p', {value: 1});"],
    ["a function declaration after", "var o = {}; Object.create(o); function Object(){ return 1; }"],
    [
      "a declaration after, getOwnPropertyDescriptor",
      "Object.getOwnPropertyDescriptor({a: 1}, 'a'); function Object(){}",
    ],
    ["a class declaration after (TDZ)", "Object.defineProperties({}, {}); class Object {}"],
    ["a var", "var Object = {defineProperty: function(o, k, d){ return 5; }}; Object.defineProperty({}, 'p', {});"],
    [
      "an assignment in a function never called",
      "function never(){ Object = 1; } Object.defineProperty({}, 'p', {value: 1});",
    ],
    ["Object.is under a function declaration (#7106)", "function Object(){} var out = String(Object.is(1, 1));"],
  ])(
    "%s refuses by name",
    async (_name, source) => {
      expect(await refusal(source, runnerOptions())).not.toBe("");
    },
    SLOW,
  );
  it(
    "a parameter named Object is the argument",
    async () =>
      agrees(
        "function f(Object){ var o = {}; Object.defineProperty(o, 'p', {value: 1}); return String(o.p); }" +
          " var out = f({defineProperty: function(){}});",
      ),
    SLOW,
  );
});

/** The four statics on `o`, and a dynamic reader of what they did (a parameter of a top-level function). */
const STATICS = `Object.defineProperty(o, "a", { value: 1, enumerable: true });
  Object.defineProperties(o, { b: { value: 2, writable: true } });
  var d = Object.getOwnPropertyDescriptor(o, "a");
  var c = Object.create(o, { z: { value: 3 } });`;
const SHOW = `function show(o, d, c){ return "" + o.a + o.b + d.value + d.enumerable + d.writable + c.a + c.z; }\n`;
const RESULT = "return show(o, d, c);";

describe("#7354 O1c — the statics inside a function body", () => {
  it.each([
    ["a function-local object", `function f(){ var o = {}; ${STATICS} ${RESULT} } var out = f();`],
    ["a parameter", `function f(o){ ${STATICS} ${RESULT} } var out = f({});`],
    [
      "an object a call returns",
      `function mk(){ return {}; } function f(){ var o = mk(); ${STATICS} ${RESULT} } var out = f();`,
    ],
    [
      "a function-local object a call returns",
      `function mk(){ var o = {}; return o; } function f(){ var o = mk(); ${STATICS} ${RESULT} } var out = f();`,
    ],
    ["a constructor", `function C(){ var o = {}; ${STATICS} this.r = show(o, d, c); } var out = new C().r;`],
    // (#7354 L0c) A closure reads the captured object from the function's cell of the dynamic value.
    [
      "a nested closure over a function-local object",
      `function f(){ var o = {}; var g = function(){ ${STATICS} ${RESULT} }; return g(); } var out = f();`,
    ],
  ])("%s agrees with node", (_name, body) => agrees(SHOW + body), SLOW);
});
