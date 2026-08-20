// acorn OFFICIAL test suite harness (#3729) — runs acorn's own real
// conformance tests (test/tests*.js, ~3,500 cases at the pinned version)
// against js2wasm-compiled acorn, instead of the small hand-written fixture
// corpus the other acorn dogfood scripts use. Distinct value: this is
// acorn's OWN authoritative "does this parser actually work" check, not an
// approximation of it.
//
// Mechanism: acorn's test/driver.js exposes `runTests(config, callback)`
// fully decoupled from any specific acorn build — it just needs a
// `parse(code, options)` function. We load the real driver + all real
// test-*.js files (their own internal `require("../acorn")` resolves
// against the pinned dist bytes stitched in by setup-acorn-test-suite.mjs,
// used only to build EXPECTED-AST fixtures, never to do the actual
// parsing-under-test), then call `runTests` with compiled-acorn's `parse`.
//
// Compiled-acorn's `throw` lowers to a bare WebAssembly.Exception with no
// JS-reflectable payload (confirmed: `Object.keys(e)` is empty, `.message`
// and `.stack` are undefined) — acorn's driver needs a real `.message` to
// compare against expected error text. `extractWasmExceptionMessage`
// (tests/test262-runner.ts, the project's own established mechanism for
// exactly this problem, #2962) recovers it via the module's own
// `__exn_tag`/render exports.
//
// Invoke:  pnpm run dogfood:acorn-official-suite
//          npx tsx tests/dogfood/acorn-official-suite.mjs --json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupAcorn } from "./setup-acorn.mjs";
import { setupAcornTestSuite } from "./setup-acorn-test-suite.mjs";
import { extractWasmExceptionMessage } from "../test262-runner.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "acorn-official-suite.json");

// Test files acorn's own test/run.js loads for the "Normal" mode (we skip
// the Loose/commonjs-variant modes — those exercise acorn-loose, a
// SEPARATE npm package not part of this pinned tarball).
const TEST_FILES = [
  "tests.js",
  "tests-harmony.js",
  "tests-es7.js",
  "tests-asyncawait.js",
  "tests-await-top-level.js",
  "tests-trailing-commas-in-func.js",
  "tests-template-literal-revision.js",
  "tests-directive.js",
  "tests-rest-spread-properties.js",
  "tests-async-iteration.js",
  "tests-regexp.js",
  "tests-regexp-2018.js",
  "tests-regexp-2020.js",
  "tests-regexp-2022.js",
  "tests-regexp-2024.js",
  "tests-regexp-2025.js",
  "tests-json-superset.js",
  "tests-optional-catch-binding.js",
  "tests-bigint.js",
  "tests-dynamic-import.js",
  "tests-export-named.js",
  "tests-export-all-as-ns-from-source.js",
  "tests-import-meta.js",
  "tests-nullish-coalescing.js",
  "tests-optional-chaining.js",
  "tests-logical-assignment-operators.js",
  "tests-numeric-separators.js",
  "tests-class-features-2022.js",
  "tests-module-string-names.js",
  "tests-import-attributes.js",
  "tests-using.js",
  "tests-commonjs.js",
];

// Classify each failure into a stable bucket so the report is triageable,
// not just a raw pass count.
function bucketOf(message) {
  if (/^Expected error message: .* But parsing succeeded\.?$/s.test(message)) return "should-have-thrown";
  if (/^Expected error message: .*\nGot error message:/s.test(message)) return "wrong-error-message";
  if (/Assertion failed/.test(message)) return "assertion-failed";
  if (/!==/.test(message)) return "ast-mismatch";
  return "unexpected-throw";
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...a) => console.log(...a);

  /** @type {any} */
  const report = {
    issue: 3729,
    generatedAt: new Date().toISOString(),
    acorn: null,
    testSuite: null,
    compile: null,
    results: null,
    summary: {},
  };

  // --- 1. ACQUIRE ----------------------------------------------------------
  const { entryModulePath, version, pin } = setupAcorn();
  report.acorn = { version, source: pin.tarball, entryModule: pin.entryModule };
  const { testDir, pin: suitePin } = setupAcornTestSuite();
  report.testSuite = {
    repo: suitePin.repo,
    tag: suitePin.tag,
    commit: suitePin.commit,
    testDirectory: "test",
    testFiles: TEST_FILES,
  };
  log(`[dogfood] acorn@${version} official suite @ ${suitePin.tag} (${suitePin.commit.slice(0, 12)})`);

  const acornSource = readFileSync(entryModulePath, "utf-8");

  // --- 2. COMPILE ------------------------------------------------------------
  const t0 = performance.now();
  const result = await compile(acornSource, { fileName: "acorn.mjs", skipSemanticDiagnostics: true });
  const compileMs = Math.round(performance.now() - t0);
  report.compile = { success: result.success, durationMs: compileMs, binaryBytes: result.binary?.length ?? 0 };
  log(`[dogfood] compile() success=${result.success} in ${compileMs}ms, binary ${result.binary?.length ?? 0} bytes`);
  if (!result.success || !result.binary?.length) {
    report.summary = { headline: "compile reported failure — cannot run the suite", compileMs };
    return finalize(report, log);
  }

  let validates = false;
  try {
    await WebAssembly.compile(result.binary);
    validates = true;
  } catch (e) {
    report.summary = {
      headline: "binary did not validate — cannot run the suite",
      validationError: e instanceof Error ? e.message : String(e),
    };
    return finalize(report, log);
  }

  // --- 3. INSTANTIATE + get compiled parse ------------------------------
  const importObject = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setInstance?.(instance);
  const exp = wrapExports(instance, { signatures: result.exportSignatures });
  if (typeof exp.parse !== "function") {
    report.summary = { headline: "binary validates but exposes no callable `parse` export" };
    return finalize(report, log);
  }

  // Unwrap compiled-acorn's opaque WebAssembly.Exception throws into real
  // Error objects the driver's message comparisons can read (#2962).
  const nativeParse = exp.parse;
  const safeParse = (code, options) => {
    try {
      return nativeParse(code, options);
    } catch (e) {
      throw new SyntaxError(extractWasmExceptionMessage(e, instance));
    }
  };

  // --- 4. LOAD acorn's real driver + test files --------------------------
  const require = createRequire(pathToFileURL(join(testDir, "run.js")).href);
  const driver = require(join(testDir, "driver.js"));
  for (const f of TEST_FILES) require(join(testDir, f));

  // --- 5. RUN acorn's OWN driver against compiled-acorn -------------------
  let passed = 0;
  let failed = 0;
  const buckets = {};
  const t1 = performance.now();
  driver.runTests({ parse: safeParse }, (state, code, message) => {
    if (state === "ok") {
      passed++;
      return;
    }
    failed++;
    const bucket = bucketOf(message ?? "");
    if (!buckets[bucket]) buckets[bucket] = { count: 0, samples: [] };
    buckets[bucket].count++;
    if (buckets[bucket].samples.length < 15) {
      buckets[bucket].samples.push({ code: code.slice(0, 200), message: (message ?? "").slice(0, 400) });
    }
  });
  const runMs = Math.round(performance.now() - t1);

  report.results = { total: passed + failed, passed, failed, durationMs: runMs, buckets };
  report.summary = {
    headline: `${passed}/${passed + failed} passed (${((passed / (passed + failed)) * 100).toFixed(1)}%)`,
    passRatePct: Number(((passed / (passed + failed)) * 100).toFixed(2)),
    compileMs,
    runMs,
    bucketCounts: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, v.count])),
  };
  log(`\n[dogfood] ${report.summary.headline} in ${runMs}ms`);
  for (const [name, b] of Object.entries(buckets).sort((a, b) => b[1].count - a[1].count)) {
    log(`  ${name}: ${b.count}`);
  }

  return finalize(report, log);
}

function finalize(report, log) {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  log(`\n[dogfood] full report → ${REPORT_PATH}`);
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
