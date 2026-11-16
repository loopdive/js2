// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #7354 slice D1 — the dynamic value on the Prepared standalone path. An explicitly annotated `any` parameter or
// result is the logical dynamic value; the dynamic-value legalization rewrites box/unbox/tag.test/dyn.* into the
// semantic intrinsics the Prepared backend binds (`js.number.*`, `js.boolean.box`, `js.extern.is_undefined`,
// `js.value.*`) and carries the value physically as `externref`. Every other dynamic operation refuses by name.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as gc from "../src/codegen/index.js";
import * as linear from "../src/codegen-linear/index.js";
import type { IrFunction, IrInstr } from "../src/ir/core/nodes.js";
import type { IrType } from "../src/ir/core/types.js";
import { DynamicValueGap, legalizeDynamicValues } from "../src/ir/program/dynamic-value-legalization.js";
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
    const main = `export function main(): number {
      const n: any = id(41);
      const b: any = id(true);
      const u: any = id(undefined);
      let r = 0;
      if (n === 41) r += 2;
      if (b === true) r += 8;
      if (u === undefined) r += 16;
      if (n !== b) r += 64;
      return r;
    }`;
    expect(await run(ID + main)).toBe(90);
  });

  it("answers strict equality with Number::equal: +0 === -0, NaN !== NaN, 1 !== true", async () => {
    const main = `export function main(): number {
      let r = 0;
      if (id(0) === id(-0)) r += 1;
      if (id(0 / 0) !== id(0 / 0)) r += 2;
      if (id(1) !== id(true)) r += 4;
      if (id(1.5) === 1.5) r += 8;
      if (id(false) === false) r += 16;
      if (id(undefined) !== id(0)) r += 32;
      return r;
    }`;
    expect(await run(ID + main)).toBe(63);
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

  it("converts the dynamic value back to a number (ToNumber over number, boolean, undefined)", async () => {
    const source = `function dbl(v: any): number {
      return v * 2;
    }
    export function main(): number {
      return dbl(20) + dbl(true) + (dbl(undefined) !== dbl(undefined) ? 100 : 0);
    }`;
    expect(await run(source)).toBe(142);
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
  ])("refuses %s by name", async (_label, body, expected) => {
    const add = body.includes("add(") ? "function add(a: any, b: any): any {\n  return a + b;\n}\n" : "";
    expect(await refusal(`${ID}${add}export function main(): number {\n  ${body}\n}\n`)).toContain(expected);
  });

  it("keeps an exported `any` contract refused: it is a host boundary", async () => {
    expect(await refusal("export function f(v: any): any { return v; }")).toContain(
      "complete synchronous numeric or Boolean function declarations are required",
    );
  });

  it("keeps the dynamic carrier off the gc target", async () => {
    expect(await refusal(`${ID}export function main(): number { return id(1) === 1 ? 1 : 0; }`, "gc")).not.toBe("");
  });
});

describe("#7354 D1 — the legalization pass", () => {
  const dynamic = { kind: "dynamic" } as const;
  const f64 = { kind: "val", val: { kind: "f64" } } as const;
  const fn = (instrs: readonly IrInstr[], params: readonly IrType[] = [dynamic]): IrFunction =>
    ({
      unitId: "ir-unit:test",
      name: "f",
      params: params.map((type, value) => ({ value, type, name: `p${value}` })),
      resultTypes: [f64],
      blocks: [{ id: 0, blockArgs: [], blockArgTypes: [], instrs, terminator: { kind: "return", values: [1] } }],
      exported: false,
      valueCount: 2,
    }) as unknown as IrFunction;

  it("rewrites a proven number unbox and the dynamic parameter to the externref carrier", () => {
    const unbox = { kind: "unbox", value: 0, tagId: JS_TAG_IDS.NumberF64, result: 1, resultType: f64 };
    const out = legalizeDynamicValues(fn([unbox as unknown as IrInstr]));
    expect(out.params[0]!.type).toEqual({ kind: "val", val: { kind: "externref" } });
    expect(out.blocks[0]!.instrs[0]).toMatchObject({ kind: "intrinsic", id: "js.number.unbox", args: [0] });
  });

  it("refuses to box a value outside the admitted set (a string)", () => {
    const box = { kind: "box", value: 0, toType: dynamic, result: 1, resultType: dynamic };
    expect(() => legalizeDynamicValues(fn([box as unknown as IrInstr], [{ kind: "string" }]))).toThrow(
      new DynamicValueGap("dynamic operation box of a non-primitive value has no Prepared intrinsic"),
    );
  });

  it("returns a function without a dynamic value unchanged", () => {
    const input = fn([], [f64]);
    expect(legalizeDynamicValues(input)).toBe(input);
  });
});
