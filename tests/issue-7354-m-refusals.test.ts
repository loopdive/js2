// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 M1 — what member access on the Prepared dynamic value refuses by name (plan slice M §10), and the
// synthesized TypeError with no catch to read it (§8 C).
//
// The TypeError rule of M1: the legalization raises a TypeError itself for a nullish member read or write, a strict
// write to a primitive, and an object whose `toString` is not callable. In a program that READS a catch binding
// (anything but a rethrow of it), that read could see the error, which no carrier kind holds before M2, so the program
// refuses by name at compile time. In any other program the TypeError is thrown under the one exception tag: a catch
// that only binds or rethrows it catches it (tests/issue-7354-m-catch-and-tags.test.ts), and without a catch it ends
// the program, as node's uncaught TypeError does (below).
import { afterEach, describe, expect, it, vi } from "vitest";
import { OBJECT_PROTOTYPE_KEYS } from "../src/ir/program/builtin-prototype-keys.js";
import { gapText, refusal, throwsAsNode } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const readCaught = (message: string) => gapText(`TypeError "${message}" in a program that reads a caught value`);

describe("#7354 M1 — the TypeError rule", () => {
  it.each([
    [
      "C31: a nullish read whose catch reads the error",
      "function f(v){ try { return v.a; } catch (e) { return typeof e; } } f(undefined);",
      readCaught("Cannot read properties of undefined (reading 'a')"),
    ],
    [
      "D32: a thrown object's member read in its catch",
      "function f(v){ try { throw v; } catch (err) { return err.name; } } f({name:'N'});",
      readCaught("Cannot read properties of undefined (reading 'name')"),
    ],
    [
      "D33: a thrown number's member read in its catch",
      "function f(){ try { throw 1; } catch (err) { return err.name; } } f();",
      readCaught("Cannot read properties of undefined (reading 'name')"),
    ],
    [
      "D35: assert.js's formatSimpleValue (its catch reads err.name)",
      "function formatSimpleValue(value) {\n  try {\n    return String(value);\n  } catch (err) {\n" +
        "    if (err.name === 'TypeError') {\n      return Object.prototype.toString.call(value);\n    }\n" +
        "    throw err;\n  }\n}\nformatSimpleValue(1);",
      readCaught("Cannot read properties of undefined (reading 'name')"),
    ],
    [
      "a strict write to a primitive whose catch reads the error",
      '"use strict"; function f(v){ try { v.k = 1; } catch (e) { return e; } } f(1);',
      readCaught("Cannot create property 'k' on string"),
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
      gapText(`member read '${key}' needs Object.prototype's properties`),
    );
  });

  it.each([
    [
      "A17: a write of toString",
      "var o = {a:1}; function f(v){ v.toString = 1; } f(o);",
      "member write 'toString' needs Object.prototype's properties",
    ],
    [
      "B23: a string's length",
      "function f(v){ return v.length; } f('abc');",
      "member read 'length' of a string needs its wrapper prototype",
    ],
    [
      "B23: a string's index key",
      "function f(v){ return v['0']; } f('abc');",
      "member read '0' of a string needs its wrapper prototype",
    ],
    [
      "B24: Number.prototype.toFixed",
      "function f(v){ return v.toFixed; } f(1);",
      "member read 'toFixed' of a number needs its wrapper prototype",
    ],
    [
      "B24: String.prototype.charAt",
      "function f(v){ return v.charAt; } f('a');",
      "member read 'charAt' of a string needs its wrapper prototype",
    ],
    // C6: the `__proto__` accessor's setter answers for a primitive receiver even in strict code.
    [
      "C6: a sloppy __proto__ write",
      "function f(v){ v.__proto__ = 2; } f(1);",
      "member write '__proto__' of a string needs Object.prototype's accessor",
    ],
    [
      "C6: a strict __proto__ write",
      '"use strict"; function f(v){ v.__proto__ = 2; } f(1);',
      "member write '__proto__' of a string needs Object.prototype's accessor",
    ],
  ])("refuses %s", async (_label, source, operation) => {
    expect(await refusal(source)).toContain(gapText(operation));
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
