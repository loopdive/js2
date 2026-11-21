// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 M1 — member access on the Prepared dynamic value (src/ir/program/dynamic-member-access.ts, plan slice M §8).
// Groups C-F: nullish receivers, catch bindings, Object.prototype.toString, positions. Each program computes `out` from guarded sub-checks and
// asserts node's `out` (it must return) and a wrong one (it must throw), through the strict Prepared entry
// (tests/helpers/prepared-node-agreement.ts). A sub-check whose receiver may be nullish runs in a `catch` that does
// not read its binding: such a catch catches the synthesized TypeError (one exception tag).
import { afterEach, describe, it, vi } from "vitest";
import { agreesWithNode } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const PROGRAMS: readonly (readonly [string, string])[] = [
  [
    "C28-30: nullish reads and writes throw, catchably; the value before PutValue",
    `function f(v){ return v.a; }
function u(v){ v.a; }
function g(s){ s.n = 1; return 1; }
function w(v, s){ v.x = g(s); }
var out = "";
try { f(undefined); out = out + "n"; } catch (e) { out = out + "T"; }
try { f(null); out = out + "n"; } catch (e) { out = out + "T"; }
try { u(null); out = out + "n"; } catch (e) { out = out + "T"; }
var s = {n:0};
try { w(null, s); out = out + "n"; } catch (e) { out = out + "T" + String(s.n); }`,
  ],
  [
    "D34: a rethrow keeps identity",
    `function f(o){ try { throw o; } catch (e) { throw e; } }
function g(o){ try { f(o); } catch (e) { return e === o; } return false; }
var o = {};
var out = g(o) ? "yes" : "no";`,
  ],
  [
    "D35: assert.js's isNegativeZero, isPrimitive, formatIdentityFreeValue verbatim",
    `function isNegativeZero(value) {
  return value === 0 && 1 / value === -Infinity;
}

function isPrimitive(value) {
  return !value || (typeof value !== 'object' && typeof value !== 'function');
}

function formatIdentityFreeValue(value) {
  switch (value === null ? 'null' : typeof value) {
    case 'string':
      return typeof JSON !== "undefined" ? JSON.stringify(value) : '"' + value + '"';
    case 'bigint':
      return String(value) + "n";
    case 'number':
      if (isNegativeZero(value)) return '-0';
      // falls through
    case 'boolean':
    case 'undefined':
    case 'null':
      return String(value);
  }
}
var out = String(formatIdentityFreeValue(1)) + String(formatIdentityFreeValue("s")) + String(formatIdentityFreeValue(null)) +
  String(formatIdentityFreeValue(-0)) + String(formatIdentityFreeValue({})) + String(isPrimitive({})) + String(isPrimitive(1)) +
  String(isNegativeZero(-0));`,
  ],
  [
    "E37, C1: Object.prototype.toString.call of each kind, String(v) beside a primitive member read",
    `function f(v){ return Object.prototype.toString.call(v); }
function nm(v){ return v.name; }
var out = f(1) + f(true) + f("s") + f(undefined) + f(null) + f({}) + String(1) + String(nm(1));`,
  ],
  [
    "F40: a member read in a loop condition",
    `var o = {n:3}; var c = 0; while (o.n > c) c++;
var out = String(c);`,
  ],
  [
    "F42-43: conditional and logical positions, repeated vars in sibling blocks and loops",
    `function t(v){ return String(v.a ? 1 : 2) + "," + String(v.a || 3) + "," + String(v.a && v.b); }
function c(v){ if (v.a) return "y"; return "n"; }
var out = t({a:1,b:2}) + ";" + t({}) + ";" + t(1) + ";" + c({a:true}) + c({a:0}) + c(true);
{ var o = {m:1}; o.m = 2; } { var o = {m:3}; o.w = 4; }
out = out + "," + String(o.m) + String(o.w);
for (var i = 0; i < 2; i++) { o.m = i; } for (var i = 0; i < 3; i++) { o.w = i; }
out = out + String(o.m) + String(o.w);`,
  ],
];

describe("#7354 M1 — nullish receivers, catches, tags and positions", () => {
  it.each(PROGRAMS)("%s", async (_name, body) => agreesWithNode(body), 300_000);
});
