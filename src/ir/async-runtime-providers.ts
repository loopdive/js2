// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Closed semantic runtime vocabulary for an IR async suspension plan.
 *
 * Plans mention only these requirements. Concrete host import spellings live
 * below this boundary in the capability catalogue, where manifest closure can
 * validate and deduplicate them before any backend starts emitting code.
 */
import type { RuntimeProviderDefinition, RuntimeProviderImplementation } from "./runtime-manifest.js";

export const ASYNC_RUNTIME_FEATURES = Object.freeze([
  "promise.capability.create",
  "promise.react",
  "promise.resolve",
  "promise.settle.fulfill",
  "promise.settle.reject",
  "scheduler.drain",
  "scheduler.enqueue",
] as const);

export type AsyncRuntimeFeature = (typeof ASYNC_RUNTIME_FEATURES)[number];

const ASYNC_RUNTIME_FEATURE_SET: ReadonlySet<string> = new Set(ASYNC_RUNTIME_FEATURES);

export function isAsyncRuntimeFeature(value: string): value is AsyncRuntimeFeature {
  return ASYNC_RUNTIME_FEATURE_SET.has(value);
}

export const ASYNC_HOST_CAPABILITY_IDS = Object.freeze([
  "async.callback.wrap",
  "async.promise.capability.create",
  "async.promise.react",
  "async.promise.resolve",
  "async.promise.settle.fulfill",
  "async.promise.settle.reject",
] as const);

export type AsyncHostCapabilityId = (typeof ASYNC_HOST_CAPABILITY_IDS)[number];

export type AsyncHostAdapterValueType = "externref" | "i32";

/** Concrete adapter data, deliberately separate from the semantic manifest. */
export interface AsyncHostAdapter {
  readonly capability: AsyncHostCapabilityId;
  readonly module: "env";
  readonly field: string;
  readonly kind: "func";
  readonly params: readonly AsyncHostAdapterValueType[];
  readonly results: readonly AsyncHostAdapterValueType[];
}

function adapter(
  capability: AsyncHostCapabilityId,
  field: string,
  params: readonly AsyncHostAdapterValueType[],
  results: readonly AsyncHostAdapterValueType[],
): AsyncHostAdapter {
  return Object.freeze({
    capability,
    module: "env",
    field,
    kind: "func",
    params: Object.freeze([...params]),
    results: Object.freeze([...results]),
  });
}

/** Exact host adapter surface consumed by the existing async frame engine. */
export const ASYNC_HOST_ADAPTERS: readonly AsyncHostAdapter[] = Object.freeze([
  adapter("async.callback.wrap", "__make_callback", ["i32", "externref"], ["externref"]),
  adapter("async.promise.capability.create", "Promise_new_pending", [], ["externref"]),
  adapter("async.promise.react", "Promise_then2", ["externref", "externref", "externref"], ["externref"]),
  adapter("async.promise.resolve", "Promise_resolve", ["externref"], ["externref"]),
  adapter("async.promise.settle.fulfill", "Promise_settle_resolve", ["externref", "externref"], ["externref"]),
  adapter("async.promise.settle.reject", "Promise_settle_reject", ["externref", "externref"], ["externref"]),
]);

function capabilities(...ids: readonly AsyncHostCapabilityId[]): readonly AsyncHostCapabilityId[] {
  return Object.freeze([...ids].sort());
}

export const ASYNC_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.promise.capability.create",
  "host.promise.react",
  "host.promise.resolve",
  "host.promise.settle.fulfill",
  "host.promise.settle.reject",
  "host.scheduler.drain",
  "host.scheduler.enqueue",
] as const);

export type AsyncRuntimeProviderId = (typeof ASYNC_RUNTIME_PROVIDER_IDS)[number];

const HOST_TARGET = Object.freeze(["host"] as const);
const WASMGC_BACKEND = Object.freeze(["wasmgc"] as const);
const NO_DEPENDENCIES = Object.freeze([] as const);
const NO_HOST_CAPABILITIES = Object.freeze([] as const);
const HOST_CAPABILITY_IMPLEMENTATION: RuntimeProviderImplementation = Object.freeze({
  kind: "host-capability",
});
const HOST_MANAGED_IMPLEMENTATION: RuntimeProviderImplementation = Object.freeze({
  kind: "host-managed",
  service: "promise-job-queue",
});

function provider(
  id: AsyncRuntimeProviderId,
  feature: AsyncRuntimeFeature,
  hostCapabilities: readonly AsyncHostCapabilityId[],
  implementation: RuntimeProviderImplementation,
): RuntimeProviderDefinition {
  return Object.freeze({
    id,
    feature,
    dependencies: NO_DEPENDENCIES,
    hostCapabilities,
    supportedTargets: HOST_TARGET,
    supportedBackends: WASMGC_BACKEND,
    implementation,
  });
}

/**
 * Host-WasmGC catalogue for the first async runtime slice. The two scheduler
 * requirements use the host Promise job queue and therefore add no import.
 */
export const ASYNC_RUNTIME_PROVIDERS: readonly RuntimeProviderDefinition[] = Object.freeze([
  provider(
    "host.promise.capability.create",
    "promise.capability.create",
    capabilities("async.promise.capability.create"),
    HOST_CAPABILITY_IMPLEMENTATION,
  ),
  provider(
    "host.promise.react",
    "promise.react",
    capabilities("async.callback.wrap", "async.promise.react"),
    HOST_CAPABILITY_IMPLEMENTATION,
  ),
  provider(
    "host.promise.resolve",
    "promise.resolve",
    capabilities("async.promise.resolve"),
    HOST_CAPABILITY_IMPLEMENTATION,
  ),
  provider(
    "host.promise.settle.fulfill",
    "promise.settle.fulfill",
    capabilities("async.promise.settle.fulfill"),
    HOST_CAPABILITY_IMPLEMENTATION,
  ),
  provider(
    "host.promise.settle.reject",
    "promise.settle.reject",
    capabilities("async.promise.settle.reject"),
    HOST_CAPABILITY_IMPLEMENTATION,
  ),
  provider("host.scheduler.drain", "scheduler.drain", NO_HOST_CAPABILITIES, HOST_MANAGED_IMPLEMENTATION),
  provider("host.scheduler.enqueue", "scheduler.enqueue", NO_HOST_CAPABILITIES, HOST_MANAGED_IMPLEMENTATION),
]);
