// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7361 — `typeof` lowers its operand under an f64 hint and answers from the IR type the lowering produced, so a
// value `void x` (the f64 NaN sentinel) read as "number". An operand with a value-`void` leaf is now split at its
// leaves: a `void x` leaf runs `x` once and answers "undefined", every other leaf keeps the IR-type answer. No
// TypeScript type is consulted: a cast that lies must not change the answer (review round 1).
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { compile } from "../src/index.js";
import { buildImports } from "../src/runtime.js";
import { compile as compilePrepared, type Test262CompileOptions } from "../src/test262/test262-prepared-entry.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";

const TAG_INDEX =
  't === "undefined" ? 1 : t === "number" ? 2 : t === "boolean" ? 3 : t === "string" ? 4 : t === "object" ? 5 : 6';
const tagOf = (operand: string): string => `var t = typeof ${operand}; return ${TAG_INDEX};`;
const F = "var n = 0; function f() { n = n + 1; return 1; }";
const FOLDED = 'return typeof (typeof JSON === "undefined" ? null : void 0) === "undefined";';

// [shape, file extension, declarations, body of `g()`]. Each body returns a boolean or a number; node answers.
const PROGRAMS: readonly (readonly [string, "js" | "ts", string, string])[] = [
  ["`void 0` vs undefined", "js", "", 'return typeof void 0 === "undefined";'],
  ["`void 0` vs number", "js", "", 'return "number" !== typeof void 0;'],
  ["`void` of a string", "js", "", tagOf('void "a"')],
  ["`void` of a Boolean", "js", "", tagOf("void true")],
  ["parenthesized `void 0`", "js", "", tagOf("((void 0))")],
  ["`void void 0`", "js", "", tagOf("void void 0")],
  ["a comma ending in `void 0`", "js", "", 'return typeof (0, void 0) === "undefined";'],
  ["a comma ending in a number", "js", "", tagOf("(void 0, 1)")],
  ["a comma ending in a parenthesized `void 0`", "js", "", tagOf("(0, (void 0))")],
  ["`?:` of two `void 0`", "js", "var c = 1;", 'return typeof (c ? void 0 : void 0) === "undefined";'],
  ["nested `?:` of `void 0`", "js", "var c = 1, d = 0;", tagOf("(c ? (d ? void 0 : void 0) : void 0)")],
  ["`?:` of `void 0` and a number (void taken)", "js", "var c = 1;", tagOf("(c ? void 0 : 1)")],
  ["`?:` of `void 0` and a number (number taken)", "js", "var c = 0;", tagOf("(c ? void 0 : 1)")],
  ["`?:` of `void 0` and a string", "js", "var c = 0;", tagOf('(c ? void 0 : "s")')],
  ["`?:` of two numbers", "js", "var c = 1;", tagOf("(c ? 1 : 2)")],
  ["a `?:` folded on `typeof JSON`", "js", "", FOLDED],
  ["`typeof typeof void 0`", "js", "", tagOf("typeof void 0")],
  ["`!void 0`", "js", "", tagOf("!void 0")],
  ["`-void 0`", "js", "", tagOf("-void 0")],
  ["an i32 `|`", "js", "var x = 7;", tagOf("(x | 0)")],
  ["a comparison", "js", "var a = 1, b = 2;", tagOf("(a < b)")],
  ["`undefined`", "js", "", tagOf("undefined")],
  ["`null`", "js", "", tagOf("null")],
  [
    "a switch on `typeof void 0`",
    "js",
    "",
    'switch (typeof void 0) { case "undefined": return 1; case "number": return 2; } return 3;',
  ],
  // The operand runs exactly once, also when the answer is static.
  ["`void f()` runs f once", "js", F, 'var r = typeof void f() === "undefined"; return r && n === 1;'],
  ["a comma calling f runs f once", "js", F, 'return typeof (f(), void 0) === "undefined" && n === 1;'],
  ["an unused `typeof void f()` runs f once", "js", F, "typeof void f(); return n;"],
  [
    "`void` of a throwing call",
    "js",
    "function f() { throw 1; }",
    "try { typeof void f(); return false; } catch (e) { return true; }",
  ],
  // Review round 1, item 1: an untyped parameter the IR infers as a number from its call site.
  ["a parameter compared with number", "js", 'function k(x) { return typeof x === "number" ? 1 : 0; }', "return k(1);"],
  [
    "a parameter narrowed by typeof",
    "js",
    'function k(x) { if (typeof x === "number") return x + 1; return 0; }',
    "return k(1);",
  ],
  ["an `any` parameter", "ts", 'function k(x: any) { return typeof x === "number" ? 1 : 0; }', "return k(1);"],
  // Review round 1, items 2 and 3: casts that lie answer from the value, not the cast.
  ["a number cast to undefined", "ts", "", tagOf("((1 as any) as undefined)")],
  ["a number cast to string", "ts", "", tagOf("(1 as unknown as string)")],
  ["a string cast to boolean", "ts", "", tagOf('("a" as any as boolean)')],
  ["a Boolean cast to number", "ts", "", tagOf("(true as any as number)")],
  ["`void 0` cast to number", "ts", "", tagOf("(void 0 as any as number)")],
  // Review round 3: the question whether to split looks through the same wrappers as the split.
  ["a comma ending in `void 0`, cast", "ts", "", tagOf("((0, void 0) as any)")],
  ["a comma ending in `void 0`, non-null", "ts", "", tagOf("((0, void 0)!)")],
  ["a comma ending in `void 0`, angle cast", "ts", "", tagOf("(<any>(0, void 0))")],
  ["a comma ending in `void 0`, satisfies", "ts", "", tagOf("((0, void 0) satisfies any)")],
  ["a `?:` of `void 0`, cast", "ts", "var c = 1;", tagOf("((c ? void 0 : void 0) as any)")],
];

const nodeAnswer = (declarations: string, body: string): unknown =>
  new Function(ts.transpile(`${declarations}\nfunction g() { ${body} }\nreturn g();`))();

async function compileOrdinary(ext: "js" | "ts", declarations: string, body: string, target: "gc" | "standalone") {
  const result = await compile(`${declarations}\nexport function g() { ${body} }`, {
    fileName: `test.${ext}`,
    allowJs: true,
    ...(target === "standalone" ? { target } : {}),
  });
  if (!result.success) throw new Error(result.errors.map((error) => error.message).join(" | "));
  return result;
}

/** Compile through the ordinary pipeline and call `g`; an i32 Boolean reads as a Boolean. */
async function runOrdinary(ext: "js" | "ts", declarations: string, body: string, target: "gc" | "standalone") {
  const result = await compileOrdinary(ext, declarations, body, target);
  const built = buildImports(result.imports, {}, result.stringPool);
  const imports = target === "standalone" ? {} : built;
  const { instance } = await WebAssembly.instantiate(result.binary, imports as unknown as WebAssembly.Imports);
  built.setInstance?.(instance);
  return (instance.exports.g as () => unknown)();
}

describe.each(["gc", "standalone"] as const)("#7361 — typeof answers like JavaScript (%s)", (target) => {
  it.each(PROGRAMS)("%s", async (_, ext, declarations, body) => {
    const expected = nodeAnswer(declarations, body);
    const actual = await runOrdinary(ext, declarations, body, target);
    expect(typeof expected === "boolean" ? actual === 1 || actual === true : actual).toBe(expected);
  });

  // The answer is static on the IR path; neither a void leaf nor a lying cast sends the function to legacy.
  it.each([
    ["js", "", 'return typeof void 0 === "undefined";'],
    ["js", "", 'return typeof (0, void 0) === "undefined";'],
    ["js", "var c = 1;", 'return typeof (c ? void 0 : void 0) === "undefined";'],
    ["ts", "", tagOf("(void 0 as any as number)")],
    ["ts", "", tagOf("(1 as unknown as string)")],
    ["ts", "", tagOf("((0, void 0) as any)")],
    // Only the live arm of a constant `typeof <ambient>` test is lowered, as the selector admitted.
    ["js", "", FOLDED],
    // Review round 2: `void` under an assertion outside `typeof` keeps main's operand family (parens only), so
    // these stay on the IR path as on main. Their answers are wrong on main too ("Known, not this change").
    ["ts", "", "return (void 0)! === undefined ? 1 : 2;"],
    ["ts", "", "return (void 0 as any) == null ? 1 : 2;"],
    ["ts", "", "var x: number = 1; x = (void 0 as any); return x !== x ? 1 : x === undefined ? 3 : 2;"],
  ] as const)("keeps %s `%s %s` on the IR path", async (ext, declarations, body) => {
    expect((await compileOrdinary(ext, declarations, body, target)).irCompiledFuncs).toContain("g");
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

  // The right answer returns, the wrong one throws: a pass cannot come from a check that never ran.
  // [shape, program expecting @A, node's answer, a wrong answer]
  it.each([
    ["`typeof void 0` at top level", "if (typeof void 0 !== @A) throw 1;", '"undefined"', '"number"'],
    [
      "a switch on `typeof void 0`",
      'function g() { switch (typeof void 0) { case "undefined": return 1; case "number": return 2; } return 3; }\n' +
        "if (g() !== @A) throw 1;",
      "1",
      "2",
    ],
    [
      "`?:` of two `void 0`",
      "var c = 1;\nif (typeof (c ? void 0 : void 0) !== @A) throw 1;",
      '"undefined"',
      '"number"',
    ],
    // Main answered "number" here: the selector keeps this shape off the ordinary IR path, Prepared has none.
    [
      "`?:` of `void 0` and a number",
      "var c = 1;\nif (typeof (c ? void 0 : 1) !== @A) throw 1;",
      '"undefined"',
      '"number"',
    ],
    // A nested `?:` is split at every level, not only where an arm is itself `void`.
    [
      "a nested `?:` reaching its `void 0`",
      "var c = 1, d = 1;\nif (typeof (c ? (d ? void 0 : 1) : 2) !== @A) throw 1;",
      '"undefined"',
      '"number"',
    ],
    [
      "a nested `?:` reaching its inner number",
      "var c = 1, d = 0;\nif (typeof (c ? (d ? void 0 : 1) : 2) !== @A) throw 1;",
      '"number"',
      '"undefined"',
    ],
    [
      "the number arm of that `?:`",
      "var c = 0;\nif (typeof (c ? void 0 : 1) !== @A) throw 1;",
      '"number"',
      '"undefined"',
    ],
    [
      "`void` of a throwing call",
      "function f() { throw 1; }\nvar r = 0;\ntry { typeof void f(); } catch (e) { r = 1; }\nif (r !== @A) throw 1;",
      "1",
      "0",
    ],
  ])("answers %s like JavaScript", async (_, program, right, wrong) => {
    expect(await run(program.replace("@A", right))).toBe("returned");
    expect(await run(program.replace("@A", wrong))).toBe("threw");
  });

  // A leaf beside `void` that has no static answer keeps its own refusal, by name.
  it("refuses a dynamic leaf beside a `void` leaf by name", async () => {
    const result = await compilePrepared(
      'var c = 1;\nfunction g(x) { return typeof (c ? void 0 : x); }\nif (g(1) !== "undefined") throw 1;',
      preparedOptions,
    );
    expect(result.success).toBe(false);
    expect(result.errors.map((error) => error.message).join("\n")).toContain(
      "dynamic operation dyn.typeof has no Prepared intrinsic",
    );
  });
});
