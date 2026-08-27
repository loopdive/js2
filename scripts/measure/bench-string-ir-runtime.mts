// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { cpus, loadavg, platform, arch, tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compileProject, type CompileResult } from "../../src/index.js";

export type BenchStringLane = "direct" | "prepared";
export type LaunchRole = "control-before" | "candidate" | "control-after";

export interface LoadObservation {
  readonly oneMinute: number;
  readonly logicalCores: number;
  readonly threshold: number;
}

export interface RoundLaunch {
  readonly role: LaunchRole;
  readonly lane: BenchStringLane;
}

export interface BootstrapInterval {
  readonly lower: number;
  readonly upper: number;
  readonly confidence: 0.95;
  readonly iterations: number;
  readonly seed: number;
}

export interface RuntimeVerdict {
  readonly pass: boolean;
  readonly failures: readonly string[];
  readonly medianDirectDirectRatio: number;
  readonly directDirectDeviation: number;
  readonly medianPreparedDirectRatio: number;
  readonly preparedDirectBootstrap95: BootstrapInterval;
  readonly thresholds: {
    readonly minimumSamplesPerArm: 30;
    readonly maximumDirectDirectDeviation: 0.05;
    readonly maximumPreparedDirectMedian: 1.05;
    readonly maximumPreparedDirectBootstrapUpper: 1.1;
  };
}

interface ArtifactManifest {
  readonly lane: BenchStringLane;
  readonly binaryPath: string;
  readonly binaryBytes: number;
  readonly sha256: string;
}

interface ArtifactSummary {
  readonly lane: BenchStringLane;
  readonly binaryBytes: number;
  readonly sha256: string;
  readonly imports: readonly WebAssembly.ModuleImportDescriptor[];
  readonly exports: readonly WebAssembly.ModuleExportDescriptor[];
}

interface SampleResult {
  readonly lane: BenchStringLane;
  readonly nsPerCall: number;
  readonly calls: number;
  readonly warmupCalls: number;
  readonly checksum: number;
  readonly load: LoadObservation;
  readonly rssBytes: number;
  readonly heapUsedBytes: number;
}

interface LaunchRecord extends RoundLaunch {
  readonly sequence: number;
  readonly round: number;
  readonly result: SampleResult;
}

interface WorkerFailure {
  readonly kind: "load-gate" | "worker";
  readonly message: string;
  readonly load?: LoadObservation;
}

type WorkerEnvelope =
  | { readonly ok: true; readonly result: SampleResult }
  | { readonly ok: false; readonly error: WorkerFailure };

interface RuntimeReport {
  readonly schemaVersion: 2;
  readonly status: "passed" | "failed" | "aborted";
  readonly generatedAt: string;
  readonly sourceRevision: string;
  readonly environment: {
    readonly node: string;
    readonly platform: string;
    readonly arch: string;
    readonly v8OldSpaceLimitMb: number;
  };
  readonly protocol: {
    readonly rounds: number;
    readonly samplesPerArm: number;
    readonly directControlSamples: number;
    readonly callsPerSample: number;
    readonly warmupCalls: number;
    readonly schedule: "direct-control / alternating-AB-BA candidate / direct-control";
    readonly freshProcessPerLaunch: true;
    readonly workerModule: "scripts/measure/bench-string-ir-runtime-worker.mjs";
    readonly bootstrapIterations: number;
    readonly bootstrapSeed: number;
  };
  readonly artifacts: readonly ArtifactSummary[];
  readonly launches: readonly LaunchRecord[];
  readonly directDirectRatios: readonly number[];
  readonly preparedDirectRatios: readonly number[];
  readonly verdict?: RuntimeVerdict;
  readonly abort?: WorkerFailure;
}

const ENTRY = fileURLToPath(new URL("../../website/playground/examples/benchmarks/string.ts", import.meta.url));
const WORKER = fileURLToPath(new URL("./bench-string-ir-runtime-worker.mjs", import.meta.url));
const TARGET = "bench_string";
const CUTOVER = "JS2WASM_MULTI_PREPARED_STRING_CUTOVER";
const REQUIRE_ROUTE = "JS2WASM_TEST_REQUIRE_MULTI_PREPARED_STRING_LEAF";
const STRING_BUILDER = "JS2WASM_IR_STRING_BUILDER";
const DEFAULT_ROUNDS = 30;
const DEFAULT_CALLS = 1_000;
const DEFAULT_WARMUP_CALLS = 12;
const DEFAULT_BOOTSTRAP_ITERATIONS = 10_000;
const DEFAULT_BOOTSTRAP_SEED = 0x3518c2d;
const MINIMUM_BOOTSTRAP_ITERATIONS = 1_000;
const V8_OLD_SPACE_LIMIT_MB = 512;

class LoadGateError extends Error {
  constructor(
    message: string,
    readonly observation?: LoadObservation,
  ) {
    super(message);
  }
}

function finitePositive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be finite and positive`);
  return value;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error("median requires at least one value");
  const sorted = values.map((value, index) => finitePositive(value, `sample[${index}]`)).sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

export function assertLoadGate(oneMinute: number, logicalCores: number): LoadObservation {
  if (!Number.isFinite(oneMinute) || oneMinute < 0) {
    throw new LoadGateError(`one-minute load must be finite and nonnegative, received ${oneMinute}`);
  }
  if (!Number.isSafeInteger(logicalCores) || logicalCores < 3) {
    throw new LoadGateError(`logical core count must be a safe integer of at least three, received ${logicalCores}`);
  }
  const observation = { oneMinute, logicalCores, threshold: logicalCores - 2 };
  if (oneMinute >= observation.threshold) {
    throw new LoadGateError(
      `one-minute load ${oneMinute.toFixed(2)} must be strictly below ${observation.threshold} ` +
        `(logical cores ${logicalCores} minus two)`,
      observation,
    );
  }
  return observation;
}

function currentLoad(): LoadObservation {
  return assertLoadGate(loadavg()[0]!, cpus().length);
}

export function roundLaunches(round: number): readonly RoundLaunch[] {
  if (!Number.isSafeInteger(round) || round < 0) throw new Error("round must be a nonnegative safe integer");
  const candidates: readonly BenchStringLane[] = round % 2 === 0 ? ["direct", "prepared"] : ["prepared", "direct"];
  return [
    { role: "control-before", lane: "direct" },
    { role: "candidate", lane: candidates[0]! },
    { role: "candidate", lane: candidates[1]! },
    { role: "control-after", lane: "direct" },
  ];
}

export function assertProtocolRounds(rounds: number): number {
  if (!Number.isSafeInteger(rounds) || rounds < 30 || rounds % 2 !== 0) {
    throw new Error("sample rounds must be an even safe integer of at least 30");
  }
  return rounds;
}

function nextRandom(state: number): number {
  return (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
}

export function bootstrapMedian95(
  values: readonly number[],
  iterations = DEFAULT_BOOTSTRAP_ITERATIONS,
  seed = DEFAULT_BOOTSTRAP_SEED,
): BootstrapInterval {
  if (values.length < 2) throw new Error("bootstrap requires at least two samples");
  const samples = values.map((value, index) => finitePositive(value, `bootstrap sample[${index}]`));
  positiveInteger(iterations, "bootstrap iterations");
  if (iterations < MINIMUM_BOOTSTRAP_ITERATIONS) {
    throw new Error(`bootstrap iterations must be at least ${MINIMUM_BOOTSTRAP_ITERATIONS}`);
  }
  if (!Number.isSafeInteger(seed)) throw new Error("bootstrap seed must be a safe integer");
  let state = seed >>> 0;
  const medians = new Array<number>(iterations);
  const resample = new Array<number>(samples.length);
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let index = 0; index < samples.length; index++) {
      state = nextRandom(state);
      resample[index] = samples[Math.floor((state / 0x1_0000_0000) * samples.length)]!;
    }
    medians[iteration] = median(resample);
  }
  medians.sort((a, b) => a - b);
  return {
    lower: medians[Math.floor((iterations - 1) * 0.025)]!,
    upper: medians[Math.ceil((iterations - 1) * 0.975)]!,
    confidence: 0.95,
    iterations,
    seed,
  };
}

export function runtimeVerdict(
  directDirectRatios: readonly number[],
  preparedDirectRatios: readonly number[],
  bootstrapIterations = DEFAULT_BOOTSTRAP_ITERATIONS,
  bootstrapSeed = DEFAULT_BOOTSTRAP_SEED,
): RuntimeVerdict {
  if (directDirectRatios.length < 30 || preparedDirectRatios.length < 30) {
    throw new Error(
      `runtime verdict requires at least 30 valid ratios per arm; received ` +
        `${directDirectRatios.length} direct/direct and ${preparedDirectRatios.length} Prepared/direct`,
    );
  }
  const medianDirectDirectRatio = median(directDirectRatios);
  const directDirectDeviation = Math.abs(medianDirectDirectRatio - 1);
  const medianPreparedDirectRatio = median(preparedDirectRatios);
  const preparedDirectBootstrap95 = bootstrapMedian95(preparedDirectRatios, bootstrapIterations, bootstrapSeed);
  const failures: string[] = [];
  if (directDirectDeviation > 0.05) {
    failures.push(`direct/direct median deviation ${directDirectDeviation.toFixed(6)} exceeds 0.05`);
  }
  if (medianPreparedDirectRatio > 1.05) {
    failures.push(`Prepared/direct median ${medianPreparedDirectRatio.toFixed(6)} exceeds 1.05`);
  }
  if (preparedDirectBootstrap95.upper > 1.1) {
    failures.push(`Prepared/direct bootstrap upper ${preparedDirectBootstrap95.upper.toFixed(6)} exceeds 1.10`);
  }
  return {
    pass: failures.length === 0,
    failures,
    medianDirectDirectRatio,
    directDirectDeviation,
    medianPreparedDirectRatio,
    preparedDirectBootstrap95,
    thresholds: {
      minimumSamplesPerArm: 30,
      maximumDirectDirectDeviation: 0.05,
      maximumPreparedDirectMedian: 1.05,
      maximumPreparedDirectBootstrapUpper: 1.1,
    },
  };
}

async function withEnvironment<T>(
  overrides: Readonly<Record<string, string | undefined>>,
  action: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(overrides)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    return await action();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function expectCompileSuccess(result: CompileResult, lane: BenchStringLane): void {
  if (!result.success || !WebAssembly.validate(result.binary)) {
    throw new Error(
      `${lane} compile failed:\n${result.errors.map((error) => `${error.severity}: ${error.message}`).join("\n")}`,
    );
  }
  const target = result.irOutcomes?.find((outcome) => outcome.displayName === TARGET);
  if (lane === "prepared") {
    if (target?.kind !== "emitted" || target.legacyBodyEmitted || !target.irBodyEmitted) {
      throw new Error(`Prepared artifact did not exclusively own ${TARGET}: ${JSON.stringify(target)}`);
    }
  } else if (
    target?.kind !== "unsupported" ||
    target.code !== "string-builder-candidate" ||
    !target.legacyBodyEmitted ||
    target.irBodyEmitted
  ) {
    throw new Error(`direct artifact was not the builder-off control for ${TARGET}: ${JSON.stringify(target)}`);
  }
}

async function compileArtifact(lane: BenchStringLane): Promise<CompileResult> {
  const prepared = lane === "prepared";
  return withEnvironment(
    {
      [CUTOVER]: prepared ? "1" : "0",
      [REQUIRE_ROUTE]: prepared ? "1" : "0",
      [STRING_BUILDER]: prepared ? "1" : "0",
    },
    async () => {
      const result = await compileProject(ENTRY, {
        experimentalIR: true,
        target: "standalone",
        trackIrOutcomes: true,
        optimize: 4,
      });
      expectCompileSuccess(result, lane);
      return result;
    },
  );
}

function artifactSummary(lane: BenchStringLane, result: CompileResult): ArtifactSummary {
  const module = new WebAssembly.Module(result.binary);
  return {
    lane,
    binaryBytes: result.binary.length,
    sha256: createHash("sha256").update(result.binary).digest("hex"),
    imports: WebAssembly.Module.imports(module),
    exports: WebAssembly.Module.exports(module),
  };
}

function writeArtifact(directory: string, lane: BenchStringLane, result: CompileResult): ArtifactManifest {
  const binaryPath = join(directory, `${lane}.wasm`);
  writeFileSync(binaryPath, result.binary);
  return {
    lane,
    binaryPath,
    binaryBytes: result.binary.length,
    sha256: createHash("sha256").update(result.binary).digest("hex"),
  };
}

function assertMatchingSurface(direct: CompileResult, prepared: CompileResult): void {
  const directModule = new WebAssembly.Module(direct.binary);
  const preparedModule = new WebAssembly.Module(prepared.binary);
  const directSurface = {
    imports: WebAssembly.Module.imports(directModule),
    exports: WebAssembly.Module.exports(directModule),
  };
  const preparedSurface = {
    imports: WebAssembly.Module.imports(preparedModule),
    exports: WebAssembly.Module.exports(preparedModule),
  };
  if (JSON.stringify(directSurface) !== JSON.stringify(preparedSurface)) {
    throw new Error(`Prepared/direct Wasm surfaces differ: ${JSON.stringify({ directSurface, preparedSurface })}`);
  }
}

class FreshSampleError extends Error {
  constructor(readonly diagnostic: WorkerFailure) {
    super(diagnostic.message);
  }
}

function failureDiagnostic(error: unknown): WorkerFailure {
  if (error instanceof FreshSampleError) return error.diagnostic;
  if (error instanceof LoadGateError) {
    return { kind: "load-gate", message: error.message, load: error.observation };
  }
  return { kind: "worker", message: error instanceof Error ? error.message : String(error) };
}

function parseWorkerEnvelope(stdout: string): WorkerEnvelope | undefined {
  const line = stdout
    .trim()
    .split("\n")
    .findLast((candidate) => candidate.trimStart().startsWith("{"));
  if (!line) return undefined;
  try {
    return JSON.parse(line) as WorkerEnvelope;
  } catch {
    return undefined;
  }
}

function runFreshSample(manifestPath: string, calls: number, warmupCalls: number): SampleResult {
  const child = spawnSync(
    process.execPath,
    [
      `--max-old-space-size=${V8_OLD_SPACE_LIMIT_MB}`,
      "--expose-gc",
      WORKER,
      manifestPath,
      String(calls),
      String(warmupCalls),
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "", NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      maxBuffer: 1_048_576,
    },
  );
  const envelope = parseWorkerEnvelope(child.stdout);
  if (child.status !== 0 || !envelope?.ok) {
    const diagnostic = envelope && !envelope.ok ? envelope.error : undefined;
    throw new FreshSampleError(
      diagnostic ?? {
        kind: "worker",
        message:
          `fresh worker failed (status ${String(child.status)}, signal ${String(child.signal)}): ` +
          `${child.error?.message ?? child.stderr.trim() ?? child.stdout.trim()}`,
      },
    );
  }
  return envelope.result;
}

function sourceRevision(): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: process.cwd(), encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "unknown";
}

function emitReport(report: RuntimeReport, outputPath?: string): void {
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputPath) writeFileSync(resolve(outputPath), serialized);
  process.stdout.write(serialized);
}

async function runProtocol(options: {
  readonly rounds: number;
  readonly calls: number;
  readonly warmupCalls: number;
  readonly bootstrapIterations: number;
  readonly bootstrapSeed: number;
}): Promise<RuntimeReport> {
  assertProtocolRounds(options.rounds);
  let directory: string | undefined;
  const launches: LaunchRecord[] = [];
  const directDirectRatios: number[] = [];
  const preparedDirectRatios: number[] = [];
  let artifacts: readonly ArtifactSummary[] = [];
  try {
    currentLoad();
    directory = mkdtempSync(join(tmpdir(), "js2-bench-string-runtime-"));
    const direct = await compileArtifact("direct");
    const prepared = await compileArtifact("prepared");
    assertMatchingSurface(direct, prepared);
    artifacts = [artifactSummary("direct", direct), artifactSummary("prepared", prepared)];
    const manifests = new Map<BenchStringLane, string>();
    for (const [lane, result] of [
      ["direct", direct],
      ["prepared", prepared],
    ] as const) {
      const manifestPath = join(directory, `${lane}.json`);
      writeFileSync(manifestPath, `${JSON.stringify(writeArtifact(directory, lane, result))}\n`);
      manifests.set(lane, manifestPath);
    }

    for (let round = 0; round < options.rounds; round++) {
      const roundRecords: LaunchRecord[] = [];
      for (const launch of roundLaunches(round)) {
        const result = runFreshSample(manifests.get(launch.lane)!, options.calls, options.warmupCalls);
        const record = { ...launch, sequence: launches.length, round, result };
        launches.push(record);
        roundRecords.push(record);
      }
      const before = roundRecords.find((record) => record.role === "control-before")!;
      const after = roundRecords.find((record) => record.role === "control-after")!;
      const direct = roundRecords.find((record) => record.role === "candidate" && record.lane === "direct")!;
      const prepared = roundRecords.find((record) => record.role === "candidate" && record.lane === "prepared")!;
      const controlRatio = after.result.nsPerCall / before.result.nsPerCall;
      const candidateRatio = prepared.result.nsPerCall / direct.result.nsPerCall;
      directDirectRatios.push(controlRatio);
      preparedDirectRatios.push(candidateRatio);
      process.stderr.write(
        `[bench-string-runtime] round ${round + 1}/${options.rounds}: ` +
          `direct/direct=${controlRatio.toFixed(4)} Prepared/direct=${candidateRatio.toFixed(4)}\n`,
      );
    }

    const verdict = runtimeVerdict(
      directDirectRatios,
      preparedDirectRatios,
      options.bootstrapIterations,
      options.bootstrapSeed,
    );
    return {
      schemaVersion: 2,
      status: verdict.pass ? "passed" : "failed",
      generatedAt: new Date().toISOString(),
      sourceRevision: sourceRevision(),
      environment: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        v8OldSpaceLimitMb: V8_OLD_SPACE_LIMIT_MB,
      },
      protocol: {
        rounds: options.rounds,
        samplesPerArm: preparedDirectRatios.length,
        directControlSamples: directDirectRatios.length * 2,
        callsPerSample: options.calls,
        warmupCalls: options.warmupCalls,
        schedule: "direct-control / alternating-AB-BA candidate / direct-control",
        freshProcessPerLaunch: true,
        workerModule: "scripts/measure/bench-string-ir-runtime-worker.mjs",
        bootstrapIterations: options.bootstrapIterations,
        bootstrapSeed: options.bootstrapSeed,
      },
      artifacts,
      launches,
      directDirectRatios,
      preparedDirectRatios,
      verdict,
    };
  } catch (error) {
    const diagnostic = failureDiagnostic(error);
    return {
      schemaVersion: 2,
      status: "aborted",
      generatedAt: new Date().toISOString(),
      sourceRevision: sourceRevision(),
      environment: {
        node: process.version,
        platform: platform(),
        arch: arch(),
        v8OldSpaceLimitMb: V8_OLD_SPACE_LIMIT_MB,
      },
      protocol: {
        rounds: options.rounds,
        samplesPerArm: preparedDirectRatios.length,
        directControlSamples: directDirectRatios.length * 2,
        callsPerSample: options.calls,
        warmupCalls: options.warmupCalls,
        schedule: "direct-control / alternating-AB-BA candidate / direct-control",
        freshProcessPerLaunch: true,
        workerModule: "scripts/measure/bench-string-ir-runtime-worker.mjs",
        bootstrapIterations: options.bootstrapIterations,
        bootstrapSeed: options.bootstrapSeed,
      },
      artifacts,
      launches,
      directDirectRatios,
      preparedDirectRatios,
      abort: diagnostic,
    };
  } finally {
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
}

function optionValue(args: readonly string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  return index < 0 ? fallback : Number(args[index + 1]);
}

function stringOption(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const rounds = optionValue(args, "--samples", DEFAULT_ROUNDS);
  const calls = optionValue(args, "--calls", DEFAULT_CALLS);
  const warmupCalls = optionValue(args, "--warmup", DEFAULT_WARMUP_CALLS);
  const bootstrapIterations = optionValue(args, "--bootstrap-iterations", DEFAULT_BOOTSTRAP_ITERATIONS);
  const bootstrapSeed = optionValue(args, "--bootstrap-seed", DEFAULT_BOOTSTRAP_SEED);
  assertProtocolRounds(rounds);
  positiveInteger(calls, "--calls");
  positiveInteger(warmupCalls, "--warmup");
  positiveInteger(bootstrapIterations, "--bootstrap-iterations");
  if (!Number.isSafeInteger(bootstrapSeed)) throw new Error("--bootstrap-seed must be a safe integer");
  const outputPath = stringOption(args, "--output");
  const report = await runProtocol({ rounds, calls, warmupCalls, bootstrapIterations, bootstrapSeed });
  emitReport(report, outputPath);
  process.exitCode = report.status === "passed" ? 0 : report.status === "failed" ? 1 : 2;
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await main();
}
