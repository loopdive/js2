// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import {
  failedPerfLane,
  measureJsHostPerf,
  measureStandalonePerf,
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
    });
    expect(rows.some((row: { path: string }) => row.path.endsWith("#standalone"))).toBe(false);
  });
});
