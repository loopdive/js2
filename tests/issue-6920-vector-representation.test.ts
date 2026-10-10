// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6920 — generic vector representation contract.
//
// One vector intent (two fixed f64 literals, set/get/len and a primitive `if`)
// lowers through the real generic lowerer and BOTH genuine emitters. The
// representation is resolved once per backend: WasmGC keeps its registered
// struct/array handle and `ref_null $array` construction scratch; linear memory
// carries a genuine i32 handle with no GC fields, and its construction scratch
// is declared i32 by the lowerer itself — the assembled function uses the
// lowered locals verbatim (no post-lowering retyping). Mismatched handles are
// rejected before any vector primitive is emitted or any GC symbolic type is
// looked up. These are low-level contract tests; they do not claim native
// public program support.

import { describe, expect, it } from "vitest";

import { addArrayRuntime, addLinearIrVecRuntime, addRuntime } from "../src/codegen-linear/runtime.js";
import { emitBinary } from "../src/emit/binary.js";
import {
  defaultOperationsForLayout,
  type LinearAllocationSitePlan,
  type LinearMemoryPlan,
  type LinearRuntimeOperation,
} from "../src/ir/analysis/linear-memory-plan.js";
import type { IrVecBackendLowering, IrVecLowering, LinearVecLowering } from "../src/ir/backend/handles.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { resolveIrVecRepresentation } from "../src/ir/backend/vector-representation.js";
import { wasmValueTypeConverter } from "../src/ir/backend/wasm-lowering.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { irSupportTypeRef } from "../src/ir/core/type-references.js";
import { irSupportRef } from "../src/ir/core/types.js";
import { createIrSourceId } from "../src/ir/identity.js";
import {
  AllocSiteRegistry,
  IrFunctionBuilder,
  irVal,
  planLinearMemory,
  verifyIrBackendLegality,
  verifyIrFunction,
  type AllocSiteId,
  type IrFunction,
  type IrLowerResolver,
  type IrType,
  type IrTypeRef,
} from "../src/ir/index.js";
import { lowerIrFunctionBody, lowerIrTypeToValType } from "../src/ir/lower.js";
import { projectIrFunctionSignatureWithConverter } from "../src/ir/lower-generic.js";
import type { FuncTypeDef, Instr, ValType, WasmFunction, WasmModule } from "../src/ir/types.js";
import { createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

const identities = createTestIrFunctionIdentityFactory("issue-6920-vector-representation");
const F64: IrType = irVal({ kind: "f64" });
const I32: IrType = irVal({ kind: "i32" });
const VEC_F64: IrType = { kind: "vec", elementType: F64, nullable: false };
const VEC_I32: IrType = { kind: "vec", elementType: I32, nullable: false };

/** JS oracle for {@link vectorIntent}. */
function oracle(a: number, b: number, index: number): number {
  const v = [a, b, a];
  const w = [b, a];
  v[1] = 9;
  const selected = index >= 0 && index < v.length ? v[index]! : 0;
  return selected + v.length * 100 + w[0]! * 1000 + w.length * 10000;
}

function vectorIntent(): { func: IrFunction; allocations: AllocSiteRegistry } {
  const allocations = new AllocSiteRegistry();
  const fn = new IrFunctionBuilder(identities.next("run"), [F64], true, allocations);
  const a = fn.addParam("a", F64);
  const b = fn.addParam("b", F64);
  const index = fn.addParam("index", I32);
  fn.openBlock();
  const v = fn.emitVecNewFixed([a, b, a], F64, VEC_F64);
  const w = fn.emitVecNewFixed([b, a], F64, VEC_F64);
  const one = fn.emitConst({ kind: "i32", value: 1 }, I32);
  const nine = fn.emitConst({ kind: "f64", value: 9 }, F64);
  fn.emitVecSet(v, one, nine);
  const lengthV = fn.emitVecLen(v);
  const lengthI32 = fn.emitUnary("i32.trunc_sat_f64_s", lengthV, I32);
  const inBounds = fn.emitBinary("i32.lt_u", index, lengthI32, I32);
  let found!: ReturnType<IrFunctionBuilder["emitVecGet"]>;
  const foundBody = fn.collectBodyInstrs(() => {
    found = fn.emitVecGet(v, index, F64);
  });
  let missing!: ReturnType<IrFunctionBuilder["emitConst"]>;
  const missingBody = fn.collectBodyInstrs(() => {
    missing = fn.emitConst({ kind: "f64", value: 0 }, F64);
  });
  const selected = fn.emitIfElse({
    cond: inBounds,
    then: foundBody,
    thenValue: found,
    else: missingBody,
    elseValue: missing,
    resultType: F64,
  });
  const zero = fn.emitConst({ kind: "i32", value: 0 }, I32);
  const w0 = fn.emitVecGet(w, zero, F64);
  const lengthW = fn.emitVecLen(w);
  const hundred = fn.emitConst({ kind: "f64", value: 100 }, F64);
  const thousand = fn.emitConst({ kind: "f64", value: 1000 }, F64);
  const tenThousand = fn.emitConst({ kind: "f64", value: 10000 }, F64);
  const lengthScore = fn.emitBinary("f64.mul", lengthV, hundred, F64);
  const wScore = fn.emitBinary("f64.mul", w0, thousand, F64);
  const wLengthScore = fn.emitBinary("f64.mul", lengthW, tenThousand, F64);
  const partial = fn.emitBinary("f64.add", selected, lengthScore, F64);
  const partial2 = fn.emitBinary("f64.add", partial, wScore, F64);
  const result = fn.emitBinary("f64.add", partial2, wLengthScore, F64);
  fn.terminate({ kind: "return", values: [result] });
  const func = fn.finish();
  expect(verifyIrFunction(func)).toEqual([]);
  return { func, allocations };
}

function vecNewFixedAllocs(func: IrFunction): AllocSiteId[] {
  return func.blocks.flatMap((block) =>
    block.instrs.flatMap((instr) => (instr.kind === "vec.new_fixed" && instr.alloc !== undefined ? [instr.alloc] : [])),
  );
}

function flatOps(body: readonly Instr[]): Instr[] {
  return body.flatMap((instr) => {
    const nested = instr as { body?: readonly Instr[]; then?: readonly Instr[]; else?: readonly Instr[] };
    return [instr, ...flatOps(nested.body ?? []), ...flatOps(nested.then ?? []), ...flatOps(nested.else ?? [])];
  });
}

function baseModule(memory: boolean): WasmModule {
  return {
    types: [],
    imports: [],
    functions: [],
    exports: [],
    tables: [],
    elements: [],
    globals: [],
    tags: [],
    stringPool: [],
    externClasses: [],
    nodeBuiltinModules: new Set(),
    stringLiteralValues: new Map(),
    asyncFunctions: new Set(),
    declaredFuncRefs: [],
    funcOrdinalToPosition: [],
    memories: memory ? [] : [],
    dataSegments: [],
  } as unknown as WasmModule;
}

function internFuncType(wasm: WasmModule, type: FuncTypeDef): number {
  const index = wasm.types.length;
  wasm.types.push({ ...type, name: `$t6920_${index}` });
  return index;
}

function functionIndex(wasm: WasmModule, name: string): number {
  const index = wasm.functions.findIndex((func) => func.name === name);
  if (index < 0) throw new Error(`missing linear runtime function ${name}`);
  return wasm.imports.filter((entry) => entry.desc.kind === "func").length + index;
}

function runtimeOperation(wasm: WasmModule, operation: LinearRuntimeOperation): number {
  if (operation.family === "vector" && operation.operation === "resolve-forwarding")
    return functionIndex(wasm, "__arr_resolve");
  if (operation.family === "vector" && operation.operation === "allocate") return functionIndex(wasm, "__arr_new");
  if (operation.family === "vector" && operation.operation === "initialize-element") {
    return functionIndex(wasm, "__linear_ir_vec_init_f64");
  }
  throw new Error(`unsupported runtime operation ${JSON.stringify(operation)}`);
}

interface RecordingLinearResolver extends IrLowerResolver {
  readonly handles: LinearVecLowering[];
  readonly requestedAllocs: (AllocSiteId | undefined)[];
  readonly typeLookups: IrTypeRef[];
}

/** A genuine linear resolver: real layout/operation descriptors, no GC fields. */
function linearResolver(wasm: WasmModule, plan: LinearMemoryPlan): RecordingLinearResolver {
  const handles: LinearVecLowering[] = [];
  const requestedAllocs: (AllocSiteId | undefined)[] = [];
  const typeLookups: IrTypeRef[] = [];
  const handle = (alloc?: AllocSiteId): LinearVecLowering => {
    const layout = plan.layoutForVector(F64)!;
    let allocation: LinearAllocationSitePlan | undefined;
    if (alloc !== undefined) {
      allocation = plan.allocation(alloc);
      if (!allocation || allocation.layoutId !== layout.id) throw new Error(`no planned row ${alloc as number}`);
    }
    const operations = allocation?.operations ?? defaultOperationsForLayout(layout);
    const find = (op: string) =>
      operations.find((candidate) => candidate.family === "vector" && candidate.operation === op)!;
    const lowering: LinearVecLowering = {
      valueType: { kind: "i32" },
      elementValType: { kind: "f64" },
      linearMemory: { allocation, layout, allocate: find("allocate"), initializeElement: find("initialize-element") },
    };
    handles.push(lowering);
    return lowering;
  };
  return {
    handles,
    requestedAllocs,
    typeLookups,
    resolveFunc: () => {
      throw new Error("no calls");
    },
    resolveGlobal: () => {
      throw new Error("no globals");
    },
    resolveType: (ref: IrTypeRef) => {
      typeLookups.push(ref);
      throw new Error("linear memory has no symbolic GC types");
    },
    internFuncType: (type: FuncTypeDef) => internFuncType(wasm, type),
    resolveVec: (valType: ValType) => (valType.kind === "i32" ? handle() : null),
    resolveVecForElement: (element: ValType, alloc?: AllocSiteId) => {
      if (element.kind !== "f64") return null;
      requestedAllocs.push(alloc);
      return handle(alloc);
    },
  };
}

/** A GC module with registered f64/i32 data arrays and their vec structs. */
function gcModule(): { wasm: WasmModule; f64: IrVecLowering; i32: IrVecLowering } {
  const wasm = baseModule(false);
  const vec = (element: ValType, name: string): IrVecLowering => {
    const arrayTypeIdx = wasm.types.length;
    wasm.types.push({ kind: "array", name: `$arr_${name}`, element, mutable: true });
    const vecStructTypeIdx = wasm.types.length;
    wasm.types.push({
      kind: "struct",
      name: `$vec_${name}`,
      fields: [
        { name: "length", type: { kind: "i32" }, mutable: true },
        { name: "data", type: { kind: "ref", typeIdx: arrayTypeIdx }, mutable: true },
      ],
    });
    return { vecStructTypeIdx, lengthFieldIdx: 0, dataFieldIdx: 1, arrayTypeIdx, elementValType: element };
  };
  return { wasm, f64: vec({ kind: "f64" }, "f64"), i32: vec({ kind: "i32" }, "i32") };
}

function gcResolver(wasm: WasmModule, handles: Record<string, IrVecLowering>): IrLowerResolver {
  return {
    resolveFunc: () => {
      throw new Error("no calls");
    },
    resolveGlobal: () => {
      throw new Error("no globals");
    },
    resolveType: () => {
      throw new Error("layout-free fixture has no symbolic types");
    },
    internFuncType: (type: FuncTypeDef) => internFuncType(wasm, type),
    resolveVec: (valType: ValType) =>
      Object.values(handles).find(
        (handle) =>
          (valType.kind === "ref" || valType.kind === "ref_null") && valType.typeIdx === handle.vecStructTypeIdx,
      ) ?? null,
    resolveVecForElement: (element: ValType) => handles[element.kind] ?? null,
  };
}

function assemble(
  wasm: WasmModule,
  resolver: IrLowerResolver,
  lowered: ReturnType<typeof lowerIrFunctionBody<Instr[], ValType>>,
): WasmFunction {
  const params = lowered.params.flatMap((param) => [...param.slots]);
  const results = lowered.results.flatMap((result) => [...result]);
  return {
    name: lowered.name,
    typeIdx: resolver.internFuncType({ kind: "func", params, results }),
    // Verbatim: every lowered local keeps the type generic lowering declared.
    locals: lowered.locals.flatMap((local) =>
      local.slots.map((type, slot) => ({ name: slot === 0 ? local.name : `${local.name}$${slot}`, type })),
    ),
    body: lowered.body,
    exported: true,
  };
}

async function instantiate(wasm: WasmModule, fn: WasmFunction): Promise<(a: number, b: number, i: number) => number> {
  const index = wasm.imports.filter((entry) => entry.desc.kind === "func").length + wasm.functions.length;
  wasm.functions.push(fn);
  wasm.exports.push({ name: "run", desc: { kind: "func", index } });
  const { instance } = await WebAssembly.instantiate(emitBinary(wasm), {});
  return instance.exports.run as (a: number, b: number, i: number) => number;
}

const CASES: [number, number, number][] = [
  [1.5, -2.25, 0],
  [1.5, -2.25, 1],
  [4, 5, 2],
  [4, 5, 3],
  [4, 5, -1],
];

describe("#6920 vector representation — same intent through both genuine backends", () => {
  it("linear memory: genuine i32 handles, i32 scratch declared before assembly, correct results", async () => {
    const { func, allocations } = vectorIntent();
    expect(verifyIrBackendLegality(func, "linear")).toEqual([]);
    const plan = planLinearMemory({ functions: [func] }, allocations);
    const wasm = baseModule(true);
    addRuntime(wasm);
    addArrayRuntime(wasm);
    addLinearIrVecRuntime(wasm);
    const resolver = linearResolver(wasm, plan);
    const emitter = new LinearEmitter({ resolveRuntimeOperation: (operation) => runtimeOperation(wasm, operation) });
    const lowered = lowerIrFunctionBody(func, resolver, emitter, wasmValueTypeConverter("linear", resolver, func.name));

    // Genuine handles only: an i32 carrier and no WasmGC indices.
    expect(resolver.handles.length).toBeGreaterThan(0);
    for (const handle of resolver.handles) {
      expect(handle.valueType).toEqual({ kind: "i32" });
      for (const gcField of ["vecStructTypeIdx", "arrayTypeIdx", "lengthFieldIdx", "dataFieldIdx"]) {
        expect(gcField in handle, gcField).toBe(false);
      }
    }
    expect(resolver.typeLookups).toEqual([]);

    // Construction requested each literal's own allocation row; the rows are distinct.
    const allocs = vecNewFixedAllocs(func);
    expect(allocs).toHaveLength(2);
    expect(new Set(allocs).size).toBe(2);
    expect(resolver.requestedAllocs.filter((alloc) => alloc !== undefined)).toEqual(allocs);
    const bound = resolver.handles.flatMap((handle) =>
      handle.linearMemory.allocation ? [handle.linearMemory.allocation.id] : [],
    );
    expect(bound).toEqual(allocs);

    // One reused i32 construction scratch (keyed by representation + type, not site).
    const scratch = lowered.locals.filter((local) => local.name.startsWith("$linear_vec_ptr_"));
    expect(scratch).toHaveLength(1);
    expect(scratch[0]!.slots).toEqual([{ kind: "i32" }]);
    // Every lowered slot is a linear scalar; no reference carrier survives.
    const allSlots = [...lowered.params, ...lowered.locals].flatMap((value) => [...value.slots]);
    expect(allSlots.every((slot) => slot.kind === "i32" || slot.kind === "f64" || slot.kind === "i64")).toBe(true);

    const ops = flatOps(lowered.body).map((instr) => instr.op);
    for (const gcOp of ["struct.new", "struct.get", "array.new_fixed", "array.get", "array.set", "ref.as_non_null"]) {
      expect(ops, gcOp).not.toContain(gcOp);
    }
    const arrNew = functionIndex(wasm, "__arr_new");
    const calls = flatOps(lowered.body).filter(
      (instr): instr is Extract<Instr, { op: "call" }> => instr.op === "call" && instr.funcIdx === arrNew,
    );
    expect(calls).toHaveLength(2);
    expect(ops).toContain("f64.load");
    expect(ops).toContain("f64.store");

    const lockedLocals = JSON.stringify(lowered.locals.map((local) => [local.name, local.slots]));
    const run = await instantiate(wasm, assemble(wasm, resolver, lowered));
    // Assembly consumed the locals verbatim — nothing retyped them afterwards.
    expect(JSON.stringify(lowered.locals.map((local) => [local.name, local.slots]))).toBe(lockedLocals);
    for (const [a, b, i] of CASES) expect(run(a, b, i), `run(${a}, ${b}, ${i})`).toBe(oracle(a, b, i));
  });

  it("WasmGC: genuine GC handle, ref_null $array scratch shared by both literals, correct results", async () => {
    const { func } = vectorIntent();
    const { wasm, f64, i32 } = gcModule();
    const resolver = gcResolver(wasm, { f64, i32 });
    const lowered = lowerIrFunctionBody(
      func,
      resolver,
      new WasmGcEmitter(resolver),
      wasmValueTypeConverter("wasmgc", resolver, func.name),
    );
    const scratch = lowered.locals.filter((local) => local.name.startsWith("$vec_data_"));
    expect(scratch.map((local) => [local.name, local.slots])).toEqual([
      [`$vec_data_${f64.arrayTypeIdx}`, [{ kind: "ref_null", typeIdx: f64.arrayTypeIdx }]],
    ]);
    // SSA vector values carry the registered struct ref.
    expect(lowered.locals.some((local) => local.slots[0]!.kind === "ref")).toBe(true);
    const scratchIdx = lowered.params.length + lowered.locals.indexOf(scratch[0]!);
    // The historical GC construction sequence, unchanged.
    const body = flatOps(lowered.body);
    const start = body.findIndex((instr) => instr.op === "array.new_fixed");
    expect(body.slice(start, start + 6)).toEqual([
      { op: "array.new_fixed", typeIdx: f64.arrayTypeIdx, length: 3 },
      { op: "local.set", index: scratchIdx },
      { op: "i32.const", value: 3 },
      { op: "local.get", index: scratchIdx },
      { op: "ref.as_non_null" },
      { op: "struct.new", typeIdx: f64.vecStructTypeIdx },
    ]);
    expect(body.filter((instr) => instr.op === "array.new_fixed")).toHaveLength(2);
    const run = await instantiate(wasm, assemble(wasm, resolver, lowered));
    for (const [a, b, i] of CASES) expect(run(a, b, i), `run(${a}, ${b}, ${i})`).toBe(oracle(a, b, i));
  });

  it("WasmGC: distinct element arrays get distinct scratch; empty reserved capacity keeps array.new_default", () => {
    const fn = new IrFunctionBuilder(identities.next("mixed"), [F64], true);
    const a = fn.addParam("a", F64);
    fn.openBlock();
    const one = fn.emitConst({ kind: "i32", value: 1 }, I32);
    const f = fn.emitVecNewFixed([a, a], F64, VEC_F64);
    const n = fn.emitVecNewFixed([one], I32, VEC_I32);
    const empty = fn.emitVecNewFixed([], F64, VEC_F64, 4);
    const lenF = fn.emitVecLen(f);
    const lenN = fn.emitVecLen(n);
    const lenE = fn.emitVecLen(empty);
    const sum = fn.emitBinary("f64.add", fn.emitBinary("f64.add", lenF, lenN, F64), lenE, F64);
    fn.terminate({ kind: "return", values: [sum] });
    const func = fn.finish();
    const { wasm, f64, i32 } = gcModule();
    const resolver = gcResolver(wasm, { f64, i32 });
    const lowered = lowerIrFunctionBody(
      func,
      resolver,
      new WasmGcEmitter(resolver),
      wasmValueTypeConverter("wasmgc", resolver, func.name),
    );
    expect(
      lowered.locals.filter((local) => local.name.startsWith("$vec_data_")).map((local) => [local.name, local.slots]),
    ).toEqual([
      [`$vec_data_${f64.arrayTypeIdx}`, [{ kind: "ref_null", typeIdx: f64.arrayTypeIdx }]],
      [`$vec_data_${i32.arrayTypeIdx}`, [{ kind: "ref_null", typeIdx: i32.arrayTypeIdx }]],
    ]);
    const body = flatOps(lowered.body);
    const def = body.findIndex((instr) => instr.op === "array.new_default");
    expect(body[def - 1]).toEqual({ op: "i32.const", value: 4 });
    expect(body[def]).toEqual({ op: "array.new_default", typeIdx: f64.arrayTypeIdx });
  });
});

describe("#6920 vector representation — converter coherence", () => {
  it("projects vector parameters and results to each backend's carrier", () => {
    const fn = new IrFunctionBuilder(identities.next("passthrough"), [VEC_F64], true);
    const v = fn.addParam("v", VEC_F64);
    fn.openBlock();
    fn.terminate({ kind: "return", values: [v] });
    const func = fn.finish();
    const { wasm, f64, i32 } = gcModule();
    const gc = gcResolver(wasm, { f64, i32 });
    const gcSignature = projectIrFunctionSignatureWithConverter(
      func,
      gc,
      new WasmGcEmitter(gc),
      wasmValueTypeConverter("wasmgc", gc, func.name),
    );
    expect(gcSignature.params[0]!.slots).toEqual([{ kind: "ref", typeIdx: f64.vecStructTypeIdx }]);
    expect(gcSignature.results[0]).toEqual([{ kind: "ref", typeIdx: f64.vecStructTypeIdx }]);

    const { allocations } = vectorIntent();
    const plan = planLinearMemory({ functions: [vectorIntent().func] }, allocations);
    const linearWasm = baseModule(true);
    const linear = linearResolver(linearWasm, plan);
    const linearSignature = projectIrFunctionSignatureWithConverter(
      func,
      linear,
      new LinearEmitter(),
      wasmValueTypeConverter("linear", linear, func.name),
    );
    expect(linearSignature.params[0]!.slots).toEqual([{ kind: "i32" }]);
    expect(linearSignature.results[0]).toEqual([{ kind: "i32" }]);
    expect(linear.typeLookups).toEqual([]);
  });

  it("lowerIrTypeToValType threads the backend through nested element conversion", () => {
    const { allocations, func } = vectorIntent();
    const plan = planLinearMemory({ functions: [func] }, allocations);
    const linear = linearResolver(baseModule(true), plan);
    expect(lowerIrTypeToValType(VEC_F64, linear, "f", "linear")).toEqual({ kind: "i32" });
    const { wasm, f64, i32 } = gcModule();
    const gc = gcResolver(wasm, { f64, i32 });
    // Historical default stays WasmGC for explicitly GC callers.
    expect(lowerIrTypeToValType(VEC_F64, gc, "f")).toEqual({ kind: "ref", typeIdx: f64.vecStructTypeIdx });
    expect(lowerIrTypeToValType({ ...VEC_F64, nullable: true }, gc, "f")).toEqual({
      kind: "ref_null",
      typeIdx: f64.vecStructTypeIdx,
    });
  });
});

describe("#6920 vector representation — carrier-only vs operation resolution", () => {
  const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "issue-6920.ts" });
  const carrierRef = irSupportTypeRef(sourceId, "vector-carrier:vec<f64>", "__vec_f64");
  const dataRef = irSupportTypeRef(sourceId, "vector-data:vec<f64>", "__arr_f64");
  const layoutVec: IrType = {
    kind: "vec",
    elementType: F64,
    nullable: true,
    layout: { carrierType: carrierRef, dataType: dataRef, lengthFieldIndex: 0, dataFieldIndex: 1 },
  };
  const recording = (): { resolver: IrLowerResolver; lookups: string[] } => {
    const lookups: string[] = [];
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      internFuncType: () => 0,
      resolveType: (ref: IrTypeRef) => {
        lookups.push(ref === carrierRef ? "carrier" : ref === dataRef ? "data" : "other");
        return ref === carrierRef ? 11 : 10;
      },
      resolveVecForElement: () => {
        throw new Error("a prepared layout must not consult the element compatibility route");
      },
    };
    return { resolver, lookups };
  };

  it("carrier resolution performs exactly one carrier lookup and no data-array lookup", () => {
    const { resolver, lookups } = recording();
    expect(lowerIrTypeToValType(layoutVec, resolver, "f")).toEqual({ kind: "ref_null", typeIdx: 11 });
    expect(lookups).toEqual(["carrier"]);
  });

  it("operation resolution preserves the historical carrier, carrier, data order", () => {
    const { resolver, lookups } = recording();
    const representation = resolveIrVecRepresentation(
      { backend: "wasmgc", type: layoutVec, elementValType: { kind: "f64" }, resolver, where: "f" },
      "operation",
    );
    expect(lookups).toEqual(["carrier", "carrier", "data"]);
    expect(representation).toEqual({
      kind: "wasmgc",
      valueType: { kind: "ref_null", typeIdx: 11 },
      dataType: { kind: "ref", typeIdx: 10 },
      newFixedScratchType: { kind: "ref_null", typeIdx: 10 },
      lowering: {
        valueType: { kind: "ref_null", typeIdx: 11 },
        vecStructTypeIdx: 11,
        lengthFieldIdx: 0,
        dataFieldIdx: 1,
        arrayTypeIdx: 10,
        elementValType: { kind: "f64" },
      },
    });
  });
});

describe("#6920 vector representation — mismatches fail at the resolution boundary", () => {
  const plan = (() => {
    const { func, allocations } = vectorIntent();
    return { func, plan: planLinearMemory({ functions: [func] }, allocations) };
  })();
  const genuineLinear = (alloc?: AllocSiteId): LinearVecLowering => {
    const layout = plan.plan.layoutForVector(F64)!;
    const allocation = alloc === undefined ? undefined : plan.plan.allocation(alloc);
    const operations = allocation?.operations ?? defaultOperationsForLayout(layout);
    const find = (op: string) =>
      operations.find((candidate) => candidate.family === "vector" && candidate.operation === op)!;
    return {
      valueType: { kind: "i32" },
      elementValType: { kind: "f64" },
      linearMemory: { allocation, layout, allocate: find("allocate"), initializeElement: find("initialize-element") },
    };
  };
  const gcHandle: IrVecLowering = {
    vecStructTypeIdx: 1,
    lengthFieldIdx: 0,
    dataFieldIdx: 1,
    arrayTypeIdx: 0,
    elementValType: { kind: "f64" },
  };
  const resolverFor = (handle: IrVecBackendLowering | null, lookups: unknown[] = []) => ({
    resolveType: (ref: IrTypeRef) => {
      lookups.push(ref);
      return 0;
    },
    resolveVec: () => handle,
    resolveVecForElement: () => handle,
  });
  const operation = (
    backend: "wasmgc" | "linear" | "porffor",
    handle: IrVecBackendLowering | null,
    type: IrType = VEC_F64,
    alloc?: AllocSiteId,
    lookups: unknown[] = [],
  ) =>
    resolveIrVecRepresentation(
      { backend, type, elementValType: { kind: "f64" }, alloc, resolver: resolverFor(handle, lookups), where: "f" },
      "operation",
    );
  const [firstAlloc, secondAlloc] = vecNewFixedAllocs(plan.func);

  it("positive controls: genuine handles resolve for their own backend", () => {
    const linear = operation("linear", genuineLinear(firstAlloc), VEC_F64, firstAlloc);
    expect(linear).toMatchObject({
      kind: "linear-memory",
      valueType: { kind: "i32" },
      dataType: { kind: "i32" },
      newFixedScratchType: { kind: "i32" },
    });
    expect(operation("porffor", genuineLinear())?.kind).toBe("linear-memory");
    expect(operation("wasmgc", gcHandle)).toMatchObject({
      kind: "wasmgc",
      newFixedScratchType: { kind: "ref_null", typeIdx: 0 },
      dataType: { kind: "ref", typeIdx: 0 },
    });
    // Physical compatibility route: linear recognizes its i32 carrier.
    expect(
      resolveIrVecRepresentation(
        { backend: "linear", type: I32, resolver: resolverFor(genuineLinear()), where: "f" },
        "operation",
      )?.kind,
    ).toBe("linear-memory");
  });

  it("linear rejects a GC handle, an intersection handle and a GC layout before symbolic lookup", () => {
    const lookups: unknown[] = [];
    expect(() => operation("linear", gcHandle, VEC_F64, undefined, lookups)).toThrow(/vec representation mismatch/);
    const intersection = { ...gcHandle, ...genuineLinear() } as IrVecBackendLowering;
    expect(() => operation("linear", intersection)).toThrow(/carries WasmGC field 'vecStructTypeIdx'/);
    const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "issue-6920-mismatch.ts" });
    const layoutVec: IrType = {
      ...VEC_F64,
      layout: {
        carrierType: irSupportTypeRef(sourceId, "vector-carrier", "__c"),
        dataType: irSupportTypeRef(sourceId, "vector-data", "__d"),
        lengthFieldIndex: 0,
        dataFieldIndex: 1,
      },
    } as IrType;
    expect(() => operation("linear", genuineLinear(), layoutVec, undefined, lookups)).toThrow(
      /WasmGC-prepared vector layout/,
    );
    expect(lookups).toEqual([]);
  });

  it("linear rejects each single GC-only field grafted onto the genuine handle", () => {
    // Positive control first: the genuine handle itself is accepted.
    expect(operation("linear", genuineLinear())?.kind).toBe("linear-memory");
    const lengthOnly = { ...genuineLinear(), lengthFieldIdx: 0 } as unknown as IrVecBackendLowering;
    expect(() => operation("linear", lengthOnly)).toThrow(/carries WasmGC field 'lengthFieldIdx'/);
    const dataOnly = { ...genuineLinear(), dataFieldIdx: 1 } as unknown as IrVecBackendLowering;
    expect(() => operation("linear", dataOnly)).toThrow(/carries WasmGC field 'dataFieldIdx'/);
    const structOnly = { ...genuineLinear(), vecStructTypeIdx: 0 } as unknown as IrVecBackendLowering;
    expect(() => operation("linear", structOnly)).toThrow(/carries WasmGC field 'vecStructTypeIdx'/);
    const arrayOnly = { ...genuineLinear(), arrayTypeIdx: 0 } as unknown as IrVecBackendLowering;
    expect(() => operation("linear", arrayOnly)).toThrow(/carries WasmGC field 'arrayTypeIdx'/);
  });

  it("WasmGC rejects a linear handle", () => {
    expect(() => operation("wasmgc", genuineLinear())).toThrow(/wasmgc backend received a non-WasmGC vector handle/);
  });

  it("linear rejects a wrong carrier, element, layout geometry and allocation row", () => {
    const wrongCarrier = { ...genuineLinear(), valueType: { kind: "f64" } } as unknown as LinearVecLowering;
    expect(() => operation("linear", wrongCarrier)).toThrow(/no i32 carrier/);
    const wrongElement = { ...genuineLinear(), elementValType: { kind: "i32" } } as LinearVecLowering;
    expect(() => operation("linear", wrongElement)).toThrow(/does not match f64/);
    const real = genuineLinear();
    const wrongStorage = {
      ...real,
      linearMemory: { ...real.linearMemory, layout: { ...real.linearMemory.layout, elementStorage: "i32" } },
    } as LinearVecLowering;
    expect(() => operation("linear", wrongStorage)).toThrow(/layout stores i32/);
    expect(firstAlloc).not.toBe(secondAlloc);
    expect(() => operation("linear", genuineLinear(firstAlloc), VEC_F64, secondAlloc)).toThrow(
      /was bound for requested site/,
    );
    expect(() =>
      resolveIrVecRepresentation(
        { backend: "linear", type: F64, resolver: resolverFor(genuineLinear()), where: "f" },
        "operation",
      ),
    ).toThrow(/carried by f64/);
  });

  it("missing capability stays an unsupported (null) result for the caller's established failure", () => {
    expect(operation("linear", null)).toBeNull();
    expect(operation("wasmgc", null)).toBeNull();
    expect(operation("bytecode" as "linear", genuineLinear())).toBeNull();
  });

  it("generic lowering fails before emitting any vector primitive on a mismatched handle", () => {
    const { func } = vectorIntent();
    const emitted: string[] = [];
    const emitter = new LinearEmitter({
      resolveRuntimeOperation: () => {
        emitted.push("runtime");
        return 0;
      },
    });
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      resolveType: () => {
        emitted.push("resolveType");
        return 0;
      },
      internFuncType: () => 0,
      resolveVec: () => gcHandle,
      resolveVecForElement: () => gcHandle,
    };
    expect(() =>
      lowerIrFunctionBody(func, resolver, emitter, wasmValueTypeConverter("linear", resolver, func.name)),
    ).toThrow(/vec representation mismatch/);
    expect(emitted).toEqual([]);
  });
});

describe("#6920 vector representation — outer preflight precedes element conversion", () => {
  const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "issue-6920-preflight.ts" });
  const supportElement = irSupportRef(irSupportTypeRef(sourceId, "vector-element", "__elem"), false);
  // Linear vec whose OUTER IrType carries a GC layout and whose element is a
  // ref-typed support type: converting the element first would call resolveType.
  const gcLayoutVec: IrType = {
    kind: "vec",
    elementType: supportElement,
    nullable: false,
    layout: {
      carrierType: irSupportTypeRef(sourceId, "vector-carrier", "__c"),
      dataType: irSupportTypeRef(sourceId, "vector-data", "__d"),
      lengthFieldIndex: 0,
      dataFieldIndex: 1,
    },
  };
  const counting = (): { resolver: IrLowerResolver; calls: string[] } => {
    const calls: string[] = [];
    const fail = (name: string) => (): never => {
      calls.push(name);
      throw new Error(`unexpected ${name}`);
    };
    return {
      calls,
      resolver: {
        resolveFunc: fail("resolveFunc"),
        resolveGlobal: fail("resolveGlobal"),
        internFuncType: fail("internFuncType"),
        resolveType: fail("resolveType"),
        resolveVec: fail("resolveVec"),
        resolveVecForElement: fail("resolveVecForElement"),
      },
    };
  };

  it("public converter: lowerIrTypeToValType / wasmValueTypeConverter reject with zero resolver calls", () => {
    const direct = counting();
    expect(() => lowerIrTypeToValType(gcLayoutVec, direct.resolver, "f", "linear")).toThrow(
      /linear backend received a WasmGC-prepared vector layout/,
    );
    expect(direct.calls).toEqual([]);
    const converter = counting();
    expect(() => wasmValueTypeConverter("linear", converter.resolver, "f").convertType(gcLayoutVec)).toThrow(
      /linear backend received a WasmGC-prepared vector layout/,
    );
    expect(converter.calls).toEqual([]);
    const porffor = counting();
    expect(() => lowerIrTypeToValType(gcLayoutVec, porffor.resolver, "f", "porffor")).toThrow(
      /porffor backend received a WasmGC-prepared vector layout/,
    );
    expect(porffor.calls).toEqual([]);
  });

  const opaqueConverter = {
    backend: "linear" as const,
    // Carries a vec as an opaque i32 so parameter projection performs no vector
    // resolution; only the body's `vec.len` reaches `resolveVecType`.
    convertType: (type: IrType): readonly ValType[] =>
      type.kind === "vec" ? [{ kind: "i32" }] : [(type as { val: ValType }).val],
  };
  const vecLenOf = (name: string, paramType: IrType): IrFunction => {
    const fn = new IrFunctionBuilder(identities.next(name), [F64], true);
    const v = fn.addParam("v", paramType);
    fn.openBlock();
    const length = fn.emitVecLen(v);
    fn.terminate({ kind: "return", values: [length] });
    return fn.finish();
  };

  it("generic body route: an f64 vec with an outer GC layout is rejected by the shared preflight, zero calls", () => {
    const f64LayoutVec: IrType = { ...gcLayoutVec, elementType: F64 } as IrType;
    const func = vecLenOf("preflightF64", f64LayoutVec);
    // Backend legality admits f64 vec elements, so lowering reaches resolveVecType.
    expect(verifyIrBackendLegality(func, "linear")).toEqual([]);
    const { resolver, calls } = counting();
    expect(() => lowerIrFunctionBody(func, resolver, new LinearEmitter(), opaqueConverter)).toThrow(
      /linear backend received a WasmGC-prepared vector layout/,
    );
    expect(calls).toEqual([]);
  });

  it("generic body route: the support-ref-element GC-layout vec never reaches a resolver call", () => {
    // Linear legality rejects non-f64 vec elements before lowering starts, so the
    // body route cannot even reach element conversion; the zero-call record is
    // the observable guarantee on this route.
    const func = vecLenOf("preflightSupport", gcLayoutVec);
    const { resolver, calls } = counting();
    expect(() => lowerIrFunctionBody(func, resolver, new LinearEmitter(), opaqueConverter)).toThrow(
      /linear backend (legality failed|received a WasmGC-prepared vector layout)/,
    );
    expect(calls).toEqual([]);
  });

  it("GC positives keep the carrier-only and operation lookup order", () => {
    const sourceRef = createIrSourceId({ kind: "entry", order: 0, sourceKey: "issue-6920-gc-order.ts" });
    const carrierRef = irSupportTypeRef(sourceRef, "vector-carrier:vec<f64>", "__vec_f64");
    const dataRef = irSupportTypeRef(sourceRef, "vector-data:vec<f64>", "__arr_f64");
    const layoutF64: IrType = {
      kind: "vec",
      elementType: F64,
      nullable: false,
      layout: { carrierType: carrierRef, dataType: dataRef, lengthFieldIndex: 0, dataFieldIndex: 1 },
    };
    const lookups: string[] = [];
    const resolver: IrLowerResolver = {
      resolveFunc: () => 0,
      resolveGlobal: () => 0,
      internFuncType: () => 0,
      resolveType: (ref: IrTypeRef) => {
        lookups.push(ref === carrierRef ? "carrier" : ref === dataRef ? "data" : "other");
        return ref === carrierRef ? 7 : 6;
      },
    };
    expect(wasmValueTypeConverter("wasmgc", resolver, "f").convertType(layoutF64)).toEqual([
      { kind: "ref", typeIdx: 7 },
    ]);
    expect(lookups).toEqual(["carrier"]);
    lookups.length = 0;
    expect(
      resolveIrVecRepresentation(
        { backend: "wasmgc", type: layoutF64, elementValType: { kind: "f64" }, resolver, where: "f" },
        "operation",
      )?.kind,
    ).toBe("wasmgc");
    expect(lookups).toEqual(["carrier", "carrier", "data"]);
  });
});
