// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice S — a script `var` named as the target of `Object.defineProperty(v, …)` keeps its home on the Prepared
// whole-program path. TypeScript's binder records the call's first argument as a declaration of the binding; that is a
// JS property declaration, not a second binding, so the home classifier no longer counts it. The call itself is refused
// by name where from-ast meets it, because the Prepared path admits no `Object` static yet: the program stops at the
// construct it lacks, not at `has no exact typed storage: not-direct`.
import { describe, expect, it } from "vitest";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  compileMulti,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (fileName = "test.js"): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName,
    allowJs: true,
  }) as Test262CompileOptions;

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** Compile through the strict Prepared entry, run the top-level code and report whether it threw. */
async function run(source: string): Promise<"returned" | "threw"> {
  const result = await compile(source, options());
  expect(messages(result)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    const exports = instantiatePreparedArtifact(result).instance.exports;
    (exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

async function refusals(source: string | readonly string[]) {
  const result =
    typeof source === "string"
      ? await compile(source, options())
      : await compileMulti(
          Object.fromEntries(source.map((text, index) => [`s${index}.js`, text])),
          `s${source.length - 1}.js`,
          options(),
        );
  expect(result.success).toBe(false);
  return messages(result);
}

const DEFINE = (unit: string) => `ir/from-ast: Object.defineProperty is not an admitted Object static (${unit})`;
const NO_HOME = (name: string) => `module binding ${name} has no exact typed storage: not-direct`;

describe("#7354 S — a script var named by Object.defineProperty", () => {
  // Each refusal is the call's own. Only the top-level, number-var and before-the-declaration rows show the home:
  // a call inside a function refused at the call before this slice too (its unit fails before module-init asks).
  it.each([
    ["at top level", 'var obj = {}; Object.defineProperty(obj, "p", { value: 1 });', DEFINE("<module-init>")],
    [
      "in a function",
      'var obj = {}; function f() { Object.defineProperty(obj, "p", { value: 1 }); } f();',
      DEFINE("f"),
    ],
    [
      "in a function never called",
      'var obj = {}; obj.p = 2; function f() { Object.defineProperty(obj, "p", { value: 1 }); }',
      DEFINE("f"),
    ],
    [
      "in a loop",
      'var obj = {}; for (var i = 0; i < 2; i++) { Object.defineProperty(obj, "p", { value: i }); }',
      DEFINE("<module-init>"),
    ],
    [
      "in a function called before the declaration",
      'f(); var obj = {}; function f() { Object.defineProperty(obj, "p", { value: 1 }); }',
      DEFINE("f"),
    ],
    ["on a number var", 'var n = 1; Object.defineProperty(n, "p", { value: 1 });', DEFINE("<module-init>")],
    [
      "on a number var read as a number",
      'var n = 1; if (n + 1 !== 2) throw 1; function g() { Object.defineProperty(n, "p", { value: 1 }); }',
      DEFINE("g"),
    ],
  ])("refuses the call %s, not the binding", async (_, program, message) => {
    expect(await refusals(program)).toEqual([message]);
  });

  // A var declared before the call is reached, too: the checker's use-before-assignment warning comes first.
  it("refuses the call before the declaration", async () => {
    expect(await refusals('Object.defineProperty(obj, "p", { value: 1 }); var obj = {};')).toEqual([
      "Variable 'obj' is used before being assigned.",
      DEFINE("<module-init>"),
    ]);
  });

  // The binding the call names keeps the home a member write already had; a program without the call still runs.
  it("runs the same binding given a property by a member write", async () => {
    const program = (expected: string) =>
      `var obj = {}; function f() { obj.p = 1; } f(); if (obj.p !== ${expected}) throw 1;`;
    expect(await run(program("1"))).toBe("returned");
    expect(await run(program("2"))).toBe("threw");
    // (#7354 M1) a member write selects the realm, whose compile is slow under vitest's self-checks
  }, 180_000);

  // The sweep of object operations on such a var found one from-ast arm that threw an invariant out of `compile()`:
  // the own-property test on a dynamic script var, which only the selector refused. It is the selector's refusal now.
  it.each([
    ["at top level", "var o = {p: 1}; if (!o.hasOwnProperty('p')) throw 1;", "<module-init>"],
    ["in a function", "var o = {p: 1}; function t() { return o.hasOwnProperty('p'); } t();", "t"],
  ])("refuses an own-property test on the var %s by name", async (_, program, unit) => {
    expect(await refusals(program)).toEqual([
      `ir/from-ast: own-property test on a script var planned by neither #7335's arm nor the row (${unit})`,
    ]);
  });

  // What still has no home keeps its reason: a non-writable global name, and a var of one of several scripts (each
  // script's module-init hoists only its own globals).
  it.each([
    ["a non-writable global name", "var Infinity = 1;", NO_HOME("Infinity")],
    [
      "a var declared in one of two scripts",
      ['var obj = {}; Object.defineProperty(obj, "p", { value: 1 });', "obj.q = 2;"],
      NO_HOME("obj"),
    ],
  ])("still refuses %s by its binding", async (_, program, message) => {
    expect(await refusals(program)).toContain(message);
  });
});
