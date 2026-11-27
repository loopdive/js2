// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7609 A1 — `this` at script level through the strict Prepared entry: the realm's global object, in sloppy and strict
// scripts alike. Its identity, `typeof` and truthiness answer as node's; it is sealed, so a read or write of its
// properties, and its enumeration, end at the run-time abort (the script's bindings stay in their homes). Node runs
// each program as a script in a fresh realm, where `var` and `this` are the script's own; each agreement also runs
// with a wrong answer, which must throw.
import { runInNewContext } from "node:vm";
import { afterEach, describe, it, vi } from "vitest";
import { abortsAtRunTime, agreesWithNode, freshRealmOut, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;
const IDENTITY =
  "var g = this; function id(v){ return v; } function h(){ return g; } var o = { k: this };" +
  " var f = function(){ return g; }; var out = typeof this + (this === this ? 'a' : '-') + (g === this ? 'b' : '-')" +
  " + (id(this) === g ? 'c' : '-') + (o.k === this ? 'd' : '-') + (f() === this ? 'e' : '-') + (h() === this ? 'f' : '-')" +
  " + (this !== undefined ? 'g' : '-') + (this !== null ? 'h' : '-') + (!this ? '-' : 'i') + (this === o ? '-' : 'j')" +
  " + String(typeof g) + (typeof this === 'object' ? 'l' : '-') + (typeof this === 'function' ? '-' : 'm');";

describe("#7609 A1 — script-level this is the global object", () => {
  it.each([
    ["a sloppy script", IDENTITY],
    ["a strict script", `'use strict'; ${IDENTITY}`],
  ])(
    "%s: identity (also through a var, a parameter, a result, an object field and a closure), typeof, truthiness",
    (_label, body) => agreesWithNode(body, true, runnerOptions(), freshRealmOut),
    SLOW,
  );

  it(
    "leaves `this` in a method, a constructor, a nested closure and strict code without a receiver as it was",
    () =>
      agreesWithNode(
        "var g = this; var o = {k: 1}; o.m = function(){ return this.k; }; function F(){ this.k = 2; }" +
          " o.n = function(){ var self = this; var f = function(){ return self.k; }; return f(); };" +
          " o.same = function(v){ return v === g; }; var s = function(){ 'use strict'; return this; };" +
          " var out = String(o.m()) + String(new F().k) + String(o.n()) + (o.same(this) ? 'y' : 'n') + (s() === undefined ? 'u' : 'x');",
        true,
        runnerOptions(),
        freshRealmOut,
      ),
    SLOW,
  );

  it.each([
    ["a write through this", "var o = {}; this.a1Probe = 1;"],
    ["a read through a var holding it", "var o = {}; var g = this; var v = g.x;"],
    ["a read through a closure's capture", "var g = this; var f = function(){ return g.x; }; var v = f();"],
    ["a for-in over it", "var o = {}; var n = 0; for (var k in this) n++;"],
  ])(
    "ends %s at the run-time abort",
    (_label, source) => abortsAtRunTime(source, runnerOptions(), (body) => runInNewContext(body, {})),
    SLOW,
  );
});
