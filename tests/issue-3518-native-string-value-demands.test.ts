// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, it, expect } from "vitest";
import { collectNativeStringValueDemands } from "../src/ir/program/native-string-value-demands.js";
import {
  asAllocSiteId,
  asValueId,
  type IrInstr,
  type IrInstrStringConst,
  type IrInstrIntrinsic,
} from "../src/ir/core/nodes.js";
import type { IrAsyncPlan, IrAsyncState, IrAsyncStateId } from "../src/ir/core/async-plan.js";
import type { PreparedIrFunction } from "../src/ir/runtime/contracts/prepared.js";
import type { PreparedIrProgram, PreparedIrProgramRuntimeProjection } from "../src/ir/program/prepared-contracts.js";
import type { AllocRegistrySnapshot, AllocRegistryMetadataSnapshot } from "../src/ir/analysis/contracts/allocations.js";
import type { IrUnitId } from "../src/shared/contracts/ir-identity.js";
import { irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { encodePreparedIrProgram, decodePreparedIrProgram } from "../src/ir/program-codec.js";
import { sourcePacket, typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";

const cache = new Map<string, PreparedIrProgram>();
function genuine(strings = false, recursive = false): PreparedIrProgram {
  const key = String(strings) + ":" + String(recursive),
    existing = cache.get(key);
  if (existing) return existing;
  // Recursive source is collected, not executed: its real call survives the
  // middle-end's small-function inliner, unlike the retained scalar fixture.
  const files = recursive
    ? { "./entry.ts": "export function main(x: number): number { return main(x - 1); }" }
    : strings
      ? { "./entry.ts": 'export function main(): string { return " source string "; }' }
      : undefined;
  const { packet } = sourcePacket(files);
  const policy = { target: "standalone", backend: "wasmgc", stringConst: { storage: "native" } } as const;
  const program = requireProgram(
    prepareTypedIrProgram(packet, strings ? { ...typedOptions, policy, runtimePolicies: [policy] } : typedOptions),
  );
  cache.set(key, program);
  return program;
}
function collect(program: PreparedIrProgram) {
  return collectNativeStringValueDemands(program, program.runtime[0]!);
}
function literal(value = "text"): IrInstrStringConst {
  return { kind: "string.const", value, result: asValueId(0), resultType: { kind: "string" } };
}
// Focused DATA fixtures below deliberately are not accepted/validated programs.
// They exercise the descriptive collector, never mint acceptance authority.
function data(functions?: readonly PreparedIrFunction[], allocations?: AllocRegistrySnapshot) {
  const base = genuine(),
    owners = functions ?? base.ir.functions;
  const projection = { ...base.runtime[0]!, prepared: { ...base.runtime[0]!.prepared, functions: owners } };
  const program = {
    ...base,
    ir: { ...base.ir, functions: owners },
    runtime: [projection],
    allocations: allocations ?? base.allocations,
  };
  return { program, projection };
}
function owner(instructions: readonly IrInstr[]): PreparedIrFunction {
  const base = genuine().ir.functions[0]!;
  return { ...base, blocks: [{ ...base.blocks[0]!, instrs: instructions }] };
}
function snapshot(metadata: readonly AllocRegistryMetadataSnapshot[] = []): AllocRegistrySnapshot {
  return {
    size: 2,
    entries: [
      { state: "aliased", to: asAllocSiteId(1) },
      { state: "live", site: { id: asAllocSiteId(1), kind: "string", type: { kind: "string" } } },
    ],
    metadata,
  };
}
function firstLiteral(program: PreparedIrProgram) {
  const demand = collect(program).literals[0];
  if (!demand || demand.kind !== "string.const") throw Error("missing positive literal");
  return demand;
}
describe("genuine preparation and decoded population", () => {
  for (const fixture of ["scalar", "string", "recursive"] as const)
    for (const decoded of [false, true])
      it("preserves complete source population fixture=" + fixture + " decoded=" + decoded, () => {
        const strings = fixture === "string";
        const source = genuine(strings, fixture === "recursive"),
          wire = encodePreparedIrProgram(source);
        const program = decoded ? decodePreparedIrProgram(wire) : source;
        if (decoded) {
          expect(program).not.toBe(source);
          expect(encodePreparedIrProgram(program)).toBe(wire);
        }
        const result = collect(program);
        expect(result.program).toBe(program);
        expect(result.projection).toBe(program.runtime[0]);
        expect(result.allocations).toBe(program.allocations);
        expect(result.owners.length).toBe(program.ir.functions.length);
        expect(result.owners.length).toBeGreaterThan(0);
        expect(result.owners.map((row) => row.unitId)).toEqual(program.ir.functions.map((fn) => fn.unitId));
        result.owners.forEach((row, i) => {
          expect(row.programFunction).toBe(program.ir.functions[i]);
          expect(row.projectedFunction).toBe(program.runtime[0]!.prepared.functions[i]);
        });
        // These source fixtures contain only flat, ordinary blocks. Enumerate
        // their input arrays directly, independently of the collector/walker.
        const expectedBuffers = program.ir.functions.flatMap((fn, ownerIndex) =>
          (
            [
              ["program", fn],
              ["projection", program.runtime[0]!.prepared.functions[ownerIndex]!],
            ] as const
          ).flatMap(([view, body]) => {
            expect(body.asyncPlan).toBeUndefined();
            expect(body.asyncRuntime).toBeUndefined();
            return body.blocks.map((block, index) => ({
              ownerUnitId: fn.unitId,
              view,
              root: { kind: "block", index, id: block.id },
              path: [],
              instructions: block.instrs,
            }));
          }),
        );
        const expectedOccurrences = expectedBuffers.flatMap((buffer, bufferIndex) =>
          buffer.instructions.map((instruction, instructionIndex) => ({ bufferIndex, instructionIndex, instruction })),
        );
        expect(result.buffers).toHaveLength(expectedBuffers.length);
        expect(result.buffers).toEqual(expectedBuffers);
        result.buffers.forEach((buffer, index) =>
          expect(buffer.instructions).toBe(expectedBuffers[index]!.instructions),
        );
        expect(result.occurrences).toHaveLength(expectedOccurrences.length);
        expect(result.occurrences).toEqual(expectedOccurrences);
        result.occurrences.forEach((row, index) =>
          expect(row.instruction).toBe(expectedOccurrences[index]!.instruction),
        );
        const expectedLiterals = expectedOccurrences.flatMap((row, occurrence) =>
          row.instruction.kind === "string.const" ? [occurrence] : [],
        );
        expect(result.literals.map((row) => row.occurrence)).toEqual(expectedLiterals);
        expect(result.intrinsics).toEqual([]);
        if (strings)
          expect(expectedOccurrences.map((row) => row.instruction.kind)).toEqual(["string.const", "string.const"]);
        else {
          expect(expectedOccurrences.some((row) => row.instruction.kind === "const")).toBe(true);
          if (fixture === "recursive")
            expect(expectedOccurrences.map((row) => row.instruction.kind)).toEqual([
              "const",
              "binary",
              "call",
              "const",
              "binary",
              "call",
            ]);
          expect(expectedOccurrences.every((row) => ["const", "call", "binary"].includes(row.instruction.kind))).toBe(
            true,
          );
        }
        expect(encodePreparedIrProgram(program)).toBe(wire);
      });
  for (const [field, value, diagnostic] of [
    ["schema", "foreign-schema", "program schema is not prepared-ir-program-v1"],
    ["sealed", false, "program is not sealed"],
    ["reconciliation", "partial", "program reconciliation is not complete"],
  ] as const)
    it("rejects local program marker " + field + " after real positive", () => {
      const program = genuine();
      collect(program);
      const changed = { ...program, [field]: value } as unknown as PreparedIrProgram;
      expect(() => collectNativeStringValueDemands(changed, program.runtime[0]!)).toThrow(diagnostic);
    });
  for (const change of ["missing", "duplicate", "reordered", "sparse", "empty"] as const)
    it("rejects " + change + " owners after real positive", () => {
      const base = genuine();
      expect(collect(base).owners.length).toBeGreaterThan(1);
      const projected = [...base.runtime[0]!.prepared.functions];
      if (change === "missing") projected.pop();
      if (change === "duplicate") projected[1] = projected[0]!;
      if (change === "reordered") projected.reverse();
      if (change === "sparse") {
        Reflect.deleteProperty(projected, 0);
        expect(Object.hasOwn(projected, 0)).toBe(false);
      }
      if (change === "empty") projected.length = 0;
      const projection = { ...base.runtime[0]!, prepared: { ...base.runtime[0]!.prepared, functions: projected } };
      const program = { ...base, runtime: [projection] };
      expect(() => collectNativeStringValueDemands(program, projection)).toThrow(/owner/);
    });
  it("rejects a copied foreign projection after positive", () => {
    const program = genuine();
    collect(program);
    expect(() => collectNativeStringValueDemands(program, { ...program.runtime[0]! })).toThrow(
      "foreign selected projection",
    );
  });
  it("rejects matching duplicated populations rather than blessing both views", () => {
    const base = genuine();
    collect(base);
    expect(() => collect(data([base.ir.functions[0]!, base.ir.functions[0]!]).program)).toThrow("duplicate");
  });
  it("rejects both populations being silently emptied", () => {
    collect(genuine());
    expect(() => collect(data([]).program)).toThrow("missing complete owner population");
  });
  for (const field of ["backend", "target", "policy-backend", "policy-target"] as const)
    it("rejects inconsistent " + field + " after positive", () => {
      const program = genuine();
      collect(program);
      const projection = structuredClone(program.runtime[0]!) as PreparedIrProgramRuntimeProjection;
      const changed =
        field === "backend"
          ? { ...projection, backend: "linear" }
          : field === "target"
            ? { ...projection, target: "host" }
            : {
                ...projection,
                prepared: {
                  ...projection.prepared,
                  manifest: {
                    ...projection.prepared.manifest,
                    policy: {
                      ...projection.prepared.manifest.policy,
                      [field === "policy-backend" ? "backend" : "target"]:
                        field === "policy-backend" ? "linear" : "host",
                    },
                  },
                },
              };
      const fixture = { ...program, runtime: [changed] } as PreparedIrProgram;
      expect(() => collect(fixture)).toThrow("not consistently standalone WasmGC");
    });
});
describe("ordered borrowed buffers and occurrences", () => {
  it("retains a non-number intrinsic and its exact provider at every occurrence", () => {
    const provider = { kind: "callable", target: irRuntimeFuncRef("__extern_is_undefined") } as const;
    const instruction: IrInstrIntrinsic = {
      kind: "intrinsic",
      id: "js.extern.is_undefined",
      version: 1,
      args: [asValueId(0)],
      result: asValueId(1),
      resultType: { kind: "val", val: { kind: "i32" } },
      provider,
    };
    const fixture = data([owner([literal(), instruction, instruction])]);
    const result = collect(fixture.program);
    expect(result.occurrences.map((row) => row.instruction.kind)).toEqual([
      "string.const",
      "intrinsic",
      "intrinsic",
      "string.const",
      "intrinsic",
      "intrinsic",
    ]);
    expect(result.intrinsics.map((row) => row.occurrence)).toEqual([1, 2, 4, 5]);
    result.intrinsics.forEach((row) => {
      expect(row.instruction).toBe(instruction);
      expect(row.instruction.provider).toBe(provider);
      if (row.instruction.provider?.kind === "callable") expect(row.instruction.provider.target).toBe(provider.target);
    });
  });
  it("retains shared sibling buffers, repeated instructions, empty buffers and both views in preorder", () => {
    const leaf = literal(),
      shared = [leaf, leaf],
      empty: IrInstr[] = [];
    const branch: IrInstr = {
      kind: "if.stmt",
      cond: asValueId(0),
      then: shared,
      else: shared,
      result: null,
      resultType: null,
    };
    const loop: IrInstr = {
      kind: "while.loop",
      cond: empty,
      body: [branch],
      result: null,
      resultType: null,
    } as IrInstr;
    const fn = owner([loop, leaf]),
      fixture = data([fn]);
    const r = collect(fixture.program);
    expect(r.buffers.map((b) => b.path)).toEqual([
      [],
      [{ instructionIndex: 0, childBufferIndex: 0 }],
      [{ instructionIndex: 0, childBufferIndex: 1 }],
      [
        { instructionIndex: 0, childBufferIndex: 1 },
        { instructionIndex: 0, childBufferIndex: 0 },
      ],
      [
        { instructionIndex: 0, childBufferIndex: 1 },
        { instructionIndex: 0, childBufferIndex: 1 },
      ],
      [],
      [{ instructionIndex: 0, childBufferIndex: 0 }],
      [{ instructionIndex: 0, childBufferIndex: 1 }],
      [
        { instructionIndex: 0, childBufferIndex: 1 },
        { instructionIndex: 0, childBufferIndex: 0 },
      ],
      [
        { instructionIndex: 0, childBufferIndex: 1 },
        { instructionIndex: 0, childBufferIndex: 1 },
      ],
    ]);
    expect(r.buffers[1]!.instructions).toBe(empty);
    expect(r.buffers[3]!.instructions).toBe(shared);
    expect(r.buffers[4]!.instructions).toBe(shared);
    expect(r.occurrences.map((o) => o.instruction)).toEqual([
      loop,
      branch,
      leaf,
      leaf,
      leaf,
      leaf,
      leaf,
      loop,
      branch,
      leaf,
      leaf,
      leaf,
      leaf,
      leaf,
    ]);
    expect(r.literals.map((d) => d.occurrence)).toEqual([2, 3, 4, 5, 6, 9, 10, 11, 12, 13]);
    expect(r.owners[0]!.programFunction).toBe(fn);
    expect(r.owners[0]!.projectedFunction).toBe(fn);
    expect(Object.isFrozen(fn)).toBe(false);
    expect(Object.isFrozen(shared)).toBe(false);
    expect(Object.isFrozen(leaf)).toBe(false);
    expect(Object.isFrozen(r)).toBe(true);
    expect(Object.isFrozen(r.buffers)).toBe(true);
    expect(Object.isFrozen(r.buffers[3]!.path[0])).toBe(true);
  });
  it("retains every intrinsic and regex operands without claiming materialization", () => {
    const intrinsic = {
      kind: "intrinsic",
      id: "js.number.unbox",
      version: 1,
      args: [asValueId(0)],
      result: asValueId(1),
      resultType: { kind: "val", val: { kind: "f64" } },
    } as IrInstrIntrinsic;
    const regex: IrInstr = {
      kind: "extern.regex",
      pattern: "a.*",
      flags: "gi",
      result: asValueId(2),
      resultType: null,
    };
    const unknown = { kind: "future.nonmaterialized", result: null, resultType: null } as unknown as IrInstr;
    const fixture = data([owner([intrinsic, regex, unknown])]),
      r = collect(fixture.program);
    expect(r.occurrences).toHaveLength(6);
    expect(r.intrinsics.map((d) => d.instruction)).toEqual([intrinsic, intrinsic]);
    expect(r.literals.map((d) => (d.kind === "extern.regex" ? [d.occurrence, d.part, d.value] : null))).toEqual([
      [1, "pattern", "a.*"],
      [1, "flags", "gi"],
      [4, "pattern", "a.*"],
      [4, "flags", "gi"],
    ]);
    expect(Object.keys(r)).not.toContain("accepted");
    expect(Object.keys(r)).not.toContain("supported");
  });
  it("includes semantic and selected runtime states, shared state occurrences, empty blocks and derived owners", () => {
    const leaf = literal(),
      state = {
        id: 7 as IrAsyncStateId,
        body: [leaf],
        terminator: { kind: "return", value: asValueId(0) },
      } as IrAsyncState;
    const base = owner([]),
      plan = { states: [state, state] } as unknown as IrAsyncPlan;
    const fn = {
      ...base,
      asyncPlan: plan,
      asyncRuntime: { kind: "standalone-native-wasmgc", adapters: [], states: [state] },
    } as PreparedIrFunction;
    const derived = { ...owner([]), unitId: "focused-derived-owner" as IrUnitId };
    const fixture = data([fn, derived]),
      r = collect(fixture.program);
    expect(r.owners.map((o) => o.unitId)).toEqual([fn.unitId, derived.unitId]);
    expect(r.owners[0]!.programFunction.asyncPlan).toBe(plan);
    expect(r.buffers.map((b) => [b.view, b.root.kind, b.root.index, b.instructions.length])).toEqual([
      ["program", "block", 0, 0],
      ["program", "async-plan", 0, 1],
      ["program", "async-plan", 1, 1],
      ["program", "async-runtime", 0, 1],
      ["projection", "block", 0, 0],
      ["projection", "async-plan", 0, 1],
      ["projection", "async-plan", 1, 1],
      ["projection", "async-runtime", 0, 1],
      ["program", "block", 0, 0],
      ["projection", "block", 0, 0],
    ]);
    expect(r.occurrences).toHaveLength(6);
    r.occurrences.forEach((o) => expect(o.instruction).toBe(leaf));
  });
  it("rejects a cyclic child buffer instead of deduplicating it to empty", () => {
    const a: IrInstr[] = [],
      fn = owner(a),
      fixture = data([fn]);
    expect(collect(fixture.program).buffers).toHaveLength(2);
    a.push({ kind: "if.stmt", cond: asValueId(0), then: a, else: [], result: null, resultType: null });
    expect(() => collect(fixture.program)).toThrow("cyclic nested instruction buffer");
  });
  it("rejects a missing instruction slot while preserving a genuinely empty buffer", () => {
    const instructions: IrInstr[] = [],
      fixture = data([owner(instructions)]);
    expect(collect(fixture.program).buffers).toHaveLength(2);
    instructions.length = 1;
    expect(() => collect(fixture.program)).toThrow("missing instruction occurrence");
  });
});
describe("allocation presence and original metadata evidence", () => {
  for (const mode of [
    "absent-alloc",
    "undefined-alloc",
    "absent-row",
    "empty-row",
    "absent-encoding",
    "undefined-encoding",
  ] as const)
    it("preserves " + mode, () => {
      const alloc =
        mode === "absent-alloc" ? {} : mode === "undefined-alloc" ? { alloc: undefined } : { alloc: asAllocSiteId(0) };
      const entries =
        mode === "undefined-encoding"
          ? [["encoding", undefined] as const]
          : mode === "absent-encoding"
            ? [["future", 42] as const]
            : [];
      const metadata = ["empty-row", "absent-encoding", "undefined-encoding"].includes(mode)
        ? [{ id: asAllocSiteId(1), entries }]
        : [];
      const instruction = { ...literal(), ...alloc },
        fixture = data([owner([instruction])], snapshot(metadata));
      const d = firstLiteral(fixture.program);
      expect(d.instruction).toBe(instruction);
      expect(d.allocation.allocation).toEqual(
        mode === "absent-alloc" ? { present: false } : { present: true, value: instruction.alloc },
      );
      expect(d.allocation.canonicalAllocation).toBe(mode.endsWith("alloc") ? null : asAllocSiteId(1));
      expect(d.allocation.metadataRow.present).toBe(metadata.length > 0);
      if (d.allocation.metadataRow.present) expect(d.allocation.metadataRow.value).toBe(metadata[0]);
      expect(d.allocation.encoding).toEqual(
        mode === "undefined-encoding" ? { present: true, value: undefined } : { present: false },
      );
    });
  it("retains unknown cyclic payload, namespaces, unused rows, source/storage/materializer identity without refreezing", () => {
    const payload: { self?: unknown; map: Map<string, unknown>; number: number; big: bigint } = {
      map: new Map([["undefined", undefined]]),
      number: -0,
      big: 17n,
    };
    payload.self = payload;
    const site = { line: 17, column: 3 },
      materializer = irRuntimeFuncRef("literal.materializer");
    const storage = {
      kind: "global",
      name: "literal storage",
      binding: { kind: "runtime", symbol: "literal.storage", bindingId: "focused-storage" },
    } as NonNullable<IrInstrStringConst["storage"]>;
    const instruction = { ...literal(), alloc: asAllocSiteId(0), site, storage, materializer };
    const metadata = [
      { id: asAllocSiteId(2), entries: [["unused-owner", payload]] as const },
      {
        id: asAllocSiteId(1),
        entries: [
          ["encoding", payload],
          ["future-unused", payload],
        ] as const,
      },
    ];
    const initial = snapshot(),
      allocations: AllocRegistrySnapshot = {
        size: 3,
        entries: [
          ...initial.entries,
          { state: "live", site: { id: asAllocSiteId(2), kind: "string", type: { kind: "string" } } },
        ],
        metadata,
      };
    const fixture = data([owner([instruction])], allocations),
      r = collect(fixture.program),
      d = firstLiteral(fixture.program);
    expect(r.allocations).toBe(allocations);
    expect(r.allocations.entries[1]).toBe(allocations.entries[1]);
    expect(r.allocations.metadata).toBe(metadata);
    expect(r.allocations.metadata[0]).toBe(metadata[0]);
    if (d.allocation.metadataRow.present) expect(d.allocation.metadataRow.value).toBe(metadata[1]);
    expect(d.instruction.site).toBe(site);
    expect(d.instruction.storage).toBe(storage);
    expect(d.instruction.materializer).toBe(materializer);
    expect(d.allocation.allocation).toEqual({ present: true, value: asAllocSiteId(0) });
    expect(d.allocation.canonicalAllocation).toBe(asAllocSiteId(1));
    expect(d.allocation.encoding).toEqual({ present: true, value: payload });
    if (d.allocation.encoding.present) expect(d.allocation.encoding.value).toBe(payload);
    expect(payload.self).toBe(payload);
    expect(Object.is(payload.number, -0)).toBe(true);
    expect(payload.big).toBe(17n);
    expect(Object.isFrozen(payload)).toBe(false);
    expect(Object.isFrozen(metadata[0])).toBe(false);
    expect(Object.isFrozen(instruction)).toBe(false);
  });
  for (const kind of ["unknown", "retired", "broken-alias", "cyclic-alias", "fractional", "negative"] as const)
    it("rejects " + kind + " live literal allocation after positive", () => {
      const instruction = { ...literal(), alloc: asAllocSiteId(0) },
        positive = data([owner([instruction])], snapshot());
      expect(firstLiteral(positive.program).allocation.canonicalAllocation).toBe(asAllocSiteId(1));
      const allocations =
        kind === "retired"
          ? { size: 1, entries: [{ state: "retired" }], metadata: [] }
          : kind === "broken-alias"
            ? { size: 1, entries: [{ state: "aliased", to: asAllocSiteId(3) }], metadata: [] }
            : kind === "cyclic-alias"
              ? { size: 1, entries: [{ state: "aliased", to: asAllocSiteId(0) }], metadata: [] }
              : snapshot();
      const alloc = kind === "unknown" ? 99 : kind === "fractional" ? 0.5 : kind === "negative" ? -1 : 0;
      const fixture = data(
        [owner([{ ...instruction, alloc: asAllocSiteId(alloc) }])],
        allocations as AllocRegistrySnapshot,
      );
      expect(() => collect(fixture.program)).toThrow(/allocation|snapshot/);
    });
});
