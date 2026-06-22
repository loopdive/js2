#!/usr/bin/env node
/**
 * #1919 — speculative-compile rollback drift gate.
 *
 * The probe-compile-and-rollback idiom must go through the transactional helper
 * in `src/codegen/context/speculative.ts` (`snapshotSpeculative` /
 * `rollbackSpeculative` / `withSpeculativeCompile` / `probeCompiledType`). A raw
 * `fctx.body.length = <savedLen>` rollback restores ONLY the body and leaks the
 * locals / late imports / errors the probe allocated — the heisenbug class #1919
 * closed.
 *
 * This gate fails when a NEW raw `*.body.length = …` ASSIGNMENT appears under
 * `src/codegen/` outside the sanctioned home, so the idiom can't creep back in.
 * It deliberately ignores:
 *   - `===` / `!==` / `==` / `<` / `>` comparisons of `.body.length` (those read
 *     the length to detect whether emission happened; they are not rollbacks);
 *   - the helper itself (`context/speculative.ts`);
 *   - any line carrying the inline marker `not-a-probe-rollback (#1919)` — used
 *     for the few legitimate detached-buffer truncations (e.g. clearing a
 *     manually-swapped `arm` buffer in property-access.ts).
 *
 * Usage:
 *   node scripts/check-speculative-rollback-sites.mjs            # fail on any hit
 *   node scripts/check-speculative-rollback-sites.mjs --list     # list + exit 0
 */
import { readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";

const CODEGEN_DIR = new URL("../src/codegen", import.meta.url).pathname;

// The transactional helper is the ONE place a body truncation is sanctioned.
const SANCTIONED_REL = new Set(["context/speculative.ts"]);

// Inline opt-out marker for the rare non-probe detached-buffer truncation.
const OPT_OUT = "not-a-probe-rollback (#1919)";

// Match an ASSIGNMENT to `<x>.body.length` — `=` NOT immediately followed by `=`
// (so `===`/`==` are excluded) and NOT preceded by a comparison operator.
const ASSIGN_RE = /\.body\.length\s*=(?!=)/;

function walk(dir, acc) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) acc.push(full);
  }
  return acc;
}

const files = walk(CODEGEN_DIR, []);
const hits = [];
for (const file of files) {
  const rel = file.slice(CODEGEN_DIR.length + 1);
  if (SANCTIONED_REL.has(rel)) continue;
  const lines = readFileSync(file, "utf-8").split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!ASSIGN_RE.test(line)) continue;
    if (line.includes(OPT_OUT)) continue;
    hits.push(`  src/codegen/${rel}:${i + 1}: ${line.trim()}`);
  }
}

const list = process.argv.includes("--list");
if (list) {
  console.log(hits.length ? hits.join("\n") : "(no raw body.length rollback sites)");
  process.exit(0);
}

if (hits.length > 0) {
  console.error("speculative-rollback gate FAILED — raw `.body.length =` rollback(s) outside the helper:\n");
  console.error(hits.join("\n"));
  console.error(
    "\nRoute speculative compiles through src/codegen/context/speculative.ts " +
      "(snapshotSpeculative/rollbackSpeculative/withSpeculativeCompile/probeCompiledType) so the " +
      "rollback undoes locals + late imports + errors, not just the body (#1919). If this is a " +
      "detached-buffer truncation (not a probe), annotate the line with `// not-a-probe-rollback (#1919)`.",
  );
  process.exit(1);
}

console.log("speculative-rollback gate: OK (no raw body.length rollbacks outside the helper).");
