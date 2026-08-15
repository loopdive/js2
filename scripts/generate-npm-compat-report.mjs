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
// Scope: only packages with a real, committed, reproducible dogfood harness.
// mustache/diff/dayjs were probed
// ad-hoc (see their issue files, #3720/#3721/#3747) but have no committed
// harness yet — deliberately NOT included here rather than fabricating
// numbers from a one-off, non-reproducible probe.
//
// Invoke: `pnpm run generate:npm-compat` (writes benchmarks/results/npm-compat.json
// and copies it to website/public/benchmarks/results/).

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { Session } from "node:inspector";

import { compile, compileMulti } from "../src/index.ts";
import { buildStringConstants, buildStringConstants16, jsString, wrapExports } from "../src/runtime.ts";

import { runHarness as runAcorn } from "../tests/dogfood/acorn-harness.mjs";
import { runHarness as runAcornOfficialSuite } from "../tests/dogfood/acorn-official-suite.mjs";
import { runHarness as runMarked } from "../tests/dogfood/marked-harness.mjs";
import { runHarness as runMarkedUpstreamSuite } from "../tests/dogfood/marked-upstream-suite.mjs";
import { runHarness as runClsx } from "../tests/dogfood/clsx-harness.mjs";
import { runHarness as runClsxUpstreamSuite } from "../tests/dogfood/clsx-upstream-suite.mjs";
import { runHarness as runCookie } from "../tests/dogfood/cookie-harness.mjs";
import { runHarness as runCookieUpstreamSuite } from "../tests/dogfood/cookie-upstream-suite.mjs";
import { correctnessRollup, correctnessVerdict } from "./lib/npm-compat-correctness.mjs"; // (#4127)
import { runHarness as runEslint } from "../tests/dogfood/eslint-harness.mjs";
import { runHarness as runEslintWorkload } from "../tests/dogfood/eslint-workload-harness.mjs";
import { runHarness as runEslintUpstreamSuite } from "../tests/dogfood/eslint-upstream-suite.mjs";
import { runHarness as runReduxWorkload } from "../tests/dogfood/redux-workload-harness.mjs";
import { runHarness as runReduxUpstreamSuite } from "../tests/dogfood/redux-upstream-suite.mjs";
import { runHarness as runJsdomWorkload } from "../tests/dogfood/jsdom-harness.mjs";
import { runHarness as runJsdomUpstreamSuite } from "../tests/dogfood/jsdom-upstream-suite.mjs";
import { runHarness as runPrettier } from "../tests/dogfood/prettier-harness.mjs";
import { runHarness as runPrettierUpstreamSuite } from "../tests/dogfood/prettier-upstream-suite.mjs";
import { runHarness as runReact } from "../tests/dogfood/react-harness.mjs";
import { runHarness as runReactUpstreamSuite } from "../tests/dogfood/react-upstream-suite.mjs";
import { runHarness as runLitUpstreamSuite } from "../tests/dogfood/lit-upstream-suite.mjs";
import { setupLitImplementation } from "../tests/dogfood/setup-lit-upstream-suite.mjs";
import { runHarness as runReactDomUpstreamSuite } from "../tests/dogfood/react-dom-upstream-suite.mjs";
import { runHarness as runHonoUpstreamSuite } from "../tests/dogfood/hono-upstream-suite.mjs";
import { runHarness as runLodashUpstreamSuite } from "../tests/dogfood/lodash-upstream-suite.mjs";
import { runHarness as runUuidUpstreamSuite } from "../tests/dogfood/uuid-upstream-suite.mjs";
import { runHarness as runMomentUpstreamSuite } from "../tests/dogfood/moment-upstream-suite.mjs";
import { runHarness as runAxiosUpstreamSuite } from "../tests/dogfood/axios-upstream-suite.mjs";
import { runHarness as runStylelintUpstreamSuite } from "../tests/dogfood/stylelint-upstream-suite.mjs";
import { runHarness as runThreeUpstreamSuite } from "../tests/dogfood/three-upstream-suite.mjs";
import { runHarness as runStyledComponentsUpstreamSuite } from "../tests/dogfood/styled-components-upstream-suite.mjs";
import { runHarness as runWebpackUpstreamSuite } from "../tests/dogfood/webpack-upstream-suite.mjs";
import { runHarness as runJestUpstreamSuite } from "../tests/dogfood/jest-upstream-suite.mjs";
import { runHarness as runTailwindcssUpstreamSuite } from "../tests/dogfood/tailwindcss-upstream-suite.mjs";
import { runHarness as runTypescriptUpstreamSuite } from "../tests/dogfood/typescript-upstream-suite.mjs";
import { NPM_COMPAT_CATALOG, NPM_COMPAT_CATALOG_NAMES } from "../tests/dogfood/npm-compat-catalog.mjs";
import { runNpmCompatCatalogHarness } from "../tests/dogfood/npm-compat-catalog-harness.mjs";
import { NPM_COMPAT_UPSTREAM_SOURCES } from "../tests/dogfood/npm-compat-upstream-sources.mjs";

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
const PACKAGE_NAMES = [
  ...new Set(["acorn", "marked", "clsx", "cookie", "eslint", "prettier", "react", ...NPM_COMPAT_CATALOG_NAMES]),
];
const UPSTREAM_SUITE_RUNNERS = new Map([
  ["acorn", runAcornOfficialSuite],
  ["axios", runAxiosUpstreamSuite],
  ["clsx", runClsxUpstreamSuite],
  ["cookie", runCookieUpstreamSuite],
  ["eslint", runEslintUpstreamSuite],
  ["hono", runHonoUpstreamSuite],
  ["jest", runJestUpstreamSuite],
  ["jsdom", runJsdomUpstreamSuite],
  ["lit", runLitUpstreamSuite],
  ["lodash", (options) => runLodashUpstreamSuite({ ...options, packageName: "lodash" })],
  ["lodash-es", (options) => runLodashUpstreamSuite({ ...options, packageName: "lodash-es" })],
  ["marked", runMarkedUpstreamSuite],
  ["moment", runMomentUpstreamSuite],
  ["prettier", runPrettierUpstreamSuite],
  ["react", runReactUpstreamSuite],
  ["react-dom", runReactDomUpstreamSuite],
  ["redux", runReduxUpstreamSuite],
  ["styled-components", runStyledComponentsUpstreamSuite],
  ["stylelint", runStylelintUpstreamSuite],
  ["tailwindcss", runTailwindcssUpstreamSuite],
  ["three", runThreeUpstreamSuite],
  ["typescript", runTypescriptUpstreamSuite],
  ["uuid", runUuidUpstreamSuite],
  ["webpack", runWebpackUpstreamSuite],
]);

const CONFIGURED_UPSTREAM_NAMES = NPM_COMPAT_UPSTREAM_SOURCES.filter((entry) => entry.suiteScript)
  .map((entry) => entry.name)
  .sort();
const WIRED_UPSTREAM_NAMES = [...UPSTREAM_SUITE_RUNNERS.keys()].sort();
if (JSON.stringify(CONFIGURED_UPSTREAM_NAMES) !== JSON.stringify(WIRED_UPSTREAM_NAMES)) {
  throw new Error(
    `npm-compat upstream runner registry mismatch\nconfigured: ${CONFIGURED_UPSTREAM_NAMES.join(", ")}\nwired: ${WIRED_UPSTREAM_NAMES.join(", ")}`,
  );
}

function runConfiguredUpstreamSuite(name, options) {
  const runner = UPSTREAM_SUITE_RUNNERS.get(name);
  if (!runner) throw new Error(`npm-compat has no upstream suite runner for ${name}`);
  return runner(options);
}
// Committed npm API snapshot keeps report generation deterministic and offline.
// Refresh these together from:
// https://api.npmjs.org/downloads/point/last-week/{package}
const NPM_DOWNLOADS_SNAPSHOT = {
  start: "2026-07-23",
  end: "2026-07-29",
  packages: {
    acorn: 240_886_853,
    cookie: 173_435_452,
    react: 162_687_688,
    eslint: 152_308_132,
    prettier: 117_242_232,
    tailwindcss: 117_155_768,
    axios: 112_353_408,
    clsx: 104_930_549,
    jsdom: 89_317_829,
    marked: 60_496_071,
    webpack: 55_617_769,
    hono: 53_123_258,
    jest: 46_631_732,
    redux: 40_344_956,
    moment: 34_294_671,
    three: 12_487_515,
    "styled-components": 11_029_759,
    stylelint: 10_427_988,
    lit: 6_829_692,
    uuid: 275_892_096,
    typescript: 250_686_863,
    lodash: 164_859_858,
    "lodash-es": 42_294_984,
    "react-dom": 139_740_993,
  },
};
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
  (selectedPackages.size !== 1 || !["acorn", "clsx", "cookie", "lit"].some((name) => selectedPackages.has(name)))
) {
  throw new Error("--perf-only requires exactly one of --only acorn, --only clsx, --only cookie, or --only lit");
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
      // `recordedIn`, NOT `sourceRevision`: this is the commit that committed
      // the measurement, which is never the commit it was measured at — the
      // generator runs at one revision and its output lands at a later one.
      // Recording it as `sourceRevision` was the bug that ate the history. The
      // refresh workflow checks out `fetch-depth: 1`, so this log yields
      // exactly one revision, HEAD, whose committed artifact holds the
      // PREVIOUS run — labelling that point `sourceRevision: HEAD` made it
      // collide with the live point (also HEAD) and the previous run was
      // dropped on every single refresh. See mergeNpmPerfHistory.
      const { generatedAt, packages } = npmPerfHistoryPoint(report.packages ?? [], report.generatedAt);
      return { generatedAt, recordedIn: revision, packages };
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
  const observedExports = (exports) => {
    const wrapped = Object.create(null);
    for (const [name, value] of Object.entries(exports)) {
      // Compiler-authored physical aliases are identity-bearing capability
      // evidence. Keep those exact while observing ordinary export callbacks.
      wrapped[name] =
        typeof value === "function" && !name.startsWith("$")
          ? new Proxy(value, {
              apply(target, thisArg, args) {
                callbackCalls.set(name, (callbackCalls.get(name) ?? 0) + 1);
                return Reflect.apply(target, thisArg, args);
              },
            })
          : value;
    }
    return wrapped;
  };
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
        importObject.__setExports(observedExports(exports));
      },
    });
  }
  if (importObject.__setInstance) {
    Object.defineProperty(instrumented, "__setInstance", {
      value(instance) {
        // Establish every branded/identity-bearing helper from the physical
        // instance before installing the separate observational export view.
        importObject.__setInstance(instance);
        if (callbacks && importObject.__setExports) {
          // Deliberate raw compatibility call: the branded instance has
          // already established authority; this second view only instruments
          // callback counts without replacing identity-bearing helpers.
          importObject.__setExports(observedExports(instance.exports));
        }
      },
    });
  }
  return { instrumented, importCalls, callbackCalls, stop() {} };
}

const STANDALONE_BENCHMARK_EXPORT = "__npmCompatStandaloneBenchmark";
const STANDALONE_STATIC_OPERATION_EXPORT = "__npmCompatStaticOperation";
const CLSX_PERF_OP_NAME = "op_two_strings";
const LIT_WHEN_PERF_EXPORT = "__npmCompatLitWhen";

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
  importObject.__setInstance?.(instance);
  const wireMs = performance.now() - wireStart;
  const wrapStart = performance.now();
  const exp = wrapExports(instance, {
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
  importObject.__setInstance?.(instance);
  const exp = wrapExports(instance, { signatures: result.exportSignatures });
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
  floorImports.__setInstance?.(floorInstance);
  const floorExports = wrapExports(floorInstance, { signatures: floorResult.exportSignatures });
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
    instrumented.__setInstance?.(probeInstance);
    const probeExports = wrapExports(probeInstance, {
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
  importObject.__setInstance?.(instance);
  const exp = wrapExports(instance, {
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

function litWhenModule() {
  const implementation = setupLitImplementation();
  const packageRecord = implementation.packages.find((entry) => entry.name === "lit-html");
  if (!packageRecord) throw new Error("[npm-compat] pinned lit-html implementation is missing");
  const entryModulePath = join(packageRecord.packageDir, "directives", "when.js");
  return { entryModulePath, source: readFileSync(entryModulePath, "utf-8") };
}

async function perfLitJsHost() {
  const { entryModulePath, source } = litWhenModule();
  const compileStarted = performance.now();
  const result = await compile(
    `${source}\nexport function ${LIT_WHEN_PERF_EXPORT}(condition, truthy, falsy) { return n(condition, truthy, falsy); }`,
    {
      fileName: "when.js",
      skipSemanticDiagnostics: true,
      optimize: 4,
    },
  );
  const compileDurationMs = performance.now() - compileStarted;
  if (!result.success || !result.binary?.length) return null;
  if (inspectBinaryPath) {
    writeFileSync(inspectBinaryPath, result.binary);
    console.log(`[npm-compat] wrote lit JS-host binary to ${inspectBinaryPath}`);
  }

  const importObject = result.importObject ?? {};
  const module = await WebAssembly.compile(result.binary);
  const moduleImports = WebAssembly.Module.imports(module).map(
    ({ module: namespace, name, kind }) => `${namespace}.${name}:${kind}`,
  );
  const instance = await WebAssembly.instantiate(module, importObject);
  importObject.__setInstance?.(instance);
  const exports = wrapExports(instance.exports, { signatures: result.exportSignatures });
  if (typeof exports[LIT_WHEN_PERF_EXPORT] !== "function") return null;

  const nativeModule = await import(pathToFileURL(entryModulePath).href);
  const truthy = () => 7;
  const falsy = () => 11;
  const expectedChecksum = nativeModule.when(true, truthy, falsy);
  const actualChecksum = exports[LIT_WHEN_PERF_EXPORT](true, truthy, falsy);
  if (!Object.is(actualChecksum, expectedChecksum)) {
    return failedPerfLane(
      "js-host",
      "result-mismatch",
      `lit when checksum mismatch: ${String(actualChecksum)} !== ${String(expectedChecksum)}`,
    );
  }
  const sampleOp = "select one of two runtime-owned callbacks";
  return {
    ...measureJsHostPerf(
      sampleOp,
      () => exports[LIT_WHEN_PERF_EXPORT](true, truthy, falsy),
      () => nativeModule.when(true, truthy, falsy),
    ),
    compileDurationMs,
    binaryBytes: result.binary.length,
    ...moduleImportMetadata(moduleImports),
    expectedChecksum,
    actualChecksum,
    testCompiledToWasm: false,
    target: "js-host",
  };
}

async function perfLit() {
  const jsHost = runJsHostLane ? await perfLitJsHost() : skippedPerfLane("js-host");
  const standalone = {
    ...skippedPerfLane("standalone"),
    reason: "the pinned Lit callback probe currently covers the JS-host lane only",
  };
  const standaloneDynamic = {
    ...skippedPerfLane("standalone", "runtime-dynamic"),
    reason: "the pinned Lit callback probe currently covers the JS-host lane only",
  };
  return packagePerfRecord(
    jsHost?.sampleOp ?? standalone?.sampleOp ?? standaloneDynamic?.sampleOp ?? "select one of two callbacks",
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

async function buildPackageEntry({ name, version, issue, entryFile, shape, report, tests, perf, entryIsBarrel }) {
  return {
    name,
    version,
    issue,
    entryFile,
    shape,
    compile: report.compile,
    validation: report.validation,
    capabilities: report.capabilities ?? null,
    // True when the published entry module is a re-export barrel with no
    // implementation of its own, so `compile`/`validation` above describe the
    // barrel rather than the package's code. Consumers must not present that
    // as evidence the package compiles (#3977).
    ...(entryIsBarrel ? { entryIsBarrel: true } : {}),
    tests,
    // (#4127) The correctness axis, kept separate from compile/validation so a
    // package that compiles to a valid module but computes the WRONG ANSWER
    // cannot read as green. `unverified` means nothing is known — it is never
    // a synonym for "fine".
    // (#4420) "compiles" must mean the ENGINE accepted the module, not that
    // `compile()` returned `success: true` — codegen can finish and still emit
    // bytes `WebAssembly.compile` rejects, which would let a package read as
    // compiling when nothing it produced can run. Every harness feeding this
    // report already records `validation.validates` from the engine; consult it.
    // `!== false` on both axes keeps "unknown" out of the failure bucket.
    correctness: correctnessVerdict(tests, {
      compiles: report?.compile?.success !== false && report?.validation?.validates !== false,
    }),
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
    const acornSuite = await runConfiguredUpstreamSuite("acorn", { quiet: true });
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
  console.log("[npm-compat] marked — package entry + selected original upstream unit tests...");
  const markedReport = await runMarked({ quiet: true });
  const markedSuite = await runConfiguredUpstreamSuite("marked", { quiet: true });
  packages.push(
    await buildPackageEntry({
      name: "marked",
      version: markedReport.marked.version,
      issue: 3716,
      entryFile: markedReport.marked.entryModule.replace(/^package\//, ""),
      shape: "esm-direct",
      report: markedReport,
      tests: {
        kind: "upstream-suite",
        status: markedSuite.compile?.validated === markedSuite.compile?.modules ? "measured" : "blocked",
        reason:
          markedSuite.compile?.validated === markedSuite.compile?.modules
            ? null
            : "Marked's implementation emitted invalid Wasm; no admitted upstream callback executed in Wasm",
        passed: markedSuite.results?.passed ?? null,
        total: markedSuite.results?.scored ?? null,
        passRatePct:
          markedSuite.results?.scored > 0
            ? Number(((markedSuite.results.passed / markedSuite.results.scored) * 100).toFixed(1))
            : null,
        admitted: markedSuite.extraction?.testsRegistered ?? null,
        executed: markedSuite.results?.scored ?? null,
        upstreamTestsSeen: markedSuite.upstreamSuite?.registrationSites ?? null,
        harnessIncompatible: markedSuite.extraction?.nativeFailed ?? null,
        implementationInvalidTests:
          markedSuite.compile?.validated === markedSuite.compile?.modules ? 0 : (markedSuite.results?.scored ?? null),
        implementationError: markedSuite.compile?.details?.find((detail) => !detail.validates)?.validationError ?? null,
        sourceIssue: 3995,
        upstreamPin: {
          repo: markedSuite.upstreamSuite?.repo ?? null,
          tag: markedSuite.upstreamSuite?.tag ?? null,
          commit: markedSuite.upstreamSuite?.commit ?? null,
        },
      },
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
    console.log("[npm-compat] clsx — compile/validate/diff + complete original upstream unit suite + perf...");
    const clsxReport = await runClsx({ quiet: true });
    const clsxSuite = await runConfiguredUpstreamSuite("clsx", { quiet: true });
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
          kind: "upstream-suite",
          passed: clsxSuite.results?.passed ?? null,
          total: clsxSuite.results?.scored ?? null,
          passRatePct:
            clsxSuite.results?.scored > 0
              ? Number(((clsxSuite.results.passed / clsxSuite.results.scored) * 100).toFixed(1))
              : null,
          admitted: clsxSuite.extraction?.testsRegistered ?? null,
          executed: clsxSuite.results?.scored ?? null,
          upstreamTestsSeen: clsxSuite.upstreamSuite?.registrationSites ?? null,
          harnessIncompatible: clsxSuite.extraction?.nativeFailed ?? null,
          sourceIssue: 3995,
          upstreamPin: {
            repo: clsxSuite.upstreamSuite?.repo ?? null,
            tag: clsxSuite.upstreamSuite?.tag ?? null,
            commit: clsxSuite.upstreamSuite?.commit ?? null,
          },
          packageApiWorkload: {
            kind: "differential-ops",
            passed: clsxReport.summary.opDiff?.equal ?? null,
            total: clsxReport.summary.opDiff?.total ?? null,
          },
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
    console.log("[npm-compat] cookie — compile/validate/diff + complete original upstream unit suite + perf...");
    const cookieReport = await runCookie({ quiet: true });
    const cookieSuite = await runConfiguredUpstreamSuite("cookie", { quiet: true });
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
          kind: "upstream-suite",
          passed: cookieSuite.results?.passed ?? null,
          total: cookieSuite.results?.scored ?? null,
          passRatePct:
            cookieSuite.results?.scored > 0
              ? Number(((cookieSuite.results.passed / cookieSuite.results.scored) * 100).toFixed(1))
              : null,
          admitted: cookieSuite.extraction?.testsRegistered ?? null,
          executed: cookieSuite.results?.scored ?? null,
          upstreamTestsSeen: cookieSuite.extraction?.testsRegistered ?? null,
          harnessIncompatible: cookieSuite.extraction?.nativeFailed ?? null,
          sourceIssue: 3995,
          upstreamPin: {
            repo: cookieSuite.upstreamSuite?.repo ?? null,
            tag: cookieSuite.upstreamSuite?.tag ?? null,
            commit: cookieSuite.upstreamSuite?.commit ?? null,
          },
          packageApiWorkload: {
            kind: "differential-ops",
            passed: cookieReport.summary.opDiff?.equal ?? null,
            total: cookieReport.summary.opDiff?.total ?? null,
          },
        },
        perf: cookiePerf,
      }),
    );
  }
}

if (selectedPackages.has("eslint")) {
  console.log("[npm-compat] eslint — bounded package entry + selected original upstream unit...");
  const eslintReport = await runEslint({ quiet: true });
  const eslintSuite = await runConfiguredUpstreamSuite("eslint", { quiet: true });
  // Do not spend a second bounded compile on a package-entry failure. Once
  // lib/api.js is a valid module, the workload harness compiles a generated
  // driver that calls the real Linter.verify API and compares its primitive
  // diagnostic count with native Node. Until then, retain an explicit blocked
  // workload row so the correctness axis cannot read as an implicit pass.
  const eslintWorkload =
    eslintReport.compile.success && eslintReport.validation.validates ? await runEslintWorkload({ quiet: true }) : null;
  const eslintTests = {
    kind: "upstream-unit",
    passed: eslintSuite.results?.passed ?? null,
    total: eslintSuite.results?.scored ?? null,
    passRatePct:
      eslintSuite.results?.scored > 0
        ? Number(((eslintSuite.results.passed / eslintSuite.results.scored) * 100).toFixed(1))
        : null,
    admitted: eslintSuite.extraction?.admitted ?? null,
    upstreamTestsSeen: eslintSuite.extraction?.upstreamTestsSeen ?? null,
    harnessIncompatible: 0,
    scope: eslintSuite.upstreamSuite?.scope ?? null,
    sourceFiles: eslintSuite.upstreamSuite?.testFiles ?? [],
    sourceIssue: 4293,
    packageApiWorkload: eslintWorkload?.tests ?? {
      status: "blocked",
      reason: eslintReport.compile.success
        ? "package-entry validation did not produce a runnable Linter workload"
        : "package-entry compile blocked before the Linter workload could run",
    },
  };
  packages.push(
    await buildPackageEntry({
      name: "eslint",
      version: eslintReport.eslint.version,
      issue: 1400,
      entryFile: eslintReport.eslint.entryModule.replace(/^package\//, ""),
      shape: "cjs-project",
      report: eslintReport,
      tests: eslintTests,
      perf: null,
    }),
  );
}

if (selectedPackages.has("prettier")) {
  console.log("[npm-compat] prettier — package entry + selected original upstream unit tests...");
  const prettierReport = await runPrettier({ quiet: true });
  const prettierSuite = await runConfiguredUpstreamSuite("prettier", { quiet: true });
  packages.push(
    await buildPackageEntry({
      name: "prettier",
      version: prettierReport.prettier.version,
      issue: null,
      entryFile: prettierReport.prettier.entryModule.replace(/^package\//, ""),
      shape: "esm-project",
      report: prettierReport,
      tests: {
        kind: "upstream-suite",
        passed: prettierSuite.results?.passed ?? null,
        total: prettierSuite.results?.scored ?? null,
        passRatePct:
          prettierSuite.results?.scored > 0
            ? Number(((prettierSuite.results.passed / prettierSuite.results.scored) * 100).toFixed(1))
            : null,
        admitted: prettierSuite.extraction?.testsRegistered ?? null,
        executed: prettierSuite.results?.scored ?? null,
        upstreamTestsSeen: prettierSuite.upstreamSuite?.registrationSites ?? null,
        harnessIncompatible: prettierSuite.extraction?.nativeFailed ?? null,
        sourceIssue: 3995,
        upstreamPin: {
          repo: prettierSuite.upstreamSuite?.repo ?? null,
          tag: prettierSuite.upstreamSuite?.tag ?? null,
          commit: prettierSuite.upstreamSuite?.commit ?? null,
        },
      },
      perf: null,
    }),
  );
}

if (selectedPackages.has("react")) {
  console.log("[npm-compat] react — package entry + React's own upstream unit tests...");
  const reactReport = await runReact({ quiet: true });
  const reactSuite = await runConfiguredUpstreamSuite("react", { quiet: true });
  packages.push(
    await buildPackageEntry({
      name: "react",
      version: reactReport.react.version,
      issue: 3958,
      entryFile: reactReport.react.entryModule.replace(/^package\//, ""),
      shape: "cjs-project",
      report: reactReport,
      // (#3958) These are React's REAL upstream tests now, not the five
      // hand-transcribed vectors this card used to report. The denominator is
      // `scored`, NOT the admitted count: a test the harness cannot reproduce
      // natively says nothing about the compiler and is excluded from the
      // score. `admitted` / `upstreamTestsSeen` ride along so the card can say
      // out loud that this is a slice of React's suite — 20% of it — rather
      // than letting "39/53" read as the whole thing.
      tests: {
        kind: "upstream-suite",
        passed: reactSuite.results?.passed ?? null,
        total: reactSuite.results?.scored ?? null,
        passRatePct: reactSuite.summary?.passRatePct ?? null,
        admitted: reactSuite.extraction?.admitted ?? null,
        executed: reactSuite.results?.executed ?? null,
        upstreamTestsSeen: reactSuite.extraction?.upstreamTestsSeen ?? null,
        harnessIncompatible: reactSuite.results?.harnessIncompatible ?? null,
        quarantined: reactSuite.compile?.quarantined?.length ?? null,
        sourceIssue: 3958,
      },
      perf: null,
    }),
  );
}

if (selectedPackages.has("lit")) {
  const litEntry = NPM_COMPAT_CATALOG.find((entry) => entry.name === "lit");
  if (perfOnly) {
    console.log("[npm-compat] lit — perf only (correctness and upstream suite skipped)...");
    packages.push({
      name: "lit",
      version: litEntry.version,
      issue: 3977,
      entryFile: litEntry.entryModule.replace(/^package\//, ""),
      shape: litEntry.shape,
      perf: await perfLit(),
      knownBugs: knownBugsFor("lit"),
    });
  } else {
    console.log("[npm-compat] lit — package entry + lit's own upstream unit tests...");
    const litReport = await runNpmCompatCatalogHarness("lit", { quiet: true });
    const litSuite = await runConfiguredUpstreamSuite("lit", { quiet: true });
    packages.push(
      await buildPackageEntry({
        name: "lit",
        version: litEntry.version,
        issue: 3977,
        entryFile: litEntry.entryModule.replace(/^package\//, ""),
        shape: litEntry.shape,
        report: litReport,
        // (#3977) The compile/validate numbers on this card come from
        // `lit/index.js`, which is a FOUR-LINE BARREL — it re-exports
        // `lit-element` and `lit-html` and contains no implementation, so
        // "201 bytes, validates" was never a statement about lit. The test
        // numbers come from the three PUBLISHED packages that actually carry
        // lit's code, running lit's own upstream suite. `entryIsBarrel` exists
        // so the card can say that out loud rather than letting the two numbers
        // be read as being about the same thing.
        entryIsBarrel: true,
        tests: {
          kind: "upstream-suite",
          passed: litSuite.results?.passed ?? null,
          total: litSuite.results?.scored ?? null,
          passRatePct: litSuite.summary?.passRatePct ?? null,
          admitted: litSuite.extraction?.admitted ?? null,
          upstreamTestsSeen: litSuite.extraction?.upstreamTestsSeen ?? null,
          harnessIncompatible: litSuite.results?.harnessIncompatible ?? null,
          // The headline finding, and the reason the pass rate is low: most of
          // lit's corpus sits behind an implementation module the validator
          // rejects (#3978), so those tests never ran against Wasm at all.
          implementationInvalidTests: litSuite.summary?.implementationInvalidTests ?? null,
          sourceIssue: 3977,
        },
        perf: await perfLit(),
      }),
    );
  }
}

if (selectedPackages.has("react-dom")) {
  console.log("[npm-compat] react-dom — package entry + react-dom's own upstream unit tests...");
  const reactDomEntry = NPM_COMPAT_CATALOG.find((entry) => entry.name === "react-dom");
  const reactDomReport = await runNpmCompatCatalogHarness("react-dom", { quiet: true });
  const reactDomSuite = await runConfiguredUpstreamSuite("react-dom", { quiet: true });
  const reactDomImplementationReport = {
    ...reactDomReport,
    // The package-entry probe only compiles the small environment selector.
    // The compatibility verdict must come from the real shared + client
    // production renderer that the upstream tests execute.
    compile: {
      ...reactDomReport.compile,
      success: reactDomSuite.compile?.success ?? false,
      durationMs: reactDomSuite.compile?.durationMs ?? reactDomReport.compile?.durationMs,
      binaryBytes: reactDomSuite.compile?.binaryBytes ?? 0,
      error: reactDomSuite.summary?.implementationError ?? null,
    },
    validation: reactDomSuite.validation,
  };
  packages.push(
    await buildPackageEntry({
      name: "react-dom",
      version: reactDomEntry.version,
      issue: 3982,
      // The card reports the real renderer result, so link the renderer rather
      // than the tiny environment-selecting package entry.
      entryFile: reactDomSuite.reactDom.modules[1].replace(/^package\//, ""),
      shape: reactDomEntry.shape,
      report: reactDomImplementationReport,
      // (#3982) The suite landed in PR #4079 but this card kept saying
      // "not-integrated" — the same failure mode as lit/#3977: a suite that
      // exists in tests/dogfood/ is invisible to the dashboard until THIS
      // generator runs it, because the refresh workflow regenerates from this
      // file alone. Denominator is `scored`, not the admitted count, matching
      // the react card: a test the harness cannot reproduce natively says
      // nothing about the compiler.
      tests: {
        kind: "upstream-suite",
        status: reactDomSuite.summary?.implementationInvalid ? "blocked" : "measured",
        reason: reactDomSuite.summary?.implementationInvalid
          ? "react-dom implementation did not produce a valid Wasm module; no upstream test executed in Wasm"
          : null,
        passed: reactDomSuite.results?.passed ?? null,
        total: reactDomSuite.results?.scored ?? null,
        passRatePct: reactDomSuite.summary?.passRatePct ?? null,
        admitted: reactDomSuite.extraction?.admitted ?? null,
        upstreamTestsSeen: reactDomSuite.extraction?.upstreamTestsSeen ?? null,
        harnessIncompatible: reactDomSuite.results?.harnessIncompatible ?? null,
        // Why 0 can be scored while 1,942 are admitted: while #3982 is open the
        // implementation module itself may be rejected, and the suite's OWN
        // test file pins that this is REPORTED with the compiler's message,
        // never a silent zero. Carry that explanation onto the card (the lit
        // card does the same via implementationInvalidTests, #3977/#3978).
        implementationInvalidTests: reactDomSuite.summary?.implementationInvalidTests ?? null,
        implementationError: reactDomSuite.summary?.implementationError ?? null,
        sourceIssue: 3982,
      },
      perf: null,
    }),
  );
}

for (const entry of NPM_COMPAT_CATALOG) {
  if (!selectedPackages.has(entry.name)) continue;
  // Handled above with its own upstream suite rather than as a bare
  if (entry.name === "lit") continue;
  if (entry.name === "react") continue;
  if (entry.name === "react-dom") continue;
  console.log(`[npm-compat] ${entry.name} — bounded published package-entry compile/validate...`);
  const report = await runNpmCompatCatalogHarness(entry.name, { quiet: true });
  const workloadRunner = entry.name === "jsdom" ? runJsdomWorkload : entry.name === "redux" ? runReduxWorkload : null;
  const workload =
    workloadRunner && report.compile.success && report.validation.validates
      ? await workloadRunner({ quiet: true })
      : null;
  const hasApiWorkload = workloadRunner !== null;
  const catalogUpstreamReport = await runConfiguredUpstreamSuite(entry.name, { quiet: true });
  const upstreamSuite = entry.upstreamSuite;
  const upstreamTests = upstreamSuite
    ? {
        kind: "upstream-suite",
        status: report.compile.success && report.validation.validates ? "not-integrated" : "compile-blocked",
        reason:
          report.compile.success && report.validation.validates
            ? `${upstreamSuite.totalTests} original upstream tests identified; runtime adapter pending`
            : `${upstreamSuite.totalTests} original upstream tests identified; none ran because the package entry emitted no valid binary`,
        admitted: 0,
        executed: 0,
        upstreamTestsSeen: upstreamSuite.totalTests,
        harnessIncompatible: 0,
        quarantined: 0,
        sourceIssue: entry.issue ?? null,
        upstreamPin: {
          repo: upstreamSuite.repo,
          tag: upstreamSuite.tag,
          commit: upstreamSuite.commit,
          testDirectory: upstreamSuite.testDirectory,
          testFiles: upstreamSuite.testFiles,
          upstreamSkipped: upstreamSuite.upstreamSkipped,
        },
      }
    : null;
  const tests =
    (catalogUpstreamReport
      ? {
          kind: "upstream-suite",
          passed: catalogUpstreamReport.results?.passed ?? null,
          total: catalogUpstreamReport.results?.scored ?? null,
          passRatePct:
            catalogUpstreamReport.results?.scored > 0
              ? Number(((catalogUpstreamReport.results.passed / catalogUpstreamReport.results.scored) * 100).toFixed(1))
              : null,
          admitted: catalogUpstreamReport.extraction?.testsRegistered ?? null,
          executed: catalogUpstreamReport.results?.scored ?? null,
          upstreamTestsSeen:
            catalogUpstreamReport.upstreamSuite?.registrationSites ??
            catalogUpstreamReport.extraction?.upstreamTestsSeen ??
            catalogUpstreamReport.results?.scored ??
            null,
          harnessIncompatible: catalogUpstreamReport.extraction?.nativeFailed ?? 0,
          quarantined: 0,
          sourceIssue: 3995,
          upstreamPin: {
            repo: catalogUpstreamReport.upstreamSuite?.repo ?? null,
            tag: catalogUpstreamReport.upstreamSuite?.tag ?? null,
            commit: catalogUpstreamReport.upstreamSuite?.commit ?? null,
          },
          packageApiWorkload: workload?.tests ?? undefined,
        }
      : null) ??
    workload?.tests ??
    upstreamTests ??
    (hasApiWorkload
      ? {
          kind: "api-workload",
          status: "blocked",
          reason: report.compile.success
            ? `package-entry validation did not produce a runnable ${entry.name} workload`
            : `package-entry compile blocked before the ${entry.name} workload could run`,
        }
      : {
          kind: "upstream-suite",
          status: "not-integrated",
          reason: "not shipped in npm tarball; adapter pending",
        });
  packages.push(
    await buildPackageEntry({
      name: entry.name,
      version: entry.version,
      issue: entry.issue ?? null,
      entryFile: entry.entryModule.replace(/^package\//, ""),
      shape: entry.shape,
      report,
      tests,
      perf: null,
    }),
  );
}

for (const pkg of packages) {
  pkg.weeklyDownloads = NPM_DOWNLOADS_SNAPSHOT.packages[pkg.name] ?? null;
}
packages.sort(
  (left, right) =>
    (right.weeklyDownloads ?? Number.NEGATIVE_INFINITY) - (left.weeklyDownloads ?? Number.NEGATIVE_INFINITY) ||
    left.name.localeCompare(right.name),
);

const summary = {
  generatedAt: new Date().toISOString(),
  // (#4127) How much of the corpus carries correctness evidence at all. The
  // `unverified` list is named, not just counted, so the size of the blind spot
  // is legible rather than implied.
  correctness: correctnessRollup(packages),
  note: "Only packages with a committed, reproducible tests/dogfood harness are listed. Original upstream tests are preferred; when npm omits them, the card says so instead of substituting harness-authored tests.",
  popularity: {
    metric: "weekly npm downloads",
    start: NPM_DOWNLOADS_SNAPSHOT.start,
    end: NPM_DOWNLOADS_SNAPSHOT.end,
    source: "https://api.npmjs.org/downloads/point/last-week/{package}",
  },
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
