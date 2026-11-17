// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice X — throw and catch with the Prepared dynamic value. The carrier already is the externref exception
// payload, so throwing a dynamic value converts nothing, and the catch binding reads the payload back as the
// dynamic value: `e === v`, ToBoolean(e) and `throw e` work on it. An unannotated result the checker types
// `unknown` (a returned catch binding) is the dynamic value, like `any`.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { DynamicValueGap, legalizeDynamicValues } from "../src/ir/program/dynamic-value-legalization.js";
import type { IrFunction, IrInstr } from "../src/ir/core/nodes.js";
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

function node(source: string): "returned" | "threw" {
  try {
    new Function(source)();
    return "returned";
  } catch {
    return "threw";
  }
}

const VALUES = ["1.5", "0", "-0", "1", "true", "false", "undefined", "null"] as const;
const SAME = "function same(a, b) { return a === b || (a !== a && b !== b); }\n";

describe("#7354 X — throw and catch with the Prepared dynamic value", () => {
  // Each program runs with node's answer (returns) and with a wrong one (throws).
  const twice = async (program: (answer: string) => string, right: string, wrong: string) => {
    expect(node(program(right))).toBe("returned");
    expect(await run(program(right))).toBe("returned");
    expect(node(program(wrong))).toBe("threw");
    expect(await run(program(wrong))).toBe("threw");
  };
  const other = (text: string) => (text === "1" ? "0" : "1");

  it.each(VALUES)("returns the caught %s", async (text) => {
    await twice(
      (answer) => `function g(v) { try { throw v; } catch (e) { return e; } }\nif (g(${text}) !== ${answer}) throw 1;`,
      text,
      other(text),
    );
  });

  it("returns a caught NaN", async () => {
    await twice(
      (answer) =>
        `${SAME}function g(v) { try { throw v; } catch (e) { return e; } }\nif (!same(g(0 / 0), ${answer})) throw 1;`,
      "0 / 0",
      "0",
    );
  });

  it.each(VALUES)("rethrows %s through a nested try/catch/finally", async (text) => {
    await twice(
      (answer) =>
        "function g(v) { var log = 0; try { try { throw v; } catch (e) { log = 1; throw e; } finally { log = log + 10; } }" +
        ` catch (e2) { if (log !== 11) throw 9; return e2; } return 7; }\nif (g(${text}) !== ${answer}) throw 1;`,
      text,
      other(text),
    );
  });

  it("catches a number thrown two calls up", async () => {
    await twice(
      (answer) =>
        "function a(v) { throw v; }\nfunction b(v) { a(v); return 0; }\n" +
        `function c(v) { try { b(v); } catch (e) { return e; } return 7; }\nif (c(4) !== ${answer}) throw 1;`,
      "4",
      "7",
    );
  });

  it.each(VALUES)("compares and branches on the caught %s", async (text) => {
    const v = new Function(`return ${text};`)() as unknown;
    await twice(
      (answer) =>
        `function g(v) { try { throw v; } catch (e) { return (e === v ? 1 : 0) + (e ? 2 : 0) + (e === null ? 4 : 0); } }\nif (g(${text}) !== ${answer}) throw 1;`,
      String(1 + (v ? 2 : 0) + (v === null ? 4 : 0)),
      "8",
    );
  });

  it("catches `throw undefined` at top level", async () => {
    await twice(
      (answer) => `try { throw undefined; } catch (e) { if (e !== ${answer}) throw 1; }`,
      "undefined",
      "null",
    );
  });

  it.each(VALUES)("lets the uncaught %s escape start", async (text) => {
    const program = `function g(v) { throw v; }\ng(${text});`;
    expect(node(program)).toBe("threw");
    expect(await run(program)).toBe("threw");
  });

  it("refuses a typed Boolean throw by name", async () => {
    const result = await compile("try { throw true; } catch (e) { }", options());
    expect(messages(result).join("\n")).toContain("throw val not in slice 9");
  });
});

describe("#7354 X — the legalization arm", () => {
  const dynamic = { kind: "dynamic" } as const;
  const externref = { kind: "val", val: { kind: "externref" } } as const;
  const fn = (instrs: readonly object[]): IrFunction =>
    ({
      unitId: "ir-unit:test",
      name: "f",
      params: [{ value: 0, type: dynamic, name: "p0" }],
      resultTypes: [],
      blocks: [
        {
          id: 0,
          blockArgs: [],
          blockArgTypes: [],
          instrs: instrs as IrInstr[],
          terminator: { kind: "return", values: [] },
        },
      ],
      exported: false,
      valueCount: 2,
    }) as unknown as IrFunction;
  const coerce = { kind: "coerce.to_externref", value: 0, result: 1, resultType: externref };

  it("keeps the coercion of a thrown dynamic value, over the legalized carrier", () => {
    const out = legalizeDynamicValues(fn([coerce, { kind: "throw", value: 1, result: null, resultType: null }]));
    expect(out.params[0]!.type).toEqual(externref);
    expect(out.blocks[0]!.instrs[0]).toEqual(coerce);
  });

  it("keeps the coercion of a dynamic value thrown inside a nested buffer", () => {
    const nested = {
      kind: "if",
      cond: 0,
      then: [{ kind: "throw", value: 1, result: null, resultType: null }],
      else: [],
      result: null,
      resultType: null,
    };
    expect(legalizeDynamicValues(fn([coerce, nested])).blocks[0]!.instrs[0]).toEqual(coerce);
  });

  it("refuses the coercion of a dynamic value that is not thrown", () => {
    expect(() => legalizeDynamicValues(fn([coerce]))).toThrow(DynamicValueGap);
  });
});
