// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, platform, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { compile } from "../src/index.js";
import { LANDING_BENCHMARK_PROGRAMS } from "./lib/landing-benchmark-corpus.mjs";
import {
  LANDING_FOUR_LANE_IDS,
  LANDING_FOUR_LANE_MEASURED_ROUNDS,
  LANDING_FOUR_LANE_WARMUP_ROUNDS,
  classifyLandingSanitizerExecution,
  landingFourLaneExpectedOrder,
  nullMeasurements,
  validateLandingFourLaneResult,
  verifyLandingBenchmarkCorpus,
  type LandingDiagnostic,
  type LandingFourLaneResult,
  type LandingProgramRecord,
  type LandingSample,
  type LandingSanitizerRecord,
  type LandingSupportCell,
  type LandingValidation,
} from "./lib/landing-four-lane-benchmark.mjs";
import {
  landingNodeVmFreshCompileSample,
  landingNodeWarmSample,
  parseLandingWasmtimeColdHostOutput,
} from "./lib/landing-runtime-timing.mjs";
import {
  LANDING_FOUR_LANE_INNER_MEASURED_CALLS,
  LANDING_FOUR_LANE_INNER_WARMUP_CALLS,
  LANDING_WASMTIME_COMPILE_OPTIONS,
  LANDING_WASMTIME_WARM_VALIDATION_EXPORT,
  LANDING_WASM_OPT_ARGS,
  landingFourLaneWasmtimeMedianWarmDriverSource,
  landingWasmtimeCompileArgs,
  landingWasmtimeRunArgs,
} from "./lib/landing-wasmtime-runtime.mjs";
import { readExactSource, sha256Hex } from "./lib/porffor-direct-ab.mjs";

interface Arguments {
  readonly outputDirectory: string;
  readonly validatePath: string | null;
  readonly withoutPorffor: boolean;
  readonly canonicalUbuntu: boolean;
  readonly captureKind: "support-probe" | "benchmark";
}

interface NativeWorkerSupported {
  readonly status: "supported";
  readonly source: { readonly sha256: string; readonly bytes: number };
  readonly artifacts: {
    readonly laneC: string;
    readonly combinedCBytes: number;
    readonly combinedCSha256: string;
    readonly renderedCBytes: number;
  };
  readonly commandProvenance: Readonly<Record<string, unknown>>;
  readonly compilePhasesMs: Readonly<Record<string, number>>;
  readonly totalWorkerWallMs: number;
  readonly compilerResourceUsage: Readonly<Record<string, unknown>>;
}

interface NativeWorkerUnsupported {
  readonly status: "unsupported";
  readonly source: { readonly sha256: string; readonly bytes: number };
  readonly diagnostic: LandingDiagnostic;
  readonly commandProvenance: Readonly<Record<string, unknown>>;
  readonly compilePhasesMs: Readonly<Record<string, number>>;
  readonly compilerResourceUsage: Readonly<Record<string, unknown>>;
}

type NativeWorkerManifest = NativeWorkerSupported | NativeWorkerUnsupported;

interface WasmBuildWorkerManifest {
  readonly status: "supported";
  readonly source: { readonly sha256: string; readonly bytes: number };
  readonly commandProvenance: {
    readonly js2Compile: readonly string[];
    readonly wasmOpt: readonly string[];
    readonly wasmtimePrecompile: readonly string[];
  };
}

interface CaptureFingerprint {
  readonly algorithm: "sha256";
  readonly digest: string;
  readonly inputs: Readonly<Record<string, unknown>>;
}

type CapturePhase = "build" | "startup" | "cold" | "warm";

const CAPTURE_PHASE_METHODOLOGY: Readonly<Record<CapturePhase, string>> = Object.freeze({
  build: "fresh-process-single-compiler-build-v2",
  startup: "fresh-process-init-plus-first-call-v1",
  cold: "native-init-plus-call-wasmtime-46-fresh-store-v3",
  warm: "uniform-six-warmup-nine-call-median-v2",
});

export const LANDING_FOUR_LANE_RUSTC_VERSION = "1.94.1";

export const CAPTURE_CONFIGURATION = Object.freeze({
  rounds: {
    warmup: LANDING_FOUR_LANE_WARMUP_ROUNDS,
    measured: LANDING_FOUR_LANE_MEASURED_ROUNDS,
  },
  wasm: {
    compile: { ...LANDING_WASMTIME_COMPILE_OPTIONS, experimentalIR: false },
    normalize: LANDING_WASM_OPT_ARGS,
    warmDriver: {
      warmup: LANDING_FOUR_LANE_INNER_WARMUP_CALLS,
      measured: LANDING_FOUR_LANE_INNER_MEASURED_CALLS,
      aggregation: "median",
    },
  },
  js2Native: { target: "linear", allocator: "analysis-stack" },
  plainPorffor: {
    supportEvidence: ["porf", "c", "--module", "-O1", "plus additive adapter probe"],
    measuredBuild: ["single compiler/index.js adapter invocation", "Clang compile/link"],
  },
  native: {
    optimized: ["-O3", "-DNDEBUG", "-fno-lto"],
    sanitizer: ["-O1", "-fno-omit-frame-pointer", "-fsanitize=address,undefined"],
    warmDriver: {
      warmup: LANDING_FOUR_LANE_INNER_WARMUP_CALLS,
      measured: LANDING_FOUR_LANE_INNER_MEASURED_CALLS,
      aggregation: "median",
    },
  },
  v8WarmDriver: {
    warmup: LANDING_FOUR_LANE_INNER_WARMUP_CALLS,
    measured: LANDING_FOUR_LANE_INNER_MEASURED_CALLS,
    aggregation: "median",
  },
});

const SANITIZER_ENVIRONMENT = Object.freeze({
  ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1:abort_on_error=1",
  UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
});
const SANITIZER_SCOPE =
  "combined AddressSanitizer+UndefinedBehaviorSanitizer executable; leak detection disabled because this probe classifies memory/undefined behavior in one short-lived invocation, not leak ownership";

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = parseArguments(process.argv.slice(2));
  if (args.validatePath) {
    const result: unknown = JSON.parse(readFileSync(args.validatePath, "utf8"));
    validateLandingFourLaneResult(result);
    process.stdout.write(`${args.validatePath}: valid #3498 result\n`);
  } else {
    await runProbe(args);
  }
}

function parseArguments(argv: readonly string[]): Arguments {
  let outputDirectory = resolve(".tmp/landing-four-lane-backend");
  let validatePath: string | null = null;
  let withoutPorffor = false;
  let canonicalUbuntu = false;
  let captureKind: Arguments["captureKind"] = "support-probe";
  let captureKindSeen = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--probe" || argument === "--benchmark") {
      if (captureKindSeen) throw new Error(usage());
      captureKindSeen = true;
      captureKind = argument === "--benchmark" ? "benchmark" : "support-probe";
      continue;
    }
    if (argument === "--without-porffor") {
      withoutPorffor = true;
      continue;
    }
    if (argument === "--canonical-ubuntu") {
      canonicalUbuntu = true;
      continue;
    }
    if (argument === "--output") {
      outputDirectory = resolve(argv[++index] ?? "");
      if (!argv[index]) throw new Error(usage());
      continue;
    }
    if (argument === "--validate-result") {
      validatePath = resolve(argv[++index] ?? "");
      if (!argv[index]) throw new Error(usage());
      continue;
    }
    throw new Error(usage());
  }
  if (validatePath && (argv.includes("--output") || withoutPorffor || canonicalUbuntu || captureKindSeen)) {
    throw new Error(usage());
  }
  if (canonicalUbuntu && (process.platform !== "linux" || process.arch !== "x64" || !process.env.GITHUB_ACTIONS)) {
    throw new Error("--canonical-ubuntu is restricted to the GitHub Actions Ubuntu x64 artifact job");
  }
  if (canonicalUbuntu && captureKind !== "benchmark") {
    throw new Error("--canonical-ubuntu requires --benchmark so the artifact contains real timing samples");
  }
  return { outputDirectory, validatePath, withoutPorffor, canonicalUbuntu, captureKind };
}

async function runProbe(options: Arguments): Promise<void> {
  const repoRoot = resolve(import.meta.dirname, "..");
  mkdirSync(options.outputDirectory, { recursive: true });
  const programs = await verifyLandingBenchmarkCorpus(repoRoot);
  const versions = environmentVersions(repoRoot);
  const cells: LandingSupportCell[] = [];

  for (const program of programs) cells.push(v8Cell(program, versions.node));
  for (const program of programs) cells.push(await wasmtimeCell(repoRoot, options.outputDirectory, program, versions));
  for (const program of programs) {
    cells.push(
      await nativeCell(
        repoRoot,
        options.outputDirectory,
        program,
        "js2-shared-plan-porffor-c-native",
        options.withoutPorffor,
        versions,
      ),
    );
  }
  for (const program of programs) {
    cells.push(
      await nativeCell(
        repoRoot,
        options.outputDirectory,
        program,
        "plain-porffor-c-native",
        options.withoutPorffor,
        versions,
      ),
    );
  }

  // Canonical order is program-major even though lane-major execution keeps
  // heavyweight compiler state isolated and makes progress easier to audit.
  const orderedCells = LANDING_BENCHMARK_PROGRAMS.flatMap((program) =>
    LANDING_FOUR_LANE_IDS.map((laneId) =>
      cells.find((cell) => cell.programId === program.id && cell.laneId === laneId),
    ),
  );
  if (orderedCells.some((cell) => !cell)) throw new Error("internal #3498 support matrix omission");
  const supportCells = orderedCells as LandingSupportCell[];
  const captured =
    options.captureKind === "benchmark"
      ? await captureBenchmarkMeasurements(repoRoot, options.outputDirectory, programs, supportCells, versions, options)
      : { cells: supportCells, fingerprint: null };
  const captureFingerprint = captured.fingerprint;
  const capturedCells = captured.cells;

  const result: LandingFourLaneResult = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    capture: {
      kind: options.captureKind,
      canonical: options.canonicalUbuntu,
      warmupRounds: options.captureKind === "benchmark" ? LANDING_FOUR_LANE_WARMUP_ROUNDS : 0,
      measuredRounds: options.captureKind === "benchmark" ? LANDING_FOUR_LANE_MEASURED_ROUNDS : 0,
      fingerprint: captureFingerprint,
      environment: versions,
    },
    programs,
    cells: capturedCells,
    interpretation: {
      crossLaneRankingPermitted: false,
      confounders: [
        "frontend: Node/V8, JS2 direct AST compatibility, JS2 typed SSA, or plain Porffor",
        "ABI: Wasm numeric export, raw-f64 native, or boxed Porffor jsval",
        "runtime: V8, Wasmtime/Cranelift, or native process",
        "optimizer: TurboFan, JS2+Binaryen+Cranelift, Porffor -O1+Clang, or JS2 IR+Clang",
        "allocator: V8 GC, Wasm GC, shared LinearMemoryPlan, or Porffor default GC",
      ],
      wasmtimeCompatibilityMethod:
        "exact source uses the existing landing options and compatibility fallback; capture uses benchmarks/wasmtime-cold-host for warm-engine/fresh-store cold samples and a four-lane-only appended 6-warmup/9-measured median driver for startup-independent steady state",
    },
  };
  validateLandingFourLaneResult(result);
  const latestPath = join(options.outputDirectory, "latest.json");
  writeFileSync(latestPath, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(options.outputDirectory, "summary.md"), renderSummary(result));
  process.stdout.write(
    `${JSON.stringify({ latestPath, supported: result.cells.filter((cell) => cell.status === "supported").length, unsafe: result.cells.filter((cell) => cell.status === "unsafe-non-authoritative").length, unsupported: result.cells.filter((cell) => cell.status === "unsupported").length })}\n`,
  );
}

function renderSummary(result: LandingFourLaneResult): string {
  const lines = [
    "# Landing four-lane backend benchmark",
    "",
    `Capture: \`${result.capture.kind}\`${result.capture.canonical ? " (canonical Ubuntu x64)" : " (noncanonical)"}`,
    "",
    "`latest.json` is the authoritative artifact. Timing columns below are median wall milliseconds from measured rounds only; warmup rounds are excluded.",
    "",
    "| Kernel | Lane | Status / authority | Build ms | Startup + first call ms | Cold ms | Warm ms |",
    "| --- | --- | --- | ---: | ---: | ---: | ---: |",
  ];
  for (const cell of result.cells) {
    const status =
      cell.status === "supported"
        ? "supported — authoritative"
        : cell.status === "unsafe-non-authoritative"
          ? "unsafe — UB-contaminated, non-authoritative†"
          : `unsupported — ${cell.diagnostic!.phase}:${cell.diagnostic!.code}${cell.diagnostic!.followUpIssue ? ` (#${cell.diagnostic!.followUpIssue})` : ""}`;
    lines.push(
      `| ${cell.programId} | ${cell.laneId} | ${escapeMarkdownCell(status)} | ${summaryMedian(cell, "build")} | ${summaryMedian(cell, "startup")} | ${summaryMedian(cell, "cold")} | ${summaryMedian(cell, "warm")} |`,
    );
  }
  lines.push(
    "",
    "† Plain-Porffor optimized timings are retained as diagnostic evidence only. A sanitizer finding makes them UB-contaminated, non-authoritative evidence.",
    "",
    "No cross-lane ranking is implied. Frontend, ABI, runtime, optimizer, and allocator differ between lanes; see `latest.json` for commands, versions, sample order, output observations, CPU time, peak RSS, artifact sizes, and full confounders.",
    "",
  );
  return lines.join("\n");
}

function summaryMedian(cell: LandingSupportCell, phase: keyof LandingSupportCell["measurements"]): string {
  const measurement = cell.measurements[phase];
  if (measurement.samples === null) return "—";
  const measured = measurement.samples
    .filter((sample) => sample.phase === "measured")
    .map((sample) => sample.wallNs / 1_000_000)
    .sort((left, right) => left - right);
  if (measured.length === 0) return "—";
  const middle = Math.floor(measured.length / 2);
  const median = measured.length % 2 === 1 ? measured[middle]! : (measured[middle - 1]! + measured[middle]!) / 2;
  return `${median.toFixed(6)}${cell.status === "unsafe-non-authoritative" ? "†" : ""}`;
}

function escapeMarkdownCell(value: string): string {
  return value.replaceAll("|", "\\|");
}

interface CaptureSetup {
  readonly coldHostPath: string;
  readonly coldHostBuild: TimedSpawnWithRssResult;
  readonly coldHostBuildEnvironment: Readonly<Record<string, string>>;
  readonly coldHostBinary: { readonly bytes: number; readonly sha256: string };
  readonly coldHostVersion: string;
  readonly cargoVersion: string;
  readonly rustcVersion: string;
  readonly coldHostTemporaryDirectory: string;
  readonly warmCwasmByProgram: ReadonlyMap<string, string>;
  readonly warmBuildCommandsByProgram: ReadonlyMap<string, readonly (readonly string[])[]>;
}

async function captureBenchmarkMeasurements(
  repoRoot: string,
  outputRoot: string,
  programs: readonly LandingProgramRecord[],
  supportCells: readonly LandingSupportCell[],
  versions: Readonly<Record<string, string>>,
  options: Arguments,
): Promise<{ readonly cells: LandingSupportCell[]; readonly fingerprint: CaptureFingerprint }> {
  const setup = await prepareCaptureSetup(repoRoot, outputRoot, programs, supportCells, versions);
  try {
    const captureFingerprint = createCaptureFingerprint(repoRoot, programs, supportCells, versions, options, setup);
    const samples = loadPartialMeasurements(repoRoot, outputRoot, programs, supportCells, captureFingerprint);
    const cells = await captureBenchmarkMeasurementsWithSetup(
      repoRoot,
      outputRoot,
      programs,
      supportCells,
      setup,
      samples,
      captureFingerprint,
    );
    return { cells, fingerprint: captureFingerprint };
  } finally {
    rmSync(setup.coldHostTemporaryDirectory, { recursive: true, force: true });
  }
}

async function captureBenchmarkMeasurementsWithSetup(
  repoRoot: string,
  outputRoot: string,
  programs: readonly LandingProgramRecord[],
  supportCells: readonly LandingSupportCell[],
  setup: CaptureSetup,
  samples: Map<string, Record<CapturePhase, LandingSample[]>>,
  captureFingerprint: CaptureFingerprint,
): Promise<LandingSupportCell[]> {
  const executableCells = supportCells.filter((cell) => cell.status !== "unsupported");
  const phases: readonly CapturePhase[] = ["build", "startup", "cold", "warm"];
  const rounds = LANDING_FOUR_LANE_WARMUP_ROUNDS + LANDING_FOUR_LANE_MEASURED_ROUNDS;

  for (const [phaseIndex, capturePhase] of phases.entries()) {
    for (let round = 0; round < rounds; round++) {
      if (
        executableCells.every((cell) =>
          samples.get(cellKey(cell))![capturePhase].some((sample) => sample.round === round),
        )
      ) {
        continue;
      }
      const rotation = (round + phaseIndex) % executableCells.length;
      const ordered = executableCells.map((_, index) => executableCells[(index + rotation) % executableCells.length]!);
      for (const [order, cell] of ordered.entries()) {
        const program = programs.find((candidate) => candidate.id === cell.programId)!;
        process.stdout.write(
          `[capture ${capturePhase} ${round + 1}/${rounds} ${order + 1}/${ordered.length}] ${program.id}:${cell.laneId}\n`,
        );
        const measured = await measureCaptureSample({
          repoRoot,
          outputRoot,
          program,
          cell,
          capturePhase,
          round,
          order,
          setup,
        });
        samples.get(cellKey(cell))![capturePhase].push(measured);
      }
      writeFileSync(
        join(outputRoot, "partial-measurements.json"),
        `${JSON.stringify(
          {
            schemaVersion: 1,
            phaseMethodology: CAPTURE_PHASE_METHODOLOGY,
            captureFingerprint,
            completedPhase: capturePhase,
            completedRound: round,
            samples: Object.fromEntries(samples),
          },
          null,
          2,
        )}\n`,
      );
    }
  }
  rmSync(join(outputRoot, "partial-measurements.json"), { force: true });

  return supportCells.map((cell) => {
    if (cell.status === "unsupported") return cell;
    const measured = samples.get(cellKey(cell))!;
    return {
      ...cell,
      measurements: {
        build: { samples: measured.build, reason: null },
        startup: { samples: measured.startup, reason: null },
        cold: { samples: measured.cold, reason: null },
        warm: { samples: measured.warm, reason: null },
      },
      provenance: {
        ...cell.provenance,
        captureFingerprint: captureFingerprint.digest,
        captureMethodology: captureMethodology(cell.laneId, setup, cell.programId),
      },
    };
  });
}

function loadPartialMeasurements(
  repoRoot: string,
  outputRoot: string,
  programs: readonly LandingProgramRecord[],
  supportCells: readonly LandingSupportCell[],
  expectedFingerprint: CaptureFingerprint,
): Map<string, Record<CapturePhase, LandingSample[]>> {
  const executableCells = supportCells.filter((cell) => cell.status !== "unsupported");
  const empty = () => ({ build: [], startup: [], cold: [], warm: [] }) satisfies Record<CapturePhase, LandingSample[]>;
  const samples = new Map(executableCells.map((cell) => [cellKey(cell), empty()]));
  const partialPath = join(outputRoot, "partial-measurements.json");
  if (!existsSync(partialPath)) return samples;
  const partial = JSON.parse(readFileSync(partialPath, "utf8")) as {
    schemaVersion?: unknown;
    phaseMethodology?: Partial<Record<CapturePhase, unknown>>;
    captureFingerprint?: unknown;
    completedPhase?: unknown;
    completedRound?: unknown;
    samples?: unknown;
  };
  if (partial.schemaVersion !== 1 || !partial.samples || typeof partial.samples !== "object") {
    throw new Error("invalid #3498 partial measurement document");
  }
  if (JSON.stringify(partial.captureFingerprint) !== JSON.stringify(expectedFingerprint)) {
    throw new Error("#3498 partial capture fingerprint mismatch; refusing resume");
  }
  const records = partial.samples as Record<string, unknown>;
  const expectedKeys = new Set(samples.keys());
  if (Object.keys(records).length !== expectedKeys.size || Object.keys(records).some((key) => !expectedKeys.has(key))) {
    throw new Error("#3498 partial measurement cell set does not match the executable support matrix");
  }
  for (const [key, phases] of Object.entries(records)) {
    if (!phases || typeof phases !== "object") throw new Error(`${key} partial measurements are invalid`);
    const phaseRecord = phases as Record<CapturePhase, unknown>;
    for (const phase of ["build", "startup", "cold", "warm"] as const) {
      if (!Array.isArray(phaseRecord[phase])) throw new Error(`${key}.${phase} partial samples are invalid`);
      const storedMethodology = partial.phaseMethodology?.[phase];
      if (storedMethodology !== CAPTURE_PHASE_METHODOLOGY[phase]) {
        throw new Error(`${key}.${phase} partial methodology fingerprint mismatch; refusing resume`);
      }
      samples.get(key)![phase] = phaseRecord[phase] as LandingSample[];
    }
  }
  validatePartialSampleSets(
    repoRoot,
    outputRoot,
    programs,
    executableCells,
    samples,
    partial.completedPhase,
    partial.completedRound,
  );
  process.stdout.write(`[capture resume] loaded ${partialPath}\n`);
  return samples;
}

export function validatePartialSampleSets(
  repoRoot: string,
  outputRoot: string,
  programs: readonly LandingProgramRecord[],
  cells: readonly LandingSupportCell[],
  samples: ReadonlyMap<string, Record<CapturePhase, LandingSample[]>>,
  completedPhase: unknown,
  completedRound: unknown,
): void {
  const phases: readonly CapturePhase[] = ["build", "startup", "cold", "warm"];
  const rounds = LANDING_FOUR_LANE_WARMUP_ROUNDS + LANDING_FOUR_LANE_MEASURED_ROUNDS;
  let previousComplete = true;
  let derivedPhase: CapturePhase | null = null;
  let derivedRound = -1;
  for (const [phaseIndex, phase] of phases.entries()) {
    const lengths = cells.map((cell) => samples.get(cellKey(cell))![phase].length);
    if (new Set(lengths).size !== 1) throw new Error(`#3498 partial ${phase} sample counts differ across cells`);
    const length = lengths[0]!;
    if (!Number.isInteger(length) || length < 0 || length > rounds) {
      throw new Error(`#3498 partial ${phase} sample count is out of range`);
    }
    if (!previousComplete && length !== 0)
      throw new Error(`#3498 partial ${phase} starts before the prior phase completed`);
    if (length > 0) {
      derivedPhase = phase;
      derivedRound = length - 1;
    }
    previousComplete = previousComplete && length === rounds;

    for (const cell of cells) {
      const program = programs.find((candidate) => candidate.id === cell.programId)!;
      const phaseSamples = samples.get(cellKey(cell))![phase];
      const seenRounds = new Set<number>();
      for (const [index, sample] of phaseSamples.entries()) {
        validatePartialSample(repoRoot, outputRoot, program, cell, phase, sample, cells.length, rounds);
        if (sample.round !== index || seenRounds.has(sample.round)) {
          throw new Error(`${cellKey(cell)}.${phase} partial rounds must be a unique contiguous prefix`);
        }
        seenRounds.add(sample.round);
      }
    }
    for (let round = 0; round < length; round++) {
      cells.forEach((cell, canonicalCellIndex) => {
        const order = samples.get(cellKey(cell))![phase][round]!.order;
        const expectedOrder = landingFourLaneExpectedOrder(canonicalCellIndex, phaseIndex, round, cells.length);
        if (order !== expectedOrder) {
          throw new Error(
            `#3498 partial ${phase} round ${round} cell ${canonicalCellIndex} order ${order} does not match rotation ${expectedOrder}`,
          );
        }
      });
    }
  }
  if (derivedPhase === null || completedPhase !== derivedPhase || completedRound !== derivedRound) {
    throw new Error("#3498 partial completed phase/round does not match its sample arrays");
  }
}

function validatePartialSample(
  repoRoot: string,
  outputRoot: string,
  program: LandingProgramRecord,
  cell: LandingSupportCell,
  phase: CapturePhase,
  sample: LandingSample,
  cellCount: number,
  roundCount: number,
): void {
  const key = `${cellKey(cell)}.${phase}`;
  if (!sample || typeof sample !== "object" || Array.isArray(sample))
    throw new Error(`${key} sample must be an object`);
  const expectedKeys = [
    "commands",
    "cpuNs",
    "order",
    "outputObservation",
    "peakRssBytes",
    "phase",
    "round",
    "validatedOutput",
    "wallNs",
  ];
  if (Object.keys(sample).sort().join("\0") !== expectedKeys.join("\0")) {
    throw new Error(`${key} sample fields are invalid`);
  }
  if (!Number.isInteger(sample.round) || sample.round < 0 || sample.round >= roundCount) {
    throw new Error(`${key} round is out of range`);
  }
  if (!Number.isInteger(sample.order) || sample.order < 0 || sample.order >= cellCount) {
    throw new Error(`${key} order is out of range`);
  }
  if (sample.phase !== (sample.round < LANDING_FOUR_LANE_WARMUP_ROUNDS ? "warmup" : "measured")) {
    throw new Error(`${key} warmup/measured label is inconsistent`);
  }
  if (!Number.isFinite(sample.wallNs) || sample.wallNs <= 0) throw new Error(`${key} wallNs must be positive finite`);
  if (sample.cpuNs !== null && (!Number.isFinite(sample.cpuNs) || sample.cpuNs <= 0)) {
    throw new Error(`${key} cpuNs must be null or positive finite`);
  }
  if (!Number.isFinite(sample.peakRssBytes) || sample.peakRssBytes <= 0) {
    throw new Error(`${key} peakRssBytes must be positive finite`);
  }
  if (
    !Array.isArray(sample.commands) ||
    sample.commands.length === 0 ||
    sample.commands.some(
      (command) =>
        !Array.isArray(command) ||
        command.length === 0 ||
        command.some((argument) => typeof argument !== "string" || !argument || /synthetic/i.test(argument)),
    )
  ) {
    throw new Error(`${key} commands are malformed or synthetic`);
  }
  validatePartialCommandIdentity(repoRoot, outputRoot, program, cell, phase, sample);
  const expectedOutput = phase === "build" ? null : program.expectedFixedOutputs[3];
  if (!Object.is(sample.validatedOutput, expectedOutput)) {
    throw new Error(`${key} validated output does not match the runtime oracle`);
  }
  if (phase === "build") {
    if (sample.outputObservation !== null) throw new Error(`${key} build must not claim an output observation`);
    return;
  }
  if (!sample.outputObservation || typeof sample.outputObservation !== "object") {
    throw new Error(`${key} must retain an output observation`);
  }
  const expectedObservation = expectedPartialObservation(cell.laneId, phase);
  if (
    sample.outputObservation.commandIndex !== expectedObservation.commandIndex ||
    sample.outputObservation.mechanism !== expectedObservation.mechanism ||
    sample.outputObservation.commandIndex >= sample.commands.length
  ) {
    throw new Error(`${key} output observation is not tied to the expected command`);
  }
}

function expectedPartialObservation(
  laneId: LandingSupportCell["laneId"],
  phase: Exclude<CapturePhase, "build">,
): NonNullable<LandingSample["outputObservation"]> {
  if (laneId === "v8-node-exact-source") {
    return { commandIndex: 0, mechanism: phase === "cold" ? "in-process-return" : "stdout-json" };
  }
  if (laneId === "js2-wasmgc-wasmtime-cranelift") {
    return { commandIndex: phase === "warm" ? 1 : 0, mechanism: phase === "cold" ? "stdout-json" : "stdout-number" };
  }
  return { commandIndex: 0, mechanism: "stdout-json" };
}

function validatePartialCommandIdentity(
  repoRoot: string,
  outputRoot: string,
  program: LandingProgramRecord,
  cell: LandingSupportCell,
  phase: CapturePhase,
  sample: LandingSample,
): void {
  const commands = sample.commands.map((command) => [...command]);
  const primary = unwrapTimeCommand(commands[0]!);
  const sourcePath = resolve(repoRoot, program.sourcePath);
  const runtimeArg = String(program.runtimeArg);
  const assertExact = (actual: readonly string[], expected: readonly string[], label: string) => {
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
      throw new Error(`${cellKey(cell)}.${phase} ${label} command identity mismatch`);
    }
  };
  if (phase === "build") {
    if (cell.laneId === "v8-node-exact-source") {
      if (commands.length !== 1) throw new Error(`${cellKey(cell)}.build V8 command count mismatch`);
      assertExact(primary, [process.execPath, "--check", sourcePath], "V8 build");
      return;
    }
    const lane =
      cell.laneId === "plain-porffor-c-native"
        ? "plain"
        : cell.laneId === "js2-shared-plan-porffor-c-native"
          ? "js2"
          : "wasm";
    const directory = join(outputRoot, "capture-build", "build", String(sample.round), `${program.id}-${cell.laneId}`);
    assertExact(
      primary,
      [
        process.execPath,
        "--import",
        "tsx",
        "scripts/benchmark-landing-four-lane-worker.mts",
        "--lane",
        lane,
        "--program",
        program.id,
        "--output",
        directory,
        "--mode",
        "measured-build",
      ],
      "build worker",
    );
    if (lane === "wasm") {
      if (
        commands.length !== 4 ||
        commands[1]?.[0] !== "JS2.compile" ||
        basename(commands[2]?.[0] ?? "") !== "wasm-opt" ||
        commands[3]?.[0] !== "wasmtime" ||
        commands[3]?.[1] !== "compile"
      ) {
        throw new Error(`${cellKey(cell)}.build Wasm nested command identity mismatch`);
      }
    } else if (
      commands.length !== 4 ||
      commands.slice(1).some((command) => command[0] !== (process.env.CC || "clang"))
    ) {
      throw new Error(`${cellKey(cell)}.build native Clang command identity mismatch`);
    }
    return;
  }
  if (phase === "startup") {
    if (commands.length !== 1) throw new Error(`${cellKey(cell)}.startup command count mismatch`);
    if (cell.laneId === "v8-node-exact-source") {
      assertExact(
        primary,
        [
          process.execPath,
          resolve(repoRoot, "scripts/wasmtime-bench-child-js.mjs"),
          "--mode=single",
          sourcePath,
          runtimeArg,
        ],
        "V8 startup",
      );
    } else if (cell.laneId === "js2-wasmgc-wasmtime-cranelift") {
      const cwasm = join(outputRoot, "artifacts", program.id, "wasmtime", `${program.id}.cranelift.cwasm`);
      assertExact(primary, ["wasmtime", ...landingWasmtimeRunArgs(cwasm, "run", program.runtimeArg)], "Wasm startup");
    } else {
      assertExact(
        primary,
        [nativeExecutablePath(outputRoot, program.id, cell.laneId), "--landing-once", runtimeArg],
        "native startup",
      );
    }
    return;
  }
  if (phase === "cold") {
    if (commands.length !== 1) throw new Error(`${cellKey(cell)}.cold command count mismatch`);
    if (cell.laneId === "v8-node-exact-source") {
      assertExact(primary, [process.execPath, "node:vm.Script+createContext", sourcePath, runtimeArg], "V8 cold");
    } else if (cell.laneId === "js2-wasmgc-wasmtime-cranelift") {
      const wasm = join(outputRoot, "artifacts", program.id, "wasmtime", `${program.id}.wasmtime.wasm`);
      if (basename(primary[0] ?? "") !== "wasmtime-cold-host") {
        throw new Error(`${cellKey(cell)}.cold host command identity mismatch`);
      }
      assertExact(primary.slice(1), [wasm, runtimeArg, "1"], "Wasm cold arguments");
    } else {
      assertExact(
        primary,
        [nativeExecutablePath(outputRoot, program.id, cell.laneId), "--landing-once", runtimeArg],
        "native cold",
      );
    }
    return;
  }
  if (cell.laneId === "v8-node-exact-source") {
    if (commands.length !== 1) throw new Error(`${cellKey(cell)}.warm V8 command count mismatch`);
    assertExact(
      primary,
      [
        process.execPath,
        resolve(repoRoot, "scripts/wasmtime-bench-child-js.mjs"),
        "--mode=warm",
        sourcePath,
        runtimeArg,
      ],
      "V8 warm",
    );
  } else if (cell.laneId === "js2-wasmgc-wasmtime-cranelift") {
    if (commands.length !== 2) throw new Error(`${cellKey(cell)}.warm Wasm command count mismatch`);
    const cwasm = join(outputRoot, "capture-setup", "wasmtime-warm", program.id, `${program.id}-warm.cranelift.cwasm`);
    assertExact(primary, ["wasmtime", ...landingWasmtimeRunArgs(cwasm, "warm", program.runtimeArg)], "Wasm warm");
    assertExact(
      unwrapTimeCommand(commands[1]!),
      ["wasmtime", ...landingWasmtimeRunArgs(cwasm, LANDING_WASMTIME_WARM_VALIDATION_EXPORT, program.runtimeArg)],
      "Wasm warm validation",
    );
  } else {
    if (commands.length !== 1) throw new Error(`${cellKey(cell)}.warm native command count mismatch`);
    assertExact(
      primary,
      [nativeExecutablePath(outputRoot, program.id, cell.laneId), "--landing-warm", runtimeArg],
      "native warm",
    );
  }
}

function unwrapTimeCommand(command: readonly string[]): readonly string[] {
  if (command[0] === "/usr/bin/time" && (command[1] === "-l" || command[1] === "-v")) return command.slice(2);
  return command;
}

function createCaptureFingerprint(
  repoRoot: string,
  programs: readonly LandingProgramRecord[],
  cells: readonly LandingSupportCell[],
  versions: Readonly<Record<string, string>>,
  options: Arguments,
  setup: CaptureSetup,
): CaptureFingerprint {
  const relevantFiles = [
    "scripts/benchmark-landing-four-lane.mts",
    "scripts/benchmark-landing-four-lane-worker.mts",
    "scripts/lib/landing-benchmark-corpus.mjs",
    "scripts/lib/landing-four-lane-benchmark.mts",
    "scripts/lib/landing-runtime-timing.mjs",
    "scripts/lib/landing-wasmtime-runtime.mjs",
    "scripts/wasmtime-bench-child-js.mjs",
    "benchmarks/porffor-direct-ab-harness.c",
    "benchmarks/wasmtime-cold-host/src/main.rs",
    "benchmarks/wasmtime-cold-host/Cargo.toml",
    "benchmarks/wasmtime-cold-host/Cargo.lock",
    "pnpm-lock.yaml",
  ];
  const compilerPaths = [
    "src",
    "scripts/benchmark-landing-four-lane.mts",
    "scripts/benchmark-landing-four-lane-worker.mts",
    "scripts/lib",
    "scripts/wasmtime-bench-child-js.mjs",
    "benchmarks/porffor-direct-ab-harness.c",
    "benchmarks/wasmtime-cold-host",
    "package.json",
    "pnpm-lock.yaml",
    "tsconfig.json",
  ];
  const inputs = {
    phaseMethodology: CAPTURE_PHASE_METHODOLOGY,
    captureConfiguration: {
      ...CAPTURE_CONFIGURATION,
      canonicalUbuntu: options.canonicalUbuntu,
      withoutPorffor: options.withoutPorffor,
      nodeExecutable: process.execPath,
      clangExecutable: process.env.CC || "clang",
    },
    canonicalSources: programs.map((program) => ({
      id: program.id,
      label: program.label,
      sourcePath: program.sourcePath,
      bytes: program.bytes,
      sha256: program.sha256,
      coldArg: program.coldArg,
      runtimeArg: program.runtimeArg,
      fixedInputs: program.fixedInputs,
      expectedFixedOutputs: program.expectedFixedOutputs,
    })),
    executableCells: cells
      .filter((cell) => cell.status !== "unsupported")
      .map((cell) => ({
        key: cellKey(cell),
        sourceSha256: cell.sourceSha256,
        status: cell.status,
        sanitizerStatus: cell.sanitizer.status,
        sanitizerAuthority: cell.sanitizer.authority,
        artifacts: collectArtifactIdentities(cell.provenance),
      })),
    supportCells: cells.map((cell) => ({
      key: cellKey(cell),
      status: cell.status,
      diagnostic:
        cell.diagnostic === null
          ? null
          : { phase: cell.diagnostic.phase, code: cell.diagnostic.code, followUpIssue: cell.diagnostic.followUpIssue },
    })),
    relevantFiles: relevantFiles.map((path) => {
      const contents = readFileSync(resolve(repoRoot, path));
      return { path, bytes: contents.byteLength, sha256: sha256Hex(contents) };
    }),
    compilerRepository: gitRepositoryFingerprint(repoRoot, compilerPaths),
    porfforRepository: existsSync(resolve(repoRoot, "vendor/Porffor/.git"))
      ? gitRepositoryFingerprint(resolve(repoRoot, "vendor/Porffor"))
      : { status: "unavailable" },
    toolVersions: versions,
    coldHost: {
      binary: setup.coldHostBinary,
      engineVersion: setup.coldHostVersion,
      rustc: setup.rustcVersion,
      cargo: setup.cargoVersion,
    },
  } satisfies Readonly<Record<string, unknown>>;
  return { algorithm: "sha256", digest: sha256Hex(JSON.stringify(inputs)), inputs };
}

function collectArtifactIdentities(value: unknown): readonly Readonly<Record<string, unknown>>[] {
  const identities: Readonly<Record<string, unknown>>[] = [];
  const visit = (candidate: unknown, role: string): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (Array.isArray(candidate)) {
      candidate.forEach((entry, index) => visit(entry, `${role}[${index}]`));
      return;
    }
    const entry = candidate as Record<string, unknown>;
    if (
      typeof entry.bytes === "number" &&
      Number.isInteger(entry.bytes) &&
      entry.bytes > 0 &&
      typeof entry.sha256 === "string" &&
      /^[0-9a-f]{64}$/.test(entry.sha256)
    ) {
      identities.push({ role, bytes: entry.bytes, sha256: entry.sha256 });
    }
    for (const key of Object.keys(entry).sort()) {
      if (key.endsWith("Sha256") && typeof entry[key] === "string" && /^[0-9a-f]{64}$/.test(entry[key])) {
        const stem = key.slice(0, -"Sha256".length);
        const bytes = entry[`${stem}Bytes`];
        if (typeof bytes === "number" && Number.isInteger(bytes) && bytes > 0) {
          identities.push({ role: `${role}.${stem}`, bytes, sha256: entry[key] });
        }
      }
      visit(entry[key], `${role}.${key}`);
    }
  };
  visit(value, "provenance");
  return identities.sort((left, right) => String(left.role).localeCompare(String(right.role)));
}

function gitRepositoryFingerprint(
  repositoryRoot: string,
  paths: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const separator = paths.length > 0 ? ["--", ...paths] : [];
  const head = checkedCommandOutput("git", ["rev-parse", "HEAD"], repositoryRoot).trim();
  const status = checkedCommandOutput(
    "git",
    ["status", "--short", "--untracked-files=all", ...separator],
    repositoryRoot,
  );
  const diff = checkedCommandOutput("git", ["diff", "--binary", "--no-ext-diff", "HEAD", ...separator], repositoryRoot);
  const untracked = checkedCommandOutput(
    "git",
    ["ls-files", "--others", "--exclude-standard", ...separator],
    repositoryRoot,
  )
    .split("\n")
    .filter(Boolean)
    .sort()
    .map((path) => {
      const contents = readFileSync(resolve(repositoryRoot, path));
      return { path, bytes: contents.byteLength, sha256: sha256Hex(contents) };
    });
  return {
    head,
    status: status.trimEnd(),
    trackedDiff: { bytes: Buffer.byteLength(diff), sha256: sha256Hex(diff) },
    untracked,
  };
}

function checkedCommandOutput(command: string, args: readonly string[], cwd: string): string {
  const executed = timedSpawn(command, args, cwd);
  if (executed.status !== 0) {
    throw new Error(`capture fingerprint command failed: ${JSON.stringify(executed.command)}: ${executed.stderr}`);
  }
  return executed.stdout;
}

async function prepareCaptureSetup(
  repoRoot: string,
  outputRoot: string,
  programs: readonly LandingProgramRecord[],
  cells: readonly LandingSupportCell[],
  versions: Readonly<Record<string, string>>,
): Promise<CaptureSetup> {
  const setupRoot = join(outputRoot, "capture-setup");
  const coldHostTemporaryDirectory = mkdtempSync(join(tmpdir(), "js2-3498-wasmtime-cold-host-"));
  const cargoTarget = join(coldHostTemporaryDirectory, "target");
  mkdirSync(setupRoot, { recursive: true });
  try {
    const rustcVersion = commandVersion("rustc", ["--version", "--verbose"], repoRoot);
    const cargoVersion = commandVersion("cargo", ["--version", "--verbose"], repoRoot);
    assertLandingCaptureRustcVersion(rustcVersion);
    assertExactRustToolVersion(cargoVersion, "cargo");
    if (versions.rustc !== rustcVersion || versions.cargo !== cargoVersion) {
      throw new Error("Rust toolchain changed after environment provenance was recorded; refusing capture");
    }
    const coldHostManifest = resolve(repoRoot, "benchmarks/wasmtime-cold-host/Cargo.toml");
    const coldHostBuildEnvironment = {
      CARGO_TARGET_DIR: cargoTarget,
      RUSTC: "rustc",
      RUSTUP_TOOLCHAIN: LANDING_FOUR_LANE_RUSTC_VERSION,
    };
    const coldHostBuild = timedSpawnWithRss(
      "cargo",
      ["build", "--release", "--manifest-path", coldHostManifest],
      repoRoot,
      coldHostBuildEnvironment,
    );
    if (coldHostBuild.status !== 0) {
      throw new Error(`failed to build Wasmtime cold host: ${coldHostBuild.stderr.slice(0, 2_000)}`);
    }
    const coldHostPath = join(
      cargoTarget,
      "release",
      process.platform === "win32" ? "wasmtime-cold-host.exe" : "wasmtime-cold-host",
    );
    const coldHostArtifact = artifact(coldHostPath);
    const coldHostBinary = {
      bytes: Number(coldHostArtifact.bytes),
      sha256: String(coldHostArtifact.sha256),
    };
    const coldHostVersion = commandVersion(coldHostPath, ["--version"], repoRoot);
    const cliEngineVersion = parseWasmtimeEngineVersion(versions.wasmtime);
    const hostEngineVersion = parseWasmtimeEngineVersion(coldHostVersion);
    if (cliEngineVersion !== hostEngineVersion) {
      throw new Error(
        `Wasmtime CLI/host engine mismatch: CLI ${cliEngineVersion}, embedded host ${hostEngineVersion}; refusing capture`,
      );
    }
    const warmCwasmByProgram = new Map<string, string>();
    const warmBuildCommandsByProgram = new Map<string, readonly (readonly string[])[]>();
    const wasmOpt = resolve(repoRoot, "node_modules/.bin/wasm-opt");

    for (const program of programs) {
      const wasmCell = cells.find(
        (cell) => cell.programId === program.id && cell.laneId === "js2-wasmgc-wasmtime-cranelift",
      );
      if (!wasmCell || wasmCell.status === "unsupported") continue;
      const directory = join(setupRoot, "wasmtime-warm", program.id);
      mkdirSync(directory, { recursive: true });
      const source = readExactSource(resolve(repoRoot, program.sourcePath), program.sha256);
      const programBody = source.source.replace(/export const benchmark[\s\S]*?};\n/, "");
      const warmSource = `${programBody}\n${landingFourLaneWasmtimeMedianWarmDriverSource()}`;
      const warmSourcePath = join(directory, `${program.id}-warm-adapter.js`);
      writeFileSync(warmSourcePath, warmSource);
      const compileOptions = {
        fileName: `${program.id}-warm.js`,
        ...LANDING_WASMTIME_COMPILE_OPTIONS,
        experimentalIR: false,
      } as const;
      const compiled = await compile(warmSource, compileOptions);
      if (!compiled.success || !compiled.binary || (compiled.imports ?? []).length > 0) {
        throw new Error(
          `${program.id} warm timing adapter failed: ${compiled.errors.map((error) => error.message).join("; ")}`,
        );
      }
      const rawPath = join(directory, `${program.id}-warm.wasm`);
      const normalizedPath = join(directory, `${program.id}-warm.wasmtime.wasm`);
      const cwasmPath = join(directory, `${program.id}-warm.cranelift.cwasm`);
      writeFileSync(rawPath, compiled.binary);
      const normalizeArgs = [...LANDING_WASM_OPT_ARGS, rawPath, "-o", normalizedPath];
      const normalized = timedSpawnWithRss(wasmOpt, normalizeArgs, repoRoot);
      if (normalized.status !== 0) throw new Error(`${program.id} warm wasm-opt failed: ${normalized.stderr}`);
      const precompileArgs = landingWasmtimeCompileArgs(normalizedPath, cwasmPath);
      const precompiled = timedSpawnWithRss("wasmtime", precompileArgs, repoRoot);
      if (precompiled.status !== 0) throw new Error(`${program.id} warm precompile failed: ${precompiled.stderr}`);
      warmCwasmByProgram.set(program.id, cwasmPath);
      warmBuildCommandsByProgram.set(program.id, [
        ["JS2.compile", JSON.stringify(compileOptions), warmSourcePath],
        normalized.command,
        precompiled.command,
      ]);
    }
    return {
      coldHostPath,
      coldHostBuild,
      coldHostBuildEnvironment,
      coldHostBinary,
      coldHostVersion,
      cargoVersion,
      rustcVersion,
      coldHostTemporaryDirectory,
      warmCwasmByProgram,
      warmBuildCommandsByProgram,
    };
  } catch (error) {
    rmSync(coldHostTemporaryDirectory, { recursive: true, force: true });
    throw error;
  }
}

async function measureCaptureSample(context: {
  readonly repoRoot: string;
  readonly outputRoot: string;
  readonly program: LandingProgramRecord;
  readonly cell: LandingSupportCell;
  readonly capturePhase: CapturePhase;
  readonly round: number;
  readonly order: number;
  readonly setup: CaptureSetup;
}): Promise<LandingSample> {
  const measured =
    context.capturePhase === "build"
      ? await measureBuild(context)
      : context.capturePhase === "startup"
        ? measureStartup(context)
        : context.capturePhase === "cold"
          ? measureCold(context)
          : measureWarm(context);
  return {
    phase: context.round < LANDING_FOUR_LANE_WARMUP_ROUNDS ? "warmup" : "measured",
    round: context.round,
    order: context.order,
    wallNs: measured.wallNs,
    cpuNs: measured.cpuNs,
    peakRssBytes: measured.peakRssBytes,
    validatedOutput: measured.validatedOutput,
    outputObservation: measured.outputObservation,
    commands: measured.commands,
  };
}

interface MeasuredInvocation {
  readonly wallNs: number;
  readonly cpuNs: number | null;
  readonly peakRssBytes: number;
  readonly validatedOutput: number | null;
  readonly outputObservation: LandingSample["outputObservation"];
  readonly commands: readonly (readonly string[])[];
}

async function measureBuild(context: Parameters<typeof measureCaptureSample>[0]): Promise<MeasuredInvocation> {
  const sourcePath = resolve(context.repoRoot, context.program.sourcePath);
  if (context.cell.laneId === "v8-node-exact-source") {
    const measured = timedSpawnWithRss(process.execPath, ["--check", sourcePath], context.repoRoot);
    assertCommandSuccess("V8 syntax/build", measured);
    return invocation(measured.wallMs, null, measured.peakRssBytes, null, null, [measured.command]);
  }

  const directory = join(
    context.outputRoot,
    "capture-build",
    context.capturePhase,
    String(context.round),
    `${context.program.id}-${context.cell.laneId}`,
  );
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  try {
    if (context.cell.laneId === "js2-wasmgc-wasmtime-cranelift") {
      const workerCommand = [
        process.execPath,
        "--import",
        "tsx",
        "scripts/benchmark-landing-four-lane-worker.mts",
        "--lane",
        "wasm",
        "--program",
        context.program.id,
        "--output",
        directory,
        "--mode",
        "measured-build",
      ];
      const worker = timedSpawnWithRss(workerCommand[0]!, workerCommand.slice(1), context.repoRoot);
      assertCommandSuccess("fresh-process measured JS2-Wasm build", worker);
      const manifest = JSON.parse(readFileSync(join(directory, "worker.json"), "utf8")) as WasmBuildWorkerManifest;
      if (
        manifest.status !== "supported" ||
        manifest.source.sha256 !== context.program.sha256 ||
        manifest.source.bytes !== context.program.bytes
      ) {
        throw new Error(`${context.program.id} measured JS2-Wasm worker did not retain the exact source`);
      }
      return invocation(worker.wallMs, null, worker.peakRssBytes, null, null, [
        worker.command,
        manifest.commandProvenance.js2Compile,
        manifest.commandProvenance.wasmOpt,
        manifest.commandProvenance.wasmtimePrecompile,
      ]);
    }

    const lane = context.cell.laneId === "plain-porffor-c-native" ? "plain" : "js2";
    const workerCommand = [
      process.execPath,
      "--import",
      "tsx",
      "scripts/benchmark-landing-four-lane-worker.mts",
      "--lane",
      lane,
      "--program",
      context.program.id,
      "--output",
      directory,
      "--mode",
      "measured-build",
    ];
    const started = performance.now();
    const worker = timedSpawnWithRss(workerCommand[0]!, workerCommand.slice(1), context.repoRoot, {
      JS2WASM_PORFFOR_ROOT: resolve(context.repoRoot, "vendor/Porffor"),
    });
    assertCommandSuccess("measured native worker", worker);
    const manifest = JSON.parse(readFileSync(join(directory, "worker.json"), "utf8")) as NativeWorkerManifest;
    if (manifest.status !== "supported")
      throw new Error("executable native cell became unsupported during build capture");
    const linked = compileAndLinkNative(
      process.env.CC || "clang",
      join(directory, manifest.artifacts.laneC),
      resolve(context.repoRoot, "benchmarks/porffor-direct-ab-harness.c"),
      directory,
      "optimized",
      context.repoRoot,
      true,
    );
    if (linked.diagnostic || !linked.executable) throw new Error(linked.diagnostic?.message ?? "native link failed");
    return invocation(
      performance.now() - started,
      null,
      Math.max(worker.peakRssBytes, linked.peakRssBytes, manifestPeakRssBytes(manifest)),
      null,
      null,
      [worker.command, ...linked.commands],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function measureStartup(context: Parameters<typeof measureCaptureSample>[0]): MeasuredInvocation {
  if (context.cell.laneId === "v8-node-exact-source") {
    const command = [
      process.execPath,
      resolve(context.repoRoot, "scripts/wasmtime-bench-child-js.mjs"),
      "--mode=single",
      resolve(context.repoRoot, context.program.sourcePath),
      String(context.program.runtimeArg),
    ];
    const measured = timedSpawnWithRss(command[0]!, command.slice(1), context.repoRoot);
    assertCommandSuccess("V8 fresh-process startup", measured);
    const parsed = JSON.parse(lastNonemptyLine(measured.stdout)) as { result: number };
    assertRuntimeOutput(context.program, parsed.result, "V8 startup");
    return invocation(measured.wallMs, null, measured.peakRssBytes, parsed.result, observed(0, "stdout-json"), [
      measured.command,
    ]);
  }
  if (context.cell.laneId === "js2-wasmgc-wasmtime-cranelift") {
    const cwasmPath = join(
      context.outputRoot,
      "artifacts",
      context.program.id,
      "wasmtime",
      `${context.program.id}.cranelift.cwasm`,
    );
    const args = landingWasmtimeRunArgs(cwasmPath, "run", context.program.runtimeArg);
    const measured = timedSpawnWithRss("wasmtime", args, context.repoRoot);
    assertCommandSuccess("Wasmtime fresh-process startup", measured);
    const output = Number(lastNonemptyLine(measured.stdout));
    assertRuntimeOutput(context.program, output, "Wasmtime startup");
    return invocation(measured.wallMs, null, measured.peakRssBytes, output, observed(0, "stdout-number"), [
      measured.command,
    ]);
  }
  const executable = nativeExecutablePath(context.outputRoot, context.program.id, context.cell.laneId);
  const measured = timedSpawnWithRss(
    executable,
    ["--landing-once", String(context.program.runtimeArg)],
    context.repoRoot,
  );
  assertCommandSuccess("native fresh-process startup", measured);
  const parsed = JSON.parse(lastNonemptyLine(measured.stdout)) as { output: number; peakRssBytes: number };
  assertRuntimeOutput(context.program, parsed.output, "native startup");
  return invocation(
    measured.wallMs,
    null,
    Math.max(measured.peakRssBytes, parsed.peakRssBytes),
    parsed.output,
    observed(0, "stdout-json"),
    [measured.command],
  );
}

function measureCold(context: Parameters<typeof measureCaptureSample>[0]): MeasuredInvocation {
  if (context.cell.laneId === "v8-node-exact-source") {
    const cpuStarted = process.cpuUsage();
    const measured = landingNodeVmFreshCompileSample(
      resolve(context.repoRoot, context.program.sourcePath),
      context.program.runtimeArg,
    );
    const cpu = process.cpuUsage(cpuStarted);
    assertRuntimeOutput(context.program, measured.output, "V8 cold");
    return invocation(
      measured.wallMs,
      cpuNs(cpu),
      processPeakRssBytes(),
      measured.output,
      observed(0, "in-process-return"),
      [
        [
          process.execPath,
          "node:vm.Script+createContext",
          resolve(context.repoRoot, context.program.sourcePath),
          String(context.program.runtimeArg),
        ],
      ],
    );
  }
  if (context.cell.laneId === "js2-wasmgc-wasmtime-cranelift") {
    const wasmPath = join(
      context.outputRoot,
      "artifacts",
      context.program.id,
      "wasmtime",
      `${context.program.id}.wasmtime.wasm`,
    );
    const measured = timedSpawnWithRss(
      context.setup.coldHostPath,
      [wasmPath, String(context.program.runtimeArg), "1"],
      context.repoRoot,
    );
    assertCommandSuccess("Wasmtime warm-engine fresh-store cold", measured);
    const parsed = parseLandingWasmtimeColdHostOutput(measured.stdout, 1);
    const output = parsed.outputs[0];
    assertRuntimeOutput(context.program, output, "Wasmtime cold");
    return invocation(parsed.samplesMs[0]!, null, measured.peakRssBytes, output, observed(0, "stdout-json"), [
      measured.command,
    ]);
  }
  const executable = nativeExecutablePath(context.outputRoot, context.program.id, context.cell.laneId);
  const measured = timedSpawnWithRss(
    executable,
    ["--landing-once", String(context.program.runtimeArg)],
    context.repoRoot,
  );
  assertCommandSuccess("native cold", measured);
  const parsed = JSON.parse(lastNonemptyLine(measured.stdout)) as {
    output: number;
    runtimeWallNs: number;
    runtimeCpuNs: number;
    peakRssBytes: number;
  };
  assertRuntimeOutput(context.program, parsed.output, "native cold");
  return invocationNs(
    parsed.runtimeWallNs,
    parsed.runtimeCpuNs,
    Math.max(measured.peakRssBytes, parsed.peakRssBytes),
    parsed.output,
    observed(0, "stdout-json"),
    [measured.command],
  );
}

function measureWarm(context: Parameters<typeof measureCaptureSample>[0]): MeasuredInvocation {
  if (context.cell.laneId === "v8-node-exact-source") {
    const measured = landingNodeWarmSample(
      resolve(context.repoRoot, "scripts/wasmtime-bench-child-js.mjs"),
      resolve(context.repoRoot, context.program.sourcePath),
      context.program.runtimeArg,
    ) as {
      medianMs: number;
      medianCpuNs: number;
      peakRssBytes: number;
      result: number;
      command: readonly string[];
    };
    assertRuntimeOutput(context.program, measured.result, "V8 warm");
    return invocation(
      measured.medianMs,
      measured.medianCpuNs,
      measured.peakRssBytes,
      measured.result,
      observed(0, "stdout-json"),
      [measured.command],
    );
  }
  if (context.cell.laneId === "js2-wasmgc-wasmtime-cranelift") {
    const cwasmPath = context.setup.warmCwasmByProgram.get(context.program.id);
    if (!cwasmPath) throw new Error(`${context.program.id} has no Wasmtime warm adapter`);
    const args = landingWasmtimeRunArgs(cwasmPath, "warm", context.program.runtimeArg);
    const measured = timedSpawnWithRss("wasmtime", args, context.repoRoot);
    assertCommandSuccess("Wasmtime in-module warm", measured);
    const perCallMs = Number(lastNonemptyLine(measured.stdout));
    const validationArgs = landingWasmtimeRunArgs(
      cwasmPath,
      LANDING_WASMTIME_WARM_VALIDATION_EXPORT,
      context.program.runtimeArg,
    );
    const validated = timedSpawnWithRss("wasmtime", validationArgs, context.repoRoot);
    assertCommandSuccess("Wasmtime warm output validation", validated);
    const output = Number(lastNonemptyLine(validated.stdout));
    assertRuntimeOutput(context.program, output, "Wasmtime warm");
    return invocation(
      perCallMs,
      null,
      Math.max(measured.peakRssBytes, validated.peakRssBytes),
      output,
      observed(1, "stdout-number"),
      [measured.command, validated.command],
    );
  }
  const executable = nativeExecutablePath(context.outputRoot, context.program.id, context.cell.laneId);
  const measured = timedSpawnWithRss(
    executable,
    ["--landing-warm", String(context.program.runtimeArg)],
    context.repoRoot,
  );
  assertCommandSuccess("native in-process warm", measured);
  const parsed = JSON.parse(lastNonemptyLine(measured.stdout)) as {
    output: number;
    medianWallNs: number;
    medianCpuNs: number;
    peakRssBytes: number;
  };
  assertRuntimeOutput(context.program, parsed.output, "native warm");
  return invocationNs(
    parsed.medianWallNs,
    parsed.medianCpuNs,
    Math.max(measured.peakRssBytes, parsed.peakRssBytes),
    parsed.output,
    observed(0, "stdout-json"),
    [measured.command],
  );
}

function invocation(
  wallMs: number,
  cpuNsValue: number | null,
  peakRssBytes: number,
  validatedOutput: number | null,
  outputObservation: LandingSample["outputObservation"],
  commands: readonly (readonly string[])[],
): MeasuredInvocation {
  return invocationNs(positiveNsFromMs(wallMs), cpuNsValue, peakRssBytes, validatedOutput, outputObservation, commands);
}

function invocationNs(
  wallNs: number,
  cpuNsValue: number | null,
  peakRssBytes: number,
  validatedOutput: number | null,
  outputObservation: LandingSample["outputObservation"],
  commands: readonly (readonly string[])[],
): MeasuredInvocation {
  if (!Number.isFinite(wallNs) || wallNs <= 0) throw new Error(`capture produced invalid wall time ${wallNs}`);
  if (!Number.isFinite(peakRssBytes) || peakRssBytes <= 0)
    throw new Error(`capture produced invalid RSS ${peakRssBytes}`);
  const normalizedCpu = cpuNsValue && cpuNsValue > 0 ? cpuNsValue : null;
  return { wallNs, cpuNs: normalizedCpu, peakRssBytes, validatedOutput, outputObservation, commands };
}

function observed(
  commandIndex: number,
  mechanism: NonNullable<LandingSample["outputObservation"]>["mechanism"],
): NonNullable<LandingSample["outputObservation"]> {
  return { commandIndex, mechanism };
}

function positiveNsFromMs(value: number): number {
  const nanoseconds = value * 1_000_000;
  if (!Number.isFinite(nanoseconds) || nanoseconds <= 0) throw new Error(`capture produced invalid ms ${value}`);
  return nanoseconds;
}

function cpuNs(value: NodeJS.CpuUsage): number | null {
  const nanoseconds = (value.user + value.system) * 1000;
  return nanoseconds > 0 ? nanoseconds : null;
}

function assertRuntimeOutput(program: LandingProgramRecord, output: unknown, label: string): void {
  const expected = program.expectedFixedOutputs[3];
  if (typeof output !== "number" || !Object.is(output, expected)) {
    throw new Error(`${program.id} ${label} output mismatch: expected ${expected}, received ${String(output)}`);
  }
}

function assertCommandSuccess(label: string, measured: TimedSpawnResult): void {
  if (measured.status !== 0) {
    throw new Error(`${label} failed (${String(measured.status)}): ${measured.stderr.slice(0, 2_000)}`);
  }
}

function nativeExecutablePath(outputRoot: string, programId: string, laneId: LandingSupportCell["laneId"]): string {
  const lane = laneId === "plain-porffor-c-native" ? "plain" : "js2";
  return join(outputRoot, "artifacts", programId, lane, process.platform === "win32" ? "optimized.exe" : "optimized");
}

function manifestPeakRssBytes(manifest: NativeWorkerSupported): number {
  const peak = manifest.compilerResourceUsage.peakRss;
  const unit = manifest.compilerResourceUsage.peakRssUnit;
  if (typeof peak !== "number" || peak <= 0) return 0;
  return unit === "kilobytes" ? peak * 1024 : peak;
}

function cellKey(cell: Pick<LandingSupportCell, "programId" | "laneId">): string {
  return `${cell.programId}:${cell.laneId}`;
}

function captureMethodology(
  laneId: LandingSupportCell["laneId"],
  setup: CaptureSetup,
  programId: string,
): Readonly<Record<string, unknown>> {
  if (laneId === "v8-node-exact-source") {
    return {
      build: "fresh node --check process",
      startup: "fresh Node/V8 process, exact module import, first runtimeArg call",
      cold: "existing #1764 warm-V8 vm Context + fresh Script compile + runtimeArg call",
      warm: "existing wasmtime-bench-child-js.mjs: six in-process warmups, median of nine calls",
    };
  }
  if (laneId === "js2-wasmgc-wasmtime-cranelift") {
    return {
      build:
        "fresh worker process per sample: JS2 exact-source compile + Binaryen normalization + Wasmtime Cranelift precompile; worker-process peak RSS",
      startup: "fresh wasmtime run process using the precompiled exact-source artifact",
      cold: "benchmarks/wasmtime-cold-host warm Engine/Module + fresh Store/Instance + runtimeArg call; host-emitted result validated",
      warm: "four-lane appended in-module driver: six in-process warmups, median of nine timed calls; paired landing_validate invocation validates run(runtimeArg)",
      coldHostBuildCommand: setup.coldHostBuild.command,
      coldHostBuildEnvironment: setup.coldHostBuildEnvironment,
      coldHostBinary: setup.coldHostBinary,
      coldHostVersion: setup.coldHostVersion,
      coldHostTargetRetention: "temporary directory outside the result tree; deleted after capture",
      warmAdapterBuildCommands: setup.warmBuildCommandsByProgram.get(programId),
    };
  }
  return {
    build: "fresh Porffor/JS2 worker + Clang compile/link without LTO",
    startup: "fresh native process initialization plus the first runtimeArg call, validated against Node",
    cold: "fresh native process initialization plus one runtimeArg call; kernel CPU and wall clocks retained",
    warm: "one native process: six warmups, median of nine individually timed runtimeArg calls",
  };
}

function v8Cell(program: LandingProgramRecord, nodeVersion: string): LandingSupportCell {
  return {
    programId: program.id,
    laneId: "v8-node-exact-source",
    sourceSha256: program.sha256,
    status: "supported",
    validation: validation(program, program.expectedFixedOutputs, [
      process.execPath,
      "dynamic-import",
      program.sourcePath,
    ]),
    diagnostic: null,
    sanitizer: notApplicableSanitizer(),
    measurements: nullMeasurements("support-probe-only; no timing sample was accepted"),
    provenance: {
      frontend: "exact ECMAScript module bytes",
      runtime: "Node/V8",
      nodeVersion,
      sourceBytes: program.bytes,
      oracle: "same exact module imported by the #3498 corpus verifier",
    },
  };
}

async function wasmtimeCell(
  repoRoot: string,
  outputRoot: string,
  program: LandingProgramRecord,
  versions: Readonly<Record<string, string>>,
): Promise<LandingSupportCell> {
  const directory = join(outputRoot, "artifacts", program.id, "wasmtime");
  mkdirSync(directory, { recursive: true });
  const source = readExactSource(resolve(repoRoot, program.sourcePath), program.sha256);
  const started = performance.now();
  const compileOptions = {
    fileName: source.path,
    ...LANDING_WASMTIME_COMPILE_OPTIONS,
    experimentalIR: false,
  } as const;
  const compiled = await compile(source.source, compileOptions);
  const js2CompileMs = performance.now() - started;
  if (!compiled.success || !compiled.binary || (compiled.imports ?? []).length > 0) {
    return unsupportedCell(program, "js2-wasmgc-wasmtime-cranelift", {
      phase: "js2-wasmgc-compile",
      code: compiled.success ? "unexpected-host-imports" : "compile-failed",
      message: compiled.success
        ? "the exact landing program produced host imports"
        : compiled.errors.map((error) => error.message).join("; "),
      evidence: [
        `compile options: ${JSON.stringify(compileOptions)}`,
        `imports: ${JSON.stringify(compiled.imports ?? [])}`,
      ],
      followUpIssue: null,
    });
  }

  const rawWasmPath = join(directory, `${program.id}.wasm`);
  const normalizedWasmPath = join(directory, `${program.id}.wasmtime.wasm`);
  const cwasmPath = join(directory, `${program.id}.cranelift.cwasm`);
  writeFileSync(rawWasmPath, compiled.binary);
  const wasmOpt = resolve(repoRoot, "node_modules/.bin/wasm-opt");
  const normalizeArgs = [...LANDING_WASM_OPT_ARGS, rawWasmPath, "-o", normalizedWasmPath];
  const normalized = timedSpawn(wasmOpt, normalizeArgs, repoRoot);
  if (normalized.status !== 0) {
    return unsupportedCell(
      program,
      "js2-wasmgc-wasmtime-cranelift",
      commandFailureDiagnostic("wasm-opt-normalize", normalized),
    );
  }
  const precompileArgs = landingWasmtimeCompileArgs(normalizedWasmPath, cwasmPath);
  const precompiled = timedSpawn("wasmtime", precompileArgs, repoRoot);
  if (precompiled.status !== 0) {
    return unsupportedCell(
      program,
      "js2-wasmgc-wasmtime-cranelift",
      commandFailureDiagnostic("wasmtime-precompile", precompiled),
    );
  }

  const actualOutputs: number[] = [];
  const validationCommands: string[][] = [];
  for (const input of program.fixedInputs) {
    const runArgs = landingWasmtimeRunArgs(cwasmPath, "run", input);
    const executed = timedSpawn("wasmtime", runArgs, repoRoot);
    if (executed.status !== 0) {
      return unsupportedCell(
        program,
        "js2-wasmgc-wasmtime-cranelift",
        commandFailureDiagnostic("wasmtime-execute", executed),
      );
    }
    const output = Number(lastNonemptyLine(executed.stdout));
    if (!Number.isFinite(output)) {
      return unsupportedCell(program, "js2-wasmgc-wasmtime-cranelift", {
        phase: "wasmtime-output-parse",
        code: "non-numeric-output",
        message: `Wasmtime did not print a finite numeric run result for ${input}`,
        evidence: [executed.stdout.slice(0, 500), executed.stderr.slice(0, 500)],
        followUpIssue: null,
      });
    }
    actualOutputs.push(output);
    validationCommands.push(["wasmtime", ...runArgs]);
  }
  assertOutputs(program, actualOutputs, "Wasmtime");
  return {
    programId: program.id,
    laneId: "js2-wasmgc-wasmtime-cranelift",
    sourceSha256: program.sha256,
    status: "supported",
    validation: validation(program, actualOutputs, validationCommands.flat()),
    diagnostic: null,
    sanitizer: notApplicableSanitizer(),
    measurements: nullMeasurements("support-probe-only; existing landing timing method is not relabelled"),
    provenance: {
      frontend: "JS2 direct-AST compatibility path",
      runtime: "Wasmtime/Cranelift precompiled module",
      compileOptions,
      compatibilityFallback: "experimentalIR:false applied consistently to all four exact sources",
      versions,
      phaseTimingsMs: {
        js2Compile: js2CompileMs,
        wasmOpt: normalized.wallMs,
        wasmtimePrecompile: precompiled.wallMs,
      },
      commands: {
        wasmOpt: [wasmOpt, ...normalizeArgs],
        precompile: ["wasmtime", ...precompileArgs],
        validation: validationCommands,
      },
      artifacts: [rawWasmPath, normalizedWasmPath, cwasmPath].map((path) => artifact(path)),
      compilerDiagnostics: compiled.errors,
    },
  };
}

async function nativeCell(
  repoRoot: string,
  outputRoot: string,
  program: LandingProgramRecord,
  laneId: "js2-shared-plan-porffor-c-native" | "plain-porffor-c-native",
  withoutPorffor: boolean,
  versions: Readonly<Record<string, string>>,
): Promise<LandingSupportCell> {
  const lane = laneId === "plain-porffor-c-native" ? "plain" : "js2";
  const directory = join(outputRoot, "artifacts", program.id, lane);
  mkdirSync(directory, { recursive: true });
  if (withoutPorffor || !existsSync(resolve(repoRoot, "vendor/Porffor/porf"))) {
    return unsupportedCell(program, laneId, {
      phase: "optional-dependency",
      code: "pinned-porffor-unavailable",
      message: "the optional pinned Porffor checkout is unavailable, so this native route was not executable",
      evidence: [resolve(repoRoot, "vendor/Porffor/porf")],
      followUpIssue: null,
    });
  }

  const workerCommand = [
    process.execPath,
    "--import",
    "tsx",
    "scripts/benchmark-landing-four-lane-worker.mts",
    "--lane",
    lane,
    "--program",
    program.id,
    "--output",
    directory,
  ];
  const worker = timedSpawn(workerCommand[0]!, workerCommand.slice(1), repoRoot, {
    JS2WASM_PORFFOR_ROOT: resolve(repoRoot, "vendor/Porffor"),
  });
  if (worker.status !== 0 || !existsSync(join(directory, "worker.json"))) {
    return unsupportedCell(program, laneId, commandFailureDiagnostic(`${lane}-native-worker`, worker));
  }
  const manifest = JSON.parse(readFileSync(join(directory, "worker.json"), "utf8")) as NativeWorkerManifest;
  if (manifest.source.sha256 !== program.sha256 || manifest.source.bytes !== program.bytes) {
    throw new Error(`${program.id}:${laneId} worker substituted the exact source`);
  }
  if (manifest.status === "unsupported") {
    return unsupportedCell(program, laneId, manifest.diagnostic, {
      workerCommand,
      worker: manifest.commandProvenance,
      compilerResourceUsage: manifest.compilerResourceUsage,
      phaseTimingsMs: { ...manifest.compilePhasesMs, workerWallMs: worker.wallMs },
    });
  }

  const clang = process.env.CC || "clang";
  const laneCPath = join(directory, manifest.artifacts.laneC);
  const harnessPath = resolve(repoRoot, "benchmarks/porffor-direct-ab-harness.c");
  const optimized = compileAndLinkNative(clang, laneCPath, harnessPath, directory, "optimized", repoRoot);
  if (optimized.diagnostic) return unsupportedCell(program, laneId, optimized.diagnostic);
  const optimizedArgs = ["--landing-probe", ...program.fixedInputs.map(String)];
  const executed = timedSpawn(optimized.executable!, optimizedArgs, repoRoot);
  if (executed.status !== 0) {
    return unsupportedCell(program, laneId, commandFailureDiagnostic("native-optimized-execute", executed));
  }
  const nativeOutput = parseNativeOutput(executed.stdout);
  assertOutputs(program, nativeOutput.fixedOutputs, `${laneId} optimized native`);

  const sanitized = compileAndLinkNative(clang, laneCPath, harnessPath, directory, "sanitize", repoRoot);
  if (sanitized.diagnostic) return unsupportedCell(program, laneId, sanitized.diagnostic);
  const sanitizerExecuted = timedSpawn(sanitized.executable!, optimizedArgs, repoRoot, SANITIZER_ENVIRONMENT);
  const sanitizerOutcome = classifyLandingSanitizerExecution(
    sanitizerExecuted.status ?? (sanitizerExecuted.signal ? 1 : null),
    sanitizerExecuted.stderr,
  );
  const sanitizerFinding = sanitizerOutcome === "finding";
  const sanitizer: LandingSanitizerRecord = sanitizerFinding
    ? {
        status: "finding",
        authority: lane === "plain" ? "ub-contaminated-non-authoritative" : "pending",
        diagnostic: firstSanitizerLine(sanitizerExecuted.stderr),
        command: [sanitized.executable!, ...optimizedArgs],
        environment: SANITIZER_ENVIRONMENT,
        scope: SANITIZER_SCOPE,
      }
    : {
        status: "clean",
        authority: "authoritative",
        diagnostic: null,
        command: [sanitized.executable!, ...optimizedArgs],
        environment: SANITIZER_ENVIRONMENT,
        scope: SANITIZER_SCOPE,
      };
  if (!sanitizerFinding) {
    const sanitizerOutput = parseNativeOutput(sanitizerExecuted.stdout);
    assertOutputs(program, sanitizerOutput.fixedOutputs, `${laneId} sanitized native`);
  }
  if (lane === "js2" && sanitizerFinding) {
    return unsupportedCell(program, laneId, {
      phase: "native-sanitizer",
      code: "js2-native-sanitizer-finding",
      message: "JS2 source-derived native output is not accepted unless ASan/UBSan are clean",
      evidence: [sanitizerExecuted.stderr.slice(0, 2_000)],
      followUpIssue: null,
    });
  }

  return {
    programId: program.id,
    laneId,
    sourceSha256: program.sha256,
    status: sanitizerFinding ? "unsafe-non-authoritative" : "supported",
    validation: validation(program, nativeOutput.fixedOutputs, [optimized.executable!, ...optimizedArgs]),
    diagnostic: null,
    sanitizer,
    measurements: nullMeasurements(
      sanitizerFinding
        ? "support-probe-only; optimized output is UB-contaminated and non-authoritative"
        : "support-probe-only; no timing sample was accepted",
    ),
    provenance: {
      frontend:
        lane === "plain" ? "pinned plain Porffor exact-source frontend" : "JS2 typed SSA/shared LinearMemoryPlan",
      runtime: "Clang native executable",
      versions,
      workerCommand,
      worker: manifest.commandProvenance,
      phaseTimingsMs: {
        ...manifest.compilePhasesMs,
        workerWallMs: worker.wallMs,
        optimizedCompileAndLinkMs: optimized.wallMs,
        sanitizerCompileAndLinkMs: sanitized.wallMs,
      },
      commands: {
        optimized: optimized.commands,
        optimizedRun: [optimized.executable!, ...optimizedArgs],
        sanitizer: sanitized.commands,
        sanitizerRun: [sanitized.executable!, ...optimizedArgs],
      },
      compilerResourceUsage: manifest.compilerResourceUsage,
      runtimePeakRssBytes: nativeOutput.peakRssBytes,
      sanitizerEnvironment: SANITIZER_ENVIRONMENT,
      sanitizerScope: SANITIZER_SCOPE,
      artifacts: {
        generatedCBytes: manifest.artifacts.combinedCBytes,
        renderedCBytes: manifest.artifacts.renderedCBytes,
        generatedCSha256: manifest.artifacts.combinedCSha256,
        executable: artifact(optimized.executable!),
        sanitizerExecutable: artifact(sanitized.executable!),
      },
    },
  };
}

function compileAndLinkNative(
  clang: string,
  laneCPath: string,
  harnessPath: string,
  directory: string,
  mode: "optimized" | "sanitize",
  cwd: string,
  capturePeakRss = false,
): {
  readonly executable: string | null;
  readonly commands: readonly (readonly string[])[];
  readonly wallMs: number;
  readonly peakRssBytes: number;
  readonly diagnostic: LandingDiagnostic | null;
} {
  const common = ["-std=gnu11", "-fno-lto", "-Werror", "-Wno-unused-function"];
  const compileFlags =
    mode === "optimized"
      ? ["-O3", "-DNDEBUG", ...common, "-ffunction-sections", "-fdata-sections"]
      : ["-O1", "-g", ...common, "-fsanitize=address,undefined", "-fno-omit-frame-pointer"];
  const linkFlags =
    mode === "optimized"
      ? ["-O3", "-fno-lto", process.platform === "darwin" ? "-Wl,-dead_strip" : "-Wl,--gc-sections"]
      : ["-O1", "-g", "-fno-lto", "-fsanitize=address,undefined", "-fno-omit-frame-pointer"];
  const laneObject = join(directory, `${mode}-lane.o`);
  const harnessObject = join(directory, `${mode}-harness.o`);
  const executable = join(directory, process.platform === "win32" ? `${mode}.exe` : mode);
  const commands = [
    [clang, ...compileFlags, "-c", laneCPath, "-o", laneObject],
    [clang, ...compileFlags, "-c", harnessPath, "-o", harnessObject],
    [clang, ...linkFlags, laneObject, harnessObject, "-lm", "-o", executable],
  ] as const;
  let wallMs = 0;
  let peakRssBytes = 0;
  for (const command of commands) {
    const result = capturePeakRss
      ? timedSpawnWithRss(command[0], command.slice(1), cwd)
      : { ...timedSpawn(command[0], command.slice(1), cwd), peakRssBytes: 0 };
    wallMs += result.wallMs;
    peakRssBytes = Math.max(peakRssBytes, result.peakRssBytes);
    if (result.status !== 0) {
      return {
        executable: null,
        commands,
        wallMs,
        peakRssBytes,
        diagnostic: commandFailureDiagnostic(`${mode}-clang`, result),
      };
    }
  }
  return { executable, commands, wallMs, peakRssBytes, diagnostic: null };
}

function unsupportedCell(
  program: LandingProgramRecord,
  laneId: LandingSupportCell["laneId"],
  diagnostic: LandingDiagnostic,
  provenance: Readonly<Record<string, unknown>> = {},
): LandingSupportCell {
  return {
    programId: program.id,
    laneId,
    sourceSha256: program.sha256,
    status: "unsupported",
    validation: null,
    diagnostic,
    sanitizer: {
      status: "not-run",
      authority: "pending",
      diagnostic: "lane did not reach an executable sanitizer probe",
      command: null,
      environment: null,
      scope: "sanitizer not run because the lane was not executable",
    },
    measurements: nullMeasurements(`unsupported at ${diagnostic.phase}:${diagnostic.code}`),
    provenance,
  };
}

function validation(
  program: LandingProgramRecord,
  actualOutputs: readonly number[],
  command: readonly string[],
): LandingValidation {
  return {
    inputs: [...program.fixedInputs],
    expectedOutputs: [...program.expectedFixedOutputs],
    actualOutputs: [...actualOutputs],
    command,
  };
}

function notApplicableSanitizer(): LandingSanitizerRecord {
  return {
    status: "not-applicable",
    authority: "not-applicable",
    diagnostic: null,
    command: null,
    environment: null,
    scope: "sanitizers are not applicable to this non-native lane",
  };
}

function assertOutputs(program: LandingProgramRecord, actual: readonly number[], lane: string): void {
  if (
    actual.length !== program.expectedFixedOutputs.length ||
    actual.some((value, index) => !Object.is(value, program.expectedFixedOutputs[index]))
  ) {
    throw new Error(
      `${program.id} ${lane} output mismatch: expected ${JSON.stringify(program.expectedFixedOutputs)}, received ${JSON.stringify(actual)}`,
    );
  }
}

function parseNativeOutput(stdout: string): {
  readonly fixedOutputs: readonly number[];
  readonly peakRssBytes: number;
} {
  const parsed = JSON.parse(lastNonemptyLine(stdout)) as { fixedOutputs?: unknown; peakRssBytes?: unknown };
  if (
    !Array.isArray(parsed.fixedOutputs) ||
    parsed.fixedOutputs.length !== 4 ||
    !parsed.fixedOutputs.every((value) => typeof value === "number" && Number.isFinite(value)) ||
    typeof parsed.peakRssBytes !== "number" ||
    !Number.isFinite(parsed.peakRssBytes) ||
    parsed.peakRssBytes <= 0
  ) {
    throw new Error(`invalid native probe output: ${JSON.stringify(parsed)}`);
  }
  return { fixedOutputs: parsed.fixedOutputs, peakRssBytes: parsed.peakRssBytes };
}

function artifact(path: string): Readonly<Record<string, unknown>> {
  const contents = readFileSync(path);
  return { path, bytes: statSync(path).size, sha256: sha256Hex(contents) };
}

function environmentVersions(repoRoot: string): Readonly<Record<string, string>> {
  return {
    platform: `${platform()}-${arch()}`,
    node: process.version,
    nodeExecutable: process.execPath,
    wasmtime: commandVersion("wasmtime", ["--version"], repoRoot),
    clang: commandVersion(process.env.CC || "clang", ["--version"], repoRoot),
    rustc: commandVersion("rustc", ["--version", "--verbose"], repoRoot),
    cargo: commandVersion("cargo", ["--version", "--verbose"], repoRoot),
    wasmOpt: commandVersion(resolve(repoRoot, "node_modules/.bin/wasm-opt"), ["--version"], repoRoot),
    osRelease: existsSync("/etc/os-release") ? readFileSync("/etc/os-release", "utf8").trim() : "unavailable",
    kernel: commandVersion("uname", ["-a"], repoRoot),
    cpuModel: cpuModel(repoRoot),
    runnerImageOS: process.env.ImageOS ?? "not-github-actions",
    runnerImageVersion: process.env.ImageVersion ?? "not-github-actions",
    runnerOS: process.env.RUNNER_OS ?? "not-github-actions",
    runnerArch: process.env.RUNNER_ARCH ?? "not-github-actions",
    porfforCommit: existsSync(resolve(repoRoot, "vendor/Porffor/.git"))
      ? commandVersion("git", ["-C", resolve(repoRoot, "vendor/Porffor"), "rev-parse", "HEAD"], repoRoot)
      : "unavailable",
  };
}

function cpuModel(repoRoot: string): string {
  if (process.platform === "linux" && existsSync("/proc/cpuinfo")) {
    return (
      readFileSync("/proc/cpuinfo", "utf8")
        .split("\n")
        .find((line) => /^model name\s*:/.test(line))
        ?.split(":")
        .slice(1)
        .join(":")
        .trim() ?? "unavailable"
    );
  }
  if (process.platform === "darwin") {
    return commandVersion("sysctl", ["-n", "machdep.cpu.brand_string"], repoRoot);
  }
  return "unavailable";
}

function parseWasmtimeEngineVersion(value: string): string {
  const match = value.match(/(?:^|\n)wasmtime\s+(\d+\.\d+\.\d+)\b/);
  if (!match) throw new Error(`could not parse Wasmtime engine version from ${JSON.stringify(value)}`);
  return match[1]!;
}

export function assertLandingCaptureRustcVersion(value: string): void {
  assertExactRustToolVersion(value, "rustc");
}

function assertExactRustToolVersion(value: string, tool: "rustc" | "cargo"): void {
  const match = value.match(new RegExp(`(?:^|\\n)${tool}\\s+(\\d+\\.\\d+\\.\\d+)\\b`));
  if (!match || match[1] !== LANDING_FOUR_LANE_RUSTC_VERSION) {
    throw new Error(
      `#3498 capture requires ${tool} ${LANDING_FOUR_LANE_RUSTC_VERSION}; observed ${JSON.stringify(value)}`,
    );
  }
}

function commandVersion(command: string, args: readonly string[], cwd: string): string {
  const result = timedSpawn(command, args, cwd);
  if (result.status !== 0) return `unavailable: ${firstNonemptyLine(result.stderr)}`;
  const output = result.stdout.trim() || result.stderr.trim();
  if (!output) throw new Error(`${command} version command produced no output`);
  return output;
}

function commandFailureDiagnostic(phase: string, result: TimedSpawnResult): LandingDiagnostic {
  return {
    phase,
    code: "command-failed",
    message: `command exited with status ${String(result.status)}${result.signal ? ` signal ${result.signal}` : ""}`,
    evidence: [
      `command: ${JSON.stringify(result.command)}`,
      `stdout: ${result.stdout.slice(0, 1_000)}`,
      `stderr: ${result.stderr.slice(0, 2_000)}`,
    ],
    followUpIssue: null,
  };
}

interface TimedSpawnResult {
  readonly command: readonly string[];
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly wallMs: number;
}

interface TimedSpawnWithRssResult extends TimedSpawnResult {
  readonly peakRssBytes: number;
}

function timedSpawn(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): TimedSpawnResult {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  return {
    command: [command, ...args],
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || String(result.error ?? ""),
    wallMs: performance.now() - started,
  };
}

function timedSpawnWithRss(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
): TimedSpawnWithRssResult {
  const timePath = "/usr/bin/time";
  if (!existsSync(timePath)) {
    return { ...timedSpawn(command, args, cwd, env), peakRssBytes: processPeakRssBytes() };
  }
  const timeArgs = process.platform === "darwin" ? ["-l", command, ...args] : ["-v", command, ...args];
  const measured = timedSpawn(timePath, timeArgs, cwd, env);
  const linux = measured.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  const darwin = measured.stderr.match(/(?:^|\n)\s*(\d+)\s+maximum resident set size/);
  const peakRssBytes = linux ? Number(linux[1]) * 1024 : darwin ? Number(darwin[1]) : processPeakRssBytes();
  return { ...measured, peakRssBytes };
}

function processPeakRssBytes(): number {
  const peak = process.resourceUsage().maxRSS;
  return process.platform === "darwin" ? peak : peak * 1024;
}

function lastNonemptyLine(value: string): string {
  const line = value
    .trim()
    .split("\n")
    .filter((candidate) => candidate.trim().length > 0)
    .at(-1);
  if (!line) throw new Error("command produced no non-empty output line");
  return line.trim();
}

function firstNonemptyLine(value: string): string {
  return (
    value
      .split("\n")
      .find((candidate) => candidate.trim().length > 0)
      ?.trim() ?? "no diagnostic"
  );
}

function firstSanitizerLine(stderr: string): string {
  return (
    stderr
      .split("\n")
      .find((line) => /runtime error:|ERROR: AddressSanitizer/.test(line))
      ?.trim() ?? firstNonemptyLine(stderr)
  );
}

function usage(): string {
  return "usage: benchmark-landing-four-lane.mts [--probe|--benchmark] [--without-porffor] [--canonical-ubuntu] [--output <dir>] | --validate-result <json>";
}
