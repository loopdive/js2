// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { lowerPreparedIrAsyncFunction } from "../src/codegen/ir-async-frame.js";
import {
  getPreparedAsyncDrivePromiseTypeIdx,
  materializePreparedAsyncHostAdapters,
} from "../src/codegen/ir-async-runtime-adapters.js";
import { planProgramAbiCallableImports } from "../src/codegen/program-abi-import-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import {
  asAsyncStateId,
  assertPreparedIrAsyncRuntimeCurrent,
  canonicalPromiseAbi,
  createIrAsyncPlan,
  type IrAsyncPlan,
  type PreparedIrAsyncRuntime,
} from "../src/ir/async-plan.js";
import {
  ASYNC_HOST_ADAPTERS,
  ASYNC_HOST_CAPABILITY_RECORDS,
  ASYNC_RUNTIME_FEATURES,
  type AsyncHostAdapter,
} from "../src/ir/async-runtime-providers.js";
import { irCallableBindingKey } from "../src/ir/callable-bindings.js";
import { attachIrExternSupport } from "../src/ir/extern-support.js";
import { buildIrUnitInventory, type IrTerminalUnitRecord } from "../src/ir/identity.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { asBlockId, asValueId, irVal, type IrFunction } from "../src/ir/nodes.js";
import { derivePreparedComponentDependencies } from "../src/ir/prepared-component-dependencies.js";
import {
  RUNTIME_BACKEND_REQUIREMENTS,
  RuntimeManifestInvariantError,
  type FrozenRuntimeManifest,
  type RuntimeBackendRequirement,
  type RuntimeProviderDefinition,
} from "../src/ir/runtime-manifest.js";
import { createEmptyModule } from "../src/ir/types.js";
import { verifyIrFunction } from "../src/ir/verify.js";
import { ts } from "../src/ts-api.js";

const EXTERN = irVal({ kind: "externref" });
const F64 = irVal({ kind: "f64" });

function fixture(suffix = ""): {
  readonly inventory: ReturnType<typeof buildIrUnitInventory>;
  readonly unit: IrTerminalUnitRecord;
} {
  const source = ts.createSourceFile(
    `/repo/async-plan-consumer${suffix}.ts`,
    "export async function fetchUser(p: Promise<number>): Promise<number> { return await p; }",
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([source], { entrySource: source });
  const unit = inventory.terminalUnits.find(
    (candidate) => candidate.kind === "top-level-function" && candidate.displayName === "fetchUser",
  );
  if (!unit) throw new Error("missing fetchUser inventory unit");
  return { inventory, unit };
}

function pairFixture(): {
  readonly inventory: ReturnType<typeof buildIrUnitInventory>;
  readonly units: readonly IrTerminalUnitRecord[];
} {
  const source = ts.createSourceFile(
    "/repo/async-plan-consumer-pair.ts",
    [
      "export async function fetchUserA(p: Promise<number>): Promise<number> { return await p; }",
      "export async function fetchUserB(p: Promise<number>): Promise<number> { return await p; }",
    ].join("\n"),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const inventory = buildIrUnitInventory([source], { entrySource: source });
  const units = inventory.terminalUnits.filter(
    (candidate) => candidate.kind === "top-level-function" && candidate.displayName.startsWith("fetchUser"),
  );
  if (units.length !== 2) throw new Error("missing paired fetchUser inventory units");
  return { inventory, units };
}

function asyncPlan(unit: IrTerminalUnitRecord, withIntrinsic = false, voidResult = false): IrAsyncPlan {
  const promise = asValueId(0);
  const resumed = asValueId(1);
  const absolute = asValueId(2);
  return createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: unit.id,
    kind: "async-function",
    abi: canonicalPromiseAbi(voidResult ? null : F64),
    entry: asAsyncStateId(0),
    params: [{ value: promise, type: EXTERN }],
    values: [
      { value: promise, type: EXTERN },
      { value: resumed, type: F64 },
      ...(withIntrinsic ? [{ value: absolute, type: F64 }] : []),
    ],
    spills: [],
    states: [
      {
        id: asAsyncStateId(0),
        body: [],
        terminator: {
          kind: "suspend",
          awaited: promise,
          resume: { state: asAsyncStateId(1), value: resumed },
          rejected: { kind: "reject" },
          live: [],
        },
      },
      {
        id: asAsyncStateId(1),
        resume: { value: resumed, type: F64, source: "fulfilled" },
        body: withIntrinsic
          ? [
              {
                kind: "intrinsic",
                id: "math.abs",
                version: 1,
                args: [resumed],
                result: absolute,
                resultType: F64,
              },
            ]
          : [],
        terminator: voidResult ? { kind: "resolve" } : { kind: "resolve", value: withIntrinsic ? absolute : resumed },
      },
    ],
    handlers: [],
    runtimeIntents: voidResult ? [...ASYNC_RUNTIME_FEATURES, "value.undefined"] : ASYNC_RUNTIME_FEATURES,
  });
}

function irFunction(unit: IrTerminalUnitRecord, withIntrinsic = false, voidResult = false): IrFunction {
  const promise = asValueId(0);
  return {
    unitId: unit.id,
    name: unit.displayName,
    params: [{ value: promise, type: EXTERN, name: "p" }],
    resultTypes: [EXTERN],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [],
        terminator: { kind: "return", values: [promise] },
      },
    ],
    exported: true,
    valueCount: 2,
    funcKind: "async",
    asyncPlan: asyncPlan(unit, withIntrinsic, voidResult),
  };
}

function externStateIrFunction(unit: IrTerminalUnitRecord): IrFunction {
  const promise = asValueId(0);
  const resumed = asValueId(1);
  const listFormat = asValueId(2);
  const plan = createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: unit.id,
    kind: "async-function",
    abi: canonicalPromiseAbi(F64),
    entry: asAsyncStateId(0),
    params: [{ value: promise, type: EXTERN }],
    values: [
      { value: promise, type: EXTERN },
      { value: resumed, type: F64 },
      { value: listFormat, type: { kind: "extern", className: "ListFormat" } },
    ],
    spills: [],
    states: [
      {
        id: asAsyncStateId(0),
        body: [],
        terminator: {
          kind: "suspend",
          awaited: promise,
          resume: { state: asAsyncStateId(1), value: resumed },
          rejected: { kind: "reject" },
          live: [],
        },
      },
      {
        id: asAsyncStateId(1),
        resume: { value: resumed, type: F64, source: "fulfilled" },
        body: [
          {
            kind: "extern.new",
            className: "ListFormat",
            importPrefix: "Intl_ListFormat",
            args: [],
            result: listFormat,
            resultType: { kind: "extern", className: "ListFormat" },
          },
        ],
        terminator: { kind: "resolve", value: resumed },
      },
    ],
    handlers: [],
    runtimeIntents: ASYNC_RUNTIME_FEATURES,
  });
  return { ...irFunction(unit), asyncPlan: plan, valueCount: 3 };
}

function settleOnlyIrFunction(unit: IrTerminalUnitRecord): IrFunction {
  const value = asValueId(0);
  const plan = createIrAsyncPlan({
    schemaVersion: 1,
    ownerUnitId: unit.id,
    kind: "async-function",
    abi: canonicalPromiseAbi(F64),
    entry: asAsyncStateId(0),
    params: [{ value, type: F64 }],
    values: [{ value, type: F64 }],
    spills: [],
    states: [{ id: asAsyncStateId(0), body: [], terminator: { kind: "resolve", value } }],
    handlers: [],
    runtimeIntents: ["promise.capability.create", "promise.settle.fulfill"],
  });
  return {
    ...irFunction(unit),
    params: [{ value, type: F64, name: "value" }],
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [],
        terminator: { kind: "unreachable" },
      },
    ],
    valueCount: 1,
    asyncPlan: plan,
  };
}

function withDiscardedAwaitBlock(fn: IrFunction): IrFunction {
  const promise = fn.params[0]!.value;
  return {
    ...fn,
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "await",
            operand: promise,
            result: asValueId(9),
            resultType: F64,
          },
        ],
        terminator: { kind: "return", values: [promise] },
      },
    ],
    valueCount: 10,
  };
}

function prepareForTarget(fn: IrFunction, target: "host" | "standalone") {
  const prepared = prepareIrRuntimeManifest({
    functions: [fn],
    sourceFile: "/repo/async-plan-consumer.ts",
    policy: { target, backend: "wasmgc" },
  });
  if (!prepared) throw new Error("missing async runtime manifest");
  return prepared;
}

function prepare(fn: IrFunction) {
  return prepareForTarget(fn, "host");
}

function replaceRuntime(fn: IrFunction, update: Partial<PreparedIrAsyncRuntime>): IrFunction {
  if (!fn.asyncRuntime) throw new Error("missing prepared async runtime");
  return { ...fn, asyncRuntime: Object.freeze({ ...fn.asyncRuntime, ...update }) as PreparedIrAsyncRuntime };
}

function allocationShape(ctx: ReturnType<typeof createCodegenContext>) {
  return {
    imports: ctx.mod.imports.length,
    types: ctx.mod.types.length,
    functions: ctx.mod.functions.length,
    globals: ctx.mod.globals.length,
    funcMap: ctx.funcMap.size,
    structMap: ctx.structMap.size,
    undefinedGlobalIdx: ctx.undefinedGlobalIdx,
  };
}

describe("#4104 IR async plan runtime consumer", () => {
  it("closes a semantic plan to the exact frozen capability records without contaminating semantic edges", () => {
    const { unit } = fixture();
    const prepared = prepare(irFunction(unit));
    const fn = prepared.functions[0]!;

    expect(prepared.manifest.features).toEqual(ASYNC_RUNTIME_FEATURES);
    expect(fn.asyncRuntime?.adapters.map((adapter) => adapter.capability)).toEqual(
      ASYNC_HOST_ADAPTERS.map((adapter) => adapter.capability),
    );
    expect(fn.asyncRuntime?.adapters.map((adapter) => adapter.target.binding)).toEqual(
      ASYNC_HOST_ADAPTERS.map((adapter) => ({ kind: "import", module: adapter.module, field: adapter.field })),
    );
    expect(fn.asyncRuntime?.adapters.map((adapter) => adapter.record)).toEqual(prepared.manifest.hostCapabilityRecords);
    expect(
      fn.asyncRuntime?.adapters.every(
        (adapter, index) => adapter.record === prepared.manifest.hostCapabilityRecords[index],
      ),
    ).toBe(true);
    expect(fn.asyncRuntime?.plan).toBe(fn.asyncPlan);
    expect(fn.asyncRuntime?.manifest).toBe(prepared.manifest);
    expect(fn.asyncRuntime?.providers).toEqual(prepared.manifest.providers);
    expect(
      fn.asyncRuntime?.providers?.every((provider, index) => provider === prepared.manifest.providers[index]),
    ).toBe(true);
    expect(fn.asyncRuntime?.backendRequirements).toEqual([]);
    expect(Object.isFrozen(fn.asyncRuntime)).toBe(true);
    expect(Object.isFrozen(fn.asyncRuntime?.providers)).toBe(true);
    expect(Object.isFrozen(fn.asyncRuntime?.backendRequirements)).toBe(true);
    expect(Object.isFrozen(fn.asyncRuntime?.states)).toBe(true);
    expect(fn.asyncRuntime?.states.every((state) => Object.isFrozen(state))).toBe(true);
    expect(fn.asyncRuntime?.states.every((state) => Object.isFrozen(state.body))).toBe(true);
    expect(Object.isFrozen(fn.asyncRuntime?.adapters)).toBe(true);
    expect(fn.asyncRuntime?.adapters.every((adapter) => Object.isFrozen(adapter))).toBe(true);
    expect(
      fn.asyncRuntime?.providers?.every(
        (provider) =>
          Object.isFrozen(provider) &&
          Object.isFrozen(provider.dependencies) &&
          Object.isFrozen(provider.hostCapabilities) &&
          Object.isFrozen(provider.supportedTargets) &&
          Object.isFrozen(provider.supportedBackends) &&
          Object.isFrozen(provider.implementation),
      ),
    ).toBe(true);
    expect(verifyIrFunction(fn)).toEqual([]);

    const semanticData = JSON.stringify({
      plan: fn.asyncPlan,
      features: prepared.manifest.features,
      providers: prepared.manifest.providers,
      providerComponents: prepared.manifest.providerComponents,
      hostCapabilities: prepared.manifest.hostCapabilities,
    });
    for (const adapter of ASYNC_HOST_ADAPTERS) expect(semanticData).not.toContain(adapter.field);
    expect(JSON.stringify(prepared.manifest.hostCapabilityRecords)).toContain("Promise_resolve");
  });

  it("attaches the optional undefined record only when the semantic plan requests it", () => {
    const { unit } = fixture("-undefined");
    const prepared = prepare(irFunction(unit, false, true));
    const fn = prepared.functions[0]!;

    expect(prepared.manifest.hostCapabilityRecords).toEqual(ASYNC_HOST_CAPABILITY_RECORDS);
    expect(fn.asyncRuntime?.adapters.map((adapter) => adapter.record)).toEqual(ASYNC_HOST_CAPABILITY_RECORDS);
    expect(fn.asyncRuntime?.adapters.at(-1)?.capability).toBe("async.value.undefined");
    expect(fn.asyncRuntime?.backendRequirements).toEqual([]);
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("repeats structurally identical manifest preparation without stale attachment evidence", () => {
    const { unit } = fixture("-repeat-preparation");
    const first = prepare(irFunction(unit));
    const second = prepare(first.functions[0]!);
    expect(second.manifest).toEqual(first.manifest);
    expect(second.functions[0]!.asyncRuntime).toEqual(first.functions[0]!.asyncRuntime);
    expect(() =>
      assertPreparedIrAsyncRuntimeCurrent(
        second.functions[0]!.unitId,
        second.functions[0]!.name,
        second.functions[0]!.asyncPlan,
        second.functions[0]!.asyncRuntime,
      ),
    ).not.toThrow();
  });

  it("preserves a valid partial semantic provider closure without widening it to all six imports", () => {
    const { unit } = fixture("-partial");
    const prepared = prepare(settleOnlyIrFunction(unit));
    const fn = prepared.functions[0]!;
    const expected = ASYNC_HOST_CAPABILITY_RECORDS.filter(
      (record) =>
        record.capability === "async.promise.capability.create" || record.capability === "async.promise.settle.fulfill",
    );
    expect(prepared.manifest.hostCapabilityRecords).toEqual(expected);
    expect(fn.asyncRuntime?.adapters.map((adapter) => adapter.record)).toEqual(expected);
    expect(verifyIrFunction(fn)).toEqual([]);

    const module = createEmptyModule();
    const ctx = createCodegenContext(module, {} as ts.TypeChecker);
    materializePreparedAsyncHostAdapters(ctx, prepared.functions);
    expect(module.imports.map((entry) => `${entry.module}.${entry.name}`)).toEqual(
      expected.map((record) => `${record.module}.${record.field}`),
    );
  });

  it("keeps semantic plan bodies target-neutral while attaching intrinsic providers to prepared states", () => {
    const { unit } = fixture();
    const prepared = prepare(irFunction(unit, true));
    const fn = prepared.functions[0]!;
    const semantic = fn.asyncPlan!.states[1]!.body[0];
    const lowered = fn.asyncRuntime!.states[1]!.body[0];

    expect(semantic).toMatchObject({ kind: "intrinsic", id: "math.abs" });
    expect(semantic).not.toHaveProperty("provider");
    expect(lowered).toMatchObject({ kind: "intrinsic", id: "math.abs", provider: { kind: "backend-op" } });
    expect(Object.isFrozen(fn.asyncRuntime!.states[1]!.body)).toBe(true);
    expect(Object.isFrozen(lowered)).toBe(true);
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("attaches the standalone native runtime without changing the target-neutral semantic plan", () => {
    const { unit } = fixture("-standalone");
    const sourceFunction = irFunction(unit);
    const sourcePlan = sourceFunction.asyncPlan;
    const host = prepareForTarget(sourceFunction, "host");
    const standalone = prepareForTarget(sourceFunction, "standalone");
    const fn = standalone.functions[0]!;

    // (#3526 F1-S1, F1-S2, F1-S4, F2-S1, F2-S3, F2-S4, F2-S6, F2-S8) The frozen policy always
    // publishes an explicit resolved decision for every value-boundary family;
    // an async-only preparation resolves them all disabled.
    expect(standalone.manifest.policy).toEqual({
      target: "standalone",
      backend: "wasmgc",
      numberBoundary: { box: "unsupported", unbox: "unsupported" },
      booleanBoundary: { box: "unsupported" },
      externIsUndefined: { probe: "unsupported" },
      generatorNumberBox: { box: "unsupported" },
      stringCompare: { compare: "unsupported" },
      stringEq: { eq: "unsupported" },
      stringLen: { len: "unsupported" },
      stringConcat: { concat: "unsupported" },
      stringCharCodeAt: { charCodeAt: "unsupported" },
      stringConcatMany: { batch: "off" },
      stringConst: { storage: "unsupported" },
    });
    expect(standalone.manifest.features).toEqual(ASYNC_RUNTIME_FEATURES);
    expect(standalone.manifest.hostCapabilities).toEqual([]);
    expect(standalone.manifest.hostCapabilityRecords).toEqual([]);
    expect(standalone.manifest.backendRequirements).toEqual(RUNTIME_BACKEND_REQUIREMENTS.slice(0, 2));
    expect(standalone.manifest.providers.every((provider) => provider.implementation.kind === "native-managed")).toBe(
      true,
    );
    expect(fn.asyncRuntime).toMatchObject({ kind: "standalone-native-wasmgc", adapters: [] });
    expect(fn.asyncRuntime?.providers?.every((provider) => provider.implementation.kind === "native-managed")).toBe(
      true,
    );
    expect(fn.asyncRuntime?.backendRequirements).toEqual(RUNTIME_BACKEND_REQUIREMENTS.slice(0, 2));
    expect(fn.asyncRuntime?.states.every((state) => Object.isFrozen(state.body))).toBe(true);
    expect(fn.asyncRuntime?.states.flatMap((state) => state.body).every((instr) => Object.isFrozen(instr))).toBe(true);
    expect(fn.asyncPlan).toEqual(sourcePlan);
    expect(fn.asyncPlan).toEqual(host.functions[0]!.asyncPlan);
    expect(sourceFunction.asyncRuntime).toBeUndefined();
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("keeps global unions separate from exact per-owner host and native attachments", () => {
    const { units } = pairFixture();
    const hostInputs = [irFunction(units[0]!), settleOnlyIrFunction(units[1]!)];
    const hostForward = prepareIrRuntimeManifest({
      functions: hostInputs,
      sourceFile: "/repo/async-plan-consumer-pair.ts",
      policy: { target: "host", backend: "wasmgc" },
    });
    const hostReverse = prepareIrRuntimeManifest({
      functions: [...hostInputs].reverse(),
      sourceFile: "/repo/async-plan-consumer-pair.ts",
      policy: { target: "host", backend: "wasmgc" },
    });
    if (!hostForward || !hostReverse) throw new Error("missing host pair runtime manifest");
    const ownerView = (functions: readonly IrFunction[]) =>
      functions
        .map((fn) => ({
          name: fn.name,
          providers: fn.asyncRuntime?.providers?.map((provider) => provider.id),
          requirements: fn.asyncRuntime?.backendRequirements,
          adapters: fn.asyncRuntime?.adapters.map((adapter) => adapter.capability),
        }))
        .sort((left, right) => left.name.localeCompare(right.name));
    expect(hostReverse.manifest).toEqual(hostForward.manifest);
    expect(ownerView(hostReverse.functions)).toEqual(ownerView(hostForward.functions));
    expect(hostForward.manifest.hostCapabilityRecords).toEqual(ASYNC_HOST_ADAPTERS);
    expect(hostForward.manifest.backendRequirements).toEqual([]);
    expect(hostForward.functions[0]!.asyncRuntime?.adapters).toHaveLength(6);
    expect(hostForward.functions[1]!.asyncRuntime?.adapters).toHaveLength(2);

    const native = prepareIrRuntimeManifest({
      functions: [irFunction(units[0]!), irFunction(units[1]!, false, true)],
      sourceFile: "/repo/async-plan-consumer-pair.ts",
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!native) throw new Error("missing native pair runtime manifest");
    expect(native.manifest.hostCapabilityRecords).toEqual([]);
    expect(native.manifest.backendRequirements).toEqual(RUNTIME_BACKEND_REQUIREMENTS);
    expect(native.functions[0]!.asyncRuntime?.backendRequirements).toEqual(RUNTIME_BACKEND_REQUIREMENTS.slice(0, 2));
    expect(native.functions[1]!.asyncRuntime?.backendRequirements).toEqual(RUNTIME_BACKEND_REQUIREMENTS);
  });

  it("rejects provider, requirement, owner, and attachment-container corruption before allocation", () => {
    const { units } = pairFixture();
    const host = prepareIrRuntimeManifest({
      functions: [irFunction(units[0]!), settleOnlyIrFunction(units[1]!)],
      sourceFile: "/repo/async-plan-consumer-pair.ts",
      policy: { target: "host", backend: "wasmgc" },
    });
    const native = prepareIrRuntimeManifest({
      functions: [irFunction(units[0]!), irFunction(units[1]!, false, true)],
      sourceFile: "/repo/async-plan-consumer-pair.ts",
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!host || !native) throw new Error("missing paired async runtime manifests");
    const hostFull = host.functions[0]!;
    const hostPartial = host.functions[1]!;
    const nativeBase = native.functions[0]!;
    const nativeVoid = native.functions[1]!;
    if (hostFull.asyncRuntime?.kind !== "host-wasmgc" || hostPartial.asyncRuntime?.kind !== "host-wasmgc") {
      throw new Error("missing host runtime attachments");
    }
    if (
      nativeBase.asyncRuntime?.kind !== "standalone-native-wasmgc" ||
      nativeVoid.asyncRuntime?.kind !== "standalone-native-wasmgc"
    ) {
      throw new Error("missing native runtime attachments");
    }

    const rejectHost = (malformed: IrFunction, detail: RegExp): void => {
      const ctx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker);
      const before = allocationShape(ctx);
      expect(() => materializePreparedAsyncHostAdapters(ctx, [malformed])).toThrow(detail);
      expect(allocationShape(ctx)).toEqual(before);
    };
    const rejectNative = (malformed: IrFunction, detail: RegExp): void => {
      const ctx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, { standalone: true });
      const before = allocationShape(ctx);
      expect(() => materializePreparedAsyncHostAdapters(ctx, [malformed])).toThrow(detail);
      expect(allocationShape(ctx)).toEqual(before);
    };

    const hostProviders = hostFull.asyncRuntime.providers;
    const firstProvider = hostProviders[0]!;
    const secondProvider = hostProviders[1]!;
    const providerMutations: readonly (readonly RuntimeProviderDefinition[])[] = [
      Object.freeze(hostProviders.slice(1)),
      Object.freeze([firstProvider, firstProvider, ...hostProviders.slice(2)]),
      Object.freeze([...hostProviders].reverse()),
      Object.freeze([secondProvider, firstProvider, ...hostProviders.slice(2)]),
      Object.freeze([Object.freeze({ ...firstProvider }), ...hostProviders.slice(1)]),
      Object.freeze([Object.freeze({ ...firstProvider, id: secondProvider.id }), ...hostProviders.slice(1)]),
      Object.freeze([Object.freeze({ ...firstProvider, feature: secondProvider.feature }), ...hostProviders.slice(1)]),
      Object.freeze([
        Object.freeze({ ...firstProvider, dependencies: Object.freeze([secondProvider.feature]) }),
        ...hostProviders.slice(1),
      ]),
      Object.freeze([
        Object.freeze({ ...firstProvider, implementation: secondProvider.implementation }),
        ...hostProviders.slice(1),
      ]),
      Object.freeze([
        Object.freeze({ ...firstProvider, supportedTargets: Object.freeze(["standalone"] as const) }),
        ...hostProviders.slice(1),
      ]),
      Object.freeze([
        Object.freeze({ ...firstProvider, supportedBackends: Object.freeze(["linear"] as const) }),
        ...hostProviders.slice(1),
      ]),
      Object.freeze([
        Object.freeze({ ...firstProvider, hostCapabilities: Object.freeze(secondProvider.hostCapabilities) }),
        ...hostProviders.slice(1),
      ]),
    ];
    for (const providers of providerMutations) {
      rejectHost(replaceRuntime(hostFull, { providers }), /exact providers/);
    }
    rejectHost(
      replaceRuntime(hostPartial, { providers: Object.freeze([...hostFull.asyncRuntime.providers]) }),
      /exact providers/,
    );
    rejectHost(
      replaceRuntime(hostFull, { providers: Object.freeze([...nativeBase.asyncRuntime.providers]) }),
      /exact providers/,
    );
    rejectHost(
      replaceRuntime(hostFull, {
        providers: Object.freeze([nativeBase.asyncRuntime.providers[0]!, ...hostProviders.slice(1)]),
      }),
      /exact providers/,
    );

    const nativeRequirements = nativeVoid.asyncRuntime.backendRequirements;
    const requirementMutations: readonly (readonly RuntimeBackendRequirement[])[] = [
      Object.freeze(nativeRequirements.slice(1)),
      Object.freeze([nativeRequirements[0]!, nativeRequirements[0]!, ...nativeRequirements.slice(2)]),
      Object.freeze([...nativeRequirements].reverse()),
      Object.freeze([...nativeRequirements, "async.native.drive"]),
      Object.freeze(["async.native.undefined"]),
      Object.freeze(["async.native.drive", "async.native.undefined"]),
      Object.freeze(["async.native.drive", "async.native.number-boundary", "async.native.unknown"] as never[]),
    ];
    for (const backendRequirements of requirementMutations) {
      rejectNative(replaceRuntime(nativeVoid, { backendRequirements }), /backend-requirement projection/);
    }
    rejectNative(
      replaceRuntime(nativeBase, { backendRequirements: Object.freeze([...RUNTIME_BACKEND_REQUIREMENTS]) }),
      /backend-requirement projection/,
    );
    rejectHost(
      replaceRuntime(hostFull, { backendRequirements: Object.freeze(["async.native.drive"]) }),
      /backend-requirement projection/,
    );

    rejectNative(
      replaceRuntime(nativeBase, {
        kind: "host-wasmgc",
        adapters: hostFull.asyncRuntime.adapters,
      } as Partial<PreparedIrAsyncRuntime>),
      /host runtime outside/,
    );
    rejectHost(
      replaceRuntime(hostFull, {
        kind: "standalone-native-wasmgc",
        adapters: Object.freeze([]),
      } as Partial<PreparedIrAsyncRuntime>),
      /native runtime outside/,
    );

    const clonedPlan = createIrAsyncPlan(hostFull.asyncPlan!);
    rejectHost(
      {
        ...hostFull,
        asyncPlan: clonedPlan,
        asyncRuntime: Object.freeze({ ...hostFull.asyncRuntime, plan: clonedPlan }),
      },
      /authenticated frozen manifest/,
    );
    const driftedPlan = Object.freeze({
      ...hostFull.asyncPlan!,
      runtimeIntents: Object.freeze([...hostFull.asyncPlan!.runtimeIntents, "value.undefined"]),
    }) as IrAsyncPlan;
    rejectHost(
      {
        ...hostFull,
        asyncPlan: driftedPlan,
        asyncRuntime: Object.freeze({ ...hostFull.asyncRuntime, plan: driftedPlan }),
      },
      /authenticated frozen manifest/,
    );
    rejectHost(
      {
        ...hostFull,
        asyncPlan: hostPartial.asyncPlan,
        asyncRuntime: Object.freeze({ ...hostFull.asyncRuntime, plan: hostPartial.asyncPlan }),
      },
      /exact semantic plan owner/,
    );
    const clonedManifest = Object.freeze({ ...host.manifest }) as FrozenRuntimeManifest;
    rejectHost(replaceRuntime(hostFull, { manifest: clonedManifest }), /authenticated frozen manifest/);
    rejectHost(replaceRuntime(hostFull, { manifest: native.manifest }), /authenticated frozen manifest/);

    rejectHost({ ...hostFull, asyncRuntime: { ...hostFull.asyncRuntime } }, /mutable attachment/);
    rejectHost(
      replaceRuntime(hostFull, { providers: [...hostFull.asyncRuntime.providers] }),
      /missing frozen provider/,
    );
    rejectHost(replaceRuntime(hostFull, { backendRequirements: [] }), /missing frozen provider/);
    rejectHost(replaceRuntime(hostFull, { adapters: [...hostFull.asyncRuntime.adapters] }), /mutable attachment/);
    const mutableBody = [...hostFull.asyncRuntime.states[0]!.body];
    rejectHost(
      replaceRuntime(hostFull, {
        states: Object.freeze([
          Object.freeze({ ...hostFull.asyncRuntime.states[0]!, body: mutableBody }),
          ...hostFull.asyncRuntime.states.slice(1),
        ]),
      }),
      /mutable attachment/,
    );
    rejectHost(
      replaceRuntime(hostFull, {
        adapters: Object.freeze([
          { ...hostFull.asyncRuntime.adapters[0]! },
          ...hostFull.asyncRuntime.adapters.slice(1),
        ]),
      }),
      /mutable attachment/,
    );
    rejectHost(
      replaceRuntime(hostFull, {
        typeLayouts: Object.freeze([{ logicalType: F64, layout: {} as never }]),
      }),
      /mutable attachment/,
    );
  });

  it("validates the complete host and native request census before allocating", () => {
    const { units } = pairFixture();
    const host = prepareIrRuntimeManifest({
      functions: units.map((unit) => irFunction(unit)),
      sourceFile: "/repo/async-plan-consumer-pair.ts",
      policy: { target: "host", backend: "wasmgc" },
    });
    const native = prepareIrRuntimeManifest({
      functions: [irFunction(units[0]!), irFunction(units[1]!, false, true)],
      sourceFile: "/repo/async-plan-consumer-pair.ts",
      policy: { target: "standalone", backend: "wasmgc" },
    });
    if (!host || !native) throw new Error("missing paired async runtime manifests");

    const malformedHost = replaceRuntime(host.functions[1]!, {
      providers: Object.freeze(host.functions[1]!.asyncRuntime!.providers!.slice(1)),
    });
    const hostCtx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker);
    const hostBefore = allocationShape(hostCtx);
    expect(() => materializePreparedAsyncHostAdapters(hostCtx, [host.functions[0]!, malformedHost])).toThrow(
      /exact providers/,
    );
    expect(allocationShape(hostCtx)).toEqual(hostBefore);

    const droppedRuntime: IrFunction = { ...host.functions[1]!, asyncRuntime: undefined };
    const droppedCtx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker);
    const droppedBefore = allocationShape(droppedCtx);
    expect(() => materializePreparedAsyncHostAdapters(droppedCtx, [host.functions[0]!, droppedRuntime])).toThrow(
      /no valid async plan owner/,
    );
    expect(allocationShape(droppedCtx)).toEqual(droppedBefore);

    const droppedAuthority: IrFunction = {
      ...host.functions[1]!,
      asyncPlan: undefined,
      asyncRuntime: undefined,
    };
    const droppedAuthorityCtx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker);
    const droppedAuthorityBefore = allocationShape(droppedAuthorityCtx);
    expect(() =>
      materializePreparedAsyncHostAdapters(droppedAuthorityCtx, [host.functions[0]!, droppedAuthority]),
    ).toThrow(/no valid async plan owner/);
    expect(allocationShape(droppedAuthorityCtx)).toEqual(droppedAuthorityBefore);

    const runtimeWithoutPlan: IrFunction = { ...host.functions[1]!, asyncPlan: undefined };
    const orphanCtx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker);
    const orphanBefore = allocationShape(orphanCtx);
    expect(() => materializePreparedAsyncHostAdapters(orphanCtx, [host.functions[0]!, runtimeWithoutPlan])).toThrow(
      /no valid async plan owner/,
    );
    expect(allocationShape(orphanCtx)).toEqual(orphanBefore);

    const malformedNative = replaceRuntime(native.functions[1]!, {
      backendRequirements: Object.freeze(RUNTIME_BACKEND_REQUIREMENTS.slice(0, 2)),
    });
    const nativeCtx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, { standalone: true });
    const nativeBefore = allocationShape(nativeCtx);
    expect(() => materializePreparedAsyncHostAdapters(nativeCtx, [native.functions[0]!, malformedNative])).toThrow(
      /backend-requirement projection/,
    );
    expect(allocationShape(nativeCtx)).toEqual(nativeBefore);

    const strictCtx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, {
      strictNoHostImports: true,
    });
    const strictBefore = allocationShape(strictCtx);
    expect(() => materializePreparedAsyncHostAdapters(strictCtx, host.functions)).toThrow(
      /host runtime on the wrong target/,
    );
    expect(allocationShape(strictCtx)).toEqual(strictBefore);

    const linearCtx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, { target: "linear" });
    const linearBefore = allocationShape(linearCtx);
    expect(() => materializePreparedAsyncHostAdapters(linearCtx, host.functions)).toThrow(
      /host runtime on the wrong target/,
    );
    expect(allocationShape(linearCtx)).toEqual(linearBefore);

    const nativeFirstHostCtx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker, {
      semanticProviders: "native-first",
    });
    materializePreparedAsyncHostAdapters(nativeFirstHostCtx, host.functions);
    expect(nativeFirstHostCtx.mod.imports).toHaveLength(ASYNC_HOST_ADAPTERS.length);
  });

  it("requires native drive reservation before frame lowering and resolves it without lazy allocation", () => {
    const { unit } = fixture("-native-drive-reservation");
    const fn = prepareForTarget(irFunction(unit), "standalone").functions[0]!;
    const module = createEmptyModule();
    module.types.push({ kind: "func", params: [{ kind: "externref" }], results: [{ kind: "externref" }] });
    const existing = { name: fn.name, typeIdx: 0, locals: [], body: [], exported: true };
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, { standalone: true });
    const before = allocationShape(ctx);
    expect(() =>
      lowerPreparedIrAsyncFunction(
        ctx,
        fn,
        {
          resolveFunc: () => {
            throw new Error("native runtime must not resolve a host function");
          },
        },
        existing,
      ),
    ).toThrow(/native drive runtime was not reserved/);
    expect(allocationShape(ctx)).toEqual(before);
    expect(() => getPreparedAsyncDrivePromiseTypeIdx(ctx)).toThrow(/not reserved/);

    materializePreparedAsyncHostAdapters(ctx, [fn]);
    const promiseTypeIdx = getPreparedAsyncDrivePromiseTypeIdx(ctx);
    expect(promiseTypeIdx).toBeGreaterThanOrEqual(0);
    expect(module.types[promiseTypeIdx]).toMatchObject({ kind: "struct", name: "$Promise" });
  });

  it("preserves frozen attachment evidence across the trusted extern-state copy-on-write pass", () => {
    const { unit } = fixture("-extern-transform");
    const fn = prepare(externStateIrFunction(unit)).functions[0]!;
    expect(fn.asyncRuntime?.states[1]!.body[0]).not.toHaveProperty("provider");

    const attached = attachIrExternSupport(fn);
    expect(attached.asyncRuntime?.states[1]!.body[0]).toMatchObject({
      kind: "extern.new",
      provider: { binding: { kind: "import", module: "env", field: "Intl_ListFormat_new" } },
    });
    expect(Object.isFrozen(attached.asyncRuntime)).toBe(true);
    expect(Object.isFrozen(attached.asyncRuntime?.states)).toBe(true);
    expect(attached.asyncRuntime?.states.every((state) => Object.isFrozen(state))).toBe(true);
    expect(attached.asyncRuntime?.states.every((state) => Object.isFrozen(state.body))).toBe(true);
    expect(Object.isFrozen(attached.asyncRuntime?.states[1]!.body[0])).toBe(true);
    expect(() =>
      assertPreparedIrAsyncRuntimeCurrent(attached.unitId, attached.name, attached.asyncPlan, attached.asyncRuntime),
    ).not.toThrow();

    const mutable: IrFunction = {
      ...attached,
      asyncRuntime: {
        ...attached.asyncRuntime!,
        states: [...attached.asyncRuntime!.states],
      },
    };
    const ctx = createCodegenContext(createEmptyModule(), {} as ts.TypeChecker);
    const before = allocationShape(ctx);
    expect(() => materializePreparedAsyncHostAdapters(ctx, [mutable])).toThrow(/mutable attachment/);
    expect(allocationShape(ctx)).toEqual(before);
  });

  it("keeps backend consumers free of semantic-intent and global-provider rediscovery", () => {
    for (const relative of ["../src/codegen/ir-async-runtime-adapters.ts", "../src/codegen/ir-async-frame.ts"]) {
      const source = readFileSync(new URL(relative, import.meta.url), "utf8");
      expect(source, relative).not.toContain(["runtime", "Intents"].join(""));
      expect(source, relative).not.toContain(["ASYNC", "RUNTIME", "PROVIDERS"].join("_"));
      if (relative.endsWith("ir-async-frame.ts")) expect(source, relative).not.toContain("ensureAsyncDriveRuntime");
    }
  });

  it("materializes, reuses, and Program-ABI-plans all six imports before component sealing", () => {
    const { inventory, unit } = fixture();
    const module = createEmptyModule();
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const prepared = prepare(irFunction(unit));

    const functions = [prepared.functions[0]!];
    materializePreparedAsyncHostAdapters(ctx, functions);
    const typeCount = module.types.length;
    materializePreparedAsyncHostAdapters(ctx, functions);

    expect(module.imports.map((imported) => `${imported.module}.${imported.name}`)).toEqual(
      ASYNC_HOST_ADAPTERS.map((adapter) => `${adapter.module}.${adapter.field}`),
    );
    expect(module.imports).toHaveLength(6);
    expect(module.types).toHaveLength(typeCount);

    const planned = planProgramAbiCallableImports(ctx);
    expect(planned.size).toBe(6);
    const report = derivePreparedComponentDependencies({
      module: { functions },
      terminalUnitIds: new Set([unit.id]),
      inventory,
      abi: {
        get: (id) => session.getDraft(id),
        bindingIdsForStructuralReference: (key) => session.bindingIdsForStructuralReference(key),
      },
    });
    expect(report.components[0]?.status).toBe("complete");
    expect(
      report.components[0]?.externalCallables.map((dependency) => dependency.structuralReferenceKey).sort(),
    ).toEqual(
      functions[0]!.asyncRuntime!.adapters.map((adapter) => irCallableBindingKey(adapter.target.binding)).sort(),
    );
    expect(report.components[0]?.externalCallables.every((dependency) => dependency.programAbiBindingId !== null)).toBe(
      true,
    );
  });

  it("rejects dropped, duplicated, substituted, cloned, or cross-wired records before allocation", () => {
    const { unit } = fixture("-poison");
    const prepared = prepare(irFunction(unit));
    const fn = prepared.functions[0]!;
    if (fn.asyncRuntime?.kind !== "host-wasmgc") throw new Error("missing host async runtime");
    const adapters = fn.asyncRuntime.adapters;

    const reject = (mutated: readonly (typeof adapters)[number][], detail: RegExp): void => {
      const module = createEmptyModule();
      const ctx = createCodegenContext(module, {} as ts.TypeChecker);
      const typeCount = module.types.length;
      const malformed: IrFunction = {
        ...fn,
        asyncRuntime: Object.freeze({ ...fn.asyncRuntime!, adapters: Object.freeze(mutated) }),
      };
      expect(() => materializePreparedAsyncHostAdapters(ctx, [malformed])).toThrow(detail);
      expect(module.imports).toEqual([]);
      expect(module.types).toHaveLength(typeCount);
    };

    const first = adapters[0]!;
    const second = adapters[1]!;
    reject(adapters.slice(1), /has 5 adapters; expected 6/);
    reject([first, first, ...adapters.slice(2)], /detached adapter/);
    reject([...adapters].reverse(), /detached adapter/);
    reject([Object.freeze({ ...first, record: second.record }), ...adapters.slice(1)], /detached adapter/);
    reject([Object.freeze({ ...first, capability: second.capability }), ...adapters.slice(1)], /detached adapter/);
    reject([Object.freeze({ ...first, target: second.target }), ...adapters.slice(1)], /detached adapter/);
    reject(
      [
        Object.freeze({
          ...first,
          record: {
            ...first.record,
            params: [...first.record.params],
            results: [...first.record.results],
          } as AsyncHostAdapter,
        }),
        ...adapters.slice(1),
      ],
      /not the canonical catalog record/,
    );
  });

  it("keeps import order and Program-ABI dependencies stable under function input traversal reordering", () => {
    const { inventory, units } = pairFixture();
    const prepared = prepareIrRuntimeManifest({
      functions: units.map((unit) => irFunction(unit)),
      sourceFile: "/repo/async-plan-consumer-pair.ts",
      policy: { target: "host", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("missing paired async runtime manifest");
    const functions = [...prepared.functions].reverse().map((fn) => {
      if (fn.asyncRuntime?.kind !== "host-wasmgc") throw new Error("missing paired host runtime");
      return fn;
    });
    const module = createEmptyModule();
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);

    materializePreparedAsyncHostAdapters(ctx, functions);
    planProgramAbiCallableImports(ctx);
    expect(module.imports.map((entry) => `${entry.module}.${entry.name}`)).toEqual(
      ASYNC_HOST_ADAPTERS.map((record) => `${record.module}.${record.field}`),
    );

    const report = derivePreparedComponentDependencies({
      module: { functions },
      terminalUnitIds: new Set(units.map((unit) => unit.id)),
      inventory,
      abi: {
        get: (id) => session.getDraft(id),
        bindingIdsForStructuralReference: (key) => session.bindingIdsForStructuralReference(key),
      },
    });
    const expectedDependencies = ASYNC_HOST_ADAPTERS.map((record) =>
      irCallableBindingKey({ kind: "import", module: record.module, field: record.field }),
    ).sort();
    expect(report.components).toHaveLength(2);
    for (const component of report.components) {
      expect(component.status).toBe("complete");
      expect(component.externalCallables.map((entry) => entry.structuralReferenceKey).sort()).toEqual(
        expectedDependencies,
      );
    }
  });

  it("scans semantic async states instead of the discarded pre-transform await block", () => {
    const { inventory, unit } = fixture("-discarded-block");
    const module = createEmptyModule();
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const prepared = prepare(withDiscardedAwaitBlock(irFunction(unit)));

    materializePreparedAsyncHostAdapters(ctx, prepared.functions);
    planProgramAbiCallableImports(ctx);
    const report = derivePreparedComponentDependencies({
      module: { functions: prepared.functions },
      terminalUnitIds: new Set([unit.id]),
      inventory,
      abi: {
        get: (id) => session.getDraft(id),
        bindingIdsForStructuralReference: (key) => session.bindingIdsForStructuralReference(key),
      },
    });
    expect(report.components[0]).toMatchObject({ status: "complete", failures: [] });
    expect(report.components[0]?.externalCallables).toHaveLength(ASYNC_HOST_ADAPTERS.length);

    const ordinary = {
      ...prepared.functions[0]!,
      funcKind: "regular" as const,
      asyncPlan: undefined,
      asyncRuntime: undefined,
    };
    const control = derivePreparedComponentDependencies({
      module: { functions: [ordinary] },
      terminalUnitIds: new Set([unit.id]),
      inventory,
      abi: {
        get: (id) => session.getDraft(id),
        bindingIdsForStructuralReference: (key) => session.bindingIdsForStructuralReference(key),
      },
    });
    expect(control.components[0]?.status).toBe("blocked");
    expect(control.components[0]?.failures).toEqual([
      expect.objectContaining({
        code: "implicit-support-reference-unavailable",
        detail: expect.stringContaining("await resolves async runtime support"),
      }),
    ]);
  });

  it("fails closed on owner drift and unavailable target policies", () => {
    const first = fixture();
    const second = fixture("-other");
    const wrongOwner = { ...irFunction(first.unit), asyncPlan: asyncPlan(second.unit) };
    expect(() => prepare(wrongOwner)).toThrow(/owner mismatch/);

    expect(() =>
      prepareIrRuntimeManifest({
        functions: [irFunction(first.unit)],
        sourceFile: "/repo/async-plan-consumer.ts",
        policy: { target: "strict-no-host", backend: "wasmgc" },
      }),
    ).toThrowError(expect.objectContaining<RuntimeManifestInvariantError>({ code: "provider-target-unavailable" }));

    const malformedModule = createEmptyModule();
    malformedModule.types.push({ kind: "func", params: [{ kind: "f64" }], results: [] });
    malformedModule.imports.push({
      module: "env",
      name: "Promise_resolve",
      desc: { kind: "func", typeIdx: 0 },
    });
    const malformedCtx = createCodegenContext(malformedModule, {} as ts.TypeChecker);
    expect(() => materializePreparedAsyncHostAdapters(malformedCtx, prepare(irFunction(first.unit)).functions)).toThrow(
      /signature outside the frozen catalogue/,
    );
  });
});
