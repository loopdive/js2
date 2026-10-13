// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Proposed private J3 callbacks only. These assembled complete-program controls
// do not qualify A2's real source producer, public native support or ROOT18.
import { describe, expect, it, vi } from "vitest";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import * as encoding from "../src/ir/analysis/encoding.js";
import * as ownership from "../src/ir/analysis/ownership.js";
import * as escapeAnalysis from "../src/ir/analysis/escape.js";
import * as stack from "../src/ir/analysis/stack-alloc.js";
import { prepareLinearAllocationFacts } from "../src/ir/analysis/linear-memory-plan.js";
import { verifyLinearPreparedAllocationFacts } from "../src/ir/analysis/linear/allocation-facts.js";
import { verifyAllocationEvidence } from "../src/ir/analysis/allocation-evidence/verify.js";
import {
  checkRegistryEvidenceMetadataDomain,
  indexRegistryEvidence,
} from "../src/ir/analysis/allocation-evidence/metadata.js";
import type { LinearPreparedAllocationFacts } from "../src/ir/analysis/linear/contracts/allocation-facts.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal, irVec } from "../src/ir/core/types.js";
import type { IrInstr } from "../src/ir/core/nodes.js";
import { asValueId } from "../src/ir/core/nodes.js";
import { irBindingKey } from "../src/ir/core/declared-types.js";
import { preparedIrDraftAbiLookup } from "../src/ir/program/draft-abi-lookup.js";
import { preparedIrCallableSignature } from "../src/ir/program/abi-signatures.js";
import { irProgramRuntimeDemands } from "../src/ir/program/runtime-demands.js";
import { prepareWholeProgramRuntimeManifest } from "../src/ir/program/runtime-manifest.js";
import { freezePreparedIrRuntimeValue, preparedIrReadonlyMap } from "../src/ir/program/data.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "../src/ir/program/prepared-contracts.js";
import {
  assertPreparedIrProgram,
  assertPreparedIrProgramLinearAllocationEvidence,
} from "../src/ir/program/validation.js";
import { requirePreparedLinearMemoryInput } from "../src/ir/program/linear-allocation-facts.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { IrUnsupportedError } from "../src/shared/contracts/ir-preparation-errors.js";
import {
  decodePreparedIrProgram,
  encodePreparedIrProgram,
  reauthenticatePreparedIrProgram,
} from "../src/ir/program-codec.js";
import { buildCodecFixture } from "./helpers/ir-whole-program-codec-fixture.js";

const registryEvents = vi.hoisted(() => ({ constructions: 0 }));
vi.mock("../src/ir/analysis/alloc-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/alloc-registry.js")>();
  return {
    ...actual,
    AllocSiteRegistry: class extends actual.AllocSiteRegistry {
      constructor() {
        super();
        registryEvents.constructions++;
      }
    },
  };
});

const F64 = irVal({ kind: "f64" }),
  I32 = irVal({ kind: "i32" }),
  VEC = irVec(F64, false);

function project(program: PreparedIrProgram, ir = program.ir): PreparedIrProgram {
  const runtime = program.runtime.map((view) => {
    const result = prepareWholeProgramRuntimeManifest({
      inventory: program.inventory,
      derivedUnits: program.derivedUnits,
      ir,
      abi: preparedIrDraftAbiLookup(program.abi.entries),
      policy: view.prepared.manifest.policy,
      demands: new Map(ir.functions.map((fn) => [fn.unitId, irProgramRuntimeDemands(fn)])),
    });
    if (result.kind !== "prepared") throw new Error(`fixture runtime: ${result.detail}`);
    freezePreparedIrRuntimeValue(result.runtime);
    return { backend: view.backend, target: view.target, prepared: result.runtime };
  });
  return { ...program, ir, runtime };
}

function fixture(
  target: "standalone" | "wasi" = "standalone",
  operation: "f64.add" | "f64.mul" = "f64.add",
  returnVector = false,
) {
  const base = buildCodecFixture([{ backend: "linear", target }]).program;
  const owner = base.inventory.terminalUnits[0]!;
  const reg = new AllocSiteRegistry();
  const b = new IrFunctionBuilder({ unitId: owner.id, name: owner.displayName }, [returnVector ? VEC : F64], true, reg);
  const x = b.addParam("x", F64);
  b.openBlock();
  const index = b.emitConst({ kind: "i32", value: 0 }, I32);
  const vector = b.emitVecNewFixed([x], F64, VEC);
  const read = b.emitVecGet(vector, index, F64);
  const result = b.emitBinary(operation, x, read, F64);
  b.terminate({ kind: "return", values: [returnVector ? vector : result] });
  const fn = b.finish();
  const ir = { functions: [fn] };
  const facts = prepareLinearAllocationFacts(ir, reg);
  const originalEntry = base.abi.entries[0]!;
  if (originalEntry.contract.kind !== "callable" || originalEntry.plan.intent.kind !== "callable")
    throw new Error("fixture lacks its actual callable ABI");
  const params = fn.params.map((param) => param.type),
    results = fn.resultTypes;
  const entry = {
    ...originalEntry,
    plan: {
      ...originalEntry.plan,
      intent: { ...originalEntry.plan.intent, signature: preparedIrCallableSignature(params, results) },
    },
    contract: { ...originalEntry.contract, params, results },
  };
  const program = project({
    ...base,
    inventory: { ...base.inventory, classes: [], allUnits: [owner], terminalUnits: [owner] },
    units: preparedIrReadonlyMap([[owner.id, owner]]),
    abi: { entries: [entry] },
    startup: base.startup.map((plan) => ({ ...plan, exports: [] })),
    ir,
    allocations: facts.registry,
    linearAllocationFacts: { schema: "linear-allocation-facts-v1", facts },
  });
  return { program, facts, reg };
}

function replaceFacts(program: PreparedIrProgram, facts: LinearPreparedAllocationFacts): PreparedIrProgram {
  return {
    ...program,
    allocations: facts.registry,
    linearAllocationFacts: { schema: "linear-allocation-facts-v1", facts },
  };
}

function metadataMode(program: PreparedIrProgram, mode: "encoding-only" | "ownership-only" | "escape-only" | "both") {
  const facts = program.linearAllocationFacts!.facts;
  const hasOwnership = mode === "ownership-only" || mode === "both";
  const hasEscape = mode === "escape-only" || mode === "both";
  const registry = {
    ...facts.registry,
    metadata: facts.registry.metadata.map((row) => ({
      ...row,
      entries: row.entries.filter(([key]) => (key === "ownership" && hasOwnership) || (key === "escape" && hasEscape)),
    })),
  };
  return replaceFacts(program, {
    ...facts,
    registry,
    allocations: facts.allocations.map((fact) => ({
      ...fact,
      ownership: hasOwnership ? fact.ownership : "escaped",
      accesses: hasOwnership ? fact.accesses : [],
      stackCandidate: hasOwnership ? fact.stackCandidate : false,
      escape: hasEscape ? fact.escape : "opaque",
      evidence: {
        ...fact.evidence,
        ownership: hasOwnership ? fact.evidence.ownership : { present: false, value: undefined },
        escape: hasEscape ? fact.evidence.escape : { present: false, value: undefined },
      },
    })),
  });
}

function falsify(program: PreparedIrProgram, namespace: "ownership" | "escape" | "encoding", value: unknown) {
  const facts = program.linearAllocationFacts!.facts;
  const registry = {
    ...facts.registry,
    metadata: facts.registry.metadata.map((row) => ({
      ...row,
      entries: [...row.entries.filter(([key]) => key !== namespace), [namespace, value] as const],
    })),
  };
  const record = value as
    | { state?: unknown; ops?: unknown; stackCandidate?: unknown; classification?: unknown }
    | undefined;
  const allocations = facts.allocations.map((fact) => ({
    ...fact,
    ...(namespace === "ownership"
      ? {
          ownership: record?.state ?? "escaped",
          accesses: record?.ops ?? [],
          stackCandidate: record?.stackCandidate === true,
        }
      : {}),
    ...(namespace === "escape" ? { escape: record?.classification ?? "opaque" } : {}),
    ...(namespace === "encoding" ? { encoding: value } : {}),
    evidence: { ...fact.evidence, [namespace]: { present: true, value } },
  }));
  // Deliberately corrupt DATA domains while keeping all projection copies equal.
  return replaceFacts(program, { ...facts, registry, allocations } as unknown as LinearPreparedAllocationFacts);
}

function allEntriesReject(program: PreparedIrProgram) {
  expect(() => assertPreparedIrProgram(program)).toThrow(PreparedIrProgramInvariantError);
  expect(() => assertPreparedIrProgramLinearAllocationEvidence(program, program.runtime[0]!)).toThrow(
    PreparedIrProgramInvariantError,
  );
  expect(() => encodePreparedIrProgram(program)).toThrow(PreparedIrProgramInvariantError);
  expect(() => reauthenticatePreparedIrProgram(program)).toThrow(PreparedIrProgramInvariantError);
  expect(() => requirePreparedLinearMemoryInput(program, program.runtime[0]!)).toThrow(PreparedIrProgramInvariantError);
}

function observeInference() {
  registryEvents.constructions = 0;
  const spies = [
    vi.spyOn(encoding, "analyzeEncoding"),
    vi.spyOn(ownership, "analyzeOwnership"),
    vi.spyOn(escapeAnalysis, "analyzeEscape"),
    vi.spyOn(stack, "findStackAllocCandidates"),
  ];
  return {
    positiveAndReset() {
      expect(registryEvents.constructions).toBeGreaterThan(0);
      registryEvents.constructions = 0;
      for (const spy of spies) {
        expect(spy.mock.calls.length).toBeGreaterThan(0);
        spy.mockClear();
      }
    },
    zero() {
      expect(registryEvents.constructions).toBe(0);
      for (const spy of spies) expect(spy.mock.calls.length).toBe(0);
    },
    legacy() {
      expect(registryEvents.constructions).toBeGreaterThan(0);
      expect(spies[0]!.mock.calls.length).toBeGreaterThan(0);
    },
    restore() {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

describe("issue6920 proposed J3 complete-program acquisition", () => {
  it.each(["SSA", "return", "ABI", "owner"] as const)(
    "keeps %s contextual failure ahead of unsupported bad metadata",
    (defect) => {
      const observer = observeInference();
      try {
        const original = falsify(fixture("standalone", "f64.mul").program, "encoding", undefined);
        observer.positiveAndReset();
        const fn = original.ir.functions[0]!,
          block = fn.blocks[0]!;
        const bad: PreparedIrProgram =
          defect === "ABI"
            ? { ...original, abi: { entries: [] } }
            : {
                ...original,
                ir: {
                  ...original.ir,
                  functions: [
                    {
                      ...fn,
                      ...(defect === "owner" ? { unitId: "foreign" as typeof fn.unitId } : {}),
                      blocks: [
                        {
                          ...block,
                          ...(defect === "return" ? { terminator: { kind: "return" as const, values: [] } } : {}),
                          instrs: block.instrs.map(
                            (instr): IrInstr =>
                              defect === "SSA" && instr.kind === "binary" ? { ...instr, rhs: asValueId(999) } : instr,
                          ),
                        },
                      ],
                    },
                  ],
                },
              };
        let failure: unknown;
        try {
          assertPreparedIrProgramLinearAllocationEvidence(bad);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(PreparedIrProgramInvariantError);
        expect((failure as Error).message).not.toContain("metadata DATA domain");
        expect((failure as Error).message).not.toContain("outside the finite semantic profile");
        observer.zero();
      } finally {
        observer.restore();
      }
    },
  );
  it.each(["ownership", "escape", "encoding"] as const)(
    "prioritizes uncovered own-undefined %s without inference",
    (namespace) => {
      const observer = observeInference();
      try {
        const original = fixture("standalone", "f64.mul").program;
        observer.positiveAndReset();
        const bad = falsify(original, namespace, undefined);
        expect(() => verifyLinearPreparedAllocationFacts(bad.ir, bad.linearAllocationFacts!.facts)).not.toThrow();
        expect(verifyAllocationEvidence(bad.ir, bad.allocations).kind).toBe("not-covered");
        allEntriesReject(bad);
        observer.zero();
        const { linearAllocationFacts: _attachment, ...absent } = bad;
        expect(() => assertPreparedIrProgramLinearAllocationEvidence(absent)).toThrow(PreparedIrProgramInvariantError);
        observer.zero();
      } finally {
        observer.restore();
      }
    },
  );

  it.each([
    ["ownership", { state: "unknown", ops: [] }],
    ["ownership", { state: "owned", ops: ["foreign"] }],
    ["ownership", { state: "owned", ops: ["read", "read"] }],
    ["ownership", { state: "owned", ops: ["write", "read"] }],
    ["ownership", { state: "owned" }],
    ["ownership", { state: "owned", ops: [], stackCandidate: undefined }],
    ["escape", { classification: "unknown", stackAllocatable: false }],
    ["escape", { classification: "local", stackAllocatable: "true" }],
    ["escape", { classification: "local", stackAllocatable: false }],
    ["escape", { classification: "opaque", stackAllocatable: true }],
    ["escape", { classification: "local" }],
    ["encoding", "unknown"],
  ] as const)("prioritizes uncovered malformed %s DATA domain", (namespace, value) => {
    const observer = observeInference();
    try {
      const original = fixture("standalone", "f64.mul").program;
      observer.positiveAndReset();
      const bad = falsify(original, namespace, value);
      expect(() => verifyLinearPreparedAllocationFacts(bad.ir, bad.linearAllocationFacts!.facts)).not.toThrow();
      allEntriesReject(bad);
      observer.zero();
    } finally {
      observer.restore();
    }
  });

  it("leaves truthful and stale broader-domain body claims unknown on required acquisition", () => {
    const observer = observeInference();
    try {
      const original = fixture("standalone", "f64.add", true).program;
      observer.positiveAndReset();
      expect(original.linearAllocationFacts!.facts.allocations[0]!.ownership).toBe("escaped");
      expect(original.linearAllocationFacts!.facts.allocations[0]!.escape).toBe("returned");
      expect(checkRegistryEvidenceMetadataDomain(indexRegistryEvidence(original.allocations))).toBeUndefined();
      expect(verifyAllocationEvidence(original.ir, original.allocations).kind).toBe("not-covered");
      expect(() => requirePreparedLinearMemoryInput(original, original.runtime[0]!)).toThrow(IrUnsupportedError);
      observer.zero();
      assertPreparedIrProgram(original);
      observer.legacy();
    } finally {
      observer.restore();
    }
    const next = observeInference();
    try {
      const original = fixture("standalone", "f64.add", true).program;
      next.positiveAndReset();
      const bad = falsify(original, "ownership", {
        state: "owned",
        ops: original.linearAllocationFacts!.facts.allocations[0]!.accesses,
      });
      expect(checkRegistryEvidenceMetadataDomain(indexRegistryEvidence(bad.allocations))).toBeUndefined();
      expect(() => verifyLinearPreparedAllocationFacts(bad.ir, bad.linearAllocationFacts!.facts)).not.toThrow();
      expect(() => requirePreparedLinearMemoryInput(bad, bad.runtime[0]!)).toThrow(IrUnsupportedError);
      next.zero();
      expect(() => assertPreparedIrProgram(bad)).toThrow(PreparedIrProgramInvariantError);
      next.legacy();
    } finally {
      next.restore();
    }
  });

  it.each([
    ["ownership", { state: "owned", ops: ["write"] }],
    ["ownership", { state: "owned", ops: ["read"], stackCandidate: false }],
    ["escape", { classification: "returned", stackAllocatable: false }],
    ["encoding", "ascii"],
  ] as const)("keeps covered well-shaped %s contradictions as invariants", (namespace, value) => {
    const observer = observeInference();
    try {
      const original = fixture().program;
      observer.positiveAndReset();
      const bad = falsify(original, namespace, value);
      expect(checkRegistryEvidenceMetadataDomain(indexRegistryEvidence(bad.allocations))).toBeUndefined();
      expect(() => verifyLinearPreparedAllocationFacts(bad.ir, bad.linearAllocationFacts!.facts)).not.toThrow();
      allEntriesReject(bad);
      observer.zero();
    } finally {
      observer.restore();
    }
  });

  it.each(["lifetime", "extension"])(
    "retains covered string extension %s and legacy namespace refusal",
    (namespace) => {
      const original = fixture().program,
        facts = original.linearAllocationFacts!.facts;
      const program = replaceFacts(original, {
        ...facts,
        registry: {
          ...facts.registry,
          metadata: facts.registry.metadata.map((row) => ({
            ...row,
            entries: [...row.entries, [namespace, { phase: "example" }] as const],
          })),
        },
      });
      assertPreparedIrProgram(program);
      requirePreparedLinearMemoryInput(program, program.runtime[0]!);
      const replay = decodePreparedIrProgram(encodePreparedIrProgram(program));
      requirePreparedLinearMemoryInput(replay, replay.runtime[0]!);
      const incomplete = metadataMode(program, "encoding-only");
      const incompleteFacts = incomplete.linearAllocationFacts!.facts;
      const extraOnly = replaceFacts(incomplete, {
        ...incompleteFacts,
        registry: {
          ...incompleteFacts.registry,
          metadata: incompleteFacts.registry.metadata.map((row) => ({ ...row, entries: [[namespace, {}] as const] })),
        },
      });
      assertPreparedIrProgram(extraOnly);
      expect(() => requirePreparedLinearMemoryInput(extraOnly, extraOnly.runtime[0]!)).toThrow(IrUnsupportedError);
      const { linearAllocationFacts: _attachment, ...absent } = program;
      expect(() => assertPreparedIrProgram(absent)).toThrow(/unverifiable namespace/);
      const unsupported = fixture("standalone", "f64.mul").program;
      const unsupportedFacts = unsupported.linearAllocationFacts!.facts;
      const legacy = replaceFacts(unsupported, {
        ...unsupportedFacts,
        registry: {
          ...unsupportedFacts.registry,
          metadata: unsupportedFacts.registry.metadata.map((row) => ({
            ...row,
            entries: [...row.entries, [namespace, {}] as const],
          })),
        },
      });
      expect(() => assertPreparedIrProgram(legacy)).toThrow(/unverifiable namespace/);
      expect(() => requirePreparedLinearMemoryInput(legacy, legacy.runtime[0]!)).toThrow(IrUnsupportedError);
    },
  );

  it("rejects array shadow methods as DATA invariants and never invokes extension accessors", () => {
    for (const key of ["includes", "some", "map"] as const) {
      const original = fixture("standalone", "f64.mul").program;
      const ops = ["read"];
      Object.defineProperty(ops, key, { value: 0 });
      const bad = falsify(original, "ownership", { state: "owned", ops });
      expect(checkRegistryEvidenceMetadataDomain(indexRegistryEvidence(bad.allocations))?.kind).toBe("invalid");
      allEntriesReject(bad);
    }
    const original = fixture().program,
      facts = original.linearAllocationFacts!.facts;
    let getters = 0;
    const value = Object.defineProperty({}, "poison", {
      get() {
        getters++;
        throw new Error("extension getter executed");
      },
    });
    const bad = replaceFacts(original, {
      ...facts,
      registry: {
        ...facts.registry,
        metadata: facts.registry.metadata.map((row) => ({
          ...row,
          entries: [...row.entries, ["extension", value] as const],
        })),
      },
    });
    allEntriesReject(bad);
    expect(getters).toBe(0);
  });

  it("keeps generic absent retired-alias handling and canonical ID priority before bad metadata", () => {
    const { program: original, reg } = fixture();
    const retired = reg.fresh("object", F64),
      alias = reg.fresh("object", F64);
    reg.alias(alias, retired);
    reg.retire(retired);
    const { linearAllocationFacts: _attachment, ...absent } = original;
    assertPreparedIrProgram({ ...absent, allocations: reg.snapshot() });
    const invalidMetadata = falsify(fixture("standalone", "f64.mul").program, "ownership", undefined);
    const fn = invalidMetadata.ir.functions[0]!,
      block = fn.blocks[0]!;
    const bad = project(invalidMetadata, {
      functions: [
        {
          ...fn,
          blocks: [
            {
              ...block,
              instrs: block.instrs.map((instr): IrInstr => {
                if (instr.kind !== "vec.new_fixed") return instr;
                const { alloc: _alloc, ...missing } = instr;
                return missing;
              }),
            },
          ],
        },
      ],
    });
    expect(() => requirePreparedLinearMemoryInput(bad, bad.runtime[0]!)).toThrow(/missing an AllocSiteId/);
  });
  it.each(["standalone", "wasi"] as const)("keeps actual complete pairing for %s and source-free replay", (target) => {
    const { program } = fixture(target);
    expect(verifyAllocationEvidence(program.ir, program.allocations).kind).toBe("verified");
    assertPreparedIrProgram(program);
    const input = requirePreparedLinearMemoryInput(program, program.runtime[0]!);
    expect(input.facts).toBe(program.linearAllocationFacts!.facts);
    expect(input.module.functions).toEqual(program.runtime[0]!.prepared.functions);
    expect(input.module.functions[0]).toBe(program.runtime[0]!.prepared.functions[0]);
    expect(Object.hasOwn(input.module, "declaredSignatures")).toBe(false);
    expect(Object.hasOwn(input.module, "declaredGlobals")).toBe(false);
    const replay = decodePreparedIrProgram(encodePreparedIrProgram(program));
    expect(replay.linearAllocationFacts).toEqual(program.linearAllocationFacts);
    requirePreparedLinearMemoryInput(replay, replay.runtime[0]!);
  });

  it.each(["encoding-only", "ownership-only", "escape-only", "both"] as const)(
    "retains generic %s and native completeness priority",
    (mode) => {
      const program = metadataMode(fixture().program, mode);
      assertPreparedIrProgram(program);
      if (mode === "both") requirePreparedLinearMemoryInput(program, program.runtime[0]!);
      else expect(() => requirePreparedLinearMemoryInput(program, program.runtime[0]!)).toThrow(IrUnsupportedError);
      const bad = falsify(program, "encoding", undefined);
      expect(() => verifyLinearPreparedAllocationFacts(bad.ir, bad.linearAllocationFacts!.facts)).not.toThrow();
      allEntriesReject(bad);
    },
  );

  it.each(["ownership", "escape"] as const)("rejects coordinated false %s after consistency passes", (namespace) => {
    const original = fixture().program;
    const value =
      namespace === "ownership"
        ? { state: "borrowed", ops: [] }
        : { classification: "opaque", stackAllocatable: false };
    const bad = falsify(original, namespace, value);
    expect(() => verifyLinearPreparedAllocationFacts(bad.ir, bad.linearAllocationFacts!.facts)).not.toThrow();
    expect(verifyAllocationEvidence(bad.ir, bad.allocations).kind).toBe("invalid");
    allEntriesReject(bad);
  });

  it("rejects coordinated body and runtime contradiction after a prior success", () => {
    const { program } = fixture();
    requirePreparedLinearMemoryInput(program, program.runtime[0]!);
    const original = program.ir.functions[0]!;
    const body = original.blocks[0]!;
    const changed = {
      ...original,
      blocks: [
        {
          ...body,
          instrs: body.instrs
            .filter((instr) => instr.kind !== "vec.get")
            .map((instr): IrInstr => (instr.kind === "binary" ? { ...instr, rhs: original.params[0]!.value } : instr)),
        },
      ],
    };
    const bad = project(program, { ...program.ir, functions: [changed] });
    expect(() => verifyLinearPreparedAllocationFacts(bad.ir, bad.linearAllocationFacts!.facts)).not.toThrow();
    expect(verifyAllocationEvidence(bad.ir, bad.allocations).kind).toBe("invalid");
    expect(Reflect.set(program, "ir", bad.ir)).toBe(true);
    expect(Reflect.set(program, "runtime", bad.runtime)).toBe(true);
    allEntriesReject(program);
  });

  it("reacquires the same program after separate facts, registry, ABI and runtime mutations", () => {
    for (const field of ["linearAllocationFacts", "allocations", "abi", "runtime"] as const) {
      const { program } = fixture();
      requirePreparedLinearMemoryInput(program, program.runtime[0]!);
      if (field === "linearAllocationFacts") {
        const facts = program.linearAllocationFacts!.facts;
        Reflect.set(program, field, {
          ...program.linearAllocationFacts,
          facts: { ...facts, allocations: facts.allocations.map((fact) => ({ ...fact, accesses: [] })) },
        });
      } else if (field === "allocations") Reflect.set(program, field, { ...program.allocations, metadata: [] });
      else if (field === "abi") {
        const entry = program.abi.entries[0]!;
        if (entry.contract.kind !== "callable") throw new Error("fixture callable missing");
        Reflect.set(program, field, { entries: [{ ...entry, contract: { ...entry.contract, params: [I32] } }] });
      } else
        Reflect.set(
          program,
          field,
          program.runtime.map((view) => ({
            ...view,
            prepared: {
              ...view.prepared,
              functions: view.prepared.functions.map((fn) => ({ ...fn, name: "foreign-owner-name" })),
            },
          })),
        );
      allEntriesReject(program);
    }
  });

  it("retains generic legacy analysis for a well-typed uncovered attached body", () => {
    const spy = vi.spyOn(encoding, "analyzeEncoding");
    try {
      const { program } = fixture("standalone", "f64.mul");
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      spy.mockClear();
      expect(verifyAllocationEvidence(program.ir, program.allocations).kind).toBe("not-covered");
      assertPreparedIrProgram(program);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      expect(() => requirePreparedLinearMemoryInput(program, program.runtime[0]!)).toThrow(IrUnsupportedError);
    } finally {
      spy.mockRestore();
    }
  });

  it("retains genuine generic absent analysis and requires missing native allocating evidence", () => {
    const { program: original } = fixture();
    const { linearAllocationFacts: _attachment, ...program } = original;
    const spy = vi.spyOn(encoding, "analyzeEncoding");
    try {
      assertPreparedIrProgram(program);
      expect(spy.mock.calls.length).toBeGreaterThan(0);
      spy.mockClear();
      expect(() => requirePreparedLinearMemoryInput(program, program.runtime[0]!)).toThrow(IrUnsupportedError);
      expect(spy.mock.calls.length).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("witnesses real producer work before zero-analysis covered consumer acquisition", () => {
    const observers = [
      vi.spyOn(encoding, "analyzeEncoding"),
      vi.spyOn(ownership, "analyzeOwnership"),
      vi.spyOn(escapeAnalysis, "analyzeEscape"),
      vi.spyOn(stack, "findStackAllocCandidates"),
    ];
    try {
      const { program } = fixture();
      expect(registryEvents.constructions).toBeGreaterThan(0);
      registryEvents.constructions = 0;
      for (const spy of observers) {
        expect(spy.mock.calls.length).toBeGreaterThan(0);
        spy.mockClear();
      }
      assertPreparedIrProgram(program);
      requirePreparedLinearMemoryInput(program, program.runtime[0]!);
      decodePreparedIrProgram(encodePreparedIrProgram(program));
      for (const spy of observers) expect(spy.mock.calls.length).toBe(0);
      expect(registryEvents.constructions).toBe(0);
    } finally {
      for (const spy of observers) spy.mockRestore();
    }
  });

  it("diagnoses canonical missing ID before uncovered instruction refusal", () => {
    const { program } = fixture("standalone", "f64.mul");
    const fn = program.ir.functions[0]!;
    const block = fn.blocks[0]!;
    const instrs = block.instrs.map((instr): IrInstr => {
      if (instr.kind !== "vec.new_fixed") return instr;
      const { alloc: _alloc, ...missing } = instr;
      return missing;
    });
    const bad = project(program, { functions: [{ ...fn, blocks: [{ ...block, instrs }] }] });
    expect(() => requirePreparedLinearMemoryInput(bad, bad.runtime[0]!)).toThrow(/missing an AllocSiteId/);
  });

  it("rejects coordinated stale active namespaces with own undefined", () => {
    for (const namespace of ["ownership", "escape"] as const) {
      const original = fixture().program;
      const facts = original.linearAllocationFacts!.facts;
      const registry = {
        ...facts.registry,
        metadata: facts.registry.metadata.map((row) => ({
          ...row,
          entries: row.entries.map(([key, value]) => [key, key === namespace ? undefined : value] as const),
        })),
      };
      const bad = replaceFacts(original, {
        ...facts,
        registry,
        allocations: facts.allocations.map((fact) => ({
          ...fact,
          ...(namespace === "ownership"
            ? { ownership: "escaped", accesses: [], stackCandidate: false }
            : { escape: "opaque" }),
          evidence: { ...fact.evidence, [namespace]: { present: true, value: undefined } },
        })),
      } as LinearPreparedAllocationFacts);
      expect(() => verifyLinearPreparedAllocationFacts(bad.ir, bad.linearAllocationFacts!.facts)).not.toThrow();
      allEntriesReject(bad);
    }
  });

  it("rejects own undefined and accessor attachment before reading any graph getter", () => {
    for (const attachment of [undefined, "accessor"] as const) {
      let getters = 0;
      const program = {} as PreparedIrProgram;
      Object.defineProperty(program, "schema", {
        get() {
          getters++;
          return "prepared-ir-program-v1";
        },
      });
      Object.defineProperty(
        program,
        "linearAllocationFacts",
        attachment === "accessor"
          ? {
              get() {
                getters++;
                return undefined;
              },
            }
          : { value: undefined },
      );
      expect(() => assertPreparedIrProgram(program)).toThrow(PreparedIrProgramInvariantError);
      expect(() => assertPreparedIrProgramLinearAllocationEvidence(program)).toThrow(PreparedIrProgramInvariantError);
      expect(getters).toBe(0);
    }
  });

  it("screens required absent whole graph before schema, ABI, support or runtime reads", () => {
    for (const key of ["schema", "abi", "runtimeSupport", "runtime", "allocations", "ir"] as const) {
      let getters = 0;
      const { linearAllocationFacts: _attachment, ...program } = fixture().program;
      Object.defineProperty(program, key, {
        get() {
          getters++;
          throw new Error("getter executed");
        },
      });
      expect(() => assertPreparedIrProgramLinearAllocationEvidence(program)).toThrow(PreparedIrProgramInvariantError);
      expect(getters).toBe(0);
    }
  });

  it("screens attached facts and nested semantic descriptors with zero getters", () => {
    for (const position of ["facts", "body", "runtime"] as const) {
      const { program } = fixture();
      let getters = 0;
      const bad = { ...program };
      const poison = {
        get() {
          getters++;
          throw new Error("getter executed");
        },
      };
      if (position === "facts") Object.defineProperty(bad, "linearAllocationFacts", poison);
      else if (position === "runtime") Object.defineProperty(bad, "runtime", poison);
      else
        bad.ir = {
          ...program.ir,
          functions: program.ir.functions.map((fn) => {
            const copy = { ...fn };
            Object.defineProperty(copy, "blocks", poison);
            return copy;
          }),
        };
      expect(() => assertPreparedIrProgram(bad)).toThrow(PreparedIrProgramInvariantError);
      expect(getters).toBe(0);
    }
  });

  it("requires original selected projection identity before touching foreign getters", () => {
    const { program } = fixture();
    let getters = 0;
    const foreign = Object.defineProperty({}, "backend", {
      get() {
        getters++;
        return "linear";
      },
    }) as PreparedIrProgramRuntimeProjection;
    expect(() => requirePreparedLinearMemoryInput(program, foreign)).toThrow(PreparedIrProgramInvariantError);
    expect(getters).toBe(0);
    const functions = [...program.ir.functions];
    const prototype = Object.create(Array.prototype);
    Object.defineProperty(prototype, Symbol.iterator, {
      get() {
        getters++;
        throw new Error("inherited iterator executed");
      },
    });
    Object.setPrototypeOf(functions, prototype);
    expect(() => assertPreparedIrProgram({ ...program, ir: { ...program.ir, functions } })).toThrow(
      PreparedIrProgramInvariantError,
    );
    expect(getters).toBe(0);
  });

  it("rejects a supplied signature contradicting complete ABI while preserving valid tables", () => {
    const { program } = fixture();
    const callable = program.abi.entries[0]!.contract;
    if (callable.kind !== "callable") throw new Error("fixture callable missing");
    const key = irBindingKey(callable.ref.binding)!;
    const valid = project(program, {
      ...program.ir,
      declaredSignatures: preparedIrReadonlyMap([[key, { params: [F64], result: F64 }]]),
      declaredGlobals: preparedIrReadonlyMap([]),
    });
    const input = requirePreparedLinearMemoryInput(valid, valid.runtime[0]!);
    expect(input.module.declaredSignatures).toBe(valid.ir.declaredSignatures);
    expect(input.module.declaredGlobals).toBe(valid.ir.declaredGlobals);
    const bad = project(program, {
      ...program.ir,
      declaredSignatures: preparedIrReadonlyMap([[key, { params: [I32], result: F64 }]]),
    });
    allEntriesReject(bad);
  });

  it("preserves a distinct raw-surrogate codec control without numeric encoding", () => {
    const { program } = fixture();
    const changed = {
      ...program,
      inventory: {
        ...program.inventory,
        sources: program.inventory.sources.map((source) => ({ ...source, originalFileName: "j3-\ud800-\udfff.ts" })),
      },
    };
    const replay = decodePreparedIrProgram(encodePreparedIrProgram(changed));
    expect(replay.inventory.sources[0]!.originalFileName).toBe("j3-\ud800-\udfff.ts");
    requirePreparedLinearMemoryInput(replay, replay.runtime[0]!);
  });

  it.each(["attachment.facts", "facts.allocations", "fact.evidence.ownership.value"] as const)(
    "screens reachable nested %s accessor at every public entry with paired positives",
    (position) => {
      const { program } = fixture();
      const projection = program.runtime[0]!;
      const positiveEntries = [
        () => assertPreparedIrProgram(program),
        () => assertPreparedIrProgramLinearAllocationEvidence(program, projection),
        () => encodePreparedIrProgram(program),
        () => reauthenticatePreparedIrProgram(program),
        () => requirePreparedLinearMemoryInput(program, projection),
      ];
      for (const acquire of positiveEntries) expect(acquire).not.toThrow();

      let getters = 0;
      const poison = {
        get() {
          getters++;
          throw new Error(`nested ${position} getter executed`);
        },
      };
      const attachment = { ...program.linearAllocationFacts! };
      if (position === "attachment.facts") Object.defineProperty(attachment, "facts", poison);
      else {
        const facts = { ...attachment.facts };
        if (position === "facts.allocations") Object.defineProperty(facts, "allocations", poison);
        else {
          const original = facts.allocations[0]!;
          const ownershipEvidence = { ...original.evidence.ownership };
          Object.defineProperty(ownershipEvidence, "value", poison);
          const fact = { ...original, evidence: { ...original.evidence, ownership: ownershipEvidence } };
          facts.allocations = [fact, ...facts.allocations.slice(1)];
        }
        attachment.facts = facts;
      }
      const bad: PreparedIrProgram = { ...program, linearAllocationFacts: attachment };
      // The attachment itself stays a DATA descriptor; each poison is nested
      // on the currently reachable original complete module/facts pairing.
      const top = Object.getOwnPropertyDescriptor(bad, "linearAllocationFacts");
      expect(top !== undefined && "value" in top).toBe(true);
      expect(top?.value).toBe(attachment);
      const rejectedEntries = [
        () => assertPreparedIrProgram(bad),
        () => assertPreparedIrProgramLinearAllocationEvidence(bad, projection),
        () => encodePreparedIrProgram(bad),
        () => reauthenticatePreparedIrProgram(bad),
        () => requirePreparedLinearMemoryInput(bad, projection),
      ];
      for (const acquire of rejectedEntries) {
        expect(acquire).toThrow(PreparedIrProgramInvariantError);
        expect(getters).toBe(0);
      }

      for (const acquire of positiveEntries) expect(acquire).not.toThrow();
      expect(getters).toBe(0);
    },
  );
});
