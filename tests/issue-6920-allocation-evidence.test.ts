// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// First-stage leaf assertions only; the 18 joined ROOT registrations remain held.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { deserialize } from "node:v8";
import { describe, expect, it, vi } from "vitest";
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
import { ALLOC_NAMESPACES } from "../src/ir/analysis/alloc-registry.js";
import type { AllocRegistrySnapshot } from "../src/ir/analysis/contracts/allocations.js";
import type {
  AllocationEvidenceCoverageReason,
  AllocationEvidenceMismatch,
} from "../src/ir/analysis/allocation-evidence/contracts.js";
import { verifyAllocationEvidence } from "../src/ir/analysis/allocation-evidence/verify.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

// Passthrough observers preserve genuine canonical implementations and instances.
const observers = vi.hoisted(() => ({ constructors: 0, encoding: 0, ownership: 0, escape: 0 }));
vi.mock("../src/ir/analysis/alloc-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/alloc-registry.js")>();
  return {
    ...actual,
    AllocSiteRegistry: class extends actual.AllocSiteRegistry {
      constructor() {
        super();
        observers.constructors++;
      }
    },
  };
});
vi.mock("../src/ir/analysis/encoding.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/encoding.js")>();
  return {
    ...actual,
    analyzeEncoding: (...args: Parameters<typeof actual.analyzeEncoding>) => {
      observers.encoding++;
      return actual.analyzeEncoding(...args);
    },
  };
});
vi.mock("../src/ir/analysis/ownership.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/ownership.js")>();
  return {
    ...actual,
    analyzeOwnership: (...args: Parameters<typeof actual.analyzeOwnership>) => {
      observers.ownership++;
      return actual.analyzeOwnership(...args);
    },
  };
});
vi.mock("../src/ir/analysis/escape.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ir/analysis/escape.js")>();
  return {
    ...actual,
    analyzeEscape: (...args: Parameters<typeof actual.analyzeEscape>) => {
      observers.escape++;
      return actual.analyzeEscape(...args);
    },
  };
});

const v = asValueId,
  a = asAllocSiteId;
const F64 = irVal({ kind: "f64" }),
  I32 = irVal({ kind: "i32" }),
  VEC = irVec(F64, false);
const identities = createTestIrFunctionIdentityFactory("issue-6920-allocation-evidence");
type Mode = "encoding-only" | "ownership-only" | "escape-only" | "ownership-and-escape";
type Access = "unused" | "read" | "write" | "read-write";
interface Fixture {
  module: IrModule;
  registry: AllocRegistrySnapshot;
}
const modes: readonly Mode[] = ["encoding-only", "ownership-only", "escape-only", "ownership-and-escape"];
function constant(id: number, kind: "i32" | "f64", value: number): IrInstr {
  return { kind: "const", result: v(id), resultType: kind === "i32" ? I32 : F64, value: { kind, value } };
}
function get(id: number, vec = 2, index = 1): IrInstr {
  return { kind: "vec.get", result: v(id), resultType: F64, vec: v(vec), index: v(index) };
}
function allocation(id = 2, site = 0): IrInstr {
  return { kind: "vec.new_fixed", result: v(id), resultType: VEC, elements: [v(0)], elementType: F64, alloc: a(site) };
}
function branch(
  then: readonly IrInstr[],
  thenValue = 4,
  otherwise: readonly IrInstr[] = [constant(5, "f64", NaN)],
  elseValue = 5,
): IrInstrIf {
  return {
    kind: "if",
    result: v(6),
    resultType: F64,
    cond: v(3),
    then,
    thenValue: v(thenValue),
    else: otherwise,
    elseValue: v(elseValue),
  };
}
function fn(instrs: readonly IrInstr[], returned = 0, ordinal = 0): IrFunction {
  return {
    unitId: identities.unit(ordinal),
    name: `unit${ordinal}`,
    params: [],
    resultTypes: [F64],
    exported: false,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs,
        terminator: { kind: "return", values: [v(returned)] },
      },
    ],
    valueCount: 32,
  };
}
function cells(access: Access, mode: Mode): (readonly [string, unknown])[] {
  const ops = access === "unused" ? [] : access === "read-write" ? ["read", "write"] : [access];
  const entries: (readonly [string, unknown])[] = [];
  if (mode === "ownership-only" || mode === "ownership-and-escape")
    entries.push([ALLOC_NAMESPACES.ownership, { state: "owned", ops }]);
  if (mode === "escape-only" || mode === "ownership-and-escape")
    entries.push([ALLOC_NAMESPACES.escape, { classification: "local", stackAllocatable: true }]);
  return entries;
}
// Ordinary, hand-authored core unit fixtures; only captured() has producer custody.
function fixture(access: Access = "read", mode: Mode = "ownership-and-escape"): Fixture {
  const instrs: IrInstr[] = [constant(0, "f64", 1.5), constant(1, "i32", 0), allocation()];
  if (access !== "unused") {
    instrs.push(constant(3, "i32", 0));
    const store: IrInstr = { kind: "vec.set", result: null, resultType: null, vec: v(2), index: v(1), newValue: v(0) };
    instrs.push(
      branch(access === "read" ? [get(4)] : access === "write" ? [store, constant(4, "f64", 1)] : [get(4), store]),
    );
  }
  const entries = cells(access, mode);
  return {
    module: { functions: [fn(instrs, access === "unused" ? 0 : 6)] },
    registry: {
      size: 1,
      entries: [{ state: "live", site: { id: a(0), kind: "array", type: VEC } }],
      metadata: entries.length ? [{ id: a(0), entries }] : [],
    },
  };
}
function body(f: Fixture): readonly IrInstr[] {
  return f.module.functions[0]!.blocks[0]!.instrs;
}
function withBody(f: Fixture, instrs: readonly IrInstr[], returned = 6): Fixture {
  const original = f.module.functions[0]!;
  return {
    ...f,
    module: {
      functions: [
        {
          ...original,
          blocks: [{ ...original.blocks[0]!, instrs, terminator: { kind: "return", values: [v(returned)] } }],
        },
      ],
    },
  };
}
function withCell(f: Fixture, namespace: string, value: unknown, site = 0): Fixture {
  const metadata = f.registry.metadata.filter((row) => row.id !== site);
  const entries =
    f.registry.metadata.find((row) => row.id === site)?.entries.filter(([key]) => key !== namespace) ?? [];
  return {
    ...f,
    registry: { ...f.registry, metadata: [...metadata, { id: a(site), entries: [...entries, [namespace, value]] }] },
  };
}
function withoutCell(f: Fixture, namespace: string, site?: number): Fixture {
  return {
    ...f,
    registry: {
      ...f.registry,
      metadata: f.registry.metadata.map((row) => ({
        ...row,
        entries: site === undefined || row.id === site ? row.entries.filter(([key]) => key !== namespace) : row.entries,
      })),
    },
  };
}
function verify(f: Fixture) {
  return verifyAllocationEvidence(f.module, f.registry);
}
function verified(f: Fixture, namespaces: Mode = "ownership-and-escape") {
  const result = verify(f);
  expect(result).toMatchObject({ kind: "verified", profile: "single-block-numeric-vector-if-v1", namespaces });
  if (result.kind !== "verified") throw new Error(`expected verified, received ${result.kind}`);
  return result;
}
function invalid(f: Fixture, code: AllocationEvidenceMismatch) {
  const result = verify(f);
  expect(result).toMatchObject({ kind: "invalid", code });
  return result;
}
function notCovered(f: Fixture, reason: AllocationEvidenceCoverageReason) {
  expect(verify(f)).toMatchObject({ kind: "not-covered", reason });
}
function twoArrays(mode: Mode = "ownership-and-escape"): Fixture {
  const first = fixture("read", mode),
    second = fixture("write", mode);
  return {
    module: {
      functions: [
        first.module.functions[0]!,
        {
          ...second.module.functions[0]!,
          unitId: identities.unit(1),
          name: "second",
          blocks: [
            {
              ...second.module.functions[0]!.blocks[0]!,
              instrs: body(second).map((i) => (i.kind === "vec.new_fixed" ? { ...i, alloc: a(1) } : i)),
            },
          ],
        },
      ],
    },
    registry: {
      size: 2,
      entries: [...first.registry.entries, { state: "live", site: { id: a(1), kind: "array", type: VEC } }],
      metadata: [...first.registry.metadata, ...second.registry.metadata.map((row) => ({ ...row, id: a(1) }))],
    },
  };
}
const CAPTURE_SHA = "e17410c15ac8770250a82f7c7ab05e786ff22de6a7f108d7852b6ddd8555ce97";
function captured(): Fixture {
  const bytes = readFileSync(new URL("./fixtures/issue-6920-allocation-evidence-core.v8", import.meta.url));
  expect(bytes.length).toBe(9314);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(CAPTURE_SHA);
  // Native V8 DATA decode only. The full A2 packet is neither rewritten nor admitted by an old codec.
  const data: { ir: IrModule; allocations: AllocRegistrySnapshot; linearAllocationFacts: unknown } = deserialize(bytes);
  expect(Object.hasOwn(data, "linearAllocationFacts")).toBe(true);
  expect(data.ir.functions).toHaveLength(1);
  expect(data.ir.functions[0]!.params.map((p) => p.type)).toEqual([F64, F64]);
  expect(data.ir.functions[0]!.blocks).toHaveLength(1);
  expect(data.ir.functions[0]!.blocks[0]!.instrs).toHaveLength(12);
  expect(data.allocations.size).toBe(1);
  expect(data.allocations.entries).toEqual([
    { state: "live", site: { id: a(0), kind: "array", type: VEC, origin: undefined } },
  ]);
  expect(data.allocations.metadata).toEqual([
    {
      id: a(0),
      entries: [
        ["ownership", { state: "owned", ops: ["read"] }],
        ["escape", { classification: "local", stackAllocatable: true }],
      ],
    },
  ]);
  return { module: data.ir, registry: data.allocations };
}
// Independent fixture-specific census, deliberately not the production traversal.
function capturedCensus(f: Fixture) {
  let instructions = 0,
    buffers = 0,
    reads = 0,
    nans = 0,
    allocations = 0;
  const visit = (buffer: readonly IrInstr[]) => {
    buffers++;
    for (const i of buffer) {
      instructions++;
      if (i.kind === "vec.get" || i.kind === "vec.len") reads++;
      if (i.kind === "vec.new_fixed") allocations++;
      if (i.kind === "const" && i.value.kind === "f64" && Object.is(i.value.value, NaN)) nans++;
      if (i.kind === "if") {
        visit(i.then);
        visit(i.else);
      }
    }
  };
  visit(body(f));
  return { instructions, buffers, reads, nans, allocations };
}

describe("issue-6920 standalone allocation-evidence leaf (22 registrations)", () => {
  it("AE01 captured producer core sample has 16 occurrences and five reads", () => {
    const f = captured();
    expect(capturedCensus(f)).toEqual({ instructions: 16, buffers: 5, reads: 5, nans: 2, allocations: 1 });
    expect(verified(f).census).toEqual({
      functions: 1,
      buffers: 5,
      instructions: 16,
      allocations: 1,
      vectorReads: 5,
      vectorWrites: 0,
      registrySlots: 1,
    });
    invalid(withCell(f, "ownership", { state: "escaped", ops: ["read"] }), "namespace-value");
  });
  it("AE02 nested-only read differs from an unused root array", () => {
    const read = fixture(),
      unused = fixture("unused");
    expect(verified(read).census).toEqual({
      functions: 1,
      buffers: 3,
      instructions: 7,
      allocations: 1,
      vectorReads: 1,
      vectorWrites: 0,
      registrySlots: 1,
    });
    expect(verified(unused).census.vectorReads).toBe(0);
    invalid(withCell(read, "ownership", { state: "owned", ops: [] }), "namespace-value");
    invalid(withCell(unused, "ownership", { state: "owned", ops: ["read"] }), "namespace-value");
  });
  it("AE03 constant-false arm write remains a may-effect", () => {
    const write = fixture("write"),
      noWrite = fixture("unused");
    expect(body(write)[3]).toMatchObject({ kind: "const", value: { kind: "i32", value: 0 } });
    expect(verified(write).census.vectorWrites).toBe(1);
    expect(verified(noWrite).census.vectorWrites).toBe(0);
    invalid(withCell(write, "ownership", { state: "owned", ops: [] }), "namespace-value");
    invalid(withCell(noWrite, "ownership", { state: "owned", ops: ["write"] }), "namespace-value");
  });
  it("AE04 NaN arms survive and repeated buffers remain occurrences", () => {
    expect(capturedCensus(captured()).nans).toBe(2);
    const f = fixture();
    const nanThen = [constant(4, "f64", NaN)],
      nanElse = [constant(5, "f64", NaN)];
    const both = withBody(fixture("unused"), [...body(f).slice(0, 4), branch(nanThen, 4, nanElse)], 6);
    expect(
      Object.is(
        nanThen[0]!.kind === "const" ? (nanThen[0].value.kind === "f64" ? nanThen[0].value.value : null) : null,
        NaN,
      ),
    ).toBe(true);
    expect(
      Object.is(
        nanElse[0]!.kind === "const" ? (nanElse[0].value.kind === "f64" ? nanElse[0].value.value : null) : null,
        NaN,
      ),
    ).toBe(true);
    expect(verified(both).census).toMatchObject({ buffers: 3, instructions: 7, vectorReads: 0 });
    const repeated = withBody(both, [...body(both).slice(0, 4), branch(nanThen, 4, nanThen, 4)]);
    expect(invalid(repeated, "lexical-definition")).toMatchObject({
      at: { kind: "instruction", root: 4, arms: [{ arm: "else", index: 0 }] },
    });
  });
  it("AE05 reference-valued if is outside the finite profile", () => {
    verified(fixture());
    const f = fixture("unused");
    const refIf: IrInstrIf = { ...branch([], 2, [], 2), resultType: VEC };
    const ref = withBody(f, [...body(f), constant(3, "i32", 1), refIf], 0);
    notCovered(ref, "reference-carrier");
  });
  it("AE06 nested allocation and extra execution domains are not covered", () => {
    verified(fixture());
    const f = fixture();
    const nestedBody = withBody(f, [...body(f).slice(0, 4), branch([allocation(7, 1), get(4, 7)])]);
    const nested: Fixture = {
      ...nestedBody,
      registry: {
        size: 2,
        entries: [...f.registry.entries, { state: "live", site: { id: a(1), kind: "array", type: VEC } }],
        metadata: [
          { id: a(0), entries: cells("unused", "ownership-and-escape") },
          { id: a(1), entries: cells("read", "ownership-and-escape") },
        ],
      },
    };
    notCovered(nested, "nested-allocation");
    const original = f.module.functions[0]!;
    const extraBlock: Fixture = {
      ...f,
      module: {
        functions: [
          {
            ...original,
            blocks: [
              { ...original.blocks[0]!, terminator: { kind: "br", branch: { target: asBlockId(1), args: [] } } },
              {
                id: asBlockId(1),
                blockArgs: [],
                blockArgTypes: [],
                instrs: [],
                terminator: { kind: "return", values: [v(0)] },
              },
            ],
          },
        ],
      },
    };
    notCovered(extraBlock, "function-shape");
    const loop: IrInstr = {
      kind: "while.loop",
      result: null,
      resultType: null,
      cond: [constant(7, "i32", 0)],
      condValue: v(7),
      body: [],
    };
    notCovered(withBody(f, [...body(f), loop]), "instruction-kind");
    const call: IrInstr = {
      kind: "call",
      result: v(7),
      resultType: F64,
      target: { kind: "func", name: original.name, binding: { kind: "unit", unitId: original.unitId } },
      args: [],
    };
    notCovered(withBody(f, [...body(f), call]), "instruction-kind");
    // Core domain marker only; prepared asynchronous state validity is ROOT-owned.
    notCovered({ ...f, module: { functions: [{ ...original, funcKind: "async" }] } }, "async-domain");
  });
  it("AE07 coordinated metadata agreement is not semantic truth", () => {
    const f = fixture();
    verified(f);
    const coordinated = withCell(
      withCell(withCell(f, "ownership", { state: "owned", ops: [] }), "escape", {
        classification: "opaque",
        stackAllocatable: false,
      }),
      "encoding",
      "ASCII",
    );
    expect(structuredClone(coordinated.registry)).toEqual(coordinated.registry);
    expect(verify(coordinated)).toMatchObject({ kind: "invalid", at: { kind: "site", site: a(0) } });
    for (const [namespace, value] of [
      ["ownership", { state: "escaped", ops: ["read", "write"] }],
      ["escape", { classification: "opaque", stackAllocatable: false }],
      ["encoding", "ASCII"],
    ] as const) {
      const copies = [structuredClone(value), structuredClone(value)];
      expect(copies[0]).toEqual(copies[1]);
      invalid(withCell(f, namespace, copies[0]), namespace === "encoding" ? "namespace-presence" : "namespace-value");
    }
  });
  it("AE09 globally disabled metadata yields encoding-only mode", () => {
    const f = fixture("read", "encoding-only");
    expect(f.registry.metadata).toEqual([]);
    expect(verified(f, "encoding-only").census.vectorReads).toBe(1);
    expect(f.registry.metadata).toEqual([]);
  });
  it("AE10 ownership-only mode checks requested truth", () => {
    const f = fixture("read", "ownership-only");
    verified(f, "ownership-only");
    invalid(withCell(f, "ownership", { state: "owned", ops: [] }), "namespace-value");
  });
  it("AE11 escape-only mode does not require globally absent ownership", () => {
    const f = fixture("read", "escape-only");
    verified(f, "escape-only");
    invalid(withCell(f, "escape", { classification: "opaque", stackAllocatable: true }), "namespace-value");
    invalid(withCell(f, "escape", { classification: "local", stackAllocatable: false }), "namespace-value");
  });
  it("AE12 both namespaces permit exact finite verification", () => {
    const f = twoArrays();
    expect(verified(f).census).toEqual({
      functions: 2,
      buffers: 6,
      instructions: 15,
      allocations: 2,
      vectorReads: 1,
      vectorWrites: 1,
      registrySlots: 2,
    });
    verified({
      ...f,
      registry: {
        ...f.registry,
        metadata: [...f.registry.metadata].reverse().map((row) => ({ ...row, entries: [...row.entries].reverse() })),
      },
    });
    const rw = fixture("read-write");
    verified(rw);
    invalid(withCell(rw, "ownership", { state: "owned", ops: ["write", "read"] }), "namespace-value");
  });
  it("AE13 ownership activation anywhere applies to every used site", () => {
    const f = twoArrays();
    expect(invalid(withoutCell(f, "ownership", 1), "namespace-presence")).toMatchObject({
      at: { kind: "site", site: a(1) },
    });
    verified(withoutCell(f, "ownership"), "escape-only");
  });
  it("AE14 escape activation anywhere applies to every used site", () => {
    const f = twoArrays();
    expect(invalid(withoutCell(f, "escape", 1), "namespace-presence")).toMatchObject({
      at: { kind: "site", site: a(1) },
    });
    verified(withoutCell(f, "escape"), "ownership-only");
  });
  it("AE15 unused registry slots retain exact empty semantic cells", () => {
    const f = fixture();
    const extended: Fixture = {
      ...f,
      registry: {
        size: 4,
        entries: [
          ...f.registry.entries,
          { state: "live", site: { id: a(1), kind: "array", type: VEC } },
          { state: "retired" },
          { state: "aliased", to: a(1) },
        ],
        metadata: [...f.registry.metadata, { id: a(1), entries: [] }],
      },
    };
    expect(verified(extended).census).toMatchObject({ allocations: 1, registrySlots: 4 });
    expect(extended.registry.entries[3]).toEqual({ state: "aliased", to: a(1) });
    expect(extended.registry.metadata[1]).toEqual({ id: a(1), entries: [] });
  });
  it("AE16 unused-site metadata cannot invent a write", () => {
    const f = fixture();
    const unused: Fixture = {
      ...f,
      registry: {
        ...f.registry,
        size: 2,
        entries: [...f.registry.entries, { state: "live", site: { id: a(1), kind: "array", type: VEC } }],
      },
    };
    verified(unused);
    invalid(withCell(unused, "ownership", { state: "owned", ops: ["write"] }, 1), "unused-site-evidence");
    invalid(withCell(unused, "escape", undefined, 1), "unused-site-evidence");
  });
  it("AE17 present undefined is not a missing metadata namespace", () => {
    const f = fixture();
    verified(f);
    invalid(withCell(f, "ownership", undefined), "namespace-value");
    invalid(withCell(f, "escape", undefined), "namespace-value");
    invalid(withCell(f, "encoding", undefined), "namespace-presence");
  });
  it("AE19 array encoding is absent in every namespace mode", () => {
    for (const mode of modes) {
      const f = fixture("read", mode);
      verified(f, mode);
      for (const value of [undefined, "ASCII", "WTF16"]) invalid(withCell(f, "encoding", value), "namespace-presence");
    }
  });
  it("AE20 metadata marker presence remains exact", () => {
    const f = fixture();
    verified(f);
    for (const stackCandidate of [false, undefined, true])
      invalid(
        withCell(f, "ownership", { state: "owned", ops: ["read"], stackCandidate }),
        "noncanonical-ownership-marker",
      );
    const instrs = body(f).map((i) => ({ ...i, site: undefined }));
    const withPresence: Fixture = {
      ...withBody(f, instrs),
      registry: {
        ...f.registry,
        entries: [{ state: "live", site: { id: a(0), kind: "array", type: VEC, origin: undefined } }],
      },
    };
    verified(withPresence);
    expect(Object.hasOwn(body(withPresence)[0]!, "site")).toBe(true);
    const entry = withPresence.registry.entries[0]!;
    expect(entry.state === "live" && Object.hasOwn(entry.site, "origin")).toBe(true);
  });
  it("AE24 lexical scopes reject sibling and future definitions", () => {
    const f = fixture("unused");
    const roots = [...body(f), constant(3, "i32", 1)];
    verified(withBody(f, [...roots, branch([], 0, [], 0)]));
    const sibling = withBody(f, [
      ...roots,
      branch([constant(4, "f64", 1)], 4, [
        { kind: "binary", op: "f64.add", result: v(5), resultType: F64, lhs: v(4), rhs: v(0) },
      ]),
    ]);
    expect(invalid(sibling, "lexical-definition")).toMatchObject({
      at: {
        kind: "instruction",
        unitId: f.module.functions[0]!.unitId,
        block: asBlockId(0),
        root: 4,
        arms: [{ arm: "else", index: 0 }],
      },
    });
    expect(invalid(withBody(f, [...roots, branch([], 6, [], 0)]), "lexical-definition")).toMatchObject({
      at: { kind: "instruction", root: 4, arms: [] },
    });
    const future = withBody(f, [
      ...roots,
      branch([{ kind: "binary", op: "f64.add", result: v(4), resultType: F64, lhs: v(7), rhs: v(0) }]),
      constant(7, "f64", 2),
    ]);
    expect(invalid(future, "lexical-definition")).toMatchObject({
      at: { kind: "instruction", root: 4, arms: [{ arm: "then", index: 0 }] },
    });
    invalid(withBody(f, [...roots, branch([constant(0, "f64", 2)], 0, [], 0)]), "lexical-definition");
  });
  it("AE25 closed grammar never inherits empty effects", () => {
    const f = fixture();
    const admitted: IrInstr[] = [
      { kind: "binary", op: "i32.lt_u", result: v(7), resultType: I32, lhs: v(1), rhs: v(3) },
      { kind: "binary", op: "f64.add", result: v(8), resultType: F64, lhs: v(0), rhs: v(6) },
    ];
    verified(withBody(f, [...body(f), ...admitted], 8));
    const unary: IrInstr = { kind: "unary", op: "f64.neg", result: v(7), resultType: F64, rand: v(0) };
    const select: IrInstr = {
      kind: "select",
      result: v(7),
      resultType: F64,
      condition: v(3),
      whenTrue: v(0),
      whenFalse: v(6),
    };
    for (const i of [unary, select]) notCovered(withBody(f, [...body(f), i]), "instruction-kind");
    notCovered(
      withBody(f, [...body(f), { ...admitted[1]!, kind: "binary", op: "f64.sub", lhs: v(0), rhs: v(6) }]),
      "numeric-opcode",
    );
    const original = f.module.functions[0]!;
    const slot: IrInstr = { kind: "slot.read", result: v(7), resultType: F64, slotIndex: 0 };
    const slotted = withBody(f, [...body(f), slot]);
    notCovered(
      {
        ...slotted,
        module: {
          functions: [{ ...slotted.module.functions[0]!, slots: [{ index: 0, name: "x", type: { kind: "f64" } }] }],
        },
      },
      "function-shape",
    );
    expect(original.unitId).toBe(slotted.module.functions[0]!.unitId);
  });
  it("AE26 buffer cycles and numeric edge values remain observable", () => {
    const f = fixture("unused");
    for (const value of [NaN, -0, Infinity, -Infinity]) {
      const number = constant(0, "f64", value);
      const edge = withBody(f, [number, ...body(f).slice(1)], 0);
      expect(number.kind === "const" && number.value.kind === "f64" && Object.is(number.value.value, value)).toBe(true);
      expect(verified(edge).census.instructions).toBe(3);
    }
    const cycle: IrInstr[] = [];
    cycle.push(branch(cycle, 0, [], 0));
    const cyclic = withBody(f, [...body(f), constant(3, "i32", 1), branch(cycle, 0, [], 0)]);
    invalid(cyclic, "occurrence-mismatch");
    const independent = withBody(f, [
      ...body(f),
      constant(3, "i32", 1),
      branch([constant(4, "f64", NaN)], 4, [constant(5, "f64", -0)]),
    ]);
    expect(verified(independent).census).toMatchObject({ buffers: 3, instructions: 7 });
  });
  it("AE27 real canonical observers are live before leaf zero counts", async () => {
    const f = captured();
    const { assertPreparedIrProgramAllocations } = await import("../src/ir/program/allocations.js");
    Object.assign(observers, { constructors: 0, encoding: 0, ownership: 0, escape: 0 });
    // Genuine canonical845 reconstruction and analysis of actual producer core DATA.
    assertPreparedIrProgramAllocations({ ir: f.module, allocations: f.registry, runtimeSupport: undefined });
    expect(observers).toEqual({ constructors: 1, encoding: 1, ownership: 1, escape: 1 });
    Object.assign(observers, { constructors: 0, encoding: 0, ownership: 0, escape: 0 });
    expect(verified(f).census.instructions).toBe(16);
    expect(observers).toEqual({ constructors: 0, encoding: 0, ownership: 0, escape: 0 });
  });
});
