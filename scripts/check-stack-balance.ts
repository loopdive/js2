// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1918 — Stack-balance fixup telemetry gate.
 *
 * Compiles a fixed corpus of `.ts` files and aggregates the fixups the
 * stack-balance pass applied (see `getFixupEvents` in
 * `src/codegen/stack-balance.ts`), bucketed by `FixupKind`.
 *
 * Every fixup is a *repair of the emitter's own output* — a masked codegen
 * bug. The pass's job is to keep emitting valid Wasm while those bugs exist,
 * but historically the fixup count was computed and then discarded, so the
 * safety net silently absorbed new emitter regressions (and the lossy
 * const-default arm could ship a silently-wrong runtime value). This gate
 * makes the count visible and *ratchets it down*: CI fails when any bucket
 * grows vs. the committed baseline (`scripts/stack-balance-baseline.json`).
 * As emitter bugs are fixed and a bucket shrinks, `--update-on-decrease`
 * banks the lower number so it can't silently regress.
 *
 * Mechanics mirror `scripts/check-ir-fallbacks.ts`.
 *
 * Usage:
 *   pnpm run check:stack-balance                       # gate against baseline
 *   pnpm run check:stack-balance -- --update           # rewrite the committed baseline
 *   pnpm run check:stack-balance -- --update-on-decrease
 *                                                       # gate, but auto-ratchet
 *                                                       # the baseline down when a
 *                                                       # bucket shrinks (growth
 *                                                       # still fails). Decreases
 *                                                       # are STAGED on disk only;
 *                                                       # the PR author commits them.
 *   pnpm run check:stack-balance -- --json             # machine-readable output
 *   pnpm run check:stack-balance -- --verbose          # per-file fixup breakdown
 *
 * Corpus: every `.ts` file under `website/playground/examples/`
 * (excluding `.d.ts`) — the same corpus as `check:ir-fallbacks`.
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compile } from "../src/index.js";
import { getFixupEvents, summarizeFixups, type FixupKind } from "../src/codegen/stack-balance.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/stack-balance-baseline.json");
const CORPUS_ROOTS = [join(REPO_ROOT, "website/playground/examples")];

/** Every FixupKind, in display order. Keep in sync with `FixupKind` in stack-balance.ts. */
const ALL_KINDS: readonly FixupKind[] = [
  "drop-excess",
  "default-value-lossy",
  "branch-type-coerce",
  "branch-type-cast",
  "call-arg-coerce",
  "struct-field-coerce",
  "local-set-coerce",
];

interface Baseline {
  readonly generated: string;
  readonly fixups: Partial<Record<FixupKind, number>>;
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

async function aggregate(): Promise<{
  totals: Record<FixupKind, number>;
  perFile: Array<{ file: string; counts: Record<FixupKind, number>; total: number }>;
}> {
  const corpus = CORPUS_ROOTS.flatMap(listTsFiles);
  const totals: Record<FixupKind, number> = summarizeFixups([]); // all-zero
  const perFile: Array<{ file: string; counts: Record<FixupKind, number>; total: number }> = [];

  for (const filePath of corpus) {
    const source = readFileSync(filePath, "utf-8");
    let counts: Record<FixupKind, number>;
    try {
      // Compile through the public API; `stackBalance` runs inside and resets
      // the module-scoped event collector, so `getFixupEvents()` immediately
      // after reflects exactly this file's repairs. We do not gate on compile
      // success — even a file that fails a later pass still exercises the
      // stack-balance pass, and a fixup is a fixup regardless.
      await compile(source, { fileName: filePath });
      const events = getFixupEvents();
      counts = summarizeFixups(events);
    } catch {
      // A corpus file that throws during compile contributes no measurable
      // fixups; skip it rather than fail the gate on an example-code quirk.
      continue;
    }
    let fileTotal = 0;
    for (const k of ALL_KINDS) {
      totals[k] += counts[k];
      fileTotal += counts[k];
    }
    perFile.push({ file: relative(REPO_ROOT, filePath), counts, total: fileTotal });
  }
  return { totals, perFile };
}

function loadBaseline(): Baseline | undefined {
  if (!existsSync(BASELINE_PATH)) return undefined;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf-8")) as Baseline;
  } catch {
    return undefined;
  }
}

function diffTable(
  base: Partial<Record<FixupKind, number>>,
  cur: Record<FixupKind, number>,
): {
  rows: Array<{ kind: string; base: number; cur: number; delta: number }>;
  anyIncrease: boolean;
  anyDecrease: boolean;
} {
  const rows: Array<{ kind: string; base: number; cur: number; delta: number }> = [];
  let anyIncrease = false;
  let anyDecrease = false;
  for (const kind of ALL_KINDS) {
    const b = base[kind] ?? 0;
    const c = cur[kind] ?? 0;
    const delta = c - b;
    rows.push({ kind, base: b, cur: c, delta });
    if (delta > 0) anyIncrease = true;
    if (delta < 0) anyDecrease = true;
  }
  return { rows, anyIncrease, anyDecrease };
}

function formatTable(label: string, rows: Array<{ kind: string; base: number; cur: number; delta: number }>): string {
  const max = Math.max(label.length, ...rows.map((r) => r.kind.length));
  const lines = [
    `\n${label}:`,
    `  ${"kind".padEnd(max)}  baseline   current     delta`,
    `  ${"-".repeat(max)}  --------  --------  --------`,
    ...rows.map(
      (r) =>
        `  ${r.kind.padEnd(max)}  ${String(r.base).padStart(8)}  ${String(r.cur).padStart(8)}  ${(r.delta > 0 ? "+" + r.delta : String(r.delta)).padStart(8)}`,
    ),
  ];
  return lines.join("\n");
}

function formatPerFile(perFile: Array<{ file: string; counts: Record<FixupKind, number>; total: number }>): string {
  const rows = perFile.filter((r) => r.total > 0);
  if (rows.length === 0) return "\nPer-file breakdown: (no fixups)\n";
  const lines = ["\nPer-file fixup breakdown:"];
  for (const row of rows.sort((a, b) => b.total - a.total)) {
    const s = ALL_KINDS.filter((k) => row.counts[k] > 0)
      .map((k) => `${k}=${row.counts[k]}`)
      .join(", ");
    lines.push(`  ${row.file}: ${s}`);
  }
  return lines.join("\n") + "\n";
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const mode: "gate" | "update" | "update-on-decrease" | "json" = args.has("--update")
    ? "update"
    : args.has("--update-on-decrease")
      ? "update-on-decrease"
      : args.has("--json")
        ? "json"
        : "gate";
  const verbose = args.has("--verbose");

  const { totals, perFile } = await aggregate();

  if (mode === "json") {
    process.stdout.write(JSON.stringify({ fixups: totals, perFile }, null, 2) + "\n");
    return;
  }

  const generated = new Date().toISOString().slice(0, 10);
  const next: Baseline = { generated, fixups: totals };

  if (mode === "update") {
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
    process.stdout.write(`Updated ${relative(REPO_ROOT, BASELINE_PATH)}\n`);
    process.stdout.write(formatTable("Fixups (target = 0)", diffTable({}, totals).rows) + "\n");
    if (verbose) process.stdout.write(formatPerFile(perFile));
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    process.stdout.write(`No baseline at ${relative(REPO_ROOT, BASELINE_PATH)}. Run with --update to create it.\n`);
    process.exit(1);
  }

  const diff = diffTable(baseline.fixups, totals);
  process.stdout.write(formatTable("Stack-balance fixups (gated; must not increase)", diff.rows) + "\n");

  if (diff.anyIncrease) {
    process.stderr.write(
      `\nStack-balance fixup gate: at least one fixup bucket grew vs. baseline.\n` +
        `Each fixup repairs an emitter bug, so a new fixup means new wrong codegen reached the\n` +
        `stack-balance safety net. Fix the producing codegen (preferred), or — if the growth is\n` +
        `genuinely unavoidable for now — run \`pnpm run check:stack-balance -- --update\` and commit\n` +
        `the refreshed baseline. Use --verbose to see the per-file breakdown.\n`,
    );
    if (verbose) process.stderr.write(formatPerFile(perFile));
    process.exit(1);
  }

  const totalBase = ALL_KINDS.reduce((a, k) => a + (baseline.fixups[k] ?? 0), 0);
  const totalCur = ALL_KINDS.reduce((a, k) => a + totals[k], 0);

  if (mode === "update-on-decrease" && diff.anyDecrease) {
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
    process.stdout.write(
      `\nStack-balance fixup gate: ratcheted baseline (total ${totalBase} -> ${totalCur}). ` +
        `Staged update to ${relative(REPO_ROOT, BASELINE_PATH)} — commit it with the PR.\n`,
    );
    if (verbose) process.stdout.write(formatPerFile(perFile));
    return;
  }

  process.stdout.write("\nStack-balance fixup gate: OK (no fixup-bucket increases vs. baseline).\n");
  if (verbose) process.stdout.write(formatPerFile(perFile));
}

main().catch((e) => {
  process.stderr.write(`check-stack-balance failed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(2);
});
