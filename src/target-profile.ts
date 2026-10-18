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

/**
 * (#6978) Named host accelerators for the native semantic regime. Each family
 * keeps its native provider as the default; selecting one swaps in the JS
 * host's implementation for that family only. The 2026-09-07 stakeholder
 * constraint names exactly these four (`wasm:js-string` strings, host RegExp,
 * Date and Intl); everything else host-semantic retires in S7 (#5385).
 */
export const HOST_ACCELERATOR_FAMILIES = ["js-string", "regexp", "date", "intl"] as const;
export type HostAcceleratorFamily = (typeof HOST_ACCELERATOR_FAMILIES)[number];

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
  /** (#6978) Named host accelerators; validated by `resolveHostAccelerators`. */
  readonly hostAccelerators?: readonly string[];
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
  /**
   * (#6978) Selected host accelerators, sorted and de-duplicated. Absent when
   * none is selected, so a default profile — and the JSON adapter manifest that
   * embeds it — is unchanged. An array rather than a `Set` because the profile
   * is serialized into the adapter manifest. Query with `hasHostAccelerator`.
   */
  readonly accelerators?: readonly HostAcceleratorFamily[];
}

/** (#6978) Whether `family` is a selected host accelerator of `profile`. */
export function hasHostAccelerator(
  profile: Pick<CompileTargetProfile, "accelerators">,
  family: HostAcceleratorFamily,
): boolean {
  return profile.accelerators?.includes(family) === true;
}

/**
 * (#6986) Does this build have a host `Intl` to call? Yes on the host-assisted
 * lane and under the selected `intl` accelerator; no on every other WasmGC
 * build (native-first in a JS environment, standalone, WASI, strict). There is
 * no native Intl beyond the `Intl.ListFormat` prelude (#6839), so a host-free
 * build that uses `Intl` is a compile error naming the accelerator rather than a
 * silent run-time failure. The linear backend keeps its own behaviour.
 */
export function hostIntlAvailable(
  profile: Pick<CompileTargetProfile, "backend" | "environment" | "semanticProviders" | "accelerators">,
): boolean {
  if (profile.backend !== "wasmgc") return true;
  if (profile.environment !== "javascript") return false;
  return profile.semanticProviders !== "native-first" || hasHostAccelerator(profile, "intl");
}

/**
 * (#6978) Validate a host-accelerator request against the resolved policy. An
 * accelerator swaps a native provider for the JS host's, so it needs a JS
 * environment that permits host imports and a native-first policy to swap out
 * of; anything else is a compile error, never a silent no-op.
 */
function resolveHostAccelerators(
  requested: readonly string[] | undefined,
  facts: { target: CompileTarget; environment: CompileEnvironment; capabilityPolicy: CapabilityPolicy },
  semanticProviders: SemanticProviderPolicy,
): readonly HostAcceleratorFamily[] {
  if (requested === undefined || requested.length === 0) return [];
  const known: readonly string[] = HOST_ACCELERATOR_FAMILIES;
  for (const name of requested) {
    if (!known.includes(name)) {
      throw new Error(`Unknown host accelerator '${name}'; expected one of: ${HOST_ACCELERATOR_FAMILIES.join(", ")}`);
    }
  }
  const families = [...new Set(requested as readonly HostAcceleratorFamily[])].sort();
  const list = families.join(", ");
  if (facts.environment !== "javascript") {
    throw new Error(
      `Host accelerator(s) ${list} require a JavaScript environment; target '${facts.target}' has none. ` +
        `Remove the accelerator or compile for the default JS target.`,
    );
  }
  if (facts.capabilityPolicy !== "ambient-js") {
    throw new Error(`Host accelerator(s) ${list} need host imports, which strictNoHostImports forbids.`);
  }
  if (semanticProviders !== "native-first") {
    throw new Error(
      `Host accelerator(s) ${list} only apply to the native-first semantic regime; the host-assisted ` +
        `profile already uses every host provider. Select semanticProviders: "native-first".`,
    );
  }
  const pending = families.filter((family) => PENDING_HOST_ACCELERATORS[family] !== undefined);
  if (pending.length > 0) {
    throw new Error(
      `Host accelerator(s) ${pending.join(", ")} not available yet: ` +
        pending.map((family) => PENDING_HOST_ACCELERATORS[family]).join("; "),
    );
  }
  return Object.freeze(families);
}

/**
 * (#6978) Families the policy already classifies but whose host path does not
 * work under the native regime yet. Selecting one is an error rather than a
 * no-op; the measured gap is recorded in plan/issues/6978-host-accelerator-opt-ins.md.
 */
const PENDING_HOST_ACCELERATORS: Partial<Record<HostAcceleratorFamily, string>> = {
  "js-string":
    "the regime's string providers (self-hosted stdlib, IR string ops) assume the native string struct, " +
    "so a regime build cannot run on wasm:js-string strings",
};

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

  const accelerators = resolveHostAccelerators(
    input.hostAccelerators,
    { target, environment, capabilityPolicy },
    semanticProviders,
  );

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
    ...(accelerators.length > 0 ? { accelerators } : {}),
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
    throw new Error(
      'Compile option semanticProviders: "native-first" conflicts with nativeStrings: false ' +
        "(the native regime runs on native strings; host `wasm:js-string` strings under it are the planned " +
        '"js-string" host accelerator, #6978)',
    );
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
