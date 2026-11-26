// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice Ty — `typeof v <op> "literal"` on the Prepared dynamic value. from-ast lowers it as a string
// comparison of `dyn.typeof` with a constant; the dynamic-value legalization answers it with a tag test on `v`
// (the native `__typeof_number` / `__typeof_boolean` predicates, the `undefined` probe, the null test for
// "object"), so no string is needed. A literal no admitted kind answers ("function", "string", a typo) is
// constant. A `typeof` result used any other way still refuses as `dyn.typeof` (slice Str2).
import { setImmediate } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { AMBIENT_TYPEOF_TAGS } from "../src/ir/ambient-typeof.js";
import { NATIVE_ERROR_CONSTRUCTORS } from "../src/runtime/contracts/native-realm-catalog.js";
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
async function run(source: string, warnings: readonly string[] = []): Promise<"returned" | "threw"> {
  for (const spy of [vi.spyOn(gc, "generateModule"), vi.spyOn(linear, "generateLinearModule")])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  const result = await compile(source, options());
  expect(messages(result)).toEqual(warnings);
  expect(requiredPreparedEmission(result)).toBeDefined();
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    return "returned";
  } catch (error) {
    expect((error as object).constructor.name).toBe("Exception");
    return "threw";
  }
}

/**
 * The name the path refuses `source` by. (#7354 U) Compiled without abort bodies: under them a refusal inside a
 * function becomes that function's abort body, which never runs the refused use either.
 */
async function refusal(source: string, target: "standalone" | "gc" = "standalone") {
  const result = await compile(source, options(target), undefined, "refuse");
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

/** node's verdict on the same script: the reference every answer is checked against. */
function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}

/** Each program runs with node's answer (returns) and the other one (throws): a pass cannot come from a check that never ran. */
async function expectLikeNode(program: (right: boolean) => string) {
  expect(node(program(true))).toBe("returned");
  expect(await run(program(true))).toBe("returned");
  expect(node(program(false))).toBe("threw");
  expect(await run(program(false))).toBe("threw");
}

// (#7354 Str2 merge) Slice Str admitted native strings into the carrier, so `typeof v === "string"` is a real tag test.
const VALUES = ["1", "0", "-0", "0 / 0", "1 / 0", "true", "false", "undefined", "null", "''", "'a'"] as const;
const LITERALS = ["number", "boolean", "undefined", "object", "function", "string", "symbol", "bigint"] as const;
const OPERATORS = ["===", "!==", "==", "!="] as const;
const answer = (expression: string): string => String(new Function(`return ${expression};`)());

describe("#7354 Ty — typeof comparisons on the Prepared dynamic value", () => {
  it("answers isPrimitive (harness/assert.js) for every admitted value", async () => {
    const isPrimitive =
      "function isPrimitive(value) {\n  return !value || (typeof value !== 'object' && typeof value !== 'function');\n}\n";
    // Every value the carrier holds is primitive; the wrong program expects the opposite of each.
    await expectLikeNode((right) =>
      [isPrimitive, ...["1.5", "0", "0 / 0", "true", "false", "undefined", "null"]].reduce(
        (source, value) => `${source}if (isPrimitive(${value}) !== ${right}) throw 1;\n`,
      ),
    );
  });

  // One program per literal: every operator, both operand orders, every value. `bad` counts the answers that
  // differ from node's; the wrong program expects every answer negated, so each check must have run.
  it.each(LITERALS)('answers typeof v <op> "%s" like JavaScript', async (literal) => {
    const functions = OPERATORS.flatMap((op, index) => [
      `function l${index}(v) { return typeof v ${op} "${literal}"; }`,
      `function r${index}(v) { return "${literal}" ${op} typeof v; }`,
    ]);
    const checks = (right: boolean) =>
      OPERATORS.flatMap((op, index) =>
        VALUES.flatMap((value) => {
          const expected = answer(`typeof (${value}) ${op} "${literal}"`);
          const sent = right ? expected : String(expected !== "true");
          return [
            `if (l${index}(${value}) !== ${sent}) bad = bad + 1;`,
            `if (r${index}(${value}) !== ${sent}) bad = bad + 1;`,
          ];
        }),
      );
    await expectLikeNode((right) =>
      [...functions, "var bad = 0;", ...checks(right), "if (bad !== 0) throw bad;"].join("\n"),
    );
  });

  // TypeScript warns (the literal is outside `typeof`'s answers) but the program compiles; JavaScript says false.
  it("answers a literal no value has (a typo) as false", async () => {
    const program = (right: boolean) =>
      `function t(v) { return typeof v === "nonsense"; }\nfunction u(v) { return typeof v !== "nonsense"; }\n` +
      `if (t(1) !== ${!right} || u(null) !== ${right}) throw 1;`;
    const warnings = Array.from({ length: 2 }, () => expect.stringContaining(`and '"nonsense"' have no overlap`));
    expect(node(program(true))).toBe("returned");
    expect(await run(program(true), warnings)).toBe("returned");
    expect(node(program(false))).toBe("threw");
    expect(await run(program(false), warnings)).toBe("threw");
  });

  it("evaluates the operand exactly once, even when the answer is constant", async () => {
    await expectLikeNode(
      (right) =>
        "var calls = 0;\nfunction f(v) { calls = calls + 1; return v; }\n" +
        'if (typeof f(1) === "function") throw 1;\nif (typeof f(undefined) !== "undefined") throw 2;\n' +
        `if (calls !== ${right ? 2 : 1}) throw 3;`,
    );
  });

  it.each([
    ["`&&`", 'function t(v) { return typeof v !== "object" && typeof v !== "number"; }', "t(true)", "true"],
    ["`||`", 'function t(v) { return typeof v === "boolean" || typeof v === "undefined"; }', "t(undefined)", "true"],
    ["`?:`", 'function t(v) { return typeof v === "number" ? 1 : 2; }', "t(0 / 0)", "1"],
    ["a negation", 'function t(v) { return !(typeof v == "object"); }', "t(null)", "false"],
    [
      "a loop condition",
      'function t(v) { var n = 0; while (typeof v === "number" && n < 3) n = n + 1; return n; }',
      "t(-0)",
      "3",
    ],
    ["an `if`", 'function t(v) { if (typeof v != "undefined") return 1; return 2; }', "t(false)", "1"],
    ["a top-level condition", 'var v = null;\nvar r = 0;\nif (typeof v === "object") r = 1;', "r", "1"],
    // Without an initializer the script var has the dynamic home (H); `var v = 1 / 0` would be typed.
    ["a top-level value", 'var v;\nv = 1 / 0;\nvar r = "number" === typeof v;', "r", "true"],
    // The local is an SSA value, so its only uses are the comparisons.
    ["a local holding the typeof", 'function t(v) { var k = typeof v; return k === "boolean"; }', "t(false)", "true"],
    [
      "a switch on the typeof with literal cases",
      'function t(v) { switch (typeof v) { case "number": case "boolean": return 1; case "object": return 2; default: return 3; } }',
      "t(true) * 100 + t(null) * 10 + t(undefined)",
      "123",
    ],
    // (#7354 Str2 merge) No native string pack: no string can reach the carrier, the string test is constant false.
    ["a string test with no string in the program", 'function t(v) { return typeof v === "string"; }', "t(1)", "false"],
    ["a caught null", 'var r = 0;\ntry { throw null; } catch (e) { if (typeof e === "object") r = 1; }', "r", "1"],
    // The number test alone (no box anywhere) still selects the value resources it binds.
    [
      "a caught null tested for a number",
      'var r = 0;\ntry { throw null; } catch (e) { if (typeof e === "number") r = 1; }',
      "r",
      "0",
    ],
  ])("answers %s like JavaScript", async (_label, declarations, probe, expected) => {
    const wrong = expected === "true" ? "false" : expected === "false" ? "true" : String(Number(expected) + 1);
    await expectLikeNode((right) => `${declarations}\nif (${probe} !== ${right ? expected : wrong}) throw 1;`);
  });

  // (#7354 Str2) A `typeof` read any other way (assigned, returned, concatenated, compared with a non-literal or with
  // another `typeof`) is its answer string now: tests/issue-7354-str2-to-string.test.ts proves each position.

  // The string dispatch compares only literal tests. (#7354 L0b) Any other case test (first, last, only, or a call) takes
  // the carrier dispatch: compared by strict equality, evaluated lazily in source order (review round 1 of Ty refused
  // them, rather than skip one).
  it.each([
    [
      "last",
      'function t(v) { var s = "boolean"; switch (typeof v) { case "number": return 1; case s: return 2; } return 3; }',
      "t(true) * 100 + t(1) * 10 + t(null)",
    ],
    [
      "first",
      'function t(v, w) { switch (typeof v) { case w: return 1; case "number": return 2; } return 3; }',
      't(1, 2) * 100 + t(1, "number") * 10 + t(true, 2)',
    ],
    ["only", "function t(v, w) { switch (typeof v) { case w: return 1; } return 3; }", 't(1, 2) * 10 + t(1, "number")'],
    [
      "a call with a side effect",
      'var n = 0;\nfunction g(w) { n = n + 1; return w; }\nfunction t(v) { switch (typeof v) { case "number": return 1; case g(v): return 2; } return 3; }',
      't(true) * 1000 + t(1) * 100 + t("boolean") * 10 + n',
    ],
    [
      "a numeric switch's",
      "function t(v) { var k = 1; switch (v * 1) { case 2: return 1; case k: return 2; } return 3; }",
      "t(1) * 100 + t(2) * 10 + t(3)",
    ],
  ])("answers a non-literal case test (%s) like JavaScript", async (_label, functions, probe) => {
    const expected = Number(new Function(`${functions}\nreturn ${probe};`)());
    await expectLikeNode((right) => `${functions}\nif (${probe} !== ${right ? expected : expected + 1}) throw 1;`);
  });

  it("answers a switch on the typeof with the default clause in the middle", async () => {
    await expectLikeNode(
      (right) =>
        'function t(v) { switch (typeof v) { case "number": return 1; default: return 4; case "boolean": return 2; } }\n' +
        `if (t(true) * 10 + t(null) !== ${right ? 24 : 21}) throw 1;`,
    );
  });

  // A typed operand's `typeof` is a constant string; (#7354 Str2 merge) slice Str gave string constants and their
  // equality a Prepared runtime, so the comparison is answered (it used to refuse at js.string.const).
  it("answers typeof of a typed value", async () => {
    await expectLikeNode(
      (right) => `function f(v) { var n = 1; return typeof n === "number"; }\nif (f(1) !== ${right}) throw 1;`,
    );
  });

  it("keeps the gc target's contract", async () => {
    expect(await refusal('function f(v) { return typeof v === "number"; }\nf(1);', "gc")).toContain(
      "function f has an unresolved parameter contract",
    );
  });
});

/** This environment's answer (not node's): the program runs with it, and throws with the other one. */
async function expectAnswer(program: (right: boolean) => string, warnings: readonly unknown[] = []) {
  expect(await run(program(true), warnings as string[])).toBe("returned");
  expect(await run(program(false), warnings as string[])).toBe("threw");
}

// #7354 Ty step 2 — `typeof` of a global the program does not declare. (#7354 T) Only a name nothing declares (not
// the program, not the standard library) is absent and answers "undefined", as in node; a standard global this path
// does not provide refuses by name (the pin below, for every name of the ambient `typeof` table).
describe("#7354 Ty — typeof of an absent global on the Prepared path", () => {
  // (#7354 T) These used a standard global (`JSON`, `Math`, `Reflect`), whose "undefined" was not node's answer; over
  // a name nothing declares it is (TypeScript warns once per mention).
  it.each([
    ["the assert.js conditional", 'function f(v) { return typeof zzz !== "undefined" ? 1 : 2; }', "f(0)", "2", 1],
    // The dead arm is not lowered: `zzz.stringify` alone refuses on this path.
    [
      "the assert.js conditional with its dead arm",
      'function f(v) { return typeof zzz !== "undefined" ? zzz.stringify(v) : 2; }',
      "f(0) === 2",
      "true",
      2,
    ],
    ["a condition", 'var r = 0;\nif (typeof zzz !== "undefined") r = 1;', "r", "0", 1],
    ["a reversed condition", 'var r = 0;\nif ("undefined" === typeof zzz) r = 1;', "r", "1", 1],
    ["a value-position boolean", 'function f(v) { return typeof zzz === "undefined"; }', "f(0)", "true", 1],
    ["a top-level value", 'var r = typeof zzz !== "object";', "r", "true", 1],
    ["a parenthesized operand", 'var r = typeof (zzz) === "undefined";', "r", "true", 1],
  ] as const)("answers %s over a name nothing declares", async (_label, declarations, probe, expected, mentions) => {
    const wrong = expected === "true" ? "false" : expected === "2" ? "1" : expected === "0" ? "1" : "0";
    const warnings = Array.from({ length: mentions }, () => expect.stringContaining("Cannot find name 'zzz'"));
    await expectAnswer((right) => `${declarations}\nif (${probe} !== ${right ? expected : wrong}) throw 1;`, warnings);
  });

  it.each([
    // A program binding keeps its own answer: a parameter, and a dynamic local, named like the global.
    ["a parameter named Math", 'function f(Math) { return typeof Math === "number"; }', "f(1)", "true"],
    ["a local named JSON", 'function f(v) { var JSON = v; return typeof JSON === "boolean"; }', "f(true)", "true"],
  ])("answers %s", async (_label, declarations, probe, expected) => {
    const wrong = expected === "true" ? "false" : expected === "false" ? "true" : expected === "2" ? "1" : "2";
    await expectAnswer((right) => `${declarations}\nif (${probe} !== ${right ? expected : wrong}) throw 1;`);
  });

  // H's dynamic home: `undefined` before the assignment, the value's type after (TypeScript warns).
  it("answers a hoisted var like JavaScript", async () => {
    const program = (right: boolean) =>
      `if ((typeof v === "undefined") !== ${right}) throw 1;\nvar v = 1;\nif (typeof v !== "number") throw 2;`;
    expect(node(program(true))).toBe("returned");
    await expectAnswer(program, [expect.stringContaining("Variable 'v' is used before being assigned")]);
  });

  // An undeclared name is legal JavaScript; TypeScript warns, the program compiles and answers like node.
  it("answers an undeclared identifier like JavaScript", async () => {
    const program = (right: boolean) =>
      `function f() { return typeof notDeclared === "undefined"; }\nif (f() !== ${right}) throw 1;`;
    expect(node(program(true))).toBe("returned");
    await expectAnswer(program, [expect.stringContaining("Cannot find name 'notDeclared'")]);
  });

  it("answers a var declaring the global's name with the program's binding", async () => {
    const program = (right: boolean) => `var JSON = 1;\nif ((typeof JSON === "number") !== ${right}) throw 1;`;
    expect(node(program(true))).toBe("returned");
    await expectAnswer(program, [expect.stringContaining("Subsequent variable declarations must have the same type")]);
  });

  // A program declaration the read path cannot resolve yet is not absent: it refuses by name, never "undefined".
  it("refuses typeof of a script function declaration named like the global by name", async () => {
    expect(await refusal('function JSON() {}\nif (typeof JSON !== "function") throw 1;')).toContain(
      'identifier "JSON" is not in scope',
    );
  });

  it("refuses typeof of a function another script declares by name", async () => {
    const result = await compileMulti(
      {
        "test.js": 'function g() { return typeof Y === "function"; }\nif (!g()) throw 1;',
        "other.js": "function Y() {}",
      },
      "test.js",
      options(),
    );
    // (#7354 U) The refusal is g's: g's body is the run-time abort, named by it, and the call of g ends there.
    expect(messages(result)).toEqual([]);
    expect(requiredPreparedAbortBodies(result)!.map((row) => row.detail)).toEqual([
      expect.stringContaining('identifier "Y" is not in scope in g'),
    ]);
    let trap: unknown;
    try {
      (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
    } catch (error) {
      trap = error;
    }
    expect((trap as Error | undefined)?.constructor.name).toBe("RuntimeError");
  });

  it("refuses typeof of a let in its TDZ by name", async () => {
    expect(
      await refusal('function f() { if (typeof x !== "undefined") return 1; let x = 1; return 2; }\nf();'),
    ).toContain("Cannot access 'x' before initialization");
  });

  it("keeps the gc target's contract", async () => {
    expect(await refusal('if (typeof JSON !== "undefined") throw 1;', "gc")).toContain(
      'identifier "JSON" is not in scope',
    );
  });

  // (#7354 T) A standard global is never absent: whether or not this path provides it yet, `typeof` refuses it by
  // name rather than answer "undefined" (node answers its real type).
  // (#7354 G1) but an Error constructor, which the realm holds as a value (tests/issue-7354-t2-typeof-standard-globals).
  const unprovided = Object.keys(AMBIENT_TYPEOF_TAGS).filter(
    (name) => !(NATIVE_ERROR_CONSTRUCTORS as readonly string[]).includes(name),
  );
  it.each(unprovided)("refuses typeof of the standard global %s by name", async (name) => {
    expect(await refusal(`if (typeof ${name} !== "undefined") throw 1;`)).toContain(
      `identifier "${name}" is not in scope`,
    );
  });
});
