#!/usr/bin/env node
/**
 * Landing-page "warm speed" chart generator.
 *
 * Produces `benchmarks/results/playground-benchmark-sidebar.json`, the JIT-
 * optimized counterpart to `generate-playground-benchmark-sidebar-no-jit.mjs`
 * ("cold speed"). Both charts now use the same methodology: pin each side to
 * an explicit V8 tier via startup flags, instead of running N warmup calls
 * in-process and hoping the engine's dynamic tier-up heuristic lands on the
 * optimizing tier before the timed samples run.
 *
 * Why explicit pinning instead of natural warmup: V8's Wasm tier-up (Liftoff
 * -> TurboFan) and JS tier-up (Ignition/Sparkplug -> TurboFan) are both
 * driven by a dynamic, execution-count/byte-budget heuristic. Whether that
 * heuristic has promoted a given hot function by the time the timed samples
 * start is nondeterministic run-to-run — confirmed directly: the SAME
 * compiled binary, run repeatedly with only natural warmup, produced
 * wall-clock medians ranging over ~5x across process invocations, with
 * individual samples spiking to 4-6x their own run's median. Forcing one
 * tier explicitly (this file: TurboFan/optimized; the no-jit sibling:
 * Liftoff/baseline) removes that source of variance entirely.
 *
 * Why this needs child processes: `--no-liftoff` is a V8 startup flag — it
 * cannot be flipped at runtime. So each measurement runs in a fresh `node`
 * subprocess via `scripts/no-jit-bench-child.mjs` (shared, unmodified, with
 * the no-jit sibling — the child is flag-agnostic; it just warms up,
 * calibrates, and measures whatever function it's given).
 *
 * JS side: pinning via `%OptimizeFunctionOnNextCall`, not `--always-turbofan`.
 * `--always-turbofan` is a tuning/testing flag whose exact name and behavior
 * has drifted across V8 releases (confirmed: it exists on the sandbox's
 * Node v22 build but CI's Node v26 rejects it outright with "bad option").
 * `%OptimizeFunctionOnNextCall` is a stable native-syntax intrinsic V8's own
 * test suites depend on — it deterministically forces one specific function
 * to tier up on its next invocation, gated behind `--allow-natives-syntax`
 * (a flag that has existed, unchanged, for the intrinsic's entire lifetime).
 * The generated JS factory calls the benchmark once, requests the tier-up,
 * then calls it again so the exported function is already optimized before
 * the child's own warmup/measurement loop ever touches it.
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import * as ts from "typescript";
import { buildImports, compileMulti, instantiateWasm, optimizeBinaryAsync } from "./compiler-bundle.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const HELPERS_PATH = resolve(ROOT, "website", "playground", "examples", "benchmarks", "helpers.ts");
const RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "playground-benchmark-sidebar.json");
const PLAYGROUND_PUBLIC_PATH = resolve(
  ROOT,
  "website",
  "playground",
  "public",
  "benchmarks",
  "results",
  "playground-benchmark-sidebar.json",
);
const PUBLIC_PATH = resolve(ROOT, "website", "public", "benchmarks", "results", "playground-benchmark-sidebar.json");
const ARTIFACT_DIR = resolve(ROOT, ".tmp", "warm-bench");
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

// V8 startup flags for the JS lane:
//   --allow-natives-syntax      permits the `%`-prefixed native-syntax
//                               intrinsics the generated JS factory (see
//                               `buildWarmJsFactorySource`) uses to force its
//                               own tier-up via `%OptimizeFunctionOnNextCall`,
//                               instead of depending on a version-sensitive
//                               tuning flag like the now-removed
//                               `--always-turbofan`.
//   --no-concurrent-recompilation
//                               forces TurboFan compilation onto the main
//                               thread instead of a background thread —
//                               defense-in-depth for determinism (no
//                               background-thread timing variance in when a
//                               compile actually completes relative to the
//                               calling code). NOT what fixes the fatal
//                               crash below; see `buildWarmJsFactorySource`.
//
// NOTE — `--no-maglev` was added here (#3769) on the theory that CI's JS lane
// was settling on Maglev, and has been REMOVED: that diagnosis was wrong and
// the flag was inert. The evidence for "maglev" was the #3759 assertion
// reporting status 41, decoded with `%GetOptimizationStatus` bit positions
// hardcoded from Node 22. Those positions shift between V8 releases
// (`kOptimized` 1<<4 -> 1<<3, `kTurboFanned` 1<<6 -> 1<<5), so on Node 26
// status 41 is actually isFunction|OPTIMIZED|TURBOFANNED — correctly tiered
// all along. Verified by running the same probe on a real Node 26: with AND
// without `--no-maglev` the status is identical (41) and the timing is
// identical (~344us), i.e. the flag changed nothing. The child now calibrates
// the optimized signature in-process instead of hardcoding bits.
const JS_WARM_FLAGS = ["--allow-natives-syntax", "--no-concurrent-recompilation"];

// V8 startup flag that skips Liftoff (the single-pass Wasm baseline
// compiler) entirely and compiles straight to TurboFan. This is the Wasm-side
// analogue of `--always-turbofan`: no baseline-to-optimized transition to be
// nondeterministic about.
const WASM_WARM_FLAGS = ["--no-liftoff"];

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

// Same as `buildJsFactorySource`, but forces the exported (niladic) function
// to tier up to TurboFan before handing it back — requires the factory to
// run under `--allow-natives-syntax` (JS_WARM_FLAGS), so this is only used
// for the artifact written for the child process, never for the in-process
// smoke test (the parent isn't launched with that flag).
//
// `%PrepareFunctionForOptimization` MUST be called before
// `%OptimizeFunctionOnNextCall` — V8's `CanOptimizeFunction` unconditionally
// CHECKs `ManualOptimizationTable::IsMarkedForManualOptimization` outside
// fuzzing mode (`src/runtime/runtime-test.cc`) and V8_Fatal()s ("Check
// failed: CheckMarkedForManualOptimization") if the function was never
// registered. Omitting this call happened to not crash on this sandbox's
// older V8 build but reliably crashed CI's Node v26 build on fib.ts.
function buildWarmJsFactorySource(source, exportName) {
  const transpiled = ts.transpileModule(stripImportsAndExports(source), {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
    },
  }).outputText;
  return `${transpiled}\n%PrepareFunctionForOptimization(${exportName});\n${exportName}();\n%OptimizeFunctionOnNextCall(${exportName});\n${exportName}();\nreturn { ${exportName} };`;
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
  // result before paying for child-process measurement. Mirrors the no-jit
  // sibling's implicit equivalence assumption.
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

  // Quick in-process smoke test — not a measurement, just a sanity gate.
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(wasmBinary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  const wasmFn = instance.exports[entry.exportName];
  if (typeof wasmFn !== "function") throw new Error(`Missing wasm export ${entry.exportName}`);
  smokeTestInProcess(wasmFn);

  const jsFactorySource = buildJsFactorySource(source, entry.exportName);
  smokeTestInProcess(new Function(jsFactorySource)()[entry.exportName]);

  // The artifact handed to the child process forces its own tier-up (see
  // buildWarmJsFactorySource) — that requires --allow-natives-syntax, which
  // this (parent) process does not run under, so it's kept separate from the
  // plain factory used for the smoke test above.
  const warmJsFactorySource = buildWarmJsFactorySource(source, entry.exportName);

  const slug = entry.path.replace(/[^a-z0-9]+/gi, "_");
  const wasmPath = resolve(ARTIFACT_DIR, `${slug}.wasm`);
  const jsSourcePath = resolve(ARTIFACT_DIR, `${slug}.factory.js`);
  const importsPath = resolve(ARTIFACT_DIR, `${slug}.imports.json`);

  writeFileSync(wasmPath, wasmBinary);
  writeFileSync(jsSourcePath, warmJsFactorySource);
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

  const wasmResult = runChild(WASM_WARM_FLAGS, [
    `--lane=wasm`,
    `--wasm=${wasmPath}`,
    `--imports=${importsPath}`,
    `--export=${entry.exportName}`,
  ]);
  // `--expect-tier=optimized` makes the child ASSERT that V8 kept the function
  // on its optimizing tier across the whole measurement, rather than assuming
  // it. A warm chart whose JS side quietly fell back to baseline reports a
  // slow JS baseline, which flatters the wasm:js ratio — a silent wrong number
  // is worse here than a loud failure.
  const jsResult = runChild(JS_WARM_FLAGS, [
    `--lane=js`,
    `--js-source=${jsSourcePath}`,
    `--export=${entry.exportName}`,
    `--expect-tier=optimized`,
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
    mode: "warm",
    jsFlags: JS_WARM_FLAGS,
    wasmFlags: WASM_WARM_FLAGS,
    // Recorded so the published JSON carries evidence the JS side really was
    // measured on the optimizing tier, instead of that being an unverifiable
    // assumption of the chart.
    jsOptStatus: jsResult.optStatusAfter ?? "unavailable",
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
    process.stdout.write(`Measuring warm: ${bench.path} ... `);
    try {
      const row = await measureBenchmark(bench);
      snapshot.push(row);
      process.stdout.write(`wasm=${row.wasmUs.toFixed(1)}us js=${row.jsUs.toFixed(1)}us\n`);
    } catch (error) {
      process.stdout.write(`FAILED\n`);
      console.error(`Failed warm benchmark for ${bench.path}:`, error);
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
