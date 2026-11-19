// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice Ty — `typeof v <op> "literal"` on the Prepared dynamic value. from-ast lowers it as a string
// comparison of `dyn.typeof` with a constant; the dynamic-value legalization answers it with a tag test on `v`
// (the native `__typeof_number` / `__typeof_boolean` predicates, the `undefined` probe, the null test for
// "object"), so no string is needed. A literal no admitted kind answers ("function", a typo) is constant. Strings
// are admitted (slice Str) but the native lane has no string predicate yet, so a test for "string" refuses by name.
// A `typeof` result used any other way still refuses as `dyn.typeof` (slice Str2).
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { NATIVE_REALM_GLOBALS, nativeRealmGlobalTypeof } from "../src/runtime/contracts/native-realm-globals.js";
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

async function refusal(source: string, target: "standalone" | "gc" = "standalone") {
  const result = await compile(source, options(target));
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
async function expectLikeNode(program: (right: boolean) => string, warnings: readonly unknown[] = []) {
  expect(node(program(true))).toBe("returned");
  expect(await run(program(true), warnings as string[])).toBe("returned");
  expect(node(program(false))).toBe("threw");
  expect(await run(program(false), warnings as string[])).toBe("threw");
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
  it.each(LITERALS)(
    'answers typeof v <op> "%s" like JavaScript',
    async (literal) => {
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
      // (#7354 Str2 merge) Two compiles of ~180 checks with string values: about 15 s alone, more under load.
    },
    120_000,
  );

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

  // The string dispatch compares only literal tests; any other case test (first, last, only, or a call) refuses by
  // name instead of being skipped — never compared, its expression never evaluated (a wrong answer, review round 1).
  it.each([
    [
      "last",
      'function t(v) { var s = "boolean"; switch (typeof v) { case "number": return 1; case s: return 2; } return 3; }\nt(true);',
    ],
    [
      "first",
      'function t(v, w) { switch (typeof v) { case w: return 1; case "number": return 2; } return 3; }\nt(1, 2);',
    ],
    ["only", "function t(v, w) { switch (typeof v) { case w: return 1; } return 3; }\nt(1, 2);"],
    [
      "a call with a side effect",
      'var n = 0;\nfunction g(w) { n = 1; return w; }\nfunction t(v) { switch (typeof v) { case "number": return 1; case g(v): return 2; } return 3; }\nt(true);',
    ],
    [
      "a numeric switch's",
      "function t(v) { var k = 1; switch (v * 1) { case 1: return 1; case k: return 2; } return 3; }\nt(1);",
    ],
  ])("refuses a non-literal case test (%s) by name", async (_label, source) => {
    expect(await refusal(source)).toContain("ir/from-ast: switch-case-test-nonliteral in t");
  });

  // A numeric test never matches a string discriminant (strict equality); one ladder cannot hold both (review RV7305).
  it("refuses a switch mixing numeric and string case tests by name", async () => {
    expect(
      await refusal('function t(v) { switch (v) { case 1: return 1; case "a": return 2; } return 3; }\nt("a");'),
    ).toContain("ir/from-ast: switch-case-test-mixed in t");
  });

  // A guard narrows the parameter's reference to `number`, but the parameter still holds the dynamic value, so the
  // result is the dynamic value too (review RV7305: the narrowed `f64` result contract was an invariant error).
  it.each([
    ["an if", 'function f(x) { if (typeof x === "number") return x; return 0; }'],
    ["a conditional", 'function f(x) { return typeof x === "number" ? x : 0; }'],
    ["a local", 'function f(x) { if (typeof x === "number") { var r = x; return r; } return 0; }'],
  ])("returns a parameter narrowed by %s like JavaScript", async (_label, declaration) => {
    await expectLikeNode((right) => `${declaration}\nif (f(5) !== ${right ? 5 : 6} || f("a") !== 0) throw 1;`);
  });

  it("answers a switch on the typeof with the default clause in the middle", async () => {
    await expectLikeNode(
      (right) =>
        'function t(v) { switch (typeof v) { case "number": return 1; default: return 4; case "boolean": return 2; } }\n' +
        `if (t(true) * 10 + t(null) !== ${right ? 24 : 21}) throw 1;`,
    );
  });

  // A typed operand's `typeof` is a constant string; with string constants and equality on the Prepared path
  // (slice Str) it compares like any two strings.
  it.each([
    ["number", "var n = 1;"],
    ["Boolean", "var n = true;"],
    ["string", 'var n = "a";'],
  ])("answers typeof of a typed %s like JavaScript", async (_label, declaration) => {
    const functions = ["number", "boolean", "string", "object"].map((literal) => {
      const body = `${declaration} return typeof n === "${literal}";`;
      return { name: `f${literal}`, body, expected: answer(`(function () { ${body} })()`) };
    });
    await expectLikeNode((right) =>
      functions
        .map(({ name, body, expected }) => {
          const sent = right ? expected : String(expected !== "true");
          return `function ${name}() { ${body} }\nif (${name}() !== ${sent}) throw 1;`;
        })
        .join("\n"),
    );
  });

  it("keeps the gc target's contract", async () => {
    expect(await refusal('function f(v) { return typeof v === "number"; }\nf(1);', "gc")).toContain(
      "function f has an unresolved parameter contract",
    );
  });
});

// #7354 Ty step 2 — `typeof` of a global the program does not declare answers like ECMAScript: the realm catalog's
// tag for an ES global (`nativeRealmGlobalTypeof`, the one table), "undefined" for a name nothing declares, and a
// named refusal for a lib-only name the catalog lacks (a host global). Never a wrong answer.
describe("#7354 Ty — typeof of a global the program does not declare, on the Prepared path", () => {
  it.each([
    ["the assert.js conditional", 'function f(v) { return typeof JSON !== "undefined" ? 1 : 2; }', "f(0)", "1"],
    ["a condition", 'var r = 0;\nif (typeof JSON !== "undefined") r = 1;', "r", "1"],
    ["a reversed condition", 'var r = 0;\nif ("undefined" === typeof Math) r = 1;', "r", "0"],
    ["a value-position boolean", 'function f(v) { return typeof JSON === "undefined"; }', "f(0)", "false"],
    ["a top-level value", 'var r = typeof Reflect !== "object";', "r", "false"],
    ["a parenthesized operand", 'var r = typeof (JSON) === "object";', "r", "true"],
    [
      "a switch",
      'var r = 0;\nswitch (typeof Math) { case "object": r = 1; break; case "undefined": r = 2; }',
      "r",
      "1",
    ],
    // A program binding keeps its own answer: a parameter, and a dynamic local, named like the global.
    ["a parameter named Math", 'function f(Math) { return typeof Math === "number"; }', "f(1)", "true"],
    ["a local named JSON", 'function f(v) { var JSON = v; return typeof JSON === "boolean"; }', "f(true)", "true"],
  ])("answers %s like JavaScript", async (_label, declarations, probe, expected) => {
    const wrong = expected === "true" ? "false" : expected === "false" ? "true" : expected === "2" ? "1" : "2";
    await expectLikeNode((right) => `${declarations}\nif (${probe} !== ${right ? expected : wrong}) throw 1;`);
  });

  // The live arm is lowered now: `JSON.stringify` refuses by name on this path.
  it("lowers the assert.js conditional's live arm", async () => {
    expect(
      await refusal('function f(v) { return typeof JSON !== "undefined" ? JSON.stringify(v) : 2; }\nf(0);'),
    ).toContain("dynamic operation dyn.json_stringify has no Prepared intrinsic");
  });

  // H's dynamic home: `undefined` before the assignment, the value's type after (TypeScript warns).
  it("answers a hoisted var like JavaScript", async () => {
    const program = (right: boolean) =>
      `if ((typeof v === "undefined") !== ${right}) throw 1;\nvar v = 1;\nif (typeof v !== "number") throw 2;`;
    await expectLikeNode(program, [expect.stringContaining("Variable 'v' is used before being assigned")]);
  });

  // An undeclared name is legal JavaScript; TypeScript warns, the program compiles and answers like node.
  it("answers an undeclared identifier like JavaScript", async () => {
    const program = (right: boolean) =>
      `function f() { return typeof notDeclared === "undefined"; }\nif (f() !== ${right}) throw 1;`;
    await expectLikeNode(program, [expect.stringContaining("Cannot find name 'notDeclared'")]);
  });

  it("answers a var declaring the global's name with the program's binding", async () => {
    const program = (right: boolean) => `var JSON = 1;\nif ((typeof JSON === "number") !== ${right}) throw 1;`;
    await expectLikeNode(program, [
      expect.stringContaining("Subsequent variable declarations must have the same type"),
    ]);
  });

  // A program declaration the read path cannot resolve yet is not a lib global: it refuses by name.
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
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain('identifier "Y" is not in scope in g');
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

  // The pin: every global of the realm catalog answers its tag, which is node's where node has the global.
  it.each(
    NATIVE_REALM_GLOBALS.map(({ name }) => name).filter((name) => !["undefined", "NaN", "Infinity"].includes(name)),
  )("answers typeof of the ES global %s from the realm catalog", async (name) => {
    const tag = nativeRealmGlobalTypeof(name)!;
    const host = (globalThis as Record<string, unknown>)[name];
    if (host !== undefined) expect(typeof host).toBe(tag);
    await expectAnswerTag(name, tag);
  });

  // A lib-only name outside the catalog (a host global) refuses by name, in a comparison and in a fold.
  it.each([
    `if (typeof document !== "undefined") throw 1;`,
    `function f() { return typeof document !== "undefined" ? 1 : 2; }\nf();`,
  ])("refuses typeof of the host global document by name: %s", async (source) => {
    expect(await refusal(source)).toContain("typeof of the host global document has no Prepared answer");
  });
});

async function expectAnswerTag(name: string, tag: string) {
  expect(await run(`if (typeof ${name} !== "${tag}") throw 1;`)).toBe("returned");
  expect(await run(`if (typeof ${name} === "${tag}") throw 1;`)).toBe("threw");
}
