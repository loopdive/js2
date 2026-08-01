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
 *   --check    Do not write. Exit non-zero if any file would change, and
 *              print the ACTUAL line diff of the offending anchor block,
 *              classified as either a changed conformance line or a
 *              whitespace/formatting-only difference. See #3947: the old
 *              message said only `DRIFT <file>`, which reads as "the
 *              conformance number is stale" and sent two separate
 *              investigations after a figure that had not moved — the real
 *              difference was two blank lines.
 *
 * Idempotent: re-running with no JSON change produces a clean diff.
 *
 * The generated block is deliberately emitted with a blank line on either
 * side of the body (see `replaceAnchorBlock`) so that prettier's markdown
 * formatter and this script agree byte-for-byte. Do not "tidy" those blank
 * lines away — that reintroduces #3947.
 *
 * See issues #1522 and #3947.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const REPORT_PATH = resolve(ROOT, "benchmarks/results/test262-current.json");
// Standalone (host-free) high-water mark — the pure-Wasm, no-JS-host path.
// Refreshed by CI's promote-baseline job alongside the JS-host baseline
// (see check-standalone-highwater.mjs + test262-sharded.yml). Carries the
// host-free pass counts; `official_pass`/`official_total` are the
// standard+annexB scope, matching the JS-host `summary` denominator.
const STANDALONE_PATH = resolve(ROOT, "benchmarks/results/test262-standalone-highwater.json");

const START = "<!-- AUTO:conformance-start -->";
const END = "<!-- AUTO:conformance-end -->";
// Optional second block. Files without this anchor pair are skipped, not
// errored — only the README surfaces the two-path axis today.
const SA_START = "<!-- AUTO:conformance-standalone-start -->";
const SA_END = "<!-- AUTO:conformance-standalone-end -->";

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
 * Load the standalone (host-free) high-water mark. Optional: returns null
 * (with a warning) if the file is absent or malformed, so a missing
 * standalone baseline never blocks the JS-host sync.
 */
function loadStandalone() {
  if (!existsSync(STANDALONE_PATH)) {
    console.warn(
      `[sync-conformance] standalone high-water not found at ${STANDALONE_PATH} — skipping standalone block.`,
    );
    return null;
  }
  let json;
  try {
    json = JSON.parse(readFileSync(STANDALONE_PATH, "utf8"));
  } catch (err) {
    console.warn(`[sync-conformance] failed to parse ${STANDALONE_PATH}: ${err.message} — skipping standalone block.`);
    return null;
  }
  if (typeof json.official_pass !== "number" || typeof json.official_total !== "number") {
    console.warn(
      `[sync-conformance] standalone high-water missing official_pass/official_total — skipping standalone block.`,
    );
    return null;
  }
  return { pass: json.official_pass, total: json.official_total };
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
 * Standalone (host-free) block. Same pass/total/percentage shape as the
 * JS-host block, on the same official denominator, so the two lines read as
 * a clean side-by-side of the two compile paths.
 */
function renderStandaloneBlock(report) {
  const passStr = fmtNumber(report.pass);
  const totalStr = fmtNumber(report.total);
  const pct = fmtPercent(report.pass, report.total);
  return `**standalone (host-free) test262 conformance**: ${passStr} / ${totalStr} (${pct} %)`;
}

/**
 * Extract the anchor block region (start anchor through end anchor,
 * inclusive) from `text`. Returns null when the anchors are absent.
 */
function blockRegion(text, start = START, end = END) {
  const s = text.indexOf(start);
  const e = text.indexOf(end);
  if (s === -1 || e === -1 || e < s) return null;
  return text.slice(s, e + end.length);
}

/**
 * Minimal LCS line diff, rendered unified-style. Only ever run over a single
 * anchor block (a handful of lines), so the O(n*m) table is free.
 *
 * Blank lines are rendered as `(blank line)` on purpose: the #3947 failure
 * was a blank-line-only difference, which is invisible in a diff that prints
 * an empty string for it.
 */
function diffLines(oldText, newText) {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const show = (s) => (s.trim() === "" ? "(blank line)" : s);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push(`  ${show(a[i])}`);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push(`- ${show(a[i])}`);
      i++;
    } else {
      out.push(`+ ${show(b[j])}`);
      j++;
    }
  }
  while (i < n) out.push(`- ${show(a[i++])}`);
  while (j < m) out.push(`+ ${show(b[j++])}`);
  return out;
}

/**
 * Classify why a file would change, so the failure message can name the
 * ACTUAL cause instead of an assumed one (#3947).
 *
 *   kind: "content"    — the generated line itself differs (e.g. the
 *                        conformance number really is stale). `oldLine` /
 *                        `newLine` carry the two values.
 *   kind: "formatting" — the generated line is byte-identical; only the
 *                        surrounding whitespace inside the anchors differs.
 *
 * Either way `diff` is the real line diff of the block, so a reader never has
 * to guess.
 */
function classifyChange(orig, next, body, start = START, end = END) {
  const before = blockRegion(orig, start, end);
  const after = blockRegion(next, start, end);
  const startIdx = orig.indexOf(start);
  const endIdx = orig.indexOf(end);
  const oldInner = startIdx === -1 || endIdx === -1 ? "" : orig.slice(startIdx + start.length, endIdx);
  const oldLine = oldInner.trim();
  const newLine = body.trim();
  return {
    kind: oldLine === newLine ? "formatting" : "content",
    oldLine,
    newLine,
    diff: before !== null && after !== null ? diffLines(before, after) : [],
  };
}

/**
 * Replace the contents between `start` and `end` in `text` with `body`.
 * Returns the new text. Throws if the anchor pair is missing or malformed.
 *
 * The blank line on either side of `body` is REQUIRED, not cosmetic (#3947):
 * prettier's markdown formatter inserts exactly those two blank lines, so
 * emitting them here is what stops `prettier --write` and this script from
 * mutually undoing each other. Verified against prettier 3.8 on all four
 * target files, including README.md's two adjacent anchor pairs.
 */
function replaceAnchorBlock(text, body, label, start = START, end = END) {
  const startIdx = text.indexOf(start);
  const endIdx = text.indexOf(end);
  if (startIdx === -1 || endIdx === -1) {
    throw new Error(
      `${label}: missing anchor pair. Expected both \`${start}\` and \`${end}\`. ` +
        `Add the anchors manually first; this script refuses to guess where to write.`,
    );
  }
  if (endIdx < startIdx) {
    throw new Error(`${label}: \`${end}\` appears before \`${start}\`.`);
  }
  // Count to ensure exactly one of each.
  const startCount = text.split(start).length - 1;
  const endCount = text.split(end).length - 1;
  if (startCount !== 1 || endCount !== 1) {
    throw new Error(
      `${label}: expected exactly one START and one END anchor, found ${startCount} START / ${endCount} END.`,
    );
  }
  const before = text.slice(0, startIdx + start.length);
  const after = text.slice(endIdx);
  return `${before}\n\n${body}\n\n${after}`;
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
  return { path: relPath, changed: true, detail: classifyChange(orig, next, body) };
}

/**
 * Optional standalone block. Files that lack the standalone anchor pair are
 * skipped (returns { skipped: true }) rather than erroring — only files that
 * opt in by carrying the anchor get the second line.
 */
function processStandaloneFile(relPath, report, { check }) {
  const abs = resolve(ROOT, relPath);
  if (!existsSync(abs)) {
    throw new Error(`Target file missing: ${relPath}`);
  }
  const orig = readFileSync(abs, "utf8");
  if (!orig.includes(SA_START) && !orig.includes(SA_END)) {
    return { path: relPath, skipped: true, changed: false };
  }
  const body = renderStandaloneBlock(report);
  const next = replaceAnchorBlock(orig, body, relPath, SA_START, SA_END);
  if (next === orig) {
    return { path: relPath, changed: false };
  }
  if (!check) {
    writeFileSync(abs, next, "utf8");
  }
  return { path: relPath, changed: true, detail: classifyChange(orig, next, body, SA_START, SA_END) };
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
  const standalone = loadStandalone();

  const errors = [];
  const results = [];
  for (const t of TARGETS) {
    try {
      results.push(processFile(t, report, { check }));
    } catch (err) {
      errors.push({ path: t, message: err.message });
    }
    if (standalone) {
      try {
        const r = processStandaloneFile(t, standalone, { check });
        if (!r.skipped) results.push({ ...r, path: `${r.path} (standalone)` });
      } catch (err) {
        errors.push({ path: `${t} (standalone)`, message: err.message });
      }
    }
  }

  for (const e of errors) {
    console.error(`[sync-conformance] ${e.path}: ${e.message}`);
  }

  const changed = results.filter((r) => r.changed);
  for (const r of results) {
    // #3947: never label a --check difference "DRIFT" unqualified. Under a
    // script named sync-conformance-NUMBERS that reads as "the number is
    // stale", which is a cause the script has NOT established.
    const marker = r.changed ? (check ? "DIFFERS" : "wrote") : "ok";
    console.log(`[sync-conformance] ${marker}  ${r.path}`);
  }

  if (errors.length > 0) {
    process.exit(1);
  }
  if (check && changed.length > 0) {
    // Print the ACTUAL diff and the ACTUAL classification. The two failure
    // modes have completely different triage paths, and guessing wrong costs
    // far more than printing three extra lines (#3947).
    for (const r of changed) {
      const d = r.detail;
      console.error("");
      if (!d) {
        console.error(`[sync-conformance] ${r.path}: generated block differs.`);
        continue;
      }
      if (d.kind === "content") {
        console.error(
          `[sync-conformance] ${r.path}: the generated line CHANGED — the committed value does not match ` +
            `benchmarks/results/test262-current.json.`,
        );
        console.error(`[sync-conformance]   committed: ${d.oldLine}`);
        console.error(`[sync-conformance]   generated: ${d.newLine}`);
      } else {
        console.error(
          `[sync-conformance] ${r.path}: generated block differs — WHITESPACE/FORMATTING ONLY. ` +
            `The generated line is byte-identical, so nothing about the conformance figures has changed. ` +
            `(Usual cause: a markdown formatter reflowed the block. See #3947.)`,
        );
      }
      for (const line of d.diff) {
        console.error(`[sync-conformance]   ${line}`);
      }
    }
    console.error("");
    console.error(
      `[sync-conformance] --check failed: ${changed.length} file(s) would change (block diff above). ` +
        `Run \`pnpm run sync:conformance\` and commit the result — it rewrites the whole anchor block, ` +
        `so it repairs a formatting-only difference just as it repairs a changed value.`,
    );
    process.exit(1);
  }
  console.log(`[sync-conformance] done. ${changed.length} updated, ${results.length - changed.length} unchanged.`);
}

main();
