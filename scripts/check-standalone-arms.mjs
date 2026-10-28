#!/usr/bin/env node
/**
 * #7143 slice A1 — standalone-arm ratchet.
 *
 * Track A of the legacy-deletion plan collapses the `ctx.standalone` /
 * `ctx.wasi` / `noJsHost(` lowering arms directory by directory (#6979 S7-c).
 * Between 10-14 and 10-25 the arm count still GREW (+69 lines), so every
 * deletion PR was racing new arms. This gate stops the growth: a change-set may
 * not add net arm lines, and every collapse banks automatically.
 *
 * Counted unit: source LINES matching each token (the `rg -c` unit the plan's
 * §1.1 table uses), over `src/**\/*.ts`:
 *   - `ctx.standalone`   — any standalone-mode branch or flag read
 *   - `!ctx.standalone`  — the host-only else arm (the deletion target)
 *   - `noJsHost(`        — the combined standalone|wasi predicate
 *   - `ctx.wasi`         — the WASI branch
 *
 * Default run is CHANGE-SCOPED and NET-PER-TOKEN, exactly like
 * check-coercion-sites.mjs (#3131/#3279): each changed src file is counted at
 * the base blob and in the working tree, and the gate fails only when the
 * change-set's NET count of some token grew. Moving an arm between files is
 * net-neutral; a new arm with no offsetting removal fails. Intentional growth
 * (a reviewed one-off) is granted per change-set with a
 * `standalone-arms-allow:` frontmatter list of repo-relative paths in the PR's
 * own plan/issues/*.md file.
 *
 * The committed baseline (scripts/standalone-arms-baseline.json, per-directory
 * per-token counts) is read only by --all and the no-git fallback; it is
 * written by --update / --update-on-decrease. PRs must not commit changes to it
 * (main is the sole writer), apart from the PR that introduces it.
 *
 * Usage:
 *   node scripts/check-standalone-arms.mjs                     # change-scoped net gate (default)
 *   node scripts/check-standalone-arms.mjs --all               # whole-tree audit vs baseline
 *   node scripts/check-standalone-arms.mjs --update            # write current counts (main only)
 *   node scripts/check-standalone-arms.mjs --update-on-decrease
 *   node scripts/check-standalone-arms.mjs --verbose           # per-directory totals
 */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveChangeBase, changedPaths, baseBlob, changeSetAllowances } from "./lib/change-scope.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url)).replace(/\/$/, "");
const SRC_ROOT = join(REPO_ROOT, "src");
const BASELINE_PATH = fileURLToPath(new URL("./standalone-arms-baseline.json", import.meta.url));
const ALLOW_KEY = "standalone-arms-allow";

export const TOKENS = [
  ["ctx.standalone", /ctx\.standalone/],
  ["!ctx.standalone", /!ctx\.standalone/],
  ["noJsHost(", /noJsHost\(/],
  ["ctx.wasi", /ctx\.wasi/],
];

/** Per-token count of matching lines in one file's text. */
export function countLines(text) {
  const counts = Object.fromEntries(TOKENS.map(([name]) => [name, 0]));
  for (const line of text.split("\n")) {
    for (const [name, re] of TOKENS) if (re.test(line)) counts[name]++;
  }
  return counts;
}

function addInto(target, counts) {
  for (const [name] of TOKENS) target[name] = (target[name] ?? 0) + (counts[name] ?? 0);
}

function walk(dir, out) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else if (ent.isFile() && ent.name.endsWith(".ts")) out.push(full);
  }
}

/** Whole-tree counts keyed by src-relative directory, plus a "total" row. */
function countTree() {
  const files = [];
  walk(SRC_ROOT, files);
  const byDir = {};
  const total = {};
  for (const full of files) {
    const counts = countLines(readFileSync(full, "utf8"));
    if (!TOKENS.some(([name]) => counts[name] > 0)) continue;
    const dir = relative(SRC_ROOT, dirname(full)) || ".";
    addInto((byDir[dir] ??= {}), counts);
    addInto(total, counts);
  }
  const sorted = Object.fromEntries(
    Object.keys(byDir)
      .sort()
      .map((k) => [k, byDir[k]]),
  );
  return { total, byDir: sorted };
}

const fmt = (counts) => TOKENS.map(([name]) => `${name} ${counts[name] ?? 0}`).join(", ");

/** Change-scoped net gate. Returns false when no diff base is resolvable. */
function gateScoped() {
  const { base, how } = resolveChangeBase(REPO_ROOT);
  if (!base) return false;
  const changedAll = changedPaths(REPO_ROOT, base, "src");
  if (changedAll === undefined) return false;
  const changed = [...changedAll].filter((p) => p.startsWith("src/") && p.endsWith(".ts")).sort();
  const allow = changeSetAllowances(REPO_ROOT, base, ALLOW_KEY);
  const net = {};
  const grownFiles = [];
  for (const p of changed) {
    let nowText = "";
    try {
      nowText = readFileSync(join(REPO_ROOT, p), "utf8");
    } catch {
      // deleted in the working tree → counts as 0
    }
    const now = countLines(nowText);
    const blob = baseBlob(REPO_ROOT, base, p);
    const was = blob === undefined ? countLines("") : countLines(blob);
    const grew = TOKENS.filter(([name]) => now[name] > was[name]).map(([name]) => name);
    if (allow.has(p)) {
      if (grew.length) console.log(`standalone-arms: ${p} growth granted by ${allow.get(p).join(", ")}`);
      continue;
    }
    for (const [name] of TOKENS) net[name] = (net[name] ?? 0) + now[name] - was[name];
    if (grew.length) grownFiles.push(`  ${p}: ${grew.map((n) => `${n} ${was[n]}→${now[n]}`).join(", ")}`);
  }
  const grownTokens = TOKENS.map(([name]) => name).filter((name) => (net[name] ?? 0) > 0);
  if (grownTokens.length > 0) {
    console.error(
      `standalone-arms gate FAILED — this change-set adds ${grownTokens.map((n) => `${n} +${net[n]}`).join(", ")} on net.`,
    );
    console.error("Files whose arm count grew:\n" + grownFiles.join("\n"));
    console.error(
      "\nTrack A (#7143 / #6979 S7-c) is collapsing these arms; new code must not add\n" +
        "standalone/host/WASI branches. Write the mode-neutral (native) lowering once.\n" +
        "Moving an existing arm between files is net-neutral and passes. If this growth\n" +
        "is a reviewed one-off, list the path under `" +
        ALLOW_KEY +
        ":` in the YAML\nfrontmatter of this PR's own plan/issues/*.md file.",
    );
    process.exit(1);
  }
  const moved = TOKENS.map(([name]) => name).filter((name) => (net[name] ?? 0) !== 0);
  const summary = moved.map((n) => `${n} ${net[n]}`).join(", ");
  console.log(
    `standalone-arms gate: OK (no net arm growth across ${changed.length} changed src file(s)` +
      `${summary ? `; net ${summary}` : ""}; base: ${how}).`,
  );
  return true;
}

function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
  } catch {
    return { total: {}, byDir: {} };
  }
}

function writeBaseline(current) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
}

/** Whole-tree comparison against the committed per-directory baseline. */
function gateWholeTree(current, { updateOnDecrease, auditAll }) {
  const baseline = readBaseline();
  const grown = [];
  const shrank = [];
  const dirs = new Set([...Object.keys(baseline.byDir ?? {}), ...Object.keys(current.byDir)]);
  for (const dir of [...dirs].sort()) {
    for (const [name] of TOKENS) {
      const was = baseline.byDir?.[dir]?.[name] ?? 0;
      const now = current.byDir[dir]?.[name] ?? 0;
      if (now > was) grown.push(`  ${dir}: ${name} ${was} → ${now}`);
      else if (now < was) shrank.push(`  ${dir}: ${name} ${was} → ${now}`);
    }
  }
  if (grown.length > 0) {
    console.error("standalone-arms gate FAILED — arm lines grew vs the committed baseline:\n" + grown.join("\n"));
    process.exit(1);
  }
  if (shrank.length > 0 && updateOnDecrease) {
    writeBaseline(current);
    console.log("standalone-arms baseline ratcheted down:\n" + shrank.join("\n"));
  } else if (shrank.length > 0) {
    console.log("standalone-arms decreased (run --update-on-decrease to bank it):\n" + shrank.join("\n"));
  }
  console.log(
    `standalone-arms gate: OK (whole-tree${auditAll ? " --all" : ", committed-baseline mode"}; ${fmt(current.total)}).`,
  );
}

function main(args) {
  const current = countTree();
  if (args.includes("--verbose")) {
    for (const [dir, counts] of Object.entries(current.byDir)) console.error(`  ${dir}: ${fmt(counts)}`);
    console.error(`  total: ${fmt(current.total)}`);
  }
  if (args.includes("--update")) {
    writeBaseline(current);
    console.log(`standalone-arms baseline written (${fmt(current.total)}).`);
    return;
  }
  const updateOnDecrease = args.includes("--update-on-decrease");
  const auditAll = args.includes("--all");
  if (!updateOnDecrease && !auditAll && gateScoped()) return;
  gateWholeTree(current, { updateOnDecrease, auditAll });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
