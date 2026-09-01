// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * Compile-once `Temporal` provider (#4628, Option A).
 *
 * #661 shipped a compile-time LOWERING of `Temporal.*` syntax
 * (`src/codegen/temporal-native.ts`), not a runtime object: there is no
 * `Temporal` value at run time, which is why 1,589 test262 rows still read
 * `Temporal is not defined` (baseline 2026-08-29, recorded in the issue file).
 * The #4628 spike measured `@js-temporal/polyfill@0.5.1` + `jsbi@4.3.0`
 * through the front end and found ZERO compile errors, so Option A — compile
 * the real polyfill and publish its `Temporal` export — is the path.
 *
 * The number that decides the SHAPE of this module is the polyfill's compile
 * cost: ~32 s measured on the ESM linked lane. Prepending the polyfill to each
 * test body (the `$262`-style source-level preamble, the only established way
 * to inject a realm global) would cost 32 s × 4,611 Temporal rows ≈ 41 h of
 * added compile. So the polyfill is compiled ONCE into a separate provider
 * module and LINKED, and the per-consumer cost is one extra instantiation.
 *
 * Nothing here is Temporal-specific machinery: it drives the existing npm
 * package linker (`src/package-linker.ts`, #2527), which already compiles a
 * bare-package edge into its own binary, content-addresses it into a provider
 * cache, and hands the consumer an import map over the frozen cross-module
 * type group (`RUNTIME_RECGROUP_ABI_VERSION`). The polyfill is presented to
 * that linker as an ordinary one-file package.
 *
 * SOURCE ACQUISITION IS DELIBERATELY NOT HERE. The caller passes the linked
 * bundle text. The pinned-tarball acquisition (two committed tarballs verified
 * against their canonical npm sha1, no run-time network) lives with the rest
 * of the dogfood contract in `tests/dogfood/setup-temporal-polyfill.mjs`, so
 * `src/` carries no test fixture path and this module stays a general
 * "compile this bundle once and expose its `Temporal` export" service.
 *
 * STANDALONE SCOPE — HOST LANE ONLY, on purpose. See the note on
 * {@link buildTemporalProvider}.
 */

import * as path from "path";
import * as nodeCrypto from "node:crypto";

import type { CompileOptions, CompileResult, LinkedModuleArtifact } from "./index.js";
import { compileMulti, compileProject } from "./index.js";
import { getDefaultEnvironment } from "./env.js";

/** npm package name the polyfill bundle is presented to the linker under. */
export const TEMPORAL_PACKAGE_NAME = "@js-temporal/polyfill";
/** The single export this provider publishes as the runtime global. */
export const TEMPORAL_EXPORT_NAME = "Temporal";
/** Declaration-only stub key handed to the consumer graph. */
export const TEMPORAL_STUB_KEY = "./__js2wasm_temporal_provider.ts";
/**
 * Lines the consumer prelude adds ahead of user source. Callers that map a
 * runtime error back to a source line (the test262 runner does) must subtract
 * this. Kept at ONE line on purpose — the prelude is a single statement pair.
 */
export const TEMPORAL_PRELUDE_LINES = 1;

export interface TemporalProvider {
  /** The compiled provider, ready for `instantiateLinkedProviders`. */
  artifact: LinkedModuleArtifact;
  /** Deterministic Wasm import namespace the consumer imports from. */
  namespace: string;
  /** Provider export that returns the live `Temporal` object. */
  getterField: string;
  /** Wall-clock cost of producing it (0-ish on a cache hit). */
  buildMs: number;
  /** True when the provider binary came from the content-addressed cache. */
  cacheHit: boolean;
}

export interface BuildTemporalProviderOptions {
  /**
   * The polyfill bundle as ONE self-contained ES module whose exports include
   * `Temporal`. `@js-temporal/polyfill`'s published `dist/index.esm.js` is not
   * self-contained (it imports `jsbi`); the dogfood setup links the two.
   */
  polyfillSource: string;
  /** Directory for the synthetic project and the provider binary cache. */
  cacheDir: string;
  /** Compile options forwarded to the provider compile. */
  compileOptions?: CompileOptions;
}

interface CachedTemporalProvider {
  provider: TemporalProvider;
}

// One provider per (source, options) per process. The disk cache under
// `cacheDir` is the cross-process boundary; this map makes repeated consumers
// in ONE worker provably compile the polyfill once even when their entry
// files live under different directories.
const memoryCache = new Map<string, CachedTemporalProvider>();

/** @internal Test seam for exercising cold-build behaviour. */
export function clearTemporalProviderMemoryCacheForTests(): void {
  memoryCache.clear();
}

function fingerprint(parts: readonly string[]): string {
  const hash = nodeCrypto.createHash("sha256");
  for (const part of parts) {
    hash.update(String(part.length));
    hash.update(":");
    hash.update(part);
    hash.update("\n");
  }
  return hash.digest("hex");
}

function providerOptionFingerprint(options: CompileOptions | undefined): string {
  return JSON.stringify({
    target: options?.target ?? "gc",
    fast: options?.fast === true,
    nativeStrings: options?.nativeStrings === true,
    utf8Storage: options?.utf8Storage === true,
    semanticProviders: options?.semanticProviders ?? "auto",
    hostBridge: options?.hostBridge ?? "auto",
    platform: options?.platform ?? "web",
  });
}

/**
 * Compile the polyfill once into a linked provider artifact.
 *
 * STANDALONE MODE IS OUT OF SCOPE HERE, and that is a real gap, not an
 * oversight: this lane is `--target gc` with the JS host adapter. The polyfill
 * reaches the host through the ordinary compiled-object bridge — no NEW host
 * import is introduced by this module (it adds none; the provider's import set
 * is whatever the polyfill's own compile needs, and the linker refuses any
 * namespace outside `env` / the string namespaces / declared `link:` targets).
 * So the dual-mode principle is not violated by a new host dependency, but a
 * standalone (`--target wasi` / `--no-host-imports`) Temporal global does NOT
 * exist yet: the provider deferred-init export the linker requires is
 * documented as unavailable for WASI (`src/package-linker.ts`, "the deferred
 * export is unavailable for WASI, whose startup contract is `_start`"). Wiring
 * standalone needs that provider-startup lifecycle first and is deliberately
 * left to a follow-up.
 */
export async function buildTemporalProvider(options: BuildTemporalProviderOptions): Promise<TemporalProvider> {
  const key = fingerprint([options.polyfillSource, providerOptionFingerprint(options.compileOptions)]);
  const cached = memoryCache.get(key);
  if (cached) return { ...cached.provider, buildMs: 0, cacheHit: true };

  const fs = getDefaultEnvironment().fs;
  if (!fs) throw new Error("buildTemporalProvider requires a filesystem environment");

  const started = Date.now();
  // The linker consumes a real module graph, so the bundle is materialized as
  // a one-file npm package next to its own provider cache. The directory is
  // keyed by the source fingerprint, so a bundle bump never reuses stale text.
  const projectRoot = path.join(options.cacheDir, `temporal-project-${key.slice(0, 16)}`);
  const packageRoot = path.join(projectRoot, "node_modules", "@js-temporal", "polyfill");
  fs.mkdirSync(packageRoot, { recursive: true });
  fs.writeFileSync(
    path.join(packageRoot, "package.json"),
    JSON.stringify({ name: TEMPORAL_PACKAGE_NAME, version: "0.0.0-linked", main: "index.js" }),
  );
  fs.writeFileSync(path.join(packageRoot, "index.js"), options.polyfillSource);
  const entryPath = path.join(projectRoot, "__js2wasm_temporal_entry.js");
  // The root exists only to make `Temporal` an external package edge the
  // linker must plan; its own binary is discarded.
  fs.writeFileSync(
    entryPath,
    `import { ${TEMPORAL_EXPORT_NAME} } from "${TEMPORAL_PACKAGE_NAME}";\n` +
      `export function __js2wasm_temporal_probe() { return typeof ${TEMPORAL_EXPORT_NAME}; }\n`,
  );

  const result = await compileProject(entryPath, {
    ...options.compileOptions,
    allowJs: true,
    emitWat: false,
    skipSemanticDiagnostics: true,
    packageCacheDir: path.join(options.cacheDir, "providers"),
  });
  if (!result.success) {
    const errors = (result.errors ?? [])
      .filter((error) => error.severity !== "warning")
      .slice(0, 5)
      .map((error) => error.message)
      .join("; ");
    throw new Error(`Temporal provider compilation failed: ${errors || "unknown error"}`);
  }
  // A `bundled` plan means the linker declined a separate provider and inlined
  // the polyfill into the root — the exact outcome this module exists to
  // avoid, so it is an error, never a silent 32 s-per-consumer degrade.
  if (result.linkPlan?.mode !== "separate") {
    throw new Error(
      `Temporal provider was not linked separately (plan=${result.linkPlan?.mode ?? "none"}` +
        `${result.linkPlan?.fallbackReason ? `, reason=${result.linkPlan.fallbackReason}` : ""})`,
    );
  }
  const artifact = (result.linkedModules ?? []).find((entry) => entry.packageName === TEMPORAL_PACKAGE_NAME);
  if (!artifact) throw new Error("Temporal provider artifact missing from the link plan");
  const boundary = artifact.exportBoundaries?.[TEMPORAL_EXPORT_NAME];
  if (!boundary || boundary.kind !== "getter") {
    throw new Error(
      `Temporal provider published ${TEMPORAL_EXPORT_NAME} as ${boundary?.kind ?? "nothing"}, expected a getter`,
    );
  }

  const provider: TemporalProvider = {
    artifact,
    namespace: artifact.namespace,
    getterField: boundary.field,
    buildMs: Date.now() - started,
    cacheHit: artifact.cacheHit === true,
  };
  memoryCache.set(key, { provider });
  return provider;
}

/** The declaration-only stub the consumer graph imports the getter from. */
export function temporalStubSource(provider: TemporalProvider): string {
  return `export declare function ${provider.getterField}(): any;\n`;
}

/**
 * The one-line prelude that makes bare `Temporal` in user source resolve to
 * the provider's export.
 *
 * `const` (not `var`) so the binding SHADOWS any ambient `Temporal` for the
 * whole module — that shadowing is the entire mechanism by which the compiled
 * global replaces the "Temporal is not defined" host ambient.
 */
export function temporalPrelude(provider: TemporalProvider): string {
  return (
    `import { ${provider.getterField} } from "${TEMPORAL_STUB_KEY.replace(/\.ts$/, "")}"; ` +
    `const ${TEMPORAL_EXPORT_NAME}: any = ${provider.getterField}();\n`
  );
}

/**
 * Does this source reference a free `Temporal`?
 *
 * A cheap textual pre-filter, on purpose: the prelude costs a wasm import and
 * a provider instantiation, so it is only worth adding for sources that could
 * use it. A false POSITIVE is harmless (an unused binding); a false NEGATIVE
 * would silently keep the old "not defined" behaviour, so the pattern is
 * deliberately loose — any `Temporal` identifier occurrence, including inside
 * a string, opts in.
 */
export function referencesTemporal(source: string): boolean {
  return /\bTemporal\b/.test(source);
}

/**
 * Compile `userSource` with `Temporal` bound to the compiled provider.
 *
 * The result carries the provider in `linkedModules`, so the ordinary
 * `result.importObject` path and `instantiateLinkedProject` both work with no
 * caller-side provider handling.
 */
export async function compileWithTemporalGlobal(
  userSource: string,
  provider: TemporalProvider,
  options?: CompileOptions & { fileName?: string },
): Promise<CompileResult> {
  const entryKey = options?.fileName ?? "/__js2wasm_temporal_main.js";
  const files: Record<string, string> = {
    [TEMPORAL_STUB_KEY]: temporalStubSource(provider),
    [entryKey]: `${temporalPrelude(provider)}${userSource}`,
  };
  const bindings = new Map<string, { module: string; field: string }>([
    [provider.getterField, { module: provider.namespace, field: provider.getterField }],
  ]);
  const result = await compileMulti(files, entryKey, {
    ...options,
    allowJs: options?.allowJs ?? true,
    canonicalRuntimeTypes: true,
    // (#5226) Match the provider's imported `env.__exn` tag so a polyfill throw
    // keeps its host-native identity in the consumer's `catch`.
    sharedExceptionTag: true,
    link: [...new Set([...(options?.link ?? []), provider.namespace])],
    linkedPackageBindings: bindings,
  });
  // Publish the provider so instantiation wires it exactly the way a
  // compileProject-linked graph does. Assigned before `importObject` is ever
  // read — that getter memoizes provider instances on first access.
  (result as { linkedModules?: LinkedModuleArtifact[] }).linkedModules = [provider.artifact];
  return result;
}
