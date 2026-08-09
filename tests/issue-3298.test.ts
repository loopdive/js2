// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3298 — the target-neutral LinearMemoryPlan is the single middle-end owner
// of linear allocation, layout, lifetime, root, barrier, and static-storage
// decisions. The current arena policy must remain byte-compatible with the
// existing linear-Wasm adapter while keeping runtime bindings symbolic.

import { describe, expect, it } from "vitest";

import { compile } from "../src/index.js";
import {
  AllocSiteRegistry,
  IrFunctionBuilder,
  LinearMemoryPlan,
  irVal,
  planLinearMemory,
  planLinearRecordLayout,
  type IrObjectShape,
  type IrType,
} from "../src/ir/index.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { computeClassLayout } from "../src/codegen-linear/layout.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-3298");
const F64: IrType = irVal({ kind: "f64" });
const LINEAR_PTR: IrType = irVal({ kind: "i32" });

function buildPlanningFixture() {
  const registry = new AllocSiteRegistry();
  const shape: IrObjectShape = {
    fields: [
      { name: "label", type: { kind: "string" } },
      { name: "value", type: F64 },
    ],
  };
  const builder = new IrFunctionBuilder(identities.next("planned"), [F64], false, registry);
  const n = builder.addParam("n", F64);
  builder.openBlock();
  const hello = builder.emitStringConst("hé");
  const suffix = builder.emitStringConst("!");
  builder.emitStringConcat(hello, suffix);
  builder.emitObjectNew(shape, [hello, n]);
  builder.emitRefCellNew(n, { kind: "f64" });
  builder.emitVecNewFixed([n], F64, LINEAR_PTR);
  builder.emitExternNew("Date", []);
  builder.emitGlobalSet({ name: "savedLabel" }, hello);
  builder.terminate({ kind: "return", values: [n] });
  return { registry, shape, fn: builder.finish() };
}

describe("#3298 — target-neutral LinearMemoryPlan", () => {
  it("plans canonical layouts and allocation sites from the shared analyses", () => {
    const { registry, shape, fn } = buildPlanningFixture();
    const plan = planLinearMemory({ functions: [fn] }, registry);

    expect(plan.policy).toBe("arena-v1");
    expect(plan.allocations).toHaveLength(7);
    expect(new Set(plan.allocations.map((allocation) => allocation.id as number)).size).toBe(7);

    const objectLayout = plan.layoutForObjectShape(shape);
    expect(objectLayout).toBeDefined();
    expect(objectLayout?.size).toEqual({ kind: "constant", bytes: 24 });
    expect(objectLayout?.fields).toMatchObject([
      { name: "label", offset: 8, storage: "pointer", slotBytes: 8, containsPointer: true },
      { name: "value", offset: 16, storage: "f64", slotBytes: 8, containsPointer: false },
    ]);
    expect(objectLayout?.pointerMap).toEqual({ kind: "fixed", offsets: [8] });
    expect(plan.layout(objectLayout!.id)).toBe(objectLayout);

    const vectorLayout = plan.layoutForVector(F64);
    expect(vectorLayout).toMatchObject({
      lengthOffset: 8,
      capacityOffset: 12,
      elementsOffset: 16,
      elementStorage: "f64",
      elementStride: 8,
      minimumCapacity: 16,
    });
    const vectorAllocation = plan.allocations.find((allocation) => allocation.allocationKind === "array");
    expect(vectorAllocation?.size).toEqual({ kind: "constant", bytes: 144 });

    const objectAllocation = plan.allocations.find((allocation) => allocation.allocationKind === "object");
    const refCellAllocation = plan.allocations.find((allocation) => allocation.allocationKind === "refcell");
    expect(objectAllocation).toMatchObject({
      allocationClass: "arena",
      lifetime: "function",
      root: { kind: "none" },
      safepoints: { kind: "none" },
      barrier: { kind: "none" },
      ownership: "owned",
      escape: "local",
      stackCandidate: true,
    });
    expect(refCellAllocation).toMatchObject({ allocationClass: "arena", escape: "local", stackCandidate: true });
    expect(plan.allocations.find((allocation) => allocation.allocationKind === "extern")).toMatchObject({
      allocationClass: "managed",
      lifetime: "function",
      root: {
        kind: "managed",
        lifetime: "function",
        operation: { family: "managed", operation: "root" },
      },
      safepoints: { kind: "calls-and-backedges" },
      barrier: { kind: "none" },
    });

    expect(plan.globals).toEqual([
      {
        id: "savedLabel",
        allocationClass: "static",
        storage: "pointer",
        sizeBytes: 4,
        alignment: 4,
        containsPointer: true,
        mutable: true,
        initializer: "zero",
      },
    ]);
    expect(plan.dataSegments.map((segment) => segment.bytes)).toEqual([[33], [104, 195, 169]]);

    const stringEncodings = plan.allocations
      .filter((allocation) => allocation.allocationKind === "string")
      .map((allocation) => allocation.encoding)
      .sort();
    expect(stringEncodings).toEqual(["ascii", "utf8-guaranteed", "utf8-guaranteed"]);
  });

  it("serializes only semantic operations and artifact-neutral data", () => {
    const { registry, fn } = buildPlanningFixture();
    const plan = planLinearMemory({ functions: [fn] }, registry);
    const serialized = JSON.stringify(plan);

    expect(serialized).not.toMatch(/__malloc|__arr_|funcIdx|typeIdx|WasmFunction|Porffor|renderer|#include/);
    expect(plan.allocations.flatMap((allocation) => allocation.operations)).toContainEqual({
      family: "memory",
      operation: "allocate",
      allocationClass: "arena",
      zeroed: false,
    });
    expect(plan.allocations.flatMap((allocation) => allocation.operations)).toContainEqual({
      family: "vector",
      operation: "initialize-element",
      allocationClass: "arena",
      elementStorage: "f64",
    });

    const objectLayout = plan.layouts.find((layout) => layout.kind === "record");
    expect(Object.isFrozen(plan)).toBe(true);
    expect(Object.isFrozen(plan.allocations)).toBe(true);
    expect(Object.isFrozen(plan.allocations[0])).toBe(true);
    expect(Object.isFrozen(objectLayout)).toBe(true);
    expect(objectLayout?.kind === "record" && Object.isFrozen(objectLayout.fields)).toBe(true);
    expect(() => {
      (plan.allocations[0] as { layoutId: string }).layoutId = "mutated";
    }).toThrow(TypeError);

    const snapshot = plan.toJSON();
    expect(
      () =>
        new LinearMemoryPlan({
          ...snapshot,
          layouts: [...snapshot.layouts, snapshot.layouts[0]!],
        }),
    ).toThrow(/duplicate layout/);
    expect(
      () =>
        new LinearMemoryPlan({
          ...snapshot,
          allocations: [{ ...snapshot.allocations[0]!, layoutId: "missing" }, ...snapshot.allocations.slice(1)],
        }),
    ).toThrow(/references missing layout/);
  });

  it("keeps the direct linear class layout on the shared record-layout primitive", () => {
    const shared = planLinearRecordLayout("Example", [
      { name: "x", storage: "f64" },
      { name: "next", storage: "pointer" },
    ]);
    const legacySurface = computeClassLayout("Example", [
      { name: "x", type: "f64" },
      { name: "next", type: "i32" },
    ]);

    expect(legacySurface.totalSize).toBe(shared.size.kind === "constant" ? shared.size.bytes : -1);
    expect([...legacySurface.fields.values()]).toEqual([
      { type: "f64", offset: shared.fields[0]!.offset },
      { type: "i32", offset: shared.fields[1]!.offset },
    ]);
  });

  it("keeps allocator references symbolic when user registration changes helper indices", async () => {
    const objectFn = `export function objectValue(n: number): number {
      const value = { x: n, label: "ok" };
      return value.x;
    }`;
    const first = await compile(objectFn, { target: "linear" });
    expect(first.success, first.success ? "" : first.errors.map((error) => error.message).join("; ")).toBe(true);
    const firstHelper = getLastLinearIrReport()?.helpers[0];
    expect(firstHelper).toBeDefined();

    const second = await compile(`export function earlier(n: number): number { return n + 1; }\n${objectFn}`, {
      target: "linear",
    });
    expect(second.success, second.success ? "" : second.errors.map((error) => error.message).join("; ")).toBe(true);
    const secondHelper = getLastLinearIrReport()?.helpers[0];
    expect(secondHelper).toBeDefined();

    expect(secondHelper!.funcIdx).not.toBe(firstHelper!.funcIdx);
    expect(secondHelper!.allocate).toEqual(firstHelper!.allocate);
    expect(secondHelper!.allocate).toEqual({
      family: "memory",
      operation: "allocate",
      allocationClass: "arena",
      zeroed: false,
    });
  });

  it("preserves canonical UTF-8 plan bytes while the shared backend claim stays ASCII-only", async () => {
    const result = await compile(`export function unicode(): number { return "hé".length; }`, { target: "linear" });
    expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);

    const report = getLastLinearIrReport();
    expect(report?.compiled).not.toContain("unicode");
    expect(report?.rejected).toContainEqual({
      func: "unicode",
      reason: "build",
      detail: "ir/linear-string: ASCII encoding proof required for constant result (got utf8-guaranteed)",
    });
    const allocation = report?.memoryPlan.allocations.find((candidate) => candidate.dataSegmentId !== undefined);
    expect(allocation?.dataSegmentId).toBeDefined();
    expect(report?.memoryPlan.requireDataSegment(allocation!.dataSegmentId!).bytes).toEqual([104, 195, 169]);

    const instance = await WebAssembly.instantiate(result.binary!);
    expect((instance.instance.exports.unicode as () => number)()).toBe(2);
  });
});
