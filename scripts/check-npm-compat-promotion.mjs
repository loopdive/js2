#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const NPM_COMPAT_PROMOTION_ARTIFACTS = Object.freeze([
  "benchmarks/results/npm-compat.json",
  "benchmarks/results/npm-compat-perf.json",
  "benchmarks/results/npm-compat-history.json",
  "website/public/benchmarks/results/npm-compat.json",
  "website/public/benchmarks/results/npm-compat-perf.json",
  "website/public/benchmarks/results/npm-compat-history.json",
]);

const MIRROR_PAIRS = Object.freeze([
  ["benchmarks/results/npm-compat.json", "website/public/benchmarks/results/npm-compat.json"],
  ["benchmarks/results/npm-compat-perf.json", "website/public/benchmarks/results/npm-compat-perf.json"],
  ["benchmarks/results/npm-compat-history.json", "website/public/benchmarks/results/npm-compat-history.json"],
]);

const ROOT = resolve(fileURLToPath(new URL("../", import.meta.url)));

const sortedUnique = (values) => [...new Set(values.filter(Boolean))].sort();

export function classifyNpmCompatChange(changedFiles) {
  const actual = sortedUnique(changedFiles);
  const expected = [...NPM_COMPAT_PROMOTION_ARTIFACTS].sort();
  const expectedSet = new Set(expected);
  const touchesArtifacts = actual.some((path) => expectedSet.has(path));
  const hasAllArtifacts = expected.every((path) => actual.includes(path));
  return {
    touchesArtifacts,
    hasAllArtifacts,
    promotionOnly: hasAllArtifacts && actual.length === expected.length,
  };
}

export function isNpmCompatPromotionOnly(changedFiles) {
  return classifyNpmCompatChange(changedFiles).promotionOnly;
}

function parseJson(path, contents) {
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function requireIsoTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be an ISO timestamp`);
  }
}

export function validateNpmCompatPromotion(root = ROOT) {
  for (const [canonicalPath, publicPath] of MIRROR_PAIRS) {
    const canonical = readFileSync(resolve(root, canonicalPath));
    const published = readFileSync(resolve(root, publicPath));
    if (!canonical.equals(published)) {
      throw new Error(`${publicPath} is not byte-identical to ${canonicalPath}`);
    }
  }

  const reportPath = NPM_COMPAT_PROMOTION_ARTIFACTS[0];
  const perfPath = NPM_COMPAT_PROMOTION_ARTIFACTS[1];
  const historyPath = NPM_COMPAT_PROMOTION_ARTIFACTS[2];
  const report = parseJson(reportPath, readFileSync(resolve(root, reportPath), "utf8"));
  const perf = parseJson(perfPath, readFileSync(resolve(root, perfPath), "utf8"));
  const history = parseJson(historyPath, readFileSync(resolve(root, historyPath), "utf8"));

  requireIsoTimestamp(report.generatedAt, `${reportPath}.generatedAt`);
  if (!Array.isArray(report.packages) || report.packages.length < 20) {
    throw new Error(`${reportPath} must contain at least 20 packages`);
  }
  if (!report.packages.every((entry) => typeof entry?.name === "string" && entry.compile)) {
    throw new Error(`${reportPath} has package entries missing name/compile`);
  }

  if (!Array.isArray(perf) || perf.length === 0) {
    throw new Error(`${perfPath} must contain performance measurements`);
  }
  if (
    !perf.every(
      (entry) =>
        typeof entry?.name === "string" &&
        Number.isFinite(entry.wasmUs) &&
        entry.wasmUs >= 0 &&
        Number.isFinite(entry.jsUs) &&
        entry.jsUs >= 0,
    )
  ) {
    throw new Error(`${perfPath} has an invalid timing entry`);
  }

  if (history?.schemaVersion !== 1 || !Array.isArray(history.runs) || history.runs.length === 0) {
    throw new Error(`${historyPath} must contain schemaVersion 1 history runs`);
  }
  const matchingRuns = history.runs.filter((run) => run?.generatedAt === report.generatedAt);
  if (matchingRuns.length !== 1) {
    throw new Error(`${historyPath} must contain exactly one run for ${report.generatedAt}`);
  }
  if (!/^[0-9a-f]{40}$/i.test(matchingRuns[0].sourceRevision ?? "")) {
    throw new Error(`${historyPath} matching run must carry a full sourceRevision`);
  }

  const newestHistoryTime = Math.max(
    ...history.runs.map((run, index) => {
      requireIsoTimestamp(run?.generatedAt, `${historyPath}.runs[${index}].generatedAt`);
      return Date.parse(run.generatedAt);
    }),
  );
  if (newestHistoryTime !== Date.parse(report.generatedAt)) {
    throw new Error(`${reportPath}.generatedAt must match the newest history run`);
  }

  return {
    generatedAt: report.generatedAt,
    packageCount: report.packages.length,
    perfCount: perf.length,
    sourceRevision: matchingRuns[0].sourceRevision,
  };
}

function changedFilesFromGit(base) {
  return execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", base, "HEAD", "--"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);
}

function parseArgs(argv) {
  const args = { base: "HEAD^", githubOutput: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--base") args.base = argv[++index] ?? "";
    else if (arg === "--github-output") args.githubOutput = argv[++index] ?? "";
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.base) throw new Error("--base requires a revision");
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  let changedFiles = [];
  try {
    changedFiles = changedFilesFromGit(args.base);
  } catch {
    // A missing parent/base must select the normal, conservative CI path.
    console.log(`Could not diff ${args.base}..HEAD; treating this as a normal change.`);
  }

  const classification = classifyNpmCompatChange(changedFiles);
  if (classification.touchesArtifacts && !classification.hasAllArtifacts) {
    throw new Error("npm-compat artifact changes must include all six canonical/public files");
  }

  if (classification.hasAllArtifacts) {
    const summary = validateNpmCompatPromotion(ROOT);
    console.log(
      `Validated ${summary.packageCount} packages and ${summary.perfCount} performance rows from ${summary.sourceRevision} (${summary.generatedAt}).`,
    );
  }

  if (args.githubOutput) appendFileSync(args.githubOutput, `only=${classification.promotionOnly}\n`);
  console.log(`npm-compat artifact-only change: ${classification.promotionOnly}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
