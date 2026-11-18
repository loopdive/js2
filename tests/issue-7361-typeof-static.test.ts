// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7361 — `typeof` lowers its operand under an f64 hint, and its static answer came from the IR type that the
// lowering produced: `typeof void 0` was "number". The answer now comes from the operand's source type (the
// oracle), which must agree with the IR type; an `undefined`/`void` source type answers "undefined".
import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { compile as compilePrepared, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";

// [shape, declarations, body of `g()`]. Each body returns a boolean or a number; node's answer is the reference.
const PROGRAMS: readonly (readonly [string, string, string])[] = [
  ["`void 0` vs undefined", "", 'return typeof void 0 === "undefined";'],
  ["`void 0` vs number", "", 'return typeof void 0 === "number";'],
  ["`void 1` vs number", "", 'return typeof void 1 !== "number";'],
  ["`void` of a string", "", 'return typeof void "a" === "undefined";'],
  ["`void` of a Boolean", "", 'return typeof void true === "undefined";'],
  ["`?:` of two `void 0`", "var c = 1;", 'return typeof (c ? void 0 : void 0) === "undefined";'],
  [
    "nested `?:` of `void 0`",
    "var c = 1, d = 0;",
    'return typeof (c ? (d ? void 0 : void 0) : void 0) === "undefined";',
  ],
  ["`?:` of `void 0` and a number", "var c = 1;", 'return typeof (c ? void 0 : 1) === "undefined";'],
  ["`?:` of a number and `void 0`", "var c = 0;", 'return typeof (c ? 1 : void 0) === "undefined";'],
  ["`?:` of two numbers", "var c = 1;", 'return typeof (c ? 1 : 2) === "number";'],
  ["`?:` of two Booleans", "var c = 1;", 'return typeof (c ? true : false) === "boolean";'],
  ["a comma ending in `void 0`", "", 'return typeof (0, void 0) === "undefined";'],
  ["a comma ending in a number", "", 'return typeof (void 0, 1) === "number";'],
  ["`typeof typeof`", "", 'return typeof typeof void 0 === "string";'],
  ["`!void 0`", "", 'return typeof !void 0 === "boolean";'],
  ["`-void 0`", "", 'return typeof -void 0 === "number";'],
  ["an i32 `|`", "var x = 7;", 'return typeof (x | 0) === "number";'],
  ["a comparison", "var a = 1, b = 2;", 'return typeof (a < b) === "boolean";'],
  ["a typed local", "", 'var k = 1; return typeof k === "number";'],
  ["`undefined`", "", 'return typeof undefined === "undefined";'],
  ["`null`", "", 'return typeof null === "object";'],
  [
    "a switch on `typeof void 0`",
    "",
    'switch (typeof void 0) { case "undefined": return 1; case "number": return 2; } return 3;',
  ],
  // The operand runs exactly once, also when the answer is static.
  [
    "`void f()` (runs f once)",
    "var n = 0; function f() { n = n + 1; return 1; }",
    'var r = typeof void f() === "undefined"; return r && n === 1;',
  ],
  [
    "a comma calling f (runs f once)",
    "var n = 0; function f() { n = n + 1; return 1; }",
    'return typeof (f(), void 0) === "undefined" && n === 1;',
  ],
  [
    "`void` of a throwing call",
    "function f() { throw 1; }",
    "try { typeof void f(); return false; } catch (e) { return true; }",
  ],
  [
    "a switch on `typeof void f()` (runs f once)",
    "var n = 0; function f() { n = n + 1; }",
    'switch (typeof void f()) { case "undefined": return n; default: return -1; }',
  ],
];

const nodeAnswer = (declarations: string, body: string): unknown =>
  new Function(`${declarations}\nfunction g() { ${body} }\nreturn g();`)();

/** Compile through the ordinary pipeline and call `g`; an i32 Boolean reads as a Boolean. */
async function runOrdinary(declarations: string, body: string, target: "gc" | "standalone"): Promise<unknown> {
  const result = await compile(`${declarations}\nexport function g() { ${body} }`, {
    fileName: "test.js",
    allowJs: true,
    ...(target === "standalone" ? { target } : {}),
  });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : built;
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  built.setInstance?.(instance);
  return (instance.exports.g as () => unknown)();
}

describe.each(["gc", "standalone"] as const)("#7361 — typeof answers like JavaScript (%s)", (target) => {
  it.each(PROGRAMS)("%s", async (_, declarations, body) => {
    const expected = nodeAnswer(declarations, body);
    const actual = await runOrdinary(declarations, body, target);
    expect(typeof expected === "boolean" ? actual === 1 || actual === true : actual).toBe(expected);
  });

  // A union whose members share one tag still has a static answer: the function stays on the IR path.
  it.each([
    ["`?:` of two numbers", "var c = 1;", 'return typeof (c ? 1 : 2) === "number";'],
    ["`typeof typeof`", "", 'return typeof typeof void 0 === "string";'],
  ])("keeps %s on the IR path", async (_, declarations, body) => {
    const result = await compile(`${declarations}\nexport function g() { ${body} }`, {
      fileName: "test.js",
      allowJs: true,
      ...(target === "standalone" ? { target } : {}),
    });
    expect(result.irCompiledFuncs).toContain("g");
  });
});

const preparedOptions = {
  wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
  backend: "wasmgc",
  target: "standalone",
  sourceMap: false,
  optimize: false,
  emitWat: false,
  fileName: "test.js",
  allowJs: true,
} as Test262CompileOptions;

describe("#7361 — typeof on the Prepared path", () => {
  // The right answer returns, the wrong one throws: a pass cannot come from a check that never ran.
  // [shape, program expecting @A, node's answer, a wrong answer]
  const programs: readonly (readonly [string, string, string, string])[] = [
    [
      "a switch on `typeof void 0`",
      'function g() { switch (typeof void 0) { case "undefined": return 1; case "number": return 2; } return 3; }\n' +
        "if (g() !== @A) throw 1;",
      "1",
      "2",
    ],
    ["`typeof void 0` at top level", "if (typeof void 0 !== @A) throw 1;", '"undefined"', '"number"'],
  ];

  async function run(source: string): Promise<"returned" | "threw"> {
    const result = await compilePrepared(source, preparedOptions);
    expect(result.errors.map((error) => error.message)).toEqual([]);
    try {
      (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
      return "returned";
    } catch {
      return "threw";
    }
  }

  it.each(programs)("answers %s like JavaScript", async (_, program, right, wrong) => {
    expect(await run(program.replace("@A", right))).toBe("returned");
    expect(await run(program.replace("@A", wrong))).toBe("threw");
  });

  // `c ? void 0 : 1` lowers to an f64 (`void 0` as NaN), but its source type is number OR undefined: the f64 does
  // not prove "number". The Prepared path has no selector to send it elsewhere, so it refuses by name.
  it("refuses an operand whose source type holds undefined beside a number by name", async () => {
    const result = await compilePrepared(
      'var c = 1;\nif (typeof (c ? void 0 : 1) !== "undefined") throw 1;',
      preparedOptions,
    );
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "typeof operand lowered as number has source type mixed",
    );
  });
});
