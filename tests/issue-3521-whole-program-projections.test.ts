// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { subscribePreparedIrProgram, type PreparedIrProgramObservation } from "../src/ir/program-observation.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import {
  freezePreparedIrValue,
  preparedIrDataMismatch,
  preparedIrReadonlyMap,
  type PreparedIrProgram,
} from "../src/ir/program.js";
import type { RuntimeManifestPolicy } from "../src/ir/runtime-manifest.js";
import type { IrInstr } from "../src/ir/nodes.js";

const HOST: RuntimeManifestPolicy = { backend: "wasmgc", target: "host" };
const LINEAR: RuntimeManifestPolicy = { backend: "linear", target: "host" };

function prepare(source: string, policies: readonly RuntimeManifestPolicy[]) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: HOST,
    runtimePolicies: policies,
    deferTopLevelInit: false,
  });
}

function intrinsic(program: PreparedIrProgram, projection?: number): Extract<IrInstr, { kind: "intrinsic" }> {
  const fn = projection === undefined ? program.ir.functions[0]! : program.runtime[projection]!.prepared.functions[0]!;
  const instruction = fn.blocks[0]!.instrs.find((item) => item.kind === "intrinsic");
  if (!instruction || instruction.kind !== "intrinsic") throw new Error("positive intrinsic population disappeared");
  return instruction;
}

describe("one semantic program with complete runtime projections", () => {
  it("prepares once for both backends and independently validates actual provider attachments", () => {
    const observations: PreparedIrProgramObservation[] = [];
    const unsubscribe = subscribePreparedIrProgram((event) => observations.push(event));
    let result: ReturnType<typeof prepare>;
    try {
      result = prepare("export function root(value: number): number { return Math.sqrt(value); }", [HOST, LINEAR]);
    } finally {
      unsubscribe();
    }
    if (result.kind !== "prepared") throw new Error(result.detail);
    const { program } = result;
    expect(program.inventory.terminalUnits).toHaveLength(1);
    expect(program.runtime.map((item) => `${item.backend}:${item.target}`)).toEqual(["wasmgc:host", "linear:host"]);
    expect(observations.map((event) => event.phase)).toEqual(["prepared"]);
    expect(observations[0]!.program).toBe(program);
    expect(intrinsic(program).provider).toBeUndefined();
    for (const index of [0, 1]) {
      expect(intrinsic(program, index).provider).toEqual({ kind: "backend-op", opcode: "f64.sqrt" });
      expect(program.runtime[index]!.prepared.functions[0]!.blocks).not.toBe(program.ir.functions[0]!.blocks);
    }
    expect(() => assertPreparedIrProgram(program)).not.toThrow();
    const replayed = { ...program, runtime: freezePreparedIrValue(program.runtime) as PreparedIrProgram["runtime"] };
    expect(replayed.runtime[0]!.prepared.functions[0]!.blocks).not.toBe(
      program.runtime[0]!.prepared.functions[0]!.blocks,
    );
    expect(() => assertPreparedIrProgram(replayed)).not.toThrow();
    const projection = program.runtime[1]!;
    const fn = projection.prepared.functions[0]!;
    const changed = {
      ...fn,
      blocks: fn.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((item) =>
          item.kind === "intrinsic"
            ? { ...item, provider: { kind: "backend-op" as const, opcode: "f64.abs" as const } }
            : item,
        ),
      })),
    };
    const invalid = {
      ...program,
      runtime: [program.runtime[0]!, { ...projection, prepared: { ...projection.prepared, functions: [changed] } }],
    };
    expect(() => assertPreparedIrProgram(invalid)).toThrow("provider");
    expect(() => assertPreparedIrProgram({ ...program, ir: { functions: projection.prepared.functions } })).toThrow(
      "physical intrinsic provider",
    );
    const wrongProviders = {
      ...projection,
      prepared: {
        ...projection.prepared,
        providers: preparedIrReadonlyMap([...projection.prepared.providers].slice(0, 0)),
      },
    };
    expect(() => assertPreparedIrProgram({ ...program, runtime: [program.runtime[0]!, wrongProviders] })).toThrow(
      "providers",
    );
  });

  it("requires independently authenticated async joins after a lossless data reconstruction", () => {
    const result = prepare(
      "export async function chain(value: number): Promise<number> { const first = await value; const second = await first; return second; }",
      [HOST],
    );
    if (result.kind !== "prepared") throw new Error(result.detail);
    const { program } = result;
    const semantic = program.ir.functions.find((fn) => fn.asyncPlan)!;
    const runtime = program.runtime[0]!.prepared.functions.find((fn) => fn.unitId === semantic.unitId)!;
    expect(semantic.asyncRuntime).toBeUndefined();
    expect(runtime.asyncPlan).not.toBe(semantic.asyncPlan);
    expect(preparedIrDataMismatch(runtime.asyncPlan, semantic.asyncPlan)).toBeUndefined();
    expect(() => assertPreparedIrProgram(program)).not.toThrow();
    const copied = freezePreparedIrValue(program.runtime) as PreparedIrProgram["runtime"];
    expect(preparedIrDataMismatch(program.runtime, copied)).toBeUndefined();
    expect(() => assertPreparedIrProgram({ ...program, runtime: copied })).toThrow("exact semantic plan owner");
  });

  it("rejects ambiguous backend/target pairs even when their nested policies differ", () => {
    expect(() =>
      prepare("export function root(value: number): number { return Math.sqrt(value); }", [
        HOST,
        { ...HOST, numberBoundary: { box: "host", unbox: "host" } },
      ]),
    ).toThrow("duplicate a backend/target pair");
  });
});
