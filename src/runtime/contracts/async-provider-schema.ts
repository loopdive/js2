// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import {
  HOST_CALLBACK_EXCEPTION_POLICY,
  type HostCallbackExceptionPolicy,
  type RuntimeHostCapabilityFuncRecord,
} from "./host-capability-schema.js";

export const ASYNC_HOST_CAPABILITY_IDS = Object.freeze([
  "async.callback.wrap",
  "async.exception.caught",
  "async.promise.capability.create",
  "async.promise.react",
  "async.promise.resolve",
  "async.promise.settle.fulfill",
  "async.promise.settle.reject",
  "async.value.undefined",
] as const);

export type AsyncHostCapabilityId = (typeof ASYNC_HOST_CAPABILITY_IDS)[number];

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

/**
 * Exact concrete capability record selected by the frozen semantic manifest.
 *
 * (#3526 F2-S2) Retargeted to the FUNC arm of the now kind-discriminated
 * central record. Every async capability is a callable host import; typing the
 * adapter on the union would have handed `materializePreparedAsyncHostAdapters`
 * a record with no `params`/`results` at all.
 */
export type AsyncHostAdapter = RuntimeHostCapabilityFuncRecord<AsyncHostCapabilityId, AsyncHostAdapterValueType>;

/** Numeric Promise crossings reuse the general number ABI without widening the historical async-only catalogue. */
export type PreparedAsyncHostCapabilityId = AsyncHostCapabilityId | "number.box" | "number.unbox";

export type PreparedAsyncHostAdapter =
  | AsyncHostAdapter
  | RuntimeHostCapabilityFuncRecord<"number.box" | "number.unbox", "f64" | "externref">;

export const ASYNC_RUNTIME_PROVIDER_IDS = Object.freeze([
  "host.promise.capability.create",
  "host.promise.react",
  "host.promise.resolve",
  "host.promise.settle.fulfill",
  "host.promise.settle.reject",
  "host.value.undefined",
  "host.promise.number.bridge",
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
  "native.promise.number.bridge",
] as const);

export type AsyncRuntimeProviderId = (typeof ASYNC_RUNTIME_PROVIDER_IDS)[number];
