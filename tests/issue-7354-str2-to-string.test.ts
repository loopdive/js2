// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice Str2 — `String(x)` and ToString on the Prepared path. The Prepared resolver plans direct calls of
// the ambient `String` (`prepareConversionResolvers`); from-ast lowers them (`tryLowerAmbientStringToStringCall`):
// a typed primitive inline, a dynamic operand through `dyn.to_string`. Every typed Number::toString is retargeted
// to the one native formatter binding (`number-to-string-target.ts`).
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
  for (const spy of [vi.spyOn(gc, "generateModule"), vi.spyOn(linear, "generateLinearModule")])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  const result = await compile(source, options());
  expect(messages(result)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

async function refusal(source: string, target: "standalone" | "gc" = "standalone") {
  const result = await compile(source, options(target));
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}

/** Each program runs with node's answer (returns) and the other one (throws). */
async function expectLikeNode(program: (right: boolean) => string) {
  expect(node(program(true))).toBe("returned");
  expect(await run(program(true))).toBe("returned");
  expect(node(program(false))).toBe("threw");
  expect(await run(program(false))).toBe("threw");
}

describe("#7354 Str2 — String(x) on the Prepared path", () => {
  it.each([
    ["a typed string", 'String("ab")', '"ab"', '"a"'],
    ["a typed true", "String(1 < 2)", '"true"', '"false"'],
    ["a typed false", "String(1 > 2)", '"false"', '"true"'],
  ])("answers String of %s", async (_label, call, right, wrong) => {
    await expectLikeNode((ok) => `var s = ${call};\nif (s !== ${ok ? right : wrong}) throw 1;`);
  });

  it("answers String(x) inside a function and in a condition", async () => {
    await expectLikeNode(
      (ok) => `function f() { var s = "x"; return String(s); }\nif ((f() === "x") !== ${ok}) throw 1;`,
    );
  });

  it.each([
    [
      // ToString's number arm calls the native formatter, which the presentation does not admit yet.
      "a dynamic operand",
      "function f(x) { return String(x); }\nf(1);",
      "host provider or async demand is outside this numeric presentation contract",
    ],
    ["no argument", "var s = String();", 'direct call to "String" has no exact AST-site plan'],
    ["String.fromCharCode", "var s = String.fromCharCode(65);", 'identifier "String" is not in scope'],
    ["new String", 'var s = new String("a");', 'unknown class "String"'],
    // An alias reads `String` as a value, which has no Prepared answer (the plan is also invalidated program-wide).
    ["a call beside an alias", 'var S = String;\nvar s = String("a");', 'identifier "String" is not in scope'],
    ["typeof String", 'if (typeof String !== "function") throw 1;', 'identifier "String" is not in scope'],
  ])("refuses %s by name", async (_label, source, expected) => {
    expect(await refusal(source)).toContain(expected);
  });

  // The `String` plan trusts that the closed program cannot rebind the ambient `String` (it is not invalidated by an
  // escape, which the harness prelude has). Each way to rebind it refuses by name, and a program declaring its own
  // `String` anywhere loses the plan (the checker reports a script's `function String` as the lib's).
  it.each([
    [
      "an assignment to String",
      'String = function () { return "x"; };\nvar s = String("a");',
      'undeclared identifier "String"',
    ],
    ["a read of globalThis", 'var g = globalThis;\nvar s = String("a");', 'identifier "globalThis" is not in scope'],
    [
      "a write through globalThis",
      'globalThis.String = function () { return "x"; };\nvar s = String("a");',
      'identifier "globalThis" is not in scope',
    ],
    [
      "the script's own function String",
      'function String(v) { return "x"; }\nvar s = String("a");',
      'direct call to "String" has no exact AST-site plan',
    ],
    [
      "a local String elsewhere",
      'function f(x) { var String = 2; return x; }\nvar s = String("a");',
      'direct call to "String" has no exact AST-site plan',
    ],
  ])("refuses %s by name", async (_label, source, expected) => {
    expect(await refusal(source)).toContain(expected);
  });

  it("loses the plan when another script declares String", async () => {
    const result = await compileMulti(
      {
        "test.js": 'function f() { return String("a"); }\nif (f() !== "x") throw 1;',
        "other.js": 'function String(v) { return "x"; }',
      },
      "test.js",
      options(),
    );
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain('direct call to "String" has no exact AST-site plan');
  });

  // A typed number is formatted by the native formatter, which the presentation does not admit yet.
  it("refuses String of a typed number by name, never with an exception", async () => {
    expect(await refusal("var s = String(1);")).toContain(
      "host provider or async demand is outside this numeric presentation contract",
    );
  });

  // The same formatter answers a template literal's number (it used to be an invariant error out of compile()).
  it("refuses a template literal's number by name, never with an exception", async () => {
    expect(await refusal("var n = 1;\nvar s = `${n}`;")).toContain(
      "host provider or async demand is outside this numeric presentation contract",
    );
  });

  it("keeps the gc target's contract", async () => {
    expect(await refusal('var s = String("a");', "gc")).not.toContain("dyn.to_string");
  });
});

// Every value the carrier holds, and node's `typeof` of it: the reference each program is checked against.
const VALUES = ["1", "-0", "0 / 0", "true", "false", "undefined", "null", "''", "'a'"] as const;
const typeofOf = (value: string): string => typeof new Function(`return ${value};`)();
// A `typeof` of a different kind than `value`'s: the wrong answer each program must throw on.
const otherTypeof = (value: string): string => (typeofOf(value) === "number" ? "string" : "number");

describe("#7354 Str2 — typeof as a value on the Prepared dynamic value", () => {
  // One program per position: every value, checked against node; the wrong program expects another kind each time.
  it.each([
    ["returned", "function t(v) { return typeof v; }", (v: string) => `t(${v})`],
    ["assigned to a local", "function t(v) { var k = typeof v; return k; }", (v: string) => `t(${v})`],
    [
      "passed as an argument",
      "function id(s) { return s; }\nfunction t(v) { return id(typeof v); }",
      (v: string) => `t(${v})`,
    ],
    ["at top level", "var g;", (v: string) => `(g = ${v}, typeof g)`],
  ])("answers typeof %s", async (_label, declarations, probe) => {
    await expectLikeNode((right) =>
      [
        declarations,
        ...VALUES.map((v) => `if (${probe(v)} !== "${right ? typeofOf(v) : otherTypeof(v)}") throw 1;`),
      ].join("\n"),
    );
  });

  it.each([
    ["concatenated with a typed string", 'function t(v) { return "x" + typeof v; }', "t(null)", '"xobject"', '"xnull"'],
    ["compared with a non-literal", "function t(v, k) { return typeof v === k; }", 't(1, "number")', "true", "false"],
    [
      "compared with a non-literal (miss)",
      "function t(v, k) { return typeof v === k; }",
      't(1, "string")',
      "false",
      "true",
    ],
    // Ty refused this; it was a wrong answer once. Same kinds, different kinds, and null against undefined.
    [
      "two typeofs (same kind)",
      "function t(v, w) { return typeof v === typeof w; }",
      "t(true, false)",
      "true",
      "false",
    ],
    ["two typeofs (other kind)", "function t(v, w) { return typeof v === typeof w; }", 't(1, "1")', "false", "true"],
    [
      "two typeofs (null, undefined)",
      "function t(v, w) { return typeof v !== typeof w; }",
      "t(null, undefined)",
      "true",
      "false",
    ],
    [
      "a typeof also compared with a literal",
      'function t(v, w) { var k = typeof v; return k === "number" && k === w; }',
      't(1, "number")',
      "true",
      "false",
    ],
    [
      "across loop iterations",
      'function t(v) { var c = 0; for (var i = 0; i < 3; i++) { var k = typeof v; if (k === "number") c = c + 1; v = i === 0 ? "s" : 1; } return c; }',
      "t(1)",
      "2",
      "3",
    ],
    [
      "the prelude's switch (formatIdentityFreeValue)",
      "function f(value) { switch (value === null ? 'null' : typeof value) { case 'string': return 1; case 'number': return 2; case 'boolean': case 'undefined': case 'null': return 3; } return 4; }",
      'f("a") * 10000 + f(1) * 1000 + f(true) * 100 + f(null) * 10 + f(undefined)',
      "12333",
      "12334",
    ],
  ])("answers typeof %s", async (_label, declarations, probe, right, wrong) => {
    await expectLikeNode((ok) => `${declarations}\nif (${probe} !== ${ok ? right : wrong}) throw 1;`);
  });

  // The operand is evaluated once, even when the answer is unused (statement position, or a local nobody reads).
  it.each([
    ["a typeof statement", "typeof g(v);"],
    ["an unread local", "var s = typeof g(v);"],
  ])("evaluates the operand of %s", async (_label, statement) => {
    await expectLikeNode(
      (right) =>
        `function g(v) { if (v === 1) throw 7; return v; }\nfunction t(v) { ${statement} return 1; }\n` +
        `var r = 0;\ntry { t(1); } catch (e) { r = 1; }\nif (r !== ${right ? 1 : 0}) throw 1;`,
    );
  });
});
