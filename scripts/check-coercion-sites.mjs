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
 * CHANGE-SCOPED + NET-PER-VOCABULARY (#3131 scoping, #3279 net rework mirroring
 * check-oracle-ratchet.mjs #3070/#3273): when a git diff base is resolvable
 * (scripts/lib/change-scope.mjs), the DEFAULT run judges ONLY this change-set.
 * For each changed src/codegen(-linear) file it counts the coercion vocabulary
 * at the BASE blob vs the WORKING TREE, then fails only when the change-set's
 * NET (per vocabulary token, summed over the changed non-allowed files) count
 * GREW. The committed baseline (scripts/coercion-sites-baseline.json) is NOT
 * consulted on that path — and PRs must NOT commit changes to it (the per-PR
 * bump merge-conflicted with every post-merge refresh promote-baseline pushes
 * to main — the same churn class as the loc-budget baseline).
 *
 *   NET, not per-file (#3279): a byte-identical god-file split relocates
 *   existing coercion sites out of the source file (−N) and into a NEW sibling
 *   module (+N). That is net-neutral — no fresh hand-rolled coercion — so it
 *   must pass. The old per-file "any file's count grew fails" rule flagged the
 *   new module (0→N) and forced every Wave-B split PR to declare a
 *   `coercion-sites-allow` for each module it created — a relocation-shift
 *   false-positive treadmill that repeatedly failed split PRs (e.g. #3076).
 *   This is exactly the class Dev-Gate already fixed for the oracle-ratchet
 *   gate in #3070. Netting per vocabulary token passes verbatim relocations
 *   (each token's removal from the source cancels its addition in the new
 *   module) while a genuinely-new hand-rolled coercion (a token gains a use
 *   with no offsetting removal) nets > 0 and still fails. Netting PER TOKEN
 *   (rather than per grand total) keeps the gate's anti-drift purpose intact:
 *   swapping one hand-rolled coercion for a NEW kind (remove __is_truthy, add
 *   __any_to_string) is not masked by the offsetting removal — the new-kind
 *   token still nets positive and fails.
 *
 * Intentional growth (a reviewed migration step) is granted per change-set via
 * a `coercion-sites-allow:` frontmatter list (repo-relative src paths) in the
 * PR's own plan/issues/*.md file; allowance-granted files are excluded from the
 * net entirely (they neither fault nor offset). The committed baseline remains
 * for the no-git fallback and the writer modes; main's post-merge refresh is
 * its sole writer.
 *
 * Mechanism otherwise mirrors the IR-fallback ratchet
 * (scripts/check-ir-fallbacks.ts) and the AnyValue box-site gate
 * (scripts/check-any-box-sites.mjs): per-file counts; growth fails, shrink
 * banks (automatically under change-scoping; via --update-on-decrease in the
 * legacy mode).
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
 *   node scripts/check-coercion-sites.mjs                    # change-scoped net gate (default)
 *   node scripts/check-coercion-sites.mjs --all              # whole-tree audit vs committed baseline
 *   node scripts/check-coercion-sites.mjs --update           # write current counts (post-merge/main only)
 *   node scripts/check-coercion-sites.mjs --update-on-decrease
 *   node scripts/check-coercion-sites.mjs --verbose          # print per-file breakdown
 */
import { readFileSync, readdirSync, writeFileSync, statSync } from "fs";
import { join, relative, basename } from "path";
import { fileURLToPath } from "node:url";
import { resolveChangeBase, changedPaths, baseBlob, changeSetAllowances } from "./lib/change-scope.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const ROOTS = [
  fileURLToPath(new URL("../src/codegen", import.meta.url)),
  fileURLToPath(new URL("../src/codegen-linear", import.meta.url)),
];
// Repo-relative prefixes matching ROOTS, for change-scoping.
const ROOT_PREFIXES = ["src/codegen/", "src/codegen-linear/"];
const SRC_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const BASELINE_PATH = fileURLToPath(new URL("./coercion-sites-baseline.json", import.meta.url));

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

/** Per-token counts for one file's text. */
function countTokens(text) {
  const perToken = {};
  for (const [tok, re] of PATTERNS) {
    re.lastIndex = 0;
    const n = (text.match(re) || []).length;
    if (n > 0) perToken[tok] = n;
  }
  return perToken;
}

/** Total vocabulary uses in one file's text. */
function countText(text) {
  let total = 0;
  for (const n of Object.values(countTokens(text))) total += n;
  return total;
}

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
    const perToken = countTokens(text);
    let total = 0;
    for (const n of Object.values(perToken)) total += n;
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
const auditAll = args.includes("--all");

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

if (update) {
  // Post-merge/main writer only (#3131) — PRs must not commit the result.
  let prev = {};
  try {
    prev = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  } catch {
    // first run
  }
  if (JSON.stringify(prev) === JSON.stringify(current)) {
    console.log("coercion-sites baseline already current — not rewritten.");
    process.exit(0);
  }
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
  console.log("coercion-sites baseline written:", Object.keys(current).length, "files");
  process.exit(0);
}

/**
 * Change-scoped gate (#3131 scoping, #3279 net rework mirroring
 * check-oracle-ratchet.mjs #3070/#3273): for each changed src/codegen file,
 * count the coercion vocabulary at the base blob vs the working tree, then fail
 * only when the change-set's NET (per vocabulary token, summed over the changed
 * non-allowed files) count grew. Only THIS change-set is judged; the committed
 * baseline is not involved. A byte-identical relocation nets to 0 per token →
 * pass; a genuinely-new hand-rolled coercion nets > 0 → fail. Returns false
 * when the diff cannot be computed (caller falls back to the legacy whole-tree
 * baseline comparison).
 */
function gateScoped() {
  const { base, how } = resolveChangeBase(REPO_ROOT);
  if (!base) return false;
  const changedAll = changedPaths(REPO_ROOT, base, "src");
  if (changedAll === undefined) return false;
  const changed = [...changedAll]
    .filter((p) => p.endsWith(".ts") && ROOT_PREFIXES.some((r) => p.startsWith(r)) && !SANCTIONED.has(basename(p)))
    .sort();
  const allow = changeSetAllowances(REPO_ROOT, base, "coercion-sites-allow");

  // Per-token net delta across the change-set, EXCLUDING allowance-granted
  // files (their intentional growth is sanctioned, so it neither faults nor
  // counts toward the net). A verbatim relocation nets to 0 for every token →
  // pass; a new hand-rolled coercion with no offsetting removal nets > 0 for
  // that token → fail.
  const net = {}; // token -> net delta summed over non-allowed changed files
  const increases = []; // non-allowed files that grew some token (for the report)
  const granted = [];

  for (const p of changed) {
    const key = p.slice("src/".length); // baseline/report keys are src-relative
    const nowTokens = detail[`${key}::tokens`] || {}; // deleted / dropped-to-zero → {}
    const blob = baseBlob(REPO_ROOT, base, p);
    const wasTokens = blob === undefined ? {} : countTokens(blob);
    const nowTotal = current[key] ?? 0;
    const wasTotal = blob === undefined ? 0 : countText(blob);
    const grewTokens = VOCAB.filter((t) => (nowTokens[t] ?? 0) > (wasTokens[t] ?? 0));

    if (allow.has(p)) {
      if (grewTokens.length > 0) {
        granted.push(`  ${key}: ${wasTotal} → ${nowTotal} granted by ${allow.get(p).join(", ")}`);
      }
      continue; // sanctioned — excluded from the net
    }

    for (const t of VOCAB) net[t] = (net[t] ?? 0) + ((nowTokens[t] ?? 0) - (wasTokens[t] ?? 0));

    if (grewTokens.length > 0) {
      const detailStr = grewTokens.map((t) => `${t} ${wasTokens[t] ?? 0}→${nowTokens[t] ?? 0}`).join(", ");
      increases.push(`  ${key}: ${wasTotal} → ${nowTotal} (${detailStr})`);
    }
  }

  if (granted.length > 0) {
    console.log("coercion-sites: intentional growth allowed by this change-set's issue file:\n" + granted.join("\n"));
  }

  const grownTokens = VOCAB.filter((t) => (net[t] ?? 0) > 0);
  if (grownTokens.length > 0) {
    console.error(
      "coercion-sites gate FAILED — this change-set ADDS hand-rolled coercion vocabulary on net " +
        `(${grownTokens.map((t) => `${t} +${net[t]}`).join(", ")}).`,
    );
    console.error("Files whose coercion vocabulary increased:");
    console.error(increases.join("\n"));
    console.error(
      "\nMoving existing coercion sites between files is net-neutral and passes;\n" +
        "this change-set grows the total. Route the coercion through the single\n" +
        "coercion engine (#1917 / #2108). Do NOT hand-roll a fresh\n" +
        "ToString/ToNumber/ToPrimitive/equality matrix.\n" +
        "See plan/log/analysis-2026-06/03-coercion-engine-spec.md §5.\n" +
        "If this growth is an intentional, reviewed migration step, grant THIS\n" +
        "change-set an allowance: list the repo-relative path(s) under a\n" +
        "`coercion-sites-allow:` key in the YAML frontmatter of this PR's own\n" +
        "issue file (any plan/issues/*.md the PR adds or modifies), e.g.\n\n" +
        "  coercion-sites-allow:\n" +
        "    - src/codegen/property-access.ts\n\n" +
        "Do NOT commit changes to scripts/coercion-sites-baseline.json in a PR —\n" +
        "it is refreshed post-merge on main only (#3131).",
    );
    process.exit(1);
  }

  const netSummary = VOCAB.filter((t) => (net[t] ?? 0) !== 0)
    .map((t) => `${t} ${net[t] > 0 ? "+" : ""}${net[t]}`)
    .join(", ");
  console.log(
    `coercion-sites gate: OK (no net vocabulary growth across ${changed.length} changed codegen file(s)` +
      `${netSummary ? `; net ${netSummary}` : ""}; base: ${how}).`,
  );
  return true;
}

// Default path: change-scoped net gate. --update-on-decrease and --all fall
// through to the legacy whole-tree comparison (the former is a writer/banking
// mode, the latter an explicit whole-tree audit).
if (!updateOnDecrease && !auditAll && gateScoped()) {
  process.exit(0);
}

// Legacy whole-tree comparison against the committed baseline — used by --all
// (an explicit whole-tree audit), by --update-on-decrease (a writer mode: the
// post-merge refresh / local banking; PRs must not commit the result, #3131),
// and as the no-git fallback so the gate never crashes a hook outside a git
// context.
let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
} catch {
  // first run
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
      "If this growth is an intentional, reviewed migration step, grant the\n" +
      "change-set a `coercion-sites-allow:` frontmatter allowance (see #3131);\n" +
      "the committed baseline is refreshed post-merge on main only.",
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

console.log(
  `coercion-sites gate: OK (whole-tree${auditAll ? " --all" : " — no git base, committed-baseline mode"}) — no unsanctioned growth vs. baseline.`,
);
