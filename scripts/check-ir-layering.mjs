#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3113 S1 — the IR→codegen LAYERING RATCHET.
//
// WHY THIS GATE EXISTS. The intended layering is `emit` <- `ir` <- `codegen`:
// codegen consumes the IR, and the IR consumes nothing above it. Reality has
// been drifting the other way for months, and nothing measured it:
//
//     issue filed (2026-07-09)      6 files /  25 import lines
//     after slice 1  (2026-07-17)   (js-tag moved below IR)
//     re-measured    (2026-08-21)  20 files /  96 import lines
//
// A ~4x regrowth in six weeks, entirely invisible, because the boundary was a
// convention rather than a check. The IR is supposed to become the primary
// front-end (#2855); a front-end that imports the legacy path's internals can
// never let that path be deleted.
//
// WHY A RATCHET AND NOT AN EMPTINESS CHECK. The issue's original acceptance
// criterion was `grep -rn 'from "../codegen' src/ir/` -> empty. That is not
// reachable today: `ir/integration.ts` alone is 7,000+ LOC of IR->codegen
// bridge and its containment (#3113 S3) is blocked on the in-flight #3520/#3521
// branches. So this gate enforces the reachable invariant instead — "no
// growth, ratchet toward zero" — which is what actually stops the regrowth
// while the structural fix waits its turn.
//
// WHAT IS COUNTED, per file under `src/ir/`:
//   Every import/export STATEMENT whose module specifier resolves to a path
//   under `src/codegen/`. That includes:
//     - `import { x } from "../codegen/y.js"`
//     - `import type { X } from "../codegen/y.js"`   <- type-only counts too:
//       the boundary is about the dependency GRAPH, and a type import is a
//       real edge in it (it constrains what may move, and tsc follows it).
//     - `export { x } from "../codegen/y.js"` (re-export pass-throughs)
//     - `await import("../codegen/y.js")` (dynamic — otherwise a trivial bypass)
//   Specifiers are RESOLVED, not prefix-matched. That distinction is
//   load-bearing: `src/codegen-linear/` is a SIBLING directory, so the obvious
//   `from "../codegen` grep matches `../../codegen-linear/context.js` too and
//   over-counts. (It over-counted by 4 lines when this gate was written — the
//   whole of `ir/backend/linear-integration.ts`'s apparent debt but one.)
//
// WHAT IS NOT COUNTED:
//   - `src/codegen-linear/**` — a sibling BACKEND, not the WasmGC codegen
//     layer this issue is about. Its count is reported as an informational
//     line so the omission is visible rather than silent, but it does not gate.
//   - Whole-line comments (`//`, `*`, `/*`).
//
// GATE SEMANTICS (cloned from `scripts/check-linear-ir.ts`):
//   - any per-file count INCREASE                       -> FAIL
//   - any NEW file acquiring codegen imports            -> FAIL
//   - decreases / removed files                         -> PASS, with a hint
//     to bank them via `--update`
//
// Usage:
//   node scripts/check-ir-layering.mjs              # gate against baseline
//   node scripts/check-ir-layering.mjs --update     # refresh/seed the baseline
//   node scripts/check-ir-layering.mjs --json       # machine-readable
//   node scripts/check-ir-layering.mjs --verbose    # per-import-line detail
//   node scripts/check-ir-layering.mjs --src <dir> --baseline <file>
//                                                   # scan an alternate tree
//                                                   # (used by the unit test)

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── argv ──────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flagValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : undefined;
}
const update = argv.includes("--update");
const json = argv.includes("--json");
const verbose = argv.includes("--verbose");

// Under `--json`, stdout carries the machine-readable payload and NOTHING
// else — the human verdict goes to stderr so a caller can pipe stdout into a
// parser without stripping a trailing summary line first.
const say = (msg) => (json ? console.error(msg) : console.log(msg));

const SRC_DIR = resolve(REPO_ROOT, flagValue("--src") ?? "src");
const BASELINE_PATH = resolve(REPO_ROOT, flagValue("--baseline") ?? "scripts/ir-layering-baseline.json");

const IR_DIR = join(SRC_DIR, "ir");
const CODEGEN_DIR = join(SRC_DIR, "codegen");

/** Every `.ts` file under `dir`, recursively, excluding declaration files. */
function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts") && !full.endsWith(".d.ts")) out.push(full);
  }
  return out;
}

/** True when `p` is the directory `dir` itself or anything beneath it. */
function isUnder(p, dir) {
  return p === dir || p.startsWith(dir + sep);
}

/**
 * Module specifiers referenced by one source line.
 *
 * Static `import`/`export ... from "x"`, bare `import "x"`, and dynamic
 * `import("x")` all produce a dependency edge, so all three are collected.
 */
function specifiersOnLine(line) {
  const trimmed = line.trim();
  // Whole-line comments only. A partial trailing comment cannot introduce a
  // `from "..."` that wasn't already an import, so this is sufficient and it
  // never mangles a string literal the way full comment-stripping can.
  if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) return [];

  const out = [];
  for (const re of [
    /(?:^|[\s})])from\s+"([^"]+)"/g, // import/export ... from "x"
    /^\s*import\s+"([^"]+)"/g, //       bare side-effect import
    /\bimport\(\s*"([^"]+)"/g, //       dynamic import("x")
  ]) {
    for (const m of line.matchAll(re)) out.push(m[1]);
  }
  return out;
}

// ── measure ───────────────────────────────────────────────────────────────
/** @type {Record<string, number>} */
const files = {};
/** @type {{file: string, line: number, specifier: string}[]} */
const hits = [];
let linearHits = 0;

for (const file of walk(IR_DIR)) {
  const rel = relative(SRC_DIR, file).split(sep).join("/");
  const text = readFileSync(file, "utf8");
  for (const [i, line] of text.split("\n").entries()) {
    for (const spec of specifiersOnLine(line)) {
      if (!spec.startsWith(".")) continue; // bare package specifier
      const resolved = resolve(dirname(file), spec);
      if (isUnder(resolved, CODEGEN_DIR)) {
        files[rel] = (files[rel] ?? 0) + 1;
        hits.push({ file: rel, line: i + 1, specifier: spec });
      } else if (isUnder(resolved, `${CODEGEN_DIR}-linear`)) {
        linearHits += 1;
      }
    }
  }
}

const total = Object.values(files).reduce((a, b) => a + b, 0);
const current = {
  total,
  files: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))),
};

if (json) console.log(JSON.stringify({ current, hits }, null, 2));
if (verbose) {
  for (const h of hits) say(`  ${h.file}:${h.line}  ${h.specifier}`);
}

// ── seed / update ─────────────────────────────────────────────────────────
if (update || !existsSync(BASELINE_PATH)) {
  writeFileSync(BASELINE_PATH, `${JSON.stringify({ generated: new Date().toISOString(), ...current }, null, 2)}\n`);
  say(
    `ir-layering ratchet: baseline ${update ? "updated" : "seeded"} — ` +
      `${total} import lines across ${Object.keys(files).length} files under src/ir/`,
  );
  process.exit(0);
}

// ── gate ──────────────────────────────────────────────────────────────────
const baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8"));
const baseFiles = baseline.files ?? {};
const failures = [];

for (const [file, count] of Object.entries(current.files)) {
  const base = baseFiles[file];
  if (base === undefined) {
    failures.push(`NEW file with codegen imports: ${file} (${count} import line${count === 1 ? "" : "s"})`);
  } else if (count > base) {
    failures.push(`${file}: codegen imports INCREASED ${base} → ${count}`);
  }
}

if (failures.length > 0) {
  console.error("ir-layering ratchet: FAIL — src/ir/ must not grow its dependency on src/codegen/.");
  for (const f of failures) console.error(`  - ${f}`);
  console.error(
    "\nThe intended layering is emit <- ir <- codegen: the IR consumes nothing above it.\n" +
      "Fix by moving the needed vocabulary BELOW the IR (as #3113 slice 1 did for js-tag.ts),\n" +
      "or by routing the call through the bridge (src/ir/integration.ts) instead of a new edge.\n" +
      "If the growth is genuinely intended, run `pnpm run check:ir-layering -- --update`\n" +
      "and commit the refreshed baseline so the increase is visible in review.",
  );
  process.exit(1);
}

const removed = Object.keys(baseFiles).filter((f) => current.files[f] === undefined);
const decreased = Object.entries(current.files).filter(([f, c]) => c < (baseFiles[f] ?? 0));
const improved = removed.length > 0 || decreased.length > 0;

say(
  `ir-layering ratchet: OK — ${total} import lines across ${Object.keys(current.files).length} files ` +
    `(baseline ${baseline.total})` +
    (improved ? " [improved — run with --update to bank it]" : "") +
    (linearHits > 0 ? `\n  note: ${linearHits} src/codegen-linear/ import lines are NOT gated (sibling backend)` : ""),
);
