#!/usr/bin/env node
/**
 * Generates the Wasmtime-vs-V8 per-request comparison data for the landing
 * page chart `<perf-benchmark-chart src="…hot-runtime.json">`.
 *
 * The page positions this as a generic edge-serverless comparison between
 * two production runtime architectures: an AOT-compiled Wasm edge runtime
 * vs a V8-isolate edge runtime. Both run untrusted code per request, but
 * with very different cost models for fresh-vs-reused execution contexts. No
 * specific commercial platform is named — the lanes describe the
 * *architecture/scenario*, not a product.
 *
 * Two scenarios per program (8 rows total):
 *
 *   1. **Per-request cold (warm engine, fresh context/instance)**
 *      Models the representative edge-serverless cold request: the engine is
 *      already resident in a long-lived host process, and the request pays
 *      only for its own execution context / instance plus the first call.
 *      - JS lane (#1764): primary `jsUs` is a dependency-free lower bound:
 *        one long-lived Node/V8 process, and per measured request:
 *        `vm.createContext()`, `new vm.Script(program)`, and
 *        `script.runInContext(ctx)` for the first `run(arg)`. A Node `vm`
 *        Context is lighter than a true V8 isolate because it shares the
 *        host isolate's heap and built-ins, so it under-counts the real
 *        isolate-per-request allocation. The JSON also records
 *        `jsCompiledContextUs`, a compiled-once / new-context-per-request
 *        sensitivity number. A fresh `worker_threads` Worker would be the
 *        heavier upper-bound analog (own thread/event loop/heap), but this
 *        generator does not emit that row by default to keep refreshes cheap.
 *      - Wasm lane (#1764): primary `wasmUs` comes from the committed Rust
 *        host in `benchmarks/wasmtime-cold-host`. The host owns a warm
 *        Wasmtime `Engine` plus a Cranelift-compiled `Module`; per measured
 *        request it creates a fresh `Store` + `Instance` and calls
 *        `run(arg)` once. This intentionally removes OS-process startup and
 *        uses Wasmtime/Cranelift, not Node's host WebAssembly engine. The
 *        `wasmtime run` CLI cannot model pooling because every CLI
 *        invocation starts a fresh process, so the generator builds and
 *        shells out to this embedding host for the cold lane.
 *
 *   2. **Warm isolate / reused instance (steady state)**
 *      Models the common-case edge request: the runtime has already served a
 *      request, the isolate/instance is reused, optimizing tiers have
 *      completed.
 *      - Wasm lane (#1760): one `wasmtime run --invoke warm` process whose
 *        appended `warm` export calls `run(arg)` a few warmup times then
 *        times many in-process iterations via CLOCK_MONOTONIC and returns
 *        the steady-state minimum per-call ms. Process startup is amortized
 *        across all iterations — NOT recovered by subtracting two noisy
 *        full-process wall-times (the previous cold−baseline method had a
 *        ~2.3× run-to-run spread that swamped any few-ms per-call signal).
 *      - JS lane: spawn `node` once, call `mod.run(arg)` WARMUP times so
 *        TurboFan tiers up, then time MEASURED more in-process iterations
 *        and report the median. This is what a warm V8-isolate edge runtime
 *        actually pays once an optimizing tier has built up.
 *
 * Why no Pulley / no-JIT lane: Pulley is a portability/dev tool in
 * Wasmtime, not a production serverless config (production Wasm edge runtimes
 * use Cranelift-compiled native code). Including it confused the message;
 * the genuine comparison is Cranelift AOT vs V8 JIT.
 *
 * ## Javy + StarlingMonkey lanes
 *
 * The hot-runtime JSON also carries `javyUs` and `starlingMonkeyUs` per row
 * so the landing-page chart can render four lanes: js2wasm AOT, V8 with JIT,
 * Javy (interpreter), StarlingMonkey (engine). These comparison controls are
 * post-merge and change-scoped: PR gates always select `inherit`; a relevant
 * main revision selects `BENCHMARK_AUXILIARY_MODE=measure` to rebuild and
 * measure them. `inherit` retains the last accepted runtime and size values
 * with their source SHA.
 *
 * For the cold rows those auxiliary lanes now use the same #1764 method as
 * the AOT lane: one Rust/Wasmtime embedding process owns a warm Engine and
 * compiled artifact(s), and every measured sample creates a fresh Store +
 * Instance before calling `run()` once. Javy is generated as a dynamic-link
 * core Wasm module plus a preloaded `javy-default-plugin-v3` module; both are
 * compiled once by the host. StarlingMonkey is generated as a ComponentizeJS
 * component with Wizer + Weval AOT and instantiated through Wasmtime's
 * component API. Javy v8.1.1 only supports WIT exports with no parameters and
 * no return values, so both auxiliary cold lanes use a fixed-argument wrapper:
 * `run()` calls the benchmark body with the same `runtimeArg` used by the
 * AOT/V8 rows and stores the result in a module global.
 *
 * Javy's dynamic module is single-entry and cannot be called repeatedly on
 * one instance. Warm auxiliary artifacts therefore batch several benchmark
 * calls inside one exported `run()`. Each outer sample uses a fresh instance;
 * the measured batch duration is divided by its iteration count, amortizing
 * instance/first-call overhead without unsupported host-level re-entry.
 *
 * Requirements: Rust/Cargo for the cold Wasmtime embedding host; `wasmtime`
 * (v35+) on PATH for the warm steady-state Wasmtime lane; Node.js for the
 * JS/V8 lanes and compiler bundle; @bytecodealliance/componentize-js for the
 * StarlingMonkey cold lane; `JAVY_BIN=/path/to/javy` or `javy` on PATH for
 * the Javy cold lane and displayed module-size artifact; competitive programs under
 * `website/public/benchmarks/competitive/programs/*.js`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Script, createContext } from "node:vm";
import { compile } from "./compiler-bundle.mjs";
import { LANDING_BENCHMARK_PROGRAMS } from "./lib/landing-benchmark-corpus.mjs";
import { buildLandingModuleSizeRows, minifiedJavaScriptByteLength } from "./lib/landing-module-size.mjs";
import {
  landingAuxiliaryRuntimeSource,
  landingNodeVmFreshCompileSample,
  landingNodeWarmSample,
  landingWasmtimeFreshInstanceSamples,
  landingWasmtimeWarmSample,
  normalizeBatchedRuntimeSamples,
} from "./lib/landing-runtime-timing.mjs";
import {
  LANDING_WASMTIME_COMPILE_OPTIONS,
  LANDING_WASM_OPT_ARGS,
  landingWasmtimeCompileArgs,
  landingWasmtimeWarmDriverSource,
} from "./lib/landing-wasmtime-runtime.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PROGRAMS_DIR = resolve(ROOT, "website", "public", "benchmarks", "competitive", "programs");
const ARTIFACT_DIR = resolve(ROOT, ".tmp", "wasmtime-hot-runtime");
const CHILD_JS_PATH = resolve(import.meta.dirname, "wasmtime-bench-child-js.mjs");
const WASM_OPT_PATH = resolve(ROOT, "node_modules", ".bin", "wasm-opt");
const COMPONENTIZE_JS_PATH = resolve(ROOT, "node_modules", ".bin", "componentize-js");
const WASMTIME_COLD_HOST_DIR = resolve(ROOT, "benchmarks", "wasmtime-cold-host");
const WASMTIME_COLD_HOST_MANIFEST = resolve(WASMTIME_COLD_HOST_DIR, "Cargo.toml");
const WASMTIME_COLD_HOST_TARGET_DIR = resolve(WASMTIME_COLD_HOST_DIR, "target");
const WASMTIME_COLD_HOST_BIN = resolve(
  WASMTIME_COLD_HOST_TARGET_DIR,
  "release",
  process.platform === "win32" ? "wasmtime-cold-host.exe" : "wasmtime-cold-host",
);

const RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "wasm-host-wasmtime-hot-runtime.json");
const PUBLIC_PATH = resolve(ROOT, "website", "public", "benchmarks", "results", "wasm-host-wasmtime-hot-runtime.json");
const MODULE_SIZE_RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "wasm-host-wasmtime-module-size-per-test.json");
const MODULE_SIZE_PUBLIC_PATH = resolve(
  ROOT,
  "website",
  "public",
  "benchmarks",
  "results",
  "wasm-host-wasmtime-module-size-per-test.json",
);
const AUXILIARY_MODE = process.env.BENCHMARK_AUXILIARY_MODE || "measure";
const AUXILIARY_RUNTIME_BASELINE = process.env.BENCHMARK_AUXILIARY_RUNTIME_BASELINE;
const AUXILIARY_SIZE_BASELINE = process.env.BENCHMARK_AUXILIARY_SIZE_BASELINE;
const AUXILIARY_SOURCE_SHA = process.env.BENCHMARK_AUXILIARY_SOURCE_SHA;

// The shared manifest deliberately excludes object-ops: it is not landing
// scope, and the existing Wasmtime compatibility path cannot compile its
// modern exception-handling use.

const WARMUP_RUNS = 2;
const MEASURED_RUNS = 7;

// #1760: in-process repeated-measure warm driver.
//
// The previous warm metric derived `warm = (full-process cold wall-time) −
// (baseline arg=0 wall-time)` — subtracting two ~30 ms `wasmtime run` process
// wall-times to recover a few-ms per-call signal. Process-startup jitter
// (~ms-scale) swamped the signal: 6 back-to-back runs of string-hash on an
// IDENTICAL binary spanned 5.43–12.31 ms (a ~2.3× spread), so a genuine
// per-call codegen win (e.g. #1746's i32 hash path) was unresolvable.
//
// The fix mirrors the V8 warm lane (`timeNodeWarmIter`): amortize the
// one-time wasmtime/Cranelift startup over many in-process iterations of the
// hot function and report the steady-state per-call time. We append a `warm`
// export to each program that calls `run(n)` a few warmup times (to settle
// caches/branch predictors — Cranelift AOT code does not tier up, so this is
// short) then times WARM_ITERS_MEASURED in-process iterations via
// `performance.now()` (CLOCK_MONOTONIC inside wasmtime, sub-ms resolution)
// and returns the MINIMUM per-call ms — the steady-state floor, the least
// scheduler-noise-contaminated estimator. One `wasmtime run --invoke warm`
// process → startup amortized across all iterations. We spawn that process
// MEASURED_RUNS times to get a sample array for the std-dev/median the chart
// consumes, exactly parallel to the V8 lane.
//
// The driver is plain JS with a JSDoc `@param {number}` so the export takes a
// numeric (not boxed externref) argument — matching how the program files
// already type `run` — and so wasmtime `--invoke` can pass the runtimeArg.
// `__sink` keeps `run()`'s result observable so the body isn't DCE'd.
const WARM_ITERS_WARMUP = 5;
const WARM_ITERS_MEASURED = 40;
const WARM_DRIVER_SOURCE = landingWasmtimeWarmDriverSource(WARM_ITERS_WARMUP, WARM_ITERS_MEASURED);

// Keep each single-entry auxiliary batch long enough to amortize instance
// setup but bounded on the slow interpreter lane. These counts target roughly
// 0.5–5 seconds per outer sample using the verified cold-lane runtimes.
const AUX_WARM_BATCH_ITERATIONS = Object.freeze({
  fib: 2,
  "fib-recursive": 8,
  "array-sum": 8,
  "string-hash": 16,
});

const WARM_LANES_PROVENANCE =
  "warm javyUs/starlingMonkeyUs measured by scripts/generate-wasmtime-hot-runtime.mjs with " +
  "benchmarks/wasmtime-cold-host: warm Wasmtime Engine + compiled artifacts, fresh Store + " +
  "Instance per outer sample, and a single-entry in-component batch normalized to per-call time. " +
  "This avoids unsupported Javy module re-entry. Javy uses dynamic-link with javy-default-plugin-v3; " +
  "StarlingMonkey uses ComponentizeJS + Wizer + Weval AOT.";
const COLD_LANES_PROVENANCE =
  "cold javyUs/starlingMonkeyUs measured by scripts/generate-wasmtime-hot-runtime.mjs with " +
  "benchmarks/wasmtime-cold-host: warm Wasmtime Engine + compiled artifacts, fresh Store + " +
  "Instance per sample, fixed-argument no-return wrapper for Javy WIT compatibility.";
const CARRIED_AUXILIARY_PROVENANCE =
  "javyUs/starlingMonkeyUs carried forward because the benchmark corpus, auxiliary wrappers and host, " +
  "componentizer dependency, and pinned runtime versions are unchanged.";
const AUX_WIT_SOURCE = `package local:bench;
world bench {
  export run: func();
}
`;

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

function min(values) {
  return values.length === 0 ? 0 : Math.min(...values);
}

function max(values) {
  return values.length === 0 ? 0 : Math.max(...values);
}

function ensureWasmtime() {
  try {
    const out = execFileSync("wasmtime", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return out.toString().trim();
  } catch {
    throw new Error("wasmtime not found on PATH. Install from https://wasmtime.dev/ and retry.");
  }
}

function ensureWasmtimeColdHost() {
  try {
    execFileSync("cargo", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("cargo not found on PATH. Install Rust/Cargo to build benchmarks/wasmtime-cold-host.");
  }

  execFileSync("cargo", ["build", "--release", "--manifest-path", WASMTIME_COLD_HOST_MANIFEST], {
    env: { ...process.env, CARGO_TARGET_DIR: WASMTIME_COLD_HOST_TARGET_DIR },
    stdio: ["ignore", "inherit", "inherit"],
  });
  return WASMTIME_COLD_HOST_BIN;
}

function resolveJavy() {
  const explicit = process.env.JAVY_BIN;
  const bin = explicit && explicit.trim() ? explicit : "javy";
  try {
    const version = execFileSync(bin, ["--version"], { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
    return { bin, version };
  } catch (err) {
    if (explicit) {
      const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr).slice(0, 400) : String(err);
      throw new Error(`JAVY_BIN is set but not executable (${explicit}): ${stderr}`);
    }
    console.warn("[javy] not found on PATH; cold Interpreter lane will be omitted.");
    return null;
  }
}

function ensureComponentizeJs() {
  if (!existsSync(COMPONENTIZE_JS_PATH)) {
    throw new Error("@bytecodealliance/componentize-js is not installed; run pnpm install and retry.");
  }
  return componentizeJsVersion();
}

function componentizeJsVersion() {
  try {
    const pkg = JSON.parse(
      readFileSync(resolve(ROOT, "node_modules", "@bytecodealliance", "componentize-js", "package.json")),
    );
    return `componentize-js ${pkg.version}`;
  } catch {
    return "componentize-js unknown";
  }
}

function ensureJavyPlugin(javy) {
  const pluginPath = resolve(ARTIFACT_DIR, "javy-default-plugin-v3.wasm");
  execFileSync(javy.bin, ["emit-plugin", "-o", pluginPath], { stdio: ["ignore", "pipe", "pipe"] });
  return pluginPath;
}

async function compileProgram(id) {
  const sourcePath = resolve(PROGRAMS_DIR, `${id}.js`);
  const source = readFileSync(sourcePath, "utf8");
  // #1580: enable `-O3` post-processing via Binaryen wasm-opt. The unoptimized
  // emitter spills a fresh `$NativeString` struct on every `s.length` /
  // `s.charCodeAt(i)` read inside hot loops; wasm-opt's SROA collapses those
  // allocations and turns the string-hash inner loop into a tight
  // `array.get_u $u16Array` sequence, bringing it within ~3× of V8 with JIT
  // (instead of the previous Interpreter-class ~63ms). The optimizer is also
  // a no-op when wasm-opt isn't available — `compile` returns the unoptimized
  // binary plus a warning we surface below.
  const result = await compile(source, { fileName: `${id}.js`, ...LANDING_WASMTIME_COMPILE_OPTIONS });
  if (!result.success) {
    throw new Error(`Failed to compile ${id}: ${result.errors?.[0]?.message ?? "unknown error"}`);
  }
  // Surface optimization warnings so a missing wasm-opt or a validator
  // rejection is visible in the script output rather than silently producing
  // an "Interpreter-class" hot-runtime number.
  for (const err of result.errors ?? []) {
    if (err.severity === "warning") {
      console.warn(`[${id}] ${err.message}`);
    }
  }
  if ((result.imports ?? []).length > 0) {
    throw new Error(
      `Program ${id} has host imports — must be standalone for wasmtime: ${JSON.stringify(result.imports)}`,
    );
  }
  const wasmPath = resolve(ARTIFACT_DIR, `${id}.wasm`);
  writeFileSync(wasmPath, result.binary);

  // #1760: also compile a warm variant — the original program plus an
  // appended self-timing `warm` export (see WARM_DRIVER_SOURCE). The
  // `export const benchmark = {…}` metadata block is stripped first so it
  // doesn't add an unused export to the standalone module. The warm module
  // is compiled with the IDENTICAL options (target/nativeStrings/optimize)
  // so its `run` lowering is bit-for-bit what the cold lane measures.
  const programBody = source.replace(/export const benchmark[\s\S]*?};\n/, "");
  const warmSource = programBody + "\n" + WARM_DRIVER_SOURCE;
  const warmResult = await compile(warmSource, {
    fileName: `${id}-warm.js`,
    ...LANDING_WASMTIME_COMPILE_OPTIONS,
  });
  if (!warmResult.success) {
    throw new Error(`Failed to compile ${id} warm driver: ${warmResult.errors?.[0]?.message ?? "unknown error"}`);
  }
  for (const err of warmResult.errors ?? []) {
    if (err.severity === "warning") {
      console.warn(`[${id}-warm] ${err.message}`);
    }
  }
  if ((warmResult.imports ?? []).length > 0) {
    throw new Error(
      `Program ${id} warm driver has host imports — must be standalone for wasmtime: ${JSON.stringify(warmResult.imports)}`,
    );
  }
  const warmWasmPath = resolve(ARTIFACT_DIR, `${id}-warm.wasm`);
  writeFileSync(warmWasmPath, warmResult.binary);

  const wasmtimeWasmPath = normalizeWasmForWasmtime(wasmPath, id);
  const wasmtimeWarmWasmPath = normalizeWasmForWasmtime(warmWasmPath, `${id}-warm`);

  return { sourcePath, wasmPath: wasmtimeWasmPath, warmWasmPath: wasmtimeWarmWasmPath };
}

function precompile(wasmPath, label) {
  const cwasmPath = resolve(ARTIFACT_DIR, `${label}.cranelift.cwasm`);
  const args = landingWasmtimeCompileArgs(wasmPath, cwasmPath);
  execFileSync("wasmtime", args, { stdio: ["ignore", "pipe", "pipe"] });
  return cwasmPath;
}

function normalizeWasmForWasmtime(wasmPath, label) {
  const normalizedPath = resolve(ARTIFACT_DIR, `${label}.wasmtime.wasm`);
  try {
    execFileSync(WASM_OPT_PATH, [...LANDING_WASM_OPT_ARGS, wasmPath, "-o", normalizedPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    return normalizedPath;
  } catch (err) {
    const stderr = err && typeof err === "object" && "stderr" in err ? String(err.stderr).slice(0, 400) : String(err);
    console.warn(`[${label}] wasm-opt normalization skipped; wasmtime may reject exact refs: ${stderr}`);
    return wasmPath;
  }
}

function readRuntimeArg(sourcePath) {
  const text = readFileSync(sourcePath, "utf8");
  const match = text.match(/runtimeArg:\s*(\d+)/);
  if (!match) throw new Error(`runtimeArg not found in ${sourcePath}`);
  return Number(match[1]);
}

function stripBenchmarkMetadata(source) {
  return source.replace(/export const benchmark[\s\S]*?};\n/, "");
}

function compileStarlingMonkeyArtifact(wrapperPath, witPath, outputPath) {
  execFileSync(
    COMPONENTIZE_JS_PATH,
    [
      wrapperPath,
      "--wit",
      witPath,
      "--world-name",
      "bench",
      "--disable",
      "stdio",
      "random",
      "clocks",
      "http",
      "fetch-event",
      "--aot",
      "-o",
      outputPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

function compileJavyArtifact(javy, javyPluginPath, wrapperPath, witPath, outputPath) {
  execFileSync(
    javy.bin,
    [
      "build",
      "-C",
      "dynamic=y",
      "-C",
      `plugin=${javyPluginPath}`,
      "-C",
      `wit=${witPath}`,
      "-C",
      "wit-world=bench",
      "-C",
      "source=omitted",
      wrapperPath,
      "-o",
      outputPath,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
}

function buildAuxiliaryArtifacts({ programId, sourcePath, runtimeArg, javy, javyPluginPath, componentizeVersion }) {
  const warmBatchIterations = AUX_WARM_BATCH_ITERATIONS[programId];
  if (!Number.isSafeInteger(warmBatchIterations) || warmBatchIterations <= 1) {
    throw new Error(`Missing auxiliary warm batch size for ${programId}`);
  }
  const witPath = resolve(ARTIFACT_DIR, "aux-runtime-noarg.wit");
  writeFileSync(witPath, AUX_WIT_SOURCE);

  const source = readFileSync(sourcePath, "utf8");
  const coldWrapperPath = resolve(ARTIFACT_DIR, `${programId}.aux-cold.js`);
  const warmWrapperPath = resolve(ARTIFACT_DIR, `${programId}.aux-warm.js`);
  writeFileSync(coldWrapperPath, landingAuxiliaryRuntimeSource(source, runtimeArg));
  writeFileSync(warmWrapperPath, landingAuxiliaryRuntimeSource(source, runtimeArg, warmBatchIterations));

  const starlingMonkeyPath = resolve(ARTIFACT_DIR, `${programId}.starlingmonkey.cold.component.wasm`);
  const starlingMonkeyWarmPath = resolve(ARTIFACT_DIR, `${programId}.starlingmonkey.warm.component.wasm`);
  compileStarlingMonkeyArtifact(coldWrapperPath, witPath, starlingMonkeyPath);
  compileStarlingMonkeyArtifact(warmWrapperPath, witPath, starlingMonkeyWarmPath);

  const javyPath = resolve(ARTIFACT_DIR, `${programId}.javy.cold.dynamic.wasm`);
  const javyWarmPath = resolve(ARTIFACT_DIR, `${programId}.javy.warm.dynamic.wasm`);
  compileJavyArtifact(javy, javyPluginPath, coldWrapperPath, witPath, javyPath);
  compileJavyArtifact(javy, javyPluginPath, warmWrapperPath, witPath, javyWarmPath);

  return {
    javyPath,
    javyWarmPath,
    javyVersion: javy?.version ?? null,
    javyPluginPath,
    starlingMonkeyPath,
    starlingMonkeyWarmPath,
    warmBatchIterations,
    componentizeVersion,
    wrapper: "fixed-runtime-arg-no-return-wit",
    warmWrapper: "fixed-runtime-arg-single-entry-batch-no-return-wit",
  };
}

function makeVmScriptSource(sourcePath) {
  const source = readFileSync(sourcePath, "utf8");
  const programBody = source
    .replace(/export const benchmark[\s\S]*?};\n/, "")
    .replace(/\bexport\s+function\s+run\b/, "function run");
  return `${programBody}\nrun(globalThis.__runtimeArg__);\n`;
}

/**
 * #1764: cold JS lower-bound lane. One long-lived Node/V8 process, and per
 * measured request: allocate a fresh vm Context, compile the program into a
 * Script, and run `run(arg)` once in that context. This avoids process
 * startup and captures context + compile + first-run cost against a warm V8.
 * A vm Context is lighter than a true isolate, so this is a lower bound.
 */
function timeNodeVmContextFreshCompile(sourcePath, arg, runs) {
  const samplesMs = [];
  for (let i = 0; i < runs; i++) {
    samplesMs.push(landingNodeVmFreshCompileSample(sourcePath, arg).wallMs);
  }
  return samplesMs;
}

/**
 * #1764 sensitivity number: compile the Script once in the long-lived host,
 * then allocate a fresh vm Context per request and run once. This approximates
 * an embedder with an already-parsed code cache.
 */
function timeNodeVmContextCompiledOnce(sourcePath, arg, runs) {
  const script = new Script(makeVmScriptSource(sourcePath), { filename: sourcePath });
  const samplesMs = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const context = createContext({ __runtimeArg__: arg });
    const result = script.runInContext(context);
    const ms = performance.now() - t0;
    void result;
    samplesMs.push(ms);
  }
  return samplesMs;
}

/**
 * #1764: cold Wasmtime instantiate lane. Spawns the Rust embedding host once
 * per program. Inside that process, Wasmtime owns a warm Engine plus compiled
 * Module, and each measured request allocates a fresh Store + Instance and
 * calls run(arg) once. The returned samples therefore exclude OS-process
 * startup and measure Wasmtime/Cranelift instantiation, not Node WebAssembly.
 */
function timeWasmtimeFreshInstance(hostPath, wasmPath, arg, runs, options = {}) {
  return landingWasmtimeFreshInstanceSamples(hostPath, wasmPath, arg, runs, options).samplesMs;
}

/**
 * #1760: in-process warm wasm lane. Spawns one `wasmtime run --invoke warm`
 * process per outer sample. Inside each process the appended `warm` export
 * does WARM_ITERS_WARMUP warmups then times WARM_ITERS_MEASURED in-process
 * iterations of `run(arg)` via CLOCK_MONOTONIC and returns the MINIMUM
 * per-call ms (steady-state floor). Each process's returned value is one
 * outer-sample value. Returns per-outer-sample milliseconds. Mirrors
 * `timeNodeWarmIter` so the warm wasm and warm v8 lanes are constructed the
 * same way (startup amortized over many in-process iterations, not recovered
 * by subtracting two noisy full-process wall-times).
 */
function timeWasmtimeWarmIter(cwasmPath, arg, outerRuns) {
  const samplesMs = [];
  for (let i = 0; i < outerRuns; i++) {
    samplesMs.push(landingWasmtimeWarmSample(cwasmPath, arg).perCallMs);
  }
  return samplesMs;
}

/**
 * Spawns one node process per outer sample. Inside each process, the child
 * warms TurboFan with WARMUP repeats then measures MEASURED in-process
 * iterations. The child's reported per-iteration median is treated as one
 * outer-sample value. Returns per-outer-sample milliseconds.
 */
function timeNodeWarmIter(sourcePath, arg, outerRuns) {
  const samplesMs = [];
  for (let i = 0; i < outerRuns; i++) {
    samplesMs.push(landingNodeWarmSample(CHILD_JS_PATH, sourcePath, arg).medianMs);
  }
  return samplesMs;
}

function addAuxSamples(row, key, samplesUs) {
  if (!Array.isArray(samplesUs) || samplesUs.length === 0) return;
  row[`${key}Us`] = median(samplesUs);
  row[`${key}MinUs`] = min(samplesUs);
  row[`${key}MaxUs`] = max(samplesUs);
  row[`${key}StdUs`] = stddev(samplesUs);
}

function buildRow({
  programId,
  scenario,
  wasmSamplesUs,
  jsSamplesUs,
  extra = {},
  javySamplesUs = null,
  starlingMonkeySamplesUs = null,
}) {
  const ratioSamples = wasmSamplesUs.map(
    (us, i) => (jsSamplesUs[i] ?? jsSamplesUs[jsSamplesUs.length - 1]) / Math.max(us, 0.000001),
  );
  const row = {
    name: programId,
    scenario,
    wasmUs: median(wasmSamplesUs),
    jsUs: median(jsSamplesUs),
    wasmMinUs: min(wasmSamplesUs),
    wasmMaxUs: max(wasmSamplesUs),
    jsMinUs: min(jsSamplesUs),
    jsMaxUs: max(jsSamplesUs),
    wasmStdUs: stddev(wasmSamplesUs),
    jsStdUs: stddev(jsSamplesUs),
    ratioStd: stddev(ratioSamples),
    warmupRounds: WARMUP_RUNS,
    measuredRounds: MEASURED_RUNS,
    ...extra,
  };
  addAuxSamples(row, "javy", javySamplesUs);
  addAuxSamples(row, "starlingMonkey", starlingMonkeySamplesUs);
  if ((row.javyUs || row.starlingMonkeyUs) && !row.lanesProvenance) {
    row.lanesProvenance = scenario === "cold" ? COLD_LANES_PROVENANCE : WARM_LANES_PROVENANCE;
  }
  return row;
}

async function buildModuleSizeRows(programId, sourcePath, wasmPath, auxiliarySizes) {
  const source = stripBenchmarkMetadata(readFileSync(sourcePath, "utf8"));
  const jsBytes = await minifiedJavaScriptByteLength(source);
  return buildLandingModuleSizeRows({
    programId,
    jsBytes,
    aotBytes: statSync(wasmPath).size,
    interpreterBytes: auxiliarySizes.interpreterBytes,
    engineBytes: auxiliarySizes.engineBytes,
  });
}

function readJsonArray(path, label) {
  if (!path) throw new Error(`${label} path is required when BENCHMARK_AUXILIARY_MODE=inherit`);
  const value = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${label} must contain a non-empty array`);
  return value;
}

function loadInheritedAuxiliaryData() {
  if (!/^[0-9a-f]{40}$/.test(AUXILIARY_SOURCE_SHA || "")) {
    throw new Error("BENCHMARK_AUXILIARY_SOURCE_SHA must be a full Git SHA when inheriting auxiliary data");
  }
  return {
    runtimeRows: readJsonArray(AUXILIARY_RUNTIME_BASELINE, "auxiliary runtime baseline"),
    moduleSizeRows: readJsonArray(AUXILIARY_SIZE_BASELINE, "auxiliary module-size baseline"),
  };
}

function inheritedRuntimeFields(runtimeRows, programId, scenario) {
  const matches = runtimeRows.filter((row) => row?.name === programId && row?.scenario === scenario);
  if (matches.length !== 1)
    throw new Error(`Expected one inherited auxiliary runtime row for ${programId}:${scenario}`);
  const inherited = {};
  for (const [key, value] of Object.entries(matches[0])) {
    if (/^(javy|starlingMonkey|auxiliary)/.test(key)) inherited[key] = value;
  }
  for (const key of ["javyUs", "starlingMonkeyUs"]) {
    if (!Number.isFinite(inherited[key]) || inherited[key] <= 0) {
      throw new Error(`Inherited auxiliary runtime row ${programId}:${scenario} is missing ${key}`);
    }
  }
  inherited.auxiliaryMeasurement = "carried-forward-unchanged-inputs";
  inherited.auxiliarySourceSha =
    typeof inherited.auxiliarySourceSha === "string" && /^[0-9a-f]{40}$/.test(inherited.auxiliarySourceSha)
      ? inherited.auxiliarySourceSha
      : AUXILIARY_SOURCE_SHA;
  inherited.lanesProvenance = `${CARRIED_AUXILIARY_PROVENANCE} Source: ${inherited.auxiliarySourceSha}.`;
  return inherited;
}

function inheritedModuleSizes(moduleSizeRows, programId) {
  const find = (name) => moduleSizeRows.find((row) => row?.path === programId && row?.name === name);
  const interpreterBytes = find("Interpreter")?.value;
  const engineBytes = find("Engine")?.value;
  if (!Number.isSafeInteger(interpreterBytes) || interpreterBytes <= 0) {
    throw new Error(`Inherited module-size rows are missing Interpreter:${programId}`);
  }
  if (!Number.isSafeInteger(engineBytes) || engineBytes <= 0) {
    throw new Error(`Inherited module-size rows are missing Engine:${programId}`);
  }
  return { interpreterBytes, engineBytes };
}

function writeOutputs(runtimeRows, moduleSizeRows) {
  const runtimeJson = JSON.stringify(runtimeRows, null, 2) + "\n";
  const moduleSizeJson = JSON.stringify(moduleSizeRows, null, 2) + "\n";
  const outputs = [
    [RESULTS_PATH, runtimeJson],
    [PUBLIC_PATH, runtimeJson],
    [MODULE_SIZE_RESULTS_PATH, moduleSizeJson],
    [MODULE_SIZE_PUBLIC_PATH, moduleSizeJson],
  ];
  const temporaryPaths = [];
  try {
    for (const [path, contents] of outputs) {
      mkdirSync(dirname(path), { recursive: true });
      const temporaryPath = `${path}.tmp-${process.pid}`;
      writeFileSync(temporaryPath, contents);
      temporaryPaths.push([temporaryPath, path]);
    }
    for (const [temporaryPath, path] of temporaryPaths) renameSync(temporaryPath, path);
  } finally {
    for (const [temporaryPath] of temporaryPaths) rmSync(temporaryPath, { force: true });
  }
  for (const [path] of outputs) console.log(`Updated ${path}`);
}

async function main() {
  if (AUXILIARY_MODE !== "measure" && AUXILIARY_MODE !== "inherit") {
    throw new Error(`BENCHMARK_AUXILIARY_MODE must be measure or inherit, received ${AUXILIARY_MODE}`);
  }
  const inheritedAuxiliary = AUXILIARY_MODE === "inherit" ? loadInheritedAuxiliaryData() : null;
  const version = ensureWasmtime();
  console.log(`Using ${version}`);
  process.stdout.write("Building Rust wasmtime cold host... ");
  const coldHostPath = ensureWasmtimeColdHost();
  process.stdout.write(`ok (${coldHostPath})\n`);
  mkdirSync(ARTIFACT_DIR, { recursive: true });
  let componentizeVersion = null;
  let javy = null;
  let javyPluginPath = null;
  if (AUXILIARY_MODE === "measure") {
    componentizeVersion = ensureComponentizeJs();
    console.log(`Using ${componentizeVersion}`);
    javy = resolveJavy();
    if (!javy) {
      throw new Error("Javy is required to refresh the displayed auxiliary benchmarks; install javy or set JAVY_BIN.");
    }
    javyPluginPath = ensureJavyPlugin(javy);
    console.log(`Using ${javy.version}`);
  } else {
    console.log(`Carrying forward unchanged Javy and StarlingMonkey controls from ${AUXILIARY_SOURCE_SHA}`);
  }

  const rows = [];
  const moduleSizeRows = [];

  for (const program of LANDING_BENCHMARK_PROGRAMS) {
    process.stdout.write(`\n[${program.id}] compiling... `);
    const { sourcePath, wasmPath, warmWasmPath } = await compileProgram(program.id);
    const runtimeArg = readRuntimeArg(sourcePath);
    process.stdout.write(`runtimeArg=${runtimeArg}\n`);

    process.stdout.write(`[${program.id}] precompiling warm cranelift... `);
    const warmCwasmPath = precompile(warmWasmPath, `${program.id}-warm`);
    process.stdout.write(`ok\n`);

    let auxArtifacts = null;
    let auxiliarySizes;
    if (AUXILIARY_MODE === "measure") {
      process.stdout.write(`[${program.id}] auxiliary cold + warm artifacts... `);
      auxArtifacts = buildAuxiliaryArtifacts({
        programId: program.id,
        sourcePath,
        runtimeArg,
        javy,
        javyPluginPath,
        componentizeVersion,
      });
      process.stdout.write(`ok\n`);
      auxiliarySizes = {
        interpreterBytes: statSync(auxArtifacts.javyPath).size,
        engineBytes: statSync(auxArtifacts.starlingMonkeyPath).size,
      };
    } else {
      auxiliarySizes = inheritedModuleSizes(inheritedAuxiliary.moduleSizeRows, program.id);
    }
    moduleSizeRows.push(...(await buildModuleSizeRows(program.id, sourcePath, wasmPath, auxiliarySizes)));

    // Cold path (#1764): warm engine / fresh context-or-instance per request,
    // no OS-process startup in the measured samples.
    process.stdout.write(`[${program.id}] wasm cold (wasmtime fresh store+instance)... `);
    const wasmColdMs = timeWasmtimeFreshInstance(coldHostPath, wasmPath, runtimeArg, WARMUP_RUNS + MEASURED_RUNS).slice(
      WARMUP_RUNS,
    );
    process.stdout.write(`${median(wasmColdMs).toFixed(3)} ms\n`);

    process.stdout.write(`[${program.id}] v8 cold (vm context + fresh compile)... `);
    const v8ColdMs = timeNodeVmContextFreshCompile(sourcePath, runtimeArg, WARMUP_RUNS + MEASURED_RUNS).slice(
      WARMUP_RUNS,
    );
    process.stdout.write(`${median(v8ColdMs).toFixed(3)} ms\n`);

    process.stdout.write(`[${program.id}] v8 cold sensitivity (vm context + compiled script)... `);
    const v8CompiledContextMs = timeNodeVmContextCompiledOnce(
      sourcePath,
      runtimeArg,
      WARMUP_RUNS + MEASURED_RUNS,
    ).slice(WARMUP_RUNS);
    process.stdout.write(`${median(v8CompiledContextMs).toFixed(3)} ms\n`);

    let javyColdMs = null;
    let starlingMonkeyColdMs = null;
    if (AUXILIARY_MODE === "measure") {
      process.stdout.write(`[${program.id}] javy cold (dynamic plugin fresh store+instance)... `);
      javyColdMs = timeWasmtimeFreshInstance(
        coldHostPath,
        auxArtifacts.javyPath,
        runtimeArg,
        WARMUP_RUNS + MEASURED_RUNS,
        {
          preloads: [{ name: "javy-default-plugin-v3", path: auxArtifacts.javyPluginPath }],
        },
      ).slice(WARMUP_RUNS);
      process.stdout.write(`${median(javyColdMs).toFixed(3)} ms\n`);

      process.stdout.write(`[${program.id}] starlingmonkey cold (component fresh store+instance)... `);
      starlingMonkeyColdMs = timeWasmtimeFreshInstance(
        coldHostPath,
        auxArtifacts.starlingMonkeyPath,
        runtimeArg,
        WARMUP_RUNS + MEASURED_RUNS,
        { component: true },
      ).slice(WARMUP_RUNS);
      process.stdout.write(`${median(starlingMonkeyColdMs).toFixed(3)} ms\n`);
    }

    // Warm path (#1760): in-process repeated-measure steady-state per-call
    // time, startup amortized. wasm via `warm` export (min per-call ms),
    // v8 via in-process iteration median — both startup-independent, so a
    // few-ms per-call codegen delta is now resolvable (the old cold−baseline
    // subtraction had a ~2.3× run-to-run spread that swamped the signal).
    process.stdout.write(`[${program.id}] wasm warm (in-process iter)... `);
    const wasmWarmMs = timeWasmtimeWarmIter(warmCwasmPath, runtimeArg, MEASURED_RUNS);
    process.stdout.write(`${median(wasmWarmMs).toFixed(2)} ms\n`);

    process.stdout.write(`[${program.id}] v8 warm (in-process iter)... `);
    const v8WarmMs = timeNodeWarmIter(sourcePath, runtimeArg, MEASURED_RUNS);
    process.stdout.write(`${median(v8WarmMs).toFixed(2)} ms\n`);

    let javyWarmMs = null;
    let starlingMonkeyWarmMs = null;
    if (AUXILIARY_MODE === "measure") {
      process.stdout.write(`[${program.id}] javy warm (single-entry batch x${auxArtifacts.warmBatchIterations})... `);
      const javyWarmBatchMs = timeWasmtimeFreshInstance(
        coldHostPath,
        auxArtifacts.javyWarmPath,
        runtimeArg,
        WARMUP_RUNS + MEASURED_RUNS,
        {
          preloads: [{ name: "javy-default-plugin-v3", path: auxArtifacts.javyPluginPath }],
        },
      ).slice(WARMUP_RUNS);
      javyWarmMs = normalizeBatchedRuntimeSamples(javyWarmBatchMs, auxArtifacts.warmBatchIterations);
      process.stdout.write(`${median(javyWarmMs).toFixed(3)} ms\n`);

      process.stdout.write(
        `[${program.id}] starlingmonkey warm (single-entry batch x${auxArtifacts.warmBatchIterations})... `,
      );
      const starlingMonkeyWarmBatchMs = timeWasmtimeFreshInstance(
        coldHostPath,
        auxArtifacts.starlingMonkeyWarmPath,
        runtimeArg,
        WARMUP_RUNS + MEASURED_RUNS,
        { component: true },
      ).slice(WARMUP_RUNS);
      starlingMonkeyWarmMs = normalizeBatchedRuntimeSamples(
        starlingMonkeyWarmBatchMs,
        auxArtifacts.warmBatchIterations,
      );
      process.stdout.write(`${median(starlingMonkeyWarmMs).toFixed(3)} ms\n`);
    }

    const toUs = (samples) => samples.map((ms) => ms * 1000);
    const coldAuxiliary =
      AUXILIARY_MODE === "measure"
        ? {
            auxiliaryMeasurement: "measured-current-run",
            auxiliaryColdWrapper: auxArtifacts.wrapper,
            javyColdMode: "rust-wasmtime-compile-once-dynamic-plugin-fresh-store-instance",
            javyColdEngine: "wasmtime-cranelift-quickjs-wasm-plugin",
            javyColdHost: "benchmarks/wasmtime-cold-host",
            javyVersion: auxArtifacts.javyVersion,
            starlingMonkeyColdMode: "rust-wasmtime-component-compile-once-fresh-store-instance",
            starlingMonkeyColdEngine: "componentize-js-starlingmonkey-weval",
            starlingMonkeyColdHost: "benchmarks/wasmtime-cold-host",
            starlingMonkeyComponentize: auxArtifacts.componentizeVersion,
          }
        : inheritedRuntimeFields(inheritedAuxiliary.runtimeRows, program.id, "cold");
    const warmAuxiliary =
      AUXILIARY_MODE === "measure"
        ? {
            auxiliaryMeasurement: "measured-current-run",
            auxiliaryWarmWrapper: auxArtifacts.warmWrapper,
            auxiliaryWarmBatchIterations: auxArtifacts.warmBatchIterations,
            javyWarmMode: "rust-wasmtime-fresh-dynamic-plugin-instance-single-entry-batch",
            javyWarmEngine: "wasmtime-cranelift-quickjs-wasm-plugin",
            javyWarmHost: "benchmarks/wasmtime-cold-host",
            javyVersion: auxArtifacts.javyVersion,
            starlingMonkeyWarmMode: "rust-wasmtime-fresh-component-instance-single-entry-batch",
            starlingMonkeyWarmEngine: "componentize-js-starlingmonkey-weval",
            starlingMonkeyWarmHost: "benchmarks/wasmtime-cold-host",
            starlingMonkeyComponentize: auxArtifacts.componentizeVersion,
          }
        : inheritedRuntimeFields(inheritedAuxiliary.runtimeRows, program.id, "warm");

    rows.push(
      buildRow({
        programId: program.id,
        scenario: "cold",
        wasmSamplesUs: toUs(wasmColdMs),
        jsSamplesUs: toUs(v8ColdMs),
        extra: {
          wasmColdMode: "rust-wasmtime-compile-once-fresh-store-instance",
          wasmColdEngine: "wasmtime-cranelift",
          wasmColdHost: "benchmarks/wasmtime-cold-host",
          jsColdMode: "node-vm-create-context-fresh-script",
          jsColdFidelity: "vm-context-lower-bound-vs-true-v8-isolate",
          jsCompiledContextUs: median(toUs(v8CompiledContextMs)),
          jsCompiledContextStdUs: stddev(toUs(v8CompiledContextMs)),
          ...coldAuxiliary,
        },
        javySamplesUs: javyColdMs ? toUs(javyColdMs) : null,
        starlingMonkeySamplesUs: starlingMonkeyColdMs ? toUs(starlingMonkeyColdMs) : null,
      }),
    );
    rows.push(
      buildRow({
        programId: program.id,
        scenario: "warm",
        wasmSamplesUs: toUs(wasmWarmMs),
        jsSamplesUs: toUs(v8WarmMs),
        extra: {
          ...warmAuxiliary,
        },
        javySamplesUs: javyWarmMs ? toUs(javyWarmMs) : null,
        starlingMonkeySamplesUs: starlingMonkeyWarmMs ? toUs(starlingMonkeyWarmMs) : null,
      }),
    );
  }

  writeOutputs(rows, moduleSizeRows);

  try {
    rmSync(ARTIFACT_DIR, { recursive: true, force: true });
  } catch {
    // best-effort cleanup; .tmp is gitignored
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
