// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { irUnitFuncRef } from "../src/ir/callable-bindings.js";
import { createDerivedIrUnitId } from "../src/ir/identity.js";
import { forEachInstrDeep, irVal, type IrInstr, type IrModule, type IrSiteId } from "../src/ir/nodes.js";
import { monomorphize } from "../src/ir/passes/monomorphize.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { verifyAllocProvenance } from "../src/ir/verify-alloc.js";
import {
  prepareLinearAllocationFacts,
  verifyLinearPreparedAllocationFacts,
  planLinearMemoryFromFrozenFacts,
} from "../src/ir/analysis/linear-memory-plan.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { decodePreparedIrProgram, encodePreparedIrProgram } from "../src/ir/program-codec.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";
const F64 = irVal({ kind: "f64" }),
  I32 = irVal({ kind: "i32" });
function freeze(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value)))
    if ("value" in descriptor) freeze(descriptor.value);
  Object.freeze(value);
}
// DATA builder witnesses are explicitly distinct from the genuine frontend case.
function fixture(
  mode: "source" | "generated" | "allocation" | "nested" | "none" | "legacy",
  capture = true,
  options: { childOnly?: boolean; threeTuples?: boolean } = {},
) {
  const ids = createTestIrFunctionIdentityFactory("3525-specialization-DATA");
  const identity = ids.next("constant"),
    previousDonor = ids.unit(9);
  const point = {
    sourceId: ids.sourceId,
    donorUnitId: identity.unitId,
    analyzed: { start: 10, end: 14 },
    original: { start: 10, end: 14 },
    mapping: "exact" as const,
  };
  const previous = {
    ...point,
    donorUnitId: previousDonor,
    analyzed: { start: 20, end: 24 },
    original: { start: 20, end: 24 },
  };
  const generated = ["generated", "allocation", "nested"].includes(mode);
  const site: IrSiteId =
    mode === "legacy"
      ? { line: 2, column: 3 }
      : {
          ...(generated ? {} : { line: 2, column: 3 }),
          origin: generated
            ? {
                kind: "generated",
                phase: "frontend",
                role: "binding-scaffold",
                ownerUnitId: identity.unitId,
                cause: point,
              }
            : { kind: "source", point, inlinedAt: [previous] },
        };
  const registry = ["allocation", "nested"].includes(mode) ? new AllocSiteRegistry() : undefined;
  const builder = new IrFunctionBuilder(
    identity,
    [F64],
    false,
    registry,
    undefined,
    capture && mode !== "none" && mode !== "legacy",
  );
  builder.addParam("unused", F64);
  builder.openBlock();
  const body = () => {
    if (mode === "allocation") builder.emitStringConst("allocation");
    if (mode === "nested") {
      const cond = builder.emitConst({ kind: "i32", value: 1 }, I32);
      const nested = builder.collectBodyInstrs(() => {
        if (options.childOnly) builder.withSourceSite(site, () => builder.emitStringConst("nested allocation"));
        else builder.emitStringConst("nested allocation");
      });
      builder.emitIfStmt({ cond, then: nested, else: [] });
    }
    const result = builder.emitConst({ kind: "f64", value: 7 }, F64);
    builder.terminate({ kind: "return", values: [result] });
  };
  if (!capture || mode === "none" || mode === "legacy") body();
  else builder.withSourceSite(site, body);
  let callee = builder.finish();
  // DATA-only omission exercises a real child origin under an unannotated parent.
  // The child site was captured by the builder; this is not frontend minting proof.
  if (options.childOnly)
    callee = {
      ...callee,
      blocks: callee.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instr) => {
          if (instr.kind !== "if.stmt") return instr;
          const { site: _site, ...withoutSite } = instr;
          return withoutSite;
        }),
      })),
    };
  if (mode === "legacy")
    callee = {
      ...callee,
      blocks: callee.blocks.map((b) => ({
        ...b,
        instrs: b.instrs.map((i) => ({ ...i, site })),
        terminator: { ...b.terminator, site },
      })),
    };
  const callers = (options.threeTuples ? [F64, I32, irVal({ kind: "i64" })] : [F64, I32]).map((type, index) => {
    const caller = new IrFunctionBuilder(ids.next(`caller${index}`), [F64], false);
    const arg = caller.addParam("arg", type);
    caller.openBlock();
    // Enough unchanged caller instructions satisfy the original global growth budget.
    for (let n = 0; n < 8; n++) caller.emitConst({ kind: "f64", value: n }, F64);
    const value = caller.emitCall(irUnitFuncRef(callee), [arg], F64)!;
    caller.terminate({ kind: "return", values: [value] });
    return caller.finish();
  });
  const module: IrModule = { functions: [callee, ...callers] };
  const before = structuredClone(module);
  freeze(module);
  return { module, before, callee, registry, point, previous, site };
}
function run(witness: ReturnType<typeof fixture>) {
  const result = monomorphize(witness.module, witness.registry);
  expect(result.cloneSignatures.size).toBe(1);
  expect(result.cloneOrigins.size).toBe(1);
  expect(result.cloneUnitProvenance.size).toBe(1);
  const [id, signature] = [...result.cloneSignatures][0]!;
  expect(id).toBe(
    createDerivedIrUnitId({ parentId: witness.callee.unitId, role: "monomorphization-clone", ordinal: 0 }),
  );
  expect(result.cloneOrigins.get(id)).toBe(witness.callee.unitId);
  expect(result.cloneUnitProvenance.get(id)).toEqual({
    id,
    parentId: witness.callee.unitId,
    role: "monomorphization-clone",
    ordinal: 0,
  });
  const clone = result.module.functions.find((fn) => fn.unitId === id)!;
  expect(clone.params.map((p) => p.type)).toEqual(signature.params);
  expect(clone.resultTypes).toEqual([signature.returnType]);
  expect(verifyIrFunction(clone)).toEqual([]);
  expect(witness.module).toEqual(witness.before);
  const instructions: IrInstr[] = [];
  for (const instr of clone.blocks[0].instrs) forEachInstrDeep(instr, (i) => instructions.push(i));
  console.info(
    "specialization DATA",
    JSON.stringify({
      functions: result.module.functions.length,
      clones: result.cloneSignatures.size,
      blocks: clone.blocks.length,
      topInstructions: clone.blocks[0].instrs.length,
      deepInstructions: instructions.length,
      registry: witness.registry?.size ?? 0,
    }),
  );
  return { result, clone, instructions };
}
describe("C1b specialization DATA origin transfer", () => {
  it("retains primary source and existing inline frames across an actual productive clone", () => {
    const witness = fixture("source"),
      { clone, instructions } = run(witness);
    for (const instr of instructions) expect(instr.site).toEqual(witness.site);
    expect(clone.blocks[0].terminator.site).toEqual(witness.callee.blocks[0].terminator.site);
  });
  it("retargets generated instruction and terminator owners to the actual clone while retaining cause", () => {
    const witness = fixture("generated"),
      { clone, instructions } = run(witness);
    const expected = {
      ...witness.site,
      origin: {
        kind: "generated",
        phase: "frontend",
        role: "binding-scaffold",
        ownerUnitId: clone.unitId,
        cause: witness.point,
      },
    };
    for (const instr of instructions) expect(instr.site).toEqual(expected);
    expect(clone.blocks[0].terminator.site).toEqual(expected);
  });
  for (const mode of ["allocation", "nested"] as const)
    it(`jointly forks ${mode} allocation and generated origin without mutating original rows`, () => {
      const witness = fixture(mode),
        old = structuredClone(witness.registry!.snapshot());
      const { clone, instructions } = run(witness);
      const allocated = instructions.filter((i) => i.alloc !== undefined);
      expect(allocated).toHaveLength(1);
      expect(witness.registry!.size).toBe(old.size + 1);
      for (const instr of allocated) {
        expect(instr.alloc!).toBeGreaterThanOrEqual(old.size);
        expect(instr.site?.origin).toEqual({
          kind: "generated",
          phase: "frontend",
          role: "binding-scaffold",
          ownerUnitId: clone.unitId,
          cause: witness.point,
        });
        const row = witness.registry!.snapshot().entries[instr.alloc!];
        expect(row.state).toBe("live");
        if (row.state !== "live") throw new Error("fresh allocation is not live");
        expect(row.site.origin).toEqual(instr.site);
      }
      expect(witness.registry!.snapshot().entries.slice(0, old.size)).toEqual(old.entries);
    });
  for (const mode of ["none", "legacy"] as const)
    it(`preserves ${mode} site shape, original instruction references and canonical semantic bytes`, () => {
      const witness = fixture(mode),
        { clone } = run(witness);
      expect(clone.blocks[0].instrs[0]).toBe(witness.callee.blocks[0].instrs[0]);
      expect(clone.blocks[0].terminator).toBe(witness.callee.blocks[0].terminator);
      expect(JSON.stringify(clone.blocks[0])).toBe(JSON.stringify(witness.callee.blocks[0]));
      expect(Reflect.ownKeys(clone.blocks[0].instrs[0])).toEqual(Reflect.ownKeys(witness.callee.blocks[0].instrs[0]));
    });
});
it("genuine admitted frontend source retains catalog through typed preparation and codec with measured natural clone population", () => {
  const files = {
    "./entry.ts":
      "function identity(x: number): number { return x; } export function run(x: number): number { return identity(x) + identity(3); }",
  };
  const ast = analyzeMultiSource(files, "./entry.ts"),
    policy = { target: "host" as const, backend: "wasmgc" as const };
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    deferTopLevelInit: false,
    sourceMap: {
      kind: "capture-source-map",
      sources: ast.sourceFiles.map((sourceFile) => ({
        sourceFile,
        projection: { originalText: sourceFile.text, analyzedText: sourceFile.text, stages: [] },
      })),
    },
  });
  expect(source.kind).toBe("prepared");
  if (source.kind !== "prepared") throw new Error(source.detail);
  const direct = monomorphize(source.ir);
  expect(direct.cloneSignatures.size).toBe(0);
  const typed = captureTypedIrProgramInput(source);
  const prepared = prepareTypedIrProgram(typed, {
    policy,
    runtimePolicies: [policy],
    controls: {
      gvnMode: "off",
      ownership: false,
      escape: false,
      verifyIntermediateAllocations: false,
      verifyDominanceNaive: true,
    },
  });
  expect(prepared.kind).toBe("prepared");
  if (prepared.kind !== "prepared") throw new Error(JSON.stringify(prepared));
  const bytes = encodePreparedIrProgram(prepared.program),
    decoded = decodePreparedIrProgram(bytes);
  expect(encodePreparedIrProgram(decoded)).toBe(bytes);
  expect(decoded.sourceMap).toEqual(source.sourceMap);
  expect(source.sourceMap?.sources).toHaveLength(1);
  console.info(
    "specialization genuine frontend",
    JSON.stringify({
      naturalClones: direct.cloneSignatures.size,
      sourceFunctions: source.ir.functions.length,
      preparedFunctions: prepared.program.ir.functions.length,
      codecBytes: bytes.length,
    }),
  );
});

// Paired requested/unrequested allocation skeletons are a semantic witness:
// enabling origin capture must not change actual allocation IDs or counters.
describe("C1b paired no-map allocation discipline", () => {
  for (const mode of ["allocation", "nested"] as const)
    it(`keeps ${mode} clone allocation IDs, counters and module skeleton independent of origin capture`, () => {
      const plain = fixture(mode, false),
        rich = fixture(mode);
      const plainBefore = structuredClone(plain.registry!.snapshot());
      const richBefore = structuredClone(rich.registry!.snapshot());
      const unannotated = run(plain),
        annotated = run(rich);
      const stripInstructionSites = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(stripInstructionSites);
        if (value !== null && typeof value === "object")
          return Object.fromEntries(
            Object.entries(value)
              .filter(([key]) => key !== "site")
              .map(([key, item]) => [key, stripInstructionSites(item)]),
          );
        return value;
      };
      const allocationData = (snapshot: ReturnType<AllocSiteRegistry["snapshot"]>) => ({
        ...snapshot,
        entries: snapshot.entries.map((row) =>
          row.state === "live" ? { ...row, site: { id: row.site.id, kind: row.site.kind, type: row.site.type } } : row,
        ),
      });
      expect(unannotated.result.cloneSignatures).toEqual(annotated.result.cloneSignatures);
      expect(unannotated.result.cloneUnitProvenance).toEqual(annotated.result.cloneUnitProvenance);
      expect(plain.registry!.size).toBe(rich.registry!.size);
      expect(allocationData(plain.registry!.snapshot())).toEqual(allocationData(rich.registry!.snapshot()));
      expect(JSON.stringify(stripInstructionSites(unannotated.result.module))).toBe(
        JSON.stringify(stripInstructionSites(annotated.result.module)),
      );
      const originalAllocated: IrInstr[] = [];
      for (const instr of plain.callee.blocks[0].instrs)
        forEachInstrDeep(instr, (item) => {
          if (item.alloc !== undefined) originalAllocated.push(item);
        });
      const clonedAllocated = unannotated.instructions.filter((instr) => instr.alloc !== undefined);
      expect(originalAllocated).toHaveLength(1);
      expect(clonedAllocated).toHaveLength(1);
      const originalId = originalAllocated[0].alloc!,
        cloneId = clonedAllocated[0].alloc!;
      // Separately authorized common allocation repair: both modes fork nested sites.
      // The authentic original nested counter1/reused-ID defect is retained in original9 evidence.
      expect(plain.registry!.size).toBe(2);
      expect(cloneId).toBe(originalId + 1);
      expect(clonedAllocated[0].site).toBeUndefined();
      expect(Object.hasOwn(clonedAllocated[0], "site")).toBe(false);
      const row = plain.registry!.snapshot().entries[cloneId];
      expect(row.state).toBe("live");
      if (row.state !== "live") throw new Error("no-map allocation is not live");
      expect(row.site.origin).toBeUndefined();
      expect(Reflect.ownKeys(row.site)).toEqual(Reflect.ownKeys((plainBefore.entries[originalId] as typeof row).site));
      expect(plain.registry!.snapshot().entries.slice(0, plainBefore.size)).toEqual(plainBefore.entries);
      expect(rich.registry!.snapshot().entries.slice(0, richBefore.size)).toEqual(richBefore.entries);
      const fingerprint = (value: unknown) => {
        const bytes = JSON.stringify(value);
        return { bytes: Buffer.byteLength(bytes), sha256: createHash("sha256").update(bytes).digest("hex") };
      };
      console.info(
        "specialization exact no-map fingerprints",
        JSON.stringify({
          mode,
          noMapModule: fingerprint(unannotated.result.module),
          noMapRegistry: fingerprint(plain.registry!.snapshot()),
          normalizedNoMapModule: fingerprint(stripInstructionSites(unannotated.result.module)),
          normalizedRichModule: fingerprint(stripInstructionSites(annotated.result.module)),
          normalizedNoMapRegistry: fingerprint(allocationData(plain.registry!.snapshot())),
          normalizedRichRegistry: fingerprint(allocationData(rich.registry!.snapshot())),
        }),
      );
      console.info(
        "specialization paired allocation",
        JSON.stringify({
          mode,
          unannotatedRegistry: plain.registry!.size,
          annotatedRegistry: rich.registry!.size,
          originalId,
          cloneId,
        }),
      );
    });
});

function allocationInstructions(module: IrModule): IrInstr[] {
  const found: IrInstr[] = [];
  for (const fn of module.functions)
    for (const block of fn.blocks)
      for (const instr of block.instrs)
        forEachInstrDeep(instr, (item) => {
          if (item.alloc !== undefined) found.push(item);
        });
  return found;
}
describe("C1b common allocation prerequisite independent controls", () => {
  it("forks a nested live site even when its parent has no origin and its child has one", () => {
    const witness = fixture("nested", true, { childOnly: true });
    const before = structuredClone(witness.registry!.snapshot());
    const { clone, instructions } = run(witness);
    const parent = clone.blocks[0].instrs.find((instr) => instr.kind === "if.stmt")!;
    expect(parent.site).toBeUndefined();
    const child = instructions.find((instr) => instr.alloc !== undefined)!;
    expect(child.alloc).toBe(1);
    expect(witness.registry!.size).toBe(2);
    expect(child.site?.origin?.kind).toBe("generated");
    if (child.site?.origin?.kind !== "generated") throw new Error("actual child origin missing");
    expect(child.site.origin.cause).toEqual(witness.point);
    expect(witness.registry!.resolve(child.alloc!)?.origin).toEqual(child.site);
    expect(witness.registry!.snapshot().entries.slice(0, before.size)).toEqual(before.entries);
  });
  it("does no allocation work for a registry-backed nonallocation body or when no registry is supplied", () => {
    const scalar = fixture("none"),
      empty = new AllocSiteRegistry();
    const result = monomorphize(scalar.module, empty);
    expect(result.cloneSignatures.size).toBe(1);
    expect(empty.size).toBe(0);
    const clone = result.module.functions.at(-1)!;
    expect(clone.blocks[0].instrs[0]).toBe(scalar.callee.blocks[0].instrs[0]);
    const nested = fixture("nested", false),
      before = structuredClone(nested.registry!.snapshot());
    const noRegistry = monomorphize(nested.module);
    expect(noRegistry.cloneSignatures.size).toBe(1);
    expect(noRegistry.module.functions.at(-1)!.blocks[0].instrs[1]).toBe(nested.callee.blocks[0].instrs[1]);
    expect(nested.registry!.snapshot()).toEqual(before);
  });
  it("forks through a live alias while retaining every original registry row", () => {
    const witness = fixture("nested", false),
      registry = witness.registry!;
    const original = registry.resolve(allocationInstructions(witness.module)[0].alloc!)!;
    const canonical = registry.fresh(original.kind, original.type, original.origin);
    registry.alias(original.id, canonical);
    const before = structuredClone(registry.snapshot());
    const { clone } = run(witness);
    const fork = allocationInstructions({ functions: [clone] })[0].alloc!;
    expect(fork).toBe(2);
    expect(registry.size).toBe(3);
    expect(registry.resolve(fork)?.kind).toBe(original.kind);
    expect(registry.snapshot().entries.slice(0, before.size)).toEqual(before.entries);
    expect(verifyAllocProvenance(clone, registry)).toEqual([]);
  });
  for (const state of ["retired", "unknown"] as const)
    it(`keeps ${state} allocation unresolved and lets the downstream validator refuse it`, () => {
      const witness = fixture("nested", false),
        registry = witness.registry!;
      let module = witness.module;
      if (state === "retired") registry.retire(allocationInstructions(module)[0].alloc!);
      else {
        module = structuredClone(module);
        Object.defineProperty(allocationInstructions(module)[0], "alloc", {
          value: 999,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      const before = structuredClone(registry.snapshot()),
        result = monomorphize(module, registry);
      expect(result.cloneSignatures.size).toBe(1);
      expect(registry.snapshot()).toEqual(before);
      const clone = result.module.functions.at(-1)!;
      const errors = verifyAllocProvenance(clone, registry);
      expect(errors).toHaveLength(1);
      expect(errors[0].message).toMatch(state === "retired" ? /retired\/aliased-away/ : /unknown AllocSiteId 999/);
      expect(() => prepareLinearAllocationFacts({ functions: [clone] }, registry)).toThrow();
    });
  it("produces distinct allocation facts across repeated specializations and rejects a deliberate reused-ID mutant", () => {
    const witness = fixture("nested", false, { threeTuples: true }),
      registry = witness.registry!;
    const before = structuredClone(registry.snapshot()),
      result = monomorphize(witness.module, registry);
    expect(result.cloneSignatures.size).toBe(2);
    expect(result.cloneUnitProvenance.size).toBe(2);
    expect(registry.size).toBe(3);
    expect([...result.cloneUnitProvenance.values()].map((row) => row.ordinal)).toEqual([0, 1]);
    const allocations = allocationInstructions(result.module);
    expect(allocations).toHaveLength(3);
    expect(allocations.map((instr) => instr.alloc)).toEqual([0, 1, 2]);
    expect(registry.snapshot().entries.slice(0, before.size)).toEqual(before.entries);
    const registryBeforeAnalysis = structuredClone(registry.snapshot());
    const facts = prepareLinearAllocationFacts(result.module, registry);
    const registryAfterAnalysis = structuredClone(registry.snapshot());
    expect(facts.allocations).toHaveLength(3);
    expect(facts.allocations.map((fact) => fact.id)).toEqual([0, 1, 2]);
    expect(() => verifyLinearPreparedAllocationFacts(result.module, facts)).not.toThrow();
    const plan = planLinearMemoryFromFrozenFacts(result.module, facts);
    expect(plan.allocations.map((row) => row.id)).toEqual([0, 1, 2]);
    expect(registry.snapshot()).toEqual(registryAfterAnalysis);
    expect(registryBeforeAnalysis.size).toBe(registryAfterAnalysis.size);
    const mutant = structuredClone(result.module);
    Object.defineProperty(allocationInstructions(mutant)[1], "alloc", {
      value: 0,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    // The basic liveness checker accepts reuse; the real linear-body consumer must reject it.
    expect(mutant.functions.flatMap((fn) => verifyAllocProvenance(fn, registry))).toEqual([]);
    expect(() => prepareLinearAllocationFacts(mutant, AllocSiteRegistry.fromSnapshot(registry.snapshot()))).toThrow(
      /duplicate live allocation-site id 0/,
    );
    expect(() => verifyLinearPreparedAllocationFacts(mutant, facts)).toThrow(/duplicate/);
    expect(() => planLinearMemoryFromFrozenFacts(mutant, facts)).toThrow(/duplicate/);
    expect(() => verifyLinearPreparedAllocationFacts(result.module, facts)).not.toThrow();
  });
});

it("accepts paired actual nested specialization output through the real linear facts and plan consumers", () => {
  for (const capture of [false, true]) {
    const witness = fixture("nested", capture),
      registry = witness.registry!;
    const result = monomorphize(witness.module, registry);
    expect(result.cloneSignatures.size).toBe(1);
    const beforeAnalysis = structuredClone(registry.snapshot());
    expect(beforeAnalysis.size).toBe(2);
    const facts = prepareLinearAllocationFacts(result.module, registry);
    const afterAnalysis = structuredClone(registry.snapshot());
    expect(facts.allocations.map((row) => row.id)).toEqual([0, 1]);
    expect(() => verifyLinearPreparedAllocationFacts(result.module, facts)).not.toThrow();
    const plan = planLinearMemoryFromFrozenFacts(result.module, facts);
    expect(plan.allocations.map((row) => row.id)).toEqual([0, 1]);
    expect(registry.snapshot()).toEqual(afterAnalysis);
    expect(beforeAnalysis.entries).toEqual(afterAnalysis.entries);
    console.info(
      "specialization linear consumers",
      JSON.stringify({
        capture,
        clones: result.cloneSignatures.size,
        registry: registry.size,
        facts: facts.allocations.length,
        planAllocations: plan.allocations.length,
        metadataBeforeAnalysis: beforeAnalysis.metadata.length,
        metadataAfterAnalysis: afterAnalysis.metadata.length,
      }),
    );
  }
});

it("rejects a malformed DATA callee return before minting that callee's specialization allocations", () => {
  const witness = fixture("nested", false),
    registry = witness.registry!;
  const functions = structuredClone([...witness.module.functions]);
  functions[0] = {
    ...functions[0],
    blocks: functions[0].blocks.map((block) => ({
      ...block,
      terminator: { kind: "return" as const, values: [] },
    })),
  };
  const malformed: IrModule = { functions };
  const before = structuredClone(registry.snapshot());
  expect(() => monomorphize(malformed, registry)).toThrow(
    "ir/monomorphize: clone constant$i32 has 0 return values; V1 requires 1",
  );
  expect(registry.snapshot()).toEqual(before);
  expect(witness.module).toEqual(witness.before);
});
