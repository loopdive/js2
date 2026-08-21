// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/** #3519 — bounded, non-vacuous IR-only readiness report. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { compile, type CompileResult, type IrObservedOutcome, type IrOutcomePolicy } from "../src/index.js";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(SCRIPT_PATH), "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/ir-only-baseline.json");

export const SINGLE_HOST_ENTRIES = [
  "website/playground/examples/dom/calendar.ts",
  "website/playground/examples/js/algorithms.ts",
  "website/playground/examples/js/async.ts",
  "website/playground/examples/js/builtins.ts",
  "website/playground/examples/js/classes.ts",
] as const;

/**
 * #3518 standalone lane — the SAME five terminals compiled with
 * `target: "standalone"` (no JS host imports). #4577 closes the bounded
 * playground population at 38/38 compile-once IR bodies, so this lane now uses
 * strict `"ir-only"` readiness rather than the temporary baseline-only mode.
 * Wider compiler reachability remains a separate R9/R10 requirement.
 */
export const STANDALONE_ENTRIES = SINGLE_HOST_ENTRIES;

export type IrOnlyEntryFailureCode = "compile-threw" | "compile-failed" | "fatal-diagnostic" | "missing-telemetry";

export interface IrOnlyEntryFailure {
  readonly code: IrOnlyEntryFailureCode;
  readonly detail: string;
}

export interface IrOnlyEntryObservation {
  readonly entry: string;
  readonly success: boolean;
  readonly outcomes: readonly IrObservedOutcome[];
  readonly hardDiagnostics: readonly string[];
  readonly irPostClaimErrors: readonly { kind: string; func: string; message: string }[];
  readonly irCompiledFuncs: readonly string[];
  readonly irFirstSkipped: readonly string[];
  readonly failures: readonly IrOnlyEntryFailure[];
}

/**
 * How a lane participates in the `--policy=ir-only` verdict.
 *
 * - `"ir-only"` (default): the lane must be compile-once — zero unsupported
 *   units, zero legacy bodies, one IR body per terminal.
 * - `"baseline"`: the lane is measured and ratcheted against its committed
 *   floors/ceilings, but is not asserted to be IR-only. Every anti-vacuity,
 *   telemetry-consistency, invariant, and baseline check still applies; only
 *   the compile-once assertions are withheld.
 */
export type IrOnlyLaneReadiness = "ir-only" | "baseline";

export interface IrOnlyLaneObservation {
  readonly name: string;
  readonly expectedEntries: number;
  readonly entries: readonly IrOnlyEntryObservation[];
  /** Defaults to `"ir-only"` when absent. */
  readonly readiness?: IrOnlyLaneReadiness;
}

export interface IrOnlyBaselineLane {
  readonly entryFloor: number;
  readonly terminalUnitFloor: number;
  readonly emittedFloor: number;
  readonly irBodyEmittedFloor: number;
  readonly legacyBodyEmittedCeiling: number;
  readonly unsupportedCeiling: number;
  readonly unsupportedByCode: Readonly<Record<string, number>>;
  readonly invariantCeiling: 0;
  /**
   * (#4508) Why a floor/ceiling sits where it does. JSON has no comments and a
   * ratchet number with no rationale is unreviewable; `baselineFrom` carries
   * these across `--update` so a reseed cannot silently drop them.
   */
  readonly notes?: readonly string[];
}

export interface IrOnlyBaseline {
  readonly schemaVersion: 1;
  readonly generated: string;
  readonly lanes: Readonly<Record<string, IrOnlyBaselineLane>>;
}

export interface IrOnlyLaneSummary {
  readonly name: string;
  readonly readiness: IrOnlyLaneReadiness;
  readonly entries: number;
  readonly expectedEntries: number;
  readonly terminalUnits: number;
  readonly emitted: number;
  readonly unsupported: number;
  readonly invariants: number;
  readonly legacyBodyEmitted: number;
  readonly irBodyEmitted: number;
  readonly byUnitKind: Readonly<Record<string, number>>;
  readonly byTarget: Readonly<Record<string, number>>;
  readonly unsupportedByCode: Readonly<Record<string, number>>;
  readonly blockers: readonly string[];
}

export interface IrOnlyGateVerdict {
  readonly policy: IrOutcomePolicy;
  readonly ready: boolean;
  readonly lanes: readonly IrOnlyLaneSummary[];
  readonly failures: readonly string[];
}

export type CompileSeedEntry = (source: string, entry: string) => Promise<CompileResult>;

const defaultCompileSeedEntry: CompileSeedEntry = (source, entry) =>
  compile(source, { fileName: entry, trackIrOutcomes: true });

const standaloneCompileSeedEntry: CompileSeedEntry = (source, entry) =>
  compile(source, { fileName: entry, trackIrOutcomes: true, target: "standalone" });

async function observeLane(
  name: string,
  entries: readonly string[],
  compileEntry: CompileSeedEntry,
  readiness: IrOnlyLaneReadiness,
  expectedEntries: number,
): Promise<IrOnlyLaneObservation> {
  const observations: IrOnlyEntryObservation[] = [];
  for (const entry of entries) {
    const failures: IrOnlyEntryFailure[] = [];
    let result: CompileResult | undefined;
    try {
      const source = readFileSync(resolve(REPO_ROOT, entry), "utf8");
      result = await compileEntry(source, entry);
    } catch (error) {
      failures.push({
        code: "compile-threw",
        detail: error instanceof Error ? error.message : String(error),
      });
    }

    const hardDiagnostics = (result?.errors ?? [])
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => diagnostic.message);
    const outcomes = result?.irOutcomes ? [...result.irOutcomes] : [];
    if (result && !result.success) {
      failures.push({ code: "compile-failed", detail: "compile returned success:false" });
    }
    if (hardDiagnostics.length > 0) {
      failures.push({
        code: "fatal-diagnostic",
        detail: `${hardDiagnostics.length} fatal result diagnostic(s): ${hardDiagnostics.join(" | ")}`,
      });
    }
    if (result && result.irOutcomes === undefined) {
      failures.push({ code: "missing-telemetry", detail: "CompileResult.irOutcomes is absent" });
    }
    observations.push({
      entry,
      success: result?.success === true,
      outcomes,
      hardDiagnostics,
      irPostClaimErrors: result?.irPostClaimErrors ?? [],
      irCompiledFuncs: result?.irCompiledFuncs ?? [],
      irFirstSkipped: result?.irFirstSkipped ?? [],
      failures,
    });
  }
  return { name, expectedEntries, entries: observations, readiness };
}

export async function observeSingleHostLane(
  entries: readonly string[] = SINGLE_HOST_ENTRIES,
  compileEntry: CompileSeedEntry = defaultCompileSeedEntry,
): Promise<IrOnlyLaneObservation> {
  return observeLane("single-host", entries, compileEntry, "ir-only", SINGLE_HOST_ENTRIES.length);
}

export async function observeStandaloneLane(
  entries: readonly string[] = STANDALONE_ENTRIES,
  compileEntry: CompileSeedEntry = standaloneCompileSeedEntry,
): Promise<IrOnlyLaneObservation> {
  return observeLane("standalone", entries, compileEntry, "ir-only", STANDALONE_ENTRIES.length);
}

function bump(target: Record<string, number>, key: string): void {
  target[key] = (target[key] ?? 0) + 1;
}

function summarizeLane(lane: IrOnlyLaneObservation): IrOnlyLaneSummary {
  const allOutcomes = lane.entries.flatMap((entry) => entry.outcomes);
  const byUnitKind: Record<string, number> = {};
  const byTarget: Record<string, number> = {};
  const unsupportedByCode: Record<string, number> = {};
  const blockers: string[] = [];
  let emitted = 0;
  let unsupported = 0;
  let invariants = 0;
  let legacyBodyEmitted = 0;
  let irBodyEmitted = 0;
  for (const outcome of allOutcomes) {
    bump(byUnitKind, outcome.unitKind);
    bump(byTarget, `${outcome.backend}/${outcome.target}`);
    if (outcome.kind === "emitted") emitted += 1;
    if (outcome.kind === "unsupported") {
      unsupported += 1;
      bump(unsupportedByCode, `${outcome.stage}/${outcome.code}`);
      blockers.push(`${outcome.key}: unsupported/${outcome.stage}/${outcome.code}`);
    }
    if (outcome.kind === "invariant") {
      invariants += 1;
      blockers.push(`${outcome.key}: invariant/${outcome.stage}/${outcome.code}`);
    }
    if (outcome.legacyBodyEmitted) legacyBodyEmitted += 1;
    if (outcome.irBodyEmitted) irBodyEmitted += 1;
  }
  return {
    name: lane.name,
    readiness: lane.readiness ?? "ir-only",
    entries: lane.entries.length,
    expectedEntries: lane.expectedEntries,
    terminalUnits: allOutcomes.length,
    emitted,
    unsupported,
    invariants,
    legacyBodyEmitted,
    irBodyEmitted,
    byUnitKind,
    byTarget,
    unsupportedByCode,
    blockers: blockers.sort(),
  };
}

/**
 * Apply anti-vacuity, compile-result, baseline, and readiness policy checks to
 * already-observed outcomes. Tests use the same evaluator as the CLI.
 */
export function evaluateIrOnlyReport(
  lanes: readonly IrOnlyLaneObservation[],
  baseline: IrOnlyBaseline,
  policy: IrOutcomePolicy,
): IrOnlyGateVerdict {
  const failures: string[] = [];
  const summaries = lanes.map(summarizeLane);
  if (lanes.length === 0) failures.push("report has no lanes");
  if (new Set(lanes.map((lane) => lane.name)).size !== lanes.length) failures.push("report has duplicate lane names");

  for (const lane of lanes) {
    const summary = summaries.find((candidate) => candidate.name === lane.name)!;
    const expected = baseline.lanes[lane.name];
    if (!expected) failures.push(`${lane.name}: missing committed baseline lane`);
    if (lane.entries.length === 0) failures.push(`${lane.name}: empty corpus`);
    if (lane.entries.length !== lane.expectedEntries) {
      failures.push(`${lane.name}: observed ${lane.entries.length}/${lane.expectedEntries} named entries`);
    }
    if (summary.terminalUnits === 0) failures.push(`${lane.name}: zero terminal units`);
    if (summary.emitted === 0) failures.push(`${lane.name}: zero emitted units`);

    const keys = lane.entries.flatMap((entry) => entry.outcomes.map((outcome) => outcome.key));
    if (new Set(keys).size !== keys.length) failures.push(`${lane.name}: duplicate observational outcome keys`);
    for (const entry of lane.entries) {
      if (entry.outcomes.length === 0) failures.push(`${lane.name}/${entry.entry}: missing terminal telemetry`);
      for (const failure of entry.failures) {
        failures.push(`${lane.name}/${entry.entry}: ${failure.code}: ${failure.detail}`);
      }

      const outcomesByName = new Map<string, IrObservedOutcome[]>();
      for (const outcome of entry.outcomes) {
        const sameName = outcomesByName.get(outcome.displayName);
        if (sameName) sameName.push(outcome);
        else outcomesByName.set(outcome.displayName, [outcome]);
      }
      const compiled = new Set(entry.irCompiledFuncs);
      const skipped = new Set(entry.irFirstSkipped);
      for (const outcome of entry.outcomes) {
        if (typeof outcome.legacyBodyEmitted !== "boolean") {
          failures.push(
            `${lane.name}/${entry.entry}: terminal ${outcome.displayName} lacks observable legacy-body evidence`,
          );
        }
        if (outcome.kind === "emitted" && !compiled.has(outcome.displayName)) {
          failures.push(
            `${lane.name}/${entry.entry}: emitted terminal ${outcome.displayName} is absent from irCompiledFuncs`,
          );
        }
        if (outcome.kind === "emitted" && !outcome.irBodyEmitted) {
          failures.push(`${lane.name}/${entry.entry}: emitted terminal ${outcome.displayName} lacks IR body evidence`);
        }
        if (outcome.kind !== "emitted" && outcome.irBodyEmitted) {
          failures.push(`${lane.name}/${entry.entry}: non-emitted terminal ${outcome.displayName} claims an IR body`);
        }
        if (outcome.kind === "unsupported" && !outcome.legacyBodyEmitted) {
          failures.push(
            `${lane.name}/${entry.entry}: unsupported terminal ${outcome.displayName} has no retained legacy body`,
          );
        }
        if (outcome.unitKind === "function" && !outcome.legacyBodyEmitted && !skipped.has(outcome.displayName)) {
          failures.push(
            `${lane.name}/${entry.entry}: non-legacy function ${outcome.displayName} is absent from irFirstSkipped`,
          );
        }
      }
      for (const name of compiled) {
        const sourceOutcomes = outcomesByName.get(name);
        // Lifted and monomorphized artifacts intentionally have no source row.
        if (sourceOutcomes && !sourceOutcomes.some((outcome) => outcome.kind === "emitted")) {
          failures.push(`${lane.name}/${entry.entry}: irCompiledFuncs source ${name} has no emitted terminal`);
        }
      }
      for (const name of skipped) {
        const sourceOutcomes = outcomesByName.get(name);
        if (!sourceOutcomes?.some((outcome) => outcome.unitKind === "function" && !outcome.legacyBodyEmitted)) {
          failures.push(`${lane.name}/${entry.entry}: irFirstSkipped source ${name} has no non-legacy terminal`);
        }
      }
      for (const error of entry.irPostClaimErrors) {
        const sourceOutcomes = outcomesByName.get(error.func);
        if (!sourceOutcomes) {
          failures.push(`${lane.name}/${entry.entry}: post-claim error ${error.func} has no source terminal`);
        } else if (!sourceOutcomes.some((outcome) => outcome.kind !== "emitted")) {
          failures.push(`${lane.name}/${entry.entry}: post-claim error ${error.func} contradicts emitted terminal`);
        }
      }
    }

    if (summary.invariants > 0) failures.push(`${lane.name}: ${summary.invariants} invariant outcome(s)`);
    if (expected) {
      if (summary.entries < expected.entryFloor) {
        failures.push(`${lane.name}: entry floor regressed ${summary.entries} < ${expected.entryFloor}`);
      }
      if (summary.terminalUnits < expected.terminalUnitFloor) {
        failures.push(
          `${lane.name}: terminal-unit floor regressed ${summary.terminalUnits} < ${expected.terminalUnitFloor}`,
        );
      }
      if (summary.emitted < expected.emittedFloor) {
        failures.push(`${lane.name}: emitted floor regressed ${summary.emitted} < ${expected.emittedFloor}`);
      }
      if (summary.irBodyEmitted < expected.irBodyEmittedFloor) {
        failures.push(
          `${lane.name}: IR-body-emitted floor regressed ${summary.irBodyEmitted} < ${expected.irBodyEmittedFloor}`,
        );
      }
      if (!Number.isSafeInteger(expected.legacyBodyEmittedCeiling) || expected.legacyBodyEmittedCeiling < 0) {
        failures.push(`${lane.name}: missing or invalid legacy-body-emitted ceiling`);
      } else if (summary.legacyBodyEmitted > expected.legacyBodyEmittedCeiling) {
        failures.push(
          `${lane.name}: legacy-body-emitted population grew ${summary.legacyBodyEmitted} > ${expected.legacyBodyEmittedCeiling}`,
        );
      }
      if (summary.unsupported > expected.unsupportedCeiling) {
        failures.push(
          `${lane.name}: unsupported population grew ${summary.unsupported} > ${expected.unsupportedCeiling}`,
        );
      }
      for (const [code, current] of Object.entries(summary.unsupportedByCode)) {
        const ceiling = expected.unsupportedByCode[code] ?? 0;
        if (current > ceiling) failures.push(`${lane.name}: unsupported ${code} grew ${current} > ${ceiling}`);
      }
      if (summary.invariants > expected.invariantCeiling) {
        failures.push(`${lane.name}: invariant population grew ${summary.invariants} > ${expected.invariantCeiling}`);
      }
    }

    // A `"baseline"` lane is measured and ratcheted but never asserted to be
    // compile-once. Withholding only these three assertions keeps every
    // anti-vacuity/telemetry/baseline check above live for the lane, so an
    // honestly-red lane cannot become a blind spot (#3518 rule 5).
    if (policy === "ir-only" && summary.readiness === "ir-only") {
      if (summary.unsupported > 0) failures.push(`${lane.name}: ${summary.unsupported} unsupported unit(s)`);
      if (summary.legacyBodyEmitted > 0) {
        failures.push(`${lane.name}: ${summary.legacyBodyEmitted} unit(s) still emitted a legacy body`);
      }
      if (summary.irBodyEmitted !== summary.terminalUnits) {
        failures.push(
          `${lane.name}: IR emitted ${summary.irBodyEmitted}/${summary.terminalUnits} terminal source units`,
        );
      }
    }
  }

  for (const laneName of Object.keys(baseline.lanes)) {
    if (!lanes.some((lane) => lane.name === laneName)) failures.push(`${laneName}: required lane is missing`);
  }
  return { policy, ready: failures.length === 0, lanes: summaries, failures: [...new Set(failures)] };
}

export function baselineFrom(lanes: readonly IrOnlyLaneObservation[], previous?: IrOnlyBaseline): IrOnlyBaseline {
  const baselineLanes: Record<string, IrOnlyBaselineLane> = {};
  for (const summary of lanes.map(summarizeLane)) {
    const notes = previous?.lanes[summary.name]?.notes;
    baselineLanes[summary.name] = {
      ...(notes && notes.length > 0 ? { notes } : {}),
      entryFloor: summary.entries,
      terminalUnitFloor: summary.terminalUnits,
      emittedFloor: summary.emitted,
      irBodyEmittedFloor: summary.irBodyEmitted,
      legacyBodyEmittedCeiling: summary.legacyBodyEmitted,
      unsupportedCeiling: summary.unsupported,
      unsupportedByCode: summary.unsupportedByCode,
      invariantCeiling: 0,
    };
  }
  return {
    schemaVersion: 1,
    generated: new Date().toISOString().slice(0, 10),
    lanes: baselineLanes,
  };
}

function loadBaseline(): IrOnlyBaseline {
  if (!existsSync(BASELINE_PATH)) throw new Error(`missing ${relative(REPO_ROOT, BASELINE_PATH)}`);
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as IrOnlyBaseline;
  if (parsed.schemaVersion !== 1) throw new Error(`unsupported IR-only baseline schema ${parsed.schemaVersion}`);
  return parsed;
}

function printHuman(verdict: IrOnlyGateVerdict): void {
  for (const lane of verdict.lanes) {
    process.stdout.write(`\nIR-only readiness lane: ${lane.name} (${lane.readiness})\n`);
    process.stdout.write(`  entries             ${lane.entries}/${lane.expectedEntries}\n`);
    process.stdout.write(`  terminal units      ${lane.terminalUnits}\n`);
    process.stdout.write(`  emitted             ${lane.emitted}\n`);
    process.stdout.write(`  unsupported         ${lane.unsupported}\n`);
    process.stdout.write(`  invariants          ${lane.invariants}\n`);
    process.stdout.write(`  legacy body emitted ${lane.legacyBodyEmitted}\n`);
    process.stdout.write(`  IR body emitted     ${lane.irBodyEmitted}\n`);
    process.stdout.write(`  by unit kind        ${JSON.stringify(lane.byUnitKind)}\n`);
    process.stdout.write(`  by backend/target   ${JSON.stringify(lane.byTarget)}\n`);
    process.stdout.write(`  unsupported codes   ${JSON.stringify(lane.unsupportedByCode)}\n`);
    if (lane.blockers.length > 0) {
      process.stdout.write("  typed blockers:\n");
      for (const blocker of lane.blockers) process.stdout.write(`    - ${blocker}\n`);
    }
  }
  process.stdout.write(`\n${verdict.policy} verdict: ${verdict.ready ? "READY" : "NOT READY"}\n`);
  for (const failure of verdict.failures) process.stdout.write(`  - ${failure}\n`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const policyArg = args.find((arg) => arg.startsWith("--policy="));
  const policy = (policyArg?.slice("--policy=".length) ?? "ir-only") as IrOutcomePolicy;
  if (policy !== "hybrid" && policy !== "ir-only") throw new Error(`unknown policy ${policy}`);
  const json = args.includes("--json");
  const update = args.includes("--update");
  if (update && policy !== "hybrid") throw new Error("--update requires --policy=hybrid");

  const lanes = [await observeSingleHostLane(), await observeStandaloneLane()];
  const activeBaseline = update ? baselineFrom(lanes, loadBaseline()) : loadBaseline();
  const verdict = evaluateIrOnlyReport(lanes, activeBaseline, policy);
  if (update && verdict.ready) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(activeBaseline, null, 2)}\n`, "utf8");
  }
  if (json) process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  else printHuman(verdict);
  if (!verdict.ready) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(
      `check-ir-only failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
