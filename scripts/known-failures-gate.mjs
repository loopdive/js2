#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#6783) Known-failures ratchet for a test suite that is NOT clean on main.
//
// WHY THIS EXISTS
// ---------------
// ~4,400 root test files (tests/issue-*.test.ts, the feature suites beside
// them, tests/ir/) ran under no required check: the `issue-tests` job runs a
// pinned handful plus the files a PR touched, `continue-on-error`, and the
// post-merge detector (.github/workflows/issue-tests.yml) loses whole shards
// to worker OOM before it can gate. So a src-only PR could turn any of them
// red, and main carried red files nobody had seen (#6783 found 2 of 8 random
// files failing on a clean checkout).
//
// The suite cannot be required as-is: some files are red on main today. This
// gate makes the RED SET the baseline instead — the same idea as
// scripts/equivalence-gate.mjs (#1659/#6785), whose report reduction it
// reuses, but scored per FILE: a file is red when any of its tests fails or
// the file itself fails (import / syntax / collect error, a worker crash).
//
//   • a file that is green on the baseline and red now FAILS the gate
//     (unless the change-set excuses it, see ALLOWANCES);
//   • a baseline file that is green now is reported "newly fixed" and leaves
//     the baseline post-merge (`--update-on-decrease`);
//   • an `it.fails` test that unexpectedly PASSES always fails (#3340 — a
//     stale inverted sentinel must be promoted, never absorbed);
//   • a run that cannot be scored fails: a shard partial missing or
//     duplicated, a file on disk that reached no report, partials taken at
//     different commits.
//
// TWO-PHASE ROLLOUT
// -----------------
// No baseline exists until CI has measured main once, and this box-class
// cannot run 4,400 files locally. So when the baseline file is ABSENT the
// gate runs in SEED mode: it scores nothing, exits 0, and prints the full red
// list as the proposed baseline. Only the post-merge bank
// (`--update-on-decrease --seed-if-missing`, test262-sharded.yml
// promote-baseline) WRITES it, from a complete merged run on main, and it
// refuses while the run has an integrity failure or an unexpected pass. From
// the first seeded commit on the gate ENFORCES; the `issue-tests-gate` check
// can then be added to the main ruleset (docs/ci-policy.md §7).
//
// ALLOWANCES — never by editing the baseline in a PR
// --------------------------------------------------
// The baseline is written on main only. A change-set that deliberately leaves
// a file red lists it in its own plan/issues/*.md frontmatter, one item per
// file: the path, an ISO date and a reason:
//
//   known-failures-allow:
//     - "tests/issue-1234.test.ts 2026-10-02 asserts the pre-#1234 shape; fix in #1240"
//
// Items without a date and a reason grant nothing. Because the baseline lags
// main (the post-merge commit is deferred while the merge queue is busy), the
// gate honours allowances from every issue file changed since the commit the
// baseline was measured at (`measuredAt`), not only the PR's own — otherwise
// the PR right behind an allowed one would fail on the same file. The bank
// adds an allowed file to the baseline once a measured run sees it red.
//
// USAGE
//   node scripts/known-failures-gate.mjs --suite issue-tests              # run the whole suite, gate
//   SHARD=3/8 PARTIAL_OUT=p.json node scripts/known-failures-gate.mjs --suite issue-tests
//   MERGE_PARTIALS_DIR=dir node scripts/known-failures-gate.mjs --suite issue-tests
//   MERGE_PARTIALS_DIR=dir node scripts/known-failures-gate.mjs --suite issue-tests \
//       --update-on-decrease --seed-if-missing                           # post-merge bank (main only)
//   node scripts/known-failures-gate.mjs --suite issue-tests --list       # print the population
//
// ENV
//   KNOWN_FAILURES_BASELINE   baseline path override (tests)
//   KNOWN_FAILURES_ROOT       repo root override for the population + allowances (tests)
//   KNOWN_FAILURES_ALLOW_BASE explicit allowance diff base (the post-merge bank passes the landed merge's HEAD^1)
//   KNOWN_FAILURES_FETCH_BASE=1  fetch `measuredAt` from origin when the clone lacks it (CI)
//   KNOWN_FAILURES_FORK_HEAP_MB  per-fork heap for the parallel pass (default 2048)
//   KNOWN_FAILURES_RERUN_HEAP_MB per-fork heap for serial re-runs (default 4096)
//   KNOWN_FAILURES_BATCH         files per vitest invocation (default 150)
//   KNOWN_FAILURES_CONFIRM_MAX   status changes re-run to confirm, per direction (default 25)
//   KNOWN_FAILURES_ONLY          regex narrowing the population (local debugging only)
//
// Exit codes: 0 ok · 1 gate failure or refused bank · 2 usage / infrastructure.

import { execFileSync, spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bankBaseline,
  evaluateGate,
  fromPartial,
  mergeSummaries,
  summarizeReport,
  toPartial,
} from "./equivalence-gate.mjs";
import { changeSetAllowances, resolveChangeBase } from "./lib/change-scope.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const REPORTER = join(__dirname, "lib", "known-failures-reporter.mjs");
const PARTIAL_FORMAT = "known-failures/1";
const ALLOW_KEY = "known-failures-allow";

// Root files owned by another gate: linear-*/c-abi/simd* run in `linear-tests`;
// the test262 chunk / local-shard / vitest entry points run the conformance
// corpus itself (test262-sharded.yml), not a unit suite.
const ROOT_EXCLUDE = /^(linear-|c-abi\.|simd|test262-(chunk|local-shard|vitest\.))/;

function listTestFiles(root, dir, rel) {
  const abs = join(root, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".test.ts") && !(rel && rel.test(e.name)))
    .map((e) => `${dir}/${e.name}`);
}

export const SUITES = {
  "issue-tests": {
    baseline: "scripts/issue-tests-baseline.json",
    describe: "tests/*.test.ts (minus linear/c-abi/simd and the test262 runners) + tests/ir/*.test.ts",
    list: (root) => [...listTestFiles(root, "tests", ROOT_EXCLUDE), ...listTestFiles(root, "tests/ir", null)].sort(),
  },
};

/** Repo-relative, forward-slash id for a vitest file name. */
export function makeToRel(root) {
  return (name) => {
    const abs = isAbsolute(name) ? name : join(root, name);
    const rel = relative(root, abs);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split(sep).join("/");
    const i = String(name).indexOf("/tests/");
    return i >= 0 ? String(name).slice(i + 1) : String(name);
  };
}

/** Round-robin slice for SHARD "i/N" (1-based) — spreads slow neighbours apart. */
export function shardSlice(files, shard) {
  const m = /^(\d+)\/(\d+)$/.exec(shard);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error(`bad SHARD "${shard}" (want i/N)`);
  const i = Number(m[1]) - 1;
  const n = Number(m[2]);
  return files.filter((_, k) => k % n === i);
}

const isUnexpectedPass = (a) => (a.failureMessages || []).some((m) => /Expect test to fail/i.test(m));

/** Score one vitest file entry (or a crash) as red / green and its unexpected passes. */
export function classifyEntry(entry, toRel) {
  const s = summarizeReport({ testResults: [entry] }, "file", toRel);
  const file = toRel(entry.name);
  const unexpected = (entry.assertionResults || [])
    .filter((a) => a.status === "failed" && isUnexpectedPass(a))
    .map((a) => `${file} :: ${a.fullName || a.title}`);
  const ordinary = [...s.failing].filter((id) => !unexpected.includes(id));
  return { red: ordinary.length > 0 || s.fileFailures.length > 0, unexpected, summary: s };
}

/** A file that never produced a result even when re-run alone. */
function crashSummary(file, reason) {
  return fromPartial({ files: [file], fileFailures: [{ file, reason }] });
}

/**
 * Reduce a merged summary to per-FILE verdicts. Every file-level failure the
 * report attributes to a file (import / collect / hook error, a confirmed
 * crash) makes that file red — it is a fact about the file, so it belongs in
 * the known-failures list like an assertion failure. Only failures no file
 * can carry stay as run-integrity failures.
 */
export function projectFiles(summary, unexpectedPasses = []) {
  const unexpected = new Set(unexpectedPasses);
  const reasons = new Map();
  const note = (file, why) => {
    if (!reasons.has(file)) reasons.set(file, why);
  };
  for (const id of [...summary.failing].sort()) {
    if (unexpected.has(id)) continue;
    const [file, ...rest] = id.split(" :: ");
    note(file, `test failed: ${rest.join(" :: ")}`);
  }
  for (const f of summary.fileFailures) note(f.file, f.reason);
  const red = new Set(reasons.keys());
  const green = new Set([...summary.files].filter((f) => !red.has(f)));
  return { red, green, reasons };
}

/**
 * Parse one `known-failures-allow` item: "<path> <YYYY-MM-DD> <reason>"
 * (an optional `-`, `—` or `:` may separate the parts). Null when the item
 * lacks a test path, a date or a reason — such an item grants nothing.
 */
export function parseAllowItem(item) {
  const m = /^(\S+\.test\.ts)\s+[-—–:]?\s*(\d{4}-\d{2}-\d{2})\b[\s:—–-]*(\S.*)$/.exec(String(item).trim());
  return m ? { path: m[1], date: m[2], reason: m[3].trim() } : null;
}

/** Map<item, sources[]> (change-scope.mjs) → valid grants per path + invalid items. */
export function collectAllowances(raw) {
  const allow = new Map();
  const invalid = [];
  for (const [item, sources] of raw) {
    const parsed = parseAllowItem(item);
    if (!parsed) {
      invalid.push({ item, sources });
      continue;
    }
    const prev = allow.get(parsed.path);
    allow.set(parsed.path, {
      date: parsed.date,
      reason: parsed.reason,
      sources: [...new Set([...(prev?.sources || []), ...sources])],
    });
  }
  return { allow, invalid };
}

/**
 * Score a (merged or shard) summary against the known-failures baseline.
 *
 * - `known`: baseline file list, or null in seed mode (no baseline yet);
 * - `expected`: files the run was asked to measure (from the partials);
 * - `diskFiles`: the suite population on disk — every one must be in the
 *   report (the PR-time gate over a full run only);
 * - `present`: files that exist now; baseline entries outside it are stale
 *   (the bank passes the re-anchored tip's population here, not `diskFiles`,
 *   because tests added after the measured commit are legitimately absent);
 * - `allow`: Map<path, grant> from `collectAllowances`;
 * - `partial`: a single shard (skips the whole-suite checks).
 */
export function scoreKnownFailures(
  summary,
  {
    known = null,
    expected = null,
    diskFiles = null,
    present = diskFiles,
    allow = new Map(),
    unexpectedPasses = [],
    partial = false,
  } = {},
) {
  const files = projectFiles(summary, unexpectedPasses);
  const integrity = [];
  if (expected) {
    for (const f of [...expected].sort()) {
      if (!summary.files.has(f))
        integrity.push({ file: f, reason: "expected by its shard but absent from the report" });
    }
  }
  const fileSummary = {
    failing: files.red,
    passing: files.green,
    files: summary.files,
    fileFailures: integrity,
    unexplained: [...summary.unexplained],
    shards: summary.shards,
  };
  const knownList = known || [];
  const verdict = evaluateGate(fileSummary, { knownFailures: knownList }, { partial, diskFiles, floors: false });
  const regressions = [];
  const allowed = [];
  for (const file of verdict.regressions) {
    if (allow.has(file)) allowed.push({ file, grant: allow.get(file) });
    else regressions.push(file);
  }
  const presentSet = present ? new Set(present) : null;
  const stale = presentSet ? knownList.filter((f) => !presentSet.has(f)).sort() : [];
  const unexpected = [...unexpectedPasses].sort();
  const integrityFailures = [...verdict.fileFailures];
  const unexplained = [...verdict.unexplained];
  const seed = known === null;
  const ok = seed
    ? true
    : !regressions.length && !unexpected.length && !integrityFailures.length && !unexplained.length;
  return {
    ok,
    seed,
    files,
    fileSummary,
    regressions,
    allowed,
    newlyFixed: verdict.newlyFixed,
    stale,
    unexpected,
    integrityFailures,
    unexplained,
  };
}

/**
 * The baseline the post-merge bank writes. Seed (no previous baseline): the
 * run's red set, via equivalence-gate's `bankBaseline`. Otherwise decrease
 * only: drop newly-fixed and deleted files, add a red file only when an
 * allowance names it. `refusals` non-empty ⇒ write nothing.
 */
export function bankKnownFailures(score, previous) {
  const seeded = bankBaseline(score.fileSummary, {}, { floors: false });
  // `bankBaseline` refuses on a count; name each failure so the log is actionable.
  const refusals = [...seeded.refusals];
  if (refusals.length) {
    for (const f of score.integrityFailures) refusals.push(`  ${f.file}: ${f.reason}`);
    for (const u of score.unexplained) refusals.push(`  ${u}`);
  }
  if (score.unexpected.length) {
    refusals.push(
      `${score.unexpected.length} unexpected pass(es) (#3340) — promote the it.fails test(s) before the baseline can be banked`,
    );
  }
  let knownFailures;
  if (!previous) {
    knownFailures = seeded.baseline.knownFailures;
  } else {
    const drop = new Set([...score.newlyFixed, ...score.stale]);
    const next = new Set((previous.knownFailures || []).filter((f) => !drop.has(f)));
    for (const { file } of score.allowed) next.add(file);
    knownFailures = [...next].sort();
  }
  return { knownFailures, refusals };
}

// ---------------------------------------------------------------------------
// Running vitest
// ---------------------------------------------------------------------------

function envInt(name, fallback) {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

/**
 * One vitest invocation over `files` with the crash-safe reporter. Resolves
 * to { ended: Map<rel, entry>, started: Set<rel>, timedOut, code }.
 */
function vitestOnce(root, toRel, files, { serial, heapMb, timeoutMs }) {
  const dir = mkdtempSync(join(tmpdir(), "known-failures-"));
  const progress = join(dir, "progress.jsonl");
  writeFileSync(progress, "");
  const args = [join(root, "node_modules", "vitest", "dist", "cli.js"), "run", ...files, "--pool=forks"];
  if (serial) args.push("--no-file-parallelism");
  args.push(`--reporter=${REPORTER}`);
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: root,
      detached: true,
      stdio: ["ignore", "inherit", "inherit"],
      env: {
        ...process.env,
        CI: "1",
        KNOWN_FAILURES_PROGRESS: progress,
        VITEST_FORK_MAX_OLD_SPACE_SIZE: String(heapMb),
      },
    });
    let timedOut = false;
    let finished = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, timeoutMs);
    const finish = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      // Reap any fork the parent left behind.
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
      const ended = new Map();
      const started = new Set();
      for (const line of readFileSync(progress, "utf8").split("\n")) {
        if (!line.trim()) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          continue; // a line torn by a kill mid-write
        }
        const rel = toRel(rec.file);
        if (rec.event === "start") started.add(rel);
        else if (rec.event === "end" && rec.entry) ended.set(rel, rec.entry);
      }
      rmSync(dir, { recursive: true, force: true });
      resolve({ ended, started, timedOut, code });
    };
    child.on("exit", (code) => finish(code));
    child.on("error", () => finish(-1));
  });
}

/**
 * Run `files` to completion despite crashes and hangs. Files a dead or
 * killed invocation never started are queued again; files it was running go
 * to a SERIAL re-run at a bigger heap; a file that dies even there is red
 * with the reason. `serial: true` skips the parallel pass (confirmation
 * re-runs). Returns Map<rel, {entry} | {crash}>.
 */
async function runFiles(root, toRel, files, { label, serial = false }) {
  const batch = envInt("KNOWN_FAILURES_BATCH", 150);
  const heap = envInt("KNOWN_FAILURES_FORK_HEAP_MB", 2048);
  const rerunHeap = envInt("KNOWN_FAILURES_RERUN_HEAP_MB", 4096);
  const results = new Map();
  const want = new Set(files);
  const suspects = serial ? [...files] : [];

  let pending = serial ? [] : [...files];
  let pass = 0;
  while (pending.length) {
    const chunk = pending.slice(0, batch);
    pending = pending.slice(batch);
    pass++;
    const t0 = Date.now();
    const r = await vitestOnce(root, toRel, chunk, {
      serial: false,
      heapMb: heap,
      timeoutMs: envInt("KNOWN_FAILURES_BATCH_TIMEOUT_MIN", 30) * 60_000,
    });
    for (const [rel, entry] of r.ended) if (want.has(rel)) results.set(rel, { entry });
    const inflight = chunk.filter((f) => !results.has(f) && r.started.has(f));
    const unstarted = chunk.filter((f) => !results.has(f) && !r.started.has(f));
    console.log(
      `known-failures-gate: ${label} pass ${pass}: ${chunk.length} file(s), ${r.ended.size} finished, ` +
        `${inflight.length} in flight at exit, ${unstarted.length} not started` +
        `${r.timedOut ? " (TIMED OUT)" : ""}, ${Math.round((Date.now() - t0) / 1000)}s`,
    );
    if (r.ended.size === 0 && inflight.length === 0) {
      // Nothing ran at all: vitest could not start. Re-queueing would loop.
      throw new Error(`vitest made no progress on ${chunk.length} file(s) (exit ${r.code}) — infrastructure failure`);
    }
    suspects.push(...inflight);
    pending = [...unstarted, ...pending];
  }

  // Serial re-runs: one file at a time, so a crash names its file exactly.
  // Past the cap (mass crashes mean the runner, not the files, is broken) and
  // for files vitest never picks up, there is NO result: the gate reports them
  // as absent from the report — a run failure, never a red file to bank.
  const cap = serial ? suspects.length : envInt("KNOWN_FAILURES_CRASH_MAX", 40);
  let queue = suspects.slice(0, cap);
  if (suspects.length > cap) {
    console.error(`known-failures-gate: ${suspects.length} file(s) died in flight; re-running only the first ${cap}.`);
  }
  while (queue.length) {
    const r = await vitestOnce(root, toRel, queue, {
      serial: true,
      heapMb: rerunHeap,
      timeoutMs: (8 * 60 + 90 * queue.length) * 1000,
    });
    for (const [rel, entry] of r.ended) if (want.has(rel)) results.set(rel, { entry });
    const died = queue.filter((f) => !results.has(f) && r.started.has(f));
    for (const f of died) {
      results.set(f, {
        crash: r.timedOut
          ? "did not finish within the serial re-run timeout"
          : `worker died even when run alone at ${rerunHeap} MB heap (OOM / crash)`,
      });
    }
    const next = queue.filter((f) => !results.has(f));
    if (next.length === queue.length) {
      console.error(`known-failures-gate: the serial re-run picked up none of ${next.length} file(s); left unscored.`);
      break;
    }
    queue = next;
  }
  return results;
}

function summarizeResults(results, toRel, label) {
  const parts = [];
  const unexpectedPasses = [];
  for (const [file, r] of results) {
    if (r.crash) {
      parts.push(crashSummary(file, r.crash));
      continue;
    }
    const c = classifyEntry(r.entry, toRel);
    parts.push(c.summary);
    unexpectedPasses.push(...c.unexpected);
  }
  const summary = mergeSummaries(parts);
  return { summary, unexpectedPasses, label };
}

function statusOf(r, toRel) {
  if (r.crash) return { red: true, unexpected: false };
  const c = classifyEntry(r.entry, toRel);
  return { red: c.red, unexpected: c.unexpected.length > 0 };
}

/**
 * Re-run every file whose status CHANGED against the baseline, serially. A
 * change counts only when the re-run reproduces it: a regression that passes
 * alone is flaky (kept green, reported), a fix that fails alone is flaky
 * (kept red). Biased toward the baseline both ways, so a flake can neither
 * fail a PR nor bank a premature fix.
 */
async function confirmChanges(root, toRel, results, known) {
  const max = envInt("KNOWN_FAILURES_CONFIRM_MAX", 25);
  const toRed = [];
  const toGreen = [];
  for (const [file, r] of results) {
    if (r.crash) continue; // already confirmed alone
    const s = statusOf(r, toRel);
    if ((s.red || s.unexpected) && !known.has(file)) toRed.push(file);
    else if (s.unexpected) toRed.push(file);
    else if (!s.red && known.has(file)) toGreen.push(file);
  }
  const candidates = [...toRed.slice(0, max), ...toGreen.slice(0, max)];
  const flakes = [];
  if (!candidates.length) return flakes;
  console.log(`known-failures-gate: confirming ${candidates.length} status change(s) with a serial re-run…`);
  const rerun = await runFiles(root, toRel, candidates, { label: "confirm", serial: true });
  for (const file of candidates) {
    const first = statusOf(results.get(file), toRel);
    const again = rerun.get(file);
    if (!again) continue;
    const second = statusOf(again, toRel);
    const firstChanged = first.red !== known.has(file) || first.unexpected;
    const secondChanged = second.red !== known.has(file) || second.unexpected;
    if (firstChanged && !secondChanged) {
      flakes.push({ file, first: first.red ? "red" : "green", rerun: second.red ? "red" : "green" });
      results.set(file, again);
    }
  }
  return flakes;
}

// ---------------------------------------------------------------------------
// Baseline, partials, allowances
// ---------------------------------------------------------------------------

function loadBaseline(path) {
  if (!existsSync(path)) return null;
  const json = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(json.knownFailures)) throw new Error(`${path}: no knownFailures array`);
  return json;
}

function writeBaseline(path, suite, measuredAt, knownFailures) {
  const body = {
    $comment:
      "Written on main only, by the post-merge bank (scripts/known-failures-gate.mjs --update-on-decrease --seed-if-missing, #6783). Never edit it in a PR: excuse a red file with `known-failures-allow:` in the PR's own plan/issues/*.md frontmatter.",
    suite,
    measuredAt,
    knownFailures,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
}

function gitOut(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return undefined;
  }
}

function headSha(root) {
  return process.env.GITHUB_SHA || gitOut(root, ["rev-parse", "HEAD"]) || "unknown";
}

function haveCommit(root, sha) {
  return gitOut(root, ["cat-file", "-e", `${sha}^{commit}`]) !== undefined;
}

/** Allowances from the change-set, widened to everything since `measuredAt`. */
function loadAllowances(root, baseline) {
  const bases = [];
  if (process.env.KNOWN_FAILURES_ALLOW_BASE) {
    bases.push({ base: process.env.KNOWN_FAILURES_ALLOW_BASE, how: "env:KNOWN_FAILURES_ALLOW_BASE" });
  } else {
    const own = resolveChangeBase(root);
    if (own.base) bases.push(own);
    const sha = baseline?.measuredAt;
    if (sha && /^[0-9a-f]{7,40}$/.test(sha)) {
      if (!haveCommit(root, sha) && process.env.KNOWN_FAILURES_FETCH_BASE === "1") {
        gitOut(root, ["fetch", "--no-tags", "--depth=1", "origin", sha]);
      }
      if (haveCommit(root, sha)) bases.push({ base: sha, how: "baseline measuredAt" });
      else
        console.warn(
          `known-failures-gate: measuredAt ${sha} is not in this clone — allowances from the change-set only.`,
        );
    }
  }
  const raw = new Map();
  for (const { base } of bases) {
    for (const [item, sources] of changeSetAllowances(root, base, ALLOW_KEY)) {
      raw.set(item, [...new Set([...(raw.get(item) || []), ...sources])]);
    }
  }
  return { ...collectAllowances(raw), bases };
}

/** Read and merge shard partials; duplicate / foreign / cross-commit partials are integrity failures. */
export function mergeKnownPartials(partials, suite) {
  const problems = [];
  const seen = new Set();
  const shas = new Set();
  const expected = new Set();
  const unexpectedPasses = [];
  const flakes = [];
  const summaries = [];
  for (const p of partials) {
    if (p.format !== PARTIAL_FORMAT || p.suite !== suite) {
      problems.push(`partial for shard ${p.shard || "?"} is not a ${suite} ${PARTIAL_FORMAT} partial`);
      continue;
    }
    if (seen.has(p.shard)) problems.push(`two partials claim shard ${p.shard}`);
    seen.add(p.shard);
    shas.add(p.sha);
    for (const f of p.expected || []) expected.add(f);
    unexpectedPasses.push(...(p.unexpectedPasses || []));
    flakes.push(...(p.flakes || []));
    summaries.push(fromPartial(p));
  }
  if (shas.size > 1) problems.push(`partials were measured at different commits: ${[...shas].sort().join(", ")}`);
  const summary = mergeSummaries(summaries);
  summary.unexplained.push(...problems);
  if (!partials.length) summary.unexplained.push("no partials to merge");
  return { summary, expected, unexpectedPasses, flakes, sha: shas.size === 1 ? [...shas][0] : "unknown" };
}

// ---------------------------------------------------------------------------
// Report + main
// ---------------------------------------------------------------------------

function printScore(score, { suite, scope, baselineRel }) {
  const { files } = score;
  console.log(
    `known-failures-gate: ${suite} ${scope} — ${files.red.size} red / ${files.green.size} green file(s)` +
      `${score.seed ? " — SEED MODE (no baseline yet)" : ""}.`,
  );
  if (score.seed) {
    const proposed = [...files.red].sort();
    console.log(
      scope.startsWith("shard")
        ? `\nRed files in this shard (${proposed.length}; the merged issue-tests-gate job prints the whole proposed ${baselineRel}):`
        : `\nProposed ${baselineRel} (${proposed.length} red file(s)):`,
    );
    for (const f of proposed) console.log(`    ${f} — ${files.reasons.get(f)}`);
    console.log(
      "\nSeed mode scores nothing and exits 0. The post-merge bank writes this list from a complete run on main " +
        "(--update-on-decrease --seed-if-missing); from then on the gate enforces.",
    );
  }
  for (const a of score.allowed) {
    console.log(`  allowed: ${a.file} — ${a.grant.date} ${a.grant.reason} (${a.grant.sources.join(", ")})`);
  }
  if (!score.seed && score.newlyFixed.length) {
    console.log(`\n✓ ${score.newlyFixed.length} baseline file(s) now pass (newly fixed — banked post-merge):`);
    for (const f of score.newlyFixed) console.log(`    fixed: ${f}`);
  }
  if (score.stale.length) {
    console.log(`\n  ${score.stale.length} baseline file(s) no longer exist (dropped post-merge):`);
    for (const f of score.stale) console.log(`    gone: ${f}`);
  }
  if (score.unexpected.length) {
    console.error(`\n✗ ${score.unexpected.length} UNEXPECTED PASS — an it.fails test now passes (#3340); promote it:`);
    for (const id of score.unexpected) console.error(`    UNEXPECTED PASS: ${id}`);
  }
  if (score.integrityFailures.length || score.unexplained.length) {
    console.error(`\n✗ The run cannot be scored completely:`);
    for (const f of score.integrityFailures) console.error(`    RUN FAILURE: ${f.file} — ${f.reason}`);
    for (const u of score.unexplained) console.error(`    RUN FAILURE: ${u}`);
  }
  if (!score.seed && score.regressions.length) {
    console.error(`\n✗ ${score.regressions.length} file(s) red that the baseline has green:`);
    for (const f of score.regressions) console.error(`    REGRESSION: ${f} — ${files.reasons.get(f)}`);
    console.error(
      `\nFix the file, or — if it must stay red — excuse it in this PR's issue frontmatter:\n` +
        `  ${ALLOW_KEY}:\n    - "${score.regressions[0]} YYYY-MM-DD <why it stays red, and where it gets fixed>"\n` +
        `Never edit ${baselineRel} in a PR; main's post-merge bank is its only writer.`,
    );
  }
}

function parseArgs(argv) {
  const opts = { suite: "", update: false, seed: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--suite") opts.suite = argv[++i] || "";
    else if (a.startsWith("--suite=")) opts.suite = a.slice(8);
    else if (a === "--update-on-decrease") opts.update = true;
    else if (a === "--seed-if-missing") opts.seed = true;
    else if (a === "--list") opts.list = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!SUITES[opts.suite]) throw new Error(`--suite must be one of: ${Object.keys(SUITES).join(", ")}`);
  return opts;
}

async function main(argv, env) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(`known-failures-gate: ${e.message}`);
    return 2;
  }
  const root = env.KNOWN_FAILURES_ROOT || REPO_ROOT;
  const suite = SUITES[opts.suite];
  const baselineRel = suite.baseline;
  const baselinePath = env.KNOWN_FAILURES_BASELINE || join(root, baselineRel);
  const toRel = makeToRel(root);
  // KNOWN_FAILURES_ONLY=<regex> narrows the population for a local look at a
  // few files; CI never sets it.
  const only = env.KNOWN_FAILURES_ONLY ? new RegExp(env.KNOWN_FAILURES_ONLY) : null;
  const population = suite.list(root).filter((f) => !only || only.test(f));

  if (opts.list) {
    console.log(`known-failures-gate: ${opts.suite} — ${population.length} file(s): ${suite.describe}`);
    for (const f of population) console.log(f);
    return 0;
  }

  const shard = env.SHARD || "";
  const mergeDir = env.MERGE_PARTIALS_DIR || "";
  if ((opts.update || opts.seed) && (shard || !mergeDir)) {
    console.error(
      "known-failures-gate: --update-on-decrease/--seed-if-missing bank merged partials only (MERGE_PARTIALS_DIR, no SHARD).",
    );
    return 2;
  }

  let baseline;
  try {
    baseline = loadBaseline(baselinePath);
  } catch (e) {
    console.error(`known-failures-gate: ${e.message}`);
    return 2;
  }
  const known = baseline ? new Set(baseline.knownFailures) : null;

  let summary;
  let unexpectedPasses;
  let expected = null;
  let flakes = [];
  let sha;
  let diskFiles = null;
  let present = null;
  if (mergeDir) {
    if (!existsSync(mergeDir)) {
      console.error(`known-failures-gate: MERGE_PARTIALS_DIR ${mergeDir} does not exist`);
      return 2;
    }
    const partials = readdirSync(mergeDir)
      .filter((f) => f.endsWith(".json"))
      .sort()
      .map((f) => JSON.parse(readFileSync(join(mergeDir, f), "utf8")));
    ({ summary, expected, unexpectedPasses, flakes, sha } = mergeKnownPartials(partials, opts.suite));
    // The bank runs on a re-anchored main tip whose test files may postdate the
    // measured commit, so only the PR-time gate demands every file on disk be
    // in the report; the bank only drops baseline entries whose file is gone.
    present = population;
    if (!opts.update && !opts.seed) diskFiles = population;
  } else {
    const slice = shard ? shardSlice(population, shard) : population;
    sha = headSha(root);
    console.log(
      `known-failures-gate: ${opts.suite} — running ${slice.length}/${population.length} file(s)${shard ? ` (shard ${shard})` : ""}.`,
    );
    let results;
    try {
      results = await runFiles(root, toRel, slice, { label: shard ? `shard ${shard}` : "suite" });
      if (known) flakes = await confirmChanges(root, toRel, results, known);
    } catch (e) {
      console.error(`known-failures-gate: ${e.message}`);
      return 2;
    }
    ({ summary, unexpectedPasses } = summarizeResults(results, toRel, shard));
    if (shard) summary.shards.push(shard);
    expected = new Set(slice);
    if (!shard) diskFiles = present = population;
    if (env.PARTIAL_OUT) {
      const partial = {
        format: PARTIAL_FORMAT,
        suite: opts.suite,
        sha,
        ...toPartial(summary, shard),
        expected: [...slice].sort(),
        unexpectedPasses: [...unexpectedPasses].sort(),
        flakes,
      };
      writeFileSync(env.PARTIAL_OUT, `${JSON.stringify(partial, null, 2)}\n`);
      console.log(`known-failures-gate: wrote partial ${env.PARTIAL_OUT}`);
    }
  }

  const allowances = loadAllowances(root, baseline);
  for (const bad of allowances.invalid) {
    console.warn(
      `known-failures-gate: ignoring ${ALLOW_KEY} item "${bad.item}" in ${bad.sources.join(", ")} — want "<tests/…test.ts> <YYYY-MM-DD> <reason>"`,
    );
  }
  const score = scoreKnownFailures(summary, {
    known: known ? [...known] : null,
    expected,
    diskFiles,
    present,
    allow: allowances.allow,
    unexpectedPasses,
    partial: Boolean(shard),
  });
  for (const f of flakes) {
    console.warn(`  flaky: ${f.file} — ${f.first} in the first run, ${f.rerun} alone; kept at its baseline status`);
  }
  printScore(score, {
    suite: opts.suite,
    scope: shard ? `shard ${shard}` : mergeDir ? "merged" : "full run",
    baselineRel,
  });

  if (opts.update || opts.seed) {
    if (!baseline && !opts.seed) {
      console.log("known-failures-gate: no baseline and no --seed-if-missing — nothing to bank.");
      return 0;
    }
    if (baseline && !opts.update) {
      console.log("known-failures-gate: baseline exists and no --update-on-decrease — nothing to bank.");
      return 0;
    }
    const { knownFailures, refusals } = bankKnownFailures(score, baseline);
    if (refusals.length) {
      console.error(`\nknown-failures-gate: bank REFUSED, ${baselineRel} unchanged:`);
      for (const r of refusals) console.error(`    ${r}`);
      return 1;
    }
    const before = baseline ? JSON.stringify(baseline.knownFailures) : null;
    if (before === JSON.stringify(knownFailures)) {
      console.log(`known-failures-gate: ${baselineRel} already current (${knownFailures.length} known red file(s)).`);
      return 0;
    }
    writeBaseline(baselinePath, opts.suite, sha, knownFailures);
    console.log(
      `known-failures-gate: ${baseline ? "banked" : "SEEDED"} ${baselineRel} — ${knownFailures.length} known red file(s), measured at ${sha}.`,
    );
    return 0;
  }

  if (!score.ok) return 1;
  console.log(score.seed ? "\nknown-failures-gate: seed mode — exit 0." : `\n✓ No new red files in ${opts.suite}.`);
  return 0;
}

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) process.exit(await main(process.argv.slice(2), process.env));
