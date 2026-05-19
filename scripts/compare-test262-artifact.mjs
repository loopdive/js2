#!/usr/bin/env node

import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const args = {
    type: "",
    baseline: "",
    candidate: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--type") {
      args.type = argv[++i] || "";
    } else if (arg === "--baseline") {
      args.baseline = argv[++i] || "";
    } else if (arg === "--candidate") {
      args.candidate = argv[++i] || "";
    }
  }

  if (!["jsonl", "report"].includes(args.type) || !args.baseline || !args.candidate) {
    console.error(
      "Usage: node scripts/compare-test262-artifact.mjs --type <jsonl|report> --baseline <path> --candidate <path>",
    );
    process.exit(2);
  }

  return args;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => [key, sortKeys(entryValue)]),
  );
}

function normalizeResultRecord(record) {
  const normalized = { ...record };
  delete normalized.timestamp;
  delete normalized.compile_ms;
  delete normalized.exec_ms;
  return sortKeys(normalized);
}

function normalizeJsonl(path) {
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.stringify(normalizeResultRecord(JSON.parse(line))))
    .sort()
    .join("\n");
}

function normalizeReportValue(value) {
  if (Array.isArray(value)) return value.map(normalizeReportValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !["timestamp", "baseline_generated_at", "baseline_sha"].includes(key))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entryValue]) => [key, normalizeReportValue(entryValue)]),
  );
}

function normalizeReport(path) {
  return JSON.stringify(normalizeReportValue(JSON.parse(readFileSync(path, "utf8"))), null, 2);
}

const args = parseArgs(process.argv.slice(2));
const normalize = args.type === "jsonl" ? normalizeJsonl : normalizeReport;
const baseline = normalize(args.baseline);
const candidate = normalize(args.candidate);

if (baseline === candidate) {
  console.log(`Semantic ${args.type} content unchanged.`);
  process.exit(0);
}

console.log(`Semantic ${args.type} content changed.`);
process.exit(1);
