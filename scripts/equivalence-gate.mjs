#!/usr/bin/env node
// #1659 — Equivalence-suite regression gate.
//
// Runs (a shard of) tests/equivalence/ under vitest with a single fork
// (low peak RAM — the historic OOM came from file-parallelism, not the
// workload), collects the set of failing tests, and compares it against a
// committed known-failures baseline (scripts/equivalence-baseline.json).
//
// Exit non-zero when a test that is NOT in the baseline fails (a genuine
// regression) — the existing failure backlog does not block every PR. Tests
// that are listed in the baseline but now PASS are reported as "newly fixed"
// so the baseline can be ratcheted down with --update.
//
// (#6785) A known-failure diff only sees failing ASSERTIONS. A test file that
// fails to import, has a syntax error, throws while collecting, crashes its
// worker, or is deleted contributes no assertion at all — so it used to read
// as "no new regressions". The gate therefore also fails on:
//
//   • a FILE-LEVEL failure — a file vitest marks failed with no tests
//     collected, with a file-level error message, with no failing test, or
//     with tests that never finished (named per file);
//   • a report that says `success: false` with no failing test or file to
//     explain it (unhandled error / crashed worker);
//   • a test file that exists on disk but is absent from the report;
//   • fewer passing tests than the committed `passingFloor`;
//   • fewer test files than the committed `fileCount`.
//
// The last two are WHOLE-SUITE properties. A shard sees only part of the
// suite, so a `SHARD=i/N` run scores the per-test and per-file checks only and
// writes a partial (`PARTIAL_OUT`); CI's `equivalence-gate` job merges the
// eight partials (`MERGE_PARTIALS_DIR`) and applies the floor and file count
// to the sum.
//
// `--update` rewrites `knownFailures` from a full run (direct, or merged from
// all shard partials) and RAISES `passingFloor` / `fileCount` to the run's
// numbers. It never lowers either one, and it refuses to bank a run that has
// a file-level failure or sits below a floor (same rule as the per-edition
// test262 ratchet). Deleting a test file or test deliberately is a hand edit
// of the two numbers in scripts/equivalence-baseline.json, justified in the
// PR's issue file.
//
// Usage:
//   node scripts/equivalence-gate.mjs                 # run full suite, gate
//   SHARD=1/8 node scripts/equivalence-gate.mjs       # run one shard, gate (no floor)
//   MERGE_PARTIALS_DIR=dir node scripts/equivalence-gate.mjs   # gate merged shard partials
//   node scripts/equivalence-gate.mjs --update        # rewrite baseline from a full run

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "equivalence-baseline.json");
const EQUIVALENCE_DIR = join(REPO_ROOT, "tests", "equivalence");
const REL_PREFIX = "tests/equivalence/";

/** Stable id for a test: "<relative file> :: <full test name>". */
function testId(fileRelPath, fullName) {
  return `${fileRelPath} :: ${fullName}`;
}

function relPath(name) {
  return name.replace(/^.*\/tests\/equivalence\//, REL_PREFIX);
}

/** A vitest error message on one line ("Transform failed with 1 error:" alone names no location). */
function oneLine(text) {
  const line = String(text)
    .trim()
    .replace(/\s*\n\s*/g, " ");
  return line.length > 240 ? `${line.slice(0, 240)}…` : line;
}

function emptySummary() {
  return { failing: new Set(), passing: new Set(), files: new Set(), fileFailures: [], unexplained: [], shards: [] };
}

/**
 * Reduce one vitest JSON report to what the gate scores: failing / passing
 * test ids, the files seen, and every failure that has no assertion to carry
 * it (`fileFailures`, `unexplained`). `toRel` maps vitest's absolute file name
 * to the repo-relative id (#6783: scripts/known-failures-gate.mjs scores
 * suites outside tests/equivalence/ with the same reduction).
 */
export function summarizeReport(report, label = "report", toRel = relPath) {
  const summary = emptySummary();
  for (const file of report.testResults || []) {
    const rel = toRel(file.name);
    summary.files.add(rel);
    const assertions = file.assertionResults || [];
    let failed = 0;
    let unfinished = 0;
    for (const a of assertions) {
      const id = testId(rel, a.fullName || a.title);
      if (a.status === "failed") {
        summary.failing.add(id);
        failed++;
      } else if (a.status === "passed") summary.passing.add(id);
      // vitest maps a test that was queued or still running when the report
      // was written to "pending" — the run ended underneath it.
      else if (a.status === "pending") unfinished++;
    }
    const message = file.message ? oneLine(file.message) : "";
    if (unfinished) {
      summary.fileFailures.push({ file: rel, reason: `${unfinished} test(s) never finished (worker crash or abort?)` });
    } else if (file.status === "failed") {
      if (assertions.length === 0) {
        summary.fileFailures.push({ file: rel, reason: `no tests collected${message ? `: ${message}` : ""}` });
      } else if (message) {
        summary.fileFailures.push({ file: rel, reason: `file-level error: ${message}` });
      } else if (failed === 0) {
        summary.fileFailures.push({ file: rel, reason: "file failed with no failing test (suite hook error?)" });
      }
    }
  }
  if (report.success === false && summary.failing.size === 0 && summary.fileFailures.length === 0) {
    summary.unexplained.push(
      `${label}: vitest reported success=false with no failing test or file (unhandled error or crashed worker)`,
    );
  }
  return summary;
}

/** Union several summaries (per-shard partials) into one. */
export function mergeSummaries(summaries) {
  const merged = emptySummary();
  for (const s of summaries) {
    for (const id of s.failing) merged.failing.add(id);
    for (const id of s.passing) merged.passing.add(id);
    for (const f of s.files) merged.files.add(f);
    merged.fileFailures.push(...s.fileFailures);
    merged.unexplained.push(...s.unexplained);
    merged.shards.push(...s.shards);
  }
  return merged;
}

/** Serialise a summary as a shard partial (the JSON `PARTIAL_OUT` holds). */
export function toPartial(summary, shard) {
  return {
    shard,
    failing: [...summary.failing].sort(),
    passing: [...summary.passing].sort(),
    files: [...summary.files].sort(),
    fileFailures: summary.fileFailures,
    unexplained: summary.unexplained,
  };
}

/** Inverse of `toPartial`. A legacy partial without `files` sees no files. */
export function fromPartial(partial) {
  return {
    failing: new Set(partial.failing || []),
    passing: new Set(partial.passing || []),
    files: new Set(partial.files || []),
    fileFailures: partial.fileFailures || [],
    unexplained: partial.unexplained || [],
    shards: partial.shard ? [partial.shard] : [],
  };
}

/** Every `i/N` slot missing from a set of shard labels (empty when complete). */
function missingShards(shards) {
  const totals = new Set(shards.map((s) => String(s).split("/")[1]));
  if (totals.size !== 1) return totals.size ? [`inconsistent shard totals: ${[...totals].join(", ")}`] : [];
  const total = Number([...totals][0]);
  const seen = new Set(shards.map((s) => String(s).split("/")[0]));
  const missing = [];
  for (let i = 1; i <= total; i++) if (!seen.has(String(i))) missing.push(`${i}/${total}`);
  return missing;
}

/**
 * Score a summary against the baseline. `partial: true` (a single shard)
 * skips the whole-suite checks. `diskFiles`, when given, names test files that
 * exist but never reached the report. `floors: false` (#6783) skips the
 * passingFloor / fileCount checks for a baseline that carries none.
 */
export function evaluateGate(summary, baseline, { partial = false, diskFiles = null, floors = true } = {}) {
  const known = new Set(baseline.knownFailures || []);
  const regressions = [...summary.failing].filter((id) => !known.has(id)).sort();
  const newlyFixed = [...known].filter((id) => summary.passing.has(id)).sort();
  const fileFailures = [...summary.fileFailures].sort((a, b) => a.file.localeCompare(b.file));
  const unexplained = [...summary.unexplained];
  const floorFailures = [];

  if (!partial) {
    for (const slot of missingShards(summary.shards)) unexplained.push(`no partial for shard ${slot}`);
    if (diskFiles) {
      for (const file of [...diskFiles].sort()) {
        if (!summary.files.has(file))
          fileFailures.push({ file, reason: "on disk but absent from the report (never run)" });
      }
    }
    const { passingFloor, fileCount } = baseline;
    if (!floors) {
      // (#6783) A known-failures baseline carries no floors; file presence is
      // checked against `diskFiles` above instead.
    } else if (!Number.isInteger(passingFloor) || !Number.isInteger(fileCount)) {
      floorFailures.push(
        "baseline has no passingFloor/fileCount — bank them with: node scripts/equivalence-gate.mjs --update",
      );
    } else {
      if (summary.passing.size < passingFloor) {
        floorFailures.push(
          `${summary.passing.size} passing tests < committed passingFloor ${passingFloor} (${passingFloor - summary.passing.size} fewer)`,
        );
      }
      if (summary.files.size < fileCount) {
        floorFailures.push(
          `${summary.files.size} test files in the report < committed fileCount ${fileCount} (${fileCount - summary.files.size} fewer — deleted, renamed away, or not run)`,
        );
      }
    }
  }

  const ok = !regressions.length && !fileFailures.length && !unexplained.length && !floorFailures.length;
  return { ok, known, regressions, newlyFixed, fileFailures, unexplained, floorFailures };
}

/**
 * The baseline an `--update` would write. Raises the floors, never lowers
 * them; `refusals` is non-empty when the run must not be banked at all.
 * `floors: false` (#6783) banks `knownFailures` alone.
 */
export function bankBaseline(summary, previous, { floors = true } = {}) {
  const refusals = [];
  if (summary.fileFailures.length || summary.unexplained.length) {
    refusals.push(
      `the run has ${summary.fileFailures.length + summary.unexplained.length} file-level/report failure(s) — fix them first; a broken run is not a measurement`,
    );
  }
  for (const slot of missingShards(summary.shards)) refusals.push(`no partial for shard ${slot}`);
  if (!floors) return { baseline: { knownFailures: [...summary.failing].sort() }, refusals };
  const oldFloor = Number.isInteger(previous.passingFloor) ? previous.passingFloor : 0;
  const oldFiles = Number.isInteger(previous.fileCount) ? previous.fileCount : 0;
  if (summary.passing.size < oldFloor) {
    refusals.push(`${summary.passing.size} passing < passingFloor ${oldFloor}; --update never lowers the floor`);
  }
  if (summary.files.size < oldFiles) {
    refusals.push(`${summary.files.size} files < fileCount ${oldFiles}; --update never lowers the file count`);
  }
  const baseline = {
    passingFloor: Math.max(oldFloor, summary.passing.size),
    fileCount: Math.max(oldFiles, summary.files.size),
    knownFailures: [...summary.failing].sort(),
  };
  return { baseline, refusals };
}

/** Every `*.test.ts` under tests/equivalence/, as repo-relative paths. */
function listEquivalenceFiles() {
  if (!existsSync(EQUIVALENCE_DIR)) return null;
  const out = [];
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}${entry.name}/`);
      else if (entry.name.endsWith(".test.ts")) out.push(`${rel}${entry.name}`);
    }
  };
  walk(EQUIVALENCE_DIR, REL_PREFIX);
  return out;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { knownFailures: [] };
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

/** Run vitest on the equivalence suite (optionally a shard) and summarise the report. */
function runVitest(shard) {
  // Equivalence shards can peak around 1 GB; regular vitest runs keep the
  // repository default fork heap unless they opt in through this env var.
  const forkHeapMb = process.env.EQUIVALENCE_FORK_HEAP_MB || "1024";
  const outFile = join(mkdtempSync(join(tmpdir(), "equiv-")), "report.json");
  const vitestArgs = [
    "node_modules/vitest/dist/cli.js",
    "run",
    "tests/equivalence/",
    "--pool=forks",
    "--poolOptions.forks.singleFork=true",
    "--no-file-parallelism",
    "--reporter=json",
    `--outputFile=${outFile}`,
  ];
  if (shard) vitestArgs.push(`--shard=${shard}`);

  const res = spawnSync(process.execPath, vitestArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      CI: "1",
      VITEST_FORK_MAX_OLD_SPACE_SIZE: process.env.VITEST_FORK_MAX_OLD_SPACE_SIZE || forkHeapMb,
    },
    maxBuffer: 256 * 1024 * 1024,
  });
  // vitest exits non-zero on test failures — that's expected; we parse the report.
  if (!existsSync(outFile)) {
    console.error("equivalence-gate: vitest produced no JSON report; signal=", res.signal);
    process.exit(2);
  }
  const summary = summarizeReport(JSON.parse(readFileSync(outFile, "utf8")), shard ? `shard ${shard}` : "vitest");
  if (shard) summary.shards.push(shard);
  return summary;
}

/** Merge per-shard partial JSON files into one summary. */
function mergePartials(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  if (!files.length) {
    console.error(`equivalence-gate: no partial *.json files in ${dir}`);
    process.exit(2);
  }
  return mergeSummaries(files.map((f) => fromPartial(JSON.parse(readFileSync(join(dir, f), "utf8")))));
}

function main(argv, env) {
  const update = argv.includes("--update");
  const shard = env.SHARD || ""; // e.g. "1/8"
  const mergeDir = env.MERGE_PARTIALS_DIR || "";
  // SHARD declares that the scored data covers only part of the suite — a
  // live shard run, or one shard's partial scored via MERGE_PARTIALS_DIR.
  const partial = Boolean(shard);

  if (update && partial) {
    console.error("equivalence-gate: --update refuses a SHARD run — a partial run is not a measurement of the suite.");
    return 2;
  }

  const summary = mergeDir ? mergePartials(mergeDir) : runVitest(shard);

  if (shard && !mergeDir && !update && env.PARTIAL_OUT) {
    writeFileSync(env.PARTIAL_OUT, JSON.stringify(toPartial(summary, shard), null, 2));
    console.log(
      `equivalence-gate: wrote partial ${env.PARTIAL_OUT} (${summary.failing.size} fail / ${summary.passing.size} pass / ${summary.files.size} files)`,
    );
  }

  if (update) {
    const previous = loadBaseline();
    const { baseline, refusals } = bankBaseline(summary, previous);
    if (refusals.length) {
      console.error("equivalence-gate: --update REFUSED, baseline unchanged:");
      for (const r of refusals) console.error(`    ${r}`);
      for (const f of summary.fileFailures) console.error(`    FILE FAILURE: ${f.file} — ${f.reason}`);
      for (const u of summary.unexplained) console.error(`    REPORT FAILURE: ${u}`);
      console.error(
        "Lowering passingFloor/fileCount for a deliberate deletion is a hand edit of scripts/equivalence-baseline.json, justified in the PR.",
      );
      return 1;
    }
    writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
    console.log(
      `equivalence-gate: baseline updated — ${baseline.knownFailures.length} known failures, passingFloor ${baseline.passingFloor}, fileCount ${baseline.fileCount}.`,
    );
    return 0;
  }

  const baseline = loadBaseline();
  const verdict = evaluateGate(summary, baseline, { partial, diskFiles: partial ? null : listEquivalenceFiles() });

  console.log(
    `equivalence-gate: ${summary.failing.size} failing, ${summary.passing.size} passing, ${verdict.known.size} known-failures in baseline.`,
  );
  if (partial) {
    console.log(
      `equivalence-gate: shard ${shard} — ${summary.files.size} files; passingFloor/fileCount are checked on the merged report (equivalence-gate job).`,
    );
  } else {
    console.log(
      `equivalence-gate: ${summary.files.size} files (fileCount ${baseline.fileCount ?? "unset"}), passingFloor ${baseline.passingFloor ?? "unset"}.`,
    );
  }

  if (verdict.newlyFixed.length) {
    console.log(
      `\n✓ ${verdict.newlyFixed.length} baseline failure(s) now PASS — ratchet the baseline with: node scripts/equivalence-gate.mjs --update`,
    );
    for (const id of verdict.newlyFixed) console.log(`    fixed: ${id}`);
  }

  if (verdict.fileFailures.length || verdict.unexplained.length) {
    console.error(
      `\n✗ ${verdict.fileFailures.length + verdict.unexplained.length} failure(s) outside any test assertion (invisible to the known-failure diff):`,
    );
    for (const f of verdict.fileFailures) console.error(`    FILE FAILURE: ${f.file} — ${f.reason}`);
    for (const u of verdict.unexplained) console.error(`    REPORT FAILURE: ${u}`);
  }

  if (verdict.floorFailures.length) {
    console.error(`\n✗ Below the committed floor:`);
    for (const f of verdict.floorFailures) console.error(`    FLOOR: ${f}`);
  }

  if (verdict.regressions.length) {
    console.error(`\n✗ ${verdict.regressions.length} NEW equivalence regression(s) (not in baseline):`);
    for (const id of verdict.regressions) console.error(`    REGRESSION: ${id}`);
    console.error(
      `\nA genuine equivalence regression was detected. Fix the codegen, or — if intentional — update the baseline.`,
    );
  }

  if (!verdict.ok) return 1;
  console.log("\n✓ No new equivalence regressions.");
  return 0;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) process.exit(main(process.argv.slice(2), process.env));
