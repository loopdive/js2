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

function measuredResult(sampleOp, placement, inputMode, iterations, wasmSamplesUs, nodeSamplesUs, config) {
  const wasmUs = median(wasmSamplesUs);
  const nodeUs = median(nodeSamplesUs);
  const ratioSamples = wasmSamplesUs.map(
    (wasmSample, index) => (nodeSamplesUs[index] ?? nodeUs) / Math.max(wasmSample, 0.000001),
  );
  return {
    status: "measured",
    placement,
    inputMode,
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
  return measuredResult(
    sampleOp,
    "js-host",
    options.inputMode ?? inputModeForPlacement("js-host"),
    iterations,
    wasmSamplesUs,
    nodeSamplesUs,
    config,
  );
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
  return measuredResult(
    sampleOp,
    "standalone",
    options.inputMode ?? inputModeForPlacement("standalone"),
    iterations,
    wasmSamplesUs,
    nodeSamplesUs,
    config,
  );
}

export function skippedPerfLane(placement, inputMode = inputModeForPlacement(placement)) {
  return {
    status: "skipped",
    placement,
    inputMode,
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

const O4_TRY_TABLE_FLATTEN_OMISSION =
  "wasm-opt -O4 omitted Binaryen's unsupported flatten pass for standardized try_table output; all remaining O4 passes completed.";

function wasmOptWarnings(result) {
  return (result?.errors ?? []).filter(
    (entry) => entry?.severity === "warning" && /\bwasm-opt\b/i.test(String(entry.message ?? "")),
  );
}

function isVerifiedO4FlattenOmission(warning, optimizationLevel) {
  return optimizationLevel === 4 && String(warning.message ?? "") === O4_TRY_TABLE_FLATTEN_OMISSION;
}

export function npmPerfOptimizationOmittedPasses(result, optimizationLevel) {
  return wasmOptWarnings(result).some((warning) => isVerifiedO4FlattenOmission(warning, optimizationLevel))
    ? ["flatten"]
    : [];
}

export function npmPerfOptimizationFailure(result, optimizationLevel) {
  const warning = wasmOptWarnings(result).find(
    (candidate) => !isVerifiedO4FlattenOmission(candidate, optimizationLevel),
  );
  if (!warning) return null;
  return `wasm-opt -O${optimizationLevel} did not produce the measured artifact: ${String(warning.message)}`;
}

export function packagePerfRecord(sampleOp, jsHost, standalone, additionalLanes = {}) {
  const record = {
    sampleOp,
    lanes: { jsHost, standalone, ...additionalLanes },
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
      ["standaloneDynamic", "standalone · runtime dynamic"],
    ]) {
      const lane = pkg.perf.lanes[key];
      if (lane?.status !== "measured") continue;
      const optimizationVerified = lane.optimizationVerified === true;
      rows.push({
        name: `${pkg.name} · ${label}`,
        path: `${pkg.entryFile}#${key}`,
        wasmUs: lane.wasmUs,
        jsUs: lane.nodeUs,
        wasmStdUs: lane.wasmStdUs,
        jsStdUs: lane.nodeStdUs,
        ratioStd: lane.ratioStd ?? 0,
        wasmOptimized: optimizationVerified,
        wasmOptimizeLevel: optimizationVerified ? lane.optimizationLevel : null,
        wasmOmittedPasses: optimizationVerified ? (lane.optimizationOmittedPasses ?? []) : [],
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

function measuredRatio(lane) {
  if (!lane || (lane.status && lane.status !== "measured")) return null;
  const ratio = Number(lane.ratio ?? Number(lane.nodeUs) / Number(lane.wasmUs));
  return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
}

/**
 * Reduce one full npm-compat report to the relative-speed values needed by
 * the per-package history charts. Older reports predate `perf.lanes`; their
 * top-level perf record was the JS-host/runtime-dynamic lane.
 */
export function npmPerfHistoryPoint(packages, generatedAt, sourceRevision = null, optimizationLevels = null) {
  const snapshots = {};
  for (const pkg of packages) {
    const perf = pkg?.perf;
    if (!perf) continue;
    const lanes = perf.lanes ?? { jsHost: perf };
    const jsHostDynamic = measuredRatio(lanes.jsHost);
    const standaloneStatic = measuredRatio(lanes.standalone);
    const standaloneDynamic = measuredRatio(lanes.standaloneDynamic);
    if (jsHostDynamic === null && standaloneStatic === null && standaloneDynamic === null) continue;

    snapshots[pkg.name] = {
      jsHost: {
        ...(jsHostDynamic === null ? {} : { dynamic: jsHostDynamic }),
      },
      standalone: {
        ...(standaloneStatic === null ? {} : { static: standaloneStatic }),
        ...(standaloneDynamic === null ? {} : { dynamic: standaloneDynamic }),
      },
    };
  }

  return {
    generatedAt,
    ...(sourceRevision ? { sourceRevision } : {}),
    ...(optimizationLevels ? { optimizationLevels } : {}),
    packages: snapshots,
  };
}

/**
 * Merge committed and freshly measured history without duplicating a source
 * revision or an unchanged report timestamp. Keeping the artifact keyed by
 * provenance makes repeated local generation idempotent while still
 * preserving every distinct committed measurement.
 *
 * A run's identity is its `generatedAt`. `sourceRevision` is the SECOND key,
 * and it is only ever the commit a run was MEASURED at — that is what makes
 * re-running the generator at an unchanged HEAD idempotent instead of
 * additive. The commit that later RECORDS a measurement into the committed
 * artifact is a different thing and belongs in `recordedIn`; conflating the
 * two silently deletes runs, because a re-read of the committed artifact then
 * re-keys an OLD measurement onto the CURRENT HEAD, where the fresh point
 * promptly matches it and overwrites it. That is not hypothetical: it froze
 * the committed history at 14 runs from 2026-08-08 to 2026-08-11, throwing
 * away every measurement in between (~84 points) while the file kept being
 * rewritten on every refresh, so the artifact looked alive and the charts
 * showed a two-week hole.
 */
export function mergeNpmPerfHistory(history, points) {
  const existing = Array.isArray(history) ? history : (history?.runs ?? []);
  const merged = [];
  for (const point of [...existing, ...points]) {
    if (!point?.generatedAt || !point?.packages) continue;
    const duplicateIndex = merged.findIndex(
      (candidate) =>
        candidate.generatedAt === point.generatedAt ||
        (candidate.sourceRevision && point.sourceRevision && candidate.sourceRevision === point.sourceRevision),
    );
    if (duplicateIndex < 0) {
      merged.push(point);
      continue;
    }
    // Later points win on measurement data, but provenance is fixed when the
    // run is measured: a point that carries no `sourceRevision` (a backfill
    // read out of git) must never erase the one already recorded, and must
    // never invent one of its own.
    const previous = merged[duplicateIndex];
    merged[duplicateIndex] = {
      ...previous,
      ...point,
      ...(previous.sourceRevision && !point.sourceRevision ? { sourceRevision: previous.sourceRevision } : {}),
    };
  }
  return {
    schemaVersion: 1,
    runs: merged.sort((left, right) => new Date(left.generatedAt).getTime() - new Date(right.generatedAt).getTime()),
  };
}
