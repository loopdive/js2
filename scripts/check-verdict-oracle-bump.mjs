#!/usr/bin/env node
// check-verdict-oracle-bump.mjs — a test262 VERDICT-LOGIC change must bump the
// #2096 ORACLE_VERSION (or consciously exempt itself). (#3003)
//
// WHY THIS EXISTS (the queue-wedge it prevents):
//   When a PR changes how a per-test test262 result is SCORED — the verdict
//   logic (pass/fail/compile_error), the negative-test matcher, or a vacuity/
//   honesty reclassifier — the new-policy results diff against the OLD-policy
//   committed baseline as a mass pass→fail cluster. If the change does NOT bump
//   the `oracle_version`, the push-to-main run's Catastrophic regression guard
//   (#1668) sees the huge delta and FAILS → `promote-baseline` never runs →
//   the baseline stays old-policy → EVERY subsequent merge_group diffs
//   new-policy-vs-old-policy → the identical cluster signature → auto-park →
//   the whole merge queue wedges against a baseline that can only be fixed by
//   the very promote the guard is blocking. This happened TWICE in 2026-07 (the
//   −439 strict-negative-verdict change and PR #2463's vacuity scorer). See the
//   postmortem in plan/issues/3003-*.md.
//
//   Bumping the oracle is the clean fix: `diff-test262.ts` REFUSES a
//   cross-oracle_version diff (unless ORACLE_REBASE=1), so the guards treat the
//   change as a re-baseline instead of catastrophic-blocking the promote.
//
// THIS GATE (wired into the required `quality` job): for the current PR/commit
// diff vs origin/main —
//   • if a verdict-logic file changed in a way that touches VERDICT-SIGNAL
//     lines (a status verdict literal, the `vacuous` marker, the negative-test
//     matcher, classifyError, etc.), AND
//   • the diff does NOT raise ORACLE_VERSION (in tests/test262-oracle-version.ts),
//     AND
//   • the diff carries no `oracle-version-exempt:` in-diff override,
//   → HARD FAIL, pointing at the bump procedure.
//
// FALSE-POSITIVE DISCIPLINE: the mixed files (test262-worker.mjs,
// test262-shared.ts, the runners) contain a LOT of non-verdict code (worker
// recycling, disk cache, pool plumbing, comments). A change there only trips
// the gate if the CHANGED lines carry a verdict-signal token — a comment fix or
// a recycle-logic tweak passes clean. And a legit verdict-touching change that
// the author has confirmed flips ZERO existing rows (e.g. the #2912
// dead-ternary deletion) can pass by adding an in-diff comment:
//     // oracle-version-exempt: <reason no existing rows flip>
// The override lives in the DIFF (not the PR body) on purpose: the PR body is
// absent in `merge_group`, so a body-based override would pass on `pull_request`
// then FAIL in the queue — re-creating the very wedge this gate prevents.
//
// Usage:
//   node scripts/check-verdict-oracle-bump.mjs            # gate (CI)
//   node scripts/check-verdict-oracle-bump.mjs --base REF # diff against REF
//   node scripts/check-verdict-oracle-bump.mjs --json
//
// Safe by construction: if the diff base can't be resolved it falls back to
// HEAD^, then exits 0 with a note — it never blocks a build it can't reason
// about.

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ── The authoritative verdict-logic surface (grep-derived, #3003) ───────────
// PURE: files whose entire job is verdict logic — ANY substantive (non-comment)
// changed line is a verdict signal.
export const PURE_VERDICT_FILES = ["scripts/negative-verdict.mjs", "scripts/test262-runtime-verdict.mjs"];

// MIXED: files that compute per-test verdicts but also carry lots of unrelated
// machinery — only a change to a VERDICT-SIGNAL line counts.
export const MIXED_VERDICT_FILES = [
  "scripts/test262-worker.mjs",
  "tests/test262-shared.ts",
  "tests/test262-vitest.test.ts",
  "tests/test262-runner.ts",
];

// The single source of truth for the oracle version (#2096). Raising the
// integer here is the "bump" this gate looks for.
export const ORACLE_FILE = "tests/test262-oracle-version.ts";

// A changed line is a verdict signal when it SETS a verdict status literal,
// touches the vacuity marker, or touches the negative-test / error
// classification verdict machinery. The distinguisher is what FOLLOWS `status`:
// a `status:` object field or a `status =` assignment (single `=`, negative
// lookahead on `==`) to a known verdict literal is a SET; `status ===`,
// `status ==`, `status;`, `.status`-property READs are NOT matched — so report
// aggregation or a guard that merely COMPARES a status does not trip the gate.
// The `[^\n]*?` between the `status:`/`status =` anchor and the verdict literal
// lets a CONDITIONAL verdict match too — e.g. the historical dead ternary
// `status: hasEarlyError ? "pass" : "pass"` (#2912) — while staying on one line.
export const VERDICT_SIGNAL_RE =
  /\bvacuous\b|status\s*(?::|=(?!=))[^\n]*?["'`](?:pass|fail|compile_error|compile_timeout|runtime_error|timeout|skip|error|todo)["'`]|\bnegativeCompile(?:ErrorMatches|SucceededVerdict)\b|\bclassifyError\b|\bnegative\.type\b|\bexpectedErrorType\b|\bES_EARLY_ERROR_CODES\b/;

// In-diff override token (see header). Placed as a comment next to the change.
export const OVERRIDE_RE = /oracle-version-exempt\s*:/i;

const ALL_VERDICT_FILES = [...PURE_VERDICT_FILES, ...MIXED_VERDICT_FILES];

// Non-substantive = blank or a pure comment line. Used for the PURE files so a
// doc/comment tweak to negative-verdict.mjs does not demand an oracle bump.
function isSubstantive(line) {
  const t = line.trim();
  if (t === "") return false;
  if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*") || t.startsWith("*/")) return false;
  return true;
}

/**
 * Pure evaluator — no git, no fs. Unit-testable (tests/issue-3003.test.ts).
 *
 * @param {{
 *   changedFiles: string[],
 *   addedLinesByFile: Record<string, string[]>,   // '+' lines (no prefix)
 *   removedLinesByFile: Record<string, string[]>, // '-' lines (no prefix)
 *   baseOracle: number,
 *   headOracle: number,
 * }} input
 * @returns {{ triggered: boolean, signals: Array<{file:string,line:string}>,
 *   bumped: boolean, override: boolean, verdict: "pass"|"warn"|"fail",
 *   baseOracle: number, headOracle: number }}
 */
export function evaluateVerdictOracle(input) {
  const { changedFiles, addedLinesByFile, removedLinesByFile, baseOracle, headOracle } = input;

  const verdictFiles = changedFiles.filter((f) => ALL_VERDICT_FILES.includes(f));
  if (verdictFiles.length === 0) {
    return { triggered: false, signals: [], bumped: false, override: false, verdict: "pass", baseOracle, headOracle };
  }

  const signals = [];
  for (const f of verdictFiles) {
    const changed = [...(addedLinesByFile[f] || []), ...(removedLinesByFile[f] || [])];
    if (PURE_VERDICT_FILES.includes(f)) {
      const hit = changed.find((l) => isSubstantive(l));
      if (hit) signals.push({ file: f, line: hit.trim() });
    } else {
      const hit = changed.find((l) => VERDICT_SIGNAL_RE.test(l));
      if (hit) signals.push({ file: f, line: hit.trim() });
    }
  }

  if (signals.length === 0) {
    // Verdict-logic files changed, but only in incidental (non-verdict) lines.
    return { triggered: true, signals: [], bumped: false, override: false, verdict: "pass", baseOracle, headOracle };
  }

  const bumped = Number(headOracle) > Number(baseOracle);
  // Override must be an ADDED line (present in the HEAD tree), scanned across
  // every changed file so the exemption can sit wherever it reads best.
  const override = Object.values(addedLinesByFile).some((lines) => lines.some((l) => OVERRIDE_RE.test(l)));

  let verdict;
  if (bumped) verdict = "pass";
  else if (override) verdict = "warn";
  else verdict = "fail";

  return { triggered: true, signals, bumped, override, verdict, baseOracle, headOracle };
}

// ── CLI: gather git inputs, then delegate to evaluateVerdictOracle ──────────

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const opt = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const JSON_OUT = has("--json");
const BASE_REF = opt("--base", process.env.VERDICT_ORACLE_BASE || "origin/main");
const REPO = process.env.REPO_ROOT || process.cwd();

function tryGit(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], cwd: REPO });
  } catch {
    return null;
  }
}

// Parse the integer `export const ORACLE_VERSION = N;` out of the oracle file
// text. Returns 0 when the file/const is absent (first introduction).
function parseOracle(text) {
  if (!text) return 0;
  const m = text.match(/export\s+const\s+ORACLE_VERSION\s*=\s*(\d+)/);
  return m ? Number(m[1]) : 0;
}

// Split a `git diff --unified=0` blob into +/- content lines per intent.
function diffLines(base, file) {
  const blob = tryGit(`git diff --unified=0 ${base}...HEAD -- ${file}`);
  const added = [];
  const removed = [];
  if (!blob) return { added, removed };
  for (const raw of blob.split("\n")) {
    if (raw.startsWith("+++") || raw.startsWith("---") || raw.startsWith("@@")) continue;
    if (raw.startsWith("+")) added.push(raw.slice(1));
    else if (raw.startsWith("-")) removed.push(raw.slice(1));
  }
  return { added, removed };
}

function resolveBase() {
  for (const ref of [BASE_REF, "HEAD^"]) {
    // A ref resolves iff we can name-only-diff against it.
    if (tryGit(`git diff --name-only ${ref}...HEAD`) !== null) return ref;
  }
  return null;
}

function log(s) {
  if (!JSON_OUT) console.log(s);
}

function main() {
  const base = resolveBase();
  if (base === null) {
    log("check-verdict-oracle-bump: could not resolve a diff base — skipping (no build block).");
    if (JSON_OUT) console.log(JSON.stringify({ skipped: "no diff base", verdict: "pass" }));
    process.exit(0);
  }

  const nameOnly = tryGit(`git diff --name-only --diff-filter=ACM ${base}...HEAD`) || "";
  const changedFiles = nameOnly
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const addedLinesByFile = {};
  const removedLinesByFile = {};
  for (const f of changedFiles) {
    if (!ALL_VERDICT_FILES.includes(f)) continue;
    const { added, removed } = diffLines(base, f);
    addedLinesByFile[f] = added;
    removedLinesByFile[f] = removed;
  }

  const baseOracle = parseOracle(tryGit(`git show ${base}:${ORACLE_FILE}`));
  const headOracle = parseOracle(
    existsSync(join(REPO, ORACLE_FILE)) ? readFileSync(join(REPO, ORACLE_FILE), "utf8") : "",
  );

  const result = evaluateVerdictOracle({ changedFiles, addedLinesByFile, removedLinesByFile, baseOracle, headOracle });

  if (JSON_OUT) {
    console.log(JSON.stringify({ base, ...result }, null, 2));
    process.exit(result.verdict === "fail" ? 1 : 0);
  }

  log(`check-verdict-oracle-bump (#3003): diff vs ${base}; ORACLE_VERSION ${baseOracle} → ${headOracle}.`);

  if (!result.triggered) {
    log("  ✓ no verdict-logic files changed.");
    process.exit(0);
  }
  if (result.signals.length === 0) {
    log("  ✓ verdict-logic file(s) changed, but no verdict-signal lines — no oracle bump required.");
    process.exit(0);
  }

  log("  verdict-signal changes detected:");
  for (const s of result.signals) log(`    • ${s.file}: ${s.line}`);

  if (result.verdict === "pass") {
    log(`  ✓ ORACLE_VERSION bumped ${baseOracle} → ${headOracle} — the guards will treat this as a re-baseline.`);
    process.exit(0);
  }
  if (result.verdict === "warn") {
    log("  ⚠ verdict-signal change WITHOUT an oracle bump, but carries an `oracle-version-exempt:` override.");
    log("    Trusting the author's assertion that ZERO existing rows flip. If any row DOES flip, the merge");
    log("    queue will wedge on the old-policy baseline (see #3003) — bump ORACLE_VERSION instead.");
    process.exit(0);
  }

  log("");
  log("  ✖ FAIL: a test262 verdict-logic change does NOT bump ORACLE_VERSION and has no override.");
  log("");
  log("  A change to how a per-test result is SCORED diffs new-policy-vs-old-policy as a mass");
  log("  pass→fail cluster. Without an oracle bump this trips the #1668 catastrophic guard on the");
  log("  push-to-main run, `promote-baseline` never runs, and the merge queue WEDGES (#3003).");
  log("");
  log("  Do ONE of:");
  log(`    (a) Bump ORACLE_VERSION in ${ORACLE_FILE} (increment the integer + append to`);
  log("        ORACLE_VERSION_HISTORY). A FORWARD bump auto-rebases the diff gate (#3086 — no env");
  log("        var needed; ORACLE_REBASE=1 is only for backward/local diffs). If the intentional");
  log("        reclassification exceeds the 25-test rebase drift tolerance, ALSO declare a");
  log("        PR-scoped ceiling in your PR's own issue file frontmatter (#3303):");
  log("          regressions-allow:");
  log("            count: <N>");
  log('            reason: "<why these flips are honest — cite the issue>"');
  log("        This is the clean path.");
  log("    (b) If you have CONFIRMED this change flips ZERO existing rows, add an in-diff comment");
  log("        `// oracle-version-exempt: <reason>` next to the change to consciously override.");
  log("");
  process.exit(1);
}

// Only run the CLI when invoked directly (not when imported by the test).
if (process.argv[1] && process.argv[1].endsWith("check-verdict-oracle-bump.mjs")) {
  main();
}
