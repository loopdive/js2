// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { requirePreparedLinearMemoryInput } from "../src/ir/program/linear-allocation-facts.js";
import { collectPreparedLinearMemoryDemand } from "../src/ir/program/linear-memory-demand.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { IrUnsupportedError } from "../src/shared/contracts/ir-preparation-errors.js";
import { forEachInstrDeep } from "../src/ir/core/nodes.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";

const source = "export function run(a:number,b:number):number {const xs=[a,b];return xs[0]+xs[1]+xs.length;}";

function producer(text = source, target: "standalone" | "wasi" = "standalone") {
  const ast = analyzeMultiSource({ "./entry.ts": text }, "./entry.ts");
  const policy = { backend: "linear" as const, target };
  const lowered = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (lowered.kind !== "prepared") throw new Error(`${lowered.kind}: ${lowered.detail}`);
  const program = requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(lowered), {
      ...typedOptions,
      policy,
      runtimePolicies: [policy],
    }),
  );
  return { program, input: requirePreparedLinearMemoryInput(program, program.runtime[0]!) };
}

function atPath(value: unknown, path: readonly (string | number)[]): unknown {
  for (const part of path) value = (value as Record<string | number, unknown>)[part];
  return value;
}

function refusal(run: () => unknown): IrUnsupportedError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(IrUnsupportedError);
    if (error instanceof IrUnsupportedError) return error;
    throw error;
  }
  throw new Error("expected a located refusal");
}

describe("checked prepared Linear semantic memory demand (collector)", () => {
  it.each(["standalone", "wasi"] as const)(
    "collects the actual selected %s producer module without mutation",
    (target) => {
      const { input } = producer(source, target);
      const before = structuredClone(input);
      const demand = collectPreparedLinearMemoryDemand(input);
      expect(input).toEqual(before);
      expect(demand.occurrences.map((row) => row.kind)).toEqual([
        "vec.new_fixed",
        "vec.len",
        "vec.get",
        "vec.len",
        "vec.get",
        "vec.len",
      ]);
      const construction = demand.occurrences[0]!;
      expect(construction).toMatchObject({
        allocationId: input.facts.allocations[0]!.id,
        vectorValue: input.module.functions[0]!.blocks[0]!.instrs[0]!.result,
        lookups: ["allocate", "initialize-element"],
        length: 2,
        capacity: 2,
      });
      for (const row of demand.occurrences) {
        const fn = input.module.functions[row.functionIndex]!;
        const instr = atPath(input.module, row.instructionPath);
        expect(instr).toMatchObject({ kind: row.kind });
        expect(row.unitId).toBe(fn.unitId);
        expect(row.ownerFunction).toBe(fn.name);
        expect(atPath(input.module, row.constructionPath)).toMatchObject({
          kind: "vec.new_fixed",
          alloc: row.allocationId,
        });
        if (row.kind !== "vec.new_fixed") expect(row.lookups).toEqual(["resolve-forwarding"]);
      }
      const nested = demand.occurrences.filter((row) => row.kind === "vec.get");
      expect(nested).toHaveLength(2);
      expect(nested.every((row) => row.instructionPath.includes("then"))).toBe(true);
      expect(Object.isFrozen(demand)).toBe(true);
      expect(Object.isFrozen(demand.occurrences)).toBe(true);
      expect(demand.occurrences.every((row) => Object.isFrozen(row) && Object.isFrozen(row.instructionPath))).toBe(
        true,
      );
    },
  );

  it("joins two live allocations across two real owners without collapsing local SSA identities", () => {
    const { input } = producer(
      "export function first(a:number,b:number):number {const xs=[a,b];return xs[0]+xs.length;}" +
        "export function second(a:number,b:number):number {const ys=[b,a];return ys[1]+ys.length;}",
    );
    expect(input.facts.allocations).toHaveLength(2);
    const rows = collectPreparedLinearMemoryDemand(input).occurrences;
    const news = rows.filter((row) => row.kind === "vec.new_fixed");
    expect(news).toHaveLength(2);
    expect(new Set(news.map((row) => row.unitId)).size).toBe(2);
    expect(new Set(news.map((row) => row.allocationId)).size).toBe(2);
    expect(new Set(news.map((row) => row.vectorValue)).size).toBe(1);
    for (const construction of news) {
      const uses = rows.filter((row) => row.functionIndex === construction.functionIndex);
      expect(uses.length).toBeGreaterThan(1);
      expect(
        uses.every((row) => row.allocationId === construction.allocationId && row.unitId === construction.unitId),
      ).toBe(true);
    }
  });

  it("keeps both allocation associations within one real function", () => {
    const { input } = producer(
      "export function run(a:number,b:number):number {const xs=[a,b];const ys=[b,a];return xs[0]+ys[1]+xs.length+ys.length;}",
    );
    const rows = collectPreparedLinearMemoryDemand(input).occurrences;
    const news = rows.filter((row) => row.kind === "vec.new_fixed");
    expect(news).toHaveLength(2);
    expect(new Set(news.map((row) => row.vectorValue)).size).toBe(2);
    for (const row of rows) {
      expect(news.find((construction) => construction.vectorValue === row.vectorValue)?.allocationId).toBe(
        row.allocationId,
      );
    }
  });

  it("requires the genuine constructor initializer lookup even when no element is written", () => {
    const { input } = producer("export function run():number {const xs:number[]=[];return xs.length;}");
    const rows = collectPreparedLinearMemoryDemand(input).occurrences;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "vec.new_fixed",
      length: 0,
      capacity: 0,
      lookups: ["allocate", "initialize-element"],
    });
    expect(rows[1]).toMatchObject({
      kind: "vec.len",
      allocationId: rows[0]!.allocationId,
      lookups: ["resolve-forwarding"],
    });
  });

  it("replays authentic decoded producer evidence with identical semantic demand", () => {
    const { program, input } = producer();
    const decoded = decodePreparedIrProgram(encodePreparedIrProgram(program));
    const replay = requirePreparedLinearMemoryInput(decoded, decoded.runtime[0]!);
    expect(collectPreparedLinearMemoryDemand(replay)).toEqual(collectPreparedLinearMemoryDemand(input));
  });

  it("keeps real scalar demand empty without allocating an idle pack", () => {
    const { input } = producer("export function run(a:number,b:number):number {return a+b;}");
    expect(input.facts.allocations).toHaveLength(0);
    expect(collectPreparedLinearMemoryDemand(input)).toEqual({ occurrences: [] });
  });

  it("reports a newly introduced source-growth operation at its exact position", () => {
    const { input } = producer();
    const changed = structuredClone(input);
    const first = changed.module.functions[0]!.blocks[0]!.instrs[0]!;
    const instrs = [
      ...changed.module.functions[0]!.blocks[0]!.instrs,
      {
        kind: "vec.set_length" as const,
        result: null,
        resultType: null,
        vec: first.result!,
        length: changed.module.functions[0]!.blocks[0]!.instrs[1]!.result!,
      },
    ];
    const fn = changed.module.functions[0]!;
    const mutated = {
      ...changed,
      module: { ...changed.module, functions: [{ ...fn, blocks: [{ ...fn.blocks[0]!, instrs }] }] },
    };
    const error = refusal(() => collectPreparedLinearMemoryDemand(mutated));
    expect(error.message).toContain("vec.set_length");
    expect(error.cause).toMatchObject({
      unitId: fn.unitId,
      functionIndex: 0,
      ownerFunction: fn.name,
      instructionPath: ["functions", 0, "blocks", 0, "instrs", instrs.length - 1],
    });
  });

  it("refuses an operand detached from its actual local construction instead of choosing the first allocation", () => {
    const { input } = producer();
    const changed = structuredClone(input);
    const fn = changed.module.functions[0]!;
    const roots = fn.blocks[0]!.instrs.map((instr) =>
      instr.kind === "vec.len" ? { ...instr, vec: fn.params[0]!.value } : instr,
    );
    const mutated = {
      ...changed,
      module: { ...changed.module, functions: [{ ...fn, blocks: [{ ...fn.blocks[0]!, instrs: roots }] }] },
    };
    const error = refusal(() => collectPreparedLinearMemoryDemand(mutated));
    expect(error.message).toContain("no exact local fixed-construction allocation");
    expect(error.cause).toMatchObject({
      unitId: fn.unitId,
      instructionPath: ["functions", 0, "blocks", 0, "instrs", 2],
    });
  });

  it("checks every malformed fact before an earlier source-growth coverage refusal", () => {
    const { input } = producer();
    const changed = structuredClone(input);
    const fn = changed.module.functions[0]!;
    const instrs = [
      {
        kind: "vec.set_length" as const,
        result: null,
        resultType: null,
        vec: fn.params[0]!.value,
        length: fn.params[1]!.value,
      },
      ...fn.blocks[0]!.instrs,
    ];
    const mutated = {
      module: { ...changed.module, functions: [{ ...fn, blocks: [{ ...fn.blocks[0]!, instrs }] }] },
      facts: { ...changed.facts, allocations: [{ ...changed.facts.allocations[0]!, ownership: "escaped" as const }] },
    };
    expect(() => collectPreparedLinearMemoryDemand(mutated)).toThrow(PreparedIrProgramInvariantError);
    expect(() => collectPreparedLinearMemoryDemand(mutated)).toThrow("disagrees with ownership evidence");
  });

  it("screens DATA accessors before evaluating or traversing them", () => {
    const { input } = producer();
    const getter = vi.fn(() => input.facts);
    const changed = { ...input };
    Object.defineProperty(changed, "facts", { enumerable: true, get: getter });
    expect(() => collectPreparedLinearMemoryDemand(changed)).toThrow(PreparedIrProgramInvariantError);
    expect(getter).not.toHaveBeenCalled();
  });

  it("reports a public vector result ABI at the actual owner signature", () => {
    const { input } = producer();
    const fn = input.module.functions[0]!;
    const construction = fn.blocks[0]!.instrs[0]!;
    const mutated = {
      ...input,
      module: { ...input.module, functions: [{ ...fn, resultTypes: [construction.resultType!] }] },
    };
    const error = refusal(() => collectPreparedLinearMemoryDemand(mutated));
    expect(error.message).toContain("public vector result ABI");
    expect(error.cause).toMatchObject({ unitId: fn.unitId, instructionPath: ["functions", 0, "resultTypes", 0] });
  });

  it("retains every canonical nested read occurrence from the genuine producer", () => {
    const { input } = producer();
    const canonical: string[] = [];
    for (const fn of input.module.functions)
      for (const block of fn.blocks)
        for (const root of block.instrs)
          forEachInstrDeep(root, (instr) => {
            if (instr.kind === "vec.new_fixed" || instr.kind === "vec.len" || instr.kind === "vec.get")
              canonical.push(instr.kind);
          });
    expect(canonical).toHaveLength(6);
    expect(collectPreparedLinearMemoryDemand(input).occurrences.map((row) => row.kind)).toEqual(canonical);
  });
});
