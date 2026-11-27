// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 A1 (#7352) — arrays on the Prepared path: an array is an ordinary object of the realm carrying the Array exotic
// brand, its index properties and `length` ordinary own data properties, and every define of one goes through the
// realm's ArrayDefineOwnProperty (src/runtime/wasmgc/values/realm-array-bodies.ts). Each program computes `out` and is
// checked against node in a fresh realm (some write Array.prototype) and with a wrong answer, under the test262 runner's
// options (a TypeScript type error is no JavaScript error; tests/helpers/prepared-node-agreement.ts).
import { describe, it } from "vitest";
import { agreesWithNode, freshRealmOut, runnerOptions } from "./helpers/prepared-node-agreement.js";

const SLOW = 300_000;

const GROUPS: readonly (readonly [string, readonly (readonly [string, string])[]])[] = [
  [
    "literals, holes and elisions",
    [
      ["A1-empty", "var a = []; var out = String(a.length);"],
      ["A3-hole-mid", "var a = [1, , 3]; var out = String(a.length) + String(a.hasOwnProperty('1')) + String(a[1]);"],
      ["A5-trailing-hole", "var a = [1, , ]; var out = String(a.length) + String(a.hasOwnProperty('1'));"],
      ["A6-only-holes", "var a = [, , ,]; var out = String(a.length) + String(a.hasOwnProperty('0'));"],
      [
        "A7-mixed",
        "var a = [1, 'x', true, null, undefined]; var out = typeof a[0] + typeof a[1] + typeof a[2] + String(a[3]) + typeof a[4] + a.length;",
      ],
      ["A8-nested", "var a = [[1, 2], [3]]; var out = String(a[0][1]) + String(a[1].length) + String(a.length);"],
      [
        "A11-literal-hasown",
        "var a = [5]; var out = String(a.hasOwnProperty('0')) + String(a.hasOwnProperty('length')) + String(a.propertyIsEnumerable('0')) + String(a.propertyIsEnumerable('length'));",
      ],
      [
        "A12-literal-defines-not-sets",
        "Object.defineProperty(Array.prototype, '0', { value: 100, writable: false, configurable: true }); var arr = [101]; var out = String(arr.hasOwnProperty('0')) + String(arr[0]);",
      ],
    ],
  ],
  [
    "length (\u00a710.4.2.4)",
    [
      [
        "B1-len-truncate",
        "var a = [1, 2, 3]; a.length = 1; var out = String(a.length) + String(a[1]) + String(a.hasOwnProperty('2'));",
      ],
      [
        "B3-len-grow",
        "var a = [1]; a.length = 5; var out = String(a.length) + String(a.hasOwnProperty('4')) + String(a[4]);",
      ],
      [
        "B5-len-neg",
        "var a = []; var out = 'none'; try { a.length = -1; } catch (e) { out = String(e instanceof RangeError) + a.length; }",
      ],
      [
        "B6-len-frac",
        "var a = [1]; var out = 'none'; try { a.length = 1.5; } catch (e) { out = String(e instanceof RangeError) + a.length; }",
      ],
      ["B9-len-max", "var a = []; a.length = 4294967295; var out = String(a.length);"],
      ["B10-len-true", "var a = [1, 2, 3]; a.length = true; var out = String(a.length);"],
      ["B11-len-null", "var a = [1, 2, 3]; a.length = null; var out = String(a.length);"],
      [
        "B12-len-undefined",
        "var a = [1]; var out = 'none'; try { a.length = undefined; } catch (e) { out = String(e instanceof RangeError) + a.length; }",
      ],
      [
        "B14-len-desc",
        "var a = [1, 2]; var d = Object.getOwnPropertyDescriptor(a, 'length'); var out = String(d.value) + d.writable + d.enumerable + d.configurable;",
      ],
      ["C1-sparse-big", "var a = []; a[4294967294] = 1; var out = String(a.length);"],
      ["C2-sparse-2p31", "var x = []; x[2147483648] = 1; var out = String(x.length);"],
      [
        "C4-sparse-shrink",
        "var a = []; a[10] = 1; a[3] = 2; a.length = 5; var out = String(a.length) + String(a[10]) + String(a[3]);",
      ],
      ["C5-index-not-2p32-1", "var a = []; a[4294967295] = 'x'; var out = String(a.length) + a[4294967295];"],
      [
        "C6-out-of-order",
        "var a = []; a[3] = 'd'; a[1] = 'b'; a[0] = 'a'; var out = String(a.length) + a[0] + a[1] + String(a[2]) + a[3];",
      ],
      [
        "N1-index-after-length",
        "var a = [1, 2, 3]; a.length = 1; a[4] = 'e'; var out = String(a.length) + String(a[2]);",
      ],
      [
        "N4-length-in-loop",
        "var a = []; while (a.length < 4) a[a.length] = a.length; var out = String(a[3]) + a.length;",
      ],
    ],
  ],
  [
    "non-configurable elements and a read-only length",
    [
      [
        "D1-shrink-nonconf-sloppy",
        "var a = [1, 2, 3]; Object.defineProperty(a, '1', { value: 9, configurable: false }); a.length = 0; var out = String(a.length) + String(a[1]) + String(a[0]);",
      ],
      [
        "D2-shrink-nonconf-strict",
        "function f() { 'use strict'; var a = [1, 2, 3]; Object.defineProperty(a, '1', { value: 9, configurable: false }); try { a.length = 0; return 'no'; } catch (e) { return String(e instanceof TypeError) + a.length + String(a[2]); } } var out = f();",
      ],
      [
        "D3-shrink-nonconf-define",
        "var a = [1, 2, 3, 4]; Object.defineProperty(a, '2', { value: 9, configurable: false }); var out = 'none'; try { Object.defineProperty(a, 'length', { value: 1 }); } catch (e) { out = String(e instanceof TypeError) + a.length + String(a[3]) + String(a[1]); }",
      ],
      [
        "D5-shrink-two-nonconf",
        "var a = [1, 2, 3, 4, 5]; Object.defineProperty(a, '1', { configurable: false }); Object.defineProperty(a, '3', { configurable: false }); a.length = 0; var out = String(a.length) + String(a[4]) + String(a[3]) + String(a[2]) + String(a[1]);",
      ],
      [
        "D6-shrink-nonconf-writable-false",
        "var a = [1, 2, 3]; Object.defineProperty(a, '1', { configurable: false }); var out = 'none'; try { Object.defineProperty(a, 'length', { value: 0, writable: false }); } catch (e) { out = String(e instanceof TypeError) + a.length + Object.getOwnPropertyDescriptor(a, 'length').writable; }",
      ],
      [
        "D7-shrink-writable-false",
        "var a = [1, 2, 3]; Object.defineProperty(a, 'length', { value: 1, writable: false }); var d = Object.getOwnPropertyDescriptor(a, 'length'); var out = String(a.length) + d.writable + String(a[1]);",
      ],
      [
        "D8-define-length-configurable",
        "var a = []; var out = 'none'; try { Object.defineProperty(a, 'length', { configurable: true }); } catch (e) { out = String(e instanceof TypeError); }",
      ],
      [
        "E1-nw-index-sloppy",
        "var a = [1]; Object.defineProperty(a, 'length', { writable: false }); a[5] = 1; var out = String(a.length) + String(a.hasOwnProperty('5'));",
      ],
      [
        "E2-nw-index-strict",
        "function f() { 'use strict'; var a = [1]; Object.defineProperty(a, 'length', { writable: false }); try { a[5] = 1; return 'no'; } catch (e) { return String(e instanceof TypeError) + a.length; } } var out = f();",
      ],
      [
        "E4-nw-len-sloppy",
        "var a = [1, 2]; Object.defineProperty(a, 'length', { writable: false }); a.length = 0; var out = String(a.length);",
      ],
      [
        "E5-nw-len-strict",
        "function f() { 'use strict'; var a = [1, 2]; Object.defineProperty(a, 'length', { writable: false }); try { a.length = 5; return 'no'; } catch (e) { return String(e instanceof TypeError) + a.length; } } var out = f();",
      ],
      [
        "E6-nw-define-index",
        "var a = [1]; Object.defineProperty(a, 'length', { writable: false }); var out = 'none'; try { Object.defineProperty(a, '3', { value: 1 }); } catch (e) { out = String(e instanceof TypeError) + a.length; }",
      ],
      [
        "E8-nw-define-other-len",
        "var a = [1]; Object.defineProperty(a, 'length', { writable: false }); var out = 'none'; try { Object.defineProperty(a, 'length', { value: 3 }); } catch (e) { out = String(e instanceof TypeError) + a.length; }",
      ],
      [
        "M5-accessor-nonconf-stops",
        "var a = [1, 2]; Object.defineProperty(a, '5', { get: function () { return 'g'; }, configurable: false }); a.length = 0; var out = String(a.length) + a[5];",
      ],
    ],
  ],
  [
    "Array.prototype",
    [
      [
        "F1-proto-index",
        "Array.prototype[1] = 'p'; var a = [0, , 2]; var out = String(a[1]) + String(a.hasOwnProperty('1'));",
      ],
      ["F2-proto-length", "var out = String(Array.prototype.length) + String(Array.isArray(Array.prototype));"],
      ["F3-proto-push-index", "Array.prototype[0] = 'z'; var a = []; var out = String(a[0]) + a.length;"],
      [
        "F6-proto-getter",
        "Object.defineProperty(Array.prototype, '1', { get: function () { return 'g'; }, configurable: true }); var a = [0, , 2]; var out = String(a[1]);",
      ],
      ["F7-proto-ctor", "var out = String(Array.prototype.constructor === Array) + String([].constructor === Array);"],
      ["F8-proto-tag", "var out = Object.prototype.toString.call(Array.prototype);"],
      [
        "L1-create-array-proto",
        "var o = Object.create(Array.prototype); o[5] = 1; var out = String(o.length) + String(o.hasOwnProperty('length'));",
      ],
      [
        "L6-array-as-descriptor",
        "var obj = {}; Array.prototype.value = 'Array'; var arrObj = [1, 2, 3]; Object.defineProperty(obj, 'property', arrObj); var out = String(obj.property);",
      ],
    ],
  ],
];

describe("#7354 A1 — arrays agree with node", () => {
  describe.each(GROUPS)("%s", (_group, programs) => {
    it.each(programs)("%s", async (_label, body) => agreesWithNode(body, true, runnerOptions(), freshRealmOut), SLOW);
  });
});
