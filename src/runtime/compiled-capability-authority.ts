// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { JavaScriptAdapterManifestV1 } from "../adapter-manifest.js";
import {
  requiresExactDomCapabilityAdapter,
  requiresExactDomInteractionCapabilityAdapter,
} from "../dom-capability-contract.js";
import {
  captureExplicitStandaloneClockCapabilityImport,
  type ClockCapabilityImport,
} from "./clock-capability-adapter.js";
import {
  createStandaloneDomCapabilityRuntime,
  type StandaloneDomCapabilityRuntime,
} from "./standalone-dom-string-bridge.js";
import { assertExplicitEmbedderCapabilityBindings } from "./standalone-timer-callback-bridge.js";

export const DOM_CAPABILITY_AUTHORITY = Symbol("validated-dom-capability");
export const CLOCK_CAPABILITY_AUTHORITY = Symbol("validated-clock-capability");

interface ValidatedDomCapabilityAuthority {
  readonly interaction: boolean;
}

export interface CompiledCapabilityAuthorityOptions {
  readonly [DOM_CAPABILITY_AUTHORITY]?: ValidatedDomCapabilityAuthority;
  readonly [CLOCK_CAPABILITY_AUTHORITY]?: ClockCapabilityImport;
}

/** Validate and capture explicit provider authority once per compiled adapter. */
export function prepareCompiledCapabilityAuthority(
  manifest: JavaScriptAdapterManifestV1,
  deps: Readonly<Record<string, unknown>> | undefined,
  domRootPresent: boolean,
): CompiledCapabilityAuthorityOptions {
  const explicitDom = requiresExactDomCapabilityAdapter(
    manifest.imports,
    manifest.capabilities,
    manifest.targetProfile,
  );
  if (explicitDom && !domRootPresent) {
    throw new Error("Explicit embedder capability 'dom' requires an authenticated domRoot");
  }
  const clock = captureExplicitStandaloneClockCapabilityImport(manifest, deps);
  assertExplicitEmbedderCapabilityBindings(manifest, deps);
  return {
    [CLOCK_CAPABILITY_AUTHORITY]: clock,
    [DOM_CAPABILITY_AUTHORITY]: explicitDom
      ? Object.freeze({ interaction: requiresExactDomInteractionCapabilityAdapter(manifest.capabilities) })
      : undefined,
  };
}

/** Materialize the DOM runtime only after the manifest granted exact authority. */
export function createCompiledDomCapabilityRuntime(
  options: CompiledCapabilityAuthorityOptions | undefined,
  root: unknown,
): StandaloneDomCapabilityRuntime | undefined {
  const authority = options?.[DOM_CAPABILITY_AUTHORITY];
  return authority ? createStandaloneDomCapabilityRuntime(root, { interaction: authority.interaction }) : undefined;
}
