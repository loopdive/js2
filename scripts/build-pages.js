#!/usr/bin/env node

import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const WEBSITE = join(ROOT, "website");
const PLAYGROUND_DIST = join(ROOT, "dist", "playground");
const PAGES_DIST = join(ROOT, "dist", "pages");
const DASHBOARD_DIR = join(WEBSITE, "dashboard");
const PLAN_DIR = join(ROOT, "plan");
const BENCHMARKS_RESULTS_DIR = join(ROOT, "benchmarks", "results");
const PUBLIC_BENCH = join(WEBSITE, "public", "benchmarks", "results");
const RUNS_DIR = join(BENCHMARKS_RESULTS_DIR, "runs");
const PLAYGROUND_DATA_DIR = join(PAGES_DIST, "playground-data");
const PLAYGROUND_APP_DATA_DIR = join(PAGES_DIST, "playground", "playground-data");
const PLAYGROUND_BENCHMARKS_RESULTS_DIR = join(PAGES_DIST, "playground", "benchmarks", "results");
const TEST262_REPO_ROOT = join(ROOT, "test262");
const PLAYGROUND_EXAMPLES_DIR = join(WEBSITE, "playground", "examples");
const EQUIV_DIR = join(ROOT, "tests", "equivalence");
const TS_WASM_EQUIV_FILE = join(ROOT, "tests", "ts-wasm-equivalence.test.ts");

function ensureExists(path) {
  if (!existsSync(path)) {
    throw new Error(`Required path does not exist: ${path}`);
  }
}

function copyFile(source, destination) {
  ensureExists(source);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(realpathSync(source), destination);
}

function copyDirectory(source, destination) {
  ensureExists(source);
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, {
    recursive: true,
    dereference: true,
  });
}

function copyDirectoryIfExists(source, destination) {
  if (!existsSync(source)) return false;
  copyDirectory(source, destination);
  return true;
}

function copyFileIfExists(source, destination) {
  if (!existsSync(source)) return false;
  copyFile(source, destination);
  return true;
}

function latestMatchingFile(dir, suffix) {
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter((name) => name.endsWith(suffix))
    .sort();
  if (matches.length === 0) return null;
  return join(dir, matches[matches.length - 1]);
}

function latestNamedFile(dir, prefix, suffix) {
  if (!existsSync(dir)) return null;
  const matches = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort();
  if (matches.length === 0) return null;
  return join(dir, matches[matches.length - 1]);
}

function resolvePreferredFile(primarySource, ...fallbackSources) {
  if (existsSync(primarySource)) return primarySource;
  for (const fallbackSource of fallbackSources) {
    if (fallbackSource && existsSync(fallbackSource)) return fallbackSource;
  }
  throw new Error(`Required path does not exist: ${primarySource}`);
}

function resolvePreferredFileOrNull(primarySource, ...fallbackSources) {
  if (existsSync(primarySource)) return primarySource;
  for (const fallbackSource of fallbackSources) {
    if (fallbackSource && existsSync(fallbackSource)) return fallbackSource;
  }
  return null;
}

function writeJson(destination, value) {
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, JSON.stringify(value));
}

function collectFiles(dir, predicate, files = []) {
  if (!existsSync(dir)) return files;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(full, predicate, files);
    else if (predicate(entry.name, full)) files.push(full);
  }
  return files.sort();
}

function normalizeSnippet(source) {
  const lines = source.split("\n");
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  if (nonEmpty.length === 0) return source.trim();
  const minIndent = Math.min(...nonEmpty.map((line) => line.match(/^(\s*)/)?.[1].length ?? 0));
  return lines
    .map((line) => line.slice(minIndent))
    .join("\n")
    .trim();
}

function extractEquivTestsFromFile(filePath) {
  const content = readFileSync(filePath, "utf-8");
  const tests = [];
  const itRegex = /it\("([^"]+)"[\s\S]*?(?:compileToWasm|assertEquivalent)\(\s*`([\s\S]*?)`/g;
  let match;
  while ((match = itRegex.exec(content)) !== null) {
    tests.push({
      name: match[1],
      source: normalizeSnippet(match[2]),
    });
  }
  return tests;
}

function buildEquivTests() {
  const files = [];
  if (existsSync(TS_WASM_EQUIV_FILE)) files.push(TS_WASM_EQUIV_FILE);
  files.push(...collectFiles(EQUIV_DIR, (name) => name.endsWith(".test.ts")));
  return files.flatMap((filePath) => extractEquivTestsFromFile(filePath));
}

function buildStaticTest262Data(resultsJsonlPath) {
  const categorySummaries = new Map();
  const filesByCategory = new Map();
  const resultsByCategory = new Map();
  const copiedFiles = new Set();

  const lines = readFileSync(resultsJsonlPath, "utf-8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const category = entry.category;
    const file = entry.file;
    if (!category || !file) continue;

    if (!filesByCategory.has(category)) filesByCategory.set(category, new Set());
    filesByCategory.get(category).add(file);

    if (!resultsByCategory.has(category)) resultsByCategory.set(category, []);
    resultsByCategory.get(category).push({
      file,
      status: entry.status,
      error: entry.error,
    });

    const normalizedFile = file.startsWith("test/") ? file : `test/${file}`;
    const src = join(TEST262_REPO_ROOT, normalizedFile);
    if (!copiedFiles.has(file) && existsSync(src) && statSync(src).isFile()) {
      copyFile(src, join(PAGES_DIST, "test262", normalizedFile));
      copiedFiles.add(file);
    }
  }

  for (const [category, files] of filesByCategory) {
    categorySummaries.set(category, {
      name: category,
      path: category,
      fileCount: files.size,
    });
  }

  const categories = [...categorySummaries.values()].sort((a, b) => a.name.localeCompare(b.name));
  const filesJson = Object.fromEntries(
    [...filesByCategory.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, files]) => [category, [...files].sort()]),
  );
  const resultsJson = Object.fromEntries([...resultsByCategory.entries()].sort(([a], [b]) => a.localeCompare(b)));

  return {
    categories: { categories },
    filesJson,
    resultsJson,
  };
}

function buildStaticTest262DataFromReport(reportPath) {
  const report = JSON.parse(readFileSync(reportPath, "utf-8"));
  const categories = Array.isArray(report.categories)
    ? report.categories
        .map((entry) => ({
          name: entry.name,
          path: entry.name,
          fileCount: 0,
        }))
        .sort((a, b) => a.name.localeCompare(b.name))
    : [];

  return {
    categories: { categories },
    filesJson: {},
    resultsJson: {},
  };
}

ensureExists(PLAYGROUND_DIST);
const hasDashboardBundle =
  existsSync(join(DASHBOARD_DIR, "index.html")) &&
  existsSync(join(DASHBOARD_DIR, "data")) &&
  existsSync(join(DASHBOARD_DIR, "data.js"));
// issues-graph.html and graph-data.json live in public/ — Vite copies them
// into playground-dist automatically, so they're already in PAGES_DIST.

rmSync(PAGES_DIST, { recursive: true, force: true });
mkdirSync(PAGES_DIST, { recursive: true });

// Start from the Vite multi-page build, which now includes the landing page
// at / and the playground at /playground/.
copyDirectory(PLAYGROUND_DIST, PAGES_DIST);
copyDirectory(PLAYGROUND_EXAMPLES_DIR, join(PAGES_DIST, "examples"));

// Static "Get started" docs page (public — always published, unlike the
// dashboard which is gated behind private planning artifacts). It is a
// self-contained HTML page that references the shared /components/site-nav.js
// copied below, so no Vite processing is required.
copyFile(join(WEBSITE, "getting-started", "index.html"), join(PAGES_DIST, "getting-started", "index.html"));

// Static blog page — same pattern as "Get started" above: a self-contained
// HTML page that references the shared /components/site-nav.js, not a Vite
// entry point.
copyFile(join(WEBSITE, "blog", "index.html"), join(PAGES_DIST, "blog", "index.html"));

// Static whitepaper page — self-contained styled HTML, same pattern as the
// "Get started" and blog pages above — EXCEPT (#3260) the conformance figures
// + report date are substituted at build time from the committed, promote-
// baseline-refreshed summaries, so the public whitepaper can never rot behind
// the live numbers again (it sat at 73.5% for two months while the real number
// climbed to 76.5%). Sources (both in-repo, both refreshed on every push to
// main by test262-sharded.yml):
//   - JS-host lane:    benchmarks/results/test262-current.json (official_summary)
//   - Standalone lane: benchmarks/results/test262-standalone-highwater.json
//     (official_pass/official_total — the reviewed host-free floor, #3322)
// The SOURCE whitepaper.{html,md} carry {{TOKENS}}, never baked figures.
{
  const fmt = (n) => n.toLocaleString("en-US");
  const cur = JSON.parse(readFileSync(join(ROOT, "benchmarks", "results", "test262-current.json"), "utf8"));
  const hostPass = cur.official_summary?.pass ?? cur.summary?.pass;
  const hostTotal = cur.official_summary?.total ?? cur.summary?.total;
  const sa = JSON.parse(readFileSync(join(ROOT, "benchmarks", "results", "test262-standalone-highwater.json"), "utf8"));
  const saPass = sa.official_pass ?? sa.pass;
  const saTotal = sa.official_total ?? hostTotal;
  const reportDate = new Date(cur.baseline_generated_at ?? cur.timestamp ?? Date.now()).toISOString().slice(0, 10);
  const subst = (text) =>
    text
      .replaceAll("{{TEST262_PCT}}", ((hostPass / hostTotal) * 100).toFixed(1))
      .replaceAll("{{TEST262_PASS}}", fmt(hostPass))
      .replaceAll("{{TEST262_TOTAL}}", fmt(hostTotal))
      .replaceAll("{{STANDALONE_PCT}}", ((saPass / saTotal) * 100).toFixed(1))
      .replaceAll("{{STANDALONE_PASS}}", fmt(saPass))
      .replaceAll("{{REPORT_DATE}}", reportDate);
  const wpHtml = subst(readFileSync(join(WEBSITE, "docs", "whitepaper.html"), "utf8"));
  mkdirSync(join(PAGES_DIST, "docs"), { recursive: true });
  writeFileSync(join(PAGES_DIST, "docs", "whitepaper.html"), wpHtml);
  // Emit the substituted .md alongside (single tokenized source, two rendered
  // artifacts — the repo copy keeps tokens so it never re-stales).
  const wpMd = subst(readFileSync(join(WEBSITE, "docs", "whitepaper.md"), "utf8"));
  writeFileSync(join(PAGES_DIST, "docs", "whitepaper.md"), wpMd);
}

// Overwrite Vite-built report pages with the latest public/ versions (which include
// web components like <t262-donut> that Vite doesn't process).
const PUBLIC_REPORT = join(WEBSITE, "public", "benchmarks", "results", "report.html");
const PUBLIC_REPORT_SHORT = join(WEBSITE, "public", "benchmarks", "report.html");
copyFileIfExists(PUBLIC_REPORT, join(PAGES_DIST, "benchmarks", "results", "report.html"));
copyFileIfExists(PUBLIC_REPORT_SHORT, join(PAGES_DIST, "benchmarks", "report.html"));

// npm package compatibility page (scripts/generate-npm-compat-report.mjs) —
// same overwrite-Vite pattern as report.html above, since it also uses a
// <npm-compat-chart> web component Vite doesn't process. The data JSON
// prefers the canonical benchmarks/results/ copy, falling back to the
// website/public/ mirror, matching history.json/latest.json below.
copyFileIfExists(join(WEBSITE, "public", "npm-compat.html"), join(PAGES_DIST, "npm-compat.html"));
const npmCompatSource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "npm-compat.json"),
  join(PUBLIC_BENCH, "npm-compat.json"),
);
if (npmCompatSource) {
  copyFile(npmCompatSource, join(PAGES_DIST, "benchmarks", "results", "npm-compat.json"));
}
// Sibling perf rows consumed by the shared <perf-benchmark-chart> on that page.
const npmCompatPerfSource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "npm-compat-perf.json"),
  join(PUBLIC_BENCH, "npm-compat-perf.json"),
);
if (npmCompatPerfSource) {
  copyFile(npmCompatPerfSource, join(PAGES_DIST, "benchmarks", "results", "npm-compat-perf.json"));
}
const npmCompatHistorySource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "npm-compat-history.json"),
  join(PUBLIC_BENCH, "npm-compat-history.json"),
);
if (npmCompatHistorySource) {
  copyFile(npmCompatHistorySource, join(PAGES_DIST, "benchmarks", "results", "npm-compat-history.json"));
}

// Add the static dashboard route and pre-generated dashboard data when the
// private planning artifacts are present. Public exports intentionally omit
// them.
if (hasDashboardBundle) {
  copyFile(join(DASHBOARD_DIR, "index.html"), join(PAGES_DIST, "dashboard", "index.html"));
  // issue.html is the detail page every kanban card links to
  // (issue.html?slug=…); without it, those links 404 on the deployed site.
  copyFile(join(DASHBOARD_DIR, "issue.html"), join(PAGES_DIST, "dashboard", "issue.html"));
  copyDirectory(join(DASHBOARD_DIR, "data"), join(PAGES_DIST, "dashboard", "data"));
  copyFile(join(DASHBOARD_DIR, "data.js"), join(PAGES_DIST, "dashboard", "data.js"));
}
// issues-graph.html + graph-data.json are in public/ → included via Vite build
copyDirectoryIfExists(join(ROOT, "benchmarks", "suites"), join(PAGES_DIST, "benchmarks", "suites"));

// spec-compliance audit data — fetched by benchmarks/spec-compliance.html at /spec-compliance/summary.json
copyDirectoryIfExists(join(ROOT, "spec-compliance"), join(PAGES_DIST, "spec-compliance"));

// Add the benchmark data files fetched by the public report pages. Public pages
// should read from the already-curated public summaries, not from the full
// internal benchmark results directory.
// `latest.json` / `history.json` are committed in the canonical
// `benchmarks/results/` dir, NOT under `website/public/benchmarks/results/`.
// Prefer the canonical source (fall back to the public copy if curated there)
// so the deployed report page can actually fetch them — otherwise the
// "Performance Benchmarks" / "Performance Trends" sections render empty
// because both files 404 on the live site.
const benchHistorySource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "history.json"),
  join(PUBLIC_BENCH, "history.json"),
);
const benchLatestSource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "latest.json"),
  join(PUBLIC_BENCH, "latest.json"),
);
if (benchHistorySource) {
  copyFile(benchHistorySource, join(PAGES_DIST, "benchmarks", "results", "history.json"));
}
if (benchLatestSource) {
  copyFile(benchLatestSource, join(PAGES_DIST, "benchmarks", "results", "latest.json"));
}
// Preference order:
//   1. test262-current.{jsonl,json}  — committed by the nightly workflow,
//      always present in CI checkouts. THIS is what GitHub Pages should serve.
//   2. test262-results.jsonl symlink — local dev, points at the latest run.
//   3. latest test262-results-*.jsonl in benchmarks/results/ — local dev fallback.
//
// Do NOT fall back to runs/ archive — those files can be months old and would
// silently poison the deployed dashboard.
const test262ReportSource = resolvePreferredFile(
  join(PUBLIC_BENCH, "test262-report.json"),
  join(BENCHMARKS_RESULTS_DIR, "test262-current.json"),
  join(BENCHMARKS_RESULTS_DIR, "test262-report.json"),
  latestNamedFile(BENCHMARKS_RESULTS_DIR, "test262-report-", ".json"),
);
const test262StandaloneReportSource = resolvePreferredFileOrNull(
  join(PUBLIC_BENCH, "test262-standalone-report.json"),
  join(BENCHMARKS_RESULTS_DIR, "test262-standalone-report.json"),
  join(ROOT, "public", "benchmarks", "results", "test262-standalone-report.json"),
  latestNamedFile(BENCHMARKS_RESULTS_DIR, "test262-standalone-report-", ".json"),
);
const test262ResultsSource = resolvePreferredFileOrNull(
  // #1528 — the JSONL is no longer committed; prefer the cache fetched
  // from `loopdive/js2wasm-baselines` if present, then the public/ copy
  // populated by `deploy-pages.yml`, then the legacy in-repo paths.
  join(ROOT, ".test262-cache", "test262-current.jsonl"),
  join(BENCHMARKS_RESULTS_DIR, "test262-current.jsonl"),
  join(PUBLIC_BENCH, "test262-results.jsonl"),
  join(BENCHMARKS_RESULTS_DIR, "test262-results.jsonl"),
  latestNamedFile(BENCHMARKS_RESULTS_DIR, "test262-results-", ".jsonl"),
);
const test262RunsIndexSource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "runs", "index.json"),
  join(PUBLIC_BENCH, "runs", "index.json"),
);
// Per-ES-edition and per-standalone-target trend history (landing-page mini
// trend graphs). Same fallback order as test262RunsIndexSource above.
const test262RunsEditionsIndexSource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "runs", "editions-index.json"),
  join(PUBLIC_BENCH, "runs", "editions-index.json"),
);
const test262RunsStandaloneIndexSource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "runs", "standalone-index.json"),
  join(PUBLIC_BENCH, "runs", "standalone-index.json"),
);
// Host-free per-edition twin (#4362) — consumed by the landing page's
// edition-scope trend in standalone mode and report.html. Without this copy
// the deployed site 404s the file and the standalone edition trend never
// renders, even though promote-baseline appends it every run.
const test262RunsStandaloneEditionsIndexSource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "runs", "standalone-editions-index.json"),
  join(PUBLIC_BENCH, "runs", "standalone-editions-index.json"),
);
copyFile(test262ReportSource, join(PAGES_DIST, "benchmarks", "results", "test262-report.json"));
if (test262StandaloneReportSource) {
  copyFile(test262StandaloneReportSource, join(PAGES_DIST, "benchmarks", "results", "test262-standalone-report.json"));
}
if (test262ResultsSource) {
  copyFile(test262ResultsSource, join(PAGES_DIST, "benchmarks", "results", "test262-results.jsonl"));
}
if (test262RunsIndexSource) {
  copyFile(test262RunsIndexSource, join(PAGES_DIST, "benchmarks", "results", "runs", "index.json"));
}
if (test262RunsEditionsIndexSource) {
  copyFile(test262RunsEditionsIndexSource, join(PAGES_DIST, "benchmarks", "results", "runs", "editions-index.json"));
}
if (test262RunsStandaloneIndexSource) {
  copyFile(
    test262RunsStandaloneIndexSource,
    join(PAGES_DIST, "benchmarks", "results", "runs", "standalone-index.json"),
  );
}
if (test262RunsStandaloneEditionsIndexSource) {
  copyFile(
    test262RunsStandaloneEditionsIndexSource,
    join(PAGES_DIST, "benchmarks", "results", "runs", "standalone-editions-index.json"),
  );
}

const equivTests = buildEquivTests();
writeJson(join(PLAYGROUND_DATA_DIR, "equiv-tests.json"), equivTests);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "equiv-tests.json"), equivTests);

const test262Data = test262ResultsSource
  ? buildStaticTest262Data(test262ResultsSource)
  : buildStaticTest262DataFromReport(test262ReportSource);
writeJson(join(PLAYGROUND_DATA_DIR, "test262-index-summary.json"), test262Data.categories);
writeJson(join(PLAYGROUND_DATA_DIR, "test262-files.json"), test262Data.filesJson);
writeJson(join(PLAYGROUND_DATA_DIR, "test262-file-results.json"), test262Data.resultsJson);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "test262-index-summary.json"), test262Data.categories);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "test262-files.json"), test262Data.filesJson);
writeJson(join(PLAYGROUND_APP_DATA_DIR, "test262-file-results.json"), test262Data.resultsJson);

// Landing page (top-level) and playground both reference these JSONs.
// The canonical source lives in benchmarks/results/ (committed); fall back to
// public/benchmarks/results/ for any files curated there.
const TOP_BENCH_RESULTS = join(PAGES_DIST, "benchmarks", "results");
for (const fileName of [
  "benchmark-manifest.json",
  "playground-benchmark-sidebar.json",
  "playground-benchmark-sidebar-no-jit.json",
  "loadtime-benchmarks.json",
  "size-benchmarks.json",
  "wasm-host-wasmtime-hot-runtime.json",
  "wasm-host-wasmtime-module-size-per-test.json",
]) {
  const source = resolvePreferredFileOrNull(join(BENCHMARKS_RESULTS_DIR, fileName), join(PUBLIC_BENCH, fileName));
  if (source) {
    copyFile(source, join(TOP_BENCH_RESULTS, fileName));
    copyFile(source, join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, fileName));
  }
}
const loadtimeSource = resolvePreferredFileOrNull(
  join(BENCHMARKS_RESULTS_DIR, "loadtime"),
  join(PUBLIC_BENCH, "loadtime"),
);
if (loadtimeSource) {
  copyDirectory(loadtimeSource, join(TOP_BENCH_RESULTS, "loadtime"));
  copyDirectory(loadtimeSource, join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, "loadtime"));
}
if (test262RunsIndexSource) {
  copyFile(test262RunsIndexSource, join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, "runs", "index.json"));
}
copyFileIfExists(
  join(PAGES_DIST, "benchmarks", "results", "test262-report.json"),
  join(PLAYGROUND_BENCHMARKS_RESULTS_DIR, "test262-report.json"),
);

// Disable Jekyll processing so all generated assets are published as-is.
writeFileSync(join(PAGES_DIST, ".nojekyll"), "");

// Emit CNAME so the GitHub Pages custom domain (js2wasm.loopdive.com) survives
// every re-deploy. GitHub Pages reads this file from the deployed artifact
// and points the Pages site at the custom domain. Bare hostname only —
// no scheme, trailing newline. See plan/issues/sprints/46/1188.md.
writeFileSync(join(PAGES_DIST, "CNAME"), "js2wasm.loopdive.com\n");

// Copy web components to pages-dist root and dashboard
const COMPONENTS_DIR = join(WEBSITE, "components");
for (const file of [
  "site-nav.js",
  "t262-charts.js",
  "t262-conformance-trend.js",
  "t262-view-state.js",
  "trend-chart.js",
  "perf-benchmark-chart.js",
  "npm-compat-chart.js",
]) {
  copyFileIfExists(join(COMPONENTS_DIR, file), join(PAGES_DIST, "components", file));
}

// Render ADR markdown → HTML pages so the landing page can link to
// on-origin /js2wasm/docs/adr/*.html instead of broken raw .md URLs.
// `buildAdrPages` is gated behind isMainModule in build-adr-html.mjs, so
// `await import(...)` alone is a no-op — call the export explicitly.
const { buildAdrPages } = await import("./build-adr-html.mjs");
buildAdrPages();

// Copy sprint-stats.json to dashboard data when dashboard artifacts exist.
if (hasDashboardBundle) {
  copyFileIfExists(
    join(WEBSITE, "dashboard", "data", "sprint-stats.json"),
    join(PAGES_DIST, "dashboard", "data", "sprint-stats.json"),
  );
}

// Copy plan/issues markdown files so dashboard issue.html can fetch them
// client-side via the URL /plan/issues/<slug>.md
copyDirectoryIfExists(join(PLAN_DIR, "issues"), join(PAGES_DIST, "plan", "issues"));

// Write a lightweight id → filename index next to the copied issue files so the
// dashboard issue page can resolve a bare id (?slug=681) to its full filename.
// (Dev serves the equivalent on the fly via website/playground/vite-plugin-dashboard.ts.)
{
  const issuesOut = join(PAGES_DIST, "plan", "issues");
  if (existsSync(issuesOut)) {
    const idIndex = {};
    for (const name of readdirSync(issuesOut)) {
      const m = name.match(/^(\d+[a-z]?)(?:-.*)?\.md$/i);
      if (m) idIndex[m[1]] = name.replace(/\.md$/, "");
    }
    writeFileSync(join(issuesOut, "index.json"), JSON.stringify(idIndex));
  }
}

console.log(`GitHub Pages artifact ready at ${PAGES_DIST}`);
