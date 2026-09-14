// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { emitPreparedAsyncAwait } from "../src/ir/async-from-ast.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { typeNodeToIr } from "../src/ir/from-ast.js";
import { JS_TAG_IDS } from "../src/ir/js-tag-domain.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import type { RuntimeManifestPolicy } from "../src/runtime/contracts/provider-policy.js";
import { ts } from "../src/ts-api.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";

const host = { backend: "wasmgc", target: "host" } as const;
const dynamic = { kind: "dynamic" } as const;
const number = { kind: "val", val: { kind: "f64" } } as const;

function owner(parameter = "any", result = "Promise<any>", declarations = ""): string {
  return `export async function suspend(input: ${parameter})${result ? `: ${result}` : ""} {
  const value = await input;
  return value;
}
${declarations}`;
}

function request(files: Record<string, string> = { "./entry.ts": owner() }, policy: RuntimeManifestPolicy = host) {
  return { ...sourceInput(files), policy };
}

/** Check the actual source await before normalization introduces new SSA values. */
function sourcePositive(files: Record<string, string> = { "./entry.ts": owner() }) {
  const input = request(files);
  const source = prepareIrProgramSources(input);
  expect(source.kind, JSON.stringify(source.kind === "prepared" ? {} : source)).toBe("prepared");
  if (source.kind !== "prepared") throw new Error(source.detail);
  const fn = source.ir.functions.find((candidate) => candidate.name === "suspend");
  if (!fn) throw new Error("missing original any owner");
  expect(fn.params.map((param) => param.type)).toEqual([dynamic]);
  expect(fn.resultTypes).toEqual([dynamic]);
  const instructions = fn.blocks.flatMap((block) => block.instrs);
  const awaits = instructions.filter((instruction) => instruction.kind === "await");
  expect(awaits).toHaveLength(1);
  expect(awaits[0]).toMatchObject({ operand: fn.params[0]!.value, resultType: dynamic });
  expect(instructions.map((instruction) => instruction.kind)).toEqual(["await"]);
  return { input, fn };
}

function prepared(files: Record<string, string>) {
  const input = request(files);
  const result = prepareWholeIrProgram({ ...input, runtimePolicies: [host] });
  expect(result.kind, JSON.stringify(result.kind === "prepared" ? {} : result)).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(result.detail);
  const encoded = encodePreparedIrProgram(result.program);
  const program = decodePreparedIrProgram(encoded);
  expect(encodePreparedIrProgram(program)).toBe(encoded);
  const projections = program.runtime.filter((entry) => entry.backend === "wasmgc" && entry.target === "host");
  expect(projections).toHaveLength(1);
  const functions = projections[0]!.prepared.functions;
  const fn = functions.find((candidate) => candidate.name === "suspend");
  if (!fn?.asyncPlan || !fn.asyncRuntime) throw new Error("missing genuine prepared async attachment");
  expect(fn.asyncRuntime.kind).toBe("host-wasmgc");
  expect(fn.asyncPlan.abi.fulfillmentType).toEqual(dynamic);
  return { program, functions, fn, plan: fn.asyncPlan };
}

describe("#3527 logical any through prepared async source", () => {
  it.each([
    { id: "A01", files: { "./entry.ts": owner() } },
    { id: "A02", files: { "./entry.ts": owner("Input", "Promise<any>", "type Input = any;") } },
    {
      id: "A03",
      files: {
        "./types.ts": "export type Opaque<T> = T;",
        "./entry.ts": `import type { Opaque as Input } from "./types";\n${owner("Input<any>")}`,
      },
    },
    { id: "A04", files: { "./entry.ts": owner("any", "Output<any>", "type Output<T> = Promise<T>;") } },
    { id: "A05", files: { "./entry.ts": owner("any", "") } },
  ])("$id retains source, helper, resume and codec types", ({ files }) => {
    sourcePositive(files);
    const { program, functions, fn, plan } = prepared(files);
    expect(fn.params.map((param) => param.type)).toEqual([dynamic]);
    expect(plan.params.map((param) => param.type)).toEqual([dynamic]);
    expect(plan.values.every((value) => JSON.stringify(value.type) === JSON.stringify(dynamic))).toBe(true);
    const suspends = plan.states.filter((state) => state.terminator.kind === "suspend");
    expect(suspends).toHaveLength(1);
    const state = suspends[0]!;
    if (state.terminator.kind !== "suspend") throw new Error("missing source suspension");
    const terminator = state.terminator;
    const calls = state.body.filter((instruction) => instruction.kind === "call");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    if (call.target.binding.kind !== "unit") throw new Error("missing source-derived entry binding");
    expect(call.args).toEqual(fn.params.map((param) => param.value));
    expect(call.result).toBe(terminator.awaited);
    expect(call.resultType).toEqual(dynamic);
    const helperId = call.target.binding.unitId;
    const helper = functions.find((candidate) => candidate.unitId === helperId);
    if (!helper) throw new Error("entry helper is absent from the real prepared population");
    expect(program.derivedUnits).toContainEqual(expect.objectContaining({ id: helperId, parentId: fn.unitId }));
    expect(helper.params.map((param) => param.type)).toEqual([dynamic]);
    expect(helper.resultTypes).toEqual([dynamic]);
    expect(helper.blocks).toHaveLength(1);
    expect(helper.blocks[0]!.instrs).toEqual([]);
    expect(helper.blocks[0]!.terminator).toEqual({ kind: "return", values: [helper.params[0]!.value] });
    expect(plan.states.find((candidate) => candidate.id === terminator.resume.state)?.resume).toEqual({
      value: terminator.resume.value,
      type: dynamic,
      source: "fulfilled",
    });
  });

  it.each([
    { id: "L01", params: "input: any", tail: "const second = await first; return second;", spill: false },
    { id: "L02", params: "input: any, next: any", tail: "const second = await next; return first;", spill: true },
    {
      id: "L03",
      params: "input: any, next: Promise<number>",
      tail: "const second = await next; return first;",
      spill: true,
    },
  ])("$id preserves dynamic fulfillment through two real source awaits", ({ id, params, tail, spill }) => {
    const files = {
      "./entry.ts": `export async function suspend(${params}): Promise<any> {
  const first = await input;
  ${tail}
}`,
    };
    const { plan } = prepared(files);
    const suspends = plan.states.filter((state) => state.terminator.kind === "suspend");
    expect(suspends).toHaveLength(2);
    expect(plan.states).toHaveLength(3);
    const resumes = plan.states.flatMap((state) => (state.resume ? [state.resume] : []));
    expect(resumes.map((resume) => resume.type)).toEqual([dynamic, id === "L03" ? number : dynamic]);
    if (spill) {
      const first = resumes[0]!.value;
      expect(plan.spills).toContainEqual(expect.objectContaining({ value: first, type: dynamic }));
      expect(plan.states[2]!.terminator).toEqual({ kind: "resolve", value: first });
      expect(suspends[1]!.terminator).toMatchObject({ live: expect.arrayContaining([first]) });
    } else {
      expect(plan.spills).toEqual([]);
      expect(plan.states[2]!.terminator).toEqual({ kind: "resolve", value: resumes[1]!.value });
    }
  });

  it.each([
    { id: "N01", source: owner("unknown") },
    { id: "N02", source: owner("Missing") },
    { id: "N03", source: owner("{ value: number }") },
    {
      id: "N04",
      source: owner("Input", "Promise<any>", "interface Input { then(done: (value: any) => void): void; }"),
    },
    { id: "N05", source: owner("Input", "Promise<any>", "class Input { value!: number; }") },
    { id: "N06", source: owner("any", "Promise<any>", "class Promise<T> { value!: T; }") },
    { id: "N07", source: owner("any", "Promise<Missing>") },
    { id: "N08", source: owner("any", "Promise<unknown>") },
  ])("$id refuses a foreign type after a genuine any positive", ({ source }) => {
    sourcePositive();
    const result = prepareIrProgramSources(request({ "./entry.ts": source }));
    expect(result).toMatchObject({
      kind: "unsupported",
      code: "type-resolution-unsupported",
      stage: "build",
      location: { line: 1, column: 1 },
    });
  });

  it.each([
    { id: "P01", policy: { backend: "wasmgc", target: "standalone" } },
    { id: "P02", policy: { backend: "wasmgc", target: "wasi" } },
    { id: "P03", policy: { backend: "wasmgc", target: "strict-no-host" } },
    { id: "P04", policy: { backend: "linear", target: "host" } },
  ] as const)("$id keeps other physical projections explicit", ({ policy }) => {
    sourcePositive();
    expect(prepareIrProgramSources(request(undefined, policy))).toMatchObject({
      kind: "unsupported",
      code: "type-resolution-unsupported",
      detail: "ir/from-ast: unsupported type in Phase 1 (suspend)",
    });
  });

  it("P05 preserves regular-function source admission", () => {
    sourcePositive();
    expect(
      prepareIrProgramSources(request({ "./entry.ts": "export function suspend(input: any): any { return input; }" })),
    ).toMatchObject({
      kind: "unsupported",
      code: "type-resolution-unsupported",
    });
  });

  it("P06 leaves the primitive annotation parser unchanged", () => {
    sourcePositive();
    expect(() => typeNodeToIr(ts.factory.createKeywordTypeNode(ts.SyntaxKind.AnyKeyword), "suspend")).toThrow(
      "unsupported type in Phase 1",
    );
  });

  it("V01 rejects a prepared-site type mismatch after real dynamic emission", () => {
    const { fn } = sourcePositive();
    const builder = new IrFunctionBuilder({ unitId: fn.unitId, name: fn.name }, [dynamic]);
    builder.setFuncKind("async");
    const operand = builder.addParam("input", dynamic);
    builder.openBlock();
    const resumed = emitPreparedAsyncAwait(builder, operand, { operandType: dynamic, resultType: dynamic });
    expect(builder.valueType(resumed)).toEqual(dynamic);
    expect(() => emitPreparedAsyncAwait(builder, operand, { operandType: number, resultType: dynamic })).toThrow(
      "prepared await operand contradicts its semantic type",
    );
    builder.terminate({ kind: "return", values: [resumed] });
    expect(builder.finish().blocks[0]!.instrs.map((instruction) => instruction.kind)).toEqual(["await"]);
  });

  it("V02 refuses a refined dynamic operand after the unrefined positive", () => {
    const { fn } = sourcePositive();
    const refined = { kind: "dynamic", tag: JS_TAG_IDS.NumberF64 } as const;
    const builder = new IrFunctionBuilder({ unitId: fn.unitId, name: fn.name }, [dynamic]);
    builder.setFuncKind("async");
    const ordinary = builder.addParam("ordinary", dynamic);
    const operand = builder.addParam("refined", refined);
    builder.openBlock();
    emitPreparedAsyncAwait(builder, ordinary, { operandType: dynamic, resultType: dynamic });
    expect(() => emitPreparedAsyncAwait(builder, operand, { operandType: refined, resultType: dynamic })).toThrow(
      "prepared await cannot represent operand type dynamic",
    );
  });
});
