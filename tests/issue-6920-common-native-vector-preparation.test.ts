// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { requirePreparedLinearMemoryInput } from "../src/ir/program/linear-allocation-facts.js";
import { collectPreparedLinearMemoryDemand } from "../src/ir/program/linear-memory-demand.js";
import * as facts from "../src/ir/analysis/linear-memory-plan.js";

const policies = [
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
] as const;

afterEach(() => vi.restoreAllMocks());

describe("one native logical vector program for both Wasm backends", () => {
  it.each(policies)("prepares all projections from $backend/$target source selection", (policy) => {
    const source =
      "export function run(a: number, b: number): number { const xs: number[] = [a, b]; return xs[0] + xs[1] + xs.length; }";
    const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
    const producer = vi.spyOn(facts, "prepareLinearAllocationFacts");
    const result = prepareWholeIrProgram({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy,
      runtimePolicies: policies,
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    const program = result.program;
    expect(producer).toHaveBeenCalledTimes(1);
    expect(program.ir.functions.map((fn) => fn.name)).toEqual(["run"]);
    expect(program.allocations.size).toBe(1);
    expect(program.allocations).toBe(program.linearAllocationFacts!.facts.registry);
    expect(program.runtime.map(({ backend, target }) => ({ backend, target }))).toEqual(policies);
    const semantic = program.ir;
    const abi = program.abi;
    assertPreparedIrProgram(program);
    for (const projection of program.runtime) {
      expect(projection.prepared.functions.map((fn) => fn.unitId)).toEqual(semantic.functions.map((fn) => fn.unitId));
      if (projection.backend === "linear") {
        const input = requirePreparedLinearMemoryInput(program, projection);
        expect(input.facts).toBe(program.linearAllocationFacts!.facts);
        expect(input.module.functions[0]).toBe(projection.prepared.functions[0]);
        const demand = collectPreparedLinearMemoryDemand(input);
        expect(demand.occurrences.map((entry) => entry.kind)).toEqual([
          "vec.new_fixed",
          // Each indexed read first emits its own bounds-check length demand.
          "vec.len",
          "vec.get",
          "vec.len",
          "vec.get",
          "vec.len",
        ]);
      }
      expect(program.ir).toBe(semantic);
      expect(program.abi).toBe(abi);
    }
    expect(producer).toHaveBeenCalledTimes(1);
  });
});
