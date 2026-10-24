import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  parseTest262CompilerPath,
  requireTest262CompilerPath,
  summarizeTest262CompilerPaths,
  test262RequestedCompilerPathMetadata,
  test262CacheDirectoryName,
  test262CompilerPathStatus,
} from "./test262-compiler-path.mjs";
import { test262ResultPrefix } from "./test262-lane.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));

test("path selection accepts explicit routes and refuses misspellings", () => {
  assert.equal(parseTest262CompilerPath("legacy"), "legacy");
  assert.equal(parseTest262CompilerPath("ir"), "ir");
  assert.throws(() => parseTest262CompilerPath("IR"));
});

test("historical rows cannot be relabelled by a current legacy request", () => {
  const identity = summarizeTest262CompilerPaths([{ status: "pass" }], "legacy");
  assert.equal(identity.compilerPath, "unknown");
  assert.equal(identity.requestedCompilerPath, "legacy");
  assert.equal(identity.compilerPathVerified, false);
});

test("compatibility request records hybrid configuration without proving execution", () => {
  const identity = test262RequestedCompilerPathMetadata("legacy", "standalone");
  assert.equal(identity.configuredCompilerPath, "hybrid");
  assert.equal(identity.executionCompilerPath, "unknown");
  assert.equal(identity.compilerPathVerified, false);
  assert.equal(test262RequestedCompilerPathMetadata("legacy", "wasi").configuredCompilerPath, "hybrid");
  assert.equal(test262RequestedCompilerPathMetadata("legacy", "unrecognised").configuredCompilerPath, "unknown");
});

test("cache and artifact namespaces preserve the old lane and isolate IR", () => {
  assert.equal(test262CacheDirectoryName("legacy"), ".test262-cache");
  assert.equal(test262CacheDirectoryName("ir"), ".test262-cache-ir");
  assert.equal(test262ResultPrefix("standalone", "legacy"), "test262-standalone");
  assert.equal(test262ResultPrefix("standalone", "ir"), "test262-standalone-ir");
});

test("neither IR_FIRST nor caller supplied verified flags admit IR numbers", () => {
  assert.equal(requireTest262CompilerPath("ir"), "ir");
  assert.throws(() => summarizeTest262CompilerPaths([{ compilerPath: "ir", compilerPathVerified: true }]));
  assert.throws(() => summarizeTest262CompilerPaths([{ compilerPath: "legacy", executionCompilerPath: "ir" }]));
  assert.throws(() => summarizeTest262CompilerPaths([{ executionCompilerPath: "garbage" }]));
});

test("mixed old and labelled rows stay mixed even when a duplicate would hide history", () => {
  const identity = summarizeTest262CompilerPaths([{ file: "x" }, { file: "x", compilerPath: "legacy" }]);
  assert.equal(identity.compilerPath, "mixed");
  assert.equal(identity.compilerPathVerified, false);
});

test("request-only CLI accepts IR without manufacturing measured counts", () => {
  const directory = mkdtempSync(join(tmpdir(), "test262-path-"));
  try {
    const status = join(directory, "test262-ir-status.json");
    const child = spawnSync(
      process.execPath,
      [join(root, "scripts/check-test262-compiler-path.mjs"), "--compiler-path", "ir", "--status", status],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0);
    const data = test262CompilerPathStatus("ir");
    assert.equal(data.state, "requested");
    assert.equal(data.compilerPathVerified, false);
    assert.equal(Object.hasOwn(data, "summary"), false);
    assert.equal(Object.hasOwn(data, "total"), false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the real report builder preserves historical numbers as path unknown", () => {
  const directory = mkdtempSync(join(tmpdir(), "test262-path-report-"));
  try {
    const input = join(directory, "rows.jsonl");
    const output = join(directory, "report.json");
    writeFileSync(
      input,
      JSON.stringify({ file: "language/x.js", status: "pass", category: "language", scope: "standard" }) + "\n",
    );
    const child = spawnSync(
      process.execPath,
      [
        join(root, "scripts/build-test262-report.mjs"),
        "--input",
        input,
        "--output",
        output,
        "--target",
        "standalone",
        "--compiler-path",
        "legacy",
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const data = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(data.summary.pass, 1);
    assert.equal(data.summary.total, 1);
    assert.equal(data.compilerPath, "unknown");
    assert.equal(data.compilerPathVerified, false);
    const categories = JSON.parse(readFileSync(join(directory, "test262-standalone-categories.json"), "utf8"));
    assert.equal(categories.compilerPath, data.compilerPath);
    assert.equal(categories.compilerPathVerified, false);
    assert.equal(categories.executionCompilerPath, "unknown");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("historical unavailable artifacts remain historical and unscored", () => {
  for (const name of ["test262-ir-status.json", "test262-standalone-ir-status.json"]) {
    const status = JSON.parse(readFileSync(join(root, "benchmarks/results", name), "utf8"));
    assert.equal(status.state, "unavailable");
    assert.equal(status.compilerPathVerified, false);
    assert.equal(Object.hasOwn(status, "summary"), false);
  }
});

const proof = {
  schema: "test262-prepared-execution-report-v1",
  jobId: 3,
  workerPid: 7,
  backend: "wasmgc",
  target: "standalone",
  sourceSha256: "0".repeat(64),
  binaryBytes: 42,
  emittedUnits: 1,
};
test("measured all-fail IR keeps the requested denominator without invented execution", () => {
  const data = summarizeTest262CompilerPaths(
    [
      { compilerPath: "ir", status: "compile_error", compilerAttempts: 1, executionCompilerPath: "unknown" },
      { compilerPath: "ir", status: "compile_error", compilerAttempts: 1, executionCompilerPath: "unknown" },
    ],
    "ir",
  );
  assert.equal(data.measurementState, "measured");
  assert.equal(data.completedCases, 2);
  assert.equal(data.attemptedCases, 2);
  assert.equal(data.compileErrorCases, 2);
  assert.equal(data.verifiedExecutionCases, 0);
  assert.equal(data.unverifiedExecutionCases, 2);
  assert.equal(data.compilerPathVerified, false);
  assert.equal(data.executionCompilerPath, "unknown");
});
test("mixed skip, compilation refusal and verified execution have consistent independent denominators", () => {
  const data = summarizeTest262CompilerPaths(
    [
      { compilerPath: "ir", status: "skip" },
      { compilerPath: "ir", status: "compile_error", compilerAttempts: 1 },
      {
        compilerPath: "ir",
        status: "pass",
        compilerAttempts: 2,
        compilerPathVerified: true,
        executionCompilerPath: "ir",
        preparedExecutionReport: proof,
      },
    ],
    "ir",
  );
  assert.equal(data.attemptedCases, 3);
  assert.equal(data.completedCases, 3);
  assert.equal(data.skippedCases, 1);
  assert.equal(data.verifiedExecutionCases, 1);
  assert.equal(data.unverifiedExecutionCases, 1);
  assert.equal(data.compilerPathVerified, false);
});
test("infrastructure failure is unavailable rather than a uniform compiler-refusal measurement", () => {
  const data = summarizeTest262CompilerPaths(
    [{ compilerPath: "ir", status: "compile_error", compilerAttempts: 1, compilerPathFailureKind: "transport" }],
    "ir",
  );
  assert.equal(data.measurementState, "unavailable");
});
test("report builder carries actual requested-attempt counters through full and category outputs", () => {
  const directory = mkdtempSync(join(tmpdir(), "test262-ir-report-"));
  try {
    const input = join(directory, "rows.jsonl"),
      output = join(directory, "report.json");
    writeFileSync(
      input,
      JSON.stringify({
        file: "language/x.js",
        status: "compile_error",
        category: "language",
        scope: "standard",
        compilerPath: "ir",
        compilerAttempts: 1,
        executionCompilerPath: "unknown",
        error: "Prepared IR: unsupported original source",
      }) + "\n",
    );
    const child = spawnSync(
      process.execPath,
      [
        join(root, "scripts/build-test262-report.mjs"),
        "--input",
        input,
        "--output",
        output,
        "--target",
        "standalone",
        "--compiler-path",
        "ir",
      ],
      { encoding: "utf8" },
    );
    assert.equal(child.status, 0, child.stderr);
    const data = JSON.parse(readFileSync(output, "utf8"));
    assert.equal(data.summary.compile_error, 1);
    assert.equal(data.compilerPath, "ir");
    assert.equal(data.measurementState, "measured");
    assert.equal(data.attemptedCases, 1);
    assert.equal(data.verifiedExecutionCases, 0);
    assert.equal(data.unverifiedExecutionCases, 1);
    const categories = JSON.parse(readFileSync(join(directory, "test262-standalone-ir-categories.json"), "utf8"));
    assert.equal(categories.measurementState, "measured");
    assert.equal(categories.compileErrorCases, 1);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("explicit IR configuration/request is separate from unknown execution", () => {
  const row = test262RequestedCompilerPathMetadata("ir", "standalone");
  assert.equal(row.compilerPath, "ir");
  assert.equal(row.requestedCompilerPath, "ir");
  assert.equal(row.configuredCompilerPath, "ir");
  assert.equal(row.executionCompilerPath, "unknown");
  assert.equal(row.compilerPathVerified, false);
  const summary = summarizeTest262CompilerPaths([{ ...row, status: "compile_error", compilerAttempts: 1 }], "ir");
  assert.equal(summary.configuredCompilerPath, "ir");
  assert.equal(summary.measurementState, "measured");
});

test("IR report failure threshold is a plain scalar under FORCE_COLOR", () => {
  const shell = readFileSync(join(root, "scripts/run-test262-vitest.sh"), "utf8");
  const program = shell.match(/IR_FAILURE_ROWS=\$\(node -e '([^']+)'/)[1];
  const directory = mkdtempSync(join(tmpdir(), "test262-color-count-"));
  try {
    const input = join(directory, "rows.jsonl");
    writeFileSync(
      input,
      [{ status: "pass" }, { status: "skip" }, { status: "compile_error" }, { status: "fail" }]
        .map(JSON.stringify)
        .join("\n") + "\n",
    );
    const child = spawnSync(process.execPath, ["-e", program, input], {
      encoding: "utf8",
      env: { ...process.env, FORCE_COLOR: "1" },
    });
    assert.equal(child.status, 0);
    assert.equal(child.stdout, "2");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("actual worker admission refuses missing strict APIs before any compiler call", () => {
  const worker = readFileSync(join(root, "scripts/test262-worker.mjs"), "utf8");
  const start = worker.indexOf("  // No legacy cache/provider path may be entered on behalf of a strict request.");
  const end = worker.indexOf("  currentNativeEvalBoundaryObservation =", start);
  assert.ok(start >= 0 && end > start);
  const enter = new Function(
    "compilerBundle",
    "preparedRequest",
    "msg",
    "sendResult",
    "refusePreparedArtifactPaths",
    "requireTest262CompilerPath",
    "doCompile",
    worker.slice(start, end) + "return doCompile();",
  );
  const names = [
    "instantiatePreparedArtifact",
    "preparedRuntimeExecutionObservation",
    "requiredPreparedEmission",
    "requiredPreparedFinalArtifactObservation",
  ];
  const complete = Object.fromEntries(names.map((name) => [name, () => {}]));
  for (const missing of ["all", ...names]) {
    const compiler = missing === "all" ? {} : { ...complete, [missing]: undefined };
    const sent = [];
    let compileCalls = 0;
    enter(
      compiler,
      { wholeProgram: { kind: "prepared-program-required", version: 1 } },
      { id: 7, compilerPath: "ir" },
      (row) => sent.push(row),
      () => {},
      requireTest262CompilerPath,
      () => compileCalls++,
    );
    assert.equal(compileCalls, 0, missing);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].compilerPathFailureKind, "transport");
    assert.match(sent[0].error, /compiler bundle lacks strict capability/);
  }
  let compileCalls = 0;
  enter(
    complete,
    {},
    { id: 8, compilerPath: "ir" },
    () => assert.fail("genuine complete route refused"),
    () => {},
    requireTest262CompilerPath,
    () => compileCalls++,
  );
  assert.equal(compileCalls, 1);
  enter(
    {},
    undefined,
    { id: 9, compilerPath: "legacy" },
    () => assert.fail("legacy route refused"),
    () => {},
    requireTest262CompilerPath,
    () => compileCalls++,
  );
  assert.equal(compileCalls, 2);
});

test("actual worker startup host primes remain legacy-only without mutating globals", () => {
  const worker = readFileSync(join(root, "scripts/test262-worker.mjs"), "utf8");
  const iteratorStart = worker.indexOf("const startupIteratorDescriptor =");
  const iteratorEnd = worker.indexOf("// --- Category 1:", iteratorStart);
  const promiseStart = worker.indexOf(
    'if (process.env.TEST262_COMPILER_PATH !== "ir") {',
    worker.indexOf("// (#6492 r5) Prime"),
  );
  const promiseEnd = worker.indexOf("let realmCanarySnapshot =", promiseStart);
  assert.ok(iteratorStart >= 0 && iteratorEnd > iteratorStart && promiseStart >= 0 && promiseEnd > promiseStart);
  const iterator = new Function(
    "process",
    "globalThis",
    "_installIteratorHelperPolyfills",
    worker.slice(iteratorStart, iteratorEnd),
  );
  const promise = new Function("process", "runtimeBundle", "Promise", worker.slice(promiseStart, promiseEnd));
  for (const path of ["ir", "legacy", undefined]) {
    let iteratorCalls = 0,
      promiseCalls = 0;
    const env = { env: { TEST262_COMPILER_PATH: path } };
    iterator(env, { Iterator: function Iterator() {} }, () => iteratorCalls++);
    promise(env, { _installPromiseKeyedCombinators: () => promiseCalls++ }, function FakePromise() {});
    assert.equal(iteratorCalls, path === "ir" ? 0 : 1);
    assert.equal(promiseCalls, path === "ir" ? 0 : 1);
  }
});
