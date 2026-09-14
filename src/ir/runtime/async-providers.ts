// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { ASYNC_HOST_CAPABILITY_IDS } from "../../runtime/contracts/async-provider-schema.js";
import type {
  AsyncHostCapabilityId,
  AsyncHostAdapter,
  PreparedAsyncHostCapabilityId,
  PreparedAsyncHostAdapter,
  AsyncRuntimeProviderId,
} from "../../runtime/contracts/async-provider-schema.js";
export {
  ASYNC_HOST_CAPABILITY_IDS,
  ASYNC_CALLBACK_EXCEPTION_POLICY,
  ASYNC_RUNTIME_PROVIDER_IDS,
} from "../../runtime/contracts/async-provider-schema.js";
export type {
  AsyncHostCapabilityId,
  AsyncHostAdapterValueType,
  AsyncCallbackExceptionPolicy,
  AsyncHostAdapter,
  PreparedAsyncHostCapabilityId,
  PreparedAsyncHostAdapter,
  AsyncRuntimeProviderId,
} from "../../runtime/contracts/async-provider-schema.js";

import {
  asCallableRuntimeHostCapabilityRecord,
  assertCanonicalRuntimeHostCapabilityRecord,
  assertRuntimeHostCapabilityRecord,
  resolveRuntimeHostCapabilityRecord,
  RUNTIME_HOST_CAPABILITY_RECORDS,
  type RuntimeHostCapabilityRecord,
} from "./host-capabilities.js";
import type { RuntimeProviderDefinition, RuntimeProviderImplementation } from "./contracts/manifest.js";

import type { AsyncRuntimeFeature } from "../core/async-intents.js";
export {
  ASYNC_RUNTIME_FEATURES,
  ASYNC_OPTIONAL_RUNTIME_FEATURES,
  isAsyncRuntimeFeature,
} from "../core/async-intents.js";
export type { AsyncRuntimeFeature } from "../core/async-intents.js";

const ASYNC_HOST_CAPABILITY_ID_SET: ReadonlySet<string> = new Set(ASYNC_HOST_CAPABILITY_IDS);

export function isAsyncHostCapabilityId(value: string): value is AsyncHostCapabilityId {
  return ASYNC_HOST_CAPABILITY_ID_SET.has(value);
}

/**
 * Narrow one central record to the async projection. Fails closed on a
 * non-async capability, on a non-callable KIND, and on any value type the
 * async materializer cannot represent, so the narrowing can never become a
 * silent cast.
 */
export function asAsyncHostAdapter(value: RuntimeHostCapabilityRecord): AsyncHostAdapter {
  if (!isAsyncHostCapabilityId(value.capability)) {
    throw new Error(`host capability ${value.capability} is not an async capability`);
  }
  // (#3526 F2-S2) BEFORE the value-type walk: a global record has no `params`
  // or `results` to walk, so the kind guard is what makes the loop total.
  const callable = asCallableRuntimeHostCapabilityRecord(value);
  for (const entry of [...callable.params, ...callable.results]) {
    if (entry !== "externref" && entry !== "i32") {
      throw new Error(`async host capability ${value.capability} cannot carry value type ${entry}`);
    }
  }
  return callable as AsyncHostAdapter;
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

export function isPreparedAsyncHostCapabilityId(value: string): value is PreparedAsyncHostCapabilityId {
  return isAsyncHostCapabilityId(value) || value === "number.box" || value === "number.unbox";
}

export function asPreparedAsyncHostAdapter(value: RuntimeHostCapabilityRecord): PreparedAsyncHostAdapter {
  if (isAsyncHostCapabilityId(value.capability)) return asAsyncHostAdapter(value);
  if (value.capability !== "number.box" && value.capability !== "number.unbox") {
    throw new Error(`host capability ${value.capability} is not a prepared Promise adapter`);
  }
  assertRuntimeHostCapabilityRecord(value);
  return asCallableRuntimeHostCapabilityRecord(value) as PreparedAsyncHostAdapter;
}

export function assertCanonicalPreparedAsyncHostCapabilityRecord(
  value: unknown,
): asserts value is PreparedAsyncHostAdapter {
  assertCanonicalRuntimeHostCapabilityRecord(value);
  asPreparedAsyncHostAdapter(value);
}

/** Mandatory and optional compatibility projections share the same records. */
export const ASYNC_HOST_ADAPTERS: readonly AsyncHostAdapter[] = Object.freeze(
  ASYNC_HOST_CAPABILITY_RECORDS.filter((record) => record.capability !== "async.value.undefined"),
);

export const ASYNC_OPTIONAL_HOST_ADAPTERS: readonly AsyncHostAdapter[] = Object.freeze(
  ASYNC_HOST_CAPABILITY_RECORDS.filter((record) => record.capability === "async.value.undefined"),
);

function capabilities(...ids: readonly PreparedAsyncHostCapabilityId[]): readonly PreparedAsyncHostCapabilityId[] {
  return Object.freeze([...ids].sort());
}

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
  hostCapabilities: readonly PreparedAsyncHostCapabilityId[],
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
    capabilities("async.exception.caught", "async.promise.capability.create"),
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
  provider(
    "host.promise.number.bridge",
    "promise.number.bridge",
    capabilities("number.box", "number.unbox"),
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
  nativeProvider("native.promise.number.bridge", "promise.number.bridge"),
]);
