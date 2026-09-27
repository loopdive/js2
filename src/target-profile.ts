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
export type AmbientPlatform = "node" | "deno";

export function ambientPlatformOf(input: {
  platform?: "web" | "node" | "deno";
  emulateNode?: boolean;
}): AmbientPlatform | undefined {
  if (input.platform === "deno") return "deno";
  return input.emulateNode === true || input.platform === "node" ? "node" : undefined;
}

export interface TargetProfileInput {
  readonly target?: CompileTarget;
  readonly ambientPlatform?: AmbientPlatform;
  readonly platform?: "web" | "node" | "deno";
  readonly emulateNode?: boolean;
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
  /**
   * (#5385) Whether codegen lowers with the native semantic REGIME — the
   * `ctx.standalone` provider arms — rather than the host-assisted one. True
   * for the standalone target and for an explicitly selected native-first
   * policy in a JavaScript environment. This answers "which ECMAScript
   * implementation runs?"; `environment` / `hostValueInterop` still answer
   * "who instantiates it and does it keep the JS value bridge?".
   */
  readonly nativeRegime: boolean;
  readonly ambientPlatform?: AmbientPlatform;
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

  // (#5385 S5) The JS-environment arm is ON by default for an explicitly
  // selected native-first policy: measured on nightly 36305955119 (2026-09-27,
  // main @ 7443ab4826) the regime lane passes 35,384 / 48,735 test262 rows
  // against 34,099 for the host-assisted lane and 35,237 for standalone, with
  // the JS boundary suites green (#6685/#6686/#6687/#6689). `JS2WASM_NATIVE_REGIME_JS=0`
  // is the one-release kill switch that restores the pre-S5 per-family reroute.
  const nativeRegime =
    target === "standalone" ||
    (target === "gc" &&
      environment === "javascript" &&
      capabilityPolicy === "ambient-js" &&
      semanticProviderSelection === "native-first" &&
      process.env.JS2WASM_NATIVE_REGIME_JS !== "0");

  return Object.freeze({
    target,
    backend,
    environment,
    capabilityPolicy,
    semanticProviders,
    hostValueInterop,
    strictEnvImportGate,
    nativeRegime,
    nativeStringsRequiredByPolicy:
      target === "standalone" || target === "wasi" || strictEnvImportGate || semanticProviders === "native-first",
    ambientPlatform: input.ambientPlatform ?? ambientPlatformOf(input),
  });
}
