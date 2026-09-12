#!/usr/bin/env node

import { readFileSync } from "node:fs";

function parseArgs(argv) {
  const args = {
    type: "",
    baseline: "",
    candidate: "",
    expectedCount: 0,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--type") {
      args.type = argv[++i] || "";
    } else if (arg === "--baseline") {
      args.baseline = argv[++i] || "";
    } else if (arg === "--candidate") {
      args.candidate = argv[++i] || "";
    } else if (arg === "--expected-count") {
      args.expectedCount = Number(argv[++i]);
    }
  }

  if (
    !["jsonl", "report", "verdicts"].includes(args.type) ||
    !args.baseline ||
    !args.candidate ||
    (args.type === "verdicts" && (!Number.isSafeInteger(args.expectedCount) || args.expectedCount <= 0))
  ) {
    console.error(
      "Usage: node scripts/compare-test262-artifact.mjs --type <jsonl|report|verdicts> --baseline <path> --candidate <path> [--expected-count N (required for verdicts)]",
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
if (args.type === "verdicts") {
  // Measurement-only exact comparison: no quarantine, netting, error cleanup,
  // or implied success from empty/partial/duplicate input. Existing modes and
  // CI regression policy are intentionally unchanged.
  const readVerdicts = (path) => {
    const records = new Map();
    const statuses = new Set(["pass", "fail", "compile_error", "compile_timeout", "skip"]);
    for (const line of readFileSync(path, "utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim())) {
      const row = JSON.parse(line);
      if (!row || typeof row.file !== "string" || !row.file.startsWith("test/") || !statuses.has(row.status)) {
        throw new Error(`${path}: invalid canonical verdict row`);
      }
      if (records.has(row.file)) throw new Error(`${path}: duplicate path ${row.file}`);
      if (Object.hasOwn(row, "error") && typeof row.error !== "string") {
        throw new Error(`${path}: non-string error for ${row.file}`);
      }
      records.set(row.file, { status: row.status, ...(Object.hasOwn(row, "error") ? { error: row.error } : {}) });
    }
    if (records.size !== args.expectedCount) {
      throw new Error(`${path}: expected ${args.expectedCount} unique verdicts, got ${records.size}`);
    }
    return records;
  };
  try {
    const baseline = readVerdicts(args.baseline);
    const candidate = readVerdicts(args.candidate);
    let differences = 0;
    for (const file of [...new Set([...baseline.keys(), ...candidate.keys()])].sort()) {
      const before = baseline.get(file);
      const after = candidate.get(file);
      if (JSON.stringify(before) !== JSON.stringify(after)) {
        differences++;
        console.log(JSON.stringify({ file, baseline: before ?? null, candidate: after ?? null }));
      }
    }
    console.log(
      JSON.stringify({
        expectedCount: args.expectedCount,
        baselineRows: baseline.size,
        candidateRows: candidate.size,
        differences,
      }),
    );
    process.exit(differences === 0 ? 0 : 1);
  } catch (error) {
    console.error(`Exact verdict comparison refused: ${error.message}`);
    process.exit(2);
  }
}
const normalize = args.type === "jsonl" ? normalizeJsonl : normalizeReport;
const baseline = normalize(args.baseline);
const candidate = normalize(args.candidate);

if (baseline === candidate) {
  console.log(`Semantic ${args.type} content unchanged.`);
  process.exit(0);
}

console.log(`Semantic ${args.type} content changed.`);
process.exit(1);
