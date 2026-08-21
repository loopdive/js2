// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import {
  failedPerfLane,
  measureJsHostPerf,
  measureStandalonePerf,
  mergeNpmPerfHistory,
  npmPerfHistoryPoint,
  npmPerfOptimizationFailure,
  npmPerfOptimizationOmittedPasses,
  npmPerfRows,
  packagePerfRecord,
} from "../scripts/lib/npm-compat-perf.mjs";

const FAST_TIMING = {
  calibrationMs: 1,
  targetMs: 2,
  prewarmIterations: 1,
  warmupRounds: 0,
  measuredRounds: 3,
};

describe("#3781 npm performance harness placement", () => {
  it("measures a host-owned loop as the JS-host lane", () => {
    let wasmCalls = 0;
    let nodeCalls = 0;
    const result = measureJsHostPerf(
      "increment",
      () => ++wasmCalls,
      () => ++nodeCalls,
      FAST_TIMING,
    );

    expect(result.status).toBe("measured");
    expect(result.placement).toBe("js-host");
    expect(result.inputMode).toBe("runtime-dynamic");
    expect(result.measuredRounds).toBe(3);
    expect(result.wasmSamplesUs).toHaveLength(3);
    expect(result.nodeSamplesUs).toHaveLength(3);
    expect(wasmCalls).toBeGreaterThan(result.iters);
    expect(nodeCalls).toBeGreaterThan(result.iters);
  });

  it("gives Wasm and Node the same batched loop scope and divides by its operation count", () => {
    const wasmBatchSizes: number[] = [];
    const nodeBatchSizes: number[] = [];
    const result = measureStandalonePerf(
      "increment",
      (iterations: number) => {
        wasmBatchSizes.push(iterations);
        return iterations;
      },
      (iterations: number) => {
        nodeBatchSizes.push(iterations);
        return iterations;
      },
      FAST_TIMING,
    );

    expect(result.status).toBe("measured");
    expect(result.placement).toBe("standalone");
    expect(result.inputMode).toBe("compile-time-static");
    expect(result.measuredRounds).toBe(3);
    expect(result.wasmSamplesUs).toHaveLength(3);
    expect(wasmBatchSizes.filter((size) => size === result.iters)).toHaveLength(3);
    expect(nodeBatchSizes.filter((size) => size === result.iters)).toHaveLength(3);
  });

  it("reports a standalone runtime input separately from a compile-time-static standalone input", () => {
    const result = measureStandalonePerf(
      "runtime-selected increment",
      (iterations) => iterations,
      (iterations) => iterations,
      {
        ...FAST_TIMING,
        inputMode: "runtime-dynamic",
      },
    );

    expect(result.placement).toBe("standalone");
    expect(result.inputMode).toBe("runtime-dynamic");
  });

  it("keeps both placements in package JSON and excludes failures from chart rows", () => {
    const jsHost = {
      status: "measured",
      placement: "js-host",
      inputMode: "runtime-dynamic",
      sampleOp: "op",
      wasmUs: 2,
      nodeUs: 1,
      wasmStdUs: 0.1,
      nodeStdUs: 0.1,
      ratio: 0.5,
      ratioStd: 0.01,
      iters: 10,
      warmupRounds: 2,
      measuredRounds: 9,
      wasmSamplesUs: [2],
      nodeSamplesUs: [1],
      optimizationLevel: 4,
      optimizationVerified: true,
    };
    const standalone = failedPerfLane("standalone", "compile-error", "unsupported operation");
    const perf = packagePerfRecord("op", jsHost, standalone);
    const rows = npmPerfRows([{ name: "pkg", entryFile: "index.js", perf }]);

    expect(perf.lanes).toEqual({ jsHost, standalone });
    expect(perf.wasmUs).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "pkg · JS host · runtime dynamic",
      path: "index.js#jsHost",
      harnessPlacement: "js-host",
      inputMode: "runtime-dynamic",
      wasmOptimized: true,
      wasmOptimizeLevel: 4,
    });
    expect(rows.some((row: { path: string }) => row.path.endsWith("#standalone"))).toBe(false);
  });

  it("emits a distinct chart row for standalone runtime-dynamic work", () => {
    const measured = {
      status: "measured",
      placement: "standalone",
      inputMode: "runtime-dynamic",
      sampleOp: "op",
      wasmUs: 2,
      nodeUs: 1,
      wasmStdUs: 0.1,
      nodeStdUs: 0.1,
      ratio: 0.5,
      ratioStd: 0.01,
      iters: 10,
      warmupRounds: 2,
      measuredRounds: 9,
      wasmSamplesUs: [2],
      nodeSamplesUs: [1],
      optimizationLevel: 4,
      optimizationVerified: true,
      optimizationOmittedPasses: ["flatten"],
    };
    const perf = packagePerfRecord(
      "op",
      failedPerfLane("js-host", "compile-error", "not run"),
      failedPerfLane("standalone", "compile-error", "not run"),
      { standaloneDynamic: measured },
    );
    const rows = npmPerfRows([{ name: "pkg", entryFile: "index.js", perf }]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: "pkg · standalone · runtime dynamic",
      path: "index.js#standaloneDynamic",
      harnessPlacement: "standalone",
      inputMode: "runtime-dynamic",
      wasmOptimized: true,
      wasmOptimizeLevel: 4,
      wasmOmittedPasses: ["flatten"],
    });
  });

  it("does not claim optimization without a verified compiler receipt", () => {
    const lane = {
      status: "measured",
      placement: "standalone",
      inputMode: "runtime-dynamic",
      sampleOp: "op",
      wasmUs: 2,
      nodeUs: 1,
      wasmStdUs: 0.1,
      nodeStdUs: 0.1,
      ratioStd: 0.01,
      warmupRounds: 2,
      measuredRounds: 9,
      optimizationLevel: 3,
    };
    const perf = packagePerfRecord(
      "op",
      failedPerfLane("js-host", "compile-error", "not run"),
      failedPerfLane("standalone", "compile-error", "not run"),
      { standaloneDynamic: lane },
    );

    expect(npmPerfRows([{ name: "pkg", entryFile: "index.js", perf }])[0]).toMatchObject({
      wasmOptimized: false,
      wasmOptimizeLevel: null,
    });
  });

  it("turns a compiler optimizer warning into a failed measurement diagnostic", () => {
    expect(
      npmPerfOptimizationFailure(
        {
          errors: [
            {
              severity: "warning",
              message: "wasm-opt -O3 failed: Flatten cannot process try_table",
            },
          ],
        },
        3,
      ),
    ).toContain("did not produce the measured artifact");
    expect(npmPerfOptimizationFailure({ errors: [] }, 3)).toBeNull();
  });

  it("accepts and records only the verified O4 try_table Flatten omission", () => {
    const result = {
      errors: [
        {
          severity: "warning",
          message:
            "wasm-opt -O4 omitted Binaryen's unsupported flatten pass for standardized try_table output; all remaining O4 passes completed.",
        },
      ],
    };

    expect(npmPerfOptimizationFailure(result, 4)).toBeNull();
    expect(npmPerfOptimizationOmittedPasses(result, 4)).toEqual(["flatten"]);
    expect(npmPerfOptimizationFailure(result, 3)).toContain("did not produce the measured artifact");
    expect(npmPerfOptimizationOmittedPasses(result, 3)).toEqual([]);
  });

  it("records static and dynamic history as separate scenarios", () => {
    const measured = (ratio: number, placement: string, inputMode: string) => ({
      status: "measured",
      placement,
      inputMode,
      ratio,
      wasmUs: 1 / ratio,
      nodeUs: 1,
    });
    const point = npmPerfHistoryPoint(
      [
        {
          name: "pkg",
          perf: {
            lanes: {
              jsHost: measured(0.5, "js-host", "runtime-dynamic"),
              standalone: measured(20, "standalone", "compile-time-static"),
              standaloneDynamic: measured(0.8, "standalone", "runtime-dynamic"),
            },
          },
        },
      ],
      "2026-07-30T00:00:00.000Z",
      "abc123",
      { "js-host": 4, standalone: 3 },
    );

    expect(point).toEqual({
      generatedAt: "2026-07-30T00:00:00.000Z",
      sourceRevision: "abc123",
      optimizationLevels: { "js-host": 4, standalone: 3 },
      packages: {
        pkg: {
          jsHost: { dynamic: 0.5 },
          standalone: { static: 20, dynamic: 0.8 },
        },
      },
    });
  });

  it("keeps legacy JS-host reports and replaces repeated revisions", () => {
    const legacy = npmPerfHistoryPoint(
      [{ name: "pkg", perf: { ratio: 0.25, wasmUs: 4, nodeUs: 1 } }],
      "2026-07-28T00:00:00.000Z",
      "same-revision",
    );
    const refreshed = npmPerfHistoryPoint(
      [{ name: "pkg", perf: { ratio: 0.5, wasmUs: 2, nodeUs: 1 } }],
      "2026-07-30T00:00:00.000Z",
      "same-revision",
    );
    const duplicateTimestamp = { ...refreshed, sourceRevision: "later-wrapper-commit" };
    const history = mergeNpmPerfHistory({ schemaVersion: 1, runs: [legacy] }, [refreshed, duplicateTimestamp]);

    expect(history.runs).toHaveLength(1);
    expect(history.runs[0].packages.pkg.jsHost.dynamic).toBe(0.5);
    expect(history.runs[0].sourceRevision).toBe("later-wrapper-commit");
  });
});
