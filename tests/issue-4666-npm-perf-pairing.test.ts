// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
import { describe, expect, it } from "vitest";

import { measureJsHostPerf, measureStandalonePerf, summarizePairedRatios } from "../scripts/lib/npm-compat-perf.mjs";

const ORDER_TIMING = {
  calibrationMs: 0,
  targetMs: 0,
  prewarmIterations: 0,
  warmupRounds: 0,
  measuredRounds: 4,
};

const BALANCED_ORDER = ["wasm", "node", "node", "wasm", "wasm", "node", "node", "wasm"];

describe("#4666 npm performance pairing", () => {
  it("alternates Wasm-first and Node-first measurement rounds in both placements", () => {
    const hostOrder: string[] = [];
    measureJsHostPerf(
      "order",
      () => hostOrder.push("wasm"),
      () => hostOrder.push("node"),
      ORDER_TIMING,
    );
    expect(hostOrder.slice(-8)).toEqual(BALANCED_ORDER);

    const standaloneOrder: string[] = [];
    measureStandalonePerf(
      "order",
      () => standaloneOrder.push("wasm"),
      () => standaloneOrder.push("node"),
      ORDER_TIMING,
    );
    expect(standaloneOrder.slice(-8)).toEqual(BALANCED_ORDER);
  });

  it("uses the median paired speed ratio rather than dividing unrelated lane medians", () => {
    const summary = summarizePairedRatios([1, 2, 3], [3, 4, 100]);

    expect(summary.ratioSamples).toEqual([3, 2, 100 / 3]);
    expect(summary.ratio).toBe(3);
  });
});
