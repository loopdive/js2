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
/**
 * Public semantic-provider spelling. Since #6979 (S7) the native semantic
 * regime is the only ECMAScript implementation on the WasmGC backend, so
 * `"native-first"` — the default — is the one accepted spelling. The former
 * `"host-assisted"` rollback and the `"auto"` alias are compile errors (see
 * `REMOVED_SEMANTIC_PROVIDER_RELEASE`).
 */
export type SemanticProviderSelection = "native-first";
/** `backend-defined` is the linear backend's own provider choice. */
export type SemanticProviderPolicy = "native-first" | "backend-defined";
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
  /** The only spelling is `"native-first"`, the default (#6979). */
  readonly semanticProviders?: SemanticProviderSelection;
  /**
   * The native regime runs on native strings: `false` is rejected for an
   * explicit native-first request and in the JavaScript environment, where it
   * used to select the removed host-assisted profile (#6979).
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
   * `ctx.standalone` provider arms. True for the standalone target and the
   * JavaScript environment (#6979). This answers "which ECMAScript
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
 * (#6986) Does this build have a host `Intl` to call? On WasmGC only under the
 * selected `intl` accelerator (#6979 removed the host-assisted lane, the other
 * way to get one). There is no native Intl beyond the `Intl.ListFormat`
 * prelude (#6839), so a build that uses `Intl` without the accelerator is a
 * compile error naming it rather than a silent run-time failure. The linear
 * backend keeps its own behaviour.
 */
export function hostIntlAvailable(profile: Pick<CompileTargetProfile, "backend" | "accelerators">): boolean {
  if (profile.backend !== "wasmgc") return true;
  return hasHostAccelerator(profile, "intl");
}

/**
 * (#6978) Validate a host-accelerator request against the resolved policy. An
 * accelerator swaps a native provider for the JS host's, so it needs a JS
 * environment that permits host imports; anything else is a compile error,
 * never a silent no-op.
 */
function resolveHostAccelerators(
  requested: readonly string[] | undefined,
  facts: { target: CompileTarget; environment: CompileEnvironment; capabilityPolicy: CapabilityPolicy },
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
  const semanticProvidersExplicit = validateSemanticProviderSelection(input);

  let capabilityPolicy: CapabilityPolicy;
  let semanticProviders: SemanticProviderPolicy;
  if (target === "linear") {
    // The legacy linear target does not itself identify its embedder/provider
    // policy. Say unknown instead of silently treating it as JS or host-free.
    capabilityPolicy = "backend-defined";
    semanticProviders = semanticProvidersExplicit ? "native-first" : "backend-defined";
  } else {
    const implicitJsSemanticsAllowed = target !== "standalone" && !strictEnvImportGate;
    capabilityPolicy = implicitJsSemanticsAllowed ? "ambient-js" : "explicit-only";
    if (implicitJsSemanticsAllowed && input.nativeStrings === false)
      throw removedSemanticProviderError("nativeStrings: false");
    semanticProviders = "native-first";
  }

  const accelerators = resolveHostAccelerators(input.hostAccelerators, { target, environment, capabilityPolicy });

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

  // (#5385 S5, #6708 S6, #6979 S7) The regime is the only semantic
  // implementation in a JavaScript environment that permits host imports, as
  // it is host-free. The S6 kill switch `JS2WASM_NATIVE_REGIME_JS` is gone.
  const nativeRegime = target === "standalone" || (target === "gc" && capabilityPolicy === "ambient-js");

  return Object.freeze({
    target,
    backend,
    environment,
    capabilityPolicy,
    semanticProviders,
    hostValueInterop,
    strictEnvImportGate,
    nativeRegime,
    nativeStringsRequiredByPolicy: strictEnvImportGate || semanticProviders === "native-first",
    ambientPlatform: input.ambientPlatform ?? ambientPlatformOf(input),
    ...(accelerators.length > 0 ? { accelerators } : {}),
  });
}

/**
 * (#6979) The last js2wasm release whose compiler accepted a host-semantic
 * spelling: `semanticProviders: "auto"` and the implicit host-assisted
 * profile behind `nativeStrings: false`. The S6 `"host-assisted"` spelling
 * never shipped in a release.
 */
export const REMOVED_SEMANTIC_PROVIDER_RELEASE = "0.71.0";

function removedSemanticProviderError(spelling: string): Error {
  return new Error(
    `Compile option ${spelling} selected the host-assisted semantic profile, which #6979 removed ` +
      `(last accepted by js2wasm ${REMOVED_SEMANTIC_PROVIDER_RELEASE}). The native semantic regime is the only ` +
      "ECMAScript implementation; omit the option. Host `wasm:js-string` strings, RegExp, Date and Intl stay " +
      "available as named host accelerators (hostAccelerators, #6978).",
  );
}

/**
 * (#6979) Validate the public spelling. `"native-first"` (or nothing) is the
 * only accepted selection; `"auto"` and `"host-assisted"` are compile errors.
 * An explicit `"native-first"` with `nativeStrings: false` is a contradiction.
 * Returns whether the caller spelled the policy explicitly: the linear backend
 * keeps its own provider choice unless it did.
 */
function validateSemanticProviderSelection(
  input: Pick<TargetProfileInput, "semanticProviders" | "nativeStrings">,
): boolean {
  const requested: unknown = input.semanticProviders;
  if (requested === undefined) return false;
  if (requested === "auto" || requested === "host-assisted") {
    throw removedSemanticProviderError(`semanticProviders: "${requested}"`);
  }
  if (requested !== "native-first") {
    throw new Error(`Compile option semanticProviders expects native-first (got ${String(requested)})`);
  }
  if (input.nativeStrings === false) {
    throw new Error(
      'Compile option semanticProviders: "native-first" conflicts with nativeStrings: false ' +
        "(the native regime runs on native strings; host `wasm:js-string` strings under it are the planned " +
        '"js-string" host accelerator, #6978)',
    );
  }
  return true;
}
