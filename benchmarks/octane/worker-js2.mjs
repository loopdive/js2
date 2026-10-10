// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#874) Octane worker — js2 lanes (`gc` host, `standalone`, `linear`). One
// fresh process per (bench, lane), spawned by run.mjs with `--import tsx`.
// Compiles the shared driver, instantiates, times `octane_run(reps)` from the
// host and prints exactly one status row. Every failure is a row with its
// message; nothing is swallowed.
//
//   node --import tsx benchmarks/octane/worker-js2.mjs --bench richards --lane gc [--reps N|auto] [--tamper]
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import { exceptionPayload, renderHarnessThrownText } from "../../scripts/lib/wasm-exn-render.mjs";
import { buildImports, compile, instantiateWasm } from "../../src/index.ts";
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
import { buildDriver } from "./driver.mjs";
import { MANIFEST, REPO_ROOT } from "./fetch.mjs";

const LANE_OPTIONS = {
  gc: {},
  standalone: { target: "standalone" },
  linear: { target: "linear" },
};

const args = parseWorkerArgs();
const meta = MANIFEST.benchmarks[args.bench];
const now = () => performance.now();
const row = { bench: args.bench, lane: args.lane, engine: `js2 (${args.lane}) on node ${process.version}` };
if (!LANE_OPTIONS[args.lane]) {
  emitRow({ ...row, status: "skipped", reason: `unknown js2 lane ${args.lane}` });
}

const src = buildDriver(args.bench, { tamper: args.tamper });
const outDir = join(REPO_ROOT, ".tmp", "octane");
mkdirSync(outDir, { recursive: true });
const driverPath = join(outDir, `${args.bench}${args.tamper ? ".tampered" : ""}.module.js`);
writeFileSync(driverPath, src);
row.driver = driverPath;

// ---- compile ---------------------------------------------------------------
let result;
const t0 = now();
try {
  result = await compile(src, {
    fileName: "octane.js",
    allowJs: true,
    skipSemanticDiagnostics: true,
    validate: false,
    ...LANE_OPTIONS[args.lane],
  });
} catch (e) {
  emitRow({ ...row, status: "compile-error", error: `compiler threw: ${describeThrown(e)}`, stack: stackTop(e) });
}
row.compileMs = Math.round(now() - t0);
if (!result.success || !result.binary?.length) {
  const errors = (result.errors ?? []).map((e) => String(e.message ?? e.messageText ?? e).split("\n")[0]);
  emitRow({
    ...row,
    status: "compile-error",
    error: errors[0] ?? "compile failed without an error message",
    errorCount: errors.length,
    errors: errors.slice(0, 8),
  });
}
row.binaryBytes = result.binary.length;
const wasmPath = join(outDir, `${args.bench}.${args.lane}.wasm`);
writeFileSync(wasmPath, result.binary);
row.wasm = wasmPath;

// ---- validate (the compile above ran with validate:false, like harness.ts) --
let mod;
try {
  mod = await WebAssembly.compile(result.binary);
} catch (e) {
  emitRow({ ...row, status: "invalid-wasm", error: describeThrown(e) });
}

// ---- instantiate (module init runs the scripts' top-level code) -----------
let instance;
try {
  if (args.lane === "standalone") {
    const leaked = WebAssembly.Module.imports(mod).map((i) => `${i.module}.${i.name}`);
    if (leaked.length) {
      emitRow({
        ...row,
        status: "instantiate-error",
        error: `standalone module has ${leaked.length} host import(s): ${leaked.slice(0, 6).join(", ")}`,
      });
    }
    instance = await WebAssembly.instantiate(mod, {});
  } else {
    const imports = buildImports(result.imports, {}, result.stringPool);
    ({ instance } = await instantiateWasm(
      result.binary,
      imports.env,
      imports.string_constants,
      imports.string_constants16,
    ));
    imports.setInstance?.(instance);
  }
} catch (e) {
  const linkFailure = e instanceof WebAssembly.LinkError || /import/i.test(String(e?.message ?? ""));
  // A throw from the module's top-level code (start function) leaves no
  // instance, so its `__exn_tag` export is unreachable and the payload cannot
  // be decoded — say so instead of printing "[object WebAssembly.Exception]".
  const error =
    e instanceof WebAssembly.Exception
      ? "opaque wasm exception thrown by the module's top-level code (no instance, so __exn_tag cannot decode the payload)"
      : renderHarnessThrownText(e, undefined);
  emitRow({
    ...row,
    status: linkFailure ? "instantiate-error" : "runtime-error",
    phase: "init",
    error,
    stack: stackTop(e),
  });
}
const run = instance.exports.octane_run;
const teardown = instance.exports.octane_teardown;
if (typeof run !== "function" || typeof teardown !== "function") {
  emitRow({
    ...row,
    status: "instantiate-error",
    error: `octane_run/octane_teardown export missing; exports: ${Object.keys(instance.exports).slice(0, 10).join(", ")}`,
  });
}

// ---- run ---------------------------------------------------------------------
emitReady({ compileMs: row.compileMs, binaryBytes: row.binaryBytes });
let reps = Math.max(args.reps ?? 0, meta.minReps);
let phase = "run";
try {
  if (args.reps == null) {
    // No node reference reps (node lane filtered out or failed): calibrate here.
    reps = calibrateReps(run, meta.minReps, now);
    row.repsSource = "self-calibrated";
  } else {
    row.repsSource = "given";
  }
  const m = measureRun(run, reps, now);
  phase = "teardown";
  teardown();
  emitRow({
    ...row,
    status: meta.hasValidation ? "pass" : "pass-unvalidated",
    ...m,
    octaneScore: octaneScore(args.bench, m.meanUsPerRun),
  });
} catch (e) {
  let error = renderHarnessThrownText(e, instance);
  const payload = exceptionPayload(e, instance);
  if (e instanceof WebAssembly.Exception && payload === undefined) {
    error = "opaque wasm exception (no __exn_tag export to decode the payload)";
  }
  // A host-created Error carried through a Wasm exception holds the useful stack.
  const payloadStack = payload && typeof payload === "object" ? stackTop(payload) : [];
  const stack = payloadStack.length ? payloadStack : stackTop(e);
  emitRow({ ...row, status: classifyThrow(args.bench, error), phase, reps, error, stack });
}
