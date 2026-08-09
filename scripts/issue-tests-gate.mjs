#!/usr/bin/env node
// #3008 — Root-test-suite (tests/*.test.ts) regression gate.
//
// The per-issue suites under tests/*.test.ts are the project's regression
// memory, but they were not wired into ANY CI job — a fixed issue could
// silently re-break on main (four separate silent main-regressions were found
// on 2026-07-16 alone: the #1284 ambient-shadow extern-class break, the
// JSON.stringify 3/9, #3307 accessor-merge casts, #3316 tagged-template CEs).
//
// Design (decision recorded in plan/issues/3008-*.md):
//   - The FULL root suite (~2,100 files, ~9 CPU-hours single-fork) is far too
//     slow to gate every PR. It runs POST-MERGE (push to main) + cron,
//     sharded, gating against a committed known-failures baseline — only NEW
//     failures fail the run, so the pre-existing rot backlog (~40% of files
//     sampled failing, mostly stale harnesses) does not block, while any
//     merge that breaks a previously-green test goes red on main within one
//     run and is auto-filed for triage.
//   - Per-PR, the `quality` job runs just the tests/*.test.ts files the PR
//     ADDS or MODIFIES (cheap — PRs touch few test files), so a test cannot
//     be born broken or unwired: new files are automatically in the full
//     suite's glob, and must pass at birth.
//
// Modeled on scripts/equivalence-gate.mjs (#1659).
//
// Usage:
//   node scripts/issue-tests-gate.mjs                  # full run, gate
//   SHARD=3/12 node scripts/issue-tests-gate.mjs       # one shard → partial
//   MERGE_PARTIALS_DIR=dir node scripts/issue-tests-gate.mjs   # merge + gate
//   node scripts/issue-tests-gate.mjs --update         # rewrite baseline
//   ALLOW_BOOTSTRAP=1 ... --update-on-decrease         # post-merge auto mode:
//       bootstrap the baseline if missing; ratchet DOWN on newly-fixed;
//       still exit 1 on NEW failures (visible red main).
//
// A file that errors at COLLECTION time (broken import) is counted as a
// failing test id `<file> :: <collect>` — a broken-import test can no longer
// pass by contributing zero assertions.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
// The baseline lives in the loopdive/js2wasm-baselines repo (#1528 pattern) —
// workflows cannot push to main (GH013: merge queue), so the post-merge
// ratchet writes there via the BASELINE_DEPLOY_KEY. The workflow points this
// env at its baselines clone; local runs default to a repo-local file.
const BASELINE_PATH = process.env.ISSUE_TESTS_BASELINE || join(REPO_ROOT, "scripts", "issue-tests-baseline.json");

const args = process.argv.slice(2);
const UPDATE = args.includes("--update");
const RATCHET = args.includes("--update-on-decrease");
const ALLOW_BOOTSTRAP = process.env.ALLOW_BOOTSTRAP === "1";
const SHARD = process.env.SHARD || ""; // e.g. "3/12"
const MERGE_DIR = process.env.MERGE_PARTIALS_DIR || "";
const FORK_HEAP_MB = process.env.ISSUE_TESTS_FORK_HEAP_MB || "1024";

// Root tests only. tests/equivalence/ has its own gate (#1659); linear-*,
// c-abi, simd* run in the `linear-tests` job (#2139). Everything else at the
// tests/ root — issue-*.test.ts plus the feature suites — is THIS gate's
// population. New test files match the selection automatically (no wiring
// step). NOTE: vitest CLI file args are substring FILTERS, not shell globs
// (a quoted "tests/*.test.ts" selects ZERO files) — so the population is
// enumerated here and sharded by slicing the sorted list.
const EXCLUDE_RE = /^(linear-|c-abi\.|simd)/;

function listRootTestFiles() {
  return readdirSync(join(REPO_ROOT, "tests"))
    .filter((f) => f.endsWith(".test.ts") && !EXCLUDE_RE.test(f))
    .sort()
    .map((f) => `tests/${f}`);
}

/** Slice the sorted population for SHARD "i/n" (1-based, contiguous ranges). */
function shardSlice(files, shard) {
  const m = /^(\d+)\/(\d+)$/.exec(shard);
  if (!m) {
    console.error(`issue-tests-gate: bad SHARD "${shard}" (want i/n)`);
    process.exit(2);
  }
  const i = Number(m[1]);
  const n = Number(m[2]);
  const per = Math.ceil(files.length / n);
  return files.slice((i - 1) * per, i * per);
}

function testId(fileRelPath, fullName) {
  return `${fileRelPath} :: ${fullName}`;
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function relName(absName) {
  const i = absName.lastIndexOf("/tests/");
  return i >= 0 ? absName.slice(i + 1) : absName;
}

/** Run vitest on the root suite (optionally a shard); return failing/passing id sets. */
function runVitest() {
  const all = listRootTestFiles();
  const files = SHARD ? shardSlice(all, SHARD) : all;
  if (files.length === 0) {
    console.log(`issue-tests-gate: shard ${SHARD || "full"} selected no files (population ${all.length}).`);
    return { failing: new Set(), passing: new Set() };
  }
  console.log(
    `issue-tests-gate: running ${files.length}/${all.length} root test file(s)${SHARD ? ` (shard ${SHARD})` : ""}.`,
  );
  const outFile = join(mkdtempSync(join(tmpdir(), "issue-tests-")), "report.json");
  const vitestArgs = [
    "node_modules/vitest/dist/cli.js",
    "run",
    ...files,
    "--pool=forks",
    "--poolOptions.forks.singleFork=true",
    "--no-file-parallelism",
    "--reporter=json",
    `--outputFile=${outFile}`,
  ];

  const res = spawnSync(process.execPath, vitestArgs, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      CI: "1",
      VITEST_FORK_MAX_OLD_SPACE_SIZE: process.env.VITEST_FORK_MAX_OLD_SPACE_SIZE || FORK_HEAP_MB,
    },
    maxBuffer: 256 * 1024 * 1024,
  });
  if (!existsSync(outFile)) {
    console.error("issue-tests-gate: vitest produced no JSON report; signal=", res.signal);
    process.exit(2);
  }
  const report = JSON.parse(readFileSync(outFile, "utf8"));
  const failing = new Set();
  const passing = new Set();
  // (#3340) An `it.fails` test whose body UNEXPECTEDLY PASSES is reported by
  // vitest with status "failed" + a "Expect test to fail" message. Left in
  // `failing`, such an inverted sentinel is silently absorbed into the baseline
  // (knownFailures) as accepted rot — main stays green while the test demands
  // obsolete bad behavior, masking the real improvement that made it pass. Split
  // these into a distinct `unexpectedPasses` set: NEVER seeded into the baseline,
  // and a hard gate failure (the test must be promoted, i.e. its `.fails`
  // removed / its assertion corrected — not absorbed).
  const unexpectedPasses = new Set();
  const isUnexpectedPass = (a) => (a.failureMessages || []).some((m) => /Expect test to fail/i.test(m));
  for (const file of report.testResults || []) {
    const rel = relName(file.name);
    const asserts = file.assertionResults || [];
    // Collection-time error (broken import / syntax): the file reports status
    // "failed" with zero assertions — record a synthetic failing id so it gates.
    if (file.status === "failed" && asserts.length === 0) {
      failing.add(testId(rel, "<collect>"));
      continue;
    }
    for (const a of asserts) {
      const id = testId(rel, a.fullName || a.title);
      if (a.status === "failed") {
        if (isUnexpectedPass(a)) unexpectedPasses.add(id);
        else failing.add(id);
      } else if (a.status === "passed") passing.add(id);
    }
  }
  return { failing, passing, unexpectedPasses };
}

function mergePartials(dir) {
  const failing = new Set();
  const passing = new Set();
  const unexpectedPasses = new Set();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const p = JSON.parse(readFileSync(join(dir, f), "utf8"));
    for (const id of p.failing || []) failing.add(id);
    for (const id of p.passing || []) passing.add(id);
    // (#3340) Preserve the inverted-sentinel classification across shard merge.
    for (const id of p.unexpectedPasses || []) unexpectedPasses.add(id);
  }
  return { failing, passing, unexpectedPasses };
}

const { failing, passing, unexpectedPasses } = MERGE_DIR ? mergePartials(MERGE_DIR) : runVitest();

// Shard mode: emit a partial artifact and exit 0 — the merge job gates.
if (SHARD && !MERGE_DIR && !UPDATE && !RATCHET) {
  const partialPath = process.env.PARTIAL_OUT || join(REPO_ROOT, `issue-tests-partial-${SHARD.replace("/", "-")}.json`);
  writeFileSync(
    partialPath,
    JSON.stringify({ failing: [...failing], passing: [...passing], unexpectedPasses: [...unexpectedPasses] }, null, 2),
  );
  console.log(
    `issue-tests-gate: wrote partial ${partialPath} (${failing.size} fail / ${passing.size} pass / ${unexpectedPasses.size} unexpected-pass)`,
  );
  process.exit(0);
}

function writeBaseline(knownFailures) {
  writeFileSync(BASELINE_PATH, JSON.stringify({ knownFailures: [...knownFailures].sort() }, null, 2) + "\n");
}

// (#3340) Inverted-sentinel gate — runs in EVERY non-shard mode (normal gate,
// --update, bootstrap) BEFORE any baseline write. An `it.fails` test whose body
// unexpectedly passes is a stale sentinel demanding obsolete bad behavior; it
// must be PROMOTED (remove `.fails` / correct the assertion), never absorbed.
// `unexpectedPasses` is disjoint from `failing`, so it can never be seeded into
// knownFailures; exiting here additionally refuses to (re)bank a baseline while
// an inverted sentinel is unaddressed, forcing the promotion.
if (unexpectedPasses.size) {
  console.error(
    `\n✗ ${unexpectedPasses.size} UNEXPECTED PASS (stale inverted sentinel — an it.fails test now passes):`,
  );
  for (const id of [...unexpectedPasses].sort()) console.error(`    UNEXPECTED PASS: ${id}`);
  console.error(
    "\nA real improvement made a `.fails` test pass. PROMOTE it — remove `.fails` and assert the now-correct" +
      " behavior (or re-characterize the remaining gap under its own issue). Do NOT let the baseline absorb it as" +
      " accepted rot (#3340).",
  );
  process.exit(1);
}

if (UPDATE) {
  writeBaseline(failing);
  console.log(`issue-tests-gate: baseline updated — ${failing.size} known failures recorded.`);
  process.exit(0);
}

const baseline = loadBaseline();

// Bootstrap: first post-merge run seeds the baseline from the observed
// failure set (the rot backlog) and passes. Requires the explicit env opt-in
// so a per-PR misconfiguration can't silently mint a fresh baseline.
if (baseline === null) {
  if (ALLOW_BOOTSTRAP) {
    writeBaseline(failing);
    console.log(
      `issue-tests-gate: BOOTSTRAP — no baseline existed; seeded ${failing.size} known failures (${passing.size} passing protected from now on).`,
    );
    process.exit(0);
  }
  console.error(
    "issue-tests-gate: no baseline (scripts/issue-tests-baseline.json). Run with --update or ALLOW_BOOTSTRAP=1.",
  );
  process.exit(2);
}

const known = new Set(baseline.knownFailures || []);
const regressions = [...failing].filter((id) => !known.has(id)).sort();
const newlyFixed = [...known].filter((id) => passing.has(id)).sort();

console.log(`issue-tests-gate: ${failing.size} failing, ${passing.size} passing, ${known.size} known in baseline.`);

if (newlyFixed.length) {
  console.log(`\n✓ ${newlyFixed.length} baseline failure(s) now PASS.`);
  if (RATCHET) {
    const next = new Set(known);
    for (const id of newlyFixed) next.delete(id);
    writeBaseline(next);
    console.log(`  Ratcheted baseline down to ${next.size} known failures.`);
  } else {
    console.log("  Ratchet with: node scripts/issue-tests-gate.mjs --update-on-decrease (or --update from a full run)");
  }
}

if (regressions.length) {
  console.error(`\n✗ ${regressions.length} NEW root-suite regression(s) (not in baseline):`);
  for (const id of regressions) console.error(`    REGRESSION: ${id}`);
  console.error(
    "\nA previously-green per-issue test broke. Fix forward, or — if the change is intentional — update the baseline in the fixing PR.",
  );
  process.exit(1);
}

console.log("\n✓ No new root-suite regressions.");
process.exit(0);
