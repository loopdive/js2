// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// One real original AE28 obligation. The other seventeen held entry controls remain unauthored.
import { describe, expect, it, vi } from "vitest";
import { AllocSiteRegistry, ALLOC_NAMESPACES } from "../src/ir/analysis/alloc-registry.js";
import { analyzeEncoding } from "../src/ir/analysis/encoding.js";
import { analyzeOwnership } from "../src/ir/analysis/ownership.js";
import { analyzeEscape } from "../src/ir/analysis/escape.js";
import { findStackAllocCandidates } from "../src/ir/analysis/stack-alloc.js";
import { prepareLinearAllocationFacts } from "../src/ir/analysis/linear-memory-plan.js";
import { verifyAllocationEvidence } from "../src/ir/analysis/allocation-evidence/verify.js";
import { assertFinalAllocProvenance } from "../src/ir/analysis/alloc-verification.js";
import { verifyIrFunction } from "../src/ir/runtime/verify.js";
import { assertPreparedIrProgramAllocations } from "../src/ir/program/allocations.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irVal, irVec, type IrObjectShape, type IrType } from "../src/ir/core/types.js";
import type { IrFunction, IrModule, IrValueId } from "../src/ir/core/nodes.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

// Each observer delegates to the original implementation, including the actual registry class.
const calls = vi.hoisted(() => ({ constructors: 0, encoding: 0, ownership: 0, escape: 0, stack: 0, facts: 0 }));
vi.mock("../src/ir/analysis/alloc-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/alloc-registry.js")>();
  return {
    ...actual,
    AllocSiteRegistry: class extends actual.AllocSiteRegistry {
      constructor() {
        super();
        calls.constructors++;
      }
    },
  };
});
vi.mock("../src/ir/analysis/encoding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/encoding.js")>();
  return {
    ...actual,
    analyzeEncoding: (...args: Parameters<typeof actual.analyzeEncoding>) => {
      calls.encoding++;
      return actual.analyzeEncoding(...args);
    },
  };
});
vi.mock("../src/ir/analysis/ownership.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/ownership.js")>();
  return {
    ...actual,
    analyzeOwnership: (...args: Parameters<typeof actual.analyzeOwnership>) => {
      calls.ownership++;
      return actual.analyzeOwnership(...args);
    },
  };
});
vi.mock("../src/ir/analysis/escape.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/escape.js")>();
  return {
    ...actual,
    analyzeEscape: (...args: Parameters<typeof actual.analyzeEscape>) => {
      calls.escape++;
      return actual.analyzeEscape(...args);
    },
  };
});

vi.mock("../src/ir/analysis/stack-alloc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/stack-alloc.js")>();
  return {
    ...actual,
    findStackAllocCandidates: (...args: Parameters<typeof actual.findStackAllocCandidates>) => {
      calls.stack++;
      return actual.findStackAllocCandidates(...args);
    },
  };
});
vi.mock("../src/ir/analysis/linear-memory-plan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/linear-memory-plan.js")>();
  return {
    ...actual,
    prepareLinearAllocationFacts: (...args: Parameters<typeof actual.prepareLinearAllocationFacts>) => {
      calls.facts++;
      return actual.prepareLinearAllocationFacts(...args);
    },
  };
});
const F64 = irVal({ kind: "f64" }),
  I32 = irVal({ kind: "i32" }),
  VEC = irVec(F64, false);
const shape: IrObjectShape = { fields: [{ name: "x", type: F64 }] };
const OBJ: IrType = { kind: "object", shape };
const ids = createTestIrFunctionIdentityFactory("issue-6920-ae28-entry");
type Op = "read" | "write";
interface Fixture {
  fn: IrFunction;
  reg: AllocSiteRegistry;
  allocation: IrValueId;
}
const reset = () => Object.assign(calls, { constructors: 0, encoding: 0, ownership: 0, escape: 0, stack: 0, facts: 0 });
function vector(ops: readonly Op[], nested = false, falseCondition = false): Fixture {
  const reg = new AllocSiteRegistry(),
    b = new IrFunctionBuilder(ids.next("numeric"), [F64], false, reg);
  b.openBlock();
  const value = b.emitConst({ kind: "f64", value: 1.5 }, F64),
    index = b.emitConst({ kind: "i32", value: 0 }, I32);
  const allocation = b.emitVecNewFixed([value], F64, VEC);
  const effects = () => {
    for (const op of ops) {
      if (op === "read") b.emitVecGet(allocation, index, F64);
      else b.emitVecSet(allocation, index, value);
    }
  };
  let returned = value;
  if (nested) {
    const cond = b.emitConst({ kind: "i32", value: falseCondition ? 0 : 1 }, I32);
    let thenValue = value,
      elseValue = value;
    const then = b.collectBodyInstrs(() => {
      effects();
      thenValue = b.emitConst({ kind: "f64", value: 2 }, F64);
    });
    const otherwise = b.collectBodyInstrs(() => {
      elseValue = b.emitConst({ kind: "f64", value: NaN }, F64);
    });
    returned = b.emitIfElse({ cond, then, thenValue, else: otherwise, elseValue, resultType: F64 });
  } else effects();
  b.terminate({ kind: "return", values: [returned] });
  return { fn: b.finish(), reg, allocation };
}
function object(returned: boolean): Fixture {
  const reg = new AllocSiteRegistry(),
    b = new IrFunctionBuilder(ids.next("small-object"), returned ? [OBJ] : [F64], false, reg);
  b.openBlock();
  const zero = b.emitConst({ kind: "f64", value: 0 }, F64);
  const allocation = b.emitObjectNew(shape, [zero]);
  const one = b.emitConst({ kind: "f64", value: 1 }, F64);
  b.emitObjectSet(allocation, "x", one);
  b.terminate({ kind: "return", values: [returned ? allocation : one] });
  return { fn: b.finish(), reg, allocation };
}
function context(f: Fixture) {
  expect(verifyIrFunction(f.fn)).toEqual([]);
  expect(() => assertFinalAllocProvenance(f.fn, f.reg)).not.toThrow();
}
function expected(ops: readonly Op[]) {
  return [
    [ALLOC_NAMESPACES.ownership, { state: "owned", ops }],
    [ALLOC_NAMESPACES.escape, { classification: "local", stackAllocatable: true }],
  ] as const;
}
function moduleOf(f: Fixture): IrModule {
  return { functions: [f.fn] };
}

describe("issue-6920 allocation evidence entry", () => {
  it("AE28 shared finite rules preserve exact canonical annotations", () => {
    const local = object(false);
    context(local);
    const ownership = analyzeOwnership(local.fn, local.reg);
    reset();
    expect(findStackAllocCandidates(local.fn, local.reg, ownership)).toEqual([{ allocId: 0, kind: "object" }]);
    expect(calls.stack).toBe(1);
    const instruction = local.fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    const marked = local.reg.read<Record<string, unknown>>(instruction.alloc!, ALLOC_NAMESPACES.ownership)!;
    expect(marked).toEqual({ state: "owned", ops: ["write"], stackCandidate: true });
    expect(Object.hasOwn(marked, "stackCandidate")).toBe(true);
    const producer = object(false);
    context(producer);
    reset();
    const facts = prepareLinearAllocationFacts(moduleOf(producer), producer.reg);
    expect(calls).toEqual({ constructors: 0, encoding: 1, ownership: 1, escape: 1, stack: 1, facts: 1 });
    expect(facts.allocations[0]).toMatchObject({
      ownership: "owned",
      accesses: ["write"],
      escape: "local",
      stackCandidate: true,
    });
    expect(() =>
      assertPreparedIrProgramAllocations({
        ir: moduleOf(producer),
        allocations: facts.registry,
        runtimeSupport: undefined,
      }),
    ).toThrow(PreparedIrProgramInvariantError);
    expect(() =>
      assertPreparedIrProgramAllocations({
        ir: moduleOf(producer),
        allocations: facts.registry,
        runtimeSupport: undefined,
      }),
    ).toThrow("site 0 has missing or stale ownership evidence");
    const returned = object(true);
    context(returned);
    const returnedOwnership = analyzeOwnership(returned.fn, returned.reg);
    expect(findStackAllocCandidates(returned.fn, returned.reg, returnedOwnership)).toEqual([]);
    expect(analyzeEscape(returned.fn, returned.reg, returnedOwnership).classOf(returned.allocation)).toBe("returned");
    const returnedInstr = returned.fn.blocks[0]!.instrs.find((i) => i.kind === "object.new")!;
    expect(
      Object.hasOwn(
        returned.reg.read<Record<string, unknown>>(returnedInstr.alloc!, ALLOC_NAMESPACES.ownership)!,
        "stackCandidate",
      ),
    ).toBe(false);
    const returnedFacts = prepareLinearAllocationFacts(moduleOf(returned), returned.reg);
    expect(returnedFacts.allocations[0]).toMatchObject({
      ownership: "escaped",
      escape: "returned",
      stackCandidate: false,
    });
    for (const cell of [
      { ops: [], nested: false, falseCondition: false },
      { ops: ["read"], nested: false, falseCondition: false },
      { ops: ["write"], nested: false, falseCondition: false },
      { ops: ["write", "read"], nested: false, falseCondition: false },
      { ops: ["read"], nested: true, falseCondition: false },
      { ops: ["write"], nested: true, falseCondition: true },
      { ops: ["read", "write"], nested: true, falseCondition: false },
    ] as const) {
      const f = vector(cell.ops, cell.nested, cell.falseCondition),
        original = structuredClone(f.fn);
      context(f);
      analyzeEncoding(f.fn, f.reg);
      const ownership = analyzeOwnership(f.fn, f.reg),
        escapeResult = analyzeEscape(f.fn, f.reg, ownership);
      const ordered: Op[] = ["read", "write"].filter((op): op is Op => cell.ops.some((value) => value === op));
      expect(ownership.ownershipOf(f.allocation)).toBe("owned");
      expect(ownership.accessOf(f.allocation).toArray()).toEqual(ordered);
      expect(ownership.isStackAllocatable(f.allocation)).toBe(true);
      expect(escapeResult.of(f.allocation)).toEqual({ classification: "local", stackAllocatable: true });
      expect(f.reg.captureSnapshot().metadata).toEqual([{ id: 0, entries: expected(ordered) }]);
      const annotation = f.reg.read<Record<string, unknown>>(
        f.fn.blocks[0]!.instrs[2]!.alloc!,
        ALLOC_NAMESPACES.ownership,
      )!;
      expect(Object.hasOwn(annotation, "stackCandidate")).toBe(false);
      reset();
      expect(() =>
        assertPreparedIrProgramAllocations({
          ir: moduleOf(f),
          allocations: f.reg.captureSnapshot(),
          runtimeSupport: undefined,
        }),
      ).not.toThrow();
      expect(calls).toEqual({ constructors: 1, encoding: 1, ownership: 1, escape: 1, stack: 0, facts: 0 });
      expect(f.fn).toEqual(original);

      const fresh = vector(cell.ops, cell.nested, cell.falseCondition);
      context(fresh);
      reset();
      const facts = prepareLinearAllocationFacts(moduleOf(fresh), fresh.reg);
      expect(calls).toEqual({ constructors: 0, encoding: 1, ownership: 1, escape: 1, stack: 1, facts: 1 });
      expect(facts.registry.metadata).toEqual([{ id: 0, entries: expected(ordered) }]);
      expect(facts.allocations).toHaveLength(1);
      expect(facts.allocations[0]).toMatchObject({
        id: 0,
        ownership: "owned",
        accesses: ordered,
        escape: "local",
        stackCandidate: false,
      });
      expect(Object.hasOwn(facts.allocations[0]!, "encoding")).toBe(false);
      expect(facts.allocations[0]!.evidence.encoding).toEqual({ present: false, value: undefined });
      const actualModule = moduleOf(fresh);
      const before = structuredClone({ module: actualModule, registry: facts.registry });
      reset();
      expect(verifyAllocationEvidence(actualModule, facts.registry)).toMatchObject({
        kind: "verified",
        namespaces: "ownership-and-escape",
      });
      expect(calls).toEqual({ constructors: 0, encoding: 0, ownership: 0, escape: 0, stack: 0, facts: 0 });
      expect({ module: moduleOf(fresh), registry: facts.registry }).toEqual(before);
      expect(findStackAllocCandidates(fresh.fn, undefined, analyzeOwnership(fresh.fn))).toEqual([]);
    }
  });
});
