// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import type { IrType } from "../src/ir/core/types.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import type { RuntimeManifestPolicy } from "../src/runtime/contracts/provider-policy.js";
import { sourceInput } from "./helpers/typed-program-fixtures.js";

const host = { backend: "wasmgc", target: "host" } as const;
const ext = { kind: "val", val: { kind: "externref" } } as const;
const number = { kind: "val", val: { kind: "f64" } } as const;

function owner(parameter = "Promise<number>", declarations = "", declaredResult = true): string {
  return `export async function suspend(input: ${parameter})${declaredResult ? ": Promise<number>" : ""} {
  const value = await input;
  return value;
}
${declarations}`;
}

function request(files: Record<string, string> = { "./entry.ts": owner() }, policy: RuntimeManifestPolicy = host) {
  return { ...sourceInput(files), policy };
}

/** Prove a real source await remains; an externref parameter alone is insufficient. */
function sourcePositive(files?: Record<string, string>, parameterType: IrType = ext, fulfillmentType: IrType = number) {
  const result = prepareIrProgramSources(request(files));
  expect(result.kind, JSON.stringify(result.kind === "prepared" ? {} : result)).toBe("prepared");
  if (result.kind !== "prepared") throw new Error(result.detail);
  const fn = result.ir.functions.find((fn) => fn.name === "suspend");
  expect(fn).toBeDefined();
  if (!fn) throw new Error("missing original async owner");
  expect(fn.params.map((param) => param.type)).toEqual([parameterType]);
  expect(fn.resultTypes).toEqual([fulfillmentType]);
  const awaits = fn.blocks.flatMap((block) => block.instrs).filter((instr) => instr.kind === "await");
  expect(awaits).toHaveLength(1);
  expect(awaits[0]).toMatchObject({ operand: fn.params[0]!.value, resultType: fulfillmentType });
}

describe("#3527 checker-authenticated pending Promise parameters", () => {
  const positives: { label: string; files: Record<string, string> }[] = [
    { label: "direct ambient Promise", files: { "./entry.ts": owner() } },
    {
      label: "local alias",
      files: { "./entry.ts": owner("Pending", "type Pending = Promise<number>;") },
    },
    {
      label: "chained generic alias",
      files: {
        "./entry.ts": owner(
          "Pending<Scalar>",
          "type Scalar = number; type Box<T> = Promise<T>; type Pending<T> = Box<T>;",
        ),
      },
    },
    {
      label: "imported renamed alias",
      files: {
        "./types.ts": "export type Input = Promise<number>;",
        "./entry.ts": `import type { Input as Pending } from "./types";\n${owner("Pending")}`,
      },
    },
  ];
  it.each(positives)("preserves $label through the complete producer and codec", ({ files }) => {
    const input = request(files);
    const result = prepareWholeIrProgram({ ...input, runtimePolicies: [host] });
    expect(result.kind, JSON.stringify(result.kind === "prepared" ? {} : result)).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    const encoded = encodePreparedIrProgram(result.program);
    const program = decodePreparedIrProgram(encoded);
    expect(encodePreparedIrProgram(program)).toBe(encoded);
    const projections = program.runtime.filter((entry) => entry.backend === "wasmgc" && entry.target === "host");
    expect(projections).toHaveLength(1);
    const fn = projections[0]!.prepared.functions.find((fn) => fn.name === "suspend");
    if (!fn?.asyncPlan || !fn.asyncRuntime) throw new Error("source owner has no real prepared async attachment");
    expect(fn.params.map((param) => param.type)).toEqual([ext]);
    expect(fn.asyncPlan.params.map((param) => param.type)).toEqual([ext]);
    expect(fn.asyncPlan.abi).toMatchObject({ fulfillmentType: number, consumerContract: "promise-only" });
    const suspends = fn.asyncPlan.states.filter((state) => state.terminator.kind === "suspend");
    expect(suspends).toHaveLength(1);
    const terminator = suspends[0]!.terminator;
    if (terminator.kind !== "suspend") throw new Error("missing source suspension");
    const entries = suspends[0]!.body.filter((instr) => instr.kind === "call" && instr.result === terminator.awaited);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    if (entry.kind !== "call" || entry.target.binding.kind !== "unit") throw new Error("missing owned entry helper");
    expect(entry.args).toEqual(fn.params.map((param) => param.value));
    expect(entry.resultType).toEqual(ext);
    const entryUnitId = entry.target.binding.unitId;
    const helper = projections[0]!.prepared.functions.find((candidate) => candidate.unitId === entryUnitId);
    if (!helper) throw new Error("entry call does not resolve to a prepared source-derived helper");
    expect(program.derivedUnits).toContainEqual(expect.objectContaining({ id: helper.unitId, parentId: fn.unitId }));
    expect(helper.params.map((param) => param.type)).toEqual([ext]);
    expect(helper.blocks).toHaveLength(1);
    expect(helper.blocks[0]!.instrs).toEqual([]);
    expect(helper.blocks[0]!.terminator).toEqual({ kind: "return", values: [helper.params[0]!.value] });
    const resume = fn.asyncPlan.states.find((state) => state.id === terminator.resume.state)?.resume;
    expect(resume).toEqual({ value: terminator.resume.value, type: number, source: "fulfilled" });
    expect(fn.asyncRuntime.kind).toBe("host-wasmgc");
    if (fn.asyncRuntime.kind !== "host-wasmgc") throw new Error("host parameter acquired another carrier");
    expect(fn.asyncRuntime.adapters.map((adapter) => adapter.capability)).toEqual(
      expect.arrayContaining(["async.promise.resolve", "async.promise.react", "number.box", "number.unbox"]),
    );
  });

  it("preserves the original inferred-any source and its prepared await", () => {
    const dynamic = { kind: "dynamic" } as const;
    // This is the exact former refusal fixture, including its inferred return.
    const files = { "./entry.ts": owner("any", "", false) };
    sourcePositive(files, dynamic, dynamic);
    const input = request(files);
    const result = prepareWholeIrProgram({ ...input, runtimePolicies: [host] });
    expect(result.kind, JSON.stringify(result.kind === "prepared" ? {} : result)).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    const projection = result.program.runtime.find((entry) => entry.backend === "wasmgc" && entry.target === "host");
    const fn = projection?.prepared.functions.find((candidate) => candidate.name === "suspend");
    if (!fn?.asyncPlan) throw new Error("inferred any lost its real async plan");
    expect(fn.params.map((param) => param.type)).toEqual([dynamic]);
    expect(fn.asyncPlan.params.map((param) => param.type)).toEqual([dynamic]);
    expect(fn.asyncPlan.abi.fulfillmentType).toEqual(dynamic);
    const suspends = fn.asyncPlan.states.filter((state) => state.terminator.kind === "suspend");
    expect(suspends).toHaveLength(1);
    const state = suspends[0]!;
    const terminator = state.terminator;
    if (terminator.kind !== "suspend") throw new Error("inferred any lost its source suspension");
    const entries = state.body.filter((instr) => instr.kind === "call" && instr.result === terminator.awaited);
    expect(entries).toHaveLength(1);
    const entry = entries[0]!;
    if (entry.kind !== "call" || entry.target.binding.kind !== "unit") throw new Error("missing dynamic entry helper");
    expect(entry.args).toEqual(fn.params.map((param) => param.value));
    expect(entry.resultType).toEqual(dynamic);
    const helperId = entry.target.binding.unitId;
    const helper = projection!.prepared.functions.find((candidate) => candidate.unitId === helperId);
    if (!helper) throw new Error("dynamic entry helper is outside the prepared population");
    expect(result.program.derivedUnits).toContainEqual(expect.objectContaining({ id: helperId, parentId: fn.unitId }));
    expect(helper.params.map((param) => param.type)).toEqual([dynamic]);
    expect(helper.resultTypes).toEqual([dynamic]);
    expect(helper.blocks).toHaveLength(1);
    expect(helper.blocks[0]!.instrs).toEqual([]);
    expect(helper.blocks[0]!.terminator).toEqual({ kind: "return", values: [helper.params[0]!.value] });
    expect(fn.asyncPlan.states.find((candidate) => candidate.id === terminator.resume.state)?.resume).toEqual({
      value: terminator.resume.value,
      type: dynamic,
      source: "fulfilled",
    });
  });

  it.each([
    {
      label: "user class named Promise",
      parameter: "Promise<number>",
      declarations: "class Promise<T> { value!: T; }",
    },
    {
      label: "alias to user class",
      parameter: "Pending",
      declarations: "class Deferred { value!: number; } type Pending = Deferred;",
    },
    { label: "plain object", parameter: "{ value: number }", declarations: "" },
    {
      label: "structural thenable",
      parameter: "Pending",
      declarations: "interface Pending { then(done: (value: number) => void): void; }",
    },
    { label: "any fulfillment", parameter: "Promise<any>", declarations: "" },
    { label: "unknown fulfillment", parameter: "Promise<unknown>", declarations: "" },
    { label: "string fulfillment", parameter: "Promise<string>", declarations: "" },
    { label: "boolean fulfillment", parameter: "Promise<boolean>", declarations: "" },
    { label: "void fulfillment", parameter: "Promise<void>", declarations: "" },
    { label: "mixed fulfillment", parameter: "Promise<number | string>", declarations: "" },
  ])("refuses $label after a real source positive", ({ parameter, declarations }) => {
    sourcePositive();
    // The function precedes type/class declarations, so a later unsupported
    // class body cannot masquerade as the parameter-contract refusal.
    const result = prepareIrProgramSources(request({ "./entry.ts": owner(parameter, declarations, false) }));
    expect(result).toMatchObject({
      kind: "unsupported",
      code: "type-resolution-unsupported",
      stage: "build",
      detail: "ir/from-ast: unsupported type in Phase 1 (suspend)",
      location: { line: 1, column: 1 },
    });
  });

  it("keeps the standalone carrier outside this host projection", () => {
    sourcePositive();
    const result = prepareIrProgramSources(request(undefined, { backend: "wasmgc", target: "standalone" }));
    expect(result).toMatchObject({
      kind: "unsupported",
      code: "type-resolution-unsupported",
      detail: "ir/from-ast: unsupported type in Phase 1 (suspend)",
    });
  });

  it("does not admit regular Promise parameters through the async-only seam", () => {
    sourcePositive();
    const result = prepareIrProgramSources(
      request({ "./entry.ts": "export function suspend(input: Promise<number>): number { return 1; }" }),
    );
    expect(result).toMatchObject({
      kind: "unsupported",
      code: "type-resolution-unsupported",
      detail: "ir/from-ast: unsupported type in Phase 1 (suspend)",
    });
  });
});
