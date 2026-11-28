// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7580 — `Object` statics as values on the Prepared path: `defineProperty`, `getOwnPropertyDescriptor`, `create`,
// `defineProperties` and `getOwnPropertyNames` read as values (identity, `typeof`, `name`, `length`), stored and passed,
// and called through the value with the direct call's answer whatever the receiver. The escape rule: a folded call of
// a static the program may have replaced reads the static and answers by identity, so a replaced static is never
// answered by the fold (the run-time abort instead).
//
// Each program computes `out` and is checked against node in a fresh realm, with a wrong answer that must throw
// (tests/helpers/prepared-node-agreement.ts). Every program calls a function expression, as the test262 harness does.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  abortsAtRunTime,
  agreesWithNode,
  freshRealmOut,
  refusal,
  runnerOptions,
} from "./helpers/prepared-node-agreement.js";

const SLOW = 300_000;
const CALLS = "\nvar k = function(){ return 1; }; k();";
const ID = "var id = function (v) { return v; };\n";

/** `body` as a function's statements whose result is `out`. */
const inFunction = (body: string) => `function run() {\n${body}\nreturn out;\n}\nvar out = run();`;
const agrees = (body: string) => agreesWithNode(body + CALLS, true, runnerOptions(), freshRealmOut);
const aborts = (body: string) => abortsAtRunTime(body + CALLS, runnerOptions(), (source) => freshRealmOut(source));
const PRELUDE = ["assert.js", "sta.js"].map((name) => readFileSync(`test262/harness/${name}`, "utf8")).join("\n");

const VALUES: readonly (readonly [string, string])[] = [
  [
    "a static as a value: typeof, identity, name, length",
    `var d = Object.defineProperty;
var out = typeof d + String(d === Object.defineProperty) + String(d === Object.getOwnPropertyDescriptor) + d.name
  + d.length;`,
  ],
  [
    "propertyHelper.js's three statics are held",
    `var a = Object.defineProperty, b = Object.getOwnPropertyDescriptor, c = Object.getOwnPropertyNames;
var out = typeof a + typeof b + typeof c + c.name + c.length + b.length + String(a !== b);`,
  ],
  [
    "defineProperty and getOwnPropertyDescriptor called through the value",
    `var d = Object.defineProperty, g = Object.getOwnPropertyDescriptor, o = {};
d(o, "x", { value: 1 });
var e = g(o, "x");
var out = String(o.x) + String(e.writable) + String(e.enumerable) + String(e.value);`,
  ],
  [
    "create and defineProperties called through the value",
    `var c = Object.create, dp = Object.defineProperties, p = { q: 2 };
var o = c(p);
dp(o, { y: { value: 3, enumerable: true } });
var out = String(o.q) + String(o.y);`,
  ],
  [
    "a static stored in an object and called as its method of the same name ignores this",
    'var h = { defineProperty: Object.defineProperty }, o = {};\nh.defineProperty(o, "z", { value: 7 });\nvar out = String(o.z);',
  ],
  [
    "a static passed as an argument and called in a closure",
    `var mk = function (d) { return function (o) { d(o, "w", { value: 9 }); return o.w; }; };
var out = String(mk(Object.defineProperty)({}));`,
  ],
  [
    "a call through the value with an argument missing",
    "var g = Object.getOwnPropertyDescriptor, o = { undefined: 4 };\nvar out = String(g(o).value);",
  ],
  [
    "a call through the value throws the static's TypeError",
    `var d = Object.defineProperty, out = "";
try { d(1, "x", {}); out = "no"; } catch (e) { out = e instanceof TypeError ? "TE" : "other"; }`,
  ],
  [
    "the root as the argument of a held static, read off a primitive",
    ID +
      `var d = Object.defineProperty;
d(Object.prototype, "g", { value: "V", writable: true, configurable: true });
var out = String(id(1).g) + String(id("s").g);`,
  ],
  [
    "a static's own descriptor on Object",
    `var e = Object.getOwnPropertyDescriptor(Object, "defineProperty");
var out = String(e.writable) + String(e.enumerable) + String(e.configurable) + String(e.value === Object.defineProperty);`,
  ],
  [
    "a static's write in a never-called function leaves the folded call right",
    'var never = function (x) { x.defineProperty = 0; }, o = {};\nObject.defineProperty(o, "a", { value: 2 });\nvar out = String(o.a);',
  ],
  [
    "a shadowing parameter named Object is the user's binding",
    "var run = function (Object) { return Object.defineProperty; };\nvar out = String(run({ defineProperty: 5 }));",
  ],
];

describe("#7580 — Object statics as values agree with node", () => {
  it.each(VALUES)("%s (at module level)", async (_label, body) => agrees(body), SLOW);
  it.each([VALUES[0]!, VALUES[2]!])("%s (inside a function)", async (_label, body) => agrees(inFunction(body)), SLOW);
  it(
    "behind the prelude",
    async () => {
      const body = `var __defineProperty = Object.defineProperty;
var __getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
var __getOwnPropertyNames = Object.getOwnPropertyNames;
var o = {};
__defineProperty(o, "a", { value: 1, configurable: true });
assert.sameValue(__getOwnPropertyDescriptor(o, "a").configurable, true);
assert.sameValue(typeof __getOwnPropertyNames, "function");
var out = "ok";`;
      await agreesWithNode(`${PRELUDE}\n${body}`, true, runnerOptions(), freshRealmOut);
    },
    SLOW,
  );
});

describe("#7580 — a replaced static is never answered by the fold", () => {
  it.each([
    [
      "written through an alias, then called",
      'var O = Object; O.defineProperty = function () { return "f"; };\nvar out = String(Object.defineProperty({}, "a", {}));',
    ],
    [
      "written through a parameter of a called function, then called",
      `var w = function (x) { x.getOwnPropertyDescriptor = function () { return 5; }; };
w(Object);
var out = String(Object.getOwnPropertyDescriptor({ a: 1 }, "a"));`,
    ],
    [
      "written through the root's constructor, then called",
      'var C = ({}).constructor; C.defineProperty = function () { return "c"; };\nvar out = String(Object.defineProperty({}, "a", {}));',
    ],
    [
      "written through an alias, then read and called",
      "var O = Object, f = function () { return 1; }; O.create = f;\nvar out = String(Object.create === f) + String(Object.create());",
    ],
    [
      "getOwnPropertyNames called through the value",
      "var n = Object.getOwnPropertyNames;\nvar out = String(n({ a: 1 }).length);",
    ],
  ])("aborts %s", async (_label, body) => aborts(body), SLOW);

  it.each([
    [
      "a static written with a literal key on the global",
      'Object["defineProperty"] = function () { return "f"; };\nvar out = String(Object.defineProperty({}, "a", {}));',
    ],
    [
      "a static defined on Object by defineProperty",
      `Object.defineProperty(Object, "getOwnPropertyDescriptor", { value: function () { return "g"; } });
var out = String(Object.getOwnPropertyDescriptor({ a: 1 }, "a"));`,
    ],
    ["a computed key off Object", 'var k = "define" + "Property";\nvar out = typeof Object[k];'],
    ["a static the realm does not hold, read as a value", "var f = Object.keys;\nvar out = typeof f;"],
  ])(
    "refuses %s",
    async (_label, body) => {
      expect(await refusal(body + CALLS, runnerOptions())).not.toBe("");
    },
    SLOW,
  );
});
