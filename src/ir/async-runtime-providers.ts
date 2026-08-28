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

export type AsyncHostAdapterValueType = "externref" | "i32";

/**
 * Exception policy at the host reaction boundary. A compiled throw crosses
 * that boundary as a WebAssembly.Exception carrying the original JS value in
 * this module's exception tag. The host Promise must observe that value, not
 * the Wasm carrier. Foreign tags and runtime traps are deliberately excluded.
 */
export const ASYNC_CALLBACK_EXCEPTION_POLICY = "module-tag-payload" as const;
export type AsyncCallbackExceptionPolicy = typeof ASYNC_CALLBACK_EXCEPTION_POLICY;

/** Exact concrete capability record selected by the frozen semantic manifest. */
export interface AsyncHostAdapter {
  readonly capability: AsyncHostCapabilityId;
  readonly module: "env";
  readonly field: string;
  readonly kind: "func";
  readonly params: readonly AsyncHostAdapterValueType[];
  readonly results: readonly AsyncHostAdapterValueType[];
  readonly exceptionPolicy?: AsyncCallbackExceptionPolicy;
}

function adapter(
  capability: AsyncHostCapabilityId,
  field: string,
  params: readonly AsyncHostAdapterValueType[],
  results: readonly AsyncHostAdapterValueType[],
  exceptionPolicy?: AsyncCallbackExceptionPolicy,
): AsyncHostAdapter {
  return Object.freeze({
    capability,
    module: "env",
    field,
    kind: "func",
    params: Object.freeze([...params]),
    results: Object.freeze([...results]),
    ...(exceptionPolicy === undefined ? {} : { exceptionPolicy }),
  });
}

/**
 * The sole closed authority for async host capability ABI. Every projection
 * below retains these exact factory-created records; no consumer may rebuild
 * one from a capability ID or emitted import spelling.
 */
export const ASYNC_HOST_CAPABILITY_RECORDS: readonly AsyncHostAdapter[] = Object.freeze([
  adapter(
    "async.callback.wrap",
    "__make_callback",
    ["i32", "externref"],
    ["externref"],
    ASYNC_CALLBACK_EXCEPTION_POLICY,
  ),
  adapter("async.promise.capability.create", "Promise_new_pending", [], ["externref"]),
  adapter("async.promise.react", "Promise_then2", ["externref", "externref", "externref"], ["externref"]),
  adapter("async.promise.resolve", "Promise_resolve", ["externref"], ["externref"]),
  adapter("async.promise.settle.fulfill", "Promise_settle_resolve", ["externref", "externref"], ["externref"]),
  adapter("async.promise.settle.reject", "Promise_settle_reject", ["externref", "externref"], ["externref"]),
  adapter("async.value.undefined", "__get_undefined", [], ["externref"]),
]);

const ASYNC_HOST_CAPABILITY_BY_ID: ReadonlyMap<AsyncHostCapabilityId, AsyncHostAdapter> = new Map(
  ASYNC_HOST_CAPABILITY_RECORDS.map((record) => [record.capability, record] as const),
);
const CANONICAL_ASYNC_HOST_CAPABILITY_RECORDS: ReadonlySet<AsyncHostAdapter> = new Set(ASYNC_HOST_CAPABILITY_RECORDS);

function compareCapabilityRecords(left: AsyncHostAdapter, right: AsyncHostAdapter): number {
  return left.capability < right.capability ? -1 : left.capability > right.capability ? 1 : 0;
}

function describeRecord(value: unknown): string {
  if (value && typeof value === "object" && "capability" in value) return String(value.capability);
  return String(value);
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(record).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(
      `async host capability ${describeRecord(record)} keys ${actual.join(",")} do not match ${canonical.join(",")}`,
    );
  }
}

function assertAdapterValueTypes(
  value: unknown,
  expected: readonly AsyncHostAdapterValueType[],
  field: "params" | "results",
  capability: AsyncHostCapabilityId,
): void {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((entry, index) => entry !== expected[index])
  ) {
    throw new Error(
      `async host capability ${capability} ${field} ${JSON.stringify(value)} do not match ${JSON.stringify(expected)}`,
    );
  }
}

/**
 * Validate one record structurally and against the exact closed ABI. This is
 * intentionally separate from the identity guard so malformed test catalogues
 * produce a precise preparation-time invariant rather than looking canonical.
 */
export function assertAsyncHostCapabilityRecord(value: unknown): asserts value is AsyncHostAdapter {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`async host capability record must be a plain object, got ${String(value)}`);
  }
  const record = value as Record<string, unknown>;
  if (Object.getPrototypeOf(record) !== Object.prototype) {
    throw new Error(`async host capability ${describeRecord(record)} must be a plain object`);
  }
  const capability = record.capability;
  if (typeof capability !== "string" || !ASYNC_HOST_CAPABILITY_ID_SET.has(capability)) {
    throw new Error(`unknown async host capability ${String(capability)}`);
  }
  const id = capability as AsyncHostCapabilityId;
  const expected = ASYNC_HOST_CAPABILITY_BY_ID.get(id);
  if (!expected) throw new Error(`async host capability ${id} has no canonical record`);
  const keys = ["capability", "field", "kind", "module", "params", "results"];
  if (expected.exceptionPolicy !== undefined) keys.push("exceptionPolicy");
  assertExactKeys(record, keys);
  if (record.module !== expected.module) {
    throw new Error(`async host capability ${id} module ${String(record.module)} does not match ${expected.module}`);
  }
  if (record.field !== expected.field) {
    throw new Error(`async host capability ${id} field ${String(record.field)} does not match ${expected.field}`);
  }
  if (record.kind !== expected.kind) {
    throw new Error(`async host capability ${id} kind ${String(record.kind)} does not match ${expected.kind}`);
  }
  assertAdapterValueTypes(record.params, expected.params, "params", id);
  assertAdapterValueTypes(record.results, expected.results, "results", id);
  if (record.exceptionPolicy !== expected.exceptionPolicy) {
    throw new Error(
      `async host capability ${id} exception policy ${String(record.exceptionPolicy)} does not match ${String(expected.exceptionPolicy)}`,
    );
  }
}

/** Authenticate that an attached record is the exact factory-created object. */
export function assertCanonicalAsyncHostCapabilityRecord(value: unknown): asserts value is AsyncHostAdapter {
  assertAsyncHostCapabilityRecord(value);
  if (!CANONICAL_ASYNC_HOST_CAPABILITY_RECORDS.has(value)) {
    throw new Error(`async host capability ${value.capability} is not the canonical catalog record`);
  }
}

/** Validate, canonicalize traversal order, and retain the exact record objects. */
export function canonicalizeAsyncHostCapabilityCatalog(
  records: readonly AsyncHostAdapter[],
): readonly AsyncHostAdapter[] {
  if (!Array.isArray(records)) throw new Error("async host capability catalog must be an array");
  const seen = new Set<AsyncHostCapabilityId>();
  for (const record of records) {
    assertCanonicalAsyncHostCapabilityRecord(record);
    if (seen.has(record.capability)) {
      throw new Error(`async host capability catalog duplicates ${record.capability}`);
    }
    seen.add(record.capability);
  }
  const missing = ASYNC_HOST_CAPABILITY_IDS.filter((capability) => !seen.has(capability));
  if (missing.length > 0 || records.length !== ASYNC_HOST_CAPABILITY_IDS.length) {
    throw new Error(`async host capability catalog is incomplete; missing ${missing.join(",") || "none"}`);
  }
  return Object.freeze([...records].sort(compareCapabilityRecords));
}

/** Resolve one selected ID from an already validated catalog, fail-closed. */
export function resolveAsyncHostCapabilityRecord(
  records: readonly AsyncHostAdapter[],
  capability: AsyncHostCapabilityId,
): AsyncHostAdapter {
  const record = records.find((candidate) => candidate.capability === capability);
  if (!record) throw new Error(`async host capability catalog does not define ${capability}`);
  assertCanonicalAsyncHostCapabilityRecord(record);
  return record;
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
