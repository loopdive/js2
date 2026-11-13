// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#874) Octane worker — Porffor lane. Runs the SAME driver (export stripped)
// under `$PORFFOR_DIR/porf` (default /home/user/porffor, the cross-engine
// convention). When Porffor is not installed every row is `skipped` with the
// reason — never omitted.
//
// Timing happens inside the Porffor-compiled program with `Date.now()`, captured
// before the prelude replaces `performance`; the reps are large enough (node-
// calibrated, ≥ 50 ms per call) that 1 ms resolution is a ≤ 2 % effect. This
// path is untested on the container that wrote it (Porffor absent there).
//
//   node benchmarks/octane/worker-porffor.mjs --bench richards [--reps N] [--tamper]
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { classifyThrow, emitRow, octaneScore, parseWorkerArgs, ROW_MARKER, SAMPLES } from "./common.mjs";
import { buildDriver } from "./driver.mjs";
import { MANIFEST, REPO_ROOT } from "./fetch.mjs";

const PORFFOR_DIR = process.env.PORFFOR_DIR ?? "/home/user/porffor";

const args = parseWorkerArgs();
const meta = MANIFEST.benchmarks[args.bench];
const row = { bench: args.bench, lane: "porffor", engine: "porffor" };
const porf = join(PORFFOR_DIR, "porf");
if (!existsSync(porf)) {
  emitRow({ ...row, status: "skipped", reason: `porffor not installed (no ${porf}; set PORFFOR_DIR)` });
}

const reps = Math.max(args.reps ?? meta.minReps, meta.minReps);
const body = buildDriver(args.bench, { tamper: args.tamper }).replace(/^export function octane_/gm, "function octane_");
const src = `var __octane_clock = Date.now;
${body}
var __octane_reps = ${reps};
var __octane_out = { status: "ok", samplesMs: [], count: 0 };
try {
  __octane_out.count = octane_run(__octane_reps);
  for (var __i = 0; __i < ${SAMPLES}; __i++) {
    var __t0 = __octane_clock();
    octane_run(__octane_reps);
    __octane_out.samplesMs.push(__octane_clock() - __t0);
  }
  octane_teardown();
} catch (e) {
  __octane_out.status = "threw";
  __octane_out.error = (e && e.message) ? (e.name + ": " + e.message) : String(e);
}
console.log(${JSON.stringify(ROW_MARKER)} + JSON.stringify(__octane_out));
`;
const outDir = join(REPO_ROOT, ".tmp", "octane");
mkdirSync(outDir, { recursive: true });
const driverPath = join(outDir, `${args.bench}.porffor.js`);
writeFileSync(driverPath, src);
row.driver = driverPath;

const res = spawnSync(porf, [driverPath], { encoding: "utf-8", maxBuffer: 64 << 20 });
// Porffor prints C-compiler warnings on stdout; only the marker line is data.
const line = (res.stdout ?? "").split("\n").find((l) => l.startsWith(ROW_MARKER));
if (!line) {
  const err = `${res.stderr ?? ""}${res.stdout ?? ""}`.trim().split("\n").slice(-3).join(" | ");
  emitRow({ ...row, status: "compile-error", error: err || `porf exited ${res.status} without a result line` });
}
const out = JSON.parse(line.slice(ROW_MARKER.length));
if (out.status !== "ok") {
  emitRow({ ...row, status: classifyThrow(args.bench, out.error), phase: "run", reps, error: out.error });
}
const usPerRun = out.samplesMs.map((ms) => (ms * 1000) / out.count);
const meanUsPerRun = usPerRun.reduce((a, b) => a + b, 0) / usPerRun.length;
emitRow({
  ...row,
  status: meta.hasValidation ? "pass" : "pass-unvalidated",
  warmupRuns: 1,
  reps,
  iterationsPerCall: out.count,
  samplesMs: out.samplesMs,
  meanUsPerRun: Number(meanUsPerRun.toFixed(3)),
  minUsPerRun: Number(Math.min(...usPerRun).toFixed(3)),
  octaneScore: octaneScore(args.bench, meanUsPerRun),
  timer: "Date.now (1 ms resolution)",
});
