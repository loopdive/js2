#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// scripts/check-orphaned-scripts.mjs — orphaned-script ratchet (#6799).
//
// WHY THIS EXISTS. `scripts/` grows by accretion: a one-off probe, a runner
// that a workflow stopped calling, a helper whose only caller was deleted. The
// 2026-09-30 review counted 271 top-level files, 44 (16 %) of them referenced
// by nothing that runs or documents them. Nobody can tell a dead script from a
// live one by looking, so dead ones are read, "fixed" and kept in sync forever.
// This gate does not demand the count be zero; it demands it never GROW, and it
// banks every decrease.
//
// WHAT "ORPHANED" MEANS. A tracked file directly under `scripts/` (not its
// subdirectories — those are libraries and fixtures reached through their
// parent script) whose name appears in NONE of:
//
//   - the repo-root files (package.json scripts, root configs, CLAUDE.md, …)
//   - anything tracked under .github/ .husky/ .claude/ docs/ plan/method/
//   - any OTHER tracked file under scripts/ (including its subdirectories)
//
// `tests/`, `plan/issues/` and `website/` deliberately do not count: a script
// only a test imports, or only an issue's history mentions, is not wired into
// anything that runs. (They DO count when deciding whether to delete one — the
// gate's job is to stop growth, not to authorise deletions.)
//
// MATCHING. Every source file is tokenised on path-ish characters, so
// `scripts/foo.mjs`, `./foo.mjs`, `node scripts/foo.mjs --x` and
// `[foo.mjs](…)` all yield the token `foo.mjs`, while `foo.test.mjs` or
// `prefoo.mjs` do not. A `.ts`/`.mts`/`.cts` file also matches its emitted
// `.js`/`.mjs`/`.cjs` import name. A reference assembled at runtime
// (`scripts/${name}.mjs`) is invisible — such a script reads as orphaned and
// belongs in the baseline with a note, or behind a literal reference.
//
// USAGE
//   node scripts/check-orphaned-scripts.mjs                       # gate (CI `quality`)
//   node scripts/check-orphaned-scripts.mjs --list                # print every orphan
//   node scripts/check-orphaned-scripts.mjs --json                # machine-readable
//   node scripts/check-orphaned-scripts.mjs --update-on-decrease  # bank a shrink
//   node scripts/check-orphaned-scripts.mjs --update              # rewrite the baseline
//
// Gate: exit 1 when a file is orphaned that the baseline does not list (a NEW
// orphan — wire it up, delete it, or, if it is genuinely run by hand, mention
// it in docs/). Baseline entries that are no longer orphaned (deleted or newly
// referenced) pass with a note; `--update-on-decrease` writes the smaller set
// and refuses if anything new appeared. `--update` is for an intentional
// addition and needs a PR note saying why.

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BASELINE_REL = "scripts/orphaned-scripts-baseline.json";
const BASELINE_PATH = join(ROOT, BASELINE_REL);
const REFERENCE_DIRS = [".github/", ".husky/", ".claude/", "docs/", "plan/method/"];
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const TOKEN_RE = /[A-Za-z0-9_][A-Za-z0-9_.+-]*/g;

function trackedFiles() {
  return execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
    .split("\0")
    .filter(Boolean);
}

function isReferenceSource(path) {
  // The baseline LISTS every orphan by name; counting it as a reference would
  // make every listed orphan look referenced and the gate pass vacuously.
  if (path === BASELINE_REL) return false;
  if (!path.includes("/")) return true; // repo root: package.json, configs, *.md
  if (path.startsWith("scripts/")) return true;
  return REFERENCE_DIRS.some((d) => path.startsWith(d));
}

function readText(path) {
  try {
    const buf = readFileSync(join(ROOT, path));
    if (buf.length > MAX_SOURCE_BYTES) return null;
    if (buf.subarray(0, 8192).includes(0)) return null; // binary
    return buf.toString("utf8");
  } catch {
    return null; // tracked but missing from the working tree
  }
}

/** token -> set of source paths containing it */
function buildTokenIndex(sources, read) {
  const index = new Map();
  for (const path of sources) {
    const text = read(path);
    if (text === null) continue;
    for (const raw of text.match(TOKEN_RE) ?? []) {
      const token = raw.replace(/\.+$/, "");
      let set = index.get(token);
      if (!set) index.set(token, (set = new Set()));
      set.add(path);
    }
  }
  return index;
}

/** Names under which a script can be referenced. */
export function referenceNames(basename) {
  const names = [basename];
  const m = /^(.*)\.(ts|mts|cts)$/.exec(basename);
  if (m) names.push(`${m[1]}.${{ ts: "js", mts: "mjs", cts: "cjs" }[m[2]]}`);
  return names;
}

export function findOrphans(files = trackedFiles(), read = readText) {
  const candidates = files.filter((f) => /^scripts\/[^/]+$/.test(f));
  const index = buildTokenIndex(files.filter(isReferenceSource), read);
  const orphans = [];
  for (const path of candidates) {
    const base = path.slice("scripts/".length);
    const referenced = referenceNames(base).some((name) => {
      const where = index.get(name);
      if (!where) return false;
      for (const src of where) if (src !== path) return true;
      return false;
    });
    if (!referenced) orphans.push(path);
  }
  return { total: candidates.length, orphans: orphans.sort() };
}

function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
}

function writeBaseline(orphans) {
  const body = {
    description:
      "Top-level scripts/ files referenced by nothing that runs or documents them (#6799). " +
      "Maintained by scripts/check-orphaned-scripts.mjs; the gate fails on any orphan not listed here.",
    count: orphans.length,
    orphans,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(body, null, 2)}\n`);
}

function main(argv) {
  const args = new Set(argv);
  const { total, orphans } = findOrphans();

  if (args.has("--json")) {
    process.stdout.write(`${JSON.stringify({ total, count: orphans.length, orphans }, null, 2)}\n`);
    return 0;
  }
  if (args.has("--update")) {
    writeBaseline(orphans);
    console.log(`orphaned-scripts: baseline written — ${orphans.length} orphaned of ${total}.`);
    return 0;
  }

  const baseline = readBaseline();
  if (!baseline) {
    console.error(
      "orphaned-scripts: FAILED — no scripts/orphaned-scripts-baseline.json (run with --update to seed it).",
    );
    return 1;
  }
  const known = new Set(baseline.orphans);
  const fresh = orphans.filter((o) => !known.has(o));
  const current = new Set(orphans);
  const resolved = baseline.orphans.filter((o) => !current.has(o));

  if (args.has("--list")) for (const o of orphans) console.log(`  ${known.has(o) ? "" : "NEW "}${o}`);

  if (fresh.length) {
    console.error(`\norphaned-scripts: ${fresh.length} NEW orphaned script(s) — referenced by nothing that runs them:`);
    for (const o of fresh) console.error(`  ${o}`);
    console.error(
      "Wire each into package.json / a workflow / a hook / another script, delete it, or (if it is run by hand)\n" +
        "document it under docs/. Banking it with --update needs a PR note saying why.",
    );
    console.error(
      `orphaned-scripts: FAILED (${orphans.length} orphaned of ${total}; baseline ${baseline.orphans.length})`,
    );
    return 1;
  }

  if (resolved.length) {
    if (args.has("--update-on-decrease")) {
      writeBaseline(orphans);
      console.log(`orphaned-scripts: baseline lowered ${baseline.orphans.length} -> ${orphans.length}.`);
    } else {
      console.log(`orphaned-scripts: ${resolved.length} baseline entr(y/ies) no longer orphaned:`);
      for (const o of resolved) console.log(`  ${o}`);
      console.log("Bank the decrease with: pnpm run check:orphaned-scripts -- --update-on-decrease");
    }
  }
  console.log(`orphaned-scripts: OK — ${orphans.length} orphaned of ${total} (baseline ${baseline.orphans.length}).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
