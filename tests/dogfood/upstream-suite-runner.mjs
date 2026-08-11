import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import * as ts from "typescript";

import { compileProject } from "../../src/index.ts";
import { wrapExports } from "../../src/runtime.ts";

// The assertions are intentionally small, deterministic JavaScript. They are
// runner infrastructure; the registered callback bodies remain the exact
// upstream source. Both Node and Wasm execute this same shim.
export const UPSTREAM_TEST_SHIM = String.raw`
const __upstreamTests = [];
function __upstreamFail(message) { throw new Error(String(message || "Assertion failed")); }
function __upstreamSame(a, b) {
  if (Object.is(a, b)) return true;
  if (a == null || b == null || typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && +a === +b;
  if (a instanceof RegExp || b instanceof RegExp) return a instanceof RegExp && b instanceof RegExp && String(a) === String(b);
  if (typeof a.length === "number" || typeof b.length === "number") {
    if (typeof a.length !== "number" || typeof b.length !== "number" || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!__upstreamSame(a[i], b[i])) return false;
    return true;
  }
  const ak = Object.keys(a), bk = Object.keys(b);
  if (ak.length !== bk.length) return false;
  for (let i = 0; i < ak.length; i++) {
    const key = ak[i];
    if (!Object.prototype.hasOwnProperty.call(b, key) || !__upstreamSame(a[key], b[key])) return false;
  }
  return true;
}
function __upstreamThrows(value) {
  try { value(); } catch (_error) { return true; }
  return false;
}
function __upstreamExpect(actual) {
  const positive = {
    toBe(expected) { if (!Object.is(actual, expected)) __upstreamFail("toBe mismatch"); },
    toEqual(expected) { if (!__upstreamSame(actual, expected)) __upstreamFail("toEqual mismatch"); },
    toStrictEqual(expected) { if (!__upstreamSame(actual, expected)) __upstreamFail("toStrictEqual mismatch"); },
    toBeUndefined() { if (actual !== undefined) __upstreamFail("expected undefined"); },
    toBeDefined() { if (actual === undefined) __upstreamFail("expected defined value"); },
    toBeNull() { if (actual !== null) __upstreamFail("expected null"); },
    toHaveLength(expected) { if (actual == null || actual.length !== expected) __upstreamFail("length mismatch"); },
    toThrow() { if (typeof actual !== "function" || !__upstreamThrows(actual)) __upstreamFail("expected throw"); },
    toThrowError() { if (typeof actual !== "function" || !__upstreamThrows(actual)) __upstreamFail("expected throw"); },
  };
  positive.not = {
    toBe(expected) { if (Object.is(actual, expected)) __upstreamFail("unexpected equal value"); },
    toEqual(expected) { if (__upstreamSame(actual, expected)) __upstreamFail("unexpected deep equality"); },
    toThrow() { if (typeof actual !== "function" || __upstreamThrows(actual)) __upstreamFail("unexpected throw"); },
    toThrowError() { if (typeof actual !== "function" || __upstreamThrows(actual)) __upstreamFail("unexpected throw"); },
  };
  return positive;
}
const expect = __upstreamExpect;
function describe(_name, body) { body(); }
function it(name, body) { __upstreamTests.push({ name: String(name), body }); }
function test(name, body) { __upstreamTests.push({ name: String(name), body }); }
const __qunitAssert = {
  expect(_count) {},
  ok(value, message) { if (!value) __upstreamFail(message || "expected truthy value"); },
  notOk(value, message) { if (value) __upstreamFail(message || "expected falsey value"); },
  equal(actual, expected, message) { if (actual != expected) __upstreamFail(message || "equal mismatch"); },
  notEqual(actual, expected, message) { if (actual == expected) __upstreamFail(message || "notEqual mismatch"); },
  strictEqual(actual, expected, message) { if (actual !== expected) __upstreamFail(message || "strictEqual mismatch"); },
  notStrictEqual(actual, expected, message) { if (actual === expected) __upstreamFail(message || "notStrictEqual mismatch"); },
  deepEqual(actual, expected, message) { if (!__upstreamSame(actual, expected)) __upstreamFail(message || "deepEqual mismatch"); },
  throws(fn, _expected, message) { if (!__upstreamThrows(fn)) __upstreamFail(message || "expected throw"); },
};
function suiteModule(_name) {}
const QUnit = {
  module: suiteModule,
  test(name, body) { __upstreamTests.push({ name: String(name), body }); },
};
`;

export const UPSTREAM_TEST_EXPORTS = String.raw`
export function upstreamTestCount(): number { return __upstreamTests.length; }
export function upstreamTestNames(): string[] {
  const names: string[] = [];
  for (let i = 0; i < __upstreamTests.length; i++) names.push(__upstreamTests[i].name);
  return names;
}
export function runUpstreamTests(): number[] {
  const statuses: number[] = [];
  for (let i = 0; i < __upstreamTests.length; i++) {
    try {
      const result = __upstreamTests[i].body(__qunitAssert);
      if (result && typeof result.then === "function") throw new Error("async upstream callback is not admitted");
      statuses.push(1);
    } catch (_error) {
      statuses.push(0);
    }
  }
  return statuses;
}
`;

function errorText(error) {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function nativePathFor(generatedPath) {
  const extension = extname(generatedPath);
  return `${generatedPath.slice(0, -extension.length)}.native.mjs`;
}

async function runNative(generatedPath, source) {
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
      allowJs: true,
    },
    fileName: generatedPath,
    reportDiagnostics: true,
  });
  const nativePath = nativePathFor(generatedPath);
  writeFileSync(nativePath, transpiled.outputText);
  const module = await import(`${pathToFileURL(nativePath).href}?run=${Date.now()}-${Math.random()}`);
  return {
    count: Number(module.upstreamTestCount()),
    names: Array.from(module.upstreamTestNames(), String),
    statuses: Array.from(module.runUpstreamTests(), (value) => Number(value) === 1),
  };
}

async function withTimeout(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`compile timeout after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function compileAndRunUpstreamModule({ generatedPath, source, timeoutMs = 180_000 }) {
  mkdirSync(dirname(generatedPath), { recursive: true });
  writeFileSync(generatedPath, source);

  let native;
  try {
    native = await runNative(generatedPath, source);
  } catch (error) {
    return { native: { fatal: errorText(error), count: 0, names: [], statuses: [] }, compile: null, wasm: null };
  }

  const started = performance.now();
  let result;
  try {
    result = await withTimeout(
      compileProject(generatedPath, {
        allowJs: true,
        skipSemanticDiagnostics: true,
        target: "gc",
        platform: "node",
      }),
      timeoutMs,
    );
  } catch (error) {
    result = { success: false, errors: [{ message: errorText(error) }] };
  }
  const durationMs = Math.round(performance.now() - started);
  if (!result.success || !result.binary?.length) {
    return {
      native,
      compile: { success: false, validates: false, durationMs, binaryBytes: 0, errors: result.errors ?? [] },
      wasm: null,
    };
  }

  try {
    await WebAssembly.compile(result.binary);
  } catch (error) {
    return {
      native,
      compile: {
        success: true,
        validates: false,
        durationMs,
        binaryBytes: result.binary.length,
        errors: [],
        validationError: errorText(error),
      },
      wasm: null,
    };
  }

  try {
    const imports = result.importObject ?? {};
    const { instance } = await WebAssembly.instantiate(result.binary, imports);
    imports.__setInstance?.(instance);
    const exports = wrapExports(instance, { signatures: result.exportSignatures });
    const statuses = Array.from(exports.runUpstreamTests(), (value) => Number(value) === 1);
    return {
      native,
      compile: { success: true, validates: true, durationMs, binaryBytes: result.binary.length, errors: [] },
      wasm: { count: Number(exports.upstreamTestCount()), statuses },
    };
  } catch (error) {
    return {
      native,
      compile: { success: true, validates: true, durationMs, binaryBytes: result.binary.length, errors: [] },
      wasm: { fatal: errorText(error), count: 0, statuses: [] },
    };
  }
}

export function summarizeUpstreamRuns({ name, pin, testFiles, selectedFiles, runs }) {
  const report = {
    generatedAt: new Date().toISOString(),
    package: name,
    upstreamSuite: {
      repo: pin.repo,
      tag: pin.tag,
      commit: pin.commit,
      testFiles: testFiles.length,
      registrationSites: pin.registrationSites,
      selectedFiles,
    },
    extraction: {
      filesSeen: testFiles.length,
      filesSelected: selectedFiles.length,
      filesDeferred: testFiles.length - selectedFiles.length,
      testsRegistered: 0,
      nativePassed: 0,
      nativeFailed: 0,
    },
    compile: { modules: runs.length, succeeded: 0, validated: 0, durationMs: 0, binaryBytes: 0 },
    results: { scored: 0, passed: 0, failed: 0, runtimeFailed: 0, tests: [] },
  };

  for (const run of runs) {
    const native = run.result.native;
    report.extraction.testsRegistered += native.count;
    report.extraction.nativePassed += native.statuses.filter(Boolean).length;
    report.extraction.nativeFailed += native.statuses.filter((status) => !status).length;
    if (run.result.compile?.success) report.compile.succeeded++;
    if (run.result.compile?.validates) report.compile.validated++;
    report.compile.durationMs += run.result.compile?.durationMs ?? 0;
    report.compile.binaryBytes += run.result.compile?.binaryBytes ?? 0;

    for (let index = 0; index < native.count; index++) {
      const nativePassed = native.statuses[index] === true;
      const wasmPassed = run.result.wasm?.statuses[index] === true;
      const status = !nativePassed
        ? "harness-incompatible"
        : run.result.wasm?.fatal
          ? "runtime-failed"
          : wasmPassed
            ? "passed"
            : "failed";
      if (nativePassed) {
        report.results.scored++;
        if (status === "passed") report.results.passed++;
        else if (status === "runtime-failed") report.results.runtimeFailed++;
        else report.results.failed++;
      }
      report.results.tests.push({ file: run.file, name: native.names[index], status });
    }
  }
  report.compile.details = runs.map((run) => ({
    file: run.file,
    ...run.result.compile,
    nativeError: run.result.native.fatal ?? null,
    runtimeError: run.result.wasm?.fatal ?? null,
  }));
  report.summary = {
    headline: `${report.results.passed}/${report.results.scored} admitted original tests pass in Wasm`,
    exactDenominator: report.results.scored,
    upstreamFiles: report.extraction.filesSeen,
    deferredFiles: report.extraction.filesDeferred,
    nativePassed: report.extraction.nativePassed,
    nativeFailed: report.extraction.nativeFailed,
    wasmPassed: report.results.passed,
    wasmFailed: report.results.failed,
    runtimeFailed: report.results.runtimeFailed,
  };
  return report;
}

export function writeUpstreamReport(reportPath, report) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

export function cliUpstreamHarness(runHarness) {
  const jsonOnly = process.argv.includes("--json");
  runHarness({ quiet: jsonOnly })
    .then((report) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify(report)}\n`);
    })
    .catch((error) => {
      if (jsonOnly) process.stdout.write(`${JSON.stringify({ fatal: errorText(error) })}\n`);
      else console.error("[dogfood] upstream suite crashed:", error);
      process.exitCode = 2;
    });
}
