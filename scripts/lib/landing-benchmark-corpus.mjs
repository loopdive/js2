// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

/**
 * The landing benchmark corpus. These paths point at the only source bytes a
 * lane may consume; wrappers and adapters are separate artifacts. The hashes,
 * sizes, metadata, and Node outputs intentionally fail loud on source drift.
 */
export const LANDING_BENCHMARK_PROGRAMS = Object.freeze([
  Object.freeze({
    id: "fib",
    label: "Fibonacci loop",
    sourcePath: "website/public/benchmarks/competitive/programs/fib.js",
    sha256: "910ab9ef86bf7ed4c6b7e55c0fe20d93b653dd8bfdb5d48de6ef906778943a73",
    bytes: 348,
    functionName: "run",
    sourceParameterName: "n",
    coldArg: 5_000,
    runtimeArg: 20_000_000,
    fixedInputs: Object.freeze([0, 1, 5_000, 20_000_000]),
    expectedFixedOutputs: Object.freeze([0, 1, -1_846_256_875, -1_821_818_939]),
    plainPorfforCliCBytes: 183_170,
  }),
  Object.freeze({
    id: "fib-recursive",
    label: "Fibonacci recursion",
    sourcePath: "website/public/benchmarks/competitive/programs/fib-recursive.js",
    sha256: "f1b64fb81a182f38cf8ebdc8f39bded7e9878d516f714fb046a8a1b15d0ba916",
    bytes: 361,
    functionName: "run",
    sourceParameterName: "n",
    coldArg: 10,
    runtimeArg: 30,
    fixedInputs: Object.freeze([0, 1, 10, 30]),
    expectedFixedOutputs: Object.freeze([0, 1, 55, 832_040]),
    plainPorfforCliCBytes: 183_927,
  }),
  Object.freeze({
    id: "array-sum",
    label: "Array fill + sum",
    sourcePath: "website/public/benchmarks/competitive/programs/array-sum.js",
    sha256: "61affa6e44688788cfdb50f5186078cb55c171f19df2bb104e2dcb9f331cd59c",
    bytes: 441,
    functionName: "run",
    sourceParameterName: "n",
    coldArg: 2_000,
    runtimeArg: 1_000_000,
    fixedInputs: Object.freeze([0, 1, 2_000, 1_000_000]),
    expectedFixedOutputs: Object.freeze([0, 0, 1_018_392, 511_492_320]),
    plainPorfforCliCBytes: 212_612,
  }),
  Object.freeze({
    id: "string-hash",
    label: "String build + hash",
    sourcePath: "website/public/benchmarks/competitive/programs/string-hash.js",
    sha256: "66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c",
    bytes: 601,
    functionName: "run",
    sourceParameterName: "n",
    coldArg: 100,
    runtimeArg: 20_000,
    fixedInputs: Object.freeze([0, 1, 100, 20_000]),
    expectedFixedOutputs: Object.freeze([0, 96_500, 36_729_899, 862_771_296]),
    plainPorfforCliCBytes: 188_870,
  }),
]);

export const LANDING_BENCHMARK_PROGRAM_IDS = Object.freeze(LANDING_BENCHMARK_PROGRAMS.map((program) => program.id));

export function landingBenchmarkProgram(id) {
  const program = LANDING_BENCHMARK_PROGRAMS.find((candidate) => candidate.id === id);
  if (!program) throw new Error(`unknown landing benchmark program ${id}`);
  return program;
}
