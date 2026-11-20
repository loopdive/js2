// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 M2 — the realm's TypeError is a kind of the Prepared dynamic value (`error` in
// src/ir/program/dynamic-value-kinds.ts), admitted in a program that reads a catch binding. A TypeError the
// legalization raises (a nullish member access, a strict write to a primitive, an object whose `toString` is not
// callable) is caught as an ordinary value: `typeof`, `name`, `message`, an absent key, ToString
// (Error.prototype.toString), ToNumber, ToBoolean and identity answer as in node. Each program asserts node's `out`
// and a wrong one (tests/helpers/prepared-node-agreement.ts).
import { afterEach, describe, it, vi } from "vitest";
import { agreesWithNode } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const PROGRAMS: readonly (readonly [string, string])[] = [
  [
    "C31, D36: typeof, name, message, ToString and an absent key of a caught TypeError",
    `function f(v){ try { return v.a; } catch (err) {
  return typeof err + "|" + String(err.name) + "|" + String(err.message) + "|" + String(err) + "|" + String(err.foo);
} }
var out = String(f(undefined)) + ";" + String(f(null));`,
  ],
  [
    "ToNumber, identity, ToBoolean and + of a caught TypeError; a ToPrimitive TypeError caught",
    `function n(v){ try { return v.a; } catch (err) {
  var x = +err; return (x !== x ? "nan" : "num") + (err === err ? "=" : "!") + (err ? "t" : "f") + ("" + err);
} }
function g(v){ return "" + v; }
function p(){ try { return g({toString: 1}); } catch (err) { return String(err); } }
var out = String(n(null)) + ";" + String(p());`,
  ],
  [
    "D32, D33: a caught number's and a caught object's member reads",
    `function f(){ try { throw 1; } catch (err) { return String(err.name); } }
function g(v){ try { throw v; } catch (err) { return String(err.name); } }
var out = f() + "," + g({name: "N"}) + "," + g(true);`,
  ],
  [
    "D35: assert.js's formatSimpleValue verbatim",
    `function formatSimpleValue(value) {
  try {
    return String(value);
  } catch (err) {
    if (err.name === 'TypeError') {
      return Object.prototype.toString.call(value);
    }
    throw err;
  }
}
var out = formatSimpleValue({toString: 1}) + formatSimpleValue({}) + formatSimpleValue(1) + formatSimpleValue(null);`,
  ],
];

describe("#7354 M2 — a caught TypeError is a value", () => {
  it.each(PROGRAMS)("%s", async (_name, body) => agreesWithNode(body), 300_000);
});
