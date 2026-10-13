// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { afterEach, describe, expect, it, vi } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareWholeIrProgram } from "../src/ir/program-preparation.js";
import { acceptPreparedIrProgram, emitAcceptedIrProgram } from "../src/ir/program-consumer.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { emitBinary } from "../src/emit/binary.js";
import { requirePreparedLinearMemoryInput } from "../src/ir/program/linear-allocation-facts.js";
import { collectLinearVectorFlow } from "../src/ir/program/linear-vector-flow.js";
import { collectPreparedLinearMemoryDemand } from "../src/ir/program/linear-memory-demand.js";
import { verifyAllocationEvidence } from "../src/ir/analysis/allocation-evidence/verify.js";
import * as directLinear from "../src/codegen-linear/index.js";
import * as directGc from "../src/codegen/index.js";
import * as memoryPack from "../src/backend/linear/program/memory.js";
import * as sourceProducer from "../src/ir/program-source.js";

const policies = [
  { backend: "linear", target: "standalone" },
  { backend: "linear", target: "wasi" },
  { backend: "wasmgc", target: "standalone" },
  { backend: "wasmgc", target: "wasi" },
] as const;
const factory = "function make(a:number,b:number):number[]{return [a,b];}";
const identity = "function identity(a:number[]):number[]{return a;}";
const pick = "function pick(a:number[],i:number):number{return a[i];}";
const fixtures = [
  {
    name: "local positive",
    files: { "./entry.ts": "export function run():number{const a=[2,5];return a[0]+a[1];}" },
    expected: 7,
    payloads: [[2, 5]],
  },
  {
    name: "argument",
    files: { "./entry.ts": `${pick} export function run():number{return pick([2,5],1);}` },
    expected: 5,
    payloads: [[2, 5]],
  },
  {
    name: "result",
    files: { "./entry.ts": `${factory} export function run():number{const a=make(2,5);return a[0]+a[1];}` },
    expected: 7,
    payloads: [[2, 5]],
  },
  {
    name: "result to parameter",
    files: {
      "./entry.ts": `${factory}${identity}${pick} export function run():number{return pick(identity(make(2,5)),1);}`,
    },
    expected: 5,
    payloads: [[2, 5]],
  },
  {
    name: "repeated fresh results",
    files: {
      "./entry.ts": `${factory} export function run():number{const a=make(2,5);const b=make(3,7);return a[0]+a[1]+b[0]+b[1];}`,
    },
    expected: 17,
    payloads: [
      [2, 5],
      [3, 7],
    ],
  },
  {
    name: "parameter result alias",
    files: {
      "./entry.ts": `${identity} export function run():number{const a=[2,5];const b=identity(a);return a[0]+b[1];}`,
    },
    expected: 7,
    payloads: [[2, 5]],
  },
  {
    name: "cross source",
    files: {
      "./vec.ts": `export ${factory} export ${pick}`,
      "./entry.ts": "import {make,pick} from './vec';export function run():number{return pick(make(2,5),1);}",
    },
    expected: 5,
    payloads: [[2, 5]],
  },
];

afterEach(() => vi.restoreAllMocks());
function prepare(files: Record<string, string>) {
  const ast = analyzeMultiSource(files, "./entry.ts");
  return prepareWholeIrProgram({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: policies[0],
    runtimePolicies: policies,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
}

/** Independently observed headers determine subsequent physical addresses, never requested extents. */
function memoryPayloads(memory: WebAssembly.Memory, expected: readonly (readonly number[])[]): number {
  const view = new DataView(memory.buffer);
  let pointer = 1024;
  for (const payload of expected) {
    expect(view.getUint32(pointer + 8, true)).toBe(payload.length);
    const capacity = view.getUint32(pointer + 12, true);
    expect(capacity).toBeGreaterThanOrEqual(payload.length);
    payload.forEach((value, index) => expect(view.getFloat64(pointer + 16 + index * 8, true)).toBe(value));
    pointer += 16 + capacity * 8;
  }
  return pointer;
}

describe("authentic whole-program synchronous vector transport", () => {
  it.each(fixtures)("$name: one program, four profiles, live and codec", async (fixture) => {
    const result = prepare(fixture.files as Record<string, string>);
    expect(result.kind, JSON.stringify(result)).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    const original = result.program;
    const sealed = encodePreparedIrProgram(original);
    const decoded = decodePreparedIrProgram(sealed);
    expect(encodePreparedIrProgram(decoded)).toBe(sealed);
    expect(original.allocations.entries.filter((entry) => entry.state === "live")).toHaveLength(
      fixture.name === "result to parameter" || fixture.name === "cross source" ? 2 : 1,
    );
    const source = vi.spyOn(sourceProducer, "prepareIrProgramSources").mockImplementation(() => {
      throw new Error("source reread forbidden");
    });
    const linear = vi.spyOn(directLinear, "generateLinearModule").mockImplementation(() => {
      throw new Error("direct Linear forbidden");
    });
    const gc = vi.spyOn(directGc, "generateModule").mockImplementation(() => {
      throw new Error("direct GC forbidden");
    });
    const bindings: memoryPack.PreparedLinearBodyBindings[] = [];
    const capacities: number[] = [];
    const bind = memoryPack.preparedLinearMemoryBindings;
    vi.spyOn(memoryPack, "preparedLinearMemoryBindings").mockImplementation((...args) => {
      const issued = bind(...args);
      bindings.push(issued);
      return {
        ...issued,
        requestedVectorCapacity: (...coordinates) => {
          const capacity = issued.requestedVectorCapacity(...coordinates);
          capacities.push(capacity);
          return capacity;
        },
      };
    });
    let executions = 0;
    for (const policy of policies) {
      const binaries: Uint8Array[] = [];
      for (const program of [original, decoded]) {
        const accepted = acceptPreparedIrProgram(program, {
          ...policy,
          moduleName: "vector-calls",
          sourceMap: false,
          utf8Storage: false,
          sharedExceptionTag: false,
        });
        expect(accepted.kind, JSON.stringify(accepted)).toBe("accepted");
        if (accepted.kind !== "accepted") throw new Error(JSON.stringify(accepted));
        const emitted = emitAcceptedIrProgram(accepted);
        const binary = new Uint8Array(emitBinary(emitted.module));
        binaries.push(binary);
        expect(WebAssembly.validate(binary)).toBe(true);
        const module = await WebAssembly.compile(binary);
        expect(WebAssembly.Module.imports(module)).toEqual([]);
        const instance = await WebAssembly.instantiate(module, {});
        if (typeof instance.exports._start === "function") instance.exports._start();
        const run = instance.exports.run as () => number;
        expect(run()).toBe(fixture.expected);
        if (policy.backend === "linear") {
          const memory = instance.exports.memory as WebAssembly.Memory;
          expect(memory).toBeInstanceOf(WebAssembly.Memory);
          memoryPayloads(memory, fixture.payloads);
          expect(run()).toBe(fixture.expected);
          const end = memoryPayloads(memory, [...fixture.payloads, ...fixture.payloads]);
          expect(new DataView(memory.buffer).getUint32(end + 8, true)).toBe(0);
        } else expect(run()).toBe(fixture.expected);
        executions++;
      }
      expect(binaries[1]).toEqual(binaries[0]);
    }
    expect(executions).toBe(8);
    expect(bindings).toHaveLength(4);
    expect(capacities.length).toBeGreaterThan(0);
    expect(new Set(capacities)).toEqual(new Set([2]));
    for (const binding of bindings)
      expect(() =>
        binding.requestedVectorCapacity(
          original.ir.functions[0]!.unitId,
          original.ir.functions[0]!.params[0]?.value ?? (0 as never),
        ),
      ).toThrow(/emission attempt is no longer active/);
    expect(source).not.toHaveBeenCalled();
    expect(linear).not.toHaveBeenCalled();
    expect(gc).not.toHaveBeenCalled();
    expect(encodePreparedIrProgram(original)).toBe(sealed);
  });

  it("retains actual callee sites, conservative local evidence and complete caller demand", () => {
    const result = prepare(fixtures[2]!.files as Record<string, string>);
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    const program = result.program,
      projection = program.runtime[0]!;
    const input = requirePreparedLinearMemoryInput(program, projection);
    const report = verifyAllocationEvidence(input.module, input.facts.registry);
    expect(report).toMatchObject({ kind: "verified", profile: "single-block-numeric-vector-call-v1" });
    const rows = collectPreparedLinearMemoryDemand(input).occurrences;
    const construction = rows.find((row) => row.kind === "vec.new_fixed")!;
    const read = rows.find((row) => row.kind === "vec.get")!;
    expect(read.unitId).not.toBe(construction.unitId);
    expect(read.allocationId).toBe(construction.allocationId);
    expect(read.constructionPath).toEqual(construction.constructionPath);
    expect(input.facts.allocations).toHaveLength(1);
    expect(input.facts.allocations[0]).toMatchObject({
      ownership: "escaped",
      escape: "returned",
      stackCandidate: false,
    });
  });

  it("refuses recursive and mixed-extent actual vector flow", () => {
    for (const text of [
      "function identity(a:number[]):number[]{return identity(a);}export function run():number{const a=identity([2,5]);return a[0];}",
      "function pick(a:number[]):number{return a[0];}export function run():number{return pick([2])+pick([3,4]);}",
    ]) {
      const result = prepare({ "./entry.ts": text });
      expect(result.kind, JSON.stringify(result)).toBe("prepared");
      if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
      const accepted = acceptPreparedIrProgram(result.program, {
        ...policies[0],
        moduleName: "refusal",
        sourceMap: false,
        utf8Storage: false,
        sharedExceptionTag: false,
      });
      expect(accepted.kind).toBe("unsupported");
      expect(JSON.stringify(accepted)).toMatch(/recursive|mixed requested/);
    }
  });

  it("uses actual argument ordinals after a fresh complete provenance recomputation", () => {
    const result = prepare({
      "./entry.ts":
        "function pick(a:number[],b:number[]):number{return a[0];}export function run():number{return pick([2,5],[3,7,11]);}",
    });
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    const module = structuredClone(result.program.ir);
    const owner = module.functions.find((fn) => fn.name === "pick")!;
    const caller = module.functions.find((fn) => fn.name === "run")!;
    const call = caller.blocks[0]!.instrs.find((instr) => instr.kind === "call")!;
    if (call.kind !== "call") throw new Error("positive control lacks real call");
    const before = collectLinearVectorFlow(module).get(owner.unitId)!.get(owner.params[0]!.value)!;
    expect(before[0]!.instruction.elements).toHaveLength(2);
    Object.assign(call, { args: [...call.args].reverse() });
    const after = collectLinearVectorFlow(module).get(owner.unitId)!.get(owner.params[0]!.value)!;
    expect(after[0]!.instruction.elements).toHaveLength(3);
    expect(after[0]!.instruction.alloc).not.toBe(before[0]!.instruction.alloc);
    expect(verifyAllocationEvidence(module, result.program.allocations).kind).toBe("verified");
  });

  it("rejects stale local evidence after a callee return or call effect changes", () => {
    const result = prepare(fixtures[2]!.files as Record<string, string>);
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    const module = structuredClone(result.program.ir);
    expect(verifyAllocationEvidence(module, result.program.allocations).kind).toBe("verified");
    const factory = module.functions.find((fn) => fn.name === "make")!;
    Object.assign(factory.blocks[0]!, { terminator: { kind: "unreachable" } });
    expect(verifyAllocationEvidence(module, result.program.allocations)).toMatchObject({
      kind: "invalid",
      code: "namespace-value",
    });
  });

  it("recomputes provenance and rejects removed caller/forged target in checked flow", () => {
    const result = prepare(fixtures[1]!.files as Record<string, string>);
    if (result.kind !== "prepared") throw new Error(JSON.stringify(result));
    const module = structuredClone(result.program.ir);
    const caller = module.functions.find((fn) => fn.name === "run")!;
    const call = caller.blocks[0]!.instrs.find((instr) => instr.kind === "call")!;
    if (call.kind !== "call") throw new Error("positive control has no real unit call");
    expect(collectLinearVectorFlow(module).size).toBe(2);
    const withoutCaller = { ...module, functions: module.functions.filter((fn) => fn !== caller) };
    expect(() => collectLinearVectorFlow(withoutCaller)).toThrow(/no complete internal callers/);
    Object.assign(call.target.binding, { unitId: "forged-owner" });
    expect(() => collectLinearVectorFlow(module)).toThrow(/no exact complete unit target/);
  });
});
