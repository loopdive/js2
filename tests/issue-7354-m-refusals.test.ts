// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 M1 — what member access on the Prepared dynamic value refuses by name (plan slice M §10), and the
// synthesized TypeError with no catch to read it (§8 C).
//
// The TypeError the legalization raises itself (a nullish member read or write, a strict write to a primitive, an
// object whose `toString` is not callable) is the realm's error, thrown under the one exception tag. (M2) A catch that
// reads it reads the error kind of the dynamic value (tests/issue-7354-m-catch-and-tags.test.ts); without a catch it
// ends the program as node's uncaught TypeError does (below). (#7354 C2, C2-D1) An access refuses at compile time only
// where no kind the receiver may hold can answer it; beside a kind that answers, a kind the realm cannot answer for (a
// write to the realm's error, a read of a key only a built-in prototype holds) is the run-time abort.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBJECT_PROTOTYPE_KEYS } from "../src/ir/program/builtin-prototype-keys.js";
import { abortsAtRunTime, agreesWithNode, gapText, refusal, throwsAsNode } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

/** The one form of a member-access refusal: the access, the receiver, and what the realm lacks to answer it. */
const refused = (operation: string, receiver: string, missing: string) =>
  gapText(`${operation} of ${receiver} needs ${missing}`);

describe("#7354 M1 — the TypeError the legalization raises", () => {
  // (#7354 G1) V8 gives an error an own `stack`; the realm answers the specification (none), so the read refuses by
  // name and its function is the run-time abort rather than answer either.
  it(
    "ends M2: an error's stack at the run-time abort",
    () => abortsAtRunTime("function f(v){ try { return v.a; } catch (e) { return e.stack; } } f(null);"),
    180_000,
  );

  // (#7354 G1) These ended at the abort (C2) while the caught error was its own kind: it is an ordinary object now.
  it.each([
    [
      "M2: an error's constructor",
      "function f(v){ try { return v.a; } catch (e) { return e.constructor === TypeError; } } var out = String(f(null));",
    ],
    [
      "M2: an error's toString",
      "function f(v){ try { return v.a; } catch (e) { return e.toString === Error.prototype.toString; } } var out = String(f(null));",
    ],
    [
      "M2: a write to a caught error",
      "function f(v){ try { return v.a; } catch (e) { e.k = 1; return e.k; } } var out = String(f(null));",
    ],
  ])("answers %s as node does", (_label, body) => agreesWithNode(body), 180_000);

  // The kinds that answer still answer where the error arm aborts.
  it(
    "M2: a strict write whose receiver may be a caught error throws node's TypeError for a number",
    () =>
      agreesWithNode(
        '"use strict"; function f(v){ try { v.k = 1; } catch (e) { return e.name; } return "none"; } var out = ""; out = out + f(1); out = out + f({});',
      ),
    180_000,
  );

  // No catch anywhere: the TypeError is thrown and ends the program, as in node.
  it.each([
    ["C28: a read of undefined", "function f(v){ return v.a; } f(undefined);"],
    ["B26: a strict write to a number", '"use strict"; function f(v){ v.k = 1; } f(1);'],
    [
      "C30: the value is evaluated before PutValue throws (a finally, no catch)",
      "var n = {c:0}; function g(){ n.c = 1; return 1; } function f(v){ v.x = g(); }" +
        " function h(){ try { f(null); } finally { if (n.c !== 1) throw 7; } } h();",
    ],
  ])("throws for %s", async (_label, source) => throwsAsNode(source), 180_000);
});

describe("#7354 M1 — keys a built-in prototype holds", () => {
  // C3: the catalog's Object.prototype keys are the one list. (#7354 C2) Off an object, a data key is found on the
  // object's own or source-built chain, else it is Object.prototype's, which the realm lacks: the abort. The accessor
  // `__proto__` is the only key no object can answer, so it still refuses at compile time.
  const DATA_KEYS = [...OBJECT_PROTOTYPE_KEYS].filter((key) => key !== "__proto__");
  it.each(DATA_KEYS)(
    "ends a read of Object.prototype's %s off an object at the run-time abort",
    (key) => abortsAtRunTime(`function g(){ var o = {a:1}; return o.${key}; } g();`),
    180_000,
  );
  it(
    "reads an own property of a key Object.prototype holds",
    () =>
      agreesWithNode(
        "function g(o){ o.toString = 2; o.constructor = 3; return o.toString + o.constructor; } var out = String(g({}));",
      ),
    180_000,
  );
  it.each([
    [
      "A17: a write of __proto__ to an object",
      "function g(){ var o = {a:1}; o.__proto__ = null; } g();",
      refused("member write '__proto__'", "an object", "Object.prototype's accessor"),
    ],
    [
      "a read of __proto__ off an object",
      "function g(){ var o = {a:1}; return o.__proto__; } g();",
      refused("member read '__proto__'", "an object", "Object.prototype's accessor"),
    ],
  ])("refuses %s", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(reason);
  });

  // (#7354 C2) Each refused at compile time before: a parameter may also be `undefined` or `null`, whose arm answers
  // (the TypeError), so the kind that cannot answer is the abort. (#7354 F1, D4) A write of Object.prototype's
  // writable data key `toString` creates an own property (tests/issue-7354-f1-function-kind.test.ts).
  it.each([
    ["B23: a string's length", "function f(v){ return v.length; } f('abc');"],
    ["B23: a string's index key", "function f(v){ return v['0']; } f('abc');"],
    ["B24: Number.prototype.toFixed", "function f(v){ return v.toFixed; } f(1);"],
    ["B24: String.prototype.charAt", "function f(v){ return v.charAt; } f('a');"],
    ["B24: Object.prototype.valueOf", "function f(v){ return v.valueOf; } f(true);"],
    // C6: the `__proto__` accessor's setter answers for a primitive receiver even in strict code.
    ["C6: a sloppy __proto__ write", "function f(v){ v.__proto__ = 2; } f(1);"],
    ["C6: a strict __proto__ write", '"use strict"; function f(v){ v.__proto__ = 2; } f(1);'],
  ])("ends %s at the run-time abort", (_label, source) => abortsAtRunTime(source), 180_000);

  // The kinds that answer still answer beside an aborting one.
  it(
    "answers a nullish receiver's TypeError where its string arm would abort",
    () =>
      agreesWithNode(
        "function f(v){ try { return v.length; } catch (e) { return 'T'; } } var out = ''; out = out + f(undefined); out = out + f(null);",
      ),
    180_000,
  );
});

describe("#7354 M1 — refusals that stay", () => {
  it.each([
    // C5: from-ast lowers a computed key as ToNumber, wrong for a string key; no arm may legalize it silently.
    [
      "C5: a computed read",
      "function f(o, k){ return o[k]; } f({a:1}, 'a');",
      gapText("dyn.member_get with a computed key"),
    ],
    [
      "C5: a computed write",
      "function f(o, k){ o[k] = 1; } f({a:1}, 'a');",
      gapText("dyn.member_set with a computed key"),
    ],
    ["C5: a number key", "function f(v){ return v[0]; } f('abc');", gapText("dyn.member_get with a computed key")],
    [
      "E38: Object.prototype.toString of an object in a program that names Symbol",
      "function f(v){ return Object.prototype.toString.call(v); } var s = typeof Symbol; f({});",
      gapText("Object.prototype.toString of an object in a program that names 'Symbol'"),
    ],
    // (#7354 F2) A method call is a Get and a call through its value; without a function value it is always the
    // TypeError (tests/issue-7354-f2-calls-through-values).
    [
      "G45: a method call",
      "function f(v){ return v.m(); } f({});",
      gapText("js.closure.call:0 in a program that creates no function value"),
    ],
    // (#7354 M1) This threw out of compile() ("internal capability violation"): the Prepared path has no selector.
    ["G45: v.a += 1", "function f(v){ v.a += 1; } f({a:1});", "binary operator '+=' is capability-deferred in f"],
    [
      "G45: v.a++",
      "function f(v){ v.a++; } f({a:1});",
      "ir/from-ast: unsupported expression kind PostfixUnaryExpression in f",
    ],
    ["G45: delete", "function f(v){ return delete v.a; } f({a:1});", "ir/from-ast: delete has no IR lowering in f"],
    ["G45: in", "function f(v){ return 'a' in v; } f({a:1});", gapText("__extern_has")],
    [
      "G45: for-in",
      "function f(v){ for (var k in v) {} } f({a:1});",
      "ir/from-ast: unsupported tail statement ForInStatement in f",
    ],
    // (#7354 O1) Object.defineProperty and its three siblings run (tests/issue-7354-o1-*); a static the catalog does
    // not mark native stays refused.
    [
      "G45: an Object static that is not native",
      "var o = {}; Object.freeze(o);",
      'ir/from-ast: identifier "Object" is not in scope in <module-init>',
    ],
    [
      "F41: a switch over a member",
      "function sw(v){ switch (v.k) { case 1: return 1; } return 0; } sw({k:1});",
      "ir/from-ast: switch disc must lower to i32/f64 in sw",
    ],
    [
      "F44: a return inside try",
      "function fin(v){ try { return 1; } finally { v.z; } } fin({z:1});",
      "ir/from-ast: early return inside try/for-of-iter not in IR scope (fin)",
    ],
  ])("refuses %s", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(reason);
  });
});
