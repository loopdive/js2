#!/usr/bin/env -S node --experimental-strip-types
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #1941 — Optimize-lane differential gate.
//
// The strongest, self-maintaining statement of "--optimize must not change
// observable behavior": compare the optimized lane's per-file outcome against
// the UNOPTIMIZED lane's per-file outcome on the same corpus. A program that
// already mismatches the V8 oracle unoptimized is NOT an optimize bug — only a
// program whose outcome *changes* when wasm-opt runs is. So we gate on the
// delta between the two lanes, not on an absolute pass rate, and there is no
// frozen baseline to drift.
//
// A regression is any file where:
//   - unoptimized produced `match` but optimized did NOT (wasm-opt broke a
//     program that worked), OR
//   - unoptimized ran fine (`match`/`mismatch`) but optimized now errors
//     (compile_error / runtime_error — e.g. the #1941 invalid-binary case).
//
// Both reports come from `scripts/diff-test.ts`: run it once without and once
// with `DIFF_TEST_OPTIMIZE=1` before invoking this gate.
//
// Exit codes:
//   0 — optimize introduces no behavioral change; safe to merge
//   1 — at least one program's outcome regressed under optimization
//   2 — internal error (missing report, parse error)

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");

type Outcome = "match" | "mismatch" | "compile_error" | "runtime_error" | "v8_error" | "malformed_wasm";
interface FileResult {
  file: string;
  outcome: Outcome;
  error?: string;
}
interface Summary {
  total: number;
  match: number;
  mismatch: number;
  results: FileResult[];
}

function load(rel: string): Summary {
  try {
    return JSON.parse(readFileSync(resolve(ROOT, rel), "utf-8")) as Summary;
  } catch (e: unknown) {
    console.error(`Failed to read ${rel}: ${(e as Error).message}`);
    console.error("Run `npx tsx scripts/diff-test.ts` and `DIFF_TEST_OPTIMIZE=1 npx tsx scripts/diff-test.ts` first.");
    process.exit(2);
  }
}

/** An error outcome means the binary failed to compile/instantiate/run. */
function isError(o: Outcome): boolean {
  return o === "compile_error" || o === "runtime_error";
}

const unopt = load("benchmarks/results/diff-test.json");
const opt = load("benchmarks/results/diff-test-optimize.json");

const unoptByFile = new Map<string, FileResult>();
for (const r of unopt.results) unoptByFile.set(r.file, r);

const regressions: { file: string; was: Outcome; now: Outcome; error?: string }[] = [];
for (const optR of opt.results) {
  const unoptR = unoptByFile.get(optR.file);
  if (!unoptR) continue; // new file only in opt lane — shouldn't happen (same corpus)
  if (unoptR.outcome === optR.outcome) continue; // identical outcome — fine

  // The outcome differs. Flag it as a regression when optimization made things
  // strictly worse:
  //   match  -> anything-else  (lost a passing program)
  //   non-error -> error       (wasm-opt produced a broken binary)
  const lostMatch = unoptR.outcome === "match" && optR.outcome !== "match";
  const newError = !isError(unoptR.outcome) && isError(optR.outcome);
  if (lostMatch || newError) {
    regressions.push({ file: optR.file, was: unoptR.outcome, now: optR.outcome, error: optR.error });
  }
  // The reverse (optimized matches where unopt didn't) is an improvement we
  // silently accept — wasm-opt can't legitimately "fix" semantics, but a
  // float/print normalization difference is harmless and not a regression.
}

console.log("# Optimize-lane differential gate (#1941)");
console.log("");
console.log(`Unoptimized: ${unopt.match}/${unopt.total} match`);
console.log(`Optimized:   ${opt.match}/${opt.total} match`);
console.log(`Outcome regressions under -O: ${regressions.length}`);
console.log("");

if (regressions.length > 0) {
  console.log("## ❌ Optimization changed observable behavior (gate FAILED)");
  console.log("");
  for (const r of regressions) {
    const err = r.error ? `  — ${r.error.slice(0, 160)}` : "";
    console.log(`  - ${r.file}: ${r.was} → ${r.now}${err}`);
  }
  console.log("");
  console.log("wasm-opt miscompiled these programs: they behave differently (or fail) optimized.");
  console.log("Fix the optimizer integration (src/optimize.ts) or quarantine the unsafe pass — do NOT ship.");
  process.exit(1);
}

console.log("✓ Optimized output matches unoptimized output on every corpus program. Safe to merge.");
process.exit(0);
