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

function validateTargetProfileCoherence(profile: CompileTargetProfile): readonly string[] {
  if (!(["gc", "linear", "wasi", "standalone"] as readonly string[]).includes(profile.target)) {
    return [`unsupported target profile '${String(profile.target)}'`];
  }
  const expectedBackend = profile.target === "linear" ? "linear" : "wasmgc";
  const expectedEnvironment =
    profile.target === "gc"
      ? "javascript"
      : profile.target === "wasi"
        ? "wasi"
        : profile.target === "standalone"
          ? "none"
          : "unknown";
  const diagnostics: string[] = [];
  if (profile.backend !== expectedBackend || profile.environment !== expectedEnvironment) {
    diagnostics.push(
      `incoherent target profile '${profile.target}': expected ${expectedBackend}/${expectedEnvironment}, received ${profile.backend}/${profile.environment}`,
    );
  }
  if (profile.target === "linear") {
    if (profile.capabilityPolicy !== "backend-defined") {
      diagnostics.push("incoherent linear target profile capability policy");
    }
    if (profile.semanticProviders !== "backend-defined" && profile.semanticProviders !== "native-first") {
      diagnostics.push("incoherent linear target profile semantic provider policy");
    }
  } else {
    const implicitJsSemanticsAllowed = profile.target !== "standalone" && !profile.strictEnvImportGate;
    const expectedCapabilityPolicy = implicitJsSemanticsAllowed ? "ambient-js" : "explicit-only";
    if (profile.capabilityPolicy !== expectedCapabilityPolicy) {
      diagnostics.push(
        `incoherent target profile capability policy '${profile.capabilityPolicy}', expected '${expectedCapabilityPolicy}'`,
      );
    }
    if (profile.semanticProviders === "host-assisted" && !implicitJsSemanticsAllowed) {
      diagnostics.push("incoherent target profile host-assisted semantic provider policy");
    } else if (profile.semanticProviders !== "host-assisted" && profile.semanticProviders !== "native-first") {
      diagnostics.push("incoherent target profile semantic provider policy");
    }
  }
  const nativeStringsRequired =
    profile.target === "standalone" ||
    profile.target === "wasi" ||
    profile.strictEnvImportGate ||
    profile.semanticProviders === "native-first";
  if (profile.nativeStringsRequiredByPolicy !== nativeStringsRequired) {
    diagnostics.push("incoherent target profile native-string policy");
  }
  const validHostValueInterop =
    profile.environment === "javascript"
      ? profile.hostValueInterop === "required" || profile.hostValueInterop === "off"
      : profile.hostValueInterop === "enabled" || profile.hostValueInterop === "off";
  if (!validHostValueInterop) diagnostics.push("incoherent target profile host-value interop policy");
  return diagnostics;
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
  diagnostics.push(...validateTargetProfileCoherence(manifest.targetProfile));
  diagnostics.push(
    ...validatePlatformCapabilityRequirements(manifest.capabilities, manifest.targetProfile.environment).map(
      ({ message }) => message,
    ),
  );
  diagnostics.push(...validateExportBoundaryPolicies(manifest.exportSignatures, manifest.exportBoundaries));

  const capabilityRequirementCounts = new Map<string, number>();
  for (const requirement of manifest.capabilities) {
    capabilityRequirementCounts.set(requirement.id, (capabilityRequirementCounts.get(requirement.id) ?? 0) + 1);
  }
  for (const [id, count] of capabilityRequirementCounts) {
    if (count > 1) diagnostics.push(`duplicate capability requirement '${id}' appears ${count} times`);
  }

  const manifestImportCounts = new Map<string, number>();
  for (const entry of manifest.imports) {
    const key = `${entry.module}\0${entry.name}\0${entry.kind}`;
    manifestImportCounts.set(key, (manifestImportCounts.get(key) ?? 0) + 1);
  }
  const reportedDuplicateManifestImports = new Set<string>();
  for (const entry of manifest.imports) {
    const key = `${entry.module}\0${entry.name}\0${entry.kind}`;
    const count = manifestImportCounts.get(key) ?? 0;
    if (count > 1 && !reportedDuplicateManifestImports.has(key)) {
      diagnostics.push(`duplicate adapter import '${entry.module}::${entry.name}' appears ${count} times`);
      reportedDuplicateManifestImports.add(key);
    }
  }
  const manifestImports = new Set(manifestImportCounts.keys());

  const capabilityImportOwners = new Map<string, string[]>();
  const capabilityImportLabels = new Map<string, string>();
  for (const requirement of manifest.capabilities) {
    for (const entry of requirement.imports) {
      const key = `${entry.module}\0${entry.name}\0${entry.kind}`;
      const owners = capabilityImportOwners.get(key) ?? [];
      owners.push(requirement.id);
      capabilityImportOwners.set(key, owners);
      capabilityImportLabels.set(key, `${entry.module}::${entry.name}`);
    }
  }
  for (const [key, owners] of capabilityImportOwners) {
    if (owners.length > 1) {
      diagnostics.push(
        `capability import '${capabilityImportLabels.get(key)}' has ${owners.length} ownership claims ` +
          `('${owners.join("', '")}'); expected exactly one`,
      );
    }
  }
  for (const descriptor of manifest.imports) {
    const policy = classifyHostImport(descriptor, manifest.targetProfile.environment);
    if (policy.classification !== "platform-capability") continue;
    const key = `${descriptor.module}\0${descriptor.name}\0${descriptor.kind}`;
    const owners = capabilityImportOwners.get(key);
    if (!owners || owners.length === 0) {
      diagnostics.push(`platform import '${descriptor.module}::${descriptor.name}' has no capability requirement`);
    } else if (owners.length === 1 && owners[0] !== policy.family) {
      diagnostics.push(
        `platform import '${descriptor.module}::${descriptor.name}' belongs to capability '${policy.family}', not ` +
          `'${owners[0]}'`,
      );
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
