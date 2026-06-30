#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #2097 — absolute standalone pass-count floor (high-water-mark backstop).
//
// Why this exists:
//   The #1897 standalone regression gate is a MOVING floor — `promote-baseline`
//   re-seeds it from the new baseline on every push to main. So a sequence of
//   small net-negative PRs, each within the per-PR tolerance (−15), compounds
//   without any single gate catching the downward trend. This script adds an
//   ABSOLUTE reference: a committed high-water mark that the standalone pass
//   count must stay within `TOLERANCE` of, regardless of how the rolling
//   baseline drifts. The mark only ever moves UP (auto-raised on improvement),
//   so it ratchets conformance and fails loudly on a compounding slide.
//
// Usage:
//   node scripts/check-standalone-highwater.mjs --report <merged-report.json>
//       Assert pass >= highwater.pass - TOLERANCE. Exit 1 on breach.
//   node scripts/check-standalone-highwater.mjs --report <r.json> --update
//       Same assert, then RAISE the committed mark if pass improved on it.
//       (Intended for the post-merge promote-baseline job.)
//   node scripts/check-standalone-highwater.mjs --pass <N> [...]
//       Take the pass count directly instead of reading a report.
//
// Inputs:
//   The report is the merged standalone report produced by
//   `scripts/build-test262-report.mjs --target standalone`. We read
//   `full_summary.host_free_pass` (the full corpus: standard + annex_b +
//   proposals), matching the row count in `test262-standalone-current.jsonl`.
//   (#2879 §2) host_free_pass = status==pass AND host-free (no `env::` import).
//
// (#2879 §4) Carrier-migration crediting — why the floor keys on host_free_pass:
//   The carrier work (#2864–#2867 generator/async-gen/symbol/promise carriers,
//   the $Object dynamic reader) converts host-satisfied "leaky passes" into
//   native standalone passes. Against a raw-`pass` floor those migrations look
//   like regressions: a leaky pass replaced by an in-progress native carrier can
//   drop to fail *while removing a host dependency*. Keying the floor on
//   host_free_pass fixes the accounting:
//     • leaky pass → host-free pass  ⇒  +1 host_free_pass (scored as PROGRESS,
//       even though raw `pass` is unchanged).
//     • leaky pass → native carrier not yet complete → fail  ⇒  host_free_pass
//       UNCHANGED (the leaky pass never counted), raw `pass` −1 — and the floor
//       is on host_free_pass, so it does NOT breach. A temporary raw-`pass` dip
//       is EXPECTED for a mid-flight carrier PR, not a regression.
//   dev-self-merge should report Δhost_free_pass and treat Δhost_free_pass ≥ 0
//   (not Δpass) as the standalone pass/fail signal.
//
// High-water file: benchmarks/results/test262-standalone-highwater.json
//   { "pass": <host_free int>, "sha": "<commit>", "generated_at": "<iso>", "tolerance": 50 }
//   (#2879 §2: `pass` here is the host-free count; re-baselined from the leaky
//    ~26k to the honest ~12.9k with stakeholder sign-off — the headline halves.)
//
// Exit codes:
//   0 — pass within tolerance of the mark (and, with --update, mark refreshed)
//   1 — pass is below high-water − tolerance (compounding regression)
//   2 — internal error (missing/garbled files, bad args)

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
export const HIGHWATER_PATH = resolve(REPO_ROOT, "benchmarks/results/test262-standalone-highwater.json");

// Default slack below the mark — matches the #1897 per-PR tolerance order of
// magnitude (a single PR's legitimate churn / runner flake) but is absolute,
// not relative to a moving baseline. Override with --tolerance N.
const DEFAULT_TOLERANCE = 50;

/**
 * Read the standalone **host-free** pass count from a merged report JSON.
 *
 * (#2879 §2) The standalone floor measures HOST-FREE-ness, not raw passes. In
 * `--target standalone` the runner still instantiates with the JS host runtime
 * present, so a module that emitted `env::__*` host imports passes by *leaning on
 * the host* — a "leaky pass" that doesn't actually run standalone. The floor must
 * gate on `host_free_pass` (status == pass AND no `env::` host import, i.e.
 * `host_import_leak_class` absent — the two are identical, verified exact on the
 * main baseline). This makes the carrier-migration work (#2864–#2867, the
 * `$Object` dynamic reader, …) score correctly: converting a host-satisfied leaky
 * pass into an in-progress native carrier removes a host dependency, so it lifts
 * `host_free_pass` (progress) — and a mid-flight migration that drops the raw
 * `pass` (any-imports) does NOT trip this floor, because the leaky pass it
 * replaced never counted toward `host_free_pass`.
 *
 * Prefers `full_summary.host_free_pass` (full corpus); falls back through
 * `summary.host_free_pass`, then the legacy `pass` tallies for older report
 * shapes so the gate never crashes mid-rollout.
 *
 * @param {string} reportPath
 * @returns {number}
 */
export function passFromReport(reportPath) {
  const raw = readFileSync(reportPath, "utf-8");
  const report = JSON.parse(raw);
  const pass =
    report?.full_summary?.host_free_pass ??
    report?.summary?.host_free_pass ??
    report?.full_summary?.pass ??
    report?.summary?.pass ??
    report?.summary?.by_category?.full?.pass;
  if (typeof pass !== "number") {
    throw new Error(`could not read full_summary.host_free_pass (or .pass) from ${reportPath}`);
  }
  return pass;
}

/**
 * Read the OFFICIAL-scope (no-proposals) pass/total from a merged report —
 * standard + annex_b only, i.e. the comparable "without proposals" number.
 * Returns null if the report has no official_summary.
 */
export function officialFromReport(reportPath) {
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    const o = report?.official_summary;
    // (#2879 §2) Prefer the host-free count for the official scope too, so the
    // statusline "without proposals" rate reflects host-free-ness; fall back to
    // the legacy `pass` for older report shapes.
    const pass = o?.host_free_pass ?? o?.pass;
    if (o && typeof pass === "number" && typeof o.total === "number") {
      return { pass, total: o.total };
    }
  } catch {
    /* no official_summary — older report shape */
  }
  return null;
}

/** Load the committed high-water mark, or null if it does not exist yet. */
export function loadHighwater() {
  if (!existsSync(HIGHWATER_PATH)) return null;
  return JSON.parse(readFileSync(HIGHWATER_PATH, "utf-8"));
}

/**
 * Evaluate the current pass count against the committed mark.
 *
 * @param {number} pass current standalone pass count
 * @param {{pass:number, tolerance?:number}|null} mark committed high-water
 * @param {number} tolerance slack below the mark
 * @returns {{ ok: boolean, floor: number, delta: number, mark: number }}
 */
export function evaluate(pass, mark, tolerance) {
  // No mark yet → nothing to breach; treat as a pass (the --update path seeds it).
  if (!mark) return { ok: true, floor: 0, delta: pass, mark: 0 };
  const tol = mark.tolerance ?? tolerance;
  const floor = mark.pass - tol;
  return { ok: pass >= floor, floor, delta: pass - mark.pass, mark: mark.pass };
}

function parseArgs(argv) {
  const args = {
    report: undefined,
    pass: undefined,
    update: false,
    tolerance: DEFAULT_TOLERANCE,
    sha: process.env.GITHUB_SHA,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--report") args.report = argv[++i];
    else if (a === "--pass") args.pass = Number(argv[++i]);
    else if (a === "--update") args.update = true;
    else if (a === "--tolerance") args.tolerance = Number(argv[++i]);
    else if (a === "--sha") args.sha = argv[++i];
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/check-standalone-highwater.mjs --report <r.json> [--update] [--tolerance N] [--sha <commit>]",
      );
      process.exit(0);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let pass;
  try {
    if (typeof args.pass === "number" && !Number.isNaN(args.pass)) {
      pass = args.pass;
    } else if (args.report) {
      pass = passFromReport(resolve(args.report));
    } else {
      console.error("fatal: pass either --report <merged-report.json> or --pass <N>.");
      process.exit(2);
    }
  } catch (e) {
    console.error(`fatal: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }

  const mark = loadHighwater();
  const { ok, floor, delta, mark: markPass } = evaluate(pass, mark, args.tolerance);
  const tol = mark?.tolerance ?? args.tolerance;

  if (!mark) {
    console.log(`[standalone-highwater] no committed mark yet; current standalone pass=${pass}.`);
  } else {
    console.log(
      `[standalone-highwater] current pass=${pass}, mark=${markPass} (floor=${floor}, tolerance=${tol}, delta=${delta >= 0 ? "+" : ""}${delta}).`,
    );
  }

  if (!ok) {
    console.error("");
    console.error(
      `::error::STANDALONE host-free pass floor breached: ${pass} < high-water ${markPass} − ${tol} = ${floor}. ` +
        `The standalone HOST-FREE pass count slid ${-delta} below the committed high-water mark (a compounding ` +
        `regression the moving #1897 per-PR gate can miss). NOTE (#2879 §4): this floor is on host_free_pass — a ` +
        `mid-flight carrier migration that only drops raw \`pass\` (any-imports) does NOT breach this; a breach here ` +
        `means host-free passes genuinely dropped. High-water set at commit ${mark.sha ?? "?"} (${mark.generated_at ?? "?"}). ` +
        `If this drop is intentional, re-seed the mark with --update on a known-good main run. See #2097 / #2879.`,
    );
    process.exit(1);
  }

  if (args.update) {
    // Ratchet UP only: never lower the committed mark here (that is the job of
    // an explicit re-seed). A net improvement raises the floor so future
    // slides are caught against the new, higher reference.
    if (!mark || pass > mark.pass) {
      const official = args.report ? officialFromReport(resolve(args.report)) : null;
      const next = {
        pass,
        // official-scope (no-proposals) count for the statusline / "without
        // proposals" rate — falls back to absent on older report shapes.
        ...(official ? { official_pass: official.pass, official_total: official.total } : {}),
        sha: args.sha ?? mark?.sha ?? "unknown",
        generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        tolerance: mark?.tolerance ?? args.tolerance,
      };
      writeFileSync(HIGHWATER_PATH, `${JSON.stringify(next, null, 2)}\n`);
      console.log(`[standalone-highwater] raised mark ${mark?.pass ?? 0} → ${pass} (commit ${next.sha}).`);
    } else {
      console.log(`[standalone-highwater] mark unchanged (current ${pass} ≤ mark ${mark.pass}); within tolerance.`);
    }
  }

  process.exit(0);
}

// Only run as a script, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
