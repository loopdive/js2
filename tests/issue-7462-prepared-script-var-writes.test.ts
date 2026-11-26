// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7462 — on the strict Prepared path, a function or closure updates a script `var` it does not have in scope (`n++`,
// `n += 1`, also where the update's value is discarded inside an expression), and a `new` expression that constructs
// a dynamic value is a `+` operand. Each accepted program agrees with node and a wrong twin throws; the shapes this
// slice leaves out are pinned by the name they refuse or abort with.
import { describe, expect, it } from "vitest";
import { compile, requiredPreparedAbortBodies } from "../src/test262/test262-prepared-entry.js";
import { abortBodies, agreesWithNode, preparedOptions, refusal } from "./helpers/prepared-node-agreement.js";

const SLOW = 240_000;

describe("#7462 — a function writes a script var", () => {
  it.each([
    ["n++ in a closure", "var n = 0; var f = function(){ n++; }; f(); var out = String(n);"],
    ["n-- in a closure", "var n = 0; var f = function(){ n--; }; f(); var out = String(n);"],
    ["++n in a closure", "var n = 0; var f = function(){ ++n; }; f(); var out = String(n);"],
    ["n += 1 in a closure", "var n = 0; var f = function(){ n += 1; }; f(); var out = String(n);"],
    ["n -= 2 in a closure", "var n = 0; var f = function(){ n -= 2; }; f(); var out = String(n);"],
    [
      "n++ in a closure's for loop",
      "var n = 0; var f = function(){ for (var i = 0; i < 3; i++) n++; }; f(); var out = String(n);",
    ],
    ["n++ of a string var (ToNumber)", 'var n = "5"; var f = function(){ n++; }; f(); var out = String(n) + typeof n;'],
    ["s += 'b' of a string var", 'var s = "a"; var f = function(){ s += "b"; }; f(); var out = s;'],
    ["n++ then return in a function", "var n = 0; function g(){ n++; return; } g(); g(); var out = String(n);"],
    ["n += 1 in a function", "var n = 0; function g(){ n += 1; } g(); var out = String(n);"],
  ])("%s", (_label, body) => agreesWithNode(body), SLOW);
});

describe("#7462 — an update whose value is discarded inside an expression", () => {
  it.each([
    ["n++ as a function's last statement", "var n = 0; function g(){ n++; } g(); var out = String(n);"],
    ["n -= 1 as a function's last statement", "var n = 0; function g(){ n -= 1; } g(); var out = String(n);"],
    ["n++ on the left of a comma", "var n = 0; (n++, 0); var out = String(n);"],
    ["n++ in a conditional's arm", "var n = 0; true ? n++ : 0; false ? 0 : --n; var out = String(n);"],
    ["n++ on the left of a comma in a function", "var n = 0; function g(){ (n++, 0); } g(); var out = String(n);"],
  ])("%s", (_label, body) => agreesWithNode(body), SLOW);
});

describe("#7462 — `new` as a `+` operand", () => {
  it.each([
    ['"" + new TypeError("m")', 'var out = "" + new TypeError("m");'],
    ['new TypeError("m") + ""', 'var out = new TypeError("m") + "";'],
    ['"" + new Error("m")', 'var out = "" + new Error("m");'],
    ['"" + new C() of a function C', 'function C(){} var out = "" + new C();'],
  ])("%s", (_label, body) => agreesWithNode(body), SLOW);
});

describe("#7462 — the shapes this slice leaves out, by name", () => {
  it.each([
    [
      "an update used as a value",
      "var n = 0; var f = function(){ var r = n++; return r; }; f();",
      "<module-init>__closure_0: ir/from-ast: unsupported expression kind PostfixUnaryExpression in <module-init>__closure_0",
    ],
    [
      "an update in a function nested in the closure",
      "var n = 0; var f = function(){ function h(){ n++; } h(); }; f();",
      "<module-init>__closure_0: ir/from-ast: nested func must have a return type annotation (<module-init>__closure_0)",
    ],
    [
      "an update of a name nothing declares",
      "function g(){ m++; } g();",
      'g: ir/from-ast: increment/decrement of undeclared "m" in g',
    ],
  ])("aborts %s", async (_label, source, row) => {
    expect(await abortBodies(source)).toEqual([row]);
  });

  it("aborts an update of a script const by name (#7434), beside the checker's error", async () => {
    const result = await compile("const n = 0; var f = function(){ n++; }; f();", preparedOptions());
    expect(result.errors.map((error) => error.message)).toEqual(["Cannot assign to 'n' because it is a constant."]);
    expect(requiredPreparedAbortBodies(result)!.map((row) => `${row.name}: ${row.detail}`)).toEqual([
      '<module-init>__closure_0: const-write: increment/decrement of "n" (<module-init>__closure_0)',
    ]);
  });

  it.each([
    [
      "an update of a let (its TDZ guard)",
      "let n = 0; var f = function(){ n++; }; f();",
      "runtime callable __new_ReferenceError needs runtime function materialization",
    ],
    [
      "an update of a BigInt var (no BigInt value exists on this lane)",
      "var n = 1n; function g(){ n++; } g();",
      "ir/from-ast: unsupported expression kind BigIntLiteral in <module-init>",
    ],
    [
      // On main: `unsupported expression kind PostfixUnaryExpression in f`; the for-update clause now discards
      // through `lowerDiscardedUpdate`, which reaches the member write the statement `o.x++;` already refuses at.
      "a member update in a for-update clause, at the member compound write",
      "function f(o){ for (var i = 0; i < 2; o.x++) i++; }",
      "ir/from-ast: compound property write on dynamic not in IR scope (f)",
    ],
  ])("refuses %s", async (_label, source, message) => {
    expect(await refusal(source)).toContain(message);
  });

  it.each(["Map", "Promise", "Number", "RegExp"])(
    "refuses a user function named %s constructed as a `+` operand, and through a variable",
    async (name) => {
      expect(await refusal(`function ${name}(){} "" + new ${name}();`)).toContain(
        "'+' operands not provably both-number or string-concatenable (string/unprovable)",
      );
      expect(await refusal(`function ${name}(){} var v = new ${name}(); "" + v;`)).toContain(
        `ir/from-ast: unknown class "${name}" in <module-init>`,
      );
    },
    SLOW,
  );
});
