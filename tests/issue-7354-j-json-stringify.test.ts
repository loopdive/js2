// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice J — `JSON.stringify(v)` of the dynamic value on the Prepared path. On this lane the call answers the
// dynamic value (a string or `undefined`), and the dynamic-value legalization expands it per kind (`JSON_ARM`):
// QuoteJSONString (`js.value.json_quote`), Number::toString for a finite number and "null" otherwise, ToString of a
// Boolean or `null`, the `undefined` value. An object or a function aborts at run time through the named, uncatchable
// `js.value.unsupported` (a trap in `__js_value_unsupported`), which ToString of a function value shares.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IrFunction, IrInstr } from "../src/ir/core/nodes.js";
import { irDynamic, irVal } from "../src/ir/core/types.js";
import { legalizeDynamicValues } from "../src/ir/program/dynamic-value-legalization.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import { compile } from "../src/test262/test262-prepared-entry.js";
import { preparedScriptOptions, preparedScriptRefusal, runPreparedScript } from "./helpers/prepared-script-run.js";

afterEach(() => vi.restoreAllMocks());

/** node's verdict on the same script: the reference every answer is checked against. */
function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}

/** The right program returns and the wrong one throws, in node and on the Prepared path alike. */
async function expectLikeNode(program: (right: boolean) => string) {
  for (const right of [true, false]) {
    const verdict = right ? "returned" : "threw";
    expect(node(program(right))).toBe(verdict);
    expect(await runPreparedScript(program(right))).toBe(verdict);
  }
}

const STRINGIFY = "function f(v) { return JSON.stringify(v); }\n";
/** `f(operand)` against node's own answer for it; the wrong program expects a different string. */
const answers = (operand: string) => (right: boolean) => {
  const expected = JSON.stringify(new Function(`return ${operand};`)());
  const literal = expected === undefined ? "undefined" : JSON.stringify(expected);
  return `${STRINGIFY}if (f(${operand}) !== ${right ? literal : JSON.stringify(`${expected}x`)}) throw 1;`;
};

/** Run `source`'s module-init and return what it threw, if anything. */
async function thrownBy(source: string): Promise<unknown> {
  const result = await compile(source, preparedScriptOptions());
  expect(result.errors.map((error) => error.message)).toEqual([]);
  try {
    (instantiatePreparedArtifact(result).instance.exports.__module_init as (() => void) | undefined)?.();
  } catch (error) {
    return error;
  }
  return undefined;
}

/** The named abort: a trap (not a program exception), whose stack names the runtime function. */
function expectNamedAbort(error: unknown) {
  expect(error).toBeInstanceOf(WebAssembly.RuntimeError);
  expect((error as Error).stack).toContain("__js_value_unsupported");
}

describe("#7354 J — JSON.stringify of a primitive answers like JavaScript", () => {
  it.each([
    ['""'],
    ['"a"'],
    ['"\\""'],
    ['"\\\\"'],
    ['"\\b\\t\\n\\f\\r"'],
    ['"\\u0001"'],
    ['"\\u001f"'],
    ['"\\ud800"'],
    ['"\\udc00"'],
    ['"\\ud83d\\ude00"'],
    ['" "'],
    ['"a" + "\\u0002" + "b"'],
  ])("quotes the string %s", async (operand) => {
    await expectLikeNode(answers(operand));
  });

  it.each([["0"], ["-0"], ["1"], ["-1.5"], ["1e21"], ["1e-7"], ["NaN"], ["Infinity"], ["-Infinity"]])(
    "formats the number %s",
    async (operand) => {
      await expectLikeNode(answers(operand));
    },
  );

  it.each([["true"], ["false"], ["null"], ["undefined"]])("answers %s", async (operand) => {
    await expectLikeNode(answers(operand));
  });

  it("answers the undefined value, which a typeof and a concatenation read as JavaScript does", async () => {
    await expectLikeNode(
      (right) =>
        `${STRINGIFY}if (typeof f(void 0) !== ${right ? '"undefined"' : '"string"'}) throw 1;\n` +
        `if ("x" + f(undefined) !== ${right ? '"xundefined"' : '"xnull"'}) throw 2;`,
    );
  });
});

describe("#7354 J — the operand's position", () => {
  it.each([
    ["a returned call", 'function g(v) { return JSON.stringify(v); }\nif (g("q") !== EXPECTED) throw 1;', '"\\"q\\""'],
    // Both branches are dynamic values (a `string` branch beside a dynamic one is from-ast's own refusal).
    [
      "a conditional",
      "function g(v, c) { return c ? JSON.stringify(v) : v; }\nif (g(1, true) !== EXPECTED) throw 1;",
      '"1"',
    ],
    [
      "assert.js's guard",
      'function g(v) { return typeof JSON !== "undefined" ? JSON.stringify(v) : "-"; }\nif (g(null) !== EXPECTED) throw 1;',
      '"null"',
    ],
    [
      "a concatenation",
      'function g(v) { return "<" + JSON.stringify(v) + ">"; }\nif (g("a") !== EXPECTED) throw 1;',
      '"<\\"a\\">"',
    ],
  ])("answers in %s", async (_label, program, expected) => {
    await expectLikeNode((right) => program.replace("EXPECTED", right ? expected : '"wrong"'));
  });

  // harness/assert.js's own formatter (its one comment dropped): its JSON.stringify site is the one the prelude reaches.
  it("answers assert.js's formatIdentityFreeValue", async () => {
    const formatter =
      "function isNegativeZero(value) {\n  return value === 0 && 1 / value === -Infinity;\n}\n" +
      "function formatIdentityFreeValue(value) {\n" +
      "  switch (value === null ? 'null' : typeof value) {\n" +
      "    case 'string':\n" +
      "      return typeof JSON !== \"undefined\" ? JSON.stringify(value) : '\"' + value + '\"';\n" +
      "    case 'bigint':\n      return String(value) + \"n\";\n" +
      "    case 'number':\n      if (isNegativeZero(value)) return '-0';\n" +
      "    case 'boolean':\n    case 'undefined':\n    case 'null':\n      return String(value);\n  }\n}\n";
    await expectLikeNode(
      (right) =>
        `${formatter}if (formatIdentityFreeValue("a\\"b") !== ${right ? '\'"a\\\\"b"\'' : "'a\"b'"}) throw 1;\n` +
        `if (formatIdentityFreeValue(-0) !== "-0") throw 2;\nif (formatIdentityFreeValue(null) !== "null") throw 3;`,
    );
  });

  // A box proves its value's kind: the serialization takes only that kind's arm, with no kind test.
  it.each([
    ["a string", { kind: "string" }, "js.value.json_quote"],
    ["a number", irVal({ kind: "f64" }), "js.number.unbox"],
  ])("serializes a box of %s with its own arm only", (_label, type, armIntrinsic) => {
    const fn = {
      unitId: "ir-unit:test",
      name: "f",
      params: [],
      resultTypes: [],
      blocks: [
        {
          id: 0,
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            {
              kind: "call",
              target: { kind: "func", name: "v", binding: { kind: "unit", unitId: "ir-unit:v" } },
              args: [],
              result: 0,
              resultType: type,
            },
            { kind: "box", value: 0, toType: irDynamic(), result: 1, resultType: irDynamic() },
            { kind: "dyn.json_stringify", value: 1, result: 2, resultType: irDynamic() },
          ] as IrInstr[],
          terminator: { kind: "return", values: [] },
        },
      ],
      exported: false,
      valueCount: 3,
    } as unknown as IrFunction;
    const instrs = legalizeDynamicValues(fn, { fresh: () => 0 } as never).blocks[0]!.instrs;
    const ids = instrs.flatMap((instr) => (instr.kind === "intrinsic" ? [instr.id] : []));
    expect(ids).toContain(armIntrinsic);
    expect(ids.filter((id) => id.startsWith("js.value.is_"))).toEqual([]);
    expect(instrs.some((instr) => instr.kind === "if" && instr.result === 2)).toBe(false);
  });
});

// A program that creates a function value or an object compiles slowly (the source-closure and realm resources).
const SLOW = 240_000;

describe("#7354 J — a kind no arm serializes aborts by name", () => {
  // A catch-all, as `assert.throws` is, does not see the abort.
  it.each([
    ["a function value", "var o = function () {};"],
    ["an object", "var o = { a: 1 };"],
  ])(
    "aborts on %s, uncatchable by the program",
    async (_label, declaration) => {
      expectNamedAbort(await thrownBy(`${STRINGIFY}${declaration}\nf(1);\ntry { f(o); } catch (e) {}`));
    },
    SLOW,
  );

  it(
    "compiles and runs a program whose abort arm never executes",
    async () => {
      await expectLikeNode(
        (right) => `${STRINGIFY}var o = function () {};\nif (f(1) !== ${right ? '"1"' : '"2"'}) throw 1;`,
      );
    },
    SLOW,
  );

  // ToString of a function value (ToPrimitive through its `toString`) is the same abort.
  it(
    "aborts ToString of a function value the same way",
    async () => {
      expectNamedAbort(await thrownBy("var o = function () {};\ntry { String(o); } catch (e) {}"));
    },
    SLOW,
  );

  // No array enters the dynamic value yet: the operand refuses at compile time, never a wrong string.
  it("refuses an array operand by name", async () => {
    expect(await preparedScriptRefusal(`${STRINGIFY}f(1);\nf([1, 2]);`)).toContain("array literal");
  });
});
