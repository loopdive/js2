#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6979 S7-c — raw `ctx.standalone` arm ratchet.
//
// `ctx.standalone` used to answer several unrelated questions at once: which
// ECMAScript implementation to emit, whether a JavaScript embedder exists,
// whether the JS-value bridge is enabled, and whether a named host accelerator
// is selected. S7-c classifies those sites one directory-sized slice at a time.
// This gate prevents a completed slice from silently growing the old question
// again while the migration is in flight.
//
// The count is deliberately lexical, including comments. The migration is
// complete only when the obsolete spelling has disappeared from source and
// from explanations that teach contributors to use it.
//
// Usage:
//   pnpm run check:standalone-arms
//   pnpm run check:standalone-arms -- --verbose
//   pnpm run check:standalone-arms -- --update-on-decrease
//   pnpm run check:standalone-arms -- --update

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_ROOT = join(REPO_ROOT, "src");
const BASELINE_PATH = join(REPO_ROOT, "plan", "audit", "standalone-arms-baseline.json");
const NEEDLE = /ctx\.standalone/g;
const args = new Set(process.argv.slice(2));

function walkTypeScriptFiles(dir, out = []) {
  if (!existsSync(dir)) throw new Error(`standalone-arms: source root not found: ${dir}`);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkTypeScriptFiles(path, out);
    else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")) out.push(path);
  }
  return out;
}

function measure() {
  const files = walkTypeScriptFiles(SOURCE_ROOT).sort();
  const directories = {};
  let matchingFiles = 0;
  for (const file of files) {
    const source = readFileSync(file, "utf8");
    const matches = source.match(NEEDLE)?.length ?? 0;
    if (matches === 0) continue;
    matchingFiles += 1;
    const directory = relative(REPO_ROOT, dirname(file)).split("\\").join("/");
    directories[directory] = (directories[directory] ?? 0) + matches;
  }
  return {
    scannedFiles: files.length,
    matchingFiles,
    directories: Object.fromEntries(Object.entries(directories).sort(([a], [b]) => a.localeCompare(b))),
  };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(`standalone-arms: baseline missing: ${relative(REPO_ROOT, BASELINE_PATH)} (seed with --update)`);
  }
  const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  if (baseline.schemaVersion !== 1 || !baseline.directories || baseline.minimumScannedFiles <= 0) {
    throw new Error("standalone-arms: invalid baseline schema or non-positive scan floor");
  }
  return baseline;
}

function writeBaseline(measured, previous) {
  const baseline = {
    schemaVersion: 1,
    minimumScannedFiles: previous?.minimumScannedFiles ?? Math.max(1, Math.floor(measured.scannedFiles * 0.9)),
    directories: measured.directories,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
}

function total(directories) {
  return Object.values(directories).reduce((sum, count) => sum + count, 0);
}

const measured = measure();
if (args.has("--update")) {
  const previous = existsSync(BASELINE_PATH) ? loadBaseline() : undefined;
  writeBaseline(measured, previous);
  console.log(
    `standalone-arms: baseline written — ${total(measured.directories)} hit(s) in ${measured.matchingFiles} file(s)`,
  );
  process.exit(0);
}

const baseline = loadBaseline();
if (measured.scannedFiles < baseline.minimumScannedFiles) {
  console.error(
    `standalone-arms: FAIL — scanned ${measured.scannedFiles} source file(s), below the non-vacuity floor ` +
      `${baseline.minimumScannedFiles}`,
  );
  process.exit(1);
}

const directories = [...new Set([...Object.keys(baseline.directories), ...Object.keys(measured.directories)])].sort();
const grew = [];
const shrank = [];
for (const directory of directories) {
  const was = baseline.directories[directory] ?? 0;
  const now = measured.directories[directory] ?? 0;
  if (now > was) grew.push(`${directory}: ${was} → ${now} (+${now - was})`);
  else if (now < was) shrank.push(`${directory}: ${was} → ${now} (−${was - now})`);
}

if (args.has("--verbose")) {
  console.log("standalone-arms by directory:");
  for (const directory of Object.keys(measured.directories)) {
    console.log(`  ${directory}: ${measured.directories[directory]}`);
  }
}

if (grew.length > 0) {
  console.error("standalone-arms: FAIL — raw ctx.standalone sites grew:");
  for (const line of grew) console.error(`  - ${line}`);
  console.error("Classify each new decision as semantic, environment, value-boundary, or accelerator policy.");
  process.exit(1);
}

if (args.has("--update-on-decrease")) {
  if (shrank.length > 0) writeBaseline(measured, baseline);
  console.log(
    shrank.length > 0
      ? `standalone-arms: banked ${total(baseline.directories)} → ${total(measured.directories)} hit(s)`
      : "standalone-arms: nothing to bank",
  );
  process.exit(0);
}

if (shrank.length > 0) {
  console.log("standalone-arms: OK — the tree shrank below the committed ceiling:");
  for (const line of shrank) console.log(`  - ${line}`);
  console.log("Run with --update-on-decrease to bank the reduction.");
} else {
  console.log(
    `standalone-arms: OK — ${total(measured.directories)} hit(s) in ${measured.matchingFiles} file(s); no growth`,
  );
}
