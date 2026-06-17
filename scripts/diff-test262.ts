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
  --path-filter <patterns>      Restrict the diff to tests whose path contains any of the
                                pipe-separated substrings (same semantics as TEST262_PATH_FILTER).
                                Used by #1954 scoped PR-time runs: the candidate JSONL only covers
                                the scoped subset, so the baseline must be restricted the same way
                                or every out-of-scope baseline pass counts as a pass→absent regression.
  --help, -h                    Show this help`);
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

  const maxShow = showAll ? Infinity : verbose ? 50 : 20;

  run(baselinePath, newPath, maxShow, quiet, baselineMetaPath, pathFilter);
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
  const oracleRebase = process.env.ORACLE_REBASE === "1";
  const baseOracle = baselineLoaded.oracleVersion;
  const newOracle = newerLoaded.oracleVersion;
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
    if (!oracleRebase) {
      console.error(
        `\n✖ Oracle-version guard (#2096): cross-version diff refused.\n` +
          `  baseline oracle = ${fmtOracle(baseOracle)}, new oracle = ${fmtOracle(newOracle)}.\n` +
          `  These rows were produced by different verdict logic, so the diff would read\n` +
          `  oracle skew as regressions. To intentionally re-seed the baseline at the new\n` +
          `  oracle version (e.g. the #1945 flip PR), re-run with ORACLE_REBASE=1.\n`,
      );
      process.exit(2);
    }
    console.log(
      `ORACLE_REBASE=1 — comparing across oracle versions ` +
        `(baseline ${fmtOracle(baseOracle)} → new ${fmtOracle(newOracle)}). ` +
        `Regression numbers below mix oracle skew with code changes; use only to re-seed.`,
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
  console.log(`=== Compile timeouts (pass → compile_timeout): ${regressionsCT} ===`);
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
  // Round to whole ms for the sums and one decimal for the percentage so the
  // workflow's `grep -oE '[0-9.-]+'` parses deterministically.
  console.log(
    `=== Aggregate compile time (shared ${aggShared} tests): baseline ${Math.round(aggBaseMs)}ms → current ${Math.round(aggCurMs)}ms (Δ ${aggPct >= 0 ? "+" : ""}${aggPct.toFixed(1)}%) ===`,
  );

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
  const noiseFiltered = regressions.filter(
    (r) => !r.wasmUnchanged && r.to !== "compile_timeout" && !isStaleAsyncArgsFlake(r),
  );
  const regressionsWasmChange = noiseFiltered.length;
  const wasmIdenticalNoise = regressions.filter((r) => r.wasmUnchanged && r.to !== "compile_timeout").length;
  console.log(`=== Wasm-identical noise (pass → other, same wasm_sha): ${wasmIdenticalNoise} ===`);
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
