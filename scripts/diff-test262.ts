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

// #1943 — single source of truth for the documented merge thresholds, so the
// CI regression-gate ENFORCES the same numbers the dev-self-merge skill
// documents (previously the hard gate was only `net_per_test >= 0`; the 10%
// ratio and 50-per-bucket limits lived solely in skill text an agent could
// skip). `.claude/skills/dev-self-merge.md` references these constants.
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
export const TRAP_GROWTH_ALLOW_KEY = "trap-growth-allow";

export interface RegressionsAllowance {
  /** Declared ceiling on non-excused wasm-change regressions. */
  count: number;
  /** Required human-readable justification (self-documenting in review). */
  reason: string;
  /** Issue file(s) in the PR's diff that declared the allowance. */
  sources: string[];
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
    let parsed: { count: number; reason: string } | null | undefined;
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
    allowance: { count: best.count, reason: best.reason, sources: declarations.map((d) => d.source) },
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

/**
 * Evaluate the documented merge thresholds against the wasm-hash-filtered
 * counts. Returns the list of human-readable failure reasons (empty ⇒ pass).
 * Pure (no I/O) so the unit test can drive it directly with fixture data
 * (#1943 acceptance criteria). The ratio gate only fires when there is at
 * least one regression — a clean PR (R == 0) always passes regardless of how
 * few improvements it carries.
 */
export function evaluateRegressionThresholds(opts: {
  improvements: number;
  regressionsWasmChange: number;
  regressedFiles: string[];
}): string[] {
  const failures: string[] = [];
  const { improvements, regressionsWasmChange, regressedFiles } = opts;
  if (regressionsWasmChange > 0) {
    const ratio = improvements > 0 ? regressionsWasmChange / improvements : Infinity;
    if (ratio >= REGRESSION_RATIO_LIMIT) {
      const pct = improvements > 0 ? (ratio * 100).toFixed(1) + "%" : "∞ (0 improvements)";
      failures.push(
        `regression ratio ${pct} (${regressionsWasmChange}/${improvements}) meets/exceeds the ${(REGRESSION_RATIO_LIMIT * 100).toFixed(0)}% limit`,
      );
    }
  }
  for (const { bucket, count } of bucketRegressions(regressedFiles)) {
    if (count > REGRESSION_BUCKET_LIMIT) {
      failures.push(`bucket "${bucket}" has ${count} regressions, exceeds the ${REGRESSION_BUCKET_LIMIT}-test limit`);
    }
  }
  return failures;
}

/** Minimal row shape the trap ratchet needs (a subset of `TestResult`). */
type TrapRatchetRow = { status: string; error_category?: string; wasm_sha?: string | null };

export interface TrapCategoryGrowth {
  /** Human-readable GATE-FAIL reasons (empty ⇒ within ratchet). */
  failures: string[];
  /** baseline population per trap category. */
  baseCounts: Record<TrapCategory, number>;
  /** candidate population per trap category (noise-filtered). */
  newCounts: Record<TrapCategory, number>;
  /** files that newly entered each trap category (weren't trapping there in baseline). */
  newlyTrapping: Record<TrapCategory, string[]>;
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
 * Noise discipline: a trap category is a STATIC miscompile signal — a
 * byte-identical binary (same `wasm_sha`) cannot newly trap — so a candidate row
 * whose wasm hash is unchanged from a baseline row of the same file is excluded
 * as CI runner noise, exactly like the `net_per_test` gate's `wasmUnchanged`
 * filter (#1222). This prevents a flaky pass→trap flip on an identical binary
 * from tripping the ratchet.
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
): TrapCategoryGrowth {
  const zero = () => Object.fromEntries(TRAP_ERROR_CATEGORIES.map((c) => [c, 0])) as Record<TrapCategory, number>;
  const baseCounts = zero();
  const newCounts = zero();
  const newlyTrapping = Object.fromEntries(TRAP_ERROR_CATEGORIES.map((c) => [c, [] as string[]])) as Record<
    TrapCategory,
    string[]
  >;

  const isTrap = (cat: string | undefined): cat is TrapCategory =>
    !!cat && (TRAP_ERROR_CATEGORIES as readonly string[]).includes(cat);

  for (const row of baseline.values()) {
    if (isTrap(row.error_category)) baseCounts[row.error_category]++;
  }

  for (const [file, row] of newer) {
    if (!isTrap(row.error_category)) continue;
    const base = baseline.get(file);
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
      const sample = newlyTrapping[cat].slice().sort().slice(0, 10);
      const more =
        newlyTrapping[cat].length > sample.length ? ` (+${newlyTrapping[cat].length - sample.length} more)` : "";
      failures.push(
        `trap category "${cat}" grew ${baseCounts[cat]} → ${newCounts[cat]} (+${grew}) — uncatchable-trap ratchet (#3189). ` +
          `Newly trapping: ${sample.join(", ")}${more}`,
      );
    }
  }
  return { failures, baseCounts, newCounts, newlyTrapping };
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

type StatusMap = Map<string, TestResult>;

interface LoadedJsonl {
  map: StatusMap;
  /**
   * The oracle_version observed in the file. `undefined` if no row carried
   * one (a pre-#2096 file). `"mixed"` if rows disagreed — a file assembled
   * from shards run under different oracles, which must never be compared.
   */
  oracleVersion: number | "mixed" | undefined;
}

async function loadJsonl(path: string): Promise<LoadedJsonl> {
  const map: StatusMap = new Map();
  let oracleVersion: number | "mixed" | undefined;
  const rl = createInterface({ input: createReadStream(path) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as TestResult;
      if (typeof entry.oracle_version === "number" && oracleVersion !== "mixed") {
        if (oracleVersion === undefined) oracleVersion = entry.oracle_version;
        else if (oracleVersion !== entry.oracle_version) oracleVersion = "mixed";
      }
      if (entry.file) {
        map.set(entry.file, entry);
      }
    } catch {
      // skip malformed lines
    }
  }
  return { map, oracleVersion };
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
  --exclude-leaky-baseline-regressions
                                (#2879 §4, standalone lane) Excuse pass→fail flips where the baseline
                                was a LEAKY pass (leaned on a host env:: import) and the new row is
                                host-free — a carrier migration removing a host dep, not a regression.
  --help, -h                    Show this help

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

  if (pathFilter.length > 0) {
    const before = baseline.size;
    baseline = applyPathFilter(baseline, pathFilter);
    newer = applyPathFilter(newer, pathFilter);
    console.log(
      `Path filter active (${pathFilter.join(" | ")}): baseline ${before} → ${baseline.size} entries in scope.`,
    );
  }

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
  }[] = [];
  const improvements: { file: string; from: string; to: string }[] = [];
  const otherChanges: { file: string; from: string; to: string }[] = [];

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
      });
    } else if (baseStatus !== "pass" && curStatus === "pass") {
      improvements.push({ file, from: baseStatus, to: curStatus });
    } else {
      otherChanges.push({ file, from: baseStatus, to: curStatus });
    }
  }

  // Sort by file path for deterministic output
  regressions.sort((a, b) => a.file.localeCompare(b.file));
  improvements.sort((a, b) => a.file.localeCompare(b.file));
  otherChanges.sort((a, b) => a.file.localeCompare(b.file));

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

  // #1192: split regressions by destination status. compile_timeout
  // transitions are runner-load timing noise (tests near the 30s
  // compile-timeout boundary flap based on CI system load), not real
  // compiler regressions. Emit separate counts so the merge gate can
  // exclude CT noise from the ratio. The "Regressions (pass → other)"
  // line above stays unchanged for backwards compat with the dashboard.
  const regressionsCT = regressions.filter((r) => r.to === "compile_timeout").length;
  const regressionsReal = regressions.length - regressionsCT;
  // #3370 — compile-time signals compare the cost of compiling the same
  // workload. A deliberate oracle rebaseline changes the assembled harness,
  // so old-oracle pass→timeout transitions are not compile regressions. Keep
  // the measured count visible, but reset the canonical gated signal consumed
  // by the #1942 workflow guard. Same-oracle comparisons are unchanged.
  const gatedRegressionsCT = rebaseMode ? 0 : regressionsCT;
  console.log(`=== Compile timeouts (pass → compile_timeout): ${gatedRegressionsCT} ===`);
  if (rebaseMode && regressionsCT > 0) {
    console.log(
      `=== Oracle re-baseline compile-time note (#3370): ${regressionsCT} raw pass→compile_timeout transition(s) are not comparable across oracle versions. ===`,
    );
  }
  console.log(`=== Regressions excluding compile_timeout: ${regressionsReal} ===`);

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
  const ctRegressions = regressions.filter((r) => r.to === "compile_timeout");
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
  for (const [file, base] of baseline) {
    const cur = newer.get(file);
    if (!cur) continue;
    if (typeof base.compile_ms !== "number" || typeof cur.compile_ms !== "number") continue;
    aggBaseMs += base.compile_ms;
    aggCurMs += cur.compile_ms;
    aggShared += 1;
  }
  const aggPct = aggBaseMs > 0 ? ((aggCurMs - aggBaseMs) / aggBaseMs) * 100 : 0;
  const gatedAggPct = rebaseMode ? 0 : aggPct;
  // Round to whole ms for the sums and one decimal for the percentage so the
  // workflow's `grep -oE '[0-9.-]+'` parses deterministically.
  console.log(
    `=== Aggregate compile time (shared ${aggShared} tests): baseline ${Math.round(aggBaseMs)}ms → current ${Math.round(aggCurMs)}ms (Δ ${gatedAggPct >= 0 ? "+" : ""}${gatedAggPct.toFixed(1)}%) ===`,
  );
  if (rebaseMode && aggPct !== 0) {
    console.log(
      `=== Oracle re-baseline compile-time note (#3370): raw aggregate delta ${aggPct >= 0 ? "+" : ""}${aggPct.toFixed(1)}%; the #1942 comparison resets because oracle ${fmtOracle(baseOracle)} → ${fmtOracle(newOracle)} changes the compiled harness workload. ===`,
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
    (r) => r.to !== "compile_timeout" && !r.wasmUnchanged && !isStaleAsyncArgsFlake(r) && isExcusedLeakyToHostFree(r),
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
      r.to !== "compile_timeout" &&
      !r.wasmUnchanged &&
      !isStaleAsyncArgsFlake(r) &&
      !isExcusedLeakyToHostFree(r) &&
      isExcusedVacuous(r),
  ).length;
  const noiseFiltered = regressions.filter(
    (r) =>
      !r.wasmUnchanged &&
      r.to !== "compile_timeout" &&
      !isStaleAsyncArgsFlake(r) &&
      !isExcusedLeakyToHostFree(r) &&
      !isExcusedVacuous(r),
  );
  const regressionsWasmChange = noiseFiltered.length;
  const wasmIdenticalNoise = regressions.filter((r) => r.wasmUnchanged && r.to !== "compile_timeout").length;
  console.log(`=== Wasm-identical noise (pass → other, same wasm_sha): ${wasmIdenticalNoise} ===`);
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
  console.log(`=== Regressions with wasm-hash change: ${regressionsWasmChange} ===`);
  console.log();

  // Improvements
  console.log(`=== Improvements (other → pass): ${improvements.length} ===`);
  if (!quiet && improvements.length > 0) {
    const shown = improvements.slice(0, maxShow);
    for (const imp of shown) {
      console.log(`  ${imp.file}: ${imp.from} → pass`);
    }
    if (improvements.length > maxShow) {
      console.log(`  ... and ${improvements.length - maxShow} more`);
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
  const netPerTest = improvements.length - regressionsWasmChange;
  let gateFailed = false;

  // #3189 — uncatchable-trap GROWTH ratchet. A regressions-allow declaration
  // never affects this ratchet. #3370 adds a separate, change-scoped
  // trap-growth-allow ceiling for an oracle bump whose literal harness changes
  // the compiled workload. It is read only in rebase mode, remains inert for
  // same-oracle changes, and is bounded per category like the existing
  // operational tolerance.
  const trapTolerance = Number.parseInt(process.env.TRAP_RATCHET_TOLERANCE ?? "0", 10) || 0;
  let trapAllowance: RegressionsAllowance | null = null;
  if (rebaseMode) {
    const loaded = await readChangeScopedNumericAllowance({
      key: TRAP_GROWTH_ALLOW_KEY,
      label: "trap-growth-allow (#3370)",
      overrideEnv: "TRAP_GROWTH_ALLOW_FILE",
    });
    trapAllowance = loaded.allowance;
    for (const note of loaded.notes) console.log(note);
  }
  const effectiveTrapTolerance = Math.max(trapTolerance, trapAllowance?.count ?? 0);
  const trapGrowth = evaluateTrapCategoryGrowth(baseline, newer, effectiveTrapTolerance);
  console.log(
    `=== Trap categories (baseline → candidate): ` +
      TRAP_ERROR_CATEGORIES.map((c) => `${c} ${trapGrowth.baseCounts[c]}→${trapGrowth.newCounts[c]}`).join(", ") +
      ` (#3189 ratchet) ===`,
  );
  for (const reason of trapGrowth.failures) {
    console.log(`=== GATE FAIL: ${reason} ===`);
    gateFailed = true;
  }
  if (trapAllowance && trapGrowth.failures.length === 0) {
    const maxGrowth = Math.max(
      0,
      ...TRAP_ERROR_CATEGORIES.map((c) => trapGrowth.newCounts[c] - trapGrowth.baseCounts[c]),
    );
    console.log(
      `=== trap-growth-allow (#3370): maximum category growth ${maxGrowth} within declared per-category ceiling ${trapAllowance.count} — ` +
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
    // above it. The allowance is read lazily HERE (rebase mode only) so an
    // ordinary same-oracle run never consults it — a declared allowance grants
    // nothing without the oracle bump that makes this a deliberate re-baseline.
    // Since #3303 the #1668/#1897 workflow guards treat this exit code as
    // authoritative when it passes, so this branch IS the rebase verdict.
    const { allowance, notes: allowanceNotes } = await readRegressionsAllowance();
    for (const note of allowanceNotes) console.log(note);
    const rebaseGate = evaluateRebaseGate({
      regressionsWasmChange,
      regressedFiles: noiseFiltered.map((r) => r.file),
      allowance,
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
        `=== GATE FAIL: net_per_test ${netPerTest} < 0 (${improvements.length} improvements − ${regressionsWasmChange} regressions) ===`,
      );
      gateFailed = true;
    }

    // #1943 — enforce the documented ratio (10%) and per-bucket (50) thresholds
    // that previously lived only in the dev-self-merge skill text. Same
    // wasm-hash-filtered count the net gate uses (`noiseFiltered`), so
    // compile_timeout flaps and byte-identical flips never trip these either.
    const thresholdFailures = evaluateRegressionThresholds({
      improvements: improvements.length,
      regressionsWasmChange,
      regressedFiles: noiseFiltered.map((r) => r.file),
    });
    for (const reason of thresholdFailures) {
      console.log(`=== GATE FAIL: ${reason} ===`);
      gateFailed = true;
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
