// clsx dogfood harness — compile + validate + differential op-by-op diff.
//
// Third entry in the pinned-tarball dogfood pattern established by acorn
// (#1710) and marked (#3716): a third differently-shaped real npm package
// (a variadic className-joining utility) exercising yet another slice of
// the compiler — `arguments`-object variadic reads, `typeof`-based dynamic
// dispatch, array/object property enumeration (`for...in`), all inside a
// tiny (~330 byte minified) real-world bundle.
//
// Unlike acorn/marked, clsx's top-level exported function can't be called
// directly: it declares zero parameters and reads the `arguments` object,
// and a wasm export's signature is fixed-arity from its declared parameter
// list — extra JS call-site arguments never reach a raw export (verified
// independent of clsx with a minimal repro; not a compiler bug, see
// clsx-pin.json's `_note`). So this harness compiles the UNMODIFIED pinned
// source with a small internal driver epilogue appended (see
// clsx-ops.mjs) — each op is a fixed-arity wrapper making an ordinary
// INTERNAL call into clsx with hardcoded literal arguments, exported so the
// host can read the result back.
//
// Loop:
//   1. ACQUIRE  — pinned npm-pack tarball (no run-time network); see setup-clsx.mjs.
//   2. COMPILE  — pinned source + driver epilogue (clsx-ops.mjs) through
//                 compile(src,{fileName}); record success + categorized errors.
//   3. VALIDATE — WebAssembly.compile(binary); record the first validator error verbatim.
//   4. RUN+DIFF — when the binary validates, run every op through both the
//                 compiled wrapper export AND the SAME op code string bound to
//                 native clsx (require()'d from the same pinned tarball), diffing
//                 the string results. Robust to a red surface: a non-validating
//                 binary skips run+diff and is RECORDED, never crashes the harness.
//   5. REPORT   — emit JSON surface report + human summary.
//
// Invoke:  pnpm run dogfood:clsx        (writes the JSON report, prints summary)
//          node tests/dogfood/clsx-harness.mjs --json   (machine output to stdout)
//
// This file does NOT fix any compiler bug — pure tooling, same acceptance
// bar as the acorn/marked harnesses.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupClsx } from "./setup-clsx.mjs";
import { CLSX_OPS } from "./clsx-ops.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "clsx-surface.json");

// ---------------------------------------------------------------------------
// Error categorization — same buckets as acorn/marked-harness.mjs.
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

function buildEpilogue() {
  return CLSX_OPS.map((op) => `export function ${op.name}() {\n${op.code}\n}\n`).join("\n");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  /** @type {any} */
  const report = {
    issue: 3748,
    generatedAt: new Date().toISOString(),
    clsx: null,
    compile: null,
    validation: null,
    diff: {
      ops: [],
      runnable: false,
      skippedReason: null,
    },
    summary: {},
  };

  // --- 1. ACQUIRE ----------------------------------------------------------
  const { entryModulePath, version, pin } = setupClsx();
  report.clsx = { version, source: pin.tarball, entryModule: pin.entryModule };
  log(`[dogfood] clsx@${version} (pinned ${pin.shasum.slice(0, 12)}…) — entry ${pin.entryModule}`);

  const clsxSource = readFileSync(entryModulePath, "utf-8");
  const fullSource = clsxSource + "\n" + buildEpilogue();

  // --- 2. COMPILE ----------------------------------------------------------
  const t0 = performance.now();
  let result;
  let threw = null;
  try {
    result = await compile(fullSource, { fileName: "clsx.mjs", skipSemanticDiagnostics: true });
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
  const require = createRequire(import.meta.url);
  // Native oracle: the SAME pinned tarball's CJS build (module.exports.clsx),
  // zero version skew with the compiled side.
  const cjsEntryPath = entryModulePath.replace(/\/clsx\.mjs$/, "/clsx.js");
  const nativeClsx = require(cjsEntryPath).clsx;

  let compiledExports = null;
  if (validates) {
    try {
      const importObject = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, importObject);
      importObject.__setInstance?.(instance);
      compiledExports = wrapExports(instance, { signatures: result.exportSignatures });
      report.diff.exports = Object.keys(compiledExports).filter((k) => !k.startsWith("__"));
    } catch (e) {
      report.diff.skippedReason = `instantiate failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  } else {
    report.diff.skippedReason = "binary did not validate (see validation.firstError)";
  }

  report.diff.runnable = !!compiledExports;

  for (const op of CLSX_OPS) {
    const entry = { op: op.name };
    let nativeVal, nativeErr;
    try {
      nativeVal = new Function("clsx", op.code)(nativeClsx);
    } catch (e) {
      nativeErr = e instanceof Error ? e.message : String(e);
      entry.nativeError = nativeErr;
    }

    if (!compiledExports) {
      entry.status = "skipped";
      entry.skippedReason = report.diff.skippedReason;
      report.diff.ops.push(entry);
      continue;
    }

    let compiledVal, compiledErr;
    try {
      compiledVal = compiledExports[op.name]();
    } catch (e) {
      compiledErr = e instanceof Error ? e.message : String(e);
    }
    if (compiledErr) {
      entry.status = "compiled-threw";
      entry.compiledError = compiledErr;
      report.diff.ops.push(entry);
      continue;
    }
    entry.compiledValue = compiledVal;
    entry.nativeValue = nativeVal;
    entry.status = compiledVal === nativeVal ? "equal" : "divergent";
    report.diff.ops.push(entry);
  }

  // --- 5. SUMMARY ----------------------------------------------------------
  const catSummary = Object.fromEntries(Object.entries(categories).map(([k, v]) => [k, v.count]));
  report.summary = {
    headline: !result.success
      ? "compile reported failure"
      : !validates
        ? "compiled, but binary INVALID (run+diff skipped — surface red)"
        : compiledExports
          ? "compiled + valid + runnable — see per-op diff"
          : "compiled + valid, but instantiate failed",
    compileMs,
    compileSuccess: result.success,
    binaryValidates: validates,
    diagnostics: errors.length,
    diagnosticCategories: catSummary,
    opDiff: report.diff.runnable
      ? {
          total: CLSX_OPS.length,
          equal: report.diff.ops.filter((o) => o.status === "equal").length,
          divergent: report.diff.ops.filter((o) => o.status === "divergent").length,
          errored: report.diff.ops.filter((o) => o.status === "compiled-threw").length,
        }
      : { skipped: report.diff.ops.length, reason: report.diff.skippedReason },
  };

  return finalize(report, log);
}

function finalize(report, log) {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  log(`\n[dogfood] === clsx surface report ===`);
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
      process.exit(0);
    })
    .catch((e) => {
      console.error("[dogfood] harness crashed:", e);
      process.exit(2);
    });
}
