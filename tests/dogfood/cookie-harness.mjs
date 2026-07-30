// cookie dogfood harness — compile + validate + differential op-by-op diff.
//
// Fourth entry in the pinned-tarball dogfood pattern established by acorn
// (#1710), marked (#3716), and clsx (#3748): a fourth differently-shaped
// real npm package (an RFC-6265 cookie header parser/serializer) exercising
// yet another slice of the compiler — object literals with a growing set of
// dynamically-assigned optional properties, `switch` dispatch, `charCodeAt`
// character classification, ternary-unified object shapes, thrown
// `TypeError`s as part of normal control flow.
//
// Unlike clsx, cookie's four exports (parseCookie/stringifyCookie/
// stringifySetCookie/parseSetCookie) are all fixed-arity with real declared
// parameters, so the harness calls them DIRECTLY across the wasm export
// boundary — no driver-epilogue shim needed (see cookie-ops.mjs).
//
// Loop:
//   1. ACQUIRE  — pinned npm-pack tarball (no run-time network); see setup-cookie.mjs.
//   2. COMPILE  — pinned source, unmodified, through compile(src,{fileName});
//                 record success + categorized errors.
//   3. VALIDATE — WebAssembly.compile(binary); record the first validator error verbatim.
//   4. RUN+DIFF — when the binary validates, run every op through both the
//                 compiled export AND the SAME args against native cookie
//                 (import()-ed from the same pinned tarball), diffing
//                 JSON-normalized results (values may be objects, strings, or
//                 thrown errors). Robust to a red surface: a non-validating
//                 binary skips run+diff and is RECORDED, never crashes the
//                 harness.
//   5. REPORT   — emit JSON surface report + human summary.
//
// Invoke:  pnpm run dogfood:cookie        (writes the JSON report, prints summary)
//          node tests/dogfood/cookie-harness.mjs --json   (machine output to stdout)
//
// This file does NOT fix any compiler bug — pure tooling, same acceptance
// bar as the acorn/marked/clsx harnesses.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupCookie } from "./setup-cookie.mjs";
import { COOKIE_OPS } from "./cookie-ops.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "cookie-surface.json");

// ---------------------------------------------------------------------------
// Error categorization — same buckets as acorn/marked/clsx-harness.mjs.
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
    issue: 3751,
    generatedAt: new Date().toISOString(),
    cookie: null,
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
  const { entryModulePath, version, pin } = setupCookie();
  report.cookie = { version, source: pin.tarball, entryModule: pin.entryModule };
  log(`[dogfood] cookie@${version} (pinned ${pin.shasum.slice(0, 12)}…) — entry ${pin.entryModule}`);

  const cookieSource = readFileSync(entryModulePath, "utf-8");

  // --- 2. COMPILE ----------------------------------------------------------
  const t0 = performance.now();
  let result;
  let threw = null;
  try {
    result = await compile(cookieSource, { fileName: "index.js", skipSemanticDiagnostics: true });
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
  const nativeModule = await import(pathToFileURL(entryModulePath).href);

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

  for (const op of COOKIE_OPS) {
    const entry = { op: op.name, fn: op.fn };
    let nativeVal, nativeErr;
    try {
      nativeVal = nativeModule[op.fn](...op.args);
    } catch (e) {
      nativeErr = e instanceof Error ? e.message : String(e);
    }

    if (!compiledExports) {
      entry.status = "skipped";
      entry.skippedReason = report.diff.skippedReason;
      report.diff.ops.push(entry);
      continue;
    }

    let compiledVal, compiledErr;
    try {
      compiledVal = compiledExports[op.fn](...op.args);
    } catch (e) {
      compiledErr = e instanceof Error ? e.message : String(e);
    }

    // Both sides can legitimately throw (e.g. invalid cookie name) — treat
    // "both threw" as equal (we don't compare exact error message text,
    // only threw-ness + JSON-normalized value shape).
    if (compiledErr && nativeErr) {
      entry.status = "equal";
      entry.bothThrew = true;
    } else if (compiledErr || nativeErr) {
      entry.status = "divergent";
      entry.compiledError = compiledErr;
      entry.nativeError = nativeErr;
    } else {
      const compiledJson = JSON.stringify(compiledVal);
      const nativeJson = JSON.stringify(nativeVal);
      entry.compiledValue = compiledJson;
      entry.nativeValue = nativeJson;
      entry.status = compiledJson === nativeJson ? "equal" : "divergent";
    }
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
          total: COOKIE_OPS.length,
          equal: report.diff.ops.filter((o) => o.status === "equal").length,
          divergent: report.diff.ops.filter((o) => o.status === "divergent").length,
        }
      : { skipped: report.diff.ops.length, reason: report.diff.skippedReason },
  };

  return finalize(report, log);
}

function finalize(report, log) {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  log(`\n[dogfood] === cookie surface report ===`);
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
