#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3954 phase 2 — the core <-> JS-dialect boundary gate.
//
// The split of `src/ir/nodes.ts` into a language-neutral core and a JavaScript
// dialect (`src/ir/dialect/js.ts`) is only worth anything if it cannot silently
// erode. A convention decays; a gate does not. This is the dependency-lint rule
// #3954 phase 2 calls for, in the shape the repo already uses for its other
// ratchets.
//
// Two rules, both narrow on purpose:
//
//   R1  The dialect may be imported from exactly ONE place in the REPO:
//       `src/ir/nodes.ts`, which assembles the `IrInstr` union and re-exports
//       the dialect's names so existing importers are unaffected. Any other
//       file reaching into `dialect/` means the boundary has stopped meaning
//       anything.
//
//       R1 scans **all of `src/`**, not just `src/ir/` (#4552 finding D1). The
//       first cut walked `src/ir/` only, which made the rule enforceable inside
//       the IR tree and merely true-by-luck outside it: adding
//       `import type { IrInstrAwait } from "../ir/dialect/js.js"` to
//       `src/codegen/peephole.ts` passed the gate with exit 0. `nodes.ts` is
//       documented as the only legitimate importer repo-wide, so the walk has
//       to match that claim — a boundary a consumer can step around is not a
//       boundary. This also settles #4552 §1's "should the gate assert the
//       converse?" question: core files legitimately *reference* dialect kinds
//       (verifiers and lowerers dispatch over the whole union — that is the
//       union edge working as designed); the enforceable converse is exactly
//       "no import path to the dialect except `nodes.ts`", which is R1 at full
//       scope.
//
//   R2  Every name the dialect declares must be re-exported by `nodes.ts`.
//       The split is a declaration move, not an API change: 54 files import
//       `nodes.js`, and a name that stops being re-exported breaks them for no
//       reason the split intends.
//
// What this gate deliberately does NOT do: decide whether a given instruction
// kind belongs in the dialect. That question is genuinely unsettled for the
// `vec.*` / `class.*` / `object.*` / `string.*` families and is owned by #4551,
// which produces a per-kind verdict with cited evidence. Encoding a guess here
// would give a wrong answer the authority of a CI gate.

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

// `--src <dir>` repoints every path at a synthetic tree, which is what
// `tests/issue-4552-ir-dialect-gate-scope.test.ts` uses to prove the gate
// FAILS on an out-of-IR import without planting one in the real `src/`.
const srcArg = process.argv.indexOf("--src");
const SRC_DIR = srcArg === -1 ? "src" : process.argv[srcArg + 1];
const IR_DIR = path.join(SRC_DIR, "ir");
const DIALECT_DIR = path.join(IR_DIR, "dialect");
const UNION_HOST = path.join(IR_DIR, "nodes.ts");

/** Every `.ts` file under a directory, recursively. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const failures = [];

// ── R1: only nodes.ts may import the dialect ──────────────────────────────
// Matching is RESOLUTION-based, not a `dialect/` substring test: a relative
// specifier is resolved against the importing file's directory and flagged only
// if it lands inside `src/ir/dialect/`. At repo scope a substring test would
// also flag any unrelated future `…/dialect/…` path, and the point of widening
// the walk is to catch real edges to THIS dialect, not to claim the word.
const importFrom = /from\s+"([^"]*)"/;

/** Does this import specifier, seen in `file`, reach into the JS dialect? */
function reachesDialect(specifier, file) {
  if (!specifier.startsWith(".")) return false; // no aliases resolve here today
  const resolved = path.resolve(path.dirname(file), specifier);
  return resolved.startsWith(path.resolve(DIALECT_DIR) + path.sep);
}

for (const file of walk(SRC_DIR)) {
  if (file.startsWith(DIALECT_DIR + path.sep) || file === DIALECT_DIR) continue;
  if (path.normalize(file) === path.normalize(UNION_HOST)) continue;
  const text = readFileSync(file, "utf8");
  for (const [i, line] of text.split("\n").entries()) {
    const m = importFrom.exec(line);
    if (m && reachesDialect(m[1], file)) {
      failures.push(
        `${file}:${i + 1}: imports the JS dialect. Only ${UNION_HOST} may — it is the ` +
          "single core->dialect edge (the IrInstr union + re-exports). Import from " +
          '"nodes.js" instead, which re-exports every dialect name.',
      );
    }
  }
}

// ── R2: nodes.ts re-exports every dialect declaration ──────────────────────
const dialectFiles = (() => {
  try {
    return walk(DIALECT_DIR);
  } catch {
    return [];
  }
})();

// `failures.length === 0` is part of the condition so a "no dialect yet" tree
// cannot swallow an R1 hit: specifier resolution does not require the target to
// exist, so an import of a deleted dialect is still a reportable violation.
if (dialectFiles.length === 0 && failures.length === 0) {
  console.log(`IR dialect gate: no ${DIALECT_DIR}/ yet — nothing to check.`);
  process.exit(0);
}

const declared = new Set();
for (const file of dialectFiles) {
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(/^export (?:interface|type|enum|const|function) (\w+)/gm)) {
    declared.add(m[1]);
  }
}

const hostText = dialectFiles.length > 0 ? readFileSync(UNION_HOST, "utf8") : "";
const reExported = new Set();
for (const block of hostText.matchAll(/export type \{([^}]*)\} from "\.\/dialect\/[^"]*"/g)) {
  for (const name of block[1].split(",")) {
    const trimmed = name.trim();
    if (trimmed) reExported.add(trimmed);
  }
}

for (const name of [...declared].sort()) {
  if (!reExported.has(name)) {
    failures.push(
      `${UNION_HOST}: does not re-export \`${name}\`, which the dialect declares. The split is a ` +
        "declaration move, not an API change — add it to the `export type { … } from " +
        '"./dialect/js.js"` block.',
    );
  }
}

if (failures.length > 0) {
  console.error("IR dialect gate: FAILED\n");
  for (const f of failures) console.error(`  ${f}`);
  console.error(`\n${failures.length} violation(s). See docs/architecture/codegen-axes.md and #3954 phase 2.`);
  process.exit(1);
}

console.log(
  `IR dialect gate: OK — ${declared.size} dialect declaration(s) re-exported by ${UNION_HOST}; ` +
    `no other file under ${SRC_DIR}/ imports the dialect.`,
);
