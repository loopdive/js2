#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #6797 — FLAT-DIRECTORY BUDGET.
//
// `src/codegen/` holds 800+ `.ts` files side by side (824 when #6797 was
// filed). A flat directory that size has no visible structure: nothing says
// which files belong to the legacy path, which to the IR bridge, which are
// `*-native.ts` helpers half-moved to `src/backend/wasmgc/`. The
// sub-directories already exist (`expressions/`, `context/`, `registry/`, …);
// this gate makes them the default home for new files by failing when the
// count of top-level files grows.
//
// What is counted: the `.ts` files (no `.d.ts`) DIRECTLY in each budgeted
// directory — non-recursive. Files in sub-directories are free.
//
// Gate semantics:
//   - count above the committed budget -> FAIL (put the new file in a
//     sub-directory, or move an existing flat file into one in the same PR)
//   - count below the budget -> PASS; `--update-on-decrease` lowers the budget
//     (the post-merge baseline jobs call it, so PRs do not have to)
//
// Usage:
//   node scripts/check-flat-dir-budget.mjs                      # gate
//   node scripts/check-flat-dir-budget.mjs --update-on-decrease # gate + bank drops
//   node scripts/check-flat-dir-budget.mjs --update             # (re)seed budgets
//   node scripts/check-flat-dir-budget.mjs --root <dir> --baseline <file>
//                                                               # alternate tree (tests)

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const ROOT = resolve(REPO_ROOT, flagValue("--root") ?? ".");
const BASELINE_PATH = resolve(REPO_ROOT, flagValue("--baseline") ?? "scripts/flat-dir-budget-baseline.json");

/** Directories under budget when the baseline does not exist yet (seeding). */
const DEFAULT_DIRS = ["src/codegen"];

function flatCount(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) throw new Error(`budgeted directory not found: ${abs}`);
  return readdirSync(abs).filter(
    (name) => name.endsWith(".ts") && !name.endsWith(".d.ts") && statSync(join(abs, name)).isFile(),
  ).length;
}

const write = (budgets) => writeFileSync(BASELINE_PATH, `${JSON.stringify(budgets, null, 2)}\n`);
const exists = existsSync(BASELINE_PATH);
const budgets = exists ? JSON.parse(readFileSync(BASELINE_PATH, "utf8")) : {};
const dirs = exists ? Object.keys(budgets) : DEFAULT_DIRS;
const counts = Object.fromEntries(dirs.map((d) => [d, flatCount(d)]));

if (argv.includes("--update")) {
  write(counts);
  console.log(`flat-dir budget: baseline written — ${dirs.map((d) => `${d}/*.ts = ${counts[d]}`).join(", ")}`);
  process.exit(0);
}
if (!exists) {
  console.error(`flat-dir budget: no baseline at ${BASELINE_PATH} — seed it with --update.`);
  process.exit(2);
}

const over = dirs.filter((d) => counts[d] > budgets[d]);
const under = dirs.filter((d) => counts[d] < budgets[d]);

if (argv.includes("--update-on-decrease") && under.length > 0) {
  write(Object.fromEntries(dirs.map((d) => [d, Math.min(budgets[d], counts[d])])));
  for (const d of under) console.log(`flat-dir budget: banked ${d}/*.ts ${budgets[d]} → ${counts[d]}`);
}

if (over.length > 0) {
  console.error("flat-dir budget: FAIL — a budgeted directory gained top-level files.");
  for (const d of over) console.error(`  - ${d}/*.ts: ${budgets[d]} → ${counts[d]} (+${counts[d] - budgets[d]})`);
  console.error(
    "\nPut new files in one of the existing sub-directories, or move an existing flat file into one\n" +
      "in the same change so the count does not grow.",
  );
  process.exit(1);
}

console.log(
  `flat-dir budget: OK — ${dirs.map((d) => `${d}/*.ts ${counts[d]}/${budgets[d]}`).join(", ")}` +
    (under.length > 0 && !argv.includes("--update-on-decrease") ? " [improved — --update-on-decrease banks it]" : ""),
);
