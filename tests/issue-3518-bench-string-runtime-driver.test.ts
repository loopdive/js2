// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import {
  assertLoadGate,
  assertProtocolRounds,
  bootstrapMedian95,
  roundLaunches,
  runtimeVerdict,
} from "../scripts/measure/bench-string-ir-runtime.mjs";

describe("#3518 bench_string durable runtime protocol", () => {
  it("keeps fresh sample workers independent of tsx and compiler/runtime setup", () => {
    const worker = readFileSync(
      new URL("../scripts/measure/bench-string-ir-runtime-worker.mjs", import.meta.url),
      "utf8",
    );
    expect(worker).not.toMatch(/\btsx\b|src\/index|src\/runtime|buildImports/);
    expect(worker).toMatch(/currentLoad\(\)/);
    expect(worker).toMatch(/benchmark unexpectedly called host import/);
  });

  it("brackets each candidate pair with direct controls and alternates exact ABBA order", () => {
    expect(assertProtocolRounds(30)).toBe(30);
    expect(() => assertProtocolRounds(31)).toThrow(/even safe integer/);
    expect(roundLaunches(0)).toEqual([
      { role: "control-before", lane: "direct" },
      { role: "candidate", lane: "direct" },
      { role: "candidate", lane: "prepared" },
      { role: "control-after", lane: "direct" },
    ]);
    expect(roundLaunches(1)).toEqual([
      { role: "control-before", lane: "direct" },
      { role: "candidate", lane: "prepared" },
      { role: "candidate", lane: "direct" },
      { role: "control-after", lane: "direct" },
    ]);
    const candidateOrder = [0, 1]
      .flatMap((round) => roundLaunches(round))
      .filter(({ role }) => role === "candidate")
      .map(({ lane }) => lane);
    expect(candidateOrder).toEqual(["direct", "prepared", "prepared", "direct"]);
  });

  it("requires a finite nonnegative load strictly below logical cores minus two", () => {
    expect(assertLoadGate(5.99, 8)).toEqual({ oneMinute: 5.99, logicalCores: 8, threshold: 6 });
    for (const [load, cores] of [
      [6, 8],
      [8, 8],
      [-0.1, 8],
      [Number.NaN, 8],
      [0, 2],
    ] as const) {
      expect(() => assertLoadGate(load, cores)).toThrow();
    }
  });

  it("publishes a deterministic 95% bootstrap interval for the paired median", () => {
    const interval = bootstrapMedian95(
      Array.from({ length: 30 }, () => 1.01),
      2_000,
      3518,
    );
    expect(interval).toEqual({ lower: 1.01, upper: 1.01, confidence: 0.95, iterations: 2_000, seed: 3518 });
    expect(() => bootstrapMedian95(Array(30).fill(1), 999, 3518)).toThrow(/at least 1000/);
  });

  it("passes only with 30 valid samples and all three regression bounds", () => {
    const verdict = runtimeVerdict(
      Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? 0.99 : 1.01)),
      Array.from({ length: 30 }, (_, index) => (index % 2 === 0 ? 1.01 : 1.03)),
      2_000,
      3518,
    );
    expect(verdict).toMatchObject({
      pass: true,
      failures: [],
      medianDirectDirectRatio: 1,
      directDirectDeviation: 0,
      medianPreparedDirectRatio: 1.02,
    });
    expect(verdict.preparedDirectBootstrap95.upper).toBeLessThanOrEqual(1.1);
    expect(() => runtimeVerdict(Array(29).fill(1), Array(30).fill(1), 100, 1)).toThrow(/at least 30/);
    expect(() => runtimeVerdict(Array(30).fill(1), [...Array(29).fill(1), Number.NaN], 100, 1)).toThrow(
      /finite and positive/,
    );
  });

  it("fails closed on direct drift, candidate median, or bootstrap uncertainty", () => {
    const directDrift = runtimeVerdict(Array(30).fill(1.051), Array(30).fill(1), 2_000, 3518);
    expect(directDrift.pass).toBe(false);
    expect(directDrift.failures.join("\n")).toMatch(/direct\/direct median deviation/);

    const candidateMedian = runtimeVerdict(Array(30).fill(1), Array(30).fill(1.051), 2_000, 3518);
    expect(candidateMedian.pass).toBe(false);
    expect(candidateMedian.failures.join("\n")).toMatch(/Prepared\/direct median/);

    const uncertain = runtimeVerdict(Array(30).fill(1), [...Array(16).fill(1), ...Array(14).fill(1.3)], 5_000, 3518);
    expect(uncertain.medianPreparedDirectRatio).toBeLessThanOrEqual(1.05);
    expect(uncertain.preparedDirectBootstrap95.upper).toBeGreaterThan(1.1);
    expect(uncertain.pass).toBe(false);
    expect(uncertain.failures.join("\n")).toMatch(/bootstrap upper/);
  });
});
