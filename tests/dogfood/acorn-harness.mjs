// acorn dogfood harness (#1710) — compile + validate + differential-AST.
//
// Mechanizes the previously-throwaway `.tmp/acorn/probe.mjs` loop into a
// committed, reproducible tool that regenerates the acorn failure surface as
// machine-readable data for #1711 (triage) and reuses the #1712 differential
// AST gate.
//
// Loop (per the #1710 spec):
//   1. ACQUIRE  — pinned npm-pack tarball (no run-time network); see setup-acorn.mjs.
//   2. COMPILE  — feed acorn's entry module through compile(src,{fileName}); record
//                 success + categorized errors (the known TS "Property does not
//                 exist" JS-noise is collapsed into one non-blocking bucket).
//   3. VALIDATE — WebAssembly.compile(binary); record the first validator error
//                 verbatim (the surface that exposed #1690).
//   4. RUN+DIFF — when the binary validates AND exposes a callable parse, run it
//                 over a small fixture corpus and structurally diff each AST
//                 against node-acorn (same pinned tarball = oracle). Robust to a
//                 red surface: a non-validating binary skips run+diff and is
//                 RECORDED, never crashes the harness.
//   5. REPORT   — emit JSON surface report + human summary.
//
// Invoke:  pnpm run dogfood:acorn        (writes the JSON report, prints summary)
//          node tests/dogfood/acorn-harness.mjs --json   (machine output only)
//
// This file does NOT fix any compiler bug — pure tooling (acceptance #5).

import { readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupAcorn } from "./setup-acorn.mjs";
import { diffAst } from "./ast-diff.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INPUTS_DIR = join(HERE, "fixtures", "inputs");
const REPORT_PATH = join(HERE, "report", "acorn-surface.json");

const PARSE_OPTIONS = { ecmaVersion: 2022, sourceType: "module" };

// ---------------------------------------------------------------------------
// Error categorization
// ---------------------------------------------------------------------------
// The known TS JS-noise ("Property 'x' does not exist on type ...") is NOT a
// compile blocker per #1679/#1690 — acorn is plain JS run through the TS
// checker, so member access on untyped objects diagnoses noisily. Collapse it
// into one bucket so the real surface is legible.
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
    issue: 1710,
    generatedAt: new Date().toISOString(),
    acorn: null,
    compile: null,
    validation: null,
    diff: {
      // Self-check proves the differential function works even when compiled
      // acorn can't run yet — required so #1712 can rely on it.
      oracleSelfCheck: null,
      // Per-fixture compiled-acorn vs node-acorn results (populated only when
      // the binary validates AND exposes a callable parse export).
      fixtures: [],
      runnable: false,
      skippedReason: null,
    },
    summary: {},
  };

  // --- 1. ACQUIRE ----------------------------------------------------------
  const { entryModulePath, version, pin } = setupAcorn();
  report.acorn = { version, source: pin.tarball, entryModule: pin.entryModule };
  log(`[dogfood] acorn@${version} (pinned ${pin.shasum.slice(0, 12)}…) — entry ${pin.entryModule}`);

  const acornSource = readFileSync(entryModulePath, "utf-8");

  // --- 2. COMPILE ----------------------------------------------------------
  const t0 = performance.now();
  let result;
  let threw = null;
  try {
    // #3717 — acorn is plain pre-strict-mode JS; compiling it through full
    // strict-mode TS type-checking surfaces a wall of legitimate-but-irrelevant
    // strict-null-check diagnostics (verified against real `tsc --strict`, not
    // a compiler bug). skipSemanticDiagnostics routes around this exact class
    // of noise, same as the other three acorn dogfood scripts
    // (acorn-corpus.mjs/acorn-probe.mjs/acorn-test262.mjs) already do — this
    // harness was the one outlier still doing full semantic checking.
    result = await compile(acornSource, { fileName: "acorn.mjs", skipSemanticDiagnostics: true });
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
  // Always run the oracle self-check so the differential gate is proven usable
  // by #1712 regardless of whether compiled-acorn runs.
  const oracleMod = await import(pathToFileURL(entryModulePath).href);
  report.diff.oracleSelfCheck = oracleSelfCheck(oracleMod);

  const fixtures = readdirSync(INPUTS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => ({ name: f, src: readFileSync(join(INPUTS_DIR, f), "utf-8") }));

  // Attempt to obtain a callable compiled-acorn parse. The compiled module is a
  // raw Wasm instance; acorn's parse() returns a deep object graph that we'd
  // need marshalled back across the JS-host boundary as an externref. The first
  // lap simply attempts instantiation + a `parse` export and records what it
  // finds; when the binary does not validate this is skipped (and RECORDED),
  // which is the expected state until #1690 is resolved.
  let compiledParse = null;
  if (validates) {
    try {
      const importObject = result.importObject ?? {};
      const { instance } = await WebAssembly.instantiate(result.binary, importObject);
      // (#1712) Wire the host runtime's exports hook so exports-backed
      // capabilities (closure wrapping, __sget_* struct reads, deferred
      // start-window Object.defineProperties) work on this convenience path.
      importObject.__setInstance?.(instance);
      // (#1712) Marshal struct/vec returns to plain JS via wrapExports —
      // a raw `exports.parse` returns an opaque WasmGC struct that diffs as
      // an empty object. wrapExports (#1504) recursively converts the node
      // graph (struct fields via __sget_*, sidecar props, vecs as arrays)
      // so diffAst compares real tree shape.
      const exp = wrapExports(instance, { signatures: result.exportSignatures });
      report.diff.exports = Object.keys(exp).slice(0, 40);
      if (typeof exp.parse === "function") {
        compiledParse = (src, opts) => exp.parse(src, opts);
      } else {
        report.diff.skippedReason =
          "binary validates + instantiates but exposes no callable `parse` export " +
          "(compiled-acorn AST marshalling across the JS-host boundary is a #1711 child)";
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
    let oracleAst, oracleErr;
    try {
      oracleAst = oracleMod.parse(fx.src, PARSE_OPTIONS);
      entry.oracleType = oracleAst?.type ?? null;
      entry.oracleBodyLen = Array.isArray(oracleAst?.body) ? oracleAst.body.length : null;
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

    let compiledAst, compiledErr;
    try {
      compiledAst = compiledParse(fx.src, PARSE_OPTIONS);
    } catch (e) {
      compiledErr = e instanceof Error ? e.message : String(e);
    }
    if (compiledErr) {
      entry.status = "compiled-parse-threw";
      entry.compiledError = compiledErr;
      report.diff.fixtures.push(entry);
      continue;
    }
    const d = diffAst(oracleAst, compiledAst, { ignorePositions: true, maxDivergences: 1 });
    entry.status = d.equal ? "equal" : "divergent";
    entry.divergences = d.divergences;
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
          : "compiled + valid, but no runnable parse export yet",
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
    oracleSelfCheckPassed: report.diff.oracleSelfCheck?.passed ?? false,
  };

  return finalize(report, log);
}

// Prove the differential function detects both equality and divergence using
// node-acorn alone. Required so #1712's acceptance gate can trust diffAst even
// while compiled-acorn can't run.
function oracleSelfCheck(oracleMod) {
  try {
    const a = oracleMod.parse("const x = 1 + 2;", PARSE_OPTIONS);
    const b = oracleMod.parse("const x = 1 + 2;", PARSE_OPTIONS);
    const same = diffAst(a, b, { ignorePositions: true });
    const c = oracleMod.parse("const x = 1 - 2;", PARSE_OPTIONS); // BinaryExpression operator differs
    const diff = diffAst(a, c, { ignorePositions: true, maxDivergences: 1 });
    const passed = same.equal === true && diff.equal === false;
    return {
      passed,
      identicalSourcesEqual: same.equal,
      differingSourcesDivergent: !diff.equal,
      sampleDivergence: diff.divergences[0] ?? null,
    };
  } catch (e) {
    return { passed: false, error: e instanceof Error ? e.message : String(e) };
  }
}

function finalize(report, log) {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  log(`\n[dogfood] === acorn surface report ===`);
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
      // The harness "passing" means it RAN to completion and emitted a report
      // (acceptance #3) — NOT that acorn fully parses. #1712 is the pass/fail
      // gate. So we exit 0 on a successful run even when the surface is red.
      process.exit(0);
    })
    .catch((e) => {
      console.error("[dogfood] harness crashed:", e);
      process.exit(2);
    });
}
