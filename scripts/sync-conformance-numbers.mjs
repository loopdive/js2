#!/usr/bin/env node
/**
 * sync-conformance-numbers.mjs
 *
 * Reads the canonical test262 summary from
 * `benchmarks/results/test262-current.json` and propagates the headline
 * pass/total/percentage numbers into every consumer markdown file.
 *
 * Each target file must contain a paired anchor block:
 *
 *   <!-- AUTO:conformance-start -->
 *   ...generated content (overwritten by this script)...
 *   <!-- AUTO:conformance-end -->
 *
 * Files lacking the anchor pair are left untouched and reported as an
 * error — this script refuses to guess where the block belongs, so it
 * cannot blow away unrelated text.
 *
 * Modes:
 *   (default)  Rewrite anchor blocks in place. Exits 0 on success, 1 on
 *              malformed inputs (missing anchors, bad JSON, etc).
 *   --check    Do not write. Exit non-zero if any file would change.
 *              Used by CI to fail PRs that would drift the numbers.
 *
 * Idempotent: re-running with no JSON change produces a clean diff.
 *
 * See issue #1522.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_PATH = resolve(ROOT, "benchmarks/results/test262-current.json");

const START = "<!-- AUTO:conformance-start -->";
const END = "<!-- AUTO:conformance-end -->";

/** Files we manage. Path is relative to repo root. */
const TARGETS = ["ROADMAP.md", "plan/goals/goal-graph.md", "README.md", "CLAUDE.md"];

function fmtNumber(n) {
  return Number(n).toLocaleString("en-US");
}

function fmtPercent(pass, total) {
  if (!total) return "0.0";
  return ((pass / total) * 100).toFixed(1);
}

function loadReport() {
  if (!existsSync(REPORT_PATH)) {
    throw new Error(
      `test262 report not found at ${REPORT_PATH} — run \`pnpm run test:262\` or wait for CI to refresh it.`,
    );
  }
  const raw = readFileSync(REPORT_PATH, "utf8");
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse ${REPORT_PATH}: ${err.message}`);
  }
  const summary = json.summary || {};
  if (typeof summary.pass !== "number" || typeof summary.total !== "number") {
    throw new Error(
      `Malformed test262 report: missing summary.pass / summary.total. Keys present: ${Object.keys(summary).join(", ")}`,
    );
  }
  return {
    pass: summary.pass,
    total: summary.total,
  };
}

/**
 * Build the block contents that go between the anchor comments.
 * Single source of truth for the wording — every target file gets the
 * exact same line so they cannot diverge.
 */
function renderBlock(report) {
  const passStr = fmtNumber(report.pass);
  const totalStr = fmtNumber(report.total);
  const pct = fmtPercent(report.pass, report.total);
  // Render ONLY the stable pass/total/percentage — no volatile suffix.
  //
  // The earlier fix here dropped the baseline *timestamp* because the
  // forced-baseline-refresh bot bumped it ~hourly with no change to
  // pass/total, making `sync:conformance:check` flag drift on every open PR
  // and perpetually block the merge queue (#1522). The `— baseline <sha>`
  // suffix has the *same* defect: promote-baseline rewrites it into CLAUDE.md,
  // README.md, ROADMAP.md and goal-graph.md on EVERY push to main, so the sha
  // changes even when pass/total are unchanged. Every open PR that had merged
  // main once then conflicted on this single line the next time main advanced
  // — stranding the whole queue as DIRTY (the 2026-06-18 6-PR pile-up).
  //
  // Dropping the sha makes the line a pure function of pass/total: all
  // branches and main render an IDENTICAL string for a given count, so a sha
  // bump no longer diverges anything, and a real count change resolves
  // cleanly via 3-way merge (the branch line equals the merge-base line, so
  // git takes main's side without a conflict). The baseline sha is still
  // authoritative in benchmarks/results/test262-current.json (committed) and
  // surfaced on the landing page — it does not belong in branch-merged prose.
  return `**test262 conformance**: ${passStr} / ${totalStr} (${pct} %)`;
}

/**
 * Replace the contents between START and END in `text` with `body`.
 * Returns the new text. Throws if the anchor pair is missing or malformed.
 */
function replaceAnchorBlock(text, body, label) {
  const startIdx = text.indexOf(START);
  const endIdx = text.indexOf(END);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `${label}: missing anchor pair. Expected both \`${START}\` and \`${END}\`. ` +
        `Add the anchors manually first; this script refuses to guess where to write.`,
    );
  }
  if (endIdx < startIdx) {
    throw new Error(`${label}: \`${END}\` appears before \`${START}\`.`);
  }
  // Count to ensure exactly one of each.
  const startCount = text.split(START).length - 1;
  const endCount = text.split(END).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `${label}: expected exactly one START and one END anchor, found ${startCount} START / ${endCount} END.`,
    );
  }
  const before = text.slice(0, startIdx + START.length);
  const after = text.slice(endIdx);
  return `${before}\n${body}\n${after}`;
}

function processFile(relPath, report, { check }) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error(`Target file missing: ${relPath}`);
  }
  const orig = readFileSync(abs, "utf8");
  const body = renderBlock(report);
  const next = replaceAnchorBlock(orig, body, relPath);
  if (next === orig) {
    return { path: relPath, changed: false };
  }
  if (!check) {
    writeFileSync(abs, next, "utf8");
  }
  return { path: relPath, changed: true };
}

function main() {
  const check = process.argv.includes("--check");
  let report;
  try {
    report = loadReport();
  } catch (err) {
    console.error(`[sync-conformance] ${err.message}`);
    process.exit(1);
  }

  const errors = [];
  const results = [];
  for (const t of TARGETS) {
    try {
      results.push(processFile(t, report, { check }));
    } catch (err) {
      errors.push({ path: t, message: err.message });
    }
  }

  for (const e of errors) {
    console.error(`[sync-conformance] ${e.path}: ${e.message}`);
  }

  const changed = results.filter((r) => r.changed);
  for (const r of results) {
    const marker = r.changed ? (check ? "DRIFT" : "wrote") : "ok";
    console.log(`[sync-conformance] ${marker}  ${r.path}`);
  }

  if (errors.length > 0) {
    process.exit(1);
  }
  if (check && changed.length > 0) {
    console.error(
      `[sync-conformance] --check failed: ${changed.length} file(s) would change. ` +
        `Run \`pnpm run sync:conformance\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`[sync-conformance] done. ${changed.length} updated, ${results.length - changed.length} unchanged.`);
}

main();
