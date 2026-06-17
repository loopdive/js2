#!/usr/bin/env npx tsx
/**
 * heal-poison-rows.ts — re-run poison-classified test262 rows in a clean
 * in-process compiler before a baseline promotion (#2099).
 *
 * ── Why ──────────────────────────────────────────────────────────────────
 * Emit/allocation-class failures ("Binary emit error", "out of memory",
 * "Array buffer allocation failed", …) can leave a sharded compiler worker (or
 * its incremental compiler) in a contaminated state, so the verdict written to
 * the JSONL is a phantom — the test would pass in a fresh process. The runner
 * already recycles + retries within a shard (#1862), but a poison row that
 * still slips through and enters the baseline is then carried forward by EVERY
 * later promotion: `promote-baseline` copies the merged JSONL verbatim, so the
 * phantom failure becomes permanent drift (#1862 investigation item 3).
 *
 * This is that unimplemented item: at PROMOTION time, collect rows whose error
 * matches the shared poison signature (`POISON_ERROR_RE`) and re-run JUST those
 * tests serially in a clean in-process compiler. A re-run that now passes
 * (or skips, or fails for a NON-poison reason) replaces the phantom row; a
 * re-run that STILL trips the poison signature is left as-is (it is a genuine
 * resource limit for that test, not contamination) and reported.
 *
 * Serial + in-process is deliberate: the poison count is small (single/low
 * double digits), so the wall-clock cost is bounded (< 2 min, acceptance
 * criterion), and a single clean process is the cleanest possible worker.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *   npx tsx scripts/heal-poison-rows.ts \
 *     --in  shard-artifacts/test262-results-merged.jsonl \
 *     --out shard-artifacts/test262-results-merged.jsonl \
 *     [--target standalone] [--max-heal N] [--quiet]
 *
 * `--in` and `--out` may be the same path (the file is read fully before any
 * write). Non-poison rows are passed through byte-for-byte. Exit code is always
 * 0 unless an argument is malformed or the input is unreadable — a row that
 * can't be healed is a reported no-op, not a failure (the promotion must not be
 * blocked by a genuinely resource-bound test).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runTest262File, TEST_CATEGORIES } from "../tests/test262-runner.ts";
import { isPoisonCompileError } from "./test262-poison-error.mjs";

const ROOT = resolve(fileURLToPath(import.meta.url), "..", "..");
const TEST262_ROOT = resolve(ROOT, "test262");

interface Row {
  file?: string;
  status?: string;
  error?: string;
  [k: string]: unknown;
}

interface Args {
  in: string;
  out: string;
  target?: "standalone";
  maxHeal: number;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const inPath = get("--in");
  if (!inPath) {
    console.error("heal-poison-rows: --in <merged.jsonl> is required.");
    process.exit(64);
  }
  const target = get("--target");
  if (target !== undefined && target !== "standalone") {
    console.error(`heal-poison-rows: --target must be "standalone" if given (got "${target}").`);
    process.exit(64);
  }
  const maxHealRaw = get("--max-heal");
  return {
    in: inPath,
    out: get("--out") ?? inPath,
    target: target as "standalone" | undefined,
    maxHeal: maxHealRaw && /^\d+$/.test(maxHealRaw) ? Number(maxHealRaw) : Infinity,
    quiet: argv.includes("--quiet"),
  };
}

/** Map a test path back to a TEST_CATEGORIES entry so runTest262File wraps correctly. */
function categoryFor(file: string): string {
  const trimmed = file.startsWith("test/") ? file.slice(5) : file;
  let best = "";
  for (const cat of TEST_CATEGORIES) {
    if (trimmed.startsWith(cat + "/") && cat.length > best.length) best = cat;
  }
  if (!best) {
    const i = trimmed.indexOf("/");
    return i > 0 ? trimmed.slice(0, i) : trimmed;
  }
  return best;
}

function isPoisonRow(row: Row): boolean {
  // Only failing rows can be phantoms; a `pass`/`skip` row is never poison.
  if (row.status === "pass" || row.status === "skip") return false;
  return isPoisonCompileError(typeof row.error === "string" ? row.error : "");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  // Read every line first (the in/out paths may be identical).
  const raw = readFileSync(args.in, "utf8");
  const lines = raw.split("\n");

  const poisonIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let row: Row;
    try {
      row = JSON.parse(line) as Row;
    } catch {
      continue; // pass malformed lines through untouched
    }
    if (row.file && isPoisonRow(row)) poisonIdx.push(i);
  }

  const laneLabel = args.target ?? "host";
  if (poisonIdx.length === 0) {
    if (!args.quiet) console.log(`heal-poison-rows [${laneLabel}]: no poison-classified rows — nothing to heal.`);
    // Still write the output (no-op copy) so the caller can use a single path.
    if (args.out !== args.in) writeFileSync(args.out, raw);
    return;
  }

  const toHeal = poisonIdx.slice(0, args.maxHeal);
  console.log(
    `heal-poison-rows [${laneLabel}]: ${poisonIdx.length} poison row(s) found; re-running ${toHeal.length} serially in a clean process.`,
  );

  let healed = 0;
  let stillPoison = 0;
  const startMs = Date.now();

  for (const idx of toHeal) {
    const before = JSON.parse(lines[idx]!) as Row;
    const file = before.file!;
    const cat = categoryFor(file);
    const fullPath = resolve(TEST262_ROOT, file);

    let newStatus: string;
    let newError: string | undefined;
    try {
      const result = await runTest262File(fullPath, cat, undefined, args.target);
      newStatus = result.status;
      newError = (result as { error?: string; reason?: string }).error ?? (result as { reason?: string }).reason;
    } catch (e) {
      // A thrown runner error on re-run is itself a verdict; record it so the
      // row reflects the clean-process reality rather than the phantom.
      newStatus = "runtime";
      newError = (e as Error)?.message?.slice(0, 200) ?? String(e);
    }

    // If the re-run STILL trips the poison signature, this is a genuine
    // resource limit for the test, not worker contamination — leave the row
    // unchanged so we don't mask a real failure.
    if (newStatus !== "pass" && newStatus !== "skip" && isPoisonCompileError(newError ?? "")) {
      stillPoison += 1;
      if (!args.quiet) console.log(`  • ${file}: still poison on clean re-run (${newStatus}) — left as-is.`);
      continue;
    }

    // Heal: replace status/error, drop the stale error/error_category/
    // error_signature so the report build re-derives them. Build the row by
    // omitting those keys (no `delete` — biome noDelete) and re-adding error
    // only when the re-run produced one. JSON.stringify drops undefined keys,
    // so an absent `error` serializes the same as a deleted one.
    const {
      error: _staleError,
      error_category: _staleCategory,
      error_signature: _staleSignature,
      ...rest
    } = before as Row & { error_category?: unknown; error_signature?: unknown };
    void _staleError;
    void _staleCategory;
    void _staleSignature;
    const after: Row = { ...rest, status: newStatus, poison_healed: true };
    if (newError) after.error = newError;
    lines[idx] = JSON.stringify(after);
    healed += 1;
    if (!args.quiet) console.log(`  • ${file}: ${before.status} → ${newStatus} (healed).`);
  }

  const elapsedS = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log(
    `heal-poison-rows [${laneLabel}]: healed ${healed}, still-poison ${stillPoison}, ` +
      `skipped ${poisonIdx.length - toHeal.length} (over --max-heal). ${elapsedS}s.`,
  );

  writeFileSync(args.out, lines.join("\n"));
}

main().catch((e) => {
  console.error("heal-poison-rows: fatal:", e);
  process.exit(1);
});
