#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const BENCHMARK_MANIFEST_VERSION = 2;

export const BENCHMARK_ARTIFACT_FILES = Object.freeze([
  "benchmarks/results/latest.json",
  "benchmarks/results/latest.md",
  "benchmarks/results/history.json",
  "benchmarks/results/playground-benchmark-sidebar.json",
  "benchmarks/results/playground-benchmark-sidebar-no-jit.json",
  "benchmarks/results/size-benchmarks.json",
  "benchmarks/results/loadtime-benchmarks.json",
  "benchmarks/results/wasm-host-wasmtime-hot-runtime.json",
  "benchmarks/results/wasm-host-wasmtime-module-size-per-test.json",
]);

export const BENCHMARK_ARTIFACT_DIRECTORIES = Object.freeze(["benchmarks/results/loadtime"]);

export const BENCHMARK_REGRESSION_POLICY = Object.freeze({
  runtime: {
    wasmSlowdownFraction: 0.2,
    jsRelativeRatioDropFraction: 0.25,
    minimumInternalSampleMs: 1,
  },
  loadtime: {
    gating: true,
    wasmSlowdownFraction: 0.4,
    jsRelativeRatioDropFraction: 0.4,
    minimumSampleMs: 1,
  },
  size: {
    growthFraction: 0.12,
    minimumGrowthBytes: 128,
  },
});

export const BENCHMARK_PROVENANCE = Object.freeze({
  scope: "outputs reproduced by the current canonical benchmark generators",
  timingMethodology:
    "sub-millisecond internal, JavaScript parse, host parse, and Wasm compile operations use calibrated batches normalized to per-call time",
  artifactSets: [
    {
      id: "internal-suite",
      generator: "benchmarks/run.ts",
      artifacts: ["benchmarks/results/latest.json", "benchmarks/results/latest.md", "benchmarks/results/history.json"],
      freshness: "latest files are current-run measurements; history.json is a regenerated historical aggregate",
    },
    {
      id: "playground-warm",
      generator: "scripts/generate-playground-benchmark-sidebar.mjs",
      artifacts: ["benchmarks/results/playground-benchmark-sidebar.json"],
      freshness: "current-run measurements",
    },
    {
      id: "playground-no-jit",
      generator: "scripts/generate-playground-benchmark-sidebar-no-jit.mjs",
      artifacts: ["benchmarks/results/playground-benchmark-sidebar-no-jit.json"],
      freshness: "current-run measurements",
    },
    {
      id: "size-loadtime",
      generator: "scripts/generate-size-benchmarks.ts",
      artifacts: [
        "benchmarks/results/size-benchmarks.json",
        "benchmarks/results/loadtime-benchmarks.json",
        "benchmarks/results/loadtime/**",
      ],
      freshness: "current-run measurements and compiled assets",
    },
    {
      id: "wasmtime-hot-runtime",
      generator: "scripts/generate-wasmtime-hot-runtime.mjs",
      artifacts: ["benchmarks/results/wasm-host-wasmtime-hot-runtime.json"],
      freshness:
        "current-run AOT and V8 measurements; Javy and StarlingMonkey are measured only after a relevant main revision and otherwise retain the last accepted values with source provenance",
    },
    {
      id: "wasmtime-module-size",
      generator: "scripts/generate-wasmtime-hot-runtime.mjs",
      artifacts: ["benchmarks/results/wasm-host-wasmtime-module-size-per-test.json"],
      freshness:
        "current-run AOT and minified JavaScript sizes; Javy and StarlingMonkey sizes refresh only after a relevant main revision",
    },
  ],
  carriedForwardMeasurements: [
    "Javy and StarlingMonkey runtime and module-size controls when their corpus, setup, dependencies, and pinned versions are unchanged",
  ],
  unsupportedArtifacts: [
    {
      path: "benchmarks/results/wasm-host-wasmtime-module-size.json",
      reason: "no current refresh generator reproduces this legacy summary",
    },
  ],
});

const REQUIRED_TOOL_VERSION_FIELDS = Object.freeze([
  "node",
  "platform",
  "arch",
  "pnpm",
  "git",
  "typescript",
  "binaryen",
  "esbuild",
  "wasmtime",
  "rustc",
  "cargo",
  "javy",
  "componentizeJs",
]);

const LOADTIME_SUPPORT_FILES = Object.freeze([
  "benchmarks/results/loadtime/runtime.js",
  "benchmarks/results/loadtime/binaryen.js",
]);

function usage() {
  console.error(`Usage:
  node scripts/benchmark-lifecycle.mjs package --root <checkout> --output <snapshot> --source-sha <sha>
  node scripts/benchmark-lifecycle.mjs validate --snapshot <snapshot> [--source-sha <sha>]
  node scripts/benchmark-lifecycle.mjs compare --baseline <snapshot> --candidate <snapshot>

Exit codes:
  0 = success / no substantial regressions
  1 = substantial regressions detected
  2 = usage or invalid artifact error`);
}

function parseOptions(args, allowed) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!allowed.includes(name) || value === undefined || value.startsWith("--")) {
      throw new Error(`Invalid option: ${name ?? "<missing>"}`);
    }
    if (Object.hasOwn(options, name)) throw new Error(`Duplicate option: ${name}`);
    options[name] = value;
  }
  return options;
}

function readJson(path, label = path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function resultPath(root, name) {
  return resolve(root, "benchmarks", "results", name);
}

function commandVersion(command, args, cwd) {
  const env = { ...process.env };
  if (command === "git") {
    // Git exports repository-scoped variables while running hooks. Let each
    // child discover the repository from its own cwd instead of inheriting the
    // caller's checkout, especially for synthetic fixture roots.
    delete env.GIT_DIR;
    delete env.GIT_WORK_TREE;
    delete env.GIT_INDEX_FILE;
    delete env.GIT_COMMON_DIR;
  }
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) return "unavailable";
  return result.stdout.trim().split(/\r?\n/, 1)[0] || "unavailable";
}

function packageVersion(root, packageName) {
  try {
    return String(readJson(resolve(root, "node_modules", packageName, "package.json")).version);
  } catch {
    return "unavailable";
  }
}

function collectToolVersions(root) {
  const auxiliaryInherited = process.env.BENCHMARK_AUXILIARY_MODE === "inherit";
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    pnpm: commandVersion("pnpm", ["--version"], root),
    git: commandVersion("git", ["--version"], root),
    typescript: packageVersion(root, "typescript"),
    binaryen: packageVersion(root, "binaryen"),
    esbuild: packageVersion(root, "esbuild"),
    wasmtime: commandVersion("wasmtime", ["--version"], root),
    rustc: commandVersion("rustc", ["--version"], root),
    cargo: commandVersion("cargo", ["--version"], root),
    javy: auxiliaryInherited
      ? "not-used (auxiliary measurements inherited)"
      : commandVersion(process.env.JAVY_BIN || "javy", ["--version"], root),
    componentizeJs: packageVersion(root, "@bytecodealliance/componentize-js"),
  };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function listFiles(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else if (entry.isFile()) files.push(path);
    else throw new Error(`Benchmark snapshot must not contain a symlink or special file: ${path}`);
  }
  return files.sort();
}

function assertInside(parent, child) {
  const path = relative(parent, child);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !path.startsWith(sep))) return;
  throw new Error(`Path escapes benchmark root: ${child}`);
}

function assertRegularFile(path, label) {
  if (!existsSync(path)) throw new Error(`Missing benchmark artifact: ${label}`);
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Benchmark artifact must be a regular file: ${label}`);
  }
}

function finitePositive(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${label} must be a positive number`);
  return number;
}

function finitePositiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function validateUniqueRows(rows, label, keyOf, validateRow) {
  if (!Array.isArray(rows) || rows.length === 0) throw new Error(`${label} must contain a non-empty array`);
  const keys = new Set();
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error(`${label}[${index}] must be an object`);
    const key = keyOf(row);
    if (!key || typeof key !== "string") throw new Error(`${label}[${index}] is missing its identity`);
    if (keys.has(key)) throw new Error(`${label} contains duplicate row: ${key}`);
    keys.add(key);
    validateRow(row, `${label}[${index}]`);
  }
  return keys;
}

function validateRuntimeRows(rows, label, keyOf, expectedMode) {
  return validateUniqueRows(rows, label, keyOf, (row, rowLabel) => {
    finitePositive(row.wasmUs, `${rowLabel}.wasmUs`);
    finitePositive(row.jsUs, `${rowLabel}.jsUs`);
    if (expectedMode && row.mode !== expectedMode) {
      throw new Error(`${rowLabel}.mode must be ${expectedMode}`);
    }
  });
}

function validateWasmtimeRows(rows) {
  const scenariosByName = new Map();
  validateRuntimeRows(rows, "benchmarks/results/wasm-host-wasmtime-hot-runtime.json", (row) =>
    row.name && row.scenario ? `${row.name}:${row.scenario}` : null,
  );
  for (const [index, row] of rows.entries()) {
    if (row.scenario !== "cold" && row.scenario !== "warm") {
      throw new Error(`benchmarks/results/wasm-host-wasmtime-hot-runtime.json[${index}].scenario must be cold or warm`);
    }
    if (!scenariosByName.has(row.name)) scenariosByName.set(row.name, new Set());
    scenariosByName.get(row.name).add(row.scenario);
    finitePositive(row.javyUs, `benchmarks/results/wasm-host-wasmtime-hot-runtime.json[${index}].javyUs`);
    finitePositive(
      row.starlingMonkeyUs,
      `benchmarks/results/wasm-host-wasmtime-hot-runtime.json[${index}].starlingMonkeyUs`,
    );
    if (row.auxiliaryMeasurement === "measured-current-run") {
      if (
        typeof row.lanesProvenance !== "string" ||
        !row.lanesProvenance.includes("measured by scripts/generate-wasmtime-hot-runtime.mjs")
      ) {
        throw new Error(`Wasmtime auxiliary lanes for ${row.name}:${row.scenario} are missing measurement provenance`);
      }
    } else if (row.auxiliaryMeasurement === "carried-forward-unchanged-inputs") {
      if (
        typeof row.auxiliarySourceSha !== "string" ||
        !/^[0-9a-f]{40}$/.test(row.auxiliarySourceSha) ||
        typeof row.lanesProvenance !== "string" ||
        !row.lanesProvenance.includes("carried forward")
      ) {
        throw new Error(`Wasmtime auxiliary lanes for ${row.name}:${row.scenario} are missing carry provenance`);
      }
    } else {
      throw new Error(`Wasmtime auxiliary lanes for ${row.name}:${row.scenario} have an invalid measurement mode`);
    }
    if (
      row.scenario === "warm" &&
      (typeof row.javyWarmMode !== "string" ||
        !row.javyWarmMode.includes("single-entry-batch") ||
        typeof row.starlingMonkeyWarmMode !== "string" ||
        !row.starlingMonkeyWarmMode.includes("single-entry-batch") ||
        !Number.isSafeInteger(row.auxiliaryWarmBatchIterations) ||
        row.auxiliaryWarmBatchIterations <= 1 ||
        row.auxiliaryWarmWrapper !== "fixed-runtime-arg-single-entry-batch-no-return-wit")
    ) {
      throw new Error(`Wasmtime warm auxiliary lanes for ${row.name} are missing single-entry batch methodology`);
    }
  }
  for (const [name, scenarios] of scenariosByName) {
    if (!scenarios.has("cold") || !scenarios.has("warm")) {
      throw new Error(`Wasmtime benchmark ${name} must contain paired cold and warm rows`);
    }
  }
}

function validateWasmtimeModuleSizeRows(rows) {
  const label = "benchmarks/results/wasm-host-wasmtime-module-size-per-test.json";
  const lanesByProgram = new Map();
  validateUniqueRows(
    rows,
    label,
    (row) => (row.name && row.path ? `${row.path}:${row.name}` : null),
    (row, rowLabel) => {
      if (!["AOT compiled", "Interpreter", "Engine"].includes(row.name)) {
        throw new Error(`${rowLabel}.name is not a displayed module-size lane`);
      }
      if (!Number.isSafeInteger(row.value) || row.value <= 0) {
        throw new Error(`${rowLabel}.value must be a positive byte count`);
      }
      if (!Number.isSafeInteger(row.jsUs) || row.jsUs <= 0) {
        throw new Error(`${rowLabel}.jsUs must be a positive minified JavaScript byte count`);
      }
      if (typeof row.label !== "string" || row.label.length === 0) {
        throw new Error(`${rowLabel}.label must be a non-empty string`);
      }
      if (!lanesByProgram.has(row.path)) lanesByProgram.set(row.path, []);
      lanesByProgram.get(row.path).push(row);
    },
  );
  for (const [program, lanes] of lanesByProgram) {
    const names = lanes.map((row) => row.name).sort();
    if (JSON.stringify(names) !== JSON.stringify(["AOT compiled", "Engine", "Interpreter"])) {
      throw new Error(`Wasmtime module-size benchmark ${program} must contain all three displayed lanes`);
    }
    if (new Set(lanes.map((row) => row.jsUs)).size !== 1) {
      throw new Error(`Wasmtime module-size benchmark ${program} has inconsistent JavaScript byte baselines`);
    }
  }
}

export function validateInternalSuite(rows) {
  const strategies = new Map();
  validateUniqueRows(
    rows,
    "benchmarks/results/latest.json",
    (row) => (typeof row.name === "string" && typeof row.strategy === "string" ? `${row.name}:${row.strategy}` : null),
    (row, label) => {
      // (#3904 prerequisite) A benchmark strategy that ERRORED is recorded as a
      // placeholder row — all-zero timings plus `status: "failed"` and an
      // `error` message — instead of being dropped from the results entirely.
      // Such a row is legal but carries no timings, so it is exempt from the
      // positive-median check while still being required to explain itself.
      //
      //   absent row  = strategy not applicable (deliberately skipped)
      //   failed row  = strategy is BROKEN
      //
      // Only the `js` reference must always produce a real measurement; a
      // failed JS row means the comparison itself is meaningless.
      //
      // This validator change MUST land on `main` BEFORE the harness starts
      // emitting such rows. `benchmark-refresh.yml` deliberately validates the
      // candidate snapshot with the BASELINE's copy of this script on
      // `pull_request` (see the `lifecycle=` selection in that workflow), so a
      // PR cannot weaken its own gate. The consequence is that an artifact
      // FORMAT change cannot go green in the same PR that teaches the validator
      // about it — hence this split.
      if (row.status === "failed") {
        if (row.strategy === "js") {
          throw new Error(`${label} records a failed JS reference row; the JS baseline must always measure`);
        }
        if (typeof row.error !== "string" || row.error.length === 0) {
          throw new Error(`${label}.error must be a non-empty message on a failed row`);
        }
      } else {
        finitePositive(row.medianMs, `${label}.medianMs`);
      }
      if (!strategies.has(row.name)) strategies.set(row.name, new Set());
      strategies.get(row.name).add(row.strategy);
    },
  );
  for (const [name, available] of strategies) {
    if (!available.has("js")) throw new Error(`Internal benchmark ${name} is missing its JS reference row`);
  }
}

function sizeEntries(document, label) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${label} must contain an object`);
  }
  if (!Array.isArray(document.benchmarks) || document.benchmarks.length === 0) {
    throw new Error(`${label}.benchmarks must contain a non-empty array`);
  }
  if (!document.howItWorks || typeof document.howItWorks !== "object" || Array.isArray(document.howItWorks)) {
    throw new Error(`${label}.howItWorks must contain an object`);
  }
  const rows = [];
  for (const [name, row] of Object.entries(document.howItWorks)) {
    if (row !== null) rows.push([`howItWorks/${name}`, row]);
  }
  for (const row of document.benchmarks) {
    if (!row || typeof row.name !== "string" || row.name.length === 0) {
      throw new Error(`${label}.benchmarks contains a row without a name`);
    }
    rows.push([`benchmarks/${row.name}`, row]);
  }
  const keys = new Set();
  for (const [key, row] of rows) {
    if (keys.has(key)) throw new Error(`${label} contains duplicate size row: ${key}`);
    keys.add(key);
    for (const metric of [
      "jsSizeRaw",
      "jsSizeGzip",
      "wasmSizeRaw",
      "wasmSizeGzip",
      "hostJsGzip",
      "wasmTotalGzip",
      "jsParseMs",
      "wasmCompileMs",
      "hostJsParseMs",
      "wasmTotalMs",
    ]) {
      finitePositive(row[metric], `${label}.${key}.${metric}`);
    }
  }
  return rows;
}

function safeLoadtimeAsset(root, value, extension, label) {
  if (
    typeof value !== "string" ||
    !value.startsWith("loadtime/") ||
    !value.endsWith(extension) ||
    value.includes("\\") ||
    value.split("/").includes("..")
  ) {
    throw new Error(`${label} must be a safe loadtime/${extension} path`);
  }
  const path = resultPath(root, value);
  assertInside(resultPath(root, "loadtime"), path);
  return path;
}

function loadtimeArtifactPaths(root, document) {
  if (!document || typeof document !== "object" || !Array.isArray(document.benchmarks)) {
    throw new Error("benchmarks/results/loadtime-benchmarks.json must contain a benchmarks array");
  }
  if (document.benchmarks.length === 0) {
    throw new Error("benchmarks/results/loadtime-benchmarks.json must contain at least one benchmark");
  }
  const names = new Set();
  const paths = LOADTIME_SUPPORT_FILES.map((path) => resolve(root, path));
  for (const [index, row] of document.benchmarks.entries()) {
    const label = `benchmarks/results/loadtime-benchmarks.json.benchmarks[${index}]`;
    if (!row || typeof row.name !== "string" || row.name.length === 0) throw new Error(`${label}.name is missing`);
    if (names.has(row.name)) throw new Error(`Duplicate loadtime benchmark: ${row.name}`);
    names.add(row.name);
    paths.push(safeLoadtimeAsset(root, row.jsUrl, ".mjs", `${label}.jsUrl`));
    paths.push(safeLoadtimeAsset(root, row.wasmUrl, ".wasm", `${label}.wasmUrl`));
  }
  return [...new Set(paths)].sort();
}

function validateCanonicalArtifacts(root) {
  const absoluteRoot = resolve(root);
  for (const artifact of BENCHMARK_ARTIFACT_FILES) {
    assertRegularFile(resolve(absoluteRoot, artifact), artifact);
  }

  const latest = readJson(resultPath(absoluteRoot, "latest.json"), "benchmarks/results/latest.json");
  validateInternalSuite(latest);

  const history = readJson(resultPath(absoluteRoot, "history.json"), "benchmarks/results/history.json");
  if (!Array.isArray(history)) throw new Error("benchmarks/results/history.json must contain an array");

  const playgroundWarmPaths = validateRuntimeRows(
    readJson(
      resultPath(absoluteRoot, "playground-benchmark-sidebar.json"),
      "benchmarks/results/playground-benchmark-sidebar.json",
    ),
    "benchmarks/results/playground-benchmark-sidebar.json",
    (row) => row.path,
    "warm",
  );
  const playgroundNoJitPaths = validateRuntimeRows(
    readJson(
      resultPath(absoluteRoot, "playground-benchmark-sidebar-no-jit.json"),
      "benchmarks/results/playground-benchmark-sidebar-no-jit.json",
    ),
    "benchmarks/results/playground-benchmark-sidebar-no-jit.json",
    (row) => row.path,
    "no-jit",
  );
  if (JSON.stringify([...playgroundWarmPaths].sort()) !== JSON.stringify([...playgroundNoJitPaths].sort())) {
    throw new Error("Playground warm and no-JIT artifacts must contain the same benchmark paths");
  }
  validateWasmtimeRows(
    readJson(
      resultPath(absoluteRoot, "wasm-host-wasmtime-hot-runtime.json"),
      "benchmarks/results/wasm-host-wasmtime-hot-runtime.json",
    ),
  );
  validateWasmtimeModuleSizeRows(
    readJson(
      resultPath(absoluteRoot, "wasm-host-wasmtime-module-size-per-test.json"),
      "benchmarks/results/wasm-host-wasmtime-module-size-per-test.json",
    ),
  );

  const sizeDocument = readJson(
    resultPath(absoluteRoot, "size-benchmarks.json"),
    "benchmarks/results/size-benchmarks.json",
  );
  const sizes = sizeEntries(sizeDocument, "benchmarks/results/size-benchmarks.json");
  const loadtimeDocument = readJson(
    resultPath(absoluteRoot, "loadtime-benchmarks.json"),
    "benchmarks/results/loadtime-benchmarks.json",
  );
  const loadtimePaths = loadtimeArtifactPaths(absoluteRoot, loadtimeDocument);
  const sizeBenchmarkNames = new Set(
    sizes.filter(([key]) => key.startsWith("benchmarks/")).map(([key]) => key.slice("benchmarks/".length)),
  );
  const loadtimeBenchmarkNames = new Set(loadtimeDocument.benchmarks.map((row) => row.name));
  if (JSON.stringify([...sizeBenchmarkNames].sort()) !== JSON.stringify([...loadtimeBenchmarkNames].sort())) {
    throw new Error("Size and loadtime artifacts must contain the same benchmark names");
  }

  for (const path of loadtimePaths) assertRegularFile(path, portablePath(absoluteRoot, path));
  const directory = resultPath(absoluteRoot, "loadtime");
  if (!existsSync(directory) || !lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
    throw new Error("Missing benchmark artifact directory: benchmarks/results/loadtime");
  }
  const actualLoadtimePaths = listFiles(directory).map((path) => portablePath(absoluteRoot, path));
  const expectedLoadtimePaths = loadtimePaths.map((path) => portablePath(absoluteRoot, path));
  if (JSON.stringify(actualLoadtimePaths) !== JSON.stringify(expectedLoadtimePaths)) {
    throw new Error(
      `Compiled loadtime asset set is incomplete or stale: expected ${expectedLoadtimePaths.join(", ")}, received ${actualLoadtimePaths.join(", ")}`,
    );
  }

  return [...BENCHMARK_ARTIFACT_FILES.map((path) => resolve(absoluteRoot, path)), ...loadtimePaths].sort();
}

function artifactSetId(path) {
  if (
    path === "benchmarks/results/latest.json" ||
    path === "benchmarks/results/latest.md" ||
    path === "benchmarks/results/history.json"
  ) {
    return "internal-suite";
  }
  if (path === "benchmarks/results/playground-benchmark-sidebar.json") return "playground-warm";
  if (path === "benchmarks/results/playground-benchmark-sidebar-no-jit.json") return "playground-no-jit";
  if (path === "benchmarks/results/wasm-host-wasmtime-hot-runtime.json") return "wasmtime-hot-runtime";
  if (path === "benchmarks/results/wasm-host-wasmtime-module-size-per-test.json") {
    return "wasmtime-module-size";
  }
  return "size-loadtime";
}

function ensureEmptyOutput(output) {
  if (!existsSync(output)) return;
  if (!lstatSync(output).isDirectory() || lstatSync(output).isSymbolicLink()) {
    throw new Error(`Snapshot output must be an absent or empty directory: ${output}`);
  }
  if (readdirSync(output).length !== 0) throw new Error(`Snapshot output must be absent or empty: ${output}`);
}

function validateSourceSha(sourceSha) {
  if (typeof sourceSha !== "string" || !/^[0-9a-f]{40}$/.test(sourceSha)) {
    throw new Error("Benchmark source SHA must be a full lowercase Git SHA");
  }
}

function verifySourceRevision(root, sourceSha, allowNonGitRoot) {
  const head = commandVersion("git", ["rev-parse", "HEAD"], root);
  if (head === "unavailable") {
    if (allowNonGitRoot) return;
    throw new Error(`Benchmark source root is not a Git checkout: ${root}`);
  }
  if (head !== sourceSha) {
    throw new Error(`Benchmark source SHA mismatch: expected checkout ${head}, received ${sourceSha}`);
  }
}

export function packageSnapshot({ root, output, sourceSha, generatedAt, toolVersions, allowNonGitRoot = false }) {
  validateSourceSha(sourceSha);
  const absoluteRoot = resolve(root);
  const absoluteOutput = resolve(output);
  if (absoluteRoot === absoluteOutput) throw new Error("Snapshot output must differ from the source checkout");
  verifySourceRevision(absoluteRoot, sourceSha, allowNonGitRoot);
  const sourcePaths = validateCanonicalArtifacts(absoluteRoot);
  ensureEmptyOutput(absoluteOutput);
  mkdirSync(absoluteOutput, { recursive: true });

  for (const source of sourcePaths) {
    const path = portablePath(absoluteRoot, source);
    const destination = resolve(absoluteOutput, path);
    assertInside(absoluteOutput, destination);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }

  const artifacts = sourcePaths.map((source) => {
    const path = portablePath(absoluteRoot, source);
    const packagedPath = resolve(absoluteOutput, path);
    return {
      path,
      artifactSet: artifactSetId(path),
      bytes: statSync(packagedPath).size,
      sha256: sha256(packagedPath),
    };
  });
  const manifest = {
    schemaVersion: BENCHMARK_MANIFEST_VERSION,
    generatedAt: generatedAt || process.env.BENCHMARK_GENERATED_AT || new Date().toISOString(),
    sourceSha,
    toolVersions: toolVersions || collectToolVersions(absoluteRoot),
    provenance: BENCHMARK_PROVENANCE,
    artifacts,
  };
  const manifestPath = resultPath(absoluteOutput, "benchmark-manifest.json");
  mkdirSync(dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  validateSnapshot(absoluteOutput, sourceSha);
  return manifest;
}

function validateManifestShape(manifest, expectedSourceSha) {
  if (manifest?.schemaVersion !== BENCHMARK_MANIFEST_VERSION) {
    throw new Error(`Unsupported benchmark manifest schema: ${String(manifest?.schemaVersion)}`);
  }
  if (typeof manifest.generatedAt !== "string" || !Number.isFinite(Date.parse(manifest.generatedAt))) {
    throw new Error("Benchmark manifest generatedAt must be an ISO timestamp");
  }
  validateSourceSha(manifest.sourceSha);
  if (expectedSourceSha && manifest.sourceSha !== expectedSourceSha) {
    throw new Error(`Benchmark source SHA mismatch: expected ${expectedSourceSha}, received ${manifest.sourceSha}`);
  }
  if (!manifest.toolVersions || typeof manifest.toolVersions !== "object" || Array.isArray(manifest.toolVersions)) {
    throw new Error("Benchmark manifest is missing toolVersions");
  }
  for (const field of REQUIRED_TOOL_VERSION_FIELDS) {
    if (
      typeof manifest.toolVersions[field] !== "string" ||
      manifest.toolVersions[field].length === 0 ||
      manifest.toolVersions[field].trim().toLowerCase() === "unavailable"
    ) {
      throw new Error(`Benchmark manifest is missing tool version: ${field}`);
    }
  }
  if (JSON.stringify(manifest.provenance) !== JSON.stringify(BENCHMARK_PROVENANCE)) {
    throw new Error("Benchmark manifest provenance does not match the lifecycle schema");
  }
}

export function validateSnapshot(snapshot, expectedSourceSha) {
  const root = resolve(snapshot);
  const manifestPath = resultPath(root, "benchmark-manifest.json");
  assertRegularFile(manifestPath, "benchmarks/results/benchmark-manifest.json");
  const manifest = readJson(manifestPath, "benchmarks/results/benchmark-manifest.json");
  validateManifestShape(manifest, expectedSourceSha);

  const expectedPaths = validateCanonicalArtifacts(root).map((path) => portablePath(root, path));
  const rows = Array.isArray(manifest.artifacts) ? manifest.artifacts : [];
  const actualPaths = rows.map((row) => row?.path);
  if (
    new Set(actualPaths).size !== actualPaths.length ||
    JSON.stringify([...actualPaths].sort()) !== JSON.stringify(expectedPaths)
  ) {
    throw new Error("Benchmark manifest artifact set does not match the packaged snapshot");
  }

  for (const row of rows) {
    if (
      !row ||
      typeof row.path !== "string" ||
      row.artifactSet !== artifactSetId(row.path) ||
      !Number.isSafeInteger(row.bytes) ||
      row.bytes < 0 ||
      typeof row.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(row.sha256)
    ) {
      throw new Error(`Invalid benchmark artifact manifest row: ${JSON.stringify(row)}`);
    }
    const path = resolve(root, row.path);
    assertInside(root, path);
    assertRegularFile(path, row.path);
    if (statSync(path).size !== row.bytes || sha256(path) !== row.sha256) {
      throw new Error(`Benchmark artifact integrity mismatch: ${row.path}`);
    }
  }

  const allPackagedFiles = listFiles(root).map((path) => portablePath(root, path));
  const expectedPackagedFiles = [...expectedPaths, "benchmarks/results/benchmark-manifest.json"].sort();
  if (JSON.stringify(allPackagedFiles) !== JSON.stringify(expectedPackagedFiles)) {
    throw new Error("Benchmark snapshot contains files outside the canonical manifest");
  }
  return manifest;
}

function keyedRows(rows, label, keyOf, valueOf) {
  const map = new Map();
  validateUniqueRows(rows, label, keyOf, (row) => {
    const value = valueOf(row);
    if (value) map.set(keyOf(row), value);
  });
  return map;
}

function comparePairedRuntime({
  label,
  baselineRows,
  candidateRows,
  keyOf,
  wasmValueOf = (row) => row.wasmUs,
  jsValueOf = (row) => row.jsUs,
  sampleSpanOf,
  policy = BENCHMARK_REGRESSION_POLICY.runtime,
}) {
  const select = (rows, side) =>
    keyedRows(rows, `${label} ${side}`, keyOf, (row) => {
      const wasm = finitePositiveOrNull(wasmValueOf(row));
      const js = finitePositiveOrNull(jsValueOf(row));
      if (!wasm || !js) return null;
      const sampleSpan = sampleSpanOf?.(row, wasm, js);
      return { wasm, js, ratio: js / wasm, sampleSpan };
    });
  const baseline = select(baselineRows, "baseline");
  const candidate = select(candidateRows, "candidate");
  const regressions = [];
  const notes = [];
  for (const [key, before] of baseline) {
    const after = candidate.get(key);
    if (!after) {
      regressions.push(`${label} ${key}: missing candidate row`);
      continue;
    }
    const ratioDrop = (before.ratio - after.ratio) / before.ratio;
    const wasmSlowdown = (after.wasm - before.wasm) / before.wasm;
    if (
      policy.minimumSampleMs &&
      ((before.sampleSpan?.wasm ?? Number.POSITIVE_INFINITY) < policy.minimumSampleMs ||
        (before.sampleSpan?.js ?? Number.POSITIVE_INFINITY) < policy.minimumSampleMs ||
        (after.sampleSpan?.wasm ?? Number.POSITIVE_INFINITY) < policy.minimumSampleMs ||
        (after.sampleSpan?.js ?? Number.POSITIVE_INFINITY) < policy.minimumSampleMs)
    ) {
      notes.push(`${label} ${key}: sample span below ${policy.minimumSampleMs}ms; informational`);
      continue;
    }
    if (ratioDrop > policy.jsRelativeRatioDropFraction && wasmSlowdown > policy.wasmSlowdownFraction) {
      regressions.push(
        `${label} ${key}: JS-relative ratio fell ${(ratioDrop * 100).toFixed(1)}% and Wasm slowed ${(wasmSlowdown * 100).toFixed(1)}%`,
      );
    } else if (ratioDrop > 0 || wasmSlowdown > 0) {
      notes.push(
        `${label} ${key}: ratio ${(ratioDrop * 100).toFixed(1)}%, Wasm ${(wasmSlowdown * 100).toFixed(1)}% (below joint gate)`,
      );
    }
  }
  return { regressions, notes };
}

function compareInternalSuite(baselineRows, candidateRows) {
  const index = (rows, side) => {
    const byBenchmark = new Map();
    validateUniqueRows(
      rows,
      `internal ${side}`,
      (row) => (row?.name && row?.strategy ? `${row.name}:${row.strategy}` : null),
      (row) => {
        const median = finitePositiveOrNull(row.medianMs);
        if (!median) return;
        if (!byBenchmark.has(row.name)) byBenchmark.set(row.name, new Map());
        const batchSize = Number.isSafeInteger(row.batchSize) && row.batchSize > 0 ? row.batchSize : 1;
        byBenchmark.get(row.name).set(row.strategy, {
          median,
          sampleMs: median * batchSize,
        });
      },
    );
    return byBenchmark;
  };
  const baseline = index(baselineRows, "baseline");
  const candidate = index(candidateRows, "candidate");
  const regressions = [];
  const notes = [];
  for (const [name, strategies] of baseline) {
    const beforeJs = strategies.get("js");
    const candidateStrategies = candidate.get(name);
    const afterJs = candidateStrategies?.get("js");
    for (const [strategy, beforeResult] of strategies) {
      if (strategy === "js") continue;
      const afterResult = candidateStrategies?.get(strategy);
      if (!afterResult) {
        regressions.push(`internal ${name}:${strategy}: missing candidate row`);
        continue;
      }
      if (!beforeJs || !afterJs) {
        regressions.push(`internal ${name}:${strategy}: missing paired JS reference`);
        continue;
      }
      const minimumSampleMs = BENCHMARK_REGRESSION_POLICY.runtime.minimumInternalSampleMs;
      if (
        beforeJs.sampleMs < minimumSampleMs ||
        afterJs.sampleMs < minimumSampleMs ||
        beforeResult.sampleMs < minimumSampleMs ||
        afterResult.sampleMs < minimumSampleMs
      ) {
        notes.push(
          `internal ${name}:${strategy}: sample span below ${minimumSampleMs}ms; runtime comparison is informational`,
        );
        continue;
      }
      const before = beforeResult.median;
      const after = afterResult.median;
      const beforeRatio = beforeJs.median / before;
      const afterRatio = afterJs.median / after;
      const ratioDrop = (beforeRatio - afterRatio) / beforeRatio;
      const slowdown = (after - before) / before;
      if (
        ratioDrop > BENCHMARK_REGRESSION_POLICY.runtime.jsRelativeRatioDropFraction &&
        slowdown > BENCHMARK_REGRESSION_POLICY.runtime.wasmSlowdownFraction
      ) {
        regressions.push(
          `internal ${name}:${strategy}: JS-relative ratio fell ${(ratioDrop * 100).toFixed(1)}% and strategy slowed ${(slowdown * 100).toFixed(1)}%`,
        );
      } else if (ratioDrop > 0 || slowdown > 0) {
        notes.push(
          `internal ${name}:${strategy}: ratio ${(ratioDrop * 100).toFixed(1)}%, runtime ${(slowdown * 100).toFixed(1)}% (below joint gate)`,
        );
      }
    }
  }
  return { regressions, notes };
}

function compareSizes(baselineDocument, candidateDocument) {
  const baseline = sizeEntries(baselineDocument, "baseline size");
  const candidate = new Map(sizeEntries(candidateDocument, "candidate size"));
  const regressions = [];
  const notes = [];
  for (const [key, before] of baseline) {
    const after = candidate.get(key);
    if (!after) {
      regressions.push(`size ${key}: missing candidate row`);
      continue;
    }
    for (const metric of ["wasmSizeRaw", "wasmSizeGzip", "wasmTotalGzip"]) {
      const oldValue = finitePositiveOrNull(before[metric]);
      const newValue = finitePositiveOrNull(after[metric]);
      if (!oldValue || !newValue) continue;
      compareByteGrowth(`size ${key}:${metric}`, oldValue, newValue, regressions, notes);
    }
  }
  return { regressions, notes };
}

function compareByteGrowth(label, oldValue, newValue, regressions, notes) {
  const growth = (newValue - oldValue) / oldValue;
  const bytes = newValue - oldValue;
  const message = `${label}: grew ${(growth * 100).toFixed(1)}% (+${Math.round(bytes)} bytes)`;
  if (
    growth > BENCHMARK_REGRESSION_POLICY.size.growthFraction &&
    bytes >= BENCHMARK_REGRESSION_POLICY.size.minimumGrowthBytes
  ) {
    regressions.push(message);
  } else if (growth > 0) {
    notes.push(message);
  }
}

function compareLoadtimeAssets(baselineManifest, candidateManifest) {
  const select = (manifest) =>
    new Map(
      manifest.artifacts
        .filter((row) => row.path.startsWith("benchmarks/results/loadtime/"))
        .map((row) => [row.path, row.bytes]),
    );
  const baseline = select(baselineManifest);
  const candidate = select(candidateManifest);
  const regressions = [];
  const notes = [];
  for (const [path, before] of baseline) {
    const after = candidate.get(path);
    if (after === undefined) {
      regressions.push(`loadtime-asset ${path}: missing candidate asset`);
      continue;
    }
    compareByteGrowth(`loadtime-asset ${path}`, before, after, regressions, notes);
  }
  return { regressions, notes };
}

function compareLoadtimeMeasurements(baselineDocument, candidateDocument) {
  const toRows = (document, label) =>
    sizeEntries(document, label).map(([key, row]) => ({
      key,
      wasmTotalMs: row.wasmTotalMs,
      jsParseMs: row.jsParseMs,
      jsParseBatchSize: row.jsParseBatchSize,
      wasmCompileMs: row.wasmCompileMs,
      wasmCompileBatchSize: row.wasmCompileBatchSize,
      hostJsParseMs: row.hostJsParseMs,
      hostJsParseBatchSize: row.hostJsParseBatchSize,
    }));
  return comparePairedRuntime({
    label: "loadtime",
    baselineRows: toRows(baselineDocument, "baseline loadtime"),
    candidateRows: toRows(candidateDocument, "candidate loadtime"),
    keyOf: (row) => row.key,
    wasmValueOf: (row) => row.wasmTotalMs,
    jsValueOf: (row) => row.jsParseMs,
    sampleSpanOf: (row, wasm, js) => {
      const jsBatch = Number.isSafeInteger(row.jsParseBatchSize) && row.jsParseBatchSize > 0 ? row.jsParseBatchSize : 1;
      const wasmBatch =
        Number.isSafeInteger(row.wasmCompileBatchSize) && row.wasmCompileBatchSize > 0 ? row.wasmCompileBatchSize : 1;
      const hostBatch =
        Number.isSafeInteger(row.hostJsParseBatchSize) && row.hostJsParseBatchSize > 0 ? row.hostJsParseBatchSize : 1;
      const wasmCompile = finitePositiveOrNull(row.wasmCompileMs);
      const hostParse = finitePositiveOrNull(row.hostJsParseMs);
      return {
        js: js * jsBatch,
        wasm: Math.min(wasmCompile ? wasmCompile * wasmBatch : wasm, hostParse ? hostParse * hostBatch : Infinity),
      };
    },
    policy: BENCHMARK_REGRESSION_POLICY.loadtime,
  });
}

function compareCompileOnlyMeasurements(baselineDocument, candidateDocument) {
  const candidate = new Map(sizeEntries(candidateDocument, "candidate compile-only"));
  const notes = [];
  for (const [key, before] of sizeEntries(baselineDocument, "baseline compile-only")) {
    const after = candidate.get(key);
    const oldValue = finitePositiveOrNull(before.wasmCompileMs);
    const newValue = finitePositiveOrNull(after?.wasmCompileMs);
    if (!oldValue || !newValue) continue;
    const slowdown = (newValue - oldValue) / oldValue;
    if (slowdown > BENCHMARK_REGRESSION_POLICY.loadtime.wasmSlowdownFraction) {
      notes.push(`compile-only ${key}: Wasm compile time slowed ${(slowdown * 100).toFixed(1)}% (informational)`);
    }
  }
  return { regressions: [], notes };
}

function compareWasmtimeModuleSizes(baselineRows, candidateRows) {
  const select = (rows, label) =>
    keyedRows(
      rows.filter((row) => row?.name === "AOT compiled"),
      label,
      (row) => (row.path && row.name ? `${row.path}:${row.name}` : null),
      (row) => {
        const value = finitePositiveOrNull(row.value);
        return value ? { value } : null;
      },
    );
  const baseline = select(baselineRows, "wasmtime-module-size baseline");
  const candidate = select(candidateRows, "wasmtime-module-size candidate");
  const regressions = [];
  const notes = [];
  for (const [key, before] of baseline) {
    const after = candidate.get(key);
    if (!after) {
      regressions.push(`wasmtime-module-size ${key}: missing candidate row`);
      continue;
    }
    compareByteGrowth(`wasmtime-module-size ${key}`, before.value, after.value, regressions, notes);
  }
  return { regressions, notes };
}

function toolchainNotes(baselineManifest, candidateManifest) {
  const notes = [];
  for (const field of REQUIRED_TOOL_VERSION_FIELDS) {
    const before = baselineManifest.toolVersions[field];
    const after = candidateManifest.toolVersions[field];
    if (before !== after) notes.push(`tool ${field} differs: baseline=${before}, candidate=${after}`);
  }
  return notes;
}

export function compareSnapshots(baselineRoot, candidateRoot) {
  const baselineManifest = validateSnapshot(baselineRoot);
  const candidateManifest = validateSnapshot(candidateRoot);
  const baselineSize = readJson(resultPath(baselineRoot, "size-benchmarks.json"));
  const candidateSize = readJson(resultPath(candidateRoot, "size-benchmarks.json"));
  const comparisons = [
    comparePairedRuntime({
      label: "playground-warm",
      baselineRows: readJson(resultPath(baselineRoot, "playground-benchmark-sidebar.json")),
      candidateRows: readJson(resultPath(candidateRoot, "playground-benchmark-sidebar.json")),
      keyOf: (row) => row.path,
    }),
    comparePairedRuntime({
      label: "playground-no-jit",
      baselineRows: readJson(resultPath(baselineRoot, "playground-benchmark-sidebar-no-jit.json")),
      candidateRows: readJson(resultPath(candidateRoot, "playground-benchmark-sidebar-no-jit.json")),
      keyOf: (row) => row.path,
    }),
    comparePairedRuntime({
      label: "wasmtime-hot",
      baselineRows: readJson(resultPath(baselineRoot, "wasm-host-wasmtime-hot-runtime.json")),
      candidateRows: readJson(resultPath(candidateRoot, "wasm-host-wasmtime-hot-runtime.json")),
      keyOf: (row) => (row.name && row.scenario ? `${row.name}:${row.scenario}` : null),
    }),
    compareInternalSuite(
      readJson(resultPath(baselineRoot, "latest.json")),
      readJson(resultPath(candidateRoot, "latest.json")),
    ),
    compareSizes(baselineSize, candidateSize),
    compareLoadtimeMeasurements(baselineSize, candidateSize),
    compareCompileOnlyMeasurements(baselineSize, candidateSize),
    compareLoadtimeAssets(baselineManifest, candidateManifest),
    compareWasmtimeModuleSizes(
      readJson(resultPath(baselineRoot, "wasm-host-wasmtime-module-size-per-test.json")),
      readJson(resultPath(candidateRoot, "wasm-host-wasmtime-module-size-per-test.json")),
    ),
  ];
  return {
    regressions: comparisons.flatMap((comparison) => comparison.regressions),
    notes: [
      ...comparisons.flatMap((comparison) => comparison.notes),
      ...toolchainNotes(baselineManifest, candidateManifest),
    ],
    informational: [
      "Wasmtime regressions are reported for the primary AOT lane; Javy and StarlingMonkey are post-merge, change-scoped comparison controls.",
      "Internal and loadtime runtime regressions are classified as substantial only when each calibrated sample spans at least 1ms.",
      "End-to-end loadtime is jointly compared with its JS control; compile-only microtimings remain informational.",
      "The legacy non-displayed wasm-host-wasmtime-module-size summary is unsupported and excluded from snapshots.",
    ],
  };
}

export function runCli(argv = process.argv.slice(2)) {
  const [command, ...args] = argv;
  if (command === "package") {
    const options = parseOptions(args, ["--root", "--output", "--source-sha"]);
    if (!options["--root"] || !options["--output"] || !options["--source-sha"]) {
      throw new Error("package requires --root, --output, and --source-sha");
    }
    const manifest = packageSnapshot({
      root: options["--root"],
      output: options["--output"],
      sourceSha: options["--source-sha"],
    });
    console.log(
      `Packaged ${manifest.artifacts.length} benchmark artifacts for ${manifest.sourceSha} at ${manifest.generatedAt}`,
    );
    return 0;
  }
  if (command === "validate") {
    const options = parseOptions(args, ["--snapshot", "--source-sha"]);
    if (!options["--snapshot"]) throw new Error("validate requires --snapshot");
    const manifest = validateSnapshot(options["--snapshot"], options["--source-sha"]);
    console.log(`Validated ${manifest.artifacts.length} benchmark artifacts for ${manifest.sourceSha}`);
    return 0;
  }
  if (command === "compare") {
    const options = parseOptions(args, ["--baseline", "--candidate"]);
    if (!options["--baseline"] || !options["--candidate"]) {
      throw new Error("compare requires --baseline and --candidate");
    }
    const report = compareSnapshots(options["--baseline"], options["--candidate"]);
    console.log("=== Benchmark lifecycle comparison ===");
    console.log(`Substantial regressions: ${report.regressions.length}`);
    for (const regression of report.regressions) console.log(`REGRESSION: ${regression}`);
    for (const note of report.notes) console.log(`NOTE: ${note}`);
    for (const note of report.informational) console.log(`INFO: ${note}`);
    return report.regressions.length > 0 ? 1 : 0;
  }
  throw new Error(`Unknown benchmark lifecycle command: ${command ?? "<missing>"}`);
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  try {
    process.exitCode = runCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    usage();
    process.exitCode = 2;
  }
}
