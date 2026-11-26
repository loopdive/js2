// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 A1 (#7352) — arrays on the Prepared path: an array is an ordinary object of the realm carrying the Array exotic
// brand, its index properties and `length` ordinary own data properties, and every define of one goes through the
// realm's ArrayDefineOwnProperty (src/runtime/wasmgc/values/realm-array-bodies.ts). Each program computes `out` and is
// checked against node in a fresh realm (some write Array.prototype) and with a wrong answer, under the test262 runner's
// options (a TypeScript type error is no JavaScript error; tests/helpers/prepared-node-agreement.ts). The array
// define's own cases are in tests/issue-7354-a1-arrays.test.ts.
import { describe, it } from "vitest";
import { agreesWithNode, freshRealmOut, runnerOptions } from "./helpers/prepared-node-agreement.js";

const SLOW = 300_000;

const GROUPS: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  [
    "arrays as values",
    [
      ["G1-prop-value", "var o = { a: [1, 2] }; var out = String(o.a.length) + String(o.a[1]);"],
      ["G2-argument", "function f(x) { return x.length + x[0]; } var out = String(f([3, 4]));"],
      ["G3-return", "function f() { return [7, 8, 9]; } var a = f(); var out = String(a.length) + a[2];"],
      ["G4-closure", "var a = [1]; function f() { a[1] = 2; return a.length; } var out = String(f()) + a[1];"],
      ["G6-array-of-arrays", "var m = [[1, 2], [3, 4]]; m[1][0] = 9; var out = String(m[1][0]) + m[0][1] + m.length;"],
      ["G7-param-write", "function f(x) { x[0] = 'w'; } var a = []; f(a); var out = a[0] + a.length;"],
      ["G8-identity", "var a = [1]; var b = a; b[1] = 2; var out = String(a.length) + String(a === b);"],
      ["G11-loop-fill", "var a = []; for (var i = 0; i < 5; i++) a[i] = i * i; var out = String(a.length) + a[4];"],
      [
        "G12-loop-read",
        "var a = [3, 1, 4, 1, 5]; var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; var out = String(s);",
      ],
      [
        "Q4-fn-local-holes",
        "function f() { var a = [1, , 3]; return String(a.hasOwnProperty('1')) + a.length; } var out = f();",
      ],
      [
        "Q5-fn-computed",
        "function f(a, i) { return a[i]; } var out = String(f([5, 6, 7], 2)) + String(f(['p'], '0'));",
      ],
    ],
  ],
  [
    "keys",
    [
      ["H1-string-index", "var a = []; a['1'] = 'x'; var out = String(a.length) + a[1];"],
      ["H2-leading-zero", "var a = []; a['01'] = 'x'; var out = String(a.length) + a['01'];"],
      ["H3-one-point-zero", "var a = []; a['1.0'] = 'x'; var out = String(a.length) + a['1.0'];"],
      ["H4-minus-zero-str", "var a = []; a['-0'] = 'x'; var out = String(a.length) + a['-0'];"],
      ["H5-2p32-1", "var a = []; a['4294967295'] = 'x'; var out = String(a.length);"],
      ["H6-negative", "var a = []; a[-1] = 'x'; var out = String(a.length) + a[-1] + a['-1'];"],
      ["H7-fraction", "var a = []; a[1.5] = 'x'; var out = String(a.length) + a['1.5'];"],
      ["H9-minus-zero-num", "var a = []; a[-0] = 'x'; var out = String(a.length) + a[0];"],
      ["H11-computed-string", "var a = [10, 20, 30]; var k = '1'; var out = String(a[k]);"],
      ["H12-computed-missing-numeric", "var a = [10]; var k = '5'; var out = String(a[k]);"],
      ["H13-computed-write-number", "var a = []; var k = 3; a[k] = 'v'; var out = String(a.length) + a[3];"],
      [
        "H16-length-key-computed",
        "var a = [1, 2, 3]; var k = 'length'; a[k] = 1; var out = String(a.length) + String(a[k]);",
      ],
      ["H17-nan-key", "var a = []; a[NaN] = 'n'; var out = String(a.length) + a['NaN'];"],
      ["O2-obj-write-string", "var o = {}; var k = 'y'; o[k] = 2; var out = String(o.y);"],
      [
        "O7-nullish-recv",
        "var o = null; var k = 'x'; var out = 'none'; try { o[k]; } catch (e) { out = String(e instanceof TypeError); }",
      ],
    ],
  ],
  [
    "Array, new Array and IsArray",
    [
      ["I1-new-empty", "var a = new Array(); var out = String(a.length) + String(Array.isArray(a));"],
      ["I2-new-n", "var a = new Array(4); var out = String(a.length) + String(a.hasOwnProperty('0'));"],
      ["I3-new-args", "var a = new Array(1, 2, 3); var out = String(a.length) + a[2];"],
      ["I5-call-args", "var a = Array('a', 'b'); var out = a[0] + a[1] + a.length;"],
      ["I6-new-neg", "var out = 'none'; try { new Array(-1); } catch (e) { out = String(e instanceof RangeError); }"],
      ["I7-new-frac", "var out = 'none'; try { new Array(1.5); } catch (e) { out = String(e instanceof RangeError); }"],
      ["I8-new-string", "var a = new Array('3'); var out = String(a.length) + a[0];"],
      ["I12-new-object", "var o = {}; var a = new Array(o); var out = String(a.length) + String(a[0] === o);"],
      [
        "J1-isArray",
        "var out = String(Array.isArray([])) + String(Array.isArray({})) + String(Array.isArray('a')) + String(Array.isArray(null)) + String(Array.isArray());",
      ],
      [
        "J2-isArray-proto-child",
        "var o = Object.create(Array.prototype); var out = String(Array.isArray(o)) + String(o instanceof Array);",
      ],
      [
        "J3-instanceof",
        "var out = String([] instanceof Array) + String([] instanceof Object) + String({} instanceof Array);",
      ],
      [
        "J7-Array-props",
        "var out = String(Array.length) + Array.name + String(Array.prototype.constructor === Array);",
      ],
      [
        "J9-prototype-desc",
        "var d = Object.getOwnPropertyDescriptor(Array, 'prototype'); var out = String(d.writable) + d.enumerable + d.configurable;",
      ],
      [
        "Q6-fn-isArray",
        "function f(x) { return Array.isArray(x); } var out = String(f([])) + String(f({})) + String(f(3));",
      ],
    ],
  ],
  [
    "defines on arrays",
    [
      [
        "K1-define-len-bool",
        "var a = [1, 2]; Object.defineProperty(a, 'length', { value: true }); var out = String(a.length);",
      ],
      [
        "K2-define-len-neg",
        "var arrObj = []; var out = 'none'; try { Object.defineProperty(arrObj, 'length', { value: -Infinity }); } catch (e) { out = String(e instanceof RangeError); }",
      ],
      [
        "K4-define-len-grow",
        "var arr = [0, , 2]; Object.defineProperties(arr, { length: { value: 3 } }); var out = String(arr.length) + arr[0] + String(arr.hasOwnProperty('1'));",
      ],
      [
        "K5-define-index-grows",
        "var a = []; Object.defineProperty(a, '7', { value: 1, writable: true, enumerable: true, configurable: true }); var out = String(a.length);",
      ],
      [
        "K6-define-index-accessor",
        "var a = []; Object.defineProperty(a, '2', { get: function () { return 'g'; }, configurable: true }); var out = String(a.length) + a[2];",
      ],
      [
        "K10-define-index-desc",
        "var a = [1]; Object.defineProperty(a, '0', { enumerable: false }); var d = Object.getOwnPropertyDescriptor(a, '0'); var out = String(d.value) + d.enumerable + d.writable;",
      ],
      [
        "L4-defineProperties-many",
        "var a = []; Object.defineProperties(a, { 0: { value: 'a', enumerable: true }, 3: { value: 'd' } }); var out = String(a.length) + a[0] + a[3];",
      ],
      [
        "M4-shrink-removes-accessor",
        "var a = []; Object.defineProperty(a, '3', { get: function () { return 'g'; }, configurable: true }); a.length = 2; var out = String(a.length) + String(a[3]);",
      ],
    ],
  ],
];

describe("#7354 A1 — arrays as values, keys, Array and defines agree with node", () => {
  describe.each(GROUPS)("%s", (_group, programs) => {
    it.each(programs)("%s", async (_label, body) => agreesWithNode(body, true, runnerOptions(), freshRealmOut), SLOW);
  });
});
