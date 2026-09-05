// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compile, compileMulti, type CompileResult } from "../src/index.js";
import {
  getLastLinearIrReport,
  prepareLinearIrCoveragePopulation,
  resetLastLinearIrReport,
} from "../src/ir/backend/linear-integration.js";
import {
  beginLinearIrCoverageGeneration,
  beginPreparedLinearIrCoverageGeneration,
  canonicalLinearIrCoverageJson,
  finalizeLinearIrCoverageGeneration,
  finalizePreparedLinearIrCoverageGeneration,
  getLastLinearIrCoverageCensus,
  linearIrCoverageDigestProjection,
  linearIrCoverageEnabled,
  resetLastLinearIrCoverageCensus,
  runPreparedLinearIrCoverageGeneration,
  validateLinearIrCoverageCensus,
  type LinearIrCoverageCensusV1,
  type PreparedLinearIrCoveragePopulation,
} from "../src/ir/backend/linear-ir-coverage.js";
import { ts } from "../src/ts-api.js";
import {
  compareLinearIrBaseline,
  digestLinearIrCompileErrors,
  linearIrGenerationContributionEligible,
  loadLinearIrBaselineForMode,
  parseLinearIrBaseline,
  projectLinearIrCompileErrors,
  sameLinearIrOwnerPopulation,
} from "../scripts/check-linear-ir.js";

const COVERAGE_FLAG = "JS2WASM_LINEAR_IR_COVERAGE";
const OVERLAY_FLAG = "JS2WASM_LINEAR_IR";
const savedCoverage = process.env[COVERAGE_FLAG];
const savedOverlay = process.env[OVERLAY_FLAG];

function setFlag(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function clearDiagnostics(): void {
  resetLastLinearIrReport();
  resetLastLinearIrCoverageCensus();
}

beforeEach(() => {
  setFlag(COVERAGE_FLAG, undefined);
  setFlag(OVERLAY_FLAG, undefined);
  clearDiagnostics();
});

afterEach(() => {
  clearDiagnostics();
  setFlag(COVERAGE_FLAG, savedCoverage);
  setFlag(OVERLAY_FLAG, savedOverlay);
});

function expectSuccess(result: CompileResult): void {
  expect(result.success, result.errors.map((error) => error.message).join("; ")).toBe(true);
}

function binarySnapshot(result: CompileResult) {
  return {
    binary: [...result.binary],
    errors: result.errors.map(({ message, line, column, severity }) => ({ message, line, column, severity })),
    exports: WebAssembly.Module.exports(new WebAssembly.Module(result.binary)),
  };
}

async function runtimeValue(result: CompileResult, exportName: string, ...args: number[]): Promise<unknown> {
  const { instance } = await WebAssembly.instantiate(result.binary);
  return (instance.exports[exportName] as (...values: number[]) => unknown)(...args);
}

function makeProgram(sources: Readonly<Record<string, string>>): {
  readonly files: readonly ts.SourceFile[];
  readonly checker: ts.TypeChecker;
} {
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    noLib: true,
    noResolve: true,
  };
  const host = ts.createCompilerHost(options, true);
  const originalGetSourceFile = host.getSourceFile.bind(host);
  const hasSource = (fileName: string): boolean => Object.prototype.hasOwnProperty.call(sources, fileName);
  host.fileExists = hasSource;
  host.readFile = (fileName) => sources[fileName];
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) =>
    hasSource(fileName)
      ? ts.createSourceFile(fileName, sources[fileName]!, languageVersion, true, ts.ScriptKind.TS)
      : originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  const names = Object.keys(sources);
  const program = ts.createProgram({ rootNames: names, options, host });
  return { files: names.map((name) => program.getSourceFile(name)!), checker: program.getTypeChecker() };
}

function population(
  sources: Readonly<Record<string, string>> = {
    "/virtual/entry.ts": `
      export function accepted(value: number): number { return value + 1; }
      export function rejected(value: number = 1): number { return value + 2; }
    `,
  },
): PreparedLinearIrCoveragePopulation {
  const built = makeProgram(sources);
  return prepareLinearIrCoveragePopulation(built.files, built.files[0]!, built.checker);
}

function completePopulation(
  prepared: PreparedLinearIrCoveragePopulation,
  unresolvedReason: "selector-omitted" | "multi-source-overlay-unimplemented" = "selector-omitted",
): LinearIrCoverageCensusV1 {
  const transaction = beginPreparedLinearIrCoverageGeneration(
    prepared,
    prepared.sourceFiles.length === 1 ? "single-source" : "multi-source",
  );
  return finalizePreparedLinearIrCoverageGeneration(transaction, prepared, {
    status: "complete",
    unresolvedReason,
  });
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function digest(census: LinearIrCoverageCensusV1): string {
  return createHash("sha256")
    .update(canonicalLinearIrCoverageJson(linearIrCoverageDigestProjection(census)))
    .digest("hex");
}

describe("#4550 linear IR coverage census", { timeout: 60_000 }, () => {
  it("keeps its browser-safe predicate default-off and exact", () => {
    expect(linearIrCoverageEnabled(null)).toBe(false);
    expect(linearIrCoverageEnabled({})).toBe(false);
    expect(linearIrCoverageEnabled({ process: null })).toBe(false);
    expect(linearIrCoverageEnabled({ process: {} })).toBe(false);
    expect(linearIrCoverageEnabled({ process: { env: null } })).toBe(false);
    expect(linearIrCoverageEnabled({ process: { env: {} } })).toBe(false);
    expect(linearIrCoverageEnabled({ process: { env: { [COVERAGE_FLAG]: "0" } } })).toBe(false);
    expect(linearIrCoverageEnabled({ process: { env: { [COVERAGE_FLAG]: "true" } } })).toBe(false);
    expect(linearIrCoverageEnabled({ process: { env: { [COVERAGE_FLAG]: "1" } } })).toBe(true);
  });

  it("publishes a nonempty exact single-source denominator with compiled and rejected owners", async () => {
    setFlag(COVERAGE_FLAG, "1");
    setFlag(OVERLAY_FLAG, "1");
    const result = await compile(
      `
        export function accepted(value: number): number { return value + 1; }
        export function withDefault(value: number = 1): number { return value + 2; }
      `,
      { target: "linear", fileName: "fixtures/coverage-positive.ts" },
    );
    expectSuccess(result);
    const census = validateLinearIrCoverageCensus(getLastLinearIrCoverageCensus());
    expect(census.generationKind).toBe("single-source");
    expect(census.status).toBe("complete");
    expect(census.sources).toHaveLength(1);
    expect(census.owners.length).toBeGreaterThan(1);
    expect(census.counts.compiled).toBeGreaterThan(0);
    expect(census.counts.rejected).toBeGreaterThan(0);
    expect(census.counts.owners).toBe(census.counts.compiled + census.counts.rejected + census.counts.notAttempted);
    expect(census.owners.some((owner) => owner.outcome.kind === "compiled")).toBe(true);
    expect(census.owners.some((owner) => owner.outcome.kind === "rejected")).toBe(true);
    expect(JSON.stringify(census)).not.toContain("fixtures/coverage-positive.ts");
  });

  it("is byte/error/export/runtime neutral for single and multi-source compiles", async () => {
    const singleSource = `export function run(value: number): number { return value * 2 + 1; }`;
    setFlag(COVERAGE_FLAG, undefined);
    const singleOff = await compile(singleSource, { target: "linear", fileName: "ab/single.ts" });
    expectSuccess(singleOff);
    expect(getLastLinearIrCoverageCensus()).toBeUndefined();
    clearDiagnostics();
    setFlag(COVERAGE_FLAG, "1");
    const singleOn = await compile(singleSource, { target: "linear", fileName: "ab/single.ts" });
    expectSuccess(singleOn);
    expect("linearIrCoverage" in singleOn).toBe(false);
    expect(binarySnapshot(singleOn)).toEqual(binarySnapshot(singleOff));
    expect(await runtimeValue(singleOn, "run", 4)).toBe(await runtimeValue(singleOff, "run", 4));
    expect(validateLinearIrCoverageCensus(getLastLinearIrCoverageCensus()).counts.owners).toBeGreaterThan(0);

    const files = {
      "lib.ts": `export function twice(value: number): number { return value * 2; }`,
      "entry.ts": `import { twice } from "./lib.js"; export function run(value: number): number { return twice(value) + 1; }`,
    };
    clearDiagnostics();
    setFlag(COVERAGE_FLAG, undefined);
    const multiOff = await compileMulti(files, "entry.ts", { target: "linear" });
    expectSuccess(multiOff);
    expect(getLastLinearIrCoverageCensus()).toBeUndefined();
    clearDiagnostics();
    setFlag(COVERAGE_FLAG, "1");
    const multiOn = await compileMulti(files, "entry.ts", { target: "linear" });
    expectSuccess(multiOn);
    expect(binarySnapshot(multiOn)).toEqual(binarySnapshot(multiOff));
    expect(await runtimeValue(multiOn, "run", 4)).toBe(await runtimeValue(multiOff, "run", 4));
    expect(getLastLinearIrReport()).toBeUndefined();
    const multiCensus = validateLinearIrCoverageCensus(getLastLinearIrCoverageCensus());
    expect(multiCensus.generationKind).toBe("multi-source");
    expect(multiCensus.sources).toHaveLength(2);
    expect(multiCensus.owners.length).toBeGreaterThan(1);
    expect(multiCensus.owners.every((owner) => owner.outcome.kind === "not-attempted")).toBe(true);
    expect(
      multiCensus.owners.every(
        (owner) =>
          owner.outcome.kind === "not-attempted" && owner.outcome.reason === "multi-source-overlay-unimplemented",
      ),
    ).toBe(true);
  });

  it("observes overlay-disabled direct mode without reserving or emitting IR runtime bytes", async () => {
    const source = `export function run(value: number): number { return value + 3; }`;
    setFlag(OVERLAY_FLAG, "0");
    setFlag(COVERAGE_FLAG, undefined);
    const off = await compile(source, { target: "linear", fileName: "ab/direct.ts" });
    expectSuccess(off);
    clearDiagnostics();
    setFlag(COVERAGE_FLAG, "1");
    const on = await compile(source, { target: "linear", fileName: "ab/direct.ts" });
    expectSuccess(on);
    expect(binarySnapshot(on)).toEqual(binarySnapshot(off));
    expect(await runtimeValue(on, "run", 4)).toBe(await runtimeValue(off, "run", 4));
    expect(getLastLinearIrReport()).toBeUndefined();
    const census = validateLinearIrCoverageCensus(getLastLinearIrCoverageCensus());
    expect(census.owners.length).toBeGreaterThan(0);
    expect(
      census.owners.every(
        (owner) => owner.outcome.kind === "not-attempted" && owner.outcome.reason === "overlay-disabled",
      ),
    ).toBe(true);
  });

  it("keeps colliding display labels distinct by source and UnitId", () => {
    const prepared = population({
      "/virtual/a.ts": `export function same(value: number): number { return value + 1; }`,
      "/virtual/b.ts": `export function same(value: number): number { return value + 2; }`,
    });
    const census = completePopulation(prepared, "multi-source-overlay-unimplemented");
    expect(census.sources).toHaveLength(2);
    expect(census.owners).toHaveLength(2);
    expect(census.owners.map((owner) => owner.legacyName)).toEqual(["same", "same"]);
    expect(new Set(census.owners.map((owner) => owner.sourceId)).size).toBe(2);
    expect(new Set(census.owners.map((owner) => owner.ownerUnitId)).size).toBe(2);
  });

  it("prevents a failed pre-generator compile from inheriting prior diagnostics", async () => {
    setFlag(COVERAGE_FLAG, "1");
    const firstWatermark = resetLastLinearIrCoverageCensus();
    const first = await compile(`export function run(value: number): number { return value + 1; }`, {
      target: "linear",
      fileName: "sequence/first.ts",
    });
    expectSuccess(first);
    expect(
      validateLinearIrCoverageCensus(getLastLinearIrCoverageCensus(), { afterWatermark: firstWatermark }),
    ).toBeTruthy();
    expect(getLastLinearIrReport()).toBeTruthy();

    resetLastLinearIrReport();
    const secondWatermark = resetLastLinearIrCoverageCensus();
    const second = await compile(`export function broken(`, {
      target: "linear",
      fileName: "sequence/broken.ts",
    });
    expect(second.success).toBe(false);
    expect(getLastLinearIrReport()).toBeUndefined();
    expect(getLastLinearIrCoverageCensus()).toBeUndefined();
    expect(resetLastLinearIrCoverageCensus()).toBe(secondWatermark);
  });

  it("retains returned failure diagnostics while admitting only its exact completed generation", async () => {
    setFlag(COVERAGE_FLAG, "1");
    const result = await compile(
      `
        export function accepted(value: number): number { return value + 1; }
        export function directOnly(): number { return document.body.childElementCount; }
      `,
      { target: "linear", fileName: "fixtures/post-generation-failure.ts" },
    );
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(getLastLinearIrReport()).toBeTruthy();
    const census = validateLinearIrCoverageCensus(getLastLinearIrCoverageCensus());
    expect(census.status).toBe("complete");
    expect(census.counts.owners).toBeGreaterThan(0);

    const projection = projectLinearIrCompileErrors([
      ...result.errors,
      {
        message: "late error at /private/tmp/checkout/file.ts",
        line: 1,
        column: 2,
        severity: "error" as const,
        file: "/private/tmp/checkout/file.ts",
      },
    ]);
    expect(JSON.stringify(projection)).not.toContain("/private/tmp");
    expect(projection.errors.length).toBe(result.errors.length + 1);
    const errorDigest = digestLinearIrCompileErrors(result.errors.length + 1, projection);
    expect(errorDigest).toMatch(/^[0-9a-f]{64}$/);
    const reversedProjection = projectLinearIrCompileErrors(
      [
        ...result.errors,
        {
          file: "/private/tmp/checkout/file.ts",
          severity: "error" as const,
          column: 2,
          line: 1,
          message: "late error at /private/tmp/checkout/file.ts",
        },
      ].reverse(),
    );
    expect(reversedProjection).toEqual(projection);
    expect(digestLinearIrCompileErrors(result.errors.length + 1, reversedProjection)).toBe(errorDigest);
    const bounded = projectLinearIrCompileErrors(
      Array.from({ length: 257 }, (_, index) => ({
        message: `error ${index}`,
        line: index + 1,
        column: 1,
        severity: "error" as const,
      })),
    );
    expect(bounded).toMatchObject({ truncated: true });
    expect(bounded.errors).toHaveLength(256);
    expect(digestLinearIrCompileErrors(257, bounded)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      linearIrGenerationContributionEligible({
        compileStatus: "returned",
        censusStatus: census.status,
        instrumentationFailureCount: 0,
      }),
    ).toBe(true);
    for (const mutation of [
      { compileStatus: "threw" as const, censusStatus: "complete" as const, instrumentationFailureCount: 0 },
      { compileStatus: "returned" as const, censusStatus: "missing" as const, instrumentationFailureCount: 0 },
      {
        compileStatus: "returned" as const,
        censusStatus: "generation-failed" as const,
        instrumentationFailureCount: 0,
      },
      { compileStatus: "returned" as const, censusStatus: "complete" as const, instrumentationFailureCount: 1 },
    ]) {
      expect(linearIrGenerationContributionEligible(mutation)).toBe(false);
    }
  });

  it("retains partial exact evidence and the full denominator on a late generation failure", () => {
    const prepared = population();
    const first = prepared.owners[0]!;
    const partial = {
      ownerEvidence: [{ outcome: "compiled" as const, ownerUnitId: first.ownerUnitId, legacyName: first.legacyName }],
      compiled: [first.legacyName],
      rejected: [],
    };
    expect(() =>
      runPreparedLinearIrCoverageGeneration({
        generationKind: "single-source",
        preparePopulation: () => prepared,
        resetCompatibility: () => undefined,
        readCompatibility: () => partial,
        unresolvedReason: "selector-omitted",
        failureUnresolvedReason: "generation-aborted",
        failurePhase: "test-generation",
        generate: () => {
          throw new Error("late failure at /tmp/private-output");
        },
      }),
    ).toThrowError("late failure");
    const census = validateLinearIrCoverageCensus(getLastLinearIrCoverageCensus());
    expect(census.status).toBe("generation-failed");
    expect(census.counts.owners).toBe(prepared.owners.length);
    expect(census.counts.compiled).toBe(1);
    expect(census.counts.notAttempted).toBe(prepared.owners.length - 1);
    expect(
      census.owners
        .filter((owner) => owner.ownerUnitId !== first.ownerUnitId)
        .every((owner) => owner.outcome.kind === "not-attempted" && owner.outcome.reason === "generation-aborted"),
    ).toBe(true);
    expect(census.failure?.detail).not.toContain("/tmp");

    const multi = population({
      "/virtual/a.ts": `export function a(): number { return 1; }`,
      "/virtual/b.ts": `export function b(): number { return 2; }`,
    });
    expect(() =>
      runPreparedLinearIrCoverageGeneration({
        generationKind: "multi-source",
        preparePopulation: () => multi,
        resetCompatibility: () => undefined,
        readCompatibility: () => undefined,
        unresolvedReason: "multi-source-overlay-unimplemented",
        failureUnresolvedReason: "multi-source-overlay-unimplemented",
        failurePhase: "test-multi-generation",
        generate: () => {
          throw new Error("multi failure");
        },
      }),
    ).toThrowError("multi failure");
    const failedMulti = validateLinearIrCoverageCensus(getLastLinearIrCoverageCensus());
    expect(failedMulti.status).toBe("generation-failed");
    expect(
      failedMulti.owners.every(
        (owner) =>
          owner.outcome.kind === "not-attempted" && owner.outcome.reason === "multi-source-overlay-unimplemented",
      ),
    ).toBe(true);
  });

  it("authenticates transactions and rejects missing, duplicate, unknown, and cross-population evidence", () => {
    const prepared = population();
    const owner = prepared.owners[0]!;
    const begin = () => beginPreparedLinearIrCoverageGeneration(prepared, "single-source");
    const empty = { status: "complete" as const, unresolvedReason: "selector-omitted" as const };

    const missing = begin();
    expect(() =>
      finalizePreparedLinearIrCoverageGeneration(missing, prepared, {
        ...empty,
        evidence: { ownerEvidence: [], compiled: [owner.legacyName], rejected: [] },
      }),
    ).toThrow(/do not reconcile/);

    const duplicate = begin();
    const compiled = { outcome: "compiled" as const, ownerUnitId: owner.ownerUnitId, legacyName: owner.legacyName };
    expect(() =>
      finalizePreparedLinearIrCoverageGeneration(duplicate, prepared, {
        ...empty,
        evidence: { ownerEvidence: [compiled, compiled], compiled: [owner.legacyName], rejected: [] },
      }),
    ).toThrow(/unknown, duplicate/);

    const unknown = begin();
    expect(() =>
      finalizePreparedLinearIrCoverageGeneration(unknown, prepared, {
        ...empty,
        evidence: {
          ownerEvidence: [{ ...compiled, ownerUnitId: `${owner.ownerUnitId}-unknown` as typeof owner.ownerUnitId }],
          compiled: [owner.legacyName],
          rejected: [],
        },
      }),
    ).toThrow(/unknown, duplicate/);

    const live = begin();
    expect(() =>
      finalizeLinearIrCoverageGeneration({} as typeof live, {
        populationToken: prepared,
        status: "complete",
        ownerEvidence: [],
        publicCompiled: [],
        publicRejected: [],
        unresolvedReason: "selector-omitted",
      }),
    ).toThrow(/foreign, stale, reused/);
    expect(() => begin()).toThrow(/overlapping/);
    expect(() => resetLastLinearIrReport()).toThrow(/active coverage generation/);
    expect(() => resetLastLinearIrCoverageCensus()).toThrow(/live generation/);
    const finalized = finalizePreparedLinearIrCoverageGeneration(live, prepared, empty);
    expect(finalized.status).toBe("complete");
    expect(() => finalizePreparedLinearIrCoverageGeneration(live, prepared, empty)).toThrow(/foreign, stale, reused/);

    const other = population({ "/virtual/other.ts": `export function other(): number { return 1; }` });
    const cross = begin();
    expect(() => finalizePreparedLinearIrCoverageGeneration(cross, other, empty)).toThrow(/cross-population/);
    finalizePreparedLinearIrCoverageGeneration(cross, prepared, empty);

    const duplicateOwners = [prepared.owners[0]!, prepared.owners[0]!];
    expect(() =>
      beginLinearIrCoverageGeneration({
        populationToken: prepared,
        generationKind: "single-source",
        entrySourceId: prepared.sources[0]!.sourceId,
        entrySourceKey: prepared.sources[0]!.sourceKey,
        sources: prepared.sources,
        owners: duplicateOwners,
      }),
    ).toThrow(/duplicate UnitId/);

    const multi = population({
      "/virtual/a.ts": `export function a(): number { return 1; }`,
      "/virtual/b.ts": `export function b(): number { return 2; }`,
    });
    const entry = multi.sources.find((source) => source.kind === "entry")!;
    expect(() =>
      beginLinearIrCoverageGeneration({
        populationToken: multi,
        generationKind: "multi-source",
        entrySourceId: entry.sourceId,
        entrySourceKey: entry.sourceKey,
        sources: [entry, entry],
        owners: multi.owners,
      }),
    ).toThrow(/duplicate ID, key, file, or order/);

    const source = prepared.sources[0]!;
    expect(() =>
      beginLinearIrCoverageGeneration({
        populationToken: prepared,
        generationKind: "single-source",
        entrySourceId: source.sourceId,
        entrySourceKey: source.sourceKey,
        sources: [{ ...source, originalFileName: "/different/input.ts" }],
        owners: prepared.owners,
      }),
    ).toThrow(/caller-supplied logical filename/);
    const firstOwner = prepared.owners[0]!;
    expect(() =>
      beginLinearIrCoverageGeneration({
        populationToken: prepared,
        generationKind: "single-source",
        entrySourceId: source.sourceId,
        entrySourceKey: source.sourceKey,
        sources: prepared.sources,
        owners: [
          {
            ...firstOwner,
            terminalRecord: { ...(firstOwner.terminalRecord as object), legacyMatchName: "other" },
          },
          ...prepared.owners.slice(1),
        ],
      }),
    ).toThrow(/source\/declaration\/terminal record/);
    expect(() =>
      beginLinearIrCoverageGeneration({
        populationToken: {},
        generationKind: "single-source",
        entrySourceId: source.sourceId,
        entrySourceKey: source.sourceKey,
        sources: prepared.sources,
        owners: prepared.owners,
      }),
    ).toThrow(/not an exact prepared population/);
  });

  it("rejects source, entry, kind, ordinal, count, and serializable-row mutations", () => {
    const census = completePopulation(population());
    const mutations: unknown[] = [];
    const wrongSource = clone(census);
    (wrongSource.sources[0] as { sourceKey: string }).sourceKey = "/absolute/entry.ts";
    mutations.push(wrongSource);
    const wrongEntry = clone(census);
    (wrongEntry as { entrySourceKey: string }).entrySourceKey = "other.ts";
    mutations.push(wrongEntry);
    const wrongKind = clone(census);
    (wrongKind.owners[0] as { terminalKind: string }).terminalKind = "module-init";
    mutations.push(wrongKind);
    const wrongSourceKind = clone(census);
    (wrongSourceKind.sources[0] as { kind: string }).kind = "source";
    mutations.push(wrongSourceKind);
    const wrongCount = clone(census);
    (wrongCount.counts as { owners: number }).owners++;
    mutations.push(wrongCount);
    const arrayOutcome = clone(census) as unknown as { owners: { outcome: unknown }[] };
    arrayOutcome.owners[0]!.outcome = [];
    mutations.push(arrayOutcome);
    const mapCounts = clone(census) as unknown as { counts: unknown };
    mapCounts.counts = new Map();
    mutations.push(mapCounts);
    const nonFinite = clone(census) as unknown as { counts: { compiled: number } };
    nonFinite.counts.compiled = Number.NaN;
    mutations.push(nonFinite);
    for (const mutation of mutations) expect(() => validateLinearIrCoverageCensus(mutation)).toThrow();
    const wrongOrdinal = clone(census) as unknown as { generationOrdinal: number };
    wrongOrdinal.generationOrdinal += 2;
    expect(() =>
      validateLinearIrCoverageCensus(wrongOrdinal, { afterWatermark: census.generationOrdinal - 1 }),
    ).toThrow(/stale/);
    expect(() => validateLinearIrCoverageCensus(census, { afterWatermark: census.generationOrdinal })).toThrow(/stale/);
    expect(validateLinearIrCoverageCensus(census, { afterWatermark: census.generationOrdinal - 1 })).toEqual(census);
    expect(JSON.stringify(census)).not.toContain("/virtual/");
    expect(sameLinearIrOwnerPopulation(census.owners.slice(1), census.owners)).toBe(false);
    expect(sameLinearIrOwnerPopulation([...census.owners, census.owners[0]!], census.owners)).toBe(false);
    expect(sameLinearIrOwnerPopulation(census.owners, census.owners)).toBe(true);
  });

  it("canonicalizes input order, property order, and excludes raw ordinals from persistent digests", () => {
    const prepared = population({
      "/virtual/z.ts": `export function zed(): number { return 2; }`,
      "/virtual/a.ts": `export function aye(): number { return 1; }`,
    });
    const runRaw = (reverse: boolean): LinearIrCoverageCensusV1 => {
      const sources = reverse ? [...prepared.sources].reverse() : prepared.sources;
      const owners = reverse ? [...prepared.owners].reverse() : prepared.owners;
      const entry = prepared.sources.find((source) => source.kind === "entry")!;
      const transaction = beginLinearIrCoverageGeneration({
        populationToken: prepared,
        generationKind: "multi-source",
        entrySourceId: entry.sourceId,
        entrySourceKey: entry.sourceKey,
        sources,
        owners,
      });
      return finalizeLinearIrCoverageGeneration(transaction, {
        populationToken: prepared,
        status: "complete",
        ownerEvidence: [],
        publicCompiled: [],
        publicRejected: [],
        unresolvedReason: "multi-source-overlay-unimplemented",
      });
    };
    const reversed = runRaw(true);
    const canonical = runRaw(false);
    expect(reversed.generationOrdinal).not.toBe(canonical.generationOrdinal);
    expect(linearIrCoverageDigestProjection(reversed)).toEqual(linearIrCoverageDigestProjection(canonical));
    expect(digest(reversed)).toBe(digest(canonical));
    expect(digest(canonical)).toMatch(/^[0-9a-f]{64}$/);
    const projection = linearIrCoverageDigestProjection(canonical) as unknown as Record<string, unknown>;
    const reordered = Object.fromEntries(Object.entries(projection).reverse());
    expect(canonicalLinearIrCoverageJson(reordered)).toBe(canonicalLinearIrCoverageJson(projection));
    expect(canonicalLinearIrCoverageJson(projection)).not.toContain("generationOrdinal");
  });

  it("keeps the committed baseline byte-exact and refuses implicit missing/malformed seeding", () => {
    expect(readFileSync(new URL("../scripts/linear-ir-baseline.json", import.meta.url), "utf8")).toBe(
      '{\n  "compiled": 8,\n  "buckets": {\n    "select:async-function": 4,\n    "select:body-shape-rejected": 24,\n    "select:call-graph-closure": 11,\n    "select:string-builder-candidate": 2\n  }\n}\n',
    );
    expect(() => parseLinearIrBaseline(undefined)).toThrow(/missing/);
    expect(() => parseLinearIrBaseline("{")).toThrow(/valid JSON/);
    expect(() => parseLinearIrBaseline('{"compiled":0,"buckets":{},"extra":true}')).toThrow(/fields/);
    expect(() => loadLinearIrBaselineForMode(undefined, false)).toThrow(/missing/);
    expect(loadLinearIrBaselineForMode(undefined, true)).toEqual({ replacementRequired: true });
    expect(loadLinearIrBaselineForMode("{", true)).toEqual({ replacementRequired: true });
    expect(compareLinearIrBaseline({ compiled: 7, buckets: {} }, { compiled: 8, buckets: {} })).toEqual([
      "IR-compiled function count DECREASED: 8 → 7",
    ]);
    expect(
      compareLinearIrBaseline({ compiled: 8, buckets: { build: 2 } }, { compiled: 8, buckets: { build: 1 } }),
    ).toEqual(["demotion bucket 'build' INCREASED: 1 → 2"]);
    expect(
      compareLinearIrBaseline({ compiled: 9, buckets: { build: 0 } }, { compiled: 8, buckets: { build: 1 } }),
    ).toEqual([]);
  });
});
