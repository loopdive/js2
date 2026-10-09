// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Eight portable extraction controls; these do not complete AE21–AE23 or ROOT18.
import { afterEach, describe, expect, it, vi } from "vitest";
import { AllocSiteRegistry } from "../src/ir/analysis/alloc-registry.js";
import type { AllocProvenanceLookup, AllocRegistrySnapshot } from "../src/ir/analysis/contracts/allocations.js";
import { assertFinalAllocProvenance, verifyAllocProvenance } from "../src/ir/analysis/alloc-verification.js";
import { assertAllocProvenance, allocVerifyEnabled } from "../src/ir/verify-alloc.js";
import { analyzeEncoding } from "../src/ir/analysis/encoding.js";
import { analyzeOwnership } from "../src/ir/analysis/ownership.js";
import { analyzeEscape } from "../src/ir/analysis/escape.js";
import { asAsyncStateId, canonicalPromiseAbi, verifyIrAsyncPlan } from "../src/ir/analysis/async-plan.js";
import type { IrAsyncPlan } from "../src/ir/core/async-plan.js";
import {
  asAllocSiteId,
  asBlockId,
  asValueId,
  type AllocSiteId,
  type IrFunction,
  type IrInstr,
} from "../src/ir/core/nodes.js";
import { irVal, irVec } from "../src/ir/core/types.js";
import { assertPreparedIrProgramAllocations } from "../src/ir/program/allocations.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { IrInvariantError } from "../src/shared/contracts/ir-preparation-errors.js";
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

const F64 = irVal({ kind: "f64" }),
  I32 = irVal({ kind: "i32" }),
  VEC = irVec(F64, false);
const a = asAllocSiteId,
  v = asValueId;
const identities = createTestIrFunctionIdentityFactory("issue-6920-allocation-provenance-lookup");
const originalDebug = process.env.IR_VERIFY_ALLOC;
afterEach(() => {
  events.calls.length = 0;
  if (originalDebug === undefined) Reflect.deleteProperty(process.env, "IR_VERIFY_ALLOC");
  else process.env.IR_VERIFY_ALLOC = originalDebug;
});
function number(result = 0, kind: "f64" | "i32" = "f64"): IrInstr {
  return { kind: "const", result: v(result), resultType: kind === "f64" ? F64 : I32, value: { kind, value: 1 } };
}
function vector(site = 0, result = 1, element = 0): IrInstr {
  return {
    kind: "vec.new_fixed",
    result: v(result),
    resultType: VEC,
    elementType: F64,
    elements: [v(element)],
    alloc: a(site),
  };
}
function fn(instrs: readonly IrInstr[] = [number(), vector()]): IrFunction {
  return {
    ...identities.next("control"),
    params: [],
    resultTypes: [F64],
    blocks: [
      { id: asBlockId(0), blockArgs: [], blockArgTypes: [], instrs, terminator: { kind: "return", values: [v(0)] } },
    ],
    exported: false,
    valueCount: 8,
  };
}
function registry(): AllocSiteRegistry {
  const reg = new AllocSiteRegistry();
  reg.fresh("array", VEC);
  return reg;
}
function lookup(reg: AllocSiteRegistry, calls: string[] = []): AllocProvenanceLookup {
  return Object.freeze({
    isKnown(id: AllocSiteId) {
      calls.push(`known:${id}`);
      return reg.isKnown(id);
    },
    resolve(id: AllocSiteId) {
      calls.push(`resolve:${id}`);
      return reg.resolve(id);
    },
  });
}
type AllocationProgram = Parameters<typeof assertPreparedIrProgramAllocations>[0];
function program(owner: IrFunction, allocations: AllocRegistrySnapshot): AllocationProgram {
  return { ir: { functions: [owner] }, allocations, runtimeSupport: undefined };
}
function thrown(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw Error("positive failure control did not throw");
}
function provenanceFailure(owner: IrFunction, reg: AllocSiteRegistry, messages: readonly string[]) {
  const expected = messages.map((message) => ({ func: owner.name, message }));
  expect(verifyAllocProvenance(owner, reg)).toEqual(expected);
  expect(verifyAllocProvenance(owner, lookup(reg))).toEqual(expected);
  for (const authority of [reg, lookup(reg)]) {
    const error = thrown(() => assertFinalAllocProvenance(owner, authority));
    expect(error).toBeInstanceOf(IrInvariantError);
    expect(error).toMatchObject({
      kind: "invariant",
      code: "allocation-provenance-failure",
      stage: "verify",
      cause: expected,
    });
    expect(error.message).toBe(
      `IR alloc-provenance check failed (#1586):\n${expected.map((row) => `  - [${row.func}] ${row.message}`).join("\n")}`,
    );
  }
}
function preparedFailure(p: AllocationProgram, message: string, provenance = false) {
  const error = thrown(() => assertPreparedIrProgramAllocations(p));
  expect(error).toBeInstanceOf(provenance ? IrInvariantError : PreparedIrProgramInvariantError);
  expect(error).toMatchObject({
    code: provenance ? "allocation-provenance-failure" : "invalid-prepared-data",
    message,
  });
  return error;
}
function missingMessage(): string {
  return 'allocation instr "vec.new_fixed" is missing an AllocSiteId (provenance lost)';
}
function staleMessage(site: number): string {
  return `live instr "vec.new_fixed" references retired/aliased-away AllocSiteId ${site} (stale provenance)`;
}
function finalMessage(owner: IrFunction, message: string): string {
  return `IR alloc-provenance check failed (#1586):\n  - [${owner.name}] ${message}`;
}
function asyncOwner(): IrFunction {
  const owner = fn([number()]);
  const plan: IrAsyncPlan = {
    schemaVersion: 1,
    ownerUnitId: owner.unitId,
    kind: "async-function",
    abi: canonicalPromiseAbi(F64),
    entry: asAsyncStateId(0),
    params: [],
    values: [
      { value: v(4), type: F64 },
      { value: v(5), type: VEC },
    ],
    spills: [],
    states: [
      { id: asAsyncStateId(0), body: [number(4), vector(0, 5, 4)], terminator: { kind: "resolve", value: v(4) } },
    ],
    handlers: [],
    runtimeIntents: ["promise.capability.create", "promise.settle.fulfill"],
  };
  expect(verifyIrAsyncPlan(plan)).toEqual([]);
  return { ...owner, funcKind: "async", asyncPlan: plan };
}
function replaceState(owner: IrFunction, instrs: readonly IrInstr[]): IrFunction {
  if (!owner.asyncPlan) throw Error("async fixture missing genuine plan");
  return {
    ...owner,
    asyncPlan: { ...owner.asyncPlan, states: owner.asyncPlan.states.map((state) => ({ ...state, body: instrs })) },
  };
}
function analyzed(): { owner: IrFunction; allocations: AllocRegistrySnapshot } {
  const owner = fn(),
    reg = registry();
  analyzeEncoding(owner, reg);
  const ownership = analyzeOwnership(owner, reg);
  analyzeEscape(owner, reg, ownership);
  return { owner, allocations: reg.captureSnapshot() };
}

describe("issue-6920 canonical allocation provenance extraction (eight controls)", () => {
  it("P01 registry and structural lookup preserve live allocation provenance", () => {
    const owner = fn(),
      reg = registry(),
      calls: string[] = [],
      structural = lookup(reg, calls);
    expect(Object.keys(structural)).toEqual(["isKnown", "resolve"]);
    expect(verifyAllocProvenance(owner, reg)).toEqual([]);
    expect(verifyAllocProvenance(owner, structural)).toEqual([]);
    expect(calls).toEqual(["known:0", "resolve:0"]);
    expect(() => assertFinalAllocProvenance(owner, reg)).not.toThrow();
    expect(() => assertFinalAllocProvenance(owner, structural)).not.toThrow();
  });
  it("P02 required IDs remain mandatory", () => {
    Reflect.deleteProperty(process.env, "IR_VERIFY_ALLOC");
    expect(allocVerifyEnabled()).toBe(false);
    const reg = registry(),
      healthy = fn();
    expect(() => assertFinalAllocProvenance(healthy, reg)).not.toThrow();
    const allocation = vector();
    Reflect.deleteProperty(allocation, "alloc");
    const owner = fn([number(), allocation]);
    expect(() => assertAllocProvenance(owner, reg)).not.toThrow();
    provenanceFailure(owner, reg, [missingMessage()]);
    preparedFailure(program(owner, reg.snapshot()), finalMessage(owner, missingMessage()), true);
  });
  it("P03 unknown retired and wrong-kind IDs remain distinct", () => {
    const reg = registry();
    reg.fresh("array", VEC);
    reg.retire(a(1));
    reg.fresh("object", F64);
    expect(() => assertFinalAllocProvenance(fn(), lookup(reg))).not.toThrow();
    provenanceFailure(fn([number(), vector(99)]), reg, [
      'instr "vec.new_fixed" references unknown AllocSiteId 99 (dangling)',
    ]);
    provenanceFailure(fn([number(), vector(1)]), reg, [staleMessage(1)]);
    provenanceFailure(fn([number(), vector(2)]), reg, [
      'instr "vec.new_fixed" has AllocSiteId 2 of kind "object", expected "array"',
    ]);
  });
  it("P04 unused alias to retired remains legacy-valid", () => {
    const reg = registry();
    reg.fresh("array", VEC);
    reg.fresh("array", VEC);
    reg.alias(a(0), a(1));
    reg.retire(a(1));
    const snapshot: AllocRegistrySnapshot = { ...reg.captureSnapshot(), metadata: [{ id: a(2), entries: [] }] };
    const before = structuredClone(snapshot);
    expect(snapshot.size).toBe(3);
    expect(snapshot.entries[0]).toEqual({ state: "aliased", to: a(1) });
    expect(snapshot.entries[1]).toEqual({ state: "retired" });
    expect(reg.isKnown(a(0))).toBe(true);
    expect(reg.resolve(a(0))).toBeNull();
    expect(() => assertPreparedIrProgramAllocations(program(fn([number()]), snapshot))).not.toThrow();
    expect(snapshot).toEqual(before);
    const used = fn();
    preparedFailure(program(used, snapshot), finalMessage(used, staleMessage(0)), true);
    expect(snapshot).toEqual(before);
  });
  it("P05 nested provenance keeps occurrence and error order", () => {
    const reg = registry();
    reg.fresh("array", VEC);
    const conditional: IrInstr = {
      kind: "if",
      result: v(5),
      resultType: VEC,
      cond: v(2),
      then: [vector(0, 3)],
      thenValue: v(3),
      else: [vector(1, 4)],
      elseValue: v(4),
    };
    const healthy = fn([number(), number(2, "i32"), conditional]);
    expect(verifyAllocProvenance(healthy, reg)).toEqual([]);
    expect(verifyAllocProvenance(healthy, lookup(reg))).toEqual([]);
    const missing = vector(1, 4);
    Reflect.deleteProperty(missing, "alloc");
    const broken = fn([
      number(),
      number(2, "i32"),
      {
        ...conditional,
        kind: "if",
        cond: v(2),
        then: [vector(99, 3)],
        thenValue: v(3),
        else: [missing],
        elseValue: v(4),
      },
    ]);
    provenanceFailure(broken, reg, [
      'instr "vec.new_fixed" references unknown AllocSiteId 99 (dangling)',
      missingMessage(),
    ]);
  });
  it("P06 async states retain entry and allocation checks", () => {
    const owner = asyncOwner(),
      reg = registry(),
      snapshot = reg.captureSnapshot();
    expect(() => assertPreparedIrProgramAllocations(program(owner, snapshot))).not.toThrow();
    preparedFailure(
      program({ ...owner, blocks: [] }, snapshot),
      `program allocations: async owner ${owner.unitId} lacks a typed entry block`,
    );
    const missing = vector(0, 5, 4);
    Reflect.deleteProperty(missing, "alloc");
    const missingOwner = replaceState(owner, [number(4), missing]);
    preparedFailure(program(missingOwner, snapshot), finalMessage(owner, missingMessage()), true);
    reg.retire(a(0));
    const retiredSnapshot = reg.captureSnapshot();
    preparedFailure(program(owner, retiredSnapshot), finalMessage(owner, staleMessage(0)), true);
  });
  it("P07 resolved result types retain exact optional behavior", () => {
    const owner = fn(),
      reg = registry(),
      snapshot = reg.captureSnapshot();
    expect(() => assertPreparedIrProgramAllocations(program(owner, snapshot))).not.toThrow();
    const mismatched = fn([number(), { ...vector(), resultType: irVec(I32, false) }]);
    preparedFailure(
      program(mismatched, snapshot),
      `program allocations: site 0 contradicts body ${mismatched.unitId}'s result type`,
    );
    // Allocation-only legacy compatibility: do not claim whole-IR schema admission for this omitted field.
    const omitted = vector();
    Reflect.deleteProperty(omitted, "resultType");
    expect(Object.hasOwn(omitted, "resultType")).toBe(false);
    expect(() => assertPreparedIrProgramAllocations(program(fn([number(), omitted]), snapshot))).not.toThrow();
    expect(() =>
      assertPreparedIrProgramAllocations(program(fn([number(), { ...vector(), resultType: null }]), snapshot)),
    ).not.toThrow();
    const async = asyncOwner();
    const badState = replaceState(async, [number(4), { ...vector(0, 5, 4), resultType: irVec(I32, false) }]);
    preparedFailure(
      program(badState, snapshot),
      `program allocations: site 0 contradicts body ${async.unitId}'s result type`,
    );
  });
  it("P08 legacy allocation order and analyses remain observable", () => {
    const { owner, allocations } = analyzed(),
      p = program(owner, allocations);
    expect(allocations.metadata).toEqual([
      {
        id: a(0),
        entries: [
          ["ownership", { state: "owned", ops: [] }],
          ["escape", { classification: "local", stackAllocatable: true }],
        ],
      },
    ]);
    events.calls.length = 0;
    expect(() => assertPreparedIrProgramAllocations(p)).not.toThrow();
    expect(events.calls).toEqual(["constructor", "encoding", "ownership", "escape"]);
    const mismatched = {
      ...owner,
      blocks: owner.blocks.map((block) => ({
        ...block,
        instrs: block.instrs.map((instr) =>
          instr.kind === "vec.new_fixed" ? { ...instr, resultType: irVec(I32, false) } : instr,
        ),
      })),
    };
    events.calls.length = 0;
    preparedFailure(
      program(mismatched, allocations),
      `program allocations: site 0 contradicts body ${owner.unitId}'s result type`,
    );
    expect(events.calls).toEqual(["constructor", "encoding", "ownership", "escape"]);
    const missing = vector();
    Reflect.deleteProperty(missing, "alloc");
    const lost = { ...owner, blocks: [{ ...owner.blocks[0]!, instrs: [number(), missing] }] };
    events.calls.length = 0;
    preparedFailure(program(lost, allocations), finalMessage(owner, missingMessage()), true);
    expect(events.calls).toEqual(["constructor"]);
  });
});
