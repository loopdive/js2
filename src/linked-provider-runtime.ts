// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Runtime side of #2527's separately compiled npm provider graph. */

import type { CompileResult, LinkedModuleArtifact } from "./index.js";
import { RUNTIME_RECGROUP_ABI_VERSION } from "./emit/canonical-recgroup.js";
import {
  canonicalProviderManifestJson,
  decodeProviderManifest,
  providerArtifactHash,
  PROVIDER_COMPILER_ABI_VERSION,
  PROVIDER_LINKER_ABI_VERSION,
  type ProviderManifestV1,
} from "./provider-manifest.js";
import {
  buildCompiledImports as buildCompiledImportsRuntime,
  registerLinkedConsumerModule,
  registerLinkedProviderModule,
  wrapLinkedProviderValue,
} from "./runtime.js";

// (#5364) Re-exported so the ONE test262 instantiate seam
// (`scripts/test262-import-object.mjs`) can retire the previous row's project
// through the SAME runtime copy that `instantiateLinkedProviders` registers
// into. The in-process lanes reach that copy by dynamically importing THIS
// module; the sharded worker passes `scripts/runtime-bundle.mjs` instead. Both
// therefore need the reset on the same object as the wiring — a reset in the
// other copy is the silent-wrong-copy bug #5353 finding 3 describes.
export { resetLinkedProjectRegistry } from "./runtime.js";

function wasmBytes(binary: Uint8Array): BufferSource {
  return binary as unknown as BufferSource;
}

/**
 * (#5226) The one exception tag a linked graph throws and catches with.
 *
 * Wasm matches a `catch` clause by tag IDENTITY, so a module-local tag per
 * module makes a provider's `throw` uncatchable by its consumer: the payload
 * fell through to `catch_all`, whose `__get_caught_exception()` never saw a host
 * frame and answered `undefined`. Both halves import `env.__exn`; installing the
 * SAME `WebAssembly.Tag` object on both import objects is what makes the
 * crossing lossless — the host-native `RangeError` arrives by identity, so
 * `instanceof`, `name`, `message` and own props all survive.
 *
 * One tag per PROCESS rather than per graph: tags carry no state, and the only
 * way two graphs' frames interleave is one calling the other, where sharing is
 * exactly what is wanted.
 */
// TypeScript 5's DOM library predates the Wasm exception-handling API. This
// runtime only needs the tag's object identity, so describe that narrow common
// surface locally instead of requiring TypeScript 7's ambient declaration.
type SharedExceptionTag = object;
type SharedExceptionTagConstructor = new (type: { parameters: WebAssembly.ValueType[] }) => SharedExceptionTag;

let sharedExceptionTag: SharedExceptionTag | undefined;

export function installSharedExceptionTag(imports: WebAssembly.Imports): void {
  const Tag = (WebAssembly as unknown as { Tag?: SharedExceptionTagConstructor }).Tag;
  if (!Tag) return;
  sharedExceptionTag ??= new Tag({ parameters: ["externref"] });
  const env = ((imports as Record<string, unknown>).env ??= {}) as Record<string, unknown>;
  env.__exn = sharedExceptionTag;
}

/**
 * Decode and validate the embedded provider manifest. Artifact fields remain
 * convenience views; the custom section is authoritative at instantiation.
 */
function decodeLinkedProviderManifest(artifact: LinkedModuleArtifact): ProviderManifestV1 {
  const manifest = decodeProviderManifest(artifact.binary, {
    linkerAbiVersion: PROVIDER_LINKER_ABI_VERSION,
    compilerAbiVersion: PROVIDER_COMPILER_ABI_VERSION,
    recgroupAbiVersion: RUNTIME_RECGROUP_ABI_VERSION,
  });
  if (providerArtifactHash(artifact.binary, manifest) !== artifact.cacheKey) {
    throw new Error(`Linked provider ${artifact.namespace} has a mismatched content hash`);
  }
  if (artifact.packageName) {
    const expectedPrefix = `js2wasm:npm:${artifact.packageName}:`;
    if (
      manifest.packageName !== artifact.packageName ||
      !artifact.namespace.startsWith(expectedPrefix) ||
      !artifact.namespace.endsWith(artifact.cacheKey.slice(0, 16))
    ) {
      throw new Error(`Linked provider ${artifact.namespace} has a mismatched namespace identity`);
    }
  }
  if (artifact.providerMetadata) {
    if (
      canonicalProviderManifestJson(artifact.providerMetadata) !==
      canonicalProviderManifestJson(manifest.providerMetadata)
    ) {
      throw new Error(`Linked provider ${artifact.namespace} has mismatched convenience metadata`);
    }
  }
  if (artifact.initExport !== manifest.initExport) {
    throw new Error(`Linked provider ${artifact.namespace} has mismatched initializer metadata`);
  }
  if (
    artifact.exports.some((name, index) => manifest.exports[index] !== name) ||
    artifact.exports.length !== manifest.exports.length
  ) {
    throw new Error(`Linked provider ${artifact.namespace} has mismatched exports`);
  }
  if (
    artifact.exportSignatures &&
    canonicalProviderManifestJson(artifact.exportSignatures) !==
      canonicalProviderManifestJson(manifest.exportSignatures)
  ) {
    throw new Error(`Linked provider ${artifact.namespace} has mismatched export signatures`);
  }
  if (
    artifact.exportBoundaries &&
    canonicalProviderManifestJson(artifact.exportBoundaries) !==
      canonicalProviderManifestJson(manifest.exportBoundaries)
  ) {
    throw new Error(`Linked provider ${artifact.namespace} has mismatched export boundaries`);
  }
  const moduleExports = WebAssembly.Module.exports(new WebAssembly.Module(wasmBytes(artifact.binary)));
  for (const boundary of Object.values(manifest.exportBoundaries)) {
    if (!moduleExports.some((entry) => entry.kind === "function" && entry.name === boundary.field)) {
      throw new Error(`Linked provider ${artifact.namespace} is missing boundary ${boundary.field}`);
    }
  }
  if (
    artifact.stringPool &&
    canonicalProviderManifestJson(artifact.stringPool) !== canonicalProviderManifestJson(manifest.stringPool)
  ) {
    throw new Error(`Linked provider ${artifact.namespace} has mismatched string pool metadata`);
  }
  if (
    artifact.dependencies.length !== manifest.dependencies.length ||
    artifact.dependencies.some((namespace, index) => manifest.dependencies[index]?.namespace !== namespace)
  ) {
    throw new Error(`Linked provider ${artifact.namespace} has mismatched dependency identity`);
  }
  return manifest;
}

/** Build a fresh host adapter for one provider instance. */
function buildProviderImportObject(
  artifact: LinkedModuleArtifact,
  overrides?: WebAssembly.Imports,
): WebAssembly.Imports {
  const manifest = decodeLinkedProviderManifest(artifact);
  const metadata = manifest.providerMetadata;
  const providerResult = {
    binary: artifact.binary,
    wat: "",
    dts: "",
    importsHelper: "",
    success: true,
    errors: [],
    stringPool: metadata.stringPool,
    imports: metadata.imports,
    hasMain: false,
    hasTopLevelStatements: artifact.initExport !== undefined,
    targetProfile: metadata.targetProfile,
    adapterManifest: metadata.adapterManifest,
    capabilityRequirements: metadata.capabilityRequirements,
    capabilityProviderDiagnostics: metadata.capabilityProviderDiagnostics,
    exportBoundaryPolicies: metadata.exportBoundaryPolicies,
  } as CompileResult;
  const built = buildCompiledImportsRuntime(providerResult);
  const imports = {
    // Provider-owned wrappers must win over inherited root wrappers: the
    // adapter carries per-instance callback/host state.
    env: { ...((overrides?.env as Record<string, Function> | undefined) ?? {}), ...built.env },
    "wasm:js-string": built["wasm:js-string"],
    string_constants: built.string_constants,
    string_constants16: built.string_constants16,
  } as unknown as WebAssembly.Imports;
  // Explicit link namespaces are inherited; env/string namespaces are rebuilt
  // for the provider's own lifecycle and string pool.
  if (overrides) {
    for (const [module, value] of Object.entries(overrides)) {
      if (
        module === "env" ||
        module === "wasm:js-string" ||
        module === "string_constants" ||
        module === "string_constants16"
      ) {
        continue;
      }
      imports[module] = value;
    }
  }
  if (built.setExports) {
    Object.defineProperty(imports, "__setExports", {
      value: built.setExports,
      enumerable: false,
      configurable: true,
    });
  }
  if (built.setInstance) {
    Object.defineProperty(imports, "__setInstance", {
      value: built.setInstance,
      enumerable: false,
      configurable: true,
    });
  }
  return imports;
}

function wireProviderInstance(
  artifact: LinkedModuleArtifact,
  providerImports: WebAssembly.Imports,
  instance: WebAssembly.Instance,
): void {
  const manifest = decodeLinkedProviderManifest(artifact);
  const setInstance = (providerImports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance;
  setInstance?.(instance);
  if (manifest.initExport) {
    const init = instance.exports[manifest.initExport];
    if (typeof init !== "function") {
      throw new Error(`Linked provider ${artifact.namespace} is missing ${manifest.initExport}`);
    }
    (init as () => void)();
  }
}

/**
 * Instantiate providers in their already-planned topological order. The root
 * import object is populated with each provider export namespace, allowing
 * both legacy `result.importObject` and fresh linked-project instantiation to
 * share exactly one provider lifecycle implementation.
 */
export function instantiateLinkedProviders(
  artifacts: readonly LinkedModuleArtifact[],
  rootImports: WebAssembly.Imports,
): ReadonlyMap<string, WebAssembly.Exports> {
  const providerExports = new Map<string, WebAssembly.Exports>();
  // (#5226) The consumer's own import object needs the tag too — it is the
  // module that CATCHES what a provider throws.
  if (artifacts.length > 0) installSharedExceptionTag(rootImports);
  for (const artifact of artifacts) {
    const providerImports = buildProviderImportObject(artifact, rootImports);
    installSharedExceptionTag(providerImports);
    for (const dependency of artifact.dependencies) {
      const exports = providerExports.get(dependency);
      if (!exports) throw new Error(`Missing linked provider dependency ${dependency}`);
      providerImports[dependency] = exports;
    }
    const instance = new WebAssembly.Instance(new WebAssembly.Module(wasmBytes(artifact.binary)), providerImports);
    wireProviderInstance(artifact, providerImports, instance);
    const manifest = decodeLinkedProviderManifest(artifact);
    const rawExports = instance.exports as Record<string, Function>;
    // (#5225) Register unconditionally: a provider whose whole export surface is
    // plain FUNCTIONS never reaches `wrapLinkedProviderValue` (the loop below
    // skips `kind === "function"`), yet its `__extern_get` is exactly where a
    // consumer-minted argument arrives undecodable.
    registerLinkedProviderModule(rawExports);
    const exposedExports: Record<string, any> = { ...rawExports };
    for (const boundary of Object.values(manifest.exportBoundaries)) {
      if (boundary.kind === "function") continue;
      const getter = rawExports[boundary.field];
      if (typeof getter !== "function") {
        throw new Error(`Linked provider ${artifact.namespace} has no getter ${boundary.field}`);
      }
      exposedExports[boundary.field] = (...args: any[]) => wrapLinkedProviderValue(getter(...args), rawExports);
    }
    providerExports.set(artifact.namespace, exposedExports as WebAssembly.Exports);
    rootImports[artifact.namespace] = exposedExports as WebAssembly.Exports;
  }
  return providerExports;
}

/** Wire root runtime lifecycle state after a consumer instance is created. */
export function wireCompiledInstance(
  imports: WebAssembly.Imports,
  instance: WebAssembly.Instance,
  // (#5225) Only a LINKED consumer joins the cross-module decoder registry; a
  // lone module must keep the registry empty so every read stays byte-identical.
  linked = false,
): void {
  const setInstance = (imports as { __setInstance?: (instance: WebAssembly.Instance) => void }).__setInstance;
  setInstance?.(instance);
  if (linked) registerLinkedConsumerModule(instance.exports as Record<string, Function>);
}
