// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";

import {
  ASYNC_HOST_ADAPTERS,
  ASYNC_HOST_CAPABILITY_IDS,
  ASYNC_OPTIONAL_RUNTIME_FEATURES,
  ASYNC_RUNTIME_FEATURES,
  ASYNC_RUNTIME_PROVIDERS,
} from "../src/ir/async-runtime-providers.js";
import {
  PURE_MATH_RUNTIME_PROVIDERS,
  RUNTIME_PROVIDERS,
  RuntimeManifestBuilder,
  RuntimeManifestInvariantError,
  type RuntimeBackend,
  type RuntimeFeature,
  type HostCapabilityId,
  type RuntimeProviderDefinition,
  type RuntimeTarget,
} from "../src/ir/runtime-manifest.js";

function builder(target: RuntimeTarget = "host", backend: RuntimeBackend = "wasmgc"): RuntimeManifestBuilder {
  return new RuntimeManifestBuilder({ target, backend });
}

function requestAll(value: RuntimeManifestBuilder, features: readonly RuntimeFeature[]): void {
  for (const feature of features) value.requestFeature(feature);
}

function thrown(code: RuntimeManifestInvariantError["code"]): object {
  return expect.objectContaining<RuntimeManifestInvariantError>({ code });
}

function asyncProviderIdsForTarget(target: RuntimeTarget, features: ReadonlySet<string>): string[] {
  return ASYNC_RUNTIME_PROVIDERS.filter(
    (provider) => provider.supportedTargets.includes(target) && features.has(provider.feature),
  )
    .map((provider) => provider.id)
    .sort();
}

describe("#4103 IR async runtime provider schema", () => {
  it("closes all seven semantic requirements to the exact six existing host imports", () => {
    const forward = builder();
    const reverse = builder();
    requestAll(forward, ASYNC_RUNTIME_FEATURES);
    requestAll(reverse, [...ASYNC_RUNTIME_FEATURES].reverse());

    const manifest = forward.freeze();
    expect(reverse.freeze()).toEqual(manifest);
    expect(manifest.features).toEqual(ASYNC_RUNTIME_FEATURES);
    expect(manifest.providers.map((provider) => provider.id)).toEqual(
      asyncProviderIdsForTarget("host", new Set(ASYNC_RUNTIME_FEATURES)),
    );
    expect(manifest.hostCapabilities).toEqual(
      ASYNC_HOST_CAPABILITY_IDS.filter((capability) => capability !== "async.value.undefined"),
    );
    expect(ASYNC_HOST_ADAPTERS.map((adapter) => adapter.field).sort()).toEqual([
      "Promise_new_pending",
      "Promise_resolve",
      "Promise_settle_reject",
      "Promise_settle_resolve",
      "Promise_then2",
      "__make_callback",
    ]);
    expect(manifest.hostCapabilities).toHaveLength(6);
    expect(new Set(manifest.hostCapabilities)).toHaveLength(6);
    const semanticManifest = JSON.stringify(manifest);
    for (const adapter of ASYNC_HOST_ADAPTERS) {
      expect(semanticManifest).not.toContain(adapter.field);
    }
  });

  it("closes the standalone catalogue to native-managed providers without host capabilities", () => {
    const value = builder("standalone");
    const requested = [...ASYNC_RUNTIME_FEATURES, ...ASYNC_OPTIONAL_RUNTIME_FEATURES];
    requestAll(value, requested);

    const manifest = value.freeze();
    expect(manifest.features).toEqual(requested);
    expect(manifest.providers.map((provider) => provider.id)).toEqual(
      asyncProviderIdsForTarget("standalone", new Set(requested)),
    );
    expect(manifest.providers.map((provider) => provider.implementation)).toEqual(
      manifest.providers.map(() => ({ kind: "native-managed", service: "native-promise-runtime" })),
    );
    expect(manifest.hostCapabilities).toEqual([]);
    expect(manifest.providers).toContainEqual(
      expect.objectContaining({
        id: "native.value.undefined",
        feature: "value.undefined",
        hostCapabilities: [],
      }),
    );
  });

  it("preserves the existing host import signatures and models scheduling without another import", () => {
    expect(ASYNC_HOST_ADAPTERS).toEqual([
      {
        capability: "async.callback.wrap",
        module: "env",
        field: "__make_callback",
        kind: "func",
        params: ["i32", "externref"],
        results: ["externref"],
        exceptionPolicy: "module-tag-payload",
      },
      {
        capability: "async.promise.capability.create",
        module: "env",
        field: "Promise_new_pending",
        kind: "func",
        params: [],
        results: ["externref"],
      },
      {
        capability: "async.promise.react",
        module: "env",
        field: "Promise_then2",
        kind: "func",
        params: ["externref", "externref", "externref"],
        results: ["externref"],
      },
      {
        capability: "async.promise.resolve",
        module: "env",
        field: "Promise_resolve",
        kind: "func",
        params: ["externref"],
        results: ["externref"],
      },
      {
        capability: "async.promise.settle.fulfill",
        module: "env",
        field: "Promise_settle_resolve",
        kind: "func",
        params: ["externref", "externref"],
        results: ["externref"],
      },
      {
        capability: "async.promise.settle.reject",
        module: "env",
        field: "Promise_settle_reject",
        kind: "func",
        params: ["externref", "externref"],
        results: ["externref"],
      },
    ]);
    expect(
      ASYNC_RUNTIME_PROVIDERS.filter(
        (provider) => provider.supportedTargets.includes("host") && provider.feature.startsWith("scheduler."),
      ).map((provider) => provider.implementation),
    ).toEqual([
      { kind: "host-managed", service: "promise-job-queue" },
      { kind: "host-managed", service: "promise-job-queue" },
    ]);
    expect(
      ASYNC_RUNTIME_PROVIDERS.filter(
        (provider) => provider.supportedTargets.includes("host") && provider.feature.startsWith("scheduler."),
      ).flatMap((provider) => provider.hostCapabilities),
    ).toEqual([]);
  });

  it("deduplicates requests and capability closure while keeping Math provider behavior", () => {
    const value = builder();
    value.requestFeature("promise.react");
    value.requestFeature("promise.react");
    value.requestFeature("scheduler.enqueue");
    value.requestFeature("scheduler.drain");
    value.requestFeature("math.sin");
    const manifest = value.freeze();

    expect(manifest.features).toEqual([
      "math.reduce-trig",
      "math.sin",
      "promise.react",
      "scheduler.drain",
      "scheduler.enqueue",
    ]);
    expect(manifest.hostCapabilities).toEqual(["async.callback.wrap", "async.promise.react"]);
    expect(value.resolveProvider("math.sin").implementation).toEqual({ kind: "self-hosted", symbol: "Math_sin" });

    const mathOnlyCatalogue = new RuntimeManifestBuilder(
      { target: "host", backend: "wasmgc" },
      { providers: PURE_MATH_RUNTIME_PROVIDERS },
    );
    mathOnlyCatalogue.requestFeature("math.sin");
    const widenedCatalogue = builder();
    widenedCatalogue.requestFeature("math.sin");
    expect(widenedCatalogue.freeze()).toEqual(mathOnlyCatalogue.freeze());
  });

  it("fails closed for post-freeze requests, missing adapters, no-host policy, and missing providers", () => {
    const frozen = builder();
    frozen.requestFeature("promise.resolve");
    frozen.freeze();
    expect(() => frozen.requestFeature("promise.react")).toThrowError(thrown("manifest-frozen"));
    expect(() => frozen.assertProviderPlanned("host.promise.resolve")).not.toThrow();
    expect(() => frozen.assertProviderPlanned("host.promise.react")).toThrowError(thrown("late-unplanned-provider"));
    expect(() => frozen.assertHostCapabilityPlanned("async.promise.resolve")).not.toThrow();
    expect(() => frozen.assertHostCapabilityPlanned("async.promise.react")).toThrowError(
      thrown("late-unplanned-host-capability"),
    );

    const noHost = builder("strict-no-host");
    noHost.requestFeature("promise.resolve");
    expect(() => noHost.freeze()).toThrowError(thrown("provider-target-unavailable"));

    const missingLinearAdapter = builder("host", "linear");
    missingLinearAdapter.requestFeature("promise.resolve");
    expect(() => missingLinearAdapter.freeze()).toThrowError(thrown("missing-backend-adapter"));

    const missingProvider = new RuntimeManifestBuilder(
      { target: "host", backend: "wasmgc" },
      { providers: RUNTIME_PROVIDERS.filter((provider) => provider.feature !== "promise.resolve") },
    );
    missingProvider.requestFeature("promise.resolve");
    expect(() => missingProvider.freeze()).toThrowError(thrown("missing-runtime-provider"));
  });

  it("rejects unknown requirements and capability IDs", () => {
    expect(() => builder().requestFeature("Promise_resolve" as RuntimeFeature)).toThrowError(
      thrown("unknown-runtime-feature"),
    );

    const providers = RUNTIME_PROVIDERS.map((provider): RuntimeProviderDefinition => {
      if (provider.feature !== "promise.resolve") return provider;
      return {
        ...provider,
        hostCapabilities: ["async.promise.unknown" as HostCapabilityId],
      };
    });
    const altered = new RuntimeManifestBuilder({ target: "host", backend: "wasmgc" }, { providers });
    altered.requestFeature("promise.resolve");
    expect(() => altered.freeze()).toThrowError(thrown("unknown-host-capability"));

    const malformedNativeProviders = RUNTIME_PROVIDERS.map((provider): RuntimeProviderDefinition => {
      if (provider.id !== "native.promise.resolve") return provider;
      return {
        ...provider,
        hostCapabilities: ["async.promise.resolve"],
      };
    });
    const malformedNative = new RuntimeManifestBuilder(
      { target: "standalone", backend: "wasmgc" },
      { providers: malformedNativeProviders },
    );
    malformedNative.requestFeature("promise.resolve");
    expect(() => malformedNative.freeze()).toThrowError(thrown("unknown-host-capability"));
  });

  it("publishes deeply frozen provider and capability records", () => {
    const value = builder();
    value.requestFeature("promise.react");
    const manifest = value.freeze();
    const provider = manifest.providers.find((candidate) => candidate.feature === "promise.react")!;

    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.providers)).toBe(true);
    expect(Object.isFrozen(manifest.hostCapabilities)).toBe(true);
    expect(Object.isFrozen(provider.hostCapabilities)).toBe(true);
    expect(Object.isFrozen(ASYNC_HOST_ADAPTERS[0]!.params)).toBe(true);
    expect(() => (provider.hostCapabilities as string[]).push("async.promise.resolve")).toThrow(TypeError);
  });
});
