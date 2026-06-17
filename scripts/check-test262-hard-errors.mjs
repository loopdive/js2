#!/usr/bin/env node
/**
 * #1853 — test262 hard-error stability gate.
 *
 * Coverage and stability are different signals. "We don't support `Proxy` yet"
 * is a roadmap fact; "we crashed / emitted malformed Wasm compiling a `for`
 * loop" is a BUG. A dashboard that folds compiler-error / malformed-output into
 * the same not-passing total as unsupported-feature can't see a stability
 * regression hiding behind an expected gap.
 *
 * The test262 runner now tags those bug outcomes with `hard_error_kind`
 * (`malformed_wasm` — the compiler reported success but the Wasm engine rejected
 * the binary, incl. #1850 verifier-failure-on-a-claimed-function; or
 * `missing_test_export` — compile+instantiate succeeded but the required `test`
 * export is missing). `build-test262-report.mjs` aggregates them into the
 * committed summary's `hard_errors` map, separately from `error_categories`
 * (coverage). This gate compares that map against a committed baseline and
 * FAILS on growth — the hard-error bucket must stay near-zero; any increase is
 * a release-blocking regression, not a coverage statistic.
 *
 * Mechanism mirrors the IR-fallback ratchet (`scripts/check-ir-fallbacks.ts`)
 * and the AnyValue box-site gate: per-kind counts vs. a committed baseline,
 * growth fails, shrink auto-ratchets with `--update-on-decrease`.
 *
 * Reads the committed summary (no test262 run needed), so it is cheap enough to
 * run in the `quality` job. The summary is refreshed by the `promote-baseline`
 * job on every push to main, so the gate sees the current main hard-error
 * count; a PR that introduces a new malformed-Wasm bug trips it once its
 * sharded report is promoted, and the per-PR regression gate already catches
 * the pass→compile_error flips in the same run.
 *
 * Usage:
 *   node scripts/check-test262-hard-errors.mjs                  # fail on growth (committed summary)
 *   node scripts/check-test262-hard-errors.mjs --update         # write current counts
 *   node scripts/check-test262-hard-errors.mjs --update-on-decrease
 *   node scripts/check-test262-hard-errors.mjs --summary <path> # override summary file
 *   node scripts/check-test262-hard-errors.mjs --jsonl <path>   # count from a raw results JSONL
 *
 * `--jsonl` is the PR-time enforcement path: the per-PR sharded run produces a
 * merged results JSONL with `hard_error_kind` rows, and this counts them
 * directly so a PR that introduces a new malformed-Wasm bug fails the gate
 * (the committed summary is only refreshed post-merge, so `--summary` alone
 * can't see a PR's new hard errors).
 */
import { readFileSync, writeFileSync } from "fs";

const SUMMARY_PATH = new URL("../benchmarks/results/test262-current.json", import.meta.url).pathname;
const BASELINE_PATH = new URL("./test262-hard-error-baseline.json", import.meta.url).pathname;

const args = process.argv.slice(2);
const update = args.includes("--update");
const updateOnDecrease = args.includes("--update-on-decrease");
const summaryArgIdx = args.indexOf("--summary");
const jsonlArgIdx = args.indexOf("--jsonl");
const summaryPath = summaryArgIdx >= 0 ? args[summaryArgIdx + 1] : SUMMARY_PATH;
const jsonlPath = jsonlArgIdx >= 0 ? args[jsonlArgIdx + 1] : undefined;

function readHardErrors(path) {
  let summary;
  try {
    summary = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    console.error(`check-test262-hard-errors: cannot read summary ${path}: ${err.message}`);
    console.error("This gate reads the committed test262 summary; run from a checkout that has it.");
    process.exit(2);
  }
  // `hard_errors` is absent on summaries generated before #1853 — treat as empty
  // (zero hard errors), which is also the desired near-zero target.
  return summary.hard_errors && typeof summary.hard_errors === "object" ? summary.hard_errors : {};
}

function countHardErrorsFromJsonl(path) {
  let text;
  try {
    text = readFileSync(path, "utf-8");
  } catch (err) {
    console.error(`check-test262-hard-errors: cannot read JSONL ${path}: ${err.message}`);
    process.exit(2);
  }
  const counts = {};
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // tolerate a malformed line rather than abort the gate
    }
    const kind = rec.hard_error_kind;
    if (kind) counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
}

const current = jsonlPath ? countHardErrorsFromJsonl(jsonlPath) : readHardErrors(summaryPath);

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
} catch {
  // first run — no baseline yet
}

if (update) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log("test262 hard-error baseline written:", JSON.stringify(current));
  process.exit(0);
}

const grown = [];
const shrank = [];
const allKinds = new Set([...Object.keys(baseline), ...Object.keys(current)]);
for (const kind of allKinds) {
  const was = baseline[kind] ?? 0;
  const now = current[kind] ?? 0;
  if (now > was) grown.push(`  ${kind}: ${was} → ${now}`);
  else if (now < was) shrank.push(`  ${kind}: ${was} → ${now}`);
}

if (grown.length > 0) {
  console.error("test262 hard-error gate FAILED — the malformed-Wasm / hard-error bucket grew:");
  console.error(grown.join("\n"));
  console.error(
    "\nThe compiler produced output the Wasm engine rejected (or dropped the\n" +
      "`test` export) on more tests than the baseline. This is a STABILITY\n" +
      "regression (a bug), not a coverage gap — fix the codegen so the binary\n" +
      "validates, rather than refreshing this baseline. See #1853 / #1850.\n" +
      "If a hard error was legitimately reclassified, refresh the baseline:\n" +
      "  node scripts/check-test262-hard-errors.mjs --update",
  );
  process.exit(1);
}

if (shrank.length > 0) {
  if (updateOnDecrease) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log("test262 hard-error baseline ratcheted down:\n" + shrank.join("\n"));
  } else {
    console.log("test262 hard-error bucket shrank (run --update-on-decrease to bank it):\n" + shrank.join("\n"));
  }
}

const total = Object.values(current).reduce((sum, n) => sum + n, 0);
console.log(`test262 hard-error gate: OK (${total} hard errors, no growth vs. baseline).`);
