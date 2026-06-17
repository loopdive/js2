// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1376 — IR fallback telemetry gate.
 *
 * Compiles a fixed corpus of `.ts` files, calls `planIrCompilation` with
 * `trackFallbacks: true`, and aggregates rejection reasons by category.
 *
 * Compares against the committed baseline at `scripts/ir-fallback-baseline.json`.
 * Fails the CI quality job when an `unintended` fallback bucket increases vs.
 * baseline. Decreases (or equal counts) succeed and (when run with `--update`)
 * refresh the committed baseline.
 *
 * Categories — see `IrFallbackReason` in `src/ir/select.ts`:
 *
 *   unintended (must not increase, target = 0):
 *     - body-shape-rejected   — Phase-1 statement-shape gate
 *     - external-call         — call to non-local identifier
 *     - call-graph-closure    — caller/callee not claimed
 *     - param-shape-rejected  — optional/rest/initializer/non-identifier
 *     - type-resolution-failure
 *     - return-type-not-resolvable
 *     - param-type-not-resolvable
 *
 *   deferred (allowed; tracked but not gated):
 *     - async-generator
 *     - type-parameters
 *     - non-export-modifier
 *     - unnamed
 *
 * Usage:
 *   pnpm run check:ir-fallbacks                       # gate against baseline
 *   pnpm run check:ir-fallbacks -- --update           # refresh the committed baseline
 *   pnpm run check:ir-fallbacks -- --update-on-decrease
 *                                                     # gate, but auto-ratchet
 *                                                     # the committed baseline
 *                                                     # downward when an
 *                                                     # `unintended` bucket
 *                                                     # shrinks (#1530). Growth
 *                                                     # still fails. Decreases
 *                                                     # are STAGED on disk
 *                                                     # only — the PR author
 *                                                     # commits the diff.
 *   pnpm run check:ir-fallbacks -- --json             # emit JSON only (machine-readable)
 *   pnpm run check:ir-fallbacks -- --verbose          # print per-file rejection
 *                                                     # breakdown after the
 *                                                     # gate result (used to
 *                                                     # locate the single
 *                                                     # `param-type-not-
 *                                                     # resolvable` site
 *                                                     # tracked by #1530).
 *
 * Corpus: every `.ts` file under `playground/examples/` (excluding `.d.ts`).
 */
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { buildTypeMap } from "../src/ir/propagate.js";
import { planIrCompilation, type IrFallbackReason } from "../src/ir/select.js";
import { compile } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/ir-fallback-baseline.json");
const CORPUS_ROOTS = [join(REPO_ROOT, "website/playground/examples")];

/** Reasons that must NOT increase vs. baseline. */
const UNINTENDED: ReadonlySet<IrFallbackReason> = new Set([
  "body-shape-rejected",
  "external-call",
  "call-graph-closure",
  "param-shape-rejected",
  "type-resolution-failure",
  "return-type-not-resolvable",
  "param-type-not-resolvable",
  // #1370 Phase A — class methods/constructors of an unsupported shape
  // (extends parent, accessors, computed names, etc.). Tracked as
  // unintended so future slices that retire these buckets (Phase E for
  // inheritance, accessors slice, etc.) are gated on a baseline drop.
  "class-method",
  // #1372 — binding-pattern params with shapes wider than slice 8a
  // (rest, defaults, nested patterns). Tracked as unintended so a
  // follow-up slice retiring the wider patterns is gated on a baseline drop.
  "destructuring-param-complex",
]);

/** Reasons that are expected until their corresponding slices land. */
const DEFERRED: ReadonlySet<IrFallbackReason> = new Set([
  "async-generator",
  // (#1373 Phase A) Tracked separately from `async-generator` so the gate
  // can flip it from deferred → unintended when Phase B/C wires lowering.
  // Until then async functions are infrastructurally distinct but still
  // fall back to legacy.
  "async-function",
  "deferred-feature",
  "type-parameters",
  "non-export-modifier",
  "unnamed",
]);

// #1923 — post-claim demotion kinds (IrIntegrationError.kind). These are
// functions the selector CLAIMED that then failed *after* claiming and fell
// back to legacy through the warning channel — invisible to the selector-level
// `IrFallbackReason` buckets above. Target = 0 for every kind: a claimed
// function must compile via IR.
type PostClaimKind = "build" | "verify" | "lower" | "backend-legality";
const POST_CLAIM_KINDS: readonly PostClaimKind[] = ["build", "verify", "lower", "backend-legality"];
// Per kind, a map of normalized message class → count.
type PostClaimBuckets = Record<PostClaimKind, Record<string, number>>;

function emptyPostClaim(): PostClaimBuckets {
  return { build: {}, verify: {}, lower: {}, "backend-legality": {} };
}

/**
 * Normalize a post-claim error message into a stable class so unrelated
 * identifier/number noise doesn't fragment the buckets: take the first line,
 * strip quoted identifiers and bare integers, collapse whitespace, cap length.
 */
function normalizeMessageClass(message: string): string {
  return (message.split("\n")[0] ?? "")
    .replace(/'[^']*'/g, "'…'")
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\b\d+\b/g, "N")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

interface Baseline {
  readonly generated: string;
  readonly unintended: Partial<Record<IrFallbackReason, number>>;
  readonly deferred: Partial<Record<IrFallbackReason, number>>;
  // #1923 — post-claim demotion buckets (build/verify/lower/backend-legality).
  // Optional for backward compatibility with pre-#1923 baselines (treated as
  // all-empty, which is the desired target).
  readonly postClaim?: PostClaimBuckets;
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
      if (s.isDirectory()) {
        stack.push(p);
      } else if (s.isFile() && name.endsWith(".ts") && !name.endsWith(".d.ts")) {
        out.push(p);
      }
    }
  }
  return out.sort();
}

async function aggregate(): Promise<{
  unintended: Partial<Record<IrFallbackReason, number>>;
  deferred: Partial<Record<IrFallbackReason, number>>;
  postClaim: PostClaimBuckets;
  perFile: Array<{ file: string; reasons: Partial<Record<IrFallbackReason, number>> }>;
}> {
  const corpus = CORPUS_ROOTS.flatMap(listTsFiles);

  // One in-memory program per file is fine for a 10-file corpus and keeps the
  // checker scope local. Each file's TypeMap is independent.
  const unintended: Partial<Record<IrFallbackReason, number>> = {};
  const deferred: Partial<Record<IrFallbackReason, number>> = {};
  // #1923 — post-claim demotions, collected from a real `compile()` of each
  // corpus file (the selector-level `planIrCompilation` below cannot see them
  // — they happen during build/verify/lower AFTER the selector claims).
  const postClaim = emptyPostClaim();
  const perFile: Array<{ file: string; reasons: Partial<Record<IrFallbackReason, number>> }> = [];

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    strict: true,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    noEmit: true,
  };

  for (const filePath of corpus) {
    const source = readFileSync(filePath, "utf-8");
    const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true);

    // Build a tiny program over just this file so we can derive a checker
    // for the type-propagation pass. Use an in-memory host that returns the
    // file source for `filePath` and falls back to the disk for libs.
    const host: ts.CompilerHost = {
      getSourceFile: (name) => {
        if (name === filePath) return sf;
        if (existsSync(name)) {
          return ts.createSourceFile(name, readFileSync(name, "utf-8"), ts.ScriptTarget.ES2022, true);
        }
        return undefined;
      },
      writeFile: () => {},
      getDefaultLibFileName: () => "lib.d.ts",
      getCurrentDirectory: () => REPO_ROOT,
      getCanonicalFileName: (n) => n,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => "\n",
      fileExists: (n) => existsSync(n),
      readFile: (n) => (existsSync(n) ? readFileSync(n, "utf-8") : undefined),
    };
    const program = ts.createProgram([filePath], compilerOptions, host);
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(filePath) ?? sf;

    let typeMap;
    try {
      typeMap = buildTypeMap(sourceFile, checker);
    } catch {
      // If type propagation fails for an example file, skip it. The point of
      // the gate is to catch IR-claim-shape regressions in the compiler, not
      // to gate on TS type-checker quirks for example code.
      continue;
    }

    const selection = planIrCompilation(sourceFile, { experimentalIR: true, trackFallbacks: true }, typeMap);
    const fileReasons: Partial<Record<IrFallbackReason, number>> = {};
    for (const fb of selection.fallbacks ?? []) {
      const bucket = UNINTENDED.has(fb.reason) ? unintended : deferred;
      bucket[fb.reason] = (bucket[fb.reason] ?? 0) + 1;
      fileReasons[fb.reason] = (fileReasons[fb.reason] ?? 0) + 1;
    }
    perFile.push({ file: relative(REPO_ROOT, filePath), reasons: fileReasons });

    // #1923 — post-claim demotions: compile the file for real and aggregate
    // `irPostClaimErrors` by kind + normalized message class. A compile that
    // throws contributes nothing (same tolerance as the selector pass above).
    try {
      const result = await compile(source, { fileName: filePath, experimentalIR: true });
      for (const e of result.irPostClaimErrors ?? []) {
        const kind = (POST_CLAIM_KINDS as readonly string[]).includes(e.kind) ? (e.kind as PostClaimKind) : "lower";
        const cls = normalizeMessageClass(e.message);
        postClaim[kind][cls] = (postClaim[kind][cls] ?? 0) + 1;
      }
    } catch {
      // ignore — example-file compile failures are not the gate's concern
    }
  }
  return { unintended, deferred, postClaim, perFile };
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
  base: Partial<Record<IrFallbackReason, number>>,
  cur: Partial<Record<IrFallbackReason, number>>,
): { rows: Array<{ reason: string; base: number; cur: number; delta: number }>; anyIncrease: boolean } {
  const reasons = new Set<string>([...Object.keys(base), ...Object.keys(cur)]);
  const rows: Array<{ reason: string; base: number; cur: number; delta: number }> = [];
  let anyIncrease = false;
  for (const reason of [...reasons].sort()) {
    const b = base[reason as IrFallbackReason] ?? 0;
    const c = cur[reason as IrFallbackReason] ?? 0;
    const delta = c - b;
    rows.push({ reason, base: b, cur: c, delta });
    if (delta > 0) anyIncrease = true;
  }
  return { rows, anyIncrease };
}

function formatTable(label: string, rows: Array<{ reason: string; base: number; cur: number; delta: number }>): string {
  if (rows.length === 0) return `\n${label}: (none)\n`;
  const max = Math.max(label.length, ...rows.map((r) => r.reason.length));
  const lines = [
    `\n${label}:`,
    `  ${"reason".padEnd(max)}  baseline   current     delta`,
    `  ${"-".repeat(max)}  --------  --------  --------`,
    ...rows.map(
      (r) =>
        `  ${r.reason.padEnd(max)}  ${String(r.base).padStart(8)}  ${String(r.cur).padStart(8)}  ${(r.delta > 0 ? "+" + r.delta : String(r.delta)).padStart(8)}`,
    ),
  ];
  return lines.join("\n");
}

function formatPerFile(perFile: Array<{ file: string; reasons: Partial<Record<IrFallbackReason, number>> }>): string {
  const rows = perFile.filter((r) => Object.keys(r.reasons).length > 0);
  if (rows.length === 0) return "\nPer-file breakdown: (no rejections)\n";
  const lines = ["\nPer-file breakdown (unintended + deferred):"];
  for (const row of rows) {
    const reasonStr = Object.entries(row.reasons)
      .sort((a, b) => b[1] - a[1])
      .map(([r, n]) => `${r}=${n}`)
      .join(", ");
    lines.push(`  ${row.file}: ${reasonStr}`);
  }
  return lines.join("\n") + "\n";
}

// #1923 — flatten the per-kind post-claim buckets into `kind/messageClass` rows
// and diff against the baseline. Any increase fails (target = 0 for all).
function diffPostClaim(
  base: PostClaimBuckets | undefined,
  cur: PostClaimBuckets,
): { rows: Array<{ reason: string; base: number; cur: number; delta: number }>; anyIncrease: boolean } {
  const b = base ?? emptyPostClaim();
  const rows: Array<{ reason: string; base: number; cur: number; delta: number }> = [];
  let anyIncrease = false;
  for (const kind of POST_CLAIM_KINDS) {
    const classes = new Set<string>([...Object.keys(b[kind] ?? {}), ...Object.keys(cur[kind] ?? {})]);
    for (const cls of [...classes].sort()) {
      const bn = b[kind]?.[cls] ?? 0;
      const cn = cur[kind]?.[cls] ?? 0;
      const delta = cn - bn;
      rows.push({ reason: `${kind}: ${cls}`, base: bn, cur: cn, delta });
      if (delta > 0) anyIncrease = true;
    }
  }
  return { rows, anyIncrease };
}

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  // Mode precedence: --update > --update-on-decrease > --json > gate.
  const mode: "gate" | "update" | "update-on-decrease" | "json" = args.has("--update")
    ? "update"
    : args.has("--update-on-decrease")
      ? "update-on-decrease"
      : args.has("--json")
        ? "json"
        : "gate";
  const verbose = args.has("--verbose");

  const { unintended, deferred, postClaim, perFile } = await aggregate();

  if (mode === "json") {
    process.stdout.write(JSON.stringify({ unintended, deferred, postClaim, perFile }, null, 2) + "\n");
    return;
  }

  const generated = new Date().toISOString().slice(0, 10);
  const next: Baseline = { generated, unintended, deferred, postClaim };

  if (mode === "update") {
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
    process.stdout.write(`Updated ${relative(REPO_ROOT, BASELINE_PATH)}\n`);
    process.stdout.write(formatTable("Unintended (target = 0)", diffTable({}, unintended).rows));
    process.stdout.write(formatTable("Deferred (informational)", diffTable({}, deferred).rows));
    process.stdout.write(
      formatTable("Post-claim demotions (target = 0)", diffPostClaim(undefined, postClaim).rows) + "\n",
    );
    if (verbose) process.stdout.write(formatPerFile(perFile));
    return;
  }

  const baseline = loadBaseline();
  if (!baseline) {
    process.stdout.write(`No baseline at ${relative(REPO_ROOT, BASELINE_PATH)}. Run with --update to create it.\n`);
    process.exit(1);
  }

  const unDiff = diffTable(baseline.unintended, unintended);
  const defDiff = diffTable(baseline.deferred, deferred);
  const pcDiff = diffPostClaim(baseline.postClaim, postClaim);
  process.stdout.write(formatTable("Unintended (gated; must not increase)", unDiff.rows));
  process.stdout.write(formatTable("Deferred (informational)", defDiff.rows));
  process.stdout.write(formatTable("Post-claim demotions (gated; must not increase)", pcDiff.rows) + "\n");

  if (unDiff.anyIncrease) {
    process.stderr.write(
      `\nIR fallback gate: at least one unintended bucket grew vs. baseline.\n` +
        `If the change was intentional (e.g. new IR-claimable feature added in a separate PR), ` +
        `run \`pnpm run check:ir-fallbacks -- --update\` and commit the refreshed baseline.\n`,
    );
    if (verbose) process.stderr.write(formatPerFile(perFile));
    process.exit(1);
  }

  // #1923 — post-claim demotions are a hard regression: a function the selector
  // CLAIMED now fails build/verify/lower and silently falls back to legacy
  // (the #1922 while-loop defect was exactly this, and no gate caught it).
  // Growth fails CI; the legitimate ways to clear it are to FIX the IR path so
  // the claimed function compiles, or — if a shape genuinely shouldn't be
  // claimed — to make the selector reject it (which moves the count into a
  // selector-level `IrFallbackReason` bucket instead).
  if (pcDiff.anyIncrease) {
    process.stderr.write(
      `\nIR fallback gate: post-claim demotions grew vs. baseline (#1923).\n` +
        `A function the selector claimed now fails build/verify/lower and falls back to legacy.\n` +
        `Fix the IR path so the claimed function compiles, or make the selector reject the\n` +
        `shape (moving it into a selector-level bucket). If the growth is genuinely intended,\n` +
        `run \`pnpm run check:ir-fallbacks -- --update\` and commit the refreshed baseline.\n`,
    );
    if (verbose) process.stderr.write(formatPerFile(perFile));
    process.exit(1);
  }

  // #1530 — ratchet policy. When a PR decreases an unintended bucket, the
  // gate writes the lower number back to the committed baseline so the next
  // PR can't silently regress the gain. Decreases are STAGED on disk only;
  // the PR author runs `git add scripts/ir-fallback-baseline.json` to
  // include the diff (we deliberately avoid `git add` inside the script —
  // it would surprise contributors running the gate from a clean tree).
  //
  // The ratchet only fires under `--update-on-decrease`. Default `gate`
  // mode preserves the original behaviour (succeed on equal/decrease,
  // never touch the file) so existing CI invocations are non-breaking.
  // The ratchet flag is meant for the pre-merge job that runs against the
  // merged result; opt-in keeps local `pnpm run check:ir-fallbacks` from
  // dirtying the working tree.
  const totalBase = Object.values(baseline.unintended).reduce((a: number, b) => a + (b ?? 0), 0);
  const totalCur = Object.values(unintended).reduce((a: number, b) => a + (b ?? 0), 0);
  // #1923 — bank post-claim decreases too, so a PR that fixes an IR-path
  // demotion ratchets the bucket down and the next PR can't reintroduce it.
  const anyDecrease = unDiff.rows.some((r) => r.delta < 0) || pcDiff.rows.some((r) => r.delta < 0);

  if (mode === "update-on-decrease" && anyDecrease) {
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
    process.stdout.write(
      `\nIR fallback gate: ratcheted baseline (total unintended ${totalBase} -> ${totalCur}). ` +
        `Staged update to ${relative(REPO_ROOT, BASELINE_PATH)} — commit it with the PR.\n`,
    );
    if (verbose) process.stdout.write(formatPerFile(perFile));
    return;
  }

  // All decreases or equal — silently refresh on local runs is unsafe (would
  // cause main to drift). Just succeed; CI doesn't auto-update either.
  process.stdout.write("\nIR fallback gate: OK (no unintended/post-claim increases vs. baseline).\n");
  if (verbose) process.stdout.write(formatPerFile(perFile));
}

main().catch((err) => {
  process.stderr.write(`check-ir-fallbacks failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exit(2);
});
