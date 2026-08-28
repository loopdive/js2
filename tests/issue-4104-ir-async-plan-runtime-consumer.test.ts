// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import { createCodegenContext } from "../src/codegen/context/create-context.js";
import { materializePreparedAsyncHostAdapters } from "../src/codegen/ir-async-runtime-adapters.js";
import { planProgramAbiCallableImports } from "../src/codegen/program-abi-import-planning.js";
import { ProgramAbiSession } from "../src/codegen/program-abi-session.js";
import { asAsyncStateId, canonicalPromiseAbi, createIrAsyncPlan, type IrAsyncPlan } from "../src/ir/async-plan.js";
import {
  ASYNC_HOST_ADAPTERS,
  ASYNC_HOST_CAPABILITY_RECORDS,
  ASYNC_RUNTIME_FEATURES,
  type AsyncHostAdapter,
} from "../src/ir/async-runtime-providers.js";
import { irCallableBindingKey } from "../src/ir/callable-bindings.js";
import { buildIrUnitInventory, type IrTerminalUnitRecord } from "../src/ir/identity.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import { asBlockId, asValueId, irVal, type IrFunction } from "../src/ir/nodes.js";
import { derivePreparedComponentDependencies } from "../src/ir/prepared-component-dependencies.js";
import { RuntimeManifestInvariantError } from "../src/ir/runtime-manifest.js";
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
    expect(verifyIrFunction(fn)).toEqual([]);
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
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("attaches the standalone native runtime without changing the target-neutral semantic plan", () => {
    const { unit } = fixture("-standalone");
    const sourceFunction = irFunction(unit);
    const sourcePlan = sourceFunction.asyncPlan;
    const host = prepareForTarget(sourceFunction, "host");
    const standalone = prepareForTarget(sourceFunction, "standalone");
    const fn = standalone.functions[0]!;

    expect(standalone.manifest.policy).toEqual({ target: "standalone", backend: "wasmgc" });
    expect(standalone.manifest.features).toEqual(ASYNC_RUNTIME_FEATURES);
    expect(standalone.manifest.hostCapabilities).toEqual([]);
    expect(standalone.manifest.hostCapabilityRecords).toEqual([]);
    expect(standalone.manifest.providers.every((provider) => provider.implementation.kind === "native-managed")).toBe(
      true,
    );
    expect(fn.asyncRuntime).toMatchObject({ kind: "standalone-native-wasmgc", adapters: [] });
    expect(fn.asyncPlan).toEqual(sourcePlan);
    expect(fn.asyncPlan).toEqual(host.functions[0]!.asyncPlan);
    expect(sourceFunction.asyncRuntime).toBeUndefined();
    expect(verifyIrFunction(fn)).toEqual([]);
  });

  it("materializes, reuses, and Program-ABI-plans all six imports before component sealing", () => {
    const { inventory, unit } = fixture();
    const module = createEmptyModule();
    const session = new ProgramAbiSession(inventory, module);
    const ctx = createCodegenContext(module, {} as ts.TypeChecker, undefined, session);
    const prepared = prepare(irFunction(unit));

    const reversed = [
      {
        ...prepared.functions[0]!,
        asyncRuntime: Object.freeze({
          ...prepared.functions[0]!.asyncRuntime!,
          adapters: Object.freeze([...prepared.functions[0]!.asyncRuntime!.adapters].reverse()),
        }),
      },
    ];
    materializePreparedAsyncHostAdapters(ctx, reversed);
    const typeCount = module.types.length;
    materializePreparedAsyncHostAdapters(ctx, reversed);

    expect(module.imports.map((imported) => `${imported.module}.${imported.name}`)).toEqual(
      ASYNC_HOST_ADAPTERS.map((adapter) => `${adapter.module}.${adapter.field}`),
    );
    expect(module.imports).toHaveLength(6);
    expect(module.types).toHaveLength(typeCount);

    const planned = planProgramAbiCallableImports(ctx);
    expect(planned.size).toBe(6);
    const report = derivePreparedComponentDependencies({
      module: { functions: reversed },
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
      reversed[0]!.asyncRuntime!.adapters.map((adapter) => irCallableBindingKey(adapter.target.binding)).sort(),
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
    reject(adapters.slice(1), /frozen adapter records/);
    reject([first, first, ...adapters.slice(2)], /repeats adapter/);
    reject([{ ...first, record: second.record }, ...adapters.slice(1)], /carries record/);
    reject([{ ...first, capability: second.capability }, ...adapters.slice(1)], /carries record/);
    reject([{ ...first, target: second.target }, ...adapters.slice(1)], /frozen import projection/);
    reject(
      [
        {
          ...first,
          record: {
            ...first.record,
            params: [...first.record.params],
            results: [...first.record.results],
          } as AsyncHostAdapter,
        },
        ...adapters.slice(1),
      ],
      /not the canonical catalog record/,
    );
  });

  it("keeps import order and Program-ABI dependencies stable under function and attachment reordering", () => {
    const { inventory, units } = pairFixture();
    const prepared = prepareIrRuntimeManifest({
      functions: units.map((unit) => irFunction(unit)),
      sourceFile: "/repo/async-plan-consumer-pair.ts",
      policy: { target: "host", backend: "wasmgc" },
    });
    if (!prepared) throw new Error("missing paired async runtime manifest");
    const functions = [...prepared.functions].reverse().map((fn) => {
      if (fn.asyncRuntime?.kind !== "host-wasmgc") throw new Error("missing paired host runtime");
      return {
        ...fn,
        asyncRuntime: Object.freeze({
          ...fn.asyncRuntime,
          adapters: Object.freeze([...fn.asyncRuntime.adapters].reverse()),
        }),
      };
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
