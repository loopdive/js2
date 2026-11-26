// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 M2 — finding 1 of the M1 review: one object literal anywhere admits the object kind for every untyped value,
// so every ToString / ToNumber of one gets an object arm whose OrdinaryToPrimitive may raise a TypeError; under M1 a
// program that also read a catch binding refused ("… in a program that reads a caught value") where main answered.
// With the error kind that TypeError is a value, and these programs answer as node does.
import { afterEach, describe, it, vi } from "vitest";
import { agreesWithNode } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const PROGRAMS: readonly (readonly [string, string])[] = [
  [
    "the review's program: ToNumber beside an object literal and a catch",
    "function g(){ var o = {a:1}; return o.a; } function f(v){ return +v; } var out = String(f(3)+g()); try{throw 2}catch(e){out += typeof e}",
  ],
  [
    "the review's program with String(v)",
    "function g(){ var o = {a:1}; return o.a; } function f(v){ return String(v); } var out = f(3)+String(g()); try{throw 2}catch(e){out += typeof e}",
  ],
  [
    'six variants: "" + v, v + 1, typeof v, !v, v === 3, String(v) of a caught value',
    `function g(){ var o = {a:1}; return o.a; }
function a(v){ return "" + v; }
function b(v){ return String(v + 1); }
function c(v){ return typeof v; }
function d(v){ return !v ? "t" : "f"; }
function e(v){ return v === 3 ? "t" : "f"; }
var out = a(3) + b(3) + c(3) + d(3) + e(3) + String(g());
try { throw "s"; } catch (x) { out += String(x) + a(x) + c(x); }`,
  ],
];

describe("#7354 M2 — conversions beside an object literal in a program that reads a caught value", () => {
  it.each(PROGRAMS)("%s", async (_name, body) => agreesWithNode(body), 300_000);
});
