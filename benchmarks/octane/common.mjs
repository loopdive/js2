// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#874) Shared helpers for the Octane workers: argv parsing, the single-JSON-
// line result protocol, error classification, and the timing loop. Every lane
// measures through the SAME `measureRun` so the numbers are comparable.
import { writeSync } from "node:fs";

import { MANIFEST } from "./fetch.mjs";

/** Marker the orchestrator scans for; everything else on stdout is ignored. */
export const ROW_MARKER = "__OCTANE_ROW__ ";

/** Timed samples per row (after one validated warm-up call). */
export const SAMPLES = 5;
/** Node calibration target: one `octane_run(reps)` call must take at least this long. */
export const CALIBRATE_TARGET_MS = 50;
const MAX_REPS = 1 << 14;

/** @returns {{ bench: string, lane: string, reps: number | null, tamper: boolean }} */
export function parseWorkerArgs(argv = process.argv.slice(2)) {
  const get = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const reps = get("reps");
  return {
    bench: get("bench") ?? "",
    lane: get("lane") ?? "",
    reps: reps && reps !== "auto" ? Number(reps) : null,
    tamper: argv.includes("--tamper"),
  };
}

/** Marker for the "compiled + instantiated, now running" progress line. */
export const READY_MARKER = "__OCTANE_READY__ ";

/**
 * Tell the orchestrator compilation is over: it switches from the compile
 * timeout to the (shorter) run timeout, and keeps `info` for a timeout row.
 */
export function emitReady(info) {
  writeSync(1, `${READY_MARKER}${JSON.stringify(info)}\n`);
}

/** Print the row and exit NOW (a worker emits exactly one row; nothing after it runs). */
export function emitRow(row) {
  writeSync(1, `${ROW_MARKER}${JSON.stringify(row)}\n`);
  process.exit(0);
}

/** Text of a thrown JS value without letting a host TypeError escape. */
export function describeThrown(e) {
  try {
    if (e instanceof Error) return `${e.name}: ${e.message}`;
    return String(e);
  } catch {
    return `uncaught non-stringifiable ${typeof e}`;
  }
}

/** First few stack frames (wasm function names are the useful repro pointer). */
export function stackTop(e, n = 4) {
  const s = e && typeof e === "object" && typeof e.stack === "string" ? e.stack : "";
  return s
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, n);
}

/**
 * A throw out of `run()` whose text matches one of the bench's Octane
 * validation messages is a WRONG ANSWER; anything else is a runtime error.
 * @returns {"wrong-result" | "runtime-error"}
 */
export function classifyThrow(bench, message) {
  const meta = MANIFEST.benchmarks[bench];
  return meta.validationMessages.some((m) => message.includes(m)) ? "wrong-result" : "runtime-error";
}

/**
 * Pick `reps` so one `run(reps)` call takes ≥ CALIBRATE_TARGET_MS (node lane).
 * The calibration calls double as warm-up. The first, untimed call runs at
 * `minReps` — it absorbs the one-time Setup (splay builds its tree there) and
 * fires a frame-gated check (navier-stokes, frame 15).
 */
export function calibrateReps(run, minReps, now) {
  let reps = Math.max(1, minReps);
  run(reps);
  const timeOnce = () => {
    const t0 = now();
    run(reps);
    return now() - t0;
  };
  for (;;) {
    // min of two calls: a single early call is dominated by JIT tier-up / GC.
    const ms = Math.min(timeOnce(), timeOnce());
    if (ms >= CALIBRATE_TARGET_MS || reps >= MAX_REPS) return reps;
    const next = ms > 0 ? Math.ceil((reps * CALIBRATE_TARGET_MS * 1.2) / ms) : reps * 8;
    reps = Math.min(MAX_REPS, Math.max(reps * 2, next));
  }
}

/**
 * One validated warm-up call, then SAMPLES timed calls of `run(reps)`.
 * `count` is the number of benchmark iterations one call performs (reps × the
 * suite's benchmark count), returned by `octane_run` itself.
 */
export function measureRun(run, reps, now) {
  const count = Number(run(reps));
  if (!(count > 0)) throw new Error(`octane_run(${reps}) returned ${count}, expected a positive iteration count`);
  const samples = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = now();
    run(reps);
    samples.push(now() - t0);
  }
  const usPerRun = samples.map((ms) => (ms * 1000) / count);
  const meanUsPerRun = usPerRun.reduce((a, b) => a + b, 0) / usPerRun.length;
  return {
    warmupRuns: 1,
    reps,
    iterationsPerCall: count,
    samplesMs: samples.map((ms) => Number(ms.toFixed(3))),
    meanUsPerRun: Number(meanUsPerRun.toFixed(3)),
    minUsPerRun: Number(Math.min(...usPerRun).toFixed(3)),
  };
}

/** Octane's own formula (base.js NotifyResult + FormatScore), from the MEAN. */
export function octaneScore(bench, meanUsPerRun) {
  const ref = MANIFEST.benchmarks[bench].reference[0];
  return Math.round((ref / meanUsPerRun) * 100);
}
