// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

export const BENCHMARK_SAMPLE_TARGET_MS = 5;
export const BENCHMARK_MAX_BATCH_SIZE = 4096;

export function nextBenchmarkBatchSize(
  elapsedMs: number,
  calls: number,
  targetMs = BENCHMARK_SAMPLE_TARGET_MS,
  maxBatchSize = BENCHMARK_MAX_BATCH_SIZE,
): number {
  if (elapsedMs >= targetMs || calls >= maxBatchSize) return calls;
  const scaled = elapsedMs > 0 ? Math.ceil((calls * targetMs) / elapsedMs) : calls * 2;
  return Math.min(maxBatchSize, Math.max(calls + 1, scaled));
}

/**
 * Sink for benchmark return values (#3898).
 *
 * On its own this does NOT stop a JIT from collapsing a loop — the measured
 * evidence in #3898 is that consuming the accumulator changed nothing, because
 * the real culprit was loop-invariant code motion inside the benchmark bodies.
 * It is still kept so the weaker dead-code-elimination risk is off the table
 * and so the harness has a value to cross-check between lanes.
 */
export const benchmarkSink: { value: unknown } = { value: undefined };

export function timeBenchmarkBatch(fn: () => unknown, calls: number): number {
  let sink: unknown;
  const started = performance.now();
  for (let call = 0; call < calls; call++) sink = fn();
  const elapsed = performance.now() - started;
  benchmarkSink.value = sink;
  return elapsed;
}

export function calibrateBenchmarkBatchSize(fn: () => unknown): number {
  let calls = 1;
  for (let attempt = 0; attempt < 8; attempt++) {
    // A single first probe can itself be preempted. Use the fastest of three
    // one-call probes so scheduler delay cannot incorrectly disable batching.
    const probes = calls === 1 ? 3 : 1;
    let elapsedMs = Number.POSITIVE_INFINITY;
    for (let probe = 0; probe < probes; probe++) {
      elapsedMs = Math.min(elapsedMs, timeBenchmarkBatch(fn, calls));
    }
    const next = nextBenchmarkBatchSize(elapsedMs, calls);
    if (next === calls) return calls;
    calls = next;
  }
  return calls;
}
