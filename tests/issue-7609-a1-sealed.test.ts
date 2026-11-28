// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7609 A1 — the global object is sealed on the strict Prepared entry: each route by which a program could read,
// write, convert or enumerate its properties ends at the run-time abort (the realm kernel's own-property find),
// never in a value. The twin shows every route answers node's
// value on an ordinary object (and with a wrong answer throws), so the abort is the global object's alone.
import { runInNewContext } from "node:vm";
import { afterEach, describe, it, vi } from "vitest";
import { abortsAtRunTime, agreesWithNode, freshRealmOut, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;
const LIVE_FUNCTIONS = "var f = function(){ return 1; }; f();";

describe("#7609 A1 — the sealed global object", () => {
  it(
    "twin: every route answers on an ordinary object",
    () =>
      agreesWithNode(
        `function rd(o){ return o.x; } function cat(a){ return a + ''; } var p = {x: 1}; ${LIVE_FUNCTIONS}` +
          " var out = String(p.x); p.y = 2; out = out + String(p['y']); var n = 0; for (var k in p) n++; out = out + String(n);" +
          " Object.defineProperty(p, 'z', {value: 3}); out = out + String(p.z) + String(p.hasOwnProperty('x'));" +
          " var g = p; out = out + String(g.x); var c = function(){ return g.x; }; out = out + String(c()); var o = {k: p};" +
          " out = out + String(o.k.x) + String(rd(p)) + cat(p) + Object.prototype.toString.call(p); var q = Object.create(p);" +
          " out = out + String(q.x) + String(p.isPrototypeOf(q));",
        true,
        runnerOptions(),
        freshRealmOut,
      ),
    SLOW,
  );

  it.each([
    ["a read through a declaration's parameter", "function rd(o){ return o.x; } var v = rd(this);"],
    ["a read through an object literal's field", "var o = {k: this}; var v = o.k.x;"],
    ["a concatenation through a parameter (ToPrimitive)", "function cat(a){ return a + ''; } var v = cat(this);"],
    ["Object.defineProperty on it", "var o = {}; Object.defineProperty(this, 'a1Probe', {value: 1});"],
    ["its hasOwnProperty", `${LIVE_FUNCTIONS} var v = this.hasOwnProperty('x');`],
    ["a read through an object whose prototype it is", "var o = Object.create(this); var v = o.x;"],
    ["an error message's conversion", "var e = new Error(this);"],
    ["Object.prototype.toString of it (its tag is the host's)", "var v = Object.prototype.toString.call(this);"],
  ])(
    "ends %s at the run-time abort",
    (_label, source) => abortsAtRunTime(source, runnerOptions(), (body) => runInNewContext(body, {})),
    SLOW,
  );
});
