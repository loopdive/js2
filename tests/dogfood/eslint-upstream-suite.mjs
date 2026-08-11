// eslint@10.0.3 upstream-suite dogfood harness.
//
// ESLint's npm tarball omits its tests. This harness checks out the immutable
// matching source tag, lifts every original body from the selected
// deep-merge-arrays unit, and runs the same generated driver in Node and Wasm.
// Only the two CommonJS require declarations are rebound: the implementation
// comes from the byte-verified published package and node:assert is represented
// by a deterministic deepStrictEqual shim that both lanes share.

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import ts from "typescript";

import { compileProject } from "../../src/index.ts";
import { buildImports, wrapExports } from "../../src/runtime.ts";
import { setupEslint } from "./setup-eslint.mjs";
import { setupEslintUpstreamSuite } from "./setup-eslint-upstream-suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_PATH = join(HERE, "report", "eslint-upstream-suite.json");
const GENERATED_ROOT = join(HERE, ".eslint-upstream-suite", "generated");
const DRIVER_PATH = join(GENERATED_ROOT, "deep-merge-arrays-driver.mjs");

const ASSERT_REQUIRE = 'const assert = require("node:assert");';
const IMPLEMENTATION_REQUIRE = 'const { deepMergeArrays } = require("../../../lib/shared/deep-merge-arrays");';

const DRIVER_SHIM = String.raw`
let __eslintTotal = 0;
let __eslintPassed = 0;
let __eslintFailLow = 0;
let __eslintFailHigh = 0;

function __eslintDeepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!__eslintDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    for (const key of aKeys) {
      if (!Object.prototype.hasOwnProperty.call(b, key) || !__eslintDeepEqual(a[key], b[key])) return false;
    }
    return true;
  }
  return false;
}

const assert = {
  deepStrictEqual(actual, expected) {
    if (!__eslintDeepEqual(actual, expected)) throw new Error("deepStrictEqual");
  },
};

function describe(_name, body) { body(); }
function it(_name, body) {
  __eslintTotal++;
  try {
    body();
    __eslintPassed++;
  } catch (_error) {
    if (__eslintTotal <= 31) __eslintFailLow |= 1 << (__eslintTotal - 1);
    else __eslintFailHigh |= 1 << (__eslintTotal - 32);
  }
}
`;

function sourceSha256(source) {
  return createHash("sha256").update(source).digest("hex");
}

function selectedCaseCount(source, sourcePath) {
  const sourceFile = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let table = null;
  function visit(node) {
    if (ts.isForOfStatement(node) && ts.isArrayLiteralExpression(node.expression)) table = node.expression;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!table) throw new Error(`[dogfood] could not find ESLint's table-driven test cases in ${sourcePath}`);
  return table.elements.length;
}

function replaceExactlyOnce(source, needle, replacement, label) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`[dogfood] expected exactly one ${label} declaration in the pinned ESLint test`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

function generatedDriverSource(upstreamSource, implementationSpecifier) {
  let testSource = replaceExactlyOnce(upstreamSource, ASSERT_REQUIRE, "", "node:assert");
  testSource = replaceExactlyOnce(testSource, IMPLEMENTATION_REQUIRE, "", "deepMergeArrays");
  return [
    `import { deepMergeArrays } from ${JSON.stringify(implementationSpecifier)};`,
    DRIVER_SHIM,
    testSource,
    `export function eslintTotal() { return __eslintTotal; }
export function eslintPassed() { return __eslintPassed; }
export function eslintFailLow() { return __eslintFailLow; }
export function eslintFailHigh() { return __eslintFailHigh; }
`,
  ].join("\n");
}

function relativeModuleSpecifier(fromDirectory, target) {
  let specifier = relative(fromDirectory, target).replaceAll("\\", "/");
  if (!specifier.startsWith(".")) specifier = `./${specifier}`;
  return specifier;
}

function failedIndices(low, high, total) {
  const indices = [];
  const lowBits = low >>> 0;
  const highBits = high >>> 0;
  for (let index = 1; index <= total; index++) {
    const word = index <= 31 ? lowBits : highBits;
    const bit = index <= 31 ? index - 1 : index - 32;
    if (((word >>> bit) & 1) === 1) indices.push(index);
  }
  return indices;
}

function recordError(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function readDriverResults(exports) {
  const total = exports.eslintTotal();
  const passed = exports.eslintPassed();
  const failLow = exports.eslintFailLow();
  const failHigh = exports.eslintFailHigh();
  return {
    total,
    passed,
    failed: total - passed,
    failedIndices: failedIndices(failLow, failHigh, total),
  };
}

export async function runHarness({ quiet = false } = {}) {
  const log = quiet ? () => {} : (...values) => console.log(...values);
  const { pin: suitePin, testPaths } = setupEslintUpstreamSuite();
  const { root: implementationRoot, version, pin: implementationPin } = setupEslint();
  const testPath = testPaths[0];
  const upstreamSource = readFileSync(testPath, "utf-8");
  const upstreamTestsSeen = selectedCaseCount(upstreamSource, testPath);
  const implementationPath = join(implementationRoot, suitePin.implementationModule);

  mkdirSync(GENERATED_ROOT, { recursive: true });
  const implementationSpecifier = relativeModuleSpecifier(GENERATED_ROOT, implementationPath);
  writeFileSync(DRIVER_PATH, generatedDriverSource(upstreamSource, implementationSpecifier));

  const nativeModule = await import(`${pathToFileURL(DRIVER_PATH).href}?run=${Date.now()}`);
  const native = readDriverResults(nativeModule);

  const compileStarted = performance.now();
  let compiled;
  try {
    compiled = await compileProject(DRIVER_PATH, {
      allowJs: true,
      skipSemanticDiagnostics: true,
      target: "gc",
      platform: "node",
    });
  } catch (error) {
    compiled = { success: false, errors: [{ message: recordError(error) }] };
  }
  const compileMs = Math.round(performance.now() - compileStarted);
  const validates = compiled.success === true && WebAssembly.validate(compiled.binary);
  let wasm = { total: upstreamTestsSeen, passed: 0, failed: upstreamTestsSeen, failedIndices: [] };
  let runtimeError = null;
  if (validates) {
    try {
      const imports = buildImports(compiled.imports, undefined, compiled.stringPool);
      const { instance } = await WebAssembly.instantiate(compiled.binary, imports);
      wasm = readDriverResults(wrapExports(instance.exports, compiled.stringPool));
    } catch (error) {
      runtimeError = recordError(error);
    }
  }

  const report = {
    issue: 1400,
    generatedAt: new Date().toISOString(),
    package: {
      name: "eslint",
      version,
      source: implementationPin.tarball,
      implementationModule: suitePin.implementationModule,
    },
    upstreamSuite: {
      repo: suitePin.repo,
      tag: suitePin.tag,
      commit: suitePin.commit,
      testFiles: suitePin.testFiles,
      sourceSha256: sourceSha256(upstreamSource),
      scope: "selected original upstream unit; not ESLint's full test suite",
    },
    extraction: {
      upstreamTestsSeen,
      admitted: upstreamTestsSeen,
      rejected: 0,
      sourceEdits: [
        "rebind node:assert to one deterministic deepStrictEqual shim shared by Node and Wasm",
        "rebind the package-relative implementation require to the byte-verified eslint@10.0.3 payload",
      ],
    },
    compile: {
      success: compiled.success === true,
      validates,
      durationMs: compileMs,
      binaryBytes: compiled.success ? compiled.binary.byteLength : 0,
      errors: compiled.errors ?? [],
    },
    results: {
      scored: upstreamTestsSeen,
      nativePassed: native.passed,
      nativeFailed: native.failed,
      passed: runtimeError === null ? wasm.passed : 0,
      failed: runtimeError === null ? wasm.failed : upstreamTestsSeen,
      failedIndices: runtimeError === null ? wasm.failedIndices : [],
      runtimeError,
    },
    summary: {
      headline:
        runtimeError !== null
          ? `runtime failed before results: ${runtimeError}`
          : `${wasm.passed}/${upstreamTestsSeen} original cases match; Node ${native.passed}/${upstreamTestsSeen}`,
      wholePackageEntry: "separate bounded probe; currently exceeds its 180s compile budget",
    },
  };

  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  log(
    `[dogfood] eslint@${version} upstream ${suitePin.tag}: ${report.summary.headline} ` +
      `(compile ${compileMs}ms, ${report.compile.binaryBytes} bytes)`,
  );
  log(`[dogfood] full report → ${REPORT_PATH}`);
  return report;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const jsonOnly = process.argv.includes("--json");
  runHarness({ quiet: jsonOnly })
    .then((report) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
    })
    .catch((error) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify({ fatal: recordError(error) })}\n`);
      else console.error(error);
      process.exitCode = 1;
    });
}
