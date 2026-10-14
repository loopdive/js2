// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { beforeAll, afterEach, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram } from "../src/ir/program-consumer.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { planNativeVectorResources, planPhysicalSetup } from "../src/ir/program-physical-plan.js";
import { physicalVectorCarrierGaps } from "../src/ir/program/physical-vector-carriers.js";
import * as discovery from "../src/ir/program/native-vector-resources.js";
import { planPreparedLinearMemory } from "../src/backend/linear/program/memory.js";
import type { PreparedIrProgram } from "../src/ir/program/prepared-contracts.js";

const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
let program: PreparedIrProgram;
let encoded: string;
beforeAll(() => {
  const source = "export function run(a:number,b:number):number { const xs=[a,b]; return xs[0]+xs[1]+xs.length; }";
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const result = prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: policies,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
  program = result.program;
  encoded = encodePreparedIrProgram(program);
});
afterEach(() => vi.restoreAllMocks());

for (const target of ["standalone", "wasi"] as const)
  for (const replay of [false, true]) {
    it(`locates an omitted actual GC body carrier before acceptance, ${target}, replay=${replay}`, () => {
      const input = replay ? decodePreparedIrProgram(encoded) : program;
      const projection = input.runtime.find((row) => row.backend === "wasmgc" && row.target === target)!;
      const options = {
        backend: "wasmgc",
        target,
        moduleName: "missing-vector-carrier",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      } as const;
      const plan = planNativeVectorResources(input, options, projection);
      const fn = projection.prepared.functions.find((row) => row.name === "run")!;
      expect(plan.layouts).toEqual(["f64"]);
      expect(physicalVectorCarrierGaps(fn, { backend: "wasmgc", vectors: plan })).toEqual([]);
      const absent = { ...plan, layouts: [] };
      const gaps = physicalVectorCarrierGaps(fn, { backend: "wasmgc", vectors: absent });
      expect(gaps.length).toBeGreaterThan(0);
      expect(gaps.every((gap) => gap.unitId === fn.unitId)).toBe(true);
      expect(gaps.some((gap) => gap.detail.includes("vec.new_fixed"))).toBe(true);
      const derive = discovery.deriveNativeVectorResourcePlan;
      vi.spyOn(discovery, "deriveNativeVectorResourcePlan").mockImplementation((actual) => ({
        ...derive(actual),
        layouts: [],
      }));
      const accepted = acceptPreparedIrProgram(input, options);
      expect(accepted.kind).toBe("unsupported");
      if (accepted.kind !== "unsupported") throw new Error("missing carrier was accepted");
      expect(accepted.code).toBe("body-shape-rejected");
      expect(accepted.unitId).toBe(fn.unitId);
      expect(accepted.location.sourceId).toBe(input.inventory.sources[0]!.id);
      expect(accepted.detail).toContain("vector carrier");
      expect(encodePreparedIrProgram(input)).toBe(encoded);
    });
  }

it.each(["standalone", "wasi"] as const)("requires the actual Linear memory plan for %s", (target) => {
  const projection = program.runtime.find((row) => row.backend === "linear" && row.target === target)!;
  const options = {
    backend: "linear",
    target,
    moduleName: "linear-carrier",
    sourceMap: false,
    utf8Storage: false,
    sharedExceptionTag: false,
  } as const;
  const memory = planPreparedLinearMemory({ program, projection, options });
  if (memory.kind !== "supported") throw new Error(memory.detail);
  expect(memory.plan.memory).toBeDefined();
  const fn = projection.prepared.functions.find((row) => row.name === "run")!;
  const vectors = planNativeVectorResources(program, options, projection);
  expect(physicalVectorCarrierGaps(fn, { backend: "linear", vectors, linearMemory: memory.plan })).toEqual([]);
  const missing: { memory?: object } = { ...memory.plan };
  Reflect.deleteProperty(missing, "memory");
  expect(physicalVectorCarrierGaps(fn, { backend: "linear", vectors, linearMemory: missing }).length).toBeGreaterThan(
    0,
  );
  expect(physicalVectorCarrierGaps(fn, { backend: "linear", vectors: { layouts: ["f64"] } }).length).toBeGreaterThan(0);
  expect(encodePreparedIrProgram(program)).toBe(encoded);
});

it.each(["standalone", "wasi"] as const)(
  "locates a missing consumer plan at the later allocating function for %s",
  (target) => {
    const source =
      "export function scalar(a:number):number { return a+1; } export function vector(a:number,b:number):number { const xs=[a,b]; return xs[0]+xs[1]+xs.length; }";
    const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
    const prepared = prepareWholeIrProgram({
      sourceFiles: ast.sourceFiles,
      entrySource: ast.entryFile,
      checker: ast.checker,
      policy: { backend: "linear", target },
      runtimePolicies: [{ backend: "linear", target }],
      deferTopLevelInit: false,
      linearVectorProjection: "native-f64",
    });
    if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
    const input = prepared.program;
    const before = encodePreparedIrProgram(input);
    const projection = input.runtime[0]!;
    expect(projection.prepared.functions.map((fn) => fn.name)).toEqual(["scalar", "vector"]);
    const scalar = projection.prepared.functions[0]!;
    const vector = projection.prepared.functions[1]!;
    expect(input.linearAllocationFacts!.facts.allocations).toHaveLength(1);
    const result = planPhysicalSetup(
      input,
      {
        backend: "linear",
        target,
        moduleName: "missing-consumer-plan",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      },
      projection,
    );
    expect(result.kind).toBe("unsupported");
    if (result.kind !== "unsupported") throw new Error("missing consumer plan was accepted");
    expect(result.code).toBe("body-shape-rejected");
    expect(result.detail).toContain("linear memory plan");
    expect(result.unitId).toBe(vector.unitId);
    expect(result.unitId).not.toBe(scalar.unitId);
    expect(result.location.sourceId).toBe(input.inventory.sources[0]!.id);
    expect(encodePreparedIrProgram(input)).toBe(before);
  },
);
