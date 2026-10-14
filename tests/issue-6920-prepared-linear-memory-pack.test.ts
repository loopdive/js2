// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it, vi } from "vitest";
import * as initializationProvider from "../src/wasm/physical/linear-vector-initialization.js";
import { analyzeMultiSource } from "../src/checker/index.js";
import { captureTypedIrProgramInput, prepareIrProgramSources } from "../src/ir/program-source.js";
import { prepareTypedIrProgram } from "../src/ir/program-prepare-ir.js";
import { typedOptions, requireProgram } from "./helpers/typed-program-fixtures.js";
import { createEmptyModule } from "../src/ir/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { PhysicalModuleReservations } from "../src/wasm/physical/module-reservations.js";
import {
  planPreparedLinearMemory,
  linearMemoryOptionsUnsupported,
  reservePreparedLinearMemory,
  preparedLinearMemoryBindings,
  fillPreparedLinearMemory,
  requireCompletedPreparedLinearMemory,
} from "../src/backend/linear/program/memory.js";
import { acquirePreparedLinearAllocation } from "../src/ir/program/linear-allocation-outcome.js";
import type { PreparedIrBackendOptions } from "../src/ir/program.js";

const vectorSource = "export function run(a:number,b:number):number {const xs=[a,b];return xs[0]+xs[1]+xs.length;}";
function fixture(target: "standalone" | "wasi" = "standalone", source = vectorSource) {
  const ast = analyzeMultiSource({ "./entry.ts": source }, "./entry.ts");
  const policy = { backend: "linear" as const, target };
  const lowered = prepareIrProgramSources({
    sourceFiles: ast.sourceFiles,
    entrySource: ast.entryFile,
    checker: ast.checker,
    policy,
    deferTopLevelInit: false,
    linearVectorProjection: "native-f64",
  });
  if (lowered.kind !== "prepared") throw new Error(lowered.detail);
  const program = requireProgram(
    prepareTypedIrProgram(captureTypedIrProgramInput(lowered), { ...typedOptions, policy, runtimePolicies: [policy] }),
  );
  const options: PreparedIrBackendOptions = {
    ...policy,
    sharedExceptionTag: false,
    utf8Storage: false,
    sourceMap: false,
    moduleName: "fixture",
  };
  const result = planPreparedLinearMemory({ program, projection: program.runtime[0]!, options });
  if (result.kind !== "supported") throw new Error(result.detail);
  return { program, options, plan: result.plan };
}
function reserved(target: "standalone" | "wasi" = "standalone") {
  const input = fixture(target);
  const module = createEmptyModule();
  const tx = new PhysicalModuleReservations(module);
  let live = true;
  const pack = reservePreparedLinearMemory(tx, input.plan, () => {
    if (!live) throw new Error("whole attempt revoked");
  });
  return {
    ...input,
    module,
    tx,
    pack,
    revoke: () => {
      live = false;
    },
  };
}

describe("issued native Linear memory pack", () => {
  it.each(["standalone", "wasi"] as const)(
    "plans actual %s source demand and interns only real provider signatures",
    (target) => {
      const f = reserved(target);
      expect(f.plan.demand.occurrences).toHaveLength(6);
      expect(f.plan.functions.map((fn) => fn.role)).toEqual([
        "malloc",
        "array-new",
        "initialize-element",
        "resolve-forwarding",
      ]);
      expect(f.plan.functions.some((fn) => fn.operation?.operation === "grow")).toBe(false);
      expect(f.module.types).toHaveLength(2);
      expect(f.module.memories).toEqual([{ min: 1, max: 256 }]);
      expect(f.module.functions.every((fn) => fn.body.length === 0)).toBe(true);
      expect(f.module.exports).toEqual([]);
      f.tx.freezeReservations();
      const binding = preparedLinearMemoryBindings(f.tx, f.pack);
      const allocation = f.plan.demand.occurrences[0]!.allocationId;
      const layout = binding.resolveVectorLayout({ kind: "val", val: { kind: "f64" } }, allocation);
      expect(layout).not.toHaveProperty("arrayTypeIdx");
      expect(layout.linearMemory.allocation?.id).toBe(allocation);
      fillPreparedLinearMemory(f.tx, f.pack);
      requireCompletedPreparedLinearMemory(f.tx, f.pack);
      requireCompletedPreparedLinearMemory(f.tx, f.pack);
      expect(binding.resolveRuntimeOperation(layout.linearMemory.allocate)).toBe(
        f.tx.physicalIndex(binding.supportFunctions[1]!),
      );
      expect(f.module.exports).toEqual([{ name: "memory", desc: { kind: "memory", index: 0 } }]);
      f.tx.seal();
    },
  );

  it("keeps genuine scalar source resource requirements empty", () => {
    const { plan } = fixture("standalone", "export function run(a:number):number{return a+1;}");
    expect(plan.functions).toEqual([]);
    expect(plan.exports).toEqual([]);
    expect(plan.memory).toBeUndefined();
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    const pack = reservePreparedLinearMemory(tx, plan, () => {});
    tx.freezeReservations();
    fillPreparedLinearMemory(tx, pack);
    requireCompletedPreparedLinearMemory(tx, pack);
    tx.seal();
    expect(module.memories).toEqual([]);
    expect(module.globals).toEqual([]);
    expect(module.functions).toEqual([]);
    expect(module.types).toEqual([]);
  });

  it("executes canonical providers with real tokens, raw headers and payload bytes", async () => {
    const f = reserved();
    f.tx.freezeReservations();
    const bindings = preparedLinearMemoryBindings(f.tx, f.pack);
    fillPreparedLinearMemory(f.tx, f.pack);
    for (const token of bindings.supportFunctions) f.tx.defineExport(`fixture:${token.key}`, token.object.name!, token);
    requireCompletedPreparedLinearMemory(f.tx, f.pack);
    f.tx.seal();
    const bytes = new Uint8Array(emitBinary(f.module));
    expect(WebAssembly.validate(bytes)).toBe(true);
    const wasm = await WebAssembly.instantiate(bytes, {});
    const exports = wasm.instance.exports;
    const newArray = exports.__arr_new as (cap: number) => number;
    const init = exports.__linear_ir_vec_init_f64 as (value: number, pointer: number, index: number) => void;
    const resolve = exports.__arr_resolve as (pointer: number) => number;
    const pointer = newArray(4);
    init(1.25, pointer, 0);
    init(-2.5, pointer, 1);
    const view = new DataView((exports.memory as WebAssembly.Memory).buffer);
    expect(pointer).toBe(1024);
    expect(view.getUint8(pointer)).toBe(1);
    expect(view.getUint32(pointer + 8, true)).toBe(0);
    expect(view.getUint32(pointer + 12, true)).toBe(4);
    expect(view.getFloat64(pointer + 16, true)).toBe(1.25);
    expect(view.getFloat64(pointer + 24, true)).toBe(-2.5);
    const old = newArray(4);
    view.setUint8(old, 6);
    view.setUint32(old + 4, pointer, true);
    expect(resolve(old)).toBe(pointer);
  });

  it("rejects cloned plan authority and consumes the original reserve attempt", () => {
    const { plan } = fixture();
    const tx = new PhysicalModuleReservations(createEmptyModule());
    expect(() => reservePreparedLinearMemory(tx, structuredClone(plan), () => {})).toThrow("unknown");
    reservePreparedLinearMemory(tx, plan, () => {});
    expect(() => reservePreparedLinearMemory(tx, plan, () => {})).toThrow("consumed");
  });
  it("rejects foreign tx and pack clones and terminally revokes captured bindings", () => {
    const f = reserved();
    f.tx.freezeReservations();
    const binding = preparedLinearMemoryBindings(f.tx, f.pack);
    expect(() => preparedLinearMemoryBindings(f.tx, { ...f.pack })).toThrow("unknown pack");
    expect(() => fillPreparedLinearMemory(new PhysicalModuleReservations(createEmptyModule()), f.pack)).toThrow(
      "foreign",
    );
    expect(() => binding.resolveRuntimeOperation({ family: "vector", operation: "resolve-forwarding" })).toThrow(
      "failed",
    );
  });
  it("revokes completed provider bindings when the whole attempt ends", () => {
    const f = reserved();
    f.tx.freezeReservations();
    const binding = preparedLinearMemoryBindings(f.tx, f.pack);
    fillPreparedLinearMemory(f.tx, f.pack);
    requireCompletedPreparedLinearMemory(f.tx, f.pack);
    f.revoke();
    expect(() => binding.resolveVectorLayout({ kind: "val", val: { kind: "f64" } })).toThrow("revoked");
    expect(() => requireCompletedPreparedLinearMemory(f.tx, f.pack)).toThrow("failed");
  });
  it("phase misuse is terminal and cannot be rehabilitated after freeze", () => {
    const f = reserved();
    expect(() => preparedLinearMemoryBindings(f.tx, f.pack)).toThrow("filling");
    f.tx.freezeReservations();
    expect(() => fillPreparedLinearMemory(f.tx, f.pack)).toThrow("failed");
  });
  it("rejects duplicate fill and noninventoried runtime operations", () => {
    const f = reserved();
    f.tx.freezeReservations();
    fillPreparedLinearMemory(f.tx, f.pack);
    expect(() => fillPreparedLinearMemory(f.tx, f.pack)).toThrow("duplicate");
    expect(() => requireCompletedPreparedLinearMemory(f.tx, f.pack)).toThrow("failed");
    const other = reserved();
    other.tx.freezeReservations();
    const binding = preparedLinearMemoryBindings(other.tx, other.pack);
    expect(() =>
      binding.resolveRuntimeOperation({
        family: "vector",
        operation: "grow",
        allocationClass: "arena",
        elementStorage: "f64",
      }),
    ).toThrow("unplanned");
  });
  it("refuses unsupported lifecycle resources before any reservation", () => {
    const f = fixture();
    const result = planPreparedLinearMemory({
      program: f.program,
      projection: f.program.runtime[0]!,
      options: { ...f.options, linear: { exposeArenaReset: true } },
    });
    expect(result).toMatchObject({ kind: "unsupported", code: "array-representation-unsupported" });
  });
  it("consumes guard-failed reservation without allocating or retrying", () => {
    const { plan } = fixture();
    const module = createEmptyModule();
    const tx = new PhysicalModuleReservations(module);
    expect(() =>
      reservePreparedLinearMemory(tx, plan, () => {
        throw new Error("guard rejected");
      }),
    ).toThrow("guard rejected");
    expect(module.functions).toEqual([]);
    expect(module.memories).toEqual([]);
    expect(() => reservePreparedLinearMemory(tx, plan, () => {})).toThrow("consumed");
  });
  it("refuses stale complete input and terminally rejects corrupted owned tokens", () => {
    const f = fixture();
    Object.assign(f.options, { moduleName: "changed" });
    expect(() =>
      reservePreparedLinearMemory(new PhysicalModuleReservations(createEmptyModule()), f.plan, () => {}),
    ).toThrow("input changed");
    const other = reserved();
    other.tx.freezeReservations();
    const bindings = preparedLinearMemoryBindings(other.tx, other.pack);
    bindings.supportFunctions[0]!.object.typeIdx = bindings.supportFunctions[2]!.object.typeIdx;
    expect(() => fillPreparedLinearMemory(other.tx, other.pack)).toThrow();
    expect(() => bindings.resolveRuntimeOperation({ family: "vector", operation: "resolve-forwarding" })).toThrow(
      "failed",
    );
  });
  it("consumes canonical body construction failure before kernel fill and rejects later bindings", () => {
    const f = reserved();
    f.tx.freezeReservations();
    const binding = preparedLinearMemoryBindings(f.tx, f.pack);
    const spy = vi.spyOn(initializationProvider, "buildLinearF64VectorInitializationBody").mockImplementation(() => {
      throw new Error("provider construction fault");
    });
    try {
      expect(() => fillPreparedLinearMemory(f.tx, f.pack)).toThrow("provider construction fault");
      expect(() => requireCompletedPreparedLinearMemory(f.tx, f.pack)).toThrow("failed");
      expect(() => binding.resolveVectorLayout({ kind: "val", val: { kind: "f64" } })).toThrow("failed");
      expect(f.module.exports).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
  it("admits explicit canonical bump and refuses the distinct malloc recipe", () => {
    const f = fixture();
    expect(
      planPreparedLinearMemory({
        program: f.program,
        projection: f.program.runtime[0]!,
        options: { ...f.options, linear: { heapAllocator: "bump", allocationPolicy: "arena-v1" } },
      }).kind,
    ).toBe("supported");
    expect(
      planPreparedLinearMemory({
        program: f.program,
        projection: f.program.runtime[0]!,
        options: { ...f.options, linear: { heapAllocator: "malloc-v1" } },
      }).kind,
    ).toBe("unsupported");
  });
  it.each(["standalone", "wasi"] as const)(
    "retains option refusals before a genuine historical %s scalar empty skip",
    (target) => {
      const f = fixture(target, "export function run(a:number):number{return a+1;}");
      const { linearAllocationFacts: _oldAttachment, ...historical } = f.program;
      const acquired = acquirePreparedLinearAllocation(historical, f.options, historical.runtime[0]!);
      expect(acquired).toEqual({ kind: "checked", input: undefined });
      expect(historical.allocations.size).toBe(0);
      expect(linearMemoryOptionsUnsupported(f.options)).toBeUndefined();
      expect(
        linearMemoryOptionsUnsupported({
          ...f.options,
          linear: { heapAllocator: "bump", allocationPolicy: "arena-v1" },
        }),
      ).toBeUndefined();
      for (const linear of [
        { exposeArenaReset: true },
        { importMemory: { module: "fixture", name: "memory", min: 1, max: 256 } },
        { allocationPolicy: "analysis-stack-arena-v1" },
        { heapAllocator: "malloc-v1" },
      ] as const)
        expect(linearMemoryOptionsUnsupported({ ...f.options, linear })).toContain("only the default");
      expect(historical).not.toHaveProperty("linearAllocationFacts");
    },
  );
});
