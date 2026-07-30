// marked dogfood harness — compile + validate + differential-HTML-output.
//
// Second entry in the pinned-tarball dogfood pattern established by acorn
// (#1710/acorn-harness.mjs): a different-shaped real npm package (a
// markdown-to-HTML renderer instead of a JS parser) exercising a different
// slice of the compiler (string-heavy transform logic, regex-driven
// tokenizing, no AST marshalling needed since the observable surface is a
// single string, not an object graph).
//
// Loop:
//   1. ACQUIRE  — pinned npm-pack tarball (no run-time network); see setup-marked.mjs.
//   2. COMPILE  — feed marked's entry module through compile(src,{fileName}); record
//                 success + categorized errors.
//   3. VALIDATE — WebAssembly.compile(binary); record the first validator error verbatim.
//   4. RUN+DIFF — when the binary validates and exposes a callable parse/marked
//                 export, run it over a markdown fixture corpus and diff the
//                 rendered HTML STRING against node-marked (same pinned tarball
//                 = oracle, zero version skew). Robust to a red surface: a
//                 non-validating binary skips run+diff and is RECORDED, never
//                 crashes the harness.
//   5. REPORT   — emit JSON surface report + human summary.
//
// Invoke:  pnpm run dogfood:marked        (writes the JSON report, prints summary)
//          node tests/dogfood/marked-harness.mjs --json   (machine output only)
//
// This file does NOT fix any compiler bug — pure tooling, same acceptance
// bar as the acorn harness.

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupMarked } from "./setup-marked.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INPUTS_DIR = join(HERE, "fixtures", "marked-inputs");
const REPORT_PATH = join(HERE, "report", "marked-surface.json");

// ---------------------------------------------------------------------------
// Error categorization — same buckets as acorn-harness.mjs (marked is also
// plain JS run through the TS checker, so the same TS-noise shapes apply).
// ---------------------------------------------------------------------------
function categorizeError(message) {
  if (/Property '.*' does not exist on type/.test(message)) return "ts-property-noise";
  if (/Cannot find name/.test(message)) return "ts-cannot-find-name";
  if (/is not assignable to/.test(message)) return "ts-not-assignable";
  if (/implicitly has an? '.*' type/.test(message)) return "ts-implicit-any";
  if (/Object is possibly/.test(message)) return "ts-possibly-null";
  return "other";
}

function normalizeForBucket(message) {
  return message
    .replace(/\d+/g, "N")
    .replace(/'[^']*'/g, "'X'")
    .replace(/"[^"]*"/g, '"X"')
    .slice(0, 160);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  /** @type {any} */
  const report = {
    issue: null, // filled in by whoever files the corresponding issue
    generatedAt: new Date().toISOString(),
    marked: null,
    compile: null,
    validation: null,
    diff: {
      fixtures: [],
      runnable: false,
      skippedReason: null,
    },
    summary: {},
  };

  // --- 1. ACQUIRE ----------------------------------------------------------
  const { entryModulePath, version, pin } = setupMarked();
  report.marked = { version, source: pin.tarball, entryModule: pin.entryModule };
  log(`[dogfood] marked@${version} (pinned ${pin.shasum.slice(0, 12)}…) — entry ${pin.entryModule}`);

  const markedSource = readFileSync(entryModulePath, "utf-8");

  // --- 2. COMPILE ----------------------------------------------------------
  const t0 = performance.now();
  let result;
  let threw = null;
  try {
    result = await compile(markedSource, { fileName: "marked.esm.js" });
  } catch (e) {
    threw = e instanceof Error ? `${e.message}` : String(e);
  }
  const compileMs = Math.round(performance.now() - t0);

  if (threw) {
    report.compile = { success: false, threw, durationMs: compileMs, errorCount: null, categories: {} };
    report.summary = { headline: "compile() THREW", compileMs };
    log(`[dogfood] compile() THREW after ${compileMs}ms: ${threw}`);
    return finalize(report, log);
  }

  const errors = result.errors ?? [];
  /** @type {Record<string, {count:number, sample:string, buckets:Record<string,number>}>} */
  const categories = {};
  for (const e of errors) {
    const cat = categorizeError(e.message ?? String(e));
    const norm = normalizeForBucket(e.message ?? String(e));
    if (!categories[cat]) categories[cat] = { count: 0, sample: e.message ?? String(e), buckets: {} };
    categories[cat].count++;
    categories[cat].buckets[norm] = (categories[cat].buckets[norm] ?? 0) + 1;
  }

  report.compile = {
    success: result.success,
    durationMs: compileMs,
    errorCount: errors.length,
    binaryBytes: result.binary?.length ?? 0,
    categories,
  };
  log(
    `[dogfood] compile() success=${result.success} in ${compileMs}ms — ` +
      `${errors.length} diagnostics, binary ${result.binary?.length ?? 0} bytes`,
  );

  // --- 3. VALIDATE ---------------------------------------------------------
  let validates = false;
  let validationError = null;
  if (result.binary && result.binary.length) {
    try {
      await WebAssembly.compile(result.binary);
      validates = true;
    } catch (e) {
      validationError = e instanceof Error ? e.message : String(e);
    }
  } else {
    validationError = "no binary emitted";
  }
  report.validation = { validates, firstError: validationError };
  log(
    validates
      ? `[dogfood] WebAssembly.compile() OK — binary validates`
      : `[dogfood] WebAssembly.compile() FAILED: ${validationError}`,
  );

  // --- 4. RUN + DIFF -------------------------------------------------------
  const oracleMod = await import(pathToFileURL(entryModulePath).href);

  const fixtures = readdirSync(INPUTS_DIR)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .map((f) => ({ name: f, src: readFileSync(join(INPUTS_DIR, f), "utf-8") }));

  // Attempt to obtain a callable compiled-marked render function. Unlike
  // acorn, the observable surface here is a plain string (rendered HTML), not
  // an object graph — no wrapExports-driven struct marshalling is needed for
  // the RESULT, only for locating the export itself.
  let compiledParse = null;
  if (validates) {
    try {
      const importObject = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, importObject);
      importObject.__setInstance?.(instance);
      const exp = wrapExports(instance, { signatures: result.exportSignatures });
      report.diff.exports = Object.keys(exp).slice(0, 40);
      const parseFn =
        typeof exp.marked === "function" ? exp.marked : typeof exp.parse === "function" ? exp.parse : null;
      if (parseFn) {
        compiledParse = (src) => parseFn(src);
      } else {
        report.diff.skippedReason = "binary validates + instantiates but exposes no callable `marked`/`parse` export";
      }
    } catch (e) {
      report.diff.skippedReason = `instantiate failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else {
    report.diff.skippedReason = "binary did not validate (see validation.firstError)";
  }

  report.diff.runnable = !!compiledParse;

  for (const fx of fixtures) {
    const entry = { fixture: fx.name };
    let oracleHtml, oracleErr;
    try {
      oracleHtml = oracleMod.marked.parse(fx.src);
      entry.oracleLength = typeof oracleHtml === "string" ? oracleHtml.length : null;
    } catch (e) {
      oracleErr = e instanceof Error ? e.message : String(e);
      entry.oracleError = oracleErr;
    }

    if (!compiledParse) {
      entry.status = "skipped";
      entry.skippedReason = report.diff.skippedReason;
      report.diff.fixtures.push(entry);
      continue;
    }

    let compiledHtml, compiledErr;
    try {
      compiledHtml = compiledParse(fx.src);
    } catch (e) {
      compiledErr = e instanceof Error ? e.message : String(e);
    }
    if (compiledErr) {
      entry.status = "compiled-parse-threw";
      entry.compiledError = compiledErr;
      report.diff.fixtures.push(entry);
      continue;
    }
    if (typeof compiledHtml !== "string") {
      entry.status = "compiled-non-string-result";
      entry.compiledType = typeof compiledHtml;
      report.diff.fixtures.push(entry);
      continue;
    }
    if (compiledHtml === oracleHtml) {
      entry.status = "equal";
    } else {
      entry.status = "divergent";
      // First-diverging-character context, not a full diff — enough to triage.
      let i = 0;
      while (i < compiledHtml.length && i < oracleHtml.length && compiledHtml[i] === oracleHtml[i]) i++;
      entry.divergesAt = i;
      entry.oracleContext = oracleHtml.slice(Math.max(0, i - 20), i + 40);
      entry.compiledContext = compiledHtml.slice(Math.max(0, i - 20), i + 40);
      entry.oracleLength = oracleHtml.length;
      entry.compiledLength = compiledHtml.length;
    }
    report.diff.fixtures.push(entry);
  }

  // --- 5. SUMMARY ----------------------------------------------------------
  const catSummary = Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.count]));
  report.summary = {
    headline: !result.success
      ? "compile reported failure"
      : !validates
        ? "compiled, but binary INVALID (run+diff skipped — surface red)"
        : compiledParse
          ? "compiled + valid + runnable — see per-fixture diff"
          : "compiled + valid, but no runnable marked/parse export yet",
    compileMs,
    compileSuccess: result.success,
    binaryValidates: validates,
    diagnostics: errors.length,
    diagnosticCategories: catSummary,
    runtimeDiff: report.diff.runnable
      ? {
          equal: report.diff.fixtures.filter((f) => f.status === "equal").length,
          divergent: report.diff.fixtures.filter((f) => f.status === "divergent").length,
          errored: report.diff.fixtures.filter((f) => f.status === "compiled-parse-threw").length,
        }
      : { skipped: report.diff.fixtures.length, reason: report.diff.skippedReason },
  };

  return finalize(report, log);
}

function finalize(report, log) {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  log(`\n[dogfood] === marked surface report ===`);
  log(JSON.stringify(report.summary, null, 2));
  log(`[dogfood] full report → ${REPORT_PATH}`);
  return report;
}

// CLI entry
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const jsonOnly = process.argv.includes("--json");
  runHarness({ quiet: jsonOnly })
    .then((report) => {
      if (jsonOnly) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      // Same acceptance bar as acorn: "passing" means the harness ran to
      // completion and emitted a report, not that marked fully compiles.
      process.exit(0);
    })
    .catch((e) => {
      console.error("[dogfood] harness crashed:", e);
      process.exit(2);
    });
}
