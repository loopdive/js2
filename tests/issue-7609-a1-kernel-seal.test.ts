// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7609 A1 (review r1) — the seal of the global object lives in the realm kernel: the object is identity-only, so the
// kernel's own-property find and own-key list abort for it wherever a kernel routine reads an object passed as data —
// a property descriptor (ToPropertyDescriptor), a descriptor map's entry, a prototype a read walks into, an error
// message's conversion. Each abort has a twin on an ordinary object that answers node's value; answers that do not
// read the global object's properties (its prototype chain, its callability) agree with node.
import { runInNewContext } from "node:vm";
import { afterEach, describe, it, vi } from "vitest";
import { abortsAtRunTime, agreesWithNode, freshRealmOut, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;
const LIVE_FUNCTIONS = "var lf = function(){ return 1; }; lf();";
const agrees = (body: string) => agreesWithNode(body, true, runnerOptions(), freshRealmOut);

describe("#7609 A1 — the global object passed to the realm kernel as data", () => {
  it(
    "twin: ordinary descriptor objects define their property",
    () =>
      agrees(
        `${LIVE_FUNCTIONS} var d = {value: 5}; var o = {}; Object.defineProperty(o, 'k', d); var q = {};` +
          " Object.defineProperties(q, {k: d}); var r = Object.create({}, {k: d}); var out = String(o.k) + String(q.k) + String(r.k);",
      ),
    SLOW,
  );

  it(
    "agrees where the answer reads none of its properties: instanceof, isPrototypeOf, a getter slot, a prototype link",
    () =>
      agrees(
        `${LIVE_FUNCTIONS} function F(){} var p = {}; var g = this; var o = {}; o.valueOf = function(){ return g; };` +
          " var out = String(this instanceof F) + String(p.isPrototypeOf(this)) + (o + 1);" +
          " try { Object.defineProperty({}, 'k', {get: this}); } catch (e) { out = out + (e instanceof TypeError ? 'T' : 'n'); }" +
          " F.prototype = this; var n = new F(); out = out + typeof n; var c = Object.create(this); out = out + typeof c;",
      ),
    SLOW,
  );

  it.each([
    [
      "a descriptor: Object.defineProperty(o, k, this)",
      "var value = 5; var o = {}; Object.defineProperty(o, 'k', this);",
    ],
    [
      "a descriptor with a script `get`",
      "function get(){ return 7; } var o = {}; Object.defineProperty(o, 'k', this);",
    ],
    [
      "a descriptor map's entry: Object.defineProperties(o, {k: this})",
      "var value = 5; var o = {}; Object.defineProperties(o, {k: this});",
    ],
    [
      "Object.create's descriptor: Object.create({}, {k: this})",
      "var value = 5; var o = Object.create({}, {k: this});",
    ],
    ["a descriptor map: Object.defineProperties(o, this)", "var o = {}; Object.defineProperties(o, this);"],
    [
      "a read through a constructed object whose prototype it is",
      "function F(){} F.prototype = this; var v = new F().x;",
    ],
  ])(
    "ends %s at the run-time abort",
    (_label, source) =>
      abortsAtRunTime(`${LIVE_FUNCTIONS} ${source}`, runnerOptions(), undefined, (body) => runInNewContext(body, {})),
    SLOW,
  );
});
