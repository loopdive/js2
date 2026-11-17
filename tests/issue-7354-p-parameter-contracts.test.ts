// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice P — sound contracts for untyped parameters on the Prepared standalone path. A parameter without a
// TypeScript annotation is the dynamic value (call-site propagation saw no top-level caller, no call with missing
// arguments and no call through a value, so it was never a contract), and an unannotated result is dynamic where
// the checker cannot vouch for it: `any`, or a body that can run off its end after a value. A JSDoc `@returns` is no
// contract either way: a converted value returns as typed, an unconverted one meets D1's implicit-flow rule.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  compileMulti,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (target: "standalone" | "gc" = "standalone"): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target,
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** Compile a script through the strict Prepared entry, run its top-level code and report whether it threw. */
async function run(source: string): Promise<"returned" | "threw"> {
  for (const spy of [
    vi.spyOn(gc, "generateModule"),
    vi.spyOn(gc, "generateMultiModule"),
    vi.spyOn(linear, "generateLinearModule"),
    vi.spyOn(linear, "generateLinearMultiModule"),
  ])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
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

async function refusal(source: string, target: "standalone" | "gc" = "standalone"): Promise<string> {
  const result = await compile(source, options(target));
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

const ID = "function id(v) { return v; }\n";

describe("#7354 P — an untyped parameter is the dynamic value", () => {
  // Each program carries node's answers and runs twice: as written (returns) and with one answer replaced by a
  // wrong one (throws), so a pass cannot come from a check that never ran.
  it.each([
    [
      "the #7354 repro: h is called with a boolean through g and with numbers from top-level code",
      "function h(v) { return v === 0; }\nfunction g(b) { return h(b); }\n" +
        "if (g(true) !== false) throw 1;\nif (h(0.5) !== false) throw 2;\nif (h(0) !== true) throw 3;",
      ["h(0) !== true", "h(0) !== false"],
    ],
    [
      "id with a number, a boolean and undefined, from top-level code and from a function",
      `${ID}function k() { if (id(true) !== true) throw 4; if (id(undefined) !== undefined) throw 5; ` +
        "if (id(2) !== 2) throw 6; }\n" +
        "if (id(1) !== 1) throw 1;\nif (id(false) !== false) throw 2;\nif (id(undefined) !== undefined) throw 3;\nk();",
      ["id(2) !== 2", "id(2) !== 3"],
    ],
    [
      "a parameter only ever passed numbers (dynamic; `*` converts it back)",
      "function sq(n) { return n * n; }\nfunction k() { return sq(3); }\nif (sq(4) + k() !== 25) throw 1;",
      ["!== 25", "!== 24"],
    ],
    [
      "recursion",
      "function f(n) { if (n === 0) return 0; return f(n - 1); }\nif (f(3) !== 0) throw 1;",
      ["f(3) !== 0", "f(3) !== 3"],
    ],
    [
      "a parameter reassigned to another type inside the body",
      "function f(v) { v = true; return v; }\nif (f(1) !== true) throw 1;",
      ["!== true", "!== 1"],
    ],
    ["a missing argument is undefined", `${ID}if (id() !== undefined) throw 1;`, ["!== undefined", "=== undefined"]],
    [
      "a body that runs off its end after returning a value returns undefined there",
      "function f(v) { if (v === 1) return 2; }\nif (f(1) !== 2) throw 1;\nif (f(3) !== undefined) throw 2;",
      ["f(3) !== undefined", "f(3) === undefined"],
    ],
    [
      "a local copied from a parameter",
      "function f(v) { var x = v; return x; }\nif (f(1) !== 1) throw 1;",
      ["!== 1", "!== 2"],
    ],
    [
      "a JSDoc `@returns {void}` on a body that returns no value (no result to contract)",
      "/** @returns {void} */\nfunction check(v) { if (v !== 1) throw 1; }\ncheck(1);",
      ["check(1);", "check(2);"],
    ],
    [
      "a JSDoc `@returns {number}` over a value the body converts",
      "/** @returns {number} */\nfunction f(n) { return n * 1; }\nif (f(true) !== 1) throw 1;",
      ["f(true) !== 1", "f(true) !== 2"],
    ],
    [
      "a JSDoc `@returns {boolean}` over a comparison",
      "/** @returns {boolean} */\nfunction f(n) { return n === 1; }\nif (f(1) !== true) throw 1;",
      ["f(1) !== true", "f(1) !== false"],
    ],
    [
      "the isNegativeZero helper of harness/assert.js",
      "function isNegativeZero(value) { return value === 0 && 1 / value === -Infinity; }\n" +
        "if (!isNegativeZero(-0)) throw 1;\nif (isNegativeZero(0)) throw 2;\nif (isNegativeZero(true)) throw 3;",
      ["if (isNegativeZero(0))", "if (!isNegativeZero(0))"],
    ],
  ])("runs %s", async (_name, source, [right, wrong]) => {
    expect(source).toContain(right);
    expect(await run(source)).toBe("returned");
    expect(await run(source.replace(right, wrong))).toBe("threw");
  });

  it.each([
    [
      "ToBoolean of the dynamic parameter (the repro's original `v ? 1 : 2`)",
      "function h(v) { return v ? 1 : 2; }\nif (h(0.5) !== 1) throw 1;",
      "dynamic operation dyn.truthy has no Prepared intrinsic",
    ],
    [
      "`arguments`",
      "function f(v) { return arguments.length; }\nif (f(1) !== 1) throw 1;",
      "dynamic operation dyn.arguments_length has no Prepared intrinsic",
    ],
    ["an extra argument", `${ID}if (id(1, 2) !== 1) throw 1;`, "call to id has 2 args, expected 1"],
    [
      "a call through a value",
      `${ID}var g = id;\nif (g(1) !== 1) throw 1;`,
      "module binding g has no exact typed storage: not-direct",
    ],
    [
      // JSDoc is not checked at runtime: the contract stays dynamic, and from-ast refuses it against a primitive tag.
      "a JSDoc-typed parameter called with a wrong type at top level",
      `/** @param {number} n */\nfunction f(n) { return n; }\n${ID}f(id(true));`,
      "type override (dynamic) disagrees with annotation (f64) at param n of f",
    ],
    [
      "a JSDoc `@returns {number}` over an unconverted untyped value",
      "/** @returns {number} */\nfunction f(n) { return n; }\nf(true);",
      "a dynamic value flows into number without a conversion (ReturnStatement)",
    ],
  ])("refuses %s", async (_name, source, message) => {
    expect(await refusal(source)).toContain(message);
  });

  it("keeps the gc target without a dynamic carrier: an untyped parameter used only from top level has no contract", async () => {
    expect(await refusal(`${ID}if (id(1) !== 1) throw 1;`, "gc")).toContain("unresolved parameter contract");
  });

  // The contract reads no call site, so a caller in another source cannot unsettle it; today a cross-source call
  // to such a function is refused before it would matter (a script has no AST-site plan for it, and an exported
  // function with an untyped parameter has no host contract).
  it.each([
    [
      "a call from another script",
      {
        "./a.js": "function h(v) { return v === 0; }\nif (h(0.5) !== false) throw 1;",
        "./b.js": "if (h(true) !== false) throw 2;",
      },
      'direct call to "h" has no exact AST-site plan',
    ],
    [
      "a call from another module",
      {
        "./a.js": "export function h(v) { return v === 0; }\nexport var x = h(0.5) ? 1 : 0;",
        "./b.js": 'import { h } from "./a.js";\nexport var y = h(true) ? 1 : 0;',
      },
      "complete synchronous numeric or Boolean function declarations are required",
    ],
  ])("refuses %s", async (_name, files, message) => {
    const result = await compileMulti(files, "./b.js", options());
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain(message);
  });
});
