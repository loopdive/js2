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
//      node scripts/refresh-slow-tests.mjs --input path/to/results.jsonl --output tests/test262-slow-tests-custom.json
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
const INPUT = resolve(REPO_ROOT, argValue("--input") || defaultInput);
const OUTPUT = resolve(REPO_ROOT, argValue("--output") || defaultOutput);

const raw = readFileSync(INPUT, "utf-8");
const lines = raw.split("\n").filter((l) => l.length > 0);
const map = new Map();
for (const line of lines) {
  let r;
  try {
    r = JSON.parse(line);
  } catch {
    continue;
  }
  const total = (r.compile_ms || 0) + (r.exec_ms || 0);
  if (total >= threshold && r.file) {
    // Clamp to >=1ms: the loader in tests/test262-shared.ts drops 0/negative
    // values, but a 0ms (skipped/untimed) test still needs an entry so the
    // weighted shard assignment doesn't fall back to the 250ms default for
    // it — that fallback is what skewed shard wall times 32s–153s (#1953).
    // Run with --threshold 0 to emit the full-coverage map.
    map.set(r.file, Math.max(1, Math.round(total)));
  }
}

const sorted = Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));

const doc = {
  _comment:
    "Per-test execution duration in ms (compile+exec wall time) from a recent baseline JSONL. Used by tests/test262-shared.ts to assign weighted shards and sort tests within each shard, slowest first. Keeps shard wall-time tight (slow tests run first so they overlap with parallel forks) and surfaces slow-test failures early in CI logs. Tests not in this map use the runner's default weight for assignment and run after the timed ones in natural order. Refresh with: node scripts/refresh-slow-tests.mjs",
  _threshold_ms: threshold,
  _count: Object.keys(sorted).length,
  _source: `${relative(REPO_ROOT, INPUT)} (regenerated ${new Date().toISOString()})`,
  _target: target,
  tests: sorted,
};

writeFileSync(OUTPUT, JSON.stringify(doc, null, 2) + "\n");
console.log(`Wrote ${Object.keys(sorted).length} entries (threshold ${threshold}ms) → ${OUTPUT}`);
