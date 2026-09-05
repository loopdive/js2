// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2956/#4550 — fail-closed linear-IR parity ratchet.
 *
 * The fixed playground corpus and threshold predicates are unchanged. Each
 * compile is authenticated by a fresh complete coverage census so a crash,
 * early validation return, missing report, or stale last-write-wins value can
 * never be counted as an empty success.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const LINEAR_IR_RATCHET_SCHEMA = "linear-ir-ratchet-evidence-v2" as const;

export interface LinearIrBaseline {
  readonly compiled: number;
  readonly buckets: Readonly<Record<string, number>>;
}

export interface LinearIrInstrumentationFailure {
  readonly logicalFileName: string;
  readonly code: string;
  readonly detail: string;
}

export interface LinearIrCompileErrorEvidence {
  readonly message: string;
  readonly line: number;
  readonly column: number;
  readonly severity: "error" | "warning";
  readonly code: number | null;
  readonly file: string | null;
}

export interface LinearIrCompileErrorProjection {
  readonly errors: readonly LinearIrCompileErrorEvidence[];
  readonly truncated: boolean;
}

interface RatchetModules {
  readonly compile: typeof import("../src/index.js").compile;
  readonly ts: typeof import("../src/ts-api.js").ts;
  readonly buildIrUnitInventory: typeof import("../src/ir/identity.js").buildIrUnitInventory;
  readonly buildIrPlanningIdentityContext: typeof import("../src/ir/planning-identity.js").buildIrPlanningIdentityContext;
  readonly getLastLinearIrReport: typeof import("../src/ir/backend/linear-integration.js").getLastLinearIrReport;
  readonly resetLastLinearIrReport: typeof import("../src/ir/backend/linear-integration.js").resetLastLinearIrReport;
  readonly indexLinearIrSourceOwners: typeof import("../src/ir/backend/linear-integration.js").indexLinearIrSourceOwners;
  readonly getLastLinearIrCoverageCensus: typeof import("../src/ir/backend/linear-ir-coverage.js").getLastLinearIrCoverageCensus;
  readonly resetLastLinearIrCoverageCensus: typeof import("../src/ir/backend/linear-ir-coverage.js").resetLastLinearIrCoverageCensus;
  readonly validateLinearIrCoverageCensus: typeof import("../src/ir/backend/linear-ir-coverage.js").validateLinearIrCoverageCensus;
  readonly linearIrCoverageDigestProjection: typeof import("../src/ir/backend/linear-ir-coverage.js").linearIrCoverageDigestProjection;
  readonly canonicalLinearIrCoverageJson: typeof import("../src/ir/backend/linear-ir-coverage.js").canonicalLinearIrCoverageJson;
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(scriptDirectory, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/linear-ir-baseline.json");
const CORPUS_ROOTS = [join(REPO_ROOT, "website/playground/examples")];
const LINEAR_IR_ENV = "JS2WASM_LINEAR_IR";
const LINEAR_IR_COVERAGE_ENV = "JS2WASM_LINEAR_IR_COVERAGE";

// biome-ignore lint/suspicious/noControlCharactersInRegex: evidence sanitization deliberately replaces C0 controls.
const ALL_CONTROL_CHARACTERS = /[\u0000-\u001f]/g;
// biome-ignore lint/suspicious/noControlCharactersInRegex: evidence sanitization deliberately retains only layout controls.
const NON_LAYOUT_CONTROL_CHARACTERS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g;

export function compareLinearIrRatchetText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareLinearIrRatchetText);
  const wanted = [...expected].sort(compareLinearIrRatchetText);
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function safeCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

/** Parse the committed two-field threshold contract; no implicit seeding. */
export function parseLinearIrBaseline(text: string | undefined): LinearIrBaseline {
  if (text === undefined) throw new Error("linear-ir baseline is missing");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("linear-ir baseline is not valid JSON");
  }
  if (!plainRecord(parsed) || !exactKeys(parsed, ["compiled", "buckets"]) || !safeCount(parsed.compiled)) {
    throw new Error("linear-ir baseline fields are malformed");
  }
  if (!plainRecord(parsed.buckets)) throw new Error("linear-ir baseline buckets are malformed");
  const buckets: Record<string, number> = {};
  for (const key of Object.keys(parsed.buckets).sort(compareLinearIrRatchetText)) {
    const count = parsed.buckets[key];
    if (key.length === 0 || !safeCount(count)) throw new Error("linear-ir baseline bucket entry is malformed");
    buckets[key] = count;
  }
  return Object.freeze({ compiled: parsed.compiled, buckets: Object.freeze(buckets) });
}

/** Missing/malformed input is replaceable only in explicit update mode. */
export function loadLinearIrBaselineForMode(
  text: string | undefined,
  update: boolean,
): { readonly baseline?: LinearIrBaseline; readonly replacementRequired: boolean } {
  try {
    return { baseline: parseLinearIrBaseline(text), replacementRequired: false };
  } catch (error) {
    if (!update) throw error;
    return { replacementRequired: true };
  }
}

function walk(directory: string, output: string[]): void {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory).sort(compareLinearIrRatchetText)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) walk(path, output);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) output.push(path);
  }
}

function logicalFileName(path: string): string {
  return relative(REPO_ROOT, path).split(sep).join("/");
}

function stableError(error: unknown): { readonly code: string; readonly detail: string } {
  const record = error !== null && typeof error === "object" ? (error as { name?: unknown; message?: unknown }) : {};
  const rawCode = typeof record.name === "string" ? record.name : "ThrownValue";
  const code = /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(rawCode) ? rawCode : "ThrownValue";
  const detail = String(record.message ?? error)
    .replaceAll(REPO_ROOT, "<repo>")
    .replace(/(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)(?:[^\s:;,)}\]]+[\\/]?)+/g, "<path>")
    .replace(/\r\n?/g, "\n")
    .replace(ALL_CONTROL_CHARACTERS, " ")
    .slice(0, 512);
  return { code, detail: detail || "unknown failure" };
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const MAX_COMPILE_ERROR_ROWS = 256;

function stableCompileErrorText(value: string, max: number): string {
  return value
    .replaceAll(REPO_ROOT, "<repo>")
    .replace(/(?:file:\/\/)?(?:[A-Za-z]:[\\/]|\/)(?:[^\s:;,)}\]]+[\\/]?)+/g, "<path>")
    .replace(/\r\n?/g, "\n")
    .replace(NON_LAYOUT_CONTROL_CHARACTERS, " ")
    .slice(0, max);
}

/** Stable bounded diagnostics retained even when generation precedes public failure. */
export function projectLinearIrCompileErrors(
  errors: readonly {
    readonly message: string;
    readonly line: number;
    readonly column: number;
    readonly severity: "error" | "warning";
    readonly code?: number;
    readonly file?: string;
  }[],
): LinearIrCompileErrorProjection {
  const projected = errors.map(
    (error): LinearIrCompileErrorEvidence => ({
      message: stableCompileErrorText(error.message, 512),
      line: safeCount(error.line) ? error.line : 0,
      column: safeCount(error.column) ? error.column : 0,
      severity: error.severity,
      code: safeCount(error.code) ? error.code : null,
      file: error.file === undefined ? null : stableCompileErrorText(error.file, 256),
    }),
  );
  projected.sort((left, right) => compareLinearIrRatchetText(JSON.stringify(left), JSON.stringify(right)));
  return Object.freeze({
    errors: Object.freeze(projected.slice(0, MAX_COMPILE_ERROR_ROWS).map((error) => Object.freeze(error))),
    truncated: projected.length > MAX_COMPILE_ERROR_ROWS,
  });
}

export function digestLinearIrCompileErrors(errorCount: number, projection: LinearIrCompileErrorProjection): string {
  if (
    !safeCount(errorCount) ||
    errorCount < projection.errors.length ||
    projection.truncated !== errorCount > projection.errors.length
  ) {
    throw new Error("linear-ir compile error projection does not reconcile with its exact count");
  }
  return sha256(JSON.stringify({ errorCount, errors: projection.errors, truncated: projection.truncated }));
}

export function linearIrGenerationContributionEligible(input: {
  readonly compileStatus: "returned" | "threw";
  readonly censusStatus: "complete" | "generation-failed" | "missing" | "malformed";
  readonly instrumentationFailureCount: number;
}): boolean {
  return (
    input.compileStatus === "returned" && input.censusStatus === "complete" && input.instrumentationFailureCount === 0
  );
}

async function loadRatchetModules(): Promise<RatchetModules> {
  const [compiler, tsApi, identity, planningIdentity, integration, coverage] = await Promise.all([
    import("../src/index.js"),
    import("../src/ts-api.js"),
    import("../src/ir/identity.js"),
    import("../src/ir/planning-identity.js"),
    import("../src/ir/backend/linear-integration.js"),
    import("../src/ir/backend/linear-ir-coverage.js"),
  ]);
  return {
    compile: compiler.compile,
    ts: tsApi.ts,
    buildIrUnitInventory: identity.buildIrUnitInventory,
    buildIrPlanningIdentityContext: planningIdentity.buildIrPlanningIdentityContext,
    getLastLinearIrReport: integration.getLastLinearIrReport,
    resetLastLinearIrReport: integration.resetLastLinearIrReport,
    indexLinearIrSourceOwners: integration.indexLinearIrSourceOwners,
    getLastLinearIrCoverageCensus: coverage.getLastLinearIrCoverageCensus,
    resetLastLinearIrCoverageCensus: coverage.resetLastLinearIrCoverageCensus,
    validateLinearIrCoverageCensus: coverage.validateLinearIrCoverageCensus,
    linearIrCoverageDigestProjection: coverage.linearIrCoverageDigestProjection,
    canonicalLinearIrCoverageJson: coverage.canonicalLinearIrCoverageJson,
  };
}

interface ExpectedOwnerIdentity {
  readonly ownerUnitId: string;
  readonly sourceId: string;
  readonly sourceKey: string;
  readonly legacyName: string;
  readonly terminalKind: string;
  readonly observedKind: string;
}

function expectedPopulation(modules: RatchetModules, fileName: string, source: string) {
  const sourceFile = modules.ts.createSourceFile(
    fileName,
    source,
    modules.ts.ScriptTarget.ESNext,
    true,
    modules.ts.ScriptKind.TS,
  );
  const inventory = modules.buildIrUnitInventory([sourceFile], { entrySource: sourceFile });
  if (inventory.sources.length !== 1 || inventory.sources[0]?.originalFileName !== fileName) {
    throw new Error(`logical source ${fileName} did not produce one exact inventory row`);
  }
  const row = inventory.sources[0]!;
  const identityContext = modules.buildIrPlanningIdentityContext(inventory);
  const owners = modules.indexLinearIrSourceOwners(sourceFile, identityContext).owners.map((owner) => {
    const terminal = identityContext.terminalByUnitId.get(owner.ownerUnitId);
    if (!terminal) throw new Error(`expected owner ${owner.ownerUnitId} lost its terminal row`);
    return {
      ownerUnitId: owner.ownerUnitId,
      sourceId: terminal.sourceId,
      sourceKey: row.sourceKey,
      legacyName: owner.legacyName,
      terminalKind: terminal.kind,
      observedKind: terminal.observedKind,
    };
  });
  owners.sort((left, right) => compareLinearIrRatchetText(left.ownerUnitId, right.ownerUnitId));
  return {
    source: { sourceId: row.id, sourceKey: row.sourceKey, kind: row.kind, order: row.order },
    owners,
  };
}

function sameSourceRow(
  actual: { readonly sourceId: string; readonly sourceKey: string; readonly kind: string; readonly order: number },
  expected: { readonly sourceId: string; readonly sourceKey: string; readonly kind: string; readonly order: number },
): boolean {
  return (
    actual.sourceId === expected.sourceId &&
    actual.sourceKey === expected.sourceKey &&
    actual.kind === expected.kind &&
    actual.order === expected.order
  );
}

export function sameLinearIrOwnerPopulation(
  actual: readonly ExpectedOwnerIdentity[],
  expected: readonly ExpectedOwnerIdentity[],
): boolean {
  return (
    actual.length === expected.length &&
    actual.every((owner, index) => {
      const wanted = expected[index];
      return (
        wanted !== undefined &&
        owner.ownerUnitId === wanted.ownerUnitId &&
        owner.sourceId === wanted.sourceId &&
        owner.sourceKey === wanted.sourceKey &&
        owner.legacyName === wanted.legacyName &&
        owner.terminalKind === wanted.terminalKind &&
        owner.observedKind === wanted.observedKind
      );
    })
  );
}

interface FileEvidence {
  readonly logicalFileName: string;
  readonly generationSequence: number;
  readonly expectedEntry: { readonly sourceId: string; readonly sourceKey: string };
  readonly compile:
    | {
        readonly status: "returned";
        readonly success: boolean;
        readonly errorCount: number;
        readonly errorProjection: LinearIrCompileErrorProjection;
        readonly errorsSha256: string;
      }
    | { readonly status: "threw"; readonly code: string; readonly detail: string };
  readonly report:
    | {
        readonly status: "present";
        readonly compiled: readonly string[];
        readonly rejected: readonly { readonly func: string; readonly reason: string }[];
      }
    | { readonly status: "missing" };
  readonly census:
    | { readonly status: "missing" | "malformed" }
    | {
        readonly status: "complete" | "generation-failed";
        readonly counts: {
          readonly sources: number;
          readonly owners: number;
          readonly compiled: number;
          readonly rejected: number;
          readonly notAttempted: number;
        };
        readonly sha256: string;
        readonly evidence: unknown;
      };
  readonly instrumentationFailures: readonly LinearIrInstrumentationFailure[];
}

async function measureFile(
  modules: RatchetModules,
  path: string,
  generationSequence: number,
): Promise<{ readonly evidence: FileEvidence; readonly baselineContribution?: LinearIrBaseline }> {
  const fileName = logicalFileName(path);
  const source = readFileSync(path, "utf8");
  const expected = expectedPopulation(modules, fileName, source);
  const failures: LinearIrInstrumentationFailure[] = [];
  const fail = (code: string, detail: string): void => {
    failures.push({ logicalFileName: fileName, code, detail });
  };

  modules.resetLastLinearIrReport();
  const watermark = modules.resetLastLinearIrCoverageCensus();
  let result: Awaited<ReturnType<RatchetModules["compile"]>> | undefined;
  let thrown: unknown;
  let didThrow = false;
  try {
    result = await modules.compile(source, { target: "linear", fileName });
  } catch (error) {
    didThrow = true;
    thrown = error;
  }
  // Capture both channels before any other compile or compiler-derived work.
  const report = modules.getLastLinearIrReport();
  const rawCensus = modules.getLastLinearIrCoverageCensus();

  const compileEvidence = didThrow
    ? ({ status: "threw", ...stableError(thrown) } as const)
    : (() => {
        const errors = result?.errors ?? [];
        const errorProjection = projectLinearIrCompileErrors(errors);
        return {
          status: "returned",
          success: result?.success === true,
          errorCount: errors.length,
          errorProjection,
          errorsSha256: digestLinearIrCompileErrors(errors.length, errorProjection),
        } as const;
      })();
  if (compileEvidence.status === "threw") fail("compile-threw", compileEvidence.detail);

  const reportEvidence = report
    ? ({
        status: "present",
        compiled: Object.freeze([...report.compiled]),
        rejected: Object.freeze(report.rejected.map(({ func, reason }) => ({ func, reason }))),
      } as const)
    : ({ status: "missing" } as const);
  if (!report) fail("missing-compatibility-report", "linear generator did not publish its compatibility report");

  let censusEvidence: FileEvidence["census"] = { status: "missing" };
  let contribution: LinearIrBaseline | undefined;
  if (!rawCensus) {
    fail("missing-coverage-census", "linear generator did not finalize a coverage census");
  } else {
    try {
      const census = modules.validateLinearIrCoverageCensus(rawCensus, { afterWatermark: watermark });
      const projection = modules.linearIrCoverageDigestProjection(census);
      const canonical = modules.canonicalLinearIrCoverageJson(projection);
      censusEvidence = {
        status: census.status,
        counts: census.counts,
        sha256: sha256(canonical),
        evidence: projection,
      };
      if (census.generationKind !== "single-source") fail("wrong-generation-kind", census.generationKind);
      if (census.status !== "complete") fail("generation-failed", census.failure?.detail ?? "missing failure detail");
      if (
        census.sources.length !== 1 ||
        !sameSourceRow(census.sources[0]!, expected.source) ||
        census.entrySourceId !== expected.source.sourceId ||
        census.entrySourceKey !== expected.source.sourceKey
      ) {
        fail("source-identity-mismatch", "census entry/source rows do not match the logical compiler input");
      }
      if (!sameLinearIrOwnerPopulation(census.owners, expected.owners)) {
        fail("owner-population-mismatch", "census owner rows do not match the authoritative logical-input population");
      }
      if (
        report &&
        (report.compiled.length !== census.counts.compiled || report.rejected.length !== census.counts.rejected)
      ) {
        fail("report-census-count-mismatch", "compatibility report counts do not match structural owner outcomes");
      }
      if (
        linearIrGenerationContributionEligible({
          compileStatus: compileEvidence.status,
          censusStatus: census.status,
          instrumentationFailureCount: failures.length,
        })
      ) {
        const bucketCounts = new Map<string, number>();
        for (const owner of census.owners) {
          if (owner.outcome.kind === "rejected") {
            bucketCounts.set(owner.outcome.reason, (bucketCounts.get(owner.outcome.reason) ?? 0) + 1);
          }
        }
        contribution = {
          compiled: census.counts.compiled,
          buckets: Object.fromEntries([...bucketCounts].sort(([a], [b]) => compareLinearIrRatchetText(a, b))),
        };
      }
    } catch (error) {
      censusEvidence = { status: "malformed" };
      fail("malformed-coverage-census", stableError(error).detail);
    }
  }
  return {
    evidence: {
      logicalFileName: fileName,
      generationSequence,
      expectedEntry: { sourceId: expected.source.sourceId, sourceKey: expected.source.sourceKey },
      compile: compileEvidence,
      report: reportEvidence,
      census: censusEvidence,
      instrumentationFailures: Object.freeze(failures),
    },
    ...(contribution ? { baselineContribution: contribution } : {}),
  };
}

function mergeContributions(contributions: readonly LinearIrBaseline[]): LinearIrBaseline {
  let compiled = 0;
  const buckets = new Map<string, number>();
  for (const contribution of contributions) {
    compiled += contribution.compiled;
    for (const [reason, count] of Object.entries(contribution.buckets)) {
      buckets.set(reason, (buckets.get(reason) ?? 0) + count);
    }
  }
  return {
    compiled,
    buckets: Object.fromEntries([...buckets].sort(([a], [b]) => compareLinearIrRatchetText(a, b))),
  };
}

export function compareLinearIrBaseline(current: LinearIrBaseline, baseline: LinearIrBaseline): readonly string[] {
  const failures: string[] = [];
  if (current.compiled < baseline.compiled) {
    failures.push(`IR-compiled function count DECREASED: ${baseline.compiled} → ${current.compiled}`);
  }
  for (const [reason, count] of Object.entries(current.buckets)) {
    const prior = baseline.buckets[reason] ?? 0;
    if (count > prior) failures.push(`demotion bucket '${reason}' INCREASED: ${prior} → ${count}`);
  }
  return failures;
}

export async function runLinearIrRatchet(args: readonly string[] = process.argv.slice(2)): Promise<number> {
  const unknownArgs = args.filter((arg) => arg !== "--json" && arg !== "--update");
  const json = args.includes("--json");
  const update = args.includes("--update");
  const files: string[] = [];
  for (const root of CORPUS_ROOTS) walk(root, files);
  files.sort((left, right) => compareLinearIrRatchetText(logicalFileName(left), logicalFileName(right)));
  const expectedFiles = files.map(logicalFileName);
  const allFailures: LinearIrInstrumentationFailure[] = unknownArgs.map((arg) => ({
    logicalFileName: "<arguments>",
    code: "unknown-argument",
    detail: arg,
  }));
  if (expectedFiles.length === 0) {
    allFailures.push({
      logicalFileName: "<census>",
      code: "empty-corpus",
      detail: "no expected TypeScript files were discovered",
    });
  }

  const priorLinearIr = process.env[LINEAR_IR_ENV];
  const priorCoverage = process.env[LINEAR_IR_COVERAGE_ENV];
  process.env[LINEAR_IR_ENV] = "1";
  process.env[LINEAR_IR_COVERAGE_ENV] = "1";
  const perFile: FileEvidence[] = [];
  const contributions: LinearIrBaseline[] = [];
  try {
    const modules = await loadRatchetModules();
    for (let index = 0; index < files.length; index++) {
      if (!json) process.stderr.write(`linear-ir ratchet: measuring ${expectedFiles[index]}\n`);
      const measured = await measureFile(modules, files[index]!, index + 1);
      perFile.push(measured.evidence);
      allFailures.push(...measured.evidence.instrumentationFailures);
      if (measured.baselineContribution) contributions.push(measured.baselineContribution);
    }
  } finally {
    if (priorLinearIr === undefined) delete process.env[LINEAR_IR_ENV];
    else process.env[LINEAR_IR_ENV] = priorLinearIr;
    if (priorCoverage === undefined) delete process.env[LINEAR_IR_COVERAGE_ENV];
    else process.env[LINEAR_IR_COVERAGE_ENV] = priorCoverage;
  }

  const observedFiles = perFile.map((row) => row.logicalFileName);
  if (
    observedFiles.length !== expectedFiles.length ||
    observedFiles.some((file, index) => file !== expectedFiles[index])
  ) {
    allFailures.push({
      logicalFileName: "<census>",
      code: "file-census-mismatch",
      detail: `expected ${expectedFiles.length}, observed ${observedFiles.length}`,
    });
  }
  const current = mergeContributions(contributions);
  let baseline: LinearIrBaseline | undefined;
  let replacementRequired = false;
  try {
    const loaded = loadLinearIrBaselineForMode(
      existsSync(BASELINE_PATH) ? readFileSync(BASELINE_PATH, "utf8") : undefined,
      update,
    );
    baseline = loaded.baseline;
    replacementRequired = loaded.replacementRequired;
  } catch (error) {
    allFailures.push({ logicalFileName: "<baseline>", code: "invalid-baseline", detail: stableError(error).detail });
  }
  const thresholdFailures = baseline ? compareLinearIrBaseline(current, baseline) : [];
  const instrumentationPassed = allFailures.length === 0 && contributions.length === expectedFiles.length;
  let baselineUpdated = false;
  if (update && instrumentationPassed) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    baselineUpdated = true;
  }
  const passed = instrumentationPassed && (update || (baseline !== undefined && thresholdFailures.length === 0));
  const evidence = {
    schema: LINEAR_IR_RATCHET_SCHEMA,
    expectedFiles,
    observedFiles,
    current,
    baseline: baseline ?? null,
    replacementRequired,
    baselineUpdated,
    perFile,
    instrumentationFailures: allFailures,
    thresholdFailures,
    status: passed ? "PASS" : "FAIL",
  } as const;

  if (json) {
    process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
  } else if (passed) {
    process.stdout.write(
      `linear-ir ratchet: OK — files=${observedFiles.length}, compiled=${current.compiled}, buckets=${JSON.stringify(current.buckets)}${baselineUpdated ? " [baseline updated]" : ""}\n`,
    );
  } else {
    process.stderr.write("linear-ir ratchet: FAIL\n");
    for (const failure of allFailures) {
      process.stderr.write(`  - ${failure.logicalFileName} ${failure.code}: ${failure.detail}\n`);
    }
    for (const failure of thresholdFailures) process.stderr.write(`  - ${failure}\n`);
  }
  return passed ? 0 : 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runLinearIrRatchet();
  } catch (error) {
    const failure = stableError(error);
    if (process.argv.includes("--json")) {
      process.stdout.write(
        `${JSON.stringify({ schema: LINEAR_IR_RATCHET_SCHEMA, status: "FAIL", instrumentationFailures: [failure] }, null, 2)}\n`,
      );
    } else {
      process.stderr.write(`linear-ir ratchet: FAIL — ${failure.code}: ${failure.detail}\n`);
    }
    process.exitCode = 1;
  }
}
