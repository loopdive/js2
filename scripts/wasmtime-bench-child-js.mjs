/**
 * Spawned by generate-wasmtime-hot-runtime.mjs. Loads a competitive program
 * (a JS module exporting `run(n)`) and reports a timing on stdout as JSON.
 *
 * Two measurement modes:
 *   --mode=single
 *     Load module, call run(arg) once, exit. The parent measures the full
 *     process wall time (process spawn + V8 boot + parse + first run). This
 *     is the "cold isolate" / per-request cost on Cloudflare Workers, Deno
 *     Deploy, etc. when an isolate hasn't been warmed yet.
 *
 *   --mode=warm
 *     Load module, call run(arg) WARMUP times so TurboFan tiers up, then call
 *     run(arg) MEASURED more times recording each iteration's in-process
 *     wall time. Reports the median iteration time. This is the "warm
 *     isolate" / per-request cost on platforms that reuse isolates across
 *     requests (the common case for Cloudflare Workers steady-state traffic).
 *
 * Usage:
 *   node [--jitless] wasmtime-bench-child-js.mjs --mode=single <program.js> <arg>
 *   node [--jitless] wasmtime-bench-child-js.mjs --mode=warm   <program.js> <arg>
 */
import { pathToFileURL } from "node:url";

const WARMUP = 6;
const MEASURED = 9;

const args = process.argv.slice(2);
let mode = "single";
const positional = [];
for (const arg of args) {
  if (arg.startsWith("--mode=")) {
    mode = arg.slice("--mode=".length);
  } else {
    positional.push(arg);
  }
}
const [programPath, inputRaw] = positional;
if (!programPath || inputRaw == null) {
  process.stderr.write("Usage: node wasmtime-bench-child-js.mjs --mode=<single|warm> <program.js> <input>\n");
  process.exit(1);
}

const mod = await import(pathToFileURL(programPath).href);
if (typeof mod.run !== "function") {
  process.stderr.write(`Program ${programPath} does not export run()\n`);
  process.exit(1);
}

const inputValue = Number(inputRaw);

if (mode === "single") {
  const t0 = performance.now();
  const result = mod.run(inputValue);
  const execMs = performance.now() - t0;
  process.stdout.write(JSON.stringify({ mode: "single", result, execMs }) + "\n");
} else if (mode === "warm") {
  for (let i = 0; i < WARMUP; i++) mod.run(inputValue);
  const samplesMs = [];
  for (let i = 0; i < MEASURED; i++) {
    const t0 = performance.now();
    const result = mod.run(inputValue);
    samplesMs.push(performance.now() - t0);
    void result;
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  process.stdout.write(JSON.stringify({ mode: "warm", samplesMs, medianMs: median }) + "\n");
} else {
  process.stderr.write(`Unknown mode: ${mode}\n`);
  process.exit(1);
}
