#!/usr/bin/env node
// Generates the committed npm-package-compatibility summary consumed by the
// website's "npm compatibility" page (website/public/npm-compat.html +
// website/components/npm-compat-chart.js) — mirrors the existing
// `scripts/generate-playground-benchmark-sidebar.mjs` convention: a
// build-time-generated, COMMITTED JSON artifact, fetched client-side at
// runtime, not templated into the HTML.
//
// Reuses the existing tests/dogfood/*-harness.mjs `runHarness()` exports for
// compile/validate/differential-correctness data (each already does this,
// no need to duplicate that logic) and adds head-to-head perf comparisons of
// the compiled Wasm export against the SAME pinned package running natively
// under Node. The explicit JS-host and standalone lanes distinguish whether
// Node or Wasm owns the benchmark driver and repeated-call loop.
//
// Scope: only the packages with a real, committed, reproducible dogfood
// harness (acorn, marked, clsx, cookie, eslint, prettier, react).
// mustache/diff/dayjs were probed
// ad-hoc (see their issue files, #3720/#3721/#3747) but have no committed
// harness yet — deliberately NOT included here rather than fabricating
// numbers from a one-off, non-reproducible probe.
//
// Invoke: `pnpm run generate:npm-compat` (writes benchmarks/results/npm-compat.json
// and copies it to website/public/benchmarks/results/).

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector";

import { compile, compileMulti } from "../src/index.ts";
import { buildStringConstants, buildStringConstants16, jsString, wrapExports } from "../src/runtime.ts";

import { runHarness as runAcorn } from "../tests/dogfood/acorn-harness.mjs";
import { runHarness as runAcornOfficialSuite } from "../tests/dogfood/acorn-official-suite.mjs";
import { runHarness as runMarked } from "../tests/dogfood/marked-harness.mjs";
import { runHarness as runClsx } from "../tests/dogfood/clsx-harness.mjs";
import { runHarness as runCookie } from "../tests/dogfood/cookie-harness.mjs";
import { runHarness as runEslint } from "../tests/dogfood/eslint-harness.mjs";
import { runHarness as runPrettier } from "../tests/dogfood/prettier-harness.mjs";
import { runHarness as runReact } from "../tests/dogfood/react-harness.mjs";

import { setupAcorn } from "../tests/dogfood/setup-acorn.mjs";
import { setupClsx } from "../tests/dogfood/setup-clsx.mjs";
import { setupCookie } from "../tests/dogfood/setup-cookie.mjs";
import { CLSX_OPS } from "../tests/dogfood/clsx-ops.mjs";
import {
  failedPerfLane,
  measureJsHostPerf,
  measureStandalonePerf,
  mergeNpmPerfHistory,
  npmPerfHistoryPoint,
  npmPerfRows,
  packagePerfRecord,
  skippedPerfLane,
} from "./lib/npm-compat-perf.mjs";
import { renderHarnessThrownText } from "./lib/wasm-exn-render.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const PACKAGE_NAMES = ["acorn", "marked", "clsx", "cookie", "eslint", "prettier", "react"];
const cliArgs = process.argv.slice(2);

function optionValue(name) {
  const exact = cliArgs.indexOf(name);
  if (exact >= 0) return cliArgs[exact + 1];
  const prefix = `${name}=`;
  return cliArgs.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const onlyArg = optionValue("--only");
const selectedPackages = new Set(
  onlyArg
    ? onlyArg
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean)
    : PACKAGE_NAMES,
);
const unknownPackages = [...selectedPackages].filter((name) => !PACKAGE_NAMES.includes(name));
if (unknownPackages.length > 0 || selectedPackages.size === 0) {
  throw new Error(
    `--only expects one or more of ${PACKAGE_NAMES.join(", ")}; received ${unknownPackages.join(", ") || "(empty)"}`,
  );
}
const focusedRun = selectedPackages.size !== PACKAGE_NAMES.length;
const writeArtifacts = !cliArgs.includes("--no-write") && !focusedRun;
const inspectWatFunctions = optionValue("--inspect-wat")
  ?.split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const inspectWatOutputPath = optionValue("--wat-output");
const inspectConstantFloor = cliArgs.includes("--inspect-constant-floor");
const inspectBoundaries = cliArgs.includes("--inspect-boundaries");
const inspectImports = cliArgs.includes("--inspect-imports");
const inspectResultFloor = cliArgs.includes("--inspect-result-floor");
const inspectIr = cliArgs.includes("--inspect-ir");
const inspectRuntimeErrors = cliArgs.includes("--inspect-runtime-errors");
const inspectBinaryPath = optionValue("--inspect-binary");
const preserveDebugNames = cliArgs.includes("--preserve-debug-names");
const linkedStandalone = cliArgs.includes("--linked-standalone");
const reuseStandaloneBinaryPath = optionValue("--reuse-standalone-binary");
const profileRuntime = optionValue("--profile-runtime");
const profileOutputPath = optionValue("--profile-output");
const profileIterations = Number(optionValue("--profile-iterations") ?? 40);
const perfOnly = cliArgs.includes("--perf-only");
const diagnosticsOnly = cliArgs.includes("--diagnostics-only");
const selectedLane = optionValue("--lane") ?? "both";
if (!["both", "js-host", "standalone", "standalone-static", "standalone-dynamic"].includes(selectedLane)) {
  throw new Error("--lane expects one of both, js-host, standalone, standalone-static, or standalone-dynamic");
}
const runJsHostLane = selectedLane === "both" || selectedLane === "js-host";
const runStandaloneLane =
  selectedLane === "both" || selectedLane === "standalone" || selectedLane === "standalone-static";
const runStandaloneDynamicLane = selectedLane === "both" || selectedLane === "standalone-dynamic";
if (
  perfOnly &&
  (selectedPackages.size !== 1 || !["acorn", "clsx", "cookie"].some((name) => selectedPackages.has(name)))
) {
  throw new Error("--perf-only requires exactly one of --only acorn, --only clsx, or --only cookie");
}
if ((diagnosticsOnly || inspectBoundaries) && !runJsHostLane) {
  throw new Error("--diagnostics-only and --inspect-boundaries require --lane js-host or --lane both");
}
if (profileRuntime && !["wasm", "node"].includes(profileRuntime)) {
  throw new Error("--profile-runtime expects wasm or node");
}
if (profileRuntime && !profileOutputPath) {
  throw new Error("--profile-runtime requires --profile-output <file.cpuprofile>");
}
if (!Number.isSafeInteger(profileIterations) || profileIterations < 1) {
  throw new Error("--profile-iterations expects a positive integer");
}

const RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "npm-compat.json");
const PUBLIC_PATH = resolve(ROOT, "website", "public", "benchmarks", "results", "npm-compat.json");
// Sibling artifact in the EXACT row shape `<perf-benchmark-chart mode="perf">`
// consumes (name / wasmUs / jsUs / ratioStd), so the npm-compat page reuses the
// landing page's own chart component instead of re-implementing a bar chart.
// `jsUs` is the native-Node time — the component's baseline tick.
const PERF_RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "npm-compat-perf.json");
const PERF_PUBLIC_PATH = resolve(ROOT, "website", "public", "benchmarks", "results", "npm-compat-perf.json");
const HISTORY_RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "npm-compat-history.json");
const HISTORY_PUBLIC_PATH = resolve(ROOT, "website", "public", "benchmarks", "results", "npm-compat-history.json");

function readHistoryArtifact() {
  if (!existsSync(HISTORY_RESULTS_PATH)) return { schemaVersion: 1, runs: [] };
  return JSON.parse(readFileSync(HISTORY_RESULTS_PATH, "utf-8"));
}

function committedHistoryPoints() {
  try {
    const revisions = execFileSync(
      "git",
      ["log", "--format=%H", "--reverse", "--", "benchmarks/results/npm-compat.json"],
      {
        cwd: ROOT,
        encoding: "utf-8",
      },
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    return revisions.map((revision) => {
      const report = JSON.parse(
        execFileSync("git", ["show", `${revision}:benchmarks/results/npm-compat.json`], {
          cwd: ROOT,
          encoding: "utf-8",
          maxBuffer: 16 * 1024 * 1024,
        }),
      );
      return npmPerfHistoryPoint(report.packages ?? [], report.generatedAt, revision);
    });
  } catch (error) {
    console.warn(
      `[npm-compat] could not backfill committed performance history: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return [];
  }
}

function currentRevision() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

function instrumentImports(importObject, { callbacks = true } = {}) {
  const importCalls = new Map();
  const callbackCalls = new Map();
  if (importObject.__startImportCounting && importObject.__takeImportCounts && !callbacks) {
    importObject.__startImportCounting();
    return {
      instrumented: importObject,
      importCalls,
      callbackCalls,
      stop() {
        for (const [name, count] of Object.entries(importObject.__takeImportCounts())) {
          if (count > 0) importCalls.set(`env.${name}`, count);
        }
      },
    };
  }
  const instrumented = Object.create(null);
  for (const [moduleName, namespace] of Object.entries(importObject)) {
    instrumented[moduleName] = Object.create(null);
    for (const [name, value] of Object.entries(namespace)) {
      instrumented[moduleName][name] =
        typeof value === "function" && moduleName === "env"
          ? new Proxy(value, {
              apply(target, thisArg, args) {
                const key = `${moduleName}.${name}`;
                importCalls.set(key, (importCalls.get(key) ?? 0) + 1);
                return Reflect.apply(target, thisArg, args);
              },
            })
          : value;
    }
  }
  if (importObject.__setExports) {
    Object.defineProperty(instrumented, "__setExports", {
      value(exports) {
        if (!callbacks) {
          importObject.__setExports(exports);
          return;
        }
        const wrapped = {};
        for (const [name, value] of Object.entries(exports)) {
          wrapped[name] =
            typeof value === "function"
              ? new Proxy(value, {
                  apply(target, thisArg, args) {
                    callbackCalls.set(name, (callbackCalls.get(name) ?? 0) + 1);
                    return Reflect.apply(target, thisArg, args);
                  },
                })
              : value;
        }
        importObject.__setExports(wrapped);
      },
    });
  }
  return { instrumented, importCalls, callbackCalls, stop() {} };
}

const STANDALONE_BENCHMARK_EXPORT = "__npmCompatStandaloneBenchmark";
const STANDALONE_STATIC_OPERATION_EXPORT = "__npmCompatStaticOperation";
const CLSX_PERF_OP_NAME = "op_two_strings";

function chunkedStringArray(value, chunkSize = 1024) {
  const chunks = [];
  for (let offset = 0; offset < value.length; offset += chunkSize) {
    chunks.push(JSON.stringify(value.slice(offset, offset + chunkSize)));
  }
  return `[${chunks.join(",\n")}]`;
}

function moduleImportMetadata(moduleImports) {
  return {
    moduleImportCount: moduleImports.length,
    functionImportCount: moduleImports.filter((entry) => entry.endsWith(":function")).length,
    ...(inspectImports ? { moduleImports } : {}),
  };
}

function firstCompileDiagnostic(result) {
  const error = result?.errors?.[0] ?? result?.diagnostics?.[0];
  const value = error?.messageText ?? error?.message ?? error;
  if (typeof value === "string") return value;
  if (value && typeof value.messageText === "string") return value.messageText;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "compile returned no binary");
  }
}

function inspectorPost(session, method) {
  return new Promise((resolvePost, rejectPost) => {
    session.post(method, (error, value) => (error ? rejectPost(error) : resolvePost(value)));
  });
}

async function captureRuntimeProfile(operation) {
  const session = new Session();
  session.connect();
  try {
    await inspectorPost(session, "Profiler.enable");
    await inspectorPost(session, "Profiler.start");
    for (let iteration = 0; iteration < profileIterations; iteration++) operation();
    const { profile } = await inspectorPost(session, "Profiler.stop");
    writeFileSync(profileOutputPath, JSON.stringify(profile));
    console.log(
      `[npm-compat] wrote ${profileRuntime} runtime profile (${profileIterations} operation(s)) to ${profileOutputPath}`,
    );
  } finally {
    session.disconnect();
  }
}

async function compileStandaloneLane({
  source,
  driver,
  packageFileName,
  sampleOp,
  nodeOperation,
  inlineDriver = false,
  staticOperationExport,
  inputMode = "compile-time-static",
  runtimeArgument,
}) {
  const failStandalone = (status, diagnostic, extra = {}) =>
    failedPerfLane("standalone", status, diagnostic, { inputMode, ...extra });
  const compileStarted = performance.now();
  let result;
  let staticEvaluation;
  try {
    const compileOptions = {
      allowJs: true,
      skipSemanticDiagnostics: true,
      optimize: 4,
      target: "standalone",
      // Linked npm graphs can need their complete instance (including
      // internal callback exports) while module initialization runs. Keep
      // the binary host-free, but invoke the exported initializer
      // immediately after instantiation instead of using the Wasm start
      // section (#3782).
      deferTopLevelInit: true,
      trackIrOutcomes: inspectIr,
      preserveDebugNames,
      ...(inspectWatFunctions?.length
        ? {
            emitWat: true,
            emitWatOnlyFunctions: inspectWatFunctions,
          }
        : {}),
    };
    result = reuseStandaloneBinaryPath
      ? {
          success: true,
          binary: readFileSync(reuseStandaloneBinaryPath),
          irCompiledFuncs: [],
        }
      : inlineDriver
        ? await compile(`${source}\n${driver}`, {
            ...compileOptions,
            fileName: packageFileName,
          })
        : await compileMulti(
            {
              [packageFileName]: source,
              "__npm-compat-benchmark.mjs": driver,
            },
            "__npm-compat-benchmark.mjs",
            compileOptions,
          );
    if (staticOperationExport && !reuseStandaloneBinaryPath) {
      if (!result.success || !result.binary?.length) {
        return failStandalone("compile-error", firstCompileDiagnostic(result), {
          compileDurationMs: performance.now() - compileStarted,
        });
      }
      const stageModule = await WebAssembly.compile(result.binary);
      const stageImports = WebAssembly.Module.imports(stageModule);
      if (stageImports.length > 0) {
        return failStandalone(
          "host-import-error",
          `static evaluation candidate retained ${stageImports.length} host import(s)`,
          {
            compileDurationMs: performance.now() - compileStarted,
            binaryBytes: result.binary.length,
            ...moduleImportMetadata(
              stageImports.map(({ module: namespace, name, kind }) => `${namespace}.${name}:${kind}`),
            ),
          },
        );
      }
      const stageInstance = await WebAssembly.instantiate(stageModule, {});
      const stageInit = stageInstance.exports.__module_init;
      if (typeof stageInit === "function") stageInit();
      const stageOperation = stageInstance.exports[staticOperationExport];
      if (typeof stageOperation !== "function") {
        return failStandalone("runtime-error", `missing static operation export ${staticOperationExport}`, {
          phase: "static-evaluation",
          compileDurationMs: performance.now() - compileStarted,
          binaryBytes: result.binary.length,
        });
      }
      const stageStarted = performance.now();
      const staticResult = stageOperation();
      const stageDurationMs = performance.now() - stageStarted;
      if (typeof staticResult !== "number" || !Number.isFinite(staticResult)) {
        return failStandalone(
          "runtime-error",
          `static operation must return a finite number, received ${String(staticResult)}`,
          {
            phase: "static-evaluation",
            compileDurationMs: performance.now() - compileStarted,
            binaryBytes: result.binary.length,
          },
        );
      }
      const residualValue = Object.is(staticResult, -0) ? "-0" : String(staticResult);
      const residualSource = `
/** @param {number} iterations */
export function ${STANDALONE_BENCHMARK_EXPORT}(iterations) {
  return iterations * ${residualValue};
}`;
      const residual = await compile(residualSource, {
        ...compileOptions,
        fileName: `__npm-compat-static-${packageFileName}`,
      });
      if (!residual.success || !residual.binary?.length) {
        return failStandalone("compile-error", firstCompileDiagnostic(residual), {
          phase: "static-residual",
          compileDurationMs: performance.now() - compileStarted,
        });
      }
      staticEvaluation = {
        operationEvaluatedInWasm: true,
        operationResultType: "number",
        stageDurationMs,
        stageBinaryBytes: result.binary.length,
        stageModuleImportCount: 0,
      };
      result = residual;
    }
  } catch (error) {
    return failStandalone("compile-error", error instanceof Error ? error.message : String(error), {
      compileDurationMs: performance.now() - compileStarted,
    });
  }
  const compileDurationMs = performance.now() - compileStarted;
  if (!result.success || !result.binary?.length) {
    return failStandalone("compile-error", firstCompileDiagnostic(result), { compileDurationMs });
  }
  if (inspectWatFunctions?.length) {
    if (inspectWatOutputPath) {
      writeFileSync(inspectWatOutputPath, result.wat ?? "");
      console.log(`[npm-compat] wrote standalone WAT to ${inspectWatOutputPath}`);
    } else {
      console.log(`[npm-compat] standalone WAT (${inspectWatFunctions.join(", ")})\n${result.wat ?? "(unavailable)"}`);
    }
  }
  if (inspectIr) {
    const outcomes = result.irOutcomes ?? [];
    const histogram = {};
    for (const outcome of outcomes) {
      const key = outcome.kind === "emitted" ? "emitted" : `${outcome.kind}:${outcome.stage}:${outcome.code}`;
      histogram[key] = (histogram[key] ?? 0) + 1;
    }
    console.log(
      "[npm-compat] standalone IR outcomes",
      JSON.stringify(
        {
          histogram,
          outcomes: outcomes.map((outcome) => ({
            file: outcome.file,
            name: outcome.displayName,
            unitKind: outcome.unitKind,
            line: outcome.line,
            column: outcome.column,
            kind: outcome.kind,
            stage: outcome.stage,
            ...(outcome.kind === "emitted"
              ? {}
              : {
                  code: outcome.code,
                  detail: outcome.detail,
                }),
            legacyBodyEmitted: outcome.legacyBodyEmitted,
            irBodyEmitted: outcome.irBodyEmitted,
          })),
        },
        null,
        2,
      ),
    );
  }
  if (inspectBinaryPath) {
    writeFileSync(inspectBinaryPath, result.binary);
    console.log(`[npm-compat] wrote standalone binary to ${inspectBinaryPath}`);
  }

  let module;
  const moduleCompileStarted = performance.now();
  let moduleCompileDurationMs;
  try {
    module = await WebAssembly.compile(result.binary);
    moduleCompileDurationMs = performance.now() - moduleCompileStarted;
  } catch (error) {
    return failStandalone("validation-error", error instanceof Error ? error.message : String(error), {
      compileDurationMs,
      binaryBytes: result.binary.length,
    });
  }
  const moduleImports = WebAssembly.Module.imports(module).map(
    ({ module: namespace, name, kind }) => `${namespace}.${name}:${kind}`,
  );
  if (moduleImports.length > 0) {
    return failStandalone("host-import-error", `standalone binary retained ${moduleImports.length} host import(s)`, {
      compileDurationMs,
      binaryBytes: result.binary.length,
      ...moduleImportMetadata(moduleImports),
    });
  }

  let instance;
  const instantiateStarted = performance.now();
  let instantiateDurationMs;
  let moduleInitDurationMs;
  try {
    instance = await WebAssembly.instantiate(module, {});
    instantiateDurationMs = performance.now() - instantiateStarted;
    const moduleInit = instance.exports.__module_init;
    if (typeof moduleInit === "function") {
      const moduleInitStarted = performance.now();
      moduleInit();
      moduleInitDurationMs = performance.now() - moduleInitStarted;
    }
  } catch (error) {
    return failStandalone("runtime-error", renderHarnessThrownText(error, instance), {
      phase: instance ? "module-init" : "instantiate",
      compileDurationMs,
      binaryBytes: result.binary.length,
      ...moduleImportMetadata(moduleImports),
    });
  }
  const wasmBatch = instance.exports[STANDALONE_BENCHMARK_EXPORT];
  if (typeof wasmBatch !== "function") {
    return failStandalone("runtime-error", `missing ${STANDALONE_BENCHMARK_EXPORT} export`, {
      phase: "resolve-export",
      compileDurationMs,
      binaryBytes: result.binary.length,
      ...moduleImportMetadata(moduleImports),
    });
  }

  const invokeWasmBatch = (iterations) =>
    runtimeArgument === undefined ? wasmBatch(iterations) : wasmBatch(iterations, runtimeArgument);
  const nodeBatch = (iterations) => {
    let checksum = 0;
    for (let index = 0; index < iterations; index++) checksum += nodeOperation(runtimeArgument, index);
    return checksum;
  };

  let expectedChecksum;
  let actualChecksum;
  let firstBatchDurationMs;
  try {
    expectedChecksum = nodeBatch(1);
    const firstBatchStarted = performance.now();
    actualChecksum = invokeWasmBatch(1);
    firstBatchDurationMs = performance.now() - firstBatchStarted;
  } catch (error) {
    if (inspectRuntimeErrors) {
      console.error("[npm-compat] standalone checksum error", error);
    }
    return failStandalone("runtime-error", renderHarnessThrownText(error, instance), {
      phase: "checksum",
      compileDurationMs,
      moduleCompileDurationMs,
      instantiateDurationMs,
      moduleInitDurationMs,
      firstBatchDurationMs,
      binaryBytes: result.binary.length,
      ...moduleImportMetadata(moduleImports),
    });
  }
  if (!Object.is(actualChecksum, expectedChecksum)) {
    return failStandalone(
      "result-mismatch",
      `checksum mismatch: Wasm ${String(actualChecksum)}, Node ${String(expectedChecksum)}`,
      {
        phase: "checksum",
        compileDurationMs,
        moduleCompileDurationMs,
        instantiateDurationMs,
        moduleInitDurationMs,
        firstBatchDurationMs,
        binaryBytes: result.binary.length,
        ...moduleImportMetadata(moduleImports),
        expectedChecksum,
        actualChecksum,
      },
    );
  }

  try {
    if (profileRuntime === "wasm") await captureRuntimeProfile(() => invokeWasmBatch(1));
    if (profileRuntime === "node") await captureRuntimeProfile(() => nodeBatch(1));
    return {
      ...measureStandalonePerf(sampleOp, invokeWasmBatch, nodeBatch, { inputMode }),
      compileDurationMs,
      moduleCompileDurationMs,
      instantiateDurationMs,
      moduleInitDurationMs,
      firstBatchDurationMs,
      binaryBytes: result.binary.length,
      ...moduleImportMetadata(moduleImports),
      expectedChecksum,
      actualChecksum,
      testCompiledToWasm: true,
      benchmarkUsesIr: result.irCompiledFuncs?.includes(STANDALONE_BENCHMARK_EXPORT) ?? false,
      irCompiledFunctions: result.irCompiledFuncs ?? [],
      target: "standalone",
      ...(runtimeArgument === undefined ? {} : { runtimeArgumentSuppliedAfterCompile: true }),
      ...(staticEvaluation ? { staticEvaluation } : {}),
    };
  } catch (error) {
    return failStandalone("runtime-error", renderHarnessThrownText(error, instance), {
      phase: "measure",
      compileDurationMs,
      moduleCompileDurationMs,
      instantiateDurationMs,
      firstBatchDurationMs,
      binaryBytes: result.binary.length,
      ...moduleImportMetadata(moduleImports),
      expectedChecksum,
      actualChecksum,
    });
  }
}

// ---------------------------------------------------------------------------
// Per-package perf probes — each returns a `measurePerf(...)` result or null
// if the package doesn't validate/run (perf is meaningless on a red surface).
// ---------------------------------------------------------------------------
async function perfAcornJsHost() {
  const { entryModulePath } = setupAcorn();
  const source = readFileSync(entryModulePath, "utf-8");
  const resultFloorExport = "__npmCompatParseBodyLength";
  const compileSourceText = inspectResultFloor
    ? `${source}
export function ${resultFloorExport}(input, options) {
  return parse(input, options).body.length;
}`
    : source;
  // optimize: 4 — perf numbers must reflect a realistic (wasm-opt'd) deployment,
  // not the debug-friendly unoptimized binary the correctness harnesses use.
  const compileStart = performance.now();
  const result = await compile(compileSourceText, {
    fileName: "acorn.mjs",
    skipSemanticDiagnostics: true,
    optimize: 4,
    ...(inspectWatFunctions?.length
      ? {
          emitWat: true,
          emitWatOnlyFunctions: inspectWatFunctions,
        }
      : {}),
  });
  const compileDurationMs = performance.now() - compileStart;
  if (!result.success || !result.binary?.length) return null;
  if (inspectWatFunctions?.length) {
    console.log(`[npm-compat] acorn WAT (${inspectWatFunctions.join(", ")})\n${result.wat ?? "(unavailable)"}`);
  }
  const importObject = result.importObject ?? {};
  const parseOptions = { ecmaVersion: 2022, sourceType: "module" };
  const wasmCompileStart = performance.now();
  const compiledModule = await WebAssembly.compile(result.binary);
  const wasmCompileMs = performance.now() - wasmCompileStart;
  const moduleImports = WebAssembly.Module.imports(compiledModule).map(
    ({ module, name, kind }) => `${module}.${name}:${kind}`,
  );
  const instantiateStart = performance.now();
  const instance = await WebAssembly.instantiate(compiledModule, importObject);
  const instantiateMs = performance.now() - instantiateStart;
  const wireStart = performance.now();
  importObject.__setExports?.(instance.exports);
  const wireMs = performance.now() - wireStart;
  const wrapStart = performance.now();
  const exp = wrapExports(instance.exports, {
    signatures: result.exportSignatures,
  });
  const wrapMs = performance.now() - wrapStart;
  const compiledOperation = inspectResultFloor
    ? (input, options) => exp[resultFloorExport](input, options)
    : (input, options) => exp.parse(input, options);
  if (
    (inspectResultFloor && typeof exp[resultFloorExport] !== "function") ||
    (!inspectResultFloor && typeof exp.parse !== "function")
  ) {
    return null;
  }
  let boundaryCensus;
  if (inspectBoundaries) {
    compiledOperation(source, parseOptions);
    const { importCalls, callbackCalls, stop } = instrumentImports(importObject, { callbacks: false });
    compiledOperation(source, parseOptions);
    stop();
    const identicalInput = {
      wrapperCalls: 1,
      jsToWasmExportCalls: 1,
      wasmToHostCalls: [...importCalls.values()].reduce((sum, count) => sum + count, 0),
      hostToWasmCallbacks: [...callbackCalls.values()].reduce((sum, count) => sum + count, 0),
      imports: Object.fromEntries([...importCalls].sort(([a], [b]) => a.localeCompare(b))),
      callbacks: Object.fromEntries([...callbackCalls].sort(([a], [b]) => a.localeCompare(b))),
    };
    const changedSourceProbe = instrumentImports(importObject, { callbacks: false });
    let changedSourceError;
    try {
      compiledOperation(`${source}\n`, parseOptions);
    } catch (error) {
      changedSourceError = error instanceof Error ? error.message : String(error);
    }
    changedSourceProbe.stop();
    const changedSourceCall = {
      wrapperCalls: 1,
      jsToWasmExportCalls: 1,
      wasmToHostCalls: [...changedSourceProbe.importCalls.values()].reduce((sum, count) => sum + count, 0),
      hostToWasmCallbacks: null,
      imports: Object.fromEntries([...changedSourceProbe.importCalls].sort(([a], [b]) => a.localeCompare(b))),
      callbacks: "not instrumented: wrapping Acorn callback exports changes its closure ABI",
      ...(changedSourceError ? { error: changedSourceError } : {}),
    };
    boundaryCensus = {
      changedSourceCall,
      identicalInput,
    };
    console.log("[npm-compat] Acorn boundary census", JSON.stringify(boundaryCensus));
  }

  const oracleMod = await import(pathToFileURL(entryModulePath).href);
  // Self-hosting sample: parse acorn's own ~6,300-line dist bundle — a real,
  // deterministic, decently-sized workload rather than a synthetic snippet.
  if (diagnosticsOnly) {
    const firstStart = performance.now();
    const ast = compiledOperation(source, parseOptions);
    const firstCallMs = performance.now() - firstStart;
    const secondStart = performance.now();
    const secondAst = compiledOperation(source, parseOptions);
    const secondCallMs = performance.now() - secondStart;
    return {
      sampleOp: `parse(own ${Math.round(source.length / 1024)}KB dist bundle)`,
      firstCallMs,
      secondCallMs,
      freshResultIdentity: inspectResultFloor ? null : secondAst !== ast,
      resultObservation: inspectResultFloor ? "inside-wasm-number" : "js-host-full-ast",
      compileDurationMs,
      wasmCompileMs,
      instantiateMs,
      wireMs,
      wrapMs,
      binaryBytes: result.binary.length,
      ...moduleImportMetadata(moduleImports),
    };
  }
  const sampleOp = `parse(own ${Math.round(source.length / 1024)}KB dist bundle).body.length`;
  const expectedChecksum = oracleMod.parse(source, parseOptions).body.length;
  const actualChecksum = inspectResultFloor
    ? compiledOperation(source, parseOptions)
    : compiledOperation(source, parseOptions).body.length;
  if (actualChecksum !== expectedChecksum) {
    return failedPerfLane(
      "js-host",
      "result-mismatch",
      `Acorn checksum mismatch: ${actualChecksum} !== ${expectedChecksum}`,
      { expectedChecksum, actualChecksum },
    );
  }
  return {
    ...measureJsHostPerf(
      sampleOp,
      () =>
        inspectResultFloor
          ? compiledOperation(source, parseOptions)
          : compiledOperation(source, parseOptions).body.length,
      () => oracleMod.parse(source, parseOptions).body.length,
    ),
    compileDurationMs,
    wasmCompileMs,
    instantiateMs,
    wireMs,
    wrapMs,
    binaryBytes: result.binary.length,
    ...moduleImportMetadata(moduleImports),
    expectedChecksum,
    actualChecksum,
    testCompiledToWasm: false,
    target: "js-host",
    resultObservation: inspectResultFloor ? "inside-wasm-number" : "js-host-full-ast",
    ...(boundaryCensus ? { boundaryCensus } : {}),
  };
}

async function perfAcornStandalone() {
  const { entryModulePath } = setupAcorn();
  const source = readFileSync(entryModulePath, "utf-8");
  const oracleMod = await import(pathToFileURL(entryModulePath).href);
  const parseOptions = { ecmaVersion: 2022, sourceType: "module" };
  const sampleOp = `parse(own ${Math.round(source.length / 1024)}KB dist bundle).body.length`;
  const driver = `${linkedStandalone ? 'import { parse } from "./acorn.mjs";' : ""}
var __npmCompatChunks = ${chunkedStringArray(source)};
var __npmCompatInput = "";
for (var __npmCompatChunkIndex = 0; __npmCompatChunkIndex < __npmCompatChunks.length; __npmCompatChunkIndex++) {
  __npmCompatInput += __npmCompatChunks[__npmCompatChunkIndex];
}
var __npmCompatOptions = { ecmaVersion: 2022, sourceType: "module" };

/** @returns {number} */
export function ${STANDALONE_STATIC_OPERATION_EXPORT}() {
  return parse(__npmCompatInput, __npmCompatOptions).body.length;
}

/** @param {number} iterations */
export function ${STANDALONE_BENCHMARK_EXPORT}(iterations) {
  var checksum = 0;
  for (var index = 0; index < iterations; index++) {
    checksum += ${STANDALONE_STATIC_OPERATION_EXPORT}();
  }
  return checksum;
}`;
  return compileStandaloneLane({
    source,
    driver,
    packageFileName: "acorn.mjs",
    sampleOp,
    nodeOperation: () => oracleMod.parse(source, parseOptions).body.length,
    inlineDriver: !linkedStandalone,
    staticOperationExport: STANDALONE_STATIC_OPERATION_EXPORT,
  });
}

async function perfAcornStandaloneDynamic() {
  const { entryModulePath } = setupAcorn();
  const source = readFileSync(entryModulePath, "utf-8");
  const oracleMod = await import(pathToFileURL(entryModulePath).href);
  const parseOptions = { ecmaVersion: 2022, sourceType: "module" };
  const sampleOp = `parse(runtime-suffixed own ${Math.round(source.length / 1024)}KB dist bundle).body.length`;
  const driver = `${linkedStandalone ? 'import { parse } from "./acorn.mjs";' : ""}
var __npmCompatChunks = ${chunkedStringArray(source)};
var __npmCompatInput = "";
for (var __npmCompatChunkIndex = 0; __npmCompatChunkIndex < __npmCompatChunks.length; __npmCompatChunkIndex++) {
  __npmCompatInput += __npmCompatChunks[__npmCompatChunkIndex];
}
var __npmCompatOptions = { ecmaVersion: 2022, sourceType: "module" };

/**
 * @param {number} iterations
 * @param {number} runtimeSeed
 */
export function ${STANDALONE_BENCHMARK_EXPORT}(iterations, runtimeSeed) {
  var checksum = 0;
  for (var index = 0; index < iterations; index++) {
    var runtimeInput = __npmCompatInput + "\\n/* npm-compat-runtime:" + runtimeSeed + ":" + index + " */";
    checksum += parse(runtimeInput, __npmCompatOptions).body.length;
  }
  return checksum;
}`;
  return compileStandaloneLane({
    source,
    driver,
    packageFileName: "acorn.mjs",
    sampleOp,
    nodeOperation: (runtimeSeed, index) =>
      oracleMod.parse(`${source}\n/* npm-compat-runtime:${runtimeSeed}:${index} */`, parseOptions).body.length,
    inlineDriver: !linkedStandalone,
    inputMode: "runtime-dynamic",
    // The numeric seed enters only when the already-compiled Wasm export is
    // invoked. It makes the parsed string depend on a post-compile value while
    // keeping the complete test loop and result observation inside Wasm.
    runtimeArgument: 3780,
  });
}

async function perfAcorn() {
  const jsHost = runJsHostLane ? await perfAcornJsHost() : skippedPerfLane("js-host");
  if (diagnosticsOnly) return jsHost;
  const standalone = runStandaloneLane ? await perfAcornStandalone() : skippedPerfLane("standalone");
  const standaloneDynamic = runStandaloneDynamicLane
    ? await perfAcornStandaloneDynamic()
    : skippedPerfLane("standalone", "runtime-dynamic");
  return packagePerfRecord(
    jsHost?.sampleOp ?? standalone?.sampleOp ?? "parse(own dist bundle).body.length",
    jsHost ?? failedPerfLane("js-host", "compile-error", "host compilation failed"),
    standalone,
    { standaloneDynamic },
  );
}

async function perfClsxJsHost() {
  const { entryModulePath } = setupClsx();
  const clsxSource = readFileSync(entryModulePath, "utf-8");
  // Reuse one already-verified-equal op (see clsx-harness.mjs) as the
  // representative perf workload — comparing timings on an op we've already
  // confirmed produces IDENTICAL output keeps the comparison meaningful.
  const op = CLSX_OPS.find((candidate) => candidate.name === CLSX_PERF_OP_NAME);
  const epilogue = `
export function ${op.name}(first, second) {
  return clsx(first, second);
}`;
  const result = await compile(clsxSource + "\n" + epilogue, {
    fileName: "clsx.mjs",
    skipSemanticDiagnostics: true,
    optimize: 4,
    ...(inspectWatFunctions?.length
      ? {
          emitWat: true,
          emitWatOnlyFunctions: inspectWatFunctions,
        }
      : {}),
  });
  if (!result.success || !result.binary?.length) return null;
  if (inspectWatFunctions?.length) {
    console.log(`[npm-compat] clsx WAT (${inspectWatFunctions.join(", ")})\n${result.wat ?? "(unavailable)"}`);
  }
  const importObject = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  const exp = wrapExports(instance.exports, { signatures: result.exportSignatures });
  if (typeof exp[op.name] !== "function") return null;

  const cjsEntryPath = entryModulePath.replace(/\/clsx\.mjs$/, "/clsx.js");
  const { createRequire } = await import("node:module");
  const nativeClsx = createRequire(import.meta.url)(cjsEntryPath).clsx;
  const hostArguments = ["foo", "bar"];
  const expected = nativeClsx(...hostArguments);
  const actual = exp[op.name](...hostArguments);
  if (actual !== expected) {
    return failedPerfLane("js-host", "result-mismatch", `clsx result mismatch: ${String(actual)} !== ${expected}`);
  }
  const sampleOp = `${op.name}.length (host-owned arguments)`;
  const moduleImports = WebAssembly.Module.imports(await WebAssembly.compile(result.binary)).map(
    ({ module, name, kind }) => `${module}.${name}:${kind}`,
  );

  const measured = {
    ...measureJsHostPerf(
      sampleOp,
      () => exp[op.name](...hostArguments).length,
      () => nativeClsx(...hostArguments).length,
    ),
    binaryBytes: result.binary.length,
    ...moduleImportMetadata(moduleImports),
    expectedChecksum: expected.length,
    actualChecksum: actual.length,
    testCompiledToWasm: false,
    target: "js-host",
  };
  if (!inspectConstantFloor) return measured;

  const floorResult = await compile(`export function ${op.name}() { return ${JSON.stringify(expected)}; }`, {
    fileName: "clsx-constant-floor.mjs",
    skipSemanticDiagnostics: true,
    optimize: 4,
  });
  if (!floorResult.success || !floorResult.binary?.length) return measured;
  const floorImports = {
    env: {},
    "wasm:js-string": jsString,
    string_constants: buildStringConstants(floorResult.stringPool),
    string_constants16: buildStringConstants16(floorResult.stringPool),
  };
  const { instance: floorInstance } = await WebAssembly.instantiate(floorResult.binary, floorImports);
  floorImports.__setExports?.(floorInstance.exports);
  const floorExports = wrapExports(floorInstance.exports, { signatures: floorResult.exportSignatures });
  const constantFloor = measureJsHostPerf(
    `${op.name}_constant_floor`,
    () => floorExports[op.name]().length,
    () => nativeClsx(...hostArguments).length,
  );
  return {
    ...measured,
    constantFloor: {
      ...constantFloor,
      binaryBytes: floorResult.binary.length,
    },
  };
}

async function perfClsxStandalone() {
  const { entryModulePath } = setupClsx();
  const source = readFileSync(entryModulePath, "utf-8");
  const op = CLSX_OPS.find((candidate) => candidate.name === CLSX_PERF_OP_NAME);
  const expression = op.code.replace(/^return\s+/, "").replace(/;\s*$/, "");
  const cjsEntryPath = entryModulePath.replace(/\/clsx\.mjs$/, "/clsx.js");
  const { createRequire } = await import("node:module");
  const nativeClsx = createRequire(import.meta.url)(cjsEntryPath).clsx;
  const nodeFn = new Function("clsx", op.code);
  const sampleOp = `${op.name}.length (driver compiled to Wasm)`;
  const driver = `
import { clsx } from "./clsx.mjs";

/** @param {number} iterations */
export function ${STANDALONE_BENCHMARK_EXPORT}(iterations) {
  var checksum = 0;
  for (var index = 0; index < iterations; index++) {
    checksum += (${expression}).length;
  }
  return checksum;
}`;
  return compileStandaloneLane({
    source,
    driver,
    packageFileName: "clsx.mjs",
    sampleOp,
    nodeOperation: () => nodeFn(nativeClsx).length,
  });
}

async function perfClsxStandaloneDynamic() {
  const { entryModulePath } = setupClsx();
  const source = readFileSync(entryModulePath, "utf-8");
  const cjsEntryPath = entryModulePath.replace(/\/clsx\.mjs$/, "/clsx.js");
  const { createRequire } = await import("node:module");
  const nativeClsx = createRequire(import.meta.url)(cjsEntryPath).clsx;
  const sampleOp = `${CLSX_PERF_OP_NAME}.length (runtime-generated arguments; driver compiled to Wasm)`;
  const driver = `
import { clsx } from "./clsx.mjs";

/**
 * @param {number} iterations
 * @param {number} runtimeSeed
 */
export function ${STANDALONE_BENCHMARK_EXPORT}(iterations, runtimeSeed) {
  var checksum = 0;
  for (var index = 0; index < iterations; index++) {
    var first = "foo-" + runtimeSeed + "-" + index;
    checksum += clsx(first, "bar").length;
  }
  return checksum;
}`;
  return compileStandaloneLane({
    source,
    driver,
    packageFileName: "clsx.mjs",
    sampleOp,
    nodeOperation: (runtimeSeed, index) => nativeClsx(`foo-${runtimeSeed}-${index}`, "bar").length,
    inputMode: "runtime-dynamic",
    runtimeArgument: 3748,
  });
}

async function perfClsx() {
  const jsHost = runJsHostLane ? await perfClsxJsHost() : skippedPerfLane("js-host");
  const standalone = runStandaloneLane ? await perfClsxStandalone() : skippedPerfLane("standalone");
  const standaloneDynamic = runStandaloneDynamicLane
    ? await perfClsxStandaloneDynamic()
    : skippedPerfLane("standalone", "runtime-dynamic");
  return packagePerfRecord(
    jsHost?.sampleOp ?? standalone?.sampleOp ?? standaloneDynamic?.sampleOp ?? `${CLSX_PERF_OP_NAME}.length`,
    jsHost ?? failedPerfLane("js-host", "compile-error", "host compilation failed"),
    standalone,
    { standaloneDynamic },
  );
}

async function perfCookieJsHost() {
  const { entryModulePath } = setupCookie();
  const cookieSource = readFileSync(entryModulePath, "utf-8");
  const result = await compile(cookieSource, {
    fileName: "index.js",
    skipSemanticDiagnostics: true,
    optimize: 4,
    ...(inspectWatFunctions?.length
      ? {
          emitWat: true,
          emitWatOnlyFunctions: inspectWatFunctions,
        }
      : {}),
  });
  if (!result.success || !result.binary?.length) return null;
  if (inspectWatFunctions?.length) {
    console.log(`[npm-compat] cookie WAT (${inspectWatFunctions.join(", ")})\n${result.wat ?? "(unavailable)"}`);
  }
  const importObject = result.importObject ?? {};
  // A heavier, realistic multi-attribute Cookie header (8 pairs) rather than
  // the harness's minimal correctness fixtures.
  const header = "a=1; b=2; c=3; d=4; e=5; f=6; g=7; h=8";
  let boundaryCensus;
  if (inspectBoundaries) {
    const { instrumented, importCalls, callbackCalls } = instrumentImports(importObject);
    const { instance: probeInstance } = await WebAssembly.instantiate(result.binary, instrumented);
    instrumented.__setExports?.(probeInstance.exports);
    const probeExports = wrapExports(probeInstance.exports, {
      signatures: result.exportSignatures,
    });
    const snapshot = (jsToWasmExportCalls) => ({
      wrapperCalls: 1,
      jsToWasmExportCalls,
      wasmToHostCalls: [...importCalls.values()].reduce((sum, count) => sum + count, 0),
      hostToWasmCallbacks: [...callbackCalls.values()].reduce((sum, count) => sum + count, 0),
      imports: Object.fromEntries([...importCalls].sort(([a], [b]) => a.localeCompare(b))),
      callbacks: Object.fromEntries([...callbackCalls].sort(([a], [b]) => a.localeCompare(b))),
    });
    importCalls.clear();
    callbackCalls.clear();
    probeExports.parseCookie(header);
    boundaryCensus = {
      firstCall: snapshot(1),
      identicalInput: null,
    };
    importCalls.clear();
    callbackCalls.clear();
    probeExports.parseCookie(header);
    boundaryCensus.identicalInput = snapshot(1);
  }
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  const exp = wrapExports(instance.exports, {
    signatures: result.exportSignatures,
  });
  if (typeof exp.parseCookie !== "function") return null;

  const nativeModule = await import(pathToFileURL(entryModulePath).href);
  const observe = (parsed) => (parsed.a === "1" && parsed.h === "8" ? 1 : 0);
  const expectedChecksum = observe(nativeModule.parseCookie(header));
  const actualChecksum = observe(exp.parseCookie(header));
  if (actualChecksum !== expectedChecksum) {
    return failedPerfLane(
      "js-host",
      "result-mismatch",
      `cookie checksum mismatch: ${actualChecksum} !== ${expectedChecksum}`,
    );
  }
  const sampleOp = "parseCookie(8-pair header); verify a/h";
  const moduleImports = WebAssembly.Module.imports(await WebAssembly.compile(result.binary)).map(
    ({ module, name, kind }) => `${module}.${name}:${kind}`,
  );
  return {
    ...measureJsHostPerf(
      sampleOp,
      () => observe(exp.parseCookie(header)),
      () => observe(nativeModule.parseCookie(header)),
    ),
    binaryBytes: result.binary.length,
    ...moduleImportMetadata(moduleImports),
    expectedChecksum,
    actualChecksum,
    testCompiledToWasm: false,
    target: "js-host",
    ...(boundaryCensus ? { boundaryCensus } : {}),
  };
}

async function perfCookieStandalone() {
  const { entryModulePath } = setupCookie();
  const source = readFileSync(entryModulePath, "utf-8");
  const nativeModule = await import(pathToFileURL(entryModulePath).href);
  const header = "a=1; b=2; c=3; d=4; e=5; f=6; g=7; h=8";
  const sampleOp = "parseCookie(8-pair header); verify a/h";
  const driver = `
import { parseCookie } from "./cookie.js";

function cookieOperation() {
  var parsed = parseCookie(${JSON.stringify(header)});
  return parsed.a === "1" && parsed.h === "8" ? 1 : 0;
}

/** @param {number} iterations */
export function ${STANDALONE_BENCHMARK_EXPORT}(iterations) {
  var checksum = 0;
  for (var index = 0; index < iterations; index++) {
    checksum += cookieOperation();
  }
  return checksum;
}`;
  return compileStandaloneLane({
    source,
    driver,
    packageFileName: "cookie.js",
    sampleOp,
    nodeOperation: () => {
      const parsed = nativeModule.parseCookie(header);
      return parsed.a === "1" && parsed.h === "8" ? 1 : 0;
    },
  });
}

async function perfCookieStandaloneDynamic() {
  const { entryModulePath } = setupCookie();
  const source = readFileSync(entryModulePath, "utf-8");
  const nativeModule = await import(pathToFileURL(entryModulePath).href);
  const sampleOp = "parseCookie(8-pair runtime-generated header); verify a/h";
  const driver = `
import { parseCookie } from "./cookie.js";

/**
 * @param {number} iterations
 * @param {number} runtimeSeed
 */
export function ${STANDALONE_BENCHMARK_EXPORT}(iterations, runtimeSeed) {
  var checksum = 0;
  for (var index = 0; index < iterations; index++) {
    var first = "" + (runtimeSeed + index);
    var header = "a=" + first + "; b=2; c=3; d=4; e=5; f=6; g=7; h=8";
    var parsed = parseCookie(header);
    checksum += parsed.a === first && parsed.h === "8" ? 1 : 0;
  }
  return checksum;
}`;
  return compileStandaloneLane({
    source,
    driver,
    packageFileName: "cookie.js",
    sampleOp,
    nodeOperation: (runtimeSeed, index) => {
      const first = String(runtimeSeed + index);
      const parsed = nativeModule.parseCookie(`a=${first}; b=2; c=3; d=4; e=5; f=6; g=7; h=8`);
      return parsed.a === first && parsed.h === "8" ? 1 : 0;
    },
    inputMode: "runtime-dynamic",
    runtimeArgument: 3751,
  });
}

async function perfCookie() {
  const jsHost = runJsHostLane ? await perfCookieJsHost() : skippedPerfLane("js-host");
  const standalone = runStandaloneLane ? await perfCookieStandalone() : skippedPerfLane("standalone");
  const standaloneDynamic = runStandaloneDynamicLane
    ? await perfCookieStandaloneDynamic()
    : skippedPerfLane("standalone", "runtime-dynamic");
  return packagePerfRecord(
    jsHost?.sampleOp ?? standalone?.sampleOp ?? standaloneDynamic?.sampleOp ?? "parseCookie(8-pair header); verify a/h",
    jsHost ?? failedPerfLane("js-host", "compile-error", "host compilation failed"),
    standalone,
    { standaloneDynamic },
  );
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------
function knownBugsFor(name) {
  const map = {
    acorn: [
      {
        issue: 3780,
        summary:
          "runtime-dynamic Acorn remains slower than native Node; only the separately reported compile-time-static lane folds to IR",
      },
      {
        issue: 3782,
        summary: "linked Acorn initialization is lowered, but the cross-module parser driver is not yet runnable",
      },
    ],
    marked: [{ issue: 3715, summary: "TS 'evolving array type' inference unimplemented — blocks compile entirely" }],
    clsx: [{ issue: 3749, summary: "for...in over an array of heterogeneously-shaped object literals derefs null" }],
    cookie: [
      {
        issue: 3750,
        summary: "a property assigned dynamically inside a loop/switch onto an object is silently dropped",
      },
    ],
    eslint: [
      {
        issue: 3672,
        summary:
          "the real multi-file Linter graph is still beyond the bounded mainline compile/runtime integration frontier",
      },
    ],
  };
  return map[name] ?? [];
}

async function buildPackageEntry({ name, version, issue, entryFile, shape, report, tests, perf }) {
  return {
    name,
    version,
    issue,
    entryFile,
    shape,
    compile: report.compile,
    validation: report.validation,
    tests,
    perf,
    knownBugs: knownBugsFor(name),
  };
}

const packages = [];

if (selectedPackages.has("acorn")) {
  if (perfOnly) {
    console.log("[npm-compat] acorn — perf only (correctness and official suite skipped)...");
    const { version, pin } = setupAcorn();
    packages.push({
      name: "acorn",
      version,
      issue: 1710,
      entryFile: pin.entryModule.replace(/^package\//, ""),
      shape: "esm-direct",
      perf: await perfAcorn(),
      knownBugs: knownBugsFor("acorn"),
    });
  } else {
    console.log("[npm-compat] acorn — compile/validate/diff + official test suite (this takes ~1 min)...");
    const acornReport = await runAcorn({ quiet: true });
    const acornSuite = await runAcornOfficialSuite({ quiet: true });
    const acornPerf = await perfAcorn();
    packages.push(
      await buildPackageEntry({
        name: "acorn",
        version: acornReport.acorn.version,
        issue: 1710,
        entryFile: acornReport.acorn.entryModule.replace(/^package\//, ""),
        shape: "esm-direct",
        report: acornReport,
        tests: {
          kind: "official-suite",
          passed: acornSuite.results?.passed ?? null,
          total: acornSuite.results?.total ?? null,
          passRatePct: acornSuite.summary?.passRatePct ?? null,
          sourceIssue: 3729,
        },
        perf: acornPerf,
      }),
    );
  }
}

if (selectedPackages.has("marked")) {
  console.log("[npm-compat] marked — compile/validate/diff...");
  const markedReport = await runMarked({ quiet: true });
  packages.push(
    await buildPackageEntry({
      name: "marked",
      version: markedReport.marked.version,
      issue: 3716,
      entryFile: markedReport.marked.entryModule.replace(/^package\//, ""),
      shape: "esm-direct",
      report: markedReport,
      tests: null,
      perf: null,
    }),
  );
}

if (selectedPackages.has("clsx")) {
  if (perfOnly) {
    console.log("[npm-compat] clsx — perf only (correctness harness skipped)...");
    const { version, pin } = setupClsx();
    packages.push({
      name: "clsx",
      version,
      issue: 3748,
      entryFile: pin.entryModule.replace(/^package\//, ""),
      shape: "esm-driver-epilogue",
      perf: await perfClsx(),
      knownBugs: knownBugsFor("clsx"),
    });
  } else {
    console.log("[npm-compat] clsx — compile/validate/diff + perf...");
    const clsxReport = await runClsx({ quiet: true });
    const clsxPerf = await perfClsx();
    packages.push(
      await buildPackageEntry({
        name: "clsx",
        version: clsxReport.clsx.version,
        issue: 3748,
        entryFile: clsxReport.clsx.entryModule.replace(/^package\//, ""),
        shape: "esm-driver-epilogue",
        report: clsxReport,
        tests: {
          kind: "differential-ops",
          passed: clsxReport.summary.opDiff?.equal ?? null,
          total: clsxReport.summary.opDiff?.total ?? null,
          sourceIssue: 3748,
        },
        perf: clsxPerf,
      }),
    );
  }
}

if (selectedPackages.has("cookie")) {
  if (perfOnly) {
    console.log("[npm-compat] cookie — perf only (correctness harness skipped)...");
    const { version, pin } = setupCookie();
    packages.push({
      name: "cookie",
      version,
      issue: 3751,
      entryFile: pin.entryModule.replace(/^package\//, ""),
      shape: "esm-direct",
      perf: await perfCookie(),
      knownBugs: knownBugsFor("cookie"),
    });
  } else {
    console.log("[npm-compat] cookie — compile/validate/diff + perf...");
    const cookieReport = await runCookie({ quiet: true });
    const cookiePerf = await perfCookie();
    packages.push(
      await buildPackageEntry({
        name: "cookie",
        version: cookieReport.cookie.version,
        issue: 3751,
        entryFile: cookieReport.cookie.entryModule.replace(/^package\//, ""),
        shape: "esm-direct",
        report: cookieReport,
        tests: {
          kind: "differential-ops",
          passed: cookieReport.summary.opDiff?.equal ?? null,
          total: cookieReport.summary.opDiff?.total ?? null,
          sourceIssue: 3751,
        },
        perf: cookiePerf,
      }),
    );
  }
}

if (selectedPackages.has("eslint")) {
  console.log("[npm-compat] eslint — bounded package-entry compile/validate...");
  const eslintReport = await runEslint({ quiet: true });
  packages.push(
    await buildPackageEntry({
      name: "eslint",
      version: eslintReport.eslint.version,
      issue: 1400,
      entryFile: eslintReport.eslint.entryModule.replace(/^package\//, ""),
      shape: "cjs-project",
      report: eslintReport,
      tests: null,
      perf: null,
    }),
  );
}

if (selectedPackages.has("prettier")) {
  console.log("[npm-compat] prettier — bounded package-entry compile/validate...");
  const prettierReport = await runPrettier({ quiet: true });
  packages.push(
    await buildPackageEntry({
      name: "prettier",
      version: prettierReport.prettier.version,
      issue: null,
      entryFile: prettierReport.prettier.entryModule.replace(/^package\//, ""),
      shape: "esm-project",
      report: prettierReport,
      tests: null,
      perf: null,
    }),
  );
}

if (selectedPackages.has("react")) {
  console.log("[npm-compat] react — bounded package-entry compile/validate...");
  const reactReport = await runReact({ quiet: true });
  packages.push(
    await buildPackageEntry({
      name: "react",
      version: reactReport.react.version,
      issue: null,
      entryFile: reactReport.react.entryModule.replace(/^package\//, ""),
      shape: "cjs-project",
      report: reactReport,
      tests: null,
      perf: null,
    }),
  );
}

const summary = {
  generatedAt: new Date().toISOString(),
  note: "Only packages with a committed, reproducible tests/dogfood/*-harness.mjs are listed. mustache (#3720), diff (#3721), and dayjs (#3747) were probed ad-hoc and surfaced real bugs but have no committed harness yet.",
  performanceMethodology: {
    baseline: "same pinned package, inputs, and result observation in native Node",
    inputModes: {
      "compile-time-static": "package, test driver, and fixed inputs are visible to the Wasm compiler",
      "runtime-dynamic":
        "an input or input-selecting value is supplied by the JavaScript host only after Wasm compilation",
    },
  },
  packages,
};

// Successful placements become separate chart rows. Failed or deliberately
// skipped placements remain visible in the package JSON/cards and are never
// converted to misleading zero-duration bars.
const perfRows = npmPerfRows(packages);
const perfHistory = mergeNpmPerfHistory(readHistoryArtifact(), [
  ...committedHistoryPoints(),
  npmPerfHistoryPoint(packages, summary.generatedAt, currentRevision()),
]);

if (writeArtifacts) {
  mkdirSync(dirname(RESULTS_PATH), { recursive: true });
  writeFileSync(RESULTS_PATH, JSON.stringify(summary, null, 2) + "\n");
  mkdirSync(dirname(PUBLIC_PATH), { recursive: true });
  copyFileSync(RESULTS_PATH, PUBLIC_PATH);
  console.log(`[npm-compat] wrote ${RESULTS_PATH}`);
  console.log(`[npm-compat] wrote ${PUBLIC_PATH}`);
  writeFileSync(PERF_RESULTS_PATH, JSON.stringify(perfRows, null, 2) + "\n");
  copyFileSync(PERF_RESULTS_PATH, PERF_PUBLIC_PATH);
  console.log(`[npm-compat] wrote ${PERF_RESULTS_PATH}`);
  console.log(`[npm-compat] wrote ${PERF_PUBLIC_PATH}`);
  writeFileSync(HISTORY_RESULTS_PATH, JSON.stringify(perfHistory, null, 2) + "\n");
  copyFileSync(HISTORY_RESULTS_PATH, HISTORY_PUBLIC_PATH);
  console.log(`[npm-compat] wrote ${HISTORY_RESULTS_PATH}`);
  console.log(`[npm-compat] wrote ${HISTORY_PUBLIC_PATH}`);
} else {
  console.log("[npm-compat] skipped aggregate artifact writes");
  console.log(JSON.stringify({ ...summary, perfRows, perfHistory }, null, 2));
}
