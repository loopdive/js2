// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7574 — `Object` as a realm value on the Prepared path: `Object` and `Object.prototype` (the realm's root) as values,
// `Object(v)` / `new Object(v)`, `instanceof Object`, Object.prototype's `toString` / `valueOf` by identity, and a
// program's write to the root seen by every receiver. What the slice leaves out (statics as values, a write to a static,
// an own-property query of the root with a key it lacks) refuses or aborts.
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

/** Programs checked at module level and inside a function. */
const VALUES: readonly (readonly [string, string])[] = [
  [
    "Object as a value: typeof, identity, name, length",
    "var O = Object;\nvar out = typeof Object + typeof O + String(O === Object) + Object.name + Object.length;",
  ],
  [
    "Object.prototype is the root: constructor, identity, its descriptor",
    `var p = Object.prototype, d = Object.getOwnPropertyDescriptor(Object, "prototype");
var out = typeof p + String(p === Object.prototype) + String(p.constructor === Object)
  + String(({}).constructor === Object) + String(d.value === p) + String(d.writable) + String(d.configurable);`,
  ],
  [
    "Object(v) and new Object(v) of each kind",
    `var o = { a: 1 }, f = function () {};
var out = typeof new Object() + typeof Object() + typeof Object(null) + typeof Object(undefined)
  + String(Object(o) === o) + String(Object(f) === f) + typeof new Object(1);`,
  ],
  [
    "Object(primitive) is its wrapper",
    'var n = Object(1), s = Object("ab"), t = Object(true);\nvar out = String(n + 1) + String(s.length) + String(t.valueOf());',
  ],
  [
    "instanceof Object",
    `var out = String(({}) instanceof Object) + String(new Object() instanceof Object)
  + String(Object.create(null) instanceof Object) + String((function () {}) instanceof Object)
  + String(new Object(1) instanceof Number) + String(5 instanceof Object);`,
  ],
  [
    "toString and valueOf of new Object() (S15.5.4.15_A3_T6, S15.5.4.13_A3_T2)",
    "var o = new Object();\nvar out = o.toString() + new Object().toString() + String(o.valueOf() === o);",
  ],
];

/** Programs that write the root: every receiver sees the write. */
const WRITES: readonly (readonly [string, string])[] = [
  [
    "a key written on the root, read off objects and primitives",
    ID +
      'Object.prototype.x = 5;\nvar out = String(id({}).x) + String(id(5).x) + String(id("a").x) + String(id(true).x);',
  ],
  [
    "a key written on the root, read off a function, an error, a wrapper and an array",
    ID +
      `Object.prototype.x = 5;
var out = String(id(function () {}).x) + String(id(new Error("m")).x) + String(id(new Number(1)).x)
  + String(id(new Array(1)).x);`,
  ],
  [
    "a written toString is ToPrimitive's and the method call's",
    ID +
      'Object.prototype.toString = function () { return "z"; };\nvar o = id({});\nvar out = String(o) + ("" + o) + o.toString();',
  ],
  [
    "a written valueOf is ToPrimitive's",
    ID + "Object.prototype.valueOf = function () { return 7; };\nvar out = String(id({}) * 1);",
  ],
  [
    "the root's own keys",
    'var p = Object.prototype;\nvar out = String(p.hasOwnProperty("valueOf")) + String(p.hasOwnProperty("x"));',
  ],
  // Review r1: `Object.prototype` as the argument of a folded static is a read of the root.
  [
    "a key defined on the root by a folded static, read off primitives",
    ID +
      `Object.defineProperty(Object.prototype, "g", { value: "V", writable: true, configurable: true });
var out = String(id(1).g) + String(id("s").g) + String(id(true).g);`,
  ],
  [
    "the root written by a program function it is passed to",
    ID + 'function w(p) { p.x = 1; }\nw(Object.prototype);\nvar out = String(id(1).x) + String(id("s").x);',
  ],
];

describe("#7574 — Object as a realm value agrees with node", () => {
  it.each(VALUES)("%s (at module level)", async (_label, body) => agrees(body), SLOW);
  it.each([VALUES[0]!, VALUES[1]!, VALUES[4]!, VALUES[5]!])(
    "%s (inside a function)",
    async (_label, body) => agrees(inFunction(body)),
    SLOW,
  );
  it.each(WRITES)("%s", async (_label, body) => agrees(body), SLOW);
  it(
    "behind the prelude",
    async () => {
      const body = `assert.sameValue(typeof Object, "function");
assert.sameValue(Object.prototype.constructor, Object);
assert.sameValue(new Object().toString(), "[object Object]");
assert(({}) instanceof Object);
assert.sameValue(Object("ab").length, 2);
var out = "ok";`;
      await agreesWithNode(`${PRELUDE}\n${body}`, true, runnerOptions(), freshRealmOut);
    },
    SLOW,
  );
});

describe("#7574 — what the slice leaves out refuses or aborts", () => {
  it.each([
    [
      "a static written through a value, then folded",
      'var O = Object; O.defineProperty = function () { return 9; };\nvar out = String(Object.defineProperty({}, "a", { value: 1 }));',
    ],
    [
      "a static written through a parameter, then folded",
      'function w(x) { x.defineProperty = function () { return 9; }; }\nw(Object);\nvar out = String(Object.defineProperty({}, "a", { value: 1 }));',
    ],
    ["the root's __proto__ queried as own", 'var out = String(Object.prototype.hasOwnProperty("__proto__"));'],
    [
      "the root queried with a computed key",
      'var k = "__define" + "Getter__";\nvar out = String(Object.prototype.hasOwnProperty(k));',
    ],
    [
      "the object tag through a written toString",
      ID +
        'Object.prototype.toString = function () { return "z"; };\nvar out = Object.prototype.toString.call(id({}));',
    ],
    [
      "the root's __proto__ descriptor, the root a folded static's argument",
      'var out = typeof Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");',
    ],
    [
      "the object tag through a toString a folded static defined",
      ID +
        `Object.defineProperty(Object.prototype, "toString", {
  value: function () { return "z"; }, writable: true, configurable: true });
var out = Object.prototype.toString.call(id({}));`,
    ],
  ])("aborts %s", async (_label, body) => aborts(body), SLOW);

  it.each([
    ["a static the identity row lacks, called", "var out = String(Object.keys({ a: 1 }).length);"],
    ["a static written on the global", "Object.keys = function () { return 1; };\nvar out = String(Object.keys({}));"],
    ["a computed key off Object", 'var O = Object, k = "ke" + "ys";\nvar out = typeof O[k];'],
  ])(
    "refuses %s",
    async (_label, body) => {
      expect(await refusal(body + CALLS, runnerOptions())).not.toBe("");
    },
    SLOW,
  );
});
