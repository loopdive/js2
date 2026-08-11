#!/usr/bin/env node
// Union other copies of `npm-compat-history.json` into the working-tree copy.
//
// The refresh workflow builds its promotion commit on `deploykey/main` and
// force-pushes it over the reused `ci/npm-compat-refresh` branch. Its own
// history artifact was derived from main as of the revision it MEASURED, so
// any run published after that point — one still waiting in the open promotion
// PR, or one that landed on main during the ~24-minute measurement — is absent
// from it and the force-push would delete it. Unioning first makes the push
// additive, which is the only shape that is safe for a reused branch.
//
// Merging is by measurement identity (see mergeNpmPerfHistory), so this is
// idempotent and order-independent: re-running it, or pointing it at a copy
// that is already a subset, changes nothing.
//
// Usage: node scripts/merge-npm-compat-history.mjs <other-history.json>...
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { mergeNpmPerfHistory } from "./lib/npm-compat-perf.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const HISTORY_PATH = resolve(ROOT, "benchmarks", "results", "npm-compat-history.json");
const HISTORY_PUBLIC_PATH = resolve(ROOT, "website", "public", "benchmarks", "results", "npm-compat-history.json");

const sources = process.argv.slice(2);
if (sources.length === 0) {
  console.error("usage: node scripts/merge-npm-compat-history.mjs <other-history.json>...");
  process.exit(2);
}
if (!existsSync(HISTORY_PATH)) {
  console.error(`[npm-compat] ${HISTORY_PATH} does not exist; nothing to merge into`);
  process.exit(1);
}

let history = JSON.parse(readFileSync(HISTORY_PATH, "utf-8"));
const before = history.runs?.length ?? 0;

for (const source of sources) {
  // A missing or unreadable copy is expected (a branch that does not exist
  // yet, a revision that predates the artifact) and must never fail the
  // refresh — the working-tree copy is already the newer one.
  if (!existsSync(source)) {
    console.warn(`[npm-compat] no history at ${source}; skipping`);
    continue;
  }
  try {
    const other = JSON.parse(readFileSync(source, "utf-8"));
    const runs = Array.isArray(other) ? other : (other.runs ?? []);
    history = mergeNpmPerfHistory(history, runs);
    console.log(`[npm-compat] unioned ${runs.length} run(s) from ${source}`);
  } catch (error) {
    console.warn(`[npm-compat] could not read ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
copyFileSync(HISTORY_PATH, HISTORY_PUBLIC_PATH);
console.log(`[npm-compat] history runs: ${before} -> ${history.runs.length}`);
