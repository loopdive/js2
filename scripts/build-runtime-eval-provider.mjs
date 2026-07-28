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
  RUNTIME_EVAL_PROVIDER_COMPILE_OPTIONS,
  buildRuntimeEvalProviderSource,
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  instantiateRuntimeEvalNamespace,
  readCachedRuntimeEvalProvider,
  runtimeEvalProviderCacheKey,
  runtimeEvalProviderCachePath,
  writeCachedRuntimeEvalProvider,
} from "./runtime-eval-provider.mjs";

async function loadCompile() {
  try {
    const bundle = await import("./compiler-bundle.mjs");
    if (typeof bundle.compile === "function") return { compile: bundle.compile, origin: "compiler-bundle.mjs" };
  } catch {}
  // Dev convenience: `node --import tsx scripts/build-runtime-eval-provider.mjs`
  try {
    const src = await import("../src/index.ts");
    if (typeof src.compile === "function") return { compile: src.compile, origin: "src/index.ts (tsx)" };
  } catch {}
  throw new Error(
    "no compiler available — build scripts/compiler-bundle.mjs first (run-test262-vitest.sh does), " +
      "or run under tsx (`node --import tsx scripts/build-runtime-eval-provider.mjs`)",
  );
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
  for (const name of ["__runtime_new_function", "__runtime_indirect_eval"]) {
    if (typeof ns[name] !== "function") throw new Error(`provider namespace export ${name} missing`);
  }
}

async function main() {
  const cacheDir = defaultRuntimeEvalProviderCacheDir();
  const source = buildRuntimeEvalProviderSource();
  const bundleHash = computeCompilerBundleHash();
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

main().catch((err) => {
  console.error(`[runtime-eval-provider] FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
