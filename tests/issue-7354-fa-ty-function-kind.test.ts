// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 Fa × Ty — the function kind's `typeof` test on the Prepared dynamic value. Slice Fa admits a function
// value (a source closure) into the carrier as kind `function`; slice Ty answers `typeof v <op> "literal"` with the
// kind's runtime test. The function test is `js.value.is_function`, the native `__typeof_function`: a `ref.test` of
// the closure wrapper root, the type the `js.closure.call:N` dispatcher's root arm tests. assert.js's
// `typeof func !== 'function'` (harness line 131) is this comparison on a parameter.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import type { IrFunction, IrInstr } from "../src/ir/core/nodes.js";
import { irDynamic, irVal } from "../src/ir/core/types.js";
import { legalizeDynamicValues } from "../src/ir/program/dynamic-value-legalization.js";
import { irRuntimeFuncRef } from "../src/ir/callable-bindings.js";
import { IR_DYN_CALL_BOX_FN } from "../src/shared/contracts/dynamic-call-helpers.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target: "standalone",
    sourceMap: false,
    optimize: false,
    emitWat: false,
    fileName: "test.js",
    allowJs: true,
  }) as Test262CompileOptions;

afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

/** A closure pulls in the native realm, whose emission takes tens of seconds on a loaded box. */
const SLOW = 240_000;

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

/** node's verdict on the same script: the reference every answer is checked against. */
function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}

/** assert.js's own predicate, on a parameter: the comparison is on a dynamic value, so it runs at run time. */
const IS_FN = "function isFn(func) { return typeof func === 'function'; }";

describe("#7354 Fa × Ty — typeof of a function value on the Prepared path", () => {
  // Each program runs with node's answer (returns) and a wrong one (throws): a pass cannot come from a check that
  // never ran, and a `typeof` folded to a constant cannot pass both.
  it.each([
    ["a closure in a var, through a parameter", "var f = function () {};", "!isFn(f)", "isFn(f)"],
    [
      "a closure in a function's local, through a parameter",
      "function g() { var k = function (v) { return v; }; return isFn(k); }",
      "!g()",
      "g()",
    ],
    ["a call's result", "var f = function () {}; function h() { return f; }", "!isFn(h())", "isFn(h())"],
    [
      "a closure passed straight to the parameter",
      "",
      "!isFn(function (a) { return a; })",
      "isFn(function (a) { return a; })",
    ],
    [
      "the `!==` sense, as assert.js writes it",
      "var f = function () {}; function notFn(func) { return typeof func !== 'function'; }",
      "notFn(f) || !notFn(1)",
      "!notFn(f)",
    ],
    [
      "values of every other admitted kind, beside a closure",
      "var f = function () {};",
      'isFn(1) || isFn(true) || isFn(undefined) || isFn(null) || isFn("a") || !isFn(f)',
      "!isFn(1)",
    ],
  ])(
    "answers %s",
    async (_, program, fails, wrong) => {
      const right = `${IS_FN} ${program} if (${fails}) throw 1;`;
      expect(node(right)).toBe("returned");
      expect(await run(right)).toBe("returned");
      expect(await run(`${IS_FN} ${program} if (${wrong}) throw 1;`)).toBe("threw");
    },
    SLOW,
  );

  // A program with no closure has no function value: the test is answered without a closure type in the module.
  it(
    "answers false in a program with no closure",
    async () => {
      const right = `${IS_FN} if (isFn(1) || isFn(undefined) || isFn("a")) throw 1;`;
      expect(node(right)).toBe("returned");
      expect(await run(right)).toBe("returned");
      expect(await run(`${IS_FN} if (!isFn(1)) throw 1;`)).toBe("threw");
    },
    SLOW,
  );
});

describe("#7354 Fa × Ty — the legalization's function test", () => {
  const dynamic = irDynamic();
  const logical = { params: [dynamic], returnType: dynamic };
  /** `enter` defines the dynamic value 1; its `typeof` is compared with `literal` into value 4. */
  const compareTypeof = (enter: readonly object[], literal: string, negate = false): IrFunction =>
    ({
      unitId: "ir-unit:test",
      name: "f",
      params: [{ value: 0, type: { kind: "callable", signature: logical }, name: "fn" }],
      resultTypes: [],
      blocks: [
        {
          id: 0,
          blockArgs: [],
          blockArgTypes: [],
          instrs: [
            ...enter,
            { kind: "dyn.typeof", value: 1, result: 2, resultType: { kind: "string" } },
            { kind: "string.const", value: literal, result: 3, resultType: { kind: "string" } },
            { kind: "string.eq", lhs: 2, rhs: 3, negate, result: 4, resultType: irVal({ kind: "i32" }) },
          ] as IrInstr[],
          terminator: { kind: "return", values: [] },
        },
      ],
      exported: false,
      valueCount: 5,
    }) as unknown as IrFunction;
  /** The function-value projection: a packed callable boxed into the dynamic value (`functionObjectDynamicValue`). */
  const enterFunction = [
    { kind: "call", target: irRuntimeFuncRef(IR_DYN_CALL_BOX_FN), args: [0], result: 1, resultType: dynamic },
  ];
  const answer = (fn: IrFunction) => legalizeDynamicValues(fn).blocks[0]!.instrs as IrInstr[];

  it('answers typeof === "function" of a function value with the function test, never a constant', () => {
    const instrs = answer(compareTypeof(enterFunction, "function"));
    expect(instrs.find((instr) => instr.result === 4)).toMatchObject({
      kind: "intrinsic",
      id: "js.value.is_function",
      args: [1],
    });
    expect(instrs.some((instr) => instr.kind === "const")).toBe(false);
  });

  it('answers typeof !== "function" with the negated function test', () => {
    const instrs = answer(compareTypeof(enterFunction, "function", true));
    const test = instrs.find((instr) => instr.kind === "intrinsic" && instr.id === "js.value.is_function");
    expect(test).toBeDefined();
    expect(instrs.find((instr) => instr.result === 4)).toMatchObject({
      kind: "unary",
      op: "i32.eqz",
      rand: test!.result,
    });
  });

  // The function value is in the carrier as itself: another kind's test on it is that kind's runtime test.
  it('answers typeof === "number" of a function value with the number test', () => {
    expect(answer(compareTypeof(enterFunction, "number")).find((instr) => instr.result === 4)).toMatchObject({
      kind: "intrinsic",
      id: "js.value.is_number",
    });
  });
});
