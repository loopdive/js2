// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice Str2 — `String(x)` and ToString on the Prepared path. The Prepared resolver plans direct calls of
// the ambient `String` (`prepareConversionResolvers`); from-ast lowers them (`tryLowerAmbientStringToStringCall`):
// a typed primitive inline, a dynamic operand through `dyn.to_string`. Every typed Number::toString is retargeted
// to the one native formatter binding (`number-to-string-target.ts`).
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  compileMulti,
  requiredPreparedAbortBodies,
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

// A compile runs synchronously for seconds; yielding a macrotask between tests lets the worker answer vitest's RPC.
afterEach(async () => {
  vi.restoreAllMocks();
  await setImmediate();
});

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
    // (#7354 Str2 review 1) `String()` is "", and a literal null / undefined operand is a known kind.
    ["no argument", "String()", '""', '" "'],
    ["a literal null", "String(null)", '"null"', '"nul"'],
    ["a literal undefined", "String(undefined)", '"undefined"', '"null"'],
    ["void 0", "String(void 0)", '"undefined"', '""'],
  ])("answers String of %s", async (_label, call, right, wrong) => {
    await expectLikeNode((ok) => `var s = ${call};\nif (s !== ${ok ? right : wrong}) throw 1;`);
  });

  // A program with no other dynamic value: the literal's box is the only one (once "no accepted host async dynamic
  // carrier"), read directly in a condition, inside a function, and unused.
  it.each([
    ["String(null) in a condition", (ok: boolean) => `if (String(null) !== ${ok ? '"null"' : '"nul"'}) throw 1;`],
    [
      "String(undefined) in a condition",
      (ok: boolean) => `if (String(undefined) !== ${ok ? '"undefined"' : '""'}) throw 1;`,
    ],
    ["String() in a condition", (ok: boolean) => `if (String() !== ${ok ? '""' : '"x"'}) throw 1;`],
    [
      "both in a function",
      (ok: boolean) =>
        `function f() { return String(null) + String() + String(undefined); }\nif (f() !== ${ok ? '"nullundefined"' : '"null"'}) throw 1;`,
    ],
    [
      "an unused String(null) beside a throwing call",
      (ok: boolean) =>
        `var n = 0;\nfunction h() { n = n + 1; return null; }\nString(h());\nString(null);\nif (n !== ${ok ? 1 : 0}) throw 1;`,
    ],
  ])("answers %s", async (_label, program) => {
    await expectLikeNode(program);
  });

  it("answers String(x) inside a function and in a condition", async () => {
    await expectLikeNode(
      (ok) => `function f() { var s = "x"; return String(s); }\nif ((f() === "x") !== ${ok}) throw 1;`,
    );
  });

  // (#7350 B3a) `String` is the realm's function object: the members and `new` it lacks refuse by name.
  it.each([
    [
      "String.fromCharCode",
      "var s = String.fromCharCode(65);",
      "String.fromCharCode is not reachable on this path yet (#7350 B3bc)",
    ],
    ["new String", 'var s = new String("a");', "new String (a wrapper object; #7350 B3bc)"],
  ])("refuses %s by name", async (_label, source, expected) => {
    expect(await refusal(source)).toContain(expected);
  });

  // (#7350 B3a) A second argument calls through the realm's value (evaluated, then ignored; `@ts-ignore` silences the
  // checker's arity warning, which `run` counts), an alias beside the call keeps the plan (the realm's `String` is
  // pristine), and `typeof String` is "function".
  it.each([
    [
      "two arguments",
      (ok: boolean) => `// @ts-ignore\nvar s = String("a", "b");\nif (s !== ${ok ? '"a"' : '"b"'}) throw 1;`,
    ],
    [
      "a call beside an alias",
      (ok: boolean) => `var S = String;\nvar s = String("a");\nif ((s === "a" && S === String) !== ${ok}) throw 1;`,
    ],
    ["typeof String", (ok: boolean) => `if ((typeof String === "function") !== ${ok}) throw 1;`],
  ])("answers %s", async (_label, program) => {
    await expectLikeNode(program);
  });

  // The `String` plan holds while the realm's `String` is pristine (it is not invalidated by a value read, which the
  // harness prelude has). Each way to rebind it refuses by name, and a program declaring its own `String` anywhere loses
  // the plan (the checker reports a script's `function String` as the lib's).
  it.each([
    [
      "an assignment to String",
      'String = function () { return "x"; };\nvar s = String("a");',
      'undeclared identifier "String"',
    ],
    // `g` is read, so the #3418 dead-binding elision (#7354 F0) keeps its statement.
    [
      "a read of globalThis",
      'var g = globalThis;\nvar s = String("a");\nvar t = g;',
      'identifier "globalThis" is not in scope',
    ],
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
    // (#7354 U) The refusal is f's: f's body is the run-time abort, named by it, and the call of f ends there.
    expect(messages(result)).toEqual([]);
    expect(requiredPreparedAbortBodies(result)!.map((row) => row.detail)).toEqual([
      expect.stringContaining('direct call to "String" has no exact AST-site plan'),
    ]);
    let trap: unknown;
    try {
      (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    } catch (error) {
      trap = error;
    }
    expect((trap as Error | undefined)?.constructor.name).toBe("RuntimeError");
  });

  // (#7354 Str2-c) The native formatter is admitted: a typed number, a dynamic operand's number arm, and a template
  // literal's number (once an invariant error out of compile()) format like node.
  it.each([
    ["a typed number", "var s = String(1.5);", '"1.5"', '"1.50"'],
    ["a dynamic operand", "function f(x) { return String(x); }\nvar s = f(-0);", '"0"', '"-0"'],
    ["a template literal's number", "var n = 1e21;\nvar s = `${n}`;", '"1e+21"', '"1e21"'],
  ])("answers String of %s", async (_label, program, right, wrong) => {
    await expectLikeNode((ok) => `${program}\nif (s !== ${ok ? right : wrong}) throw 1;`);
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
