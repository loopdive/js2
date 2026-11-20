// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice X — throw and catch with the Prepared dynamic value. The carrier already is the externref exception
// payload, so throwing a dynamic value converts nothing, and the catch binding reads the payload back as the
// dynamic value: `e === v`, ToBoolean(e) and `throw e` work on it. An unannotated result the checker types
// `unknown` (a returned catch binding) is the dynamic value, like `any`.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { irIntrinsicFuncRef } from "../src/ir/core/callable-bindings.js";
import { legalizeDynamicValues, refuseUnadmittedThrows } from "../src/ir/program/dynamic-value-legalization.js";
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

  // An unannotated Boolean result is the Boolean carrier (review round 1): it used to lower to a plain i32 that
  // the source-declaration join refused ("source declaration and prepared callable slots disagree").
  it.each([
    ["a comparison on the caught value", "function f() { try { throw 3; } catch (e) { return e === 3; } }"],
    ["a parameterless comparison", "function f() { return 1 === 1; }"],
  ])("returns %s as a Boolean", async (_label, f) => {
    await twice((answer) => `${f}\nif (f() !== ${answer}) throw 1;`, "true", "false");
  });

  it("passes a Boolean result on to a dynamic parameter", async () => {
    await twice(
      (answer) => `${SAME}function f(v) { return !v; }\nif (!same(f(0), ${answer})) throw 1;`,
      "true",
      "false",
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

  // (#7354 T review round 3, after the merge with Str) A thrown native string reaches the catch: strict equality
  // and ToBoolean both have its arm.
  it.each([
    ["`=== 'x'`", "try { throw 'x'; } catch (e) { if ((e === 'x') !== @A) throw 1; }", "true", "false"],
    ["ToBoolean of 'x'", "try { throw 'x'; } catch (e) { if (!e !== @A) throw 1; }", "false", "true"],
    ["ToBoolean of ''", "try { throw ''; } catch (e) { if (!e !== @A) throw 1; }", "true", "false"],
    // (#7354 Str2 merge) TYPEOF_KIND lists the string kind.
    ["typeof 'x'", "try { throw 'x'; } catch (e) { if ((typeof e === 'string') !== @A) throw 1; }", "true", "false"],
    [
      "a string through `||`",
      "function g(v) { throw v; } try { g(''); } catch (e) { if ((e || 7) !== @A) throw 1; }",
      "7",
      "''",
    ],
  ])("catches a thrown string: %s", async (_label, template, right, wrong) => {
    await twice((answer) => template.replace("@A", answer), right, wrong);
  });

  // The catch binding is the dynamic value, which is exact only for numbers, booleans, `undefined`, `null` and
  // native strings (and for Error objects, under every operation the carrier has). Each other payload that could
  // reach a catch refuses before it does; the slice that makes one reachable must give the dynamic operations its
  // arm and update this list. (#7354 Ty) The catch binding enters the carrier without the box arm's `carrierKindOf`, so
  // this list is also what keeps `TYPEOF_KIND` (the `typeof` answers of the admitted kinds) complete.
  it.each([
    ["a typed Boolean throw", "try { throw true; } catch (e) { if (!e) throw 1; }", "throw val not in slice 9"],
    [
      "a TDZ ReferenceError",
      "function f() { return x; }\ntry { f(); } catch (e) { if (!e) throw 1; }\nlet x = 1;",
      // (#7354 O1) The thrown ReferenceError is no carrier kind: the program-wide throw rule refuses it first.
      "throw of a value outside the dynamic carrier's kinds",
    ],
    [
      "a vector store (the null-vector guard throws a null payload)",
      "try { var a = [1]; a[5] = 2; } catch (e) { if (!e) throw 1; }",
      "resolver cannot register vec for array literal",
    ],
    [
      "a call through a dynamic value (a TypeError)",
      "function f(v) { try { v(); } catch (e) { return e; } }\nf(1);",
      "dynamic operation __ir_dyn_call_value has no Prepared intrinsic",
    ],
    // (#7354 M2) "a member read of a dynamic value (a TypeError on null)" left this table: the realm's TypeError is a
    // kind of the dynamic value (tests/issue-7354-m2-caught-errors.test.ts).
  ])("refuses %s before it reaches a catch", async (_label, source, expected) => {
    const result = await compile(source, options());
    expect(
      result.success,
      "a new payload kind reaches a catch: add its kind to TYPEOF_KIND (src/ir/program/dynamic-value-legalization.ts) " +
        "so `typeof e` answers it, and give the dynamic operations its arm",
    ).toBe(false);
    expect(messages(result).join("\n")).toContain(expected);
  });

  // (#7354 O1) The throw rule binds only a program with a catch binding: without one no source code reads a payload,
  // so a throw the compiler synthesizes meets its own step, not the carrier's kinds.
  it("leaves a TDZ ReferenceError in a program without a catch to its own refusal", async () => {
    const result = await compile("function f() { return x; }\nf();\nlet x = 1;", options());
    expect(result.success).toBe(false);
    expect(messages(result).join("\n")).toContain(
      "runtime callable __new_ReferenceError needs runtime function materialization",
    );
  });

  // (#7354 O2) An ordinary object is a kind of the dynamic value, so a thrown object reaches the catch binding as
  // one: `typeof` answers it and its plain ToString is "[object Object]" (tests/issue-7354-o2-object-values.test.ts).
  it.each([
    [
      "an object throw",
      "try { throw {}; } catch (e) { if (!e) throw 1; }",
      "try { throw {}; } catch (e) { if (e) throw 1; }",
    ],
    [
      "an object-literal throw from a callee, tested with typeof",
      'function f() { throw { a: 1 }; }\ntry { f(); } catch (e) { if (typeof e !== "object") throw 1; }',
      'function f() { throw { a: 1 }; }\ntry { f(); } catch (e) { if (typeof e === "object") throw 1; }',
    ],
  ])(
    "catches %s as the object kind",
    async (_label, right, wrong) => {
      expect([node(right), node(wrong)]).toEqual(["returned", "threw"]);
      expect(await run(right)).toBe("returned");
      expect(await run(wrong)).toBe("threw");
    },
    180_000,
  );
});

describe("#7354 X — the legalization arm", () => {
  const dynamic = { kind: "dynamic" } as const;
  const externref = { kind: "val", val: { kind: "externref" } } as const;
  const fn = (instrs: readonly object[], params: readonly object[] = [dynamic]): IrFunction =>
    ({
      unitId: "ir-unit:test",
      name: "f",
      params: params.map((type, value) => ({ value, type, name: `p${value}` })),
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

  // (#7354 O1) An ordinary object's property stores the carrier too, so an unthrown coercion keeps as well.
  it("keeps the coercion of a dynamic value that is not thrown", () => {
    expect(legalizeDynamicValues(fn([coerce])).blocks[0]!.instrs[0]).toEqual(coerce);
  });

  // (#7354 O1) Both carrier rules ask one predicate (`carrierKindOf`): a coercion to the carrier keeps, and a throw of
  // it is admitted, only over an operand of a kind the carrier holds. Value 1 is the operand: a parameter of `type`,
  // or the result of `definition`.
  const operand = (type: object | undefined, definition?: object) => {
    const coerced = { kind: "coerce.to_externref", value: 1, result: 2, resultType: externref };
    const thrown = { kind: "throw", value: 2, result: null, resultType: null };
    const instrs = [...(definition ? [{ ...definition, result: 1, resultType: externref }] : []), coerced, thrown];
    return { coerced, program: { ...fn(instrs, type ? [dynamic, type] : [dynamic]), valueCount: 3 } };
  };
  it.each([
    ["a native string", { kind: "string" }],
    ["a boundary-boxed number", undefined, { kind: "intrinsic", id: "js.number.box", version: 1, args: [0] }],
    ["a boundary-boxed Boolean", undefined, { kind: "intrinsic", id: "js.boolean.box", version: 1, args: [0] }],
    ["the null constant", undefined, { kind: "const", value: { kind: "null", ty: externref } }],
    // (#7354 O2) the object kind
    [
      "an ordinary object",
      undefined,
      { kind: "call", target: irIntrinsicFuncRef("js.object.create-default"), args: [] },
    ],
  ])("admits %s in both rules", (_label, type, definition?: object) => {
    const { coerced, program } = operand(type, definition);
    expect(legalizeDynamicValues(program).blocks[0]!.instrs).toContainEqual(coerced);
    expect(() => refuseUnadmittedThrows(program)).not.toThrow();
  });
  it.each([
    [
      "a closure pack",
      { kind: "callable", signature: { params: [], returnType: null } },
      undefined,
      "a value of type callable",
    ],
    ["an externref of unknown kind", externref, undefined, "a value of type externref"],
  ])("refuses %s by name in both rules", (_label, type, definition, name) => {
    const { program } = operand(type, definition);
    expect(() => legalizeDynamicValues(program)).toThrow(`coerce.to_externref of ${name}`);
    expect(() => refuseUnadmittedThrows(program)).toThrow(`carrier's kinds (${name})`);
  });
});
