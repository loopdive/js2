// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Closed semantic runtime vocabulary for an IR async suspension plan.
 *
 * Plans mention only these requirements. Concrete host import spellings live
 * below this boundary in the capability catalogue, where manifest closure can
 * validate and deduplicate them before any backend starts emitting code.
 */

export const ASYNC_RUNTIME_FEATURES = Object.freeze([
  "promise.capability.create",
  "promise.react",
  "promise.resolve",
  "promise.settle.fulfill",
  "promise.settle.reject",
  "scheduler.drain",
  "scheduler.enqueue",
] as const);

export const ASYNC_OPTIONAL_RUNTIME_FEATURES = Object.freeze(["value.undefined", "promise.number.bridge"] as const);

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
