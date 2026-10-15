#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6979 S7-c — `ctx.standalone` ARM RATCHET.
//
// `ctx.standalone` is the native semantic regime flag. After #6979 S7-a/S7-b
// the regime is the only ECMAScript implementation, so every
// `if (ctx.standalone) { native } else { host }` is either a dead else-arm (a
// semantic site) or a mis-keyed environment / value-boundary / accelerator
// question that belongs on `hostFreeEnvironment(ctx)`, `jsValueBoundary(ctx)`
// or `hasHostAccelerator(...)`. S7-c collapses them directory by directory;
// this gate keeps the count from growing back while that happens.
//
// What is counted: occurrences of `ctx.standalone` (not followed by an
// identifier character, so `ctx.standaloneGlobalThisImport` is not a hit) in
// every `.ts` file under `src/`, grouped by the file's directory.
//
// Gate: FAILS when any directory's count exceeds its committed baseline, or a
// directory with no baseline entry has any hit. Fewer hits always pass.
//
// The baseline `scripts/standalone-arms-baseline.json` is written ONLY by
//   --update-on-decrease   lower every entry to the measured count, never raise
//                          (post-merge banking; also run by a PR that collapses arms)
//   --update               deliberate (re)seed — a reviewed diff
//
// Usage:
//   node scripts/check-standalone-arms.mjs                      # gate
//   node scripts/check-standalone-arms.mjs --update-on-decrease # bank drops
//   node scripts/check-standalone-arms.mjs --update             # (re)seed
//   node scripts/check-standalone-arms.mjs --root <dir> --baseline <file>  # alternate tree (tests)

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const ROOT = resolve(REPO_ROOT, flagValue("--root") ?? ".");
const BASELINE_PATH = resolve(REPO_ROOT, flagValue("--baseline") ?? "scripts/standalone-arms-baseline.json");
const HIT = /\bctx\.standalone(?![\w$])/g;

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (name.endsWith(".ts")) out.push(abs);
  }
  return out;
}

/** `{ "<dir>": hits }` for every directory under src/ with at least one hit, sorted. */
function measure() {
  const counts = {};
  for (const file of walk(join(ROOT, "src"), [])) {
    const hits = readFileSync(file, "utf8").match(HIT)?.length ?? 0;
    if (hits === 0) continue;
    const dir = relative(ROOT, dirname(file)).split(sep).join("/");
    counts[dir] = (counts[dir] ?? 0) + hits;
  }
  return Object.fromEntries(
    Object.keys(counts)
      .sort()
      .map((d) => [d, counts[d]]),
  );
}

const total = (o) => Object.values(o).reduce((a, b) => a + b, 0);
const write = (o) => writeFileSync(BASELINE_PATH, `${JSON.stringify(o, null, 2)}\n`);
const counts = measure();

if (argv.includes("--update")) {
  write(counts);
  console.log(`standalone-arms: baseline written — ${total(counts)} hits in ${Object.keys(counts).length} directories`);
  process.exit(0);
}
if (!existsSync(BASELINE_PATH)) {
  console.error(`standalone-arms: no baseline at ${BASELINE_PATH} — seed it with --update.`);
  process.exit(2);
}
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const dirs = [...new Set([...Object.keys(baseline), ...Object.keys(counts)])].sort();

if (argv.includes("--update-on-decrease")) {
  const banked = {};
  const lowered = [];
  for (const d of Object.keys(baseline).sort()) {
    const now = Math.min(baseline[d], counts[d] ?? 0);
    if (now < baseline[d]) lowered.push(`${d} ${baseline[d]} → ${now}`);
    if (now > 0) banked[d] = now;
  }
  if (lowered.length > 0) write(banked);
  for (const l of lowered) console.log(`standalone-arms: banked ${l}`);
  if (lowered.length === 0) console.log("standalone-arms: nothing to bank");
  process.exit(0);
}

const rows = dirs.map((d) => ({ d, base: baseline[d] ?? 0, now: counts[d] ?? 0 }));
const failures = rows.filter((r) => r.now > r.base);
const width = Math.max(...rows.map((r) => r.d.length), 9);
console.log(`${"directory".padEnd(width)}  baseline  current`);
for (const r of rows) {
  const mark = r.now > r.base ? "  GREW" : r.now < r.base ? "  (bank with --update-on-decrease)" : "";
  console.log(`${r.d.padEnd(width)}  ${String(r.base).padStart(8)}  ${String(r.now).padStart(7)}${mark}`);
}
console.log(`${"total".padEnd(width)}  ${String(total(baseline)).padStart(8)}  ${String(total(counts)).padStart(7)}`);
if (failures.length > 0) {
  console.error("\nstandalone-arms: FAIL — `ctx.standalone` hits grew:");
  for (const r of failures) console.error(`  - ${r.d}: ${r.base} → ${r.now} (+${r.now - r.base})`);
  console.error(
    "\n`ctx.standalone` is the native regime flag and the regime is the only semantic implementation\n" +
      "(#6979). Key environment questions on hostFreeEnvironment(ctx), the JS value bridge on\n" +
      "jsValueBoundary(ctx), and host accelerators on hasHostAccelerator(ctx.targetProfile, <family>).",
  );
  process.exit(1);
}
console.log("standalone-arms: OK");
