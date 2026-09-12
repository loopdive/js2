// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

// Compatibility exports retain the canonical implementation and authority identities.

export {
  ASYNC_HOST_CAPABILITY_IDS,
  ASYNC_CALLBACK_EXCEPTION_POLICY,
  ASYNC_RUNTIME_PROVIDER_IDS,
  ASYNC_RUNTIME_FEATURES,
  ASYNC_OPTIONAL_RUNTIME_FEATURES,
  isAsyncRuntimeFeature,
  isAsyncHostCapabilityId,
  asAsyncHostAdapter,
  ASYNC_HOST_CAPABILITY_RECORDS,
  assertAsyncHostCapabilityRecord,
  assertCanonicalAsyncHostCapabilityRecord,
  resolveAsyncHostCapabilityRecord,
  isPreparedAsyncHostCapabilityId,
  asPreparedAsyncHostAdapter,
  assertCanonicalPreparedAsyncHostCapabilityRecord,
  ASYNC_HOST_ADAPTERS,
  ASYNC_OPTIONAL_HOST_ADAPTERS,
  ASYNC_RUNTIME_PROVIDERS,
} from "./runtime/async-providers.js";
export type {
  AsyncHostCapabilityId,
  AsyncHostAdapterValueType,
  AsyncCallbackExceptionPolicy,
  AsyncHostAdapter,
  PreparedAsyncHostCapabilityId,
  PreparedAsyncHostAdapter,
  AsyncRuntimeProviderId,
  AsyncRuntimeFeature,
} from "./runtime/async-providers.js";
