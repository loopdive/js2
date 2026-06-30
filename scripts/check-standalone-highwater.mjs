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
//   { "pass": <host_free int>, "host_free_pass": <host_free int>,
//     "official_pass": <host_free official>, "official_total": <int>,
//     "sha": "<commit>", "generated_at": "<iso>", "tolerance": 50 }
//   (#2879 §2: `pass` here is the host-free count; re-baselined from the leaky
//    ~26k to the honest ~12.9k with stakeholder sign-off — the headline halves.)
//   (#2889: every write also emits the explicit, self-describing `host_free_pass`
//    field — `pass` is kept == it for back-compat. The field is what lets the
//    WRITE side refuse to clobber the honest mark with a stale leaky number.)
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

/**
 * (#2889) STRICT host-free WRITE reader — the value used to RATCHET the mark.
 *
 * Unlike `passFromReport` (the gate READ, which deliberately falls back to the
 * leaky `pass` so the gate never crashes mid-rollout), the WRITE path must
 * NEVER ratchet the high-water mark from a leaky pass. A report that lacks
 * `host_free_pass` (a pre-#2879-§1 report shape, or one whose rows dropped the
 * `host_import_leak_class`) would otherwise let the leaky ~26k inflate the
 * honest ~12.9k mark and breach every later standalone PR — exactly the
 * `d4bc147d3` clobber. So read host_free_pass STRICTLY here and return `null`
 * when it is absent, signalling "refuse to raise".
 *
 * @param {string} reportPath
 * @returns {number|null} host-free full-corpus pass, or null if not present
 */
export function hostFreeFromReport(reportPath) {
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    const hf = report?.full_summary?.host_free_pass ?? report?.summary?.host_free_pass;
    return typeof hf === "number" ? hf : null;
  } catch {
    return null;
  }
}

/**
 * (#2889) STRICT host-free OFFICIAL-scope reader for the WRITE path. Reads only
 * `official_summary.host_free_pass` (no leaky fallback); returns null when
 * absent so the write never records a leaky official number.
 *
 * @param {string} reportPath
 * @returns {{pass:number, total:number}|null}
 */
export function officialHostFreeFromReport(reportPath) {
  try {
    const report = JSON.parse(readFileSync(reportPath, "utf-8"));
    const o = report?.official_summary;
    if (o && typeof o.host_free_pass === "number" && typeof o.total === "number") {
      return { pass: o.host_free_pass, total: o.total };
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
 * (#2889) The authoritative host-free count stored in a committed mark.
 * Prefers the explicit `host_free_pass` field (every #2889+ write emits it);
 * falls back to `pass` for marks written before the field existed (where, by
 * the #2879 §2 convention, `pass` already held the host-free count).
 *
 * @param {{pass?:number, host_free_pass?:number}|null} mark
 * @returns {number}
 */
export function markHostFree(mark) {
  return mark?.host_free_pass ?? mark?.pass ?? 0;
}

/**
 * Evaluate the current pass count against the committed mark.
 *
 * @param {number} pass current standalone host-free pass count
 * @param {{pass:number, host_free_pass?:number, tolerance?:number}|null} mark committed high-water
 * @param {number} tolerance slack below the mark
 * @returns {{ ok: boolean, floor: number, delta: number, mark: number }}
 */
export function evaluate(pass, mark, tolerance) {
  // No mark yet → nothing to breach; treat as a pass (the --update path seeds it).
  if (!mark) return { ok: true, floor: 0, delta: pass, mark: 0 };
  const tol = mark.tolerance ?? tolerance;
  const markPass = markHostFree(mark);
  const floor = markPass - tol;
  return { ok: pass >= floor, floor, delta: pass - markPass, mark: markPass };
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
    // (#2889) WRITE side — STRICT host-free ratchet. The mark is RAISED only
    // from a genuine host-free measurement read STRICTLY (no leaky-`pass`
    // fallback). This is the asymmetry that closes the d4bc147d3 clobber: the
    // gate READ above may fall back to the leaky `pass` (safe — a leaky number
    // ≥ an honest floor never false-breaches), but if the WRITE ratcheted on a
    // leaky pass it would inflate the honest ~12.9k mark back to the leaky
    // ~26k and breach every later standalone PR. So:
    //   • a report lacking `host_free_pass` (pre-#2879-§1 shape, or rows that
    //     dropped the leak class) → REFUSE to touch the file (no raise).
    //   • every write emits an explicit `host_free_pass` field (== `pass`) so a
    //     stale checkout can only ever hold an honest host-free mark — a leaky
    //     number can never re-enter the file.
    const hostFree = args.report
      ? hostFreeFromReport(resolve(args.report))
      : // --pass escape hatch: the caller asserts N is the host-free count.
        Number.isFinite(args.pass)
        ? args.pass
        : null;

    if (hostFree === null) {
      console.warn(
        "[standalone-highwater] report has no host_free_pass (leaky/old report shape) — NOT raising the mark " +
          "(refusing to clobber the honest host-free high-water with a leaky pass; see #2889).",
      );
    } else if (!mark || hostFree > markHostFree(mark)) {
      const official = args.report ? officialHostFreeFromReport(resolve(args.report)) : null;
      const next = {
        // `pass` kept == host-free for back-compat (evaluate / the #2879 test
        // read `pass`); `host_free_pass` is the explicit, self-describing field
        // (#2889) that makes a future leaky clobber structurally impossible.
        pass: hostFree,
        host_free_pass: hostFree,
        // official-scope (no-proposals) HOST-FREE count for the statusline /
        // "without proposals" rate — absent on older report shapes.
        ...(official ? { official_pass: official.pass, official_total: official.total } : {}),
        sha: args.sha ?? mark?.sha ?? "unknown",
        generated_at: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
        tolerance: mark?.tolerance ?? args.tolerance,
      };
      writeFileSync(HIGHWATER_PATH, `${JSON.stringify(next, null, 2)}\n`);
      console.log(
        `[standalone-highwater] raised host-free mark ${markHostFree(mark)} → ${hostFree} (commit ${next.sha}).`,
      );
    } else {
      console.log(
        `[standalone-highwater] mark unchanged (host-free ${hostFree} ≤ mark ${markHostFree(mark)}); within tolerance.`,
      );
    }
  }

  process.exit(0);
}

// Only run as a script, not when imported by tests.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
