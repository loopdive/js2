#!/usr/bin/env node
/**
 * #2104 (value-rep P1) drift gate — keep AnyValue boxing flowing through the
 * single `boxToAny` entry point in `src/codegen/value-tags.ts`.
 *
 * Counts direct `ctx.funcMap.get("__any_box_*")` emission sites OUTSIDE the
 * sanctioned files (`value-tags.ts`, which owns `boxToAny`, and
 * `any-helpers.ts`, which defines the helpers and uses the i32/f64 boxers
 * internally inside `__any_add`). Growth fails CI; a decrease auto-ratchets the
 * baseline down (same flag convention as `check-ir-fallbacks`).
 *
 * The remaining baselined sites are the literal fast-paths in `expressions.ts`
 * (null/undefined/bool literals boxed inline in an AnyValue-expected context) —
 * the value-rep spec keeps them (correct and cheaper; consistency-checked by
 * tests, not deleted). New blind boxing elsewhere must route through `boxToAny`.
 *
 * Usage:
 *   node scripts/check-any-box-sites.mjs                    # fail on growth
 *   node scripts/check-any-box-sites.mjs --update           # write current counts
 *   node scripts/check-any-box-sites.mjs --update-on-decrease
 */
import { readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

const CODEGEN_DIR = new URL("../src/codegen", import.meta.url).pathname;
const BASELINE_PATH = new URL("./any-box-sites-baseline.json", import.meta.url).pathname;

// Files allowed to call the box helpers directly (the home + the definitions).
const SANCTIONED = new Set(["value-tags.ts", "any-helpers.ts"]);

const PATTERN = /funcMap\.get\("__any_box_/g;

function countSites() {
  const counts = {};
  for (const fname of readdirSync(CODEGEN_DIR)) {
    if (!fname.endsWith(".ts") || SANCTIONED.has(fname)) continue;
    const text = readFileSync(join(CODEGEN_DIR, fname), "utf-8");
    const n = (text.match(PATTERN) || []).length;
    if (n > 0) counts[fname] = n;
  }
  return counts;
}

const args = process.argv.slice(2);
const update = args.includes("--update");
const updateOnDecrease = args.includes("--update-on-decrease");

const current = countSites();
let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
} catch {
  // first run
}

if (update) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log("any-box-sites baseline written:", JSON.stringify(current));
  process.exit(0);
}

const grown = [];
const shrank = [];
const allFiles = new Set([...Object.keys(baseline), ...Object.keys(current)]);
for (const f of allFiles) {
  const was = baseline[f] ?? 0;
  const now = current[f] ?? 0;
  if (now > was) grown.push(`  ${f}: ${was} → ${now}`);
  else if (now < was) shrank.push(`  ${f}: ${was} → ${now}`);
}

if (grown.length > 0) {
  console.error("any-box-sites gate FAILED — new direct __any_box_* sites outside boxToAny:");
  console.error(grown.join("\n"));
  console.error("\nRoute the boxing through `boxToAny` in src/codegen/value-tags.ts (#2104).");
  process.exit(1);
}

if (shrank.length > 0) {
  if (updateOnDecrease) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log("any-box-sites baseline ratcheted down:\n" + shrank.join("\n"));
  } else {
    console.log("any-box-sites decreased (run --update-on-decrease to bank it):\n" + shrank.join("\n"));
  }
}

console.log("any-box-sites gate: OK (no unsanctioned growth vs. baseline).");
