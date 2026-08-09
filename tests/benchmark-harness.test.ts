// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { BENCHMARK_MAX_BATCH_SIZE, BENCHMARK_SAMPLE_TARGET_MS, nextBenchmarkBatchSize } from "../benchmarks/timing.js";

const ROOT = resolve(import.meta.dirname, "..");

describe("internal benchmark batching", () => {
  it("scales sub-millisecond calls to a scheduler-sized sample", () => {
    expect(nextBenchmarkBatchSize(0.01, 1)).toBe(500);
    expect(nextBenchmarkBatchSize(BENCHMARK_SAMPLE_TARGET_MS, 500)).toBe(500);
  });

  it("makes progress for zero-duration probes and clamps pathological batches", () => {
    expect(nextBenchmarkBatchSize(0, 1)).toBe(2);
    expect(nextBenchmarkBatchSize(0.000001, 1)).toBe(BENCHMARK_MAX_BATCH_SIZE);
    expect(nextBenchmarkBatchSize(1, BENCHMARK_MAX_BATCH_SIZE)).toBe(BENCHMARK_MAX_BATCH_SIZE);
  });

  it.skipIf(Number(process.versions.node.split(".")[0]) < 22)(
    "keeps the Pages generator timing import resolvable by native type stripping",
    () => {
      const generatorPath = resolve(ROOT, "scripts", "generate-size-benchmarks.ts");
      const generatorSource = readFileSync(generatorPath, "utf8");
      const timingImport = generatorSource.match(/from "(\.\.\/benchmarks\/timing\.[^"]+)"/)?.[1];

      expect(timingImport).toBe("../benchmarks/timing.ts");

      const timingUrl = new URL(timingImport!, pathToFileURL(generatorPath));
      expect(() =>
        execFileSync(
          process.execPath,
          [
            "--experimental-strip-types",
            "--input-type=module",
            "--eval",
            `const timing = await import(${JSON.stringify(timingUrl.href)}); if (typeof timing.calibrateBenchmarkBatchSize !== "function") process.exit(1);`,
          ],
          { stdio: "pipe" },
        ),
      ).not.toThrow();
    },
  );
});
