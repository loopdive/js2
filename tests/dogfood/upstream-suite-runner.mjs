import { mkdirSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import * as ts from "typescript";

// The assertions are intentionally small, deterministic JavaScript. They are
// runner infrastructure; the registered callback bodies remain the exact
// upstream source. Both Node and Wasm execute this same shim.
export const UPSTREAM_TEST_SHIM = String.raw`
const __upstreamTests = [];
const __upstreamErrors = [];
let __upstreamAssertion = 0;
function __upstreamFail(message) { throw new Error(String(message || "Assertion failed")); }
function __upstreamValue(value) {
  const kind = typeof value;
  if (value === null || kind === "undefined" || kind === "string" || kind === "number" || kind === "boolean") {
    return kind + ":" + String(value);
  }
  return kind;
}
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
function __upstreamThrown(value) {
  try { value(); } catch (error) { return error; }
  return null;
}
function __upstreamThrownMatches(error, expected) {
  if (error === null) return false;
  if (expected === undefined) return true;
  const message = error && error.message !== undefined ? String(error.message) : String(error);
  if (expected instanceof RegExp) return expected.test(message);
  if (typeof expected === "string") return message.includes(expected);
  if (typeof expected === "function") return error instanceof expected || error.name === expected.name;
  return true;
}
function __upstreamExpect(actual) {
  const positive = {
    toBe(expected) { const n = ++__upstreamAssertion; if (!Object.is(actual, expected)) __upstreamFail("assertion " + n + " toBe: " + __upstreamValue(actual) + " != " + __upstreamValue(expected)); },
    toEqual(expected) { const n = ++__upstreamAssertion; if (!__upstreamSame(actual, expected)) __upstreamFail("assertion " + n + " toEqual mismatch"); },
    toStrictEqual(expected) { const n = ++__upstreamAssertion; if (!__upstreamSame(actual, expected)) __upstreamFail("assertion " + n + " toStrictEqual mismatch"); },
    toBeUndefined() { const n = ++__upstreamAssertion; if (actual !== undefined) __upstreamFail("assertion " + n + " expected undefined, got " + __upstreamValue(actual)); },
    toBeDefined() { const n = ++__upstreamAssertion; if (actual === undefined) __upstreamFail("assertion " + n + " expected defined value"); },
    toBeNull() { const n = ++__upstreamAssertion; if (actual !== null) __upstreamFail("assertion " + n + " expected null, got " + __upstreamValue(actual)); },
    toBeTruthy() { const n = ++__upstreamAssertion; if (!actual) __upstreamFail("assertion " + n + " expected truthy value"); },
    toBeFalsy() { const n = ++__upstreamAssertion; if (actual) __upstreamFail("assertion " + n + " expected falsey value"); },
    toHaveLength(expected) { const n = ++__upstreamAssertion; if (actual == null || actual.length !== expected) __upstreamFail("assertion " + n + " length mismatch"); },
    toContain(expected) { const n = ++__upstreamAssertion; if (actual == null || typeof actual.includes !== "function" || !actual.includes(expected)) __upstreamFail("assertion " + n + " expected contained value"); },
    toHaveProperty(expected) { const n = ++__upstreamAssertion; if (actual == null || !(expected in Object(actual))) __upstreamFail("assertion " + n + " missing property " + String(expected)); },
    toMatch(expected) { const n = ++__upstreamAssertion; const value = String(actual); if (expected instanceof RegExp ? !expected.test(value) : !value.includes(String(expected))) __upstreamFail("assertion " + n + " pattern mismatch"); },
    toBeCalledWith() { const n = ++__upstreamAssertion; const expected = Array.prototype.slice.call(arguments); const calls = actual && actual.mock && actual.mock.calls; let matched = false; if (calls) for (let i = 0; i < calls.length; i++) if (__upstreamSame(calls[i], expected)) matched = true; if (!matched) __upstreamFail("assertion " + n + " expected matching spy call"); },
    toHaveBeenCalledWith() { const n = ++__upstreamAssertion; const expected = Array.prototype.slice.call(arguments); const calls = actual && actual.mock && actual.mock.calls; let matched = false; if (calls) for (let i = 0; i < calls.length; i++) if (__upstreamSame(calls[i], expected)) matched = true; if (!matched) __upstreamFail("assertion " + n + " expected matching spy call"); },
    toHaveBeenCalledTimes(expected) { const n = ++__upstreamAssertion; const calls = actual && actual.mock && actual.mock.calls; if (!calls || calls.length !== expected) __upstreamFail("assertion " + n + " spy call count mismatch"); },
    toBeInstanceOf(expected) { const n = ++__upstreamAssertion; if (typeof expected !== "function" || !(actual instanceof expected)) __upstreamFail("assertion " + n + " instance mismatch"); },
    toMatchSnapshot() { __upstreamFail("snapshot assertion requires a package-specific snapshot adapter"); },
    toThrow(expected) { const n = ++__upstreamAssertion; if (typeof actual !== "function" || !__upstreamThrownMatches(__upstreamThrown(actual), expected)) __upstreamFail("assertion " + n + " expected matching throw"); },
    toThrowError(expected) { const n = ++__upstreamAssertion; if (typeof actual !== "function" || !__upstreamThrownMatches(__upstreamThrown(actual), expected)) __upstreamFail("assertion " + n + " expected matching throw"); },
  };
  positive.not = {
    toBe(expected) { const n = ++__upstreamAssertion; if (Object.is(actual, expected)) __upstreamFail("assertion " + n + " unexpected equal value"); },
    toEqual(expected) { const n = ++__upstreamAssertion; if (__upstreamSame(actual, expected)) __upstreamFail("assertion " + n + " unexpected deep equality"); },
    toHaveBeenCalled() { const n = ++__upstreamAssertion; const calls = actual && actual.mock && actual.mock.calls; if (calls && calls.length > 0) __upstreamFail("assertion " + n + " unexpected spy call"); },
    toThrow() { const n = ++__upstreamAssertion; if (typeof actual !== "function" || __upstreamThrown(actual) !== null) __upstreamFail("assertion " + n + " unexpected throw"); },
    toThrowError() { const n = ++__upstreamAssertion; if (typeof actual !== "function" || __upstreamThrown(actual) !== null) __upstreamFail("assertion " + n + " unexpected throw"); },
  };
  return positive;
}
const expect = __upstreamExpect;
const vi = {
  fn(implementation) {
    function spy() {
      const args = Array.prototype.slice.call(arguments);
      spy.mock.calls.push(args);
      if (typeof implementation === "function") return implementation.apply(this, args);
    }
    spy.mock = { calls: [] };
    spy.mockClear = function() { spy.mock.calls.length = 0; return spy; };
    spy.mockReturnValue = function(value) { implementation = function() { return value; }; return spy; };
    return spy;
  },
};
const __upstreamBeforeEach = [];
function describe(_name, body) {
  const hookCount = __upstreamBeforeEach.length;
  body();
  __upstreamBeforeEach.length = hookCount;
}
function beforeEach(body) { __upstreamBeforeEach.push(body); }
function __upstreamRegister(name, body) {
  const hooks = __upstreamBeforeEach.slice();
  __upstreamTests.push({
    name: String(name),
    body: function(assertion) {
      for (let index = 0; index < hooks.length; index++) hooks[index]();
      return body(assertion);
    },
  });
}
function it(name, body) { __upstreamRegister(name, body); }
function test(name, body) { __upstreamRegister(name, body); }
function __upstreamEach(cases) {
  return function(name, body) {
    const expandRows = cases.length > 0 && cases.every(function(value) { return Array.isArray(value); });
    for (let index = 0; index < cases.length; index++) {
      const row = expandRows ? cases[index] : [cases[index]];
      const displayName = String(name).replace(/%s/g, function() { return String(row[0]); });
      it(displayName, function() {
        if (row.length === 0) return body();
        if (row.length === 1) return body(row[0]);
        if (row.length === 2) return body(row[0], row[1]);
        if (row.length === 3) return body(row[0], row[1], row[2]);
        return body(row[0], row[1], row[2], row[3]);
      });
    }
  };
}
it.each = __upstreamEach;
test.each = __upstreamEach;
const __qunitAssert = {
  expect(_count) {},
  ok(value, message) { const n = ++__upstreamAssertion; if (!value) __upstreamFail("assertion " + n + ": " + (message || "expected truthy value") + "; got " + __upstreamValue(value)); },
  notOk(value, message) { const n = ++__upstreamAssertion; if (value) __upstreamFail("assertion " + n + ": " + (message || "expected falsey value") + "; got " + __upstreamValue(value)); },
  equal(actual, expected, message) { const n = ++__upstreamAssertion; if (actual != expected) __upstreamFail("assertion " + n + ": " + (message || "equal mismatch") + "; " + __upstreamValue(actual) + " != " + __upstreamValue(expected)); },
  notEqual(actual, expected, message) { const n = ++__upstreamAssertion; if (actual == expected) __upstreamFail("assertion " + n + ": " + (message || "notEqual mismatch") + "; unexpected " + __upstreamValue(actual)); },
  strictEqual(actual, expected, message) { const n = ++__upstreamAssertion; if (actual !== expected) __upstreamFail("assertion " + n + ": " + (message || "strictEqual mismatch") + "; " + __upstreamValue(actual) + " !== " + __upstreamValue(expected)); },
  notStrictEqual(actual, expected, message) { const n = ++__upstreamAssertion; if (actual === expected) __upstreamFail("assertion " + n + ": " + (message || "notStrictEqual mismatch") + "; unexpected " + __upstreamValue(actual)); },
  deepEqual(actual, expected, message) { const n = ++__upstreamAssertion; if (!__upstreamSame(actual, expected)) __upstreamFail("assertion " + n + ": " + (message || "deepEqual mismatch") + "; " + __upstreamValue(actual) + " != " + __upstreamValue(expected)); },
  throws(fn, expected, message) { if (!__upstreamThrownMatches(__upstreamThrown(fn), expected)) __upstreamFail(message || "expected matching throw"); },
};
function suiteModule(_name, body) { if (typeof body === "function") body(); }
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
  __upstreamErrors.length = 0;
  for (let i = 0; i < __upstreamTests.length; i++) {
    __upstreamAssertion = 0;
    try {
      const result = __upstreamTests[i].body(__qunitAssert);
      if (result && typeof result.then === "function") {
        // The synchronous Wasm runner cannot score async callbacks yet. Attach
        // a rejection sink before classifying the callback so an intentionally
        // unawaited upstream promise cannot crash the surrounding harness.
        if (typeof result.catch === "function") result.catch(function() {});
        throw new Error("async upstream callback is not admitted");
      }
      statuses.push(1);
      __upstreamErrors.push("");
    } catch (error) {
      statuses.push(0);
      __upstreamErrors.push(error && error.message !== undefined ? String(error.message) : String(error));
    }
  }
  return statuses;
}
export function upstreamTestErrors(): string[] { return __upstreamErrors; }
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
  const statuses = Array.from(module.runUpstreamTests(), (value) => Number(value) === 1);
  return {
    count: Number(module.upstreamTestCount()),
    names: Array.from(module.upstreamTestNames(), String),
    statuses,
    errors: Array.from(module.upstreamTestErrors(), String),
  };
}

/**
 * Compile and execute one upstream module in a child process.
 *
 * `compileProject` is intentionally synchronous from the event loop's point
 * of view.  A Promise.race timeout therefore cannot interrupt a pathological
 * module: the timer never gets a chance to fire while code generation is
 * running.  Keeping the compiler and Wasm instance in a short-lived child
 * gives the suite a real hard deadline and prevents one package from wedging
 * the npm-compat workflow.
 */
function runIsolatedCompile(generatedPath, timeoutMs, mode = "project", workerEnv = {}) {
  return new Promise((resolve) => {
    const workerPath = new URL("./upstream-suite-compile-worker.mjs", import.meta.url);
    const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(workerPath), generatedPath, mode], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...workerEnv },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const started = performance.now();
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      finish({
        compile: {
          success: false,
          validates: false,
          durationMs: Math.round(performance.now() - started),
          binaryBytes: 0,
          errors: [{ message: errorText(error) }],
        },
        wasm: null,
      });
    });
    child.on("exit", (code, signal) => {
      if (settled) return;
      try {
        const result = JSON.parse(stdout.trim());
        finish(result);
      } catch {
        const detail = stderr.trim() || stdout.trim() || `worker exited with ${signal ?? `code ${code}`}`;
        finish({
          compile: {
            success: false,
            validates: false,
            durationMs: Math.round(performance.now() - started),
            binaryBytes: 0,
            errors: [{ message: detail }],
          },
          wasm: null,
        });
      }
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        compile: {
          success: false,
          validates: false,
          durationMs: timeoutMs,
          binaryBytes: 0,
          timedOut: true,
          errors: [{ message: `compile timeout after ${timeoutMs}ms${stderr ? `; worker: ${stderr.trim()}` : ""}` }],
        },
        wasm: null,
      });
    }, timeoutMs);
    timer.unref?.();
  });
}

export async function compileAndRunUpstreamModule({
  generatedPath,
  source,
  nativeSource = source,
  timeoutMs = 180_000,
}) {
  mkdirSync(dirname(generatedPath), { recursive: true });
  writeFileSync(generatedPath, source);

  let native;
  try {
    native = await runNative(generatedPath, nativeSource);
  } catch (error) {
    return { native: { fatal: errorText(error), count: 0, names: [], statuses: [] }, compile: null, wasm: null };
  }

  const isolated = await runIsolatedCompile(generatedPath, timeoutMs);
  return { native, ...isolated };
}

/**
 * Compile a generated source file in an isolated worker without executing its
 * exports. Large package implementations (notably ReactDOM) must pass this
 * gate before per-test batches are attempted; the child gives the caller a
 * real deadline even while synchronous code generation is running.
 */
export async function compileSourceInWorker({ generatedPath, source, timeoutMs = 300_000, workerEnv }) {
  mkdirSync(dirname(generatedPath), { recursive: true });
  writeFileSync(generatedPath, source);
  return runIsolatedCompile(generatedPath, timeoutMs, "source", workerEnv);
}

/**
 * Compile a generated multi-file upstream project in an isolated worker.
 * Keeping the package implementation in imported files means a test entry
 * does not have to concatenate/recompile the same large CJS body once per
 * batch, while the worker still supplies a hard deadline for pathological
 * code generation.
 */
export async function compileProjectInWorker({ generatedRoot, entryFile = "entry.ts", files, timeoutMs = 300_000, workerEnv }) {
  mkdirSync(generatedRoot, { recursive: true });
  for (const [relativePath, source] of Object.entries(files)) {
    const target = join(generatedRoot, relativePath);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  return runIsolatedCompile(join(generatedRoot, entryFile), timeoutMs, "project", workerEnv);
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
      report.results.tests.push({
        file: run.file,
        name: native.names[index],
        status,
        nativeError: native.errors?.[index] || null,
        wasmError: run.result.wasm?.errors?.[index] || run.result.wasm?.fatal || null,
      });
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
