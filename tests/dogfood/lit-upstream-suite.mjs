// lit upstream-suite dogfood harness — lit's OWN unit tests, run against lit
// compiled to WebAssembly.
//
// Loop:
//   1. ACQUIRE  — the three PUBLISHED tarballs that actually contain lit's
//                 implementation (lit-html, @lit/reactive-element, lit-element),
//                 sha1-verified, plus the matching monorepo tag at its immutable
//                 commit. The `lit` tarball itself is a four-line barrel with no
//                 implementation in it, so compiling `lit/index.js` — which is
//                 what the package-entry card does — proves almost nothing.
//                 See setup-lit-upstream-suite.mjs.
//   2. EXTRACT  — lift every `test()` out of lit's real test files, verbatim,
//                 with its `suite` scope and `setup` prelude. ALL of them run,
//                 including the ~90 % that need a DOM, which are expected to
//                 fail. See lit-upstream-extract.mjs.
//   3. BUNDLE   — resolve each test file's imports through the published
//                 packages' OWN `exports` maps and bundle them to one ESM
//                 module, rebound as plain values. A specifier lit's repo has
//                 but npm does not ship (its internal test-utils,
//                 @web/test-runner) resolves to a stub that throws on use, so
//                 the test still runs and still fails on both sides.
//   4. COMPILE  — the bundled IMPLEMENTATION is compiled ALONE first. If that
//                 module is already invalid (#3978) then every batch containing
//                 it is invalid, and subdividing is pure wasted wall clock — so
//                 the file is reported and its tests skip compilation. When it
//                 IS valid, tests compile ONE MODULE PER UPSTREAM FILE (not one
//                 for the whole suite): a single invalid function makes
//                 WebAssembly.compile reject the WHOLE binary, so a unit that
//                 fails VALIDATION is halved and retried, bounding the blast
//                 radius of #3775.
//   5. ORACLE   — run the SAME generated sources natively against the SAME
//                 published lit. A test that fails natively is harness-
//                 incompatible: it is excluded from the compiler score and
//                 reported in its own bucket, never counted as a compiler bug.
//   6. RUN+DIFF — run each admitted test inside Wasm and diff against native.
//   7. REPORT   — JSON surface report + human summary.
//
// Invoke:  pnpm run dogfood:lit-upstream-suite
//          node tests/dogfood/lit-upstream-suite.mjs --json

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import * as esbuild from "esbuild";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupLitImplementation, setupLitUpstreamSuite } from "./setup-lit-upstream-suite.mjs";
import { extractLitUpstreamTests } from "./lit-upstream-extract.mjs";
import { LIT_ASSERT_SHIM, LAST_ERROR_EXPORT, buildTestFunction } from "./lit-upstream-shim.mjs";
import { installReactTestEnvironment } from "./react-test-environment.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "lit-upstream-suite.json");
const NAMESPACE = "__LIT__";

// Upstream inlines a lot of shared scaffolding into each `suite`, and that
// scope prelude is replicated into every lifted test — so lit-html_test.ts
// alone would generate a ~3 MB module from 204 tests. Splitting a group up
// front by generated size is not the same lever as the validation-failure
// subdivision below: this one keeps a unit small enough to compile in
// reasonable time at all, while that one exists to bound #3775's blast radius.
// Without it the harness spends most of its wall clock compiling modules that
// were always going to be halved anyway.
const MAX_BATCH_CHARS = 120_000;

// A specifier the published tarballs do not carry (lit's repo-internal
// `test-utils`, `@web/test-runner-commands`, a node builtin). Stubbing rather
// than failing the bundle is what lets the test RUN: it throws on first use and
// fails identically on both sides, landing in `harness-incompatible` instead of
// disappearing from the corpus.
const STUB_SOURCE =
  "module.exports = new Proxy(function () {}, {\n" +
  "  get: function (target, key) {\n" +
  '    if (key === "__esModule") return true;\n' +
  "    if (key === Symbol.toPrimitive || typeof key === 'symbol') return undefined;\n" +
  '    throw new Error("lit-dogfood: `" + String(key) + "` comes from a module the published tarballs do not ship");\n' +
  "  },\n" +
  '  apply: function () { throw new Error("lit-dogfood: called a module the published tarballs do not ship"); },\n' +
  "});\n";

const LIT_TESTING_STUB_SOURCE =
  "module.exports = {\n" +
  "  stripExpressionComments: function (html) { return String(html).replace(/<!--\\?lit\\$[0-9]+\\$-->|<!--\\??-->/g, ''); },\n" +
  "  stripExpressionMarkers: function (html) { return String(html).replace(/<!--\\?lit\\$[0-9]+\\$-->|<!--\\??-->|lit\\$[0-9]+\\$/g, ''); },\n" +
  "  nextFrame: function () { return new Promise(function (resolve) { requestAnimationFrame(resolve); }); },\n" +
  "};\n";

/**
 * Bundles one upstream test file's imports into a single module exposing every
 * binding the file's tests reference. Resolution goes through the packages'
 * published `exports` maps via a real node_modules layout — not a hand-rolled
 * path rewrite that could pick a file npm would never serve.
 */
async function bundleImports(fileRecord, { nodeModules, resolveDir }) {
  const lines = [];
  const exposed = new Map();
  let index = 0;
  for (const entry of fileRecord.imports) {
    const alias = `__m${index++}`;
    if (entry.bindings.some((binding) => binding.imported === "*")) {
      lines.push(`import * as ${alias} from ${JSON.stringify(entry.from)};`);
    } else {
      const clause = entry.bindings
        .map((binding) =>
          binding.imported === "default"
            ? `default as ${alias}_${binding.local}`
            : `${binding.imported} as ${alias}_${binding.local}`,
        )
        .join(", ");
      lines.push(`import { ${clause} } from ${JSON.stringify(entry.from)};`);
    }
    for (const binding of entry.bindings) {
      // A later import of the same local name shadows an earlier one, exactly
      // as it would in the upstream module.
      exposed.set(binding.local, binding.imported === "*" ? alias : `${alias}_${binding.local}`);
    }
  }
  const exportClause = [...exposed.entries()]
    .map(([local, source]) => `${source} as ${JSON.stringify(local)}`)
    .join(", ");
  const entrySource = `${lines.join("\n")}\nexport { ${exportClause} };\n`;

  const stubbed = new Set();
  const result = await esbuild.build({
    stdin: { contents: entrySource, resolveDir, sourcefile: "lit-entry.js", loader: "js" },
    bundle: true,
    write: false,
    // ESM, NOT iife+globalName. The iife wrapper routes every export through
    // esbuild's `__toCommonJS`, which exposes them as lazy accessor properties
    // — and reading those through the compiled module yielded `undefined` for
    // every binding, so all nine natively-passing tests failed for a reason
    // that had nothing to do with lit. The ESM output has no accessor
    // machinery at all, and its trailing `export {}` clause gives the exact
    // internal→public name mapping needed to rebind them as plain values.
    format: "esm",
    target: "es2020",
    platform: "browser",
    legalComments: "none",
    logLevel: "silent",
    nodePaths: [nodeModules],
    plugins: [
      {
        name: "lit-dogfood-stub",
        setup(build) {
          build.onResolve({ filter: /.*/ }, (args) => {
            if (args.kind === "entry-point") return null;
            if (/^(lit|lit-html|lit-element|@lit\/reactive-element)(\/.*)?$/.test(args.path)) return null;
            // A RELATIVE specifier reached from inside one of the published
            // packages is that package's own module graph and must resolve
            // normally. A relative specifier in the generated ENTRY is a test
            // file importing lit's repo-internal helpers (`../test-utils/…`,
            // `./test-async-iterable.js`) — those ship in no tarball, and
            // resolving them against the implementation root is impossible, so
            // they stub like any other unavailable module.
            const fromEntry = !args.importer || args.importer.endsWith("lit-entry.js");
            if ((args.path.startsWith(".") || args.path.startsWith("/")) && !fromEntry) return null;
            stubbed.add(args.path);
            return { path: `stub:${args.path}`, namespace: "lit-stub" };
          });
          build.onResolve({ filter: /.*/, namespace: "lit-stub" }, (args) => ({
            path: args.path,
            namespace: "lit-stub",
          }));
          build.onLoad({ filter: /.*/, namespace: "lit-stub" }, (args) => ({
            contents: args.path.endsWith("@lit-labs/testing") ? LIT_TESTING_STUB_SOURCE : STUB_SOURCE,
            loader: "js",
          }));
        },
      },
    ],
  });

  // Turn the ESM bundle into a self-contained module value. The bundle body
  // goes inside a function so its (minified, single-letter) internal names can
  // never collide with the upstream local names rebound afterwards, and the
  // returned object literal is plain data — no accessors.
  const text = result.outputFiles[0].text;
  const clause = text.match(/export\s*\{([^}]*)\}\s*;?\s*$/);
  const pairs = [];
  if (clause) {
    for (const part of clause[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const [internal, publicName] = trimmed.split(/\s+as\s+/).map((piece) => piece.trim().replace(/^["']|["']$/g, ""));
      pairs.push([publicName ?? internal, internal]);
    }
  }
  const body = clause ? text.slice(0, clause.index) : text;
  const source = `function __litModule() {\n${body}\nreturn { ${pairs
    .map(([publicName, internal]) => `${JSON.stringify(publicName)}: ${internal}`)
    .join(", ")} };\n}\nvar ${NAMESPACE} = __litModule();`;

  return { source, names: pairs.map(([publicName]) => publicName), stubbed: [...stubbed] };
}

// Rebinds each imported value under the identifier the upstream file's own
// `import` statement bound, so the lifted body sees exactly the names it was
// written against.
function bindingPrelude(names) {
  if (names.length === 0) return "";
  return names.map((name) => `var ${name} = ${NAMESPACE}[${JSON.stringify(name)}];`).join("\n");
}

function buildModuleSource(bundle, tests) {
  return [
    bundle.source,
    bindingPrelude(bundle.names),
    LIT_ASSERT_SHIM,
    ...tests.map((test) => buildTestFunction(test)),
    LAST_ERROR_EXPORT,
  ].join("\n");
}

// The native oracle runs the identical generated sources — same bundle, same
// shim, same prelude, same body — so any difference is the compiler.
function buildNativeRunners(bundle, tests) {
  const source = [
    bundle.source,
    bindingPrelude(bundle.names),
    LIT_ASSERT_SHIM,
    ...tests.map((test) => buildTestFunction(test, { exported: false })),
    `return { __lastError: function () { return __lastError; }, tests: { ${tests
      .map((test) => `${JSON.stringify(test.id)}: ${test.id}`)
      .join(", ")} } };`,
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function(source);
}

async function runNative(bundle, tests) {
  try {
    const runners = buildNativeRunners(bundle, tests)();
    const out = [];
    for (const test of tests) {
      let value;
      let error = null;
      try {
        // An async upstream body returns a promise; awaiting it here is what
        // makes its assertions observable at all.
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

// Compiles the bundled implementation ALONE — no tests at all. This is the
// question the per-test subdivision cannot answer: if the implementation
// module is already invalid, then EVERY batch containing it is invalid, and
// halving is pure wasted wall clock (it bottoms out at one test and still
// fails). It is also the more interesting result — an invalid module here
// means js2wasm cannot compile lit's published bytes, full stop, which no
// per-test number would ever surface.
async function compileImplementationOnly(bundle) {
  const source = [bundle.source, bindingPrelude(bundle.names), "export function __probe() {\n  return 1;\n}"].join(
    "\n",
  );
  const started = performance.now();
  let result;
  try {
    result = await compile(source, { fileName: "lit.js", skipSemanticDiagnostics: true });
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

// Splits a file's tests into chunks whose generated source stays under
// MAX_BATCH_CHARS. A single test larger than the budget still gets its own
// chunk — it is never dropped for being big.
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

// A compile diagnostic points at a byte offset in the generated module. Map it
// back to the test that owns it so a single bad test can be quarantined instead
// of poisoning the whole run.
function quarantineFromErrors(moduleSource, tests, errors) {
  const offenders = new Set();
  for (const error of errors) {
    let index = typeof error.start === "number" ? error.start : null;
    if (index === null && typeof error.line === "number") {
      index = moduleSource.split("\n").slice(0, error.line).join("\n").length;
    }
    if (index === null) continue;
    for (const test of tests) {
      const start = moduleSource.indexOf(`export function ${test.id}(`);
      const startAsync = moduleSource.indexOf(`export async function ${test.id}(`);
      const from = start === -1 ? startAsync : start;
      if (from === -1) continue;
      const end = moduleSource.indexOf("\nexport ", from + 1);
      if (index >= from && (end === -1 || index < end)) {
        offenders.add(test.id);
        break;
      }
    }
  }
  return offenders;
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  // Lit's upstream tests run under Web Test Runner in a browser. Install the
  // same explicit jsdom globals for the native oracle and the compiled lane;
  // without this, every DOM/custom-elements test is mislabeled as unavailable
  // infrastructure before lit itself gets a chance to run.
  const dom = installReactTestEnvironment();
  // Lit's published bundles use these version registries as process-global
  // duplicate-package guards. Web Test Runner creates them before loading
  // lit; mirror that host bootstrap so the native oracle does not fail while
  // constructing the implementation bundle.
  const previousLitHtmlVersions = globalThis.litHtmlVersions;
  const previousLitElementVersions = globalThis.litElementVersions;
  if (!Array.isArray(globalThis.litHtmlVersions)) globalThis.litHtmlVersions = [];
  if (!Array.isArray(globalThis.litElementVersions)) globalThis.litElementVersions = [];

  // --- 1. ACQUIRE ----------------------------------------------------------
  const implementation = setupLitImplementation();
  const { root: suiteRoot, pin: suitePin } = setupLitUpstreamSuite();

  const report = {
    generatedAt: new Date().toISOString(),
    lit: {
      // Deliberately NOT the `lit` tarball: it is a barrel. These are the
      // published packages that carry the implementation under test.
      packages: implementation.packages.map((entry) => ({
        name: entry.name,
        version: entry.version,
        source: entry.tarball,
        entryModule: entry.entryModule,
      })),
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
  const extracted = extractLitUpstreamTests({
    root: suiteRoot,
    testFiles: suitePin.testFiles,
    admitAll: process.env.DOGFOOD_LIT_ADMIT_ALL !== "0",
    // The harness installs these browser surfaces through jsdom before
    // extraction. Conservative mode must not call a supplied DOM API
    // "unavailable" merely because the upstream source mentions it.
    supportedInfrastructure: new Set([
      "needs-dom",
      "needs-custom-elements",
      "needs-window",
      "needs-shadow-dom",
      "needs-constructable-stylesheets",
      "needs-dev-mode-warnings",
    ]),
  });
  report.extraction = {
    upstreamTestsSeen: extracted.tests.length + extracted.rejected.length,
    admitted: extracted.tests.length,
    rejected: extracted.rejected.length,
    rejectionCounts: extracted.rejectionCounts,
    rejectedTests: extracted.rejected,
  };
  log(
    `[dogfood] lit @ ${suitePin.tag}: ` +
      `${extracted.tests.length} of ${extracted.tests.length + extracted.rejected.length} upstream tests admitted`,
  );

  // --- 3-6. BUNDLE + COMPILE + RUN, ONE BATCH PER UPSTREAM FILE -------------
  const quarantined = [];
  const batchReports = [];
  const runResults = new Map();
  const bundleFailures = [];
  const implementationInvalid = [];
  let admitted = [];
  let totalCompileMs = 0;
  let totalBytes = 0;

  const compileGroup = async (file, bundle, groupTests, depth = 0) => {
    let batchTests = groupTests;
    let result = null;
    let moduleSource = "";
    let compileMs = 0;

    for (let attempt = 0; attempt < 4 && batchTests.length > 0; attempt++) {
      moduleSource = buildModuleSource(bundle, batchTests);
      const started = performance.now();
      try {
        result = await compile(moduleSource, { fileName: "lit.js", skipSemanticDiagnostics: true });
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
      await compileGroup(file, bundle, batchTests.slice(0, middle), depth + 1);
      await compileGroup(file, bundle, batchTests.slice(middle), depth + 1);
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

    const nativeResults = new Map((await runNative(bundle, batchTests)).map((entry) => [entry.id, entry]));
    for (const test of batchTests) {
      runResults.set(test.id, { native: nativeResults.get(test.id) ?? {}, compiled, firstError });
    }
  };

  for (const fileRecord of extracted.files) {
    if (fileRecord.tests.length === 0) continue;
    let bundle;
    try {
      bundle = await bundleImports(fileRecord, {
        nodeModules: implementation.nodeModules,
        resolveDir: implementation.root,
      });
    } catch (error) {
      // The file's own imports could not be resolved even to stubs. Its tests
      // are reported as unrunnable by name, never silently dropped.
      const message = error instanceof Error ? error.message : String(error);
      bundleFailures.push({ file: fileRecord.file, error: message.slice(0, 300) });
      for (const test of fileRecord.tests) quarantined.push({ ...test, reason: "bundle-failed" });
      log(`[dogfood]   ${fileRecord.file.replace(/^.*\//, "")}: BUNDLE FAILED — ${message.slice(0, 70)}`);
      continue;
    }
    // Ask first whether the implementation this file imports compiles to a
    // VALID module at all, before spending any time on its tests.
    const baseline = await compileImplementationOnly(bundle);
    totalCompileMs += baseline.compileMs;
    if (!baseline.validates) {
      implementationInvalid.push({
        file: fileRecord.file,
        tests: fileRecord.tests.length,
        stubbed: bundle.stubbed,
        error: String(baseline.error).slice(0, 300),
      });
      log(
        `[dogfood]   ${fileRecord.file.replace(/^.*\//, "")}: implementation INVALID before any test — ` +
          `${String(baseline.error).slice(0, 80)}`,
      );
      // The tests still RUN natively, so the report can say how many of them
      // the compiler would have to get right — they are scored as failures,
      // not quietly dropped.
      admitted = admitted.concat(fileRecord.tests);
      const nativeResults = new Map((await runNative(bundle, fileRecord.tests)).map((entry) => [entry.id, entry]));
      for (const test of fileRecord.tests) {
        runResults.set(test.id, {
          native: nativeResults.get(test.id) ?? {},
          compiled: null,
          firstError: `implementation module invalid: ${String(baseline.error).slice(0, 200)}`,
        });
      }
      continue;
    }

    for (const chunk of splitBySize(fileRecord.tests)) {
      await compileGroup(fileRecord.file, bundle, chunk);
    }
  }

  const invalidBatches = batchReports.filter((batch) => !batch.validates);
  report.compile = {
    success: batchReports.every((batch) => batch.compileSuccess),
    durationMs: totalCompileMs,
    binaryBytes: totalBytes,
    batches: batchReports,
    invalidBatches: invalidBatches.length,
    bundleFailures,
    // The headline finding when it is non-empty: these files' tests never had a
    // chance, because the lit implementation they import does not compile to a
    // valid Wasm module even with no test code attached.
    implementationInvalid,
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
        return compiled?.__lit_last_error?.() ?? "";
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
      // a document, custom elements, or lit's repo-internal test utils.
      // Running it was still worth it, but a test the ORACLE cannot pass says
      // nothing about the compiler, so it is excluded from the score and
      // reported in its own bucket rather than counted as a compiler failure.
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
    // Three numbers, not one. A bare pass rate hides how much of lit's suite
    // ran; a bare "admitted" hides that most of it cannot be scored because it
    // needs a browser the harness has no way to supply.
    headline:
      `${passed}/${scored.length} scored upstream lit tests pass against compiled Wasm ` +
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
    bundleFailures: bundleFailures.length,
    implementationInvalidFiles: implementationInvalid.length,
    implementationInvalidTests: implementationInvalid.reduce((sum, entry) => sum + entry.tests, 0),
    binaryValidates: report.validation.validates,
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  if (previousLitHtmlVersions === undefined) delete globalThis.litHtmlVersions;
  else globalThis.litHtmlVersions = previousLitHtmlVersions;
  if (previousLitElementVersions === undefined) delete globalThis.litElementVersions;
  else globalThis.litElementVersions = previousLitElementVersions;
  dom.cleanup();
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
