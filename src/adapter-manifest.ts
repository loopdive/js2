// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { validatePlatformCapabilityRequirements } from "./capability-registry.js";
import type { PlatformCapabilityRequirement } from "./capability-registry.js";
import { validateExportBoundaryPolicies } from "./boundary-policy.js";
import type { ExportBoundaryPolicy } from "./boundary-policy.js";
import type { ImportDescriptor } from "./index.js";
import { classifyHostImport } from "./host-import-policy.js";
import type { ExportSignature } from "./ir/types.js";
import type { CompileTargetProfile } from "./target-profile.js";

export const JAVASCRIPT_ADAPTER_MANIFEST_SCHEMA_VERSION = 1 as const;

/** Closed, serializable input to the generated JavaScript boundary adapter. */
export interface JavaScriptAdapterManifestV1 {
  readonly schemaVersion: typeof JAVASCRIPT_ADAPTER_MANIFEST_SCHEMA_VERSION;
  readonly targetProfile: CompileTargetProfile;
  readonly imports: readonly ImportDescriptor[];
  readonly stringPool: readonly string[];
  readonly capabilities: readonly PlatformCapabilityRequirement[];
  readonly exportSignatures: Readonly<Record<string, ExportSignature>>;
  readonly exportBoundaries: Readonly<Record<string, ExportBoundaryPolicy>>;
}

export interface JavaScriptAdapterManifestInput {
  readonly targetProfile: CompileTargetProfile;
  readonly imports: readonly ImportDescriptor[];
  readonly stringPool: readonly string[];
  readonly capabilities?: readonly PlatformCapabilityRequirement[];
  readonly exportSignatures?: Readonly<Record<string, ExportSignature>>;
  readonly exportBoundaries?: Readonly<Record<string, ExportBoundaryPolicy>>;
}

/** Clone JSON-like compiler metadata and recursively freeze the adapter-owned copy. */
function frozenClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => frozenClone(entry))) as T;
  }
  if (value !== null && typeof value === "object") {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) clone[key] = frozenClone(entry);
    return Object.freeze(clone) as T;
  }
  return value;
}

/** Build the immutable v1 plan consumed by runtime import and value binders. */
export function createJavaScriptAdapterManifest(input: JavaScriptAdapterManifestInput): JavaScriptAdapterManifestV1 {
  return frozenClone({
    schemaVersion: JAVASCRIPT_ADAPTER_MANIFEST_SCHEMA_VERSION,
    targetProfile: input.targetProfile,
    imports: input.imports,
    stringPool: input.stringPool,
    capabilities: input.capabilities ?? [],
    exportSignatures: input.exportSignatures ?? {},
    exportBoundaries: input.exportBoundaries ?? {},
  });
}

/** Validate a serialized manifest before any host authority is bound. */
export function validateJavaScriptAdapterManifest(manifest: JavaScriptAdapterManifestV1): readonly string[] {
  const diagnostics: string[] = [];
  if (manifest.schemaVersion !== JAVASCRIPT_ADAPTER_MANIFEST_SCHEMA_VERSION) {
    diagnostics.push(
      `unsupported JavaScript adapter manifest schema v${String(manifest.schemaVersion)}; expected v${JAVASCRIPT_ADAPTER_MANIFEST_SCHEMA_VERSION}`,
    );
  }
  diagnostics.push(
    ...validatePlatformCapabilityRequirements(manifest.capabilities, manifest.targetProfile.environment).map(
      ({ message }) => message,
    ),
  );
  diagnostics.push(...validateExportBoundaryPolicies(manifest.exportSignatures, manifest.exportBoundaries));

  const manifestImports = new Set(manifest.imports.map((entry) => `${entry.module}\0${entry.name}\0${entry.kind}`));
  const capabilityImports = new Set(
    manifest.capabilities.flatMap((requirement) =>
      requirement.imports.map((entry) => `${entry.module}\0${entry.name}\0${entry.kind}`),
    ),
  );
  for (const descriptor of manifest.imports) {
    if (classifyHostImport(descriptor).classification !== "platform-capability") continue;
    const key = `${descriptor.module}\0${descriptor.name}\0${descriptor.kind}`;
    if (!capabilityImports.has(key)) {
      diagnostics.push(`platform import '${descriptor.module}::${descriptor.name}' has no capability requirement`);
    }
  }
  for (const requirement of manifest.capabilities) {
    for (const entry of requirement.imports) {
      // The JavaScript adapter binds `env`; non-env providers are linked by
      // their own Wasm/WASI instantiator and are not part of this import list.
      if (entry.module !== "env") continue;
      const key = `${entry.module}\0${entry.name}\0${entry.kind}`;
      if (!manifestImports.has(key)) {
        diagnostics.push(
          `capability '${requirement.id}' declares missing adapter import '${entry.module}::${entry.name}'`,
        );
      }
    }
  }
  return Object.freeze(diagnostics);
}
