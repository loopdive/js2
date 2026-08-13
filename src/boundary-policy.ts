// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CompileTargetProfile } from "./target-profile.js";
import type { ExportBoundaryKind, ExportSignature } from "./ir/types.js";

export type BoundaryValuePolicy = "primitive-value" | "copied-value" | "live-view" | "opaque-handle";

export interface BoundarySlotPolicy {
  readonly kind: ExportBoundaryKind;
  readonly policy: BoundaryValuePolicy;
}

export interface ExportBoundaryPolicy {
  readonly params: readonly BoundarySlotPolicy[];
  readonly result: BoundarySlotPolicy;
}

const PRIMITIVE_BOUNDARY_KINDS: ReadonlySet<ExportBoundaryKind> = new Set(["string", "symbol", "other"]);

function expectedPolicyDescription(kind: ExportBoundaryKind, direction: "param" | "result"): string {
  if (PRIMITIVE_BOUNDARY_KINDS.has(kind)) return "primitive-value";
  if ((kind === "uint8array" || kind === "typed-array") && direction === "param") return "copied-value";
  return "copied-value, live-view, or opaque-handle";
}

function slotPolicyIsValid(slot: BoundarySlotPolicy, direction: "param" | "result"): boolean {
  if (PRIMITIVE_BOUNDARY_KINDS.has(slot.kind)) return slot.policy === "primitive-value";
  if ((slot.kind === "uint8array" || slot.kind === "typed-array") && direction === "param") {
    return slot.policy === "copied-value";
  }
  return slot.policy === "copied-value" || slot.policy === "live-view" || slot.policy === "opaque-handle";
}

function aggregatePolicy(profile: CompileTargetProfile): BoundaryValuePolicy {
  if (profile.hostValueInterop === "off") return "opaque-handle";
  return profile.semanticProviders === "native-first" ? "live-view" : "copied-value";
}

function slotPolicy(
  kind: ExportBoundaryKind,
  direction: "param" | "result",
  profile: CompileTargetProfile,
): BoundarySlotPolicy {
  let policy: BoundaryValuePolicy;
  if (kind === "string" || kind === "symbol" || kind === "other") {
    policy = "primitive-value";
  } else if ((kind === "uint8array" || kind === "typed-array") && direction === "param") {
    // Current flat ABI allocates a fresh Wasm vec for a JS TypedArray input.
    policy = "copied-value";
  } else {
    // Dynamic/object/closure outputs and aggregate inputs use the current
    // identity-cached live façade in native-first JS builds. Compatibility
    // builds retain their historical detached materialization.
    policy = aggregatePolicy(profile);
  }
  return Object.freeze({ kind, policy });
}

/** Freeze the declared value policy for every classified export boundary. */
export function buildExportBoundaryPolicies(
  signatures: Readonly<Record<string, ExportSignature>> | undefined,
  profile: CompileTargetProfile,
): Readonly<Record<string, ExportBoundaryPolicy>> {
  const policies: Record<string, ExportBoundaryPolicy> = Object.create(null);
  for (const [name, signature] of Object.entries(signatures ?? {}).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    policies[name] = Object.freeze({
      params: Object.freeze(signature.params.map((kind) => slotPolicy(kind, "param", profile))),
      result: slotPolicy(signature.result, "result", profile),
    });
  }
  return Object.freeze(policies);
}

/**
 * Validate the value-policy half of the generated JS adapter manifest.
 *
 * The source-level signature is the closed list of boundary slots. Every one
 * must have a matching declaration before the adapter exposes the module. In
 * particular, an aggregate may never silently inherit copy semantics merely
 * because a policy row was omitted.
 */
export function validateExportBoundaryPolicies(
  signatures: Readonly<Record<string, ExportSignature>> | undefined,
  policies: Readonly<Record<string, ExportBoundaryPolicy>> | undefined,
): readonly string[] {
  const diagnostics: string[] = [];
  const signatureEntries = Object.entries(signatures ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const policyNames = new Set(Object.keys(policies ?? {}));

  for (const [name, signature] of signatureEntries) {
    const policy = policies?.[name];
    policyNames.delete(name);
    if (!policy) {
      diagnostics.push(`export '${name}' has no boundary policy`);
      continue;
    }
    if (policy.params.length !== signature.params.length) {
      diagnostics.push(
        `export '${name}' declares ${policy.params.length} parameter policies for ${signature.params.length} parameters`,
      );
    }
    for (let index = 0; index < signature.params.length; index++) {
      const expectedKind = signature.params[index]!;
      const slot = policy.params[index];
      if (!slot) continue;
      if (slot.kind !== expectedKind) {
        diagnostics.push(
          `export '${name}' parameter #${index} policy kind '${slot.kind}' does not match '${expectedKind}'`,
        );
        continue;
      }
      if (!slotPolicyIsValid(slot, "param")) {
        diagnostics.push(
          `export '${name}' parameter #${index} kind '${slot.kind}' requires ${expectedPolicyDescription(slot.kind, "param")}, got '${slot.policy}'`,
        );
      }
    }
    if (policy.result.kind !== signature.result) {
      diagnostics.push(
        `export '${name}' result policy kind '${policy.result.kind}' does not match '${signature.result}'`,
      );
    } else if (!slotPolicyIsValid(policy.result, "result")) {
      diagnostics.push(
        `export '${name}' result kind '${policy.result.kind}' requires ${expectedPolicyDescription(policy.result.kind, "result")}, got '${policy.result.policy}'`,
      );
    }
  }

  for (const name of [...policyNames].sort()) {
    diagnostics.push(`boundary policy for unknown export '${name}'`);
  }
  return Object.freeze(diagnostics);
}
