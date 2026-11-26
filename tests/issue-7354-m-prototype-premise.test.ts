// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 M1, C1 — the closed-world premise a member read of a primitive rests on: no Prepared program can obtain a
// built-in prototype as a value, so no code can change one, and a primitive's member read may answer what the
// specification's pristine prototypes answer (src/ir/program/dynamic-member-access.ts, `MEMBER_ACCESS_ARM`
// "primitive"). Each route to a prototype refuses by its exact text here, or (#7354 C2, C2-D1) where a kind beside it
// answers, ends at the run-time abort before any prototype is a value.
//
// The slice that makes any of these routes compile (`Object.getPrototypeOf`, a wrapper or Object as a value, ...) must
// reintroduce a program-wide gate on the primitive arm, or populate the realm's prototypes and read through them.
// (#7354 G1) The Error family is a value now, and no route from it reaches one of these prototypes (the rows below).
// (#7354 W2) `Object` and the wrapper constructors are values, so Object.prototype and the wrapper prototypes are: a
// program that reads one of those constructors reads a primitive's members through the realm's prototype objects
// (`obtainsPrototypes`; tests/issue-7354-w2-wrappers.test.ts writes String.prototype and reads it through a string).
// `Object.getPrototypeOf` is a static the realm does not hold: its call is the run-time abort (below).
import { describe, expect, it } from "vitest";
import { compile, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { abortBodies, abortsAtRunTime } from "./helpers/prepared-node-agreement.js";

const options = (): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

const notInScope = (name: string) => `ir/from-ast: identifier "${name}" is not in scope in f`;

describe("#7354 M1 — no Prepared program obtains a built-in prototype", () => {
  it.each([
    ["Function.prototype", "function f(){ return Function.prototype; } f();", notInScope("Function")],
    ["Array.prototype", "function f(){ return Array.prototype; } f();", notInScope("Array")],
    ["Reflect.getPrototypeOf", "function f(){ return Reflect.getPrototypeOf({}); } f();", notInScope("Reflect")],
    ["globalThis", "function f(){ return globalThis; } f();", notInScope("globalThis")],
    [
      "a number literal's constructor",
      "function f(){ return (1).constructor; } f();",
      "ir/from-ast: property access .constructor on f64 is not in slice 2 (f)",
    ],
  ])(
    "refuses %s",
    async (_label, source, reason) => {
      const result = await compile(source, options(), undefined, "refuse");
      expect(result.success).toBe(false);
      expect(result.errors.map((error) => error.message)).toContain(reason);
      // (#7354 U) Under abort bodies the refusal is f's: f's body is the run-time abort, so the program still never
      // obtains the prototype.
      expect(await abortBodies(source)).toEqual([`f: ${reason}`]);
      await abortsAtRunTime(source);
    },
    180_000,
  );

  // `undefined` and `null` answer these reads (the TypeError), so the kinds that would reach a prototype abort.
  it.each([
    [
      "Object.getPrototypeOf, a static the realm does not hold",
      "function f(){ return Object.getPrototypeOf(1); } f();",
    ],
    ["a dynamic value's __proto__", "function f(v){ return v.__proto__; } f(1);"],
    ["a dynamic value's constructor", "function f(v){ return v.constructor; } f(1);"],
    // (#7354 P1) The routes a populated Object.prototype method opens: it is a built-in function object, and every key
    // that would lead from it to a prototype (Function.prototype's, Object.prototype's accessor) aborts.
    ...(["constructor", "__proto__", "call"] as const).flatMap((key) =>
      ["({})", "1"].map((receiver): [string, string] => [
        `a method of ${receiver}'s ${key}`,
        `var fv = function(){ return 1; }; fv(); function f(v){ return v.hasOwnProperty.${key}; } f(${receiver});`,
      ]),
    ),
    // (#7354 G1) The Error family's values and prototypes are the program's to read and write, but none leads on to a
    // prototype the premise covers: each route past them (a function's or an object's [[Prototype]], Function) aborts.
    ...["TypeError.__proto__", "TypeError.constructor", "TypeError.call", "Error.prototype.__proto__"].map(
      (route): [string, string] => [
        `the Error family's ${route}`,
        `var fv = function(){ return 1; }; fv(); function f(){ return ${route}; } f();`,
      ],
    ),
  ])("ends %s at the run-time abort", (_label, source) => abortsAtRunTime(source), 180_000);
});
