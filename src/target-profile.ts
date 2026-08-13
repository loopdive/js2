// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Target-policy normalization (#4396).
 *
 * A JavaScript execution environment, permission to use implicit JS imports,
 * semantic-provider choice, and JS value interop are independent questions.
 * Keep their legacy projections here while the compiler migrates away from
 * compound `standalone || wasi || strictNoHostImports` predicates.
 */

export type CompileTarget = "gc" | "linear" | "wasi" | "standalone";
export type CompileBackend = "wasmgc" | "linear";
export type CompileEnvironment = "javascript" | "wasi" | "none" | "unknown";
export type CapabilityPolicy = "ambient-js" | "explicit-only" | "backend-defined";
export type SemanticProviderSelection = "auto" | "native-first";
export type SemanticProviderPolicy = "host-assisted" | "native-first" | "backend-defined";
export type HostValueInteropPolicy = "required" | "enabled" | "off";

export interface TargetProfileInput {
  readonly target?: CompileTarget;
  /** Internal CodegenOptions compatibility projection. Public callers use target. */
  readonly wasi?: boolean;
  /** Internal CodegenOptions compatibility projection. Public callers use target. */
  readonly standalone?: boolean;
  readonly strictNoHostImports?: boolean;
  /** Select migrated Wasm-native semantic families independently of the host. */
  readonly semanticProviders?: SemanticProviderSelection;
  /** Used only to reject a contradictory explicit native-first request. */
  readonly nativeStrings?: boolean;
  readonly hostBridge?: "auto" | "always" | "off";
}

/**
 * Immutable policy facts derived from the current compatibility options.
 *
 * `strictEnvImportGate` deliberately records the existing low-level gate; it
 * is not treated as a synonym for `semanticProviders` or `hostValueInterop`.
 * In particular, standalone currently has its own no-host enforcement while
 * the legacy strict-env gate remains false, and a strict GC build still keeps
 * its JS value bridge by default.
 */
export interface CompileTargetProfile {
  readonly target: CompileTarget;
  readonly backend: CompileBackend;
  readonly environment: CompileEnvironment;
  readonly capabilityPolicy: CapabilityPolicy;
  readonly semanticProviders: SemanticProviderPolicy;
  readonly hostValueInterop: HostValueInteropPolicy;
  readonly strictEnvImportGate: boolean;
  readonly nativeStringsRequiredByPolicy: boolean;
}

export function resolveCompileTargetProfile(input: TargetProfileInput = {}): CompileTargetProfile {
  if (input.wasi && input.standalone) {
    throw new Error("Conflicting codegen target projections: wasi and standalone are both enabled");
  }
  const target = input.target ?? (input.wasi ? "wasi" : input.standalone ? "standalone" : "gc");
  const backend: CompileBackend = target === "linear" ? "linear" : "wasmgc";
  const environment: CompileEnvironment =
    target === "gc" ? "javascript" : target === "wasi" ? "wasi" : target === "standalone" ? "none" : "unknown";

  // Preserve #1524's exact compatibility rule: WASI enables the env-import
  // gate unless explicitly disabled. Standalone owns a separate hard no-host
  // check (#2961), so changing its strict-gate projection here would not be a
  // behavior-neutral refactor.
  const strictEnvImportGate = input.strictNoHostImports ?? target === "wasi";
  const semanticProviderSelection = input.semanticProviders ?? "auto";
  if (semanticProviderSelection === "native-first" && input.nativeStrings === false) {
    throw new Error('Compile option semanticProviders: "native-first" conflicts with nativeStrings: false');
  }

  let capabilityPolicy: CapabilityPolicy;
  let semanticProviders: SemanticProviderPolicy;
  if (target === "linear") {
    // The legacy linear target does not itself identify its embedder/provider
    // policy. Say unknown instead of silently treating it as JS or host-free.
    capabilityPolicy = "backend-defined";
    semanticProviders = semanticProviderSelection === "native-first" ? semanticProviderSelection : "backend-defined";
  } else {
    const implicitJsSemanticsAllowed = target !== "standalone" && !strictEnvImportGate;
    capabilityPolicy = implicitJsSemanticsAllowed ? "ambient-js" : "explicit-only";
    semanticProviders =
      semanticProviderSelection === "native-first"
        ? semanticProviderSelection
        : implicitJsSemanticsAllowed
          ? "host-assisted"
          : "native-first";
  }

  const hostBridge = input.hostBridge ?? "auto";
  const hostValueInterop: HostValueInteropPolicy =
    hostBridge === "off"
      ? "off"
      : hostBridge === "always"
        ? environment === "javascript"
          ? "required"
          : "enabled"
        : environment === "javascript"
          ? "required"
          : "off";

  return Object.freeze({
    target,
    backend,
    environment,
    capabilityPolicy,
    semanticProviders,
    hostValueInterop,
    strictEnvImportGate,
    nativeStringsRequiredByPolicy:
      target === "standalone" || target === "wasi" || strictEnvImportGate || semanticProviders === "native-first",
  });
}
