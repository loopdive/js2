// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Proposed J2/R3 controls only. Runtime qualification and the A2/J3 join remain held.
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { AllocSiteRegistry, ALLOC_NAMESPACES as oldNamespaces } from "../src/ir/analysis/alloc-registry.js";
import { ALLOC_NAMESPACES, type AllocRegistrySnapshot } from "../src/ir/analysis/contracts/allocations.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { asAllocSiteId, asValueId, type IrFunction, type IrInstr } from "../src/ir/core/nodes.js";
import type { IrAsyncPlan } from "../src/ir/core/async-plan.js";
import { asAsyncStateId, canonicalPromiseAbi } from "../src/ir/analysis/async-plan.js";
import { irVal, irVec } from "../src/ir/core/types.js";
import { assertFinalAllocProvenance, verifyAllocProvenance } from "../src/ir/analysis/alloc-verification.js";
import { assertPreparedIrFunctionAllocationTypesAndStates } from "../src/ir/program/allocation-body-validation.js";
import { assertPreparedIrProgramAllocations } from "../src/ir/program/allocations.js";
import { createVerifiedAllocationSnapshot, sameDetachedValue } from "../src/ir/analysis/allocations/snapshot.js";
import { verifyLinearPreparedAllocationFacts } from "../src/ir/analysis/linear/allocation-facts.js";
import type {
  LinearPreparedAllocationFact,
  LinearPreparedAllocationFacts,
} from "../src/ir/analysis/linear/contracts/allocation-facts.js";
import * as compatibility from "../src/ir/analysis/linear-memory-plan.js";
import * as pure from "../src/ir/analysis/linear-memory-from-facts.js";
import * as geometry from "../src/shared/contracts/linear-memory-layout.js";
import { verifyAllocationEvidence } from "../src/ir/analysis/allocation-evidence/verify.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const events = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock("../src/ir/analysis/alloc-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/alloc-registry.js")>();
  return {
    ...actual,
    AllocSiteRegistry: class extends actual.AllocSiteRegistry {
      constructor() {
        super();
        events.calls.push("constructor");
      }
    },
  };
});
vi.mock("../src/ir/analysis/encoding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/encoding.js")>();
  return {
    ...actual,
    analyzeEncoding: (...args: Parameters<typeof actual.analyzeEncoding>) => {
      events.calls.push("encoding");
      return actual.analyzeEncoding(...args);
    },
  };
});
vi.mock("../src/ir/analysis/ownership.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/ownership.js")>();
  return {
    ...actual,
    analyzeOwnership: (...args: Parameters<typeof actual.analyzeOwnership>) => {
      events.calls.push("ownership");
      return actual.analyzeOwnership(...args);
    },
  };
});
vi.mock("../src/ir/analysis/escape.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/escape.js")>();
  return {
    ...actual,
    analyzeEscape: (...args: Parameters<typeof actual.analyzeEscape>) => {
      events.calls.push("escape");
      return actual.analyzeEscape(...args);
    },
  };
});
vi.mock("../src/ir/analysis/stack-alloc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/stack-alloc.js")>();
  return {
    ...actual,
    findStackAllocCandidates: (...args: Parameters<typeof actual.findStackAllocCandidates>) => {
      events.calls.push("stack");
      return actual.findStackAllocCandidates(...args);
    },
  };
});
afterEach(() => {
  events.calls.length = 0;
});
const F64 = irVal({ kind: "f64" }),
  VEC = irVec(F64, false),
  a = asAllocSiteId;
const identities = createTestIrFunctionIdentityFactory("issue-6920-allocation-snapshot-facts");
function fixture(kind: "vector" | "string" | "empty" = "vector") {
  const registry = new AllocSiteRegistry();
  const builder = new IrFunctionBuilder(identities.next(kind), [F64], false, registry);
  const input = builder.addParam("input", F64);
  builder.openBlock();
  if (kind === "vector") builder.emitVecNewFixed([input], F64, VEC);
  if (kind === "string") builder.emitStringConst("x");
  builder.terminate({ kind: "return", values: [input] });
  const fn = builder.finish(),
    module = { functions: [fn] };
  return { registry, fn, module };
}
function prepared(kind: "vector" | "string" = "vector") {
  const value = fixture(kind);
  return { ...value, facts: compatibility.prepareLinearAllocationFacts(value.module, value.registry) };
}
function patchFact(facts: LinearPreparedAllocationFacts, patch: Partial<LinearPreparedAllocationFact>) {
  return {
    ...facts,
    allocations: facts.allocations.map((fact, index) => (index === 0 ? { ...fact, ...patch } : fact)),
  };
}
function snapshotMetadata(snapshot: AllocRegistrySnapshot, entries: readonly (readonly [string, unknown])[]) {
  return { ...snapshot, metadata: [{ id: a(0), entries }] };
}
function replaceAllocation(fn: IrFunction, change: (instr: IrInstr) => IrInstr): IrFunction {
  return {
    ...fn,
    blocks: fn.blocks.map((block) => ({
      ...block,
      instrs: block.instrs.map((instr) => (instr.alloc !== undefined ? change(instr) : instr)),
    })),
  };
}
function allocation(fn: IrFunction): IrInstr {
  const found = fn.blocks[0]!.instrs.find((instr) => instr.alloc !== undefined);
  if (!found) throw Error("fixture must contain a real allocation instruction");
  return found;
}
function generic(fn: IrFunction, allocations: AllocRegistrySnapshot): void {
  assertPreparedIrProgramAllocations({ ir: { functions: [fn] }, allocations, runtimeSupport: undefined });
}
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cleanRoots = [
  "src/ir/analysis/allocations/snapshot.ts",
  "src/ir/analysis/linear/contracts/allocation-facts.ts",
  "src/ir/analysis/linear/allocation-facts.ts",
  "src/ir/analysis/linear-memory-from-facts.ts",
];
function closure(entry: string, reader = (path: string) => readFileSync(resolve(root, path), "utf8")): Set<string> {
  const found = new Set<string>(),
    work = [entry];
  while (work.length) {
    const path = work.pop()!;
    if (found.has(path)) continue;
    if (
      /^src\/(?:frontend|checker|compiler|backend|codegen)|\/program\/|\/analysis\/(?:alloc-registry|ownership|encoding|escape|stack-alloc|linear-memory-plan)\.ts$/.test(
        path,
      )
    )
      throw Error("forbidden source-free dependency: " + path);
    found.add(path);
    const file = ts.createSourceFile(path, reader(path), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const references: string[] = [];
    const walk = (node: ts.Node): void => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        if (!ts.isStringLiteral(node.moduleSpecifier)) throw Error("nonliteral import");
        references.push(node.moduleSpecifier.text);
      }
      if (
        ts.isCallExpression(node) &&
        (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(file) === "require")
      )
        throw Error("dynamic dependency is outside the clean static contract");
      ts.forEachChild(node, walk);
    };
    walk(file);
    for (const reference of references) {
      if (!reference.startsWith(".")) throw Error("external source-free dependency: " + reference);
      const absolute = resolve(root, dirname(path), reference.replace(/\.js$/, ".ts"));
      work.push(absolute.slice(root.length + 1).replaceAll("\\", "/"));
    }
  }
  return found;
}

describe("issue-6920 J2/R3 allocation snapshot and pure planner extraction", () => {
  it("J201 actual producer and planner use the relocated authority", () => {
    const { module, registry, facts } = prepared();
    const plan = pure.planLinearMemoryFromFrozenFacts(module, facts);
    expect(compatibility.verifyLinearPreparedAllocationFacts).toBe(verifyLinearPreparedAllocationFacts);
    expect(compatibility.sameDetachedValue).toBe(sameDetachedValue);
    expect(compatibility.LinearMemoryPlan).toBe(pure.LinearMemoryPlan);
    expect(compatibility.DEFAULT_ARENA_POLICY).toBe(pure.DEFAULT_ARENA_POLICY);
    expect(oldNamespaces).toBe(ALLOC_NAMESPACES);
    expect(compatibility.LINEAR_ARRAY_FORWARDING).toBe(geometry.LINEAR_ARRAY_FORWARDING);
    expect(compatibility.planLinearRecordLayout).toBe(geometry.planLinearRecordLayout);
    expect(plan.toJSON()).toEqual(compatibility.planLinearMemory(module, registry).toJSON());
    expect(plan.allocations).toHaveLength(1);
    expect(plan.allocations[0]).toMatchObject({
      id: a(0),
      ownership: "owned",
      escape: "local",
      size: { kind: "constant", bytes: 144 },
    });
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.toJSON().allocations[0])).toBe(true);
    expect(plan.allocation(a(0))).toBe(plan.allocations[0]);
  });
  it("J202 snapshot lookup and mutable lookup agree on live provenance", () => {
    const { fn, registry } = fixture();
    registry.fresh("array", VEC);
    registry.alias(a(0), a(1));
    const view = createVerifiedAllocationSnapshot(registry.snapshot());
    events.calls.length = 0;
    expect(view.resolve(a(0))).toEqual(registry.resolve(a(0)));
    expect(view.canonicalIndex(a(0))).toBe(1);
    expect(verifyAllocProvenance(fn, view)).toEqual(verifyAllocProvenance(fn, registry));
    expect(() => assertFinalAllocProvenance(fn, view)).not.toThrow();
    expect(() => assertPreparedIrFunctionAllocationTypesAndStates(fn, view)).not.toThrow();
    expect(events.calls).toEqual([]);
  });
  it("J203 strict and legacy retired-alias domains stay distinct", () => {
    const { registry } = fixture();
    registry.fresh("array", VEC);
    registry.fresh("array", VEC);
    registry.alias(a(0), a(1));
    registry.retire(a(1));
    const snapshot = { ...registry.captureSnapshot(), metadata: [{ id: a(2), entries: [] }] };
    const before = structuredClone(snapshot),
      empty = fixture("empty").fn;
    expect(() => createVerifiedAllocationSnapshot(snapshot)).toThrow("reference retired site 1");
    expect(() => generic(empty, snapshot)).not.toThrow();
    expect(() => generic(fixture().fn, snapshot)).toThrow("stale provenance");
    expect(snapshot).toEqual(before);
    const direct = new AllocSiteRegistry();
    direct.fresh("array", VEC);
    direct.retire(a(0));
    expect(createVerifiedAllocationSnapshot(direct.snapshot()).resolve(a(0))).toBeNull();
  });
  it("J204 strict snapshot defects cannot become null success", () => {
    const healthy = fixture().registry.snapshot();
    expect(createVerifiedAllocationSnapshot(healthy).resolve(a(0))).toEqual(
      healthy.entries[0]!.state === "live" ? healthy.entries[0]!.site : null,
    );
    expect(() => createVerifiedAllocationSnapshot({ ...healthy, size: 2 })).toThrow("incomplete registry snapshot");
    expect(() =>
      createVerifiedAllocationSnapshot({
        ...healthy,
        entries: [{ state: "live", site: { id: a(1), kind: "array", type: VEC } }],
      }),
    ).toThrow("site identity mismatch");
    expect(() => createVerifiedAllocationSnapshot({ ...healthy, entries: [{ state: "aliased", to: a(0) }] })).toThrow(
      "cyclic alias",
    );
    expect(() => createVerifiedAllocationSnapshot({ ...healthy, entries: [{ state: "aliased", to: a(99) }] })).toThrow(
      "unknown site 99",
    );
    expect(() =>
      createVerifiedAllocationSnapshot(
        snapshotMetadata(healthy, [
          ["encoding", undefined],
          ["encoding", undefined],
        ]),
      ),
    ).toThrow("duplicate metadata namespace");
    expect(() =>
      createVerifiedAllocationSnapshot({
        ...healthy,
        metadata: [
          { id: a(0), entries: [] },
          { id: a(0), entries: [] },
        ],
      }),
    ).toThrow("duplicate metadata site");
  });
  it("J205 missing IDs kind and result types remain J1 checks", () => {
    const { fn, registry } = fixture(),
      view = createVerifiedAllocationSnapshot(registry.snapshot());
    expect(() => assertFinalAllocProvenance(fn, view)).not.toThrow();
    expect(() =>
      assertFinalAllocProvenance(
        replaceAllocation(fn, (instr) => ({ ...instr, alloc: undefined })),
        view,
      ),
    ).toThrow("missing an AllocSiteId");
    expect(() =>
      assertFinalAllocProvenance(
        replaceAllocation(fn, (instr) => ({ ...instr, alloc: a(99) })),
        view,
      ),
    ).toThrow("unknown AllocSiteId 99");
    expect(() =>
      assertPreparedIrFunctionAllocationTypesAndStates(
        replaceAllocation(fn, (instr) => ({ ...instr, resultType: F64 })),
        view,
      ),
    ).toThrow("contradicts body");
    const wrong = {
      ...registry.snapshot(),
      entries: [{ state: "live" as const, site: { id: a(0), kind: "string" as const, type: VEC } }],
    };
    expect(() => assertFinalAllocProvenance(fn, createVerifiedAllocationSnapshot(wrong))).toThrow(
      'kind "string", expected "array"',
    );
    registry.retire(a(0));
    expect(() => assertFinalAllocProvenance(fn, createVerifiedAllocationSnapshot(registry.snapshot()))).toThrow(
      "stale provenance",
    );
    const plan: IrAsyncPlan = {
      schemaVersion: 1,
      ownerUnitId: fn.unitId,
      kind: "async-function",
      abi: canonicalPromiseAbi(F64),
      entry: asAsyncStateId(0),
      params: [],
      values: [],
      spills: [],
      states: [{ id: asAsyncStateId(0), body: [allocation(fn)], terminator: { kind: "resolve", value: asValueId(0) } }],
      handlers: [],
      runtimeIntents: [],
    };
    expect(() =>
      assertPreparedIrFunctionAllocationTypesAndStates({ ...fn, blocks: [], asyncPlan: plan }, view),
    ).toThrow("lacks a typed entry block");
    const bad = {
      ...plan,
      states: plan.states.map((state) => ({ ...state, body: [{ ...allocation(fn), resultType: F64 }] })),
    };
    expect(() => assertPreparedIrFunctionAllocationTypesAndStates({ ...fn, asyncPlan: bad }, view)).toThrow(
      "contradicts body",
    );
  });
  it("J206 complete Linear fact denominator is preserved", () => {
    const { fn, module, registry } = fixture();
    registry.fresh("array", VEC);
    const facts = compatibility.prepareLinearAllocationFacts(module, registry),
      first = facts.allocations[0]!;
    expect(facts.registry.size).toBe(2);
    expect(() => verifyLinearPreparedAllocationFacts(module, facts)).not.toThrow();
    expect(() => verifyLinearPreparedAllocationFacts(module, { ...facts, allocations: [first, first] })).toThrow(
      "duplicate site 0",
    );
    expect(() => verifyLinearPreparedAllocationFacts(module, { ...facts, allocations: [] })).toThrow(
      "missing body allocation site 0",
    );
    expect(() =>
      verifyLinearPreparedAllocationFacts(module, patchFact(facts, { site: { ...first.site, kind: "object" } })),
    ).toThrow("falsified site projection");
    const site = createVerifiedAllocationSnapshot(facts.registry).resolve(a(1))!;
    const extra: LinearPreparedAllocationFact = {
      id: a(1),
      site,
      ownership: "escaped",
      accesses: [],
      escape: "opaque",
      stackCandidate: false,
      evidence: {
        ownership: { present: false, value: undefined },
        escape: { present: false, value: undefined },
        encoding: { present: false, value: undefined },
      },
    };
    expect(() =>
      verifyLinearPreparedAllocationFacts({ functions: [fn] }, { ...facts, allocations: [first, extra] }),
    ).toThrow("extra site 1");
  });
  it("J207 direct encoding value cannot disagree with evidence", () => {
    const { module, facts } = prepared("string");
    expect(facts.allocations[0]!.encoding).toBe("ascii");
    const mutant = patchFact(facts, { encoding: "wtf16" });
    expect(() => verifyLinearPreparedAllocationFacts(module, facts)).not.toThrow();
    for (const verify of [verifyLinearPreparedAllocationFacts, compatibility.verifyLinearPreparedAllocationFacts])
      expect(() => verify(module, mutant)).toThrow("disagrees with encoding value");
  });
  it("J208 encoding presence preserves original failure order", () => {
    const { module, facts } = prepared("string"),
      first = facts.allocations[0]!;
    const evidence = { ...first.evidence, encoding: { present: false, value: "wtf16" as const } };
    expect(() =>
      verifyLinearPreparedAllocationFacts(module, patchFact(facts, { encoding: "wtf16", evidence })),
    ).toThrow("encoding presence");
    expect(() =>
      verifyLinearPreparedAllocationFacts(
        module,
        patchFact(facts, { encoding: "wtf16", evidence: { ...evidence, encoding: { present: true, value: "wtf16" } } }),
      ),
    ).toThrow("encoding evidence");
    const numeric = prepared(),
      vectorFact = numeric.facts.allocations[0]!;
    expect(Object.hasOwn(vectorFact, "encoding")).toBe(false);
    expect(() =>
      verifyLinearPreparedAllocationFacts(numeric.module, patchFact(numeric.facts, { encoding: undefined })),
    ).toThrow("encoding presence");
    const registry = snapshotMetadata(numeric.facts.registry, [
      ...numeric.facts.registry.metadata[0]!.entries,
      ["encoding", undefined],
    ]);
    const presentUndefined = {
      ...patchFact(numeric.facts, {
        encoding: undefined,
        evidence: { ...vectorFact.evidence, encoding: { present: true, value: undefined } },
      }),
      registry,
    };
    expect(() => verifyLinearPreparedAllocationFacts(numeric.module, presentUndefined)).not.toThrow();
    expect(verifyAllocationEvidence(numeric.module, registry).kind).toBe("invalid");
  });
  it("J209 ownership escape defaults remain consistency checks", () => {
    const { module, facts } = prepared(),
      first = facts.allocations[0]!;
    for (const namespaces of [[], ["ownership"], ["escape"], ["ownership", "escape"]]) {
      const registry = snapshotMetadata(
        facts.registry,
        facts.registry.metadata[0]!.entries.filter(([name]) => namespaces.includes(name)),
      );
      const candidate = patchFact(
        { ...facts, registry },
        {
          ownership: namespaces.includes("ownership") ? first.ownership : "escaped",
          accesses: namespaces.includes("ownership") ? first.accesses : [],
          stackCandidate: false,
          escape: namespaces.includes("escape") ? first.escape : "opaque",
          evidence: {
            ownership: namespaces.includes("ownership")
              ? first.evidence.ownership
              : { present: false, value: undefined },
            escape: namespaces.includes("escape") ? first.evidence.escape : { present: false, value: undefined },
            encoding: first.evidence.encoding,
          },
        },
      );
      expect(() => verifyLinearPreparedAllocationFacts(module, candidate)).not.toThrow();
      expect(verifyAllocationEvidence(module, registry).kind).toBe("verified");
    }
    const falseOwnership = { state: "owned" as const, ops: ["write"] };
    const registry = snapshotMetadata(
      facts.registry,
      facts.registry.metadata[0]!.entries.map(([name, value]) => [name, name === "ownership" ? falseOwnership : value]),
    );
    const forged = patchFact(
      { ...facts, registry },
      { accesses: ["write"], evidence: { ...first.evidence, ownership: { present: true, value: falseOwnership } } },
    );
    expect(() => verifyLinearPreparedAllocationFacts(module, forged)).not.toThrow();
    expect(verifyAllocationEvidence(module, registry).kind).toBe("invalid");
  });
  it.todo("J210 descriptor preconditions stay at the actual A2 adapter — held until composition");
  it("J211 sourcefree closure has a live negative control", () => {
    for (const entry of cleanRoots) {
      const files = closure(entry);
      expect(files.has(entry)).toBe(true);
      expect(files.has("src/ir/analysis/contracts/allocations.ts")).toBe(true);
      expect(files.has("src/ir/core/nodes.ts")).toBe(true);
      if (entry !== cleanRoots[3]) expect(files.has("src/shared/contracts/linear-memory-layout.ts")).toBe(false);
    }
    const target = cleanRoots[2]!;
    expect(() =>
      closure(
        target,
        (path) =>
          readFileSync(resolve(root, path), "utf8") + (path === target ? '\nimport "../alloc-registry.js";\n' : ""),
      ),
    ).toThrow("forbidden source-free dependency");
  });
  it("J212 genuine observers distinguish producer from consumers", () => {
    events.calls.length = 0;
    const { fn, module, facts } = prepared();
    for (const name of ["constructor", "encoding", "ownership", "escape", "stack"])
      expect(events.calls).toContain(name);
    events.calls.length = 0;
    const view = createVerifiedAllocationSnapshot(facts.registry);
    assertFinalAllocProvenance(fn, view);
    assertPreparedIrFunctionAllocationTypesAndStates(fn, view);
    verifyLinearPreparedAllocationFacts(module, facts);
    pure.planLinearMemoryFromFrozenFacts(module, facts);
    expect(events.calls).toEqual([]);
  });
});
