#!/usr/bin/env node
// Regenerate tests/test262-slow-tests.json from the committed baseline JSONL.
//
// The slow-tests JSON is a `{ testPath: durationMs }` map consumed by
// `tests/test262-shared.ts` to assign weighted shards and sort each shard's
// test list by descending duration (slow tests first). The map needs to be
// refreshed whenever a chunk of slow tests becomes fast (compiler perf wins)
// or vice versa.
//
// Run: node scripts/refresh-slow-tests.mjs [--threshold 1000] [--target standalone]
//      node scripts/refresh-slow-tests.mjs --input run-a.jsonl --input run-b.jsonl --output tests/test262-slow-tests-custom.json
//
// Repeated --input values are combined by per-test median. CI wall time has
// enough runner-to-runner noise that a multi-run median is a substantially
// better balancing signal than replacing the map from one unusually fast or
// slow runner.
//
// Default source JSONL: benchmarks/results/test262-current.jsonl for host,
// benchmarks/results/test262-standalone-results.jsonl for standalone.
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, relative, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const args = process.argv.slice(2);
const argValue = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
};
const argValues = (name) => {
  const values = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1] !== undefined) values.push(args[i + 1]);
  }
  return values;
};
const threshold = (() => {
  const raw = argValue("--threshold");
  if (raw) return parseInt(raw, 10);
  return 1000;
})();
const target = argValue("--target") || "gc";
const defaultInput =
  target === "standalone"
    ? resolve(REPO_ROOT, "benchmarks/results/test262-standalone-results.jsonl")
    : resolve(REPO_ROOT, "benchmarks/results/test262-current.jsonl");
const defaultOutput =
  target === "gc"
    ? resolve(REPO_ROOT, "tests/test262-slow-tests.json")
    : resolve(REPO_ROOT, `tests/test262-slow-tests-${target}.json`);
const inputArgs = argValues("--input");
const INPUTS = (inputArgs.length > 0 ? inputArgs : [defaultInput]).map((input) => resolve(REPO_ROOT, input));
const OUTPUT = resolve(REPO_ROOT, argValue("--output") || defaultOutput);
const sourceLabel = argValue("--source");

const samples = new Map();
for (const input of INPUTS) {
  const raw = readFileSync(input, "utf-8");
  const lines = raw.split("\n").filter((l) => l.length > 0);
  for (const line of lines) {
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      continue;
    }
    const total = (r.compile_ms || 0) + (r.exec_ms || 0);
    if (r.file) {
      const durations = samples.get(r.file) ?? [];
      durations.push(Math.max(1, Math.round(total)));
      samples.set(r.file, durations);
    }
  }
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

// Clamp to >=1ms: the loader in tests/test262-shared.ts drops 0/negative
// values, but a 0ms (skipped/untimed) test still needs an entry so the
// weighted shard assignment doesn't fall back to the 250ms default for it —
// that fallback is what skewed shard wall times 32s–153s (#1953). Run with
// --threshold 0 to emit the full-coverage map.
const map = new Map(
  [...samples].map(([file, durations]) => [file, median(durations)]).filter(([, duration]) => duration >= threshold),
);
const sorted = Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));

const doc = {
  _comment:
    "Per-test execution duration in ms (compile+exec wall time) from a recent baseline JSONL. Used by tests/test262-shared.ts to assign weighted shards and sort tests within each shard, slowest first. Keeps shard wall-time tight (slow tests run first so they overlap with parallel forks) and surfaces slow-test failures early in CI logs. Tests not in this map use the runner's default weight for assignment and run after the timed ones in natural order. Refresh with: node scripts/refresh-slow-tests.mjs",
  _threshold_ms: threshold,
  _count: Object.keys(sorted).length,
  _source:
    sourceLabel ||
    `${INPUTS.map((input) => relative(REPO_ROOT, input)).join(", ")} (${INPUTS.length}-run median, regenerated ${new Date().toISOString()})`,
  _target: target,
  tests: sorted,
};

writeFileSync(OUTPUT, JSON.stringify(doc, null, 2) + "\n");
console.log(`Wrote ${Object.keys(sorted).length} entries (threshold ${threshold}ms) → ${OUTPUT}`);
