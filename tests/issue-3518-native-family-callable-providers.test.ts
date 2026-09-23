// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { createIrSourceId, createIrUnitId } from "../src/ir/identity.js";
import { asBlockId, asValueId, type IrInstr, type IrInstrCall } from "../src/ir/core/nodes.js";
import type { PreparedIrFunction } from "../src/ir/runtime/contracts/prepared.js";
import { createIrAsyncPlan, canonicalPromiseAbi, asAsyncStateId } from "../src/ir/analysis/async-plan.js";
import { ASYNC_RUNTIME_FEATURES } from "../src/ir/core/async-intents.js";
import { irCallableBindingKey, irIntrinsicFuncRef, irRuntimeFuncRef } from "../src/ir/core/callable-bindings.js";
import { prepareIrRuntimeManifest } from "../src/ir/intrinsic-support.js";
import {
  NATIVE_ASYNC_CALLABLE_DECLARATIONS,
  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS,
  collectNativeAsyncCallableDemands,
  assertNativeAsyncCallableDemands,
  assertNativeAsyncRuntimeCallables,
  nativeAsyncProviderMismatch,
  nativeAsyncCallablePolicyMismatch,
} from "../src/ir/runtime/native-async-callables.js";
import { RuntimeManifestBuilder, RUNTIME_PROVIDERS } from "../src/ir/runtime/manifest.js";
import {
  NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES,
  NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,
  STRING_CONCAT_MANY_NATIVE_ARITY,
  type RuntimeProviderDefinition,
} from "../src/ir/runtime/contracts/manifest.js";
import type { RuntimeManifestPolicy } from "../src/runtime/contracts/provider-policy.js";

const POLICY: RuntimeManifestPolicy = {
  target: "standalone",
  backend: "wasmgc",
  stringConst: { storage: "native" },
  stringConcat: { concat: "native" },
};
const HOST: RuntimeManifestPolicy = { target: "host", backend: "wasmgc" };
const sourceId = createIrSourceId({ kind: "entry", order: 0, sourceKey: "logical-fixture.ts" });

// Independent acceptance oracle: never derive expected features, implementations or
// dependency populations from the live declaration/provider catalog under test.
const PROMISE_DEPENDENCY_ORACLE = [
  "promise.capability.create",
  "promise.number.bridge",
  "promise.react",
  "promise.resolve",
  "promise.settle.fulfill",
  "promise.settle.reject",
  "scheduler.drain",
  "scheduler.enqueue",
] as const;
const BINDING_PROVIDER_ORACLE = [
  {
    binding: { kind: "runtime", symbol: "__ir_promise_delay_native" },
    feature: "async.native.delay",
    id: "native.async.delay",
    implementation: { kind: "runtime-callable", symbol: "__ir_promise_delay_native" },
    dependencies: PROMISE_DEPENDENCY_ORACLE,
  },
  {
    binding: { kind: "runtime", symbol: "__ir_async_promise_all_native" },
    feature: "async.native.all",
    id: "native.async.all",
    implementation: { kind: "runtime-callable", symbol: "__ir_async_promise_all_native" },
    dependencies: PROMISE_DEPENDENCY_ORACLE,
  },
  {
    binding: { kind: "intrinsic", symbol: "async.clock.snapshot" },
    feature: "async.native.clock-zero",
    id: "native.async.clock-zero",
    implementation: { kind: "standalone-clock-zero" },
    dependencies: [],
  },
  {
    binding: { kind: "intrinsic", symbol: "async.number.to-string" },
    feature: "async.native.number-to-string",
    id: "native.async.number-to-string",
    implementation: { kind: "runtime-callable", symbol: "__ir_number_toString_native" },
    dependencies: [],
  },
  {
    binding: { kind: "intrinsic", symbol: "async.console.log-string" },
    feature: "async.native.console-append",
    id: "native.async.console-append",
    implementation: { kind: "runtime-callable", symbol: "__stdout_append" },
    dependencies: [],
  },
  {
    binding: { kind: "intrinsic", symbol: "async.string.concat$arity5" },
    feature: "js.string.concat.many",
    id: "native.js.string.concat.many",
    implementation: { kind: "runtime-callable-family", symbolPrefix: "__str_concat_", arity: { min: 3, max: 8 } },
    dependencies: [],
  },
] as const;
type BindingProviderOracle = (typeof BINDING_PROVIDER_ORACLE)[number];

/** Source-free logical controls, not public-source or physical execution witnesses. */
function body(index: number): PreparedIrFunction {
  const declaration = NATIVE_ASYNC_CALLABLE_DECLARATIONS[index]!;
  const params = declaration.params.map((type, ordinal) => ({ name: `p${ordinal}`, value: asValueId(ordinal), type }));
  const result = declaration.results.length ? asValueId(params.length) : null;
  return {
    unitId: createIrUnitId({ sourceId, lexicalOwnerId: null, kind: "function", ordinal: index }),
    name: `logical${index}`,
    params,
    resultTypes: declaration.results,
    exported: true,
    valueCount: params.length + (result === null ? 0 : 1),
    blocks: [
      {
        id: asBlockId(0),
        blockArgs: [],
        blockArgTypes: [],
        instrs: [
          {
            kind: "call",
            target: declaration.ref,
            args: params.map((param) => param.value),
            result,
            resultType: declaration.results[0] ?? null,
          },
        ],
        terminator: { kind: "return", values: result === null ? [] : [result] },
      },
    ],
  };
}

function explicit(functions: readonly PreparedIrFunction[], policy = POLICY) {
  return prepareIrRuntimeManifest({
    functions,
    sourceFile: "logical-fixture.ts",
    policy,
    builtinDemands: collectNativeAsyncCallableDemands(functions),
    includeEmpty: true,
  });
}

function stateOnly(index: 1 | 2): PreparedIrFunction {
  const fn = body(index);
  const call = fn.blocks[0]!.instrs[0] as IrInstrCall;
  const params = fn.params.map(({ value, type }) => ({ value, type }));
  return {
    ...fn,
    funcKind: "async",
    blocks: [],
    asyncPlan: createIrAsyncPlan({
      schemaVersion: 1,
      ownerUnitId: fn.unitId,
      kind: "async-function",
      abi: canonicalPromiseAbi(fn.resultTypes[0]!),
      entry: asAsyncStateId(0),
      params,
      values: [...params, { value: call.result!, type: call.resultType! }],
      spills: [],
      handlers: [],
      states: [{ id: asAsyncStateId(0), body: [call], terminator: { kind: "resolve", value: call.result! } }],
      runtimeIntents: index === 2 ? [...ASYNC_RUNTIME_FEATURES, "promise.number.bridge"] : ASYNC_RUNTIME_FEATURES,
    }),
  };
}

function observeSingleBinding(expected: BindingProviderOracle) {
  const index = NATIVE_ASYNC_CALLABLE_DECLARATIONS.findIndex(
    (entry) => irCallableBindingKey(entry.ref.binding) === irCallableBindingKey(expected.binding),
  );
  expect(index).toBeGreaterThanOrEqual(0);
  const fn = body(index);
  const demands = collectNativeAsyncCallableDemands([fn]);
  expect(demands).toHaveLength(1);
  return {
    declaration: NATIVE_ASYNC_CALLABLE_DECLARATIONS[index]!,
    demand: demands[0]!,
    manifest: explicit([fn]).manifest,
  };
}

function expectSingleBinding(expected: BindingProviderOracle, actual: ReturnType<typeof observeSingleBinding>) {
  expect(actual.declaration.ref.binding).toEqual(expected.binding);
  expect(actual.declaration.feature).toBe(expected.feature);
  expect(actual.demand.uses).toEqual([
    {
      region: "block:0",
      ordinal: 0,
      bindingKey: irCallableBindingKey(expected.binding),
      feature: expected.feature,
    },
  ]);
  expect(actual.manifest.features).toEqual([expected.feature, ...expected.dependencies].sort());
  const selected = actual.manifest.providers.filter((provider) => provider.feature === expected.feature);
  expect(selected).toHaveLength(1);
  expect(selected[0]!.id).toBe(expected.id);
  expect(selected[0]!.implementation).toEqual(expected.implementation);
  expect(selected[0]!.dependencies).toEqual([...expected.dependencies].sort());
  expect(actual.manifest.providers.map((provider) => provider.id).sort()).toEqual(
    [expected.id, ...expected.dependencies.map((feature) => `native.${feature}`)].sort(),
  );
}

describe("independent per-binding feature/provider oracle", () => {
  it.each(BINDING_PROVIDER_ORACLE)("demands only $binding.symbol and its exact dependency closure", (expected) => {
    expectSingleBinding(expected, observeSingleBinding(expected));
  });

  it.each(["declaration", "demand", "manifest"] as const)(
    "detects a number-format/console feature swap in live %s evidence despite the unchanged combined set",
    (boundary) => {
      const expected = [BINDING_PROVIDER_ORACLE[3], BINDING_PROVIDER_ORACLE[4]] as const;
      const observed = expected.map(observeSingleBinding);
      const swapped = observed.map((actual, index) => {
        const other = observed[1 - index]!;
        if (boundary === "declaration")
          return { ...actual, declaration: { ...actual.declaration, feature: other.declaration.feature } };
        if (boundary === "demand")
          return {
            ...actual,
            demand: {
              ...actual.demand,
              uses: actual.demand.uses.map((use) => ({ ...use, feature: other.demand.uses[0]!.feature })),
            },
          };
        return { ...actual, manifest: other.manifest };
      });
      const features = (rows: typeof observed) =>
        rows
          .flatMap((actual) =>
            boundary === "declaration"
              ? [actual.declaration.feature]
              : boundary === "demand"
                ? actual.demand.uses.map((use) => use.feature)
                : actual.manifest.features,
          )
          .sort();
      expect(features(swapped)).toEqual(features(observed));
      for (const [index, row] of expected.entries()) {
        expect(() => expectSingleBinding(row, observed[index]!)).not.toThrow();
        expect(() => expectSingleBinding(row, swapped[index]!)).toThrow();
      }
    },
  );

  it("rejects swapping the two live catalog provider features without changing their population", () => {
    const number = BINDING_PROVIDER_ORACLE[3],
      console = BINDING_PROVIDER_ORACLE[4];
    const providers = RUNTIME_PROVIDERS.map((provider) =>
      provider.id === number.id
        ? { ...provider, feature: console.feature }
        : provider.id === console.id
          ? { ...provider, feature: number.feature }
          : provider,
    );
    expect(providers.map((provider) => provider.feature).sort()).toEqual(
      RUNTIME_PROVIDERS.map((provider) => provider.feature).sort(),
    );
    for (const row of [number, console]) {
      const observed = observeSingleBinding(row);
      const changed = providers.find((provider) => provider.id === row.id)!;
      expect(() =>
        expectSingleBinding(row, { ...observed, manifest: { ...observed.manifest, providers: [changed] } }),
      ).toThrow();
      const builder = new RuntimeManifestBuilder(POLICY, { providers });
      builder.requestFeature(row.feature);
      expect(() => builder.freeze()).toThrow(expect.objectContaining({ code: "provider-signature-mismatch" }));
    }
  });

  it.each(
    [BINDING_PROVIDER_ORACLE[0], BINDING_PROVIDER_ORACLE[1]].flatMap((row) =>
      ["promise.settle.fulfill", "promise.settle.reject"].map((dependency) => ({ row, dependency })),
    ),
  )("rejects removing $dependency from $row.binding.symbol's eight-member dependency set", ({ row, dependency }) => {
    const observed = observeSingleBinding(row);
    expectSingleBinding(row, observed);
    expect(row.dependencies).toHaveLength(8);
    const original = observed.manifest.providers.find((provider) => provider.id === row.id)!;
    const changed = { ...original, dependencies: original.dependencies.filter((feature) => feature !== dependency) };
    expect(changed.dependencies).toHaveLength(7);
    const providers = observed.manifest.providers.map((provider) => (provider.id === row.id ? changed : provider));
    expect(() => expectSingleBinding(row, { ...observed, manifest: { ...observed.manifest, providers } })).toThrow();
    const builder = new RuntimeManifestBuilder(POLICY, {
      providers: RUNTIME_PROVIDERS.map((provider) => (provider.id === row.id ? changed : provider)),
    });
    builder.requestFeature(row.feature);
    expect(() => builder.freeze()).toThrow(expect.objectContaining({ code: "provider-signature-mismatch" }));
  });
});

describe("explicit native-family manifest demand", () => {
  it("has exactly five provider features, while concat reuses the existing family", () => {
    expect(NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES).toHaveLength(5);
    expect(NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS.map((provider) => provider.id)).toEqual(
      NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDER_IDS,
    );
    for (const feature of NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES) expect(ASYNC_RUNTIME_FEATURES).not.toContain(feature);
    const manifest = explicit(NATIVE_ASYNC_CALLABLE_DECLARATIONS.map((_, index) => body(index))).manifest;
    for (const feature of [...NATIVE_ASYNC_CALLABLE_RUNTIME_FEATURES, "js.string.concat.many"])
      expect(manifest.features).toContain(feature);
    expect(manifest.providers.filter((provider) => provider.feature === "js.string.concat.many")).toHaveLength(1);
    expect(manifest.providers.find((provider) => provider.feature === "js.string.concat.many")?.implementation).toEqual(
      { kind: "runtime-callable-family", symbolPrefix: "__str_concat_", arity: STRING_CONCAT_MANY_NATIVE_ARITY },
    );
    expect(
      manifest.providers.find((provider) => provider.feature === "async.native.number-to-string")?.implementation,
    ).toEqual({ kind: "runtime-callable", symbol: "__ir_number_toString_native" });
    expect(
      manifest.providers.find((provider) => provider.feature === "async.native.console-append")?.implementation,
    ).toEqual({ kind: "runtime-callable", symbol: "__stdout_append" });
  });

  it("finds ordinary delay without any frame or async attachment", () => {
    const fn = body(0),
      runtime = explicit([fn]);
    expect(fn.asyncPlan).toBeUndefined();
    expect(runtime.functions[0]!.asyncRuntime).toBeUndefined();
    expect(runtime.manifest.features).toContain("async.native.delay");
    for (const feature of ["promise.resolve", "promise.number.bridge", "scheduler.enqueue", "scheduler.drain"])
      expect(runtime.manifest.features).toContain(feature);
    expect(runtime.manifest.backendRequirements).toContain("async.native.number-boundary");
    // No host capability here is not evidence that a timer-service import is unnecessary.
    expect(runtime.manifest.hostCapabilities).toEqual([]);
  });

  it.each(NATIVE_ASYNC_CALLABLE_DECLARATIONS.map((entry, index) => [entry.ref.name, index] as const))(
    "does not automatically demand %s in the historical host scanner",
    (_, index) => {
      expect(
        prepareIrRuntimeManifest({ functions: [body(index)], sourceFile: "logical-fixture.ts", policy: HOST }),
      ).toBeUndefined();
    },
  );

  it("keeps automatic ReferenceError demand active", () => {
    const fn = body(1),
      param = fn.params[0]!;
    const extern = { kind: "val", val: { kind: "externref" } } as const;
    const old: PreparedIrFunction = {
      ...fn,
      params: [{ ...param, type: extern }],
      blocks: [
        {
          ...fn.blocks[0]!,
          instrs: [
            {
              kind: "call",
              target: irRuntimeFuncRef("__new_ReferenceError"),
              args: [param.value],
              result: asValueId(1),
              resultType: extern,
            },
          ],
        },
      ],
    };
    expect(
      prepareIrRuntimeManifest({ functions: [old], sourceFile: "logical-fixture.ts", policy: HOST })!.manifest.features,
    ).toEqual(["error.reference.construct"]);
  });

  it.each([
    { ...POLICY, target: "host" },
    { ...POLICY, target: "wasi" },
    { ...POLICY, target: "strict-no-host" },
    { ...POLICY, backend: "linear" },
    { ...POLICY, stringConst: undefined },
    { ...POLICY, stringConst: { storage: "host" } },
  ] satisfies RuntimeManifestPolicy[])("rejects incompatible explicit native policy %j", (policy) => {
    expect(() => explicit([body(0)], policy)).toThrow(
      expect.objectContaining({ code: "provider-target-unavailable", requestedFeature: "async.native.delay" }),
    );
  });

  it("requires concat's native policy without requiring the optimization batching switch", () => {
    expect(nativeAsyncCallablePolicyMismatch("js.string.concat.many", POLICY)).toBeUndefined();
    for (const concat of ["host", "unsupported"] as const)
      expect(() => explicit([body(5)], { ...POLICY, stringConcat: { concat } })).toThrow("native concatenation");
    expect(explicit([body(5)], { ...POLICY, stringConcatMany: { batch: "off" } }).manifest.features).toContain(
      "js.string.concat.many",
    );
  });

  it("retains nested occurrence positions and a full owner denominator, including empty owners", () => {
    const fn = body(0),
      blank = { ...body(1), blocks: [] };
    const nested: PreparedIrFunction = {
      ...fn,
      params: [...fn.params, { name: "cond", value: asValueId(50), type: { kind: "val", val: { kind: "i32" } } }],
      blocks: [
        { ...fn.blocks[0]!, instrs: [{ kind: "if.stmt", cond: asValueId(50), then: fn.blocks[0]!.instrs, else: [] }] },
      ],
    };
    const demands = collectNativeAsyncCallableDemands([nested, blank]);
    expect(demands).toHaveLength(2);
    expect(demands[0]!.uses).toMatchObject([{ region: "block:0", ordinal: 1, feature: "async.native.delay" }]);
    expect(demands[1]!.uses).toEqual([]);
    expect(() => assertNativeAsyncCallableDemands([nested, blank], demands)).not.toThrow();
    expect(Object.isFrozen(demands[0]!.uses[0])).toBe(true);
  });

  it.each(["missing-owner", "duplicate-owner", "missing-use", "foreign-position", "foreign-feature"])(
    "rejects incomplete or stale explicit demands: %s",
    (mutation) => {
      const functions = [body(0), body(1)],
        canonical = collectNativeAsyncCallableDemands(functions);
      const demands = [...canonical];
      if (mutation === "missing-owner") demands.pop();
      if (mutation === "duplicate-owner") demands[1] = canonical[0]!;
      if (mutation === "missing-use") demands[0] = { ...canonical[0]!, uses: [] };
      if (mutation === "foreign-position")
        demands[0] = { ...canonical[0]!, uses: [{ ...canonical[0]!.uses[0]!, ordinal: 2 }] };
      if (mutation === "foreign-feature")
        demands[0] = { ...canonical[0]!, uses: [{ ...canonical[0]!.uses[0]!, feature: "async.native.all" }] };
      expect(() =>
        prepareIrRuntimeManifest({
          functions,
          sourceFile: "logical-fixture.ts",
          policy: POLICY,
          builtinDemands: demands,
        }),
      ).toThrow();
      expect(() => assertNativeAsyncCallableDemands(functions, canonical)).not.toThrow();
    },
  );

  it("validates actual signatures on re-scan, not just the demand's feature spelling", () => {
    const fn = body(0),
      demands = collectNativeAsyncCallableDemands([fn]);
    const call = fn.blocks[0]!.instrs[0] as IrInstrCall;
    const changed = {
      ...fn,
      blocks: [
        { ...fn.blocks[0]!, instrs: [{ ...call, resultType: { kind: "val", val: { kind: "externref" } } } as IrInstr] },
      ],
    };
    expect(() => assertNativeAsyncCallableDemands([changed], demands)).toThrow("result differs");
  });

  it("does not certify a lifted closure target by recognizing its runtime name", () => {
    const fn = body(0),
      signature = { params: [], returnType: null };
    const closure: IrInstr = {
      kind: "closure.new",
      liftedFunc: NATIVE_ASYNC_CALLABLE_DECLARATIONS[0]!.ref,
      signature,
      captures: [],
      captureFieldTypes: [],
      result: asValueId(10),
      resultType: { kind: "closure", signature },
    };
    expect(() =>
      collectNativeAsyncCallableDemands([{ ...fn, blocks: [{ ...fn.blocks[0]!, instrs: [closure] }] }]),
    ).toThrow("not a lifted closure body");
  });

  it("reconciles selected semantic-state builtin calls without extending frame intents", () => {
    const fn = stateOnly(1),
      before = fn.asyncPlan!.runtimeIntents;
    const runtime = explicit([fn]),
      attached = runtime.functions[0]!;
    expect(runtime.manifest.features).toContain("async.native.all");
    expect(attached.asyncPlan!.runtimeIntents).toEqual(before);
    expect(attached.asyncRuntime!.providers!.some((provider) => provider.feature === "async.native.all")).toBe(false);
    expect(attached.asyncRuntime!.providers!.every((provider) => runtime.manifest.providers.includes(provider))).toBe(
      true,
    );
    expect(() => assertNativeAsyncRuntimeCallables(attached)).not.toThrow();
    const state = attached.asyncRuntime!.states[0]!;
    expect(() =>
      assertNativeAsyncRuntimeCallables({
        ...attached,
        asyncRuntime: { ...attached.asyncRuntime!, states: [{ ...state, body: [] }] },
      }),
    ).toThrow("occurrence differs");
  });

  it("authenticates the clock's exact state-local zero projection without a callable provider", () => {
    const fn = stateOnly(2),
      runtime = explicit([fn]),
      attached = runtime.functions[0]!;
    const provider = runtime.manifest.providers.find((entry) => entry.feature === "async.native.clock-zero")!;
    expect(provider.implementation).toEqual({ kind: "standalone-clock-zero" });
    expect(provider.signature).toBeUndefined();
    const state = attached.asyncRuntime!.states[0]!;
    expect(state.body[0]).toMatchObject({ kind: "const", value: { kind: "f64", value: 0 }, result: asValueId(0) });
    expect(() => assertNativeAsyncRuntimeCallables(attached)).not.toThrow();
    for (const replacement of [
      fn.asyncPlan!.states[0]!.body[0]!,
      { ...state.body[0]!, kind: "const", value: { kind: "f64", value: 1 } } as IrInstr,
      { ...state.body[0]!, result: asValueId(99) },
    ])
      expect(() =>
        assertNativeAsyncRuntimeCallables({
          ...attached,
          asyncRuntime: { ...attached.asyncRuntime!, states: [{ ...state, body: [replacement] }] },
        }),
      ).toThrow("exact zero projection");
  });

  it.each(["dependencies", "signature", "implementation", "targets", "foreign-clock"])(
    "rejects tampered provider rows: %s",
    (mutation) => {
      const original = NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS[0]!;
      let changed: RuntimeProviderDefinition = original;
      if (mutation === "dependencies") changed = { ...original, dependencies: [] };
      if (mutation === "signature")
        changed = { ...original, signature: { version: 1, params: [], result: { kind: "val", val: { kind: "f64" } } } };
      if (mutation === "implementation")
        changed = { ...original, implementation: { kind: "runtime-callable", symbol: "foreign" } };
      if (mutation === "targets") changed = { ...original, supportedTargets: ["host", "standalone"] };
      if (mutation === "foreign-clock")
        changed = {
          ...RUNTIME_PROVIDERS.find((provider) => provider.id === "native.js.string.concat.many")!,
          implementation: { kind: "standalone-clock-zero" },
        };
      expect(nativeAsyncProviderMismatch(changed)).toBeDefined();
      const builder = new RuntimeManifestBuilder(POLICY, {
        providers: RUNTIME_PROVIDERS.map((provider) => (provider.id === changed.id ? changed : provider)),
      });
      builder.requestFeature("async.native.delay");
      expect(() => builder.freeze()).toThrow(expect.objectContaining({ code: "provider-signature-mismatch" }));
    },
  );

  it("does not create a fallback when a provider is missing or duplicated", () => {
    const delay = NATIVE_ASYNC_CALLABLE_RUNTIME_PROVIDERS[0]!;
    for (const providers of [
      RUNTIME_PROVIDERS.filter((provider) => provider.id !== delay.id),
      [...RUNTIME_PROVIDERS, delay],
    ]) {
      const builder = new RuntimeManifestBuilder(POLICY, { providers });
      builder.requestFeature("async.native.delay");
      expect(() => builder.freeze()).toThrow();
    }
    const invalid = {
      ...body(0),
      blocks: [
        {
          ...body(0).blocks[0]!,
          instrs: [
            {
              ...(body(0).blocks[0]!.instrs[0] as IrInstrCall),
              target: irIntrinsicFuncRef("__ir_promise_delay_native"),
            },
          ],
        },
      ],
    };
    expect(collectNativeAsyncCallableDemands([invalid])[0]!.uses).toEqual([]);
  });
});
