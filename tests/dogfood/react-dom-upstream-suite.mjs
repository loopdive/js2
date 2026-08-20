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
//   1. TWO published CJS modules make up the client implementation (the shared
//      entry and the client renderer), and each needs its OWN function scope:
//      react and react-dom both declare a top-level `noop`, so a bare
//      concatenation dies with `Duplicate identifier 'noop'` before a single
//      test runs.
//   2. `require("react")` / `require("react-dom")` / `require("scheduler")`
//      inside those modules are rewired to the in-module values.
//   3. Each implementation graph is compiled ALONE first (the #3977 lit
//      lesson): if it cannot produce a valid module, subdividing per test is
//      wasted wall clock and hides the real finding. Client and server graphs
//      therefore report independent compile/validation results.
//
// Invoke:  pnpm run dogfood:react-dom-upstream-suite
//          node tests/dogfood/react-dom-upstream-suite.mjs --json

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { createRequire } from "node:module";
import ts from "typescript";

import { compile } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupReact } from "./setup-react.mjs";
import { setupReactDomImplementation, setupReactDomUpstreamSuite } from "./setup-react-dom-upstream-suite.mjs";
import { extractReactUpstreamTests } from "./react-upstream-extract.mjs";
import { installReactTestEnvironment } from "./react-test-environment.mjs";
import { installReactUpstreamInfrastructure } from "./react-upstream-infrastructure.mjs";
import { REACT_EXPECT_SHIM, LAST_ERROR_EXPORT, buildTestFunction } from "./react-upstream-shim.mjs";
import { compileProjectInWorker, compileSourceInWorker } from "./upstream-suite-runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "react-dom-upstream-suite.json");
const GENERATED_ROOT = join(HERE, ".react-dom-upstream-suite-impl");
const PROJECT_ROOT = join(HERE, ".react-dom-upstream-suite-project");

let nativeContextFile = "<setup>";
let nativeContextTest = "<setup>";

export function isExpectedLateJsdomHostError(error) {
  return error?.name === "NotFoundError" && error?.message === "The node to be removed is not a child of this node.";
}

function installNativeHostErrorBoundary(nativeHostErrors) {
  const onUncaught = (error) => {
    if (!isExpectedLateJsdomHostError(error)) {
      process.off("uncaughtException", onUncaught);
      process.nextTick(() => {
        throw error;
      });
      return;
    }
    nativeHostErrors.push({
      file: nativeContextFile,
      test: nativeContextTest,
      name: error.name,
      message: error.message,
    });
  };
  process.on("uncaughtException", onUncaught);
  return () => process.off("uncaughtException", onUncaught);
}

// Upstream's `suite` scaffolding is replicated into every lifted test, so a
// whole file's tests can generate megabytes. Split up front by generated size —
// a separate lever from the validation-failure subdivision below, which exists
// to bound #3775's blast radius rather than to keep a unit compilable at all.
const MAX_BATCH_CHARS = 120_000;

function decodeVlq(segment) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const values = [];
  for (let i = 0; i < segment.length; ) {
    let value = 0;
    let shift = 0;
    let digit;
    do {
      digit = alphabet.indexOf(segment[i++]);
      if (digit < 0) return values;
      value |= (digit & 31) << shift;
      shift += 5;
    } while (digit & 32);
    values.push(value & 1 ? -(value >>> 1) : value >>> 1);
  }
  return values;
}

function sourceAtWasmOffset(sourceMapJson, wasmOffset) {
  if (!sourceMapJson) return null;
  const sourceMap = JSON.parse(sourceMapJson);
  let offset = 0;
  let source = 0;
  let line = 0;
  let column = 0;
  let best = null;
  for (const segment of String(sourceMap.mappings ?? "").split(",")) {
    const values = decodeVlq(segment);
    if (values.length < 4) continue;
    offset += values[0];
    source += values[1];
    line += values[2];
    column += values[3];
    if (offset > wasmOffset) break;
    best = { source: sourceMap.sources?.[source] ?? "", line: line + 1, column: column + 1 };
  }
  return best;
}

// Each published CJS module gets its own function scope. `require` calls are
// rewired to the in-module values rather than stubbed, so what runs is the
// published implementation wired to the published implementation.
function wireRequires(source) {
  return source
    .replace(/require\(\s*['"]react['"]\s*\)/g, "__REACT__")
    .replace(/require\(\s*['"]react-dom['"]\s*\)/g, "__REACTDOM_SHARED__")
    .replace(/require\(\s*['"]scheduler['"]\s*\)/g, "__SCHEDULER__");
}

const REACT_DOM_SCHEDULER_SHIM = `
var __schedulerTaskId = 0;
exports.unstable_ImmediatePriority = 1;
exports.unstable_UserBlockingPriority = 2;
exports.unstable_NormalPriority = 3;
exports.unstable_LowPriority = 4;
exports.unstable_IdlePriority = 5;
exports.unstable_now = function () { return Date.now(); };
exports.unstable_shouldYield = function () { return false; };
exports.unstable_requestPaint = function () {};
exports.unstable_getCurrentPriorityLevel = function () { return 3; };
exports.unstable_scheduleCallback = function (priority, callback) {
  var task = { id: ++__schedulerTaskId, callback: callback, timer: null };
  function run() {
    if (task.callback === null) return;
    var continuation = task.callback(false);
    task.callback = typeof continuation === "function" ? continuation : null;
    if (task.callback !== null) task.timer = setTimeout(run, 0);
  }
  task.timer = setTimeout(run, 0);
  return task;
};
exports.unstable_cancelCallback = function (task) {
  task.callback = null;
  if (task.timer !== null) clearTimeout(task.timer);
};
exports.log = undefined;
exports.unstable_setDisableYieldValue = undefined;
`;

function buildImplementationSource({ reactSource, sharedSource, clientSource }) {
  const wiredClientSource = wireRequires(clientSource);
  return [
    "var __REACT__, __SCHEDULER__, __REACTDOM_SHARED__, __REACTDOM__;",
    "var __reactDomInitialized = false;",
    "function __reactModule() { var exports = {};",
    reactSource,
    "return exports; }",
    "function __schedulerModule() { var exports = {};",
    REACT_DOM_SCHEDULER_SHIM,
    "return exports; }",
    "function __reactDomSharedModule() { var exports = {};",
    wireRequires(sharedSource),
    "return exports; }",
    "function __reactDomClientModule() { var exports = {};",
    wiredClientSource,
    "return exports; }",
    "function __reactDomEnsureInit() {",
    "if (__reactDomInitialized) return;",
    "__reactDomInitialized = true;",
    "__REACT__ = __reactModule();",
    "__SCHEDULER__ = __schedulerModule();",
    "__REACTDOM_SHARED__ = __reactDomSharedModule();",
    "__REACTDOM__ = __reactDomClientModule();",
    "}",
  ].join("\n");
}

// The server renderers are separate published CJS graphs. Keep each in its
// own module scope so the legacy SSR and browser Fizz tests can compile and
// measure independently without pulling either graph into the client WasmGC
// type graph. Their package dependencies are the pinned React and react-dom
// shared exports, both wired to the same in-module values.
function buildServerImplementationSource({ reactSource, sharedSource, serverSource, fizzSource = null }) {
  const legacyServerModule = serverSource
    ? ["function __reactDomServerModule() { var exports = {};", wireRequires(serverSource), "return exports; }"]
    : [];
  const legacyServerInit = serverSource ? ["__REACTDOM_SERVER__ = __reactDomServerModule();"] : [];
  const fizzModule = fizzSource
    ? ["function __reactDomFizzModule() { var exports = {};", wireRequires(fizzSource), "return exports; }"]
    : [];
  const fizzInit = fizzSource ? ["__REACTDOM_FIZZ__ = __reactDomFizzModule();"] : [];
  return [
    "var __REACT__, __REACTDOM_SHARED__, __REACTDOM__, __REACTDOM_SERVER__, __REACTDOM_FIZZ__, __reactDomServerInitialized = false;",
    "function __reactServerModule() { var exports = {};",
    reactSource,
    "return exports; }",
    "function __reactDomSharedServerModule() { var exports = {};",
    wireRequires(sharedSource),
    "return exports; }",
    ...legacyServerModule,
    ...fizzModule,
    "function __reactDomServerEnsureInit() {",
    "if (__reactDomServerInitialized) return;",
    "__reactDomServerInitialized = true;",
    "__REACT__ = __reactServerModule();",
    "__REACTDOM_SHARED__ = __reactDomSharedServerModule();",
    "__REACTDOM__ = __REACTDOM_SHARED__;",
    ...legacyServerInit,
    ...fizzInit,
    "}",
  ].join("\n");
}

function reactDomTestSetup(prelude, testSource = prelude, { server = false, fizz = false } = {}) {
  const lines = [
    `${server ? "__reactDomServerEnsureInit" : "__reactDomEnsureInit"}();`,
    `document.body.textContent = "";`,
  ];
  const binds = (name, expression) => {
    const declaration = new RegExp(`\\b(let|var|const)\\s+${name}\\b`).exec(prelude);
    if (declaration && declaration[1] !== "const") {
      lines.push(`${name} = ${expression};`);
    } else if (!declaration && new RegExp(`\\b${name}\\b`).test(testSource)) {
      // Imports are intentionally removed by the upstream extractor. A
      // server-renderer import therefore has no surviving declaration even
      // though the test body still uses the binding. Declare only bindings
      // that the test actually reaches for; unconditional `var` declarations
      // would collide with retained `const`/`let` preludes.
      lines.push(`var ${name} = ${expression};`);
    }
  };
  binds("React", "__REACT__");
  binds("ReactDOM", "__REACTDOM_SHARED__");
  binds("ReactDOMClient", "__REACTDOM__");
  binds("OuterReactDOMClient", "__REACTDOM__");
  binds("InnerReactDOM", "{ flushSync: __REACTDOM_SHARED__.flushSync }");
  binds("InnerReactDOMClient", "{ createRoot: __REACTDOM__.createRoot }");
  if (server) binds("ReactDOMServer", "__REACTDOM_SERVER__");
  if (fizz) {
    binds("ReactDOMFizzServer", "__REACTDOM_FIZZ__");
    binds("ReactDOMFizzStatic", "__REACTDOM_FIZZ__");
  }
  const actDeclaration = /\b(let|var|const)\s+act\b/.exec(prelude);
  if (actDeclaration && actDeclaration[1] === "const") {
    // Preserve an upstream const binding; the extractor's import rewrite owns
    // its value and assigning to it would turn a harness setup into a failure.
  } else if (actDeclaration || /\bact\b/.test(testSource)) {
    lines.push(`${actDeclaration ? "act" : "var act"} = async function (callback) {
  var result;
  __REACTDOM_SHARED__.flushSync(function () { result = callback(); });
  if (result !== null && result !== undefined && typeof result.then === "function") await result;
  return result;
};`);
  }
  return lines.join("\n");
}

const SETUP_BINDINGS = [
  "React",
  "ReactDOM",
  "ReactDOMClient",
  "OuterReactDOMClient",
  "InnerReactDOM",
  "InnerReactDOMClient",
  "ReactDOMServer",
  "ReactDOMFizzServer",
  "ReactDOMFizzStatic",
  "act",
];

// A React test often assigns host globals in its beforeEach before declaring
// the package bindings (`global.ReadableStream = ...; let React;`). Inserting
// the setup at byte zero would then assign to a lexical binding while it is in
// its temporal-dead-zone. Place setup after every variable declaration that
// declares one of the bindings we provide, while preserving all other
// prelude statements and their order.
function setupInsertionOffset(prelude) {
  const sourceFile = ts.createSourceFile(
    "react-dom-upstream-prelude.js",
    prelude,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  let offset = 0;
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const text = statement.getText(sourceFile);
    if (SETUP_BINDINGS.some((name) => new RegExp(`\\b${name}\\b`).test(text))) offset = statement.end;
  }
  return offset;
}

function withReactDomSetup(test, options = {}) {
  const setup = reactDomTestSetup(test.prelude, `${test.prelude}\n${test.body}`, options);
  const offset = setupInsertionOffset(test.prelude);
  const prelude = `${test.prelude.slice(0, offset)}\n${setup}\n${test.prelude.slice(offset)}`;
  return { ...test, prelude };
}

function buildModuleSource(implementation, tests) {
  return [
    implementation,
    REACT_EXPECT_SHIM,
    `export function __reactDomInit() { __reactDomEnsureInit(); }`,
    ...tests.map((test) => buildTestFunction(withReactDomSetup(test))),
    LAST_ERROR_EXPORT,
  ].join("\n");
}

function buildServerModuleSource(implementation, tests, options = {}) {
  return [
    implementation,
    REACT_EXPECT_SHIM,
    `export function __reactDomServerInit() { __reactDomServerEnsureInit(); }`,
    ...tests.map((test) => buildTestFunction(withReactDomSetup(test, { server: true, ...options }))),
    LAST_ERROR_EXPORT,
  ].join("\n");
}

function buildProjectModuleSource({ exportName, moduleName, imports, bindings = "", source }) {
  // The multi-file compiler currently publishes module-scope bindings in one
  // Wasm namespace. Keep the CJS export carrier top-level (so the large React
  // production bodies do not become nested function expressions), but give
  // each file a unique carrier name before exposing it as a named ESM export.
  // Reusing a bare `exports`/`default` binding across React, shared, and client
  // modules made importers observe the wrong (usually empty) object.
  const carrier = `__${moduleName}Exports`;
  const wiredSource = source.replace(/\bexports\b/g, carrier);
  return `${imports}\nconst ${carrier} = {};\n${bindings}\n${wiredSource}\nexport { ${carrier} as ${exportName} };\n`;
}

// Keep each published CJS implementation file in its own project module.
// Concatenating the 560 KB client graph into every test batch both repeats
// compilation work and makes a single compiler watchdog unable to distinguish
// a slow implementation from a pathological test body.
function buildProjectFiles({ reactSource, sharedSource, clientSource, tests }) {
  const entry = [
    'import { __reactExports } from "./react.ts";',
    'import { __sharedExports } from "./shared.ts";',
    'import { __clientExports } from "./client.ts";',
    'import { __schedulerExports } from "./scheduler.ts";',
    "const __REACT__ = __reactExports;",
    "const __REACTDOM_SHARED__ = __sharedExports;",
    "const __REACTDOM__ = __clientExports;",
    "const __SCHEDULER__ = __schedulerExports;",
    "function __reactDomEnsureInit() {}",
    REACT_EXPECT_SHIM,
    `export function __reactDomInit() { __reactDomEnsureInit(); }`,
    ...tests.map((test) => buildTestFunction(withReactDomSetup(test))),
    LAST_ERROR_EXPORT,
    `export function upstreamTestNames() { return [${tests.map((test) => JSON.stringify(test.id)).join(", ")}]; }`,
    `export function upstreamTestCount() { return ${tests.length}; }`,
  ].join("\n");
  return {
    "react.ts": buildProjectModuleSource({
      exportName: "__reactExports",
      moduleName: "react",
      imports: "",
      source: reactSource,
    }),
    "scheduler.ts": buildProjectModuleSource({
      exportName: "__schedulerExports",
      moduleName: "scheduler",
      imports: "",
      source: REACT_DOM_SCHEDULER_SHIM,
    }),
    "shared.ts": buildProjectModuleSource({
      exportName: "__sharedExports",
      moduleName: "shared",
      imports: 'import { __reactExports } from "./react.ts";',
      bindings: "var __REACT__ = __reactExports;",
      source: wireRequires(sharedSource),
    }),
    "client.ts": buildProjectModuleSource({
      exportName: "__clientExports",
      moduleName: "client",
      imports:
        'import { __reactExports } from "./react.ts";\n' +
        'import { __sharedExports } from "./shared.ts";\n' +
        'import { __schedulerExports } from "./scheduler.ts";',
      bindings:
        "var __REACT__ = __reactExports;\n" +
        "var __REACTDOM_SHARED__ = __sharedExports;\n" +
        "var __SCHEDULER__ = __schedulerExports;",
      source: wireRequires(clientSource),
    }),
    "entry.ts": entry,
  };
}

function buildNativeRunners(implementation, tests, options = {}) {
  const { server = false } = options;
  const init = server ? "__reactDomServerEnsureInit()" : "__reactDomEnsureInit()";
  const source = [
    implementation,
    REACT_EXPECT_SHIM,
    ...tests.map((test) => buildTestFunction(withReactDomSetup(test, options), { exported: false })),
    `return { init: function () { ${init}; }, __lastError: function () { return __lastError; }, tests: { ${tests
      .map((test) => `${JSON.stringify(test.id)}: ${test.id}`)
      .join(", ")} } };`,
  ].join("\n");
  // eslint-disable-next-line no-new-func
  return new Function("require", source);
}

async function runNative(implementation, tests, options = {}) {
  try {
    const nativeRequire = createRequire(import.meta.url);
    const runners = buildNativeRunners(implementation, tests, options)(nativeRequire);
    runners.init();
    const out = [];
    for (const test of tests) {
      nativeContextTest = test.id;
      let value;
      let error = null;
      try {
        value = await runners.tests[test.id]();
      } catch (thrown) {
        error = thrown instanceof Error ? thrown.message : String(thrown);
      }
      out.push({ id: test.id, value, error, message: value === 1 ? "" : runners.__lastError() });
      // React's scheduler shim uses host timers. Give those callbacks one turn
      // to settle before starting the next upstream test, while the native host
      // error boundary is still active for any late jsdom exception.
      await new Promise((resolve) => setImmediate(resolve));
    }
    return out;
  } catch (thrown) {
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    return tests.map((test) => ({ id: test.id, value: undefined, error: `oracle build failed: ${message}` }));
  }
}

async function runNativeByFile(implementation, tests, options = {}) {
  const byFile = new Map();
  for (const test of tests) {
    if (!byFile.has(test.file)) byFile.set(test.file, []);
    byFile.get(test.file).push(test);
  }
  const results = [];
  for (const [file, fileTests] of byFile) {
    nativeContextFile = file;
    results.push(...(await runNative(implementation, fileTests, options)));
  }
  return results;
}

function withCompileTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs} ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Run original server-renderer tests against a separately published browser
// bundle. This lane is intentionally independent from the client project
// lane: server graphs have different host requirements and can compile to
// valid Wasm even while the client graph is still being hardened. The same
// runner is used for the legacy `renderToString` graph and the browser Fizz
// graph (`renderToReadableStream`/`prerender`).
async function runServerHarness({
  log,
  reactSource,
  sharedSource,
  serverSource,
  fizzSource = null,
  suitePin,
  serverTests,
  lane = "legacy",
}) {
  const isFizz = fizzSource !== null;
  const configuredLimit = Number(
    process.env[isFizz ? "DOGFOOD_REACT_DOM_FIZZ_TEST_LIMIT" : "DOGFOOD_REACT_DOM_SERVER_TEST_LIMIT"] ?? 0,
  );
  const selectedTests =
    Number.isInteger(configuredLimit) && configuredLimit > 0 ? serverTests.slice(0, configuredLimit) : serverTests;
  const implementation = buildServerImplementationSource({
    reactSource,
    sharedSource,
    // Fizz is a separate published graph. Do not concatenate the legacy
    // renderer into it: the two lanes must be independently compilable and
    // independently attributable in the report.
    serverSource: isFizz ? "" : (serverSource ?? ""),
    fizzSource,
  });
  const testTimeoutMs = Number(process.env.DOGFOOD_REACT_DOM_TEST_TIMEOUT_MS ?? 10_000);
  const configuredCompileTimeout = Number(process.env.DOGFOOD_REACT_DOM_COMPILE_TIMEOUT_MS ?? 300_000);
  const compileTimeoutMs =
    Number.isFinite(configuredCompileTimeout) && configuredCompileTimeout > 0 ? configuredCompileTimeout : 300_000;
  const report = {
    lane,
    modules: [
      isFizz
        ? "package/cjs/react-dom-server.browser.production.js"
        : "package/cjs/react-dom-server-legacy.browser.production.js",
    ],
    implementationChars: implementation.length,
    extraction: {
      upstreamTestsSeen: serverTests.length,
      admitted: serverTests.length,
      selected: selectedTests.length,
      rejected: 0,
      rejectionCounts: {},
      rejectedTests: [],
    },
    compile: null,
    validation: null,
    results: null,
    summary: {},
  };
  const nativeHostErrors = [];
  const disposeNativeHostErrorBoundary = installNativeHostErrorBoundary(nativeHostErrors);

  const batchReports = [];
  const runResults = new Map();
  const admitted = [];
  let totalCompileMs = 0;
  let totalBytes = 0;

  const compileGroup = async (file, groupTests, depth = 0) => {
    const moduleSource = buildServerModuleSource(implementation, groupTests, { fizz: isFizz });
    const started = performance.now();
    let result;
    try {
      result = await withCompileTimeout(
        compile(moduleSource, {
          fileName: isFizz ? "react-dom-server.browser.js" : "react-dom-server-legacy.browser.js",
          skipSemanticDiagnostics: true,
          experimentalIR: process.env.DOGFOOD_REACT_DOM_LEGACY !== "1",
          sourceMap: true,
        }),
        compileTimeoutMs,
        `compile server ${file}`,
      );
    } catch (error) {
      result = { success: false, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
    }
    const compileMs = Math.round(performance.now() - started);
    totalCompileMs += compileMs;

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

    if (!validates && groupTests.length > 1 && depth < 6) {
      const middle = Math.ceil(groupTests.length / 2);
      await compileGroup(file, groupTests.slice(0, middle), depth + 1);
      await compileGroup(file, groupTests.slice(middle), depth + 1);
      return;
    }

    admitted.push(...groupTests);
    let compiled = null;
    if (validates) {
      try {
        const imports = result.importObject ?? {};
        const { instance } = await WebAssembly.instantiate(result.binary, imports);
        imports.setInstance?.(instance);
        imports.__setInstance?.(instance);
        instance.exports.__reactDomServerInit?.();
        compiled = wrapExports(instance.exports, { signatures: result.exportSignatures });
        totalBytes += result.binary.length;
      } catch (error) {
        firstError = `instantiate failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    }

    batchReports.push({
      file,
      tests: groupTests.length,
      compileMs,
      binaryBytes: result?.binary?.length ?? 0,
      imports: result?.imports?.map((entry) => `${entry.module}.${entry.name}`) ?? [],
      compileSuccess: result?.success ?? false,
      validates,
      firstError,
    });
    log(
      `[dogfood]   ${lane} ${file.replace(/^.*\//, "")}: ${groupTests.length} tests, ` +
        `${validates ? "valid" : `INVALID — ${String(firstError).slice(0, 70)}`}`,
    );

    nativeContextFile = file;
    const nativeResults = new Map(
      (await runNative(implementation, groupTests, { server: true, fizz: isFizz })).map((entry) => [entry.id, entry]),
    );
    for (const test of groupTests) {
      runResults.set(test.id, {
        native: nativeResults.get(test.id) ?? {},
        compiled,
        firstError,
        sourceMap: result?.sourceMap,
      });
    }
  };

  const batches = new Map();
  for (const test of selectedTests) {
    if (!batches.has(test.file)) batches.set(test.file, []);
    batches.get(test.file).push(test);
  }
  try {
    for (const [file, fileTests] of batches) {
      for (const chunk of splitBySize(fileTests)) await compileGroup(file, chunk);
    }
  } catch (error) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    disposeNativeHostErrorBoundary();
    report.compile = {
      success: false,
      durationMs: totalCompileMs,
      binaryBytes: totalBytes,
      batches: batchReports,
      invalidBatches: batchReports.filter((batch) => !batch.validates).length,
      firstError: error instanceof Error ? error.message : String(error),
    };
    report.validation = { validates: false, firstError: report.compile.firstError };
    report.results = {
      scored: 0,
      passed: 0,
      failed: 0,
      harnessIncompatible: 0,
      implementationInvalidTests: selectedTests.length,
      nativeHostErrors,
      tests: [],
    };
    report.summary = {
      headline: `0/0 executed upstream react-dom ${lane} tests pass against compiled Wasm (${selectedTests.length} selected; ${lane} lane aborted)`,
      passRatePct: 0,
      upstreamTestsSeen: serverTests.length,
      admitted: serverTests.length,
      selected: selectedTests.length,
      scored: 0,
      passed: 0,
      failed: 0,
      harnessIncompatible: 0,
      implementationInvalidTests: selectedTests.length,
      nativeHostErrors: nativeHostErrors.length,
      compileMs: totalCompileMs,
      binaryBytes: totalBytes,
      batches: batchReports.length,
      invalidBatches: report.compile.invalidBatches,
      binaryValidates: false,
      error: report.compile.firstError,
    };
    return report;
  }

  const tests = [];
  for (const test of admitted) {
    const { native, compiled, firstError, sourceMap } = runResults.get(test.id) ?? {};
    const entry = {
      id: test.id,
      file: test.file,
      fullName: test.fullName,
      nativePassed: native?.value === 1,
      nativeMessage: native?.error ?? native?.message ?? "",
    };
    if (!entry.nativePassed) {
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
    try {
      const value = await withCompileTimeout(compiled[test.id](), testTimeoutMs, `server ${test.fullName}`);
      entry.compiledPassed = value === 1;
      entry.status = value === 1 ? "pass" : "fail";
      if (value !== 1) entry.compiledMessage = compiled.__react_last_error?.() ?? "";
    } catch (error) {
      entry.status = "trapped";
      const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
      const offsetMatch = /wasm-function\[\d+\]:0x([0-9a-f]+)/i.exec(stack);
      const source = offsetMatch ? sourceAtWasmOffset(sourceMap, Number.parseInt(offsetMatch[1], 16)) : null;
      entry.compiledMessage = `${stack}${source ? `\nsource ${source.source}:${source.line}:${source.column}` : ""}`;
    }
    tests.push(entry);
  }

  const scored = tests.filter((test) => ["pass", "fail", "trapped"].includes(test.status));
  const passed = tests.filter((test) => test.status === "pass").length;
  const harnessIncompatible = tests.filter((test) => test.status === "harness-incompatible").length;
  const implementationInvalidTests = tests.filter((test) => test.status === "skipped").length;
  const failed = scored.length - passed;
  await new Promise((resolve) => setTimeout(resolve, 200));
  disposeNativeHostErrorBoundary();
  report.compile = {
    success: batchReports.every((batch) => batch.compileSuccess),
    durationMs: totalCompileMs,
    binaryBytes: totalBytes,
    batches: batchReports,
    invalidBatches: batchReports.filter((batch) => !batch.validates).length,
  };
  report.validation = {
    validates: report.compile.invalidBatches === 0,
    firstError: batchReports.find((batch) => !batch.validates)?.firstError ?? null,
  };
  report.results = {
    scored: scored.length,
    passed,
    failed,
    harnessIncompatible,
    implementationInvalidTests,
    nativeHostErrors,
    tests,
  };
  report.summary = {
    headline:
      `${passed}/${scored.length} executed upstream react-dom ${lane} tests pass against compiled Wasm ` +
      `(${selectedTests.length} selected; ${harnessIncompatible} need infrastructure; ${implementationInvalidTests} blocked before Wasm execution)`,
    passRatePct: scored.length ? Number(((passed / scored.length) * 100).toFixed(2)) : 0,
    upstreamTestsSeen: serverTests.length,
    admitted: serverTests.length,
    selected: selectedTests.length,
    scored: scored.length,
    passed,
    failed,
    harnessIncompatible,
    implementationInvalidTests,
    nativeHostErrors: nativeHostErrors.length,
    compileMs: totalCompileMs,
    binaryBytes: totalBytes,
    batches: batchReports.length,
    invalidBatches: report.compile.invalidBatches,
    binaryValidates: report.validation.validates,
  };
  return report;
}

// Compiles the implementation ALONE — no test code. If this cannot produce a
// valid module then every batch containing it is invalid too, and subdividing
// per test only burns wall clock while hiding the actual finding.
async function compileImplementationOnly(implementation) {
  const source = `${implementation}\nexport function __probe() {\n  return 1;\n}`;
  const configuredTimeout = Number(process.env.DOGFOOD_REACT_DOM_COMPILE_TIMEOUT_MS ?? 300_000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 300_000;
  const result = await compileSourceInWorker({
    generatedPath: join(GENERATED_ROOT, "generated-implementation.ts"),
    source,
    timeoutMs,
    workerEnv: { DOGFOOD_INSTALL_JSDOM: "1" },
  });
  const compile = result?.compile;
  if (!compile) return { validates: false, compileMs: 0, error: "compile worker returned no result" };
  return {
    validates: compile.validates === true,
    compileMs: compile.durationMs ?? 0,
    error:
      compile.errors?.[0]?.message ??
      compile.validationError ??
      (compile.timedOut ? `compile timeout after ${timeoutMs}ms` : compile.success ? null : "no binary emitted"),
    binaryBytes: compile.binaryBytes ?? 0,
    timedOut: compile.timedOut === true,
  };
}

async function runProjectHarness({
  report,
  log,
  implementation,
  reactSource,
  sharedSource,
  clientSource,
  selectedTests,
}) {
  const configuredTimeout = Number(process.env.DOGFOOD_REACT_DOM_COMPILE_TIMEOUT_MS ?? 300_000);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0 ? configuredTimeout : 300_000;
  const files = buildProjectFiles({ reactSource, sharedSource, clientSource, tests: selectedTests });
  const started = performance.now();
  const isolated = await compileProjectInWorker({
    generatedRoot: PROJECT_ROOT,
    entryFile: "entry.ts",
    files,
    timeoutMs,
    workerEnv: { DOGFOOD_INSTALL_JSDOM: "1", DOGFOOD_NAMED_TEST_EXPORTS: "1" },
  });
  const compile = isolated?.compile ?? {
    success: false,
    validates: false,
    durationMs: Math.round(performance.now() - started),
    binaryBytes: 0,
    errors: [{ message: "compile worker returned no result" }],
  };
  const wasm = isolated?.wasm ?? null;
  const nativeHostErrors = [];
  const disposeNativeHostErrorBoundary = installNativeHostErrorBoundary(nativeHostErrors);
  const nativeResults = new Map(
    (await runNativeByFile(implementation, selectedTests)).map((entry) => [entry.id, entry]),
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  disposeNativeHostErrorBoundary();

  const compileError =
    compile.errors?.[0]?.message ??
    compile.validationError ??
    (compile.timedOut ? `compile timeout after ${timeoutMs}ms` : compile.success ? null : "no binary emitted");
  const implementationInvalid =
    compile.validates === true ? null : { error: compileError, compileMs: compile.durationMs ?? 0 };
  const statuses = wasm?.statuses ?? [];
  const wasmErrors = wasm?.errors ?? [];
  const tests = selectedTests.map((test, index) => {
    const native = nativeResults.get(test.id) ?? {};
    const entry = {
      id: test.id,
      file: test.file,
      fullName: test.fullName,
      nativePassed: native.value === 1,
      nativeMessage: native.error ?? native.message ?? "",
    };
    if (!entry.nativePassed) {
      entry.status = "harness-incompatible";
    } else if (implementationInvalid) {
      entry.status = "skipped";
      entry.skippedReason = compileError ?? "binary did not compile";
    } else if (wasm?.fatal) {
      entry.status = "trapped";
      entry.compiledMessage = wasm.fatal;
    } else {
      entry.compiledPassed = statuses[index] === true;
      entry.status = entry.compiledPassed ? "pass" : "fail";
      if (!entry.compiledPassed) entry.compiledMessage = wasmErrors[index] ?? "";
    }
    return entry;
  });
  const scored = tests.filter((test) => ["pass", "fail", "trapped"].includes(test.status));
  const passed = tests.filter((test) => test.status === "pass").length;
  const harnessIncompatible = tests.filter((test) => test.status === "harness-incompatible").length;
  const implementationInvalidTests = tests.filter((test) => test.status === "skipped").length;
  report.compile = {
    success: compile.success === true,
    durationMs: compile.durationMs ?? 0,
    binaryBytes: compile.binaryBytes ?? 0,
    batches: [{ file: "react-dom-project", tests: selectedTests.length, ...compile }],
    invalidBatches: compile.validates === true ? 0 : 1,
    implementationInvalid,
    quarantined: [],
  };
  report.validation = { validates: compile.validates === true, firstError: compileError };
  report.results = {
    scored: scored.length,
    passed,
    failed: scored.length - passed,
    harnessIncompatible,
    implementationInvalidTests,
    nativeHostErrors,
    tests,
  };
  report.summary = {
    headline:
      `${passed}/${scored.length} executed upstream react-dom tests pass against compiled Wasm ` +
      `(${report.extraction.admitted} of ${report.extraction.upstreamTestsSeen} upstream tests admitted; ` +
      `${harnessIncompatible} need infrastructure the harness cannot supply; ` +
      `${implementationInvalidTests} blocked before Wasm execution)` +
      (implementationInvalid ? " — react-dom's project does not compile to a valid module" : ""),
    passRatePct: scored.length ? Number(((passed / scored.length) * 100).toFixed(2)) : 0,
    upstreamTestsSeen: report.extraction.upstreamTestsSeen,
    admitted: report.extraction.admitted,
    scored: scored.length,
    passed,
    failed: scored.length - passed,
    harnessIncompatible,
    implementationInvalidTests,
    nativeHostErrors: nativeHostErrors.length,
    compileMs: compile.durationMs ?? 0,
    binaryBytes: compile.binaryBytes ?? 0,
    batches: 1,
    invalidBatches: compile.validates === true ? 0 : 1,
    implementationInvalid: implementationInvalid !== null,
    implementationError: implementationInvalid?.error ?? null,
    binaryValidates: compile.validates === true,
  };
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(`[dogfood] ${report.summary.headline}`);
  log(`[dogfood] full report → ${REPORT_PATH}`);
  return report;
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
  installReactTestEnvironment();

  // --- 1. ACQUIRE ----------------------------------------------------------
  const { root: reactRoot, version: reactVersion } = setupReact();
  const reactSource = readFileSync(join(reactRoot, "package", "cjs", "react.production.js"), "utf-8");
  const implementationPin = setupReactDomImplementation();
  const localRequire = createRequire(import.meta.url);
  const hostInfrastructure = installReactUpstreamInfrastructure({ react: localRequire("react") });
  const installedReactDom = localRequire("react-dom/package.json");
  if (installedReactDom.version !== implementationPin.version) {
    throw new Error(
      `[dogfood] installed react-dom ${installedReactDom.version} does not match pinned ${implementationPin.version}`,
    );
  }
  const reactDomRequire = createRequire(localRequire.resolve("react-dom/package.json"));
  const schedulerPackagePath = reactDomRequire.resolve("scheduler/package.json");
  const schedulerPackage = JSON.parse(readFileSync(schedulerPackagePath, "utf-8"));
  const sharedSource = readFileSync(implementationPin.sharedPath, "utf-8");
  const clientSource = readFileSync(implementationPin.clientPath, "utf-8");
  const serverSource = readFileSync(implementationPin.serverPath, "utf-8");
  const fizzSource = readFileSync(implementationPin.fizzServerPath, "utf-8");
  const { root: suiteRoot, pin: suitePin } = setupReactDomUpstreamSuite();

  const implementation = buildImplementationSource({ reactSource, sharedSource, clientSource });

  const report = {
    generatedAt: new Date().toISOString(),
    reactDom: {
      version: implementationPin.version,
      reactVersion,
      schedulerVersion: schedulerPackage.version,
      source: implementationPin.pin.tarball,
      modules: [
        suitePin.implementation.sharedModule,
        suitePin.implementation.clientModule,
        suitePin.implementation.serverModule,
        suitePin.implementation.fizzServerModule,
      ],
      clientModules: [suitePin.implementation.sharedModule, suitePin.implementation.clientModule],
      serverModules: [suitePin.implementation.serverModule],
      fizzServerModules: [suitePin.implementation.fizzServerModule],
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
    supportedInfrastructure: new Set([
      "needs-react-dom",
      "needs-react-noop",
      "needs-test-utils",
      "needs-act",
      "needs-console-assertions",
      // Console output is captured by the host infrastructure in both lanes;
      // direct console assertions are runnable rather than unavailable setup.
      "asserts-on-console",
      "needs-jest-runtime",
      "needs-dom",
      "dev-build-only",
      "needs-feature-flags",
      "needs-scheduler",
      "needs-external-module",
    ]),
  });
  // The browser server renderer is a separate published CJS graph. Keep those
  // original tests in the admitted corpus, but route them to their own module
  // lane instead of including the graph in the client module.
  // Most ReactDOM files import ReactDOMServer in their shared prelude even
  // when an individual test only exercises the client renderer. Route only a
  // body that directly calls the legacy browser renderer, and leave mixed or
  // client-only tests in the client graph. Browser Fizz tests use a second
  // published graph and are routed only when the whole test is server-only;
  // node/edge Fizz tests remain outside this browser lane because they need
  // different stream/host modules.
  const hasClientRendererCall = (body) =>
    /\b(?:ReactDOMClient|ReactDOM\.(?:render|createRoot|hydrate|flushSync)|createRoot\s*\()/.test(body);
  const serverTests = extracted.tests.filter(
    (test) =>
      /\bReactDOMServer\.(?:renderToString|renderToStaticMarkup)\b/.test(test.body) &&
      !hasClientRendererCall(test.body),
  );
  const serverIds = new Set(serverTests.map((test) => test.id));
  const browserFizzFile = /ReactDOMFizz(?:ServerBrowser|StaticBrowser|StaticFloat)-test\.js$/;
  const fizzTests = extracted.tests.filter(
    (test) =>
      !serverIds.has(test.id) &&
      browserFizzFile.test(test.file) &&
      /\bReactDOMFizz(?:Server|Static)\b/.test(test.body) &&
      !hasClientRendererCall(test.body),
  );
  const fizzIds = new Set(fizzTests.map((test) => test.id));
  const clientTests = extracted.tests.filter((test) => !serverIds.has(test.id) && !fizzIds.has(test.id));
  report.extraction = {
    upstreamTestsSeen: extracted.tests.length + extracted.rejected.length,
    admitted: extracted.tests.length,
    rejected: extracted.rejected.length,
    rejectionCounts: extracted.rejectionCounts,
    rejectedTests: extracted.rejected,
    clientAdmitted: clientTests.length,
    serverAdmitted: serverTests.length,
    fizzAdmitted: fizzTests.length,
  };
  const requestedLimit = Number(process.env.DOGFOOD_REACT_DOM_TEST_LIMIT ?? 0);
  const selectedTests =
    Number.isInteger(requestedLimit) && requestedLimit > 0 ? clientTests.slice(0, requestedLimit) : clientTests;
  report.extraction.selected = selectedTests.length;
  report.extraction.clientSelected = selectedTests.length;
  report.extraction.serverSelected = Number(process.env.DOGFOOD_REACT_DOM_SERVER_TEST_LIMIT ?? 0) || serverTests.length;
  report.extraction.fizzSelected = Number(process.env.DOGFOOD_REACT_DOM_FIZZ_TEST_LIMIT ?? 0) || fizzTests.length;
  log(
    `[dogfood] react-dom@${implementationPin.version} upstream @ ${suitePin.tag}: ` +
      `${extracted.tests.length} of ${extracted.tests.length + extracted.rejected.length} upstream tests admitted ` +
      `(${clientTests.length} client, ${serverTests.length} legacy server, ${fizzTests.length} browser Fizz)`,
  );

  // The project lane compiles the published React, shared, and client modules
  // once, then runs all selected tests from one small entry module. The legacy
  // concatenated batch lane remains available for comparison while the project
  // graph is being hardened, but is no longer the default compatibility path.
  if (process.env.DOGFOOD_REACT_DOM_PROJECT !== "0") {
    const result = await runProjectHarness({
      report,
      log,
      implementation,
      reactSource,
      sharedSource,
      clientSource,
      selectedTests,
    });
    try {
      result.server = await runServerHarness({
        log,
        reactSource,
        sharedSource,
        serverSource,
        suitePin,
        serverTests,
        lane: "legacy server",
      });
    } catch (error) {
      result.server = {
        summary: {
          headline:
            "0/0 executed upstream react-dom server tests pass against compiled Wasm (server lane failed before execution)",
          passRatePct: 0,
          upstreamTestsSeen: serverTests.length,
          admitted: serverTests.length,
          selected: 0,
          scored: 0,
          passed: 0,
          failed: 0,
          harnessIncompatible: 0,
          implementationInvalidTests: serverTests.length,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
    try {
      result.fizz = await runServerHarness({
        log,
        reactSource,
        sharedSource,
        fizzSource,
        suitePin,
        serverTests: fizzTests,
        lane: "browser Fizz",
      });
    } catch (error) {
      result.fizz = {
        summary: {
          headline:
            "0/0 executed upstream react-dom browser Fizz tests pass against compiled Wasm (Fizz lane failed before execution)",
          passRatePct: 0,
          upstreamTestsSeen: fizzTests.length,
          admitted: fizzTests.length,
          selected: 0,
          scored: 0,
          passed: 0,
          failed: 0,
          harnessIncompatible: 0,
          implementationInvalidTests: fizzTests.length,
          error: error instanceof Error ? error.message : String(error),
        },
      };
    }
    report.server = result.server;
    report.fizz = result.fizz;
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
    hostInfrastructure.cleanup();
    return result;
  }

  // --- 3. DOES THE IMPLEMENTATION COMPILE AT ALL? --------------------------
  const baseline = await compileImplementationOnly(implementation);
  log(
    `[dogfood] react-dom implementation alone (${Math.round(implementation.length / 1024)} KB): ` +
      (baseline.validates ? `valid in ${baseline.compileMs}ms` : `INVALID — ${String(baseline.error).slice(0, 100)}`),
  );

  const batchReports = [];
  const runResults = new Map();
  const quarantined = [];
  const nativeHostErrors = [];
  let admitted = [];
  let totalCompileMs = baseline.compileMs;
  let totalBytes = 0;
  let implementationInvalid = null;
  const disposeNativeHostErrorBoundary = installNativeHostErrorBoundary(nativeHostErrors);

  if (!baseline.validates) {
    // The whole corpus is behind this one fact. The tests still RUN natively so
    // the report can say how many the compiler would have to get right. They are
    // implementation-blocked, not compiled failures: no Wasm test body ran.
    implementationInvalid = { error: String(baseline.error), compileMs: baseline.compileMs };
    admitted = selectedTests;
    // Build one native oracle per upstream file.  A single ESM helper import
    // in one file must not turn every unrelated test into an oracle-build
    // failure (the extractor records those helpers as dropped scaffolding).
    const nativeResults = new Map((await runNativeByFile(implementation, selectedTests)).map((e) => [e.id, e]));
    for (const test of selectedTests) {
      runResults.set(test.id, {
        native: nativeResults.get(test.id) ?? {},
        compiled: null,
        firstError: `implementation module invalid: ${String(baseline.error).slice(0, 200)}`,
      });
    }
  } else {
    const batches = new Map();
    for (const test of selectedTests) {
      if (!batches.has(test.file)) batches.set(test.file, []);
      batches.get(test.file).push(test);
    }

    const compileGroup = async (file, groupTests, depth = 0) => {
      let batchTests = groupTests;
      let result = null;
      let compileMs = 0;
      const started = performance.now();
      try {
        const moduleSource = buildModuleSource(implementation, batchTests);
        result = await compile(moduleSource, {
          fileName: "react-dom.js",
          skipSemanticDiagnostics: true,
          experimentalIR: process.env.DOGFOOD_REACT_DOM_LEGACY !== "1",
          sourceMap: true,
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
        let instance = null;
        try {
          const imports = result.importObject ?? {};
          ({ instance } = await WebAssembly.instantiate(result.binary, imports));
          imports.setInstance?.(instance);
          imports.__setInstance?.(instance);
          instance.exports.__reactDomInit?.();
          compiled = wrapExports(instance.exports, { signatures: result.exportSignatures });
        } catch (error) {
          const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
          let payload = "";
          const tag = instance?.exports?.__exn_tag ?? instance?.exports?.__tag;
          if (tag && typeof error?.getArg === "function") {
            try {
              const value = error.getArg(tag, 0);
              payload = value === undefined || value === null ? "" : ` payload=${String(value)}`;
            } catch {
              // Foreign exception tags cannot be decoded by this instance.
            }
          }
          const offsetMatch = /wasm-function\[\d+\]:0x([0-9a-f]+)/i.exec(stack);
          const source = offsetMatch ? sourceAtWasmOffset(result.sourceMap, Number.parseInt(offsetMatch[1], 16)) : null;
          firstError = `instantiate failed: ${stack}${payload}${source ? `\nsource ${source.source}:${source.line}:${source.column}` : ""}`;
        }
      }

      batchReports.push({
        file,
        tests: batchTests.length,
        compileMs,
        binaryBytes: result?.binary?.length ?? 0,
        imports: result?.imports?.map((entry) => `${entry.module}.${entry.name}`) ?? [],
        compileSuccess: result?.success ?? false,
        validates,
        firstError,
      });
      log(
        `[dogfood]   ${file.replace(/^.*\//, "")}: ${batchTests.length} tests, ` +
          `${validates ? "valid" : `INVALID — ${String(firstError).slice(0, 70)}`}`,
      );

      nativeContextFile = file;
      const nativeResults = new Map((await runNative(implementation, batchTests)).map((e) => [e.id, e]));
      for (const test of batchTests) {
        runResults.set(test.id, {
          native: nativeResults.get(test.id) ?? {},
          compiled,
          firstError,
          sourceMap: result?.sourceMap,
        });
      }
    };

    for (const [file, fileTests] of batches) {
      for (const chunk of splitBySize(fileTests)) await compileGroup(file, chunk);
    }
  }

  // A scheduler callback can outlive the final test body. Give late host work
  // a real macrotask window while the boundary is still installed, then restore
  // normal process error handling before producing the report.
  await new Promise((resolve) => setTimeout(resolve, 200));
  disposeNativeHostErrorBoundary();

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
    const { native, compiled, firstError, sourceMap } = runResults.get(test.id) ?? {};
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
      const stack = error instanceof Error ? (error.stack ?? error.message) : String(error);
      const offsetMatch = /wasm-function\[\d+\]:0x([0-9a-f]+)/i.exec(stack);
      const source = offsetMatch ? sourceAtWasmOffset(sourceMap, Number.parseInt(offsetMatch[1], 16)) : null;
      entry.compiledMessage = `${stack}${source ? `\nsource ${source.source}:${source.line}:${source.column}` : ""}`;
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

  const scored = tests.filter((test) => ["pass", "fail", "trapped"].includes(test.status));
  const passed = tests.filter((test) => test.status === "pass").length;
  const failed = scored.length - passed;
  const harnessIncompatible = tests.filter((test) => test.status === "harness-incompatible").length;
  const implementationInvalidTests = tests.filter((test) => test.status === "skipped").length;

  report.results = {
    scored: scored.length,
    passed,
    failed,
    harnessIncompatible,
    implementationInvalidTests,
    nativeHostErrors,
    tests,
  };
  report.summary = {
    headline:
      `${passed}/${scored.length} executed upstream react-dom tests pass against compiled Wasm ` +
      `(${report.extraction.admitted} of ${report.extraction.upstreamTestsSeen} upstream tests admitted; ` +
      `${harnessIncompatible} need infrastructure the harness cannot supply; ` +
      `${implementationInvalidTests} blocked before Wasm execution)` +
      (implementationInvalid ? " — react-dom's own implementation does not compile to a valid module" : ""),
    passRatePct: scored.length ? Number(((passed / scored.length) * 100).toFixed(2)) : 0,
    upstreamTestsSeen: report.extraction.upstreamTestsSeen,
    admitted: report.extraction.admitted,
    scored: scored.length,
    passed,
    failed,
    harnessIncompatible: report.results.harnessIncompatible,
    implementationInvalidTests,
    nativeHostErrors: nativeHostErrors.length,
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
  if (nativeHostErrors.length > 0) {
    log(`[dogfood] native oracle recorded ${nativeHostErrors.length} expected late jsdom host error(s)`);
  }
  log(`[dogfood] full report → ${REPORT_PATH}`);
  try {
    report.server = await runServerHarness({
      log,
      reactSource,
      sharedSource,
      serverSource,
      suitePin,
      serverTests,
    });
  } catch (error) {
    report.server = {
      summary: {
        headline:
          "0/0 executed upstream react-dom server tests pass against compiled Wasm (server lane failed before execution)",
        passRatePct: 0,
        upstreamTestsSeen: serverTests.length,
        admitted: serverTests.length,
        selected: 0,
        scored: 0,
        passed: 0,
        failed: 0,
        harnessIncompatible: 0,
        implementationInvalidTests: serverTests.length,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
  try {
    report.fizz = await runServerHarness({
      log,
      reactSource,
      sharedSource,
      fizzSource,
      suitePin,
      serverTests: fizzTests,
      lane: "browser Fizz",
    });
  } catch (error) {
    report.fizz = {
      summary: {
        headline:
          "0/0 executed upstream react-dom browser Fizz tests pass against compiled Wasm (Fizz lane failed before execution)",
        passRatePct: 0,
        upstreamTestsSeen: fizzTests.length,
        admitted: fizzTests.length,
        selected: 0,
        scored: 0,
        passed: 0,
        failed: 0,
        harnessIncompatible: 0,
        implementationInvalidTests: fizzTests.length,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
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
