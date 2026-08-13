// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { ExportBoundaryPolicy } from "./boundary-policy.js";
import type { CapabilityProviderDiagnostic, PlatformCapabilityRequirement } from "./capability-registry.js";
import type { HostImportInventorySummary } from "./host-import-policy.js";
import type { CompileTargetProfile } from "./target-profile.js";

export const COMPILE_EXPLANATION_SCHEMA_VERSION = 1 as const;

export type CompileExplanationStatus = "host-free-wasm" | "declared-host-capability" | "runtime-provider" | "unknown";

export interface CompileExplanationV1 {
  readonly schemaVersion: typeof COMPILE_EXPLANATION_SCHEMA_VERSION;
  readonly status: CompileExplanationStatus;
  readonly target: CompileTargetProfile;
  readonly hostImports: HostImportInventorySummary;
  readonly capabilities: readonly PlatformCapabilityRequirement[];
  readonly capabilityDiagnostics: readonly CapabilityProviderDiagnostic[];
  readonly exportBoundaries: Readonly<Record<string, ExportBoundaryPolicy>>;
}

export interface CompileExplanationInput {
  readonly target: CompileTargetProfile;
  readonly hostImports: HostImportInventorySummary;
  readonly capabilities: readonly PlatformCapabilityRequirement[];
  readonly capabilityDiagnostics: readonly CapabilityProviderDiagnostic[];
  readonly exportBoundaries: Readonly<Record<string, ExportBoundaryPolicy>>;
}

function explanationStatus(input: CompileExplanationInput): CompileExplanationStatus {
  if (input.hostImports.byClassification.unknown > 0 || input.capabilityDiagnostics.length > 0) return "unknown";
  if (input.capabilities.length > 0) return "declared-host-capability";
  const providerImports =
    input.hostImports.byClassification["value-adapter"] +
    input.hostImports.byClassification["instance-lifecycle"] +
    input.hostImports.byClassification["host-accelerator"] +
    input.hostImports.byClassification["legacy-semantic"];
  return providerImports > 0 ? "runtime-provider" : "host-free-wasm";
}

/** Build the stable compiler-owned provider/capability explanation for one successful compilation. */
export function buildCompileExplanation(input: CompileExplanationInput): CompileExplanationV1 {
  return Object.freeze({
    schemaVersion: COMPILE_EXPLANATION_SCHEMA_VERSION,
    status: explanationStatus(input),
    target: input.target,
    hostImports: input.hostImports,
    capabilities: Object.freeze([...input.capabilities]),
    capabilityDiagnostics: Object.freeze([...input.capabilityDiagnostics]),
    exportBoundaries: input.exportBoundaries,
  });
}

/** Stable human projection of the same record used by JSON explain output. */
export function formatCompileExplanation(explanation: CompileExplanationV1): string {
  const lines = [
    `status: ${explanation.status}`,
    `target: ${explanation.target.target}`,
    `backend: ${explanation.target.backend}`,
    `environment: ${explanation.target.environment}`,
    `semantic provider: ${explanation.target.semanticProviders}`,
    `host value interop: ${explanation.target.hostValueInterop}`,
    `host imports: ${explanation.hostImports.total}`,
  ];
  for (const [classification, count] of Object.entries(explanation.hostImports.byClassification)) {
    if (count > 0) lines.push(`  ${classification}: ${count}`);
  }
  if (explanation.capabilities.length === 0) {
    lines.push("capabilities: none");
  } else {
    lines.push("capabilities:");
    for (const capability of explanation.capabilities) {
      lines.push(
        `  ${capability.id}@${capability.abiVersion}: ${capability.selectedProviders.join(", ")}` +
          (capability.permissions.length > 0 ? ` [${capability.permissions.join(", ")}]` : ""),
      );
    }
  }
  if (explanation.capabilityDiagnostics.length > 0) {
    lines.push("capability diagnostics:");
    for (const diagnostic of explanation.capabilityDiagnostics)
      lines.push(`  ${diagnostic.code}: ${diagnostic.message}`);
  }
  lines.push(`export boundaries: ${Object.keys(explanation.exportBoundaries).length}`);
  return `${lines.join("\n")}\n`;
}
