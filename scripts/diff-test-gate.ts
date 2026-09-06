#!/usr/bin/env -S node --experimental-strip-types
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1203 — Differential test delta gate.
// #5344 — baseline refresh (`--update`) + staleness fallback.
//
// Compares the current `diff-test.json` against the committed
// `diff-test-baseline.json` and fails the build if any program that previously
// matched is now a mismatch / error.
//
// ── WHAT THE BASELINE IS, AND WHY STALENESS IS A CORRECTNESS BUG ──────────
//
// The delta this gate reports is attributed to whatever is under test. That
// attribution is only sound while the baseline describes the merge base. A
// baseline measured N commits ago makes the delta cover ALL N commits, so a
// regression that landed on `main` weeks earlier is reported against whichever
// PR happens to be in the merge queue now.
//
// That is not hypothetical. The refresh step in `diff-test.yml` was commented
// out on 2026-05-22 (`239062b95d`, post-#491: `GITHUB_TOKEN` cannot push to a
// queue-protected `main`), nothing replaced it, and the baseline froze at
// 2026-07-19. On 2026-09-05 the frozen delta surfaced as
// `closures/06-nested.js: match → mismatch` inside the merge group of PR #5620
// — a closure-shaped failure on a closure PR that had nothing to do with it
// (it reproduced with the change reverted; the real cause was #5335). It cost
// that P0 fix real time, and only because the agent checked rather than
// trusting the gate. Meanwhile the 16 corpus files added after 2026-07-19 were
// in no baseline at all, so nothing gated them.
//
// So this gate now refuses to make a claim it cannot support. Two mechanisms:
//
//   1. `--update` (called by `diff-test.yml`'s `refresh-baseline` job on every
//      push to `main`) rewrites the baseline from a fresh report. It writes
//      only when the OUTCOMES changed, or when the stamp is older than
//      HEARTBEAT_DAYS — never on timing noise — so promotion pushes to `main`
//      stay rare. (Every push to `main` rebuilds in-flight merge groups, #3915.)
//   2. In gate mode, a baseline older than STALE_DAYS (or carrying no stamp at
//      all) DOWNGRADES a regression from a failure to a loud warning. When the
//      refresh mechanism breaks again, the symptom is a visible "the baseline
//      is stale" annotation on the run that broke it — not months of silent
//      mis-attribution onto innocent PRs.
//
// Exit codes:
//   0 — no new mismatches (or: mismatches found against a baseline too stale
//       to attribute them — reported as a warning)
//   1 — at least one program flipped from match to non-match against a
//       CURRENT baseline (delta regression attributable to this change)
//   2 — internal error (missing file, parse error, etc.)

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const REPORT_REL = "benchmarks/results/diff-test.json";
const BASELINE_REL = "benchmarks/results/diff-test-baseline.json";

/**
 * How old the committed baseline's stamp may get before `--update` re-lands it
 * unchanged. The point of the heartbeat is to keep `generatedAt` meaningful as
 * "the baseline was verified against `main` this recently" — without it the
 * stamp would only ever record the last time an OUTCOME moved, which can be
 * months even while the mechanism is perfectly healthy, and the staleness
 * check below would then fire on a working system.
 */
const HEARTBEAT_DAYS = 7;

/**
 * How old the baseline may get before a reported delta stops being
 * attributable to the change under test. Deliberately 3x the heartbeat: on a
 * healthy mechanism the stamp is at most HEARTBEAT_DAYS old, so reaching this
 * threshold means the refresh path itself is broken.
 */
const STALE_DAYS = 21;

type Outcome = "match" | "mismatch" | "compile_error" | "runtime_error" | "v8_error" | "malformed_wasm";

interface FileResult {
  file: string;
  // #2143 — `malformed_wasm`: compiler reported success but WebAssembly.validate
  // rejected the binary. The per-file delta below treats it like any other
  // non-match outcome, so a corpus program that regresses from `match` to
  // `malformed_wasm` fails the gate loudly.
  outcome: Outcome;
  error?: string;
}

interface Report {
  /** #5344 — ISO-8601 measurement stamp. Absent on pre-#5344 artifacts. */
  generatedAt?: string;
  total: number;
  match: number;
  mismatch: number;
  results: FileResult[];
}

/**
 * The committed baseline is a PROJECTION of a report, not a copy of one. A
 * report also carries `ms_v8` / `ms_js2wasm` / `duration_s` / captured stdout,
 * all of which differ on every run — committing them would make the baseline
 * change on every push to `main`, i.e. a promotion push (and a merge-group
 * rebuild, #3915) for pure timing noise. Only `file` + `outcome` decide the
 * gate, so only those are kept, sorted, for a diff a human can read.
 */
interface Baseline {
  generatedAt: string;
  total: number;
  match: number;
  mismatch: number;
  results: { file: string; outcome: Outcome }[];
}

function load<T>(rel: string): T {
  const path = resolve(ROOT, rel);
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch (e: unknown) {
    console.error(`Failed to read ${rel}: ${(e as Error).message}`);
    process.exit(2);
  }
}

/** Age of an ISO-8601 stamp in days, or `null` when it is absent/unparseable. */
function ageInDays(stamp: string | undefined): number | null {
  if (!stamp) return null;
  const then = Date.parse(stamp);
  if (Number.isNaN(then)) return null;
  return (Date.now() - then) / 86_400_000;
}

function project(report: Report): Baseline {
  const results = report.results
    .map((r) => ({ file: r.file, outcome: r.outcome }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return {
    generatedAt: report.generatedAt ?? new Date().toISOString(),
    total: report.total,
    match: report.match,
    mismatch: report.mismatch,
    results,
  };
}

/** Outcome-only identity of a baseline — what a promotion decision compares. */
function outcomeKey(results: { file: string; outcome: Outcome }[]): string {
  return results.map((r) => `${r.file}\t${r.outcome}`).join("\n");
}

// ── `--update`: refresh the committed baseline from a fresh report ─────────
function update(): never {
  const report = load<Report>(REPORT_REL);
  const next = project(report);
  const baselinePath = resolve(ROOT, BASELINE_REL);

  let reason = "";
  if (!existsSync(baselinePath)) {
    reason = "no committed baseline exists";
  } else {
    const prev = load<Baseline>(BASELINE_REL);
    if (outcomeKey(prev.results ?? []) !== outcomeKey(next.results)) {
      reason = `corpus outcomes changed (${prev.match}/${prev.total} → ${next.match}/${next.total} match)`;
    } else {
      const age = ageInDays(prev.generatedAt);
      if (age === null) reason = "baseline carries no generatedAt stamp";
      else if (age > HEARTBEAT_DAYS) reason = `heartbeat — stamp is ${age.toFixed(1)}d old (> ${HEARTBEAT_DAYS}d)`;
    }
  }

  if (!reason) {
    console.log(`diff-test baseline: unchanged — outcomes identical and stamp is within ${HEARTBEAT_DAYS}d.`);
    process.exit(0);
  }

  writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
  console.log(`diff-test baseline: updated — ${reason}.`);
  console.log(`  ${next.match}/${next.total} match, stamped ${next.generatedAt}`);
  process.exit(0);
}

// ── default: gate the current report against the committed baseline ────────
function gate(): never {
  const baseline = load<Baseline>(BASELINE_REL);
  const current = load<Report>(REPORT_REL);

  const baseByFile = new Map<string, { outcome: Outcome }>();
  for (const r of baseline.results ?? []) baseByFile.set(r.file, r);
  const curByFile = new Map<string, FileResult>();
  for (const r of current.results) curByFile.set(r.file, r);

  // New mismatches: files that PREVIOUSLY matched and NO LONGER match.
  const newRegressions: { file: string; was: string; now: string; error?: string }[] = [];
  for (const [file, was] of baseByFile) {
    if (was.outcome !== "match") continue;
    const now = curByFile.get(file);
    // Test was deleted from the corpus — not a regression, but worth noting.
    if (!now) continue;
    if (now.outcome !== "match") {
      newRegressions.push({ file, was: was.outcome, now: now.outcome, error: now.error });
    }
  }

  // New improvements: files that previously did NOT match and now match.
  const newImprovements: { file: string; was: string }[] = [];
  for (const [file, was] of baseByFile) {
    if (was.outcome === "match") continue;
    const now = curByFile.get(file);
    if (now && now.outcome === "match") newImprovements.push({ file, was: was.outcome });
  }

  const newFiles: string[] = [];
  for (const file of curByFile.keys()) {
    if (!baseByFile.has(file)) newFiles.push(file);
  }

  const age = ageInDays(baseline.generatedAt);
  const stale = age === null || age > STALE_DAYS;
  const ageText =
    age === null ? "UNKNOWN age (no generatedAt stamp)" : `${age.toFixed(1)} days old (${baseline.generatedAt})`;

  console.log("# Differential test delta");
  console.log("");
  console.log(`Baseline: ${baseline.match}/${baseline.total} match — ${ageText}`);
  console.log(`Current:  ${current.match}/${current.total} match`);
  console.log(`New corpus files: ${newFiles.length}`);
  console.log(`New regressions:  ${newRegressions.length}`);
  console.log(`New improvements: ${newImprovements.length}`);
  console.log("");

  if (newRegressions.length > 0) {
    console.log(
      stale ? "## ⚠️ Regressions vs a STALE baseline (not attributable)" : "## ❌ New regressions (delta gate FAILED)",
    );
    console.log("");
    for (const r of newRegressions) {
      const err = r.error ? `  — ${r.error.slice(0, 120)}` : "";
      console.log(`  - ${r.file}: ${r.was} → ${r.now}${err}`);
    }
    console.log("");

    if (stale) {
      console.log(
        `::warning title=diff-test-gate::baseline is ${ageText}; the ${newRegressions.length} regression(s) above span every commit merged since it was measured, so they are NOT attributable to the change under test`,
      );
      console.log("Blaming the change under test would be a guess, so this gate reports and does not fail.");
      console.log("Fix the refresh path instead — `refresh-baseline` in .github/workflows/diff-test.yml");
      console.log("re-lands this file on every push to main (#5344). To refresh by hand:");
      console.log("  pnpm run test:diff && pnpm run test:diff:gate -- --update");
      process.exit(0);
    }

    console.log("These programs matched V8 on the baseline and no longer do.");
    console.log("Either fix the regression or update the baseline if the new behaviour is intentional.");
    process.exit(1);
  }

  if (newImprovements.length > 0) {
    console.log("## ✅ New improvements");
    console.log("");
    for (const r of newImprovements.slice(0, 30)) {
      console.log(`  + ${r.file}: ${r.was} → match`);
    }
    if (newImprovements.length > 30) console.log(`  + ... ${newImprovements.length - 30} more`);
    console.log("");
    console.log("The `refresh-baseline` job banks these into the committed baseline on the next push to main.");
    console.log("");
  }

  if (stale) {
    console.log(
      `::warning title=diff-test-gate::baseline is ${ageText} — the refresh path (#5344) is not keeping it current, so this run gated a delta spanning many commits.`,
    );
    console.log("");
  }

  console.log("✓ No new regressions. Safe to merge.");
  process.exit(0);
}

if (process.argv.slice(2).includes("--update")) update();
gate();
