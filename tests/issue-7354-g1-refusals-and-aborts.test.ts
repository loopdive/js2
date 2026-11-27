// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 G1 — what the Error family does not answer on the Prepared path, and why each is sound: a refusal by name or
// the run-time abort where JavaScript would answer, never a wrong value.
// - ES2022's second argument (`options.cause`) and V8's own error keys (`stack`, `captureStackTrace`,
//   `stackTraceLimit`) refuse by name: the realm answers the specification, the engine beside it V8.
// - A shadowed or written name is no longer the realm's constructor: the existing rules refuse it.
// - The constructor called through another value (a variable) is the dispatcher's built-in abort.
// - The premise re-proof (`dynamic-error-constructors.ts`): a function's [[Prototype]] chain answers `false` to
//   `instanceof` / `isPrototypeOf`, but `%Error%` (a NativeError constructor's [[Prototype]]) is the abort.
// - A read of an undeclared name stays a refusal (no ReferenceError at GetValue: the lib is not the global list).
import { afterEach, describe, expect, it, vi } from "vitest";
import { abortsAtRunTime, agreesWithNode, gapText, refusal, runnerOptions } from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 300_000;
const CALLS = "\nvar k = function(){ return 1; }; k();";

describe("#7354 G1 — refusals by name", () => {
  it.each([
    [
      "a second argument",
      "var e = new Error('m', {cause: 1});",
      gapText("Error with a second argument (options.cause)"),
    ],
    [
      "an error's stack",
      "var e = new Error('m'); var s = e.stack;",
      gapText("member read 'stack' (V8's own error property) where a value may be an error"),
    ],
    [
      "Error.captureStackTrace",
      "var c = Error.captureStackTrace;",
      gapText("member read 'captureStackTrace' (V8's own error property) where a value may be an error"),
    ],
    [
      "Error.stackTraceLimit",
      "var n = Error.stackTraceLimit;",
      gapText("member read 'stackTraceLimit' (V8's own error property) where a value may be an error"),
    ],
    [
      "a script function named TypeError",
      "function TypeError(m){ this.m = m; } var o = new TypeError('q');",
      'ir/from-ast: unknown class "TypeError" in <module-init>',
    ],
    [
      "a write to TypeError",
      "TypeError = 1; var t = TypeError;",
      'ir/from-ast: assignment to undeclared identifier "TypeError" in <module-init>',
    ],
    [
      // The write itself has no lowering on this path; were it lowered, the name would not be pristine either.
      "a write through the global object",
      "globalThis.TypeError = 1; var t = TypeError;",
      'ir/from-ast: identifier "globalThis" is not in scope in <module-init>',
    ],
    // Function.prototype's `caller` / `arguments` setter throws; a write that silently landed (as it did before G1,
    // unobservable while `assert.throws(TypeError, …)` could not run) answers wrong. (#7489) The realm answers
    // `caller` now (tests/issue-7489-function-caller.test.ts); `arguments` still refuses, as a sloppy function's own
    // is its arguments object.
    [
      "a write to a function's arguments",
      "'use strict'; function f(){} f.arguments = 1;",
      gapText("member write 'arguments' of a function needs a sloppy function's own arguments object"),
    ],
    [
      "a read of an undeclared name",
      "var x = undeclaredQ;",
      'ir/from-ast: identifier "undeclaredQ" is not in scope in <module-init>',
    ],
  ])(
    "refuses %s",
    async (_label, source, text) => {
      expect(await refusal(source + CALLS, runnerOptions())).toContain(text);
    },
    SLOW,
  );
});

describe("#7354 G1 — the run-time abort", () => {
  it.each([
    ["new through a variable", "var E = TypeError; var e = new E('m');"],
    ["a call through a variable", "var E = RangeError; var e = E('m');"],
    [
      "instanceof whose prototype is %Error%",
      "var F = function(){}; F.prototype = Error; var b = TypeError instanceof F;",
    ],
    ["isPrototypeOf with %Error% as this", "var b = Error.isPrototypeOf(TypeError);"],
  ])("ends %s at the abort", (_label, source) => abortsAtRunTime(source + CALLS, runnerOptions()), SLOW);
});

describe("#7354 G1 — a function's chain without %Error% answers false", () => {
  it(
    "instanceof and isPrototypeOf over functions",
    () =>
      agreesWithNode(
        `var f = function(){};
var out = String(f instanceof TypeError) + String(TypeError instanceof f) + String(TypeError instanceof Error)
  + String(Error.prototype.isPrototypeOf(TypeError)) + String(TypeError.prototype.isPrototypeOf(f))
  + String(Error instanceof f);` + CALLS,
        true,
        runnerOptions(),
      ),
    SLOW,
  );
});
