// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { compile } from "../src/index.js";
import { emitBinary } from "../src/emit/binary.js";
import { getLastLinearIrReport } from "../src/ir/backend/linear-integration.js";
import { LinearEmitter } from "../src/ir/backend/linear-emitter.js";
import { WasmGcEmitter } from "../src/ir/backend/wasmgc-emitter.js";
import { irImportGlobalRef } from "../src/ir/abi-bindings.js";
import { AllocSiteRegistry } from "../src/ir/alloc-registry.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { irImportFuncRef, irUnitFuncRef } from "../src/ir/callable-bindings.js";
import {
  consumeFrozenIrBodyBatch,
  createFrozenIrBackendSession,
  type FrozenIrBackendFunctionPlan,
  type FrozenIrBackendFunctionSignature,
} from "../src/ir/backend/frozen-body-consumer.js";
import { wasmValueTypeConverter } from "../src/ir/lower.js";
import type { TypeConverter } from "../src/ir/backend/contract.js";
import {
  FrozenIrBodyBatchInvariantError,
  prepareLinearIrBodyBatch,
  type FrozenIrBodyBatch,
} from "../src/ir/frozen-body-batch.js";
import type { IrLowerResolver } from "../src/ir/lower.js";
import type { IrUnitId } from "../src/ir/identity.js";
import { irBindingKey } from "../src/ir/declared-types.js";
import { createEmptyModule, type Instr, type ValType, type WasmModule } from "../src/ir/types.js";
import {
  asAllocSiteId,
  irVal,
  mapNestedBuffers,
  IR_CLASS_SHAPE_CELL,
  type IrClassShape,
  type IrFuncRef,
  type IrType,
} from "../src/ir/nodes.js";
import { prepareLinearAllocationFacts } from "../src/ir/analysis/linear-memory-plan.js";
import { createTestIrClassId, createTestIrFunctionIdentityFactory } from "./helpers/ir-identities.js";

function scalarResolver(): IrLowerResolver {
  return {
    resolveFunc: () => 0,
    resolveGlobal: () => 0,
    resolveType: () => 0,
    internFuncType: () => 0,
  };
}

function moduleResolver(batch: FrozenIrBodyBatch): IrLowerResolver {
  const indices = new Map(batch.module.functions.map((fn, index) => [fn.unitId, index] as const));
  return {
    resolveFunc: (ref: IrFuncRef) => {
      if (ref.binding.kind !== "unit") return 0;
      const index = indices.get(ref.binding.unitId);
      if (index === undefined) throw new Error(`test resolver has no owner ${ref.binding.unitId}`);
      return index;
    },
    resolveGlobal: () => 0,
    resolveType: () => 0,
    internFuncType: () => 0,
  };
}

function physicalSignature(
  fn: FrozenIrBodyBatch["module"]["functions"][number],
  converter: TypeConverter<ValType>,
): FrozenIrBackendFunctionSignature<ValType> {
  return {
    params: fn.params.map((param) => converter.convertType(param.type)),
    results: fn.resultTypes.map((result) => converter.convertType(result)),
  };
}

function assembleConsumedBodies(
  batch: FrozenIrBodyBatch,
  outputs: readonly {
    readonly lowered: {
      readonly name: string;
      readonly body: Instr[];
      readonly params: readonly { readonly slots: readonly ValType[] }[];
      readonly locals: readonly { readonly name: string; readonly slots: readonly ValType[] }[];
      readonly results: readonly (readonly ValType[])[];
      readonly exported: boolean;
    };
  }[],
): WasmModule {
  const module = createEmptyModule();
  for (const [index, output] of outputs.entries()) {
    const body = output.lowered;
    module.types.push({
      kind: "func",
      name: `r8-body-${index}`,
      params: body.params.flatMap((param) => [...param.slots]),
      results: body.results.flatMap((result) => [...result]),
    });
    module.functions.push({
      name: body.name,
      typeIdx: index,
      locals: body.locals.flatMap((local) =>
        local.slots.map((type, slot) => ({ name: slot === 0 ? local.name : `${local.name}$${slot}`, type })),
      ),
      body: body.body,
      exported: body.exported,
    });
  }
  for (const [index, fn] of batch.module.functions.entries()) {
    if (fn.exported) module.exports.push({ name: fn.name, desc: { kind: "func", index } });
  }
  return module;
}

function assembleOrderedBody(output: {
  readonly lowered: {
    readonly name: string;
    readonly body: Instr[];
    readonly params: readonly { readonly slots: readonly ValType[] }[];
    readonly locals: readonly { readonly name: string; readonly slots: readonly ValType[] }[];
    readonly results: readonly (readonly ValType[])[];
    readonly exported: boolean;
  };
}): WasmModule {
  const module = createEmptyModule();
  module.types.push({ kind: "func", name: "trace", params: [{ kind: "f64" }], results: [{ kind: "f64" }] });
  module.imports.push({ module: "env", name: "trace", desc: { kind: "func", typeIdx: 0 } });
  const body = output.lowered;
  module.types.push({
    kind: "func",
    name: body.name,
    params: body.params.flatMap((param) => [...param.slots]),
    results: body.results.flatMap((result) => [...result]),
  });
  module.functions.push({
    name: body.name,
    typeIdx: 1,
    locals: body.locals.flatMap((local) =>
      local.slots.map((type, slot) => ({ name: slot === 0 ? local.name : `${local.name}$${slot}`, type })),
    ),
    body: body.body,
    exported: body.exported,
  });
  module.exports.push({ name: body.name, desc: { kind: "func", index: 1 } });
  return module;
}

async function productionOrderedBatch(): Promise<FrozenIrBodyBatch> {
  const f64 = irVal({ kind: "f64" });
  const registry = new AllocSiteRegistry();
  const identities = createTestIrFunctionIdentityFactory("r8-order");
  const identity = identities.next("ordered");
  const builder = new IrFunctionBuilder(identity, [f64], true, registry);
  builder.openBlock();
  const firstInput = builder.emitConst({ kind: "f64", value: 1 }, f64);
  const secondInput = builder.emitConst({ kind: "f64", value: 2 }, f64);
  const first = builder.emitCall(irImportFuncRef("env", "trace"), [firstInput], f64)!;
  const second = builder.emitCall(irImportFuncRef("env", "trace"), [secondInput], f64)!;
  const ten = builder.emitConst({ kind: "f64", value: 10 }, f64);
  const product = builder.emitBinary("f64.mul", first, ten, f64);
  const total = builder.emitBinary("f64.add", product, second, f64);
  builder.terminate({ kind: "return", values: [total] });
  const fn = builder.finish();
  const module = { functions: [fn] };
  const allocationFacts = prepareLinearAllocationFacts(module, registry);
  return prepareLinearIrBodyBatch({
    module,
    owners: [
      {
        ownerUnitId: fn.unitId,
        sourceId: identities.sourceId,
        sourceKey: "@test/r8-order",
        legacyName: fn.name,
        terminalKind: "synthetic-support",
        observedKind: "function",
        outcome: "built",
      },
    ],
    allocationFacts,
    producer: {
      backend: "linear",
      policy: "arena-v1",
      source: { sourceId: identities.sourceId, sourceKey: "@test/r8-order", fileName: "r8-order.ts" },
      version: "l0-p1-v1",
      representation: "linear-ir",
      boundaries: [],
    },
  });
}

function recursiveShapeBatch(): FrozenIrBodyBatch {
  const identities = createTestIrFunctionIdentityFactory("r8-recursive");
  const classId = createTestIrClassId("r8-recursive");
  const shape = {
    [IR_CLASS_SHAPE_CELL]: true as const,
    classId,
    className: "Recursive",
    fields: [] as { readonly name: string; readonly type: IrType }[],
    methods: [],
    constructorParams: [],
  } as unknown as IrClassShape;
  const recursiveType: IrType = { kind: "class", shape };
  const recursiveFieldType: IrType = { kind: "class", shape };
  (shape as { fields: readonly { readonly name: string; readonly type: IrType }[] }).fields = [
    { name: "next", type: recursiveFieldType },
  ];
  const builder = new IrFunctionBuilder(identities.next("recursive"), [recursiveType], true);
  const parameter = builder.addParam("value", recursiveType);
  builder.openBlock();
  builder.terminate({ kind: "return", values: [parameter] });
  const fn = builder.finish();
  const module = { functions: [fn] };
  return prepareLinearIrBodyBatch({
    module,
    owners: [
      {
        ownerUnitId: fn.unitId,
        sourceId: identities.sourceId,
        sourceKey: "@test/r8-recursive",
        legacyName: fn.name,
        terminalKind: "synthetic-support",
        observedKind: "function",
        outcome: "built",
      },
    ],
    allocationFacts: prepareLinearAllocationFacts(module, new AllocSiteRegistry()),
    producer: {
      backend: "linear",
      policy: "arena-v1",
      source: { sourceId: identities.sourceId, sourceKey: "@test/r8-recursive", fileName: "r8-recursive.ts" },
      version: "l0-p1-v1",
      representation: "linear-ir",
      boundaries: [],
    },
  });
}

async function productionBatch(): Promise<{ readonly batch: FrozenIrBodyBatch; readonly value: number }> {
  const result = await compile(`export function add(left: number, right: number): number { return left + right; }`, {
    target: "linear",
    fileName: "r8-frozen-body.ts",
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  const value = (instance.exports as { readonly add: (left: number, right: number) => number }).add(20, 22);
  const batch = getLastLinearIrReport()?.frozenBodyBatch;
  expect(batch).toBeDefined();
  return { batch: batch!, value };
}

async function productionProviderBatch(): Promise<{ readonly batch: FrozenIrBodyBatch; readonly value: number }> {
  const result = await compile(`export function absolute(value: number): number { return Math.abs(value); }`, {
    target: "linear",
    fileName: "r8-frozen-provider.ts",
  });
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  const value = (instance.exports as { readonly absolute: (value: number) => number }).absolute(-9);
  const batch = getLastLinearIrReport()?.frozenBodyBatch;
  expect(batch).toBeDefined();
  expect(batch?.runtime.providers.has("math.abs")).toBe(true);
  return { batch: batch!, value };
}

function replaceIntrinsicProvider(
  fn: FrozenIrBodyBatch["module"]["functions"][number],
  id: string,
  provider: NonNullable<Extract<IrInstr, { kind: "intrinsic" }>["provider"]>,
): FrozenIrBodyBatch["module"]["functions"][number] {
  const mapInstr = (instr: IrInstr): IrInstr => {
    const nested = mapNestedBuffers(instr, (buffer) => buffer.map(mapInstr));
    if (nested.kind === "intrinsic" && nested.id === id) return { ...nested, provider };
    return nested;
  };
  return {
    ...fn,
    blocks: fn.blocks.map((block) => ({ ...block, instrs: block.instrs.map(mapInstr) })),
  };
}

async function productionAllocationBatch(): Promise<FrozenIrBodyBatch> {
  const result = await compile(
    `export function first(input: number): number { const values = [input, 2]; return values[0]; }`,
    { target: "linear", fileName: "r8-frozen-allocation.ts" },
  );
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  const batch = getLastLinearIrReport()?.frozenBodyBatch;
  expect(batch?.allocationFacts.allocations.length).toBeGreaterThan(0);
  return batch!;
}

function declaredReferenceInput(withUnexpectedArgument: boolean, withContradictoryDeclaration = false) {
  const f64 = irVal({ kind: "f64" });
  const registry = new AllocSiteRegistry();
  const identities = createTestIrFunctionIdentityFactory("r8-declarations");
  const targetIdentity = identities.next("zero");
  const targetBuilder = new IrFunctionBuilder(targetIdentity, [f64], true, registry);
  targetBuilder.openBlock();
  const targetValue = targetBuilder.emitConst({ kind: "f64", value: 0 }, f64);
  targetBuilder.terminate({ kind: "return", values: [targetValue] });
  const target = targetBuilder.finish();

  const callerIdentity = identities.next("caller");
  const callerBuilder = new IrFunctionBuilder(callerIdentity, [f64], true, registry);
  const argument = callerBuilder.addParam("argument", f64);
  callerBuilder.openBlock();
  const call = callerBuilder.emitCall(irUnitFuncRef(targetIdentity), withUnexpectedArgument ? [argument] : [], f64)!;
  callerBuilder.terminate({ kind: "return", values: [call] });
  const caller = callerBuilder.finish();
  const module = {
    functions: [target, caller],
    ...(withContradictoryDeclaration
      ? {
          declaredSignatures: new Map([[`unit:${target.unitId}`, { params: [f64], result: f64 }]]),
        }
      : {}),
  };
  return {
    module,
    owners: [target, caller].map((fn) => ({
      ownerUnitId: fn.unitId,
      sourceId: identities.sourceId,
      sourceKey: "@test/r8-declarations",
      legacyName: fn.name,
      terminalKind: "synthetic-support",
      observedKind: "function",
      outcome: "built" as const,
    })),
    allocationFacts: prepareLinearAllocationFacts(module, registry),
    producer: {
      backend: "linear" as const,
      policy: "arena-v1",
      source: { sourceId: identities.sourceId, sourceKey: "@test/r8-declarations", fileName: "r8-declarations.ts" },
      version: "l0-p1-v1" as const,
      representation: "linear-ir" as const,
      boundaries: [],
    },
  };
}

function declaredGlobalInput() {
  const f64 = irVal({ kind: "f64" });
  const i32 = irVal({ kind: "i32" });
  const registry = new AllocSiteRegistry();
  const identities = createTestIrFunctionIdentityFactory("r8-global-declarations");
  const global = irImportGlobalRef(identities.sourceId, "env", "value", "value");
  const builder = new IrFunctionBuilder(identities.next("read"), [f64], true, registry);
  builder.openBlock();
  const value = builder.emitGlobalGet(global, f64);
  builder.terminate({ kind: "return", values: [value] });
  const fn = builder.finish();
  const module = {
    functions: [fn],
    declaredGlobals: new Map([[irBindingKey(global.binding)!, i32]]),
  };
  return {
    module,
    owners: [
      {
        ownerUnitId: fn.unitId,
        sourceId: identities.sourceId,
        sourceKey: "@test/r8-global-declarations",
        legacyName: fn.name,
        terminalKind: "synthetic-support",
        observedKind: "function",
        outcome: "built" as const,
      },
    ],
    allocationFacts: prepareLinearAllocationFacts(module, registry),
    producer: {
      backend: "linear" as const,
      policy: "arena-v1",
      source: {
        sourceId: identities.sourceId,
        sourceKey: "@test/r8-global-declarations",
        fileName: "r8-global-declarations.ts",
      },
      version: "l0-p1-v1" as const,
      representation: "linear-ir" as const,
      boundaries: [],
    },
  };
}

async function productionGraphBatch(): Promise<{
  readonly batch: FrozenIrBodyBatch;
  readonly values: readonly number[];
}> {
  const result = await compile(
    `
      function step(value: number): number { return Math.imul(value, 3); }
      export function test(input: number): number {
        let current = step(input);
        let i = 0;
        while (i < 3) { current = current + 1; i = i + 1; }
        if (current < 0) return current - 1;
        return current + 1;
      }
    `,
    { target: "linear", fileName: "r8-frozen-graph.ts" },
  );
  expect(result.success, result.success ? "" : result.errors.map((error) => error.message).join("; ")).toBe(true);
  const { instance } = await WebAssembly.instantiate(result.binary);
  const test = (instance.exports as { readonly test: (input: number) => number }).test;
  const values = [-2, 0, 2_147_483_647].map((input) => test(input));
  const batch = getLastLinearIrReport()?.frozenBodyBatch;
  expect(batch?.module.functions.length).toBe(2);
  expect(batch?.runtime.manifest?.features).toContain("math.imul");
  return { batch: batch!, values };
}

describe("#3528 L0-P1 frozen executable body handoff", () => {
  it("captures one production batch and routes the same object through linear and WasmGC consumers", async () => {
    const { batch, value } = await productionBatch();
    expect(value).toBe(42);
    expect(batch.schema).toBe("frozen-ir-body-batch-v1");
    expect(batch.module.functions).toHaveLength(1);
    expect(batch.functions).toBe(batch.module.functions);
    expect(batch.owners.filter((owner) => owner.outcome === "built")).toHaveLength(1);
    expect(batch.effects.some((fact) => fact.kind === "binary")).toBe(true);
    expect(batch.producer).toMatchObject({ backend: "linear", version: "l0-p1-v1", representation: "linear-ir" });
    const capturedDigest = batch.digest;
    expect(Object.isFrozen(batch)).toBe(true);
    expect(Object.isFrozen(batch.module)).toBe(true);
    expect(Object.isFrozen(batch.module.functions)).toBe(true);

    const resolver = scalarResolver();
    const ownerIds = batch.module.functions.map((fn) => fn.unitId);
    const linearPlans = new Map<IrUnitId, FrozenIrBackendFunctionPlan<Instr[], ValType>>();
    const gcPlans = new Map<IrUnitId, FrozenIrBackendFunctionPlan<Instr[], ValType>>();
    for (const fn of batch.module.functions) {
      const linearTypeConverter = wasmValueTypeConverter("linear", resolver, fn.name);
      const gcTypeConverter = wasmValueTypeConverter("wasmgc", resolver, fn.name);
      linearPlans.set(fn.unitId, {
        resolver,
        emitter: new LinearEmitter(),
        typeConverter: linearTypeConverter,
        signature: physicalSignature(fn, linearTypeConverter),
      });
      gcPlans.set(fn.unitId, {
        resolver,
        emitter: new WasmGcEmitter(),
        typeConverter: gcTypeConverter,
        signature: physicalSignature(fn, gcTypeConverter),
      });
    }
    const linearSession = createFrozenIrBackendSession(batch, "linear", { ownerIds });
    const gcSession = createFrozenIrBackendSession(batch, "wasmgc", { ownerIds });
    const linear = consumeFrozenIrBodyBatch({ batch, session: linearSession, backend: "linear", plans: linearPlans });
    const gc = consumeFrozenIrBodyBatch({ batch, session: gcSession, backend: "wasmgc", plans: gcPlans });
    expect(linear[0]!.func).toBe(batch.module.functions[0]);
    expect(gc[0]!.func).toBe(batch.module.functions[0]);
    expect(linear[0]!.lowered.body).toEqual(gc[0]!.lowered.body);
    expect(linear[0]!.emitter).not.toBe(gc[0]!.emitter);
    expect(batch.digest).toBe(capturedDigest);
    const recaptured = prepareLinearIrBodyBatch({
      module: batch.module,
      owners: batch.owners,
      allocationFacts: batch.allocationFacts,
      runtime: batch.runtime,
      countedStringReceipts: batch.countedStringReceipts,
      producer: batch.producer,
    });
    expect(recaptured.digest).toBe(capturedDigest);
  });

  it("authenticates the exact selected provider implementation and attachment", async () => {
    const { batch, value } = await productionProviderBatch();
    expect(value).toBe(9);
    const provider = batch.runtime.providers.get("math.abs");
    expect(provider?.implementation).toEqual({ kind: "backend-op", opcode: "f64.abs" });
    expect(batch.runtime.manifest?.intrinsicUses.filter((use) => use.id === "math.abs")).toHaveLength(1);

    const fn = batch.module.functions.find((candidate) => candidate.name === "absolute");
    expect(fn).toBeDefined();
    const corrupted = replaceIntrinsicProvider(fn!, "math.abs", { kind: "backend-op", opcode: "f64.neg" as never });
    expect(() =>
      prepareLinearIrBodyBatch({
        module: { ...batch.module, functions: [corrupted] },
        owners: batch.owners,
        allocationFacts: batch.allocationFacts,
        runtime: batch.runtime,
        countedStringReceipts: batch.countedStringReceipts,
        producer: batch.producer,
      }),
    ).toThrow(/attachment outside its selected runtime provider/);

    expect(() =>
      prepareLinearIrBodyBatch({
        module: batch.module,
        owners: batch.owners,
        allocationFacts: batch.allocationFacts,
        runtime: { providers: batch.runtime.providers },
        countedStringReceipts: batch.countedStringReceipts,
        producer: batch.producer,
      }),
    ).toThrow(/provider demand has no frozen runtime manifest/);
  });

  it("preserves ordered imported-call evaluation through both consumers", async () => {
    const batch = await productionOrderedBatch();
    const fn = batch.module.functions[0]!;
    const linearResolver = moduleResolver(batch);
    const gcResolver = moduleResolver(batch);
    const linearPlans = new Map<IrUnitId, FrozenIrBackendFunctionPlan<Instr[], ValType>>([
      [
        fn.unitId,
        {
          resolver: linearResolver,
          emitter: new LinearEmitter(),
          typeConverter: wasmValueTypeConverter("linear", linearResolver, fn.name),
          signature: physicalSignature(fn, wasmValueTypeConverter("linear", linearResolver, fn.name)),
        },
      ],
    ]);
    const gcPlans = new Map<IrUnitId, FrozenIrBackendFunctionPlan<Instr[], ValType>>([
      [
        fn.unitId,
        {
          resolver: gcResolver,
          emitter: new WasmGcEmitter(),
          typeConverter: wasmValueTypeConverter("wasmgc", gcResolver, fn.name),
          signature: physicalSignature(fn, wasmValueTypeConverter("wasmgc", gcResolver, fn.name)),
        },
      ],
    ]);
    const linear = consumeFrozenIrBodyBatch({
      batch,
      session: createFrozenIrBackendSession(batch, "linear"),
      backend: "linear",
      plans: linearPlans,
    });
    const gc = consumeFrozenIrBodyBatch({
      batch,
      session: createFrozenIrBackendSession(batch, "wasmgc"),
      backend: "wasmgc",
      plans: gcPlans,
    });
    const run = async (module: WasmModule): Promise<{ readonly value: number; readonly events: readonly number[] }> => {
      const events: number[] = [];
      const { instance } = await WebAssembly.instantiate(emitBinary(module), {
        env: {
          trace: (value: number) => {
            events.push(value);
            return value;
          },
        },
      });
      const value = (instance.exports as { readonly ordered: () => number }).ordered();
      return { value, events };
    };
    const linearRun = await run(assembleOrderedBody(linear[0]!));
    const gcRun = await run(assembleOrderedBody(gc[0]!));
    expect(linearRun).toEqual({ value: 12, events: [1, 2] });
    expect(gcRun).toEqual({ value: 12, events: [1, 2] });
  });

  it("owns nested values and rejects foreign, missing, and extra backend plans", async () => {
    const { batch } = await productionBatch();
    const fn = batch.module.functions[0]!;
    const resolver = scalarResolver();
    const typeConverter = wasmValueTypeConverter("linear", resolver, fn.name);
    const plan: FrozenIrBackendFunctionPlan<Instr[], ValType> = {
      resolver,
      emitter: new LinearEmitter(),
      typeConverter,
      signature: physicalSignature(fn, typeConverter),
    };
    const session = createFrozenIrBackendSession(batch, "linear");
    const plans = new Map([[fn.unitId, plan]]);
    expect(() => consumeFrozenIrBodyBatch({ batch, session, backend: "linear", plans: new Map() })).toThrow(
      FrozenIrBodyBatchInvariantError,
    );
    const extra = "foreign-owner" as IrUnitId;
    const extraPlans = new Map(plans);
    extraPlans.set(extra, plan);
    expect(() => consumeFrozenIrBodyBatch({ batch, session, backend: "linear", plans: extraPlans })).toThrow(
      FrozenIrBodyBatchInvariantError,
    );
    expect(() => createFrozenIrBackendSession({ ...batch } as FrozenIrBodyBatch, "linear")).toThrow(
      FrozenIrBodyBatchInvariantError,
    );

    const instruction = fn.blocks[0]!.instrs[0];
    expect(instruction).toBeDefined();
    expect(() => {
      (instruction as { result?: number }).result = 999;
    }).toThrow();
    expect((fn.blocks[0]!.instrs[0] as { result?: number }).result).not.toBe(999);

    const invalidFn = {
      ...fn,
      blocks: fn.blocks.map((block, blockIndex) =>
        blockIndex === 0
          ? {
              ...block,
              instrs: block.instrs.map((entry, instrIndex) =>
                instrIndex === 0 ? ({ ...entry, result: 999 } as typeof entry) : entry,
              ),
            }
          : block,
      ),
    };
    expect(() =>
      prepareLinearIrBodyBatch({
        module: { ...batch.module, functions: [invalidFn] },
        owners: batch.owners,
        allocationFacts: batch.allocationFacts,
        runtime: batch.runtime,
        countedStringReceipts: batch.countedStringReceipts,
        producer: batch.producer,
      }),
    ).toThrow(FrozenIrBodyBatchInvariantError);
  });

  it("keeps an explicitly branded recursive shape and stable shared-type digest", () => {
    const batch = recursiveShapeBatch();
    const fn = batch.module.functions[0]!;
    expect(fn.params[0]!.type.kind).toBe("class");
    const classType = fn.params[0]!.type;
    expect(classType.kind).toBe("class");
    expect(classType.shape.fields[0]!.type).toBeDefined();
    expect(classType.shape.fields[0]!.type).not.toBe(classType);
    expect(classType.shape.fields[0]!.type.kind).toBe("class");
    expect(classType.shape.fields[0]!.type.shape).toBe(classType.shape);
    const recaptured = prepareLinearIrBodyBatch({
      module: batch.module,
      owners: batch.owners,
      allocationFacts: batch.allocationFacts,
      runtime: batch.runtime,
      countedStringReceipts: batch.countedStringReceipts,
      producer: batch.producer,
    });
    expect(recaptured.digest).toBe(batch.digest);
  });

  it("checks derived and supplied declared callable signatures before capture", () => {
    const valid = prepareLinearIrBodyBatch(declaredReferenceInput(false));
    expect(valid.module.functions).toHaveLength(2);
    expect(() => prepareLinearIrBodyBatch(declaredReferenceInput(true))).toThrow(
      /passes 1 argument\(s\) but the module declares 0 parameter\(s\)/,
    );
    expect(() => prepareLinearIrBodyBatch(declaredReferenceInput(false, true))).toThrow(
      /passes 0 argument\(s\) but the module declares 1 parameter\(s\)/,
    );
  });

  it("checks supplied declared global carriers before capture", () => {
    expect(() => prepareLinearIrBodyBatch(declaredGlobalInput())).toThrow(
      /global\.get value carrier f64 contradicts the module-declared i32/,
    );
  });

  it("authenticates allocation body joins and preserves unknown, retired, cyclic, and absent evidence", async () => {
    const batch = await productionAllocationBatch();
    const originalFacts = batch.allocationFacts;
    const first = originalFacts.allocations[0]!;
    const baseInput = (allocationFacts: typeof originalFacts) => ({
      module: batch.module,
      owners: batch.owners,
      allocationFacts,
      runtime: batch.runtime,
      countedStringReceipts: batch.countedStringReceipts,
      producer: batch.producer,
    });
    const expectRejected = (allocationFacts: typeof originalFacts) => {
      expect(() => prepareLinearIrBodyBatch(baseInput(allocationFacts))).toThrow(FrozenIrBodyBatchInvariantError);
    };

    expectRejected({ ...originalFacts, allocations: [] });
    expectRejected({
      ...originalFacts,
      allocations: [{ ...first, id: asAllocSiteId(999) }],
    });
    expectRejected({
      ...originalFacts,
      allocations: [{ ...first, ownership: first.ownership === "owned" ? "escaped" : "owned" }],
    });
    expectRejected({
      ...originalFacts,
      allocations: [
        {
          ...first,
          evidence: {
            ...first.evidence,
            ownership: { present: !first.evidence.ownership.present, value: first.evidence.ownership.value },
          },
        },
      ],
    });
    const alteredSiteType =
      first.site.type.kind === "vec"
        ? {
            ...first.site.type,
            elementType: { kind: "val" as const, val: { kind: "f32" as const } },
          }
        : { kind: "val" as const, val: { kind: "f32" as const } };
    expectRejected({
      ...originalFacts,
      allocations: [{ ...first, site: { ...first.site, type: alteredSiteType } }],
    });
    expectRejected({
      ...originalFacts,
      registry: {
        ...originalFacts.registry,
        entries: originalFacts.registry.entries.map((entry, index) =>
          index === (first.id as number) ? { state: "retired" as const } : entry,
        ),
      },
    });

    const cyclicEntries =
      originalFacts.registry.entries.length < 2
        ? [
            { state: "aliased" as const, to: asAllocSiteId(1) },
            { state: "aliased" as const, to: asAllocSiteId(0) },
          ]
        : originalFacts.registry.entries.map((entry, index) =>
            index < 2 ? { state: "aliased" as const, to: asAllocSiteId(index === 0 ? 1 : 0) } : entry,
          );
    expectRejected({
      ...originalFacts,
      registry: { ...originalFacts.registry, size: cyclicEntries.length, entries: cyclicEntries },
    });

    const extraId = asAllocSiteId(originalFacts.registry.size);
    const extraSite = { ...first.site, id: extraId };
    expectRejected({
      ...originalFacts,
      allocations: [
        ...originalFacts.allocations,
        {
          id: extraId,
          site: extraSite,
          ownership: "escaped",
          accesses: [],
          escape: "opaque",
          stackCandidate: false,
          evidence: {
            ownership: { present: false, value: undefined },
            escape: { present: false, value: undefined },
            encoding: { present: false, value: undefined },
          },
        },
      ],
      registry: {
        ...originalFacts.registry,
        size: originalFacts.registry.size + 1,
        entries: [...originalFacts.registry.entries, { state: "live" as const, site: extraSite }],
      },
    });
  });

  it("keeps a multi-function call graph, loop, branch, mutable slots, and Math provider in one batch", async () => {
    const { batch, values } = await productionGraphBatch();
    expect(values).toEqual([-4, 4, 2_147_483_649]);
    expect(batch.module.functions.map((fn) => fn.name)).toEqual(["step", "test"]);
    expect(batch.effects.some((fact) => fact.kind === "while.loop")).toBe(true);
    expect(batch.effects.some((fact) => fact.kind === "slot.write")).toBe(true);
    expect(batch.runtime.providers.size).toBeGreaterThan(0);
    expect(batch.runtime.manifest?.providers.length).toBeGreaterThan(0);
    const [providerId, provider] = [...batch.runtime.providers.entries()][0]!;
    const captureInput = (providers: ReadonlyMap<string, typeof provider>) => ({
      module: batch.module,
      owners: batch.owners,
      allocationFacts: batch.allocationFacts,
      runtime: { manifest: batch.runtime.manifest, providers },
      countedStringReceipts: batch.countedStringReceipts,
      producer: batch.producer,
    });
    const missingProvider = new Map(batch.runtime.providers);
    missingProvider.delete(providerId);
    expect(() => prepareLinearIrBodyBatch(captureInput(missingProvider))).toThrow(/has no selected runtime provider/);
    const extraProvider = new Map(batch.runtime.providers);
    extraProvider.set("math.trunc", provider);
    expect(() => prepareLinearIrBodyBatch(captureInput(extraProvider))).toThrow(/has no executable intrinsic use/);

    const linearResolver = moduleResolver(batch);
    const gcResolver = moduleResolver(batch);
    const linearPlans = new Map<IrUnitId, FrozenIrBackendFunctionPlan<Instr[], ValType>>();
    const gcPlans = new Map<IrUnitId, FrozenIrBackendFunctionPlan<Instr[], ValType>>();
    for (const fn of batch.module.functions) {
      const linearTypeConverter = wasmValueTypeConverter("linear", linearResolver, fn.name);
      const gcTypeConverter = wasmValueTypeConverter("wasmgc", gcResolver, fn.name);
      linearPlans.set(fn.unitId, {
        resolver: linearResolver,
        emitter: new LinearEmitter(),
        typeConverter: linearTypeConverter,
        signature: physicalSignature(fn, linearTypeConverter),
      });
      gcPlans.set(fn.unitId, {
        resolver: gcResolver,
        emitter: new WasmGcEmitter(),
        typeConverter: gcTypeConverter,
        signature: physicalSignature(fn, gcTypeConverter),
      });
    }
    const linearOutputs = consumeFrozenIrBodyBatch({
      batch,
      session: createFrozenIrBackendSession(batch, "linear"),
      backend: "linear",
      plans: linearPlans,
    });
    const gcOutputs = consumeFrozenIrBodyBatch({
      batch,
      session: createFrozenIrBackendSession(batch, "wasmgc"),
      backend: "wasmgc",
      plans: gcPlans,
    });
    const linearModule = assembleConsumedBodies(batch, linearOutputs);
    const gcModule = assembleConsumedBodies(batch, gcOutputs);
    const linearInstance = await WebAssembly.instantiate(emitBinary(linearModule));
    const gcInstance = await WebAssembly.instantiate(emitBinary(gcModule));
    const linearTest = (linearInstance.instance.exports as { readonly test: (input: number) => number }).test;
    const gcTest = (gcInstance.instance.exports as { readonly test: (input: number) => number }).test;
    expect([-2, 0, 2_147_483_647].map((input) => linearTest(input))).toEqual(values);
    expect([-2, 0, 2_147_483_647].map((input) => gcTest(input))).toEqual(values);
  });

  it("terminalizes an accepted backend attempt after a late lowering failure", async () => {
    const { batch } = await productionGraphBatch();
    const [first, second] = batch.module.functions;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const resolver = moduleResolver(batch);
    const firstTypeConverter = wasmValueTypeConverter("linear", resolver, first!.name);
    const secondTypeConverter = wasmValueTypeConverter("linear", resolver, second!.name);
    let secondConversions = 0;
    const conversionLimit = second!.params.length + second!.resultTypes.length;
    const lateTypeConverter: TypeConverter<ValType> = {
      backend: "linear",
      convertType(type) {
        secondConversions++;
        if (secondConversions > conversionLimit) throw new Error("late test converter failure");
        return secondTypeConverter.convertType(type);
      },
    };
    const plans = new Map<IrUnitId, FrozenIrBackendFunctionPlan<Instr[], ValType>>([
      [
        first!.unitId,
        {
          resolver,
          emitter: new LinearEmitter(),
          typeConverter: firstTypeConverter,
          signature: physicalSignature(first!, firstTypeConverter),
        },
      ],
      [
        second!.unitId,
        {
          resolver,
          emitter: new LinearEmitter(),
          typeConverter: lateTypeConverter,
          signature: physicalSignature(second!, secondTypeConverter),
        },
      ],
    ]);
    const session = createFrozenIrBackendSession(batch, "linear");
    expect(() => consumeFrozenIrBodyBatch({ batch, session, backend: "linear", plans })).toThrow(
      /failed during lowering: late test converter failure/,
    );
    expect(() => consumeFrozenIrBodyBatch({ batch, session, backend: "linear", plans })).toThrow(
      /backend session was already consumed/,
    );
  });
});
