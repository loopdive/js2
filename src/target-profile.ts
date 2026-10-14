// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * Target-policy normalization (#4396).
 *
 * A JavaScript execution environment, permission to use implicit JS imports,
 * semantic-provider choice, and JS value interop are independent questions.
 * Keep their legacy projections here while the compiler migrates away from
 * compound `standalone || wasi || strictNoHostImports` predicates.
 */

import { readEnv } from "./env.js";

export type CompileTarget = "gc" | "linear" | "wasi" | "standalone";
export type CompileBackend = "wasmgc" | "linear";
export type CompileEnvironment = "javascript" | "wasi" | "none" | "unknown";
export type CapabilityPolicy = "ambient-js" | "explicit-only" | "backend-defined";
/**
 * Public semantic-provider spelling (#6708 S6). `"native-first"` is the
 * default in every environment; `"host-assisted"` is the compatibility
 * profile (byte-identical to the pre-S6 `gc` default), scheduled for removal
 * in S7; `"auto"` is a deprecated alias of `"native-first"`.
 */
export type SemanticProviderSelection = "native-first" | "host-assisted" | "auto";
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
  /**
   * Rejects a contradictory explicit native-first request; with no explicit
   * selection, `false` keeps the pre-S6 host-assisted profile (deprecated).
   */
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
  const { selection: semanticProviderSelection, explicit: semanticProvidersExplicit } =
    normalizeSemanticProviderSelection(input);

  let capabilityPolicy: CapabilityPolicy;
  let semanticProviders: SemanticProviderPolicy;
  if (target === "linear") {
    // The legacy linear target does not itself identify its embedder/provider
    // policy. Say unknown instead of silently treating it as JS or host-free.
    capabilityPolicy = "backend-defined";
    semanticProviders =
      semanticProvidersExplicit && semanticProviderSelection === "native-first" ? "native-first" : "backend-defined";
  } else {
    const implicitJsSemanticsAllowed = target !== "standalone" && !strictEnvImportGate;
    capabilityPolicy = implicitJsSemanticsAllowed ? "ambient-js" : "explicit-only";
    // `host-assisted` is the pre-S6 rule verbatim: implicit JS semantics where
    // the target allows them, native providers where it does not.
    semanticProviders =
      semanticProviderSelection === "host-assisted" && implicitJsSemanticsAllowed ? "host-assisted" : "native-first";
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

  // (#5385 S5, #6708 S6) The JS-environment arm is ON for the native-first
  // policy, which is the default since S6: the regime lane led the
  // host-assisted lane on every nightly from 2026-09-27 (35,384 vs 34,099) to
  // 2026-10-07 (41,816 vs 39,700), and its arms are the `ctx.standalone` arms
  // the standalone edition ratchet guards on every merge. `JS2WASM_NATIVE_REGIME_JS=0`
  // stays the one-release kill switch: it now also applies to the DEFAULT and
  // restores the pre-S5 per-family reroute (native-first providers without the
  // regime). The whole pre-S6 profile is `semanticProviders: "host-assisted"`.
  const nativeRegime =
    target === "standalone" ||
    (target === "gc" &&
      environment === "javascript" &&
      capabilityPolicy === "ambient-js" &&
      semanticProviderSelection === "native-first" &&
      readEnv("JS2WASM_NATIVE_REGIME_JS") !== "0");

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

type NormalizedSemanticProviderSelection = "native-first" | "host-assisted";

const warnedSemanticProviderDeprecations = new Set<string>();

function warnSemanticProviderDeprecationOnce(key: string, message: string): void {
  if (warnedSemanticProviderDeprecations.has(key)) return;
  warnedSemanticProviderDeprecations.add(key);
  console.warn(`js2wasm: ${message}`);
}

/** Test-only: forget which once-per-process deprecation warnings were printed. */
export function resetSemanticProviderDeprecationWarnings(): void {
  warnedSemanticProviderDeprecations.clear();
}

/**
 * (#6708 S6) Resolve the public spelling to the policy it selects.
 *
 * - no selection → `native-first` (the default in every environment), except
 *   that an explicit `nativeStrings: false` with no selection keeps the pre-S6
 *   `host-assisted` profile those callers relied on (deprecated, warns once);
 * - `"auto"` → same as omitting the option, i.e. `native-first` (deprecated
 *   alias, warns once per process);
 * - an explicit `"native-first"` with `nativeStrings: false` throws.
 *
 * `explicit` says whether the caller spelled a policy: the target-derived
 * linear/standalone/WASI defaults keep their established behaviour.
 */
export function normalizeSemanticProviderSelection(
  input: Pick<TargetProfileInput, "semanticProviders" | "nativeStrings"> = {},
): { readonly selection: NormalizedSemanticProviderSelection; readonly explicit: boolean } {
  const requested = input.semanticProviders;
  if (requested === "auto") {
    warnSemanticProviderDeprecationOnce(
      "auto-alias",
      'semanticProviders: "auto" is a deprecated alias of "native-first" (the default since #6708); omit the option.',
    );
  }
  if (requested === undefined || requested === "auto") {
    // `"auto"` meant "the default policy" before S6 and keeps meaning exactly
    // that — the default is now native-first — so it resolves like an omitted
    // option (target-derived standalone/WASI behaviour included).
    if (input.nativeStrings !== false) return { selection: "native-first", explicit: false };
    warnSemanticProviderDeprecationOnce(
      "implicit-native-strings-false",
      'nativeStrings: false without semanticProviders selects the "host-assisted" compatibility profile; ' +
        'spell semanticProviders: "host-assisted" explicitly (the profile is removed in S7, #6708).',
    );
    return { selection: "host-assisted", explicit: false };
  }
  if (requested === "host-assisted") return { selection: "host-assisted", explicit: true };
  if (requested !== "native-first") {
    throw new Error(`Compile option semanticProviders expects native-first | host-assisted (got ${String(requested)})`);
  }
  if (input.nativeStrings === false) {
    throw new Error('Compile option semanticProviders: "native-first" conflicts with nativeStrings: false');
  }
  return { selection: "native-first", explicit: true };
}

/**
 * Cache-key spelling of the selected policy. Provider caches keyed the raw
 * option (`?? "auto"`) before S6; keying the normalized policy makes `{}` and
 * `"native-first"` share an entry and keeps a pre-S6 `"auto"` entry (built
 * host-assisted) from being served for the new native-first default.
 */
export function semanticProviderCacheKey(
  input: Pick<TargetProfileInput, "semanticProviders" | "nativeStrings">,
): string {
  return normalizeSemanticProviderSelection(input).selection;
}
