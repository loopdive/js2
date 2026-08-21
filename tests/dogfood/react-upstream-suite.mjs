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
import { installReactTestEnvironment } from "./react-test-environment.mjs";
import { installReactUpstreamInfrastructure } from "./react-upstream-infrastructure.mjs";
import { REACT_EXPECT_SHIM, LAST_ERROR_EXPORT, buildTestFunction } from "./react-upstream-shim.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "react-upstream-suite.json");
// React's lifted suite intentionally admits tests that need infrastructure the
// harness cannot provide. Those tests still run against the native oracle and
// the compiled lane, but a missing async dependency must not hold the complete
// npm-compat refresh for ten seconds per test. The timeout is a watchdog, not
// a test selection filter: timed-out tests remain in the report as failures or
// harness-incompatible results.
const DEFAULT_REACT_TEST_TIMEOUT_MS = 2_000;

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
  return new Function("__REACT__", "require", source);
}

function withTimeout(value, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([Promise.resolve(value), timeout]).finally(() => clearTimeout(timer));
}

async function runNative(tests, nativeReact, timeoutMs, infrastructure) {
  try {
    // A few upstream tests intentionally require the published ReactDOM
    // package (for example Portal coverage).  Supplying Node's real resolver
    // to the native oracle makes that an honest host dependency; the Wasm side
    // still reports the same call as unavailable if the compiler cannot lower
    // it, rather than hiding the gap behind an oracle-build failure.
    const nativeRequire = createRequire(import.meta.url);
    const hostRequire = (name) => {
      // These packages are React's monorepo-only test infrastructure and are
      // intentionally absent from node_modules. Resolve them through the same
      // explicit host surface used by the compiled lane so a native failure
      // means the test or implementation disagrees, not that the oracle could
      // not find a package that was never published.
      if (name === "react") return nativeReact;
      if (name === "react-dom") return infrastructure?.reactDom ?? nativeRequire(name);
      if (name === "react-dom/client") return infrastructure?.reactDomClient ?? nativeRequire(name);
      if (name === "react-dom/server") return infrastructure?.reactDomServer ?? nativeRequire(name);
      if (name === "react-test-renderer") return infrastructure?.reactTestRenderer ?? nativeRequire(name);
      if (name === "react-noop-renderer") {
        if (!infrastructure?.reactNoop) throw new Error("React upstream noop renderer infrastructure is unavailable");
        return infrastructure.reactNoop;
      }
      if (name === "react-native-renderer") {
        if (!infrastructure?.reactNativeRenderer)
          throw new Error("React upstream native renderer infrastructure is unavailable");
        return infrastructure.reactNativeRenderer;
      }
      if (name === "internal-test-utils") {
        if (!infrastructure?.internalTestUtils)
          throw new Error("React upstream internal test utilities are unavailable");
        return infrastructure.internalTestUtils;
      }
      if (name === "react/jsx-runtime") return infrastructure?.reactJsxRuntime ?? nativeRequire(name);
      if (name === "react/jsx-dev-runtime") return infrastructure?.reactJsxDevRuntime ?? nativeRequire(name);
      if (name === "create-react-class") return infrastructure?.createReactClass ?? nativeRequire(name);
      if (name === "create-react-class/factory") {
        const factory = nativeRequire("create-react-class/factory");
        return factory;
      }
      return nativeRequire(name);
    };
    const runners = buildNativeRunners(tests)(nativeReact, hostRequire);
    const out = [];
    for (const test of tests) {
      let value;
      let error = null;
      try {
        // An async upstream body returns a promise; awaiting it here is what
        // makes its assertions observable at all. A rejection is a failure,
        // exactly as Jest would score it.
        value = await withTimeout(runners.tests[test.id](), timeoutMs, `native ${test.fullName}`);
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

export async function runHarness({
  quiet = false,
  filter = process.env.DOGFOOD_REACT_FILTER || "",
  testTimeoutMs = Number(process.env.DOGFOOD_REACT_TEST_TIMEOUT_MS || DEFAULT_REACT_TEST_TIMEOUT_MS),
  compileTimeoutMs = Number(process.env.DOGFOOD_REACT_COMPILE_TIMEOUT_MS || 30_000),
} = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  installReactTestEnvironment();

  // --- 1. ACQUIRE ----------------------------------------------------------
  const { root: packageRoot, version, pin } = setupReact();
  const { root: suiteRoot, pin: suitePin } = setupReactUpstreamSuite();
  // Jest runs React's upstream unit files against the development build. Keep
  // the published production artifact as the default npm-compat lane, while
  // allowing the upstream harness to select the matching development graph so
  // warning/act assertions are not misclassified as missing infrastructure.
  const build = process.env.DOGFOOD_REACT_BUILD === "development" ? "development" : "production";
  const modulePath = join(packageRoot, "package", "cjs", `react.${build}.js`);
  const reactSource = readFileSync(modulePath, "utf-8");

  const report = {
    generatedAt: new Date().toISOString(),
    react: { version, source: pin.tarball, build, entryModule: `package/cjs/react.${build}.js` },
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
  const extractedAll = extractReactUpstreamTests({
    root: suiteRoot,
    testFiles: suitePin.testFiles,
    admitAll: process.env.DOGFOOD_REACT_ADMIT_ALL !== "0",
    supportedInfrastructure: new Set([
      "needs-react-dom",
      "needs-react-noop",
      "needs-test-utils",
      "needs-act",
      "needs-console-assertions",
      // The native oracle captures console.error/warn, and the Wasm host
      // exposes the same console methods. Direct console assertions are
      // therefore test infrastructure we do provide, not a reason to reject
      // an upstream test before it runs.
      "asserts-on-console",
      "needs-jest-runtime",
      "needs-dom",
      "dev-build-only",
      "needs-feature-flags",
      "needs-scheduler",
      "needs-external-module",
    ]),
  });
  const filterPattern = filter ? new RegExp(filter, "i") : null;
  const extracted = filterPattern
    ? {
        ...extractedAll,
        tests: extractedAll.tests.filter((test) => filterPattern.test(test.fullName)),
      }
    : extractedAll;
  report.extraction = {
    upstreamTestsSeen: extractedAll.tests.length + extractedAll.rejected.length,
    admitted: extracted.tests.length,
    rejected: extractedAll.rejected.length,
    rejectionCounts: extractedAll.rejectionCounts,
    rejectedTests: extractedAll.rejected,
    ...(filterPattern ? { filter } : {}),
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
  const nativeReact = require(modulePath);
  const hostInfrastructure = installReactUpstreamInfrastructure({ react: nativeReact, build });

  const batches = new Map();
  for (const test of extracted.tests) {
    // The create-react-class integration file contains a large amount of
    // nested class/factory code. Compiling all 27 lifted bodies as one module
    // can keep the compiler busy indefinitely; one real upstream test per
    // module bounds that compiler work without removing or rewriting tests.
    const batchKey = test.file.endsWith("createReactClassIntegration-test.js") ? `${test.file}::${test.id}` : test.file;
    if (!batches.has(batchKey)) batches.set(batchKey, []);
    batches.get(batchKey).push(test);
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
        result = await withTimeout(
          compile(moduleSource, { fileName: `react.${build}.js`, skipSemanticDiagnostics: true }),
          compileTimeoutMs,
          `compile ${file}`,
        );
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

    const reportFile = file.split("::", 1)[0];
    batchReports.push({
      file: reportFile,
      tests: batchTests.length,
      compileMs,
      binaryBytes: result?.binary?.length ?? 0,
      compileSuccess: result?.success ?? false,
      validates,
      firstError,
    });
    log(
      `[dogfood]   ${reportFile.replace(/^.*\//, "")}: ${batchTests.length} tests, ` +
        `${validates ? "valid" : `INVALID — ${String(firstError).slice(0, 70)}`}`,
    );

    // The native oracle receives the exact host React values it would see in
    // Node.  Only the compiled call path may opt into reifying values that
    // crossed the Wasm/host boundary.
    hostInfrastructure.infrastructure.prepareReactValues = false;
    const nativeResults = new Map(
      (await runNative(batchTests, nativeReact, testTimeoutMs, hostInfrastructure.infrastructure)).map((entry) => [
        entry.id,
        entry,
      ]),
    );
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
      hostInfrastructure.infrastructure.prepareReactValues = true;
      value = await withTimeout(compiled[test.id](), testTimeoutMs, `compiled ${test.fullName}`);
    } catch (error) {
      entry.status = "trapped";
      entry.compiledMessage = error instanceof Error ? error.message : String(error);
      tests.push(entry);
      continue;
    } finally {
      hostInfrastructure.infrastructure.prepareReactValues = false;
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
    executed: tests.length,
    scored: scored.length,
    passed,
    failed,
    harnessIncompatible: tests.length - scored.length,
    failuresByFile,
    tests,
  };
  report.summary = {
    // One score cannot expose tests rejected by compilation or by the native
    // oracle. Keep selected, executed, compiler-quarantined and infrastructure
    // counts distinct.
    headline:
      `${passed}/${scored.length} scored upstream React tests pass against compiled Wasm ` +
      `(${tests.length} of ${report.extraction.upstreamTestsSeen} upstream tests executed; ` +
      `${quarantined.length} compile-quarantined; ${tests.length - scored.length} need infrastructure)`,
    passRatePct: scored.length ? Number(((passed / scored.length) * 100).toFixed(2)) : 0,
    upstreamTestsSeen: report.extraction.upstreamTestsSeen,
    admitted: report.extraction.admitted,
    executed: tests.length,
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
  hostInfrastructure.cleanup();
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
