#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2928 E6 — prebuild the standalone runtime-eval provider into .test262-cache.
//
// Idempotent: exits fast when the cache already holds a provider for the
// current (source, compile options, compiler bundle) key. On a build, the
// provider is verified with its own canaries BEFORE it is cached — a provider
// that cannot evaluate "1 + 2" through the real Acorn parse must never be
// published, or every dynamic-eval test would fail with an opaque link result.
//
// Invoked by scripts/run-test262-vitest.sh when TEST262_TARGET=standalone
// (after the compiler bundle is built, so ./compiler-bundle.mjs exists). Can
// also be run manually: NODE_OPTIONS=--max-old-space-size=3072 node
// scripts/build-runtime-eval-provider.mjs

import {
  RUNTIME_EVAL_IMPORT_MODULE,
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  RUNTIME_EVAL_REFUSAL_CANARY_EXPECTED,
  RUNTIME_EVAL_REFUSAL_CANARY_SOURCE,
  buildRuntimeEvalProviderSource,
  buildRuntimeEvalRefusalProviderSource,
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  instantiateRuntimeEvalNamespace,
  loadProviderCompiler,
  readCachedRuntimeEvalProvider,
  runtimeEvalProviderCacheKey,
  runtimeEvalProviderCachePath,
  runtimeEvalRefusalCachePath,
  writeCachedRuntimeEvalProvider,
} from "./runtime-eval-provider.mjs";

// The interpreter provider needs no compiler feature newer than the oldest
// bundle we would ever ship, so it passes no capability probe — the shared
// loader then behaves exactly as this function did before #4238 (bundle first,
// tsx second). It shares the loader so the two prebuild scripts cannot drift.
async function loadCompile() {
  return loadProviderCompiler({ label: "runtime-eval" });
}

function verifyProvider(binary) {
  const module = new WebAssembly.Module(binary);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    throw new Error(
      `provider must have ZERO imports, found: ${imports.map((i) => `${i.module}::${i.name}`).join(", ")}`,
    );
  }
  const instance = new WebAssembly.Instance(module, {});
  const checks = [
    ["__runtime_eval_canary", 3],
    ["__runtime_function_canary", 3],
    ["__runtime_direct_eval_canary", 84],
    ["__runtime_apply_interpreted_canary", 3],
    ["__runtime_positive_corpus_canary", 30],
  ];
  for (const [name, expected] of checks) {
    const fn = instance.exports[name];
    if (typeof fn !== "function") throw new Error(`provider export ${name} missing`);
    const actual = fn();
    if (actual !== expected) throw new Error(`provider canary ${name} returned ${actual}, expected ${expected}`);
  }
  // The linkable namespace itself must exist.
  const ns = instantiateRuntimeEvalNamespace(module);
  for (const name of [
    "__runtime_new_function",
    "__runtime_indirect_eval",
    "__runtime_direct_eval",
    "__runtime_apply_interpreted",
  ]) {
    if (typeof ns[name] !== "function") throw new Error(`provider namespace export ${name} missing`);
  }
}

/**
 * (#2928 E7) Positive control for the REFUSAL provider, run BEFORE it is
 * cached. Self-inspection is not enough here: what has to hold is that the
 * `[false, TypeError]` envelope survives the module boundary and surfaces in
 * the USER module as an ordinary catchable `TypeError`. So compile a throwaway
 * standalone user module that takes the dynamic `new Function` route, link it
 * against the candidate, and require the agreed probe code.
 */
async function verifyRefusalProvider(compile, binary) {
  const module = new WebAssembly.Module(binary);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    throw new Error(
      `refusal provider must have ZERO imports, found: ${imports.map((i) => `${i.module}::${i.name}`).join(", ")}`,
    );
  }
  const canary = await compile(RUNTIME_EVAL_REFUSAL_CANARY_SOURCE, {
    ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
    fileName: "runtime-eval-refusal-canary.ts",
  });
  if (!canary.success || !canary.binary) throw new Error("refusal canary user module failed to compile");
  const canaryModule = new WebAssembly.Module(canary.binary);
  const linksProvider = WebAssembly.Module.imports(canaryModule).some((i) => i.module === RUNTIME_EVAL_IMPORT_MODULE);
  if (!linksProvider) {
    // The canary must actually exercise the provider seam; if the compiler
    // ever compiles this body away, the check would pass vacuously.
    throw new Error(`refusal canary does not import ${RUNTIME_EVAL_IMPORT_MODULE} — it would verify nothing`);
  }
  const instance = new WebAssembly.Instance(canaryModule, {
    [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace(module),
  });
  const actual = instance.exports.probe();
  if (actual !== RUNTIME_EVAL_REFUSAL_CANARY_EXPECTED) {
    throw new Error(
      `refusal canary returned ${actual}, expected ${RUNTIME_EVAL_REFUSAL_CANARY_EXPECTED} ` +
        `(the [false, TypeError] envelope did not surface as a catchable TypeError)`,
    );
  }
}

/**
 * (#2928 E7) Build + canary-verify + publish the REFUSAL provider. Cheap
 * (seconds, ~50 KB) because it carries no parser and no interpreter, which is
 * what lets every CI standalone shard afford it.
 */
async function buildRefusal(cacheDir, bundleHash) {
  const source = buildRuntimeEvalRefusalProviderSource();
  const key = runtimeEvalProviderCacheKey(source, bundleHash);
  const path = runtimeEvalRefusalCachePath(cacheDir, key);
  const cached = readCachedRuntimeEvalProvider(cacheDir, key, runtimeEvalRefusalCachePath);
  if (cached) {
    console.log(
      `[runtime-eval-refusal] cache HIT — key ${key} (bundle ${bundleHash}), ${cached.length} bytes at ${path}`,
    );
    return;
  }
  const { compile, origin } = await loadCompile();
  console.log(`[runtime-eval-refusal] cache MISS — compiling refusal provider (key ${key}, compiler: ${origin}) ...`);
  const startMs = Date.now();
  const result = await compile(source, {
    ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
    fileName: "runtime-eval-refusal.ts",
  });
  const compileMs = Date.now() - startMs;
  if (!result.success || !result.binary || result.binary.length === 0) {
    const detail = (result.errors ?? [])
      .filter((e) => e.severity === "error" || e.severity === undefined)
      .slice(0, 5)
      .map((e) => e.message ?? String(e))
      .join("; ");
    throw new Error(`refusal provider compile FAILED after ${compileMs}ms: ${detail || "unknown"}`);
  }
  await verifyRefusalProvider(compile, result.binary);
  const written = writeCachedRuntimeEvalProvider(cacheDir, key, result.binary, runtimeEvalRefusalCachePath);
  console.log(
    `[runtime-eval-refusal] built + canary-verified in ${compileMs}ms — ${result.binary.length} bytes at ${written}`,
  );
}

async function buildFull(cacheDir, bundleHash) {
  const source = buildRuntimeEvalProviderSource();
  const key = runtimeEvalProviderCacheKey(source, bundleHash);
  const path = runtimeEvalProviderCachePath(cacheDir, key);

  const cached = readCachedRuntimeEvalProvider(cacheDir, key);
  if (cached) {
    console.log(
      `[runtime-eval-provider] cache HIT — key ${key} (bundle ${bundleHash}), ${cached.length} bytes at ${path}`,
    );
    return;
  }

  const { compile, origin } = await loadCompile();
  console.log(
    `[runtime-eval-provider] cache MISS — compiling provider (key ${key}, bundle ${bundleHash}, compiler: ${origin}, source ${source.length} chars) ...`,
  );
  const startMs = Date.now();
  const result = await compile(source, { ...RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS });
  const compileMs = Date.now() - startMs;
  if (!result.success || !result.binary || result.binary.length === 0) {
    const detail = (result.errors ?? [])
      .filter((e) => e.severity === "error" || e.severity === undefined)
      .slice(0, 5)
      .map((e) => e.message ?? String(e))
      .join("; ");
    throw new Error(`provider compile FAILED after ${compileMs}ms: ${detail || "unknown"}`);
  }
  verifyProvider(result.binary);
  const written = writeCachedRuntimeEvalProvider(cacheDir, key, result.binary);
  console.log(
    `[runtime-eval-provider] built + canary-verified in ${compileMs}ms — ${result.binary.length} bytes at ${written}`,
  );
}

function requireFullCache(cacheDir, bundleHash) {
  const source = buildRuntimeEvalProviderSource();
  const key = runtimeEvalProviderCacheKey(source, bundleHash);
  const path = runtimeEvalProviderCachePath(cacheDir, key);
  const cached = readCachedRuntimeEvalProvider(cacheDir, key);
  if (!cached) {
    throw new Error(
      `required full provider cache entry is missing for key ${key} (bundle ${bundleHash}) at ${path}; ` +
        `the shared CI artifact is absent or was built from a different compiler bundle`,
    );
  }
  verifyProvider(cached);
  console.log(
    `[runtime-eval-provider] required cache HIT + canary verification — key ${key}, ${cached.length} bytes at ${path}`,
  );
}

async function main() {
  const refusalOnly = process.argv.includes("--refusal-only");
  const requireFull = process.argv.includes("--require-full-cache");
  if (refusalOnly && requireFull) {
    throw new Error("--refusal-only and --require-full-cache are mutually exclusive");
  }
  const cacheDir = defaultRuntimeEvalProviderCacheDir();
  const bundleHash = computeCompilerBundleHash();

  // The refusal provider is built FIRST and unconditionally: it is the floor
  // that keeps eval-mentioning standalone modules instantiable even when the
  // real interpreter is absent, and it costs seconds.
  await buildRefusal(cacheDir, bundleHash);
  if (refusalOnly) return;
  if (requireFull) {
    requireFullCache(cacheDir, bundleHash);
    return;
  }
  await buildFull(cacheDir, bundleHash);
}

main().catch((err) => {
  console.error(`[runtime-eval-provider] FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
