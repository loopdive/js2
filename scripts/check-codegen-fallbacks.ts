// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2089 — silent-fallback telemetry gate (Phase 0).
 *
 * Codegen-internal counterpart of `scripts/check-ir-fallbacks.ts`
 * (#1376/#1530). Compiles a fixed corpus (`website/playground/examples/**.ts`)
 * with `trackSilentFallbacks: true`, aggregates the per-class/per-site
 * `reportSilentFallback` counts surfaced on `CompileResult.fallbackCounts`,
 * and compares them against the committed baseline at
 * `scripts/codegen-fallback-baseline.json`.
 *
 * CI fails the `quality` job when any class's total grows vs. baseline.
 * Decreases (or equal counts) succeed and, with `--update` /
 * `--update-on-decrease`, refresh the committed baseline (the latter only
 * lowers, never raises — improvements bank automatically post-merge).
 *
 * Flags (copy-compatible with check-ir-fallbacks.ts so CI wiring is identical):
 *   pnpm run check:codegen-fallbacks                    # gate against baseline
 *   pnpm run check:codegen-fallbacks -- --update        # rewrite baseline
 *   pnpm run check:codegen-fallbacks -- --update-on-decrease
 *   pnpm run check:codegen-fallbacks -- --json          # machine-readable
 *   pnpm run check:codegen-fallbacks -- --verbose       # per-file breakdown
 *
 * Phase 0 is pure telemetry — `reportSilentFallback` only counts (and, when
 * the option is set, warns), so this gate captures current reality and prevents
 * regression growth. Phases 1–4 (see plan/log/analysis-2026-06/04-fail-loud-audit.md)
 * route more sites through the choke point and promote zeroed classes to hard
 * errors via `STRICT_FALLBACK_CLASSES`.
 */
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/index.js";
import {
  SILENT_FALLBACK_CLASSES,
  fallbackCountsToJson,
  type SilentFallbackClass,
} from "../src/codegen/fallback-telemetry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/codegen-fallback-baseline.json");
const CORPUS_ROOTS = [join(REPO_ROOT, "website/playground/examples")];

interface Baseline {
  readonly generated: string;
  /** class → site → count */
  readonly counts: Record<string, Record<string, number>>;
}

function listTsFiles(root: string): string[] {
  const out: string[] = [];
  if (!existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const s = statSync(p);
      if (s.isDirectory()) stack.push(p);
      else if (s.isFile() && name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(p);
    }
  }
  return out.sort();
}

interface Aggregated {
  /** class → site → count */
  counts: Record<string, Record<string, number>>;
  perFile: Array<{ file: string; counts: Record<string, Record<string, number>> }>;
}

async function aggregate(): Promise<Aggregated> {
  const corpus = CORPUS_ROOTS.flatMap(listTsFiles);
  const counts: Record<string, Record<string, number>> = {};
  const perFile: Aggregated["perFile"] = [];

  for (const filePath of corpus) {
    const source = readFileSync(filePath, "utf-8");
    let fileCounts: Record<string, Record<string, number>> = {};
    try {
      const result = await compile(source, { fileName: filePath, trackSilentFallbacks: true });
      if (result.fallbackCounts) fileCounts = fallbackCountsToJson(result.fallbackCounts);
    } catch {
      // A corpus file that throws during compile contributes no counts —
      // the IR checker tolerates the same (a throw is not a silent fallback).
    }
    for (const [cls, sites] of Object.entries(fileCounts)) {
      const bucket = (counts[cls] ??= {});
      for (const [site, n] of Object.entries(sites)) bucket[site] = (bucket[site] ?? 0) + n;
    }
    if (Object.keys(fileCounts).length > 0) {
      perFile.push({ file: relative(REPO_ROOT, filePath), counts: fileCounts });
    }
  }
  return { counts, perFile };
}

function classTotal(counts: Record<string, Record<string, number>>, cls: string): number {
  const sites = counts[cls];
  if (!sites) return 0;
  let total = 0;
  for (const n of Object.values(sites)) total += n;
  return total;
}

function loadBaseline(): Baseline {
  if (!existsSync(BASELINE_PATH)) return { generated: "(none)", counts: {} };
  return JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Baseline;
}

function writeBaseline(counts: Record<string, Record<string, number>>): void {
  // Stable, sorted serialization for readable diffs.
  const sorted: Record<string, Record<string, number>> = {};
  for (const cls of SILENT_FALLBACK_CLASSES) {
    const sites = counts[cls];
    if (!sites || Object.keys(sites).length === 0) continue;
    const sortedSites: Record<string, number> = {};
    for (const site of Object.keys(sites).sort()) sortedSites[site] = sites[site]!;
    sorted[cls] = sortedSites;
  }
  const baseline: Baseline = { generated: new Date().toISOString(), counts: sorted };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const update = args.has("--update");
  const updateOnDecrease = args.has("--update-on-decrease");
  const jsonOnly = args.has("--json");
  const verbose = args.has("--verbose");

  const { counts, perFile } = await aggregate();

  if (jsonOnly) {
    console.log(JSON.stringify(counts, null, 2));
    return;
  }

  const baseline = loadBaseline();

  // Compare per-class totals (Phase 0 gates on class growth, like the IR
  // budget gates on per-reason growth).
  const grew: string[] = [];
  const shrank: string[] = [];
  for (const cls of SILENT_FALLBACK_CLASSES) {
    const now = classTotal(counts, cls);
    const was = classTotal(baseline.counts, cls);
    if (now > was) grew.push(`${cls}: ${was} → ${now} (+${now - was})`);
    else if (now < was) shrank.push(`${cls}: ${was} → ${now} (−${was - now})`);
  }

  console.log("Silent-fallback telemetry (Phase 0) — corpus:", `${perFile.length} file(s) with hits`);
  for (const cls of SILENT_FALLBACK_CLASSES) {
    const now = classTotal(counts, cls);
    if (now > 0) console.log(`  ${cls.padEnd(20)} ${now}`);
  }

  if (verbose) {
    console.log("\nPer-file breakdown:");
    for (const { file, counts: fc } of perFile) {
      console.log(`  ${file}`);
      for (const [cls, sites] of Object.entries(fc)) {
        for (const [site, n] of Object.entries(sites)) console.log(`      ${cls} · ${site}: ${n}`);
      }
    }
  }

  if (update) {
    writeBaseline(counts);
    console.log(`\nBaseline rewritten: ${relative(REPO_ROOT, BASELINE_PATH)}`);
    return;
  }

  if (grew.length > 0) {
    console.error("\n❌ Silent-fallback classes grew vs. baseline:");
    for (const g of grew) console.error(`   ${g}`);
    console.error(
      "\nA new silent fallback was introduced (or an existing site now fires more).\n" +
        "Fix the root cause, or — if intentional — refresh the baseline:\n" +
        "  pnpm run check:codegen-fallbacks -- --update\n" +
        "  git add scripts/codegen-fallback-baseline.json",
    );
    process.exit(1);
  }

  if (shrank.length > 0) {
    console.log("\n✅ Silent-fallback classes shrank vs. baseline:");
    for (const s of shrank) console.log(`   ${s}`);
    if (updateOnDecrease) {
      writeBaseline(counts);
      console.log(`\nBaseline ratcheted down: ${relative(REPO_ROOT, BASELINE_PATH)} (commit the diff).`);
    } else {
      console.log("\nRun with --update-on-decrease to bank the improvement into the baseline.");
    }
    return;
  }

  console.log("\n✅ No silent-fallback growth vs. baseline.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
