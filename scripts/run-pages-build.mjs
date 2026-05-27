#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

function run(command, args) {
  execFileSync(command, args, {
    cwd: ROOT,
    stdio: "inherit",
  });
}

const hasPlanningArtifacts =
  existsSync(resolve(ROOT, "plan")) &&
  existsSync(resolve(ROOT, "website", "dashboard")) &&
  existsSync(resolve(ROOT, "scripts", "sprint-stats.ts")) &&
  existsSync(resolve(ROOT, "scripts", "build-planning-artifacts.mjs"));

// Refresh conformance numbers (#1522) before any step that reads ROADMAP.md,
// plan/goals/goal-graph.md, README.md, or CLAUDE.md. Idempotent — only writes
// when test262-current.json moved.
if (existsSync(resolve(ROOT, "benchmarks", "results", "test262-current.json"))) {
  run("node", ["scripts/sync-conformance-numbers.mjs"]);
}

if (hasPlanningArtifacts) {
  run(process.execPath, ["--experimental-strip-types", "scripts/sprint-stats.ts"]);
  run("node", ["scripts/build-planning-artifacts.mjs"]);
}

run(process.execPath, ["--experimental-strip-types", "scripts/generate-editions.ts"]);
run("pnpm", ["run", "build:playground"]);
run("pnpm", ["run", "build:compiler-bundle"]);
// Experimental Wasm flags required by generate-size-benchmarks (Node 25):
//   --experimental-wasm-stringref         — stringview_wtf16 (wasm:js-string ops)
//   --experimental-wasm-custom-descriptors — exact heap type (custom-descriptors)
// Without these, Node rejects modules at compile-time with "invalid heap type X".
run(process.execPath, [
  "--experimental-strip-types",
  "--experimental-wasm-stringref",
  "--experimental-wasm-custom-descriptors",
  "scripts/generate-size-benchmarks.ts",
]);
run("node", ["scripts/build-pages.js"]);
