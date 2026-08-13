// uuid@14.0.1 upstream-suite dogfood harness.
//
// The npm tarball contains only the published dist implementation; the source
// tests are acquired from uuidjs/uuid's immutable v14.0.1 tag.  The harness
// keeps the test bodies and registration code intact, replacing only node:test
// and node:assert with tiny deterministic shims and rewriting package-relative
// imports to the verified tarball.  Each upstream file is compiled as its own
// Wasm module, then the same registered callbacks are run natively and in Wasm
// so a compile-only card can never masquerade as runtime evidence.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import * as ts from "typescript";

import { compileProject } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";
import { setupNpmCompatCatalogPackage } from "./npm-compat-catalog.mjs";
import { setupUuidUpstreamSuite } from "./setup-uuid-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "uuid-upstream-suite.json");
const GENERATED_ROOT = join(resolve(HERE, "..", "..", ".uuid-upstream-suite"), "generated");

const ASSERT_SHIM = String.raw`
function __uuid_fail(message) { throw new Error(String(message || "Assertion failed")); }
function __uuid_repr(value) {
  if (value != null && typeof value.length === "number") {
    let out = "[";
    for (let i = 0; i < value.length; i++) out += (i === 0 ? "" : ",") + String(value[i]);
    return out + "]";
  }
  return String(value);
}
function __uuid_same(a, b) {
  if (Object.is(a, b)) return true;
  if (a == null || b == null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (typeof a.length === "number" && typeof b.length === "number") {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!__uuid_same(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const key = ak[i];
    if (!Object.prototype.hasOwnProperty.call(b, key) || !__uuid_same(a[key], b[key])) return false;
  }
  return true;
}
const assert = {
  ok(value, message) { if (!value) __uuid_fail(message || "expected a truthy value"); },
  equal(actual, expected, message) { if (actual != expected) __uuid_fail((message ? String(message) + ": " : "") + String(actual) + " != " + String(expected)); },
  notEqual(actual, expected, message) { if (actual == expected) __uuid_fail(message || "values are equal"); },
  notStrictEqual(actual, expected, message) { if (actual === expected) __uuid_fail(message || "values are strictly equal"); },
  strictEqual(actual, expected, message) { if (actual !== expected) __uuid_fail((message ? String(message) + ": " : "") + String(actual) + " !== " + String(expected)); },
  deepEqual(actual, expected, message) { if (!__uuid_same(actual, expected)) __uuid_fail((message ? String(message) + ": " : "") + __uuid_repr(actual) + " != " + __uuid_repr(expected)); },
  deepStrictEqual(actual, expected, message) { if (!__uuid_same(actual, expected)) __uuid_fail((message ? String(message) + ": " : "") + __uuid_repr(actual) + " != " + __uuid_repr(expected)); },
  throws(fn, expected, message) {
    let thrown = null;
    try { fn(); } catch (error) { thrown = error; }
    if (thrown === null) __uuid_fail(message || "Missing expected exception");
    if (typeof expected === "function" && !(thrown instanceof expected) && thrown.name !== expected.name) {
      __uuid_fail(message || ("Unexpected exception " + String(thrown)));
    }
  },
  fail(message) { __uuid_fail(message); },
};
`;

const REGISTRATION_SHIM = String.raw`
const __uuidTests = [];
const __uuidErrors = [];
function describe(_name, body) { body(); }
function test(name, body) { __uuidTests.push({ name: String(name), body }); }
`;

function cleanSpecifier(specifier) {
  return specifier.replace(/\\/g, "/").replace(/^\.\//, "");
}

function packageModulePath(specifier, packageRoot, generatedDirectory) {
  const relativePath = cleanSpecifier(specifier).replace(/^\.\.\//, "");
  const fileName = relativePath.endsWith(".js") ? relativePath : `${relativePath}.js`;
  const absolute = join(packageRoot, "package", "dist", basename(fileName));
  let fromGenerated = relative(generatedDirectory, absolute).replace(/\\/g, "/");
  if (!fromGenerated.startsWith(".")) fromGenerated = `./${fromGenerated}`;
  return { absolute, specifier: fromGenerated };
}

function importBindings(importClause) {
  const bindings = [];
  if (!importClause) return bindings;
  if (importClause.name) bindings.push({ imported: "default", local: importClause.name.text });
  if (importClause.namedBindings) {
    if (ts.isNamespaceImport(importClause.namedBindings)) {
      bindings.push({ imported: "*", local: importClause.namedBindings.name.text });
    } else {
      for (const element of importClause.namedBindings.elements) {
        bindings.push({
          imported: element.propertyName?.text ?? element.name.text,
          local: element.name.text,
        });
      }
    }
  }
  return bindings;
}

function importRecords(sourceFile) {
  const records = [];
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const specifier = String(statement.moduleSpecifier.text);
    records.push({
      statement,
      specifier,
      typeOnly: statement.importClause?.isTypeOnly === true,
      bindings: importBindings(statement.importClause),
    });
  }
  return records;
}

/**
 * Return the original source with imports removed/rebound.  Package imports
 * stay as real ESM imports for compileProject; native execution gets the same
 * source with all import declarations removed and receives those bindings as
 * function arguments.  No test body is copied or hand-written here.
 */
function transformSource({ source, filePath, packageRoot, generatedDirectory, native = false }) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const records = importRecords(sourceFile);
  const replacements = [];
  const dependencies = [];

  for (const record of records) {
    const start = record.statement.getStart(sourceFile);
    const end = record.statement.end;
    if (record.typeOnly || record.specifier === "node:test" || record.specifier === "node:assert/strict") {
      replacements.push({ start, end, text: "" });
      continue;
    }

    let replacement = "";
    if (record.specifier.startsWith("../") || record.specifier.startsWith("./")) {
      if (record.specifier === "./test_constants.js") {
        replacement = native ? "" : source.slice(start, end);
      } else if (record.specifier.startsWith("../")) {
        const target = packageModulePath(record.specifier, packageRoot, generatedDirectory);
        const statementText = source.slice(start, end);
        const quote = statementText.includes(`"${record.specifier}"`) ? '"' : "'";
        replacement = native
          ? ""
          : statementText.replace(`${quote}${record.specifier}${quote}`, `${quote}${target.specifier}${quote}`);
        dependencies.push({ ...record, absolute: target.absolute });
      } else {
        replacement = native ? "" : source.slice(start, end);
      }
    } else {
      // The pinned source suite has no third-party imports. Keep a loud error
      // if that changes instead of silently compiling a different test.
      throw new Error(`[dogfood] unsupported uuid upstream import ${record.specifier} in ${filePath}`);
    }
    replacements.push({ start, end, text: replacement });
    if (native && replacement === "" && record.specifier === "./test_constants.js") {
      dependencies.push({ ...record, absolute: null, helper: true });
    }
  }

  let transformed = source;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    transformed = transformed.slice(0, replacement.start) + replacement.text + transformed.slice(replacement.end);
  }

  // Node's v4 tests mark their callbacks async although every assertion is
  // synchronous. Removing that modifier lets the tiny test runner observe a
  // thrown assertion in both native and Wasm modes instead of losing it in a
  // rejected Promise that a synchronous Wasm callback cannot await.
  transformed = transformed.replace(/\basync\s*(?=\([^)]*\)\s*=>)/g, "");

  // TypeScript's Array#forEach callback registration is a useful compact way
  // to express a table-driven test, but the callback dispatcher is not yet
  // reliable in every Wasm host path. Expand only registration-shaped
  // forEach calls into an equivalent counted loop. The callback body itself
  // remains the original upstream source, and this keeps the native and Wasm
  // registration counts identical (uuid's v35 file has 6 such cases).
  transformed = expandForEachRegistrations(transformed, filePath);

  return { source: transformed, dependencies };
}

function expandForEachRegistrations(source, filePath) {
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const replacements = [];
  let serial = 0;
  function visit(node) {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "forEach"
    ) {
      const callback = node.arguments[0];
      if (
        callback &&
        (ts.isFunctionExpression(callback) || ts.isArrowFunction(callback)) &&
        ts.isBlock(callback.body)
      ) {
        const collection = node.expression.expression;
        const collectionText = source.slice(collection.getStart(sourceFile), collection.end);
        const bodyText = source.slice(callback.body.getStart(sourceFile), callback.body.end);
        const params = callback.parameters.map((parameter) =>
          source.slice(parameter.name.getStart(sourceFile), parameter.name.end),
        );
        const indexName = `__uuidForEachIndex${serial++}`;
        const bindings = params
          .map((name, index) => `const ${name} = ${index === 0 ? `${collectionText}[${indexName}]` : indexName};`)
          .join(" ");
        replacements.push({
          start: node.getStart(sourceFile),
          end: node.end,
          text: `for (let ${indexName} = 0; ${indexName} < ${collectionText}.length; ${indexName}++) { ${bindings} ${bodyText} }`,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    source = source.slice(0, replacement.start) + replacement.text + source.slice(replacement.end);
  }
  return source;
}

function helperSource(source, packageRoot, generatedDirectory) {
  const transformed = transformSource({
    source,
    filePath: join(generatedDirectory, "test_constants.ts"),
    packageRoot,
    generatedDirectory,
    native: false,
  }).source;
  return transformed;
}

function wasmModuleSource(source, filePath, packageRoot, generatedDirectory) {
  let transformed = transformSource({ source, filePath, packageRoot, generatedDirectory, native: false }).source;
  return [
    ASSERT_SHIM,
    REGISTRATION_SHIM,
    transformed,
    `export function uuidRun(context: any): number[] {
  const statuses: number[] = [];
  __uuidErrors.length = 0;
  for (let i = 0; i < __uuidTests.length; i++) {
    try { __uuidTests[i].body(context); statuses.push(1); __uuidErrors.push(""); }
    catch (error) {
      statuses.push(0);
      __uuidErrors.push(error && error.message !== undefined ? String(error.message) : String(error));
    }
  }
  return statuses;
}
export function uuidCount(): number { return __uuidTests.length; }
export function uuidErrors(): string[] { return __uuidErrors; }
`,
  ].join("\n");
}

function transpileNative(source) {
  return ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      removeComments: false,
    },
    reportDiagnostics: true,
  }).outputText;
}

async function loadNativeDependencies(record, packageRoot, helperValues) {
  const values = {};
  for (const dependency of record.dependencies) {
    for (const binding of dependency.bindings) {
      if (dependency.helper) {
        values[binding.local] = helperValues[binding.imported === "default" ? "default" : binding.imported];
        continue;
      }
      const imported = await import(pathToFileURL(dependency.absolute).href);
      values[binding.local] =
        binding.imported === "default"
          ? imported.default
          : binding.imported === "*"
            ? imported
            : imported[binding.imported];
    }
  }
  return values;
}

function nativeFactorySource(transformedSource, dependencyValues) {
  const aliases = Object.keys(dependencyValues)
    .map((name) => `const ${name} = __imports[${JSON.stringify(name)}];`)
    .join("\n");
  return [ASSERT_SHIM, REGISTRATION_SHIM, aliases, transformedSource, "return { tests: __uuidTests };"].join("\n");
}

function makeMockContext() {
  const restores = [];
  return {
    mock: {
      method(target, name, replacement) {
        const original = target[name];
        let calls = 0;
        target[name] = function (...args) {
          calls++;
          return replacement.apply(this, args);
        };
        restores.push(() => {
          target[name] = original;
        });
        return { mock: { callCount: () => calls } };
      },
      reset() {
        while (restores.length > 0) restores.pop()();
      },
    },
  };
}

function recordNativeError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function runNativeFile(source, filePath, packageRoot, generatedDirectory, helperValues) {
  const transformed = transformSource({ source, filePath, packageRoot, generatedDirectory, native: true });
  const dependencies = await loadNativeDependencies(transformed, packageRoot, helperValues);
  const js = transpileNative(nativeFactorySource(transformed.source, dependencies));
  const factory = new Function("__imports", js); // eslint-disable-line no-new-func
  const module = factory(dependencies);
  const results = [];
  for (const test of module.tests) {
    let error = null;
    try {
      await test.body(makeMockContext());
    } catch (thrown) {
      error = recordNativeError(thrown);
    }
    results.push({ name: test.name, passed: error === null, error });
  }
  return results;
}

async function runWasmFile({ source, filePath, packageRoot, generatedDirectory, nativeResults }) {
  const generatedPath = join(generatedDirectory, basename(filePath));
  const moduleSource = wasmModuleSource(source, filePath, packageRoot, generatedDirectory);
  writeFileSync(generatedPath, moduleSource);
  const started = performance.now();
  let result;
  try {
    result = await compileProject(generatedPath, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "node",
      deferTopLevelInit: true,
    });
  } catch (error) {
    result = { success: false, errors: [{ message: recordNativeError(error) }] };
  }
  const compileMs = Math.round(performance.now() - started);
  if (!result.success || !result.binary?.length) {
    return {
      file: basename(filePath),
      compile: { success: false, validates: false, durationMs: compileMs, binaryBytes: 0, errors: result.errors ?? [] },
      tests: nativeResults.map((test) => ({
        ...test,
        status: "compile-failed",
        wasmPassed: false,
        wasmError: result.errors?.[0]?.message ?? "no binary emitted",
      })),
    };
  }

  let validates = false;
  let validationError = null;
  try {
    await WebAssembly.compile(result.binary);
    validates = true;
  } catch (error) {
    validationError = recordNativeError(error);
  }
  if (!validates) {
    return {
      file: basename(filePath),
      compile: {
        success: true,
        validates: false,
        durationMs: compileMs,
        binaryBytes: result.binary.length,
        errors: [],
        validationError,
      },
      tests: nativeResults.map((test) => ({
        ...test,
        status: "validation-failed",
        wasmPassed: false,
        wasmError: validationError,
      })),
    };
  }

  let wasmResults;
  let wasmErrors;
  try {
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.setInstance?.(instance);
    imports.__setInstance?.(instance);
    instance.exports.__module_init?.();
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    const statuses = exports.uuidRun(makeMockContext());
    wasmResults = Array.from(statuses, (value) => value === 1);
    wasmErrors = Array.from(exports.uuidErrors(), String);
  } catch (error) {
    const message = recordNativeError(error);
    return {
      file: basename(filePath),
      compile: { success: true, validates: true, durationMs: compileMs, binaryBytes: result.binary.length, errors: [] },
      tests: nativeResults.map((test) => ({
        ...test,
        status: "runtime-failed",
        wasmPassed: false,
        wasmError: message,
      })),
    };
  }

  if (wasmResults.length !== nativeResults.length) {
    const message = `uuidRun returned ${wasmResults.length} statuses for ${nativeResults.length} tests`;
    return {
      file: basename(filePath),
      compile: { success: true, validates: true, durationMs: compileMs, binaryBytes: result.binary.length, errors: [] },
      tests: nativeResults.map((test) => ({
        ...test,
        status: "runtime-shape-failed",
        wasmPassed: false,
        wasmError: message,
      })),
    };
  }

  return {
    file: basename(filePath),
    compile: { success: true, validates: true, durationMs: compileMs, binaryBytes: result.binary.length, errors: [] },
    tests: nativeResults.map((test, index) => ({
      ...test,
      status: test.passed && wasmResults[index] ? "passed" : test.passed ? "failed" : "harness-incompatible",
      wasmPassed: wasmResults[index],
      wasmError: test.passed && !wasmResults[index] ? wasmErrors[index] || "upstream assertion failed in Wasm" : null,
    })),
  };
}

function finalize(report, log) {
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(`[dogfood] full report → ${REPORT_PATH}`);
  return report;
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const { root: packageRoot, version, pin } = setupNpmCompatCatalogPackage("uuid");
  const { pin: suitePin, testPaths, helperPaths } = setupUuidUpstreamSuite();
  mkdirSync(GENERATED_ROOT, { recursive: true });

  const report = {
    generatedAt: new Date().toISOString(),
    uuid: { version, source: pin.tarball, entryModule: pin.entryModule },
    upstreamSuite: { repo: suitePin.repo, tag: suitePin.tag, commit: suitePin.commit, testFiles: suitePin.testFiles },
    extraction: { upstreamTestsSeen: 0, admitted: 0, rejected: 0, rejectedTests: [] },
    compile: { files: [], success: true, validates: true, durationMs: 0, binaryBytes: 0 },
    results: { nativePassed: 0, nativeFailed: 0, scored: 0, passed: 0, failed: 0, harnessIncompatible: 0, tests: [] },
    summary: {},
  };

  // Compile/evaluate the shared test_constants helper in the host oracle once.
  const helperPath = helperPaths[0];
  const helperRaw = readFileSync(helperPath, "utf-8");
  const helperNoImports = helperRaw.replace(/^import[^;]+;\s*/gm, "").replace(/export\s+const\s+TESTS/g, "const TESTS");
  const helperMax = await import(pathToFileURL(join(packageRoot, "package", "dist", "max.js")).href);
  const helperNil = await import(pathToFileURL(join(packageRoot, "package", "dist", "nil.js")).href);
  const helperJs = transpileNative(helperNoImports);
  const helperFactory = new Function("MAX", "NIL", `${helperJs}\nreturn TESTS;`); // eslint-disable-line no-new-func
  const helperValues = { TESTS: helperFactory(helperMax.default, helperNil.default) };
  writeFileSync(join(GENERATED_ROOT, "test_constants.ts"), `${helperSource(helperRaw, packageRoot, GENERATED_ROOT)}\n`);

  log(`[dogfood] uuid@${version} upstream @ ${suitePin.tag} (${suitePin.commit.slice(0, 12)})`);
  for (let index = 0; index < testPaths.length; index++) {
    const filePath = testPaths[index];
    const source = readFileSync(filePath, "utf-8");
    const fileResults = await runNativeFile(source, filePath, packageRoot, GENERATED_ROOT, helperValues);
    report.extraction.upstreamTestsSeen += fileResults.length;
    report.extraction.admitted += fileResults.filter((test) => test.passed).length;
    report.extraction.rejected += fileResults.filter((test) => !test.passed).length;
    report.extraction.rejectedTests.push(
      ...fileResults
        .filter((test) => !test.passed)
        .map((test) => ({ file: basename(filePath), name: test.name, reason: test.error })),
    );
    report.results.nativePassed += fileResults.filter((test) => test.passed).length;
    report.results.nativeFailed += fileResults.filter((test) => !test.passed).length;

    const wasm = await runWasmFile({
      source,
      filePath,
      packageRoot,
      generatedDirectory: GENERATED_ROOT,
      nativeResults: fileResults,
    });
    report.compile.files.push(wasm.compile);
    report.compile.success &&= wasm.compile.success;
    report.compile.validates &&= wasm.compile.validates;
    report.compile.durationMs += wasm.compile.durationMs;
    report.compile.binaryBytes += wasm.compile.binaryBytes;
    for (const test of wasm.tests) {
      const scored = test.passed;
      if (scored) report.results.scored++;
      if (test.status === "passed") report.results.passed++;
      else if (scored) report.results.failed++;
      else report.results.harnessIncompatible++;
      report.results.tests.push({
        file: test.file ?? basename(filePath),
        name: test.name,
        status: test.status,
        nativeError: test.error,
        wasmError: test.wasmError,
      });
    }
    log(
      `[dogfood] ${basename(filePath)}: ${fileResults.filter((test) => test.passed).length}/${fileResults.length} native; ${wasm.tests.filter((test) => test.status === "passed").length}/${fileResults.length} Wasm`,
    );
  }

  report.summary = {
    headline: `${report.results.passed}/${report.results.scored} admitted upstream tests passed in Wasm (${report.results.harnessIncompatible} native-incompatible; ${report.extraction.upstreamTestsSeen} total)`,
    exactDenominator: report.results.scored,
    upstreamTestsSeen: report.extraction.upstreamTestsSeen,
    nativePassed: report.results.nativePassed,
    nativeFailed: report.results.nativeFailed,
    wasmPassed: report.results.passed,
    wasmFailed: report.results.failed,
    harnessIncompatible: report.results.harnessIncompatible,
    compileSuccess: report.compile.success,
    binaryValidates: report.compile.validates,
    compileMs: report.compile.durationMs,
  };
  return finalize(report, log);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const jsonOnly = process.argv.includes("--json");
  runHarness({ quiet: jsonOnly })
    .then((report) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
    })
    .catch((error) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify({ fatal: recordNativeError(error) })}\n`);
      else console.error("[dogfood] uuid upstream harness crashed:", error);
      process.exitCode = 2;
    });
}
