import { performance } from "node:perf_hooks";

export const PERF_WARMUP_ROUNDS = 2;
export const PERF_MEASURED_ROUNDS = 9;

function timeIt(fn, iterations) {
  const started = performance.now();
  for (let index = 0; index < iterations; index++) fn();
  return performance.now() - started;
}

function calibrate(fn, calibrationMs, targetMs) {
  let iterations = 0;
  const started = performance.now();
  let elapsed = 0;
  do {
    fn();
    iterations++;
    elapsed = performance.now() - started;
  } while (elapsed < calibrationMs);
  return Math.max(1, Math.ceil((iterations / Math.max(elapsed, 0.001)) * targetMs));
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function stddev(values) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function timingConfig(options) {
  return {
    calibrationMs: options.calibrationMs ?? 100,
    targetMs: options.targetMs ?? 300,
    prewarmIterations: options.prewarmIterations ?? 20,
    warmupRounds: options.warmupRounds ?? PERF_WARMUP_ROUNDS,
    measuredRounds: options.measuredRounds ?? PERF_MEASURED_ROUNDS,
  };
}

function inputModeForPlacement(placement) {
  return placement === "standalone" ? "compile-time-static" : "runtime-dynamic";
}

function measuredResult(sampleOp, placement, iterations, wasmSamplesUs, nodeSamplesUs, config) {
  const wasmUs = median(wasmSamplesUs);
  const nodeUs = median(nodeSamplesUs);
  const ratioSamples = wasmSamplesUs.map(
    (wasmSample, index) => (nodeSamplesUs[index] ?? nodeUs) / Math.max(wasmSample, 0.000001),
  );
  return {
    status: "measured",
    placement,
    inputMode: inputModeForPlacement(placement),
    sampleOp,
    wasmUs,
    nodeUs,
    wasmStdUs: stddev(wasmSamplesUs),
    nodeStdUs: stddev(nodeSamplesUs),
    ratio: nodeUs / Math.max(wasmUs, 0.000001),
    ratioStd: stddev(ratioSamples),
    iters: iterations,
    warmupRounds: config.warmupRounds,
    measuredRounds: config.measuredRounds,
    wasmSamplesUs,
    nodeSamplesUs,
  };
}

/**
 * The JavaScript host owns both repeated-call loops. Each closure performs one
 * package operation and consumes its result.
 */
export function measureJsHostPerf(sampleOp, wasmOperation, nodeOperation, options = {}) {
  const config = timingConfig(options);
  for (let index = 0; index < config.prewarmIterations; index++) {
    wasmOperation();
    nodeOperation();
  }
  const iterations = Math.min(
    calibrate(wasmOperation, config.calibrationMs, config.targetMs),
    calibrate(nodeOperation, config.calibrationMs, config.targetMs),
  );
  for (let round = 0; round < config.warmupRounds; round++) {
    timeIt(wasmOperation, iterations);
    timeIt(nodeOperation, iterations);
  }
  const wasmSamplesUs = [];
  const nodeSamplesUs = [];
  for (let round = 0; round < config.measuredRounds; round++) {
    wasmSamplesUs.push((timeIt(wasmOperation, iterations) / iterations) * 1000);
    nodeSamplesUs.push((timeIt(nodeOperation, iterations) / iterations) * 1000);
  }
  return measuredResult(sampleOp, "js-host", iterations, wasmSamplesUs, nodeSamplesUs, config);
}

/**
 * Wasm and Node each own the same repeated-call loop through their respective
 * batch functions. Both samples are divided by the same operation count. This
 * gives both optimizers the same loop scope; timing Node through `timeIt` would
 * hide its loop behind a callback while Wasm could optimize across its loop.
 */
export function measureStandalonePerf(sampleOp, wasmBatch, nodeBatch, options = {}) {
  const config = timingConfig(options);
  wasmBatch(1);
  nodeBatch(1);
  const iterations = Math.min(
    calibrate(() => wasmBatch(1), config.calibrationMs, config.targetMs),
    calibrate(() => nodeBatch(1), config.calibrationMs, config.targetMs),
  );
  for (let round = 0; round < config.warmupRounds; round++) {
    wasmBatch(iterations);
    nodeBatch(iterations);
  }
  const wasmSamplesUs = [];
  const nodeSamplesUs = [];
  for (let round = 0; round < config.measuredRounds; round++) {
    const wasmStarted = performance.now();
    wasmBatch(iterations);
    wasmSamplesUs.push(((performance.now() - wasmStarted) / iterations) * 1000);
    const nodeStarted = performance.now();
    nodeBatch(iterations);
    nodeSamplesUs.push(((performance.now() - nodeStarted) / iterations) * 1000);
  }
  return measuredResult(sampleOp, "standalone", iterations, wasmSamplesUs, nodeSamplesUs, config);
}

export function skippedPerfLane(placement) {
  return {
    status: "skipped",
    placement,
    inputMode: inputModeForPlacement(placement),
    reason: "lane not selected",
  };
}

export function failedPerfLane(placement, status, diagnostic, extra = {}) {
  return {
    status,
    placement,
    inputMode: inputModeForPlacement(placement),
    diagnostic: diagnostic || "unknown failure",
    ...extra,
  };
}

export function packagePerfRecord(sampleOp, jsHost, standalone) {
  const record = {
    sampleOp,
    lanes: { jsHost, standalone },
  };
  // Transitional aliases keep older npm-compat consumers rendering the
  // JS-host lane while the committed JSON and website move to `lanes`.
  if (jsHost?.status === "measured") {
    for (const key of [
      "wasmUs",
      "nodeUs",
      "wasmStdUs",
      "nodeStdUs",
      "ratio",
      "ratioStd",
      "iters",
      "warmupRounds",
      "measuredRounds",
      "wasmSamplesUs",
      "nodeSamplesUs",
    ]) {
      record[key] = jsHost[key];
    }
  }
  return record;
}

export function npmPerfRows(packages) {
  const rows = [];
  for (const pkg of packages) {
    if (!pkg.perf?.lanes) continue;
    for (const [key, label] of [
      ["jsHost", "JS host · runtime dynamic"],
      ["standalone", "standalone · compile-time static"],
    ]) {
      const lane = pkg.perf.lanes[key];
      if (lane?.status !== "measured") continue;
      rows.push({
        name: `${pkg.name} · ${label}`,
        path: `${pkg.entryFile}#${key}`,
        wasmUs: lane.wasmUs,
        jsUs: lane.nodeUs,
        wasmStdUs: lane.wasmStdUs,
        jsStdUs: lane.nodeStdUs,
        ratioStd: lane.ratioStd ?? 0,
        wasmOptimized: true,
        wasmOptimizeLevel: 4,
        warmupRounds: lane.warmupRounds,
        measuredRounds: lane.measuredRounds,
        sampleOp: lane.sampleOp,
        harnessPlacement: lane.placement,
        inputMode: lane.inputMode,
      });
    }
  }
  return rows;
}
