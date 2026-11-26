// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 O1c — a program whose only function values are the realm's Object.prototype methods (P1), read off an object.
// Reading one admits the function kind (`readsPrototypeMethods`), so `typeof` answers "function". The method-call
// shape `o.m(…)` runs the method's own algorithm. Without a source function no dispatcher exists, so a callee that is
// not the realm's method is the run-time abort the dispatcher would have been (or its TypeError, for a non-callable
// one). No program below creates a source function; the `__fv` program's only one is dead and elided before the walk.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  abortBodies,
  abortsAtRunTime,
  agreesWithNode,
  refusal,
  runnerOptions,
} from "./helpers/prepared-node-agreement.js";

afterEach(() => vi.restoreAllMocks());

const SLOW = 240_000;

describe("#7354 O1c — Object.prototype methods in a program with no source function", () => {
  it.each([
    [
      "own, absent and non-enumerable keys through hasOwnProperty and propertyIsEnumerable",
      "var o = { a: 1 }; Object.defineProperty(o, 'x', { value: 2 });" +
        " var out = String(o.hasOwnProperty('a')) + String(o.hasOwnProperty('b')) + String(o.hasOwnProperty('x'))" +
        " + String(o.propertyIsEnumerable('a')) + String(o.propertyIsEnumerable('x'));",
    ],
    ["typeof a method read (the fold P1 guarded)", "var o = { a: 1 }; var out = typeof o.hasOwnProperty;"],
    [
      "a dead function expression is elided before the source walk (S12's finding)",
      "var __fv = function(){}; var o = { a: 1 }; var out = String(o.hasOwnProperty('a'));",
    ],
    [
      "isPrototypeOf over an Object.create chain",
      "var p = {}; var c = Object.create(p); var out = String(p.isPrototypeOf(c)) + String(c.isPrototypeOf(p));",
    ],
  ])("%s", (_label, body) => agreesWithNode(body, true, runnerOptions()), SLOW);

  // The realm method was replaced by another built-in: the dispatcher would abort, so the fallback is that abort.
  it(
    "a callee that is not the realm's method is the run-time abort",
    () =>
      abortsAtRunTime("var o = { a: 1 }; o.hasOwnProperty = o.isPrototypeOf; o.hasOwnProperty('a');", runnerOptions()),
    SLOW,
  );
});

describe("#7354 O1c — what still refuses", () => {
  it(
    "a detached call needs the dispatcher, which a program with no source function has none of",
    async () => {
      expect(await refusal("var o = { a: 1 }; var h = o.hasOwnProperty; var out = h('a');", runnerOptions())).toBe(
        "dynamic operation js.closure.call:1 in a program that creates no function value has no Prepared intrinsic",
      );
    },
    SLOW,
  );

  // S12's finding (1): a function-local `{}` is a raw externref, and a method call on one is from-ast's own refusal
  // (P1's notes); its function gets the U abort body.
  it(
    "a method call on a function-local object stays from-ast's refusal",
    async () => {
      expect(
        await abortBodies(
          "function f(){ var o = {}; Object.defineProperty(o, 'x', { value: 1 }); return o.hasOwnProperty('x'); } f();",
        ),
      ).toEqual(["f: ir/from-ast: method call .hasOwnProperty(...) on externref not in slice 4 (f)"]);
    },
    SLOW,
  );

  // A string receiver needs ToObject of a string (a String wrapper the realm lacks): the run-time abort.
  it(
    "a string receiver is the run-time abort",
    () =>
      abortsAtRunTime("function id(v){ return v; } var o = {}; id('abc').hasOwnProperty('length');", runnerOptions()),
    SLOW,
  );
});
