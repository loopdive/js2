// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #4118 — range-proven array index arithmetic stays in i32.
 *
 * The published matrix benchmark indexes flat arrays with `i * N + k` and
 * `k * N + j`. Its loop counters and immutable `N` are statically bounded, but
 * the generic numeric binary path used to emit f64 conversions, arithmetic,
 * and an i32 truncation for every element read. These tests pin both sides of
 * the proof boundary: the benchmark shape uses direct i32 address arithmetic,
 * while an expression whose range exceeds int32 retains the generic f64 path.
 */
import { describe, expect, it } from "vitest";

import { mixedBenchmarks } from "../benchmarks/suites/mixed.js";
import { compile } from "../src/index.js";
import { buildImports, instantiateWasm } from "../src/runtime.js";

type Lane = "host-call" | "gc-native" | "linear-memory";

const MATRIX = mixedBenchmarks.find((benchmark) => benchmark.name === "mixed/matrix-multiply")!;

function emittedFunctionWat(wat: string, functionName: string): string {
  const start = wat.indexOf(`(func $${functionName}`);
  if (start < 0) throw new Error(`function ${functionName} not found`);
  const end = wat.indexOf("\n  (func ", start + 1);
  return wat.slice(start, end < 0 ? undefined : end);
}

async function compileLane(source: string, lane: Lane, emitWat = false) {
  const options =
    lane === "host-call"
      ? ({ fast: false } as const)
      : lane === "gc-native"
        ? ({ fast: true } as const)
        : ({ fast: true, target: "linear" } as const);
  const result = await compile(source, { ...options, emitWat, optimize: 4, fileName: "issue-4118-matrix.ts" });
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
  return result;
}

async function runLane(source: string, lane: Lane): Promise<{ value: number; wat: string }> {
  const result = await compileLane(source, lane, true);
  const imports = buildImports(result.imports, {}, result.stringPool);
  const { instance } = await instantiateWasm(result.binary, imports.env, imports.string_constants);
  imports.setInstance?.(instance);
  const run = (instance.exports as Record<string, unknown>).run;
  expect(typeof run).toBe("function");
  return { value: (run as () => number)(), wat: result.wat ?? "" };
}

describe("#4118 range-proven array index arithmetic", () => {
  it("keeps the published matrix indices in i32 and agrees in every lane", { timeout: 30_000 }, async () => {
    const expected = MATRIX.js() as number;
    const results = await Promise.all(
      (["host-call", "gc-native", "linear-memory"] as const).map((lane) => runLane(MATRIX.source, lane)),
    );

    expect(results.map(({ value }) => value)).toEqual([expected, expected, expected]);

    for (const { wat } of results.slice(0, 2)) {
      const runWat = emittedFunctionWat(wat, "run");
      // Positive controls: the matrix multiply and both array reads remain.
      expect((runWat.match(/\barray\.get\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
      expect((runWat.match(/\bf64\.mul\b/g) ?? []).length).toBe(1);
      // Three flat indices: a[i*N+k], b[k*N+j], and c[i*N+j].
      expect((runWat.match(/\bi32\.mul\b/g) ?? []).length).toBeGreaterThanOrEqual(3);
    }
  });

  it("falls back when the proven index range exceeds int32", async () => {
    const source = `
export function run(): number {
  const a: number[] = [];
  for (let i = 2147483646; i < 2147483648; i = i + 1) {
    return a[i * 2];
  }
  return 0;
}`;
    const result = await compileLane(source, "host-call", true);
    const runWat = emittedFunctionWat(result.wat ?? "", "run");
    expect(runWat).toContain("f64.mul");
    expect(runWat).toContain("i32.trunc_sat_f64_s");
  });
});
