// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice Ty — `typeof v <op> "literal"` on the Prepared dynamic value. from-ast lowers it as a string
// comparison of `dyn.typeof` with a constant; the dynamic-value legalization answers it with a tag test on `v`
// (the native `__typeof_number` / `__typeof_boolean` predicates, the `undefined` probe, the null test for
// "object"), so no string is needed. A literal no admitted kind answers ("function", "string", a typo) is
// constant. A `typeof` result used any other way still refuses as `dyn.typeof` (slice Str2).
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
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
async function expectLikeNode(program: (right: boolean) => string) {
  expect(node(program(true))).toBe("returned");
  expect(await run(program(true))).toBe("returned");
  expect(node(program(false))).toBe("threw");
  expect(await run(program(false))).toBe("threw");
}

const VALUES = ["1", "0", "-0", "0 / 0", "1 / 0", "true", "false", "undefined", "null"] as const;
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
    ["a caught null", 'var r = 0;\ntry { throw null; } catch (e) { if (typeof e === "object") r = 1; }', "r", "1"],
  ])("answers %s like JavaScript", async (_label, declarations, probe, expected) => {
    const wrong = expected === "true" ? "false" : expected === "false" ? "true" : String(Number(expected) + 1);
    await expectLikeNode((right) => `${declarations}\nif (${probe} !== ${right ? expected : wrong}) throw 1;`);
  });

  it.each([
    ["an unused typeof", "function f(v) { var s = typeof v; return 1; }\nf(1);"],
    ["a typeof statement", "function f(v) { typeof v; return 1; }\nf(1);"],
    ["a returned typeof", "function f(v) { return typeof v; }\nf(1);"],
    ["a non-literal comparison", "function f(v, w) { return typeof v === w; }\nf(1, 2);"],
    [
      "a typeof also compared with a non-literal",
      'function f(v, w) { var t = typeof v; return t === "number" && t === w; }\nf(1, 2);',
    ],
    ["a typeof also returned", 'function f(v) { var t = typeof v; if (t === "number") {} return t; }\nf(1);'],
    ["a template literal operand", 'function f(v) { return `${typeof v}` === "number"; }\nf(1);'],
    ["a concatenation", 'function f(v) { return typeof v + "" === "number"; }\nf(1);'],
  ])("refuses %s by name", async (_label, source) => {
    expect(await refusal(source)).toContain("dynamic operation dyn.typeof has no Prepared intrinsic");
  });

  it("refuses a switch on the typeof with a non-literal case by name (from-ast)", async () => {
    expect(await refusal("function f(v, w) { switch (typeof v) { case w: return 1; } return 2; }\nf(1, 2);")).toContain(
      "ir/from-ast: switch disc must lower to i32/f64 in f",
    );
  });

  // A typed operand's `typeof` is a constant string, and string constants have no Prepared runtime yet.
  it("refuses typeof of a typed value by name, as before", async () => {
    expect(await refusal('function f(v) { var n = 1; return typeof n === "number"; }\nf(1);')).toContain(
      "runtime feature js.string.const is unavailable under string-const policy storage=unsupported",
    );
  });

  it("refuses typeof of an undeclared identifier by name", async () => {
    expect(await refusal('if (typeof notDefined !== "undefined") throw 1;')).toContain(
      'ir/from-ast: identifier "notDefined" is not in scope in <module-init>',
    );
  });

  it("keeps the gc target's contract", async () => {
    expect(await refusal('function f(v) { return typeof v === "number"; }\nf(1);', "gc")).toContain(
      "function f has an unresolved parameter contract",
    );
  });
});
