// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { LANDING_BENCHMARK_PROGRAM_IDS, LANDING_BENCHMARK_PROGRAMS } from "./landing-benchmark-corpus.mjs";
import { readExactSource } from "./porffor-direct-ab.mjs";

export const LANDING_FOUR_LANE_SCHEMA_VERSION = 1;
export const LANDING_FOUR_LANE_WARMUP_ROUNDS = 5;
export const LANDING_FOUR_LANE_MEASURED_ROUNDS = 21;

export function landingFourLaneExpectedOrder(
  canonicalCellIndex: number,
  phaseIndex: number,
  round: number,
  executableCellCount: number,
): number {
  for (const [label, value] of Object.entries({ canonicalCellIndex, phaseIndex, round })) {
    if (!Number.isInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
  }
  if (!Number.isInteger(executableCellCount) || executableCellCount <= 0) {
    throw new Error("executableCellCount must be a positive integer");
  }
  if (canonicalCellIndex >= executableCellCount) throw new Error("canonicalCellIndex is out of range");
  const rotation = (round + phaseIndex) % executableCellCount;
  return (canonicalCellIndex - rotation + executableCellCount) % executableCellCount;
}

export const LANDING_FOUR_LANE_IDS = [
  "v8-node-exact-source",
  "js2-wasmgc-wasmtime-cranelift",
  "js2-shared-plan-porffor-c-native",
  "plain-porffor-c-native",
] as const;

export type LandingFourLaneId = (typeof LANDING_FOUR_LANE_IDS)[number];
export type LandingProgramId = (typeof LANDING_BENCHMARK_PROGRAM_IDS)[number];
export type LandingSupportStatus = "supported" | "unsupported" | "unsafe-non-authoritative";

export interface LandingProgramRecord {
  readonly id: LandingProgramId;
  readonly label: string;
  readonly sourcePath: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly coldArg: number;
  readonly runtimeArg: number;
  readonly fixedInputs: readonly number[];
  readonly expectedFixedOutputs: readonly number[];
}

export interface LandingDiagnostic {
  readonly phase: string;
  readonly code: string;
  readonly message: string;
  readonly evidence: readonly string[];
  readonly followUpIssue: number | null;
}

export interface LandingValidation {
  readonly inputs: readonly number[];
  readonly expectedOutputs: readonly number[];
  readonly actualOutputs: readonly number[];
  readonly command: readonly string[];
}

export interface LandingSanitizerRecord {
  readonly status: "clean" | "finding" | "not-applicable" | "not-run";
  readonly authority: "authoritative" | "ub-contaminated-non-authoritative" | "not-applicable" | "pending";
  readonly diagnostic: string | null;
  readonly command: readonly string[] | null;
  readonly environment: Readonly<Record<string, string>> | null;
  readonly scope: string;
}

export interface LandingNullMeasurement {
  readonly samples: null;
  readonly reason: string;
}

export interface LandingSample {
  readonly phase: "warmup" | "measured";
  readonly round: number;
  readonly order: number;
  readonly wallNs: number;
  readonly cpuNs: number | null;
  readonly peakRssBytes: number;
  readonly validatedOutput: number | null;
  readonly outputObservation: {
    readonly commandIndex: number;
    readonly mechanism: "stdout-json" | "stdout-number" | "in-process-return";
  } | null;
  readonly commands: readonly (readonly string[])[];
}

export interface LandingMeasuredPhase {
  readonly samples: readonly LandingSample[];
  readonly reason: null;
}

export interface LandingMeasurementSet {
  readonly build: LandingNullMeasurement | LandingMeasuredPhase;
  readonly startup: LandingNullMeasurement | LandingMeasuredPhase;
  readonly cold: LandingNullMeasurement | LandingMeasuredPhase;
  readonly warm: LandingNullMeasurement | LandingMeasuredPhase;
}

export interface LandingSupportCell {
  readonly programId: LandingProgramId;
  readonly laneId: LandingFourLaneId;
  readonly sourceSha256: string;
  readonly status: LandingSupportStatus;
  readonly validation: LandingValidation | null;
  readonly diagnostic: LandingDiagnostic | null;
  readonly sanitizer: LandingSanitizerRecord;
  readonly measurements: LandingMeasurementSet;
  readonly provenance: Readonly<Record<string, unknown>>;
}

export interface LandingFourLaneResult {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly capture: {
    readonly kind: "support-probe" | "benchmark";
    readonly canonical: boolean;
    readonly warmupRounds: number;
    readonly measuredRounds: number;
    readonly fingerprint: {
      readonly algorithm: "sha256";
      readonly digest: string;
      readonly inputs: Readonly<Record<string, unknown>>;
    } | null;
    readonly environment: Readonly<Record<string, string>>;
  };
  readonly programs: readonly LandingProgramRecord[];
  readonly cells: readonly LandingSupportCell[];
  readonly interpretation: {
    readonly crossLaneRankingPermitted: false;
    readonly confounders: readonly string[];
    readonly wasmtimeCompatibilityMethod: string;
  };
}

interface LoadedModule {
  readonly benchmark: {
    readonly id: string;
    readonly label: string;
    readonly coldArg: number;
    readonly runtimeArg: number;
  };
  readonly run: (input: number) => number;
}

export async function verifyLandingBenchmarkCorpus(repoRoot: string): Promise<LandingProgramRecord[]> {
  const records: LandingProgramRecord[] = [];
  for (const expected of LANDING_BENCHMARK_PROGRAMS) {
    const absolutePath = resolve(repoRoot, expected.sourcePath);
    const source = readExactSource(absolutePath, expected.sha256);
    if (source.bytes !== expected.bytes) {
      throw new Error(`${expected.id} source byte count changed: expected ${expected.bytes}, received ${source.bytes}`);
    }
    const moduleUrl = `${pathToFileURL(absolutePath).href}?issue3498=${expected.sha256}`;
    const loaded = (await import(moduleUrl)) as LoadedModule;
    if (typeof loaded.run !== "function") throw new Error(`${expected.id} exact source does not export run`);
    if (
      loaded.benchmark?.id !== expected.id ||
      loaded.benchmark.label !== expected.label ||
      loaded.benchmark.coldArg !== expected.coldArg ||
      loaded.benchmark.runtimeArg !== expected.runtimeArg
    ) {
      throw new Error(`${expected.id} benchmark metadata differs from the pinned corpus descriptor`);
    }
    const actual = expected.fixedInputs.map((input) => loaded.run(input));
    assertNumericArrayEquals(actual, expected.expectedFixedOutputs, `${expected.id} Node oracle`);
    records.push({
      id: expected.id,
      label: expected.label,
      sourcePath: expected.sourcePath,
      sha256: expected.sha256,
      bytes: expected.bytes,
      coldArg: expected.coldArg,
      runtimeArg: expected.runtimeArg,
      fixedInputs: [...expected.fixedInputs],
      expectedFixedOutputs: [...expected.expectedFixedOutputs],
    });
  }
  return records;
}

export function nullMeasurements(reason: string): LandingMeasurementSet {
  if (!reason) throw new Error("null measurement reason must be non-empty");
  const empty = (): LandingNullMeasurement => ({ samples: null, reason });
  return { build: empty(), startup: empty(), cold: empty(), warm: empty() };
}

export function validateLandingFourLaneResult(value: unknown): asserts value is LandingFourLaneResult {
  const result = record(value, "result");
  if (result.schemaVersion !== LANDING_FOUR_LANE_SCHEMA_VERSION) throw new Error("unsupported #3498 schema version");
  const capture = record(result.capture, "capture");
  if (capture.kind !== "support-probe" && capture.kind !== "benchmark") throw new Error("capture.kind is invalid");
  if (typeof capture.canonical !== "boolean") throw new Error("capture.canonical must be boolean");
  const environment = record(capture.environment, "capture.environment");
  for (const [key, value] of Object.entries(environment)) {
    if (!key || typeof value !== "string" || !value) throw new Error("capture.environment entries must be strings");
  }
  if (capture.kind === "support-probe") {
    if (capture.fingerprint !== null) throw new Error("support probes must not carry a benchmark fingerprint");
  } else {
    const fingerprint = record(capture.fingerprint, "capture.fingerprint");
    if (fingerprint.algorithm !== "sha256" || !/^[0-9a-f]{64}$/.test(fingerprint.digest)) {
      throw new Error("capture.fingerprint must carry a SHA-256 digest");
    }
    record(fingerprint.inputs, "capture.fingerprint.inputs");
  }
  const warmupRounds = nonnegativeInteger(capture.warmupRounds, "capture.warmupRounds");
  const measuredRounds = nonnegativeInteger(capture.measuredRounds, "capture.measuredRounds");
  if (
    capture.kind === "benchmark" &&
    (warmupRounds !== LANDING_FOUR_LANE_WARMUP_ROUNDS || measuredRounds !== LANDING_FOUR_LANE_MEASURED_ROUNDS)
  ) {
    throw new Error("benchmark captures require exactly 5 warmup and 21 measured rounds");
  }

  const programs = array(result.programs, "programs");
  if (programs.length !== LANDING_BENCHMARK_PROGRAMS.length) throw new Error("result must contain four programs");
  for (let index = 0; index < LANDING_BENCHMARK_PROGRAMS.length; index++) {
    const expected = LANDING_BENCHMARK_PROGRAMS[index]!;
    const actual = record(programs[index], `programs[${index}]`);
    if (
      actual.id !== expected.id ||
      actual.sourcePath !== expected.sourcePath ||
      actual.sha256 !== expected.sha256 ||
      actual.bytes !== expected.bytes ||
      actual.coldArg !== expected.coldArg ||
      actual.runtimeArg !== expected.runtimeArg
    ) {
      throw new Error(`program ${expected.id} does not identify the exact canonical source`);
    }
    assertNumericArrayEquals(actual.fixedInputs, expected.fixedInputs, `${expected.id} fixed inputs`);
    assertNumericArrayEquals(actual.expectedFixedOutputs, expected.expectedFixedOutputs, `${expected.id} outputs`);
  }

  const cells = array(result.cells, "cells");
  const expectedKeys = LANDING_BENCHMARK_PROGRAMS.flatMap((program) =>
    LANDING_FOUR_LANE_IDS.map((laneId) => `${program.id}:${laneId}`),
  );
  if (cells.length !== expectedKeys.length) throw new Error("result must contain exactly 16 support cells");
  const seen = new Set<string>();
  for (const cellValue of cells) {
    const cell = record(cellValue, "cell");
    const program = LANDING_BENCHMARK_PROGRAMS.find((candidate) => candidate.id === cell.programId);
    if (!program || !(LANDING_FOUR_LANE_IDS as readonly unknown[]).includes(cell.laneId)) {
      throw new Error(`unknown support cell ${String(cell.programId)}:${String(cell.laneId)}`);
    }
    const key = `${cell.programId}:${cell.laneId}`;
    if (seen.has(key)) throw new Error(`duplicate support cell ${key}`);
    seen.add(key);
    if (cell.sourceSha256 !== program.sha256) throw new Error(`${key} substituted the canonical source`);
    if (!(["supported", "unsupported", "unsafe-non-authoritative"] as const).includes(cell.status as never)) {
      throw new Error(`${key} has invalid support status`);
    }
    validateMeasurements(
      cell.measurements,
      key,
      program,
      cell.status !== "unsupported",
      capture.kind,
      warmupRounds,
      measuredRounds,
    );
    const sanitizer = record(cell.sanitizer, `${key}.sanitizer`);
    if (typeof sanitizer.scope !== "string" || !sanitizer.scope) {
      throw new Error(`${key} sanitizer scope must be disclosed`);
    }
    if (cell.laneId === "js2-shared-plan-porffor-c-native" || cell.laneId === "plain-porffor-c-native") {
      if (sanitizer.status === "clean" || sanitizer.status === "finding") {
        const environment = record(sanitizer.environment, `${key}.sanitizer.environment`);
        if (
          environment.ASAN_OPTIONS !== "detect_leaks=0:halt_on_error=1:abort_on_error=1" ||
          environment.UBSAN_OPTIONS !== "halt_on_error=1:print_stacktrace=1"
        ) {
          throw new Error(`${key} sanitizer environment is not the disclosed ASan/UBSan probe configuration`);
        }
      }
    } else if (sanitizer.environment !== null) {
      throw new Error(`${key} non-native lane must not claim sanitizer environment`);
    }
    if (cell.status === "unsupported") {
      if (cell.validation !== null) throw new Error(`${key} unsupported cell must not carry successful validation`);
      const diagnostic = record(cell.diagnostic, `${key}.diagnostic`);
      for (const field of ["phase", "code", "message"] as const) {
        if (typeof diagnostic[field] !== "string" || diagnostic[field].length === 0) {
          throw new Error(`${key} unsupported diagnostic.${field} must be non-empty`);
        }
      }
    } else {
      if (cell.diagnostic !== null) throw new Error(`${key} executable cell must not carry an unsupported diagnostic`);
      const validation = record(cell.validation, `${key}.validation`);
      assertNumericArrayEquals(validation.inputs, program.fixedInputs, `${key} validation inputs`);
      assertNumericArrayEquals(validation.expectedOutputs, program.expectedFixedOutputs, `${key} expected outputs`);
      assertNumericArrayEquals(validation.actualOutputs, program.expectedFixedOutputs, `${key} actual outputs`);
      if (cell.status === "unsafe-non-authoritative") {
        if (
          cell.laneId !== "plain-porffor-c-native" ||
          sanitizer.status !== "finding" ||
          sanitizer.authority !== "ub-contaminated-non-authoritative"
        ) {
          throw new Error(`${key} unsafe status is not backed by a plain-Porffor sanitizer finding`);
        }
      }
      if (
        cell.laneId === "plain-porffor-c-native" &&
        sanitizer.status === "finding" &&
        cell.status !== "unsafe-non-authoritative"
      ) {
        throw new Error(`${key} hides a plain-Porffor sanitizer finding behind authoritative support`);
      }
      if (cell.laneId === "js2-shared-plan-porffor-c-native" && sanitizer.status !== "clean") {
        throw new Error(`${key} JS2 native support requires clean sanitizers`);
      }
    }
  }
  for (const key of expectedKeys) if (!seen.has(key)) throw new Error(`missing support cell ${key}`);

  if (capture.kind === "benchmark") {
    const executableCells = cells
      .map((cell) => record(cell, "benchmark cell"))
      .filter((cell) => cell.status !== "unsupported");
    for (const [phaseIndex, phase] of (["build", "startup", "cold", "warm"] as const).entries()) {
      for (let round = 0; round < warmupRounds + measuredRounds; round++) {
        executableCells.forEach((cell, canonicalCellIndex) => {
          const measurement = record(record(cell.measurements, "measurements")[phase], phase);
          const samples = array(measurement.samples, `${phase}.samples`);
          const sample = samples.find((candidate) => record(candidate, "sample").round === round);
          if (!sample) throw new Error(`${phase} is missing benchmark round ${round}`);
          const order = nonnegativeInteger(record(sample, "sample").order, `${phase}.order`);
          const expectedOrder = landingFourLaneExpectedOrder(
            canonicalCellIndex,
            phaseIndex,
            round,
            executableCells.length,
          );
          if (order !== expectedOrder) {
            throw new Error(
              `${phase} round ${round} cell ${canonicalCellIndex} order ${order} does not match rotation ${expectedOrder}`,
            );
          }
        });
      }
    }
  }

  const serialized = JSON.stringify(value);
  if (/\bskipped\b/i.test(serialized)) throw new Error("skipped is not a valid #3498 support outcome");
}

function validateMeasurements(
  value: unknown,
  key: string,
  program: (typeof LANDING_BENCHMARK_PROGRAMS)[number],
  executable: boolean,
  captureKind: unknown,
  warmupRounds: number,
  measuredRounds: number,
): void {
  const measurements = record(value, `${key}.measurements`);
  for (const phase of ["build", "startup", "cold", "warm"] as const) {
    const measurement = record(measurements[phase], `${key}.measurements.${phase}`);
    if (measurement.samples === null) {
      if (typeof measurement.reason !== "string" || measurement.reason.length === 0) {
        throw new Error(`${key}.${phase} null measurement needs a reason`);
      }
      if (captureKind === "benchmark" && executable) {
        throw new Error(`${key}.${phase} executable benchmark cell must carry timing samples`);
      }
      continue;
    }
    if (!executable) throw new Error(`${key}.${phase} unsupported cell must not carry timing samples`);
    if (measurement.reason !== null) throw new Error(`${key}.${phase} measured data must use reason:null`);
    const samples = array(measurement.samples, `${key}.${phase}.samples`);
    for (const sampleValue of samples) {
      const sample = record(sampleValue, `${key}.${phase}.sample`);
      if (typeof sample.wallNs !== "number" || !Number.isFinite(sample.wallNs) || sample.wallNs <= 0) {
        throw new Error(`${key}.${phase} wallNs invalid`);
      }
      if (
        sample.cpuNs !== null &&
        (typeof sample.cpuNs !== "number" || !Number.isFinite(sample.cpuNs) || sample.cpuNs <= 0)
      ) {
        throw new Error(`${key}.${phase} cpuNs invalid`);
      }
      if (
        typeof sample.peakRssBytes !== "number" ||
        !Number.isFinite(sample.peakRssBytes) ||
        sample.peakRssBytes <= 0
      ) {
        throw new Error(`${key}.${phase} peak RSS invalid`);
      }
      const commands = array(sample.commands, `${key}.${phase}.commands`);
      if (
        commands.length === 0 ||
        commands.some(
          (command) =>
            !Array.isArray(command) ||
            command.length === 0 ||
            command.some((argument) => typeof argument !== "string" || argument.length === 0),
        )
      ) {
        throw new Error(`${key}.${phase} commands must retain one or more exact invocations`);
      }
      if (sample.phase !== (sample.round < warmupRounds ? "warmup" : "measured")) {
        throw new Error(`${key}.${phase} warmup/measured label does not match its round`);
      }
      const expectedOutput = phase === "build" ? null : program.expectedFixedOutputs[3];
      if (sample.validatedOutput !== expectedOutput) {
        throw new Error(`${key}.${phase} validated output does not match the Node runtime oracle`);
      }
      if (expectedOutput === null) {
        if (sample.outputObservation !== null) {
          throw new Error(`${key}.${phase} output-free phase must not claim an output observation`);
        }
      } else {
        const observation = record(sample.outputObservation, `${key}.${phase}.outputObservation`);
        const commandIndex = nonnegativeInteger(
          observation.commandIndex,
          `${key}.${phase}.outputObservation.commandIndex`,
        );
        if (commandIndex >= commands.length) {
          throw new Error(`${key}.${phase} output observation does not reference a retained command`);
        }
        if (!("stdout-json stdout-number in-process-return".split(" ") as unknown[]).includes(observation.mechanism)) {
          throw new Error(`${key}.${phase} output observation mechanism is invalid`);
        }
      }
    }
    if (captureKind === "support-probe") throw new Error(`${key}.${phase} probe must not masquerade as timing data`);
    const expected = warmupRounds + measuredRounds;
    if (samples.length !== expected) throw new Error(`${key}.${phase} sample count mismatch`);
  }
}

function assertNumericArrayEquals(actualValue: unknown, expected: readonly number[], label: string): void {
  const actual = array(actualValue, label);
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => typeof value !== "number" || !Object.is(value, expected[index]))
  ) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

function record(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, any>;
}

function array(value: unknown, label: string): any[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a nonnegative integer`);
  return Number(value);
}

export function classifyLandingSanitizerExecution(status: number | null, stderr: string): "clean" | "finding" {
  const recognized = /ERROR: AddressSanitizer|runtime error:|UndefinedBehaviorSanitizer/.test(stderr);
  if (status === 0 && !recognized) return "clean";
  if (status !== null && status !== 0 && recognized) return "finding";
  throw new Error(
    `sanitizer infrastructure error: status=${String(status)}, recognizedSignature=${String(recognized)}`,
  );
}
