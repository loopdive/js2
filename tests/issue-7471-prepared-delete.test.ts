// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7471 — `delete` on the Prepared whole-program path (strict entry, standalone). Slice 1: `delete <recv>.<key>` is the
// realm's OrdinaryDelete for an object or a function (`js.object.delete`, the kernel's `deleteOwn`), a TypeError in
// strict code where it answers `false`, and the wrapper's answer for a primitive. Slice 2: `delete <name>` of a binding
// a function or the script declares answers `false` unevaluated; any other operand that is no reference is evaluated
// and answers `true`. Each program runs with node's answer (returns) and a wrong one (throws).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortBodies,
  abortsAtRunTime,
  agreesWithNode,
  gapText,
  preparedOptions,
  refusal,
  runPrepared,
  runnerOptions,
} from "./helpers/prepared-node-agreement.js";
import { compile } from "../src/test262/test262-prepared-entry.js";

afterEach(() => vi.restoreAllMocks());

/** A sloppy script row, compiled as the test262 runner compiles one. */
const script = (body: string) => agreesWithNode(body, true, runnerOptions());

describe("#7471 slice 1 — delete of an object's or a function's member", () => {
  it.each([
    [
      "a configurable property, an absent key and an inherited key",
      "var proto = {q: 2}; var o = Object.create(proto); o.p = 1;" +
        ' var out = "" + (delete o.p) + "," + o.p + "," + (delete o.z) + "," + (delete o.q) + "," + o.q + "," + proto.q;',
    ],
    [
      "a non-configurable property in sloppy code",
      'var o = {}; Object.defineProperty(o, "p", {value: 1}); var out = "" + (delete o.p) + "," + o.p;',
    ],
    [
      "a non-configurable property in strict code",
      '"use strict"; var o = {}; Object.defineProperty(o, "p", {value: 1}); var out = "none";' +
        ' try { delete o.p; } catch (e) { out = e.name + "," + (e instanceof TypeError); } out = out + "," + o.p;',
    ],
    [
      "an accessor, its getter not called",
      'var n = {calls: 0}; var o = {}; Object.defineProperty(o, "p", {get: function () { n.calls = n.calls + 1; return 1; },' +
        ' configurable: true}); var out = "" + (delete o.p) + "," + n.calls + "," + o.p;',
    ],
    [
      "a nested member, its receiver evaluated once",
      "var n = {calls: 0}; var a = {b: {c: 1}}; function g() { n.calls = n.calls + 1; return a; }" +
        ' var out = "" + (delete g().b.c) + "," + n.calls + "," + a.b.c + "," + (delete a.b) + "," + a.b;',
    ],
    [
      "a function's length, name and prototype",
      'function f(x) {} var out = "" + (delete f.length) + "," + f.length + "," + (delete f.name) + ",[" + f.name + "],"' +
        ' + (delete f.prototype) + "," + typeof f.prototype;',
    ],
    [
      "a function's prototype in strict code",
      '"use strict"; function f(x) {} var out = "none"; try { delete f.prototype; } catch (e) { out = e.name; }',
    ],
    [
      "a number's, a Boolean's and a string's member, and a nullish receiver",
      'function d(v) { return delete v.x; } var out = "" + d(1) + "," + d(true) + "," + d("ab");' +
        " function e(v) { try { return delete v.p; } catch (err) { return err.name; } }" +
        " out = out + String(e(undefined)) + String(e(null));",
    ],
    [
      "in a function, its value read",
      'function f(o) { return delete o.p; } var o = {p: 1}; var out = "" + f(o) + "," + o.p + "," + f(o);',
    ],
    [
      "a function-local object's member",
      'function f() { var o = {p: 1, q: 2}; delete o.p; return "" + o.p + "," + (delete o.q) + "," + o.q; }' +
        " var out = f();",
    ],
  ])("answers %s as node does", (_label, body) => script(body), 180_000);

  // The three Object rows of the o411 sample (#7354), each a statement-form delete after an `Object` static.
  it.each([
    [
      "built-ins/Object/create/15.2.3.5-4-121",
      "var descObj = new Error(); descObj.configurable = true; var newObj = Object.create({}, {prop: descObj});" +
        ' var result1 = newObj.hasOwnProperty("prop"); delete newObj.prop; var result2 = newObj.hasOwnProperty("prop");' +
        ' var out = "" + same(result1) + "," + same(result2);',
    ],
    [
      "built-ins/Object/defineProperties/15.2.3.7-5-b-59",
      'var obj = {}; Object.defineProperties(obj, {prop: {configurable: true}}); var result1 = obj.hasOwnProperty("prop");' +
        ' delete obj.prop; var result2 = obj.hasOwnProperty("prop"); var out = "" + same(result1) + "," + same(result2);',
    ],
    [
      "built-ins/Object/defineProperty/15.2.3.6-3-124",
      'var obj = {}; Object.defineProperty(obj, "property", {configurable: "false"});' +
        ' var beforeDeleted = obj.hasOwnProperty("property"); delete obj.property;' +
        ' var afterDeleted = obj.hasOwnProperty("property"); var out = "" + same(beforeDeleted) + "," + same(afterDeleted);',
    ],
  ])(
    "answers the shape of %s as node does",
    (_label, body) => script(`var same = function (v) { return v; }; ${body}`),
    180_000,
  );

  // (PRV-7471 B1) The delete follows the Prepared code strictness, the rule `dyn.member_set` follows: with
  // `inferModuleStrictArguments: false` a module-flagged source is sloppy code, so the delete answers `false`; the
  // ordinary pipeline's rule would make it strict and throw.
  it("follows the Prepared code strictness of a source with an export", async () => {
    // `export {}` makes the source a module to TypeScript; the option decides whether that makes its code strict.
    const source =
      'export {}; function f() { var o = {}; Object.defineProperty(o, "p", {value: 1}); return delete o.p; }' +
      " if (f() !== false) throw 1;";
    expect(await runPrepared(source, { ...preparedOptions(), inferModuleStrictArguments: false })).toBe("returned");
    expect(await runPrepared(source, { ...preparedOptions(), inferModuleStrictArguments: true })).toBe("threw");
  }, 180_000);

  // A string's own `length` and indices need the String exotic the realm lacks; a receiver that may also hold
  // `undefined` answers that kind, so the string's arm is the run-time abort.
  it.each([
    ["a string's length", 'var s = "ab"; var x = delete s.length;'],
    ["a string's index", 'var s = "ab"; var x = delete s["0"];'],
  ])("ends %s at the run-time abort", (_label, source) => abortsAtRunTime(source, runnerOptions()), 180_000);

  it.each([
    [
      "a computed key",
      'var o = {}; var k = "a"; var x = delete o[k];',
      gapText("__ir_dyn_delete_sloppy with a computed key"),
    ],
    [
      "a function's caller (V8's own property)",
      "function f() {} var x = delete f.caller;",
      gapText("member delete 'caller' (V8's own function property) where a value may be a function"),
    ],
    ["`this`'s member", "var x = delete this.x;", "ir/from-ast: 'this' reference outside an instance method body"],
  ])("refuses %s by name", async (_label, source, reason) => {
    expect(await refusal(source, runnerOptions())).toContain(reason);
  });
});

describe("#7471 slice 2 — delete of a name", () => {
  it.each([
    ["a script var", 'var v = 1; var out = "" + (delete v) + "," + v;'],
    ["a script var, parenthesised", 'var v = 1; var out = "" + (delete (v)) + "," + v;'],
    ["a local", 'function f() { var w = 2; return "" + (delete w) + "," + w; } var out = f();'],
    ["a parameter", 'function f(p) { return "" + (delete p) + "," + p; } var out = f(3);'],
    ["a function's name", 'function g() { return 1; } var out = "" + (delete g) + "," + g();'],
    ["a named function expression's own name", 'var h = function k() { return delete k; }; var out = "" + h();'],
    ["a comma expression, evaluated", 'var x = 1; var out = "" + (delete (0, x)) + "," + x;'],
    ["the statement form", 'var v = 1; delete v; var out = "" + v;'],
  ])("answers %s as node does", (_label, body) => script(body), 180_000);

  // (PRV-7471 point 8) An early SyntaxError, before any lowering; the checker reports it too (code 1102).
  it("rejects a delete of a name in strict code early", async () => {
    const source = '"use strict"; var v; delete v;';
    expect(await refusal(source, runnerOptions())).toBe("Delete of an unqualified identifier in strict mode");
    const result = await compile(source, preparedOptions(), undefined, "refuse");
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.code)).toContain(1102);
  });

  // `arguments` in a non-arrow function is its own binding, so the delete answers `false`; such a function reads its
  // argument count at entry, which the Prepared path does not lower yet, so it is that run-time abort, not the delete's.
  it("answers a function's arguments, the function aborting at its argument count", async () => {
    expect(new Function("function f(a) { return delete arguments; } return f(1);")()).toBe(false);
    expect(
      await abortBodies('function f(a) { return delete arguments; } var out = "" + f(1);', runnerOptions()),
    ).toEqual(["f: dynamic operation dyn.arguments_length has no Prepared intrinsic"]);
  });

  it.each([
    [
      "an undeclared name",
      "var x = delete y;",
      'ir/from-ast: delete of "y", which names no binding this lowering resolves',
    ],
    ["NaN", "var x = delete NaN;", 'ir/from-ast: delete of "NaN", which names no binding this lowering resolves'],
    [
      "arguments at script level",
      "var x = delete arguments;",
      'delete of "arguments", which names no binding this lowering resolves',
    ],
    ["a class name", "class C {} var x = delete C;", 'delete of "C", which names no binding this lowering resolves'],
  ])("refuses %s by name", async (_label, source, reason) => {
    expect(await refusal(source, runnerOptions())).toContain(reason);
  });

  // (PRV-7471 B2) A `with` binding is an object environment's, whose [[Delete]] can answer `true` (node: `true`). The
  // Prepared path lowers no `with` today, so the function is the run-time abort before the delete arm is asked.
  it("ends a delete of a with-scope binding at its function's abort", async () => {
    expect(new Function("with ({x: 1}) { return delete x; }")()).toBe(true);
    expect(
      await abortBodies("function f() { with ({x: 1}) { return delete x; } } var out = f();", runnerOptions()),
    ).toEqual(["f: ir/from-ast: unsupported tail statement WithStatement in f"]);
  });
});
