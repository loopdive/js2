// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { CompileTarget } from "./compile-target.js";

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

export interface TargetProfileInput {
  readonly target?: CompileTarget;
  /** Explicit native backend selection; target still defines the execution environment. */
  readonly backend?: CompileBackend;
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
