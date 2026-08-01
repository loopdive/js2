// react upstream-suite dogfood harness — React's OWN unit tests, run against
// React compiled to WebAssembly.
//
// Loop:
//   1. ACQUIRE  — pinned react npm tarball (published bytes, sha-verified) plus
//                 the matching upstream source tag at its immutable commit.
//                 See setup-react.mjs / setup-react-upstream-suite.mjs.
//   2. EXTRACT  — lift every `it()` out of React's real test files, verbatim,
//                 with its describe scope and beforeEach prelude. ALL of them
//                 run — async bodies included, and the ones needing ReactDOM /
//                 act / jest / a document too, which are expected to fail. Only
//                 a `done`-callback signature is structurally unrunnable. See
//                 react-upstream-extract.mjs.
//   3. COMPILE  — ONE MODULE PER UPSTREAM FILE (not one for the whole suite):
//                 the published CommonJS React implementation, unmodified, +
//                 the `expect` shim + one exported function per test. A single
//                 invalid function would make WebAssembly.compile reject the
//                 whole binary, so a unit that fails VALIDATION is halved and
//                 retried, bounding the blast radius of #3775. A test that
//                 breaks compilation is quarantined and reported, never
//                 silently removed.
//   4. ORACLE   — run the SAME generated test sources natively against the SAME
//                 pinned React. A test that fails natively is harness-
//                 incompatible and is excluded from the compiler score, with the
//                 reason recorded. It is never counted as a compiler bug.
//   5. RUN+DIFF — run each admitted test inside Wasm and diff against native.
//   6. REPORT   — JSON surface report + human summary.
//
// Invoke:  pnpm run dogfood:react-upstream-suite
//          node tests/dogfood/react-upstream-suite.mjs --json

import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupReact } from "./setup-react.mjs";
import { setupReactUpstreamSuite } from "./setup-react-upstream-suite.mjs";
import { extractReactUpstreamTests } from "./react-upstream-extract.mjs";
import { REACT_EXPECT_SHIM, LAST_ERROR_EXPORT, buildTestFunction } from "./react-upstream-shim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "react-upstream-suite.json");

// `var exports = {}` makes the published CommonJS implementation an internal
// module value. Every byte of the implementation after that one binding is
// unmodified; the appended code only observes React's public API.
function buildModuleSource(reactSource, tests) {
  return [
    "var exports = {};",
    reactSource,
    "var __REACT__ = exports;",
    REACT_EXPECT_SHIM,
    ...tests.map((test) => buildTestFunction(test)),
    LAST_ERROR_EXPORT,
  ].join("\n");
}

// The native oracle runs the identical generated sources — same shim, same
// prelude, same body — so any difference is attributable to the compiler.
function buildNativeRunners(tests) {
  const source = [
    REACT_EXPECT_SHIM,
    ...tests.map((test) => buildTestFunction(test, { exported: false })),
    `return { __lastError: function () { return __lastError; }, tests: { ${tests
      .map((test) => `${JSON.stringify(test.id)}: ${test.id}`)
      .join(", ")} } };`,
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function("__REACT__", source);
}

async function runNative(tests, nativeReact) {
  try {
    const runners = buildNativeRunners(tests)(nativeReact);
    const out = [];
    for (const test of tests) {
      let value;
      let error = null;
      try {
        // An async upstream body returns a promise; awaiting it here is what
        // makes its assertions observable at all. A rejection is a failure,
        // exactly as Jest would score it.
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

// A compile diagnostic points at a byte offset in the generated module. Map it
// back to the test that owns it so a single bad test can be quarantined instead
// of poisoning the whole run.
function quarantineFromErrors(moduleSource, tests, errors) {
  const offenders = new Set();
  for (const error of errors) {
    const marker = error.file ? null : null;
    void marker;
    const position = typeof error.start === "number" ? error.start : null;
    const line = typeof error.line === "number" ? error.line : null;
    let index = position;
    if (index === null && line !== null) {
      const lines = moduleSource.split("\n");
      index = lines.slice(0, line).join("\n").length;
    }
    if (index === null) continue;
    // Which test function contains this offset?
    for (const test of tests) {
      const start = moduleSource.indexOf(`export function ${test.id}(`);
      if (start === -1) continue;
      const end = moduleSource.indexOf("\nexport function ", start + 1);
      if (index >= start && (end === -1 || index < end)) {
        offenders.add(test.id);
        break;
      }
    }
  }
  return offenders;
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);

  // --- 1. ACQUIRE ----------------------------------------------------------
  const { root: packageRoot, version, pin } = setupReact();
  const { root: suiteRoot, pin: suitePin } = setupReactUpstreamSuite();
  const productionModulePath = join(packageRoot, "package", "cjs", "react.production.js");
  const reactSource = readFileSync(productionModulePath, "utf-8");

  const report = {
    generatedAt: new Date().toISOString(),
    react: { version, source: pin.tarball, entryModule: "package/cjs/react.production.js" },
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
  // Admit every upstream test the harness can physically turn into a callable
  // function — including the ones that reach for ReactDOM / jest / a document,
  // which are expected to fail. A failure that is RUN and counted is honest;
  // a test filtered out before it runs is invisible. Only the structural
  // rejection left is a `done`-callback signature, which has no scheduler to
  // invoke it. Async bodies DO run — see buildTestFunction / the awaits below.
  const extracted = extractReactUpstreamTests({
    root: suiteRoot,
    testFiles: suitePin.testFiles,
    admitAll: process.env.DOGFOOD_REACT_ADMIT_ALL !== "0",
  });
  report.extraction = {
    upstreamTestsSeen: extracted.tests.length + extracted.rejected.length,
    admitted: extracted.tests.length,
    rejected: extracted.rejected.length,
    rejectionCounts: extracted.rejectionCounts,
    rejectedTests: extracted.rejected,
  };
  log(
    `[dogfood] react@${version} upstream @ ${suitePin.tag}: ` +
      `${extracted.tests.length} of ${extracted.tests.length + extracted.rejected.length} upstream tests admitted`,
  );

  // --- 3-5. COMPILE + RUN, ONE BATCH PER UPSTREAM FILE ----------------------
  //
  // Deliberately NOT one module for all of them. A single invalid function
  // makes `WebAssembly.compile` reject the WHOLE binary, so with every test in
  // one unit one compiler bug costs every result: admitting all 132 tests
  // pushed the module to 537 KB, tripped #3775 in React's `startTransition`,
  // and took the pass count from 39 to 0 — not because anything regressed, but
  // because nothing could run. Batching per upstream file bounds that blast
  // radius to the batch, and the failing batch is still REPORTED rather than
  // dropped.
  const require = createRequire(import.meta.url);
  const nativeReact = require(productionModulePath);

  const batches = new Map();
  for (const test of extracted.tests) {
    if (!batches.has(test.file)) batches.set(test.file, []);
    batches.get(test.file).push(test);
  }

  const quarantined = [];
  const batchReports = [];
  const runResults = new Map();
  let admitted = [];
  let totalCompileMs = 0;
  let totalBytes = 0;

  // Compile one group, subdividing on a VALIDATION failure. #3775 is triggered
  // by module size, not by any single test — React's own `startTransition`
  // emits an invalid `if` once the unit grows past some threshold — so halving
  // the group is what recovers the tests around it. Recursion bottoms out at a
  // single test, which is then reported unrunnable rather than silently lost.
  const compileGroup = async (file, groupTests, depth = 0) => {
    let batchTests = groupTests;
    let result = null;
    let moduleSource = "";
    let compileMs = 0;

    for (let attempt = 0; attempt < 4 && batchTests.length > 0; attempt++) {
      moduleSource = buildModuleSource(reactSource, batchTests);
      const started = performance.now();
      try {
        result = await compile(moduleSource, { fileName: "react.production.js", skipSemanticDiagnostics: true });
      } catch (thrown) {
        result = { success: false, errors: [{ message: thrown instanceof Error ? thrown.message : String(thrown) }] };
      }
      compileMs += Math.round(performance.now() - started);
      if (result.success && result.binary?.length) break;

      const offenders = quarantineFromErrors(moduleSource, batchTests, result.errors ?? []);
      if (offenders.size === 0) break;
      for (const test of batchTests) {
        if (offenders.has(test.id)) quarantined.push({ ...test, reason: "compile-rejected" });
      }
      batchTests = batchTests.filter((test) => !offenders.has(test.id));
    }

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

    // Invalid and still divisible → halve and retry. Recovers every test that
    // is not adjacent to whatever pushed this unit over the #3775 threshold.
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

    const nativeResults = new Map((await runNative(batchTests, nativeReact)).map((entry) => [entry.id, entry]));
    for (const test of batchTests) {
      runResults.set(test.id, { native: nativeResults.get(test.id) ?? {}, compiled, firstError });
    }
  };

  for (const [file, fileTests] of batches) await compileGroup(file, fileTests);

  const invalidBatches = batchReports.filter((batch) => !batch.validates);
  report.compile = {
    success: batchReports.every((batch) => batch.compileSuccess),
    durationMs: totalCompileMs,
    binaryBytes: totalBytes,
    batches: batchReports,
    invalidBatches: invalidBatches.length,
    quarantined: quarantined.map((test) => ({ id: test.id, fullName: test.fullName, reason: test.reason })),
  };
  report.validation = {
    validates: invalidBatches.length === 0,
    firstError: invalidBatches[0]?.firstError ?? null,
  };

  const tests = [];
  for (const test of admitted) {
    const { native, compiled, firstError } = runResults.get(test.id) ?? {};
    const readCompiledError = () => {
      try {
        return compiled?.__react_last_error?.() ?? "";
      } catch {
        return "";
      }
    };
    const entry = {
      id: test.id,
      file: test.file,
      fullName: test.fullName,
      nativePassed: native.value === 1,
      nativeMessage: native.error ?? native.message ?? "",
    };

    if (!entry.nativePassed) {
      // The harness could not reproduce this upstream test natively — it needs
      // ReactDOM, a document, jest's module registry, or React's private test
      // utils. Running it was still worth it (that is why it is admitted at
      // all), but a test the ORACLE cannot pass says nothing about the
      // compiler, so it is excluded from the score and reported in its own
      // bucket rather than counted as a compiler failure.
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
    if (value !== 1) entry.compiledMessage = readCompiledError();
    tests.push(entry);
  }

  const scored = tests.filter((test) => test.status !== "harness-incompatible");
  const passed = tests.filter((test) => test.status === "pass").length;
  const failed = scored.length - passed;

  const failuresByFile = {};
  for (const test of tests) {
    if (test.status === "fail" || test.status === "trapped") {
      failuresByFile[test.file] = (failuresByFile[test.file] ?? 0) + 1;
    }
  }

  report.results = {
    scored: scored.length,
    passed,
    failed,
    harnessIncompatible: tests.length - scored.length,
    failuresByFile,
    tests,
  };
  report.summary = {
    // Three numbers, not one. "39/55" alone hides that 272 upstream tests ran;
    // "272 admitted" alone hides that most of them cannot be scored because the
    // native oracle fails them too.
    headline:
      `${passed}/${scored.length} scored upstream React tests pass against compiled Wasm ` +
      `(${report.extraction.admitted} of ${report.extraction.upstreamTestsSeen} upstream tests run; ` +
      `${tests.length - scored.length} need infrastructure the harness cannot supply)`,
    passRatePct: scored.length ? Number(((passed / scored.length) * 100).toFixed(2)) : 0,
    upstreamTestsSeen: report.extraction.upstreamTestsSeen,
    admitted: report.extraction.admitted,
    scored: scored.length,
    passed,
    failed,
    harnessIncompatible: report.results.harnessIncompatible,
    quarantined: quarantined.length,
    compileMs: totalCompileMs,
    binaryBytes: report.compile.binaryBytes,
    batches: batchReports.length,
    invalidBatches: invalidBatches.length,
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
