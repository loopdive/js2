// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice D1 — the dynamic value on the Prepared standalone path. An explicitly annotated `any` parameter or
// result is the logical dynamic value; the dynamic-value legalization rewrites box/unbox/tag.test/dyn.* into the
// semantic intrinsics the Prepared backend binds (`js.number.*`, `js.boolean.box`, `js.extern.is_undefined`,
// `js.value.*`) and carries the value physically as `externref`. Every other dynamic operation, and every flow of a
// dynamic value into a typed position without a conversion the source wrote, refuses by name.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import { selectNativeDynamicValues } from "../src/backend/wasmgc/resources/native-dynamic-values.js";
import { irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import type { IrFunction, IrInstr, IrInstrIntrinsic } from "../src/ir/core/nodes.js";
import type { IrType } from "../src/ir/core/types.js";
import { DynamicValueGap, legalizeDynamicValues } from "../src/ir/program/dynamic-value-legalization.js";
import { dynamicValuePolicyMismatch } from "../src/ir/runtime/dynamic-value-callables.js";
import { JS_TAG_IDS } from "../src/ir/runtime/js-tag-domain.js";
import { instantiatePreparedArtifact } from "../src/test262/test262-prepared-runtime.js";
import {
  compile,
  requiredPreparedEmission,
  type Test262CompileOptions,
} from "../src/test262/test262-prepared-entry.js";

const options = (target: "standalone" | "gc"): Test262CompileOptions =>
  ({
    wholeProgram: Object.freeze({ kind: "prepared-program-required" as const, version: 1 as const }),
    backend: "wasmgc",
    target,
    fileName: "entry.ts",
    sourceMap: false,
    optimize: false,
    emitWat: false,
  }) as Test262CompileOptions;

afterEach(() => vi.restoreAllMocks());

const messages = (result: { errors: readonly { message: string }[] }) => result.errors.map((error) => error.message);

const ID = "function id(v: any): any {\n  return v;\n}\n";
const main = (body: string) => `${ID}export function main(): number {\n  ${body}\n}\n`;

async function run(source: string): Promise<number> {
  for (const spy of [vi.spyOn(gc, "generateModule"), vi.spyOn(linear, "generateLinearModule")])
    spy.mockImplementation(() => {
      throw new Error("strict request entered a direct generator");
    });
  const result = await compile(source, options("standalone"));
  expect(messages(result)).toEqual([]);
  expect(requiredPreparedEmission(result)).toBeDefined();
  return (instantiatePreparedArtifact(result).instance.exports.main as () => number)();
}

async function refusal(source: string, target: "standalone" | "gc" = "standalone"): Promise<string> {
  const result = await compile(source, options(target));
  expect(result.success).toBe(false);
  return messages(result).join("\n");
}

describe("#7354 D1 — the dynamic value on the Prepared standalone path", () => {
  it("passes a number, a boolean and undefined through `any` and compares them strictly", async () => {
    const body = `const n: any = id(41);
      const b: any = id(true);
      const u: any = id(undefined);
      let r = 0;
      if (n === 41) r += 2;
      if (b === true) r += 8;
      if (u === undefined) r += 16;
      if (n !== b) r += 64;
      return r;`;
    expect(await run(main(body))).toBe(90);
  });

  // Every ordered pair of admitted values, both sides dynamic (`js.value.strict_eq`) and, negated, against a typed
  // right side boxed at the comparison: the answer is JavaScript's `===` bit for bit.
  const VALUES = ["1", "-0", "0", "0 / 0", "1.5", "true", "false", "undefined"] as const;
  const jsValue = (text: string): unknown => new Function(`return ${text};`)();
  it.each([
    ["===", (a: string, b: string) => `id(${a}) === id(${b})`, (a: unknown, b: unknown) => a === b],
    ["!==", (a: string, b: string) => `id(${a}) !== ${b}`, (a: unknown, b: unknown) => a !== b],
  ])("answers %s over every pair of numbers, booleans and undefined like JavaScript", async (_, spell, js) => {
    const pairs = VALUES.flatMap((a) => VALUES.map((b) => [a, b] as const));
    // Two programs of half the pairs each keep every bit an exact f64 integer.
    for (const half of [pairs.slice(0, 32), pairs.slice(32)]) {
      const body = half.map(([a, b], bit) => `if (${spell(a, b)}) r += ${2 ** bit};`).join("\n  ");
      const expected = half.reduce((sum, [a, b], bit) => sum + (js(jsValue(a), jsValue(b)) ? 2 ** bit : 0), 0);
      expect(await run(main(`let r = 0;\n  ${body}\n  return r;`))).toBe(expected);
    }
  });

  it("calls one helper with three tags and tests each one", async () => {
    const source = `${ID}function tagOf(v: any): number {
      if (v === undefined) return 1;
      if (v === true || v === false) return 4;
      return 3;
    }
    export function main(): number {
      return tagOf(id(1.5)) * 100 + tagOf(true) * 10 + tagOf(undefined);
    }`;
    expect(await run(source)).toBe(341);
  });

  it("converts the dynamic value to a number where the source writes the conversion", async () => {
    const source = `function dbl(v: any): number {
      return v * 2;
    }
    function f(n: number): number { return n; }
    export function main(): number {
      return dbl(20) + dbl(true) + (dbl(undefined) !== dbl(undefined) ? 100 : 0) + f(+dbl(1)) * 1000;
    }`;
    expect(await run(source)).toBe(2142);
  });

  it("carries a dynamic value through a branch join and a conditional", async () => {
    const body = `const c = 1 > 0;
      let x: any = id(1);
      if (c) x = id(true);
      const y: any = c ? id(undefined) : id(2);
      return (x === true ? 1 : 0) + (y === undefined ? 2 : 0);`;
    expect(await run(main(body))).toBe(3);
  });

  it("legalizes a dynamic value that no `any` contract introduced", async () => {
    expect(
      await run("export function main(): number { let a: any = undefined; return a === undefined ? 1 : 0; }"),
    ).toBe(1);
  });

  it.each([
    // The one rule: an `any` expression whose contextual type is not `any` crosses into that type with no
    // conversion the source wrote, and the Prepared path has no checked unbox yet.
    ["a typed result", "function f(v: any): number { return v; }\n", "return f(3);", "number", "ReturnStatement"],
    ["a typed result of main", "", "return id(3);", "number", "ReturnStatement"],
    [
      "a typed result in a branch",
      "function f(c: boolean, v: any): number { if (c) return v; return 2; }\n",
      "return f(true, 3);",
      "number",
      "ReturnStatement",
    ],
    [
      "a number parameter",
      "function f(n: number): number { return n; }\n",
      "return f(id(true));",
      "number",
      "CallExpression",
    ],
    [
      "a boolean parameter",
      "function f(b: boolean): number { return b ? 1 : 0; }\n",
      "return f(id(true));",
      "boolean",
      "CallExpression",
    ],
    ["a typed local", "", "const n: number = id(1); return n;", "number", "VariableDeclaration"],
    ["an assignment to a typed local", "", "let n = 0; n = id(1); return n;", "number", "BinaryExpression"],
    // The conditional itself is `any` here, so the flow is named at its typed binding.
    [
      "a typed local through a conditional",
      "",
      "const n: number = 1 > 0 ? id(1) : 2; return n;",
      "number",
      "VariableDeclaration",
    ],
    [
      "a typed literal property",
      "",
      "const o: { a: number } = { a: id(1) }; return o.a;",
      "number",
      "PropertyAssignment",
    ],
    ["a typed array element", "", "const a: number[] = [id(1)]; return a[0];", "number", "ArrayLiteralExpression"],
  ])("refuses a dynamic value flowing into %s", async (_label, helper, body, type, site) => {
    expect(await refusal(`${ID}${helper}export function main(): number {\n  ${body}\n}\n`)).toContain(
      `a dynamic value flows into ${type} without a conversion (${site})`,
    );
  });

  it.each([
    ["loose equality", "return id(1) == id(1) ? 1 : 0;", "dynamic operation dyn.eq (loose) has no Prepared intrinsic"],
    [
      "the null tag test",
      "return id(1) === null ? 1 : 0;",
      "dynamic operation tag.test of tag 0 has no Prepared intrinsic",
    ],
    ["ToBoolean", "return id(1) ? 1 : 0;", "dynamic operation dyn.truthy has no Prepared intrinsic"],
    [
      "dynamic +",
      "return add(id(1), id(2)) === 3 ? 1 : 0;",
      "dynamic operation __ir_dyn_add has no Prepared intrinsic",
    ],
    // The property key enters the dynamic value as a string: outside the admitted set.
    ["a member read", "return id(1).x === 1 ? 1 : 0;", "dynamic operation box of a non-primitive value"],
    // typeof answers a string: a later slice, with string equality.
    ["typeof", 'return typeof id(1) === "number" ? 1 : 0;', "dynamic operation dyn.typeof has no Prepared intrinsic"],
    ["`**`", "return id(2) ** 3;", "'**' on a dynamic operand"],
    ["`**` on the right", "return 2 ** id(3);", "'**' on a dynamic operand"],
    ["a value-position prefix update", "let x: any = id(1); return ++x;", "value-position prefix update"],
    ["a thrown dynamic value", "try { throw id(1); } catch (e) { return 1; } return 0;", "coerce.to_externref"],
    [
      "a dynamic object field",
      "const o = { a: id(1) }; return o.a === 1 ? 1 : 0;",
      "dynamic operation on a value of composite type has no Prepared intrinsic",
    ],
  ])("refuses %s by name", async (_label, body, expected) => {
    const add = body.includes("add(") ? "function add(a: any, b: any): any {\n  return a + b;\n}\n" : "";
    expect(await refusal(`${ID}${add}export function main(): number {\n  ${body}\n}\n`)).toContain(expected);
  });

  it.each([
    // Only an annotated `any` is a result contract; an inferred one is not dynamic (here: no value).
    ["an inferred `any` result", "function f(v: any) { return v; }\n", "returned void used as expression"],
    [
      "an exported `any` contract (a host boundary)",
      "export function f(v: any): any { return v; }\n",
      "complete synchronous",
    ],
  ])("keeps %s refused", async (_label, source, expected) => {
    expect(await refusal(source + "export function main(): number { return f(1) === 1 ? 1 : 0; }\n")).toContain(
      expected,
    );
  });

  it("keeps the dynamic carrier off the gc target", async () => {
    expect(await refusal(main("return id(1) === 1 ? 1 : 0;"), "gc")).toContain("unsupported type in Phase 1 (id)");
  });
});

describe("#7354 D1 — the legalization pass", () => {
  const dynamic = { kind: "dynamic" } as const;
  const f64 = { kind: "val", val: { kind: "f64" } } as const;
  const i32 = { kind: "val", val: { kind: "i32" } } as const;
  const union = { kind: "union", members: [{ kind: "f64" }, { kind: "i32" }] } as unknown as IrType;
  const fn = (instrs: readonly IrInstr[], params: readonly IrType[] = [dynamic]): IrFunction =>
    ({
      unitId: "ir-unit:test",
      name: "f",
      params: params.map((type, value) => ({ value, type, name: `p${value}` })),
      resultTypes: [f64],
      blocks: [{ id: 0, blockArgs: [], blockArgTypes: [], instrs, terminator: { kind: "return", values: [1] } }],
      exported: false,
      valueCount: 3,
    }) as unknown as IrFunction;
  const one = (instr: object, params?: readonly IrType[]) =>
    legalizeDynamicValues(fn([instr as unknown as IrInstr], params)).blocks[0]!.instrs[0];

  it("rewrites a proven number unbox and the dynamic parameter to the externref carrier", () => {
    const unbox = { kind: "unbox", value: 0, tagId: JS_TAG_IDS.NumberF64, result: 1, resultType: f64 };
    const out = legalizeDynamicValues(fn([unbox as unknown as IrInstr]));
    expect(out.params[0]!.type).toEqual({ kind: "val", val: { kind: "externref" } });
    expect(out.blocks[0]!.instrs[0]).toMatchObject({ kind: "intrinsic", id: "js.number.unbox", args: [0] });
  });

  it("refuses to box a value outside the admitted set (a string)", () => {
    const box = { kind: "box", value: 1, toType: dynamic, result: 2, resultType: dynamic };
    expect(() => one(box, [dynamic, { kind: "string" }])).toThrow(
      new DynamicValueGap("dynamic operation box of a non-primitive value has no Prepared intrinsic"),
    );
  });

  it.each([
    ["a Boolean unbox", { kind: "unbox", value: 0, tagId: JS_TAG_IDS.Boolean, result: 1, resultType: i32 }, "unbox"],
    [
      "a number tag test",
      { kind: "tag.test", value: 0, tagId: JS_TAG_IDS.NumberF64, result: 1, resultType: i32 },
      "tag",
    ],
    [
      "a dynamic externref coercion",
      { kind: "coerce.to_externref", value: 0, result: 1, resultType: dynamic },
      "coerce",
    ],
  ])("refuses %s, which has no source producer here", (_label, instr, name) => {
    expect(() => one(instr)).toThrow(DynamicValueGap);
    expect(() => one(instr)).toThrow(name);
  });

  // Operations on non-dynamic values inside a function that has a dynamic one stay exactly as they were.
  it.each([
    ["a box into a union", { kind: "box", value: 1, toType: union, result: 2, resultType: union }],
    ["a union unbox", { kind: "unbox", value: 1, tag: { kind: "f64" }, result: 2, resultType: f64 }],
    ["a union tag test", { kind: "tag.test", value: 1, tag: { kind: "f64" }, result: 2, resultType: i32 }],
    ["an externref coercion of a number", { kind: "coerce.to_externref", value: 1, result: 2, resultType: f64 }],
    [
      "an undeclared runtime call without a dynamic operand",
      { kind: "call", target: irRuntimeFuncRef("__probe_helper"), args: [1], result: 2, resultType: f64 },
    ],
  ])("leaves %s unchanged", (_label, instr) => {
    expect(one(instr, [dynamic, union])).toBe(instr);
  });

  it("refuses a dynamic type left inside a composite type", () => {
    const vec = { kind: "vec", element: dynamic, nullable: false } as unknown as IrType;
    expect(() => legalizeDynamicValues(fn([], [dynamic, vec]))).toThrow(
      new DynamicValueGap("dynamic operation on a value of composite type has no Prepared intrinsic"),
    );
  });

  it("returns a function without a dynamic value unchanged", () => {
    const input = fn([], [f64]);
    expect(legalizeDynamicValues(input)).toBe(input);
  });
});

describe("#7354 D1 — the native dynamic-value resources", () => {
  const probe = (binding: "runtime" | "host") =>
    ({
      kind: "intrinsic",
      id: "js.extern.is_undefined",
      provider: {
        kind: "callable",
        target: binding === "runtime" ? irRuntimeFuncRef("__extern_is_undefined") : { binding: { kind: "import" } },
      },
    }) as unknown as IrInstrIntrinsic;

  it("reserves the `undefined` probe only when the manifest bound it to the native function", () => {
    expect(selectNativeDynamicValues([probe("host")])).toBeUndefined();
    expect(selectNativeDynamicValues([probe("runtime")])).toEqual({
      strictEq: false,
      undefinedValue: false,
      isUndefined: true,
    });
  });

  it("admits the js.value family only on standalone WasmGC", () => {
    expect(dynamicValuePolicyMismatch("js.value.strict_eq", { backend: "wasmgc", target: "standalone" } as never)).toBe(
      undefined,
    );
    expect(dynamicValuePolicyMismatch("js.value.strict_eq", { backend: "wasmgc", target: "host" } as never)).toBe(
      "js.value.strict_eq requires standalone WasmGC",
    );
    expect(dynamicValuePolicyMismatch("js.number.box", { backend: "wasmgc", target: "host" } as never)).toBe(undefined);
  });
});
