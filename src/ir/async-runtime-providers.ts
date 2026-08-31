// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Closed semantic runtime vocabulary for an IR async suspension plan.
 *
 * Plans mention only these requirements. Concrete host import spellings live
 * below this boundary in the capability catalogue, where manifest closure can
 * validate and deduplicate them before any backend starts emitting code.
 */
import {
  assertCanonicalRuntimeHostCapabilityRecord,
  assertRuntimeHostCapabilityRecord,
  HOST_CALLBACK_EXCEPTION_POLICY,
  resolveRuntimeHostCapabilityRecord,
  RUNTIME_HOST_CAPABILITY_RECORDS,
  type HostCallbackExceptionPolicy,
  type RuntimeHostCapabilityRecord,
} from "./runtime-host-capabilities.js";
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

export const ASYNC_OPTIONAL_RUNTIME_FEATURES = Object.freeze(["value.undefined"] as const);

export type AsyncRuntimeFeature =
  | (typeof ASYNC_RUNTIME_FEATURES)[number]
  | (typeof ASYNC_OPTIONAL_RUNTIME_FEATURES)[number];

const ASYNC_RUNTIME_FEATURE_SET: ReadonlySet<string> = new Set([
  ...ASYNC_RUNTIME_FEATURES,
  ...ASYNC_OPTIONAL_RUNTIME_FEATURES,
]);

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
  "async.value.undefined",
] as const);

export type AsyncHostCapabilityId = (typeof ASYNC_HOST_CAPABILITY_IDS)[number];

const ASYNC_HOST_CAPABILITY_ID_SET: ReadonlySet<string> = new Set(ASYNC_HOST_CAPABILITY_IDS);

export function isAsyncHostCapabilityId(value: string): value is AsyncHostCapabilityId {
  return ASYNC_HOST_CAPABILITY_ID_SET.has(value);
}

/**
 * (#3526 F1-S1) The async projection keeps this NARROWED value-type union on
 * purpose. `materializePreparedAsyncHostAdapters` maps every non-`i32` row to
 * externref, so admitting the central `f64` rows here would silently mislower
 * the number-boundary records. Never re-export the widened central union under
 * an async name.
 */
export type AsyncHostAdapterValueType = "externref" | "i32";

/**
 * Exception policy at the host reaction boundary. A compiled throw crosses
 * that boundary as a WebAssembly.Exception carrying the original JS value in
 * this module's exception tag. The host Promise must observe that value, not
 * the Wasm carrier. Foreign tags and runtime traps are deliberately excluded.
 */
export const ASYNC_CALLBACK_EXCEPTION_POLICY = HOST_CALLBACK_EXCEPTION_POLICY;
export type AsyncCallbackExceptionPolicy = HostCallbackExceptionPolicy;

/** Exact concrete capability record selected by the frozen semantic manifest. */
export type AsyncHostAdapter = RuntimeHostCapabilityRecord<AsyncHostCapabilityId, AsyncHostAdapterValueType>;

/**
 * Narrow one central record to the async projection. Fails closed on a
 * non-async capability and on any value type the async materializer cannot
 * represent, so the narrowing can never become a silent cast.
 */
export function asAsyncHostAdapter(value: RuntimeHostCapabilityRecord): AsyncHostAdapter {
  if (!isAsyncHostCapabilityId(value.capability)) {
    throw new Error(`host capability ${value.capability} is not an async capability`);
  }
  for (const entry of [...value.params, ...value.results]) {
    if (entry !== "externref" && entry !== "i32") {
      throw new Error(`async host capability ${value.capability} cannot carry value type ${entry}`);
    }
  }
  return value as AsyncHostAdapter;
}

/**
 * The async-only projection of the central catalogue. These are the SAME
 * frozen objects, so canonical-identity guards accept either view.
 */
export const ASYNC_HOST_CAPABILITY_RECORDS: readonly AsyncHostAdapter[] = Object.freeze(
  RUNTIME_HOST_CAPABILITY_RECORDS.filter((entry) => isAsyncHostCapabilityId(entry.capability)).map(asAsyncHostAdapter),
);

/** Validate one record against the central closed ABI, then narrow it. */
export function assertAsyncHostCapabilityRecord(value: unknown): asserts value is AsyncHostAdapter {
  assertRuntimeHostCapabilityRecord(value);
  asAsyncHostAdapter(value);
}

/** Authenticate that an attached record is the exact factory-created object. */
export function assertCanonicalAsyncHostCapabilityRecord(value: unknown): asserts value is AsyncHostAdapter {
  assertCanonicalRuntimeHostCapabilityRecord(value);
  asAsyncHostAdapter(value);
}

/** Resolve one selected async ID from an already validated catalog, fail-closed. */
export function resolveAsyncHostCapabilityRecord(
  records: readonly RuntimeHostCapabilityRecord[],
  capability: AsyncHostCapabilityId,
): AsyncHostAdapter {
  return asAsyncHostAdapter(resolveRuntimeHostCapabilityRecord(records, capability));
}

/** Mandatory and optional compatibility projections share the same records. */
export const ASYNC_HOST_ADAPTERS: readonly AsyncHostAdapter[] = Object.freeze(
  ASYNC_HOST_CAPABILITY_RECORDS.filter((record) => record.capability !== "async.value.undefined"),
);

export const ASYNC_OPTIONAL_HOST_ADAPTERS: readonly AsyncHostAdapter[] = Object.freeze(
  ASYNC_HOST_CAPABILITY_RECORDS.filter((record) => record.capability === "async.value.undefined"),
);

function capabilities(...ids: readonly AsyncHostCapabilityId[]): readonly AsyncHostCapabilityId[] {
  return Object.freeze([...ids].sort());
}

export const ASYNC_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.promise.capability.create",
  "host.promise.react",
  "host.promise.resolve",
  "host.promise.settle.fulfill",
  "host.promise.settle.reject",
  "host.value.undefined",
  "host.scheduler.drain",
  "host.scheduler.enqueue",
  "native.promise.capability.create",
  "native.promise.react",
  "native.promise.resolve",
  "native.promise.settle.fulfill",
  "native.promise.settle.reject",
  "native.scheduler.drain",
  "native.scheduler.enqueue",
  "native.value.undefined",
] as const);

export type AsyncRuntimeProviderId = (typeof ASYNC_RUNTIME_PROVIDER_IDS)[number];

const HOST_TARGET = Object.freeze(["host"] as const);
const STANDALONE_TARGET = Object.freeze(["standalone"] as const);
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
const NATIVE_MANAGED_IMPLEMENTATION: RuntimeProviderImplementation = Object.freeze({
  kind: "native-managed",
  service: "native-promise-runtime",
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

function nativeProvider(id: AsyncRuntimeProviderId, feature: AsyncRuntimeFeature): RuntimeProviderDefinition {
  return Object.freeze({
    id,
    feature,
    dependencies: NO_DEPENDENCIES,
    hostCapabilities: NO_HOST_CAPABILITIES,
    supportedTargets: STANDALONE_TARGET,
    supportedBackends: WASMGC_BACKEND,
    implementation: NATIVE_MANAGED_IMPLEMENTATION,
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
    "host.value.undefined",
    "value.undefined",
    capabilities("async.value.undefined"),
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
  nativeProvider("native.promise.capability.create", "promise.capability.create"),
  nativeProvider("native.promise.react", "promise.react"),
  nativeProvider("native.promise.resolve", "promise.resolve"),
  nativeProvider("native.promise.settle.fulfill", "promise.settle.fulfill"),
  nativeProvider("native.promise.settle.reject", "promise.settle.reject"),
  nativeProvider("native.scheduler.drain", "scheduler.drain"),
  nativeProvider("native.scheduler.enqueue", "scheduler.enqueue"),
  nativeProvider("native.value.undefined", "value.undefined"),
]);
