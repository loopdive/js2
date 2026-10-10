// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// Five reuse regression controls. Function/allocation validity is not whole prepared-population or native admission.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deserialize } from "node:v8";
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
const identities = createTestIrFunctionIdentityFactory("issue-6920-allocation-evidence-site-reuse");
type LegacyInput = Parameters<typeof assertPreparedIrProgramAllocations>[0];
interface Fixture {
  readonly module: IrModule;
  readonly authority: AllocSiteRegistry;
  readonly snapshot: AllocRegistrySnapshot;
  readonly actualProgram?: LegacyInput;
}
const reset = () => Object.assign(calls, { constructors: 0, encoding: 0, ownership: 0, escape: 0 });
function number(result = 0, integer = false): IrInstr {
  return {
    kind: "const",
    result: v(result),
    resultType: integer ? I32 : F64,
    value: integer ? { kind: "i32", value: 0 } : { kind: "f64", value: 1.5 },
  };
}
function vector(result = 1, id = 0): IrInstr {
  return {
    kind: "vec.new_fixed",
    result: v(result),
    resultType: VEC,
    elementType: F64,
    elements: [v(0)],
    alloc: a(id),
  };
}
function owner(instrs: readonly IrInstr[], valueCount = 3): IrFunction {
  return {
    ...identities.next("reuse"),
    params: [],
    resultTypes: [F64],
    exported: false,
    valueCount,
    blocks: [
      { id: asBlockId(0), blockArgs: [], blockArgTypes: [], instrs, terminator: { kind: "return", values: [v(0)] } },
    ],
  };
}
// Ordinary hand-authored core DATA. Every registry/snapshot comes from the genuine canonical class.
function fixture(repeated = false): Fixture {
  const authority = new AllocSiteRegistry();
  authority.fresh("array", VEC);
  return {
    module: { functions: [owner([number(), vector(), ...(repeated ? [vector(2)] : [])])] },
    authority,
    snapshot: authority.snapshot(),
  };
}
function program(f: Fixture): LegacyInput {
  return f.actualProgram ?? { ir: f.module, allocations: f.snapshot, runtimeSupport: undefined };
}
function withBody(f: Fixture, instrs: readonly IrInstr[]): Fixture {
  const fn = f.module.functions[0]!;
  return { ...f, module: { ...f.module, functions: [{ ...fn, blocks: [{ ...fn.blocks[0]!, instrs }] }] } };
}
function at(f: Fixture, root: number, unit = 0) {
  return { kind: "instruction", unitId: f.module.functions[unit]!.unitId, block: asBlockId(0), root, arms: [] };
}
function legacyPositive(f: Fixture, materialized = false) {
  const original = structuredClone({ module: f.module, snapshot: f.snapshot });
  for (const fn of f.module.functions) {
    expect(verifyIrFunction(fn)).toEqual([]);
    expect(verifyAllocProvenance(fn, f.authority)).toEqual([]);
    expect(() => assertFinalAllocProvenance(fn, f.authority)).not.toThrow();
  }
  reset();
  // The full retained caller reconstructs the real registry and invokes J1's helper after actual analyses.
  expect(() => assertPreparedIrProgramAllocations(program(f))).not.toThrow();
  expect(calls).toEqual({
    constructors: 1,
    encoding: f.module.functions.length,
    ownership: materialized ? f.module.functions.length : 0,
    escape: materialized ? f.module.functions.length : 0,
  });
  expect({ module: f.module, snapshot: f.snapshot }).toEqual(original);
}
function leaf(f: Fixture) {
  const original = structuredClone({ module: f.module, snapshot: f.snapshot });
  reset();
  const result = verifyAllocationEvidence(f.module, f.snapshot);
  expect(calls).toEqual({ constructors: 0, encoding: 0, ownership: 0, escape: 0 });
  expect({ module: f.module, snapshot: f.snapshot }).toEqual(original);
  return result;
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
function legacyFailure(f: Fixture): Error {
  const original = structuredClone({ module: f.module, snapshot: f.snapshot });
  const error = thrown(() => assertPreparedIrProgramAllocations(program(f)));
  expect({ module: f.module, snapshot: f.snapshot }).toEqual(original);
  return error;
}
function provenanceFailure(f: Fixture, message: string) {
  const fn = f.module.functions[0]!,
    errors = [{ func: fn.name, message }];
  expect(verifyAllocProvenance(fn, f.authority)).toEqual(errors);
  for (const error of [thrown(() => assertFinalAllocProvenance(fn, f.authority)), legacyFailure(f)]) {
    expect(error).toBeInstanceOf(IrInvariantError);
    expect(error).toMatchObject({ code: "allocation-provenance-failure", stage: "verify", cause: errors });
    expect(error.message).toBe(`IR alloc-provenance check failed (#1586):\n  - [${fn.name}] ${message}`);
  }
}
function cross(fresh: boolean): Fixture {
  const authority = new AllocSiteRegistry();
  authority.fresh("array", VEC);
  if (fresh) authority.fresh("array", VEC);
  return {
    module: { functions: [owner([number(), vector()], 2), owner([number(), vector(1, fresh ? 1 : 0)], 2)] },
    authority,
    snapshot: authority.snapshot(),
  };
}
function observed(f: Fixture): Fixture {
  for (const fn of f.module.functions) {
    analyzeEncoding(fn, f.authority);
    const ownership = analyzeOwnership(fn, f.authority);
    analyzeEscape(fn, f.authority, ownership);
  }
  return { ...f, snapshot: f.authority.snapshot() };
}
function readWrite(reused = false): Fixture {
  const authority = new AllocSiteRegistry();
  authority.fresh("array", VEC);
  authority.fresh("array", VEC);
  return observed({
    authority,
    snapshot: authority.snapshot(),
    module: {
      functions: [
        owner(
          [
            number(),
            number(1, true),
            vector(2),
            vector(3, reused ? 0 : 1),
            { kind: "vec.get", result: v(4), resultType: F64, vec: v(2), index: v(1) },
            { kind: "vec.set", result: null, resultType: null, vec: v(3), index: v(1), newValue: v(0) },
          ],
          5,
        ),
      ],
    },
  });
}
function captured(): Fixture {
  const bytes = readFileSync(new URL("./fixtures/issue-6920-allocation-evidence-core.v8", import.meta.url));
  expect(bytes.length).toBe(9314);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "e17410c15ac8770250a82f7c7ab05e786ff22de6a7f108d7852b6ddd8555ce97",
  );
  // DATA decode only; retain every captured byte and the existing attachment. No old codec/native claim.
  const actualProgram: LegacyInput = deserialize(bytes);
  expect(Object.hasOwn(actualProgram, "linearAllocationFacts")).toBe(true);
  const authority = new AllocSiteRegistry(),
    snapshot = actualProgram.allocations;
  expect(snapshot.entries).toHaveLength(1);
  const slot = snapshot.entries[0]!;
  if (slot.state !== "live") throw Error("producer fixture lost its actual live site");
  expect(authority.fresh(slot.site.kind, slot.site.type, slot.site.origin)).toBe(a(0));
  for (const row of snapshot.metadata)
    for (const [namespace, value] of row.entries) authority.annotate(row.id, namespace, value);
  return { module: actualProgram.ir, authority, snapshot, actualProgram };
}

describe("issue-6920 allocation evidence site reuse (five controls)", () => {
  it("SR01 same-function site reuse remains generic-valid and leaf-uncovered", () => {
    const single = fixture();
    legacyPositive(single);
    expect(leaf(single)).toEqual({
      kind: "verified",
      profile: "single-block-numeric-vector-if-v1",
      namespaces: "encoding-only",
      census: {
        functions: 1,
        buffers: 1,
        instructions: 2,
        allocations: 1,
        vectorReads: 0,
        vectorWrites: 0,
        registrySlots: 1,
      },
    });
    const repeated = fixture(true);
    legacyPositive(repeated);
    expect(leaf(repeated)).toEqual({ kind: "not-covered", reason: "allocation-site-reuse", at: at(repeated, 2) });
  });
  it("SR02 cross-function site reuse is uncovered at the second owner", () => {
    const repeated = cross(false);
    expect(repeated.module.functions[0]!.unitId).not.toBe(repeated.module.functions[1]!.unitId);
    legacyPositive(repeated);
    expect(leaf(repeated)).toEqual({ kind: "not-covered", reason: "allocation-site-reuse", at: at(repeated, 1, 1) });
    const distinct = cross(true);
    legacyPositive(distinct);
    expect(leaf(distinct)).toEqual({
      kind: "verified",
      profile: "single-block-numeric-vector-if-v1",
      namespaces: "encoding-only",
      census: {
        functions: 2,
        buffers: 2,
        instructions: 4,
        allocations: 2,
        vectorReads: 0,
        vectorWrites: 0,
        registrySlots: 2,
      },
    });
  });
  it("SR03 missing unknown retired and wrong-kind provenance stay invalid", () => {
    for (const mode of ["missing", "unknown", "retired", "wrong-kind"] as const) {
      const live = fixture();
      legacyPositive(live);
      expect(leaf(live).kind).toBe("verified");
      let invalid = live,
        message: string;
      if (mode === "missing") {
        const { alloc: _alloc, ...instruction } = live.module.functions[0]!.blocks[0]!.instrs[1]!;
        invalid = withBody(live, [number(), instruction]);
        message = 'allocation instr "vec.new_fixed" is missing an AllocSiteId (provenance lost)';
      } else if (mode === "unknown") {
        invalid = withBody(live, [number(), vector(1, 777)]);
        message = 'instr "vec.new_fixed" references unknown AllocSiteId 777 (dangling)';
      } else if (mode === "retired") {
        const authority = new AllocSiteRegistry();
        authority.fresh("array", VEC);
        authority.retire(a(0));
        invalid = { ...live, authority, snapshot: authority.snapshot() };
        message = 'live instr "vec.new_fixed" references retired/aliased-away AllocSiteId 0 (stale provenance)';
      } else {
        const authority = new AllocSiteRegistry();
        authority.fresh("object", VEC);
        invalid = { ...live, authority, snapshot: authority.snapshot() };
        message = 'instr "vec.new_fixed" has AllocSiteId 0 of kind "object", expected "array"';
      }
      provenanceFailure(invalid, message);
      expect(leaf(invalid)).toEqual({ kind: "invalid", code: "allocation-provenance", at: at(invalid, 1) });
      legacyPositive(live);
      expect(leaf(live).kind).toBe("verified");
    }
  });
  it("SR04 resolved type and null-result failures precede reuse", () => {
    const matching = fixture();
    legacyPositive(matching);
    expect(leaf(matching).kind).toBe("verified");
    const authority = new AllocSiteRegistry();
    authority.fresh("array", irVec(F64, true));
    const mismatched = { ...matching, authority, snapshot: authority.snapshot() };
    expect(verifyIrFunction(mismatched.module.functions[0]!)).toEqual([]);
    expect(verifyAllocProvenance(mismatched.module.functions[0]!, authority)).toEqual([]);
    const error = legacyFailure(mismatched);
    expect(error).toBeInstanceOf(PreparedIrProgramInvariantError);
    expect(error).toMatchObject({
      code: "invalid-prepared-data",
      message: `program allocations: site 0 contradicts body ${mismatched.module.functions[0]!.unitId}'s result type`,
    });
    expect(leaf(mismatched)).toEqual({ kind: "invalid", code: "site-result-type", at: at(mismatched, 1) });
    const repeated = fixture(true);
    legacyPositive(repeated);
    expect(leaf(repeated)).toEqual({ kind: "not-covered", reason: "allocation-site-reuse", at: at(repeated, 2) });
    const invalid = withBody(repeated, [number(), vector(), { ...vector(2), result: null }]);
    expect(leaf(invalid)).toEqual({ kind: "invalid", code: "lexical-definition", at: at(invalid, 2) });
  });
  it("SR05 distinct allocation IDs retain complete finite truth", () => {
    const real = captured();
    legacyPositive(real, true);
    expect(leaf(real)).toEqual({
      kind: "verified",
      profile: "single-block-numeric-vector-if-v1",
      namespaces: "ownership-and-escape",
      census: {
        functions: 1,
        buffers: 5,
        instructions: 16,
        allocations: 1,
        vectorReads: 5,
        vectorWrites: 0,
        registrySlots: 1,
      },
    });
    const distinct = readWrite();
    const evidence = (id: number, op: "read" | "write") => ({
      id: a(id),
      entries: [
        [ALLOC_NAMESPACES.ownership, { state: "owned", ops: [op] }],
        [ALLOC_NAMESPACES.escape, { classification: "local", stackAllocatable: true }],
      ] as const,
    });
    expect(distinct.snapshot.metadata).toEqual([evidence(0, "read"), evidence(1, "write")]);
    legacyPositive(distinct, true);
    expect(leaf(distinct)).toEqual({
      kind: "verified",
      profile: "single-block-numeric-vector-if-v1",
      namespaces: "ownership-and-escape",
      census: {
        functions: 1,
        buffers: 1,
        instructions: 6,
        allocations: 2,
        vectorReads: 1,
        vectorWrites: 1,
        registrySlots: 2,
      },
    });
    const swapped = {
      ...distinct,
      snapshot: { ...distinct.snapshot, metadata: [evidence(0, "write"), evidence(1, "read")] },
    };
    expect(leaf(swapped)).toEqual({ kind: "invalid", code: "namespace-value", at: { kind: "site", site: a(0) } });
    for (const [id, namespace] of [
      [0, ALLOC_NAMESPACES.ownership],
      [1, ALLOC_NAMESPACES.escape],
    ] as const) {
      const omitted = {
        ...distinct,
        snapshot: {
          ...distinct.snapshot,
          metadata: distinct.snapshot.metadata.map((row) =>
            row.id === id ? { ...row, entries: row.entries.filter(([key]) => key !== namespace) } : row,
          ),
        },
      };
      expect(leaf(omitted)).toEqual({ kind: "invalid", code: "namespace-presence", at: { kind: "site", site: a(id) } });
    }
    const reused = readWrite(true);
    expect(reused.snapshot.metadata).toEqual([evidence(0, "write")]);
    legacyPositive(reused, true);
    expect(leaf(reused)).toEqual({ kind: "not-covered", reason: "allocation-site-reuse", at: at(reused, 3) });
    legacyPositive(distinct, true);
    expect(leaf(distinct).kind).toBe("verified");
  });
});
