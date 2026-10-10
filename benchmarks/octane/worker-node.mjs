// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#874) Octane worker — node (V8) reference lane. One fresh process per bench
// (spawned by run.mjs). The driver is written to `.tmp/octane/<bench>.js` for
// reproduction and executed as a plain SCRIPT in this process's main realm
// (`vm.runInThisContext`), so `this` at top level is the real global object —
// box2d attaches `Box2D` to it — and no other lane can have polluted the realm.
//
//   node benchmarks/octane/worker-node.mjs --bench richards [--reps N|auto] [--tamper]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance as perf } from "node:perf_hooks";
import vm from "node:vm";

import {
  calibrateReps,
  classifyThrow,
  describeThrown,
  emitReady,
  emitRow,
  measureRun,
  octaneScore,
  parseWorkerArgs,
  stackTop,
} from "./common.mjs";
import { buildDriver, forScript } from "./driver.mjs";
import { MANIFEST, REPO_ROOT } from "./fetch.mjs";

const args = parseWorkerArgs();
const meta = MANIFEST.benchmarks[args.bench];
// Captured before the driver runs: its prelude replaces the global `performance`.
const now = () => perf.now();
const row = { bench: args.bench, lane: "node", engine: `node ${process.version}` };

const src = forScript(buildDriver(args.bench, { tamper: args.tamper }));
const outDir = join(REPO_ROOT, ".tmp", "octane");
mkdirSync(outDir, { recursive: true });
const driverPath = join(outDir, `${args.bench}${args.tamper ? ".tampered" : ""}.js`);
writeFileSync(driverPath, src);
row.driver = driverPath;

try {
  vm.runInThisContext(src, { filename: driverPath });
} catch (e) {
  emitRow({ ...row, status: "runtime-error", phase: "init", error: describeThrown(e), stack: stackTop(e) });
}
emitReady({});
const run = globalThis.__octane_run;
let reps = Math.max(args.reps ?? 0, meta.minReps);
let phase = "run";
try {
  if (args.reps == null) {
    reps = calibrateReps(run, meta.minReps, now);
    row.repsSource = "node-calibrated";
  } else {
    row.repsSource = "given";
  }
  const m = measureRun(run, reps, now);
  phase = "teardown";
  globalThis.__octane_teardown();
  emitRow({
    ...row,
    status: meta.hasValidation ? "pass" : "pass-unvalidated",
    ...m,
    octaneScore: octaneScore(args.bench, m.meanUsPerRun),
  });
} catch (e) {
  const error = describeThrown(e);
  emitRow({ ...row, status: classifyThrow(args.bench, error), phase, reps, error, stack: stackTop(e) });
}
