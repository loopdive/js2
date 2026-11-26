// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice S — a script `var` named as the target of `Object.defineProperty(v, …)` keeps its home on the Prepared
// whole-program path. TypeScript's binder records the call's first argument as a declaration of the binding; that is a
// JS property declaration, not a second binding, so the home classifier no longer counts it. (#7354 O1) The call runs
// now (tests/issue-7354-o1-*): each program checks the property the call defined on the binding.
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

/**
 * The names the path refuses `source` by. (#7354 U) A single source compiles without abort bodies: under them a
 * refusal inside a function becomes that function's abort body, and these cases are about the name of the refusal.
 */
async function refusals(source: string | readonly string[]) {
  const result =
    typeof source === "string"
      ? await compile(source, options(), undefined, "refuse")
      : await compileMulti(
          Object.fromEntries(source.map((text, index) => [`s${index}.js`, text])),
          `s${source.length - 1}.js`,
          options(),
        );
  expect(result.success).toBe(false);
  return messages(result);
}

/** Whether node runs `source` to its end. */
function nodeOutcome(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}
const NO_HOME = (name: string) => `module binding ${name} has no exact typed storage: not-direct`;

describe("#7354 S — a script var named by Object.defineProperty", () => {
  // `expected` is node's outcome: the program checks the defined property, or the call throws its TypeError on a
  // number (a defined `configurable: true` property lets the loop redefine it).
  it.each([
    [
      "at top level",
      'var obj = {}; Object.defineProperty(obj, "p", { value: 1 }); if (obj.p !== 1) throw 1;',
      "returned",
    ],
    [
      "in a function",
      'var obj = {}; function f() { Object.defineProperty(obj, "p", { value: 1 }); } f(); if (obj.p !== 1) throw 1;',
      "returned",
    ],
    [
      "in a function never called",
      'var obj = {}; obj.p = 2; function f() { Object.defineProperty(obj, "p", { value: 1 }); } if (obj.p !== 2) throw 1;',
      "returned",
    ],
    [
      "in a loop",
      'var obj = {}; for (var i = 0; i < 2; i++) { Object.defineProperty(obj, "p", { value: i, configurable: true }); }' +
        " if (obj.p !== 1) throw 1;",
      "returned",
    ],
    [
      "in a function called before the declaration",
      'f(); var obj = {}; function f() { Object.defineProperty(obj, "p", { value: 1 }); }',
      "threw",
    ],
    ["on a number var", 'var n = 1; Object.defineProperty(n, "p", { value: 1 });', "threw"],
    [
      "on a number var read as a number",
      'var n = 1; if (n + 1 !== 2) throw 1; function g() { Object.defineProperty(n, "p", { value: 1 }); } g();',
      "threw",
    ],
  ])(
    "runs the call %s on the binding's home",
    async (_, program, expected) => {
      expect(nodeOutcome(program)).toBe(expected);
      expect(await run(program)).toBe(expected);
    },
    180_000,
  );

  // The binding the call names keeps the home a member write already had; a program without the call still runs.
  it("runs the same binding given a property by a member write", async () => {
    const program = (expected: string) =>
      `var obj = {}; function f() { obj.p = 1; } f(); if (obj.p !== ${expected}) throw 1;`;
    expect(await run(program("1"))).toBe("returned");
    expect(await run(program("2"))).toBe("threw");
    // (#7354 M1) a member write selects the realm, whose compile is slow under vitest's self-checks
  }, 180_000);

  // The sweep of object operations on such a var found one from-ast arm that threw an invariant out of `compile()`:
  // the own-property test on a dynamic script var, which only the selector refused. (#7354 P1) It is the method call
  // now (Object.prototype holds `hasOwnProperty`): it runs where the program has function values, the define-target
  // var included, and refuses by name where the function kind is not admitted.
  it.each([
    ["at top level", "var o = {p: 1}; if (!o.hasOwnProperty('p') || o.hasOwnProperty('q')) throw 1;"],
    ["in a function", "var o = {p: 1}; function t() { return o.hasOwnProperty('p'); } if (!t()) throw 1;"],
    [
      "defined by Object.defineProperty",
      "var o = {}; Object.defineProperty(o, 'p', {value: 1}); if (!o.hasOwnProperty('p') || o.propertyIsEnumerable('p')) throw 1;",
    ],
  ])(
    "runs an own-property test on the var %s",
    async (_, program) => {
      const functionValue = "var fv = function(){ return 1; }; fv(); ";
      expect(await run(functionValue + program)).toBe("returned");
      expect(await run(functionValue + program.replace("throw 1", "{} else throw 1"))).toBe("threw");
    },
    180_000,
  );

  it("refuses an own-property test on the var in a program without function values by name", async () => {
    expect(await refusals("var o = {p: 1}; if (!o.hasOwnProperty('p')) throw 1;")).toEqual([
      "dynamic operation member read 'hasOwnProperty' in a program that creates no function value has no Prepared intrinsic",
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
