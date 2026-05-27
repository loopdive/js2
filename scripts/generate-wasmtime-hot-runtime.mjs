#!/usr/bin/env node
/**
 * Generates the Wasmtime-vs-V8 per-request comparison data for the landing
 * page chart `<perf-benchmark-chart src="…hot-runtime.json">`.
 *
 * The page positions this as a Fastly Compute (Wasmtime + AOT-precompiled
 * `.cwasm`) vs Cloudflare Workers (V8 isolate) comparison: edge serverless
 * platforms that both run untrusted code per request, but with very
 * different cost models for fresh-vs-reused execution contexts.
 *
 * Two scenarios per program (8 rows total):
 *
 *   1. **Cold isolate / fresh process per request**
 *      Models the worst-case edge serverless request: a request arrives, no
 *      pre-warmed instance exists, the runtime must boot from scratch.
 *      - Wasm lane: full `wasmtime run --allow-precompiled` wall time
 *        (wasmtime startup ~ms + cwasm `mmap` + signature check + `run(arg)`).
 *      - JS lane: full `node script.js` wall time (V8 startup + module parse
 *        + Ignition → Liftoff → first invocation).
 *      Both include process startup. This is the honest per-request cost
 *      on a platform where requests aren't pinned to warm instances.
 *
 *   2. **Warm isolate / reused instance**
 *      Models the common-case edge serverless request: the runtime has
 *      already served a request, the isolate is reused, optimizing tiers
 *      have completed.
 *      - Wasm lane: `(full wall time with runtimeArg) − (baseline wall time
 *        with arg=0)`. Cranelift-compiled native code doesn't tier up, so
 *        per-iteration cost equals per-request cost minus the fixed
 *        startup amortized away in the steady state.
 *      - JS lane: spawn `node` once, call `mod.run(arg)` WARMUP times so
 *        TurboFan tiers up, then time MEASURED more in-process iterations
 *        and report the median. This is what a Cloudflare Workers isolate
 *        actually pays once an optimizing tier has built up.
 *
 * Why no Pulley / no-JIT lane: Pulley is a portability/dev tool in
 * Wasmtime, not a production serverless config (Fastly/Fermyon/Shopify all
 * use Cranelift-compiled native code). Including it confused the message;
 * the genuine comparison is Cranelift AOT vs V8 JIT.
 *
 * ## Javy + StarlingMonkey lanes
 *
 * The hot-runtime JSON also carries `javyUs` and `starlingMonkeyUs` per row
 * so the landing-page chart can render four lanes: js2wasm AOT, V8 with JIT,
 * Javy (interpreter), StarlingMonkey (engine).
 *
 * Those two values are NOT measured by this script — they require:
 *   - wasmtime ≥ 40 (for component `--invoke "fn(args)"` syntax)
 *   - javy + javy-default-plugin-v3 (Shopify-style dynamic-link mode)
 *   - @bytecodealliance/componentize-js ≥ 0.20.0 + Wizer + Weval AOT
 *
 * The full four-lane harness lives in the labs repo under
 * `benchmarks/compare-runtimes.ts` + `benchmarks/competitive/`. This script
 * (the public landing-page generator) carries the verified Javy /
 * StarlingMonkey numbers forward from that harness; refresh them when the
 * labs run produces new measurements by editing JAVY_NUMBERS_MS /
 * STARLINGMONKEY_NUMBERS_MS below.
 *
 * Requirements: `wasmtime` (v35+) on PATH; competitive programs under
 * `public/benchmarks/competitive/programs/*.js`.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { compile } from "./compiler-bundle.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PROGRAMS_DIR = resolve(ROOT, "website", "public", "benchmarks", "competitive", "programs");
const ARTIFACT_DIR = resolve(ROOT, ".tmp", "wasmtime-hot-runtime");
const CHILD_JS_PATH = resolve(import.meta.dirname, "wasmtime-bench-child-js.mjs");

const RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "wasm-host-wasmtime-hot-runtime.json");
const PUBLIC_PATH = resolve(ROOT, "website", "public", "benchmarks", "results", "wasm-host-wasmtime-hot-runtime.json");

// `object-ops` excluded: js2wasm emits the modern exception-handling
// proposal for object literal lookups, which Cranelift in wasmtime 35
// parses but doesn't yet compile.
const PROGRAMS = [
  { id: "fib", label: "Fibonacci loop" },
  { id: "fib-recursive", label: "Fibonacci recursion" },
  { id: "array-sum", label: "Array fill + sum" },
  { id: "string-hash", label: "String build + hash" },
];

const WARMUP_RUNS = 2;
const MEASURED_RUNS = 7;
const WASMTIME_FEATURES = ["-W", "gc=y", "-W", "function-references=y"];

// Javy + StarlingMonkey verified numbers (2026-04-27 wasmtime 44.0.0,
// aarch64-linux) — see labs benchmarks/compare-runtimes.ts.
// Map: `cold` → README "Cold ms" (process startup + first call);
//      `warm` → README "Compute-only ms" (steady-state per call).
// Programs not present in either table fall back to 0 (omitted from chart).
const JAVY_NUMBERS_MS = {
  fib: { cold: 28.8, warm: 1193.2 },
  "fib-recursive": { cold: 31.2, warm: 87.9 },
  "array-sum": { cold: 28.0, warm: 112.9 },
  "string-hash": { cold: 30.7, warm: 36.0 },
};
const STARLINGMONKEY_NUMBERS_MS = {
  fib: { cold: 37.2, warm: 1024.3 },
  "fib-recursive": { cold: 26.4, warm: 156.7 },
  "array-sum": { cold: 31.0, warm: 125.5 },
  "string-hash": { cold: 30.5, warm: 14.2 },
};
const LANES_PROVENANCE =
  "javyUs/starlingMonkeyUs from verified 2026-04-27 wasmtime 44.0.0 aarch64-linux " +
  "labs measurements (compare-runtimes.ts). Javy = Shopify-style dynamic-link " +
  "with javy-default-plugin-v3 preload. StarlingMonkey = ComponentizeJS 0.20.0 + " +
  "Wizer + Weval AOT.";

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

function ensureWasmtime() {
  try {
    const out = execFileSync("wasmtime", ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
    return out.toString().trim();
  } catch {
    throw new Error("wasmtime not found on PATH. Install from https://wasmtime.dev/ and retry.");
  }
}

function compileProgram(id) {
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
  const result = compile(source, { fileName: `${id}.js`, target: "wasi", nativeStrings: true, optimize: 3 });
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
  return { sourcePath, wasmPath };
}

function precompile(wasmPath, id) {
  const cwasmPath = resolve(ARTIFACT_DIR, `${id}.cranelift.cwasm`);
  const args = ["compile", ...WASMTIME_FEATURES, wasmPath, "-o", cwasmPath];
  execFileSync("wasmtime", args, { stdio: ["ignore", "pipe", "pipe"] });
  return cwasmPath;
}

function readRuntimeArg(sourcePath) {
  const text = readFileSync(sourcePath, "utf8");
  const match = text.match(/runtimeArg:\s*(\d+)/);
  if (!match) throw new Error(`runtimeArg not found in ${sourcePath}`);
  return Number(match[1]);
}

/**
 * Wall time of N `wasmtime run` invocations, each a fresh process.
 * Returns per-sample milliseconds.
 */
function timeWasmtime(cwasmPath, arg, runs) {
  const cmdArgs = ["run", "--allow-precompiled", ...WASMTIME_FEATURES, "--invoke", "run", cwasmPath, String(arg)];
  const samplesMs = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = spawnSync("wasmtime", cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const ms = performance.now() - t0;
    if (r.status !== 0) {
      throw new Error(`wasmtime failed (exit ${r.status}): ${(r.stderr ?? "").toString().slice(0, 400)}`);
    }
    samplesMs.push(ms);
  }
  return samplesMs;
}

/**
 * Wall time of N `node script.js` invocations in "single" mode. Each sample
 * is one fresh node process: V8 boot, parse, single call to run().
 */
function timeNodeColdProcess(sourcePath, arg, runs) {
  const cmdArgs = [CHILD_JS_PATH, "--mode=single", sourcePath, String(arg)];
  const samplesMs = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    const ms = performance.now() - t0;
    if (r.status !== 0) {
      throw new Error(`node single failed (exit ${r.status}): ${(r.stderr ?? "").toString().slice(0, 400)}`);
    }
    samplesMs.push(ms);
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
  const cmdArgs = [CHILD_JS_PATH, "--mode=warm", sourcePath, String(arg)];
  const samplesMs = [];
  for (let i = 0; i < outerRuns; i++) {
    const r = spawnSync(process.execPath, cmdArgs, { stdio: ["ignore", "pipe", "pipe"] });
    if (r.status !== 0) {
      throw new Error(`node warm failed (exit ${r.status}): ${(r.stderr ?? "").toString().slice(0, 400)}`);
    }
    const out = (r.stdout ?? "").toString().trim().split("\n").pop();
    const parsed = JSON.parse(out);
    if (typeof parsed?.medianMs !== "number") {
      throw new Error(`node warm did not return medianMs: ${out}`);
    }
    samplesMs.push(parsed.medianMs);
  }
  return samplesMs;
}

function buildRow({ programId, scenario, wasmSamplesUs, jsSamplesUs }) {
  const ratioSamples = wasmSamplesUs.map(
    (us, i) => (jsSamplesUs[i] ?? jsSamplesUs[jsSamplesUs.length - 1]) / Math.max(us, 0.000001),
  );
  const row = {
    name: programId,
    scenario,
    wasmUs: median(wasmSamplesUs),
    jsUs: median(jsSamplesUs),
    wasmStdUs: stddev(wasmSamplesUs),
    jsStdUs: stddev(jsSamplesUs),
    ratioStd: stddev(ratioSamples),
    warmupRounds: WARMUP_RUNS,
    measuredRounds: MEASURED_RUNS,
  };
  const javyMs = JAVY_NUMBERS_MS[programId]?.[scenario];
  if (typeof javyMs === "number" && javyMs > 0) {
    row.javyUs = javyMs * 1000;
  }
  const smMs = STARLINGMONKEY_NUMBERS_MS[programId]?.[scenario];
  if (typeof smMs === "number" && smMs > 0) {
    row.starlingMonkeyUs = smMs * 1000;
  }
  if (row.javyUs || row.starlingMonkeyUs) {
    row.lanesProvenance = LANES_PROVENANCE;
  }
  return row;
}

function writeOutput(rows) {
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(rows, null, 2) + "\n");
  mkdirSync(dirname(PUBLIC_PATH), { recursive: true });
  copyFileSync(RESULTS_PATH, PUBLIC_PATH);
  console.log(`Updated ${RESULTS_PATH}`);
  console.log(`Updated ${PUBLIC_PATH}`);
}

async function main() {
  const version = ensureWasmtime();
  console.log(`Using ${version}`);
  mkdirSync(ARTIFACT_DIR, { recursive: true });

  const rows = [];

  for (const program of PROGRAMS) {
    process.stdout.write(`\n[${program.id}] compiling... `);
    const { sourcePath, wasmPath } = compileProgram(program.id);
    const runtimeArg = readRuntimeArg(sourcePath);
    process.stdout.write(`runtimeArg=${runtimeArg}\n`);

    process.stdout.write(`[${program.id}] precompiling cranelift... `);
    const cwasmPath = precompile(wasmPath, program.id);
    process.stdout.write(`ok\n`);

    // Cold path: full process wall time, no subtraction.
    process.stdout.write(`[${program.id}] wasm cold (full process)... `);
    const wasmColdMs = timeWasmtime(cwasmPath, runtimeArg, WARMUP_RUNS + MEASURED_RUNS).slice(WARMUP_RUNS);
    process.stdout.write(`${median(wasmColdMs).toFixed(1)} ms\n`);

    process.stdout.write(`[${program.id}] v8 cold (full process)... `);
    const v8ColdMs = timeNodeColdProcess(sourcePath, runtimeArg, WARMUP_RUNS + MEASURED_RUNS).slice(WARMUP_RUNS);
    process.stdout.write(`${median(v8ColdMs).toFixed(1)} ms\n`);

    // Warm path: wasm exec only (subtract baseline arg=0); v8 warm in-process median.
    process.stdout.write(`[${program.id}] wasm baseline (arg=0)... `);
    const wasmBaselineMs = timeWasmtime(cwasmPath, 0, WARMUP_RUNS + MEASURED_RUNS).slice(WARMUP_RUNS);
    const wasmBaselineMedian = median(wasmBaselineMs);
    process.stdout.write(`${wasmBaselineMedian.toFixed(1)} ms\n`);

    const wasmWarmMs = wasmColdMs.map((ms) => Math.max(ms - wasmBaselineMedian, 0.001));
    process.stdout.write(`[${program.id}] wasm warm (cold − baseline) = ${median(wasmWarmMs).toFixed(2)} ms\n`);

    process.stdout.write(`[${program.id}] v8 warm (in-process iter)... `);
    const v8WarmMs = timeNodeWarmIter(sourcePath, runtimeArg, MEASURED_RUNS);
    process.stdout.write(`${median(v8WarmMs).toFixed(2)} ms\n`);

    const toUs = (samples) => samples.map((ms) => ms * 1000);

    rows.push(
      buildRow({
        programId: program.id,
        scenario: "cold",
        wasmSamplesUs: toUs(wasmColdMs),
        jsSamplesUs: toUs(v8ColdMs),
      }),
    );
    rows.push(
      buildRow({
        programId: program.id,
        scenario: "warm",
        wasmSamplesUs: toUs(wasmWarmMs),
        jsSamplesUs: toUs(v8WarmMs),
      }),
    );
  }

  writeOutput(rows);

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
