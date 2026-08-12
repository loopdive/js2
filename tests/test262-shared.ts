/**
 * Shared infrastructure for test262 vitest chunks.
 *
 * Unified fork architecture: each it() sends source to a pool of fork
 * processes. Each fork compiles + executes the test in one process, then
 * sends back just the result. No binaries over IPC, no disk I/O in the
 * critical path. Forks self-manage memory (GC + compiler recreation).
 *
 * Vitest runs chunks sequentially; fork dies between chunks for full
 * memory reclaim of the vitest process itself.
 */
import { createHash } from "crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  writeSync as fdWrite,
  fsyncSync,
  openSync,
} from "fs";
import { join, relative } from "path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { availableParallelism } from "os";
import { CompilerPool, type TestResult } from "../scripts/compiler-pool.js";
import { discoverFixtureGraph } from "../scripts/test262-fixture-graph.mjs";
// (#4162) ONE import-object finaliser, shared with scripts/test262-worker.mjs
// and tests/test262-runner.ts.
import { instantiateTest262Module } from "../scripts/test262-import-object.mjs";
import { isPoisonCompileError } from "../scripts/test262-poison-error.mjs";
import { negativeCompileErrorMatches, negativeCompileSucceededVerdict } from "../scripts/negative-verdict.mjs";
import { isRecordedVerdictSentinel } from "../scripts/verdict-once.mjs";
import { findNthAssert } from "./test262-assert-locator.js";
import { ORACLE_VERSION, ORACLE_FAST_REV } from "./test262-oracle-version.js";
import {
  classifyError,
  classifyTestScope,
  createTestSandbox,
  extractWasmExceptionMessage,
  findTestFiles,
  isModuleGoal,
  matchesPathFilter,
  parseMeta,
  shouldSkip,
  standaloneHostImportError,
  TEST_CATEGORIES,
  type Test262Scope,
} from "./test262-runner.js";
import { assembleOriginalHarness, assembleNativeHarness } from "./test262-original-harness.js";

// Prevent unhandled Promise rejections from crashing the vitest fork.
process.on("unhandledRejection", () => {});

// Lazy-load compileMulti and buildImports only when needed (FIXTURE tests)
let _compileMulti: typeof import("../src/index.js").compileMulti | null = null;
async function getCompileMulti() {
  if (!_compileMulti) {
    const mod = await import("../src/index.js");
    _compileMulti = mod.compileMulti;
  }
  return _compileMulti;
}

let _buildImports: typeof import("../src/runtime.js").buildImports | null = null;
async function getBuildImports() {
  if (!_buildImports) {
    const mod = await import("../src/runtime.js");
    _buildImports = mod.buildImports;
  }
  return _buildImports;
}

/** Provenance prefix for this lane's runtime-eval tier announcement (#2928 E7). */
const RUNTIME_EVAL_PROVIDER_LABEL = "test262-fixture";

function resolveFixtureGraph(source: string, testFilePath: string) {
  return discoverFixtureGraph(relative(join(TEST262_ROOT, "test"), testFilePath), source);
}

// ── Slow-test priority map ─────────────────────────────────────────
// Maps test path (relative to test262/, e.g. "test/built-ins/Array/.../foo.js")
// to its measured compile+exec wall time in ms for the active target. Used
// inside `runTest262Chunk` to assign tests to weighted shards and then sort
// each shard's test list by descending duration so the slow tests run FIRST.
// Tests absent from the map get `DEFAULT_TEST_WEIGHT_MS` for shard assignment
// and sort behind the timed ones.
//
// Sources: tests/test262-slow-tests.json for JS-host, with target-specific
// overrides such as tests/test262-slow-tests-standalone.json when available.
function slowTestPathCandidates(): string[] {
  const target = process.env.TEST262_TARGET;
  const dir = import.meta.dirname ?? ".";
  const candidates: string[] = [];
  if (target && target !== "gc") candidates.push(join(dir, `test262-slow-tests-${target}.json`));
  candidates.push(join(dir, "test262-slow-tests.json"));
  return candidates;
}

const slowTestDurationMs: Map<string, number> = (() => {
  for (const path of slowTestPathCandidates()) {
    if (!existsSync(path)) continue;
    try {
      const raw = readFileSync(path, "utf-8");
      const doc = JSON.parse(raw) as { tests?: Record<string, number> };
      const map = new Map<string, number>();
      for (const [k, v] of Object.entries(doc.tests ?? {})) {
        if (typeof v === "number" && v > 0) map.set(k, v);
      }
      return map;
    } catch {
      // Try the next candidate; a broken target-specific file should not keep
      // the runner from falling back to the host timing map.
    }
  }
  return new Map();
})();
const parsedDefaultTestWeightMs = parseInt(process.env.TEST262_DEFAULT_TEST_WEIGHT_MS || "250", 10);
const DEFAULT_TEST_WEIGHT_MS = Number.isFinite(parsedDefaultTestWeightMs)
  ? Math.max(1, parsedDefaultTestWeightMs)
  : 250;

// ── Cache setup (for disk cache side-effect) ───────────────────────

const CACHE_DIR = join(import.meta.dirname ?? ".", "..", ".test262-cache");
mkdirSync(CACHE_DIR, { recursive: true });

function buildCompilerHash(): string {
  const h = createHash("md5");
  const root = join(import.meta.dirname ?? ".", "..");
  try {
    h.update(readFileSync(join(root, "scripts", "compiler-bundle.mjs")));
  } catch {
    h.update("no-bundle");
  }
  try {
    h.update(readFileSync(join(import.meta.dirname ?? ".", "test262-runner.ts")));
  } catch {
    h.update("no-runner");
  }
  try {
    h.update(readFileSync(join(root, "src", "runtime.ts")));
  } catch {
    h.update("no-runtime");
  }
  return h.digest("hex").slice(0, 12);
}

const compilerHash = buildCompilerHash();

type Test262CompileTarget = "gc" | "linear" | "wasi" | "standalone";

function parseTest262Target(): Test262CompileTarget | undefined {
  const raw = process.env.TEST262_TARGET;
  if (raw === "linear" || raw === "wasi" || raw === "standalone") return raw;
  return undefined;
}

const TEST262_TARGET = parseTest262Target();

// #3462 — oracle LANE selection (the #3450 hybrid two-oracle pipeline). Two
// oracles run under the same `ORACLE_VERSION`:
//   - HONEST in-wasm v8 (the default) — host + standalone, the published number;
//   - FAST native-harness (host lane ONLY) — the merge-gate oracle sr-3461 wires
//     behind `TEST262_ORACLE_MODE=fast` in the worker (harness runs natively,
//     body-only wasm compile). We read the SAME pinned env var + the target here
//     to stamp each result row's lane, so `diff-test262` can refuse to compare a
//     fast candidate against the honest baseline (and vice-versa).
//
// The "host" lane is the JS-host default (no TEST262_TARGET → gc/js-string). The
// native harness needs a JS host to run assert.js/sta.js natively, so it applies
// ONLY there: standalone (and linear/wasi) can never host-exec the harness, so
// they stay HONEST v8 even inside a fast-mode merge_group run. This mirrors the
// worker's own rule (sr-3461): standalone target NEVER sets `nativeHarness`.
const TEST262_ORACLE_MODE = process.env.TEST262_ORACLE_MODE;
const IS_HOST_LANE = TEST262_TARGET === undefined;
const ORACLE_LANE: "honest" | "fast-nativeharness" =
  TEST262_ORACLE_MODE === "fast" && IS_HOST_LANE ? "fast-nativeharness" : "honest";

// (#3461) Fast native-harness oracle — the execution side of the fast lane that
// #3462 stamps above. Active ONLY when `TEST262_ORACLE_MODE=fast` AND the run is
// the HOST lane (`TEST262_TARGET` undefined — WasmGC + JS host). Standalone/
// linear/wasi cannot host-execute the harness (they forbid host imports), so they
// always use the honest whole-assembly v8 oracle regardless of the flag — exactly
// the condition captured by `ORACLE_LANE === "fast-nativeharness"`. Absent flag ⇒
// honest path, byte-identical to today (AC#2).
const NATIVE_HARNESS_ORACLE = ORACLE_LANE === "fast-nativeharness";

function getCachePaths(wrappedSource: string): { wasmPath: string; metaPath: string } {
  const hash = createHash("md5")
    .update(wrappedSource)
    .update(compilerHash)
    .update(TEST262_TARGET ?? "gc")
    .digest("hex");
  return {
    wasmPath: join(CACHE_DIR, `${hash}.wasm`),
    metaPath: join(CACHE_DIR, `${hash}.json`),
  };
}

// ── Pool setup ─────────────────────────────────────────────────────

const POOL_SIZE = parseInt(process.env.COMPILER_POOL_SIZE || String(Math.max(1, availableParallelism() - 1)), 10);

// (#2928 E6) Per-test vitest timeout. The 90s default measures POOL-QUEUE WAIT
// as well as the test's own run: when a slow cluster occupies every pool worker
// (e.g. interpreter-linked eval tests hitting the 30s pool timeout back to
// back), queued tests blow this limit and vitest kills them WITHOUT a jsonl
// row — the run silently under-reports its own denominator (measured: 202 of
// 816 eval-code rows missing at 2 workers). Raise via env for slow-cluster
// sweeps; the default stays 90s so CI behavior is unchanged.
const IT_TIMEOUT_MS = parseInt(process.env.TEST262_IT_TIMEOUT_MS || "90000", 10);

let pool: CompilerPool | null = null;

// ── Compile-timeout retry (#1589) ──────────────────────────────────
// CI fork-pool contention makes tests show `compile_timeout` (30 s, exec
// 0 ms) when in isolation they pass in <300 ms. Per the #1589 investigation,
// 95/100 baseline timeouts are this kind of flake. On a `compile_timeout`
// result, we re-run the test serially with a tighter 10 s ceiling. If it
// passes, we record `pass` with `retried: true`. If it still times out or
// fails, we record the (new) failure. A per-shard counter caps retries at
// MAX_RETRIES_PER_SHARD so a systemically broken pool doesn't add
// MAX_RETRIES * RETRY_TIMEOUT_MS of wall time.
const MAX_RETRIES_PER_SHARD = 10;
const RETRY_TIMEOUT_MS = 10_000;
let retriesUsed = 0;
let poisonRetriesUsed = 0;
// Mutex (serial Promise chain) — only one retry runs at a time so retries
// are truly isolated from each other on the fork pool.
let retryMutex: Promise<void> = Promise.resolve();
function runRetrySerial<T>(fn: () => Promise<T>): Promise<T> {
  const prev = retryMutex;
  let release!: () => void;
  retryMutex = new Promise<void>((r) => {
    release = r;
  });
  return prev.then(fn).finally(() => release());
}

// ── Result tracking (JSONL output for report.html) ──────────────────

const RESULTS_DIR = join(import.meta.dirname ?? ".", "..", "benchmarks", "results");
mkdirSync(RESULTS_DIR, { recursive: true });

// Timestamped filename — env var from run-test262-vitest.sh, or generate one
const RUN_TIMESTAMP =
  process.env.RUN_TIMESTAMP || new Date().toISOString().replace(/[-:T]/g, "").replace(/\..+/, "").slice(0, 15);
const RESULT_PREFIX = process.env.TEST262_RESULT_PREFIX || (TEST262_TARGET ? `test262-${TEST262_TARGET}` : "test262");
const JSONL_PATH = join(RESULTS_DIR, `${RESULT_PREFIX}-results-${RUN_TIMESTAMP}.jsonl`);
// A JSONL can exist even when the Vitest fork dies halfway through a shard.
// The workflow accepts exit code 1 because baseline conformance failures are
// ordinary test results, so process death cannot be inferred from the exit
// code alone. Write this marker only from afterAll, once Vitest has settled
// every registered test and the result fd has been closed. Shard jobs require
// the marker before accepting/uploading their evidence.
const SHARD_COMPLETION_PATH = `${JSONL_PATH}.complete.json`;

// Open results JSONL — each chunk appends independently
const jsonlFd = openSync(JSONL_PATH, "a");
let flushCount = 0;

const summary = {
  total: 0,
  pass: 0,
  fail: 0,
  compile_error: 0,
  compile_timeout: 0,
  skip: 0,
};
type StatusCounts = {
  pass: number;
  fail: number;
  compile_error: number;
  compile_timeout: number;
  skip: number;
  total: number;
};

function createEmptyCounts(): StatusCounts {
  return {
    pass: 0,
    fail: 0,
    compile_error: 0,
    compile_timeout: 0,
    skip: 0,
    total: 0,
  };
}

const catCounts: Record<string, StatusCounts> = {};

const errorCategoryCounts: Record<string, number> = {};
const skipReasonCounts: Record<string, number> = {};

class ConformanceError extends Error {
  constructor(status: string, detail?: string) {
    super(`[${status}] ${detail || "unknown"}`);
    this.name = "ConformanceError";
  }
}

type RecordMetadata = {
  imports?: string[];
  hostImportLeakClass?: string;
  reachedTest?: boolean;
  // (#2939/#2940) True when the `fail` is a vacuity correction (harness-wrapper
  // callback never executed). Surfaced in the JSONL so the report tallies the
  // integrity correction separately from genuine fails.
  vacuous?: boolean;
};

function normalizeErrorSignature(status: string, errorCategory: string | undefined, error: string | undefined) {
  if (!error) return undefined;
  const normalized = error
    .replace(/\bL\d+:\d+/g, "L#:##")
    .replace(/\bL\d+\b/g, "L#")
    .replace(/@\+\d+/g, "@+#")
    .replace(/0x[0-9a-f]+/gi, "0x#")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return `${errorCategory ?? status}:${normalized}`;
}

function summarizeImportName(desc: any): string | undefined {
  if (!desc || typeof desc !== "object") return undefined;
  const moduleName = desc.module ?? desc.moduleName ?? desc.module_name ?? "env";
  const name = desc.name ?? desc.field ?? desc.fieldName ?? desc.importName;
  return name ? `${moduleName}::${name}` : undefined;
}

function summarizeImports(imports: any[] | undefined): string[] {
  if (!Array.isArray(imports)) return [];
  return [...new Set(imports.map(summarizeImportName).filter((name): name is string => Boolean(name)))].sort();
}

function classifyHostImportLeak(imports: string[] | undefined): string | undefined {
  if (!imports || imports.length === 0) return undefined;
  const joined = imports.join(" ");
  if (
    /__extern_|__object_|__defineProperty|__get_builtin|__new_plain_object|__register_|__proto_method_call/.test(joined)
  ) {
    return "dynamic_object_property";
  }
  if (/__iterator|__array_from_iter|__gen_|generator|async_iterator/.test(joined)) return "iterator_protocol";
  if (/RegExp_|regexp/i.test(joined)) return "regexp";
  if (/JSON_/i.test(joined)) return "json";
  if (/__extern_eval|__dynamic_import|Function_new/.test(joined)) return "dynamic_code";
  if (/wasm:js-string/.test(joined)) return "js_string";
  if (/wasi_snapshot_preview1/.test(joined)) return "wasi";
  return "host_import";
}

function metadataFromImports(imports: any[] | undefined, reachedTest: boolean): RecordMetadata {
  const names = summarizeImports(imports);
  return {
    ...(names.length > 0 ? { imports: names } : {}),
    ...(names.length > 0 ? { hostImportLeakClass: classifyHostImportLeak(names) } : {}),
    reachedTest,
  };
}

function metadataFromWorkerResult(result: TestResult, reachedTestFallback = false): RecordMetadata {
  return {
    ...(result.imports && result.imports.length > 0 ? { imports: result.imports } : {}),
    ...(result.hostImportLeakClass ? { hostImportLeakClass: result.hostImportLeakClass } : {}),
    ...((result as { vacuous?: boolean }).vacuous ? { vacuous: true } : {}),
    reachedTest: result.reachedTest ?? reachedTestFallback,
  };
}

function recordResult(
  file: string,
  category: string,
  status: string,
  error?: string,
  timing?: { compileMs?: number; execMs?: number },
  scopeInfo?: { scope: Test262Scope; official: boolean; reason?: string; strict?: "only" | "no" | "both" },
  retryInfo?: { retried?: boolean; retryCount?: number },
  metadata?: RecordMetadata,
) {
  const hostImportError = status === "pass" ? standaloneHostImportError(TEST262_TARGET, metadata?.imports) : undefined;
  if (hostImportError) {
    status = "compile_error";
    error = hostImportError;
  }
  const errorCategory = status === "fail" || status === "compile_error" ? classifyError(error) : undefined;

  const entry = JSON.stringify({
    timestamp: new Date().toLocaleString("de-DE", { timeZone: "Europe/Berlin" }),
    // #2096: oracle identity. Every row carries the version of the verdict
    // logic that produced its status so diff-test262 can refuse cross-version
    // comparisons (which would read oracle skew as regressions). Bump in
    // tests/test262-oracle-version.ts when the oracle tightens (e.g. #1945).
    oracle_version: ORACLE_VERSION,
    // #3462: oracle LANE discriminator (the #3450 hybrid). "honest" is the
    // in-wasm v8 lane (host + standalone, the published number); a fast-mode
    // HOST run stamps "fast-nativeharness" and its own `oracle_fast_rev`. This
    // is an INDEPENDENT axis from oracle_version — a fast row and an honest row
    // are both v8 but produced by different oracles, so diff-test262 keys on the
    // (version, lane, fast_rev) tuple. Absent on pre-#3462 rows ⇒ treated as
    // "honest" (backward-compatible; existing honest baselines are unaffected).
    oracle_lane: ORACLE_LANE,
    oracle_fast_rev: ORACLE_LANE === "fast-nativeharness" ? ORACLE_FAST_REV : undefined,
    file,
    category,
    status,
    error: error || undefined,
    error_category: errorCategory,
    error_signature: normalizeErrorSignature(status, errorCategory, error),
    imports: metadata?.imports && metadata.imports.length > 0 ? metadata.imports : undefined,
    host_import_leak_class: metadata?.hostImportLeakClass,
    reached_test: metadata?.reachedTest ?? false,
    // (#2939/#2940) vacuity correction marker (only on `fail` rows it applies to).
    vacuous: metadata?.vacuous || undefined,
    compile_ms: timing?.compileMs !== undefined ? Math.round(timing.compileMs) : undefined,
    exec_ms: timing?.execMs !== undefined ? Math.round(timing.execMs) : undefined,
    scope: scopeInfo?.scope ?? "standard",
    scope_official: scopeInfo?.official ?? true,
    scope_reason: scopeInfo?.reason,
    strict: scopeInfo?.strict ?? "both",
    retried: retryInfo?.retried || undefined,
    retry_count: retryInfo?.retryCount || undefined,
  });
  fdWrite(jsonlFd, entry + "\n");
  summary.total++;
  (summary as any)[status]++;
  if (!catCounts[category]) catCounts[category] = createEmptyCounts();
  (catCounts[category] as any)[status]++;
  catCounts[category].total++;

  if (errorCategory) {
    errorCategoryCounts[errorCategory] = (errorCategoryCounts[errorCategory] || 0) + 1;
  }
  if (status === "skip" && error) {
    skipReasonCounts[error] = (skipReasonCounts[error] || 0) + 1;
  }

  flushCount++;
  if (flushCount % 50 === 0) {
    try {
      fsyncSync(jsonlFd);
    } catch {}
  }

  if (status !== "pass") {
    throw new ConformanceError(status, error || status);
  }
}

// ── Assertion lookup ────────────────────────────────────────────────

function adjustErrorLines(msg: string, offset: number): string {
  if (offset === 0) return msg;
  return msg.replace(/\bL(\d+)(:\d+)?/g, (_m, line, col) => {
    const adjusted = parseInt(line, 10) - offset;
    return `L${adjusted > 0 ? adjusted : 1}${col ?? ""}`;
  });
}

// findNthAssert / extractFullAssert moved to ./test262-assert-locator (#1318):
// shared with the legacy vitest runner and unit-testable without the
// result-file side effects this module performs at import time.

// ── Test generation ─────────────────────────────────────────────────

const TEST262_ROOT = join(import.meta.dirname ?? ".", "..", "test262");

type Test262ChunkTest = {
  category: string;
  durationMs: number;
  filePath: string;
  ordinal: number;
  relPath: string;
};

type Test262ChunkBin = {
  tests: Test262ChunkTest[];
  weightMs: number;
};

function durationOf(relPath: string): number {
  return slowTestDurationMs.get(relPath) ?? DEFAULT_TEST_WEIGHT_MS;
}

function chooseLightestBin(bins: Test262ChunkBin[]): Test262ChunkBin {
  let best = bins[0]!;
  for (let i = 1; i < bins.length; i++) {
    const candidate = bins[i]!;
    if (
      candidate.weightMs < best.weightMs ||
      (candidate.weightMs === best.weightMs && candidate.tests.length < best.tests.length)
    ) {
      best = candidate;
    }
  }
  return best;
}

function assignBalancedChunk(tests: Test262ChunkTest[], chunkIndex: number, totalChunks: number) {
  const bins = Array.from({ length: totalChunks }, () => ({
    tests: [] as Test262ChunkTest[],
    weightMs: 0,
  }));
  const weighted = [...tests].sort((a, b) => b.durationMs - a.durationMs || a.ordinal - b.ordinal);

  for (const test of weighted) {
    const bin = chooseLightestBin(bins);
    bin.tests.push(test);
    bin.weightMs += test.durationMs;
  }

  return bins[chunkIndex]!;
}

/**
 * Register vitest describe/it blocks for this chunk's share of tests.
 *
 * Each it() sends source to a unified fork pool that compiles + executes
 * the test in one process. No separate Phase 1 needed.
 */
export function runTest262Chunk(chunkIndex: number, totalChunks: number) {
  // Build full test list, filtering out proposals unless explicitly included.
  // This avoids registering ~5,200 proposal tests that would be skipped anyway,
  // saving ~10% of run time and keeping the statusline total accurate.
  const includeProposals = process.env.TEST262_INCLUDE_PROPOSALS === "1";
  const allTests: Test262ChunkTest[] = [];
  for (const category of TEST_CATEGORIES) {
    for (const filePath of findTestFiles(category)) {
      // Skip staging/ proposal tests at the file level.
      const relPath = relative(TEST262_ROOT, filePath);
      if (!matchesPathFilter(relPath)) continue;
      if (!includeProposals && (relPath.startsWith("test/staging/") || relPath.startsWith("staging/"))) continue;
      allTests.push({
        category,
        durationMs: durationOf(relPath),
        filePath,
        ordinal: allTests.length,
        relPath,
      });
    }
  }

  const chunk = assignBalancedChunk(allTests, chunkIndex, totalChunks);
  const myTests = chunk.tests;

  // Sort within the shard by descending known duration (slow tests first).
  // Tests absent from `slowTestDurationMs` keep their natural order behind the
  // timed ones (Array.prototype.sort is stable on Node ≥ 12).
  // Effect: a shard's worst-case wall time is dominated by max(timed test)
  // rather than max + sum-of-tail. See tests/test262-slow-tests.json for the
  // source of truth and how to refresh.
  myTests.sort((a, b) => b.durationMs - a.durationMs || a.ordinal - b.ordinal);

  const byCategory = new Map<string, string[]>();
  for (const { category, filePath } of myTests) {
    let arr = byCategory.get(category);
    if (!arr) {
      arr = [];
      byCategory.set(category, arr);
    }
    arr.push(filePath);
  }

  beforeAll(() => {
    // #1957 — realm-contamination canary, default ON. Workers diff a broad
    // intrinsic surface after every test (~0.2ms) and request a recycle when
    // a test actually mutated shared realm state, so the next test gets a
    // pristine process instead of someone else's Array.prototype/JSON/
    // Iterator mutations (the order-dependent flip class that also poisoned
    // the in-realm TS compiler, #1862). Forks inherit this env. Set
    // TEST262_REALM_CANARY="" to disable, or "log" for measurement mode.
    if (!("TEST262_REALM_CANARY" in process.env)) {
      process.env.TEST262_REALM_CANARY = "recycle";
    }
    pool = new CompilerPool(POOL_SIZE, "unified");
    console.log(
      `Chunk ${chunkIndex + 1}/${totalChunks}: ${myTests.length} tests, est ${Math.round(chunk.weightMs / 1000)}s, ${POOL_SIZE} unified fork workers (realm canary: ${process.env.TEST262_REALM_CANARY || "off"})`,
    );
  }, 30_000);

  afterAll(() => {
    try {
      pool?.shutdown();
      pool = null;
    } catch {}
    try {
      closeSync(jsonlFd);
    } catch {}

    const ecEntries = Object.entries(errorCategoryCounts).sort((a, b) => b[1] - a[1]);
    if (ecEntries.length > 0) {
      console.log(`\nError categories:`);
      for (const [cat, count] of ecEntries) {
        console.log(`  ${cat}: ${count}`);
      }
    }

    const skipEntries = Object.entries(skipReasonCounts).sort((a, b) => b[1] - a[1]);
    if (skipEntries.length > 0) {
      console.log(`\nUnsupported features (skipped):`);
      for (const [reason, count] of skipEntries) {
        console.log(`  ${reason}: ${count}`);
      }
    }

    console.log(
      `\nTest262 chunk ${chunkIndex + 1}/${totalChunks}: ${summary.total} total — ${summary.pass} pass, ${summary.fail} fail, ${summary.compile_error} CE, ${summary.skip} skip`,
    );
    if (retriesUsed > 0) {
      console.log(`Compile-timeout retries (#1589): ${retriesUsed}/${MAX_RETRIES_PER_SHARD} used`);
    }
    if (poisonRetriesUsed > 0) {
      console.log(`Poison-error retries (#1862): ${poisonRetriesUsed} used`);
    }

    writeFileSync(
      SHARD_COMPLETION_PATH,
      JSON.stringify(
        {
          chunkIndex,
          chunkTotal: totalChunks,
          registeredTests: myTests.length,
          recordedRows: summary.total,
          target: TEST262_TARGET ?? "gc",
        },
        null,
        2,
      ) + "\n",
    );
  });

  for (const [category, files] of byCategory) {
    // describe.concurrent lets vitest run it() blocks within this describe up
    // to `maxConcurrency` at a time (set in vitest.config.ts). Without it,
    // vitest runs tests sequentially within a describe, starving the
    // CompilerPool of work and stretching runs from ~15 min to 150+ min.
    describe.concurrent(`test262: ${category}`, () => {
      for (const filePath of files) {
        const relPath = relative(TEST262_ROOT, filePath);

        it(
          relPath,
          async () => {
            // #1521 — Path-scoped filter. Applied BEFORE source read / parse /
            // cache lookup so narrowly-scoped PRs skip ~40k tests entirely
            // (no compile, no record, no execution). Empty / unset filter
            // (the default) is a no-op. See `matchesPathFilter` in
            // test262-runner.ts for the matching semantics.
            if (!matchesPathFilter(relPath)) return;

            const source = readFileSync(filePath, "utf-8");
            const meta = parseMeta(source);
            const scopeInfo = classifyTestScope(source, meta, filePath);

            // Don't record proposal tests at all — they inflate JSONL without adding value
            if (!includeProposals && scopeInfo.scope === "proposal") return;

            if (!meta.negative) {
              const filter = shouldSkip(source, meta, filePath);
              if (filter.skip) {
                recordResult(relPath, category, "skip", filter.reason, undefined, scopeInfo);
                return;
              }
            }

            // (#3370) The verdict-bearing runner compiles the literal upstream
            // harness assembly. wrapTest() remains available for targeted
            // compiler diagnostics, but its source rewrites are not a
            // conformance oracle: they can delete checks or turn top-level
            // globals into function locals.
            const harnessAssembly = assembleOriginalHarness(source, meta);
            // (#3461) Fast native-harness oracle (host lane). When active, the
            // worker path below compiles ONLY `bindingShim + body` and runs the
            // harness prefix natively. The in-process FIXTURE path (rare, ~172
            // multi-module tests) keeps the honest whole-assembly compile — it
            // has no native runInContext step — so those rows stay honest even
            // in a fast run. When the flag is off, `nativeAssembly` is null and
            // nothing below diverges from the honest path (AC#2).
            const nativeAssembly = NATIVE_HARNESS_ORACLE ? assembleNativeHarness(source, meta) : null;
            const inferModuleStrictArguments = isModuleGoal(category, meta, source);
            const isNegative =
              meta.negative &&
              (meta.negative.phase === "parse" ||
                meta.negative.phase === "early" ||
                meta.negative.phase === "resolution");
            const isRuntimeNegative = meta.negative?.phase === "runtime";
            let compileSource = harnessAssembly.primary.source;
            let lineAdjustOffset = harnessAssembly.primary.bodyLineOffset;

            // Multi-file compilation for FIXTURE imports (handled in-process)
            const fixtureGraph = resolveFixtureGraph(source, filePath);
            // #3509 — Dynamic fixture metadata alone does not mean this test
            // executes import(). Compiler capability validation rejects eager
            // #3494 cases while allowing an uncalled ordinary closure to reach
            // the test with a host-free runtime trap in its body. Do not turn
            // dynamic fixtures into eager compileMulti inputs.
            if (Object.keys(fixtureGraph.fixtureFiles).length > 0) {
              // Fixture tests are rare — compile in-process
              try {
                const vfiles: Record<string, string> = {
                  ...fixtureGraph.fixtureFiles,
                  [fixtureGraph.entryFile]: compileSource,
                };
                const multiCompile = await getCompileMulti();
                const result = await multiCompile(vfiles, fixtureGraph.entryFile, {
                  skipSemanticDiagnostics: true,
                  target: TEST262_TARGET,
                  inferModuleStrictArguments,
                  // (#3049 C1 / #3123 / #2900) The FIXTURE compile defers
                  // top-level init, exactly like the worker's single-file path
                  // and the worker's own fixture-graph branch
                  // (scripts/test262-worker.mjs `...deferOpt`). Without it the
                  // whole harness assembly runs in the wasm `(start)` section,
                  // i.e. BEFORE `setInstance(instance)` wires the
                  // runtime — and own properties on function objects are not
                  // yet readable, so `assert.sameValue(...)` threw
                  // "sameValue is not a function" in 22 module-code tests and
                  // `assert.throws` in one more. Every OTHER test in the corpus
                  // already ran deferred; this branch was the lone exception,
                  // which is why the whole 204-test fixture bucket looked like
                  // a semantics gap. Measured effect: 31 fail→pass, 0
                  // pass→fail, identical compile_error set.
                  // The historical reason for omitting it — compileMulti
                  // emitting a SECOND `__module_init` export (V8 "Duplicate
                  // export name '__module_init'", the #2835/#2839 queue park) —
                  // was fixed by #3505: the progressively accumulated
                  // dependency-order initializers now retain only the FINAL
                  // `__module_init` export, so the graph is fully wired before
                  // that one initializer runs. Re-verified: no duplicate-export
                  // CompileError across all 204 fixture-graph tests.
                  deferTopLevelInit: true,
                  // (#2932) Without allowJs, TypeScript excludes the `.js`
                  // _FIXTURE root files from the program entirely — their
                  // top-level declarations are never codegen'd and every
                  // import of them resolves to null. Harness-scoped by
                  // decision (lead, 2026-07-02); NOT a compiler default.
                  // NEGATIVE (parse/early/resolution) tests are excluded:
                  // they assert compile-time FAILURE, and allowJs suppresses
                  // the syntax/type-error bail in compileMultiSource — with it
                  // the invalid module "compiles", its raw top-level asserts
                  // execute at instantiation, and the test records fail
                  // (import-attribute-key-string-* flipped pass→fail this way).
                  allowJs: !isNegative,
                });
                const compileRecordMetadata = metadataFromImports(result.imports, false);
                const reachedRecordMetadata = metadataFromImports(result.imports, true);
                if (!result.success || result.binary.length === 0) {
                  if (isNegative) {
                    const errors = result.errors.filter((error: any) => error.severity === "error");
                    const detail = errors.map((error: any) => error.message).join("; ");
                    const codes = errors.map((error: any) => error.code).filter(Boolean);
                    if (negativeCompileErrorMatches(meta.negative!.type, codes, detail)) {
                      recordResult(
                        relPath,
                        category,
                        "pass",
                        undefined,
                        undefined,
                        scopeInfo,
                        undefined,
                        compileRecordMetadata,
                      );
                    } else {
                      recordResult(
                        relPath,
                        category,
                        "compile_error",
                        `expected ${meta.negative!.type} but compiler rejected for an unrelated reason: ${detail || "unknown"}`,
                        undefined,
                        scopeInfo,
                        undefined,
                        compileRecordMetadata,
                      );
                    }
                  } else {
                    const errMsg = result.errors.map((e: any) => `L${e.line}:${e.column} ${e.message}`).join("; ");
                    recordResult(
                      relPath,
                      category,
                      "compile_error",
                      errMsg,
                      undefined,
                      scopeInfo,
                      undefined,
                      compileRecordMetadata,
                    );
                  }
                  return;
                }
                // Execute the compiled binary in-process (fixture tests are rare,
                // in-process execution is acceptable for 172 tests).
                const hostImportError = standaloneHostImportError(TEST262_TARGET, compileRecordMetadata.imports);
                if (hostImportError) {
                  recordResult(
                    relPath,
                    category,
                    "compile_error",
                    hostImportError,
                    undefined,
                    scopeInfo,
                    undefined,
                    compileRecordMetadata,
                  );
                  return;
                }
                const buildImports = await getBuildImports();
                let reachedFixtureTest = false;
                let fixtureInstance: WebAssembly.Instance | undefined;
                const originalHarnessNoThrow = Symbol("originalHarnessNoThrow");
                try {
                  const fixtureOutput: string[] = [];
                  const appendFixtureOutput = (line: string): void => {
                    Reflect.defineProperty(fixtureOutput, fixtureOutput.length, {
                      value: line,
                      writable: true,
                      enumerable: true,
                      configurable: true,
                    });
                  };
                  const consoleProxy = {
                    log: (...values: unknown[]) => appendFixtureOutput(values.map(String).join(" ")),
                    error: (...values: unknown[]) => appendFixtureOutput(values.map(String).join(" ")),
                    warn: (...values: unknown[]) => appendFixtureOutput(values.map(String).join(" ")),
                  };
                  const importObj = buildImports(result.imports, { console: consoleProxy }, result.stringPool, {
                    globalSandbox: createTestSandbox(consoleProxy as unknown as Console),
                  });
                  // (#4162) The fixture-graph lane executes in this process
                  // instead of scripts/test262-worker.mjs. Both go through the
                  // ONE shared instantiate seam, so a fixture that merely
                  // mentions eval/new Function links the same provider tier the
                  // worker would give it — a fresh instance per test, so
                  // interpreter globals never leak between fixtures.
                  const instance = await instantiateTest262Module(result.binary, importObj as any, {
                    target: TEST262_TARGET,
                    providerLabel: RUNTIME_EVAL_PROVIDER_LABEL,
                  });
                  fixtureInstance = instance;
                  (importObj as any).setInstance?.(instance);
                  // (#3049 C1) Deferred top-level init (host lane): run the
                  // exported __module_init now that setInstance has wired the
                  // runtime. Same try as instantiate + test(), so a top-level
                  // throw keeps its pre-defer classification.
                  const moduleInit = (instance.exports as any).__module_init;
                  if (typeof moduleInit === "function") {
                    moduleInit();
                  }
                  reachedFixtureTest = true;

                  // Literal-harness completion is itself the positive verdict;
                  // there is intentionally no synthetic `test` export.
                  if (isNegative) {
                    throw new Error(
                      `expected ${meta.negative!.phase} ${meta.negative!.type} but compilation succeeded`,
                    );
                  }
                  if (isRuntimeNegative) throw originalHarnessNoThrow;
                  if (harnessAssembly.async) {
                    // (#3496) Multi-module fixture tests execute in this
                    // process instead of the unified worker. Mirror the
                    // worker's standalone async handling: the host-free
                    // compiler writes console output to its native sink, not
                    // `consoleProxy`, so drain the Wasm queue and copy that
                    // sink into the same marker buffer before polling.
                    let standaloneDrainError: unknown = null;
                    if (TEST262_TARGET === "standalone") {
                      const exp = instance.exports as Record<string, any>;
                      if (typeof exp.__drain_microtasks === "function") {
                        try {
                          exp.__drain_microtasks();
                        } catch (err) {
                          standaloneDrainError = err;
                        }
                      }
                      if (typeof exp.__stdout_prepare === "function" && typeof exp.__stdout_char === "function") {
                        let length = 0;
                        try {
                          length = exp.__stdout_prepare() | 0;
                        } catch {
                          length = 0;
                        }
                        if (length > 0) {
                          let sink = "";
                          for (let i = 0; i < length; i++) {
                            sink += String.fromCharCode(exp.__stdout_char(i) & 0xffff);
                          }
                          for (const line of sink.split("\n")) {
                            if (line.length > 0) appendFixtureOutput(line);
                          }
                        }
                      }
                    }
                    const marker = (prefix: string) => fixtureOutput.find((line) => line.includes(prefix));
                    const deadline = Date.now() + 1_000;
                    while (
                      Date.now() < deadline &&
                      !marker("Test262:AsyncTestComplete") &&
                      !marker("Test262:AsyncTestFailure")
                    ) {
                      await new Promise((resolveTurn) => setTimeout(resolveTurn, 10));
                    }
                    const failure = marker("Test262:AsyncTestFailure");
                    if (failure) throw new Error(failure);
                    if (!marker("Test262:AsyncTestComplete")) {
                      const detail =
                        standaloneDrainError != null
                          ? `async continuation threw before completion: ${extractWasmExceptionMessage(
                              standaloneDrainError,
                              instance,
                            )}`
                          : "async completion marker not observed";
                      throw new Error(detail);
                    }
                  }
                  recordResult(
                    relPath,
                    category,
                    "pass",
                    undefined,
                    undefined,
                    scopeInfo,
                    undefined,
                    reachedRecordMetadata,
                  );
                  return;
                } catch (execErr: any) {
                  // #3407: recordResult() writes the canonical JSONL row and then
                  // throws a ConformanceError sentinel for any non-pass verdict.
                  // The "pass" record above can be reclassified to compile_error
                  // inside recordResult (standalone host-import leak) and throw
                  // that sentinel INTO this catch. Reclassifying it here would
                  // write a SECOND, contradictory row for the same file. Rethrow
                  // the already-recorded verdict before any classification branch;
                  // the outer guard is defense in depth.
                  if (isRecordedVerdictSentinel(execErr)) throw execErr;
                  const execRecordMetadata = metadataFromImports(result.imports, reachedFixtureTest);
                  if (execErr === originalHarnessNoThrow) {
                    recordResult(
                      relPath,
                      category,
                      "fail",
                      `expected runtime ${meta.negative!.type} but execution succeeded`,
                      undefined,
                      scopeInfo,
                      undefined,
                      execRecordMetadata,
                    );
                  } else if (
                    isRuntimeNegative &&
                    extractWasmExceptionMessage(execErr, fixtureInstance).includes(meta.negative!.type)
                  ) {
                    // A throw from the start function IS the expected runtime
                    // error for a runtime-negative test.
                    recordResult(
                      relPath,
                      category,
                      "pass",
                      undefined,
                      undefined,
                      scopeInfo,
                      undefined,
                      execRecordMetadata,
                    );
                  } else if (isNegative) {
                    // (#2920) STRICT compile-SUCCEEDED arm (fixture path). The
                    // compiler emitted no diagnostic, so the expected
                    // parse/early error was NOT detected at compile time. An
                    // incidental Wasm validation / start-function throw is not
                    // spec-conformant detection => fail (was scored `pass`).
                    // Intentional verdict tightening (plan/issues/2920).
                    const { status, error } = negativeCompileSucceededVerdict(
                      meta.negative!.type,
                      meta.negative!.phase,
                    );
                    recordResult(relPath, category, status, error, undefined, scopeInfo, undefined, execRecordMetadata);
                  } else {
                    recordResult(
                      relPath,
                      category,
                      "fail",
                      String(execErr),
                      undefined,
                      scopeInfo,
                      undefined,
                      execRecordMetadata,
                    );
                  }
                }
              } catch (e: any) {
                // #1221/#3407: recordResult() throws a ConformanceError after
                // writing the JSONL row whenever status !== "pass". If we
                // catch THAT and call recordResult again, we double-write
                // the row (e.g. a "fail" row followed by a "compile_error"
                // row prefixed "[fail] …"). Re-throw so the inner record
                // is the only JSONL entry, matching the non-FIXTURE path
                // which has no outer catch. Shared guard with the inner catch
                // so both catches apply one identical duplicate policy.
                if (isRecordedVerdictSentinel(e)) throw e;
                recordResult(
                  relPath,
                  category,
                  "compile_error",
                  e.message ?? String(e),
                  undefined,
                  scopeInfo,
                  undefined,
                  { reachedTest: false },
                );
              }
              return;
            }

            // ── Normal path: unified compile+execute in fork ────────
            // Cache disabled — stale cache entries caused false baselines.
            // Every test is compiled and executed fresh each run.
            const wasmPath = "";
            const metaPath = "";
            // (#3461) In fast native-harness mode the worker compiles ONLY
            // `bindingShim + body` and runs `harnessPrefix` natively. The prefix
            // is strict-neutral (identical for the primary and strict-rerun
            // variants), so a single `nativeHarnessOpts` object carries it to all
            // run sites, including the poison/timeout retries. When the flag is
            // off, `nativeAssembly` is null → `nativeHarnessOpts` is empty and the
            // opts objects are byte-identical to the honest path (AC#2).
            const nativeHarnessOpts: { nativeHarness?: boolean; harnessPrefix?: string } = nativeAssembly
              ? { nativeHarness: true, harnessPrefix: nativeAssembly.primary.harnessPrefix }
              : {};
            if (nativeAssembly) {
              compileSource = nativeAssembly.primary.bindingShim + nativeAssembly.primary.body;
              lineAdjustOffset = nativeAssembly.primary.bodyLineOffset;
            }
            const runHarnessSource = (variantSource: string, label: string) =>
              pool!.runTest(
                variantSource,
                {
                  isNegative: isNegative || false,
                  isRuntimeNegative: isRuntimeNegative || false,
                  expectedErrorType: meta.negative?.type,
                  originalHarness: true,
                  asyncTest: harnessAssembly.async,
                  wasmPath,
                  metaPath,
                  label,
                  target: TEST262_TARGET,
                  inferModuleStrictArguments,
                  ...nativeHarnessOpts,
                },
                30_000,
              );

            let r = await runHarnessSource(compileSource, relPath);
            if (r.status === "pass" && harnessAssembly.strictRerun) {
              const primaryCompileMs = r.compileMs ?? 0;
              const primaryExecMs = r.execMs ?? 0;
              compileSource = nativeAssembly?.strictRerun
                ? nativeAssembly.strictRerun.bindingShim + nativeAssembly.strictRerun.body
                : harnessAssembly.strictRerun.source;
              lineAdjustOffset = nativeAssembly?.strictRerun
                ? nativeAssembly.strictRerun.bodyLineOffset
                : harnessAssembly.strictRerun.bodyLineOffset;
              const strictResult = await runHarnessSource(compileSource, `${relPath} [strict rerun]`);
              r = {
                ...strictResult,
                ...(strictResult.status === "pass"
                  ? {}
                  : { error: `strict rerun: ${strictResult.error ?? strictResult.status}` }),
                compileMs: primaryCompileMs + (strictResult.compileMs ?? 0),
                execMs: primaryExecMs + (strictResult.execMs ?? 0),
              };
            }

            const timing = { compileMs: r.compileMs, execMs: r.execMs };

            // Map worker result to recordResult
            if (r.status === "pass") {
              recordResult(
                relPath,
                category,
                "pass",
                undefined,
                timing,
                scopeInfo,
                undefined,
                metadataFromWorkerResult(r, true),
              );
              return;
            }

            if (
              r.status === "compile_error" ||
              r.status === "compile_timeout" ||
              (r.status === "fail" && isPoisonCompileError(r.error))
            ) {
              // #1862 — a poison-class compile_error from the unified worker
              // is a contaminated verdict. The worker requests a recycle
              // before the pool dispatches more work; retry this file once in
              // a clean fork and record only the clean retry result.
              // #1957 — the same poison signature can arrive with
              // status="fail" ("wasm exception during compile (poisoned
              // built-in)" is sent as fail, not compile_error), which used to
              // bypass this retry entirely. Both statuses are contaminated
              // verdicts; retry both.
              if ((r.status === "compile_error" || r.status === "fail") && isPoisonCompileError(r.error)) {
                poisonRetriesUsed++;
                const retry = await runRetrySerial(() =>
                  pool!.runTest(
                    compileSource,
                    {
                      isNegative: isNegative || false,
                      isRuntimeNegative: isRuntimeNegative || false,
                      expectedErrorType: meta.negative?.type,
                      originalHarness: true,
                      asyncTest: harnessAssembly.async,
                      wasmPath,
                      metaPath,
                      label: relPath + " [poison retry]",
                      target: TEST262_TARGET,
                      inferModuleStrictArguments,
                      ...nativeHarnessOpts,
                    },
                    RETRY_TIMEOUT_MS,
                  ),
                );
                const retryTiming = { compileMs: retry.compileMs, execMs: retry.execMs };
                const retryInfo = { retried: true, retryCount: 1 };

                if (retry.status === "pass") {
                  recordResult(
                    relPath,
                    category,
                    "pass",
                    undefined,
                    retryTiming,
                    scopeInfo,
                    retryInfo,
                    metadataFromWorkerResult(retry, true),
                  );
                  return;
                }
                if (retry.status === "fail") {
                  const error = retry.error ? adjustErrorLines(retry.error, lineAdjustOffset) : "fail after retry";
                  recordResult(
                    relPath,
                    category,
                    "fail",
                    error,
                    retryTiming,
                    scopeInfo,
                    retryInfo,
                    metadataFromWorkerResult(retry, true),
                  );
                  return;
                }

                const retryError = retry.error ? adjustErrorLines(retry.error, lineAdjustOffset) : retry.status;
                recordResult(
                  relPath,
                  category,
                  retry.status,
                  retryError,
                  retryTiming,
                  scopeInfo,
                  retryInfo,
                  metadataFromWorkerResult(retry, false),
                );
                return;
              }

              // #1589 — auto-retry compile_timeout in isolation. Most CI
              // timeouts are fork-pool contention flakes that pass in <300 ms
              // when not competing with siblings. Retry once with a tighter
              // 10 s ceiling, serialized via a per-shard mutex. Capped at
              // MAX_RETRIES_PER_SHARD so a broken pool doesn't blow up the
              // shard's wall time.
              if (r.status === "compile_timeout" && retriesUsed < MAX_RETRIES_PER_SHARD) {
                retriesUsed++;
                const retry = await runRetrySerial(() =>
                  pool!.runTest(
                    compileSource,
                    {
                      isNegative: isNegative || false,
                      isRuntimeNegative: isRuntimeNegative || false,
                      expectedErrorType: meta.negative?.type,
                      originalHarness: true,
                      asyncTest: harnessAssembly.async,
                      wasmPath,
                      metaPath,
                      label: relPath + " [retry]",
                      target: TEST262_TARGET,
                      inferModuleStrictArguments,
                      ...nativeHarnessOpts,
                    },
                    RETRY_TIMEOUT_MS,
                  ),
                );
                const retryTiming = { compileMs: retry.compileMs, execMs: retry.execMs };
                const retryInfo = { retried: true, retryCount: 1 };

                if (retry.status === "pass") {
                  recordResult(
                    relPath,
                    category,
                    "pass",
                    undefined,
                    retryTiming,
                    scopeInfo,
                    retryInfo,
                    metadataFromWorkerResult(retry, true),
                  );
                  return;
                }
                if (retry.status === "fail") {
                  // Retry executed but assertions failed — record as a real
                  // fail with the retry error message (preserves the new
                  // signal rather than the timeout-shaped one).
                  const error = retry.error ? adjustErrorLines(retry.error, lineAdjustOffset) : "fail after retry";
                  recordResult(
                    relPath,
                    category,
                    "fail",
                    error,
                    retryTiming,
                    scopeInfo,
                    retryInfo,
                    metadataFromWorkerResult(retry, true),
                  );
                  return;
                }
                // compile_error or another compile_timeout on retry → record
                // the retry status (with retried flag) so we can distinguish
                // genuine-slow tests from flakes in baseline analysis.
                const retryError = retry.error ? adjustErrorLines(retry.error, lineAdjustOffset) : retry.status;
                recordResult(
                  relPath,
                  category,
                  retry.status,
                  retryError,
                  retryTiming,
                  scopeInfo,
                  retryInfo,
                  metadataFromWorkerResult(retry, false),
                );
                return;
              }

              const error = r.error ? adjustErrorLines(r.error, lineAdjustOffset) : r.status;
              recordResult(
                relPath,
                category,
                r.status,
                error,
                timing,
                scopeInfo,
                undefined,
                metadataFromWorkerResult(r, false),
              );
              return;
            }

            if (r.status === "fail") {
              let error = r.error || "unknown failure";

              // Enrich error with source context
              if (r.isException) {
                const fnMatch = error.match(/\[in (\w+)\(\)\]/);
                if (fnMatch) {
                  const fname = fnMatch[1];
                  if (fname !== "test") {
                    const lines = source.split("\n");
                    for (let i = 0; i < lines.length; i++) {
                      if (lines[i].includes(`function ${fname}`) || lines[i].includes(`${fname}(`)) {
                        const ctx = lines[i].trim().substring(0, 80);
                        error = error.replace(`[in ${fname}()]`, `[in ${fname}() at L${i + 1}: ${ctx}]`);
                        break;
                      }
                    }
                  }
                }
                const desc = meta.description?.substring(0, 100) ?? "";
                if (/TypeError \(null\/undefined/.test(error) && desc) {
                  error = `${error}: ${desc}`;
                }
              }

              if (r.runtimeNegativeNoThrow) {
                error = `expected runtime ${meta.negative!.type} but succeeded`;
              }

              if (r.ret !== undefined && r.ret !== 1 && !r.isException && !r.runtimeNegativeNoThrow) {
                if (r.ret === -262 || (r as { vacuous?: boolean }).vacuous) {
                  // (#2939/#2940) keep the vacuity message (not "returned -262").
                  error = "vacuous: harness-wrapper callback never executed (#2940) — no assertion ran";
                } else if (r.ret === -1) {
                  const desc = meta.description?.substring(0, 100) ?? "";
                  const throwsMatch = source.match(/assert\.throws\s*\(\s*(\w+Error)/);
                  const expectedErr = throwsMatch ? throwsMatch[1] : null;
                  let context = desc || "exception in test body";
                  if (expectedErr) context = `expected ${expectedErr} — ${context}`;
                  error = `returned -1 — ${context}`;
                } else {
                  error = `returned ${r.ret} — ${findNthAssert(source, r.ret)}`;
                }
              }

              recordResult(
                relPath,
                category,
                "fail",
                error,
                timing,
                scopeInfo,
                undefined,
                metadataFromWorkerResult(r, true),
              );
              return;
            }

            // Fallback
            recordResult(
              relPath,
              category,
              r.status || "fail",
              r.error || "unknown",
              timing,
              scopeInfo,
              undefined,
              metadataFromWorkerResult(r, false),
            );
          },
          IT_TIMEOUT_MS,
        );
      }
    });
  }
}
