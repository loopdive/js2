#!/usr/bin/env node

// Assemble the focused reports produced by npm-compat-refresh's matrix
// workers. The worker reports are deliberately not dashboard artifacts: only
// this coordinator writes the complete snapshots and the public twins.

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { mergeNpmCompatPartials } from "./lib/npm-compat-partials.mjs";

const ROOT = resolve(import.meta.dirname, "..");
const partialDirectory = process.argv[2];
if (!partialDirectory) throw new Error("usage: merge-npm-compat-partials.mjs <partial-directory>");

const partialRoot = resolve(partialDirectory);
mkdirSync(partialRoot, { recursive: true });
const partialPaths = readdirSync(partialRoot)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => join(partialRoot, name));

const partials = partialPaths.map((path) => JSON.parse(readFileSync(path, "utf8")));
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
const summaryPath = resolve(ROOT, "benchmarks", "results", "npm-compat.json");
const existingSummary = existsSync(summaryPath) ? JSON.parse(readFileSync(summaryPath, "utf8")) : null;
const historyPath = resolve(ROOT, "benchmarks", "results", "npm-compat-history.json");
const existingHistory = existsSync(historyPath)
  ? JSON.parse(readFileSync(historyPath, "utf8"))
  : { schemaVersion: 1, runs: [] };

const { summary, perfRows, perfHistory } = mergeNpmCompatPartials(partials, {
  sourceRevision,
  existingHistory,
  existingPackages: existingSummary?.packages ?? [],
  existingSummaryMeta: existingSummary
    ? {
        note: existingSummary.note,
        popularity: existingSummary.popularity,
        performanceMethodology: existingSummary.performanceMethodology,
      }
    : null,
  existingGeneratedAt: existingSummary?.generatedAt ?? null,
  allowStaleFallback: true,
});

const outputs = [
  ["benchmarks/results/npm-compat.json", JSON.stringify(summary, null, 2) + "\n"],
  ["benchmarks/results/npm-compat-perf.json", JSON.stringify(perfRows, null, 2) + "\n"],
  ["benchmarks/results/npm-compat-history.json", JSON.stringify(perfHistory, null, 2) + "\n"],
];
for (const [relativePath, contents] of outputs) {
  const outputPath = resolve(ROOT, relativePath);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, contents);
  const publicPath = resolve(ROOT, "website/public", relativePath);
  mkdirSync(dirname(publicPath), { recursive: true });
  copyFileSync(outputPath, publicPath);
  console.log(`[npm-compat] wrote ${outputPath}`);
  console.log(`[npm-compat] wrote ${publicPath}`);
}

console.log(
  `[npm-compat] assembled ${summary.packages.length} packages from ${partialPaths.length} worker reports at ${sourceRevision}`,
);
