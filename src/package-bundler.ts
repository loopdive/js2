// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/** Static core-Wasm bundling for manifest-verified npm providers (#2527). */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CompileResult, LinkedModuleArtifact } from "./index.js";
import { RUNTIME_RECGROUP_ABI_VERSION } from "./emit/canonical-recgroup.js";
import { appendBundleManifest, bundleArtifactHash, type BundleManifestV1 } from "./bundle-manifest.js";
import { BINARYEN_PORTABLE_FEATURE_FLAGS } from "./binaryen-features.js";
import {
  decodeProviderManifest,
  providerArtifactHash,
  PROVIDER_COMPILER_ABI_VERSION,
  PROVIDER_LINKER_ABI_VERSION,
} from "./provider-manifest.js";

const ROOT_MODULE_NAMESPACE = "js2wasm:root" as const;

export interface MergedPackageBundle {
  binary: Uint8Array;
  wat: string;
  manifest: BundleManifestV1;
  cacheKey: string;
}

export interface PackageBundleOptions {
  optimize?: boolean | 1 | 2 | 3 | 4;
}

export type PackageBundleAttempt =
  | { kind: "merged"; bundle: MergedPackageBundle }
  | { kind: "unsupported"; reason: string };

function wasmBytes(binary: Uint8Array): BufferSource {
  return binary as unknown as BufferSource;
}

type BinaryenBundleTool = "wasm-merge" | "wasm-metadce" | "wasm-opt" | "wasm-dis";

function binaryenTool(name: BinaryenBundleTool): string {
  const require = createRequire(import.meta.url);
  const packageJson = require.resolve("binaryen/package.json");
  return join(dirname(packageJson), "bin", name);
}

function runBinaryenTool(tool: BinaryenBundleTool, args: string[]): void {
  execFileSync(process.execPath, [binaryenTool(tool), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

function providerManifest(artifact: LinkedModuleArtifact) {
  const manifest = decodeProviderManifest(artifact.binary, {
    compilerAbiVersion: PROVIDER_COMPILER_ABI_VERSION,
    linkerAbiVersion: PROVIDER_LINKER_ABI_VERSION,
    recgroupAbiVersion: RUNTIME_RECGROUP_ABI_VERSION,
  });
  if (providerArtifactHash(artifact.binary, manifest) !== artifact.cacheKey) {
    throw new Error(`provider ${artifact.namespace} has a mismatched content hash`);
  }
  if (!artifact.namespace.endsWith(artifact.cacheKey.slice(0, 16))) {
    throw new Error(`provider ${artifact.namespace} has a mismatched namespace identity`);
  }
  return manifest;
}

function staticLinkUnsupported(artifacts: readonly LinkedModuleArtifact[]): string | undefined {
  for (const artifact of artifacts) {
    const manifest = providerManifest(artifact);
    const nonFunctionBoundary = Object.entries(manifest.exportBoundaries).find(
      ([, boundary]) => boundary.kind !== "function",
    );
    if (nonFunctionBoundary) {
      return `${manifest.packageName}:${nonFunctionBoundary[0]} uses a ${nonFunctionBoundary[1].kind} JavaScript value boundary`;
    }
    if (manifest.initExport) {
      return `${manifest.packageName} requires provider-local deferred initialization`;
    }
    if (manifest.providerMetadata.imports.length > 0) {
      const imports = manifest.providerMetadata.imports.map((entry) => `${entry.module}.${entry.name}`).join(", ");
      return `${manifest.packageName} requires a provider-local host adapter${imports ? ` (${imports})` : ""}`;
    }
  }
  return undefined;
}

function rootExportNames(result: CompileResult): string[] {
  return WebAssembly.Module.exports(new WebAssembly.Module(wasmBytes(result.binary)))
    .filter(
      (entry) =>
        entry.kind === "function" || entry.kind === "global" || entry.kind === "memory" || entry.kind === "table",
    )
    .map((entry) => entry.name)
    .sort();
}

function makeBundleManifest(result: CompileResult, artifacts: readonly LinkedModuleArtifact[]): BundleManifestV1 {
  const providerManifests = artifacts.map(providerManifest);
  const stringPool = [
    ...new Set([result.stringPool, ...providerManifests.map((provider) => provider.stringPool)].flat()),
  ].sort();
  return {
    section: "js2wasm.bundle.v1",
    version: 1,
    compilerAbiVersion: PROVIDER_COMPILER_ABI_VERSION,
    linkerAbiVersion: PROVIDER_LINKER_ABI_VERSION,
    rootModule: ROOT_MODULE_NAMESPACE,
    rootExports: rootExportNames(result),
    providers: artifacts.map((artifact, index) => {
      const provider = providerManifests[index]!;
      return {
        packageName: provider.packageName,
        namespace: artifact.namespace,
        cacheKey: artifact.cacheKey,
        dependencies: provider.dependencies.map((dependency) => dependency.namespace),
        exports: provider.exports,
        exportBoundaries: provider.exportBoundaries,
        sourceFingerprint: provider.sourceFingerprint,
      };
    }),
    hostMetadata: {
      imports: result.imports,
      stringPool,
      targetProfile: result.targetProfile,
      adapterManifest: result.adapterManifest,
      capabilityRequirements: result.capabilityRequirements,
      capabilityProviderDiagnostics: result.capabilityProviderDiagnostics,
      exportBoundaryPolicies: result.exportBoundaryPolicies,
    },
  };
}

function narrowHostMetadataToFinalImports(manifest: BundleManifestV1, binary: Uint8Array): void {
  const finalImports = WebAssembly.Module.imports(new WebAssembly.Module(wasmBytes(binary)));
  const retained = new Set(finalImports.map((entry) => `${entry.module}\0${entry.name}`));
  manifest.hostMetadata.imports = manifest.hostMetadata.imports.filter((entry) =>
    retained.has(`${entry.module}\0${entry.name}`),
  );
  manifest.hostMetadata.stringPool = manifest.hostMetadata.stringPool.filter(
    (value) => retained.has(`string_constants\0${value}`) || retained.has(`string_constants16\0${value}`),
  );
}

/**
 * Merge the application and its cached provider modules into one core-Wasm
 * module. The application is first so its public export names win deterministic
 * conflict handling; metadata DCE then removes every unrooted provider export.
 */
export function mergePackageProviders(
  result: CompileResult,
  artifacts: readonly LinkedModuleArtifact[],
  options: PackageBundleOptions = {},
): PackageBundleAttempt {
  const unsupported = staticLinkUnsupported(artifacts);
  if (unsupported) return { kind: "unsupported", reason: unsupported };

  const manifest = makeBundleManifest(result, artifacts);
  const workDir = mkdtempSync(join(tmpdir(), "js2wasm-merge-"));
  try {
    const rootPath = join(workDir, "root.wasm");
    const mergedPath = join(workDir, "merged.wasm");
    const dcePath = join(workDir, "bundle.wasm");
    const optimizedPath = join(workDir, "bundle.optimized.wasm");
    const watPath = join(workDir, "bundle.wat");
    const graphPath = join(workDir, "roots.json");
    writeFileSync(rootPath, result.binary);

    const mergeArgs = [rootPath, ROOT_MODULE_NAMESPACE];
    artifacts.forEach((artifact, index) => {
      const providerPath = join(workDir, `provider-${index}.wasm`);
      writeFileSync(providerPath, artifact.binary);
      mergeArgs.push(providerPath, artifact.namespace);
    });
    mergeArgs.push(...BINARYEN_PORTABLE_FEATURE_FLAGS, "--rename-export-conflicts", "-o", mergedPath);
    runBinaryenTool("wasm-merge", mergeArgs);

    const graph = manifest.rootExports.map((name, index) => ({
      name: `js2wasm-root-export-${index}`,
      export: name,
      root: true,
    }));
    writeFileSync(graphPath, JSON.stringify(graph));
    runBinaryenTool("wasm-metadce", [
      mergedPath,
      ...BINARYEN_PORTABLE_FEATURE_FLAGS,
      "--graph-file",
      graphPath,
      "-o",
      dcePath,
    ]);

    let finalPath = dcePath;
    if (options.optimize) {
      const level = options.optimize === true ? 3 : options.optimize;
      runBinaryenTool("wasm-opt", [dcePath, `-O${level}`, ...BINARYEN_PORTABLE_FEATURE_FLAGS, "-o", optimizedPath]);
      finalPath = optimizedPath;
    }

    let binary: Uint8Array<ArrayBufferLike> = new Uint8Array(readFileSync(finalPath));
    const remainingProviderImport = WebAssembly.Module.imports(new WebAssembly.Module(wasmBytes(binary))).find(
      (entry) => artifacts.some((artifact) => artifact.namespace === entry.module),
    );
    if (remainingProviderImport) {
      return {
        kind: "unsupported",
        reason: `wasm-merge left unresolved provider import ${remainingProviderImport.module}.${remainingProviderImport.name}`,
      };
    }
    narrowHostMetadataToFinalImports(manifest, binary);
    if (result.wat.length > 0) {
      runBinaryenTool("wasm-dis", [finalPath, "--all-features", "-o", watPath]);
    }
    binary = appendBundleManifest(binary, manifest);
    // Validate the finalized bytes, including the appended authoritative
    // custom section, before they can replace the ordinary linked result.
    new WebAssembly.Module(wasmBytes(binary));

    return {
      kind: "merged",
      bundle: {
        binary,
        wat: result.wat.length > 0 ? readFileSync(watPath, "utf8") : "",
        manifest,
        cacheKey: bundleArtifactHash(binary),
      },
    };
  } catch (error) {
    return {
      kind: "unsupported",
      reason: `Binaryen static merge failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}
