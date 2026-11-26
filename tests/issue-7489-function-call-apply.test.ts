// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7489 slice B — `Function.prototype.call` and `apply` on the Prepared path. The realm holds both on its
// Function.prototype; `f.call(…)` / `f.apply(…)` whose callee is the realm's own method is the dispatcher's call of `f`
// with the given receiver (P1's shape, `dynamic-prototype-methods.ts`). `apply` checks IsCallable first; a primitive
// `argArray` is CreateListFromArrayLike's TypeError, an object one the run-time abort (array-likes are arrays' slice).
// A sloppy callee given `undefined` or a primitive as `this` aborts (C2-D3: no global object or wrappers).
import { afterEach, describe, it, vi } from "vitest";
import { abortsAtRunTime, agreesWithNode, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 300_000;
const caught = (expression: string) =>
  `(function () { try { ${expression}; return "none"; } catch (e) { return e instanceof TypeError ? "TE" : "other"; } })()`;

describe("#7489 B — call and apply agree with node", () => {
  it.each([
    [
      "call and apply bind this and pass arguments",
      `var o = { v: 7 };
function f(a, b) { return this.v + (a === undefined ? 0 : a) + (b === undefined ? 0 : b); }
var out = "" + f.call(o) + "," + f.call(o, 1, 2) + "," + f.apply(o) + "," + f.apply(o, null) + "," + f.apply(o, undefined);`,
    ],
    [
      "a strict callee sees an absent thisArg as undefined",
      `function s() { "use strict"; return this === undefined; }
var out = String(s.call()) + String(s.apply());`,
    ],
    ["a primitive argArray is a TypeError", `function f() {} var out = ${caught("f.apply({}, 1)")};`],
    [
      "apply on a non-callable receiver is a TypeError before argArray is read",
      `function f() {}
var o = {};
o.apply = f.apply;
var out = ${caught("o.apply({}, {})")};`,
    ],
    [
      "an own call property is called, not the realm's method",
      `function f() { return 3; }
f.call = function () { return 9; };
var out = String(f.call());`,
    ],
    [
      "a primitive's chain does not reach Function.prototype",
      `function id(x) { return x; }
var n = id(5), s = id("s"), b = id(true);
var out = String(n.call) + String(s.apply) + String(b.call);`,
    ],
  ])("%s", (_label, body) => agreesWithNode(body, true, runnerOptions()), SLOW);
});

describe("#7489 B — the run-time abort, never a wrong value", () => {
  it.each([
    ["a sloppy callee given undefined as this", "function f() { return this.v; } var x = f.call(undefined);"],
    ["a sloppy callee given a primitive as this", "function f() { return this.v; } var x = f.call(1);"],
    ["an object argArray (array-likes)", "function f() { return 1; } var a = {}; var x = f.apply({}, a);"],
    [
      "an object whose chain holds a function reads a key the realm lacks",
      "function g() {} function F() {} F.prototype = g; var o = new F(); var x = o.bind;",
    ],
  ])("ends %s at the abort", (_label, source) => abortsAtRunTime(source, runnerOptions()), SLOW);
});
