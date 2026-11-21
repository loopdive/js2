// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 M1 — what member access on the Prepared dynamic value refuses by name (plan slice M §10), and the
// synthesized TypeError with no catch to read it (§8 C).
//
// The TypeError the legalization raises itself (a nullish member read or write, a strict write to a primitive, an
// object whose `toString` is not callable) is the realm's error, thrown under the one exception tag. (M2) A catch that
// reads it reads the error kind of the dynamic value (tests/issue-7354-m-catch-and-tags.test.ts); without a catch it
// ends the program as node's uncaught TypeError does (below). What a program that reads a caught value still refuses:
// a member write whose receiver may be that error, and reads of an error's Error.prototype keys.
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBJECT_PROTOTYPE_KEYS } from "../src/ir/program/builtin-prototype-keys.js";
import { gapText, refusal, throwsAsNode } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

/** The one form of a member-access refusal: the access, the receiver, and what the realm lacks to answer it. */
const refused = (operation: string, receiver: string, missing: string) =>
  gapText(`${operation} of ${receiver} needs ${missing}`);
const mayBe = (kinds: string) => `a value that may be ${kinds}`;
const WRAPPERS = "String.prototype's properties and Number.prototype's properties and Boolean.prototype's properties";

describe("#7354 M1 — the TypeError the legalization raises", () => {
  it.each([
    [
      "M2: a write whose receiver may be a caught error",
      '"use strict"; function f(v){ try { v.k = 1; } catch (e) { return e; } } f(1);',
      refused("member write 'k'", mayBe("an Error"), "property storage on the realm's error"),
    ],
    [
      "M2: an error's constructor",
      "function f(v){ try { return v.a; } catch (e) { return e.constructor; } } f(null);",
      refused(
        "member read 'constructor'",
        mayBe("a string or a number or a boolean or an Error"),
        `${WRAPPERS} and Error.prototype's properties`,
      ),
    ],
    [
      // V8 gives an error an own `stack`; the realm's error has none, so the read refuses rather than answer undefined.
      "M2: an error's stack",
      "function f(v){ try { return v.a; } catch (e) { return e.stack; } } f(null);",
      refused("member read 'stack'", mayBe("an Error"), "Error.prototype's properties"),
    ],
    [
      "M2: an error's toString",
      "function f(v){ try { return v.a; } catch (e) { return e.toString; } } f(null);",
      refused(
        "member read 'toString'",
        mayBe("a string or a number or a boolean or an Error"),
        `${WRAPPERS} and Error.prototype's properties`,
      ),
    ],
  ])("refuses %s", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(reason);
  });

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
  // C3: the catalog's Object.prototype keys are the one list; each refuses on an object receiver.
  it.each([...OBJECT_PROTOTYPE_KEYS])("refuses a read of Object.prototype's %s off an object", async (key) => {
    expect(await refusal(`function g(){ var o = {a:1}; return o.${key}; } g();`)).toContain(
      refused(`member read '${key}'`, "an object", "Object.prototype's properties"),
    );
  });

  // A receiver of one known kind names it; one that may hold several kinds names those whose arm refuses (finding 5 of
  // the M1 review: `{a:1}.constructor` once refused "of a string").
  const prim = "a string or a number or a boolean";
  it.each([
    [
      "A17: a write of __proto__ to an object",
      "function g(){ var o = {a:1}; o.__proto__ = null; } g();",
      refused("member write '__proto__'", "an object", "Object.prototype's properties"),
    ],
    [
      "A17: a write of toString to a value that may be an object",
      "var o = {a:1}; function f(v){ v.toString = 1; } f(o);",
      refused("member write 'toString'", mayBe("an object"), "Object.prototype's properties"),
    ],
    [
      "B23: a string's length",
      "function f(v){ return v.length; } f('abc');",
      refused("member read 'length'", mayBe("a string"), "its own length and index properties"),
    ],
    [
      "B23: a string's index key",
      "function f(v){ return v['0']; } f('abc');",
      refused("member read '0'", mayBe("a string"), "its own length and index properties"),
    ],
    [
      "B24: Number.prototype.toFixed",
      "function f(v){ return v.toFixed; } f(1);",
      refused("member read 'toFixed'", mayBe("a number"), "Number.prototype's properties"),
    ],
    [
      "B24: String.prototype.charAt",
      "function f(v){ return v.charAt; } f('a');",
      refused("member read 'charAt'", mayBe("a string"), "String.prototype's properties"),
    ],
    [
      "B24: Object.prototype.valueOf",
      "function f(v){ return v.valueOf; } f(true);",
      refused("member read 'valueOf'", mayBe(prim), WRAPPERS),
    ],
    // C6: the `__proto__` accessor's setter answers for a primitive receiver even in strict code.
    [
      "C6: a sloppy __proto__ write",
      "function f(v){ v.__proto__ = 2; } f(1);",
      refused("member write '__proto__'", mayBe(prim), "Object.prototype's accessor"),
    ],
    [
      "C6: a strict __proto__ write",
      '"use strict"; function f(v){ v.__proto__ = 2; } f(1);',
      refused("member write '__proto__'", mayBe(prim), "Object.prototype's accessor"),
    ],
  ])("refuses %s", async (_label, source, reason) => {
    expect(await refusal(source)).toContain(reason);
  });
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
    ["G45: a method call", "function f(v){ return v.m(); } f({});", gapText("__ir_dyn_method_call_0")],
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
    [
      "G45: Object.defineProperty",
      "var o = {}; Object.defineProperty(o, 'p', {value:1});",
      "module binding o has no exact typed storage: not-direct",
    ],
    [
      "G45: new TypeError",
      "function f(){ return new TypeError('m'); } f();",
      'ir/from-ast: unknown class "TypeError" in f',
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
