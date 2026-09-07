// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { analyzeMultiSource } from "../src/checker/index.js";
import { prepareIrProgramSources } from "../src/ir/program-source.js";
import {
  prepareIrProgramAbiEntries,
  preparedIrClassLayoutKey,
  preparedIrTypeKey,
} from "../src/ir/program-abi-contracts.js";
import { assertPreparedIrProgram } from "../src/ir/program-validation.js";
import { assertPreparedIrClassLayouts } from "../src/ir/program-class-layouts.js";
import { assertPreparedIrProgramAllocations } from "../src/ir/program-allocations.js";
import {
  freezePreparedIrValue,
  freezePreparedIrRuntimeValue,
  preparedIrDataMismatch,
  preparedIrProgramAbiLookup,
  preparedIrReadonlyMap,
  type PreparedIrProgram,
  type PreparedIrAbiEntry,
} from "../src/ir/program.js";
import {
  createIrAsyncPlan,
  canonicalPromiseAbi,
  asAsyncStateId,
  assertPreparedIrAsyncRuntimeCurrent,
} from "../src/ir/async-plan.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { RuntimeManifestBuilder } from "../src/ir/runtime-manifest.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { analyzeEncoding } from "../src/ir/analysis/encoding.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { IR_CLASS_SHAPE_CELL, type IrClassShape } from "../src/ir/nodes.js";
import { irClassTypeRef, irTypeBindingKey } from "../src/ir/abi-bindings.js";
import type { IrClassId } from "../src/ir/identity.js";

function fixture(): PreparedIrProgram {
  const ast = analyzeMultiSource(
    { "./entry.ts": "let base: number = 4; export function answer(value: number): number { return value + base; }" },
    "./entry.ts",
  );
  const source = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy: { backend: "wasmgc", target: "host" },
    deferTopLevelInit: false,
  });
  if (source.kind !== "prepared") throw new Error(source.detail);
  const semantic = freezePreparedIrValue({
    inventory: source.inventory,
    ir: source.ir,
    derivedUnits: source.derivedUnits,
    startup: source.startup,
    abi: { entries: prepareIrProgramAbiEntries(source) },
    allocations: source.allocations.snapshot(),
  }) as Pick<PreparedIrProgram, "inventory" | "ir" | "derivedUnits" | "startup" | "abi" | "allocations">;
  return {
    schema: "prepared-ir-program-v1",
    ...semantic,
    units: preparedIrReadonlyMap(semantic.inventory.terminalUnits.map((unit) => [unit.id, unit])),
    runtime: [
      {
        backend: "wasmgc",
        target: "host",
        prepared: {
          functions: semantic.ir.functions,
          manifest: new RuntimeManifestBuilder({ backend: "wasmgc", target: "host" }).freeze(),
          providers: new Map(),
        },
      },
    ],
    reconciliation: "complete",
    sealed: true,
  };
}

function runtimeMutation(
  program: PreparedIrProgram,
  patch: Partial<PreparedIrProgram["ir"]["functions"][number]>,
): PreparedIrProgram {
  const projection = program.runtime[0]!;
  const functions = projection.prepared.functions.map((fn, index) => (index === 0 ? { ...fn, ...patch } : fn));
  return { ...program, runtime: [{ ...projection, prepared: { ...projection.prepared, functions } }] };
}

describe("complete program validation", () => {
  it("validates original bodies, startup and exact ABI before reconstructing a lookup", () => {
    const program = fixture();
    expect(program.inventory.terminalUnits).toHaveLength(2);
    expect(program.ir.functions).toHaveLength(2);
    expect(() => assertPreparedIrProgram(program)).not.toThrow();
    expect(preparedIrProgramAbiLookup(program).entries()).toHaveLength(program.abi.entries.length);
    const contradictory = {
      ...program,
      abi: {
        entries: program.abi.entries.map((entry, index) =>
          index === 0 ? { ...entry, contract: { kind: "support", role: "false-callable" } } : entry,
        ),
      },
    } as PreparedIrProgram;
    expect(() => preparedIrProgramAbiLookup(contradictory)).toThrow("semantic contract kind");
    expect(() => assertPreparedIrProgram({ ...program, ir: { functions: program.ir.functions.slice(1) } })).toThrow(
      "missing body",
    );
    expect(() =>
      assertPreparedIrProgram({ ...program, ir: { functions: [...program.ir.functions, program.ir.functions[0]!] } }),
    ).toThrow("duplicated");
    expect(() => assertPreparedIrProgram({ ...program, startup: [] })).toThrow("startup omits");
  });

  it("rejects runtime result and export substitutions even with identical blocks and parameters", () => {
    const program = fixture();
    const first = program.ir.functions[0]!;
    expect(() => assertPreparedIrProgram(program)).not.toThrow();
    const result = runtimeMutation(program, { resultTypes: [{ kind: "val", val: { kind: "i32" } }] });
    expect(result.runtime[0]!.prepared.functions[0]!.blocks).toBe(first.blocks);
    expect(result.runtime[0]!.prepared.functions[0]!.params).toBe(first.params);
    expect(() => assertPreparedIrProgram(result)).toThrow("resultTypes");
    expect(() => assertPreparedIrProgram(runtimeMutation(program, { exported: !first.exported }))).toThrow("exported");
  });

  it("accepts recursive nominal class references but rejects a substituted field layout", () => {
    const left: IrClassShape = {
      [IR_CLASS_SHAPE_CELL]: true,
      classId: "ir-class:v1:test:left" as IrClassId,
      className: "Left",
      fields: [],
      methods: [],
      constructorParams: [],
    };
    const right: IrClassShape = {
      [IR_CLASS_SHAPE_CELL]: true,
      classId: "ir-class:v1:test:right" as IrClassId,
      className: "Right",
      fields: [],
      methods: [],
      constructorParams: [],
    };
    (left.fields as { name: string; type: unknown }[]).push({ name: "right", type: { kind: "class", shape: right } });
    (right.fields as { name: string; type: unknown }[]).push({ name: "left", type: { kind: "class", shape: left } });
    const entries: PreparedIrAbiEntry[] = [left, right].map((shape, index) => {
      const ref = irClassTypeRef(shape.classId, shape.className);
      return {
        plan: {
          id: ref.binding.bindingId,
          displayName: shape.className,
          order: { sourceOrder: 0, declarationOrder: index },
          slotPolicy: "required",
          slotSpace: "type",
          structuralReferenceKey: irTypeBindingKey(ref.binding),
          intent: { kind: "class", classId: shape.classId, layoutKey: preparedIrClassLayoutKey(shape) },
        },
        contract: { kind: "class", ref, shape },
      };
    });
    const base = fixture();
    const fn = { ...base.ir.functions[0]!, resultTypes: [{ kind: "class" as const, shape: left }] };
    const program = { abi: { entries }, ir: { functions: [fn] }, allocations: base.allocations };
    expect(preparedIrTypeKey(fn.resultTypes[0]!)).toContain(left.classId);
    expect(() => assertPreparedIrClassLayouts(program)).not.toThrow();
    expect(preparedIrDataMismatch(fn.resultTypes, freezePreparedIrValue(fn.resultTypes))).toBeUndefined();
    const wrong = {
      ...left,
      fields: [{ name: "changed", type: { kind: "val" as const, val: { kind: "f64" as const } } }],
    };
    expect(preparedIrDataMismatch(fn.resultTypes, [{ kind: "class", shape: wrong }])).toContain("fields");
    expect(() =>
      assertPreparedIrClassLayouts({
        ...program,
        ir: { functions: [{ ...fn, resultTypes: [{ kind: "class", shape: wrong }] }] },
      }),
    ).toThrow("complete layout");
    expect(() => assertPreparedIrClassLayouts({ ...program, abi: { entries: entries.slice(0, 1) } })).toThrow(
      "lacks a declared layout",
    );
  });

  it("recomputes allocation evidence against the final semantic body", () => {
    const program = fixture();
    const registry = new AllocSiteRegistry();
    const builder = new IrFunctionBuilder(
      { unitId: program.ir.functions[0]!.unitId, name: "text" },
      [{ kind: "string" }],
      false,
      registry,
    );
    builder.openBlock();
    const value = builder.emitStringConst("hello");
    builder.terminate({ kind: "return", values: [value] });
    const fn = builder.finish();
    analyzeEncoding(fn, registry);
    const allocations = registry.snapshot();
    expect(allocations.size).toBe(1);
    expect(allocations.metadata).toHaveLength(1);
    expect(() => assertPreparedIrProgramAllocations({ ir: { functions: [fn] }, allocations })).not.toThrow();
    expect(() =>
      assertPreparedIrProgramAllocations({ ir: { functions: [fn] }, allocations: { ...allocations, metadata: [] } }),
    ).toThrow("missing or stale encoding");
    expect(() =>
      assertPreparedIrProgramAllocations({
        ir: { functions: [fn] },
        allocations: {
          ...allocations,
          metadata: [{ id: allocations.metadata[0]!.id, entries: [["encoding", "wtf16"]] }],
        },
      }),
    ).toThrow("missing or stale encoding");
    expect(() =>
      assertPreparedIrProgramAllocations({
        ir: { functions: [fn] },
        allocations: { ...allocations, entries: [{ state: "retired" }], metadata: [] },
      }),
    ).toThrow("stale provenance");
  });
  it("freezes attached runtime data without detaching authenticated plan and manifest identities", () => {
    const original = fixture().ir.functions[0]!;
    const plan = createIrAsyncPlan({
      schemaVersion: 1,
      ownerUnitId: original.unitId,
      kind: "async-function",
      abi: canonicalPromiseAbi(null),
      entry: asAsyncStateId(0),
      params: [],
      values: [],
      spills: [],
      states: [{ id: asAsyncStateId(0), body: [], terminator: { kind: "resolve" } }],
      handlers: [],
      runtimeIntents: ["promise.capability.create", "value.undefined", "promise.settle.fulfill", "promise.resolve"],
    });
    const fn = { ...original, params: [], resultTypes: [], funcKind: "async" as const, asyncPlan: plan };
    const projected = prepareIrRuntimeManifest({
      functions: [fn],
      sourceFile: "entry.ts",
      policy: { backend: "wasmgc", target: "host" },
    });
    if (!projected) throw new Error("explicit Promise demand produced no manifest");
    // The whole-program producer wraps this existing lookup with the canonical immutable map.
    const runtime = { ...projected, providers: preparedIrReadonlyMap(projected.providers) };
    const body = runtime.functions[0]!;
    const current = assertPreparedIrAsyncRuntimeCurrent(body.unitId, body.name, body.asyncPlan, body.asyncRuntime);
    expect(freezePreparedIrRuntimeValue(runtime)).toBe(runtime);
    expect(assertPreparedIrAsyncRuntimeCurrent(body.unitId, body.name, body.asyncPlan, body.asyncRuntime)).toBe(
      current,
    );
    expect(body.asyncRuntime!.manifest).toBe(runtime.manifest);
    expect(Object.isFrozen(body)).toBe(true);
    expect(Object.isFrozen(body.blocks[0]!.instrs)).toBe(true);
    expect(() => freezePreparedIrRuntimeValue({ context: new Map() })).toThrow("mutable or executable context");
    expect(() => freezePreparedIrRuntimeValue({ callback: () => 1 })).toThrow("executable functions");
  });

  it("rejects native collection slots after their public prototype is erased or replaced", () => {
    for (const prototype of [null, Object.prototype]) {
      for (const collection of [new Map(), new Set(), new WeakMap(), new WeakSet()]) {
        const disguised = Object.setPrototypeOf(collection, prototype);
        expect(() => freezePreparedIrRuntimeValue({ context: disguised })).toThrow(
          expect.objectContaining({
            code: "invalid-prepared-data",
            message: expect.stringContaining("mutable or executable context"),
          }),
        );
      }
    }
    const data = Object.assign(Object.create(null), { value: 3 });
    expect(freezePreparedIrRuntimeValue(data)).toBe(data);
    expect(Object.isFrozen(data)).toBe(true);
  });
});
