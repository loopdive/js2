// react-dom upstream-suite dogfood harness — react-dom's OWN unit tests, run
// against react-dom compiled to WebAssembly.
//
// Deliberately built on the #3958 react suite rather than beside it: the test
// EXTRACTOR (`react-upstream-extract.mjs`) and the `expect` SHIM
// (`react-upstream-shim.mjs`) are reused verbatim, because react-dom's tests are
// the same Jest + JSX + `describe`/`it` shape from the same repository at the
// same commit. Only three things are actually different, and each is the reason
// a separate harness exists at all:
//
//   1. TWO published CJS modules make up the implementation (the shared entry
//      plus the 536 KB client renderer), and each needs its OWN function scope:
//      react and react-dom both declare a top-level `noop`, so a bare
//      concatenation dies with `Duplicate identifier 'noop'` before a single
//      test runs.
//   2. `require("react")` / `require("react-dom")` / `require("scheduler")`
//      inside those modules are rewired to the in-module values.
//   3. The implementation is compiled ALONE first (the #3977 lit lesson): if it
//      cannot produce a valid module, subdividing per test is wasted wall clock
//      and hides the real finding. Today react-dom does NOT compile, so that
//      pre-check IS the result.
//
// Invoke:  pnpm run dogfood:react-dom-upstream-suite
//          node tests/dogfood/react-dom-upstream-suite.mjs --json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupReact } from "./setup-react.mjs";
import { setupReactDomImplementation, setupReactDomUpstreamSuite } from "./setup-react-dom-upstream-suite.mjs";
import { extractReactUpstreamTests } from "./react-upstream-extract.mjs";
import { REACT_EXPECT_SHIM, LAST_ERROR_EXPORT, buildTestFunction } from "./react-upstream-shim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "react-dom-upstream-suite.json");

// Upstream's `suite` scaffolding is replicated into every lifted test, so a
// whole file's tests can generate megabytes. Split up front by generated size —
// a separate lever from the validation-failure subdivision below, which exists
// to bound #3775's blast radius rather than to keep a unit compilable at all.
const MAX_BATCH_CHARS = 120_000;

// Each published CJS module gets its own function scope. `require` calls are
// rewired to the in-module values rather than stubbed, so what runs is the
// published implementation wired to the published implementation.
function wireRequires(source) {
  return source
    .replace(/require\(\s*['"]react['"]\s*\)/g, "__REACT__")
    .replace(/require\(\s*['"]react-dom['"]\s*\)/g, "__REACTDOM_SHARED__")
    .replace(/require\(\s*['"]scheduler['"]\s*\)/g, "__SCHEDULER__");
}

function buildImplementationSource({ reactSource, sharedSource, clientSource }) {
  return [
    "function __reactModule() { var exports = {};",
    reactSource,
    "return exports; }",
    "var __REACT__ = __reactModule();",
    // react-dom's client renderer reaches for the scheduler; it is not part of
    // the react-dom tarball, so it is an empty object here. Anything that
    // actually needs it fails identically on both sides and lands in
    // `harness-incompatible` rather than being filtered out.
    "var __SCHEDULER__ = {};",
    "function __reactDomSharedModule() { var exports = {};",
    wireRequires(sharedSource),
    "return exports; }",
    "var __REACTDOM_SHARED__ = __reactDomSharedModule();",
    "function __reactDomClientModule() { var exports = {};",
    wireRequires(clientSource),
    "return exports; }",
    "var __REACTDOM__ = __reactDomClientModule();",
  ].join("\n");
}

function buildModuleSource(implementation, tests) {
  return [implementation, REACT_EXPECT_SHIM, ...tests.map((test) => buildTestFunction(test)), LAST_ERROR_EXPORT].join(
    "\n",
  );
}

function buildNativeRunners(implementation, tests) {
  const source = [
    implementation,
    REACT_EXPECT_SHIM,
    ...tests.map((test) => buildTestFunction(test, { exported: false })),
    `return { __lastError: function () { return __lastError; }, tests: { ${tests
      .map((test) => `${JSON.stringify(test.id)}: ${test.id}`)
      .join(", ")} } };`,
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(source);
}

async function runNative(implementation, tests) {
  try {
    const runners = buildNativeRunners(implementation, tests)();
    const out = [];
    for (const test of tests) {
      let value;
      let error = null;
      try {
        value = await runners.tests[test.id]();
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      out.push({ id: test.id, value, error, message: value === 1 ? "" : runners.__lastError() });
    }
    return out;
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return tests.map((test) => ({ id: test.id, value: undefined, error: `oracle build failed: ${message}` }));
  }
}

// Compiles the implementation ALONE — no test code. If this cannot produce a
// valid module then every batch containing it is invalid too, and subdividing
// per test only burns wall clock while hiding the actual finding.
async function compileImplementationOnly(implementation) {
  const source = `${implementation}\nexport function __probe() {\n  return 1;\n}`;
  const started = performance.now();
  let result;
  try {
    result = await compile(source, { fileName: "react-dom.js", skipSemanticDiagnostics: true });
  } catch (thrown) {
    return {
      validates: false,
      compileMs: Math.round(performance.now() - started),
      error: thrown instanceof Error ? thrown.message : String(thrown),
    };
  }
  const compileMs = Math.round(performance.now() - started);
  if (!result.success || !result.binary?.length) {
    return { validates: false, compileMs, error: result.errors?.[0]?.message ?? "no binary emitted" };
  }
  try {
    await WebAssembly.compile(result.binary);
    return { validates: true, compileMs, error: null, binaryBytes: result.binary.length };
  } catch (error) {
    return {
      validates: false,
      compileMs,
      error: error instanceof Error ? error.message : String(error),
      binaryBytes: result.binary.length,
    };
  }
}

function splitBySize(tests) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const test of tests) {
    const cost = test.prelude.length + test.body.length + 200;
    if (current.length > 0 && size + cost > MAX_BATCH_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(test);
    size += cost;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);

  // --- 1. ACQUIRE ----------------------------------------------------------
  const { root: reactRoot, version: reactVersion } = setupReact();
  const reactSource = readFileSync(join(reactRoot, "package", "cjs", "react.production.js"), "utf-8");
  const implementationPin = setupReactDomImplementation();
  const sharedSource = readFileSync(implementationPin.sharedPath, "utf-8");
  const clientSource = readFileSync(implementationPin.clientPath, "utf-8");
  const { root: suiteRoot, pin: suitePin } = setupReactDomUpstreamSuite();

  const implementation = buildImplementationSource({ reactSource, sharedSource, clientSource });

  const report = {
    generatedAt: new Date().toISOString(),
    reactDom: {
      version: implementationPin.version,
      reactVersion,
      source: implementationPin.pin.tarball,
      modules: [suitePin.implementation.sharedModule, suitePin.implementation.clientModule],
      implementationChars: implementation.length,
    },
    upstreamSuite: {
      repo: suitePin.repo,
      tag: suitePin.tag,
      commit: suitePin.commit,
      testFiles: suitePin.testFiles,
    },
    extraction: null,
    compile: null,
    validation: null,
    results: null,
    summary: {},
  };

  // --- 2. EXTRACT ----------------------------------------------------------
  const extracted = extractReactUpstreamTests({
    root: suiteRoot,
    testFiles: suitePin.testFiles,
    admitAll: process.env.DOGFOOD_REACT_DOM_ADMIT_ALL !== "0",
  });
  report.extraction = {
    upstreamTestsSeen: extracted.tests.length + extracted.rejected.length,
    admitted: extracted.tests.length,
    rejected: extracted.rejected.length,
    rejectionCounts: extracted.rejectionCounts,
    rejectedTests: extracted.rejected,
  };
  log(
    `[dogfood] react-dom@${implementationPin.version} upstream @ ${suitePin.tag}: ` +
      `${extracted.tests.length} of ${extracted.tests.length + extracted.rejected.length} upstream tests admitted`,
  );

  // --- 3. DOES THE IMPLEMENTATION COMPILE AT ALL? --------------------------
  const baseline = await compileImplementationOnly(implementation);
  log(
    `[dogfood] react-dom implementation alone (${Math.round(implementation.length / 1024)} KB): ` +
      (baseline.validates ? `valid in ${baseline.compileMs}ms` : `INVALID — ${String(baseline.error).slice(0, 100)}`),
  );

  const batchReports = [];
  const runResults = new Map();
  const quarantined = [];
  let admitted = [];
  let totalCompileMs = baseline.compileMs;
  let totalBytes = 0;
  let implementationInvalid = null;

  if (!baseline.validates) {
    // The whole corpus is behind this one fact. The tests still RUN natively so
    // the report can say how many the compiler would have to get right, and they
    // are scored as failures rather than quietly dropped.
    implementationInvalid = { error: String(baseline.error), compileMs: baseline.compileMs };
    admitted = extracted.tests;
    const nativeResults = new Map((await runNative(implementation, extracted.tests)).map((e) => [e.id, e]));
    for (const test of extracted.tests) {
      runResults.set(test.id, {
        native: nativeResults.get(test.id) ?? {},
        compiled: null,
        firstError: `implementation module invalid: ${String(baseline.error).slice(0, 200)}`,
      });
    }
  } else {
    const batches = new Map();
    for (const test of extracted.tests) {
      if (!batches.has(test.file)) batches.set(test.file, []);
      batches.get(test.file).push(test);
    }

    const compileGroup = async (file, groupTests, depth = 0) => {
      let batchTests = groupTests;
      let result = null;
      let compileMs = 0;
      const started = performance.now();
      try {
        result = await compile(buildModuleSource(implementation, batchTests), {
          fileName: "react-dom.js",
          skipSemanticDiagnostics: true,
        });
      } catch (thrown) {
        result = { success: false, errors: [{ message: thrown instanceof Error ? thrown.message : String(thrown) }] };
      }
      compileMs = Math.round(performance.now() - started);
      totalCompileMs += compileMs;
      totalBytes += result?.binary?.length ?? 0;

      let validates = false;
      let firstError = result?.errors?.[0]?.message ?? "no binary emitted";
      if (result?.success && result.binary?.length) {
        try {
          await WebAssembly.compile(result.binary);
          validates = true;
          firstError = null;
        } catch (error) {
          firstError = error instanceof Error ? error.message : String(error);
        }
      }

      if (!validates && batchTests.length > 1 && depth < 6) {
        const middle = Math.ceil(batchTests.length / 2);
        await compileGroup(file, batchTests.slice(0, middle), depth + 1);
        await compileGroup(file, batchTests.slice(middle), depth + 1);
        return;
      }

      admitted = admitted.concat(batchTests);
      let compiled = null;
      if (validates) {
        try {
          const imports = result.importObject ?? {};
          const { instance } = await WebAssembly.instantiate(result.binary, imports);
          imports.__setExports?.(instance.exports);
          imports.__setInstance?.(instance);
          compiled = wrapExports(instance.exports, { signatures: result.exportSignatures });
        } catch (error) {
          firstError = `instantiate failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      batchReports.push({
        file,
        tests: batchTests.length,
        compileMs,
        binaryBytes: result?.binary?.length ?? 0,
        compileSuccess: result?.success ?? false,
        validates,
        firstError,
      });
      log(
        `[dogfood]   ${file.replace(/^.*\//, "")}: ${batchTests.length} tests, ` +
          `${validates ? "valid" : `INVALID — ${String(firstError).slice(0, 70)}`}`,
      );

      const nativeResults = new Map((await runNative(implementation, batchTests)).map((e) => [e.id, e]));
      for (const test of batchTests) {
        runResults.set(test.id, { native: nativeResults.get(test.id) ?? {}, compiled, firstError });
      }
    };

    for (const [file, fileTests] of batches) {
      for (const chunk of splitBySize(fileTests)) await compileGroup(file, chunk);
    }
  }

  const invalidBatches = batchReports.filter((batch) => !batch.validates);
  report.compile = {
    success: implementationInvalid === null && batchReports.every((batch) => batch.compileSuccess),
    durationMs: totalCompileMs,
    binaryBytes: totalBytes,
    batches: batchReports,
    invalidBatches: invalidBatches.length,
    // The headline when non-null: react-dom's published implementation does not
    // produce a valid module even with no test code attached, so no test in the
    // corpus ever had a chance.
    implementationInvalid,
    quarantined: quarantined.map((test) => ({ id: test.id, fullName: test.fullName, reason: test.reason })),
  };
  report.validation = {
    validates: implementationInvalid === null && invalidBatches.length === 0,
    firstError: implementationInvalid?.error ?? invalidBatches[0]?.firstError ?? null,
  };

  const tests = [];
  for (const test of admitted) {
    const { native, compiled, firstError } = runResults.get(test.id) ?? {};
    const entry = {
      id: test.id,
      file: test.file,
      fullName: test.fullName,
      nativePassed: native?.value === 1,
      nativeMessage: native?.error ?? native?.message ?? "",
    };
    if (!entry.nativePassed) {
      // The oracle cannot reproduce it either (it needs jsdom, ReactDOM's test
      // utils, jest's module registry). Not compiler evidence — reported in its
      // own bucket, never counted as a compiler failure.
      entry.status = "harness-incompatible";
      tests.push(entry);
      continue;
    }
    if (!compiled) {
      entry.status = "skipped";
      entry.skippedReason = firstError ?? "binary did not instantiate";
      tests.push(entry);
      continue;
    }
    let value;
    try {
      value = await compiled[test.id]();
    } catch (error) {
      entry.status = "trapped";
      entry.compiledMessage = error instanceof Error ? error.message : String(error);
      tests.push(entry);
      continue;
    }
    entry.compiledPassed = value === 1;
    entry.status = value === 1 ? "pass" : "fail";
    if (value !== 1) {
      try {
        entry.compiledMessage = compiled.__react_last_error?.() ?? "";
      } catch {
        entry.compiledMessage = "";
      }
    }
    tests.push(entry);
  }

  const scored = tests.filter((test) => test.status !== "harness-incompatible");
  const passed = tests.filter((test) => test.status === "pass").length;
  const failed = scored.length - passed;

  report.results = {
    scored: scored.length,
    passed,
    failed,
    harnessIncompatible: tests.length - scored.length,
    tests,
  };
  report.summary = {
    headline:
      `${passed}/${scored.length} scored upstream react-dom tests pass against compiled Wasm ` +
      `(${report.extraction.admitted} of ${report.extraction.upstreamTestsSeen} upstream tests run; ` +
      `${tests.length - scored.length} need infrastructure the harness cannot supply)` +
      (implementationInvalid ? " — react-dom's own implementation does not compile to a valid module" : ""),
    passRatePct: scored.length ? Number(((passed / scored.length) * 100).toFixed(2)) : 0,
    upstreamTestsSeen: report.extraction.upstreamTestsSeen,
    admitted: report.extraction.admitted,
    scored: scored.length,
    passed,
    failed,
    harnessIncompatible: report.results.harnessIncompatible,
    compileMs: totalCompileMs,
    binaryBytes: report.compile.binaryBytes,
    batches: batchReports.length,
    invalidBatches: invalidBatches.length,
    implementationInvalid: implementationInvalid !== null,
    implementationError: implementationInvalid?.error ?? null,
    binaryValidates: report.validation.validates,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(`[dogfood] ${report.summary.headline}`);
  log(`[dogfood] full report → ${REPORT_PATH}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const jsonOnly = process.argv.includes("--json");
  runHarness({ quiet: jsonOnly })
    .then((report) => jsonOnly && process.stdout.write(`${JSON.stringify(report)}\n`))
    .catch((error) => {
      if (jsonOnly)
        process.stdout.write(`${JSON.stringify({ fatal: error instanceof Error ? error.message : String(error) })}\n`);
      else console.error(error);
      process.exitCode = 1;
    });
}
