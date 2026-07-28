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
// no need to duplicate that logic) and adds ONE new thing on top: a
// head-to-head perf comparison of the compiled Wasm export against the SAME
// pinned package running natively under Node — a real npm package, not a
// synthetic micro-benchmark (contrast the playground sidebar, which compares
// Wasm against the SAME source transpiled straight to JS).
//
// Scope: only the packages with a real, committed, reproducible dogfood
// harness (acorn, marked, clsx, cookie). mustache/diff/dayjs were probed
// ad-hoc (see their issue files, #3720/#3721/#3747) but have no committed
// harness yet — deliberately NOT included here rather than fabricating
// numbers from a one-off, non-reproducible probe.
//
// Invoke: `pnpm run generate:npm-compat` (writes benchmarks/results/npm-compat.json
// and copies it to website/public/benchmarks/results/).

import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

import { compile } from "../src/index.ts";
import { wrapExports } from "../src/runtime.ts";

import { runHarness as runAcorn } from "../tests/dogfood/acorn-harness.mjs";
import { runHarness as runAcornOfficialSuite } from "../tests/dogfood/acorn-official-suite.mjs";
import { runHarness as runMarked } from "../tests/dogfood/marked-harness.mjs";
import { runHarness as runClsx } from "../tests/dogfood/clsx-harness.mjs";
import { runHarness as runCookie } from "../tests/dogfood/cookie-harness.mjs";

import { setupAcorn } from "../tests/dogfood/setup-acorn.mjs";
import { setupClsx } from "../tests/dogfood/setup-clsx.mjs";
import { setupCookie } from "../tests/dogfood/setup-cookie.mjs";
import { CLSX_OPS } from "../tests/dogfood/clsx-ops.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "npm-compat.json");
const PUBLIC_PATH = resolve(ROOT, "website", "public", "benchmarks", "results", "npm-compat.json");
// Sibling artifact in the EXACT row shape `<perf-benchmark-chart mode="perf">`
// consumes (name / wasmUs / jsUs / ratioStd), so the npm-compat page reuses the
// landing page's own chart component instead of re-implementing a bar chart.
// `jsUs` is the native-Node time — the component's baseline tick.
const PERF_RESULTS_PATH = resolve(ROOT, "benchmarks", "results", "npm-compat-perf.json");
const PERF_PUBLIC_PATH = resolve(ROOT, "website", "public", "benchmarks", "results", "npm-compat-perf.json");

// ---------------------------------------------------------------------------
// Perf timing helpers — same calibrated-median methodology as
// generate-playground-benchmark-sidebar.mjs (2 warmup + 9 measured rounds).
// ---------------------------------------------------------------------------
function calibrate(fn) {
  let iters = 0;
  const t0 = performance.now();
  while (performance.now() - t0 < 100) {
    fn();
    iters++;
  }
  return Math.max(5, Math.ceil((iters / 100) * 300));
}

function timeIt(fn, iters) {
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) fn();
  return performance.now() - t0;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function stddev(values) {
  if (values.length <= 1) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

/**
 * Head-to-head timing: wasmFn vs nodeFn, same op, same inputs (baked into
 * each closure by the caller). Returns median microseconds/call for both
 * sides plus their stddev, and `ratio` = nodeUs / wasmUs (>1 means the
 * compiled Wasm export is faster than the real package running natively
 * under Node; <1 means Node is faster).
 */
function measurePerf(sampleOp, wasmFn, nodeFn) {
  for (let i = 0; i < 20; i++) {
    wasmFn();
    nodeFn();
  }
  const iters = calibrate(wasmFn);
  const warmupRounds = 2;
  const measuredRounds = 9;
  for (let i = 0; i < warmupRounds; i++) {
    timeIt(wasmFn, iters);
    timeIt(nodeFn, iters);
  }
  const wasmSamplesUs = [];
  const nodeSamplesUs = [];
  for (let i = 0; i < measuredRounds; i++) {
    wasmSamplesUs.push((timeIt(wasmFn, iters) / iters) * 1000);
    nodeSamplesUs.push((timeIt(nodeFn, iters) / iters) * 1000);
  }
  const wasmUs = median(wasmSamplesUs);
  const nodeUs = median(nodeSamplesUs);
  // Per-round ratio samples so the shared <perf-benchmark-chart> can draw the
  // same error bar it draws for the landing-page sidebar.
  const ratioSamples = wasmSamplesUs.map((w, i) => (nodeSamplesUs[i] ?? nodeUs) / Math.max(w, 0.000001));
  return {
    sampleOp,
    wasmUs,
    nodeUs,
    wasmStdUs: stddev(wasmSamplesUs),
    nodeStdUs: stddev(nodeSamplesUs),
    ratio: nodeUs / Math.max(wasmUs, 0.000001),
    ratioStd: stddev(ratioSamples),
    warmupRounds,
    measuredRounds,
  };
}

// ---------------------------------------------------------------------------
// Per-package perf probes — each returns a `measurePerf(...)` result or null
// if the package doesn't validate/run (perf is meaningless on a red surface).
// ---------------------------------------------------------------------------
async function perfAcorn() {
  const { entryModulePath } = setupAcorn();
  const source = readFileSync(entryModulePath, "utf-8");
  // optimize: 4 — perf numbers must reflect a realistic (wasm-opt'd) deployment,
  // not the debug-friendly unoptimized binary the correctness harnesses use.
  const result = await compile(source, { fileName: "acorn.mjs", skipSemanticDiagnostics: true, optimize: 4 });
  if (!result.success || !result.binary?.length) return null;
  const importObject = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  const exp = wrapExports(instance.exports, { signatures: result.exportSignatures });
  if (typeof exp.parse !== "function") return null;

  const oracleMod = await import(pathToFileURL(entryModulePath).href);
  // Self-hosting sample: parse acorn's own ~6,300-line dist bundle — a real,
  // deterministic, decently-sized workload rather than a synthetic snippet.
  const parseOptions = { ecmaVersion: 2022, sourceType: "module" };
  return measurePerf(
    `parse(own ${Math.round(source.length / 1024)}KB dist bundle)`,
    () => exp.parse(source, parseOptions),
    () => oracleMod.parse(source, parseOptions),
  );
}

async function perfClsx() {
  const { entryModulePath } = setupClsx();
  const clsxSource = readFileSync(entryModulePath, "utf-8");
  // Reuse one already-verified-equal op (see clsx-harness.mjs) as the
  // representative perf workload — comparing timings on an op we've already
  // confirmed produces IDENTICAL output keeps the comparison meaningful.
  const op = CLSX_OPS.find((o) => o.name === "op_mixed_all_kinds");
  const epilogue = `export function ${op.name}() {\n${op.code}\n}\n`;
  const result = await compile(clsxSource + "\n" + epilogue, {
    fileName: "clsx.mjs",
    skipSemanticDiagnostics: true,
    optimize: 4,
  });
  if (!result.success || !result.binary?.length) return null;
  const importObject = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  const exp = wrapExports(instance.exports, { signatures: result.exportSignatures });
  if (typeof exp[op.name] !== "function") return null;

  const cjsEntryPath = entryModulePath.replace(/\/clsx\.mjs$/, "/clsx.js");
  const { createRequire } = await import("node:module");
  const nativeClsx = createRequire(import.meta.url)(cjsEntryPath).clsx;
  const nodeFn = new Function("clsx", op.code);

  return measurePerf(
    op.name,
    () => exp[op.name](),
    () => nodeFn(nativeClsx),
  );
}

async function perfCookie() {
  const { entryModulePath } = setupCookie();
  const cookieSource = readFileSync(entryModulePath, "utf-8");
  const result = await compile(cookieSource, { fileName: "index.js", skipSemanticDiagnostics: true, optimize: 4 });
  if (!result.success || !result.binary?.length) return null;
  const importObject = result.importObject ?? {};
  const { instance } = await WebAssembly.instantiate(result.binary, importObject);
  importObject.__setExports?.(instance.exports);
  const exp = wrapExports(instance.exports, { signatures: result.exportSignatures });
  if (typeof exp.parseCookie !== "function") return null;

  const nativeModule = await import(pathToFileURL(entryModulePath).href);
  // A heavier, realistic multi-attribute Cookie header (8 pairs) rather than
  // the harness's minimal correctness fixtures.
  const header = "a=1; b=2; c=3; d=4; e=5; f=6; g=7; h=8";
  return measurePerf(
    "parseCookie(8-pair header)",
    () => exp.parseCookie(header),
    () => nativeModule.parseCookie(header),
  );
}

// ---------------------------------------------------------------------------
// Assemble
// ---------------------------------------------------------------------------
function knownBugsFor(name) {
  const map = {
    acorn: [
      {
        issue: 3756,
        summary:
          "parse() is ~400-500x slower than native at real-file scale — a large constant-factor gap (flat ~60us/byte), likely method-dispatch overhead",
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

console.log("[npm-compat] acorn — compile/validate/diff + official test suite (this takes ~1 min)...");
const acornReport = await runAcorn({ quiet: true });
const acornSuite = await runAcornOfficialSuite({ quiet: true });
const acornPerf = await perfAcorn();

console.log("[npm-compat] marked — compile/validate/diff...");
const markedReport = await runMarked({ quiet: true });

console.log("[npm-compat] clsx — compile/validate/diff + perf...");
const clsxReport = await runClsx({ quiet: true });
const clsxPerf = await perfClsx();

console.log("[npm-compat] cookie — compile/validate/diff + perf...");
const cookieReport = await runCookie({ quiet: true });
const cookiePerf = await perfCookie();

const packages = await Promise.all([
  buildPackageEntry({
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
  buildPackageEntry({
    name: "marked",
    version: markedReport.marked.version,
    issue: 3716,
    entryFile: markedReport.marked.entryModule.replace(/^package\//, ""),
    shape: "esm-direct",
    report: markedReport,
    tests: null,
    perf: null,
  }),
  buildPackageEntry({
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
  buildPackageEntry({
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
]);

const summary = {
  generatedAt: new Date().toISOString(),
  note: "Only packages with a committed, reproducible tests/dogfood/*-harness.mjs are listed. mustache (#3720), diff (#3721), and dayjs (#3747) were probed ad-hoc and surfaced real bugs but have no committed harness yet.",
  packages,
};

mkdirSync(dirname(RESULTS_PATH), { recursive: true });
writeFileSync(RESULTS_PATH, JSON.stringify(summary, null, 2) + "\n");
mkdirSync(dirname(PUBLIC_PATH), { recursive: true });
copyFileSync(RESULTS_PATH, PUBLIC_PATH);
console.log(`[npm-compat] wrote ${RESULTS_PATH}`);
console.log(`[npm-compat] wrote ${PUBLIC_PATH}`);

// Perf rows for the shared <perf-benchmark-chart>. Only packages with a real
// measurement appear — a package whose surface is red has no honest bar to draw.
const perfRows = packages
  .filter((p) => p.perf)
  .map((p) => ({
    name: p.name,
    path: p.entryFile,
    wasmUs: p.perf.wasmUs,
    jsUs: p.perf.nodeUs,
    wasmStdUs: p.perf.wasmStdUs,
    jsStdUs: p.perf.nodeStdUs,
    ratioStd: p.perf.ratioStd ?? 0,
    wasmOptimized: true,
    wasmOptimizeLevel: 4,
    warmupRounds: p.perf.warmupRounds,
    measuredRounds: p.perf.measuredRounds,
    sampleOp: p.perf.sampleOp,
  }));
writeFileSync(PERF_RESULTS_PATH, JSON.stringify(perfRows, null, 2) + "\n");
copyFileSync(PERF_RESULTS_PATH, PERF_PUBLIC_PATH);
console.log(`[npm-compat] wrote ${PERF_RESULTS_PATH}`);
console.log(`[npm-compat] wrote ${PERF_PUBLIC_PATH}`);
