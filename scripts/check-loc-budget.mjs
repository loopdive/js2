// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/check-loc-budget.mjs — LOC-regrowth ratchet (#3102).
//
// WHY THIS EXISTS
// ---------------
// Splitting the codegen god-files never sticks: every past split regrew because
// nothing structurally stops new code from landing in the biggest file.
// `src/codegen/index.ts` went 14,344 (#1013 split, Apr 10) → 6,368 (#1172 audit,
// Apr 25) → 16,565 (Jul 9). In the 12 days to 2026-07-09 four files absorbed
// +7.1k LOC. See plan/log/compiler-consolidation-plan.md §1.2.
//
// This gate is the regrowth brake, modelled on the IR-fallback ratchet (#1376)
// and the oracle ratchet (#1930): a committed baseline
// (scripts/loc-budget-baseline.json) records a per-file line ceiling for every
// `src/**/*.ts` file over the threshold, plus a coarse total-`src`-LOC ceiling.
//
// CHANGE-SCOPED (merge-queue safe). The gate evaluates ONLY the src files the
// current change-set actually modifies — the diff between the working tree and
// `git merge-base origin/main HEAD` (the fork point, so it is the PR's OWN delta
// even after main advances). A frozen ABSOLUTE baseline compared against the
// whole tree wedges the merge queue: `main` advances past some ceiling via an
// unrelated PR, and every subsequent PR's `merge_group` re-run of `quality`
// then fails on a file it never touched (observed on #2808). Scoping to the
// change-set keeps the strict "no regrowth of a file you touch" pressure while
// never blaming a PR for another PR's growth.
//
//   - FAILS when a file the change-set modifies exceeds its recorded ceiling
//     (regrowth) or crosses the threshold newly (a new god-file), or when the
//     change-set is net-additive AND total src LOC exceeds the total ceiling.
//   - GRANDFATHERS everything at its current size — blocks *growth of what you
//     touch*, never demands shrinkage; merges with zero refactoring.
//   - `--update-on-decrease` banks shrinkage: lowers (never raises) the ceilings
//     of files the change-set shrank, so the next PR can't silently regrow them.
//     Staged on disk only; the PR author commits the diff (IR/oracle convention).
//   - `--update` force-reseeds every over-threshold file from current sizes, for
//     the rare PR that deliberately grows a file (visible in review).
//   - `--all` ignores change-scoping and audits the whole tree (local use).
//
// Line count matches `wc -l` (newline count) so the baseline is reproducible
// with `find src -name '*.ts' ! -name '*.d.ts' | xargs wc -l`.
//
// USAGE
//   pnpm run check:loc-budget                           # gate the change-set
//   pnpm run check:loc-budget -- --all                  # audit the whole tree
//   pnpm run check:loc-budget -- --update               # force-reseed the baseline
//   pnpm run check:loc-budget -- --update-on-decrease   # gate, bank decreases
//   pnpm run check:loc-budget -- --json                 # machine-readable snapshot

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/loc-budget-baseline.json");
const SRC_ROOT = join(REPO_ROOT, "src");

// A file crossing this many lines becomes a tracked god-file. 1,500 LOC is the
// point past which a single-file module stops being reviewable in one sitting.
const THRESHOLD = 1500;
// Headroom for the coarse total-`src`-LOC ceiling above the current total. The
// per-file ceilings are the real teeth; this is a runaway backstop against
// sprawl that hides below the threshold across many small files.
const TOTAL_HEADROOM = 75000;

/** Recursively list `.ts` files under `src` (excluding `.d.ts`), sorted. */
function listSrcFiles() {
  const out = [];
  const stack = [SRC_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) stack.push(p);
      else if (s.isFile() && name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
    }
  }
  return out.sort();
}

/** Count lines the way `wc -l` does: number of `\n` bytes. */
function countLines(filePath) {
  const buf = readFileSync(filePath);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) n++;
  }
  return n;
}

/** Repo-relative path with forward slashes, so the baseline is OS-independent. */
function relPath(filePath) {
  return relative(REPO_ROOT, filePath).split(sep).join("/");
}

function git(argv) {
  return execFileSync("git", argv, { cwd: REPO_ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
}
function gitTry(argv) {
  try {
    return git(argv).trim();
  } catch {
    return undefined;
  }
}

/**
 * Resolve the diff base: the merge base of origin/main and HEAD (the fork point,
 * so the diff is this change-set's OWN delta even if main advanced). Falls back
 * to origin/main (a tree diff — shallow-safe, may over-include if main moved),
 * then to undefined (caller audits the whole tree).
 */
function resolveBase() {
  if (gitTry(["rev-parse", "--is-inside-work-tree"]) !== "true") return undefined;
  const hasMain = !!gitTry(["rev-parse", "--verify", "--quiet", "origin/main"]);
  if (!hasMain) return undefined;
  const mb = gitTry(["merge-base", "origin/main", "HEAD"]);
  return mb || "origin/main";
}

/**
 * The set of src `.ts` files the working tree changes relative to `base`
 * (repo-relative, forward-slash). `git diff --name-only <base> -- src` compares
 * the base tree to the WORKING TREE, so it includes committed + uncommitted edits.
 */
function changedSrcFiles(base) {
  const out = gitTry(["diff", "--name-only", base, "--", "src"]);
  if (out === undefined) return undefined;
  const set = new Set();
  for (const line of out.split("\n")) {
    const p = line.trim();
    if (p.endsWith(".ts") && !p.endsWith(".d.ts") && p.startsWith("src/")) set.add(p);
  }
  return set;
}

/** Lines of `path` on `base` (0 if the file is new on this change-set). */
function baseLines(base, path) {
  const blob = gitTry(["show", `${base}:${path}`]);
  if (blob === undefined) return 0;
  let n = 0;
  for (let i = 0; i < blob.length; i++) if (blob[i] === "\n") n++;
  return n;
}

/** Current line count per src file + total. */
function measure() {
  const files = {};
  let total = 0;
  for (const p of listSrcFiles()) {
    const lines = countLines(p);
    files[relPath(p)] = lines;
    total += lines;
  }
  return { files, total };
}

/** Build a fresh baseline: per-file ceilings for files over THRESHOLD + total ceiling. */
function seedBaseline(measured) {
  const files = {};
  for (const [path, lines] of Object.entries(measured.files).sort()) {
    if (lines > THRESHOLD) files[path] = lines;
  }
  return {
    generated: new Date().toISOString().slice(0, 10),
    threshold: THRESHOLD,
    totalCeiling: measured.total + TOTAL_HEADROOM,
    files,
  };
}

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  } catch {
    return undefined;
  }
}

function writeBaseline(baseline) {
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n", "utf-8");
}

function main() {
  const args = new Set(process.argv.slice(2));
  const mode = args.has("--update")
    ? "update"
    : args.has("--update-on-decrease")
      ? "update-on-decrease"
      : args.has("--json")
        ? "json"
        : "gate";
  const auditAll = args.has("--all");

  const measured = measure();

  if (mode === "json") {
    process.stdout.write(JSON.stringify(measured, null, 2) + "\n");
    return;
  }

  if (mode === "update") {
    const next = seedBaseline(measured);
    writeBaseline(next);
    process.stdout.write(
      `Reseeded ${relPath(BASELINE_PATH)}: ${Object.keys(next.files).length} files > ${THRESHOLD} LOC, ` +
        `total ceiling ${next.totalCeiling} (current ${measured.total}).\n`,
    );
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    process.stderr.write(`No baseline at ${relPath(BASELINE_PATH)}. Run with --update to create it.\n`);
    process.exit(1);
  }
  const threshold = baseline.threshold ?? THRESHOLD;
  const baseFiles = baseline.files ?? {};

  // Change-scoping: evaluate only the files this change-set modifies. `--all`
  // (or an unresolvable git base) audits the whole tree.
  const base = auditAll ? undefined : resolveBase();
  const changed = base ? changedSrcFiles(base) : undefined;
  const inScope = (path) => auditAll || changed === undefined || changed.has(path);

  const regrown = []; // baselined, modified, over its recorded ceiling
  const newGiants = []; // non-baselined, modified, crossing the threshold
  let anyDecrease = false;
  let changeNetDelta = 0; // net LOC the change-set adds across modified src files

  for (const [path, lines] of Object.entries(measured.files)) {
    if (!inScope(path)) continue;
    // `grew` blames a PR only for its OWN growth of a file: when a git base is
    // available, a file only counts against the gate if the change-set made it
    // bigger than its size at the fork point. This keeps a stale committed
    // ceiling (main grew the file via an unrelated PR) from blocking a PR that
    // merely edits or shrinks that file. Without a base (`--all` audit) every
    // over-limit file is reported.
    const priorLines = base && changed ? baseLines(base, path) : 0;
    const grew = base && changed ? lines > priorLines : true;
    if (base && changed) changeNetDelta += lines - priorLines;
    if (path in baseFiles) {
      const ceiling = baseFiles[path];
      if (lines > ceiling && grew) regrown.push({ path, ceiling, lines, delta: lines - ceiling });
      else if (lines < ceiling) anyDecrease = true;
    } else if (lines > threshold && grew) {
      newGiants.push({ path, lines, delta: lines - threshold });
    }
  }

  const totalCeiling = baseline.totalCeiling ?? measured.total + TOTAL_HEADROOM;
  // Only fault the total when THIS change-set is net-additive — otherwise an
  // unrelated main advance past the ceiling would wedge every later PR.
  const totalOver = measured.total > totalCeiling && (auditAll || changeNetDelta > 0);

  const failed = regrown.length > 0 || newGiants.length > 0 || totalOver;

  if (failed) {
    process.stderr.write("\nLOC budget gate FAILED (#3102):\n");
    if (regrown.length > 0) {
      process.stderr.write(`\n  Regrown files (over their recorded ceiling):\n`);
      for (const r of regrown.sort((a, b) => b.delta - a.delta)) {
        process.stderr.write(`    ${r.path}: ${r.lines} > ${r.ceiling} (+${r.delta})\n`);
      }
    }
    if (newGiants.length > 0) {
      process.stderr.write(`\n  New god-files (crossed the ${threshold} LOC threshold):\n`);
      for (const g of newGiants.sort((a, b) => b.lines - a.lines)) {
        process.stderr.write(`    ${g.path}: ${g.lines} (> ${threshold}, +${g.delta})\n`);
      }
    }
    if (totalOver) {
      process.stderr.write(`\n  Total src LOC ${measured.total} exceeds ceiling ${totalCeiling}.\n`);
    }
    process.stderr.write(
      `\nAdd code to the subsystem module, not the barrel/driver. See\n` +
        `plan/log/compiler-consolidation-plan.md. If the growth is genuinely intended,\n` +
        `run \`pnpm run check:loc-budget -- --update\` and commit the refreshed baseline\n` +
        `(visible in review).\n`,
    );
    process.exit(1);
  }

  if (mode === "update-on-decrease" && anyDecrease) {
    // Bank the shrink: LOWER the ceilings of files this change-set reduced;
    // never raise (so unrelated drift is not silently banked). Keep everything
    // else — including files not in scope — exactly as the committed baseline.
    const nextFiles = { ...baseFiles };
    for (const [path, lines] of Object.entries(measured.files)) {
      if (!inScope(path)) continue;
      if (path in nextFiles && lines < nextFiles[path]) nextFiles[path] = lines;
    }
    const next = {
      generated: new Date().toISOString().slice(0, 10),
      threshold,
      totalCeiling: Math.min(totalCeiling, measured.total + TOTAL_HEADROOM),
      files: nextFiles,
    };
    writeBaseline(next);
    process.stdout.write(
      `\nLOC budget gate: ratcheted baseline (banked per-file shrink; total src ${measured.total}). ` +
        `Staged update to ${relPath(BASELINE_PATH)} — commit it with the PR.\n`,
    );
    return;
  }

  const scopeNote = auditAll || changed === undefined ? "whole tree" : `${changed.size} changed src file(s)`;
  process.stdout.write(
    `\nLOC budget gate: OK — no regrowth in ${scopeNote}. ` +
      `${Object.keys(baseFiles).length} files tracked, total src ${measured.total}/${totalCeiling}.\n`,
  );
}

main();
