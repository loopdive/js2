// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { IrUnitId } from "../../shared/contracts/ir-identity.js";
import type { IrAsyncPlan, IrAsyncState } from "../core/async-plan.js";
import type { IrInstr } from "../core/nodes.js";
import { isAsyncRuntimeFeature, type AsyncRuntimeFeature } from "../core/async-intents.js";
import { irImportFuncRef, sameIrCallableBinding } from "../core/callable-bindings.js";
import type {
  PreparedIrAsyncRuntime,
  CurrentPreparedIrAsyncRuntime,
  PreparedIrAsyncRuntimeInput,
} from "./contracts/prepared.js";
import type { FrozenRuntimeManifest, RuntimeProviderDefinition } from "./contracts/manifest.js";
import { ASYNC_HOST_ADAPTERS, assertCanonicalPreparedAsyncHostCapabilityRecord } from "./async-providers.js";
import { asCallableRuntimeHostCapabilityRecord } from "./host-capabilities.js";
import { projectRuntimeBackendRequirements } from "./manifest.js";

const preparedManifestByPlan = new WeakMap<IrAsyncPlan, FrozenRuntimeManifest>();

function runtimeAttachmentError(owner: string, detail: string): never {
  throw new Error(`IR async runtime attachment for ${owner} ${detail}`);
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function expectedAsyncProviders(
  owner: string,
  plan: IrAsyncPlan,
  manifest: FrozenRuntimeManifest,
): readonly RuntimeProviderDefinition[] {
  const intents = new Set<AsyncRuntimeFeature>();
  for (const intent of plan.runtimeIntents) {
    if (!isAsyncRuntimeFeature(intent) || intents.has(intent)) {
      runtimeAttachmentError(owner, `has an unknown or duplicated semantic intent ${String(intent)}`);
    }
    intents.add(intent);
  }
  const providers = manifest.providers.filter((provider) => intents.has(provider.feature as AsyncRuntimeFeature));
  if (
    providers.length !== intents.size ||
    providers.some((provider) => !intents.has(provider.feature as AsyncRuntimeFeature))
  ) {
    runtimeAttachmentError(owner, "does not have one exact manifest provider per semantic intent");
  }
  return providers;
}

function assertFrozenProvider(owner: string, provider: RuntimeProviderDefinition): void {
  if (
    !Object.isFrozen(provider) ||
    !Object.isFrozen(provider.dependencies) ||
    !Object.isFrozen(provider.hostCapabilities) ||
    !Object.isFrozen(provider.supportedTargets) ||
    !Object.isFrozen(provider.supportedBackends) ||
    !Object.isFrozen(provider.implementation)
  ) {
    runtimeAttachmentError(owner, `carries mutable provider ${provider.id}`);
  }
}

/** Freeze one attached state body in place without cloning symbolic IR identities. */
function freezePreparedIrAsyncStateBody(body: readonly IrInstr[]): readonly IrInstr[] {
  const seen = new WeakSet<object>();
  const freezeValue = (value: unknown): void => {
    if (value === null || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor) freezeValue(descriptor.value);
    }
    Object.freeze(value);
  };
  freezeValue(body);
  return body;
}

function isPreparedIrAsyncStateBodyFrozen(body: readonly IrInstr[]): boolean {
  const seen = new WeakSet<object>();
  const isFrozen = (value: unknown): boolean => {
    if (value === null || typeof value !== "object" || seen.has(value)) return true;
    seen.add(value);
    if (!Object.isFrozen(value)) return false;
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor && "value" in descriptor && !isFrozen(descriptor.value)) return false;
    }
    return true;
  };
  return isFrozen(body);
}

function sealPreparedIrAsyncStates(states: readonly IrAsyncState[]): readonly IrAsyncState[] {
  let changed = !Object.isFrozen(states);
  const sealed = states.map((state) => {
    const body = freezePreparedIrAsyncStateBody(state.body);
    if (Object.isFrozen(state) && body === state.body) return state;
    changed = true;
    return Object.freeze({ ...state, body });
  });
  return changed ? Object.freeze(sealed) : states;
}

/**
 * Prove that one backend attachment is the exact current decision for its
 * semantic owner. This is deliberately allocation-free and is shared by every
 * codegen consumer before it reserves imports, types, helpers, or globals.
 */
export function assertPreparedIrAsyncRuntimeCurrent(
  ownerUnitId: IrUnitId,
  ownerName: string,
  plan: IrAsyncPlan | undefined,
  runtime: PreparedIrAsyncRuntime | undefined,
): CurrentPreparedIrAsyncRuntime {
  if (!plan || !runtime) runtimeAttachmentError(ownerName, "is incomplete");
  if (runtime.plan !== plan || plan.ownerUnitId !== ownerUnitId) {
    runtimeAttachmentError(ownerName, "does not retain its exact semantic plan owner");
  }
  const manifest = runtime.manifest;
  if (!manifest || preparedManifestByPlan.get(plan) !== manifest) {
    runtimeAttachmentError(ownerName, "does not retain its authenticated frozen manifest");
  }
  if (
    !Object.isFrozen(runtime) ||
    !Object.isFrozen(runtime.states) ||
    runtime.states.some((state) => !Object.isFrozen(state) || !isPreparedIrAsyncStateBodyFrozen(state.body)) ||
    !Object.isFrozen(runtime.adapters) ||
    runtime.adapters.some((adapter) => !Object.isFrozen(adapter)) ||
    (runtime.typeLayouts !== undefined &&
      (!Object.isFrozen(runtime.typeLayouts) || runtime.typeLayouts.some((entry) => !Object.isFrozen(entry)))) ||
    !Object.isFrozen(plan) ||
    !Object.isFrozen(manifest) ||
    !Object.isFrozen(manifest.policy) ||
    !Object.isFrozen(manifest.providers) ||
    !Object.isFrozen(manifest.hostCapabilityRecords) ||
    !Object.isFrozen(manifest.backendRequirements)
  ) {
    runtimeAttachmentError(ownerName, "contains mutable attachment, plan, or manifest state");
  }
  const providers = runtime.providers;
  const requirements = runtime.backendRequirements;
  if (!providers || !requirements || !Object.isFrozen(providers) || !Object.isFrozen(requirements)) {
    runtimeAttachmentError(ownerName, "is missing frozen provider or backend-requirement evidence");
  }
  const expectedProviders = expectedAsyncProviders(ownerName, plan, manifest);
  if (
    providers.length !== expectedProviders.length ||
    providers.some((provider, index) => provider !== expectedProviders[index])
  ) {
    runtimeAttachmentError(ownerName, "does not retain exact providers in canonical manifest order");
  }
  for (const provider of providers) {
    assertFrozenProvider(ownerName, provider);
    if (
      !provider.supportedTargets.includes(manifest.policy.target) ||
      !provider.supportedBackends.includes(manifest.policy.backend) ||
      provider.dependencies.some((feature) => !manifest.features.includes(feature)) ||
      provider.hostCapabilities.some((capability) => !manifest.hostCapabilities.includes(capability))
    ) {
      runtimeAttachmentError(ownerName, `carries detached provider ${provider.id}`);
    }
  }
  const expectedRequirements = projectRuntimeBackendRequirements(providers);
  if (!sameOrderedStrings(requirements, expectedRequirements)) {
    runtimeAttachmentError(ownerName, "has a non-canonical backend-requirement projection");
  }
  if (requirements.some((requirement) => !manifest.backendRequirements.includes(requirement))) {
    runtimeAttachmentError(ownerName, "requests a backend requirement absent from the frozen manifest");
  }
  const hostProviders = providers.every(
    (provider) => provider.implementation.kind === "host-capability" || provider.implementation.kind === "host-managed",
  );
  const nativeProviders = providers.every((provider) => provider.implementation.kind === "native-managed");
  if (runtime.kind === "standalone-native-wasmgc") {
    if (
      !nativeProviders ||
      hostProviders ||
      manifest.policy.target !== "standalone" ||
      manifest.policy.backend !== "wasmgc" ||
      runtime.adapters.length !== 0
    ) {
      runtimeAttachmentError(ownerName, "has a native runtime outside the exact standalone/WasmGC provider policy");
    }
  } else {
    if (
      !hostProviders ||
      nativeProviders ||
      manifest.policy.target !== "host" ||
      manifest.policy.backend !== "wasmgc" ||
      requirements.length !== 0
    ) {
      runtimeAttachmentError(ownerName, "has a host runtime outside the exact host/WasmGC provider policy");
    }
    const capabilities = new Set(providers.flatMap((provider) => provider.hostCapabilities));
    const records = manifest.hostCapabilityRecords.filter((record) => capabilities.has(record.capability));
    if (runtime.adapters.length !== records.length) {
      runtimeAttachmentError(ownerName, `has ${runtime.adapters.length} adapters; expected ${records.length}`);
    }
    for (let index = 0; index < records.length; index++) {
      const adapter = runtime.adapters[index]!;
      // (#3526 F2-S2) Fail-closed kind guard: the frozen catalogue is now
      // kind-discriminated, and only a callable record has an import spelling.
      const record = asCallableRuntimeHostCapabilityRecord(records[index]!);
      assertCanonicalPreparedAsyncHostCapabilityRecord(adapter.record);
      const target = irImportFuncRef(record.module, record.field, record.field);
      if (
        adapter.record !== record ||
        adapter.capability !== record.capability ||
        !sameIrCallableBinding(adapter.target.binding, target.binding) ||
        adapter.target.name !== target.name
      ) {
        runtimeAttachmentError(ownerName, `has a detached adapter at canonical index ${index}`);
      }
    }
  }
  return runtime as CurrentPreparedIrAsyncRuntime;
}

/** Create and authenticate one exact per-owner backend attachment. */
export function createPreparedIrAsyncRuntime(input: PreparedIrAsyncRuntimeInput): CurrentPreparedIrAsyncRuntime {
  const previous = preparedManifestByPlan.get(input.plan);
  if (previous && previous !== input.manifest) {
    runtimeAttachmentError(String(input.plan.ownerUnitId), "was already attached to another frozen manifest");
  }
  const runtime = Object.freeze({
    ...input,
    states: sealPreparedIrAsyncStates(input.states),
  }) as CurrentPreparedIrAsyncRuntime;
  preparedManifestByPlan.set(input.plan, input.manifest);
  try {
    return assertPreparedIrAsyncRuntimeCurrent(
      input.plan.ownerUnitId,
      String(input.plan.ownerUnitId),
      input.plan,
      runtime,
    );
  } catch (error) {
    if (!previous) preparedManifestByPlan.delete(input.plan);
    throw error;
  }
}

/**
 * Restore the immutable attachment envelope after a generic IR pass has
 * copy-on-write rewritten only state bodies or prepared type layouts. Semantic
 * joins remain untouched and are authenticated separately by the validator.
 */
export function sealPreparedIrAsyncRuntimeContainers(runtime: PreparedIrAsyncRuntime): PreparedIrAsyncRuntime {
  const states = sealPreparedIrAsyncStates(runtime.states);
  const adapters =
    Object.isFrozen(runtime.adapters) && runtime.adapters.every((adapter) => Object.isFrozen(adapter))
      ? runtime.adapters
      : Object.freeze(
          runtime.adapters.map((adapter) => (Object.isFrozen(adapter) ? adapter : Object.freeze({ ...adapter }))),
        );
  const typeLayouts =
    runtime.typeLayouts === undefined ||
    (Object.isFrozen(runtime.typeLayouts) && runtime.typeLayouts.every((entry) => Object.isFrozen(entry)))
      ? runtime.typeLayouts
      : Object.freeze(
          runtime.typeLayouts.map((entry) => (Object.isFrozen(entry) ? entry : Object.freeze({ ...entry }))),
        );
  if (
    Object.isFrozen(runtime) &&
    states === runtime.states &&
    adapters === runtime.adapters &&
    typeLayouts === runtime.typeLayouts
  ) {
    return runtime;
  }
  return Object.freeze({
    ...runtime,
    states,
    adapters,
    ...(typeLayouts === undefined ? {} : { typeLayouts }),
  }) as PreparedIrAsyncRuntime;
}

/** The shared frame currently needs the complete host adapter set even for a smaller valid semantic plan. */
export function preparedIrAsyncFrameCapabilityFailure(runtime: CurrentPreparedIrAsyncRuntime): string | undefined {
  if (runtime.kind !== "host-wasmgc") return undefined;
  const capabilities = new Set(runtime.adapters.map((adapter) => adapter.capability));
  const missing = ASYNC_HOST_ADAPTERS.filter((adapter) => !capabilities.has(adapter.capability));
  return missing.length === 0
    ? undefined
    : `shared async frame requires host adapters absent from this valid semantic plan: ${missing.map((adapter) => adapter.capability).join(", ")}`;
}
