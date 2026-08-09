#!/usr/bin/env node
// #1659 — Equivalence-suite regression gate.
//
// Runs (a shard of) tests/equivalence/ under vitest with a single fork
// (low peak RAM — the historic OOM came from file-parallelism, not the
// workload), collects the set of failing tests, and compares it against a
// committed known-failures baseline (scripts/equivalence-baseline.json).
//
// Exit non-zero ONLY when a test that is NOT in the baseline fails (a genuine
// regression) — the existing failure backlog does not block every PR. Tests
// that are listed in the baseline but now PASS are reported as "newly fixed"
// so the baseline can be ratcheted down with --update.
//
// Usage:
//   node scripts/equivalence-gate.mjs                 # run full suite, gate
//   SHARD=1/8 node scripts/equivalence-gate.mjs       # run one shard, gate
//   node scripts/equivalence-gate.mjs --update        # rewrite baseline from a full run
//
// In CI each shard evaluates its own failures against the shared baseline.
// A tiny final status job only verifies that every matrix cell succeeded; it
// does not need to repeat checkout, dependency install, artifact upload, or
// artifact download just to re-run this set comparison.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts", "equivalence-baseline.json");

const args = process.argv.slice(2);
const UPDATE = args.includes("--update");
const SHARD = process.env.SHARD || ""; // e.g. "1/8"
// When merging shard partials instead of running vitest directly.
const MERGE_DIR = process.env.MERGE_PARTIALS_DIR || "";
// Equivalence shards can peak around 1 GB; regular vitest runs keep the
// repository default 512 MB fork heap unless they opt in through this env var.
const EQUIVALENCE_FORK_HEAP_MB = process.env.EQUIVALENCE_FORK_HEAP_MB || "1024";

/** Stable id for a test: "<relative file> :: <full test name>". */
function testId(fileRelPath, fullName) {
  return `${fileRelPath} :: ${fullName}`;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return { knownFailures: [] };
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

/** Run vitest on the equivalence suite (optionally a shard) and return failing test ids. */
function runVitest() {
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
  if (SHARD) vitestArgs.push(`--shard=${SHARD}`);

  const res = spawnSync(process.execPath, vitestArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      CI: "1",
      VITEST_FORK_MAX_OLD_SPACE_SIZE: process.env.VITEST_FORK_MAX_OLD_SPACE_SIZE || EQUIVALENCE_FORK_HEAP_MB,
    },
    maxBuffer: 256 * 1024 * 1024,
  });
  // vitest exits non-zero on test failures — that's expected; we parse the report.
  if (!existsSync(outFile)) {
    console.error("equivalence-gate: vitest produced no JSON report; signal=", res.signal);
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(outFile, "utf8"));
  const failing = new Set();
  const passing = new Set();
  for (const file of report.testResults || []) {
    const rel = file.name.replace(/^.*\/tests\/equivalence\//, "tests/equivalence/");
    for (const a of file.assertionResults || []) {
      const id = testId(rel, a.fullName || a.title);
      if (a.status === "failed") failing.add(id);
      else if (a.status === "passed") passing.add(id);
    }
  }
  return { failing, passing };
}

/** Merge per-shard partial JSON files ({failing:[], passing:[]}) into combined sets. */
function mergePartials(dir) {
  const failing = new Set();
  const passing = new Set();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const p = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const id of p.failing || []) failing.add(id);
    for (const id of p.passing || []) passing.add(id);
  }
  return { failing, passing };
}

const { failing, passing } = MERGE_DIR ? mergePartials(MERGE_DIR) : runVitest();

// A caller may still request a partial for diagnostics, but shard mode now
// continues into the same baseline gate as a full run. Regression membership
// is independent per test, so merging all shard sets first cannot change the
// pass/fail verdict.
if (SHARD && !MERGE_DIR && !UPDATE) {
  const partialPath = process.env.PARTIAL_OUT;
  if (partialPath) {
    writeFileSync(partialPath, JSON.stringify({ failing: [...failing], passing: [...passing] }, null, 2));
    console.log(`equivalence-gate: wrote partial ${partialPath} (${failing.size} fail / ${passing.size} pass)`);
  }
}

if (UPDATE) {
  const knownFailures = [...failing].sort();
  writeFileSync(BASELINE_PATH, JSON.stringify({ knownFailures }, null, 2) + "\n");
  console.log(`equivalence-gate: baseline updated — ${knownFailures.length} known failures recorded.`);
  process.exit(0);
}

// Gate: compare against baseline.
const baseline = loadBaseline();
const known = new Set(baseline.knownFailures || []);

const regressions = [...failing].filter((id) => !known.has(id)).sort();
const newlyFixed = [...known].filter((id) => passing.has(id)).sort();

console.log(
  `equivalence-gate: ${failing.size} failing, ${passing.size} passing, ${known.size} known-failures in baseline.`,
);

if (newlyFixed.length) {
  console.log(
    `\n✓ ${newlyFixed.length} baseline failure(s) now PASS — ratchet the baseline with: node scripts/equivalence-gate.mjs --update`,
  );
  for (const id of newlyFixed) console.log(`    fixed: ${id}`);
}

if (regressions.length) {
  console.error(`\n✗ ${regressions.length} NEW equivalence regression(s) (not in baseline):`);
  for (const id of regressions) console.error(`    REGRESSION: ${id}`);
  console.error(
    `\nA genuine equivalence regression was detected. Fix the codegen, or — if intentional — update the baseline.`,
  );
  process.exit(1);
}

console.log("\n✓ No new equivalence regressions.");
process.exit(0);
