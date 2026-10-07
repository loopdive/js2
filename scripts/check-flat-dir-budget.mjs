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
// Gate semantics — change-scoped, like check:loc-budget / check:func-budget:
//   the count at HEAD is compared with the count at the change-set's own base
//   (scripts/lib/change-scope.mjs). It FAILS when the count grew by more than
//   the number of added top-level files this change-set grants. The committed
//   budget is not read on that path, so PRs never edit
//   scripts/flat-dir-budget-baseline.json.
//
// INTENDED GROWTH: list each new top-level file under `flat-dir-budget-allow:`
// in the YAML frontmatter of an issue file the change-set itself adds or
// modifies (a `# <date>: <why>` comment after the path is kept for review and
// ignored by the gate):
//
//   flat-dir-budget-allow:
//     - src/codegen/foo-helper.ts # 2026-10-02 (#NNNN): must sit next to index.ts because …
//
// The committed budget is a low-water mark: the post-merge jobs lower it with
// `--update-on-decrease` (never raising it), and it is the reference only when
// no base can be resolved. `--update` is a deliberate human re-seed.
//
// Usage:
//   node scripts/check-flat-dir-budget.mjs                      # gate
//   node scripts/check-flat-dir-budget.mjs --update-on-decrease # bank drops (post-merge)
//   node scripts/check-flat-dir-budget.mjs --update             # (re)seed budgets
//   node scripts/check-flat-dir-budget.mjs --root <dir> --baseline <file>
//                                                               # alternate tree (tests)

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { baseBlob, changedPaths, changeSetAllowances, resolveChangeBase } from "./lib/change-scope.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const ROOT = realpathSync(resolve(REPO_ROOT, flagValue("--root") ?? "."));
const BASELINE_PATH = resolve(REPO_ROOT, flagValue("--baseline") ?? "scripts/flat-dir-budget-baseline.json");

/** Directories under budget when the baseline does not exist yet (seeding). */
const DEFAULT_DIRS = ["src/codegen"];

const isFlatTs = (name) => name.endsWith(".ts") && !name.endsWith(".d.ts");

function flatCount(dir) {
  const abs = join(ROOT, dir);
  if (!existsSync(abs)) throw new Error(`budgeted directory not found: ${abs}`);
  return readdirSync(abs).filter((name) => isFlatTs(name) && statSync(join(abs, name)).isFile()).length;
}

/** Top level of the work tree containing `dir`, or undefined outside one. */
function workTreeRoot(dir) {
  try {
    // Without GIT_*: inside a hook GIT_DIR would answer for the hook's repo, not `dir`'s.
    const top = execFileSync("git", ["-C", dir, "rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return top ? realpathSync(top) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Top-level files of `dir` the change-set added and removed, as repo-relative
 * paths. Undefined when the diff against `base` fails.
 */
function flatChanges(repoRoot, base, dir) {
  const prefix = relative(repoRoot, join(ROOT, dir)).split(sep).join("/");
  const changed = changedPaths(repoRoot, base, prefix);
  if (changed === undefined) return undefined;
  const added = [];
  const removed = [];
  for (const path of [...changed].sort()) {
    const name = path.slice(prefix.length + 1);
    if (name.includes("/") || !isFlatTs(name)) continue;
    const atHead = existsSync(join(repoRoot, path));
    const atBase = baseBlob(repoRoot, base, path) !== undefined;
    if (atHead && !atBase) added.push(path);
    else if (!atHead && atBase) removed.push(path);
  }
  return { added, removed };
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

// Post-merge banking: lower the budget, never raise it, never fail.
if (argv.includes("--update-on-decrease")) {
  const under = dirs.filter((d) => counts[d] < budgets[d]);
  if (under.length > 0) write(Object.fromEntries(dirs.map((d) => [d, Math.min(budgets[d], counts[d])])));
  for (const d of under) console.log(`flat-dir budget: banked ${d}/*.ts ${budgets[d]} → ${counts[d]}`);
  if (under.length === 0) console.log("flat-dir budget: nothing to bank");
  process.exit(0);
}

// Gate: against the change-set's own base when one resolves.
const repoRoot = workTreeRoot(ROOT);
const { base, how } = repoRoot ? resolveChangeBase(repoRoot) : { base: undefined, how: "no-git" };
const allow = base ? changeSetAllowances(repoRoot, base, "flat-dir-budget-allow") : new Map();
const granted = new Map(); // path -> granting issue files (comments after `#` stripped)
for (const [item, sources] of allow) granted.set(item.replace(/\s+#.*$/, "").trim(), sources);

const failures = [];
const notes = [];
for (const d of dirs) {
  const changes = base ? flatChanges(repoRoot, base, d) : undefined;
  if (changes) {
    const baseCount = counts[d] - changes.added.length + changes.removed.length;
    const growth = counts[d] - baseCount;
    const allowedAdds = changes.added.filter((p) => granted.has(p));
    for (const p of allowedAdds) notes.push(`granted ${p} by ${granted.get(p).join(", ")}`);
    if (growth > allowedAdds.length) {
      const unallowed = changes.added.filter((p) => !granted.has(p));
      failures.push(
        `${d}/*.ts: ${baseCount} → ${counts[d]} (+${growth}, ${allowedAdds.length} granted; base: ${how})` +
          (unallowed.length > 0 ? `\n      not granted: ${unallowed.join(", ")}` : ""),
      );
    }
  } else if (counts[d] > budgets[d]) {
    failures.push(`${d}/*.ts: ${budgets[d]} → ${counts[d]} (+${counts[d] - budgets[d]}; committed budget, ${how})`);
  }
}

if (failures.length > 0) {
  console.error("flat-dir budget: FAIL — a budgeted directory gained top-level files.");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nPut new files in one of the existing sub-directories, or move an existing flat file into one\n" +
      "in the same change so the count does not grow. If a new top-level file is deliberate, list it\n" +
      "in the frontmatter of this change-set's own plan/issues/*.md file:\n" +
      "  flat-dir-budget-allow:\n" +
      "    - src/codegen/<file>.ts # <date> (#issue): <why>\n" +
      "Do not edit scripts/flat-dir-budget-baseline.json; main's post-merge job is its sole writer.",
  );
  process.exit(1);
}
for (const n of notes) console.log(`flat-dir budget: ${n}`);
console.log(
  `flat-dir budget: OK — ${dirs.map((d) => `${d}/*.ts ${counts[d]}`).join(", ")} (${base ? `base: ${how}` : `committed budget, ${how}`})`,
);
