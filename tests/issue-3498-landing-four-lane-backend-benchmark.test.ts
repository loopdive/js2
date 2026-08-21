// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import {
  CAPTURE_CONFIGURATION,
  LANDING_FOUR_LANE_RUSTC_VERSION,
  assertLandingCaptureRustcVersion,
  validatePartialSampleSets,
} from "../scripts/benchmark-landing-four-lane.mjs";
import { LANDING_BENCHMARK_PROGRAMS } from "../scripts/lib/landing-benchmark-corpus.mjs";
import {
  LANDING_FOUR_LANE_IDS,
  LANDING_FOUR_LANE_MEASURED_ROUNDS,
  LANDING_FOUR_LANE_WARMUP_ROUNDS,
  classifyLandingSanitizerExecution,
  landingFourLaneExpectedOrder,
  validateLandingFourLaneResult,
  verifyLandingBenchmarkCorpus,
  type LandingFourLaneResult,
} from "../scripts/lib/landing-four-lane-benchmark.mjs";
import {
  LANDING_FOUR_LANE_INNER_MEASURED_CALLS,
  LANDING_FOUR_LANE_INNER_WARMUP_CALLS,
  landingFourLaneWasmtimeMedianWarmDriverSource,
} from "../scripts/lib/landing-wasmtime-runtime.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "js2-3498-"));
const coreOutput = join(temporaryRoot, "core");
const configuredOutput = process.env.LANDING_FOUR_LANE_TEST_OUTPUT;
const fullOutput = configuredOutput ? resolve(repoRoot, configuredOutput) : join(temporaryRoot, "full");
const toolchainsRequired = process.env.LANDING_FOUR_LANE_REQUIRED === "1";
const coreAvailable =
  existsSync(resolve(repoRoot, "node_modules/.bin/wasm-opt")) &&
  spawnSync("wasmtime", ["--version"], { cwd: repoRoot, stdio: "ignore" }).status === 0;
const nativeAvailable =
  coreAvailable &&
  existsSync(resolve(repoRoot, "vendor/Porffor/porf")) &&
  spawnSync(process.env.CC || "clang", ["--version"], { cwd: repoRoot, stdio: "ignore" }).status === 0;
const coreIt = coreAvailable || toolchainsRequired ? it : it.skip;
const nativeIt = nativeAvailable || toolchainsRequired ? it : it.skip;

let coreResult: LandingFourLaneResult | undefined;

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

describe("#3498 landing four-lane backend benchmark", () => {
  it("pins and oracles the four exact landing source files without object-ops", async () => {
    expect(LANDING_BENCHMARK_PROGRAMS.map((program) => program.id)).toEqual([
      "fib",
      "fib-recursive",
      "array-sum",
      "string-hash",
    ]);
    const records = await verifyLandingBenchmarkCorpus(repoRoot);
    expect(records).toMatchObject([
      {
        id: "fib",
        bytes: 348,
        sha256: "910ab9ef86bf7ed4c6b7e55c0fe20d93b653dd8bfdb5d48de6ef906778943a73",
        fixedInputs: [0, 1, 5_000, 20_000_000],
        expectedFixedOutputs: [0, 1, -1_846_256_875, -1_821_818_939],
      },
      {
        id: "fib-recursive",
        bytes: 361,
        sha256: "f1b64fb81a182f38cf8ebdc8f39bded7e9878d516f714fb046a8a1b15d0ba916",
        fixedInputs: [0, 1, 10, 30],
        expectedFixedOutputs: [0, 1, 55, 832_040],
      },
      {
        id: "array-sum",
        bytes: 441,
        sha256: "61affa6e44688788cfdb50f5186078cb55c171f19df2bb104e2dcb9f331cd59c",
        fixedInputs: [0, 1, 2_000, 1_000_000],
        expectedFixedOutputs: [0, 0, 1_018_392, 511_492_320],
      },
      {
        id: "string-hash",
        bytes: 601,
        sha256: "66a15148fdd960dcbe5d87c25a28d870e8db9d00865483d708f0ca4e6e6e335c",
        fixedInputs: [0, 1, 100, 20_000],
        expectedFixedOutputs: [0, 96_500, 36_729_899, 862_771_296],
      },
    ]);
    for (const program of LANDING_BENCHMARK_PROGRAMS) {
      expect(program.sourcePath).toBe(`website/public/benchmarks/competitive/programs/${program.id}.js`);
      expect(program.id).not.toBe("object-ops");
    }
    expect(readFileSync(resolve(repoRoot, "scripts/generate-wasmtime-hot-runtime.mjs"), "utf8")).toContain(
      'from "./lib/landing-benchmark-corpus.mjs"',
    );
  });

  coreIt(
    "executes exact V8 and JS2-Wasm outputs for all four kernels",
    async () => {
      if (!coreAvailable) throw new Error("LANDING_FOUR_LANE_REQUIRED=1 but Wasmtime/wasm-opt are unavailable");
      coreResult = await runProbe(coreOutput, true);
      expect(coreResult.cells).toHaveLength(16);
      expect(coreResult.cells.map((cell) => `${cell.programId}:${cell.laneId}`)).toEqual(
        LANDING_BENCHMARK_PROGRAMS.flatMap((program) => LANDING_FOUR_LANE_IDS.map((lane) => `${program.id}:${lane}`)),
      );
      for (const program of coreResult.programs) {
        for (const laneId of ["v8-node-exact-source", "js2-wasmgc-wasmtime-cranelift"] as const) {
          const cell = coreResult.cells.find(
            (candidate) => candidate.programId === program.id && candidate.laneId === laneId,
          );
          expect(cell).toMatchObject({ status: "supported", sourceSha256: program.sha256, diagnostic: null });
          expect(cell?.validation?.actualOutputs).toEqual(program.expectedFixedOutputs);
        }
      }
    },
    60_000,
  );

  coreIt("rejects source substitution, omission, output drift, skipped success, and invalid timing", async () => {
    if (!coreAvailable) throw new Error("LANDING_FOUR_LANE_REQUIRED=1 but Wasmtime/wasm-opt are unavailable");
    coreResult ??= await runProbe(coreOutput, true);
    validateLandingFourLaneResult(coreResult);

    const substituted = clone(coreResult);
    substituted.cells[0]!.sourceSha256 = "0".repeat(64);
    expect(() => validateLandingFourLaneResult(substituted)).toThrow(/substituted/);

    const omitted = clone(coreResult);
    omitted.cells.pop();
    expect(() => validateLandingFourLaneResult(omitted)).toThrow(/16 support cells/);

    const wrongOutput = clone(coreResult);
    wrongOutput.cells[0]!.validation!.actualOutputs[0] = 123;
    expect(() => validateLandingFourLaneResult(wrongOutput)).toThrow(/actual outputs mismatch/);

    const skipped = clone(coreResult);
    skipped.cells[0]!.provenance = { outcome: "skipped success" };
    expect(() => validateLandingFourLaneResult(skipped)).toThrow(/skipped is not/);

    const zeroTiming = clone(coreResult);
    zeroTiming.cells[0]!.measurements.build = {
      reason: null,
      samples: [
        {
          phase: "measured",
          round: 0,
          order: 0,
          wallNs: 0,
          cpuNs: 0,
          peakRssBytes: 0,
          validatedOutput: null,
          outputObservation: null,
          commands: [["false-success"]],
        },
      ],
    };
    expect(() => validateLandingFourLaneResult(zeroTiming)).toThrow(/wallNs invalid/);

    const nullBenchmark = clone(coreResult);
    nullBenchmark.capture = {
      kind: "benchmark",
      canonical: false,
      warmupRounds: LANDING_FOUR_LANE_WARMUP_ROUNDS,
      measuredRounds: LANDING_FOUR_LANE_MEASURED_ROUNDS,
      fingerprint: { algorithm: "sha256", digest: "a".repeat(64), inputs: { fixture: true } },
      environment: coreResult.capture.environment,
    };
    expect(() => validateLandingFourLaneResult(nullBenchmark)).toThrow(
      /executable benchmark cell must carry timing samples/,
    );

    const completeBenchmark = clone(coreResult);
    completeBenchmark.capture = nullBenchmark.capture;
    const executableCells = completeBenchmark.cells.filter((cell: any) => cell.status !== "unsupported");
    for (const [canonicalCellIndex, cell] of executableCells.entries()) {
      const program = completeBenchmark.programs.find((candidate: any) => candidate.id === cell.programId)!;
      for (const [phaseIndex, phase] of (["build", "startup", "cold", "warm"] as const).entries()) {
        cell.measurements[phase] = {
          reason: null,
          samples: Array.from(
            { length: LANDING_FOUR_LANE_WARMUP_ROUNDS + LANDING_FOUR_LANE_MEASURED_ROUNDS },
            (_, round) => ({
              phase: round < LANDING_FOUR_LANE_WARMUP_ROUNDS ? "warmup" : "measured",
              round,
              order: landingFourLaneExpectedOrder(canonicalCellIndex, phaseIndex, round, executableCells.length),
              wallNs: 1_000 + round,
              cpuNs: 900 + round,
              peakRssBytes: 4_096,
              validatedOutput: phase === "build" ? null : program.expectedFixedOutputs[3],
              outputObservation: phase === "build" ? null : { commandIndex: 0, mechanism: "stdout-json" },
              commands: [["synthetic-schema-fixture", phase, String(round)]],
            }),
          ),
        };
      }
    }
    expect(() => validateLandingFourLaneResult(completeBenchmark)).not.toThrow();

    const wrongRotation = clone(completeBenchmark);
    const rotatedCells = wrongRotation.cells.filter((cell: any) => cell.status !== "unsupported");
    const firstOrder = rotatedCells[0].measurements.build.samples[0].order;
    rotatedCells[0].measurements.build.samples[0].order = rotatedCells[1].measurements.build.samples[0].order;
    rotatedCells[1].measurements.build.samples[0].order = firstOrder;
    expect(() => validateLandingFourLaneResult(wrongRotation)).toThrow(/does not match rotation/);

    const syntheticOutput = clone(completeBenchmark);
    const wasmCold = syntheticOutput.cells.find(
      (cell: any) => cell.programId === "fib" && cell.laneId === "js2-wasmgc-wasmtime-cranelift",
    );
    wasmCold.measurements.cold.samples[0].outputObservation = null;
    expect(() => validateLandingFourLaneResult(syntheticOutput)).toThrow(/outputObservation must be an object/);
  });

  it("keeps the manual canonical workflow in real benchmark mode", () => {
    const workflow = readFileSync(resolve(repoRoot, ".github/workflows/landing-four-lane-backend.yml"), "utf8");
    const runner = readFileSync(resolve(repoRoot, "scripts/benchmark-landing-four-lane.mts"), "utf8");
    expect(workflow.match(/^ {8}run: pnpm run benchmark:landing-four-lane.*$/gm)).toEqual([
      "        run: pnpm run benchmark:landing-four-lane --benchmark --canonical-ubuntu --output .tmp/landing-four-lane-canonical",
      "        run: pnpm run benchmark:landing-four-lane --validate-result .tmp/landing-four-lane-canonical/latest.json",
    ]);
    expect(workflow).not.toContain("--probe --canonical-ubuntu");
    expect(workflow).toContain('"benchmarks/wasmtime-cold-host/**"');
    expect(workflow).toContain('"scripts/wasmtime-bench-child-js.mjs"');
    expect(workflow.match(/timeout-minutes: 90/g)).toHaveLength(2);
    expect(workflow.match(/runs-on: ubuntu-24\.04/g)).toHaveLength(2);
    expect(workflow.match(/node-version: "25\.7\.0"/g)).toHaveLength(2);
    expect(workflow).toContain('RUST_TOOLCHAIN_VERSION: "1.94.1"');
    expect(
      workflow.match(/rustup toolchain install "\$RUST_TOOLCHAIN_VERSION" --profile minimal --no-self-update/g),
    ).toHaveLength(2);
    expect(workflow.match(/RUSTUP_TOOLCHAIN=\$RUST_TOOLCHAIN_VERSION/g)).toHaveLength(2);
    expect(workflow).toContain('WASMTIME_VERSION: "46.0.1"');
    const coldHostManifest = readFileSync(resolve(repoRoot, "benchmarks/wasmtime-cold-host/Cargo.toml"), "utf8");
    expect(coldHostManifest).toContain('rust-version = "1.94"');
    expect(coldHostManifest).toContain('wasmtime = "=46.0.1"');
    expect(readFileSync(resolve(repoRoot, "benchmarks/wasmtime-cold-host/src/main.rs"), "utf8")).toContain(
      'println!("wasmtime {}", wasmtime_environ::VERSION)',
    );
    expect(runner).toContain('mkdtempSync(join(tmpdir(), "js2-3498-wasmtime-cold-host-")');
    expect(runner).toContain("rmSync(setup.coldHostTemporaryDirectory, { recursive: true, force: true })");
    expect(runner).not.toContain('join(setupRoot, "wasmtime-cold-host-target")');
    expect(runner).toContain("artifacts: collectArtifactIdentities(cell.provenance)");
    expect(runner).toContain("compilerRepository: gitRepositoryFingerprint(repoRoot, compilerPaths)");
    expect(runner).toContain("expectedFixedOutputs: program.expectedFixedOutputs");
    expect(runner).toContain('["diff", "--binary", "--no-ext-diff", "HEAD"');
    expect(runner).toContain('["ls-files", "--others", "--exclude-standard"');
    expect(runner).toContain("Wasmtime CLI/host engine mismatch");
    expect(runner).toContain('osRelease: existsSync("/etc/os-release")');
    expect(runner).toContain("runnerImageVersion: process.env.ImageVersion");
    const setupIndex = runner.indexOf("const setup = await prepareCaptureSetup");
    const fingerprintIndex = runner.indexOf("const captureFingerprint = createCaptureFingerprint", setupIndex);
    const resumeIndex = runner.indexOf("const samples = loadPartialMeasurements", fingerprintIndex);
    expect(setupIndex).toBeGreaterThan(0);
    expect(fingerprintIndex).toBeGreaterThan(setupIndex);
    expect(resumeIndex).toBeGreaterThan(fingerprintIndex);
    expect(runner).toContain("binary: setup.coldHostBinary");
    expect(runner).toContain("rustc: setup.rustcVersion");
    expect(runner).toContain("cargo: setup.cargoVersion");
    expect(runner).toContain('RUSTC: "rustc"');
    expect(runner).toContain("RUSTUP_TOOLCHAIN: LANDING_FOUR_LANE_RUSTC_VERSION");
    expect(runner.indexOf("assertLandingCaptureRustcVersion(rustcVersion)")).toBeLessThan(
      runner.indexOf("const coldHostBuild = timedSpawnWithRss"),
    );
  });

  it("uses the same six-plus-nine median warm estimator for the Wasmtime lane", () => {
    const source = landingFourLaneWasmtimeMedianWarmDriverSource();
    expect(LANDING_FOUR_LANE_INNER_WARMUP_CALLS).toBe(6);
    expect(LANDING_FOUR_LANE_INNER_MEASURED_CALLS).toBe(9);
    expect(source.match(/const __started\d = performance\.now\(\);/g)).toHaveLength(9);
    expect(source.match(/if \(__t\d > __t\d\)/g)).toHaveLength(36);
    expect(source).toContain("return __t4;");
    expect(source).not.toContain("__best");
    expect(CAPTURE_CONFIGURATION.wasm.warmDriver).toEqual({
      warmup: LANDING_FOUR_LANE_INNER_WARMUP_CALLS,
      measured: LANDING_FOUR_LANE_INNER_MEASURED_CALLS,
      aggregation: "median",
    });
    const runner = readFileSync(resolve(repoRoot, "scripts/benchmark-landing-four-lane.mts"), "utf8");
    expect(runner).toContain("landingFourLaneWasmtimeMedianWarmDriverSource()");
    expect(runner).not.toContain("landingWasmtimeWarmDriverSource(5, 40)");
  });

  it("requires the exact Rust compiler used to build the cold host", () => {
    expect(LANDING_FOUR_LANE_RUSTC_VERSION).toBe("1.94.1");
    expect(() => assertLandingCaptureRustcVersion("rustc 1.94.1 (e408947bf 2026-03-25)\nhost: fixture")).not.toThrow();
    expect(() => assertLandingCaptureRustcVersion("rustc 1.94.0 (fixture)")).toThrow(/requires rustc 1\.94\.1/);
    expect(() => assertLandingCaptureRustcVersion("rustc 1.94.2 (fixture)")).toThrow(/requires rustc 1\.94\.1/);
  });

  it("distinguishes sanitizer findings from infrastructure failures", () => {
    expect(classifyLandingSanitizerExecution(0, "")).toBe("clean");
    expect(classifyLandingSanitizerExecution(1, "runtime error: store to misaligned address")).toBe("finding");
    expect(classifyLandingSanitizerExecution(1, "ERROR: AddressSanitizer: heap-use-after-free")).toBe("finding");
    expect(() => classifyLandingSanitizerExecution(1, "dyld: missing library")).toThrow(/infrastructure error/);
    expect(() => classifyLandingSanitizerExecution(0, "runtime error: recovered unexpectedly")).toThrow(
      /infrastructure error/,
    );
  });

  it("rejects structurally or semantically corrupt partial samples", async () => {
    const program = (await verifyLandingBenchmarkCorpus(repoRoot))[0]!;
    const cell = {
      programId: program.id,
      laneId: "v8-node-exact-source",
      sourceSha256: program.sha256,
    } as any;
    const makeSamples = () => {
      const build = Array.from(
        { length: LANDING_FOUR_LANE_WARMUP_ROUNDS + LANDING_FOUR_LANE_MEASURED_ROUNDS },
        (_, round) => ({
          phase: round < LANDING_FOUR_LANE_WARMUP_ROUNDS ? "warmup" : "measured",
          round,
          order: 0,
          wallNs: 1_000 + round,
          cpuNs: null,
          peakRssBytes: 4_096,
          validatedOutput: null,
          outputObservation: null,
          commands: [[process.execPath, "--check", resolve(repoRoot, program.sourcePath)]],
        }),
      );
      const startup = [
        {
          phase: "warmup",
          round: 0,
          order: 0,
          wallNs: 2_000,
          cpuNs: null,
          peakRssBytes: 8_192,
          validatedOutput: program.expectedFixedOutputs[3],
          outputObservation: { commandIndex: 0, mechanism: "stdout-json" },
          commands: [
            [
              process.execPath,
              resolve(repoRoot, "scripts/wasmtime-bench-child-js.mjs"),
              "--mode=single",
              resolve(repoRoot, program.sourcePath),
              String(program.runtimeArg),
            ],
          ],
        },
      ];
      return new Map([[`${program.id}:v8-node-exact-source`, { build, startup, cold: [], warm: [] }]]) as any;
    };
    const validate = (samples: any) =>
      validatePartialSampleSets(repoRoot, temporaryRoot, [program], [cell], samples, "startup", 0);
    expect(() => validate(makeSamples())).not.toThrow();

    const duplicateRound = makeSamples();
    duplicateRound.values().next().value.build[1].round = 0;
    expect(() => validate(duplicateRound)).toThrow(/unique contiguous prefix/);

    const nonpositive = makeSamples();
    nonpositive.values().next().value.build[0].wallNs = 0;
    expect(() => validate(nonpositive)).toThrow(/wallNs must be positive finite/);

    const synthetic = makeSamples();
    synthetic.values().next().value.build[0].commands = [["synthetic-schema-fixture"]];
    expect(() => validate(synthetic)).toThrow(/malformed or synthetic/);

    const wrongOracle = makeSamples();
    wrongOracle.values().next().value.startup[0].validatedOutput = 123;
    expect(() => validate(wrongOracle)).toThrow(/runtime oracle/);

    const detachedObservation = makeSamples();
    detachedObservation.values().next().value.startup[0].outputObservation.commandIndex = 1;
    expect(() => validate(detachedObservation)).toThrow(/not tied to the expected command/);

    const rotationPrograms = (await verifyLandingBenchmarkCorpus(repoRoot)).slice(0, 2);
    const rotationCells = rotationPrograms.map(
      (candidate) =>
        ({
          programId: candidate.id,
          laneId: "v8-node-exact-source",
          sourceSha256: candidate.sha256,
        }) as any,
    );
    const rotationSamples = new Map(
      rotationCells.map((candidate, canonicalCellIndex) => {
        const candidateProgram = rotationPrograms[canonicalCellIndex]!;
        const build = Array.from(
          { length: LANDING_FOUR_LANE_WARMUP_ROUNDS + LANDING_FOUR_LANE_MEASURED_ROUNDS },
          (_, round) => ({
            phase: round < LANDING_FOUR_LANE_WARMUP_ROUNDS ? "warmup" : "measured",
            round,
            order: landingFourLaneExpectedOrder(canonicalCellIndex, 0, round, rotationCells.length),
            wallNs: 1_000 + round,
            cpuNs: null,
            peakRssBytes: 4_096,
            validatedOutput: null,
            outputObservation: null,
            commands: [[process.execPath, "--check", resolve(repoRoot, candidateProgram.sourcePath)]],
          }),
        );
        return [`${candidate.programId}:v8-node-exact-source`, { build, startup: [], cold: [], warm: [] }];
      }),
    ) as any;
    expect(() =>
      validatePartialSampleSets(
        repoRoot,
        temporaryRoot,
        rotationPrograms,
        rotationCells,
        rotationSamples,
        "build",
        LANDING_FOUR_LANE_WARMUP_ROUNDS + LANDING_FOUR_LANE_MEASURED_ROUNDS - 1,
      ),
    ).not.toThrow();
    const firstRotationOrder = rotationSamples.values().next().value.build[0].order;
    const secondRotationSamples = [...rotationSamples.values()][1];
    rotationSamples.values().next().value.build[0].order = secondRotationSamples.build[0].order;
    secondRotationSamples.build[0].order = firstRotationOrder;
    expect(() =>
      validatePartialSampleSets(
        repoRoot,
        temporaryRoot,
        rotationPrograms,
        rotationCells,
        rotationSamples,
        "build",
        LANDING_FOUR_LANE_WARMUP_ROUNDS + LANDING_FOUR_LANE_MEASURED_ROUNDS - 1,
      ),
    ).toThrow(/does not match rotation/);
  });

  it("times native cold initialization plus its first call without changing warm/default setup", () => {
    const harness = readFileSync(resolve(repoRoot, "benchmarks/porffor-direct-ab-harness.c"), "utf8");
    const onceStart = harness.indexOf('strcmp(argv[1], "--landing-once")');
    const warmStart = harness.indexOf('strcmp(argv[1], "--landing-warm")');
    const onceBlock = harness.slice(onceStart, warmStart);
    expect(onceStart).toBeGreaterThan(0);
    expect(warmStart).toBeGreaterThan(onceStart);
    expect(onceBlock.indexOf("wall_started")).toBeLessThan(onceBlock.indexOf("js2_ab_init"));
    expect(onceBlock.indexOf("js2_ab_init")).toBeLessThan(onceBlock.indexOf("js2_ab_kernel"));
    expect(harness).toContain("Keep warm, correctness-probe, and default #3482 timing behavior unchanged.");
    expect(readFileSync(resolve(repoRoot, "scripts/benchmark-landing-four-lane.mts"), "utf8")).toContain(
      'cold: "native-init-plus-call-wasmtime-46-fresh-store-v3"',
    );
  });

  coreIt(
    "refuses a partial capture whose fingerprint changed",
    async () => {
      if (!coreAvailable) throw new Error("LANDING_FOUR_LANE_REQUIRED=1 but Wasmtime/wasm-opt are unavailable");
      coreResult ??= await runProbe(coreOutput, true);
      const executable = coreResult.cells.filter((cell) => cell.status !== "unsupported");
      writeFileSync(
        join(coreOutput, "partial-measurements.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          phaseMethodology: {
            build: "fresh-process-single-compiler-build-v2",
            startup: "fresh-process-init-plus-first-call-v1",
            cold: "native-init-plus-call-wasmtime-46-fresh-store-v3",
            warm: "uniform-six-warmup-nine-call-median-v2",
          },
          captureFingerprint: { algorithm: "sha256", digest: "0".repeat(64), inputs: {} },
          samples: Object.fromEntries(
            executable.map((cell) => [
              `${cell.programId}:${cell.laneId}`,
              { build: [], startup: [], cold: [], warm: [] },
            ]),
          ),
        })}\n`,
      );
      const executed = await spawnAsync(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/benchmark-landing-four-lane.mts",
          "--benchmark",
          "--without-porffor",
          "--output",
          coreOutput,
        ],
        { cwd: repoRoot },
      );
      expect(executed.status).not.toBe(0);
      expect(executed.stderr).toContain("partial capture fingerprint mismatch; refusing resume");
      expect(executed.stderr).not.toContain("failed to build Wasmtime cold host");
      rmSync(join(coreOutput, "partial-measurements.json"), { force: true });
    },
    240_000,
  );

  nativeIt("measures one plain-Porffor compiler invocation without the evidence-only CLI compile", () => {
    if (!nativeAvailable) throw new Error("LANDING_FOUR_LANE_REQUIRED=1 but Porffor/Clang are unavailable");
    const output = join(temporaryRoot, "plain-measured-worker");
    const executed = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/benchmark-landing-four-lane-worker.mts",
        "--lane",
        "plain",
        "--program",
        "fib",
        "--output",
        output,
        "--mode",
        "measured-build",
      ],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 128 * 1024 * 1024,
        env: { ...process.env, JS2WASM_PORFFOR_ROOT: resolve(repoRoot, "vendor/Porffor") },
      },
    );
    expect(executed.status, `${executed.stdout}\n${executed.stderr}`).toBe(0);
    const manifest = JSON.parse(readFileSync(join(output, "worker.json"), "utf8"));
    expect(manifest).toMatchObject({
      status: "supported",
      source: { sha256: LANDING_BENCHMARK_PROGRAMS[0]!.sha256, bytes: LANDING_BENCHMARK_PROGRAMS[0]!.bytes },
      commandProvenance: {
        workerMode: "measured-build",
        porfforCompilationCount: 1,
        directPorfforArgumentModel: ["porf", "c", "--module", "-O1", expect.any(String), expect.any(String)],
      },
    });
    expect(manifest.commandProvenance.exactCliCommand).toBeUndefined();
    expect(existsSync(join(output, "porffor-cli-raw.c"))).toBe(false);
    expect(existsSync(join(output, manifest.artifacts.laneC))).toBe(true);
  });

  nativeIt(
    "probes both native routes and classifies every sanitizer result",
    async () => {
      if (!nativeAvailable) throw new Error("LANDING_FOUR_LANE_REQUIRED=1 but Porffor/Clang are unavailable");
      const result = await runProbe(fullOutput, false);
      const js2Cells = result.cells.filter((cell) => cell.laneId === "js2-shared-plan-porffor-c-native");
      const plainCells = result.cells.filter((cell) => cell.laneId === "plain-porffor-c-native");
      expect(js2Cells).toHaveLength(4);
      expect(plainCells).toHaveLength(4);
      if (js2Cells[0]!.diagnostic?.code === "select:return-type-not-resolvable") {
        // Current main before #3497/PR #3446 lands.
        for (const cell of js2Cells) {
          expect(cell).toMatchObject({
            status: "unsupported",
            validation: null,
            diagnostic: {
              phase: "js2-linear-ir-selection",
              code: "select:return-type-not-resolvable",
              followUpIssue: 3497,
            },
          });
        }
      } else {
        // #3499, #3500, #3501, and #3502 are now landed prerequisites.
        expect(js2Cells).toMatchObject([
          {
            programId: "fib",
            status: "supported",
            diagnostic: null,
            sanitizer: { status: "clean", authority: "authoritative" },
          },
          {
            programId: "fib-recursive",
            status: "supported",
            diagnostic: null,
            sanitizer: { status: "clean", authority: "authoritative" },
          },
          {
            programId: "array-sum",
            status: "supported",
            diagnostic: null,
            sanitizer: { status: "clean", authority: "authoritative" },
          },
          {
            programId: "string-hash",
            status: "supported",
            diagnostic: null,
            sanitizer: { status: "clean", authority: "authoritative" },
          },
        ]);
        for (const [index, cell] of js2Cells.entries()) {
          expect(cell.validation?.actualOutputs).toEqual(result.programs[index]!.expectedFixedOutputs);
        }
      }
      for (const [index, cell] of plainCells.entries()) {
        const program = result.programs[index]!;
        expect(cell).toMatchObject({
          status: "unsafe-non-authoritative",
          sourceSha256: program.sha256,
          sanitizer: { status: "finding", authority: "ub-contaminated-non-authoritative" },
        });
        expect(cell.validation?.actualOutputs).toEqual(program.expectedFixedOutputs);
        expect(cell.sanitizer.diagnostic).toContain("runtime error: store to misaligned address");
        const rawCli = join(fullOutput, "artifacts", program.id, "plain", "porffor-cli-raw.c");
        expect(statSync(rawCli).size).toBe(LANDING_BENCHMARK_PROGRAMS[index]!.plainPorfforCliCBytes);
      }

      const hiddenFinding = clone(result);
      const unsafe = hiddenFinding.cells.find((cell) => cell.status === "unsafe-non-authoritative")!;
      unsafe.status = "supported";
      expect(() => validateLandingFourLaneResult(hiddenFinding)).toThrow(/hides a plain-Porffor sanitizer finding/);
    },
    180_000,
  );
});

async function runProbe(output: string, withoutPorffor: boolean): Promise<LandingFourLaneResult> {
  rmSync(output, { recursive: true, force: true });
  const command = [
    "--import",
    "tsx",
    "scripts/benchmark-landing-four-lane.mts",
    "--probe",
    ...(withoutPorffor ? ["--without-porffor"] : []),
    "--output",
    output,
  ];
  const executed = await spawnAsync(process.execPath, command, { cwd: repoRoot });
  expect(executed.status, `${executed.stdout}\n${executed.stderr}`).toBe(0);
  const latest = JSON.parse(readFileSync(join(output, "latest.json"), "utf8")) as LandingFourLaneResult;
  const summary = readFileSync(join(output, "summary.md"), "utf8");
  expect(summary).toContain("`latest.json` is the authoritative artifact");
  expect(summary).toContain("UB-contaminated, non-authoritative");
  validateLandingFourLaneResult(latest);
  return latest;
}

function clone(value: LandingFourLaneResult): any {
  return JSON.parse(JSON.stringify(value));
}

function spawnAsync(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string },
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolvePromise({ status, stdout, stderr }));
  });
}
