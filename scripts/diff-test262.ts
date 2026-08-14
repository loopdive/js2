#!/usr/bin/env npx tsx
/**
 * diff-test262.ts — Compare two test262 JSONL result files and report regressions/improvements.
 *
 * Usage:
 *   npx tsx scripts/diff-test262.ts <baseline.jsonl> <new.jsonl>
 *
 * Output:
 *   - Regressions (pass → fail/CE)
 *   - Improvements (fail/CE → pass)
 *   - Status transitions summary
 *   - Net delta
 *   - Error category breakdown for regressions
 */

import { createReadStream, readFileSync } from "fs";
import { createInterface } from "readline";
import { createHash } from "crypto";
// (#3613) A checker that answers for 0 of N inputs is a BROKEN checker, not a
// clean result. `trapInnermostFrame` is exactly such a checker and its
// 100 %-unverifiable rate on the CI grammar is what silently produced the
// "0 verified unmasked pre-existing traps" reading in the #3601 park.
import { guardedFilter } from "./lib/verifier-guard.mjs";

// #1943 — single source of truth for the documented merge thresholds, so the
// CI regression-gate ENFORCES the same numbers the dev-self-merge skill
// documents (previously the hard gate was only `net_per_test >= 0`; the 10%
// ratio and 50-per-bucket limits lived solely in skill text an agent could
// skip). `.claude/skills/dev-self-merge/SKILL.md` references these constants.
//
// - REGRESSION_RATIO_LIMIT: fail when regressions / improvements >= 10%.
// - REGRESSION_BUCKET_LIMIT: fail when any single path bucket has > 50
//   regressions.
// - REGRESSION_BUCKET_PATH_DEPTH: a "bucket" is the first N path segments of a
//   test file (e.g. `test/built-ins/Array/prototype/every`), matching the
//   skill's `'/'.join(f.split('/')[:5])`.
export const REGRESSION_RATIO_LIMIT = 0.1;
export const REGRESSION_BUCKET_LIMIT = 50;
export const REGRESSION_BUCKET_PATH_DEPTH = 5;

// #3457 — small-sample floor for the regression-RATIO gate. Below this absolute
// count of wasm-change regressions the ratio is statistically meaningless: a
// single flaky pass↔fail flip shifts the ratio by ≥10 points (1 flake on a
// 9-improvement diff already reads 11 %), so a raw 10 % ratio breach on a tiny
// sample is noise, not signal. The floor is well under the 50-per-bucket
// concentration limit, so a genuinely concentrated break still trips the
// (unchanged) bucket gate; and the independent net gate (net < 0) still
// hard-fails any true net-negative change regardless of the floor. See the
// #3351/#3318/#3359 and #3406/#3409 false-parks in plan/issues/3457-*.md.
export const REGRESSION_RATIO_SMALL_SAMPLE_FLOOR = 10;

export interface HostNoiseCanaryProvenance {
  canary_run_id: number;
  compiler_sha: string;
  artifact_id: number;
  artifact_name: string;
  compiler_pool_size: number;
  run_a_entries: number;
  run_b_entries: number;
  pass_flips: number;
  non_pass_status_noise: number;
  unstable_paths: number;
}

export interface HostNoiseObservation {
  canary_run_id: number;
  run_a_status: string;
  run_b_status: string;
  kind: "pass_flip" | "non_pass_status_noise";
}

export interface HostNoiseQuarantineManifest {
  schema_version: number;
  lane: string;
  policy: {
    eligible_paths: string;
    intersection_paths: string;
  };
  provenance: {
    generated_by: string;
    canaries: HostNoiseCanaryProvenance[];
  };
  counts: {
    canary_runs: number;
    pass_flip_observations: number;
    non_pass_status_noise_observations: number;
    union_paths: number;
    intersection_paths: number;
  };
  entries: {
    path: string;
    observations: HostNoiseObservation[];
  }[];
}

export interface HostNoiseQuarantine {
  manifest: HostNoiseQuarantineManifest;
  paths: ReadonlySet<string>;
  intersectionPaths: ReadonlySet<string>;
}

export const HOST_NOISE_ELIGIBILITY_POLICY = "union-of-complete-same-sha-pool4-canaries";
export const HOST_NOISE_INTERSECTION_POLICY = "observed-in-every-recorded-canary";

/**
 * #3426 — Load and validate the exact-path JS-host noise quarantine generated
 * from complete same-compiler canaries. Eligibility is the exact union of
 * observed A/B status changes; the exact intersection remains available as the
 * repeat-confirmed subset. Fail closed: this file influences required gate
 * arithmetic, so malformed provenance, duplicate/unsorted observations, or a
 * count / transition mismatch must abort instead of silently changing scope.
 * The standalone lane never calls this loader.
 */
export function validateHostNoiseQuarantineManifest(manifest: HostNoiseQuarantineManifest): HostNoiseQuarantine {
  if (
    manifest.schema_version !== 2 ||
    manifest.lane !== "js-host" ||
    manifest.policy?.eligible_paths !== HOST_NOISE_ELIGIBILITY_POLICY ||
    manifest.policy?.intersection_paths !== HOST_NOISE_INTERSECTION_POLICY ||
    manifest.provenance?.generated_by !== "scripts/test262-canary-diff.ts" ||
    !Array.isArray(manifest.provenance?.canaries) ||
    manifest.provenance.canaries.length < 1 ||
    !Array.isArray(manifest.entries)
  ) {
    throw new Error("invalid Test262 host-noise quarantine provenance/schema (#3426)");
  }

  const canaryRunIds = new Set<number>();
  const artifactIds = new Set<number>();
  const canaryByRunId = new Map<number, HostNoiseCanaryProvenance>();
  let previousRunId = 0;
  for (const canary of manifest.provenance.canaries) {
    if (
      !Number.isInteger(canary.canary_run_id) ||
      canary.canary_run_id <= 0 ||
      (previousRunId !== 0 && canary.canary_run_id <= previousRunId) ||
      canaryRunIds.has(canary.canary_run_id) ||
      !/^[0-9a-f]{40}$/.test(canary.compiler_sha ?? "") ||
      !Number.isInteger(canary.artifact_id) ||
      canary.artifact_id <= 0 ||
      artifactIds.has(canary.artifact_id) ||
      canary.artifact_name !== "test262-canary-report" ||
      canary.compiler_pool_size !== 4 ||
      !Number.isInteger(canary.run_a_entries) ||
      !Number.isInteger(canary.run_b_entries) ||
      canary.run_a_entries <= 0 ||
      canary.run_a_entries !== canary.run_b_entries ||
      !Number.isInteger(canary.pass_flips) ||
      canary.pass_flips < 0 ||
      !Number.isInteger(canary.non_pass_status_noise) ||
      canary.non_pass_status_noise < 0 ||
      !Number.isInteger(canary.unstable_paths) ||
      canary.unstable_paths !== canary.pass_flips + canary.non_pass_status_noise
    ) {
      throw new Error(`invalid Test262 host-noise canary provenance for run ${canary.canary_run_id || "<unknown>"}`);
    }
    canaryRunIds.add(canary.canary_run_id);
    artifactIds.add(canary.artifact_id);
    canaryByRunId.set(canary.canary_run_id, canary);
    previousRunId = canary.canary_run_id;
  }

  const paths = new Set<string>();
  const intersectionPaths = new Set<string>();
  const observationCounts = new Map<number, { passFlips: number; nonPassNoise: number; total: number }>();
  for (const runId of canaryRunIds) observationCounts.set(runId, { passFlips: 0, nonPassNoise: 0, total: 0 });
  let passFlipObservations = 0;
  let nonPassNoiseObservations = 0;
  let previousPath = "";
  for (const entry of manifest.entries) {
    if (
      typeof entry.path !== "string" ||
      entry.path.length === 0 ||
      !Array.isArray(entry.observations) ||
      entry.observations.length < 1 ||
      paths.has(entry.path) ||
      (previousPath !== "" && entry.path.localeCompare(previousPath) <= 0)
    ) {
      throw new Error(`invalid/duplicate/unsorted Test262 host-noise quarantine entry: ${entry.path || "<empty>"}`);
    }

    const observedRunIds = new Set<number>();
    let previousObservationRunId = 0;
    for (const observation of entry.observations) {
      if (
        !Number.isInteger(observation.canary_run_id) ||
        !canaryRunIds.has(observation.canary_run_id) ||
        observedRunIds.has(observation.canary_run_id) ||
        (previousObservationRunId !== 0 && observation.canary_run_id <= previousObservationRunId) ||
        typeof observation.run_a_status !== "string" ||
        typeof observation.run_b_status !== "string" ||
        observation.run_a_status === observation.run_b_status
      ) {
        throw new Error(`invalid/duplicate/unsorted Test262 host-noise observation for ${entry.path}`);
      }
      const aPass = observation.run_a_status === "pass";
      const bPass = observation.run_b_status === "pass";
      const runCounts = observationCounts.get(observation.canary_run_id)!;
      if (observation.kind === "pass_flip" && aPass !== bPass) {
        passFlipObservations++;
        runCounts.passFlips++;
      } else if (observation.kind === "non_pass_status_noise" && !aPass && !bPass) {
        nonPassNoiseObservations++;
        runCounts.nonPassNoise++;
      } else {
        throw new Error(`inconsistent Test262 host-noise transition kind for ${entry.path}`);
      }
      runCounts.total++;
      observedRunIds.add(observation.canary_run_id);
      previousObservationRunId = observation.canary_run_id;
    }
    if (observedRunIds.size === canaryRunIds.size) intersectionPaths.add(entry.path);
    paths.add(entry.path);
    previousPath = entry.path;
  }

  for (const [runId, observed] of observationCounts) {
    const expected = canaryByRunId.get(runId)!;
    if (
      observed.passFlips !== expected.pass_flips ||
      observed.nonPassNoise !== expected.non_pass_status_noise ||
      observed.total !== expected.unstable_paths
    ) {
      throw new Error(`Test262 host-noise observation count mismatch for canary run ${runId}`);
    }
  }
  if (
    manifest.counts?.canary_runs !== canaryRunIds.size ||
    manifest.counts?.pass_flip_observations !== passFlipObservations ||
    manifest.counts?.non_pass_status_noise_observations !== nonPassNoiseObservations ||
    manifest.counts?.union_paths !== paths.size ||
    manifest.counts?.intersection_paths !== intersectionPaths.size
  ) {
    throw new Error("Test262 host-noise quarantine count mismatch (#3426)");
  }
  return { manifest, paths, intersectionPaths };
}

export function loadHostNoiseQuarantine(): HostNoiseQuarantine {
  const source = new URL("./test262-host-noise-quarantine.json", import.meta.url);
  const manifest = JSON.parse(readFileSync(source, "utf-8")) as HostNoiseQuarantineManifest;
  return validateHostNoiseQuarantineManifest(manifest);
}

// #3189 — the four UNCATCHABLE Wasm-trap error categories. A trap aborts the
// whole test file and escapes `try`/`catch` (documented in #3179 — a trap
// inside `assert.throws` poisons every test whose body shares the pattern), so
// the "crash-free (traps → 0)" goal (plan/goals/goal-graph.md) treats them as
// strictly worse than an ordinary assertion fail. These strings are assigned by
// `classifyError` (tests/test262-runner.ts) and are stable in the jsonl.
export const TRAP_ERROR_CATEGORIES = ["null_deref", "illegal_cast", "oob", "unreachable"] as const;
export type TrapCategory = (typeof TRAP_ERROR_CATEGORIES)[number];

// #3086 — drift tolerance for a DELIBERATE oracle re-baseline (forward-bump
// auto-rebase or ORACLE_REBASE=1). A pure re-baseline has ~0 improvements, so
// the strict net<0 / ratio<10% gate is structurally inapplicable: ANY residual
// regression makes net negative and the ratio ∞. The intended reclassification
// (e.g. #2940/#3086 vacuity) is already excused from `regressionsWasmChange`;
// what remains is main-side DRIFT the re-baseline cannot avoid (the baseline the
// merge_group diffs against lags main HEAD by the promote-serialization window).
// In rebase mode we therefore replace net/ratio with a bounded drift tolerance
// PLUS the unchanged per-bucket (50) concentration check. Since #3303 the
// #1668 catastrophic guard and the #1897 standalone guard treat THIS script's
// exit code as authoritative when it passes (exit 0) and only apply their
// coarse raw-count thresholds (200 / net −15) when this script's own gate
// FAILED (exit 1) — so a rebase within tolerance (or within a declared
// #3303 regressions-allow ceiling, below) clears the whole gate stack in one
// place. Set to 25 — comfortably above realistic single-window host drift, ~8×
// below the catastrophic threshold, so a genuine concentrated break still trips
// (bucket-50) or overflows (25) while ordinary drift self-lands the re-baseline.
export const ORACLE_REBASE_DRIFT_TOLERANCE = 25;

// #3303 — PR-scoped allowance for HONEST verdict-logic reclassifications that
// exceed the bounded drift tolerance above (e.g. #3285/#3104: 2615 previously
// inflated false passes becoming honest fails — plain assertion_fail /
// type_error rows, so the #2940 vacuity excusal does not cover them, see
// #3286). The PR declares a ceiling in its OWN issue file's frontmatter:
//
//   regressions-allow:
//     count: 2700
//     reason: "#3285 assert_throws error-type tightening, see #3286"
//
// Read via the same change-set scoping as loc-budget-allow (#3131,
// scripts/lib/change-scope.mjs): only issue files in the PR's OWN diff are
// consulted, so the allowance is inherently per-PR — an allowance that landed
// on main grants nothing to later PRs, unlike a repo variable
// (#3202's TRAP_RATCHET_TOLERANCE), which would silently stay open for every
// subsequent PR. Containment properties (all load-bearing):
//   - REBASE-MODE ONLY: the allowance is consulted exclusively inside the
//     rebase-mode gate, so it has ZERO effect unless the same PR also bumps
//     `oracle_version` forward (or CI sets ORACLE_REBASE=1) — an ordinary PR
//     cannot use it to sneak regressions past the net/ratio/bucket gate.
//   - CEILING, NOT BLANK CHECK: regressionsWasmChange > declared count still
//     hard-fails; if reality exceeds the declaration, that is itself signal
//     and needs a fresh, honest re-declaration.
//   - TRAP-RATCHET IMMUNE: the #3189 uncatchable-trap growth ratchet runs
//     before and independent of this gate in BOTH branches — an allowance
//     never excuses a new trap.
export const REGRESSIONS_ALLOW_KEY = "regressions-allow";
// (#3735) A docs-only PR (touching only plan/issues/**) never triggers
// test262-sharded.yml's push run at all (path-filtered out), so a
// trap-growth-allow declared there is invisible to promote-baseline's
// change-scoping (which reads only the triggering commit's OWN HEAD^1..HEAD
// diff) — the declaration must land in a PR that also touches a
// test262-paths-matched file (e.g. this one) to actually be read.
export const TRAP_GROWTH_ALLOW_KEY = "trap-growth-allow";

export interface RegressionsAllowance {
  /** Declared ceiling on non-excused wasm-change regressions. */
  count: number;
  /** Required human-readable justification (self-documenting in review). */
  reason: string;
  /** Issue file(s) in the PR's diff that declared the allowance. */
  sources: string[];
  /**
   * #3596 — the test files the declaration claims are RECLASSIFIED (a failure
   * changing flavour), not regressed. Empty when the declaration does not name
   * any. Required for a non-rebase `trap-growth-allow` (see
   * `evaluateTrapReclassification`), optional elsewhere for backward
   * compatibility with the #3303/#3370 count+reason declarations.
   */
  tests?: string[];
}

/**
 * #3303 — the rebase-mode gate (#3086 drift tolerance + bucket concentration,
 * or a declared regressions-allow ceiling superseding both). Pure (no I/O) so
 * the unit test drives it directly, mirroring `evaluateRegressionThresholds`
 * (#1943). Returns GATE-FAIL reasons (empty ⇒ pass) plus informational notes
 * the CLI prints on pass.
 */
export function evaluateRebaseGate(opts: {
  regressionsWasmChange: number;
  regressedFiles: string[];
  allowance?: RegressionsAllowance | null;
}): { failures: string[]; notes: string[] } {
  const { regressionsWasmChange, regressedFiles, allowance } = opts;
  const failures: string[] = [];
  const notes: string[] = [];
  if (allowance) {
    if (regressionsWasmChange > allowance.count) {
      failures.push(
        `regressions-allow ceiling exceeded (#3303): ${regressionsWasmChange} non-excused wasm-change regressions > declared count ${allowance.count} ` +
          `(declared in ${allowance.sources.join(", ")}; reason: ${allowance.reason}). ` +
          `The declared count is a ceiling the PR commits to, not a blank check — re-measure and re-declare honestly if the reclassification really grew`,
      );
    } else {
      notes.push(
        `=== regressions-allow (#3303): excused ${regressionsWasmChange} of ${allowance.count} declared wasm-change regressions — ` +
          `reason: ${allowance.reason} (declared in ${allowance.sources.join(", ")}). ` +
          `Drift tolerance (${ORACLE_REBASE_DRIFT_TOLERANCE}) and bucket limit (${REGRESSION_BUCKET_LIMIT}) are superseded by the declared ceiling for this re-baseline; the #3189 trap ratchet is NOT. ===`,
      );
    }
    return { failures, notes };
  }
  if (regressionsWasmChange > ORACLE_REBASE_DRIFT_TOLERANCE) {
    failures.push(
      `re-baseline residual ${regressionsWasmChange} non-excused wasm-change regressions exceeds drift tolerance ${ORACLE_REBASE_DRIFT_TOLERANCE} (#3086)`,
    );
  }
  for (const { bucket, count } of bucketRegressions(regressedFiles)) {
    if (count > REGRESSION_BUCKET_LIMIT) {
      failures.push(
        `bucket "${bucket}" has ${count} regressions, exceeds the ${REGRESSION_BUCKET_LIMIT}-test limit (re-baseline concentration check)`,
      );
    }
  }
  if (failures.length === 0) {
    notes.push(
      `=== Re-baseline gate (#3086): ${regressionsWasmChange} residual non-excused wasm-change regression(s) within drift tolerance ${ORACLE_REBASE_DRIFT_TOLERANCE}; net/ratio skipped (0-improvement re-baseline). ===`,
    );
  }
  return { failures, notes };
}

/**
 * (#3649) Machine-check a NAMED `regressions-allow` declaration so it can be
 * honoured on an ORDINARY (non-rebase) PR without becoming a blank cheque.
 *
 * WHY THIS EXISTS. `regressions-allow` was read **only** inside
 * `evaluateRebaseGate`, i.e. only when `rebaseMode` holds — which requires
 * `ORACLE_REBASE=1` or a forward `ORACLE_VERSION` bump. On an ordinary PR the
 * declaration was therefore **inert**: it parsed, it was well-formed, and it did
 * nothing. A dev with a genuine, proven, intentional pass→fail had no way to
 * declare it that any gate would read — the declaration was theatre, not a
 * machine check. Worse, the failure is **indistinguishable from "ceiling too
 * small"**: the gate fails either way and nothing in the log says which. (The
 * tell is the ABSENCE of this function's own note; absence-as-diagnosis is the
 * same silent-ambiguity class as #3644 and #3648.)
 *
 * This mirrors `evaluateTrapReclassification` (#3596) exactly, and the contract
 * is selected by the DECLARATION'S SHAPE, never by the run mode:
 *
 *   • `tests:` PRESENT → verified and honoured in both modes (this function).
 *   • `tests:` ABSENT  → #3303 semantics, byte-for-byte unchanged: a bare
 *     ceiling, rebase mode only. Existing declarations cannot change behaviour.
 *
 * Two conditions, both required:
 *
 *   1. **Real** — every named test must actually be among this diff's
 *      wasm-change regressions. A name that is not is either stale (copied from
 *      an earlier run) or speculative (pre-naming tests to bank future
 *      breakage); both are refused, so the declaration cannot be written ahead
 *      of the evidence.
 *   2. **Bounded** — the number excused may not exceed the declared `count`.
 *      The count remains a ceiling the PR commits to, not a blank cheque.
 *
 * Note what is deliberately NOT required: completeness. Undeclared regressions
 * are simply *not excused* and continue through the net/ratio/bucket gates
 * normally. That is strictly safer than failing outright on undeclared
 * collateral, and it means a partial declaration degrades gracefully instead of
 * turning an honest under-declaration into a hard stop.
 *
 * Pure (no I/O) so the unit test drives it with fixture lists.
 */
export function evaluateNamedRegressionsAllowance(opts: {
  allowance: RegressionsAllowance;
  regressedFiles: string[];
}): { excused: Set<string>; failures: string[]; notes: string[] } {
  const { allowance, regressedFiles } = opts;
  const failures: string[] = [];
  const notes: string[] = [];
  const declared = allowance.tests ?? [];
  const where = allowance.sources.join(", ");
  const regressedSet = new Set(regressedFiles);

  const excused = new Set<string>();
  const notRegressed: string[] = [];
  for (const file of declared) {
    if (regressedSet.has(file)) excused.add(file);
    else notRegressed.push(file);
  }

  if (notRegressed.length > 0) {
    const sample = notRegressed.slice().sort().slice(0, 10);
    const more = notRegressed.length > sample.length ? ` (+${notRegressed.length - sample.length} more)` : "";
    failures.push(
      `regressions-allow (#3649): ${notRegressed.length} declared test(s) are NOT among this diff's wasm-change ` +
        `regressions — ${sample.join(", ")}${more} (declared in ${where}). A declaration must describe THIS diff: ` +
        `name only tests it actually regresses, so the claim cannot be written ahead of the evidence`,
    );
  }

  if (excused.size > allowance.count) {
    failures.push(
      `regressions-allow (#3649) ceiling exceeded: ${excused.size} named regression(s) > declared count ` +
        `${allowance.count} (declared in ${where}). The count is a ceiling the PR commits to — re-measure and ` +
        `re-declare honestly`,
    );
  }

  if (failures.length === 0 && excused.size > 0) {
    notes.push(
      `=== regressions-allow (#3649): EXCUSING ${excused.size} named wasm-change regression(s) of a declared ` +
        `ceiling ${allowance.count}, each verified to be a regression in this diff. Undeclared regressions are ` +
        `NOT excused and still gate. reason: ${allowance.reason} (declared in ${where}). ===`,
    );
  }
  return { excused: failures.length === 0 ? excused : new Set(), failures, notes };
}

/**
 * #3303 — read the change-set-scoped `regressions-allow:` declaration (CLI
 * path only; never called when this module is imported for its pure helpers).
 * Resolution:
 *   1. `REGRESSIONS_ALLOW_FILE` env — read the declaration from ONE explicit
 *      file, bypassing git scoping entirely. Test/emergency hook: keeps the
 *      fixture tests hermetic (the ambient repo diff can never leak an
 *      allowance into them, and they can grant one without touching the repo).
 *   2. Git change-set scoping via `resolveChangeBase` + the PR's own
 *      `plan/issues/**.md` diff (`changeSetNumericAllowances`) — the real
 *      mechanism. In CI this resolves `HEAD^1` of the synthetic merge commit
 *      (pull_request / merge_group / push), which is exactly the PR's own
 *      change-set even inside a stacked merge-queue group.
 * Multiple valid declarations: the ceiling is the MAX single declaration (one
 * PR = one honest reclassification; declarations deliberately do NOT sum).
 */
export async function readChangeScopedNumericAllowance(opts: {
  key: string;
  label: string;
  overrideEnv: string;
}): Promise<{ allowance: RegressionsAllowance | null; notes: string[] }> {
  const notes: string[] = [];
  const { resolveChangeBase, changeSetNumericAllowances, parseFrontmatterCountReason } =
    await import("./lib/change-scope.mjs");
  const overrideFile = process.env[opts.overrideEnv];
  if (overrideFile !== undefined && overrideFile !== "") {
    let parsed: { count: number; reason: string; tests?: string[] } | null | undefined;
    try {
      parsed = parseFrontmatterCountReason(readFileSync(overrideFile, "utf-8"), opts.key);
    } catch {
      parsed = undefined;
    }
    if (parsed === null) {
      notes.push(
        `⚠️  ${opts.label}: MALFORMED declaration in ${overrideFile} (needs positive-integer count + non-empty reason) — ignored.`,
      );
    }
    if (!parsed) return { allowance: null, notes };
    return { allowance: { ...parsed, sources: [overrideFile] }, notes };
  }
  const repoRoot = process.cwd();
  const { base, how } = resolveChangeBase(repoRoot);
  if (!base) return { allowance: null, notes };
  const { declarations, invalid } = changeSetNumericAllowances(repoRoot, base, opts.key);
  for (const p of invalid) {
    notes.push(
      `⚠️  ${opts.label}: MALFORMED declaration in ${p} (needs positive-integer count + non-empty reason) — ignored.`,
    );
  }
  if (declarations.length === 0) return { allowance: null, notes };
  const best = declarations.reduce((a, b) => (b.count > a.count ? b : a));
  if (declarations.length > 1) {
    notes.push(
      `${opts.label}: ${declarations.length} declarations in the change-set (base via ${how}) — using the max ceiling ${best.count} from ${best.source}; declarations do not sum.`,
    );
  }
  return {
    allowance: {
      count: best.count,
      reason: best.reason,
      sources: declarations.map((d) => d.source),
      // #3596 — the named-tests list travels with the winning declaration. The
      // ceiling does not sum across declarations, so neither does its evidence.
      tests: best.tests ?? [],
    },
    notes,
  };
}

async function readRegressionsAllowance(): Promise<{ allowance: RegressionsAllowance | null; notes: string[] }> {
  return readChangeScopedNumericAllowance({
    key: REGRESSIONS_ALLOW_KEY,
    label: "regressions-allow (#3303)",
    overrideEnv: "REGRESSIONS_ALLOW_FILE",
  });
}

/**
 * Group regressed test files into path buckets (first
 * `REGRESSION_BUCKET_PATH_DEPTH` segments) and return them sorted by count
 * descending. Mirrors the dev-self-merge skill's bucket grouping exactly so
 * the documented and enforced definitions stay byte-identical (#1943).
 */
export function bucketRegressions(files: string[]): { bucket: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const bucket = file.split("/").slice(0, REGRESSION_BUCKET_PATH_DEPTH).join("/");
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return [...counts.entries()].map(([bucket, count]) => ({ bucket, count })).sort((a, b) => b.count - a.count);
}

export interface RegressionThresholdResult {
  /** Human-readable HARD-FAIL reasons (empty ⇒ the ratio/bucket gate passes). */
  failures: string[];
  /**
   * Human-readable ADVISORY signals that did NOT hard-fail (#3457): a ratio
   * breach that was waived because the change is net-positive/net-neutral, or
   * because the absolute regression count is below the small-sample floor. The
   * CLI prints these as `GATE WARN` so the signal stays visible without parking.
   */
  warnings: string[];
}

/**
 * Evaluate the documented merge thresholds against the wasm-hash-filtered
 * counts. Pure (no I/O) so the unit test can drive it directly with fixture
 * data (#1943 acceptance criteria).
 *
 * #3457 — NET-AWARE / FLAP-TOLERANT ratio gate. The raw 10 % regression-ratio
 * gate (#1943) false-parked net-positive and net-neutral PRs: symmetric
 * content-current flap (improvements ≈ regressions, so NET ≥ 0) and genuine
 * net-conformance GAINS with a handful of offsetting edge-case regressions
 * (#3406 net +29 ratio 17 %; #3409 net +30 ratio 11.8 %; #3351/#3318/#3359
 * net-neutral) all tripped the ratio even though conformance held or rose. The
 * ratio is now classified against the NET (improvements − regressions):
 *
 *   • net ≥ 0                              → ratio breach is a WARNING, not a
 *                                            fail. Conformance did not drop, so
 *                                            the regressions are outnumbered —
 *                                            not merge-blocking.
 *   • net < 0 AND regressions ≥ floor(10)  → ratio breach HARD-FAILS: a
 *                                            statistically-meaningful,
 *                                            one-directional net regression.
 *   • net < 0 AND regressions <  floor(10) → ratio breach is a WARNING: below
 *                                            the small-sample floor the ratio is
 *                                            noise (a single flake dominates it),
 *                                            and the independent net gate already
 *                                            hard-fails this net-negative diff.
 *
 * The per-bucket (>50) concentration check is UNCHANGED and stays a hard fail
 * independent of net — a net-positive PR that nukes one test family (≥50 in one
 * bucket) is still suspicious and still parks. The #3189 uncatchable-trap growth
 * ratchet and the net gate (net < 0) live outside this function and are likewise
 * unchanged. The ratio gate only fires when there is at least one wasm-change
 * regression — a clean diff (R == 0) always passes.
 */
export function evaluateRegressionThresholds(opts: {
  improvements: number;
  regressionsWasmChange: number;
  regressedFiles: string[];
}): RegressionThresholdResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  const { improvements, regressionsWasmChange, regressedFiles } = opts;
  const net = improvements - regressionsWasmChange;
  if (regressionsWasmChange > 0) {
    const ratio = improvements > 0 ? regressionsWasmChange / improvements : Infinity;
    if (ratio >= REGRESSION_RATIO_LIMIT) {
      const pct = improvements > 0 ? (ratio * 100).toFixed(1) + "%" : "∞ (0 improvements)";
      const base = `regression ratio ${pct} (${regressionsWasmChange}/${improvements}) meets/exceeds the ${(REGRESSION_RATIO_LIMIT * 100).toFixed(0)}% limit`;
      if (net >= 0) {
        // Net conformance held or rose — the ratio is advisory, not blocking.
        warnings.push(
          `${base} — WAIVED (#3457): net conformance change is +${net} (improvements ${improvements} ≥ regressions ${regressionsWasmChange}); ratio is advisory on a net-positive/neutral diff`,
        );
      } else if (regressionsWasmChange < REGRESSION_RATIO_SMALL_SAMPLE_FLOOR) {
        // Net-negative but below the small-sample floor — ratio too noisy to
        // gate on; the net gate (net < 0) already fails this diff.
        warnings.push(
          `${base} — WAIVED (#3457): only ${regressionsWasmChange} wasm-change regression(s) < small-sample floor ${REGRESSION_RATIO_SMALL_SAMPLE_FLOOR}; ratio is statistically noisy on a small sample (the net gate already hard-fails this net-negative diff)`,
        );
      } else {
        // Net-negative AND ≥ floor regressions — a real one-directional break.
        failures.push(
          `${base} (net ${net} < 0, ${regressionsWasmChange} ≥ small-sample floor ${REGRESSION_RATIO_SMALL_SAMPLE_FLOOR})`,
        );
      }
    }
  }
  for (const { bucket, count } of bucketRegressions(regressedFiles)) {
    if (count > REGRESSION_BUCKET_LIMIT) {
      failures.push(`bucket "${bucket}" has ${count} regressions, exceeds the ${REGRESSION_BUCKET_LIMIT}-test limit`);
    }
  }
  return { failures, warnings };
}

/** Minimal row shape the trap ratchet needs (a subset of `TestResult`). */
type TrapRatchetRow = { status: string; error_category?: string; wasm_sha?: string | null };

export interface TrapCategoryGrowth {
  /** Human-readable GATE-FAIL reasons (empty ⇒ within ratchet). */
  failures: string[];
  /** baseline population per trap category. */
  baseCounts: Record<TrapCategory, number>;
  /** candidate population per trap category (noise/unknown-filtered). */
  newCounts: Record<TrapCategory, number>;
  /** files that newly entered each trap category (weren't trapping there in baseline). */
  newlyTrapping: Record<TrapCategory, string[]>;
  /**
   * Candidate traps whose baseline never reached runtime: compilation timed
   * out (`compile_timeout`), produced invalid Wasm that never instantiated
   * (`compile_error`, #3595), or the file was never run at all (`skip`,
   * #4141). All three are unknown baseline outcomes, not observed trap growth.
   * (The field name predates the latter two; it is kept for compatibility with
   * the existing gate output and tests.)
   */
  unknownBaselineTimeouts: Record<TrapCategory, string[]>;
  /**
   * Candidate traps with no corresponding baseline row. An absent row carries
   * no runtime evidence, so it cannot establish that the candidate newly traps.
   */
  unknownBaselineMissingRows: Record<TrapCategory, string[]>;
}

export interface TrapCategoryGrowthOptions {
  /**
   * Treat candidate-only rows as unknown instead of newly trapping. Enable this
   * for baseline artifacts that are expected to cover the same Test262 corpus:
   * there an absent row is an incomplete observation, not evidence of a new
   * test. The pure helper defaults to strict candidate-only/new-test semantics.
   * (#3735) `check-baseline-trap-growth.ts`'s before/after root-baseline
   * compare passes `true` here — see that call site for why.
   */
  missingBaselineRowsAreUnknown?: boolean;
  /**
   * #3592 — candidate files whose trap rows are excluded from category growth
   * entirely: VERIFIED unmasked pre-existing traps under a declared
   * de-vacuification allowance (see `evaluateDevacuificationAllowance` — each
   * excluded file's trap has a non-dispatcher innermost frame, i.e. the trap
   * pre-existed and only became reachable because the callee finally ran).
   * Empty/absent ⇒ behaviour is byte-identical to pre-#3592.
   */
  excludeFiles?: Set<string>;
}

/**
 * #3189 — trap-category GROWTH ratchet. For each of the four uncatchable-trap
 * categories, compare the candidate's population against the baseline's. **Any
 * growth in any trap category is a gate failure**, independent of `net_per_test`
 * — so a PR that fixes 60 assertion-fails while introducing 12 new illegal-casts
 * (net-positive, so it clears the existing net/ratio gate) is still blocked. The
 * "crash-free (traps → 0)" goal is a strict ratchet: the trap population may
 * only shrink or hold. Decreases auto-bank because the committed baseline jsonl
 * is re-seeded by `promote-baseline` on every push to main (#1528) — no separate
 * baseline file, so there is no per-PR baseline-bump merge conflict (#3131).
 *
 * Pure (no I/O) so the unit test drives it with fixture maps, mirroring
 * `evaluateRegressionThresholds` (#1943).
 *
 * Evidence discipline: a trap category is a STATIC miscompile signal — a
 * byte-identical binary (same `wasm_sha`) cannot newly trap — so a candidate row
 * whose wasm hash is unchanged from a baseline row of the same file is excluded
 * as CI runner noise, exactly like the `net_per_test` gate's `wasmUnchanged`
 * filter (#1222). This prevents a flaky pass→trap flip on an identical binary
 * from tripping the ratchet.
 *
 * A baseline `compile_timeout`, `compile_error`, `skip`, or an absent baseline
 * row is also not an observed runtime outcome. If the candidate compiles that file and exposes a trap, the
 * ratchet must not claim a new trap: the predecessor run did not establish that
 * the file was trap-free. Such rows stay visible in diagnostics, while the hard
 * ratchet remains unchanged for every baseline row that reached runtime.
 */
export function evaluateTrapCategoryGrowth(
  baseline: Map<string, TrapRatchetRow>,
  newer: Map<string, TrapRatchetRow>,
  /**
   * Per-category growth tolerance (default 0 — strict ratchet). An operational
   * safety valve wired to `TRAP_RATCHET_TOLERANCE` in the CLI, mirroring
   * `STANDALONE_REGRESSION_TOLERANCE`: if the ratchet ever proves brittle
   * against baseline drift it can be loosened without a code change, rather than
   * wedging the merge queue. Growth fails only when it EXCEEDS the tolerance.
   */
  tolerancePerCategory = 0,
  options: TrapCategoryGrowthOptions = {},
): TrapCategoryGrowth {
  const zero = () => Object.fromEntries(TRAP_ERROR_CATEGORIES.map((c) => [c, 0])) as Record<TrapCategory, number>;
  const baseCounts = zero();
  const newCounts = zero();
  const newlyTrapping = Object.fromEntries(TRAP_ERROR_CATEGORIES.map((c) => [c, [] as string[]])) as Record<
    TrapCategory,
    string[]
  >;
  const unknownBaselineTimeouts = Object.fromEntries(TRAP_ERROR_CATEGORIES.map((c) => [c, [] as string[]])) as Record<
    TrapCategory,
    string[]
  >;
  const unknownBaselineMissingRows = Object.fromEntries(
    TRAP_ERROR_CATEGORIES.map((c) => [c, [] as string[]]),
  ) as Record<TrapCategory, string[]>;

  const isTrap = (cat: string | undefined): cat is TrapCategory =>
    !!cat && (TRAP_ERROR_CATEGORIES as readonly string[]).includes(cat);

  for (const row of baseline.values()) {
    if (row.status !== "compile_timeout" && isTrap(row.error_category)) baseCounts[row.error_category]++;
  }

  for (const [file, row] of newer) {
    if (row.status === "compile_timeout" || !isTrap(row.error_category)) continue;
    // #3592 — a verified unmasked pre-existing trap under a declared
    // de-vacuification allowance neither grows the category nor lists as
    // newly trapping (the baseline "pass" was vacuous: the trapping code was
    // never reached, so the baseline never testified it was trap-free).
    if (options.excludeFiles?.has(file)) continue;
    const base = baseline.get(file);
    // A missing shard/artifact row says nothing about the baseline runtime
    // outcome. Treat it as unknown rather than manufacturing trap growth.
    if (!base && options.missingBaselineRowsAreUnknown) {
      unknownBaselineMissingRows[row.error_category].push(file);
      continue;
    }
    // A compile timeout never observed the baseline's runtime behavior. A
    // subsequent trap is therefore unknown, not evidence that this change
    // introduced one. Keep it out of category growth and report it separately.
    //
    // (#3595) `compile_error` is the SAME class of baseline-can't-testify: an
    // invalid-Wasm module never instantiated, so `__module_init` never ran and
    // never had the opportunity to trap. A later trap on that file is therefore
    // *unknown*, not *introduced* — exactly the rationale already written above
    // for `compile_timeout`. Measured evidence (#3593): the minimized repro for
    // `Iterator/zip/iterables-iteration.js` traps identically with and without
    // the PR that made the file compile, so the trap pre-existed the change that
    // merely let the module reach it.
    //
    // (#4141) `skip` is the THIRD member of the same class, and the most
    // obviously so: a skipped test was never compiled and never instantiated,
    // so the baseline run produced no runtime observation of that file at all.
    // It cannot testify that the file was trap-free, and a candidate trap on
    // it is therefore *unknown*, not *introduced*. This is correct on its own
    // merits — it holds for every reason a row can be skipped (scope filter,
    // HANGING_TESTS, feature filter) and does not depend on any particular
    // producer bug. It also happens to be defense in depth for the healer
    // asymmetry fixed alongside this in `test262-sharded.yml`: the baseline
    // heal step ran without `TEST262_INCLUDE_PROPOSALS`, rewriting ~1,229 real
    // Temporal traps as `skip`, while the never-healed candidate kept them as
    // traps — a phantom `null_deref 156 → 1360` charged to two unrelated PRs
    // (#4074, #4088). With the healer fixed those rows record as `fail` again;
    // with this exclusion a future scope/skip asymmetry from ANY source cannot
    // manufacture trap growth either.
    //
    // Deliberately NOT loosened beyond that: a baseline that actually RAN
    // (`pass` or `fail`) and now traps still fails the ratchet, hard. See the
    // `pass → trap` / `fail → trap` cases in `tests/issue-3189.test.ts`.
    if (base?.status === "compile_timeout" || base?.status === "compile_error" || base?.status === "skip") {
      unknownBaselineTimeouts[row.error_category].push(file);
      continue;
    }
    // Wasm-identical noise: a trap can't appear on a byte-identical binary, so a
    // same-`wasm_sha` flip is runner noise — don't let it inflate the count.
    if (base && base.wasm_sha && row.wasm_sha && base.wasm_sha === row.wasm_sha) continue;
    newCounts[row.error_category]++;
    // "newly trapping HERE" = this file was not already in THIS trap category.
    if (!base || base.error_category !== row.error_category) {
      newlyTrapping[row.error_category].push(file);
    }
  }

  const failures: string[] = [];
  for (const cat of TRAP_ERROR_CATEGORIES) {
    if (newCounts[cat] - baseCounts[cat] > tolerancePerCategory) {
      const grew = newCounts[cat] - baseCounts[cat];
      const files = newlyTrapping[cat].slice().sort().slice(0, 10);
      // (#3915) Report each file WITH its baseline status. The old wording,
      // "Newly trapping: <file>", reads as "this file used to pass" — but as the
      // comment above records, it only means the file was not already in THIS
      // category. On 2026-07-31 that phrasing sent a triage down the wrong path
      // for `Array/from/array-like-has-length-but-no-indexes-with-values.js`: it
      // was read as a pass→trap regression when the baseline said `fail`, so the
      // brief named the wrong valve. The baseline status is the single field
      // that selects the mechanism, so print it here rather than making every
      // reader go look it up in a 66 MB JSONL.
      const sample = files.map((f) => `${f} (baseline: ${baseline.get(f)?.status ?? "absent"})`);
      const more =
        newlyTrapping[cat].length > files.length ? ` (+${newlyTrapping[cat].length - files.length} more)` : "";
      failures.push(
        `trap category "${cat}" grew ${baseCounts[cat]} → ${newCounts[cat]} (+${grew}) — uncatchable-trap ratchet (#3189). ` +
          `Now trapping: ${sample.join(", ")}${more}. ` +
          `"Now trapping" means the CATEGORY grew — it does NOT mean these files were passing. ` +
          `The baseline status selects the mechanism: pass ⇒ genuine regression (no valve applies); ` +
          `fail ⇒ named trap-growth-allow (#3596); compile_error/compile_timeout/absent ⇒ excluded outright (#3595).`,
      );
    }
  }
  return {
    failures,
    baseCounts,
    newCounts,
    newlyTrapping,
    unknownBaselineTimeouts,
    unknownBaselineMissingRows,
  };
}

/**
 * #3596 — machine-check a `trap-growth-allow` RECLASSIFICATION claim so the
 * allowance can be honoured on an ORDINARY (non-rebase) PR without becoming a
 * general trap-growth escape hatch.
 *
 * Background: the #3189 ratchet is a strict "traps may only shrink" gate. That
 * is right for a *regression* (a test that used to pass and now traps) but wrong
 * for a *reclassification* — a test that already failed and merely changed the
 * FLAVOUR of its failure, typically because a fix made the module compile far
 * enough to reach a pre-existing latent trap. Two net-positive PRs (#3563 +11
 * pass, #3583 +16 pass) were parked on exactly that in one evening, with no
 * available valve: the existing allowance is gated behind `rebaseMode`, and the
 * only other lever (`TRAP_RATCHET_TOLERANCE`) is a repo-wide variable that
 * blinds the gate for every other PR in the queue while open.
 *
 * The claim is verified, not trusted. Three conditions, all required:
 *
 *   1. **Named** — the declaration must list the affected test files. A bare
 *      count is not checkable and is refused.
 *   2. **Not previously passing** — every named test must have a baseline row
 *      whose status is NOT `pass`. A `pass → trap` transition is a real
 *      regression and still hard-fails, which is the property that keeps this
 *      from being an escape hatch. An absent baseline row is also refused: it
 *      proves nothing either way.
 *   3. **Complete** — every file actually responsible for the growth must be
 *      named. Undeclared growth (including growth in a category the PR never
 *      mentioned) fails, so a `count: 1` cannot silently excuse an unrelated
 *      new trap elsewhere.
 *
 * Pure (no I/O) so the unit test drives it with fixture maps, mirroring
 * `evaluateTrapCategoryGrowth` / `evaluateRegressionThresholds`.
 */
export function evaluateTrapReclassification(opts: {
  allowance: RegressionsAllowance;
  baseline: Map<string, TrapRatchetRow>;
  growth: TrapCategoryGrowth;
}): { failures: string[]; notes: string[] } {
  const { allowance, baseline, growth } = opts;
  const failures: string[] = [];
  const notes: string[] = [];
  const declared = allowance.tests ?? [];
  const where = allowance.sources.join(", ");

  if (declared.length === 0) {
    failures.push(
      `trap-growth-allow (#3596) on a non-rebase PR must NAME the reclassified tests — declare a nested ` +
        `\`tests:\` list alongside \`count:\`/\`reason:\` in ${where}. A bare count cannot be machine-checked, ` +
        `so it is refused outside an oracle re-baseline`,
    );
    return { failures, notes };
  }

  // (2) Every named test must be demonstrably NOT passing on the baseline.
  for (const file of declared) {
    const base = baseline.get(file);
    if (!base) {
      failures.push(
        `trap-growth-allow (#3596): declared test "${file}" has NO baseline row, so the reclassification claim ` +
          `cannot be verified (declared in ${where}). Name only tests present in the baseline`,
      );
      continue;
    }
    if (base.status === "pass") {
      failures.push(
        `trap-growth-allow (#3596): declared test "${file}" was "pass" on the baseline — that is a REGRESSION, ` +
          `not a reclassification, and the #3189 ratchet still hard-fails it (declared in ${where})`,
      );
    }
  }

  // (3) Every file actually causing growth must have been named.
  const declaredSet = new Set(declared);
  const undeclared: string[] = [];
  for (const cat of TRAP_ERROR_CATEGORIES) {
    if (growth.newCounts[cat] - growth.baseCounts[cat] <= 0) continue;
    for (const file of growth.newlyTrapping[cat]) {
      if (!declaredSet.has(file)) undeclared.push(`${cat}: ${file}`);
    }
  }
  if (undeclared.length > 0) {
    const sample = undeclared.slice().sort().slice(0, 10);
    const more = undeclared.length > sample.length ? ` (+${undeclared.length - sample.length} more)` : "";
    failures.push(
      `trap-growth-allow (#3596): ${undeclared.length} newly-trapping file(s) are NOT named in the declaration — ` +
        `${sample.join(", ")}${more}. The allowance covers only what it declares; undeclared trap growth still fails`,
    );
  }

  if (failures.length === 0) {
    notes.push(
      `=== trap-growth-allow (#3596): reclassification VERIFIED for ${declared.length} declared test(s) — ` +
        `each was non-passing on the baseline, and no undeclared trap growth was observed. ` +
        `reason: ${allowance.reason} (declared in ${where}). ===`,
    );
  }
  return { failures, notes };
}

interface TestResult {
  file: string;
  status: string;
  error?: string;
  error_category?: string;
  category?: string;
  /**
   * 12-char sha256 hex digest of the compiled Wasm binary (or null if no
   * binary was produced — skip / compile_error / compile_timeout). Added in
   * #1222 so the PR regression-gate can filter out byte-identical "regressions"
   * that are pure CI runner noise.
   */
  wasm_sha?: string | null;
  /**
   * Wall-clock compile time in ms (rounded), recorded per-test in the JSONL
   * (`tests/test262-shared.ts` `recordResult`). Present only when a binary was
   * actually produced (pass / fail / runtime). #1942 sums this over the shared
   * both-compiled set to gate aggregate compile-time regressions, which the
   * per-test `compile_timeout` exclusion otherwise hides.
   */
  compile_ms?: number;
  /**
   * #2096: opaque monotonic integer identifying the conformance oracle (the
   * verdict logic: error classification + negative-expectation matching +
   * required error precision). Stamped on every row by `recordResult`. Two
   * runs with the same `oracle_version` apply identical verdict logic, so
   * their rows are directly comparable; differing versions are not, and the
   * diff is refused unless `ORACLE_REBASE=1`. Defined in
   * tests/test262-oracle-version.ts.
   */
  oracle_version?: number;
  /**
   * #3462: oracle LANE discriminator (the #3450 hybrid two-oracle pipeline).
   * "honest" = the in-wasm v8 lane (host + standalone; the published number);
   * "fast-nativeharness" = the host-only fast merge-gate oracle (harness runs
   * natively, body-only wasm compile). Absent ⇒ "honest" (backward-compatible
   * with pre-#3462 baselines). An INDEPENDENT axis from `oracle_version`: a fast
   * row and an honest row are both v8 but produced by different oracles and are
   * NOT comparable. Stamped by `recordResult` (tests/test262-shared.ts).
   */
  oracle_lane?: "honest" | "fast-nativeharness";
  /**
   * #3462: revision of the FAST native-harness oracle, present ONLY on
   * `oracle_lane: "fast-nativeharness"` rows. Bumped independently of
   * `oracle_version` whenever the native-harness verdict boundary changes
   * (binding-shim/realm policy). Defined in tests/test262-oracle-version.ts.
   */
  oracle_fast_rev?: number;
  /**
   * #2879 §1 — leak class of the host imports this row's module declared, or
   * null/absent when the module ran host-free (no `env::` import). Computed by
   * `classifyHostImportLeak` (scripts/test262-worker.mjs) and recorded by
   * `recordResult`. Authoritative for host-free-ness (verified identical to
   * "no `env::` import" in #2879).
   */
  host_import_leak_class?: string | null;
  /**
   * #2879 — the `env::`-namespaced host imports the compiled module declared
   * (e.g. `["env::Promise_then", "env::__make_callback"]`). Empty/absent ⇒
   * host-free. Used as the fallback host-free signal when `host_import_leak_class`
   * is not present on a row.
   */
  imports?: string[] | null;
  /**
   * #2940 — vacuity correction marker. Set to `true` by the runner
   * (`tests/test262-shared.ts` `recordResult`) on a `fail` row whose
   * harness-wrapper callback never executed, so no assertion actually ran — the
   * module "passed" only because nothing checked anything. Since #2463 such rows
   * are scored `fail` and carry the canonical error string
   * `"vacuous: harness-wrapper callback never executed (#2940) — no assertion
   * ran"`. Pre-#2463 baselines never carry the field (they scored the same row
   * `pass`). See `isVacuousResult`.
   */
  vacuous?: boolean;
}

/**
 * #2890 / #2879 §4 — host-free-ness helpers for the standalone regression guard.
 *
 * A standalone result is **host-free** iff it declared no `env::` host import —
 * authoritatively captured by a null/absent `host_import_leak_class` (verified in
 * #2879 to be identical to "no `env::` import"), with the raw `imports` array as a
 * fallback for rows that predate the leak-class field. A compile_error / skip
 * carries no binary and therefore no host import, so it is host-free by this
 * definition (it does not lean on the host).
 */
export function entryHasEnvImport(imports?: string[] | null): boolean {
  return Array.isArray(imports) && imports.some((i) => typeof i === "string" && i.startsWith("env::"));
}

export function isHostFreeResult(entry: Pick<TestResult, "host_import_leak_class" | "imports"> | undefined): boolean {
  if (!entry) return true; // absent on the new side ⇒ no host dependency
  if (entry.host_import_leak_class) return false; // a recorded leak class ⇒ leaky
  return !entryHasEnvImport(entry.imports);
}

/** A row that leaned on the host: a recorded leak class, or an `env::` import. */
export function isLeaky(entry: Pick<TestResult, "host_import_leak_class" | "imports"> | undefined): boolean {
  if (!entry) return false;
  if (entry.host_import_leak_class) return true;
  return entryHasEnvImport(entry.imports);
}

/**
 * #2879 §4 — the ONLY pass→fail flip excused from the standalone regression
 * count: the BASELINE was a **leaky pass** (it only passed by leaning on the
 * host) AND the NEW result is **host-free** (it no longer leans on the host).
 * This is a carrier migration removing a host dependency — `host_free_pass` is
 * unchanged (the leaky pass never counted), so it is NOT a real standalone
 * regression. A baseline that was ALREADY host-free flipping to fail is NOT
 * excused — it still trips the guard at full strength.
 */
export function isLeakyBaselineToHostFreeRegression(
  base: TestResult | undefined,
  cur: TestResult | undefined,
): boolean {
  if (!base || base.status !== "pass") return false;
  return isLeaky(base) && isHostFreeResult(cur);
}

/**
 * #2940 — a row scored by the VACUITY scorer: the harness-wrapper callback
 * never executed, so no assertion ran, and #2463 rescores such a row `fail`.
 * Authoritatively flagged by `vacuous: true` (set by `recordResult`), with the
 * canonical `vacuous:`-prefixed error string as a fallback for rows that carry
 * only the message. A vacuous "pass" never actually asserted anything, so
 * reclassifying it to fail is an integrity correction — not a conformance
 * regression.
 */
export function isVacuousResult(entry: Pick<TestResult, "vacuous" | "error"> | undefined): boolean {
  if (!entry) return false;
  if (entry.vacuous === true) return true;
  return typeof entry.error === "string" && entry.error.startsWith("vacuous:");
}

/**
 * #2940 gate-excusal — **TEMPORARY, DEFAULT-ON** (remove after the post-#2463
 * standalone baseline promotes to new-policy; removal follow-up #3001). True
 * for the ONLY extra pass→fail flip excused: the BASELINE was a `pass` and the
 * NEW row is a #2940 vacuity reclassification. The exclusion is applied
 * UNCONDITIONALLY in `run` (no CLI flag) — see the long rationale at the
 * `isExcusedVacuous` use-site: `merge_group` runs the base-branch YAML against
 * the merged-tree script, so only a default-on (script-side) exclusion fires in
 * the fixing PR's own merge_group.
 *
 * Root cause this bridges: #2463's vacuity scorer intentionally rescored
 * ~1438 vacuous "passes" as `fail` WITHOUT bumping the #2096 oracle_version,
 * so a diff against a STALE pre-#2463 baseline (which still records those rows
 * `pass`) reads the policy delta as a mass regression. The host baseline was
 * re-promoted to new-policy but the STANDALONE baseline was not, so every
 * code PR's merge_group standalone diff trips the #1897 guard on the same
 * `d822f85a` cluster — wedging the merge queue. This excusal drops those
 * reclassifications out of the gated regression count so the queue clears; the
 * next push-to-main then promotes the standalone baseline to new-policy, after
 * which this excuses ZERO transitions and MUST be removed (else it would mask a
 * genuine true-pass→"callback never executed" codegen break). A NEW row that is
 * NOT vacuous still trips the guard at full strength.
 */
export function isVacuousReclassification(base: TestResult | undefined, cur: TestResult | undefined): boolean {
  if (!base || base.status !== "pass") return false;
  return isVacuousResult(cur);
}

/**
 * #3592 — ONE-TIME standalone DE-VACUIFICATION allowance (change-scoped,
 * standalone lane only).
 *
 * Background: #3592 RC2 measured that `__apply_closure` dispatched on the
 * dynamic argument count alone, so an under-applied call through the
 * closure-dispatch bridge (e.g. `assert.sameValue(a, b)` — 2 args into 3
 * formals) silently NEVER invoked the callee: 18.9 % of sampled standalone
 * passes (453 of 2,395; N = 4,000 seeded A/B) were vacuous through this one
 * mechanism. Fixing the dispatch to `max(argc, declaredArity)` converts those
 * fake passes into HONEST fails — an integrity correction, not a conformance
 * regression — but the #1897 guard diffs against the pre-fix baseline (which
 * records them `pass`) and would read the correction as a mass regression.
 *
 * Unlike #2940 there is no per-row marker (the new rows are ordinary honest
 * assertion failures), so the excusal is a DECLARED, per-PR ceiling in the
 * PR's own issue-file frontmatter (same change-set scoping as
 * `regressions-allow`/`trap-growth-allow` — an allowance that landed on main
 * grants nothing to later PRs):
 *
 *   standalone-devacuification-allow:
 *     count: <ceiling>
 *     reason: "<measured basis for the expected honest-fail conversion>"
 *
 * Containment (all load-bearing):
 *   - STANDALONE LANE ONLY: consulted exclusively under
 *     `--exclude-leaky-baseline-regressions` (main's YAML already passes it in
 *     the #1897 guard step), so the js-host catastrophic/regression gates are
 *     byte-unchanged.
 *   - CEILING, NOT BLANK CHECK: more matching flips than the declared count
 *     hard-fails the gate — reality exceeding the declaration is itself
 *     signal and needs a fresh, honest re-declaration.
 *   - FAIL-ONLY: only `pass → fail` flips qualify; `pass → compile_error` /
 *     `absent` still count at full strength.
 *   - TRAP-VERIFIED: a flip whose new row is an uncatchable-trap category is
 *     excusable ONLY when the trap is verifiably PRE-EXISTING (unmasked by the
 *     callee finally running): its innermost wasm frame must NOT be the
 *     dispatcher (`__call_fn_method_N`). A dispatcher-innermost trap is by
 *     construction INTRODUCED by the arity widening's own argument conversion
 *     (#3592 §2) and remains a hard #3189 ratchet failure. A frameless trap
 *     message cannot be verified and is NOT excused.
 *   - SELF-REMOVING: once `promote-baseline` re-seeds the standalone baseline
 *     post-merge, the affected rows are no longer baseline `pass`, so even the
 *     declaring PR's mechanism excuses zero flips on any later diff; and the
 *     change-set scoping means later PRs never see the declaration at all.
 */
export const DEVACUIFICATION_ALLOW_KEY = "standalone-devacuification-allow";

/**
 * #3592 — the innermost wasm frame of an enriched trap message. TWO renderers
 * produce these strings, both trap-first (innermost frame named right after
 * `in`):
 *   - the local runner's `enrichErrorMessage` (tests/test262-runner.ts):
 *     `<msg> in <leaf>() at source L<n> (via <caller>@L<n> ← …)`
 *   - the CI worker (scripts/test262-worker.mjs `describeWasmError`):
 *     `<msg> [in <leaf>() ← <caller> ← …]`
 * The first `in <name>()` occurrence (space- OR bracket-prefixed) names the
 * trap site. Parsing ONLY the space form was the #3601-park verification-
 * coverage gap: every CI trap row read as frameless, so zero unmasked
 * pre-existing traps could be verified. Returns null when the message carries
 * no recognizable frame.
 */
export function trapInnermostFrame(error: string | undefined): string | null {
  if (!error) return null;
  const m = /[[ ]in ([A-Za-z0-9_$.]+)\(\)/.exec(error);
  return m ? m[1]! : null;
}

/**
 * #3592 §2 — a widening-INTRODUCED trap can only arise inside the dispatcher's
 * own argument conversion, so its innermost frame is `__call_fn_method_N`
 * itself. A user closure / runtime helper innermost frame means the trap
 * pre-existed and was merely unmasked by the call finally happening.
 */
export function isDispatcherIntroducedTrap(error: string | undefined): boolean {
  const frame = trapInnermostFrame(error);
  return frame !== null && /^__call_fn_method_\d+$/.test(frame);
}

/**
 * #3592 — is this pass→X regression row excusable under a declared
 * de-vacuification allowance? See DEVACUIFICATION_ALLOW_KEY for the contract.
 *
 * Two tiers (#3601 park ruling):
 *   - a NON-TRAP `pass → fail` flip is excusable under the ceiling alone (an
 *     ordinary honest assertion failure surfacing);
 *   - a TRAP flip is excusable ONLY when (1) it is NAMED in the declaration's
 *     nested `tests:` list (`declaredTraps`), (2) its innermost frame is
 *     extractable, and (3) that frame is NOT the dispatcher. Naming makes the
 *     claim per-test and change-scoped (the declaring PR carries the OFF/ON
 *     vacuity evidence for each named file in its issue doc); the frame check
 *     machine-verifies — on the live CI row — that the trap fires inside the
 *     callee's own code (the de-vacuified call finally reaching a genuine
 *     callee defect), not inside the widening's own argument conversion. A
 *     `pass → trap` flip OUTSIDE the named cluster is NEVER excused and still
 *     hard-fails the #3189 ratchet: this mechanism must not generalise to
 *     "pass → trap is acceptable".
 */
export function isDevacuificationExcusableFlip(
  r: { file?: string; to: string; error?: string; error_category?: string },
  declaredTraps?: Set<string>,
): boolean {
  if (r.to !== "fail") return false;
  const isTrap = !!r.error_category && (TRAP_ERROR_CATEGORIES as readonly string[]).includes(r.error_category);
  if (!isTrap) return true;
  if (!declaredTraps || !r.file || !declaredTraps.has(r.file)) return false;
  return trapInnermostFrame(r.error) !== null && !isDispatcherIntroducedTrap(r.error);
}

/**
 * #3592 — evaluate a declared de-vacuification allowance against the
 * candidate regression rows (already filtered for CT flake / wasm-identical
 * noise / the other excusals). Pure (no I/O) so the unit test drives it with
 * fixtures, mirroring `evaluateTrapReclassification` (#3596).
 *
 * Returns the files to excuse from the gated regression count, the subset to
 * exclude from the #3189 trap-category growth (verified unmasked pre-existing
 * traps), GATE-FAIL reasons (ceiling exceeded ⇒ excuse NOTHING), and loud
 * informational notes.
 */
export function evaluateDevacuificationAllowance(opts: {
  allowance: RegressionsAllowance;
  candidates: { file: string; to: string; error?: string; error_category?: string }[];
}): { excusedFiles: Set<string>; trapExcludedFiles: Set<string>; failures: string[]; notes: string[] } {
  const { allowance, candidates } = opts;
  const failures: string[] = [];
  const notes: string[] = [];
  // #3601 — the declaration's nested `tests:` list names the pass→trap files
  // claimed as de-vacuified callee defects (per-file OFF/ON evidence recorded
  // in the declaring issue). Trap flips outside this list are never excused.
  const declaredTraps = new Set(allowance.tests ?? []);

  // (#3613) VACUOUS-VERIFIER GUARD. `trapInnermostFrame` is the machine check
  // that makes a declared trap excusal trustworthy; if it can answer for NONE
  // of the trap candidates, the "verified 0" it reports is a parser-coverage
  // failure, not evidence of a clean population. That exact blindness produced
  // the #3601 park's "0 verified unmasked pre-existing traps" (the CI worker's
  // `[in name() ← …]` grammar was unparsed). Warn LOUDLY instead of returning
  // a silent zero. The excusal itself stays conservative — an unverifiable
  // trap is still refused — so this is a diagnostic, not a gate relaxation.
  const trapCandidates = candidates.filter(
    (r) => !!r.error_category && (TRAP_ERROR_CATEGORIES as readonly string[]).includes(r.error_category),
  );
  const { warning: vacuityWarning } = guardedFilter(trapCandidates, (r) => trapInnermostFrame(r.error) !== null, {
    name: "trapInnermostFrame",
    hint: "trap-message frame-grammar drift — the local runner renders `in name() at source L…` while the CI worker renders `[in name() ← caller ← …]`; a third renderer would be invisible the same way",
  });
  if (vacuityWarning) notes.push(vacuityWarning);

  const excusable = candidates.filter((r) => isDevacuificationExcusableFlip(r, declaredTraps));
  const where = allowance.sources.join(", ");
  if (excusable.length > allowance.count) {
    failures.push(
      `standalone-devacuification-allow ceiling exceeded (#3592): ${excusable.length} qualifying pass→fail flips > declared count ${allowance.count} ` +
        `(declared in ${where}; reason: ${allowance.reason}). The declared count is a ceiling the PR commits to, not a blank check — ` +
        `re-measure and re-declare honestly if the de-vacuification really grew. NO flips were excused`,
    );
    return { excusedFiles: new Set(), trapExcludedFiles: new Set(), failures, notes };
  }
  const excusedFiles = new Set(excusable.map((r) => r.file));
  const trapExcludedFiles = new Set(
    excusable
      .filter((r) => !!r.error_category && (TRAP_ERROR_CATEGORIES as readonly string[]).includes(r.error_category))
      .map((r) => r.file),
  );
  if (excusedFiles.size > 0) {
    notes.push(
      `=== standalone-devacuification-allow (#3592): excused ${excusedFiles.size} of ceiling ${allowance.count} declared pass→fail de-vacuification flips ` +
        `(${trapExcludedFiles.size} NAMED + frame-verified de-vacuified trap(s) also excluded from the #3189 ratchet) — ` +
        `reason: ${allowance.reason} (declared in ${where}). Un-named pass→trap flips, dispatcher-innermost traps and pass→compile_error flips are NOT excused. ===`,
    );
  }
  return { excusedFiles, trapExcludedFiles, failures, notes };
}

type StatusMap = Map<string, TestResult>;

type OracleLane = "honest" | "fast-nativeharness";

interface LoadedJsonl {
  map: StatusMap;
  /**
   * The oracle_version observed in the file. `undefined` if no row carried
   * one (a pre-#2096 file). `"mixed"` if rows disagreed — a file assembled
   * from shards run under different oracles, which must never be compared.
   */
  oracleVersion: number | "mixed" | undefined;
  /**
   * #3462: the oracle LANE observed in the file, normalized so an absent
   * `oracle_lane` (pre-#3462 rows) counts as "honest". `undefined` only for an
   * empty file (no rows at all). `"mixed"` if rows disagreed — a file assembled
   * from BOTH lanes (e.g. host-fast + standalone-honest rows in one JSONL),
   * which must never be diffed against a single-lane baseline.
   */
  oracleLane: OracleLane | "mixed" | undefined;
  /**
   * #3462: the fast-oracle revision observed among `fast-nativeharness` rows.
   * `undefined` when the file carries no fast rows. `"mixed"` if fast rows
   * disagreed on the rev. Only consulted when both sides are the fast lane.
   */
  oracleFastRev: number | "mixed" | undefined;
}

async function loadJsonl(path: string): Promise<LoadedJsonl> {
  const map: StatusMap = new Map();
  let oracleVersion: number | "mixed" | undefined;
  let oracleLane: OracleLane | "mixed" | undefined;
  let oracleFastRev: number | "mixed" | undefined;
  const rl = createInterface({ input: createReadStream(path) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TestResult;
      if (typeof entry.oracle_version === "number" && oracleVersion !== "mixed") {
        if (oracleVersion === undefined) oracleVersion = entry.oracle_version;
        else if (oracleVersion !== entry.oracle_version) oracleVersion = "mixed";
      }
      // #3462: normalize absent oracle_lane ⇒ "honest" (backward-compatible),
      // then track a single file-level lane. A file mixing lanes is "mixed" and
      // is refused, exactly like a mixed oracle_version.
      const lane: OracleLane = entry.oracle_lane === "fast-nativeharness" ? "fast-nativeharness" : "honest";
      if (oracleLane !== "mixed") {
        if (oracleLane === undefined) oracleLane = lane;
        else if (oracleLane !== lane) oracleLane = "mixed";
      }
      if (lane === "fast-nativeharness" && typeof entry.oracle_fast_rev === "number" && oracleFastRev !== "mixed") {
        if (oracleFastRev === undefined) oracleFastRev = entry.oracle_fast_rev;
        else if (oracleFastRev !== entry.oracle_fast_rev) oracleFastRev = "mixed";
      }
      if (entry.file) {
        map.set(entry.file, entry);
      }
    } catch {
      // skip malformed lines
    }
  }
  return { map, oracleVersion, oracleLane, oracleFastRev };
}

// Reads baseline metadata (baseline_generated_at, baseline_sha) from a report.json.
// Used to warn when the committed baseline is older than 6 hours — see #1079.
function readBaselineMeta(path: string): { generatedAt?: string; sha?: string } | null {
  try {
    const raw = readFileSync(path, "utf8");
    const json = JSON.parse(raw);
    return {
      generatedAt: typeof json.baseline_generated_at === "string" ? json.baseline_generated_at : undefined,
      sha: typeof json.baseline_sha === "string" ? json.baseline_sha : undefined,
    };
  } catch {
    return null;
  }
}

function formatAge(ageMs: number): string {
  const totalMinutes = Math.max(0, Math.floor(ageMs / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function main() {
  const args = process.argv.slice(2);

  if (args.length < 2 || args.includes("--help") || args.includes("-h")) {
    console.log(`Usage: npx tsx scripts/diff-test262.ts <baseline.jsonl> <new.jsonl>

Compare two test262 JSONL result files and report regressions/improvements.

Options:
  --verbose, -v                 Show individual test transitions (default: show up to 20)
  --all                         Show all transitions (no limit)
  --quiet, -q                   Only show summary counts
  --baseline-meta <report.json> Read baseline_generated_at + baseline_sha to warn on stale baseline

Environment:
  ORACLE_REBASE=1               Allow a cross-oracle-version diff (#2096). By default a diff
                                between two JSONL files whose rows carry different oracle_version
                                stamps is refused (exit 2), because the verdict logic differed and
                                the diff would read oracle skew as regressions. Set this only on the
                                oracle-flip PR (e.g. #1945) to intentionally re-seed the baseline at
                                the new oracle version.
  REGRESSIONS_ALLOW_FILE=<path> (#3303) Read the rebase-mode 'regressions-allow:' ceiling from ONE
                                explicit file instead of the change-set's own plan/issues diff.
                                Test/emergency hook; /dev/null disables the allowance entirely.
                                In rebase mode ONLY, a PR may declare in its own issue file:
                                  regressions-allow:
                                    count: <N>
                                    reason: "<why these flips are honest>"
                                which supersedes the drift-tolerance + bucket checks up to count
                                (hard-fails above it; #3189 trap ratchet is never excused).
  --path-filter <patterns>      Restrict the diff to tests whose path contains any of the
                                pipe-separated substrings (same semantics as TEST262_PATH_FILTER).
                                Used by #1954 scoped PR-time runs: the candidate JSONL only covers
                                the scoped subset, so the baseline must be restricted the same way
                                or every out-of-scope baseline pass counts as a pass→absent regression.
  STANDALONE_DEVACUIFICATION_ALLOW_FILE=<path>
                                (#3592) Read the standalone-lane 'standalone-devacuification-allow:'
                                ceiling from ONE explicit file instead of the change-set's own
                                plan/issues diff. Test/emergency hook. Only consulted together with
                                --exclude-leaky-baseline-regressions. A PR performing a deliberate
                                honest-floor de-inflation may declare in its own issue file:
                                  standalone-devacuification-allow:
                                    count: <N>
                                    reason: "<measured basis>"
                                which excuses up to N baseline-pass → fail flips from the gated
                                standalone regression count (hard-fails above N; pass→compile_error
                                is never excused; a trap flip is excused only when its innermost
                                frame proves the trap pre-existing, and dispatcher-innermost traps
                                still hard-fail the #3189 ratchet).
  --exclude-leaky-baseline-regressions
                                (#2879 §4, standalone lane) Excuse pass→fail flips where the baseline
                                was a LEAKY pass (leaned on a host env:: import) and the new row is
                                host-free — a carrier migration removing a host dep, not a regression.
  --help, -h                    Show this help

Host-lane note: #3426 excludes only the exact union of paths observed changing
status in complete same-SHA pool-4 A/B canaries recorded by
scripts/test262-host-noise-quarantine.json. The repeat-confirmed intersection is
reported separately. Every matching transition remains listed as QUARANTINED.
The standalone invocation (--exclude-leaky-baseline-regressions) never loads or
applies this JS-host-only manifest.

Note: #2940 vacuity reclassifications (pass → a NEW row scored 'vacuous' — the
harness callback never ran, so nothing asserted) are excluded from the gated
regression count UNCONDITIONALLY (default-on, like the #2167 stale-async flake),
not behind a flag. This is REQUIRED for self-landing: merge_group runs main's
workflow YAML against the merged-tree script, so a flag added only in a PR's YAML
would not take effect in that PR's own merge_group. TEMPORARY — removal follow-up
#3001.`);
    process.exit(args.includes("--help") || args.includes("-h") ? 0 : 1);
  }

  const positional = args.filter((a, i) => {
    if (a.startsWith("--") || a.startsWith("-")) return false;
    const prev = args[i - 1];
    if (prev === "--baseline-meta" || prev === "--path-filter") return false;
    return true;
  });
  const baselinePath = positional[0];
  const newPath = positional[1];
  const verbose = args.includes("--verbose") || args.includes("-v");
  const showAll = args.includes("--all");
  const quiet = args.includes("--quiet") || args.includes("-q");
  const metaIdx = args.indexOf("--baseline-meta");
  const baselineMetaPath = metaIdx >= 0 ? args[metaIdx + 1] : undefined;
  const filterIdx = args.indexOf("--path-filter");
  const rawPathFilter = filterIdx >= 0 ? (args[filterIdx + 1] ?? "") : "";
  const pathFilter = rawPathFilter
    .split("|")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  // #2890 / #2879 §4 — opt-in host-free accounting for the STANDALONE lane only.
  // The standalone guard step passes this; the js-host catastrophic guard /
  // dev-self-merge / triage callers do NOT, so their behaviour is unchanged.
  const excludeLeakyBaseline = args.includes("--exclude-leaky-baseline-regressions");

  const maxShow = showAll ? Infinity : verbose ? 50 : 20;

  run(baselinePath, newPath, maxShow, quiet, baselineMetaPath, pathFilter, excludeLeakyBaseline);
}

function applyPathFilter(map: StatusMap, patterns: string[]): StatusMap {
  if (patterns.length === 0) return map;
  const filtered: StatusMap = new Map();
  for (const [file, entry] of map) {
    if (patterns.some((p) => file.includes(p))) filtered.set(file, entry);
  }
  return filtered;
}

async function run(
  baselinePath: string,
  newPath: string,
  maxShow: number,
  quiet: boolean,
  baselineMetaPath?: string,
  pathFilter: string[] = [],
  excludeLeakyBaseline = false,
) {
  const [baselineLoaded, newerLoaded] = await Promise.all([loadJsonl(baselinePath), loadJsonl(newPath)]);
  let baseline = baselineLoaded.map;
  let newer = newerLoaded.map;

  // #2096: cross-version oracle guard. The oracle (verdict logic) decides
  // pass/fail/CE; when it tightens (e.g. the #1945 trap-vs-TypeError upgrade)
  // rows flip for the SAME compiler output. Diffing a baseline against a
  // candidate produced under a DIFFERENT oracle reads that skew as regressions
  // and trips the gate on oracle change, not code change. Refuse such a diff
  // unless ORACLE_REBASE=1 — which is how the oracle-flip PR re-seeds the
  // baseline at the new version (promote-baseline picks it up on merge).
  //
  // #3086 — FORWARD-MONOTONIC AUTO-REBASE (the self-land key). A cross-version
  // diff otherwise hard-refuses (exit 2) unless ORACLE_REBASE=1. But
  // `merge_group` runs the BASE-branch (main) workflow YAML, which never sets
  // that env var — so a naive oracle bump would exit 2 in the merged-tree diff,
  // fail the required guard step (which does `exit $diff_exit`), and — worse —
  // the push-to-main promote-baseline (`needs: merge-report`) would ALSO refuse,
  // permanently wedging the queue (the refusal blocks the very promote that
  // would re-seed the baseline at the new version). This is the untested hole
  // #3003 documented (the oracle was never actually bumped before). Fix: a
  // FORWARD bump (newOracle > baseOracle) is ALWAYS a deliberate re-baseline —
  // the oracle is a hand-edited, append-only integer, never accidentally raised
  // — so the merged-tree script treats it as an implicit rebase and PROCEEDS
  // (loud warning, exit 0) regardless of which YAML runs. This self-lands like
  // #3004's default-on excusal. A BACKWARD / equal-but-shouldn't diff is left to
  // the explicit env flag (a backward skew IS the accidental case to catch).
  // The guards keep their teeth: in rebase mode the diff still counts genuine
  // (non-excused, non-vacuous) regressions, so a real codegen break in the same
  // PR still trips; only the intended oracle-skew flips are excused.
  const oracleRebase = process.env.ORACLE_REBASE === "1";
  const baseOracle = baselineLoaded.oracleVersion;
  const newOracle = newerLoaded.oracleVersion;
  const rebaseMode =
    oracleRebase || (typeof baseOracle === "number" && typeof newOracle === "number" && newOracle > baseOracle);
  const fmtOracle = (v: number | "mixed" | undefined) =>
    v === undefined ? "unstamped (pre-#2096)" : v === "mixed" ? "mixed (multiple versions)" : `v${v}`;

  // A "mixed" file is never comparable: it was assembled from shards run under
  // different oracles, so even a same-version peer can't be trusted. This is a
  // hard error regardless of ORACLE_REBASE.
  if (baseOracle === "mixed" || newOracle === "mixed") {
    console.error(
      `\n✖ Oracle-version guard (#2096): one side carries MIXED oracle versions ` +
        `(baseline=${fmtOracle(baseOracle)}, new=${fmtOracle(newOracle)}).\n` +
        `  A result file assembled from shards run under different oracles cannot be diffed.\n` +
        `  Re-run all shards under a single oracle version, then diff again.\n`,
    );
    process.exit(2);
  }

  // Differing single versions: refuse unless explicitly rebasing. Treat an
  // unstamped (pre-#2096) file as comparable to anything — there is no
  // recorded oracle to conflict with, so we fall back to the legacy behaviour
  // and only emit an informational note.
  if (baseOracle !== undefined && newOracle !== undefined && baseOracle !== newOracle) {
    // #3086: a FORWARD monotonic bump auto-rebases (see the block comment
    // above); a backward skew still requires the explicit env flag.
    const forwardBump = typeof baseOracle === "number" && typeof newOracle === "number" && newOracle > baseOracle;
    if (!rebaseMode) {
      console.error(
        `\n✖ Oracle-version guard (#2096): cross-version diff refused.\n` +
          `  baseline oracle = ${fmtOracle(baseOracle)}, new oracle = ${fmtOracle(newOracle)}.\n` +
          `  The new side is an OLDER oracle than the baseline — that is the accidental\n` +
          `  skew case (stale code vs a newer baseline), not a deliberate forward re-seed.\n` +
          `  If this backward comparison is intentional, re-run with ORACLE_REBASE=1.\n`,
      );
      process.exit(2);
    }
    console.log(
      `${forwardBump && !oracleRebase ? "ORACLE forward-bump auto-rebase (#3086)" : "ORACLE_REBASE=1"} — ` +
        `comparing across oracle versions (baseline ${fmtOracle(baseOracle)} → new ${fmtOracle(newOracle)}). ` +
        `This is a deliberate re-baseline: oracle-skew flips (e.g. #2940/#3086 vacuity) are excused, ` +
        `but genuine non-vacuous regressions below still count. promote-baseline re-seeds at the new version.`,
    );
  } else if (baseOracle === undefined || newOracle === undefined) {
    console.log(
      `Oracle-version note (#2096): ${fmtOracle(baseOracle)} (baseline) vs ${fmtOracle(newOracle)} (new) — ` +
        `at least one side is unstamped, comparing as legacy same-oracle.`,
    );
  }

  // #3462 — oracle-LANE guard (the #3450 hybrid two-oracle pipeline). The FAST
  // native-harness lane (host only) and the HONEST in-wasm v8 lane share the
  // same `oracle_version` (v8) but produce DIFFERENT verdicts at the
  // native-harness boundary (~9,244 corpus-projected flips). They must never be
  // diffed against each other, or the gate reads those baked-in boundary flips
  // as regressions. `oracle_version` alone cannot catch this — both lanes are
  // v8 — so the lane is a SEPARATE guard here.
  //
  // Unlike the version axis, the lane axis is NOT monotonic: there is no
  // "forward bump" that auto-rebases (#3086), because neither lane supersedes
  // the other — they measure different things. So a lane mismatch is excused
  // ONLY by an explicit `ORACLE_REBASE=1`, which is how the fast baseline is
  // seeded (#3465). Absent `oracle_lane` is normalized to "honest" in the loader
  // (backward-compatible with every pre-#3462 baseline), so an old honest
  // baseline vs a new honest candidate compares cleanly.
  const baseLane = baselineLoaded.oracleLane;
  const newLane = newerLoaded.oracleLane;
  const fmtLane = (v: OracleLane | "mixed" | undefined) =>
    v === undefined ? "honest (no rows)" : v === "mixed" ? "mixed (both lanes)" : v;

  // A file assembled from BOTH lanes (e.g. host-fast + standalone-honest rows in
  // one JSONL) is never comparable to a single-lane baseline — hard error,
  // regardless of ORACLE_REBASE (mirrors the mixed-oracle_version refusal).
  if (baseLane === "mixed" || newLane === "mixed") {
    console.error(
      `\n✖ Oracle-lane guard (#3462): one side carries MIXED oracle lanes ` +
        `(baseline=${fmtLane(baseLane)}, new=${fmtLane(newLane)}).\n` +
        `  A result file that mixes the honest and fast-native-harness lanes cannot be diffed.\n` +
        `  Split the run by lane (host-fast vs standalone/honest) and diff each against its own baseline.\n`,
    );
    process.exit(2);
  }

  if (baseLane !== undefined && newLane !== undefined && baseLane !== newLane) {
    // Cross-LANE diff (honest-vs-fast or fast-vs-honest). Excused only by the
    // explicit env flag — there is no forward-bump auto-rebase for the lane.
    if (!oracleRebase) {
      console.error(
        `\n✖ Oracle-lane guard (#3462): cross-lane diff refused.\n` +
          `  baseline lane = ${fmtLane(baseLane)}, new lane = ${fmtLane(newLane)}.\n` +
          `  The fast native-harness lane and the honest in-wasm v8 lane are both oracle ${fmtOracle(newOracle)}\n` +
          `  but produce different verdicts at the native-harness boundary (~9,244 baked-in flips),\n` +
          `  so diffing one against the other reads that boundary as regressions. This is the mechanism\n` +
          `  that keeps a fast candidate from ever being gated against the honest baseline (and vice-versa).\n` +
          `  If this is a deliberate fast-lane re-seed (#3465), re-run with ORACLE_REBASE=1.\n`,
      );
      process.exit(2);
    }
    console.log(
      `ORACLE_REBASE=1 — comparing across oracle LANES ` +
        `(baseline ${fmtLane(baseLane)} → new ${fmtLane(newLane)}). Deliberate fast-lane re-seed (#3462/#3465): ` +
        `the ~9,244 native-harness boundary flips are being baked into the fast baseline.`,
    );
  } else if (baseLane === "fast-nativeharness" && newLane === "fast-nativeharness") {
    // Same lane (both FAST) — the fast-rev must ALSO match. A rev bump means the
    // native-harness verdict boundary itself moved (binding-shim/realm policy),
    // so its baseline must be re-seeded, exactly like an honest oracle bump.
    const baseRev = baselineLoaded.oracleFastRev;
    const newRev = newerLoaded.oracleFastRev;
    const fmtRev = (v: number | "mixed" | undefined) =>
      v === undefined ? "unstamped" : v === "mixed" ? "mixed (multiple revs)" : `rev${v}`;
    if (baseRev === "mixed" || newRev === "mixed") {
      console.error(
        `\n✖ Oracle-lane guard (#3462): one fast side carries MIXED fast revs ` +
          `(baseline=${fmtRev(baseRev)}, new=${fmtRev(newRev)}).\n` +
          `  A fast result file assembled from shards run under different fast revisions cannot be diffed.\n`,
      );
      process.exit(2);
    }
    if (typeof baseRev === "number" && typeof newRev === "number" && baseRev !== newRev) {
      if (!oracleRebase) {
        console.error(
          `\n✖ Oracle-lane guard (#3462): fast-lane rev mismatch — diff refused.\n` +
            `  baseline ${fmtRev(baseRev)}, new ${fmtRev(newRev)}.\n` +
            `  The native-harness verdict boundary changed between these revisions, so their rows are not\n` +
            `  comparable. Re-seed the fast baseline at the new rev with ORACLE_REBASE=1 (#3465).\n`,
        );
        process.exit(2);
      }
      console.log(
        `ORACLE_REBASE=1 — comparing across fast oracle revisions ` +
          `(baseline ${fmtRev(baseRev)} → new ${fmtRev(newRev)}). Deliberate fast-lane re-seed (#3462/#3465).`,
      );
    }
  }

  if (pathFilter.length > 0) {
    const before = baseline.size;
    baseline = applyPathFilter(baseline, pathFilter);
    newer = applyPathFilter(newer, pathFilter);
    console.log(
      `Path filter active (${pathFilter.join(" | ")}): baseline ${before} → ${baseline.size} entries in scope.`,
    );
  }

  // #3426 — the base-main workflow already distinguishes the standalone lane
  // with this flag. That makes the exact same merged-tree script self-landing:
  // base-main YAML need not learn a new option before the host quarantine can
  // take effect, while standalone never loads or consults the host manifest.
  const hostNoiseQuarantine = excludeLeakyBaseline ? null : loadHostNoiseQuarantine();
  const isHostQuarantined = (file: string) => hostNoiseQuarantine?.paths.has(file) === true;

  // Collect transitions
  const regressions: {
    file: string;
    from: string;
    to: string;
    error?: string;
    error_category?: string;
    /**
     * True when both base and pr have a non-null wasm_sha and the values
     * match — i.e. the compiled binary is byte-identical, so any pass→fail
     * transition is CI runner noise (#1222).
     */
    wasmUnchanged: boolean;
    /**
     * #2098: the baseline-side `compile_ms` for this test, when recorded.
     * Used to split `pass → compile_timeout` regressions into `ct_flake`
     * (baseline already compiled near the 30s boundary in well under the
     * 5s flake threshold → the timeout is runner-load noise) vs `ct_suspect`
     * (baseline compile already > 5s → the PR may have pushed a genuinely
     * slow compile over the edge, worth a look). Encodes the tribal rule
     * "pass→compile_timeout is runner-load flake unless baseline compile >5s".
     */
    baselineCompileMs?: number;
    /**
     * #2890 / #2879 §4 — true when the baseline was a LEAKY pass (leaned on the
     * host) and the new result is HOST-FREE. Such a flip removes a host
     * dependency (host_free_pass unchanged), so it is excused from the gated
     * standalone regression count when `--exclude-leaky-baseline-regressions` is
     * set. The js-host lane never sets the flag, so this is always counted there.
     */
    leakyBaselineToHostFree: boolean;
    /**
     * #2940 — true when the baseline was a `pass` and the NEW row is a #2940
     * vacuity reclassification (harness callback never ran → scored `fail`).
     * Excused from the gated regression count UNCONDITIONALLY (default-on,
     * **TEMPORARY** — removal follow-up #3001). See `isVacuousReclassification`.
     */
    vacuousReclassification: boolean;
    /** #3426: exact path changed status between same-compiler host canary runs. */
    hostQuarantined: boolean;
  }[] = [];
  const improvements: { file: string; from: string; to: string; hostQuarantined: boolean }[] = [];
  const otherChanges: { file: string; from: string; to: string; hostQuarantined: boolean }[] = [];

  // Count statuses
  const baselineCounts: Record<string, number> = {};
  const newCounts: Record<string, number> = {};

  for (const [file, entry] of baseline) {
    baselineCounts[entry.status] = (baselineCounts[entry.status] || 0) + 1;
  }
  for (const [file, entry] of newer) {
    newCounts[entry.status] = (newCounts[entry.status] || 0) + 1;
  }

  // All files in either set
  const allFiles = new Set([...baseline.keys(), ...newer.keys()]);

  for (const file of allFiles) {
    const base = baseline.get(file);
    const cur = newer.get(file);

    const baseStatus = base?.status ?? "absent";
    const curStatus = cur?.status ?? "absent";

    if (baseStatus === curStatus) continue;

    if (baseStatus === "pass" && curStatus !== "pass") {
      // #1222: if both runs produced a Wasm binary and the binaries are
      // byte-identical, the test cannot have regressed for any compiler
      // reason — the runtime difference is CI-runner variance (scheduling,
      // memory pressure, GC timing). The merge gate uses
      // `regressions_wasm_change` which excludes these.
      const baseSha = base?.wasm_sha;
      const curSha = cur?.wasm_sha;
      const wasmUnchanged = typeof baseSha === "string" && typeof curSha === "string" && baseSha === curSha;
      regressions.push({
        file,
        from: baseStatus,
        to: curStatus,
        error: cur?.error,
        error_category: cur?.error_category,
        wasmUnchanged,
        baselineCompileMs: typeof base?.compile_ms === "number" ? base.compile_ms : undefined,
        // #2890 / #2879 §4 — leaky-baseline → host-free-fail (excused only under
        // the standalone flag). `base`/`cur` are the full rows; `base` is a pass
        // here by construction.
        leakyBaselineToHostFree: isLeakyBaselineToHostFreeRegression(base, cur),
        // #2940 — vacuity reclassification (excused UNCONDITIONALLY / default-on,
        // TEMPORARY #3001). `base` is a pass by construction; `cur` carries the
        // vacuity marker.
        vacuousReclassification: isVacuousReclassification(base, cur),
        hostQuarantined: isHostQuarantined(file),
      });
    } else if (baseStatus !== "pass" && curStatus === "pass") {
      improvements.push({ file, from: baseStatus, to: curStatus, hostQuarantined: isHostQuarantined(file) });
    } else {
      otherChanges.push({ file, from: baseStatus, to: curStatus, hostQuarantined: isHostQuarantined(file) });
    }
  }

  // Sort by file path for deterministic output
  regressions.sort((a, b) => a.file.localeCompare(b.file));
  improvements.sort((a, b) => a.file.localeCompare(b.file));
  otherChanges.sort((a, b) => a.file.localeCompare(b.file));
  const quarantinedTransitions = [...regressions, ...improvements, ...otherChanges]
    .filter((entry) => entry.hostQuarantined)
    .sort((a, b) => a.file.localeCompare(b.file));
  const stableImprovements = improvements.filter((entry) => !entry.hostQuarantined);

  // Print report
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  test262 diff: ${baseline.size} baseline → ${newer.size} new tests`);
  console.log(`${"=".repeat(60)}\n`);

  // Status counts
  const allStatuses = new Set([...Object.keys(baselineCounts), ...Object.keys(newCounts)]);
  console.log("  Status        Baseline    New      Delta");
  console.log("  " + "-".repeat(46));
  for (const status of [
    "pass",
    "fail",
    "compile_error",
    ...[...allStatuses].filter((s) => !["pass", "fail", "compile_error"].includes(s)).sort(),
  ]) {
    if (!allStatuses.has(status)) continue;
    const bCount = baselineCounts[status] || 0;
    const nCount = newCounts[status] || 0;
    const delta = nCount - bCount;
    const deltaStr = delta === 0 ? "" : delta > 0 ? `+${delta}` : `${delta}`;
    console.log(
      `  ${status.padEnd(16)}${String(bCount).padStart(7)}  ${String(nCount).padStart(7)}  ${deltaStr.padStart(7)}`,
    );
  }
  console.log();

  // Regressions
  const regColor = regressions.length > 0 ? "⚠️  " : "";
  console.log(`${regColor}=== Regressions (pass → other): ${regressions.length} ===`);
  // (#4218 park triage) Under --quiet, a SMALL regression list is still
  // printed: the required merge-group gate uploads/echoes only the quiet
  // output, and a park comment without the failing paths is undiagnosable
  // from outside CI (artifact blobs are unreachable from some agent
  // environments). At <=20 entries the list is shorter than the summary.
  if (quiet && regressions.length > 0 && regressions.length <= 20) {
    for (const r of regressions) {
      const errMsg = r.error ? ` (${truncate(r.error, 120)})` : "";
      console.log(`  ${r.file}: pass → ${r.to}${errMsg}`);
    }
  }
  if (!quiet && regressions.length > 0) {
    const shown = regressions.slice(0, maxShow);
    for (const r of shown) {
      const errMsg = r.error ? ` (${truncate(r.error, 80)})` : "";
      console.log(`  ${r.file}: pass → ${r.to}${errMsg}`);
    }
    if (regressions.length > maxShow) {
      console.log(`  ... and ${regressions.length - maxShow} more`);
    }
  }
  console.log();

  if (hostNoiseQuarantine) {
    const quarantinedRegressions = regressions.filter((entry) => entry.hostQuarantined).length;
    const quarantinedImprovements = improvements.filter((entry) => entry.hostQuarantined).length;
    const quarantinedOther = otherChanges.filter((entry) => entry.hostQuarantined).length;
    const { provenance, counts } = hostNoiseQuarantine.manifest;
    const intersectionTransitions = quarantinedTransitions.filter((entry) =>
      hostNoiseQuarantine.intersectionPaths.has(entry.file),
    ).length;
    console.log(
      `=== Host canary quarantine (#3426): ${quarantinedTransitions.length} observed transition(s) excluded from host fine/compile-time gate arithmetic ===`,
    );
    for (const canary of provenance.canaries) {
      console.log(
        `  Evidence: same-SHA run ${canary.canary_run_id}, compiler ${canary.compiler_sha}, artifact ${canary.artifact_id}, pool ${canary.compiler_pool_size}; ` +
          `${canary.unstable_paths} exact paths (${canary.pass_flips} pass flips + ${canary.non_pass_status_noise} non-pass noise).`,
      );
    }
    console.log(
      `  Manifest policy: ${counts.union_paths} union-eligible exact paths; ${counts.intersection_paths} intersection paths observed in all ${counts.canary_runs} canaries.`,
    );
    console.log(
      `  Current raw quarantined transitions: ${quarantinedRegressions} regression(s), ${quarantinedImprovements} improvement(s), ${quarantinedOther} other status change(s); ` +
        `${intersectionTransitions} intersection, ${quarantinedTransitions.length - intersectionTransitions} union-only.`,
    );
    // Always list every observed quarantined transition, including under
    // --quiet: the required workflow uploads this output as the audit artifact.
    for (const entry of quarantinedTransitions) {
      const evidenceClass = hostNoiseQuarantine.intersectionPaths.has(entry.file) ? "intersection" : "union-only";
      console.log(`  QUARANTINED ${entry.file}: ${entry.from} → ${entry.to} [${evidenceClass}]`);
    }
    console.log();
  }

  // #1192: split regressions by destination status. compile_timeout
  // transitions are runner-load timing noise (tests near the 30s
  // compile-timeout boundary flap based on CI system load), not real
  // compiler regressions. Emit separate counts so the merge gate can
  // exclude CT noise from the ratio. The "Regressions (pass → other)"
  // line above stays unchanged for backwards compat with the dashboard.
  const rawRegressionsCT = regressions.filter((r) => r.to === "compile_timeout").length;
  const quarantinedRegressionsCT = regressions.filter((r) => r.to === "compile_timeout" && r.hostQuarantined).length;
  const regressionsCT = rawRegressionsCT - quarantinedRegressionsCT;
  const rawImprovementsCT = improvements.filter((entry) => entry.from === "compile_timeout").length;
  const quarantinedImprovementsCT = improvements.filter(
    (entry) => entry.from === "compile_timeout" && entry.hostQuarantined,
  ).length;
  const improvementsCT = rawImprovementsCT - quarantinedImprovementsCT;
  const rawRegressionsReal = regressions.length - rawRegressionsCT;
  const quarantinedRegressionsReal = regressions.filter((r) => r.to !== "compile_timeout" && r.hostQuarantined).length;
  const regressionsReal = rawRegressionsReal - quarantinedRegressionsReal;
  // #3426 follow-up — host pool contention moves tests across the compile
  // timeout boundary in both directions. A forward-only count treats one side
  // of that symmetric churn as a compiler slowdown while discarding the exact
  // inverse evidence from the same comparison. For the HOST lane only, gate
  // directional growth in the pass↔compile_timeout population after removing
  // canary-proven paths from BOTH directions:
  //
  //   max(0, stable pass→compile_timeout − stable compile_timeout→pass)
  //
  // This still reports/fails one-way timeout growth at full strength. It does
  // not identify or excuse any additional path, and standalone keeps the
  // original forward-only count because it never loads the host manifest.
  // Keep the legacy first-line shape because the base-main #1942 shell parses
  // its first match; the following distinct labels make every component and
  // the interpretation observable.
  const directionalRegressionsCT = hostNoiseQuarantine ? Math.max(0, regressionsCT - improvementsCT) : regressionsCT;
  // #3370 — compile-time signals compare the cost of compiling the same
  // workload. A deliberate oracle rebaseline changes the assembled harness,
  // so old-oracle pass→timeout transitions are not compile regressions. Keep
  // the measured count visible, but reset the canonical gated signal consumed
  // by the #1942 workflow guard. Same-oracle comparisons are unchanged.
  const gatedRegressionsCT = rebaseMode ? 0 : directionalRegressionsCT;
  console.log(`=== Compile timeouts (pass → compile_timeout): ${gatedRegressionsCT} ===`);
  if (hostNoiseQuarantine) {
    console.log(`=== Stable host pass→compile_timeout transitions before symmetric offset: ${regressionsCT} ===`);
    console.log(`=== Stable host compile_timeout→pass reverse transitions: ${improvementsCT} ===`);
    console.log(
      `=== Stable host directional compile_timeout growth (max(0, pass→compile_timeout − compile_timeout→pass)): ${directionalRegressionsCT} ===`,
    );
    console.log(`=== Raw host pass→compile_timeout transitions before canary quarantine: ${rawRegressionsCT} ===`);
    console.log(`=== Host canary-quarantined pass→compile_timeout noise: ${quarantinedRegressionsCT} ===`);
    console.log(`=== Raw host compile_timeout→pass transitions before canary quarantine: ${rawImprovementsCT} ===`);
    console.log(`=== Host canary-quarantined compile_timeout→pass noise: ${quarantinedImprovementsCT} ===`);

    const rawBaselineCT = baselineCounts.compile_timeout ?? 0;
    const rawCurrentCT = newCounts.compile_timeout ?? 0;
    const quarantinedBaselineCT = [...baseline].filter(
      ([file, entry]) => entry.status === "compile_timeout" && isHostQuarantined(file),
    ).length;
    const quarantinedCurrentCT = [...newer].filter(
      ([file, entry]) => entry.status === "compile_timeout" && isHostQuarantined(file),
    ).length;
    const stableBaselineCT = rawBaselineCT - quarantinedBaselineCT;
    const stableCurrentCT = rawCurrentCT - quarantinedCurrentCT;
    const formatCountDelta = (value: number) => (value > 0 ? `+${value}` : `${value}`);
    console.log(
      `=== Stable host compile_timeout population: baseline ${stableBaselineCT} → current ${stableCurrentCT} ` +
        `(Δ ${formatCountDelta(stableCurrentCT - stableBaselineCT)}) ===`,
    );
    console.log(
      `=== Raw host compile_timeout population before canary quarantine: baseline ${rawBaselineCT} → current ${rawCurrentCT} ` +
        `(Δ ${formatCountDelta(rawCurrentCT - rawBaselineCT)}) ===`,
    );
    console.log(
      `=== Host canary-quarantined compile_timeout population: baseline ${quarantinedBaselineCT} → current ${quarantinedCurrentCT} ` +
        `(Δ ${formatCountDelta(quarantinedCurrentCT - quarantinedBaselineCT)}) ===`,
    );
  }
  if (rebaseMode && rawRegressionsCT > 0) {
    console.log(
      `=== Oracle re-baseline compile-time note (#3370): ${rawRegressionsCT} raw pass→compile_timeout transition(s) are not comparable across oracle versions. ===`,
    );
  }
  console.log(`=== Regressions excluding compile_timeout: ${regressionsReal} ===`);
  if (hostNoiseQuarantine) {
    console.log(
      `=== Raw host regressions excluding compile_timeout before canary quarantine: ${rawRegressionsReal} ===`,
    );
    console.log(`=== Host canary-quarantined non-timeout regression noise: ${quarantinedRegressionsReal} ===`);
  }

  // #2098: split compile_timeout regressions by baseline compile cost, encoding
  // the triage rule that lived only in memory files
  // (feedback_regression_analysis): "pass→compile_timeout is runner-load flake
  // unless baseline compile >5s". A test whose baseline already compiled in
  // well under the threshold can only have timed out from CI runner load
  // (`ct_flake`); one whose baseline was already slow may have been pushed over
  // the 30s wall by the PR and deserves a look (`ct_suspect`). A timeout with no
  // recorded baseline compile_ms is conservatively counted as suspect (we can't
  // prove it was fast). Output-only — no gate behaviour change; the workflow
  // already excludes ALL compile_timeout from the ratio (#1192/#1942).
  const CT_FLAKE_THRESHOLD_MS = 5000;
  const ctRegressions = regressions.filter((r) => r.to === "compile_timeout" && !r.hostQuarantined);
  let ctFlake = 0;
  let ctSuspect = 0;
  for (const r of ctRegressions) {
    if (typeof r.baselineCompileMs === "number" && r.baselineCompileMs <= CT_FLAKE_THRESHOLD_MS) {
      ctFlake += 1;
    } else {
      ctSuspect += 1;
    }
  }
  console.log(
    `=== ct_flake (compile_timeout, baseline ≤${CT_FLAKE_THRESHOLD_MS}ms — runner-load noise): ${ctFlake} ===`,
  );
  console.log(
    `=== ct_suspect (compile_timeout, baseline >${CT_FLAKE_THRESHOLD_MS}ms or unknown — investigate): ${ctSuspect} ===`,
  );
  if (!quiet && ctSuspect > 0) {
    for (const r of ctRegressions.filter(
      (r) => !(typeof r.baselineCompileMs === "number" && r.baselineCompileMs <= CT_FLAKE_THRESHOLD_MS),
    )) {
      const ms = typeof r.baselineCompileMs === "number" ? `${Math.round(r.baselineCompileMs)}ms` : "unknown";
      console.log(`  ct_suspect ${r.file} (baseline compile ${ms})`);
    }
  }

  // A baseline compile_timeout is an UNKNOWN runtime outcome. When the
  // candidate compiles the same test, classify that recovery by the candidate
  // compile cost so timeout noise remains visible without pretending the
  // predecessor established a pass/fail/trap result. This is output-only; the
  // #1942 timeout-population guard remains the compile-time gate.
  const baselineTimeoutRecoveries = [...newer].flatMap(([file, current]) => {
    const base = baseline.get(file);
    if (base?.status !== "compile_timeout" || current.status === "compile_timeout") return [];
    return [{ file, current }];
  });
  const ctFlakeRecoveries = baselineTimeoutRecoveries.filter(
    ({ current }) => typeof current.compile_ms === "number" && current.compile_ms <= CT_FLAKE_THRESHOLD_MS,
  );
  const ctSuspectRecoveries = baselineTimeoutRecoveries.filter(
    ({ current }) => !(typeof current.compile_ms === "number" && current.compile_ms <= CT_FLAKE_THRESHOLD_MS),
  );
  console.log(
    `=== ct_flake recoveries (baseline compile_timeout → observed, candidate ≤${CT_FLAKE_THRESHOLD_MS}ms): ${ctFlakeRecoveries.length} ===`,
  );
  console.log(
    `=== ct_suspect recoveries (baseline compile_timeout → observed, candidate >${CT_FLAKE_THRESHOLD_MS}ms or unknown): ${ctSuspectRecoveries.length} ===`,
  );
  if (!quiet) {
    for (const { file, current } of ctFlakeRecoveries) {
      console.log(`  ct_flake recovery ${file} (candidate compile ${Math.round(current.compile_ms!)}ms)`);
    }
    for (const { file, current } of ctSuspectRecoveries) {
      const ms = typeof current.compile_ms === "number" ? `${Math.round(current.compile_ms)}ms` : "unknown";
      console.log(`  ct_suspect recovery ${file} (candidate compile ${ms})`);
    }
  }

  // #1942: compile-time regression signals. `pass → compile_timeout` is
  // excluded from every regression gate (it's runner-load flake — see the
  // #1192 split above), which leaves a blind spot: a PR that pathologically
  // slows compilation (exponential type inference, accidental O(n²) pass)
  // converts passes to timeouts invisibly. Two cheap signals, both from data
  // already in the JSONL (`compile_ms`), gate that surface. We only EMIT them
  // here (grep-able lines); the workflow guard (#1942, test262-sharded.yml)
  // reads these lines and applies the thresholds, mirroring the #1897
  // standalone guard's "explicit threshold in YAML" style.
  //
  // (1) Aggregate compile time over the SHARED both-compiled set: files
  //     present in BOTH baseline and current whose status carries a binary
  //     (`compile_ms` present on both). Restricting to the intersection makes
  //     the sum immune to set-membership churn (added/removed tests, skips)
  //     and to single-test timeout flake — it measures the same population on
  //     both sides, so a >X% rise is a real systemic slowdown.
  let aggBaseMs = 0;
  let aggCurMs = 0;
  let aggShared = 0;
  let rawAggBaseMs = 0;
  let rawAggCurMs = 0;
  let rawAggShared = 0;
  let quarantinedAggBaseMs = 0;
  let quarantinedAggCurMs = 0;
  let quarantinedAggShared = 0;
  for (const [file, base] of baseline) {
    const cur = newer.get(file);
    if (!cur) continue;
    if (typeof base.compile_ms !== "number" || typeof cur.compile_ms !== "number") continue;
    rawAggBaseMs += base.compile_ms;
    rawAggCurMs += cur.compile_ms;
    rawAggShared += 1;
    if (isHostQuarantined(file)) {
      quarantinedAggBaseMs += base.compile_ms;
      quarantinedAggCurMs += cur.compile_ms;
      quarantinedAggShared += 1;
      continue;
    }
    aggBaseMs += base.compile_ms;
    aggCurMs += cur.compile_ms;
    aggShared += 1;
  }
  const aggPct = aggBaseMs > 0 ? ((aggCurMs - aggBaseMs) / aggBaseMs) * 100 : 0;
  const rawAggPct = rawAggBaseMs > 0 ? ((rawAggCurMs - rawAggBaseMs) / rawAggBaseMs) * 100 : 0;
  const quarantinedAggPct =
    quarantinedAggBaseMs > 0 ? ((quarantinedAggCurMs - quarantinedAggBaseMs) / quarantinedAggBaseMs) * 100 : 0;
  const gatedAggPct = rebaseMode ? 0 : aggPct;
  // Round to whole ms for the sums and one decimal for the percentage so the
  // workflow's `grep -oE '[0-9.-]+'` parses deterministically.
  console.log(
    `=== Aggregate compile time (shared ${aggShared} tests): baseline ${Math.round(aggBaseMs)}ms → current ${Math.round(aggCurMs)}ms (Δ ${gatedAggPct >= 0 ? "+" : ""}${gatedAggPct.toFixed(1)}%) ===`,
  );
  if (hostNoiseQuarantine) {
    console.log(
      `=== Raw host aggregate before canary quarantine (shared ${rawAggShared} tests): baseline ${Math.round(rawAggBaseMs)}ms → current ${Math.round(rawAggCurMs)}ms (Δ ${rawAggPct >= 0 ? "+" : ""}${rawAggPct.toFixed(1)}%) ===`,
    );
    console.log(
      `=== Host canary-quarantined aggregate contribution (shared ${quarantinedAggShared} tests): baseline ${Math.round(quarantinedAggBaseMs)}ms → current ${Math.round(quarantinedAggCurMs)}ms (Δ ${quarantinedAggPct >= 0 ? "+" : ""}${quarantinedAggPct.toFixed(1)}%) ===`,
    );
  }
  if (rebaseMode && rawAggPct !== 0) {
    console.log(
      `=== Oracle re-baseline compile-time note (#3370): raw aggregate delta ${rawAggPct >= 0 ? "+" : ""}${rawAggPct.toFixed(1)}%; the #1942 comparison resets because oracle ${fmtOracle(baseOracle)} → ${fmtOracle(newOracle)} changes the compiled harness workload. ===`,
    );
  }

  // #1222: filter regressions where the compiled Wasm binary is byte-identical
  // on both base and PR. A test that compiles to the same bytes cannot have
  // regressed due to anything in the PR — the pass→fail flip is pure CI runner
  // variance (scheduling, memory pressure, GC timing). The merge gate prefers
  // `regressions_wasm_change` over `regressions_real` to avoid flagging these
  // physically-impossible "regressions". Only counts entries where wasm_sha
  // is present on BOTH sides; if either is missing we conservatively treat
  // the regression as real (could be a compile_error vs pass transition).
  // Sprint 62 (#2167-flake): the async-`arguments`-from-nested-closure cluster
  // (`returns-async-{arrow,function}-returns-arguments-from-{own,parent}-function`)
  // flips `pass → compile_error` (invalid Wasm) — a genuine PRE-EXISTING
  // standalone codegen bug (arguments-capture lowered as externref where the
  // closure sig expects i32) that current main cannot compile. It is recorded
  // as `pass` in the STALE standalone baseline and never refreshes, because
  // `promote-baseline` only runs on a *successful* main push and main's
  // standalone run fails on exactly this cluster. So every standalone-touching
  // PR (incl. proven-identical-wasm and zero-codegen telemetry PRs) trips the
  // floor at the same ~-19 signature. Exclude this specific cluster from the
  // gated regression count until the underlying bug is fixed (own issue) and
  // the baseline can refresh. Narrowly matched so it cannot mask real regressions.
  const isStaleAsyncArgsFlake = (r: { to: string; file: string }) =>
    r.to === "compile_error" && /async/.test(r.file) && /returns-arguments-from-(own|parent)-function/.test(r.file);
  // #2890 / #2879 §4 — under the standalone flag, a leaky-baseline → host-free-fail
  // flip is NOT a regression (it removed a host dependency; host_free_pass is
  // unchanged). Excused ONLY from the GATED count, ONLY when the flag is set, and
  // ONLY for genuine leaky→host-free flips — a baseline that was already host-free
  // flipping to fail (`leakyBaselineToHostFree === false`) still counts at full
  // strength. The js-host catastrophic guard never sets the flag, so its count is
  // byte-unchanged.
  const isExcusedLeakyToHostFree = (r: { leakyBaselineToHostFree: boolean }) =>
    excludeLeakyBaseline && r.leakyBaselineToHostFree;
  const excusedLeakyToHostFree = regressions.filter(
    (r) =>
      !r.hostQuarantined &&
      r.to !== "compile_timeout" &&
      !r.wasmUnchanged &&
      !isStaleAsyncArgsFlake(r) &&
      isExcusedLeakyToHostFree(r),
  ).length;
  // #2940 gate-excusal — **TEMPORARY, DEFAULT-ON** (removal follow-up #3001).
  // A pass→fail flip whose NEW row is a #2940 vacuity reclassification is NOT a
  // regression: #2463's vacuity scorer intentionally rescored vacuous "passes"
  // (the harness-wrapper callback never ran, so nothing asserted) as `fail`
  // WITHOUT bumping the #2096 oracle_version, so a diff against a stale
  // pre-#2463 baseline reads the policy delta (the d822f85a −1438 cluster) as a
  // mass regression and WEDGES the merge queue.
  //
  // Why UNCONDITIONAL (no flag), mirroring `isStaleAsyncArgsFlake` above and
  // NOT the flag-gated leaky excusal: `merge_group` runs the workflow YAML from
  // the BASE branch (main), but checks out the MERGED-tree scripts. A flag added
  // only in a PR's YAML would therefore NOT be passed in that PR's own
  // merge_group (main's YAML runs), so the excusal would not fire and the fixing
  // PR would park itself — deadlock. Default-on in the merged-tree script fires
  // in every merge_group regardless of which YAML runs, so the fix self-lands.
  //
  // Excused ONLY from the GATED count, and ONLY for genuine vacuity flips — a
  // NEW row that is not vacuous (`vacuousReclassification === false`) still
  // counts at full strength. MUST be removed once the standalone baseline
  // promotes to new-policy (after which it excuses zero flips and would instead
  // MASK a true-pass → "callback never executed" codegen break) — see #3001.
  const isExcusedVacuous = (r: { vacuousReclassification: boolean }) => r.vacuousReclassification;
  // Count vacuity-excused flips NOT already excused as leaky→host-free, so the
  // two "excused" tallies partition the excused set (no double count).
  const excusedVacuous = regressions.filter(
    (r) =>
      !r.hostQuarantined &&
      r.to !== "compile_timeout" &&
      !r.wasmUnchanged &&
      !isStaleAsyncArgsFlake(r) &&
      !isExcusedLeakyToHostFree(r) &&
      isExcusedVacuous(r),
  ).length;
  // #3592 — ONE-TIME standalone de-vacuification allowance. Consulted ONLY on
  // the standalone lane (`--exclude-leaky-baseline-regressions` — already on
  // main's YAML in the #1897 guard step, so this is merge_group-self-landing
  // exactly like the #2879 §4 leaky excusal), and ONLY when the PR's own
  // change-set declares a `standalone-devacuification-allow:` ceiling in its
  // issue-file frontmatter (change-set scoping proven in merge_group by the
  // #3596 trap-growth-allow). See DEVACUIFICATION_ALLOW_KEY for the full
  // contract; the js-host gates never set the flag and are byte-unchanged.
  let devacExcusedFiles = new Set<string>();
  let devacTrapExcludedFiles = new Set<string>();
  let devacFailures: string[] = [];
  let devacAllowance: RegressionsAllowance | null = null;
  if (excludeLeakyBaseline) {
    const loadedDevac = await readChangeScopedNumericAllowance({
      key: DEVACUIFICATION_ALLOW_KEY,
      label: "standalone-devacuification-allow (#3592)",
      overrideEnv: "STANDALONE_DEVACUIFICATION_ALLOW_FILE",
    });
    for (const note of loadedDevac.notes) console.log(note);
    devacAllowance = loadedDevac.allowance;
    if (devacAllowance) {
      const devacResult = evaluateDevacuificationAllowance({
        allowance: devacAllowance,
        candidates: regressions.filter(
          (r) =>
            !r.hostQuarantined &&
            r.to !== "compile_timeout" &&
            !r.wasmUnchanged &&
            !isStaleAsyncArgsFlake(r) &&
            !isExcusedLeakyToHostFree(r) &&
            !isExcusedVacuous(r),
        ),
      });
      devacExcusedFiles = devacResult.excusedFiles;
      devacTrapExcludedFiles = devacResult.trapExcludedFiles;
      devacFailures = devacResult.failures;
      for (const note of devacResult.notes) console.log(note);
    }
  }
  const noiseFilteredBase = regressions.filter(
    (r) =>
      !r.hostQuarantined &&
      !r.wasmUnchanged &&
      r.to !== "compile_timeout" &&
      !isStaleAsyncArgsFlake(r) &&
      !isExcusedLeakyToHostFree(r) &&
      !isExcusedVacuous(r) &&
      !devacExcusedFiles.has(r.file),
  );

  // (#3649) Read `regressions-allow` ONCE, here, for BOTH modes. It used to be
  // read lazily inside the rebase branch only, which made it inert on an
  // ordinary PR — a well-formed declaration that no gate consulted. The
  // declaration's SHAPE now selects the contract:
  //   • `tests:` present → verified here and honoured in either mode, by
  //     excusing exactly the named files from the regression set the
  //     net/ratio/bucket gates see (mirroring how `devacExcusedFiles` works).
  //   • bare `count:`    → untouched #3303 semantics; consumed by
  //     `evaluateRebaseGate` in rebase mode and inert elsewhere, as before.
  // The exclusion is applied only OUTSIDE rebase mode: in rebase mode the bare
  // ceiling already supersedes the drift/concentration checks, and excusing the
  // files as well would apply the same leniency twice.
  const { allowance: regressionsAllowance, notes: regressionsAllowanceNotes } = await readRegressionsAllowance();
  for (const note of regressionsAllowanceNotes) console.log(note);
  const namedRegressionsAllowance = (regressionsAllowance?.tests ?? []).length > 0;
  let regressionsAllowExcused = new Set<string>();
  const regressionsAllowFailures: string[] = [];
  if (regressionsAllowance && namedRegressionsAllowance && !rebaseMode) {
    const verdict = evaluateNamedRegressionsAllowance({
      allowance: regressionsAllowance,
      regressedFiles: noiseFilteredBase.map((r) => r.file),
    });
    for (const note of verdict.notes) console.log(note);
    regressionsAllowFailures.push(...verdict.failures);
    regressionsAllowExcused = verdict.excused;
  } else if (regressionsAllowance && !namedRegressionsAllowance && !rebaseMode) {
    // Say so out loud. Silence here is exactly what made the old behaviour
    // unreadable: the gate would fail and the author could not tell whether the
    // ceiling was too small or the declaration was never consulted at all.
    console.log(
      `=== regressions-allow: declaration found (count ${regressionsAllowance.count}, declared in ` +
        `${regressionsAllowance.sources.join(", ")}) but it is INERT on this ordinary PR — a bare count is only ` +
        `honoured across an oracle re-baseline (#3303). Add a nested \`tests:\` list naming the regressions to ` +
        `make the claim machine-checkable and have it honoured here (#3649). ===`,
    );
  }

  const noiseFiltered = noiseFilteredBase.filter((r) => !regressionsAllowExcused.has(r.file));
  const regressionsWasmChange = noiseFiltered.length;
  const wasmIdenticalNoise = regressions.filter((r) => r.wasmUnchanged && r.to !== "compile_timeout").length;
  console.log(`=== Wasm-identical noise (pass → other, same wasm_sha): ${wasmIdenticalNoise} ===`);
  if (hostNoiseQuarantine) {
    console.log(
      `=== Host canary-quarantined pass regressions excluded from fine gate: ${regressions.filter((r) => r.hostQuarantined).length} ===`,
    );
  }
  if (excludeLeakyBaseline) {
    console.log(`=== Excused leaky→host-free regressions (#2879 §4, standalone): ${excusedLeakyToHostFree} ===`);
  }
  // Loud, grep-able tally of the TEMPORARY DEFAULT-ON #2940 excusal (removal
  // follow-up #3001). Always printed. Non-zero ⇒ the stale-baseline vacuity
  // delta is being bridged; zero ⇒ the excusal is inert (baseline already
  // new-policy) and it should be removed. See isVacuousReclassification.
  console.log(
    `=== Excused vacuous reclassifications (#2940 TEMPORARY default-on — remove after standalone baseline promotes to new-policy; see #3001): ${excusedVacuous} ===`,
  );
  if (devacAllowance) {
    console.log(
      `=== Excused de-vacuification reclassifications (#3592 standalone-devacuification-allow, ceiling ${devacAllowance.count}): ${devacExcusedFiles.size} ===`,
    );
  }
  console.log(`=== Regressions with wasm-hash change: ${regressionsWasmChange} ===`);
  console.log();

  // Improvements
  console.log(`=== Improvements (other → pass): ${stableImprovements.length} ===`);
  if (hostNoiseQuarantine) {
    console.log(`=== Raw host improvements before canary quarantine: ${improvements.length} ===`);
    console.log(
      `=== Host canary-quarantined improvements excluded from fine gate: ${improvements.length - stableImprovements.length} ===`,
    );
  }
  if (!quiet && stableImprovements.length > 0) {
    const shown = stableImprovements.slice(0, maxShow);
    for (const imp of shown) {
      console.log(`  ${imp.file}: ${imp.from} → pass`);
    }
    if (stableImprovements.length > maxShow) {
      console.log(`  ... and ${stableImprovements.length - maxShow} more`);
    }
  }
  console.log();

  // Other transitions
  if (otherChanges.length > 0) {
    console.log(`=== Other transitions: ${otherChanges.length} ===`);
    if (!quiet) {
      // Group by transition type
      const groups = new Map<string, string[]>();
      for (const c of otherChanges) {
        const key = `${c.from} → ${c.to}`;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(c.file);
      }
      for (const [transition, files] of groups) {
        console.log(`  ${transition}: ${files.length} tests`);
        const shown = files.slice(0, Math.min(5, maxShow));
        for (const f of shown) {
          console.log(`    ${f}`);
        }
        if (files.length > shown.length) {
          console.log(`    ... and ${files.length - shown.length} more`);
        }
      }
    }
    console.log();
  }

  // Regression error categories
  if (regressions.length > 0) {
    const errCats = new Map<string, number>();
    for (const r of regressions) {
      const cat = r.error_category || r.to;
      errCats.set(cat, (errCats.get(cat) || 0) + 1);
    }
    console.log("=== Regression error categories ===");
    const sorted = [...errCats.entries()].sort((a, b) => b[1] - a[1]);
    for (const [cat, count] of sorted) {
      console.log(`  ${cat}: ${count}`);
    }
    console.log();
  }

  // #2098: stable bucket-signature hash. Encodes the triage rule from
  // feedback_baseline_drift_cross_check: "identical regression clusters across
  // unrelated PRs are baseline drift, not real regressions." The signature is
  // a sha256 over the SORTED set of regressing test paths plus their
  // destination status — it is independent of the PR, the run order, and the
  // counts, so two PRs that regress the exact same cluster emit the SAME hash.
  // An agent (or a future cross-PR drift detector) can compare the hash across
  // open PRs: a match means the cluster is pre-existing drift to triage once,
  // not N independent regressions. compile_timeout flake is excluded so a
  // single flapping test can't perturb the signature. Output-only — no gate
  // behaviour change.
  const signatureFiles = regressions
    .filter((r) => r.to !== "compile_timeout")
    .map((r) => `${r.file} ${r.to}`)
    .sort();
  if (signatureFiles.length > 0) {
    const bucketSignature = createHash("sha256").update(signatureFiles.join("\n")).digest("hex").slice(0, 16);
    console.log(`=== Regression bucket signature: ${bucketSignature} (${signatureFiles.length} non-CT files) ===`);
    console.log(
      `  (Same signature on another PR ⇒ identical cluster ⇒ likely baseline drift — see feedback_baseline_drift_cross_check.)`,
    );
    console.log();
  }

  // Net delta
  const basePass = baselineCounts["pass"] || 0;
  const newPass = newCounts["pass"] || 0;
  const delta = newPass - basePass;
  const sign = delta >= 0 ? "+" : "";
  console.log(`=== Net: ${sign}${delta} pass (${basePass} → ${newPass}) ===`);
  if (hostNoiseQuarantine) {
    const stableNet = stableImprovements.length - regressionsWasmChange;
    console.log(
      `=== Host stable-path fine-gate net: ${stableNet >= 0 ? "+" : ""}${stableNet} ` +
        `(${stableImprovements.length} improvements − ${regressionsWasmChange} regressions) ===`,
    );
  }
  console.log();

  // Stale baseline warning — emit a PR-comment-friendly line if the
  // committed baseline is older than 6h. See #1079.
  if (baselineMetaPath) {
    const meta = readBaselineMeta(baselineMetaPath);
    if (meta?.generatedAt) {
      const generated = new Date(meta.generatedAt);
      if (!Number.isNaN(generated.getTime())) {
        const ageMs = Date.now() - generated.getTime();
        const ageText = formatAge(ageMs);
        const shortSha = meta.sha ? meta.sha.slice(0, 7) : "unknown";
        if (ageMs >= 6 * 3600 * 1000) {
          console.log(
            `⚠️  baseline is ${ageText} old (commit ${shortSha}) — consider force-refresh via workflow_dispatch before trusting these numbers`,
          );
        } else {
          console.log(`baseline age: ${ageText} (commit ${shortSha})`);
        }
        console.log();
      }
    }
  }

  // Exit code: non-zero when the change is a net negative using wasm-hash-filtered regressions.
  // Compile_timeout flaps (timing noise) and wasm-identical flips are excluded via
  // regressionsWasmChange. Gate: improvements.length - regressionsWasmChange < 0.
  const netPerTest = stableImprovements.length - regressionsWasmChange;
  let gateFailed = false;

  // #3592 — a de-vacuification ceiling breach is a hard gate failure (the
  // declaration is a ceiling, not a blank check); nothing was excused above.
  for (const reason of devacFailures) {
    console.log(`=== GATE FAIL: ${reason} ===`);
    gateFailed = true;
  }

  // (#3649) A named `regressions-allow` that did not verify is a hard failure —
  // the declaration excused nothing (its `excused` set is empty on failure), so
  // the regressions it named still count AND the dishonest claim is reported.
  for (const reason of regressionsAllowFailures) {
    console.log(`=== GATE FAIL: ${reason} ===`);
    gateFailed = true;
  }

  // #3189 — uncatchable-trap GROWTH ratchet. A regressions-allow declaration
  // never affects this ratchet. #3370 adds a separate, change-scoped
  // trap-growth-allow ceiling for an oracle bump whose literal harness changes
  // the compiled workload. It is read only in rebase mode, remains inert for
  // same-oracle changes, and is bounded per category like the existing
  // operational tolerance.
  // #3596 — the allowance is now read in BOTH modes. In rebase mode it behaves
  // exactly as #3370 defined it (the oracle bump is itself the containment). On
  // an ORDINARY same-oracle PR it is honoured only if the declaration NAMES the
  // reclassified tests and every claim machine-checks against the baseline —
  // see `evaluateTrapReclassification`. That keeps the strict ratchet for real
  // regressions (pass → trap) while unblocking a genuine flavour change
  // (fail → fail), which previously had no valve short of the repo-wide
  // TRAP_RATCHET_TOLERANCE variable.
  const trapTolerance = Number.parseInt(process.env.TRAP_RATCHET_TOLERANCE ?? "0", 10) || 0;
  const loadedTrapAllowance = await readChangeScopedNumericAllowance({
    key: TRAP_GROWTH_ALLOW_KEY,
    label: rebaseMode ? "trap-growth-allow (#3370)" : "trap-growth-allow (#3596)",
    overrideEnv: "TRAP_GROWTH_ALLOW_FILE",
  });
  const trapAllowance: RegressionsAllowance | null = loadedTrapAllowance.allowance;
  for (const note of loadedTrapAllowance.notes) console.log(note);
  const effectiveTrapTolerance = Math.max(trapTolerance, trapAllowance?.count ?? 0);
  const trapGrowth = evaluateTrapCategoryGrowth(baseline, newer, effectiveTrapTolerance, {
    // CI compares artifacts for the same pinned Test262 corpus. A missing
    // baseline row is therefore an incomplete predecessor observation, not a
    // newly-added test whose first observed result should ratchet.
    missingBaselineRowsAreUnknown: true,
    // #3592 — verified unmasked pre-existing traps under a declared
    // de-vacuification allowance (empty set unless the standalone lane's
    // change-set declared one; dispatcher-innermost traps are never in here).
    excludeFiles: devacTrapExcludedFiles,
  });
  if (devacTrapExcludedFiles.size > 0) {
    console.log(
      `=== Trap rows excluded from the #3189 ratchet as #3592 unmasked pre-existing traps (baseline-pass, non-dispatcher innermost frame): ${devacTrapExcludedFiles.size} ===`,
    );
  }
  console.log(
    `=== Trap categories (baseline → candidate): ` +
      TRAP_ERROR_CATEGORIES.map((c) => `${c} ${trapGrowth.baseCounts[c]}→${trapGrowth.newCounts[c]}`).join(", ") +
      ` (#3189 ratchet) ===`,
  );
  const trapBaselineUnknowns = TRAP_ERROR_CATEGORIES.flatMap((category) => [
    // (#4141) Report the file's ACTUAL baseline status, not a hardcoded
    // "compile_timeout". The bucket has covered `compile_error` since #3595 and
    // `skip` since #4141, so the fixed label was already wrong and actively
    // misleading: it tells a triager the predecessor timed out when it in fact
    // never ran at all. The baseline status is the single field that selects
    // which mechanism is in play, so print the real one.
    ...trapGrowth.unknownBaselineTimeouts[category].map((file) => ({
      category,
      file,
      baseline: baseline.get(file)?.status ?? "compile_timeout",
    })),
    ...trapGrowth.unknownBaselineMissingRows[category].map((file) => ({ category, file, baseline: "absent" })),
  ]);
  if (trapBaselineUnknowns.length > 0) {
    const byStatus = new Map<string, number>();
    for (const u of trapBaselineUnknowns) byStatus.set(u.baseline, (byStatus.get(u.baseline) ?? 0) + 1);
    console.log(
      `=== Trap baseline unknowns (baseline never observed runtime → trap; excluded from #3189): ` +
        `${trapBaselineUnknowns.length} (` +
        [...byStatus.entries()]
          .sort()
          .map(([s, n]) => `${s} ${n}`)
          .join(", ") +
        `) ===`,
    );
    // Cap the per-file listing. A producer-side asymmetry can push this bucket
    // into the thousands (#4141 put ~1,200 laundered Temporal rows in it), and
    // a 1,200-line dump buries the summary line that actually names the cause.
    const UNKNOWN_LIST_CAP = 50;
    for (const { category, file, baseline: baselineStatus } of trapBaselineUnknowns.slice(0, UNKNOWN_LIST_CAP)) {
      console.log(`  ${category}: ${file} (baseline ${baselineStatus})`);
    }
    if (trapBaselineUnknowns.length > UNKNOWN_LIST_CAP) {
      console.log(
        `  … and ${trapBaselineUnknowns.length - UNKNOWN_LIST_CAP} more (listing capped at ${UNKNOWN_LIST_CAP}).`,
      );
    }
  }
  for (const reason of trapGrowth.failures) {
    console.log(`=== GATE FAIL: ${reason} ===`);
    gateFailed = true;
  }
  if (trapAllowance && trapGrowth.failures.length === 0) {
    const maxGrowth = Math.max(
      0,
      ...TRAP_ERROR_CATEGORIES.map((c) => trapGrowth.newCounts[c] - trapGrowth.baseCounts[c]),
    );
    // #3596 — the DECLARATION'S OWN SHAPE selects the contract, not the run mode.
    // This matters because mode is incidental: whether a given PR happens to run
    // during an oracle re-baseline is not something the declaration's author can
    // predict, and it would be a trap for the same frontmatter to receive weaker
    // enforcement purely because of when it ran.
    //
    //   • `tests:` PRESENT → verify it, in BOTH modes. The author opted into the
    //     stronger contract, so it is enforced regardless of mode. Strictly a
    //     tightening: verification can only ever refuse a declaration, never
    //     admit one the ceiling alone would have rejected.
    //   • `tests:` ABSENT → #3370 semantics, unchanged. A bare bounded count
    //     remains valid in rebase mode (existing declarations keep working and
    //     cannot start hard-failing mid-re-baseline) and is still refused
    //     outside one, as uncheckable.
    //
    // Either way the check only runs when the allowance actually did some work
    // (growth > 0) — a declaration that excused nothing needs no proof.
    const declaredTests = trapAllowance.tests ?? [];
    const checkedContract = declaredTests.length > 0 || !rebaseMode;
    if (checkedContract && maxGrowth > 0) {
      const recheck = evaluateTrapReclassification({
        allowance: trapAllowance,
        baseline,
        growth: trapGrowth,
      });
      for (const note of recheck.notes) console.log(note);
      for (const reason of recheck.failures) {
        console.log(`=== GATE FAIL: ${reason} ===`);
        gateFailed = true;
      }
    }
    console.log(
      `=== ${checkedContract ? "trap-growth-allow (#3596)" : "trap-growth-allow (#3370)"}: maximum category growth ${maxGrowth} within declared per-category ceiling ${trapAllowance.count} — ` +
        `reason: ${trapAllowance.reason} (declared in ${trapAllowance.sources.join(", ")}). ===`,
    );
  }

  // #3086 — is this a deliberate oracle RE-BASELINE? (forward-monotonic bump
  // auto-rebase, or ORACLE_REBASE=1). Same condition the oracle guard above used
  // to PROCEED across versions; both `baseOracle`/`newOracle` are in scope here.
  if (rebaseMode) {
    // A pure re-baseline has ~0 improvements → net/ratio are inapplicable (see
    // ORACLE_REBASE_DRIFT_TOLERANCE). The intended reclassification is already
    // excused from regressionsWasmChange; the residual is main drift — gated on
    // a bounded drift tolerance + the per-bucket concentration check — UNLESS
    // the PR declares a #3303 `regressions-allow:` ceiling in its own issue
    // file (an honest reclassification larger than drift, e.g. #3285/#3286),
    // which supersedes both checks up to the declared count and hard-fails
    // above it. Since #3303 the #1668/#1897 workflow guards treat this exit code
    // as authoritative when it passes, so this branch IS the rebase verdict.
    //
    // (#3649) The allowance is now read ONCE, before the mode split, rather than
    // lazily here. Rebase-mode behaviour is byte-for-byte unchanged — the same
    // allowance object reaches `evaluateRebaseGate`, with the same ceiling logic
    // — but it is no longer true that "an ordinary same-oracle run never
    // consults it". THAT was the bug: it made a well-formed declaration silently
    // inert on every normal PR, and indistinguishable from a ceiling that was
    // simply too small.
    const rebaseGate = evaluateRebaseGate({
      regressionsWasmChange,
      regressedFiles: noiseFiltered.map((r) => r.file),
      allowance: regressionsAllowance,
    });
    for (const reason of rebaseGate.failures) {
      console.log(`=== GATE FAIL: ${reason} ===`);
      gateFailed = true;
    }
    if (rebaseGate.failures.length === 0) {
      for (const note of rebaseGate.notes) console.log(note);
    }
  } else {
    if (netPerTest < 0) {
      console.log(
        `=== GATE FAIL: net_per_test ${netPerTest} < 0 (${stableImprovements.length} improvements − ${regressionsWasmChange} regressions) ===`,
      );
      gateFailed = true;
    }

    // #1943 — enforce the documented ratio (10%) and per-bucket (50) thresholds
    // that previously lived only in the dev-self-merge skill text. Same
    // wasm-hash-filtered count the net gate uses (`noiseFiltered`), so
    // compile_timeout flaps and byte-identical flips never trip these either.
    // #3457 — the ratio arm is now NET-AWARE: a ratio breach on a net-positive
    // / net-neutral diff (or below the small-sample floor) is reported as a
    // WARNING, not a hard fail. The per-bucket concentration check stays a hard
    // fail. See evaluateRegressionThresholds.
    const thresholdResult = evaluateRegressionThresholds({
      improvements: stableImprovements.length,
      regressionsWasmChange,
      regressedFiles: noiseFiltered.map((r) => r.file),
    });
    for (const reason of thresholdResult.failures) {
      console.log(`=== GATE FAIL: ${reason} ===`);
      gateFailed = true;
    }
    for (const warning of thresholdResult.warnings) {
      console.log(`=== GATE WARN (#3457): ${warning} ===`);
    }
  }

  if (gateFailed) {
    process.exit(1);
  }
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

// Only run the CLI when invoked directly (not when imported by the unit test
// for the exported threshold helpers — #1943). `process.argv[1]` is the
// executed script path under tsx/node.
const invokedPath = process.argv[1] ?? "";
if (invokedPath.endsWith("diff-test262.ts") || invokedPath.endsWith("diff-test262.js")) {
  main();
}
