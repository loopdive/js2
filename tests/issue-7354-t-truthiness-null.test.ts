// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice T — ToBoolean and `null` on the Prepared dynamic value. ToBoolean is the intrinsic
// `js.value.to_boolean`, whose native function is the ordinary pipeline's `__is_truthy` body (one shared
// builder). `null` is the carrier's null reference, as on the ordinary standalone pipeline, so it stays apart
// from the `undefined` singleton under strict equality and the `undefined` probe; `=== null` is `ref.is_null`.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { legalizeDynamicValues } from "../src/ir/program/dynamic-value-legalization.js";
import type { IrFunction, IrInstr } from "../src/ir/core/nodes.js";
import { JS_TAG_IDS } from "../src/ir/runtime/js-tag-domain.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (target: "standalone" | "gc" = "standalone", fileName = "test.js"): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target,
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName,
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

async function refusal(source: string, target: "standalone" | "gc" = "standalone", fileName?: string) {
  const result = await compile(source, options(target, fileName));
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

const VALUES = ["1.5", "0", "-0", "0 / 0", "1", "1 / 0", "true", "false", "undefined", "null"] as const;
const value = (text: string): unknown => new Function(`return ${text};`)();

describe("#7354 T — ToBoolean and null on the Prepared dynamic value", () => {
  // Each program runs twice: with node's answer (returns) and with a wrong one (throws), so a pass cannot come
  // from a check that never ran.
  it.each([
    ["`!v`", "function f(v) { return !v; }\nif (f(0) !== @R || f(1) !== @W) throw 1;", "true", "false"],
    ["`&&` yields an operand", "function a(x, y) { return x && y; }\nif (a(1, true) !== @R) throw 1;", "true", "1"],
    ["`||` yields an operand", "function o(x, y) { return x || y; }\nif (o(0, 5) !== @R) throw 1;", "5", "true"],
    [
      "`||` over undefined",
      "function o(x, y) { return x || y; }\nif (o(undefined, undefined) !== @R) throw 1;",
      "undefined",
      "null",
    ],
    [
      "`=== null`",
      "function n(v) { return v === null; }\nif (n(null) !== @R || n(undefined) !== @W) throw 1;",
      "true",
      "false",
    ],
    [
      "`!== null`",
      "function n(v) { return v !== null; }\nif (n(0) !== @R || n(null) !== @W) throw 1;",
      "true",
      "false",
    ],
    [
      "`null` through a dynamic value",
      "function id(v) { return v; }\nif ((id(null) === null) !== @R) throw 1;",
      "true",
      "false",
    ],
    [
      "`null !== undefined`",
      "function id(v) { return v; }\nif ((id(null) !== id(undefined)) !== @R) throw 1;",
      "true",
      "false",
    ],
    ["ToNumber(null) is 0", "function id(v) { return v; }\nif (id(null) * 1 !== @R) throw 1;", "0", "1"],
    [
      "a loop condition",
      "function w(v) { var i = 0; while (v) { i++; v = 0; } return i; }\nif (w(1.5) !== @R) throw 1;",
      "1",
      "0",
    ],
    ["a conditional", "function c(v) { return v ? 1 : 2; }\nif (c(null) !== @R) throw 1;", "2", "1"],
  ])("answers %s like JavaScript", async (_label, template, right, wrong) => {
    // `@W` is the other polarity of `@R` where a program checks two answers.
    const program = (r: string, w: string) => template.replaceAll("@R", r).replaceAll("@W", w);
    expect(node(program(right, wrong))).toBe("returned");
    expect(await run(program(right, wrong))).toBe("returned");
    expect(node(program(wrong, right))).toBe("threw");
    expect(await run(program(wrong, right))).toBe("threw");
  });

  it.each(VALUES)("branches on %s like JavaScript", async (text) => {
    const answer = value(text) ? 1 : 2;
    const program = (expected: number) =>
      `function t(v) { if (v) return 1; return 2; }\nif (t(${text}) !== ${expected}) throw 1;`;
    expect(await run(program(answer))).toBe("returned");
    expect(await run(program(3 - answer))).toBe("threw");
  });

  // typeof answers a string (slice Str); loose equality other than a tag test is not lowered.
  it.each([
    [
      "typeof",
      'function p(v) { return typeof v !== "object"; }\nif (!p(1)) throw 1;',
      "dynamic operation dyn.typeof has no Prepared intrinsic",
    ],
    [
      "isPrimitive (blocked by typeof)",
      'function isPrimitive(v) { return !v || (typeof v !== "object" && typeof v !== "function"); }\nif (!isPrimitive(1)) throw 1;',
      "dynamic operation dyn.typeof has no Prepared intrinsic",
    ],
    [
      "`== null`",
      "function q(v) { return v == null; }\nif (q(undefined) !== true) throw 1;",
      "bare 'null' in non-reference context (f64)",
    ],
    [
      "loose equality",
      "function q(v, w) { return v == w; }\nif (q(1, 1) !== true) throw 1;",
      "dynamic operation dyn.eq (loose) has no Prepared intrinsic",
    ],
    // The other from-ast paths the externref-carrier flag switches on; each still refuses before it matters.
    [
      "a dynamic for-in head",
      "function f(v) { var r = 0; for (var k in v) { r++; } return r; }\nf(null);",
      "dynamic for-in runtime is unavailable in f",
    ],
    [
      "a function-object property write",
      "function g() {}\nfunction h() { g.x = 2; return 0; }\nh();",
      'identifier "g" is not in scope in h',
    ],
    [
      "a primitive wrapper's ToPrimitive",
      "function h(v) { return new Number(1) == v; }\nh(1);",
      'unknown class "Number" in h',
    ],
    [
      "the parseInt externref boundary",
      "function stringToNumber(v) { return parseInt(v); }\nstringToNumber(5);",
      'direct call to "parseInt" has no exact AST-site plan in stringToNumber',
    ],
  ])("refuses %s by name", async (_label, source, expected) => {
    expect(await refusal(source)).toContain(expected);
  });

  it("keeps `null` and ToBoolean of the dynamic value off the gc target", async () => {
    expect(await refusal("function t(v) { return v ? 1 : 2; }\nif (t(null) !== 2) throw 1;", "gc")).toContain(
      "function t has an unresolved parameter contract",
    );
  });

  // The catch binding is the dynamic value now (the carrier is the exception payload), so an assertion to a
  // typed position is a flow without a conversion, like an `any` one.
  it("refuses a caught value asserted into a typed result by name", async () => {
    const source = "export function f(x: number): number { try { throw x * 2; } catch (e) { return e as number; } }";
    expect(await refusal(source, "standalone", "entry.ts")).toContain(
      "a dynamic value flows into number without a conversion (ReturnStatement)",
    );
  });
});

describe("#7354 T — the legalization arms", () => {
  const dynamic = { kind: "dynamic" } as const;
  const externref = { kind: "val", val: { kind: "externref" } } as const;
  const i32 = { kind: "val", val: { kind: "i32" } } as const;
  const one = (instr: object, params: readonly object[] = [dynamic]) =>
    legalizeDynamicValues({
      unitId: "ir-unit:test",
      name: "f",
      params: params.map((type, index) => ({ value: index, type, name: `p${index}` })),
      resultTypes: [i32],
      blocks: [
        {
          id: 0,
          blockArgs: [],
          blockArgTypes: [],
          instrs: [instr as IrInstr],
          terminator: { kind: "return", values: [1] },
        },
      ],
      exported: false,
      valueCount: 2,
    } as unknown as IrFunction).blocks[0]!.instrs[0];

  it("lowers ToBoolean to its intrinsic", () => {
    expect(one({ kind: "dyn.truthy", value: 0, result: 1, resultType: i32 })).toMatchObject({
      kind: "intrinsic",
      id: "js.value.to_boolean",
      args: [0],
    });
  });

  it("lowers the null tag test to the carrier's null check", () => {
    expect(one({ kind: "tag.test", value: 0, tagId: JS_TAG_IDS.Null, result: 1, resultType: i32 })).toEqual({
      kind: "unary",
      op: "ref.is_null",
      rand: 0,
      result: 1,
      resultType: i32,
    });
  });

  it("boxes null as the carrier's null reference", () => {
    const box = {
      kind: "box",
      value: 0,
      toType: { kind: "dynamic", tag: JS_TAG_IDS.Null },
      result: 1,
      resultType: dynamic,
    };
    expect(one(box, [externref])).toEqual({
      kind: "const",
      value: { kind: "null", ty: externref },
      result: 1,
      resultType: externref,
    });
  });
});
