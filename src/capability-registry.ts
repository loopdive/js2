// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import type { HostImportInventoryEntry } from "./host-import-policy.js";
import type { WasmModule, ValType } from "./ir/types.js";
import type { CompileEnvironment } from "./target-profile.js";
import {
  DOM_CAPABILITY_IMPORTS,
  DOM_CAPABILITY_PERMISSIONS,
  DOM_INTERACTION_CAPABILITY_IMPORTS,
  DOM_INTERACTION_CAPABILITY_PERMISSIONS,
} from "./dom-capability-contract.js";

export type CapabilityProviderId = "js-host" | "wasi-preview1" | "node" | "embedder";

export interface CapabilityProviderImportContract {
  readonly name: string;
  readonly kind: HostImportInventoryEntry["kind"];
  readonly params?: readonly string[];
  readonly results?: readonly string[];
}

export interface CapabilityProviderDefinition {
  readonly id: CapabilityProviderId;
  readonly environments: readonly CompileEnvironment[];
  readonly importNamespace: string;
  /** When present, every emitted import for this provider must match one of these ABI signatures. */
  readonly imports?: readonly CapabilityProviderImportContract[];
  /** Require exactly one occurrence of every registered import contract. */
  readonly completeImportContract?: boolean;
}

export interface PlatformCapabilityDefinition {
  readonly id: string;
  readonly abiNamespace: string;
  readonly abiVersion: 1;
  readonly permissions: readonly string[];
  readonly providers: readonly CapabilityProviderDefinition[];
}

export interface CapabilityImportRequirement {
  readonly module: string;
  readonly name: string;
  readonly kind: HostImportInventoryEntry["kind"];
  readonly params?: readonly string[];
  readonly results?: readonly string[];
}

export interface PlatformCapabilityRequirement {
  readonly id: string;
  readonly abiNamespace: string;
  readonly abiVersion: 1;
  readonly permissions: readonly string[];
  readonly selectedProviders: readonly CapabilityProviderId[];
  readonly compatibleProviders: readonly CapabilityProviderId[];
  readonly imports: readonly CapabilityImportRequirement[];
}

export type CapabilityProviderDiagnosticCode =
  | "abi-namespace-mismatch"
  | "abi-version-mismatch"
  | "permissions-mismatch"
  | "compatible-providers-mismatch"
  | "missing-provider"
  | "unsupported-provider"
  | "unsupported-environment"
  | "provider-namespace-mismatch"
  | "provider-import-mismatch";

export interface CapabilityProviderDiagnostic {
  readonly code: CapabilityProviderDiagnosticCode;
  readonly capability: string;
  readonly provider?: CapabilityProviderId;
  readonly message: string;
}

const provider = (
  id: CapabilityProviderId,
  environments: readonly CompileEnvironment[],
  importNamespace: string,
  imports?: readonly CapabilityProviderImportContract[],
  completeImportContract = false,
): CapabilityProviderDefinition =>
  Object.freeze({
    id,
    environments: Object.freeze([...environments]),
    importNamespace,
    ...(imports
      ? {
          imports: Object.freeze(
            imports.map((entry) =>
              Object.freeze({
                ...entry,
                ...(entry.params ? { params: Object.freeze([...entry.params]) } : {}),
                ...(entry.results ? { results: Object.freeze([...entry.results]) } : {}),
              }),
            ),
          ),
        }
      : {}),
    ...(completeImportContract ? { completeImportContract: true } : {}),
  });

const capability = (
  id: string,
  permissions: readonly string[],
  providers: readonly CapabilityProviderDefinition[],
): PlatformCapabilityDefinition =>
  Object.freeze({
    id,
    abiNamespace: `js2wasm:capability/${id}`,
    abiVersion: 1 as const,
    permissions: Object.freeze([...permissions]),
    providers: Object.freeze([...providers]),
  });

const TIMER_PROVIDER_IMPORTS: readonly CapabilityProviderImportContract[] = Object.freeze([
  Object.freeze({
    name: "__timer_set_timeout",
    kind: "func" as const,
    params: Object.freeze(["externref", "externref"]),
    results: Object.freeze(["externref"]),
  }),
  Object.freeze({
    name: "__timer_set_interval",
    kind: "func" as const,
    params: Object.freeze(["externref", "externref"]),
    results: Object.freeze(["externref"]),
  }),
  Object.freeze({
    name: "__timer_clear_timeout",
    kind: "func" as const,
    params: Object.freeze(["externref"]),
    results: Object.freeze([]),
  }),
  Object.freeze({
    name: "__timer_clear_interval",
    kind: "func" as const,
    params: Object.freeze(["externref"]),
    results: Object.freeze([]),
  }),
]);

const CLOCK_EMBEDDER_PROVIDER_IMPORTS: readonly CapabilityProviderImportContract[] = Object.freeze([
  Object.freeze({
    name: "__date_now",
    kind: "func" as const,
    params: Object.freeze([]),
    results: Object.freeze(["f64"]),
  }),
]);

/**
 * Versioned capability contracts already backed by more than one real target
 * provider. The source program names the standard API; target/provider policy
 * chooses one of these ABIs without changing source semantics.
 */
export const PLATFORM_CAPABILITY_REGISTRY: Readonly<Record<string, PlatformCapabilityDefinition>> = Object.freeze({
  clock: capability(
    "clock",
    ["clock:read"],
    [
      provider("js-host", ["javascript"], "env", [{ name: "__date_now", kind: "func", params: [], results: ["f64"] }]),
      provider("wasi-preview1", ["wasi"], "wasi_snapshot_preview1", [
        { name: "clock_time_get", kind: "func", params: ["i32", "i64", "i32"], results: ["i32"] },
      ]),
      provider("embedder", ["none"], "env", CLOCK_EMBEDDER_PROVIDER_IMPORTS, true),
    ],
  ),
  randomness: capability(
    "randomness",
    ["random:read"],
    [
      provider("js-host", ["javascript"], "env", [{ name: "Math_random", kind: "func", params: [], results: ["f64"] }]),
      provider("wasi-preview1", ["wasi", "none"], "wasi_snapshot_preview1", [
        { name: "random_get", kind: "func", params: ["i32", "i32"], results: ["i32"] },
      ]),
    ],
  ),
  console: capability("console", ["console:write"], [provider("js-host", ["javascript"], "env")]),
  timers: capability(
    "timers",
    ["timers:schedule"],
    [
      provider("js-host", ["javascript"], "env", TIMER_PROVIDER_IMPORTS),
      provider("embedder", ["none", "unknown"], "env", TIMER_PROVIDER_IMPORTS),
    ],
  ),
  dom: capability("dom", DOM_CAPABILITY_PERMISSIONS, [
    provider(
      "embedder",
      ["none"],
      "env",
      DOM_CAPABILITY_IMPORTS.map(({ name, params, results }) => ({
        name,
        kind: "func" as const,
        params,
        results,
      })),
      true,
    ),
  ]),
  "dom-interaction": capability("dom-interaction", DOM_INTERACTION_CAPABILITY_PERMISSIONS, [
    provider(
      "embedder",
      ["none"],
      "env",
      DOM_INTERACTION_CAPABILITY_IMPORTS.map(({ name, params, results }) => ({
        name,
        kind: "func" as const,
        params,
        results,
      })),
      true,
    ),
  ]),
  "module-loader": capability("module-loader", ["module:load"], [provider("js-host", ["javascript"], "env")]),
});

function valTypeName(type: ValType): string {
  switch (type.kind) {
    case "ref":
      return `ref:${type.typeIdx}`;
    case "ref_null":
      return `ref-null:${type.typeIdx}`;
    case "ref_extern":
      return "ref-extern";
    default:
      return type.kind;
  }
}

function importSignature(
  mod: WasmModule,
  importIndex: number,
): Pick<CapabilityImportRequirement, "params" | "results"> {
  const desc = mod.imports[importIndex]?.desc;
  if (!desc || desc.kind !== "func") return {};
  const type = mod.types[desc.typeIdx];
  if (!type || type.kind !== "func") return {};
  return {
    params: Object.freeze(type.params.map(valTypeName)),
    results: Object.freeze(type.results.map(valTypeName)),
  };
}

function providerIdForImport(
  entry: Pick<HostImportInventoryEntry, "module">,
  definition?: PlatformCapabilityDefinition,
  environment?: CompileEnvironment,
): CapabilityProviderId {
  const environmentMatches = definition?.providers.filter(
    (candidate) =>
      candidate.importNamespace === entry.module &&
      (environment === undefined || candidate.environments.includes(environment)),
  );
  if (environmentMatches?.length === 1) return environmentMatches[0]!.id;
  if (entry.module === "env") return "js-host";
  if (entry.module === "wasi_snapshot_preview1") return "wasi-preview1";
  if (entry.module.startsWith("node:")) return "node";
  return "embedder";
}

function fallbackDefinition(family: string): PlatformCapabilityDefinition {
  return capability(family, [], [provider("embedder", ["unknown"], "*")]);
}

function stringArraysEqual(left: readonly string[] | undefined, right: readonly string[] | undefined): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function stringSetsEqual(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function importContractMatches(
  actual: CapabilityImportRequirement,
  expected: CapabilityProviderImportContract,
): boolean {
  return (
    actual.name === expected.name &&
    actual.kind === expected.kind &&
    stringArraysEqual(actual.params, expected.params) &&
    stringArraysEqual(actual.results, expected.results)
  );
}

/**
 * Prove that one concrete Wasm import is covered by an exact registered
 * capability/provider ABI for the selected target environment.
 *
 * This is intentionally stricter than requirement construction: providers
 * without an explicit import contract return false, so a no-leak backstop can
 * never interpret missing registry evidence as permission.
 */
export function isValidatedPlatformCapabilityImport(
  mod: WasmModule,
  importIndex: number,
  capabilityId: string,
  providerId: CapabilityProviderId,
  environment: CompileEnvironment,
): boolean {
  const definition = PLATFORM_CAPABILITY_REGISTRY[capabilityId];
  const selectedProvider = definition?.providers.find(({ id }) => id === providerId);
  const entry = mod.imports[importIndex];
  if (
    !selectedProvider ||
    !selectedProvider.environments.includes(environment) ||
    !selectedProvider.imports ||
    !entry ||
    entry.module !== selectedProvider.importNamespace
  ) {
    return false;
  }
  const actual: CapabilityImportRequirement = {
    module: entry.module,
    name: entry.name,
    kind: entry.desc.kind,
    ...importSignature(mod, importIndex),
  };
  return selectedProvider.imports.some((expected) => importContractMatches(actual, expected));
}

/**
 * Authenticate the exact standalone clock provider only after codegen retained
 * a compiler-certified Date snapshot demand. Registry shape alone is not
 * authority: user source may declare an ambient function named `__date_now`.
 */
export function hasCertifiedStandaloneClockCapabilityProvider(
  mod: WasmModule,
  compilerCertifiedDemand: boolean,
  environment: CompileEnvironment,
): boolean {
  if (!compilerCertifiedDemand || environment !== "none") return false;
  const clockImports = mod.imports
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.module === "env" && entry.name === "__date_now");
  return (
    clockImports.length === 1 &&
    mod.platformCapabilityImportProvenance?.get(clockImports[0]!.entry)?.capabilityId === "clock" &&
    mod.platformCapabilityImportProvenance?.get(clockImports[0]!.entry)?.providerId === "embedder" &&
    isValidatedPlatformCapabilityImport(mod, clockImports[0]!.index, "clock", "embedder", "none")
  );
}

/** Validate emitted provider bindings against the same frozen registry used to describe them. */
export function validatePlatformCapabilityRequirements(
  requirements: readonly PlatformCapabilityRequirement[],
  environment: CompileEnvironment,
): readonly CapabilityProviderDiagnostic[] {
  const diagnostics: CapabilityProviderDiagnostic[] = [];
  const report = (
    code: CapabilityProviderDiagnosticCode,
    capabilityId: string,
    message: string,
    selectedProvider?: CapabilityProviderId,
  ): void => {
    diagnostics.push(
      Object.freeze({
        code,
        capability: capabilityId,
        ...(selectedProvider ? { provider: selectedProvider } : {}),
        message,
      }),
    );
  };

  for (const requirement of requirements) {
    const definition = PLATFORM_CAPABILITY_REGISTRY[requirement.id];
    // Embedder-defined capabilities remain explicit requirements, but only a
    // registered contract can be validated by this compiler version.
    if (!definition) continue;
    if (requirement.abiNamespace !== definition.abiNamespace) {
      report(
        "abi-namespace-mismatch",
        requirement.id,
        `capability '${requirement.id}' requires namespace '${requirement.abiNamespace}', expected '${definition.abiNamespace}'`,
      );
    }
    if (requirement.abiVersion !== definition.abiVersion) {
      report(
        "abi-version-mismatch",
        requirement.id,
        `capability '${requirement.id}' requires ABI v${requirement.abiVersion}, expected v${definition.abiVersion}`,
      );
    }
    if (!stringSetsEqual(requirement.permissions, definition.permissions)) {
      report(
        "permissions-mismatch",
        requirement.id,
        `capability '${requirement.id}' permissions do not match its registered ABI v${definition.abiVersion}`,
      );
    }
    const compatibleProviders = definition.providers.map(({ id }) => id);
    if (!stringSetsEqual(requirement.compatibleProviders, compatibleProviders)) {
      report(
        "compatible-providers-mismatch",
        requirement.id,
        `capability '${requirement.id}' compatible providers do not match its registered ABI v${definition.abiVersion}`,
      );
    }
    if (requirement.selectedProviders.length === 0) {
      report("missing-provider", requirement.id, `capability '${requirement.id}' has no selected provider`);
      continue;
    }

    for (const selectedProviderId of requirement.selectedProviders) {
      const providerDefinition = definition.providers.find(({ id }) => id === selectedProviderId);
      if (!providerDefinition) {
        report(
          "unsupported-provider",
          requirement.id,
          `provider '${selectedProviderId}' does not implement capability '${requirement.id}' ABI v${definition.abiVersion}`,
          selectedProviderId,
        );
        continue;
      }
      if (!providerDefinition.environments.includes(environment)) {
        report(
          "unsupported-environment",
          requirement.id,
          `provider '${selectedProviderId}' for capability '${requirement.id}' does not support environment '${environment}'`,
          selectedProviderId,
        );
      }

      const selectedImports =
        requirement.selectedProviders.length === 1
          ? requirement.imports
          : requirement.imports.filter((entry) => providerIdForImport(entry) === selectedProviderId);
      if (
        providerDefinition.completeImportContract &&
        providerDefinition.imports &&
        (selectedImports.length !== providerDefinition.imports.length ||
          providerDefinition.imports.some(
            (expected) => selectedImports.filter((actual) => importContractMatches(actual, expected)).length !== 1,
          ))
      ) {
        report(
          "provider-import-mismatch",
          requirement.id,
          `provider '${selectedProviderId}' must declare the complete capability '${requirement.id}' ABI v${definition.abiVersion} import contract`,
          selectedProviderId,
        );
      }
      for (const actual of selectedImports) {
        if (actual.module !== providerDefinition.importNamespace) {
          report(
            "provider-namespace-mismatch",
            requirement.id,
            `provider '${selectedProviderId}' import '${actual.module}::${actual.name}' must use namespace '${providerDefinition.importNamespace}'`,
            selectedProviderId,
          );
          continue;
        }
        if (
          providerDefinition.imports &&
          !providerDefinition.imports.some((expected) => importContractMatches(actual, expected))
        ) {
          report(
            "provider-import-mismatch",
            requirement.id,
            `provider '${selectedProviderId}' import '${actual.module}::${actual.name}' does not match capability '${requirement.id}' ABI v${definition.abiVersion}`,
            selectedProviderId,
          );
        }
      }
    }
  }

  return Object.freeze(
    diagnostics.sort(
      (left, right) =>
        left.capability.localeCompare(right.capability) ||
        left.code.localeCompare(right.code) ||
        (left.provider ?? "").localeCompare(right.provider ?? ""),
    ),
  );
}

/** Build the explicit platform-capability requirement set for one module. */
export function buildCapabilityRequirements(
  mod: WasmModule,
  inventory: readonly HostImportInventoryEntry[],
  environment?: CompileEnvironment,
): PlatformCapabilityRequirement[] {
  const grouped = new Map<string, Array<{ entry: HostImportInventoryEntry; index: number }>>();
  for (let index = 0; index < inventory.length; index++) {
    const entry = inventory[index]!;
    if (entry.classification !== "platform-capability") continue;
    // The clock import's public name/signature can be reproduced by an
    // ambient source declaration.  Only the exact Import object allocated by
    // the compiler-owned Date snapshot provider may mint clock@1 authority.
    if (environment === "none" && entry.family === "clock") {
      const imported = mod.imports[index];
      const provenance = imported ? mod.platformCapabilityImportProvenance?.get(imported) : undefined;
      if (provenance?.capabilityId !== "clock" || provenance.providerId !== "embedder") continue;
    }
    const entries = grouped.get(entry.family) ?? [];
    entries.push({ entry, index });
    grouped.set(entry.family, entries);
  }

  return [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([family, entries]) => {
      const definition = PLATFORM_CAPABILITY_REGISTRY[family] ?? fallbackDefinition(family);
      const selectedProviders = [
        ...new Set(entries.map(({ entry }) => providerIdForImport(entry, definition, environment))),
      ].sort();
      const imports = entries
        .map(({ entry, index }) =>
          Object.freeze({
            module: entry.module,
            name: entry.name,
            kind: entry.kind,
            ...importSignature(mod, index),
          }),
        )
        .sort((left, right) => left.module.localeCompare(right.module) || left.name.localeCompare(right.name));
      return Object.freeze({
        id: definition.id,
        abiNamespace: definition.abiNamespace,
        abiVersion: definition.abiVersion,
        permissions: definition.permissions,
        selectedProviders: Object.freeze(selectedProviders),
        compatibleProviders: Object.freeze(definition.providers.map(({ id }) => id)),
        imports: Object.freeze(imports),
      });
    });
}
