#!/usr/bin/env -S npx tsx
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3437 — deterministic, PRE-MERGE compile-time budget gate for the test262
// harness path.
//
// WHY. The oracle-v8 harness switch (#3267/#3370) prepended the ~6–18 KB
// upstream harness prelude to every one of ~43k tests. That exposed a
// quadratic per-file AST scan (`symbolBindsAsyncFunction` walking the whole
// source per call-site), exploding per-compile cost (host shards ~2 min →
// ~13.6 min) — INVISIBLE until it hit the merge queue, where each merge_group
// validation ballooned to ~30–90 min. #3433 (PR #3374) fixed the current
// slowness (memoize the per-file scans), but nothing GATED a future harness /
// codegen change from silently reintroducing the same class of regression.
//
// THE PROXY (load-independent, deterministic). The pre-existing #1942
// compile-time guard measures WALL-CLOCK under runner load — flaky, and it runs
// post-merge (too late). This gate instead measures a DETERMINISTIC proxy for
// source-scan compile WORK: the number of times the shared `forEachChild`
// traversal helper (src/ts-api.ts) is invoked while compiling a FIXED,
// self-contained representative harness-shaped assembly. That count is a pure
// function of the AST + the scans performed — no wall-clock, no runner load, no
// parallelism — so it is reproducible bit-for-bit and safe to gate in the
// pre-merge `quality` job. The per-file source-scan predicates and the
// (now-migrated, #3437) async-assign scan — the exact O(call-sites × file-size)
// class that tanked CI — all flow through this helper, so a change that
// re-de-memoizes or adds a per-call-site full-file scan re-explodes the count
// and fails this gate before it ever reaches the queue.
//
// SCOPE / caveat. `ts.forEachChild` is a getter-only export (not
// monkey-patchable), so DIRECT `ts.forEachChild` call sites are not counted —
// the meter covers the SHARED-helper traversal class. New per-file source scans
// should use the shared helper (src/codegen/source-scan-predicates.ts already
// does); broadening coverage to the remaining direct sites is a follow-up.
//
// USAGE
//   npx tsx scripts/check-harness-compile-budget.ts            # gate (CI)
//   npx tsx scripts/check-harness-compile-budget.ts --update   # reseed budget
//   npx tsx scripts/check-harness-compile-budget.ts --json
//
// The committed budget lives in scripts/harness-compile-budget.json. A slowdown
// beyond `marginPct` fails; an intentional/justified slowdown is banked with
// `--update` (like the LOC / IR ratchets). Set from post-#3433 main.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { compile } from "../src/index.js";
import { enableForEachChildMeter, disableForEachChildMeter, readForEachChildCalls } from "../src/ts-api.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUDGET_PATH = join(__dirname, "harness-compile-budget.json");

// A hard vacuity floor: if the measured work drops below this, the fixture or
// the meter has broken and the gate has gone blind — fail loudly rather than
// pass vacuously.
const VACUITY_FLOOR = 800;

interface Budget {
  forEachChildCalls: number;
  marginPct: number;
  fixtureCallSites: number;
  updated: string;
  note: string;
}

/**
 * Build a FIXED, self-contained, harness-shaped assembly. It deliberately does
 * NOT read the test262 submodule (the `quality` job checks out without
 * submodules, and a vendored copy would drift with the corpus) — a synthetic
 * fixture isolates COMPILER work from corpus churn, which is exactly what a
 * compiler-regression budget wants. It mimics propertyHelper's shape: many
 * `Object.defineProperty` + assertion call-sites (the axis the #3433 quadratic
 * scaled on), plus a class, a delete, and an async-assign pattern so the
 * per-file source-scan predicates and the async-assign scan all traverse.
 *
 * Exported (pure) for unit testing — same string every call.
 */
export function buildRepresentativeAssembly(callSites: number): string {
  const lines: string[] = [
    "// #3437 representative harness-shaped assembly (synthetic, deterministic).",
    "class Marker { tag() { return 1; } }",
    "var asyncRef;",
    "asyncRef = async function () { return 1; };",
    "var obj = {};",
    "function check(name, cond) { if (!cond) { throw new Error(name); } }",
  ];
  for (let i = 0; i < callSites; i++) {
    lines.push(
      `Object.defineProperty(obj, "p${i}", { value: ${i}, writable: true, enumerable: true, configurable: true });`,
    );
    lines.push(`check("p${i}", obj["p${i}"] === ${i});`);
    if (i % 7 === 0) lines.push(`delete obj["p${i}"];`);
    if (i % 11 === 0) lines.push(`var m${i} = new Marker(); check("m${i}", m${i}.tag() === 1);`);
  }
  return lines.join("\n") + "\n";
}

export interface BudgetVerdict {
  measured: number;
  budget: number;
  marginPct: number;
  ceiling: number;
  /** Half-margin line (#5306): crossing it warns, it never fails. */
  softCeiling: number;
  overBudget: boolean;
  /** Past the half-margin line but still under the ceiling — advisory only. */
  nearCeiling: boolean;
  /** Traversals still available before `ceiling` (negative once over budget). */
  marginLeft: number;
  /** `marginLeft` as a share of the ceiling, so "how close" reads at a glance. */
  marginLeftPct: number;
  vacuous: boolean;
  wellBelow: boolean;
}

/**
 * Pure budget comparison — exported for unit testing. `overBudget` is the hard
 * fail (a real slowdown past the margin); `vacuous` is the safety fail (the
 * meter/fixture broke and the gate went blind); `wellBelow` is an advisory to
 * rebank an improvement.
 *
 * `nearCeiling` (#5306) is the SOFT band: the gate is a one-PR-regression
 * detector, but the margin is consumed by every PR cumulatively, so a budget
 * that is silently 99.98 % spent fails the NEXT harness-path PR for fourteen
 * days of other people's drift. Warning at the half-margin line makes that
 * drift visible in every `quality` log long before it fails. Exit code is
 * deliberately unchanged — no new required check (issue #5306 non-goals).
 */
export function evaluateBudget(
  measured: number,
  budget: number,
  marginPct: number,
  vacuityFloor: number,
): BudgetVerdict {
  const ceiling = Math.ceil(budget * (1 + marginPct / 100));
  const softCeiling = Math.ceil(budget * (1 + marginPct / 2 / 100));
  const overBudget = measured > ceiling;
  const marginLeft = ceiling - measured;
  return {
    measured,
    budget,
    marginPct,
    ceiling,
    softCeiling,
    overBudget,
    nearCeiling: measured > softCeiling && !overBudget,
    marginLeft,
    marginLeftPct: ceiling === 0 ? 0 : (marginLeft / ceiling) * 100,
    vacuous: measured < vacuityFloor,
    wellBelow: measured < Math.floor(budget * (1 - marginPct / 100)),
  };
}

async function measureCompileWork(callSites: number): Promise<number> {
  const source = buildRepresentativeAssembly(callSites);
  enableForEachChildMeter();
  try {
    // The assembly may not compile cleanly (as the real harness does not) — the
    // WORK is what we measure, not success. Both are deterministic.
    await compile(source, { fileName: "harness-budget-fixture.ts" });
  } finally {
    // read BEFORE disable clears nothing (disable only flips the flag), but read
    // first to be safe against any future change.
  }
  const count = readForEachChildCalls();
  disableForEachChildMeter();
  return count;
}

function readBudget(): Budget | null {
  if (!existsSync(BUDGET_PATH)) return null;
  return JSON.parse(readFileSync(BUDGET_PATH, "utf-8")) as Budget;
}

function writeBudget(b: Budget): void {
  writeFileSync(BUDGET_PATH, JSON.stringify(b, null, 2) + "\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const isUpdate = argv.includes("--update");
  const isJson = argv.includes("--json");

  // The fixture call-site count is pinned in the budget so measurement and gate
  // always agree; default to 120 on a fresh --update.
  const existing = readBudget();
  const callSites = existing?.fixtureCallSites ?? 120;
  const marginPct = existing?.marginPct ?? 15;

  const measured = await measureCompileWork(callSites);

  if (isUpdate) {
    const today = new Date().toISOString().slice(0, 10);
    const budget: Budget = {
      forEachChildCalls: measured,
      marginPct,
      fixtureCallSites: callSites,
      updated: today,
      // #5306 acceptance #4: the note must carry the rebank DATE and the
      // MEASURED figure it was banked from. The previous note said only
      // "post-#3433 main", so a reader could not tell whether the committed
      // number was measured or picked, nor when.
      note:
        `Rebanked ${today} from a measured ${measured} shared-forEachChild traversals ` +
        `(fixtureCallSites=${callSites}, margin ${marginPct}%) for the #3437 representative harness ` +
        "assembly. Reseed with `npx tsx scripts/check-harness-compile-budget.ts --update` when a " +
        "slowdown is intentional and justified. See the script header.",
    };
    writeBudget(budget);
    console.log(`#3437 budget reseeded: forEachChildCalls=${measured} (callSites=${callSites}, margin=${marginPct}%).`);
    process.exit(0);
  }

  if (!existing) {
    console.error(
      "#3437 no budget file (scripts/harness-compile-budget.json). Seed it with:\n" +
        "  npx tsx scripts/check-harness-compile-budget.ts --update",
    );
    process.exit(2);
  }

  const verdict = evaluateBudget(measured, existing.forEachChildCalls, marginPct, VACUITY_FLOOR);
  const { ceiling } = verdict;

  if (isJson) {
    console.log(JSON.stringify({ ...verdict, callSites }, null, 2));
  } else {
    console.log(
      `#3437 harness compile-work: measured=${measured} budget=${existing.forEachChildCalls} ` +
        `ceiling=${ceiling} (+${marginPct}%) callSites=${callSites} ` +
        `margin-left=${verdict.marginLeft} (${verdict.marginLeftPct.toFixed(2)}%).`,
    );
  }

  if (verdict.vacuous) {
    console.error(
      `\n✖ FAIL: measured work ${measured} is below the vacuity floor ${VACUITY_FLOOR} — the meter or ` +
        `fixture has broken and this gate is no longer measuring compile work. Investigate before trusting it.`,
    );
    process.exit(1);
  }

  if (verdict.overBudget) {
    console.error(
      `\n✖ FAIL: test262 harness compile work grew ${existing.forEachChildCalls} → ${measured} ` +
        `(+${measured - existing.forEachChildCalls}, over the +${marginPct}% ceiling ${ceiling}).\n` +
        `A change materially slowed harness-shaped compilation (the #3433 regression class). If the ` +
        `slowdown is intentional and justified, rebank with:\n` +
        `  npx tsx scripts/check-harness-compile-budget.ts --update\n` +
        `Otherwise fix the added/de-memoized per-file scan. See #3437.`,
    );
    process.exit(1);
  }

  // #5306 soft band. Emitted AFTER the hard checks so a real failure is never
  // softened into a warning, and on stderr so `--json` stdout stays parseable.
  // GitHub renders `::warning::` from either stream.
  if (verdict.nearCeiling) {
    console.error(
      `::warning file=scripts/harness-compile-budget.json::#3437 harness compile work is past the ` +
        `half-margin line: measured ${measured} vs budget ${existing.forEachChildCalls} ` +
        `(soft ${verdict.softCeiling}, ceiling ${ceiling}). Margin left: ${verdict.marginLeft} traversals ` +
        `(${verdict.marginLeftPct.toFixed(2)}% of the ceiling). Drift since the last rebank is cumulative — ` +
        `bisect it and rebank on main (#5306) rather than letting the next harness-path PR absorb the failure.`,
    );
  }

  if (verdict.wellBelow) {
    console.log(
      `  ℹ compile work dropped well below budget (${existing.forEachChildCalls} → ${measured}); ` +
        `bank the improvement with --update so the ceiling tracks it.`,
    );
  }
  console.log("  ✓ harness compile work within budget.");
  process.exit(0);
}

// Only run as a CLI; the assembly builder is imported by the unit test.
const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedAsScript) {
  main().catch((e) => {
    console.error("#3437 gate error:", e);
    process.exit(2);
  });
}
