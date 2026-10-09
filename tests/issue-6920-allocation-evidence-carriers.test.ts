// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Five carrier regressions; canonical allocation/function validity is not whole prepared/native admission.
import { describe, expect, it, vi } from "vitest";
import { AllocSiteRegistry, ALLOC_NAMESPACES } from "../src/ir/analysis/alloc-registry.js";
import type { AllocRegistrySnapshot } from "../src/ir/analysis/contracts/allocations.js";
import { verifyAllocProvenance, assertFinalAllocProvenance } from "../src/ir/analysis/alloc-verification.js";
import { analyzeEncoding } from "../src/ir/analysis/encoding.js";
import { analyzeOwnership } from "../src/ir/analysis/ownership.js";
import { analyzeEscape } from "../src/ir/analysis/escape.js";
import { verifyAllocationEvidence } from "../src/ir/analysis/allocation-evidence/verify.js";
import {
  asAllocSiteId,
  asBlockId,
  asValueId,
  type IrFunction,
  type IrInstr,
  type IrInstrIf,
  type IrModule,
} from "../src/ir/core/nodes.js";
import { irVal, irVec } from "../src/ir/core/types.js";
import { verifyIrFunction } from "../src/ir/runtime/verify.js";
import { assertPreparedIrProgramAllocations } from "../src/ir/program/allocations.js";
import { PreparedIrProgramInvariantError } from "../src/ir/program/errors.js";
import { IrInvariantError } from "../src/shared/contracts/ir-preparation-errors.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

// Each observer delegates to the original implementation, including the actual registry class.
const calls = vi.hoisted(() => ({ constructors: 0, encoding: 0, ownership: 0, escape: 0 }));
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

const F64 = irVal({ kind: "f64" }),
  I32 = irVal({ kind: "i32" }),
  VEC = irVec(F64, false);
const v = asValueId,
  a = asAllocSiteId;
const identities = createTestIrFunctionIdentityFactory("issue-6920-allocation-evidence-carriers");
interface Fixture {
  readonly module: IrModule;
  readonly authority: AllocSiteRegistry;
  readonly snapshot: AllocRegistrySnapshot;
}
interface Cell {
  readonly name: string;
  readonly root: number;
  readonly arm?: "then";
}
const cells: readonly Cell[] = [
  { name: "const f64", root: 0 },
  { name: "const i32", root: 1 },
  { name: "binary i32.lt_u", root: 3 },
  { name: "binary f64.add", root: 4 },
  { name: "vec.get", root: 5 },
  { name: "vec.len i32", root: 6 },
  { name: "vec.len f64", root: 7 },
  { name: "primitive if", root: 8 },
  { name: "nested then const", root: 8, arm: "then" },
];
const reset = () => Object.assign(calls, { constructors: 0, encoding: 0, ownership: 0, escape: 0 });
function number(result: number, integer = false): IrInstr {
  return {
    kind: "const",
    result: v(result),
    resultType: integer ? I32 : F64,
    value: integer ? { kind: "i32", value: 0 } : { kind: "f64", value: 1.5 },
  };
}
function vector(result: number): IrInstr {
  return { kind: "vec.new_fixed", result: v(result), resultType: VEC, elementType: F64, elements: [v(0)], alloc: a(0) };
}
function owner(instrs: readonly IrInstr[], count: number): IrFunction {
  return {
    ...identities.next("carrier"),
    params: [],
    resultTypes: [F64],
    exported: false,
    valueCount: count,
    blocks: [
      { id: asBlockId(0), blockArgs: [], blockArgTypes: [], instrs, terminator: { kind: "return", values: [v(0)] } },
    ],
  };
}
function observed(module: IrModule, authority: AllocSiteRegistry): Fixture {
  for (const fn of module.functions) {
    analyzeEncoding(fn, authority);
    const ownership = analyzeOwnership(fn, authority);
    analyzeEscape(fn, authority, ownership);
  }
  return { module, authority, snapshot: authority.snapshot() };
}
// Typed ordinary core fixtures; no copied analysis algorithm or replacement annotation output.
function scalarCarrier(): Fixture {
  const authority = new AllocSiteRegistry();
  expect(authority.fresh("array", VEC)).toBe(a(0));
  expect(authority.fresh("object", F64)).toBe(a(1));
  return observed({ functions: [owner([{ ...number(0), alloc: a(1) }, vector(1)], 2)] }, authority);
}
function matrix(cell?: Cell, ownUndefined = false): Fixture {
  const optional = (instr: IrInstr): IrInstr => (ownUndefined ? { ...instr, alloc: undefined } : instr);
  const then = [optional(number(8))],
    otherwise = [optional(number(9))];
  const branch: IrInstrIf = {
    kind: "if",
    cond: v(3),
    result: v(10),
    resultType: F64,
    then,
    thenValue: v(8),
    else: otherwise,
    elseValue: v(9),
  };
  const instrs: IrInstr[] = [
    optional(number(0)),
    optional(number(1, true)),
    vector(2),
    optional({ kind: "binary", op: "i32.lt_u", lhs: v(1), rhs: v(1), result: v(3), resultType: I32 }),
    optional({ kind: "binary", op: "f64.add", lhs: v(0), rhs: v(0), result: v(4), resultType: F64 }),
    optional({ kind: "vec.get", vec: v(2), index: v(1), result: v(5), resultType: F64 }),
    optional({ kind: "vec.len", vec: v(2), integer: true, result: v(6), resultType: I32 }),
    optional({ kind: "vec.len", vec: v(2), result: v(7), resultType: F64 }),
    optional(branch),
  ];
  const authority = new AllocSiteRegistry();
  authority.fresh("array", VEC);
  if (cell) {
    const instr = cell.arm ? then[0]! : instrs[cell.root]!;
    if (!instr.resultType) throw Error("carrier fixture has no registered result type");
    expect(authority.fresh("object", instr.resultType)).toBe(a(1));
    if (cell.arm) then[0] = { ...instr, alloc: a(1) };
    else instrs[cell.root] = { ...instr, alloc: a(1) };
  }
  return observed({ functions: [owner(instrs, 11)] }, authority);
}
function program(f: Fixture): Parameters<typeof assertPreparedIrProgramAllocations>[0] {
  return { ir: f.module, allocations: f.snapshot, runtimeSupport: undefined };
}
function input(f: Fixture) {
  return { module: f.module, snapshot: f.snapshot };
}
function canonical(f: Fixture) {
  const original = structuredClone(input(f));
  for (const fn of f.module.functions) {
    expect(verifyIrFunction(fn)).toEqual([]);
    expect(verifyAllocProvenance(fn, f.authority)).toEqual([]);
    expect(() => assertFinalAllocProvenance(fn, f.authority)).not.toThrow();
  }
  reset();
  // Exercise the complete retained caller, including its actual post-analysis J1 helper.
  expect(() => assertPreparedIrProgramAllocations(program(f))).not.toThrow();
  expect(calls).toEqual({ constructors: 1, encoding: 1, ownership: 1, escape: 1 });
  expect(input(f)).toEqual(original);
}
function leaf(f: Fixture) {
  const original = structuredClone(input(f));
  reset();
  const result = verifyAllocationEvidence(f.module, f.snapshot);
  expect(calls).toEqual({ constructors: 0, encoding: 0, ownership: 0, escape: 0 });
  expect(input(f)).toEqual(original);
  return result;
}
function location(f: Fixture, root: number, arm?: "then") {
  return {
    kind: "instruction",
    unitId: f.module.functions[0]!.unitId,
    block: asBlockId(0),
    root,
    arms: arm ? [{ arm, index: 0 }] : [],
  };
}
function refuse(f: Fixture, root: number, arm?: "then") {
  expect(leaf(f)).toEqual({ kind: "not-covered", reason: "instruction-kind", at: location(f, root, arm) });
}
function healthy(f: Fixture) {
  expect(leaf(f)).toEqual({
    kind: "verified",
    profile: "single-block-numeric-vector-if-v1",
    namespaces: "ownership-and-escape",
    census: {
      functions: 1,
      buffers: 3,
      instructions: 11,
      allocations: 1,
      vectorReads: 3,
      vectorWrites: 0,
      registrySlots: 1,
    },
  });
}
function completeScalarEvidence(f: Fixture) {
  expect(f.snapshot.size).toBe(2);
  expect(f.snapshot.metadata).toEqual([
    {
      id: a(0),
      entries: [
        [ALLOC_NAMESPACES.ownership, { state: "owned", ops: [] }],
        [ALLOC_NAMESPACES.escape, { classification: "local", stackAllocatable: true }],
      ],
    },
    {
      id: a(1),
      entries: [
        [ALLOC_NAMESPACES.ownership, { state: "escaped", ops: ["escape"] }],
        [ALLOC_NAMESPACES.escape, { classification: "returned", stackAllocatable: false }],
      ],
    },
  ]);
}
function thrown(run: () => void): Error {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw Error("negative control did not throw");
}

describe("issue-6920 allocation evidence carriers (five controls)", () => {
  it("AC01 genuine numeric carrier retains canonical allocation validity", () => {
    const f = scalarCarrier();
    completeScalarEvidence(f);
    canonical(f);
    refuse(f, 0);
  });
  it("AC02 omitted carrier metadata cannot produce finite verification", () => {
    const complete = scalarCarrier();
    completeScalarEvidence(complete);
    canonical(complete);
    refuse(complete, 0);
    const missing = {
      ...complete,
      snapshot: { ...complete.snapshot, metadata: complete.snapshot.metadata.filter((row) => row.id !== a(1)) },
    };
    expect(missing.snapshot.metadata).toEqual([complete.snapshot.metadata[0]!]);
    expect(missing.snapshot.metadata[0]!.entries.map(([namespace]) => namespace)).toEqual([
      ALLOC_NAMESPACES.ownership,
      ALLOC_NAMESPACES.escape,
    ]);
    const original = structuredClone(input(missing));
    reset();
    const error = thrown(() => assertPreparedIrProgramAllocations(program(missing)));
    expect(error).toBeInstanceOf(PreparedIrProgramInvariantError);
    expect(error).toMatchObject({
      code: "invalid-prepared-data",
      message: "program allocations: site 1 has missing or stale ownership evidence",
    });
    expect(calls).toEqual({ constructors: 1, encoding: 1, ownership: 1, escape: 1 });
    expect(input(missing)).toEqual(original);
    refuse(missing, 0);
    canonical(complete);
    completeScalarEvidence(complete);
    refuse(complete, 0);
  });
  it("AC03 admitted numeric kinds and nested arms exclude defined carriers", () => {
    for (const cell of cells) {
      const f = matrix(cell);
      canonical(f);
      expect(f.snapshot.size).toBe(2);
      const carrier = f.snapshot.metadata.find((row) => row.id === a(1));
      expect(carrier?.entries.map(([namespace]) => namespace)).toEqual([
        ALLOC_NAMESPACES.ownership,
        ALLOC_NAMESPACES.escape,
      ]);
      refuse(f, cell.root, cell.arm);
    }
  });
  it("AC04 absent and own-undefined IDs preserve healthy finite truth", () => {
    const absent = matrix(),
      undefinedOwn = matrix(undefined, true);
    for (const f of [absent, undefinedOwn]) {
      canonical(f);
      healthy(f);
    }
    const roots = (f: Fixture) => f.module.functions[0]!.blocks[0]!.instrs;
    for (const [index, instr] of roots(absent).entries())
      if (index !== 2) expect(Object.hasOwn(instr, "alloc")).toBe(false);
    for (const [index, instr] of roots(undefinedOwn).entries())
      if (index !== 2) {
        expect(Object.hasOwn(instr, "alloc")).toBe(true);
        expect(instr.alloc).toBeUndefined();
      }
    for (const f of [absent, undefinedOwn]) {
      const branch = roots(f)[8]!;
      if (branch.kind !== "if") throw Error("healthy fixture lost its real if");
      for (const instr of [...branch.then, ...branch.else]) {
        expect(Object.hasOwn(instr, "alloc")).toBe(f === undefinedOwn);
        expect(instr.alloc).toBeUndefined();
      }
      expect(roots(f)[2]!.alloc).toBe(a(0));
      const fn = f.module.functions[0]!;
      const missing = {
        ...f,
        module: {
          ...f.module,
          functions: [
            {
              ...fn,
              blocks: [
                {
                  ...fn.blocks[0]!,
                  instrs: roots(f).map((instr, index) => (index === 2 ? { ...instr, alloc: undefined } : instr)),
                },
              ],
            },
          ],
        },
      };
      expect(() => assertFinalAllocProvenance(missing.module.functions[0]!, missing.authority)).toThrow(
        IrInvariantError,
      );
      expect(leaf(missing)).toEqual({ kind: "invalid", code: "allocation-provenance", at: location(missing, 2) });
      canonical(f);
      healthy(f);
    }
  });
  it("AC05 genuine solver observations precede zero leaf calls and recovery", () => {
    const unchanged = matrix(),
      original = structuredClone(input(unchanged));
    canonical(unchanged);
    healthy(unchanged);
    for (const cell of cells) {
      const mutation = matrix(cell);
      canonical(mutation);
      refuse(mutation, cell.root, cell.arm);
      canonical(unchanged);
      healthy(unchanged);
      expect(input(unchanged)).toEqual(original);
    }
  });
});
