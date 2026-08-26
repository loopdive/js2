#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
// #2527 / #2514 — build the shared core-Wasm runtime provider.
//
// The provider is compiled once, keyed by the compiler bundle + ABI/source,
// and then instantiated in the same store as consumers that use
// `link: ["js2wasm:runtime"]`. It intentionally publishes only the raw native
// number-format ABI in this first production slice; unsupported runtime
// families remain in the consumer until their provider ABI is specified.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeCompilerBundleHash, loadProviderCompiler } from "./runtime-eval-provider.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const CACHE_ROOT = process.env.JS2WASM_RUNTIME_PROVIDER_CACHE_DIR
  ? resolve(process.env.JS2WASM_RUNTIME_PROVIDER_CACHE_DIR)
  : join(REPO_ROOT, ".js2wasm-cache", "runtime-provider");
const OUTPUT_ARG = process.argv.indexOf("--output");
const OUTPUT_PATH = OUTPUT_ARG >= 0 && process.argv[OUTPUT_ARG + 1] ? resolve(process.argv[OUTPUT_ARG + 1]) : undefined;

const SOURCE = "export {};\n";
const COMPILE_OPTIONS = Object.freeze({
  target: "standalone",
  nativeStrings: true,
  runtimeProvider: true,
  hostBridge: "off",
  experimentalIR: false,
  emitWat: false,
  validate: true,
  fileName: "js2wasm-runtime-provider.ts",
});
const EXPORTS = [
  "number_toString",
  "number_toString_radix",
  "number_toFixed",
  "number_toPrecision",
  "number_toExponential",
];

function cacheKey(bundleHash) {
  return createHash("sha256")
    .update(JSON.stringify(COMPILE_OPTIONS))
    .update("\0")
    .update(bundleHash)
    .update("\0")
    .update(SOURCE)
    .digest("hex")
    .slice(0, 24);
}

function artifactPaths(key) {
  return {
    wasm: join(CACHE_ROOT, `js2wasm-runtime-${key}.wasm`),
    manifest: join(CACHE_ROOT, `js2wasm-runtime-${key}.json`),
  };
}

function verify(binary, expectedFingerprint) {
  const module = new WebAssembly.Module(binary);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) {
    throw new Error(
      `js2wasm:runtime provider must have zero imports, found ${imports
        .map((entry) => `${entry.module}::${entry.name}`)
        .join(", ")}`,
    );
  }
  const exports = new Set(WebAssembly.Module.exports(module).map((entry) => entry.name));
  for (const name of EXPORTS) {
    if (!exports.has(name)) throw new Error(`js2wasm:runtime provider export ${name} is missing`);
  }
  if (!expectedFingerprint || expectedFingerprint.abiVersion !== 2) {
    throw new Error("js2wasm:runtime provider did not publish canonical rec-group ABI v2 metadata");
  }
  // Instantiate once as a canary. The consumer-side test performs the actual
  // provider→consumer import binding in the same engine store.
  new WebAssembly.Instance(module, {});
}

function readCached(paths) {
  if (!existsSync(paths.wasm) || !existsSync(paths.manifest)) return null;
  try {
    const binary = readFileSync(paths.wasm);
    const manifest = JSON.parse(readFileSync(paths.manifest, "utf8"));
    verify(binary, manifest.runtimeRecGroupFingerprint);
    return { binary, manifest };
  } catch {
    return null;
  }
}

async function main() {
  const bundleHash = computeCompilerBundleHash();
  const key = cacheKey(bundleHash);
  const paths = artifactPaths(key);
  mkdirSync(CACHE_ROOT, { recursive: true });

  let cached = readCached(paths);
  if (!cached) {
    const { compile, origin } = await loadProviderCompiler({ label: "runtime-provider" });
    const started = Date.now();
    const result = await compile(SOURCE, COMPILE_OPTIONS);
    if (!result.success || result.binary.length === 0) {
      const detail = result.errors
        .filter((error) => error.severity === "error")
        .slice(0, 5)
        .map((error) => error.message)
        .join("; ");
      throw new Error(`js2wasm:runtime provider compile failed: ${detail || "unknown error"}`);
    }
    verify(result.binary, result.runtimeRecGroupFingerprint);
    const manifest = {
      key,
      compiler: origin,
      compilerBundleHash: bundleHash,
      sourceSha256: createHash("sha256").update(SOURCE).digest("hex"),
      compileOptions: COMPILE_OPTIONS,
      runtimeRecGroupFingerprint: result.runtimeRecGroupFingerprint,
      bytes: result.binary.length,
      builtAt: new Date().toISOString(),
      compileMs: Date.now() - started,
    };
    writeFileSync(paths.wasm, result.binary);
    writeFileSync(paths.manifest, JSON.stringify(manifest, null, 2) + "\n");
    cached = { binary: result.binary, manifest };
    console.log(`[runtime-provider] built ${paths.wasm} (${result.binary.length} bytes, ${manifest.compileMs}ms)`);
  } else {
    console.log(`[runtime-provider] cache HIT ${paths.wasm} (${cached.binary.length} bytes)`);
  }

  if (OUTPUT_PATH) {
    mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
    writeFileSync(OUTPUT_PATH, cached.binary);
    writeFileSync(`${OUTPUT_PATH}.json`, JSON.stringify(cached.manifest, null, 2) + "\n");
    console.log(`[runtime-provider] published ${OUTPUT_PATH}`);
  }
}

main().catch((error) => {
  console.error(`[runtime-provider] FAILED: ${error?.stack ?? error}`);
  process.exitCode = 1;
});
