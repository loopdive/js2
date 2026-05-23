#!/usr/bin/env node
// Regenerate tests/test262-slow-tests.json from the committed baseline JSONL.
//
// The slow-tests JSON is a `{ testPath: durationMs }` map consumed by
// `tests/test262-shared.ts` to sort each shard's test list by descending
// duration (slow tests first). The map needs to be refreshed whenever a
// chunk of slow tests becomes fast (compiler perf wins) or vice versa.
//
// Run: node scripts/refresh-slow-tests.mjs [--threshold 1000]
//
// Source JSONL: benchmarks/results/test262-current.jsonl (committed baseline).
// Output JSON:  tests/test262-slow-tests.json (committed).
import { readFileSync, writeFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const INPUT = resolve(REPO_ROOT, "benchmarks/results/test262-current.jsonl");
const OUTPUT = resolve(REPO_ROOT, "tests/test262-slow-tests.json");

const args = process.argv.slice(2);
const threshold = (() => {
  const idx = args.indexOf("--threshold");
  if (idx >= 0 && args[idx + 1]) return parseInt(args[idx + 1], 10);
  return 1000;
})();

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
    map.set(r.file, total);
  }
}

const sorted = Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1]));

const doc = {
  _comment:
    "Per-test execution duration in ms (compile+exec wall time) from the most-recent main baseline. Used by tests/test262-shared.ts to sort tests within each shard, slowest first. Keeps shard wall-time tight (slow tests run first so they overlap with parallel forks) and surfaces slow-test failures early in CI logs. Tests not in this map sort to 0 (run after the timed ones, in their natural order). Refresh with: node scripts/refresh-slow-tests.mjs",
  _threshold_ms: threshold,
  _count: Object.keys(sorted).length,
  _source: `benchmarks/results/test262-current.jsonl (regenerated ${new Date().toISOString()})`,
  tests: sorted,
};

writeFileSync(OUTPUT, JSON.stringify(doc, null, 2) + "\n");
console.log(`Wrote ${Object.keys(sorted).length} entries (threshold ${threshold}ms) → ${OUTPUT}`);
