#!/usr/bin/env node
/**
 * No-JIT benchmark child process.
 *
 * Spawned by `generate-playground-benchmark-sidebar-no-jit.mjs` under V8 startup
 * flags that pin execution to the no-JIT tier:
 *
 *   - JS lane:   `--jitless --no-opt --no-turbofan --no-sparkplug --no-maglev`
 *                → V8 Ignition interpreter only (no Sparkplug baseline, no
 *                Maglev, no Turbofan).
 *   - Wasm lane: `--no-wasm-tier-up --liftoff`
 *                → V8 Liftoff (single-pass baseline) only, no Turbofan tier-up.
 *                This is the closest analogue to wasmtime cranelift opt-level 0.
 *
 * Both lanes share the same warmup/calibrate/measure protocol as the JIT-enabled
 * sidebar generator so the two charts compare like-for-like sample counts.
 *
 * Usage:
 *   node [v8-flags] no-jit-bench-child.mjs --lane=js   --js-source <path> --export <name>
 *   node [v8-flags] no-jit-bench-child.mjs --lane=wasm --wasm <path> --imports <path> --export <name>
 *
 * The child writes a single JSON object to stdout:
 *   { samplesUs: number[], iters: number }
 *
 * Errors are surfaced via non-zero exit code with the message on stderr.
 */

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith("--") && arg.includes("=")) {
      const [key, value] = arg.slice(2).split("=");
      out[key] = value;
    } else if (arg.startsWith("--")) {
      out[arg.slice(2)] = argv[++i];
    }
  }
  return out;
}

/**
 * Read V8's optimization status for `fn`, or `null` when unavailable.
 *
 * Built through `new Function` on purpose: this file is shared with the
 * COLD ("no-jit") lane, which runs under `--jitless` WITHOUT
 * `--allow-natives-syntax`. A literal `%GetOptimizationStatus(...)` here
 * would be a parse error in that lane before any guard could run, so the
 * natives syntax only ever materialises lazily, inside a try/catch, in a
 * process that enabled it.
 */
function readOptStatus(fn) {
  try {
    return new Function("f", "return %GetOptimizationStatus(f);")(fn);
  } catch {
    return null; // --allow-natives-syntax not enabled: nothing to assert.
  }
}

/**
 * Derive "what does an optimized function look like on THIS V8" empirically,
 * by optimizing a throwaway reference function the exact same way the
 * benchmark factory does and diffing its status before/after.
 *
 * Hardcoding `%GetOptimizationStatus` bit positions does not survive a V8
 * upgrade. The positions shifted by one between Node 22 and Node 26 —
 * `kOptimized` moved 1<<4 -> 1<<3 and `kTurboFanned` 1<<6 -> 1<<5 — so a
 * table written against Node 22 decoded Node 26's perfectly TurboFan-optimized
 * status (41) as "maglev, not optimized" and failed a run that was in fact
 * correctly tiered. Verified directly on both runtimes:
 *
 *   after %OptimizeFunctionOnNextCall   Node 22: bits 0,4,6   Node 26: bits 0,3,5
 *   after %OptimizeMaglevOnNextCall     Node 22: n/a          Node 26: bits 0,3,4
 *
 * Calibrating in-process needs no table and cannot drift: the bits that
 * appear when the reference is optimized ARE the bits that mean "optimized
 * the way we asked for" on whatever V8 is running. Maglev is still rejected,
 * because a Maglev-tiered function lacks the reference's TurboFan bit.
 */
function calibrateOptimizedMask() {
  const reference = () => {
    let s = 0;
    for (let i = 0; i < 1000; i++) s = (s + i) | 0;
    return s;
  };
  try {
    const prepare = new Function("f", "%PrepareFunctionForOptimization(f);");
    const optimize = new Function("f", "%OptimizeFunctionOnNextCall(f);");
    prepare(reference);
    reference();
    const before = readOptStatus(reference);
    optimize(reference);
    reference();
    const after = readOptStatus(reference);
    if (before === null || after === null) return null;
    // Bits gained by optimizing == this V8's "optimized" signature.
    const gained = after & ~before;
    return gained === 0 ? null : gained;
  } catch {
    return null;
  }
}

function describeOptStatus(status, mask) {
  if (status === null) return "unavailable";
  if (!mask) return `${status}`;
  return `${status} (${(status & mask) === mask ? "matches" : "MISSING"} optimized-signature ${mask})`;
}

/**
 * (#3777) Keep a measurement wrapper OUT of the optimizing tiers.
 *
 * `timeIt` is scaffolding, not the subject. Left optimizable, V8 eventually
 * tiers it up and INLINES `fn` into it — and then the hot loop executes as the
 * wrapper's code, not as the code the subject actually has. On Node 26 that
 * turned the warm `loop.ts` JS lane from ~370 us into ~5615 us per call
 * (measured), because Maglev claimed `timeIt` and ran the inlined 1M-iteration
 * body at mid-tier speed while `bench_loop`'s own TurboFan code object sat
 * unused. `%GetOptimizationStatus(fn)` stayed 41 (optimized|turbofanned)
 * throughout, which is exactly why the #3759 tier assertion could not see it:
 * it interrogates the SUBJECT, and the subject was never the problem.
 *
 * Pinning the wrapper is preferable to pinning the engine (`--no-maglev`,
 * #3769): it fixes the mechanism rather than one tier's symptom, needs no
 * startup flag, keeps the JS lane on the same tier configuration a real browser
 * has, and covers the wasm lane and any future tier for free.
 *
 * Best-effort: needs `--allow-natives-syntax`, which the COLD lane does not
 * enable (it runs `--jitless`, where there is no tier to opt out of anyway), so
 * a failure here is silently fine.
 */
function neverOptimize(...fns) {
  try {
    const pin = new Function("f", "%NeverOptimizeFunction(f);");
    for (const fn of fns) pin(fn);
  } catch {
    // no natives syntax (cold lane) — nothing to pin.
  }
}

function calibrate(fn) {
  let iters = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 100) {
    fn();
    iters++;
  }
  return Math.max(10, Math.ceil((iters / 100) * 300));
}

function timeIt(fn, iters) {
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return performance.now() - t0;
}

async function loadJsFn(jsSourcePath, exportName) {
  const source = readFileSync(jsSourcePath, "utf8");
  // The source is a wrapped function body that returns { [exportName]: fn }
  // when invoked. See generate-playground-benchmark-sidebar-no-jit.mjs for the
  // exact wrapping logic.
  const factory = new Function(source);
  const exports = factory();
  const fn = exports?.[exportName];
  if (typeof fn !== "function") throw new Error(`JS export ${exportName} not found`);
  return fn;
}

async function loadWasmFn(wasmPath, importsPath, exportName) {
  const wasmBytes = readFileSync(wasmPath);
  const importsManifest = JSON.parse(readFileSync(importsPath, "utf8"));
  // The runtime helpers bundle is generated alongside the wasm so the child can
  // build imports identically to how the in-process sidebar does it.
  const helpersUrl = pathToFileURL(importsManifest.runtimeHelpersPath).href;
  const { buildImports, instantiateWasm } = await import(helpersUrl);
  const imports = buildImports(importsManifest.imports ?? [], {}, importsManifest.stringPool ?? []);
  const { instance } = await instantiateWasm(wasmBytes, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  const fn = instance.exports?.[exportName];
  if (typeof fn !== "function") throw new Error(`wasm export ${exportName} not found`);
  return fn;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const lane = args.lane;
  const exportName = args.export;
  if (!lane || !exportName) throw new Error("missing --lane / --export");

  const fn =
    lane === "js"
      ? await loadJsFn(args["js-source"], exportName)
      : await loadWasmFn(args.wasm, args.imports, exportName);

  // (#3777) Pin the scaffolding before it is ever called, so no tier-up can
  // fuse the subject into the timer. See `neverOptimize`.
  neverOptimize(timeIt, calibrate);

  // Warmup pass mirrors the in-process sidebar generator to avoid a cold-call
  // outlier dominating the first measured sample.
  for (let i = 0; i < 80; i++) fn();

  const calibrateStart = performance.now();
  const iters = calibrate(fn);
  // Per-call cost implied by calibration, i.e. by a code path that has NOT yet
  // run through `timeIt`. Cross-checked against the measured median below.
  const calibratedUsPerCall = ((performance.now() - calibrateStart) / (iters / 3)) * 1000;
  const warmupRounds = 2;
  const measuredRounds = 9;
  for (let i = 0; i < warmupRounds; i++) timeIt(fn, iters);

  // `--expect-tier=optimized` (warm lane only) turns the harness's central
  // assumption into an assertion. Without it a silently-mis-tiered run still
  // produces a plausible-looking number and publishes it, with no signal that
  // anything is wrong. Sampled BEFORE and AFTER the measured rounds so a
  // mid-measurement deopt is caught, not just a never-optimized start.
  const expectTier = args["expect-tier"];
  const optimizedMask = expectTier ? calibrateOptimizedMask() : null;
  const optStatusBefore = expectTier ? readOptStatus(fn) : null;

  const samplesUs = [];
  for (let i = 0; i < measuredRounds; i++) {
    const us = (timeIt(fn, iters) / iters) * 1000;
    samplesUs.push(us);
  }

  const optStatusAfter = expectTier ? readOptStatus(fn) : null;

  if (expectTier === "optimized" && optStatusBefore !== null && optimizedMask !== null) {
    const isOpt = (s) => (s & optimizedMask) === optimizedMask;
    if (!isOpt(optStatusBefore) || !isOpt(optStatusAfter)) {
      throw new Error(
        `expected '${exportName}' to stay on V8's optimizing tier for the whole ` +
          `measurement, but status was ${describeOptStatus(optStatusBefore, optimizedMask)} before ` +
          `and ${describeOptStatus(optStatusAfter, optimizedMask)} after the measured rounds ` +
          `(reference signature calibrated in-process: ${optimizedMask}). ` +
          `The reported timings would not represent optimized-tier speed.`,
      );
    }
  }

  // (#3777) Cross-check the measured median against calibration.
  //
  // The tier assertion above interrogates the SUBJECT, so it is blind to a
  // wrapper-side artifact: on Node 26 the subject reported `optimized` for the
  // entire run while the measured rounds were 15x slower than calibration had
  // just observed. Calibration is an INDEPENDENT measurement path — it calls
  // `fn` directly, never through `timeIt` — so disagreement between the two is
  // evidence that something about the measurement changed, whatever the cause
  // (a new tier, a different inlining decision, a deopt the mask cannot see).
  //
  // Threshold is deliberately loose: CI runners are noisy and calibration is a
  // shorter sample, so ordinary variance runs well under 2x. 4x catches the
  // 15x class without flagging drift. Skipped when `iters` hit its floor of 10,
  // where the clamp breaks the implied-per-call arithmetic.
  const measuredMedianUs = [...samplesUs].sort((a, b) => a - b)[Math.floor(samplesUs.length / 2)];
  const driftRatio = calibratedUsPerCall > 0 ? measuredMedianUs / calibratedUsPerCall : 1;
  if (iters > 10 && driftRatio > 4) {
    throw new Error(
      `measurement instability for '${exportName}': calibration implied ` +
        `~${calibratedUsPerCall.toFixed(1)}us/call but the measured median is ` +
        `${measuredMedianUs.toFixed(1)}us/call (${driftRatio.toFixed(1)}x). Calibration calls the ` +
        `subject directly while the measured rounds go through 'timeIt', so a gap this large means ` +
        `the timing wrapper is affecting what is being measured (see #3777) — not that the subject ` +
        `is slow. The reported timings would not represent the subject's speed.`,
    );
  }

  process.stdout.write(
    JSON.stringify({
      samplesUs,
      iters,
      calibratedUsPerCall,
      driftRatio,
      ...(expectTier
        ? {
            optimizedMask,
            optStatusBefore: describeOptStatus(optStatusBefore, optimizedMask),
            optStatusAfter: describeOptStatus(optStatusAfter, optimizedMask),
          }
        : {}),
    }) + "\n",
  );
}

main().catch((err) => {
  process.stderr.write(`${err.stack || err.message || err}\n`);
  process.exit(1);
});
