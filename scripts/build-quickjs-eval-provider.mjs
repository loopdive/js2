#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #4238 slice 1 — prebuild the QuickJS eval-engine provider into .test262-cache.
//
// Sibling of scripts/build-runtime-eval-provider.mjs, same idempotent
// build → verify → publish shape. Two artifacts:
//
//   quickjs-artifact-<akey>/{libquickjs.wasm, qjs-abi.json, build-info.json}
//     akey = sha256(quickjs-ng ref ∥ wasi-libc ref ∥ builtins url ∥ OPT ∥
//                   sha256(qjs_shim.c) ∥ sha256(build.sh))
//   quickjs-eval-adapter-<key>.wasm
//     key = runtimeEvalProviderCacheKey(adapterSource, compilerBundleHash);
//     the adapter source bakes in the artifact's own qjs-abi.json constants, so
//     re-pinning the artifact invalidates the adapter automatically.
//
// Acquisition order:
//   1. JS2WASM_QUICKJS_ARTIFACT_DIR — a prebuilt dir, verified then copied into
//      the keyed cache dir.
//   2. keyed cache hit — instantiate/verify the linked pair, then exit fast.
//   3. build on demand: `bash scripts/quickjs-artifact/build.sh` (~3 min cold;
//      needs clang-18/cmake/git/curl + network). On failure: HARD ERROR naming
//      the prerequisite and the env override — never a silent degrade, because
//      the flag is an explicit opt-in and a silent fallback to the interpreter
//      would invalidate every measurement made under it.
//
// Usage:
//   node --import tsx scripts/build-quickjs-eval-provider.mjs   (dev, no bundle)
//   node scripts/build-quickjs-eval-provider.mjs                (after the
//                                                                compiler bundle
//                                                                is built)
//   node scripts/build-quickjs-eval-provider.mjs --require-cache
//                                                               (CI consumer:
//                                                                verify only,
//                                                                never build)

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  computeCompilerBundleHash,
  defaultRuntimeEvalProviderCacheDir,
  instantiateRuntimeEvalNamespace,
  loadProviderCompiler,
  runtimeEvalProviderCacheKey,
  writeCachedRuntimeEvalProvider,
} from "./runtime-eval-provider.mjs";
import {
  assertQuickjsArtifactExports,
  assertQuickjsArtifactStandalone,
  buildQuickjsAdapterSource,
  QUICKJS_ADAPTER_CANARY_EXPECTATIONS,
  QUICKJS_ADAPTER_CANARY_SOURCE,
  QUICKJS_ADAPTER_COMPILE_OPTIONS,
  QUICKJS_ADAPTER_EXTERNS,
  QUICKJS_BUILD_SCRIPT,
  QUICKJS_DIRECT_CANARY_EXPECTATIONS,
  QUICKJS_DIRECT_CANARY_SOURCE,
  QUICKJS_FUNCTION_PARITY_CANARY_EXPECTATIONS,
  QUICKJS_FUNCTION_PARITY_CANARY_SOURCE,
  QUICKJS_IMPORT_MODULE,
  QUICKJS_STATE_PARITY_CANARY_EXPECTATIONS,
  QUICKJS_STATE_PARITY_CANARY_SOURCE,
  quickjsAdapterCachePath,
  quickjsArtifactCacheDir,
  quickjsArtifactCacheKey,
  readQuickjsArtifact,
} from "./quickjs-eval-provider.mjs";

const RUNTIME_EVAL_IMPORT_MODULE = "js2wasm:runtime-eval";

/**
 * The stale-bundle guard (#4238 slice 2 — a real landmine, not a hypothetical).
 *
 * `loadProviderCompiler` prefers `scripts/compiler-bundle.mjs`, and a bundle
 * built before slice 1's three enablers (`externNativeTypes`,
 * `externImportModule`, `importMemory`) still imports and still exports a
 * working `compile`. The adapter then compiles "successfully" with its
 * `wasm:memory` accessors NOT inline-lowered, so `store8` leaks to `env` and
 * the build dies at `verifyQuickjsProvider` with
 * "quickjs adapter must import ONLY js2wasm:qjs, found env::store8" — a message
 * that accuses the adapter, which is fine. The bundle is the suspect.
 *
 * So probe the capability directly on a two-line module rather than inferring
 * it from a downstream symptom: with the enablers honoured, the probe's extern
 * binds as `js2wasm:qjs::probe_ext (i32)->i32`, memory is IMPORTED from the
 * same namespace, and nothing lands in `env`. Any deviation names the bundle.
 */
async function quickjsCompilerCapability(compile) {
  const probeSource = `
import { store8 } from "wasm:memory";
type i32 = number;
declare function probe_ext(a: i32): i32;
export function probe(a: i32): i32 { store8(a, 1); return probe_ext(a); }
`;
  let result;
  try {
    result = await compile(probeSource, {
      ...QUICKJS_ADAPTER_COMPILE_OPTIONS,
      fileName: "quickjs-capability-probe.ts",
    });
  } catch (err) {
    return `capability probe failed to compile: ${err?.message ?? err}`;
  }
  if (!result?.success || !result.binary) return "capability probe did not compile";
  const imports = WebAssembly.Module.imports(new WebAssembly.Module(result.binary));
  const foreign = imports.filter((i) => i.module !== QUICKJS_IMPORT_MODULE).map((i) => `${i.module}::${i.name}`);
  if (foreign.length > 0) {
    return (
      `the wasm:memory accessors did not inline-lower and/or externs did not land in ` +
      `${QUICKJS_IMPORT_MODULE} (leaked: ${foreign.join(", ")}) — this compiler predates the #4238 ` +
      `externNativeTypes/externImportModule/importMemory enablers`
    );
  }
  const ext = imports.find((i) => i.name === "probe_ext");
  if (!ext) return `the declared extern probe_ext was not imported from ${QUICKJS_IMPORT_MODULE}`;
  if (!imports.some((i) => i.kind === "memory")) {
    return `memory was DEFINED rather than imported from ${QUICKJS_IMPORT_MODULE} (importMemory unsupported)`;
  }
  return null;
}

async function loadCompile() {
  return loadProviderCompiler({ label: "quickjs-eval-provider", capability: quickjsCompilerCapability });
}

/** Step 1–3 of the acquisition order. Returns the verified artifact. */
function acquireArtifact(cacheDir) {
  const akey = quickjsArtifactCacheKey();
  const keyedDir = quickjsArtifactCacheDir(cacheDir, akey);

  const override = process.env.JS2WASM_QUICKJS_ARTIFACT_DIR;
  if (override) {
    const from = resolve(override);
    const supplied = readQuickjsArtifact(from);
    if (!supplied) {
      throw new Error(
        `JS2WASM_QUICKJS_ARTIFACT_DIR=${from} must contain libquickjs.wasm and qjs-abi.json ` +
          `(build them with: bash scripts/quickjs-artifact/build.sh)`,
      );
    }
    assertQuickjsArtifactStandalone(supplied.binary);
    if (from !== keyedDir) {
      mkdirSync(keyedDir, { recursive: true });
      for (const name of ["libquickjs.wasm", "qjs-abi.json", "build-info.json"]) {
        if (existsSync(join(from, name))) copyFileSync(join(from, name), join(keyedDir, name));
      }
    }
    console.log(
      `[quickjs-eval-provider] artifact from JS2WASM_QUICKJS_ARTIFACT_DIR — sha256 ${supplied.sha256.slice(0, 16)}, ` +
        `published to ${keyedDir} (key ${akey})`,
    );
    return readQuickjsArtifact(keyedDir);
  }

  const cached = readQuickjsArtifact(keyedDir);
  if (cached) {
    assertQuickjsArtifactStandalone(cached.binary);
    console.log(
      `[quickjs-eval-provider] artifact cache HIT — key ${akey}, sha256 ${cached.sha256.slice(0, 16)} at ${keyedDir}`,
    );
    return cached;
  }

  console.log(`[quickjs-eval-provider] artifact cache MISS — building (key ${akey}) into ${keyedDir} ...`);
  mkdirSync(keyedDir, { recursive: true });
  const started = Date.now();
  const built = spawnSync("bash", [QUICKJS_BUILD_SCRIPT], {
    stdio: "inherit",
    env: { ...process.env, OUT_DIR: keyedDir },
  });
  if (built.error || built.status !== 0) {
    throw new Error(
      `scripts/quickjs-artifact/build.sh failed (${built.error?.message ?? `exit ${built.status}`}). ` +
        `It needs clang-18 (CC=), llvm-ar-18/llvm-ranlib-18/llvm-nm-18, cmake, git, curl and network access. ` +
        `Alternatively set JS2WASM_QUICKJS_ARTIFACT_DIR to a directory holding a prebuilt ` +
        `libquickjs.wasm + qjs-abi.json.`,
    );
  }
  const fresh = readQuickjsArtifact(keyedDir);
  if (!fresh) throw new Error(`build.sh reported success but ${keyedDir} has no libquickjs.wasm + qjs-abi.json`);
  assertQuickjsArtifactStandalone(fresh.binary);
  console.log(
    `[quickjs-eval-provider] artifact built in ${Date.now() - started}ms — ` +
      `sha256 ${fresh.sha256.slice(0, 16)}, ${fresh.binary.length} bytes`,
  );
  return fresh;
}

/**
 * Canary-verify the LINKED PAIR before publishing (`verifyProvider`'s
 * discipline). Self-inspection is not enough: what has to hold is that a real
 * user module's indirect eval reaches QuickJS and the number comes back through
 * the `[ok, value]` envelope.
 *
 * NOTE: the existing single-module tiers keep their zero-imports invariant —
 * this check deliberately does NOT touch it. The adapter's imports must be
 * exactly `js2wasm:qjs`, and the artifact's exactly `wasi_snapshot_preview1`.
 */
function verifyQuickjsPair(adapterBinary, artifact) {
  const adapterModule = new WebAssembly.Module(adapterBinary);
  const allowed = new Set([...QUICKJS_ADAPTER_EXTERNS, "memory"]);
  for (const imp of WebAssembly.Module.imports(adapterModule)) {
    if (imp.module !== QUICKJS_IMPORT_MODULE) {
      throw new Error(
        `quickjs adapter must import ONLY ${QUICKJS_IMPORT_MODULE}, found ${imp.module}::${imp.name} — ` +
          `an extern leaked outside the provider namespace`,
      );
    }
    if (!allowed.has(imp.name)) {
      throw new Error(`quickjs adapter imports unexpected ${QUICKJS_IMPORT_MODULE}::${imp.name}`);
    }
  }
  const quickjsModule = assertQuickjsArtifactStandalone(artifact.binary);
  // A cached artifact that predates the current qjs_shim.c would otherwise fail
  // as a bare LinkError inside the canary, with nothing pointing at the shim.
  assertQuickjsArtifactExports(quickjsModule);

  // Instantiate the linked pair even on a cache hit. Structural inspection
  // alone cannot see an ABI mismatch between the adapter and libquickjs.wasm,
  // and a CI shard must reject a stale/corrupt download before it starts
  // producing engine-labelled test262 results.
  const namespace = instantiateRuntimeEvalNamespace({
    engine: "quickjs",
    adapterModule,
    quickjsModule,
  });
  for (const name of [
    "__runtime_new_function",
    "__runtime_indirect_eval",
    "__runtime_direct_eval",
    "__runtime_apply_interpreted",
  ]) {
    if (typeof namespace[name] !== "function") {
      throw new Error(`quickjs linked pair exposes no ${name}`);
    }
  }

  return { adapterModule, quickjsModule };
}

async function verifyQuickjsProvider(compile, adapterBinary, artifact) {
  const { adapterModule, quickjsModule } = verifyQuickjsPair(adapterBinary, artifact);

  // Two canary compiles. The second one only differs by
  // `inferModuleStrictArguments: false`, and that difference is the whole point:
  // any source with a top-level `export` is module code, module code is strict,
  // and the SLOPPY `with (S)` direct-eval arm is therefore unreachable from the
  // first compile. Verifying only the strict arm would leave half the tier
  // unproven — and the sloppy arm is the one test262's script-goal files use.
  const runCanary = async (source, fileName, expectations, extra) => {
    const canary = await compile(source, {
      ...QUICKJS_ADAPTER_COMPILE_OPTIONS,
      fileName,
      // The CANARY is an ordinary user module — it must NOT carry the adapter's
      // provider-build enablers, or it would not be the module shape we serve.
      externNativeTypes: false,
      externImportModule: undefined,
      importMemory: undefined,
      ...extra,
    });
    if (!canary.success || !canary.binary) {
      const detail = (canary.errors ?? [])
        .filter((e) => e.severity === "error" || e.severity === undefined)
        .slice(0, 5)
        .map((e) => e.message ?? String(e))
        .join("; ");
      throw new Error(`quickjs canary ${fileName} failed to compile: ${detail || "unknown"}`);
    }
    const canaryModule = new WebAssembly.Module(canary.binary);
    const linksProvider = WebAssembly.Module.imports(canaryModule).some((i) => i.module === RUNTIME_EVAL_IMPORT_MODULE);
    if (!linksProvider) {
      throw new Error(`quickjs canary ${fileName} does not import ${RUNTIME_EVAL_IMPORT_MODULE} — it verifies nothing`);
    }
    const instance = new WebAssembly.Instance(canaryModule, {
      [RUNTIME_EVAL_IMPORT_MODULE]: instantiateRuntimeEvalNamespace({
        engine: "quickjs",
        adapterModule,
        quickjsModule,
      }),
    });
    instance.exports._start?.();
    for (const { probe, expected, why } of expectations) {
      const actual = instance.exports[probe]();
      if (actual !== expected) {
        throw new Error(`quickjs canary ${probe}() returned ${actual}, expected ${expected} (${why})`);
      }
    }
  };

  // One reading per capability the engine claims. `engineIdentityProbe === 7`
  // ("quickjs".length) is the anti-vacuity anchor: it is a real QuickJS STRING
  // on the realm, so no compile-time fold and no other engine can produce it.
  await runCanary(QUICKJS_ADAPTER_CANARY_SOURCE, "quickjs-eval-canary.ts", QUICKJS_ADAPTER_CANARY_EXPECTATIONS, {});
  await runCanary(QUICKJS_DIRECT_CANARY_SOURCE, "quickjs-eval-direct-canary.ts", QUICKJS_DIRECT_CANARY_EXPECTATIONS, {
    inferModuleStrictArguments: false,
  });
  await runCanary(
    QUICKJS_FUNCTION_PARITY_CANARY_SOURCE,
    "quickjs-eval-function-parity-canary.ts",
    QUICKJS_FUNCTION_PARITY_CANARY_EXPECTATIONS,
    {},
  );
  await runCanary(
    QUICKJS_STATE_PARITY_CANARY_SOURCE,
    "quickjs-eval-state-parity-canary.ts",
    QUICKJS_STATE_PARITY_CANARY_EXPECTATIONS,
    { inferModuleStrictArguments: false },
  );
}

/**
 * CI consumer-side verification. This path is intentionally read-only: it
 * proves that the artifact and compiler-keyed adapter downloaded by a shard
 * are the exact pair the selector will load, and refuses a miss instead of
 * rebuilding (or silently measuring another engine).
 */
function requireQuickjsCache(cacheDir, bundleHash) {
  const akey = quickjsArtifactCacheKey();
  const artifactDir = process.env.JS2WASM_QUICKJS_ARTIFACT_DIR
    ? resolve(process.env.JS2WASM_QUICKJS_ARTIFACT_DIR)
    : quickjsArtifactCacheDir(cacheDir, akey);
  const artifact = readQuickjsArtifact(artifactDir);
  if (!artifact) {
    throw new Error(
      `required quickjs artifact cache entry is missing for key ${akey} at ${artifactDir}; ` +
        `the shared CI artifact is absent or was built with different QuickJS inputs`,
    );
  }

  const adapterSource = buildQuickjsAdapterSource(artifact.abi);
  const key = runtimeEvalProviderCacheKey(adapterSource, bundleHash);
  const adapterPath = quickjsAdapterCachePath(cacheDir, key);
  if (!existsSync(adapterPath)) {
    throw new Error(
      `required quickjs adapter cache entry is missing for key ${key} (bundle ${bundleHash}) at ${adapterPath}; ` +
        `the shared CI artifact is absent or was built from a different compiler bundle`,
    );
  }

  const adapterBinary = readFileSync(adapterPath);
  verifyQuickjsPair(adapterBinary, artifact);
  console.log(
    `[quickjs-eval-provider] required cache HIT + linked-pair verification — artifact key ${akey}, ` +
      `adapter key ${key} (bundle ${bundleHash}), ${artifact.binary.length} + ${adapterBinary.length} bytes`,
  );
}

async function main(args = process.argv.slice(2)) {
  const known = new Set(["--require-cache", "--help", "-h"]);
  const unknown = args.filter((arg) => !known.has(arg));
  if (unknown.length > 0) {
    throw new Error(`unknown argument(s): ${unknown.join(", ")} (expected --require-cache or --help)`);
  }
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      "Usage: node scripts/build-quickjs-eval-provider.mjs [--require-cache]\n" +
        "  --require-cache  verify the selected artifact + compiler-keyed adapter without building",
    );
    return;
  }

  const cacheDir = defaultRuntimeEvalProviderCacheDir();
  const bundleHash = computeCompilerBundleHash();
  if (args.includes("--require-cache")) {
    requireQuickjsCache(cacheDir, bundleHash);
    return;
  }

  mkdirSync(cacheDir, { recursive: true });

  const artifact = acquireArtifact(cacheDir);
  const adapterSource = buildQuickjsAdapterSource(artifact.abi);
  const key = runtimeEvalProviderCacheKey(adapterSource, bundleHash);
  const adapterPath = quickjsAdapterCachePath(cacheDir, key);
  if (existsSync(adapterPath)) {
    const adapterBinary = readFileSync(adapterPath);
    verifyQuickjsPair(adapterBinary, artifact);
    console.log(
      `[quickjs-eval-provider] adapter cache HIT + linked-pair verification — key ${key} (bundle ${bundleHash}), ` +
        `${adapterBinary.length} bytes at ${adapterPath}`,
    );
    return;
  }

  const { compile, origin } = await loadCompile();
  console.log(
    `[quickjs-eval-provider] adapter cache MISS — compiling (key ${key}, bundle ${bundleHash}, ` +
      `compiler: ${origin}, source ${adapterSource.length} chars) ...`,
  );
  const startMs = Date.now();
  const result = await compile(adapterSource, { ...QUICKJS_ADAPTER_COMPILE_OPTIONS });
  const compileMs = Date.now() - startMs;
  if (!result.success || !result.binary || result.binary.length === 0) {
    const detail = (result.errors ?? [])
      .filter((e) => e.severity === "error" || e.severity === undefined)
      .slice(0, 5)
      .map((e) => e.message ?? String(e))
      .join("; ");
    throw new Error(`quickjs adapter compile FAILED after ${compileMs}ms: ${detail || "unknown"}`);
  }
  await verifyQuickjsProvider(compile, result.binary, artifact);
  const written = writeCachedRuntimeEvalProvider(cacheDir, key, result.binary, quickjsAdapterCachePath);
  console.log(
    `[quickjs-eval-provider] built + canary-verified in ${compileMs}ms — ${result.binary.length} bytes at ${written}`,
  );
}

main().catch((err) => {
  console.error(`[quickjs-eval-provider] FAILED: ${err?.stack ?? err}`);
  process.exit(1);
});
