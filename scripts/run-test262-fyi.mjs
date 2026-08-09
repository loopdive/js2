#!/usr/bin/env node

/**
 * Run test262 through test262.fyi's original-harness assembler.
 *
 * Unlike tests/test262-runner.ts, this lane performs no wrapTest/buildPreamble
 * rewriting. test262-fyi/data/runner/read.js concatenates the runtime shim,
 * upstream assert.js + sta.js, metadata includes, and the raw test body.
 */
import fs from "node:fs";
import { execFileSync, fork } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverTestPaths, loadOriginalHarnessTests } from "./test262-fyi-reader.mjs";
import { enforceTest262FyiRuntime } from "./test262-fyi-runtime.mjs";

export { loadOriginalHarnessTests } from "./test262-fyi-reader.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FYI_ROOT = join(ROOT, "test262-fyi", "data");
const TEST262_ROOT = join(ROOT, "test262");

// (#3599) Resolved lazily, relative to THIS module's own location, not to a
// path baked in at repo-checkout time. esbuild flattens `import.meta.url` to
// wherever the bundle actually lives when this file is bundled into
// dist/test262-fyi-cli.js for npm publishing — so a plain `join(ROOT,
// "scripts", "test262-worker.mjs")` constant resolves correctly when run
// unbundled from the monorepo (import.meta.url is scripts/run-test262-fyi.mjs
// itself, and test262-worker.mjs is its sibling) but resolves to a
// `scripts/` path inside node_modules that was never published when run from
// the published package (dist/test262-worker.js is the sibling there
// instead). Checking both extensions next to *this* module's own resolved
// location covers both cases with the same code path.
function resolveWorkerPath() {
  const directory = dirname(fileURLToPath(import.meta.url));
  for (const name of ["test262-worker.mjs", "test262-worker.js"]) {
    const candidate = resolve(directory, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`js2 Test262 worker is missing beside ${fileURLToPath(import.meta.url)}`);
}
const DEFAULT_SOURCE_TIMEOUT_MS = 30_000;
const DEFAULT_WORKERS = 2;
const MAX_WORKERS = 4;

function configuredWorkerCount() {
  const configured = Number.parseInt(process.env.TEST262_FYI_WORKERS ?? "", 10);
  return Number.isInteger(configured) && configured >= 1 && configured <= MAX_WORKERS ? configured : DEFAULT_WORKERS;
}

function usage() {
  console.log(`Usage: pnpm run test:262:fyi -- [options]

Runs test262 with the literal test262.fyi harness assembly. The optional
test262-fyi/data submodule must be initialized first.

Options:
  --filter <text>       Run paths containing text (repeatable)
  --paths-file <path>  Run the newline-delimited Test262 paths in this file
  --limit <n>           Stop after n selected test records
  --workers <n>         Parallel source workers, 1-${MAX_WORKERS} (default: ${DEFAULT_WORKERS})
  --target <target>     gc (default), standalone, or wasi
  --json <path>         Write the complete result document to path
  --non-authoritative-smoke
                        Allow a runtime mismatch and mark the report non-comparable
  --list                List selected files without compiling
  --help                Show this help

Examples:
  git submodule update --init --checkout test262-fyi/data
  pnpm run test:262:fyi -- --filter built-ins/Array --limit 20
  pnpm run test:262:fyi:smoke -- --filter built-ins/Array --limit 20
`);
}

export function parseArgs(argv) {
  const options = {
    filters: [],
    pathsFile: undefined,
    limit: Infinity,
    workers: configuredWorkerCount(),
    target: "gc",
    json: undefined,
    list: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") return { ...options, help: true };
    if (arg === "--list") {
      options.list = true;
      continue;
    }
    if (arg === "--non-authoritative-smoke") {
      options.nonAuthoritativeSmoke = true;
      continue;
    }
    if (arg === "--filter") {
      const value = argv[++i];
      if (!value) throw new Error("--filter requires a value");
      options.filters.push(value);
      continue;
    }
    if (arg === "--paths-file") {
      const value = argv[++i];
      if (!value) throw new Error("--paths-file requires a value");
      options.pathsFile = resolve(value);
      continue;
    }
    if (arg === "--limit") {
      const value = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(value) || value < 1) throw new Error("--limit must be a positive integer");
      options.limit = value;
      continue;
    }
    if (arg === "--workers") {
      const value = Number.parseInt(argv[++i] ?? "", 10);
      if (!Number.isInteger(value) || value < 1 || value > MAX_WORKERS) {
        throw new Error(`--workers must be an integer between 1 and ${MAX_WORKERS}`);
      }
      options.workers = value;
      continue;
    }
    if (arg === "--target") {
      const value = argv[++i];
      if (value !== "gc" && value !== "standalone" && value !== "wasi") {
        throw new Error("--target must be gc, standalone, or wasi");
      }
      options.target = value;
      continue;
    }
    if (arg === "--json") {
      const value = argv[++i];
      if (!value) throw new Error("--json requires a path");
      options.json = resolve(value);
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function sourceTimeoutMs() {
  const configured = Number.parseInt(process.env.TEST262_FYI_SOURCE_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_SOURCE_TIMEOUT_MS;
}

function testWorkerOptions(test) {
  const negative = test.negative;
  const isRuntimeNegative = negative !== true && negative?.phase === "runtime";
  const isNegative = negative === true || (Boolean(negative) && !isRuntimeNegative);
  return {
    execute: true,
    isNegative,
    isRuntimeNegative,
    negativePhase: negative === true ? undefined : negative?.phase,
    expectedErrorType: negative === true ? undefined : negative?.type,
    originalHarness: true,
    asyncTest: Boolean(test.flags?.async),
    inferModuleStrictArguments: test.flags?.module === true,
  };
}

function resultPhase(result) {
  if (result.status === "compile_timeout") return "timeout";
  if (result.status === "compile_error" || (result.reachedTest === false && !result.isException)) return "compile";
  return "runtime";
}

function normalizeWorkerResult(result) {
  return {
    pass: result.status === "pass",
    phase: resultPhase(result),
    ...(result.status === "pass" ? {} : { detail: result.error ?? result.status }),
    reachedTest: result.reachedTest === true,
    output: [],
  };
}

/**
 * Serial client for the canonical Test262 worker used by the project runner.
 * The source still comes byte-for-byte from test262.fyi; only execution,
 * isolation, async completion, timeout handling, and verdict classification
 * are shared so the two lanes cannot silently disagree about the same source.
 */
export class FyiSourceExecutor {
  constructor(timeoutMs = sourceTimeoutMs(), { execPath = process.execPath, workerPath = resolveWorkerPath() } = {}) {
    this.timeoutMs = timeoutMs;
    this.execPath = execPath;
    this.workerPath = workerPath;
    this.child = undefined;
    this.starting = undefined;
    this.nextId = 1;
  }

  async startWorker() {
    if (this.child?.connected) return this.child;
    if (this.starting) return this.starting;

    this.starting = new Promise((resolveWorker, rejectWorker) => {
      const child = fork(this.workerPath, [], {
        execPath: this.execPath,
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        execArgv: ["--expose-gc", "--max-old-space-size=512"],
        env: {
          ...process.env,
          TEST262_REALM_CANARY: process.env.TEST262_REALM_CANARY ?? "recycle",
          TZ: process.env.TEST262_TZ ?? "UTC",
        },
      });
      this.child = child;

      const cleanup = () => {
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
      };
      const onMessage = (message) => {
        if (message?.type !== "ready") return;
        cleanup();
        resolveWorker(child);
      };
      const onError = (error) => {
        cleanup();
        this.child = undefined;
        rejectWorker(error);
      };
      const onExit = (code, signal) => {
        cleanup();
        this.child = undefined;
        rejectWorker(new Error(`Test262 worker exited before ready (code ${code}, signal ${signal ?? "none"})`));
      };
      child.on("message", onMessage);
      child.on("error", onError);
      child.on("exit", onExit);
    }).finally(() => {
      this.starting = undefined;
    });

    return this.starting;
  }

  recycle(child, signal = "SIGTERM") {
    if (this.child === child) this.child = undefined;
    child.removeAllListeners();
    if (!child.killed) child.kill(signal);
  }

  async runSource(test, source, target) {
    const child = await this.startWorker();
    const id = this.nextId++;
    const options = testWorkerOptions(test);

    const workerResult = await new Promise((resolveResult) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("message", onMessage);
        child.off("error", onError);
        child.off("exit", onExit);
        resolveResult(result);
      };
      const onMessage = (message) => {
        if (message?.id !== id) return;
        if (message.recycle) this.recycle(child);
        finish(message);
      };
      const onError = (error) => {
        this.recycle(child);
        finish({ status: "compile_error", error: error.message });
      };
      const onExit = (code, signal) => {
        if (this.child === child) this.child = undefined;
        finish({
          status: "compile_error",
          error: `Test262 worker exited during ${test.file} (code ${code}, signal ${signal ?? "none"})`,
        });
      };
      const timer = setTimeout(() => {
        this.recycle(child, "SIGKILL");
        finish({
          status: "compile_timeout",
          error: `source timeout after ${this.timeoutMs}ms`,
        });
      }, this.timeoutMs);

      child.on("message", onMessage);
      child.on("error", onError);
      child.on("exit", onExit);
      child.send({
        id,
        source,
        target,
        ...options,
        ...(test.entryFile && test.fixtureFiles ? { entryFile: test.entryFile, fixtureFiles: test.fixtureFiles } : {}),
        ...(test.dynamicFixtureFiles ? { dynamicFixtureFiles: test.dynamicFixtureFiles } : {}),
      });
    });

    return normalizeWorkerResult(workerResult);
  }

  shutdown() {
    if (this.child) this.recycle(this.child);
  }
}

export async function runTest(test, target, executor) {
  const sourceExecutor = executor ?? new FyiSourceExecutor();
  try {
    const sloppy = await sourceExecutor.runSource(test, test.contents, target);
    if (!sloppy.pass || !test.strictRerun) return sloppy;
    const strict = await sourceExecutor.runSource(test, `"use strict";\n${test.contents}`, target);
    return strict.pass ? sloppy : { ...strict, detail: `strict rerun: ${strict.detail ?? "failed"}` };
  } finally {
    if (!executor) sourceExecutor.shutdown();
  }
}

function gitlinkRevision(path) {
  if (fs.existsSync(join(path, ".git"))) {
    return execFileSync("git", ["-C", path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  }
  return execFileSync("git", ["-C", ROOT, "rev-parse", `HEAD:${path.slice(ROOT.length + 1)}`], {
    encoding: "utf8",
  }).trim();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  const runtimeContract = enforceTest262FyiRuntime({ authoritative: !options.nonAuthoritativeSmoke });
  if (!runtimeContract.authoritative) {
    console.warn(
      "NON-AUTHORITATIVE SMOKE: runtime contract enforcement is disabled; this run cannot be compared with CI baselines.",
    );
  }

  const allPaths = discoverTestPaths();
  const requestedPaths = options.pathsFile
    ? fs
        .readFileSync(options.pathsFile, "utf8")
        .split(/\r?\n/)
        .map((path) => path.trim().replace(/^test\//, ""))
        .filter(Boolean)
    : allPaths;
  const knownPaths = new Set(allPaths);
  const unknownPaths = requestedPaths.filter((path) => !knownPaths.has(path));
  if (unknownPaths.length > 0) {
    throw new Error(`paths file contains unknown Test262 path: ${unknownPaths[0]}`);
  }
  const selectedPaths = requestedPaths
    .filter((path) => options.filters.every((filter) => path.includes(filter)))
    .slice(0, options.limit);

  if (options.list) {
    for (const path of selectedPaths) console.log(path);
    console.log(`Selected ${selectedPaths.length} of ${allPaths.length} test records.`);
    return;
  }

  const selected = selectedPaths.length > 0 ? await loadOriginalHarnessTests(selectedPaths) : [];
  selected.sort((a, b) => a.file.localeCompare(b.file));

  const results = new Array(selected.length);
  let nextIndex = 0;
  let completed = 0;
  const executors = Array.from(
    { length: Math.min(options.workers, Math.max(selected.length, 1)) },
    () => new FyiSourceExecutor(),
  );
  try {
    await Promise.all(
      executors.map(async (executor) => {
        while (true) {
          const index = nextIndex++;
          if (index >= selected.length) return;
          const test = selected[index];
          const result = await runTest(test, options.target, executor);
          results[index] = { file: test.file, ...result };
          completed++;
          const label = result.pass ? "PASS" : "FAIL";
          console.log(
            `[${completed}/${selected.length}] ${label} ${test.file}${result.detail ? ` — ${result.detail}` : ""}`,
          );
        }
      }),
    );
  } finally {
    for (const executor of executors) executor.shutdown();
  }
  const passed = results.filter((result) => result.pass).length;

  const document = {
    runner: "test262-fyi-original-harness",
    executor: "project-test262-worker",
    workers: executors.length,
    target: options.target,
    runtimeContract,
    host: {
      runtime: "node",
      version: process.version,
      v8: process.versions.v8,
      icu: process.versions.icu,
      unicode: process.versions.unicode,
      workerTimeZone: process.env.TEST262_TZ ?? "UTC",
    },
    projectRevision: execFileSync("git", ["-C", ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    test262FyiRevision: gitlinkRevision(FYI_ROOT),
    test262Revision: gitlinkRevision(TEST262_ROOT),
    total: selected.length,
    passed,
    failed: selected.length - passed,
    results,
  };
  if (options.json) {
    fs.mkdirSync(dirname(options.json), { recursive: true });
    fs.writeFileSync(options.json, `${JSON.stringify(document, null, 2)}\n`);
  }
  console.log(`Original harness: ${passed}/${selected.length} passed (${options.target})`);
  if (passed !== selected.length) process.exitCode = 1;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath.endsWith("run-test262-fyi.mjs") && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
