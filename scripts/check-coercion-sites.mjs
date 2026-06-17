#!/usr/bin/env node
/**
 * #2108 (coercion drift gate) — keep the JS-semantic coercion vocabulary
 * funnelling through the single coercion engine instead of being hand-rolled
 * per call site.
 *
 * Background: the June-2026 spec-conformance sweep found the §7.1.17 ToString
 * matrix hand-rolled 7×, ToPrimitive 5×, equality 7×, ToNumber 6+×, ToBoolean
 * 4× — a fix to one copy is structurally invisible to the others (see
 * plan/log/analysis-2026-06/03-coercion-engine-spec.md §1). Nothing stopped a
 * ninth copy: a fresh inline ToNumber matrix landed WHILE that analysis ran.
 * This gate is the §5 drift-prevention net: it baseline-counts uses of the
 * sealed coercion vocabulary OUTSIDE the engine, so a new hand-rolled site
 * fails CI, and the coercion-engine migration (#1917 Steps 1-4) ratchets the
 * baseline down step by step until the count outside the engine is ~0 and the
 * grep becomes a hard seal.
 *
 * Mechanism mirrors the IR-fallback ratchet (scripts/check-ir-fallbacks.ts) and
 * the AnyValue box-site gate (scripts/check-any-box-sites.mjs): per-(file,token)
 * counts vs. a committed baseline; growth fails, shrink auto-ratchets with
 * --update-on-decrease.
 *
 * Scope: walks src/codegen/** and src/codegen-linear/** (recursively),
 * EXCLUDING the engine-owned files (SANCTIONED) that legitimately define /
 * own the vocabulary:
 *   - coercion-engine.ts  — the future single engine home (#1917 Step 1+);
 *     listed up front so the gate is ready the moment migration starts.
 *   - any-helpers.ts      — defines the __any_* / __unbox_number tails.
 *   - native-strings.ts   — defines number_toString / __any_to_string.
 *
 * Each token is counted in the form it actually appears as a USE site:
 *   - host/wasm func names ("__extern_toString", "number_toString", …) appear
 *     as quoted strings inside funcMap.get("…"), ensureLateImport(ctx,"…"),
 *     and func-name emission → matched as "token".
 *   - TS helper identifiers (emitBoolToString, _toPrimitiveSync, …) appear as
 *     calls → matched as token( .
 * Both forms for every token are tried; definitions inside SANCTIONED files are
 * never counted.
 *
 * Usage:
 *   node scripts/check-coercion-sites.mjs                    # fail on growth
 *   node scripts/check-coercion-sites.mjs --update           # write current counts
 *   node scripts/check-coercion-sites.mjs --update-on-decrease
 *   node scripts/check-coercion-sites.mjs --verbose          # print per-file breakdown
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from "fs";
import { join, relative } from "path";

const ROOTS = [
  new URL("../src/codegen", import.meta.url).pathname,
  new URL("../src/codegen-linear", import.meta.url).pathname,
];
const SRC_ROOT = new URL("../src", import.meta.url).pathname;
const BASELINE_PATH = new URL("./coercion-sites-baseline.json", import.meta.url).pathname;

// Engine-owned files that legitimately define / own the coercion vocabulary.
// Matched by basename anywhere under the scanned roots.
const SANCTIONED = new Set([
  "coercion-engine.ts", // future single-engine home (#1917 Step 1+)
  "any-helpers.ts", // defines __any_* / __unbox_number tails
  "native-strings.ts", // defines number_toString / __any_to_string
]);

// The sealed §7.1.x / §7.2.x coercion vocabulary (spec §5).
const VOCAB = [
  "number_toString",
  "emitBoolToString",
  "__extern_toString",
  "__any_to_string",
  "__to_primitive",
  "_toPrimitiveSync",
  "__host_loose_eq",
  "__host_eq",
  "__any_to_f64",
  "__str_to_number",
  "__unbox_number",
  "__is_truthy",
  "__to_boolean",
  "__any_eq",
  "__any_strict_eq",
  "valueOfClosureTypes",
  "toPrimitiveHint",
];

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Per token: count quoted-string uses ("token") OR call uses (token().
// `valueOfClosureTypes`/`toPrimitiveHint` also appear as type/identifier refs;
// the call/quoted forms capture the emission-relevant uses without sweeping in
// every type annotation. A use matching both forms on one line is rare; we
// count occurrences of each alternative independently (matches the intent of
// "how many times is the coercion vocabulary invoked here").
function tokenPattern(tok) {
  const e = escapeRe(tok);
  return new RegExp(`"${e}"|\\b${e}\\s*\\(`, "g");
}

const PATTERNS = VOCAB.map((tok) => [tok, tokenPattern(tok)]);

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // root may not exist (e.g. no codegen-linear yet)
  }
  for (const ent of entries) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      walk(full, out);
    } else if (ent.isFile() && ent.name.endsWith(".ts")) {
      if (SANCTIONED.has(ent.name)) continue;
      out.push(full);
    }
  }
}

function countSites() {
  const files = [];
  for (const root of ROOTS) walk(root, files);
  const counts = {};
  for (const full of files) {
    const text = readFileSync(full, "utf-8");
    const key = relative(SRC_ROOT, full);
    const perToken = {};
    let total = 0;
    for (const [tok, re] of PATTERNS) {
      re.lastIndex = 0;
      const n = (text.match(re) || []).length;
      if (n > 0) {
        perToken[tok] = n;
        total += n;
      }
    }
    if (total > 0) counts[key] = total;
    counts[key] && (counts[`${key}::tokens`] = perToken);
  }
  // Strip the per-token detail from the comparable baseline; keep it only for
  // --verbose. We store ONLY the file→total map in the baseline file.
  const totals = {};
  for (const k of Object.keys(counts)) {
    if (k.endsWith("::tokens")) continue;
    totals[k] = counts[k];
  }
  return { totals, detail: counts };
}

const args = process.argv.slice(2);
const update = args.includes("--update");
const updateOnDecrease = args.includes("--update-on-decrease");
const verbose = args.includes("--verbose");

const { totals: current, detail } = countSites();

if (verbose) {
  console.error("coercion-sites per-file breakdown:");
  for (const f of Object.keys(current).sort()) {
    console.error(`  ${f}: ${current[f]}`);
    const tokens = detail[`${f}::tokens`] || {};
    for (const t of Object.keys(tokens).sort()) {
      console.error(`      ${t}: ${tokens[t]}`);
    }
  }
  console.error("");
}

let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
} catch {
  // first run
}

if (update) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log("coercion-sites baseline written:", Object.keys(current).length, "files");
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
  console.error("coercion-sites gate FAILED — new hand-rolled coercion vocabulary outside the engine:");
  console.error(grown.join("\n"));
  console.error(
    "\nRoute the coercion through the single coercion engine (#1917 / #2108).\n" +
      "Do NOT hand-roll a fresh ToString/ToNumber/ToPrimitive/equality matrix.\n" +
      "See plan/log/analysis-2026-06/03-coercion-engine-spec.md §5.\n" +
      "If this growth is an intentional, reviewed migration step, refresh the\n" +
      "baseline: node scripts/check-coercion-sites.mjs --update",
  );
  process.exit(1);
}

if (shrank.length > 0) {
  if (updateOnDecrease) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log("coercion-sites baseline ratcheted down:\n" + shrank.join("\n"));
  } else {
    console.log("coercion-sites decreased (run --update-on-decrease to bank it):\n" + shrank.join("\n"));
  }
}

console.log("coercion-sites gate: OK (no unsanctioned growth vs. baseline).");
