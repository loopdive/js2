// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PORFFOR_IR_COMMIT, assertPorfforCommit } from "../src/ir/backend/porffor/compat.js";
import {
  PORFFOR_DIRECT_AB_EXPECTED_CHECKSUM,
  PORFFOR_DIRECT_AB_EXPECTED_FIXED,
  PORFFOR_DIRECT_AB_EXPECTED_SANITIZER_CHECKSUM,
  PORFFOR_DIRECT_AB_FIXTURE,
  PORFFOR_DIRECT_AB_FUNCTION,
  PORFFOR_DIRECT_AB_GREEN_HEAD,
  PORFFOR_DIRECT_AB_ITERATIONS,
  PORFFOR_DIRECT_AB_MEASURED_ROUNDS,
  PORFFOR_DIRECT_AB_ROWS,
  PORFFOR_DIRECT_AB_SANITIZER_ITERATIONS,
  PORFFOR_DIRECT_AB_SCHEMA_VERSION,
  PORFFOR_DIRECT_AB_SUPERSEDED_FIX,
  PORFFOR_DIRECT_AB_VALIDATED_FIX,
  PORFFOR_DIRECT_AB_WARMUP_ROUNDS,
  checksumForIterations,
  quartiles,
  readExactSource,
  sha256Hex,
  type CompilePhaseRecord,
  type PorfforDirectAbMode,
  type PorfforDirectAbRowId,
  type WorkerManifest,
} from "./lib/porffor-direct-ab.mjs";

interface BenchmarkArguments {
  readonly outputDirectory: string;
  readonly mode: PorfforDirectAbMode;
  readonly warmupRounds: number;
  readonly measuredRounds: number;
  readonly iterations: number;
  readonly allowDirty: boolean;
  readonly canonicalUbuntu: boolean;
  readonly validateResult?: string;
}

interface OracleRecord {
  readonly sourcePath: string;
  readonly sourceSha256: string;
  readonly sourceBytes: number;
  readonly function: string;
  readonly fixedSeeds: readonly number[];
  readonly fixedOutputs: readonly number[];
  readonly iterations: number;
  readonly seedFormula: string;
  readonly seedFormulaVersion: number;
  readonly checksumDecimal: string;
}

interface CommandRecord {
  readonly phase: string;
  readonly rowId?: PorfforDirectAbRowId;
  readonly samplePhase?: "warmup" | "measured";
  readonly round?: number;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly wallMs: number;
  readonly peakRssBytes?: number;
  readonly status: number;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutLog: string;
  readonly stderrLog: string;
}

interface NativeOutput {
  readonly iterations: number;
  readonly runtimeCpuNs: number;
  readonly peakRssBytes: number;
  readonly fixedOutputs: readonly number[];
  readonly checksumDecimal: string;
}

interface RecordedCompilePhases extends CompilePhaseRecord {
  readonly sourceToCWorkerWallMs: number;
  readonly clangCompileMs: number;
  readonly clangLinkMs: number;
  readonly totalBuildWallMs: number;
}

interface RawSample {
  readonly round: number;
  readonly order: number;
  readonly compilePhasesMs: RecordedCompilePhases;
  readonly compilerPeakRssBytes: number;
  readonly clangPeakRssBytes: number;
  readonly runtimeCpuNs: number;
  readonly runtimePeakRssBytes: number;
  readonly checksumDecimal: string;
  readonly fixedOutputs: readonly number[];
  readonly iterations: number;
  readonly objectBytes: number;
  readonly executableBytes: number;
  readonly cSha256: string;
}

interface SanitizerSample {
  readonly round: number;
  readonly order: number;
  readonly verdict: "expected-ubsan-failure" | "clean";
  readonly expectedFailure: boolean;
  readonly processStatus: number;
  readonly processSignal: NodeJS.Signals | null;
  readonly diagnosticKind: "misaligned-dynamic-object-f64" | null;
  readonly diagnosticLine: string | null;
  readonly stdoutSha256: string;
  readonly stderrSha256: string;
  readonly compilePhasesMs: RecordedCompilePhases;
  readonly compilerPeakRssBytes: number;
  readonly clangPeakRssBytes: number;
  readonly iterationsAttempted: number;
  readonly checksumDecimal: string | null;
  readonly fixedOutputs: readonly number[] | null;
  readonly objectBytes: number;
  readonly executableBytes: number;
  readonly cSha256: string;
}

interface RowAccumulator {
  manifest?: WorkerManifest;
  artifactSignature?: string;
  artifacts?: WorkerManifest["artifacts"] & { readonly objectBytes: number; readonly executableBytes: number };
  readonly warmups: RawSample[];
  readonly samples: RawSample[];
  readonly sanitizerWarmups: SanitizerSample[];
  readonly sanitizerSamples: SanitizerSample[];
  representativeCopied: boolean;
}

interface TimedResult {
  readonly wallMs: number;
  readonly peakRssBytes: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly status: number;
  readonly signal: NodeJS.Signals | null;
  readonly argv: readonly string[];
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = parseBenchmarkArguments(process.argv.slice(2));
if (cli.validateResult) {
  const result = JSON.parse(readFileSync(cli.validateResult, "utf8")) as unknown;
  validateResultDocument(result);
  process.stdout.write(`validated ${cli.validateResult}\n`);
} else {
  await runBenchmark(cli);
}

export function parseBenchmarkArguments(argv: readonly string[]): BenchmarkArguments {
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const values = new Map<string, string>();
  let allowDirty = false;
  let canonicalUbuntu = false;
  for (let index = 0; index < normalizedArgv.length; index++) {
    const arg = normalizedArgv[index]!;
    if (arg === "--allow-dirty") {
      if (allowDirty) throw new Error(benchmarkUsage());
      allowDirty = true;
      continue;
    }
    if (arg === "--canonical-ubuntu") {
      if (canonicalUbuntu) throw new Error(benchmarkUsage());
      canonicalUbuntu = true;
      continue;
    }
    if (
      !["--output", "--mode", "--warmup-rounds", "--measured-rounds", "--iterations", "--validate-result"].includes(arg)
    ) {
      throw new Error(benchmarkUsage());
    }
    const value = normalizedArgv[++index];
    if (!value || value.startsWith("--") || values.has(arg)) throw new Error(benchmarkUsage());
    values.set(arg, value);
  }
  if (values.has("--validate-result")) {
    if (values.size !== 1 || allowDirty || canonicalUbuntu) throw new Error(benchmarkUsage());
    return {
      outputDirectory: "",
      mode: "optimized",
      warmupRounds: PORFFOR_DIRECT_AB_WARMUP_ROUNDS,
      measuredRounds: PORFFOR_DIRECT_AB_MEASURED_ROUNDS,
      iterations: PORFFOR_DIRECT_AB_ITERATIONS,
      allowDirty: false,
      canonicalUbuntu: false,
      validateResult: resolve(values.get("--validate-result")!),
    };
  }

  const mode = values.get("--mode") ?? "optimized";
  if (mode !== "optimized" && mode !== "sanitize") throw new Error(`unknown mode ${mode}`);
  const warmupRounds = parseNonnegativeInteger(
    values.get("--warmup-rounds") ?? String(mode === "optimized" ? PORFFOR_DIRECT_AB_WARMUP_ROUNDS : 0),
    "warmup rounds",
  );
  const measuredRounds = parsePositiveInteger(
    values.get("--measured-rounds") ?? String(mode === "optimized" ? PORFFOR_DIRECT_AB_MEASURED_ROUNDS : 1),
    "measured rounds",
  );
  const iterations = parsePositiveInteger(
    values.get("--iterations") ??
      String(mode === "optimized" ? PORFFOR_DIRECT_AB_ITERATIONS : PORFFOR_DIRECT_AB_SANITIZER_ITERATIONS),
    "iterations",
  );
  if (
    mode === "optimized" &&
    (warmupRounds !== PORFFOR_DIRECT_AB_WARMUP_ROUNDS ||
      measuredRounds !== PORFFOR_DIRECT_AB_MEASURED_ROUNDS ||
      iterations !== PORFFOR_DIRECT_AB_ITERATIONS ||
      allowDirty)
  ) {
    throw new Error("optimized capture is fixed at clean 5 warmups, 21 measured rounds, and 200,000 calls");
  }
  if (canonicalUbuntu && mode !== "optimized") throw new Error("sanitizer runs cannot be labelled canonical");
  return {
    outputDirectory: resolve(values.get("--output") ?? ".tmp/porffor-direct-ab"),
    mode,
    warmupRounds,
    measuredRounds,
    iterations,
    allowDirty,
    canonicalUbuntu,
  };
}

async function runBenchmark(options: BenchmarkArguments): Promise<void> {
  process.chdir(repoRoot);
  if (existsSync(options.outputDirectory)) {
    throw new Error(`output directory already exists: ${options.outputDirectory}`);
  }
  const gitStatus = git(["status", "--porcelain"]);
  const dirty = gitStatus.length > 0;
  if (dirty && !options.allowDirty) throw new Error(`optimized capture requires a clean worktree:\n${gitStatus}`);
  if (options.allowDirty && options.mode !== "sanitize")
    throw new Error("--allow-dirty is restricted to sanitizer validation");

  const repositoryCommit = git(["rev-parse", "HEAD"]);
  assertAncestor(PORFFOR_DIRECT_AB_GREEN_HEAD, repositoryCommit, "exact green prerequisite head");
  assertAncestor(PORFFOR_DIRECT_AB_VALIDATED_FIX, repositoryCommit, "patch-equivalent validated prerequisite fix");
  const porfforRoot = resolve("vendor/Porffor");
  const gitlink = git(["rev-parse", "HEAD:vendor/Porffor"]);
  const porfforCheckout = git(["-C", porfforRoot, "rev-parse", "HEAD"]);
  assertPorfforCommit(gitlink);
  assertPorfforCommit(porfforCheckout);

  if (options.canonicalUbuntu) {
    if (
      platform() !== "linux" ||
      arch() !== "x64" ||
      process.env.GITHUB_ACTIONS !== "true" ||
      process.env.GITHUB_EVENT_NAME !== "workflow_dispatch"
    ) {
      throw new Error("canonical Ubuntu label requires Linux x64 GitHub Actions workflow_dispatch");
    }
  }

  const clangPath = commandPath("clang");
  const timePath = "/usr/bin/time";
  if (!existsSync(timePath)) throw new Error("/usr/bin/time is required for Clang child RSS measurement");
  const sourcePath = resolve(PORFFOR_DIRECT_AB_FIXTURE);
  const source = readExactSource(sourcePath);
  const oracle = runOracle(sourcePath);
  assertOracle(oracle, source.sha256, source.bytes, options.iterations);

  mkdirSync(options.outputDirectory, { recursive: true });
  const logsDirectory = join(options.outputDirectory, "logs");
  const roundsDirectory = join(options.outputDirectory, ".rounds");
  const representativeDirectory = join(options.outputDirectory, "representative");
  mkdirSync(logsDirectory, { recursive: true });
  mkdirSync(roundsDirectory, { recursive: true });
  mkdirSync(representativeDirectory, { recursive: true });

  const compileFlags = compileFlagsFor(options.mode, options.iterations);
  const linkFlags = linkFlagsFor(options.mode);
  const commands: CommandRecord[] = [];
  const harnessObject = join(options.outputDirectory, "harness.o");
  const harness = runTimedCommand(clangPath, [
    ...compileFlags,
    resolve("benchmarks/porffor-direct-ab-harness.c"),
    "-o",
    harnessObject,
  ]);
  commands.push(logCommand("harness-compile", harness, logsDirectory));

  const rows = new Map<PorfforDirectAbRowId, RowAccumulator>(
    PORFFOR_DIRECT_AB_ROWS.map((rowId) => [
      rowId,
      {
        warmups: [],
        samples: [],
        sanitizerWarmups: [],
        sanitizerSamples: [],
        representativeCopied: false,
      } satisfies RowAccumulator,
    ]),
  );
  const interleaveOrders: { phase: "warmup" | "measured"; round: number; rows: readonly PorfforDirectAbRowId[] }[] = [];
  const totalRounds = options.warmupRounds + options.measuredRounds;
  for (let globalRound = 0; globalRound < totalRounds; globalRound++) {
    const samplePhase = globalRound < options.warmupRounds ? "warmup" : "measured";
    const round = samplePhase === "warmup" ? globalRound : globalRound - options.warmupRounds;
    const order = cyclicOrder(globalRound);
    interleaveOrders.push({ phase: samplePhase, round, rows: order });
    for (let orderIndex = 0; orderIndex < order.length; orderIndex++) {
      const rowId = order[orderIndex]!;
      const accumulator = rows.get(rowId)!;
      const sampleDirectory = join(
        roundsDirectory,
        `${samplePhase}-${String(round).padStart(2, "0")}-${orderIndex}-${rowId}`,
      );
      mkdirSync(sampleDirectory, { recursive: true });
      const workerArgs = [
        "--import",
        "tsx",
        resolve("scripts/benchmark-porffor-direct-ab-worker.mts"),
        "--row",
        rowId,
        "--source",
        sourcePath,
        "--source-sha",
        source.sha256,
        "--output",
        sampleDirectory,
        "--mode",
        options.mode,
      ];
      const worker = runPlainCommand(process.execPath, workerArgs);
      commands.push(logCommand("source-to-c-worker", worker, logsDirectory, rowId, samplePhase, round));
      const manifest = readWorkerManifest(join(sampleDirectory, "worker.json"), rowId, options.mode, source.sha256);
      const laneObject = join(sampleDirectory, "lane.o");
      const executable = join(sampleDirectory, "lane");
      const compiled = runTimedCommand(clangPath, [
        ...compileFlags,
        join(sampleDirectory, manifest.outputFiles.laneC),
        "-o",
        laneObject,
      ]);
      commands.push(logCommand("lane-compile", compiled, logsDirectory, rowId, samplePhase, round));
      const linked = runTimedCommand(clangPath, [...linkFlags, harnessObject, laneObject, "-lm", "-o", executable]);
      commands.push(logCommand("lane-link", linked, logsDirectory, rowId, samplePhase, round));
      const directRow = rowId === "direct-porffor-gc" || rowId === "direct-porffor-bump";
      const expectedSanitizerFailure = options.mode === "sanitize" && directRow;
      const executed = runPlainCommand(executable, [], nativeEnvironment(options.mode), expectedSanitizerFailure);
      commands.push(logCommand("lane-execute", executed, logsDirectory, rowId, samplePhase, round));

      const objectBytes = statSync(laneObject).size;
      const executableBytes = statSync(executable).size;
      const artifactSignature = JSON.stringify({ ...manifest.artifacts, objectBytes, executableBytes });
      if (accumulator.artifactSignature && accumulator.artifactSignature !== artifactSignature) {
        throw new Error(`generated artifacts changed across ${rowId} samples`);
      }
      accumulator.manifest ??= manifest;
      accumulator.artifactSignature ??= artifactSignature;
      accumulator.artifacts ??= { ...manifest.artifacts, objectBytes, executableBytes };

      const compilePhasesMs: RecordedCompilePhases = {
        ...manifest.compilePhasesMs,
        sourceToCWorkerWallMs: worker.wallMs,
        clangCompileMs: compiled.wallMs,
        clangLinkMs: linked.wallMs,
        totalBuildWallMs: worker.wallMs + compiled.wallMs + linked.wallMs,
      };
      if (options.mode === "sanitize") {
        let native: NativeOutput | null = null;
        let diagnosticLine: string | null = null;
        if (directRow) {
          diagnosticLine = assertExpectedDirectSanitizerFailure(executed, rowId);
        } else {
          native = parseNativeOutput(executed.stdout);
          assertNativeOutput(native, oracle, options.iterations);
        }
        const sanitizerSample: SanitizerSample = {
          round,
          order: orderIndex,
          verdict: directRow ? "expected-ubsan-failure" : "clean",
          expectedFailure: directRow,
          processStatus: executed.status,
          processSignal: executed.signal,
          diagnosticKind: directRow ? "misaligned-dynamic-object-f64" : null,
          diagnosticLine,
          stdoutSha256: sha256Hex(executed.stdout),
          stderrSha256: sha256Hex(executed.stderr),
          compilePhasesMs,
          compilerPeakRssBytes: manifest.compilerPeakRssBytes,
          clangPeakRssBytes: Math.max(compiled.peakRssBytes, linked.peakRssBytes),
          iterationsAttempted: options.iterations,
          checksumDecimal: native?.checksumDecimal ?? null,
          fixedOutputs: native?.fixedOutputs ?? null,
          objectBytes,
          executableBytes,
          cSha256: manifest.artifacts.cSha256,
        };
        (samplePhase === "warmup" ? accumulator.sanitizerWarmups : accumulator.sanitizerSamples).push(sanitizerSample);
      } else {
        const native = parseNativeOutput(executed.stdout);
        assertNativeOutput(native, oracle, options.iterations);
        const sample: RawSample = {
          round,
          order: orderIndex,
          compilePhasesMs,
          compilerPeakRssBytes: manifest.compilerPeakRssBytes,
          clangPeakRssBytes: Math.max(compiled.peakRssBytes, linked.peakRssBytes),
          runtimeCpuNs: native.runtimeCpuNs,
          runtimePeakRssBytes: native.peakRssBytes,
          checksumDecimal: native.checksumDecimal,
          fixedOutputs: native.fixedOutputs,
          iterations: native.iterations,
          objectBytes,
          executableBytes,
          cSha256: manifest.artifacts.cSha256,
        };
        (samplePhase === "warmup" ? accumulator.warmups : accumulator.samples).push(sample);
      }

      if (samplePhase === "measured" && !accumulator.representativeCopied) {
        copyRepresentative(sampleDirectory, representativeDirectory, rowId, manifest, laneObject, executable);
        accumulator.representativeCopied = true;
      }
      writeFileSync(
        join(options.outputDirectory, "partial.json"),
        `${JSON.stringify(partialProgress(options, interleaveOrders, rows), null, 2)}\n`,
      );
      rmSync(sampleDirectory, { recursive: true, force: true });
    }
  }

  const environment = environmentRecord(clangPath, porfforCheckout);
  const result = buildResultDocument({
    options,
    dirty,
    repositoryCommit,
    source,
    oracle,
    environment,
    compileFlags,
    linkFlags,
    interleaveOrders,
    harness,
    rows,
  });
  validateResultDocument(result);
  const latestJson = join(options.outputDirectory, "latest.json");
  const latestMarkdown = join(options.outputDirectory, "latest.md");
  writeFileSync(latestJson, `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(latestMarkdown, renderMarkdown(result));
  writeFileSync(join(options.outputDirectory, "commands.json"), `${JSON.stringify(commands, null, 2)}\n`);
  writeFileSync(join(options.outputDirectory, "environment.json"), `${JSON.stringify(environment, null, 2)}\n`);
  rmSync(join(options.outputDirectory, "partial.json"), { force: true });
  rmSync(roundsDirectory, { recursive: true, force: true });
  process.stdout.write(
    `${JSON.stringify({
      latestJson,
      latestMarkdown,
      capture: result.capture,
      rowIds: result.rows.map((row) => row.id),
    })}\n`,
  );
}

function buildResultDocument(context: {
  readonly options: BenchmarkArguments;
  readonly dirty: boolean;
  readonly repositoryCommit: string;
  readonly source: ReturnType<typeof readExactSource>;
  readonly oracle: OracleRecord;
  readonly environment: ReturnType<typeof environmentRecord>;
  readonly compileFlags: readonly string[];
  readonly linkFlags: readonly string[];
  readonly interleaveOrders: readonly unknown[];
  readonly harness: TimedResult;
  readonly rows: ReadonlyMap<PorfforDirectAbRowId, RowAccumulator>;
}) {
  const workflowRunUrl =
    process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
      ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
      : null;
  const captureLabel = context.options.canonicalUbuntu
    ? "canonical-ubuntu-x64-workflow-dispatch"
    : `noncanonical-${platform()}-${arch()}-local`;
  return {
    schemaVersion: PORFFOR_DIRECT_AB_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    capture: {
      mode: context.options.mode,
      canonical: context.options.canonicalUbuntu,
      label: captureLabel,
      workflowRunUrl,
      crossMachineComparisonPermitted: false,
    },
    repository: { commit: context.repositoryCommit, dirty: context.dirty },
    dependency: {
      issue: 3478,
      pr: 3432,
      requiredGreenHead: PORFFOR_DIRECT_AB_GREEN_HEAD,
      validatedFixCommit: PORFFOR_DIRECT_AB_VALIDATED_FIX,
      supersededPatchEquivalentCommit: PORFFOR_DIRECT_AB_SUPERSEDED_FIX,
    },
    environment: context.environment,
    fixture: {
      path: PORFFOR_DIRECT_AB_FIXTURE,
      sha256: context.source.sha256,
      bytes: context.source.bytes,
      function: PORFFOR_DIRECT_AB_FUNCTION,
      iterations: context.options.iterations,
      oracle: {
        fixedSeeds: context.oracle.fixedSeeds,
        fixedOutputs: context.oracle.fixedOutputs,
        seedFormula: context.oracle.seedFormula,
        seedFormulaVersion: context.oracle.seedFormulaVersion,
        checksumDecimal: String(checksumForIterations(context.options.iterations)),
      },
    },
    methodology: {
      warmupRounds: context.options.warmupRounds,
      measuredRounds: context.options.measuredRounds,
      freshCompilerWorkers: true,
      freshNativeProcesses: true,
      initTimed: false,
      timer: "CLOCK_PROCESS_CPUTIME_ID",
      runtimeRss: "whole-process high-water RSS",
      quantile: "R-7 linear interpolation, h = (n - 1) * p",
      compileFlags: context.compileFlags,
      linkFlags: context.linkFlags,
      noLto: true,
      harnessObjectReused: true,
      harnessCompileWallMs: context.harness.wallMs,
      harnessCompilePeakRssBytes: context.harness.peakRssBytes,
      interleaveOrders: context.interleaveOrders,
      sanitizerOptions:
        context.options.mode === "sanitize"
          ? {
              asan: "detect_leaks=0:halt_on_error=1:abort_on_error=1",
              ubsan: "halt_on_error=1:print_stacktrace=1",
            }
          : null,
    },
    rows: PORFFOR_DIRECT_AB_ROWS.map((rowId) => buildRowResult(rowId, context.rows.get(rowId)!, context.options.mode)),
    interpretation: {
      endToEndConflates: ["frontend", "value-abi", "layout", "ir", "allocator"],
      directNumberAbi: "ordinary TypeScript number is boxed Porffor jsval; two hidden jsval call slots are asserted",
      directObjectLayout: "approximately 56 bytes per dynamic object at the pinned commit",
      js2NumberAbi: "raw f64 benchmark boundary",
      js2ObjectLayout: "24-byte fixed record (8-byte header plus two f64 fields)",
      allocationScope: "Porffor policy is global; JS2 stack promotion is per allocation site",
      policyIsolationPair: ["js2-porffor-arena-v1", "js2-porffor-analysis-stack-arena-v1"],
      onlyPolicyIsolatingComparison: true,
      handBuiltPolicyProof: "#3300 remains the hand-built-IR policy proof and is not this direct source A/B",
      directPlainPorfforSafety:
        "plain direct Porffor has known misaligned f64 dynamic-object entry accesses; its optimized timings are UB-contaminated and non-authoritative",
      sanitizerContract:
        "direct rows must reproduce the pinned UBSan misalignment; JS2 rows must complete with exact outputs/checksum and no sanitizer finding",
    },
  };
}

function buildRowResult(rowId: PorfforDirectAbRowId, accumulator: RowAccumulator, mode: PorfforDirectAbMode) {
  if (!accumulator.manifest || !accumulator.artifacts || !accumulator.representativeCopied) {
    throw new Error(`row ${rowId} did not produce complete artifacts`);
  }
  const common = {
    id: rowId,
    sourceSha256: accumulator.manifest.source.sha256,
    valueAbi: accumulator.manifest.function.valueAbi,
    renderedParameterCount: accumulator.manifest.function.renderedParameterCount,
    allocation: accumulator.manifest.allocation,
    safety: accumulator.manifest.safety,
    validity: {
      performanceAuthority: accumulator.manifest.safety.performanceAuthority,
      knownUndefinedBehavior: accumulator.manifest.safety.finding !== null,
      explanation:
        accumulator.manifest.safety.finding === null
          ? "sanitizer-clean behavior is required; optimized values are informational within this capture"
          : "plain pinned Porffor reproducibly fails UBSan on misaligned dynamic-object f64 access; optimized values are UB-contaminated and non-authoritative",
    },
    artifacts: accumulator.artifacts,
    commandProvenance: accumulator.manifest.commandProvenance,
  };
  if (mode === "sanitize") {
    return {
      ...common,
      warmups: accumulator.sanitizerWarmups,
      samples: accumulator.sanitizerSamples,
      summary: null,
    };
  }
  if (accumulator.samples.length === 0) throw new Error(`optimized row ${rowId} has no measured samples`);
  const phaseNames = Object.keys(accumulator.samples[0]!.compilePhasesMs) as (keyof RawSample["compilePhasesMs"])[];
  const compilePhasesMs = Object.fromEntries(
    phaseNames.map((name) => {
      const values = accumulator.samples
        .map((sample) => sample.compilePhasesMs[name])
        .filter((value): value is number => value !== null);
      return [name, values.length === 0 ? null : quartiles(values)];
    }),
  );
  return {
    ...common,
    warmups: accumulator.warmups,
    samples: accumulator.samples,
    summary: {
      runtimeCpuMs: scaleQuartiles(quartiles(accumulator.samples.map((sample) => sample.runtimeCpuNs)), 1_000_000),
      runtimePeakRssBytes: quartiles(accumulator.samples.map((sample) => sample.runtimePeakRssBytes)),
      compilerPeakRssBytes: quartiles(accumulator.samples.map((sample) => sample.compilerPeakRssBytes)),
      clangPeakRssBytes: quartiles(accumulator.samples.map((sample) => sample.clangPeakRssBytes)),
      totalBuildWallMs: quartiles(accumulator.samples.map((sample) => sample.compilePhasesMs.totalBuildWallMs)),
      compilePhasesMs,
    },
  };
}

export function validateResultDocument(value: unknown): void {
  const result = requireRecord(value, "result");
  if (result.schemaVersion !== PORFFOR_DIRECT_AB_SCHEMA_VERSION) throw new Error("result schema version changed");
  const capture = requireRecord(result.capture, "capture");
  const fixture = requireRecord(result.fixture, "fixture");
  const methodology = requireRecord(result.methodology, "methodology");
  const rows = requireArray(result.rows, "rows");
  if (capture.mode !== "optimized" && capture.mode !== "sanitize") throw new Error("result capture mode is invalid");
  if (rows.length !== PORFFOR_DIRECT_AB_ROWS.length) throw new Error("result must contain exactly four rows");
  const expectedWarmups = requireNonnegativeInteger(methodology.warmupRounds, "warmupRounds");
  const expectedSamples = requirePositiveInteger(methodology.measuredRounds, "measuredRounds");
  const expectedIterations = requirePositiveInteger(fixture.iterations, "fixture.iterations");
  const oracle = requireRecord(fixture.oracle, "fixture.oracle");
  const expectedChecksum = String(checksumForIterations(expectedIterations));
  if (oracle.checksumDecimal !== expectedChecksum) throw new Error("result oracle checksum is inconsistent");
  const seen = new Set<string>();
  for (const [index, rowValue] of rows.entries()) {
    const row = requireRecord(rowValue, `rows[${index}]`);
    const expectedId = PORFFOR_DIRECT_AB_ROWS[index]!;
    if (row.id !== expectedId || seen.has(String(row.id))) throw new Error(`row order/id mismatch at ${index}`);
    seen.add(String(row.id));
    if (row.sourceSha256 !== fixture.sha256) throw new Error(`row ${row.id} source SHA differs from fixture`);
    const directRow = expectedId === "direct-porffor-gc" || expectedId === "direct-porffor-bump";
    const safety = requireRecord(row.safety, `${row.id}.safety`);
    const validity = requireRecord(row.validity, `${row.id}.validity`);
    if (directRow) {
      const finding = requireRecord(safety.finding, `${row.id}.safety.finding`);
      if (
        safety.generatedC !== "plain-pinned-porffor" ||
        safety.sanitizerExpectation !== "misaligned-object-entry-ubsan" ||
        validity.performanceAuthority !== "ub-contaminated-non-authoritative" ||
        validity.knownUndefinedBehavior !== true ||
        finding.kind !== "misaligned-dynamic-object-f64"
      ) {
        throw new Error(`direct row ${row.id} hides or weakens its known plain-Porffor UB`);
      }
    } else if (
      safety.generatedC !== "js2-porffor-ir" ||
      safety.sanitizerExpectation !== "clean" ||
      validity.performanceAuthority !== "within-machine-informational" ||
      validity.knownUndefinedBehavior !== false ||
      safety.finding !== null
    ) {
      throw new Error(`JS2 row ${row.id} weakens its sanitizer-clean contract`);
    }
    const warmups = requireArray(row.warmups, `${row.id}.warmups`);
    const samples = requireArray(row.samples, `${row.id}.samples`);
    if (warmups.length !== expectedWarmups || samples.length !== expectedSamples) {
      throw new Error(`row ${row.id} sample count mismatch`);
    }
    for (const sampleValue of [...warmups, ...samples]) {
      const sample = requireRecord(sampleValue, `${row.id}.sample`);
      if (capture.mode === "sanitize") {
        if (sample.iterationsAttempted !== expectedIterations) {
          throw new Error(`row ${row.id} sanitizer iteration count mismatch`);
        }
        if (directRow) {
          if (
            sample.verdict !== "expected-ubsan-failure" ||
            sample.expectedFailure !== true ||
            sample.processStatus === 0 ||
            sample.diagnosticKind !== "misaligned-dynamic-object-f64" ||
            typeof sample.diagnosticLine !== "string" ||
            !sample.diagnosticLine.includes("misaligned address") ||
            sample.checksumDecimal !== null ||
            sample.fixedOutputs !== null
          ) {
            throw new Error(`direct row ${row.id} did not reproduce the exact expected UBSan failure`);
          }
        } else if (
          sample.verdict !== "clean" ||
          sample.expectedFailure !== false ||
          sample.processStatus !== 0 ||
          sample.diagnosticKind !== null ||
          sample.checksumDecimal !== expectedChecksum ||
          JSON.stringify(sample.fixedOutputs) !== JSON.stringify(PORFFOR_DIRECT_AB_EXPECTED_FIXED)
        ) {
          throw new Error(`JS2 row ${row.id} was not sanitizer-clean with exact oracle output`);
        }
      } else {
        if (sample.iterations !== expectedIterations || sample.checksumDecimal !== expectedChecksum) {
          throw new Error(`row ${row.id} native checksum/iteration mismatch`);
        }
        if (JSON.stringify(sample.fixedOutputs) !== JSON.stringify(PORFFOR_DIRECT_AB_EXPECTED_FIXED)) {
          throw new Error(`row ${row.id} fixed outputs differ from the oracle`);
        }
      }
    }
  }
  if (capture.mode === "optimized") {
    if (
      expectedWarmups !== PORFFOR_DIRECT_AB_WARMUP_ROUNDS ||
      expectedSamples !== PORFFOR_DIRECT_AB_MEASURED_ROUNDS ||
      expectedIterations !== PORFFOR_DIRECT_AB_ITERATIONS
    ) {
      throw new Error("optimized result does not contain the fixed complete experiment");
    }
  }
  if (capture.canonical === true) {
    const environment = requireRecord(result.environment, "environment");
    if (
      environment.os !== "linux" ||
      environment.arch !== "x64" ||
      capture.label !== "canonical-ubuntu-x64-workflow-dispatch"
    ) {
      throw new Error("canonical result is not the declared Ubuntu x64 workflow capture");
    }
  }
  const interpretation = requireRecord(result.interpretation, "interpretation");
  if (
    JSON.stringify(interpretation.policyIsolationPair) !==
      JSON.stringify(["js2-porffor-arena-v1", "js2-porffor-analysis-stack-arena-v1"]) ||
    interpretation.onlyPolicyIsolatingComparison !== true ||
    typeof interpretation.directPlainPorfforSafety !== "string" ||
    !interpretation.directPlainPorfforSafety.includes("UB-contaminated and non-authoritative")
  ) {
    throw new Error("result weakens the policy-isolation caveat");
  }
}

function renderMarkdown(result: ReturnType<typeof buildResultDocument>): string {
  if (result.capture.mode === "sanitize") return renderSanitizerMarkdown(result);
  const warning = result.capture.canonical
    ? "This is the canonical Ubuntu x86_64 workflow-dispatch capture. Runtime magnitudes remain informational, not thresholds."
    : `This is a **clearly noncanonical ${result.environment.os}/${result.environment.arch} local capture**. Do not compare these numbers with another machine or claim cross-machine ratios.`;
  const resultRows = result.rows
    .map((row) => {
      const summary = row.summary;
      if (!summary) throw new Error(`optimized row ${row.id} unexpectedly lacks a summary`);
      const cpu = summary.runtimeCpuMs;
      const rss = summary.runtimePeakRssBytes;
      const build = summary.totalBuildWallMs;
      return `| \`${row.id}\` | ${row.valueAbi} | ${row.allocation.policy} | ${row.validity.performanceAuthority} | ${fmt(cpu.q1)} / ${fmt(cpu.median)} / ${fmt(cpu.q3)} | ${fmtBytes(rss.q1)} / ${fmtBytes(rss.median)} / ${fmtBytes(rss.q3)} | ${fmt(build.q1)} / ${fmt(build.median)} / ${fmt(build.q3)} |`;
    })
    .join("\n");
  const artifactRows = result.rows
    .map(
      (row) =>
        `| \`${row.id}\` | ${row.artifacts.renderedCBytes} | ${row.artifacts.wrapperBytes} | ${row.artifacts.objectBytes} | ${row.artifacts.executableBytes} | \`${row.artifacts.renderedCSha256}\` | \`${row.artifacts.cSha256}\` |`,
    )
    .join("\n");
  const phaseRows = result.rows
    .map((row) => {
      if (!row.summary) throw new Error(`optimized row ${row.id} unexpectedly lacks phase summaries`);
      const phases = row.summary.compilePhasesMs;
      const pick = (name: string) => {
        const q = phases[name] as { q1: number; median: number; q3: number } | null | undefined;
        return q ? `${fmt(q.q1)} / ${fmt(q.median)} / ${fmt(q.q3)}` : "n/a";
      };
      return `| \`${row.id}\` | ${pick("porfforParseMs")} | ${pick("porfforCodegenMs")} | ${pick("js2SourceToLinearTelemetryMs")} | ${pick("js2IrToPorfforMs")} | ${pick("porfforRenderMs")} | ${pick("clangCompileMs")} | ${pick("clangLinkMs")} |`;
    })
    .join("\n");
  return `# Direct Porffor vs JS2 typed-SSA/shared-plan Porffor IR A/B

> ${warning}

Generated ${result.generatedAt} from repository commit \`${result.repository.commit}\`. The exact checked-in fixture is \`${result.fixture.path}\` (${result.fixture.bytes} bytes, SHA-256 \`${result.fixture.sha256}\`). Its ${result.fixture.iterations.toLocaleString("en-US")} calls produce checksum \`${result.fixture.oracle.checksumDecimal}\` in Node and every native sample.

> **Safety boundary:** both direct rows preserve plain pinned Porffor C and reproducibly fail UBSan on misaligned dynamic-object \`f64\` accesses. Their optimized values below are UB-contaminated and non-authoritative. The JS2 rows are sanitizer-clean.

## Method

- Capture: \`${result.capture.label}\`; workflow run: ${result.capture.workflowRunUrl ?? "none (local capture)"}.
- ${result.methodology.warmupRounds} complete warmup rounds, then ${result.methodology.measuredRounds} complete cyclically interleaved measured rounds.
- Every sample uses a fresh compiler worker, freshly compiled lane object, fresh link, and fresh native process.
- CPU time is \`CLOCK_PROCESS_CPUTIME_ID\`; RSS is whole-process high-water RSS. Q1/median/Q3 use R-7.
- Compile flags: \`${result.methodology.compileFlags.join(" ")}\`.
- Link flags: \`${result.methodology.linkFlags.join(" ")}\`.
- The same separately compiled harness object is linked into all four rows; LTO, \`porf native\`, and \`-march=native\` are absent.

## Runtime and build summaries

All triplets are Q1 / median / Q3. CPU/build values are milliseconds.

| Row | Value ABI | Allocation | Authority | CPU ms | Runtime RSS | Total build ms |
| --- | --- | --- | --- | ---: | ---: | ---: |
${resultRows}

## Compile phases

The JS2 source-to-linear-telemetry phase includes production linear-Wasm emission. It is not presented as a pure front-end timer.

| Row | Direct parse | Direct codegen | JS2 source→linear telemetry | JS2 IR→Porffor | Porffor render | Clang compile | Clang link |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${phaseRows}

## Artifact sizes and hashes

| Row | Rendered C B | Wrapper B | Object B | Executable B | Rendered C SHA-256 | Combined C SHA-256 |
| --- | ---: | ---: | ---: | ---: | --- | --- |
${artifactRows}

## Interpretation boundary

The direct rows use ordinary TypeScript numbers boxed as Porffor \`jsval\`, including two asserted hidden call slots, dynamic objects of approximately 56 bytes, and a global GC-or-bump policy. Their 20-byte entry stride places the second \`f64\` payload at byte offset 28, violating its 8-byte alignment; the generated raw loads/stores are deliberately not repaired. The JS2 rows use a raw \`f64\` boundary, 24-byte fixed records (8-byte header plus two \`f64\` fields), and per-site escape-based stack promotion. Therefore direct-vs-JS2 conflates front end, value ABI, layout, generated IR, allocator, and known direct undefined behavior. **Only \`js2-porffor-arena-v1\` versus \`js2-porffor-analysis-stack-arena-v1\` isolates allocation policy.**

#3300 remains the hand-built-IR policy proof; its source paths and compile timing differ, so it is not evidence for this direct compiler A/B.

The complete raw warmups, all measured samples, actual interleave order, environment, and command provenance are in [latest.json](./latest.json). Representative C, wrappers, objects, executables, and logs are retained in the workflow/local artifact directory.
`;
}

function renderSanitizerMarkdown(result: ReturnType<typeof buildResultDocument>): string {
  const rows = result.rows
    .map((row) => {
      const sample = row.samples[0];
      if (!sample || !("verdict" in sample)) throw new Error(`sanitizer row ${row.id} lacks its verdict`);
      return `| \`${row.id}\` | ${sample.verdict} | ${sample.processStatus} | ${sample.diagnosticLine ?? "none"} | ${sample.checksumDecimal ?? "not reached"} | \`${row.artifacts.renderedCSha256}\` | \`${sample.stderrSha256}\` |`;
    })
    .join("\n");
  return `# Direct Porffor / JS2 sanitizer evidence

Generated ${result.generatedAt} from \`${result.repository.commit}\` using the exact fixture SHA-256 \`${result.fixture.sha256}\`.

The direct rows are **expected safety failures, not skips**: plain pinned Porffor uses a 20-byte dynamic-object entry stride and an 8-byte \`f64\` payload, so the second payload is at byte offset 28 and is misaligned. UBSan must report that finding. Both JS2 rows must complete sanitizer-clean with fixed outputs \`${JSON.stringify(PORFFOR_DIRECT_AB_EXPECTED_FIXED)}\` and checksum \`${result.fixture.oracle.checksumDecimal}\`.

| Row | Verdict | Exit status | Diagnostic | Checksum | Rendered C SHA-256 | stderr SHA-256 |
| --- | --- | ---: | --- | ---: | --- | --- |
${rows}

The raw stderr/stdout and exact argv are retained in \`logs/\` and \`commands.json\`; representative plain generated C is retained under \`representative/<row>/rendered.c\`.
`;
}

function readWorkerManifest(
  path: string,
  rowId: PorfforDirectAbRowId,
  mode: PorfforDirectAbMode,
  sourceSha: string,
): WorkerManifest {
  const value = JSON.parse(readFileSync(path, "utf8")) as WorkerManifest;
  if (
    value.schemaVersion !== PORFFOR_DIRECT_AB_SCHEMA_VERSION ||
    value.rowId !== rowId ||
    value.mode !== mode ||
    value.source.sha256 !== sourceSha ||
    value.source.bytes <= 0
  ) {
    throw new Error(`invalid worker manifest for ${rowId}`);
  }
  return value;
}

function runOracle(sourcePath: string): OracleRecord {
  const result = runPlainCommand(process.execPath, [
    "--experimental-strip-types",
    resolve("scripts/porffor-direct-ab-node-oracle.mjs"),
    "--source",
    sourcePath,
  ]);
  return JSON.parse(result.stdout) as OracleRecord;
}

function assertOracle(oracle: OracleRecord, sourceSha: string, sourceBytes: number, iterations: number): void {
  if (
    oracle.sourceSha256 !== sourceSha ||
    oracle.sourceBytes !== sourceBytes ||
    oracle.function !== PORFFOR_DIRECT_AB_FUNCTION ||
    JSON.stringify(oracle.fixedOutputs) !== JSON.stringify(PORFFOR_DIRECT_AB_EXPECTED_FIXED) ||
    oracle.iterations !== PORFFOR_DIRECT_AB_ITERATIONS ||
    oracle.checksumDecimal !== String(PORFFOR_DIRECT_AB_EXPECTED_CHECKSUM)
  ) {
    throw new Error(`Node oracle changed: ${JSON.stringify(oracle)}`);
  }
  const expected = checksumForIterations(iterations);
  if (
    (iterations === PORFFOR_DIRECT_AB_ITERATIONS && expected !== PORFFOR_DIRECT_AB_EXPECTED_CHECKSUM) ||
    (iterations === PORFFOR_DIRECT_AB_SANITIZER_ITERATIONS &&
      expected !== PORFFOR_DIRECT_AB_EXPECTED_SANITIZER_CHECKSUM)
  ) {
    throw new Error(`bounded checksum helper changed for ${iterations} iterations`);
  }
}

function parseNativeOutput(stdout: string): NativeOutput {
  const lines = stdout.trim().split("\n");
  if (lines.length !== 1) throw new Error(`native lane must print exactly one JSON record, received ${stdout}`);
  return JSON.parse(lines[0]!) as NativeOutput;
}

function assertNativeOutput(native: NativeOutput, oracle: OracleRecord, iterations: number): void {
  if (
    native.iterations !== iterations ||
    !Number.isSafeInteger(native.runtimeCpuNs) ||
    native.runtimeCpuNs <= 0 ||
    !Number.isSafeInteger(native.peakRssBytes) ||
    native.peakRssBytes <= 0 ||
    JSON.stringify(native.fixedOutputs) !== JSON.stringify(oracle.fixedOutputs) ||
    native.checksumDecimal !== String(checksumForIterations(iterations))
  ) {
    throw new Error(`native row failed the exact oracle: ${JSON.stringify(native)}`);
  }
}

function assertExpectedDirectSanitizerFailure(executed: TimedResult, rowId: PorfforDirectAbRowId): string {
  if (executed.status === 0)
    throw new Error(`${rowId} unexpectedly became sanitizer-clean; update the safety contract`);
  const diagnosticLine = executed.stderr
    .split("\n")
    .find((line) => line.includes("runtime error:") && line.includes("misaligned address"));
  if (!diagnosticLine || !/(?:load of|store to) misaligned address/.test(diagnosticLine)) {
    throw new Error(
      `${rowId} failed for a reason other than the pinned misaligned dynamic-object f64 access:\n${executed.stderr}`,
    );
  }
  return diagnosticLine.trim();
}

function compileFlagsFor(mode: PorfforDirectAbMode, iterations: number): readonly string[] {
  const common = ["-std=gnu11", `-DJS2_AB_ITERATIONS=${iterations}`, "-fno-lto", "-Werror", "-Wno-unused-function"];
  return mode === "optimized"
    ? ["-O3", "-DNDEBUG", ...common, "-ffunction-sections", "-fdata-sections", "-c"]
    : ["-O1", "-g", ...common, "-fsanitize=address,undefined", "-fno-omit-frame-pointer", "-c"];
}

function linkFlagsFor(mode: PorfforDirectAbMode): readonly string[] {
  if (mode === "sanitize") {
    return ["-O1", "-g", "-fno-lto", "-fsanitize=address,undefined", "-fno-omit-frame-pointer"];
  }
  return ["-O3", "-fno-lto", platform() === "darwin" ? "-Wl,-dead_strip" : "-Wl,--gc-sections"];
}

function runTimedCommand(command: string, args: readonly string[]): TimedResult {
  const timeArgs = platform() === "darwin" ? ["-l", command, ...args] : ["-v", command, ...args];
  const result = runPlainCommand("/usr/bin/time", timeArgs);
  const match =
    platform() === "darwin"
      ? /\s*(\d+)\s+maximum resident set size/.exec(result.stderr)
      : /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(result.stderr);
  if (!match) throw new Error(`could not parse child RSS from /usr/bin/time:\n${result.stderr}`);
  return {
    ...result,
    argv: ["/usr/bin/time", ...timeArgs],
    peakRssBytes: Number(match[1]) * (platform() === "darwin" ? 1 : 1024),
  };
}

function runPlainCommand(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  allowFailure = false,
): TimedResult {
  const started = performance.now();
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  const wallMs = performance.now() - started;
  const status = result.status ?? -1;
  if (status !== 0 && !allowFailure) {
    throw new Error(`command failed (${status}): ${[command, ...args].join(" ")}\n${result.stdout}\n${result.stderr}`);
  }
  return {
    wallMs,
    peakRssBytes: 0,
    stdout: result.stdout,
    stderr: result.stderr,
    status,
    signal: result.signal,
    argv: [command, ...args],
  };
}

function logCommand(
  phase: string,
  result: TimedResult,
  logsDirectory: string,
  rowId?: PorfforDirectAbRowId,
  samplePhase?: "warmup" | "measured",
  round?: number,
): CommandRecord {
  const stem = [phase, samplePhase, round === undefined ? undefined : String(round).padStart(2, "0"), rowId]
    .filter(Boolean)
    .join("-");
  const stdoutLog = join(logsDirectory, `${stem}.stdout.log`);
  const stderrLog = join(logsDirectory, `${stem}.stderr.log`);
  writeFileSync(stdoutLog, result.stdout);
  writeFileSync(stderrLog, result.stderr);
  return {
    phase,
    ...(rowId ? { rowId } : {}),
    ...(samplePhase ? { samplePhase } : {}),
    ...(round === undefined ? {} : { round }),
    argv: result.argv,
    cwd: repoRoot,
    wallMs: result.wallMs,
    ...(result.peakRssBytes > 0 ? { peakRssBytes: result.peakRssBytes } : {}),
    status: result.status,
    signal: result.signal,
    stdoutLog: relative(repoRoot, stdoutLog),
    stderrLog: relative(repoRoot, stderrLog),
  };
}

function nativeEnvironment(mode: PorfforDirectAbMode): NodeJS.ProcessEnv {
  return mode === "sanitize"
    ? {
        ...process.env,
        ASAN_OPTIONS: "detect_leaks=0:halt_on_error=1:abort_on_error=1",
        UBSAN_OPTIONS: "halt_on_error=1:print_stacktrace=1",
      }
    : process.env;
}

function copyRepresentative(
  sampleDirectory: string,
  root: string,
  rowId: PorfforDirectAbRowId,
  manifest: WorkerManifest,
  objectPath: string,
  executablePath: string,
): void {
  const destination = join(root, rowId);
  mkdirSync(destination, { recursive: true });
  for (const sourceName of [
    manifest.outputFiles.renderedC,
    manifest.outputFiles.wrapperC,
    manifest.outputFiles.laneC,
    "worker.json",
  ]) {
    copyFileSync(join(sampleDirectory, sourceName), join(destination, basename(sourceName)));
  }
  copyFileSync(objectPath, join(destination, "lane.o"));
  copyFileSync(executablePath, join(destination, "lane"));
}

function partialProgress(
  options: BenchmarkArguments,
  orders: readonly unknown[],
  rows: ReadonlyMap<PorfforDirectAbRowId, RowAccumulator>,
) {
  return {
    schemaVersion: PORFFOR_DIRECT_AB_SCHEMA_VERSION,
    incomplete: true,
    mode: options.mode,
    methodology: {
      warmupRounds: options.warmupRounds,
      measuredRounds: options.measuredRounds,
      iterations: options.iterations,
      acceptedInterleaveOrders: orders,
    },
    rows: PORFFOR_DIRECT_AB_ROWS.map((id) => ({
      id,
      acceptedWarmups: options.mode === "sanitize" ? rows.get(id)!.sanitizerWarmups : rows.get(id)!.warmups,
      acceptedSamples: options.mode === "sanitize" ? rows.get(id)!.sanitizerSamples : rows.get(id)!.samples,
    })),
  };
}

function environmentRecord(clangPath: string, porfforCommit: string) {
  return {
    os: platform(),
    arch: arch(),
    release: release(),
    cpu: cpus()[0]?.model ?? "unknown",
    cpuCount: cpus().length,
    node: process.version,
    pnpm: execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim(),
    clang: {
      path: clangPath,
      version: execFileSync(clangPath, ["--version"], { encoding: "utf8" }).trim(),
    },
    porfforCommit,
    porfforExpectedCommit: PORFFOR_IR_COMMIT,
  };
}

function cyclicOrder(round: number): readonly PorfforDirectAbRowId[] {
  const shift = round % PORFFOR_DIRECT_AB_ROWS.length;
  return [...PORFFOR_DIRECT_AB_ROWS.slice(shift), ...PORFFOR_DIRECT_AB_ROWS.slice(0, shift)];
}

function scaleQuartiles(
  values: { readonly q1: number; readonly median: number; readonly q3: number },
  divisor: number,
) {
  return { q1: values.q1 / divisor, median: values.median / divisor, q3: values.q3 / divisor };
}

function assertAncestor(ancestor: string, descendant: string, label: string): void {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd: repoRoot });
  if (result.status !== 0) throw new Error(`${label} ${ancestor} is not an ancestor of ${descendant}`);
}

function git(args: readonly string[]): string {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function commandPath(command: string): string {
  const path = execFileSync("which", [command], { encoding: "utf8" }).trim();
  if (!path) throw new Error(`${command} is required`);
  return path;
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value;
}

function requirePositiveInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) <= 0) throw new Error(`${path} must be a positive integer`);
  return Number(value);
}

function requireNonnegativeInteger(value: unknown, path: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${path} must be a nonnegative integer`);
  return Number(value);
}

function parsePositiveInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value) || Number(value) <= 0) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function parseNonnegativeInteger(value: string, label: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`${label} must be a nonnegative integer`);
  return Number(value);
}

function fmt(value: number): string {
  return value.toFixed(3);
}

function fmtBytes(value: number): string {
  return `${(value / (1024 * 1024)).toFixed(2)} MiB`;
}

function benchmarkUsage(): string {
  return (
    "usage: benchmark-porffor-direct-ab.mts [--output <dir>] [--mode optimized|sanitize] " +
    "[--warmup-rounds N --measured-rounds N --iterations N] [--allow-dirty] [--canonical-ubuntu] " +
    "or --validate-result <latest.json>"
  );
}
