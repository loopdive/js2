// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { mintDefinedFunc, pushDefinedFunc } from "../src/codegen/func-space.js";
import { lowerPreparedIrAsyncFunction } from "../src/codegen/ir-async-frame.js";
import { materializePreparedAsyncHostAdapters } from "../src/codegen/ir-async-runtime-adapters.js";
import { addFuncType } from "../src/codegen/registry/types.js";
import { emitBinary } from "../src/emit/binary.js";
import { emitPreparedAsyncAwait } from "../src/ir/async-from-ast.js";
import { ASYNC_RUNTIME_FEATURES } from "../src/ir/async-runtime-providers.js";
import { IrFunctionBuilder } from "../src/ir/builder.js";
import { createEmptyModule, type WasmFunction } from "../src/ir/types.js";
import { ts } from "../src/ts-api.js";
import {
  asAsyncStateId,
  assertPreparedIrAsyncRuntimeCurrent,
  canonicalPromiseAbi,
  createIrAsyncPlan,
  verifyIrAsyncPlan,
} from "../src/ir/async-plan.js";
import {
  createDerivedIrUnitId,
  createIrSourceId,
  createIrUnitId,
  type IrSourceRecord,
  type IrTerminalUnitRecord,
} from "../src/ir/identity.js";
import { prepareIrRuntimeManifest, type IrRuntimeManifestDemands } from "../src/ir/intrinsic-support.js";
import { asBlockId, asValueId, irVal, type IrFunction, type IrInstr } from "../src/ir/nodes.js";
import { PreparedIrProgramInvariantError, type PreparedIrProgramProducerInput } from "../src/ir/program.js";
import {
  prepareWholeProgramAsyncFunctions,
  prepareWholeProgramRuntimeManifest,
} from "../src/ir/runtime-program-producers.js";
import type { RuntimeManifestPolicy } from "../src/ir/runtime-manifest.js";
import {
  assertRuntimeHostCapabilityRecord,
  resolveRuntimeHostCapabilityRecord,
  RUNTIME_HOST_CAPABILITY_RECORDS,
} from "../src/ir/runtime-host-capabilities.js";

const F64 = irVal({ kind: "f64" });
const EXTERN = irVal({ kind: "externref" });
const HOST: RuntimeManifestPolicy = { target: "host", backend: "wasmgc" };

function source(sourceKey: string, order: number): IrSourceRecord {
  return {
    id: createIrSourceId({ kind: order === 0 ? "entry" : "source", order, sourceKey }),
    kind: order === 0 ? "entry" : "source",
    order,
    sourceKey,
    displayName: sourceKey,
    originalFileName: `/build/${sourceKey}`,
  };
}
const ENTRY = source("entry.ts", 0);
const OTHER = source("dependency.ts", 1);

function terminal(source: IrSourceRecord, ordinal: number, initializer = false): IrTerminalUnitRecord {
  const kind = initializer ? "module-init" : "function-declaration";
  const id = createIrUnitId({ sourceId: source.id, lexicalOwnerId: null, kind, ordinal });
  return {
    id,
    sourceId: source.id,
    lexicalOwnerId: null,
    kind,
    ordinal,
    displayName: initializer ? "<module-init>" : "sameName",
    line: 10 + ordinal,
    column: 2,
    declarationStart: ordinal * 10,
    declarationEnd: ordinal * 10 + 9,
    terminal: true,
    terminalOwnerId: id,
    observedKind: initializer ? "module-init" : "function",
    legacyKey: String(id),
    legacyMatchName: "sameName",
    legacyOrdinal: ordinal,
    staticClassMember: false,
    legacyBodyAvailable: true,
  };
}

function constant(unit: IrTerminalUnitRecord): IrFunction {
  return {
    unitId: unit.id,
    name: unit.displayName,
    params: [],
    resultTypes: [F64],
    valueCount: 1,
    exported: false,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [{ kind: "const", value: { kind: "f64", value: 3 }, result: asValueId(0), resultType: F64 }],
        terminator: { kind: "return", values: [asValueId(0)] },
      },
    ],
  };
}

function math(unit: IrTerminalUnitRecord): IrFunction {
  const fn = constant(unit);
  return {
    ...fn,
    valueCount: 2,
    blocks: [
      {
        ...fn.blocks[0]!,
        instrs: [
          ...fn.blocks[0]!.instrs,
          {
            kind: "intrinsic",
            id: "math.sin",
            version: 1,
            args: [asValueId(0)],
            result: asValueId(1),
            resultType: F64,
            site: { line: unit.line + 2, column: 4 },
          },
        ],
        terminator: { kind: "return", values: [asValueId(1)] },
      },
    ],
  };
}

function asyncChain(unit: IrTerminalUnitRecord): IrFunction {
  const c = (result: number, value: number): IrInstr => ({
    kind: "const",
    value: { kind: "f64", value },
    result: asValueId(result),
    resultType: F64,
  });
  const add = (lhs: number, rhs: number, result: number): IrInstr => ({
    kind: "binary",
    op: "f64.add",
    lhs: asValueId(lhs),
    rhs: asValueId(rhs),
    result: asValueId(result),
    resultType: F64,
  });
  const promise = (result: number): IrInstr => ({
    kind: "const",
    value: { kind: "null", ty: EXTERN },
    result: asValueId(result),
    resultType: EXTERN,
  });
  const awaitValue = (operand: number, result: number): IrInstr => ({
    kind: "await",
    operand: asValueId(operand),
    result: asValueId(result),
    resultType: F64,
  });
  return {
    unitId: unit.id,
    name: unit.displayName,
    funcKind: "async",
    params: [{ name: "seed", value: asValueId(0), type: F64 }],
    resultTypes: [F64],
    valueCount: 9,
    exported: false,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          c(1, 1),
          add(0, 1, 2),
          promise(3),
          awaitValue(3, 4),
          promise(5),
          awaitValue(5, 6),
          add(4, 6, 7),
          add(7, 0, 8),
        ],
        terminator: { kind: "return", values: [asValueId(8)] },
      },
    ],
  };
}

function program(
  units: readonly IrTerminalUnitRecord[],
  functions: readonly IrFunction[],
  policy = HOST,
): PreparedIrProgramProducerInput {
  return {
    inventory: { sources: [ENTRY, OTHER], classes: [], allUnits: units, terminalUnits: units },
    ir: { functions },
    derivedUnits: [],
    abi: { get: () => undefined },
    policy,
  };
}

function demandsFor(input: PreparedIrProgramProducerInput): Map<IrFunction["unitId"], IrRuntimeManifestDemands> {
  return new Map(input.ir.functions.map((fn) => [fn.unitId, {}]));
}

function prepareAsyncProgram(policy = HOST): PreparedIrProgramProducerInput {
  const units = [terminal(ENTRY, 0, true), terminal(OTHER, 0), terminal(ENTRY, 1)];
  const input = program(units, [constant(units[0]!), math(units[1]!), asyncChain(units[2]!)], policy);
  const prepared = prepareWholeProgramAsyncFunctions(input);
  expect(prepared.kind).toBe("prepared");
  if (prepared.kind !== "prepared") throw new Error(prepared.detail);
  return { ...input, ir: { functions: prepared.functions }, derivedUnits: prepared.derivedUnits };
}

function numericAwaitProgram(settleOnly = false): PreparedIrProgramProducerInput {
  const unit = terminal(ENTRY, 0);
  const seed = asValueId(0),
    first = asValueId(1),
    second = asValueId(2);
  const plan = createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: unit.id,
    kind: "async-function",
    abi: canonicalPromiseAbi(F64),
    entry: asAsyncStateId(0),
    params: [{ value: seed, type: F64 }],
    values: [seed, first, second].map((value) => ({ value, type: F64 })),
    spills: [],
    handlers: [],
    states: [
      {
        id: asAsyncStateId(0),
        body: [],
        terminator: {
          kind: "suspend",
          awaited: seed,
          resume: { state: asAsyncStateId(1), value: first },
          rejected: { kind: "reject" },
          live: [],
        },
      },
      {
        id: asAsyncStateId(1),
        resume: { value: first, type: F64, source: "fulfilled" },
        body: [],
        terminator: {
          kind: "suspend",
          awaited: first,
          resume: { state: asAsyncStateId(2), value: second },
          rejected: { kind: "reject" },
          live: [],
        },
      },
      {
        id: asAsyncStateId(2),
        resume: { value: second, type: F64, source: "fulfilled" },
        body: [],
        terminator: { kind: "resolve", value: second },
      },
    ],
    runtimeIntents: [...ASYNC_RUNTIME_FEATURES, "promise.number.bridge"],
  });
  return program(
    [unit],
    [
      {
        ...constant(unit),
        funcKind: "async",
        params: [{ name: "seed", value: seed, type: F64 }],
        valueCount: 3,
        blocks: [
          { id: asBlockId(0), blockArgs: [], blockArgTypes: [], instrs: [], terminator: { kind: "unreachable" } },
        ],
        asyncPlan: settleOnly
          ? createIrAsyncPlan({
              ...plan,
              values: [{ value: seed, type: F64 }],
              states: [{ id: asAsyncStateId(0), body: [], terminator: { kind: "resolve", value: seed } }],
            })
          : plan,
      },
    ],
  );
}

describe("#3518 complete-program runtime producers", () => {
  it("publishes an explicit empty manifest while preserving the legacy optional result", () => {
    const unit = terminal(ENTRY, 0, true);
    const input = program([unit], [constant(unit)]);
    expect(
      prepareIrRuntimeManifest({ functions: input.ir.functions, sourceFile: "entry.ts", policy: HOST }),
    ).toBeUndefined();
    const result = prepareWholeProgramRuntimeManifest({ ...input, demands: demandsFor(input) });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    expect(result.runtime.functions).toHaveLength(1);
    expect(result.runtime.manifest.features).toEqual([]);
    expect(result.runtime.manifest.providers).toEqual([]);
    expect(Object.isFrozen(result.runtime.manifest)).toBe(true);
    expect(() => (result.runtime.providers as Map<unknown, unknown>).clear()).toThrow();
  });

  it("also prepares a truly empty population without inventing a source owner", () => {
    const result = prepareWholeProgramRuntimeManifest({ ...program([], []), demands: new Map() });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    expect(result.runtime.functions).toHaveLength(0);
    expect(result.runtime.manifest.intrinsicUses).toHaveLength(0);
  });

  it("keeps same-name functions and initializer uses source-qualified", () => {
    const units = [terminal(ENTRY, 0, true), terminal(OTHER, 0)];
    const input = program(units, units.map(math));
    const result = prepareWholeProgramRuntimeManifest({ ...input, demands: demandsFor(input) });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    expect(result.runtime.functions).toHaveLength(2);
    expect(result.runtime.manifest.intrinsicUses.map((use) => use.location)).toEqual([
      { file: "dependency.ts", line: 12, column: 4 },
      { file: "entry.ts", line: 12, column: 4 },
    ]);
    expect(result.runtime.manifest.providers.some((provider) => provider.feature === "math.sin")).toBe(true);
  });

  it("prepares every async owner and returns complete derived state provenance", () => {
    const input = prepareAsyncProgram();
    expect(input.ir.functions).toHaveLength(6);
    expect(input.derivedUnits).toHaveLength(3);
    const owner = input.ir.functions.find((fn) => fn.funcKind === "async")!;
    expect(verifyIrAsyncPlan(owner.asyncPlan!)).toEqual([]);
    expect(owner.asyncPlan!.states).toHaveLength(3);
    expect(owner.asyncPlan!.abi.settlementTiming).toBe("always-async");
    for (const derived of input.derivedUnits) {
      expect(derived.parentId).toBe(owner.unitId);
      expect(derived.terminalOwnerId).toBe(owner.unitId);
      expect(derived.sourceId).toBe(ENTRY.id);
      expect(input.ir.functions.some((fn) => fn.unitId === derived.id)).toBe(true);
    }
    expect(input.ir.functions.every((fn) => fn.asyncRuntime === undefined)).toBe(true);
  });

  it.each([HOST, { target: "standalone", backend: "wasmgc" } as const])(
    "retains authenticated async joins for %s",
    (policy) => {
      const input = prepareAsyncProgram(policy);
      const result = prepareWholeProgramRuntimeManifest({ ...input, demands: demandsFor(input) });
      expect(result.kind).toBe("prepared");
      if (result.kind !== "prepared") throw new Error(result.detail);
      expect(result.runtime.functions).toHaveLength(6);
      const fn = result.runtime.functions.find((fn) => fn.funcKind === "async")!;
      const runtime = assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, fn.asyncRuntime);
      expect(runtime.manifest).toBe(result.runtime.manifest);
      expect(runtime.providers.every((provider) => result.runtime.manifest.providers.includes(provider))).toBe(true);
      expect(runtime.kind).toBe(policy.target === "host" ? "host-wasmgc" : "standalone-native-wasmgc");
      const copied = JSON.parse(JSON.stringify(runtime));
      expect(() => assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, copied)).toThrow();
    },
  );

  it("locates a malformed intrinsic in its original dependency owner", () => {
    const units = [terminal(ENTRY, 0), terminal(OTHER, 1)];
    const bad = math(units[1]!);
    const input = program(units, [
      constant(units[0]!),
      {
        ...bad,
        blocks: [
          {
            ...bad.blocks[0]!,
            instrs: bad.blocks[0]!.instrs.map((instr) =>
              instr.kind === "intrinsic" ? { ...instr, args: [asValueId(99)] } : instr,
            ),
          },
        ],
      },
    ]);
    const result = prepareWholeProgramRuntimeManifest({ ...input, demands: demandsFor(input) });
    expect(result).toMatchObject({
      kind: "invariant",
      unitId: units[1]!.id,
      location: { sourceId: OTHER.id, line: 11 },
    });
  });

  it("refuses a missing per-artifact demand scan even when the body has no runtime use", () => {
    const unit = terminal(OTHER, 0);
    const input = program([unit], [constant(unit)]);
    expect(prepareWholeProgramRuntimeManifest({ ...input, demands: new Map() })).toMatchObject({
      kind: "invariant",
      unitId: unit.id,
      detail: expect.stringContaining("scan is missing"),
    });
  });

  it("locates an unavailable non-intrinsic provider through its exact demand owner", () => {
    const units = [terminal(ENTRY, 0), terminal(OTHER, 1)];
    const input = program(units, units.map(constant));
    const demands = demandsFor(input);
    demands.set(units[1]!.id, { stringLenDemand: true });
    expect(prepareWholeProgramRuntimeManifest({ ...input, demands })).toMatchObject({
      kind: "unsupported",
      unitId: units[1]!.id,
      location: { sourceId: OTHER.id },
    });
  });

  it("reports a linear async capability gap as failure evidence", () => {
    const input = prepareAsyncProgram({ target: "host", backend: "linear" });
    expect(prepareWholeProgramRuntimeManifest({ ...input, demands: demandsFor(input) })).toMatchObject({
      kind: "unsupported",
      location: { sourceId: ENTRY.id },
    });
  });

  it("rejects incomplete semantic async preparation before manifest freeze", () => {
    const unit = terminal(ENTRY, 0);
    const input = program([unit], [asyncChain(unit)]);
    expect(prepareWholeProgramRuntimeManifest({ ...input, demands: demandsFor(input) })).toMatchObject({
      kind: "invariant",
      unitId: unit.id,
    });
  });

  it("returns explicit unsupported for a body the existing async producer cannot represent", () => {
    const unit = terminal(OTHER, 0);
    const fn = asyncChain(unit);
    const input = program([unit], [{ ...fn, blocks: [...fn.blocks, { ...fn.blocks[0]!, id: asBlockId(1) }] }]);
    expect(prepareWholeProgramAsyncFunctions(input)).toMatchObject({
      kind: "unsupported",
      unitId: unit.id,
      location: { sourceId: OTHER.id },
    });
  });

  it("rejects duplicate units and derived state collisions", () => {
    const unit = terminal(ENTRY, 0);
    const fn = asyncChain(unit);
    expect(() => prepareWholeProgramAsyncFunctions(program([unit], [fn, fn]))).toThrow(/duplicated/);
    const input = program([unit], [fn]);
    const derived = {
      id: createDerivedIrUnitId({ parentId: unit.id, role: "ir-async-state", ordinal: 0 }),
      parentId: unit.id,
      role: "ir-async-state" as const,
      ordinal: 0,
      terminalOwnerId: unit.id,
      sourceId: ENTRY.id,
    };
    expect(
      prepareWholeProgramAsyncFunctions({
        ...input,
        ir: { functions: [fn, { ...constant(unit), unitId: derived.id }] },
        derivedUnits: [derived],
      }),
    ).toMatchObject({ kind: "invariant", detail: expect.stringContaining("conflicting") });
  });

  it("rejects an empty or subset body vector for a nonempty original census", () => {
    const units = [terminal(ENTRY, 0, true), terminal(OTHER, 0)];
    const input = program(units, units.map(constant));
    for (const functions of [[], [input.ir.functions[0]!]]) {
      const missing = { ...input, ir: { functions } };
      expect(() => prepareWholeProgramRuntimeManifest({ ...missing, demands: demandsFor(missing) })).toThrow(
        /missing body/,
      );
      expect(() => prepareWholeProgramAsyncFunctions(missing)).toThrow(/missing body/);
    }
  });

  it("rejects a pre-existing async plan with missing state bodies or provenance", () => {
    const input = prepareAsyncProgram();
    const stateId = input.derivedUnits[0]!.id;
    const missingState = { ...input, ir: { functions: input.ir.functions.filter((fn) => fn.unitId !== stateId) } };
    expect(() => prepareWholeProgramAsyncFunctions(missingState)).toThrow(/missing body/);
    expect(() => prepareWholeProgramRuntimeManifest({ ...missingState, demands: demandsFor(missingState) })).toThrow(
      /missing body/,
    );
    const missingProvenance = { ...input, derivedUnits: input.derivedUnits.slice(1) };
    expect(() => prepareWholeProgramAsyncFunctions(missingProvenance)).toThrow(/no original owner/);
  });

  it("keeps an unsupported non-suspending async owner explicit", () => {
    const unit = terminal(ENTRY, 0);
    const fn = { ...constant(unit), funcKind: "async" as const };
    expect(prepareWholeProgramAsyncFunctions(program([unit], [fn]))).toMatchObject({
      kind: "unsupported",
      unitId: unit.id,
    });
  });

  it("never fabricates a source location for an unowned function", () => {
    const unit = terminal(OTHER, 0);
    const input = program([], [constant(unit)]);
    expect(() => prepareWholeProgramRuntimeManifest({ ...input, demands: demandsFor(input) })).toThrow(
      PreparedIrProgramInvariantError,
    );
  });

  it("preserves the original numeric await carrier and rejects contradictory type evidence", () => {
    const unit = terminal(ENTRY, 0);
    const builder = new IrFunctionBuilder({ unitId: unit.id, name: "numeric" }, [F64]);
    builder.setFuncKind("async");
    builder.openBlock();
    const operand = builder.emitConst({ kind: "f64", value: 29 }, F64);
    const result = emitPreparedAsyncAwait(builder, operand, { operandType: F64, resultType: F64 });
    expect(builder.valueType(result)).toEqual(F64);
    expect(() => emitPreparedAsyncAwait(builder, operand, { operandType: EXTERN, resultType: F64 })).toThrow(
      /contradicts/,
    );
    expect(() =>
      emitPreparedAsyncAwait(builder, operand, { operandType: F64, resultType: F64, settledNonThenable: true }),
    ).toThrow(/settled-owner receipt/);
    builder.terminate({ kind: "return", values: [result] });
    const fn = builder.finish();
    expect(fn.blocks[0]!.instrs.map((instr) => instr.kind)).toEqual(["const", "await"]);
    expect(fn.blocks[0]!.instrs[1]).toMatchObject({ kind: "await", operand });
    const input = program([unit], [fn]);
    const prepared = prepareWholeProgramAsyncFunctions(input);
    expect(prepared.kind).toBe("prepared");
    if (prepared.kind !== "prepared") throw new Error(prepared.detail);
    const owner = prepared.functions.find((candidate) => candidate.unitId === unit.id)!;
    expect(owner.asyncPlan?.runtimeIntents).toContain("promise.number.bridge");
    expect(owner.asyncPlan?.states[0]!.terminator).toMatchObject({ kind: "suspend" });
  });

  it("declares the exact host caught-exception dependency and rejects ABI mutations", () => {
    const record = resolveRuntimeHostCapabilityRecord(RUNTIME_HOST_CAPABILITY_RECORDS, "async.exception.caught");
    expect(record).toEqual({
      kind: "func",
      capability: "async.exception.caught",
      module: "env",
      field: "__get_caught_exception",
      params: [],
      results: ["externref"],
    });
    expect(() => assertRuntimeHostCapabilityRecord({ ...record, results: ["f64"] })).toThrow(/results/);
    const input = numericAwaitProgram();
    const result = prepareWholeProgramRuntimeManifest({ ...input, demands: demandsFor(input) });
    if (result.kind !== "prepared") throw new Error(result.detail);
    expect(
      result.runtime.manifest.providers.find((provider) => provider.id === "host.promise.capability.create")
        ?.hostCapabilities,
    ).toEqual(["async.exception.caught", "async.promise.capability.create"]);
    const adapter = result.runtime.functions[0]!.asyncRuntime!.adapters.find(
      (entry) => entry.capability === "async.exception.caught",
    );
    expect(adapter?.record).toBe(record);
    expect(adapter?.target.binding).toMatchObject({ kind: "import", module: "env", field: "__get_caught_exception" });
  });

  it("reports the shared-frame prerequisite for a valid minimal settled plan before allocation", () => {
    const input = numericAwaitProgram(true);
    const owner = input.ir.functions[0]!;
    const param = { value: owner.params[0]!.value, type: EXTERN };
    const fn: IrFunction = {
      ...owner,
      params: [{ ...owner.params[0]!, type: EXTERN }],
      resultTypes: [EXTERN],
      asyncPlan: createIrAsyncPlan({
        ...owner.asyncPlan!,
        abi: canonicalPromiseAbi(EXTERN),
        params: [param],
        values: [param],
        runtimeIntents: ["promise.capability.create", "promise.settle.fulfill"],
      }),
    };
    const semantic = { ...input, ir: { functions: [fn] } };
    expect(verifyIrAsyncPlan(fn.asyncPlan!)).toEqual([]);
    expect(prepareWholeProgramRuntimeManifest({ ...semantic, demands: demandsFor(semantic) })).toMatchObject({
      kind: "unsupported",
      stage: "resolve",
      unitId: fn.unitId,
      detail: expect.stringContaining("valid semantic plan"),
    });
    const projection = prepareIrRuntimeManifest({ functions: [fn], sourceFile: "entry.ts", policy: HOST })!;
    expect(projection.manifest.hostCapabilityRecords).toHaveLength(3);
    const module = createEmptyModule();
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, { target: "gc", nativeStrings: true });
    const typeIdx = addFuncType(ctx, [{ kind: "externref" }], [{ kind: "externref" }]);
    const before = JSON.stringify(module);
    const existing: WasmFunction = { name: "settled", typeIdx, locals: [], body: [], exported: false };
    expect(() =>
      lowerPreparedIrAsyncFunction(
        ctx,
        projection.functions[0]!,
        {
          resolveFunc() {
            throw new Error("must reject before physical reference lookup");
          },
        },
        existing,
      ),
    ).toThrow(expect.objectContaining({ kind: "unsupported", stage: "resolve" }));
    expect(JSON.stringify(module)).toBe(before);
  });

  it("requires the numeric Promise bridge without changing generic number policy", () => {
    const input = numericAwaitProgram();
    const result = prepareWholeProgramRuntimeManifest({ ...input, demands: demandsFor(input) });
    expect(result.kind).toBe("prepared");
    if (result.kind !== "prepared") throw new Error(result.detail);
    expect(result.runtime.manifest.policy.numberBoundary).toEqual({ box: "unsupported", unbox: "unsupported" });
    expect(result.runtime.manifest.features).toContain("promise.number.bridge");
    expect(result.runtime.manifest.features).not.toContain("js.number.box");
    expect(
      result.runtime.manifest.hostCapabilityRecords
        .filter((record) => record.capability.startsWith("number."))
        .map((record) => record.capability),
    ).toEqual(["number.box", "number.unbox"]);
    const fn = input.ir.functions[0]!;
    const dropped = {
      ...fn.asyncPlan!,
      runtimeIntents: fn.asyncPlan!.runtimeIntents.filter((intent) => intent !== "promise.number.bridge"),
    };
    expect(verifyIrAsyncPlan(dropped).some((error) => error.code === "missing-runtime-intent")).toBe(true);
    const runtime = result.runtime.functions[0]!.asyncRuntime!;
    const missingAdapter = Object.freeze({
      ...runtime,
      adapters: Object.freeze(runtime.adapters.filter((adapter) => adapter.capability !== "number.box")),
    });
    expect(() =>
      assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, result.runtime.functions[0]!.asyncPlan, missingAdapter),
    ).toThrow(/adapters/);
  });

  it.each([false, true])(
    "executes a numeric host Promise frame with settleOnly=%s without late imports",
    (settleOnly) => {
      const input = numericAwaitProgram(settleOnly);
      const result = prepareWholeProgramRuntimeManifest({ ...input, demands: demandsFor(input) });
      if (result.kind !== "prepared") throw new Error(result.detail);
      const fn = result.runtime.functions[0]!;
      const module = createEmptyModule();
      const ctx = createCodegenContext(module, {} as ts.TypeChecker, { target: "gc", nativeStrings: true });
      materializePreparedAsyncHostAdapters(ctx, result.runtime.functions);
      const importsBeforeFrame = module.imports.length;
      const importObjectsBeforeFrame = [...module.imports];
      const typeIdx = addFuncType(ctx, [{ kind: "f64" }], [{ kind: "externref" }]);
      const mainIdx = mintDefinedFunc(ctx);
      const placeholder: WasmFunction = {
        name: "numeric",
        typeIdx,
        locals: [],
        body: [{ op: "unreachable" }],
        exported: true,
      };
      pushDefinedFunc(ctx, mainIdx, placeholder);
      const lowered = lowerPreparedIrAsyncFunction(
        ctx,
        fn,
        {
          resolveFunc(ref) {
            if (ref.binding.kind !== "import") throw new Error("unexpected non-import numeric-plan reference");
            const binding = ref.binding;
            let index = 0;
            for (const imported of module.imports) {
              if (imported.desc.kind !== "func") continue;
              if (imported.module === binding.module && imported.name === binding.field) return index;
              index++;
            }
            throw new Error(`missing accepted import ${ref.name}`);
          },
        },
        placeholder,
      );
      Object.assign(placeholder, lowered);
      module.exports.push({ name: "numeric", desc: { kind: "func", index: mainIdx } });
      expect(module.imports, JSON.stringify(module.imports.slice(importsBeforeFrame))).toHaveLength(importsBeforeFrame);
      expect(module.imports.every((imported, index) => imported === importObjectsBeforeFrame[index])).toBe(true);
      const binary = emitBinary(module);
      const script = `
      import { readFileSync } from 'node:fs';
      const bytes = Uint8Array.from(JSON.parse(readFileSync(0, 'utf8')));
      const pending = new WeakMap(); let instance; const trace = [];
      const env = {
        __box_number: value => value, __unbox_number: value => Number(value),
        __get_caught_exception: () => { throw new Error('unexpected host catch'); },
        __make_callback: (id, caps) => value => instance.exports['__cb_' + id](caps, value),
        Promise_new_pending: () => { let resolve, reject; const promise = new Promise((a,b) => { resolve = a; reject = b; }); pending.set(promise, {resolve,reject}); return promise; },
        Promise_resolve: value => Promise.resolve(value),
        Promise_then2: (promise, fulfilled, rejected) => promise.then(fulfilled, rejected),
        Promise_settle_resolve: (promise, value) => { pending.get(promise).resolve(value); return promise; },
        Promise_settle_reject: (promise, value) => { pending.get(promise).reject(value); return promise; },
      };
      instance = new WebAssembly.Instance(new WebAssembly.Module(bytes), {env});
      const actual = instance.exports.numeric(29); const nativePromise = actual instanceof Promise;
      actual.then(value => trace.push('value:' + value)); trace.push('sync');
      await Promise.resolve(); trace.push('tick1'); await Promise.resolve(); trace.push('tick2');
      const value = await actual; trace.push('done');
      console.log(JSON.stringify({nativePromise,value,trace}));
    `;
      const child = spawnSync(process.execPath, ["--experimental-wasm-exnref", "--input-type=module", "-e", script], {
        input: JSON.stringify([...binary]),
        encoding: "utf8",
        timeout: 30_000,
      });
      expect(child.status, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toEqual({
        nativePromise: true,
        value: 29,
        trace: settleOnly
          ? ["sync", "value:29", "tick1", "tick2", "done"]
          : ["sync", "tick1", "tick2", "value:29", "done"],
      });
    },
  );

  it("does not reuse a runtime projection as fresh semantic input", () => {
    const input = prepareAsyncProgram();
    const result = prepareWholeProgramRuntimeManifest({ ...input, demands: demandsFor(input) });
    if (result.kind !== "prepared") throw new Error(result.detail);
    const projected = { ...input, ir: { functions: result.runtime.functions } };
    expect(prepareWholeProgramAsyncFunctions(projected)).toMatchObject({
      kind: "invariant",
      detail: expect.stringContaining("physical async runtime"),
    });
  });

  it("reattaches the runtime in a fresh process with frontend imports blocked", () => {
    const input = numericAwaitProgram();
    const loader = `export async function load(url, context, next) {
      if (/\\/src\\/(?:ts-api|ir\\/(?:async-prepare|async-linear-prepare|from-ast)|codegen\\/async-(?:ir|linear)-planning)\\.ts(?:\\?|$)|\\/node_modules\\/typescript\\//.test(url)) {
        throw new Error('blocked frontend: ' + url);
      }
      return next(url, context);
    }`;
    const script = `
      import { readFileSync } from 'node:fs';
      import { register } from 'node:module';
      register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(loader)}`)}, import.meta.url);
      const { prepareWholeProgramRuntimeManifest } = await import(${JSON.stringify(new URL("../src/ir/runtime-program-manifest.ts", import.meta.url).href)});
      const { assertPreparedIrAsyncRuntimeCurrent } = await import(${JSON.stringify(new URL("../src/ir/async-plan.ts", import.meta.url).href)});
      const input = JSON.parse(readFileSync(0, 'utf8'));
      const result = prepareWholeProgramRuntimeManifest({ ...input, abi: {}, demands: new Map(input.ir.functions.map(fn => [fn.unitId, {}])) });
      if (result.kind !== 'prepared') throw new Error(result.detail);
      for (const fn of result.runtime.functions) assertPreparedIrAsyncRuntimeCurrent(fn.unitId, fn.name, fn.asyncPlan, fn.asyncRuntime);
      let barrier = false;
      try { await import(${JSON.stringify(new URL("../src/ts-api.ts", import.meta.url).href)}); }
      catch (error) { if (!String(error).includes('blocked frontend:')) throw error; barrier = true; }
      console.log(JSON.stringify({barrier, functions:result.runtime.functions.length, features:result.runtime.manifest.features}));
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      input: JSON.stringify({
        inventory: input.inventory,
        ir: input.ir,
        derivedUnits: input.derivedUnits,
        policy: input.policy,
      }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      barrier: true,
      functions: 1,
      features: [...ASYNC_RUNTIME_FEATURES, "promise.number.bridge"].sort(),
    });
  });
});
