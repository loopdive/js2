// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it, vi, afterEach } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import {
  assertPreparedIrProgramShape,
  encodePreparedIrProgram,
  decodePreparedIrProgram,
  decodePreparedIrProgramData,
} from "../src/ir/program-codec.js";
import { verifyLinearPreparedAllocationFacts } from "../src/ir/analysis/linear-memory-plan.js";
import { planPhysicalSetup } from "../src/ir/program-physical-plan.js";
import { typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { replayOptions } from "./helpers/ir-whole-program-replay.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";

const arraySource =
  "export function sample(a: number, b: number): number { const xs: number[] = [a, b]; return xs[0] + xs[1] + xs.length; }";

function input(source = arraySource, target: "standalone" | "wasi" = "standalone") {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  return {
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "linear" as const, target },
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64" as const,
  };
}

function prepare(source = arraySource, target: "standalone" | "wasi" = "standalone") {
  const request = input(source, target);
  const lowered = prepareIrProgramSources(request);
  if (lowered.kind !== "prepared") throw new Error(`${lowered.kind}: ${lowered.detail}`);
  const program = requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(lowered), {
      ...typedOptions,
      policy: request.policy,
      runtimePolicies: [request.policy],
    }),
  );
  return { lowered, program };
}

function withFacts(program: PreparedIrProgram, patch: Record<string, unknown>): PreparedIrProgram {
  return { ...program, linearAllocationFacts: { ...program.linearAllocationFacts!, ...patch } } as PreparedIrProgram;
}

afterEach(() => vi.restoreAllMocks());

describe("native Linear source facts and persisted preparation DATA", () => {
  it.each(["standalone", "wasi"] as const)(
    "prepares the real numeric array source under %s with final exact evidence",
    (target) => {
      const { lowered, program } = prepare(arraySource, target);
      expect(lowered.inventory.terminalUnits).toHaveLength(1);
      expect(lowered.ir.functions[0]!.name).toBe("sample");
      expect(program.linearAllocationFacts?.schema).toBe("linear-allocation-facts-v1");
      const facts = program.linearAllocationFacts!.facts;
      expect(facts.allocations).toHaveLength(1);
      expect(facts.registry).toEqual(program.allocations);
      expect(facts.allocations[0]!.site.kind).toBe("array");
      expect(facts.allocations[0]!.site.type.kind).toBe("vec");
      expect(facts.allocations[0]!.evidence.ownership.present).toBe(true);
      expect(facts.allocations[0]!.evidence.escape.present).toBe(true);
      verifyLinearPreparedAllocationFacts(program.ir, facts);
      verifyLinearPreparedAllocationFacts({ ...program.ir, functions: program.runtime[0]!.prepared.functions }, facts);
      const bytes = encodePreparedIrProgram(program);
      const decoded = decodePreparedIrProgram(bytes);
      expect(decoded.linearAllocationFacts).toEqual(program.linearAllocationFacts);
      expect(encodePreparedIrProgram(decoded)).toBe(bytes);
      const refused = planPhysicalSetup(decoded, replayOptions("linear", target), decoded.runtime[0]!);
      expect(refused.kind).toBe("unsupported");
      if (refused.kind !== "unsupported") throw new Error("array physical resources were unexpectedly materialized");
      expect(refused.detail).toContain("linear memory plan");
      expect(refused.unitId).toBe(program.inventory.terminalUnits[0]!.id);
    },
  );

  it("keeps old native scalar programs valid without the optional attachment", () => {
    const { program } = prepare("export function twice(x: number): number { return x * 2; }");
    expect(program.linearAllocationFacts!.facts.allocations).toHaveLength(0);
    const { linearAllocationFacts: _facts, ...old } = program;
    assertPreparedIrProgram(old);
    expect(decodePreparedIrProgram(encodePreparedIrProgram(old)).linearAllocationFacts).toBeUndefined();
  });

  it.each([
    ["unknown schema", { schema: "linear-allocation-facts-v2" }],
    ["extra field", { forged: true }],
    ["missing facts", { facts: undefined }],
  ])("refuses %s in both direct validation and the codec", (_label, patch) => {
    const broken = withFacts(prepare().program, patch);
    expect(() => assertPreparedIrProgram(broken)).toThrow();
    expect(() => assertPreparedIrProgramShape(broken)).toThrow();
    expect(() => encodePreparedIrProgram(broken)).toThrow();
  });

  it("refuses a facts accessor without evaluating it", () => {
    const program = prepare().program;
    const getter = vi.fn(() => program.linearAllocationFacts);
    const broken = { ...program };
    Object.defineProperty(broken, "linearAllocationFacts", { enumerable: true, get: getter });
    expect(() => assertPreparedIrProgram(broken)).toThrow("accessor");
    expect(() => assertPreparedIrProgramShape(broken)).toThrow("accessor");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["site", "evidence", "registry"] as const)("rejects nested %s accessors before executing them", (field) => {
    const program = prepare().program;
    const facts = program.linearAllocationFacts!.facts;
    const fact = { ...facts.allocations[0]! };
    const getter = vi.fn(() => undefined);
    let changed = { ...facts };
    if (field === "site") {
      const site = { ...fact.site };
      Object.defineProperty(site, "id", { enumerable: true, get: getter });
      changed = { ...facts, allocations: [{ ...fact, site }] };
    } else if (field === "evidence") {
      const value = { ...fact.evidence.ownership.value };
      Object.defineProperty(value, "state", { enumerable: true, get: getter });
      changed = {
        ...facts,
        allocations: [{ ...fact, evidence: { ...fact.evidence, ownership: { ...fact.evidence.ownership, value } } }],
      };
    } else {
      const registry = { ...facts.registry };
      Object.defineProperty(registry, "entries", { enumerable: true, get: getter });
      changed = { ...facts, registry };
    }
    const broken = withFacts(program, { facts: changed });
    expect(() => assertPreparedIrProgramShape(broken)).toThrow("non-executable");
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["allocation", "runtime", "semantic"] as const)(
    "screens the joined %s graph before direct physical reads",
    (field) => {
      const program = prepare().program;
      const valid = planPhysicalSetup(program, replayOptions("linear", "standalone"), program.runtime[0]!);
      expect(valid.kind).toBe("unsupported");
      const getter = vi.fn();
      let broken: PreparedIrProgram;
      if (field === "allocation") {
        const allocations = { ...program.allocations };
        Object.defineProperty(allocations, "entries", { enumerable: true, get: getter });
        broken = { ...program, allocations };
      } else if (field === "runtime") {
        const prepared = { ...program.runtime[0]!.prepared };
        Object.defineProperty(prepared, "functions", { enumerable: true, get: getter });
        broken = { ...program, runtime: [{ ...program.runtime[0]!, prepared }] };
      } else {
        const fn = { ...program.ir.functions[0]! };
        Object.defineProperty(fn, "blocks", { enumerable: true, get: getter });
        broken = { ...program, ir: { ...program.ir, functions: [fn] } };
      }
      expect(() => planPhysicalSetup(broken, replayOptions("linear", "standalone"), broken.runtime[0]!)).toThrow(
        PreparedIrProgramInvariantError,
      );
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it("refuses missing, extra and stale allocation facts without recomputing evidence", () => {
    const program = prepare().program;
    const facts = program.linearAllocationFacts!.facts;
    for (const allocations of [
      [],
      [...facts.allocations, facts.allocations[0]!],
      [
        {
          ...facts.allocations[0]!,
          evidence: {
            ...facts.allocations[0]!.evidence,
            ownership: { ...facts.allocations[0]!.evidence.ownership, present: false },
          },
        },
      ],
    ]) {
      const broken = withFacts(program, { facts: { ...facts, allocations } });
      expect(() => assertPreparedIrProgram(broken)).toThrow();
      expect(() => encodePreparedIrProgram(broken)).toThrow();
    }
  });

  it("refuses a final registry mismatch and a runtime projection with a missing allocation owner", () => {
    const program = prepare().program;
    const broken = { ...program, allocations: { size: 0, entries: [], metadata: [] } };
    expect(() => assertPreparedIrProgramShape(broken)).toThrow("registry differs");
    const projection = program.runtime[0]!;
    const changed = { ...program, runtime: [{ ...projection, prepared: { ...projection.prepared, functions: [] } }] };
    expect(() => assertPreparedIrProgramShape(changed)).toThrow("allocation population");
  });

  it("keeps allocating historical Linear DATA explicitly unsupported when evidence is absent", () => {
    const program = prepare().program;
    const { linearAllocationFacts: _facts, ...old } = program;
    const refused = planPhysicalSetup(old, replayOptions("linear", "standalone"), old.runtime[0]!);
    expect(refused.kind).toBe("unsupported");
    if (refused.kind !== "unsupported") throw new Error("historical allocating program was accepted");
    expect(refused.detail).toContain("no final linear-allocation-facts-v1 attachment");
  });

  it("preserves raw surrogate halves and explicit undefined extension metadata through codec replay", () => {
    const request = input(arraySource + " // \ud800x\udc00");
    const sourceMap = {
      kind: "capture-source-map" as const,
      sources: request.sourceFiles.map((sourceFile) => ({
        sourceFile,
        projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
      })),
    };
    const lowered = prepareIrProgramSources({ ...request, sourceMap });
    if (lowered.kind !== "prepared") throw new Error(lowered.detail);
    const site = lowered.allocations.liveSites()[0]!;
    lowered.allocations.annotate(site.id, "6865.explicit-undefined", undefined);
    const program = requireProgram(
      prepareTypedIrProgram(captureTypedIrProgramInput(lowered), {
        ...typedOptions,
        policy: request.policy,
        runtimePolicies: [request.policy],
      }),
    );
    const bytes = encodePreparedIrProgram(program);
    const replay = decodePreparedIrProgram(bytes);
    expect(encodePreparedIrProgram(replay)).toBe(bytes);
    expect(replay.linearAllocationFacts).toEqual(program.linearAllocationFacts);
    const fact = replay.linearAllocationFacts!.facts.allocations[0]!;
    expect(Object.hasOwn(fact, "encoding")).toBe(false);
    expect(fact.encoding).toBeUndefined();
    expect(fact.evidence.encoding.present).toBe(false);
    expect(Object.hasOwn(fact.evidence.encoding, "value")).toBe(true);
    const cell = replay.allocations.metadata
      .find((row) => row.id === site.id)!
      .entries.find(([namespace]) => namespace === "6865.explicit-undefined")!;
    expect(cell).toHaveLength(2);
    expect(Object.hasOwn(cell, 1)).toBe(true);
    expect(cell[1]).toBeUndefined();
    expect(replay.sourceMap!.sources[0]!.projection.originalText).toBe(arraySource + " // \ud800x\udc00");
  });

  it("refuses present undefined canonical encoding through real preparation and codec admission", () => {
    const request = input(),
      lowered = prepareIrProgramSources(request);
    if (lowered.kind !== "prepared") throw new Error(lowered.detail);
    const id = lowered.allocations.liveSites()[0]!.id;
    lowered.allocations.annotate(id, "encoding", undefined);
    expect(() =>
      prepareTypedIrProgram(captureTypedIrProgramInput(lowered), {
        ...typedOptions,
        policy: request.policy,
        runtimePolicies: [request.policy],
      }),
    ).toThrow(/metadata DATA domain namespace-value/);

    const { program } = prepare();
    const allocations = {
      ...program.allocations,
      metadata: program.allocations.metadata.map((row) =>
        row.id === id ? { ...row, entries: [...row.entries, ["encoding", undefined] as const] } : row,
      ),
    };
    const facts = program.linearAllocationFacts!.facts;
    const invalidEncoding = {
      ...program,
      allocations,
      linearAllocationFacts: {
        ...program.linearAllocationFacts!,
        facts: {
          ...facts,
          registry: allocations,
          allocations: facts.allocations.map((fact) =>
            fact.id === id
              ? {
                  ...fact,
                  encoding: undefined,
                  evidence: { ...fact.evidence, encoding: { present: true, value: undefined } },
                }
              : fact,
          ),
        },
      },
    } as PreparedIrProgram;
    expect(() => assertPreparedIrProgramShape(invalidEncoding)).not.toThrow();
    expect(() => encodePreparedIrProgram(invalidEncoding)).toThrow(/metadata DATA domain namespace-value/);

    type RawRegistry = { metadata: { id: number; entries: [string, unknown][] }[] };
    type RawFact = { id: number; encoding?: unknown; evidence: { encoding: { present: boolean; value: unknown } } };
    const persisted = JSON.parse(encodePreparedIrProgram(program)) as {
      program: {
        allocations: RawRegistry;
        linearAllocationFacts: { facts: { registry: RawRegistry; allocations: RawFact[] } };
      };
    };
    const undefinedAtom = { $undefined: true };
    for (const registry of [persisted.program.allocations, persisted.program.linearAllocationFacts.facts.registry]) {
      registry.metadata.find((row) => row.id === id)!.entries.push(["encoding", undefinedAtom]);
    }
    const fact = persisted.program.linearAllocationFacts.facts.allocations.find((row) => row.id === id)!;
    fact.encoding = undefinedAtom;
    fact.evidence.encoding = { present: true, value: undefinedAtom };
    const canonicalTransport = (value: unknown): string => {
      if (Array.isArray(value)) return `[${value.map(canonicalTransport).join(",")}]`;
      if (value && typeof value === "object")
        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalTransport((value as Record<string, unknown>)[key])}`)
          .join(",")}}`;
      return JSON.stringify(value)!;
    };
    const persistedBytes = canonicalTransport(persisted);
    // Structural custody is distinct from complete/native evidence admission.
    const data = decodePreparedIrProgramData(persistedBytes);
    expect(Object.hasOwn(data.linearAllocationFacts!.facts.allocations[0]!, "encoding")).toBe(true);
    expect(data.linearAllocationFacts!.facts.allocations[0]!.evidence.encoding.present).toBe(true);
    expect(() => decodePreparedIrProgram(persistedBytes)).toThrow(/metadata DATA domain namespace-value/);
  });

  it("rejects host policy before source inventory and whole-program preparation", () => {
    const request = input();
    const host = { ...request, policy: { backend: "linear" as const, target: "host" as const } };
    expect(() => prepareIrProgramSources(host)).toThrow("native target");
    expect(() => prepareWholeIrProgram(host)).toThrow("native target");
    const empty = { ...host, sourceFiles: [] };
    expect(() => prepareIrProgramSources(empty)).toThrow("native target");
  });
});
