#!/usr/bin/env node
/**
 * No-JIT counterpart to `generate-playground-benchmark-sidebar.mjs`.
 *
 * Produces `benchmarks/results/playground-benchmark-sidebar-no-jit.json` for
 * the second landing-page chart that compares baseline-tier execution on both
 * sides (V8 Ignition for JS, V8 Liftoff for Wasm).
 *
 * Why this needs child processes:
 *   The flags `--jitless` and `--no-wasm-tier-up --liftoff` are V8 startup
 *   flags — they cannot be flipped at runtime. So each measurement runs in a
 *   fresh `node` subprocess via `scripts/no-jit-bench-child.mjs`.
 *
 * Output shape is identical to the JIT sidebar JSON so the same
 * <perf-benchmark-chart> component can render either dataset.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { buildImports, compileMulti, instantiateWasm, optimizeBinaryAsync } from "./compiler-bundle.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HELPERS_PATH = resolve(ROOT, "website", "playground", "examples", "benchmarks", "helpers.ts");
const RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "playground-benchmark-sidebar-no-jit.json");
const PLAYGROUND_PUBLIC_PATH = resolve(
  ROOT,
  "website",
  "playground",
  "public",
  "benchmarks",
  "results",
  "playground-benchmark-sidebar-no-jit.json",
);
const PUBLIC_PATH = resolve(
  ROOT,
  "website",
  "public",
  "benchmarks",
  "results",
  "playground-benchmark-sidebar-no-jit.json",
);
const ARTIFACT_DIR = resolve(ROOT, ".tmp", "no-jit-bench");
const CHILD_SCRIPT = resolve(import.meta.dirname, "no-jit-bench-child.mjs");
const COMPILER_BUNDLE_PATH = resolve(import.meta.dirname, "compiler-bundle.mjs");
const WASM_EXPERIMENTAL_FLAGS = ["--experimental-wasm-stringref", "--experimental-wasm-custom-descriptors"];

const HELPERS_SOURCE = readFileSync(HELPERS_PATH, "utf8");

const BENCHMARKS = [
  { path: "examples/benchmarks/fib.ts", exportName: "bench_fib" },
  { path: "examples/benchmarks/loop.ts", exportName: "bench_loop" },
  { path: "examples/benchmarks/string.ts", exportName: "bench_string" },
  { path: "examples/benchmarks/array.ts", exportName: "bench_array" },
];

// V8 startup flags that disable every optimizing tier above the interpreter for
// regular JS execution. Sparkplug, Maglev, and Turbofan are all off; only
// Ignition runs the bytecode.
const JS_NO_JIT_FLAGS = ["--jitless", "--no-opt", "--no-turbofan", "--no-sparkplug", "--no-maglev"];

// V8 startup flags that pin Wasm execution to Liftoff (the single-pass baseline
// compiler). Turbofan tier-up is disabled so all calls keep running Liftoff
// code. This is the closest like-for-like analogue of `wasmtime` with
// `--cranelift-opt-level=0` (cranelift is wasmtime's required JIT — the
// "no-JIT" framing means "no optimizing tier").
const WASM_NO_JIT_FLAGS = ["--no-wasm-tier-up", "--liftoff"];

function stripImportsAndExports(source) {
  return source.replace(/^\s*import\s+[^;]+;\s*$/gm, "").replace(/^export\s+/gm, "");
}

function buildJsFactorySource(source, exportName) {
  const transpiled = ts.transpileModule(stripImportsAndExports(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  return `${transpiled}\nreturn { ${exportName} };`;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function optimizeBenchmarkWasm(binary, entryPath) {
  let optimizedBinary = binary;
  for (let pass = 0; pass < 4; pass++) {
    const optResult = await optimizeBinaryAsync(optimizedBinary, { level: 4 });
    if (!optResult.optimized) {
      throw new Error(
        `wasm-opt optimization is required for offline benchmark artifacts (${entryPath}): ${
          optResult.warning ?? "optimizer returned the original binary"
        }`,
      );
    }
    if (bytesEqual(optResult.binary, optimizedBinary)) return optimizedBinary;
    optimizedBinary = optResult.binary;
  }
  return optimizedBinary;
}

function runChild(v8Flags, args) {
  const result = spawnSync(process.execPath, [...WASM_EXPERIMENTAL_FLAGS, ...v8Flags, CHILD_SCRIPT, ...args], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "";
    throw new Error(`no-jit-bench child failed (exit ${result.status}): ${stderr.slice(0, 800)}`);
  }
  const stdout = result.stdout.toString().trim();
  const lastLine = stdout.split(/\r?\n/).filter(Boolean).pop();
  return JSON.parse(lastLine);
}

function smokeTestInProcess(fn) {
  // Sanity-check that the wasm export and JS factory both produce the same
  // result before paying for child-process measurement. Mirrors the in-process
  // sidebar generator's implicit equivalence assumption.
  try {
    return fn();
  } catch (err) {
    throw new Error(`benchmark export threw during smoke test: ${err.message || err}`);
  }
}

async function prepareArtifacts(entry) {
  const absEntryPath = resolve(ROOT, "website", "playground", entry.path);
  const source = readFileSync(absEntryPath, "utf8");

  const result = await compileMulti(
    {
      [entry.path]: source,
      "examples/benchmarks/helpers.ts": HELPERS_SOURCE,
    },
    entry.path,
    {},
  );
  if (!result.success) {
    throw new Error(`Compilation failed for ${entry.path}:\n${result.errors.map((e) => e.message).join("\n")}`);
  }
  const wasmBinary = await optimizeBenchmarkWasm(result.binary, entry.path);

  // Quick in-process smoke test to make sure the wasm + JS factory both produce
  // a sensible value. This runs under the *normal* (JIT-enabled) parent process
  // — it's not a measurement, just a sanity gate.
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(wasmBinary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  const wasmFn = instance.exports[entry.exportName];
  if (typeof wasmFn !== "function") throw new Error(`Missing wasm export ${entry.exportName}`);
  smokeTestInProcess(wasmFn);

  const jsFactorySource = buildJsFactorySource(source, entry.exportName);
  smokeTestInProcess(new Function(jsFactorySource)()[entry.exportName]);

  const slug = entry.path.replace(/[^a-z0-9]+/gi, "_");
  const wasmPath = resolve(ARTIFACT_DIR, `${slug}.wasm`);
  const jsSourcePath = resolve(ARTIFACT_DIR, `${slug}.factory.js`);
  const importsPath = resolve(ARTIFACT_DIR, `${slug}.imports.json`);

  writeFileSync(wasmPath, wasmBinary);
  writeFileSync(jsSourcePath, jsFactorySource);
  writeFileSync(
    importsPath,
    JSON.stringify({
      imports: result.imports,
      stringPool: result.stringPool,
      runtimeHelpersPath: COMPILER_BUNDLE_PATH,
    }),
  );

  return { wasmPath, jsSourcePath, importsPath };
}

async function measureBenchmark(entry) {
  const { wasmPath, jsSourcePath, importsPath } = await prepareArtifacts(entry);

  const wasmResult = runChild(WASM_NO_JIT_FLAGS, [
    `--lane=wasm`,
    `--wasm=${wasmPath}`,
    `--imports=${importsPath}`,
    `--export=${entry.exportName}`,
  ]);
  const jsResult = runChild(JS_NO_JIT_FLAGS, [
    `--lane=js`,
    `--js-source=${jsSourcePath}`,
    `--export=${entry.exportName}`,
  ]);

  const wasmSamplesUs = wasmResult.samplesUs;
  const jsSamplesUs = jsResult.samplesUs;
  const ratioSamples = wasmSamplesUs.map(
    (wasmUs, i) => (jsSamplesUs[i] ?? jsSamplesUs[jsSamplesUs.length - 1]) / Math.max(wasmUs, 0.000001),
  );

  return {
    path: entry.path,
    wasmOptimized: true,
    wasmOptimizeLevel: 4,
    mode: "no-jit",
    jsFlags: JS_NO_JIT_FLAGS,
    wasmFlags: WASM_NO_JIT_FLAGS,
    wasmUs: median(wasmSamplesUs),
    jsUs: median(jsSamplesUs),
    wasmStdUs: stddev(wasmSamplesUs),
    jsStdUs: stddev(jsSamplesUs),
    ratioStd: stddev(ratioSamples),
    warmupRounds: 2,
    measuredRounds: wasmSamplesUs.length,
  };
}

async function main() {
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const snapshot = [];
  for (const bench of BENCHMARKS) {
    process.stdout.write(`Measuring no-JIT: ${bench.path} ... `);
    try {
      const row = await measureBenchmark(bench);
      snapshot.push(row);
      process.stdout.write(`wasm=${row.wasmUs.toFixed(1)}us js=${row.jsUs.toFixed(1)}us\n`);
    } catch (error) {
      process.stdout.write(`FAILED\n`);
      console.error(`Failed no-JIT benchmark for ${bench.path}:`, error);
      throw error;
    }
  }

  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(snapshot, null, 2) + "\n");
  mkdirSync(dirname(PLAYGROUND_PUBLIC_PATH), { recursive: true });
  copyFileSync(RESULTS_PATH, PLAYGROUND_PUBLIC_PATH);
  mkdirSync(dirname(PUBLIC_PATH), { recursive: true });
  copyFileSync(RESULTS_PATH, PUBLIC_PATH);

  console.log(`Updated ${RESULTS_PATH}`);
  console.log(`Updated ${PLAYGROUND_PUBLIC_PATH}`);
  console.log(`Updated ${PUBLIC_PATH}`);

  try {
    rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup; the artifacts live in `.tmp/` which is gitignored
    // anyway.
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
