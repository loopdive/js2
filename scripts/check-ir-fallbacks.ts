// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #1376 — IR fallback telemetry gate.
 *
 * Compiles a fixed corpus of `.ts` files, plans each exact program graph with
 * source-qualified IR identity, and aggregates rejection reasons by category.
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
import { createRequire } from "node:module";
import { join, dirname, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { analyzeFiles } from "../src/checker/index.js";
import { buildIrUnitInventory } from "../src/ir/identity.js";
import { buildIrPlanningIdentityContext } from "../src/ir/planning-identity.js";
import { buildIrUnitTypeMap } from "../src/ir/propagate.js";
import { planIrCompilationByIdentity, projectIrSelectionToLegacy } from "../src/ir/select-identity.js";
import type { IrFallback, IrFallbackReason, IrSelection } from "../src/ir/select.js";
import type { IrObservedOutcome } from "../src/ir/outcomes.js";
import { makeIrHostDateSnapshotResolver } from "../src/ir/host-date.js";
import { makeIrHostGlobalResolver, makeIrHostVoidCallbackResolver } from "../src/ir/host-extern.js";
import { makeIrPromiseDelayResolver } from "../src/ir/promise-delay.js";
import {
  makeIrArrayExpressionPredicate,
  makeIrDeclaredPrimitiveExpressionClassifier,
  makeIrIdentityModuleBindingResolver,
  makeIrPrimitiveExpressionClassifier,
} from "../src/ir/module-bindings.js";
import {
  makeIrIdentityImportedFunctionResolver,
  projectIrIdentityImportedFunctionResolverToLegacy,
} from "../src/ir/imported-functions.js";
import { compile, compileFiles } from "../src/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// `analyzeFiles` is also consumed from the published CJS-compatible surface
// and currently obtains node:path through `require`. The gate executes source
// directly as ESM, so supply the same Node require binding before compileFiles.
(globalThis as typeof globalThis & { require?: ReturnType<typeof createRequire> }).require ??= createRequire(
  import.meta.url,
);
const REPO_ROOT = resolve(__dirname, "..");
const BASELINE_PATH = join(REPO_ROOT, "scripts/ir-fallback-baseline.json");
const CORPUS_ROOTS = [join(REPO_ROOT, "website/playground/examples")];
const IMPORTED_HOF_ENTRY_FILES = new Set(
  [
    "website/playground/examples/benchmarks.ts",
    "website/playground/examples/benchmarks/array.ts",
    "website/playground/examples/benchmarks/dom.ts",
    "website/playground/examples/benchmarks/fib.ts",
    "website/playground/examples/benchmarks/loop.ts",
    "website/playground/examples/benchmarks/string.ts",
    "website/playground/examples/benchmarks/style.ts",
  ].map((file) => resolve(REPO_ROOT, file)),
);

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
  "array-presize-legacy",
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
  // #3142 Slice 1 — module-level (top-level statement) claim rejections,
  // keyed by rejection reason: one count per corpus MODULE whose module-init
  // unit is not IR-claimable (`selection.moduleInit.reason != null`).
  // Optional for backward compatibility: when absent from the committed
  // baseline the section is reported informationally but not gated.
  readonly moduleLevel?: Partial<Record<IrFallbackReason, number>>;
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

type IrFallbackPlanningGraph = Pick<ReturnType<typeof analyzeFiles>, "checker" | "entryFile" | "sourceFiles">;

/**
 * Run the telemetry selector through the same source-qualified planning seam
 * as production. A graph owns exactly one inventory/context; imported targets
 * are resolved structurally before the selector's explicit compatibility
 * projection, and only the final selection is projected to report labels.
 *
 * `undefined` preserves the gate's historical policy for propagation failure:
 * skip that example. Identity, resolver, selection, and projection invariants
 * remain fail-closed and escape to the caller.
 */
export function planIrFallbackGateEntry(graph: IrFallbackPlanningGraph): IrSelection | undefined {
  const checker = graph.checker;
  const sourceFile = graph.entryFile;
  const identityContext = buildIrPlanningIdentityContext(
    buildIrUnitInventory(graph.sourceFiles, { entrySource: sourceFile, checker }),
  );
  const importedFunctions = projectIrIdentityImportedFunctionResolverToLegacy(
    makeIrIdentityImportedFunctionResolver(checker, graph.sourceFiles, identityContext),
  );

  let unitTypeMap;
  try {
    unitTypeMap = buildIrUnitTypeMap([sourceFile], checker, identityContext);
  } catch {
    return undefined;
  }

  // (#2856) Thread the SAME host-extern options the real compiler passes
  // (`planIrOverlay` in src/codegen/index.ts) so the gate's selector
  // verdicts match production exactly: JS-host mode (the corpus is
  // playground/browser code) + the shared checker-backed ambient-global
  // resolver.
  const identitySelection = planIrCompilationByIdentity(
    sourceFile,
    identityContext,
    {
      experimentalIR: true,
      trackFallbacks: true,
      jsHostExterns: true,
      resolveHostGlobal: makeIrHostGlobalResolver(checker),
      hostVoidCallbacks: makeIrHostVoidCallbackResolver(checker),
      hostDateSnapshots: makeIrHostDateSnapshotResolver(checker),
      promiseDelays: makeIrPromiseDelayResolver(checker),
      importedFunctions,
      resolveModuleBinding: makeIrIdentityModuleBindingResolver(
        checker,
        {
          numberStorage: "f64",
          allowHostExterns: true,
          allowBuiltinMapExtern: true,
        },
        identityContext,
      ),
      classifyPrimitiveExpression: makeIrPrimitiveExpressionClassifier(checker),
      classifyDeclaredPrimitiveExpression: makeIrDeclaredPrimitiveExpressionClassifier(checker),
      isArrayExpression: makeIrArrayExpressionPredicate(checker),
      supportsSymbolicMathHelpers: true,
      supportsLiteralStringReplace: true,
      supportsStringArrayLiterals: true,
    },
    unitTypeMap,
  );
  return projectIrSelectionToLegacy(identitySelection).selection;
}

/**
 * The bare selector records preliminary declines before prepared components
 * are discovered. Reconcile those labels with the terminal production outcome
 * for the same source-qualified owner so a prepared IR replacement removes its
 * stale fallback instead of leaving the gate false-green.
 */
export function reconcileFallbackGateFallbacks(
  fallbacks: readonly IrFallback[],
  outcomes: readonly IrObservedOutcome[],
  entryFile: string,
): { readonly remaining: readonly IrFallback[]; readonly retired: readonly IrFallback[] } {
  const entry = resolve(entryFile);
  const replaced = new Set(
    outcomes
      .filter(
        (outcome) =>
          resolve(REPO_ROOT, outcome.file) === entry &&
          outcome.kind === "emitted" &&
          outcome.irBodyEmitted &&
          !outcome.legacyBodyEmitted,
      )
      .map((outcome) => outcome.displayName),
  );
  const remaining: IrFallback[] = [];
  const retired: IrFallback[] = [];
  for (const fallback of fallbacks) (replaced.has(fallback.name) ? retired : remaining).push(fallback);
  return { remaining, retired };
}

async function aggregate(): Promise<{
  unintended: Partial<Record<IrFallbackReason, number>>;
  deferred: Partial<Record<IrFallbackReason, number>>;
  postClaim: PostClaimBuckets;
  // #3142 Slice 1 — module-level rejection histogram + informational
  // claimable/empty module counts (not baselined; printed for context).
  moduleLevel: Partial<Record<IrFallbackReason, number>>;
  moduleLevelInfo: { claimable: number; empty: number };
  modulePerFile: Array<{ file: string; status: string }>;
  perFile: Array<{ file: string; reasons: Partial<Record<IrFallbackReason, number>> }>;
  reconciled: Array<{ file: string; reasons: Partial<Record<IrFallbackReason, number>> }>;
  // (#2856 Step-1) Per-rejection reject-arm detail for `body-shape-rejected`,
  // populated only when JS2WASM_IR_SHAPE_DIAG=1 (select.ts records it).
  shapeDetails: Array<{ file: string; name: string; detail: string }>;
}> {
  const corpus = CORPUS_ROOTS.flatMap(listTsFiles);

  // One disk-backed program per entry mirrors compileFiles: imports and barrel
  // re-exports participate in the same checker realm and exact source set.
  const unintended: Partial<Record<IrFallbackReason, number>> = {};
  const deferred: Partial<Record<IrFallbackReason, number>> = {};
  // #1923 — post-claim demotions, collected from a real `compileFiles()` graph
  // for each corpus entry (the planning selector below cannot see them — they
  // happen during build/verify/lower AFTER the selector claims).
  const postClaim = emptyPostClaim();
  const moduleLevel: Partial<Record<IrFallbackReason, number>> = {};
  const moduleLevelInfo = { claimable: 0, empty: 0 };
  const modulePerFile: Array<{ file: string; status: string }> = [];
  const perFile: Array<{ file: string; reasons: Partial<Record<IrFallbackReason, number>> }> = [];
  const reconciled: Array<{ file: string; reasons: Partial<Record<IrFallbackReason, number>> }> = [];
  const shapeDetails: Array<{ file: string; name: string; detail: string }> = [];

  for (const filePath of corpus) {
    // Use the exact production disk graph and checker that compileFiles uses,
    // including dependency order and the emitted user-source set.
    const graph = analyzeFiles(filePath);
    const selection = planIrFallbackGateEntry(graph);
    if (!selection) {
      // If type propagation fails for an example file, skip it. The point of
      // the gate is to catch IR-claim-shape regressions in the compiler, not
      // to gate on TS type-checker quirks for example code.
      continue;
    }
    let productionResult: Awaited<ReturnType<typeof compileFiles>> | undefined;
    try {
      productionResult = await compileFiles(filePath, { experimentalIR: true, trackIrOutcomes: true });
      if (
        IMPORTED_HOF_ENTRY_FILES.has(resolve(filePath)) &&
        !(productionResult.irCompiledFuncs ?? []).includes("main")
      ) {
        throw new Error(`#3214 A+B1 gate invariant: ${relative(REPO_ROOT, filePath)}::main was not emitted through IR`);
      }
      for (const e of productionResult.irPostClaimErrors ?? []) {
        const kind = (POST_CLAIM_KINDS as readonly string[]).includes(e.kind) ? (e.kind as PostClaimKind) : "lower";
        const cls = normalizeMessageClass(e.message);
        postClaim[kind][cls] = (postClaim[kind][cls] ?? 0) + 1;
      }
    } catch (error) {
      if (IMPORTED_HOF_ENTRY_FILES.has(resolve(filePath))) throw error;
      // Other example-file compile failures are not the gate's concern. Their
      // preliminary selector fallbacks remain visible because no terminal
      // production outcome exists to reconcile them.
    }

    // Prepared async discovery uses the same host-source lane as the bounded
    // readiness census. `compileFiles` intentionally has a smaller ambient
    // library and therefore cannot observe these Promise/Date/console-backed
    // prepared components; keep it above for the multi-file post-claim meter,
    // but reconcile its preliminary `async-function` labels with the actual
    // production host outcome.
    let terminalOutcomes = productionResult?.irOutcomes ?? [];
    if ((selection.fallbacks ?? []).some((fallback) => fallback.reason === "async-function")) {
      const hostResult = await compile(readFileSync(filePath, "utf8"), {
        fileName: filePath,
        target: "gc",
        experimentalIR: true,
        trackIrOutcomes: true,
      });
      terminalOutcomes = hostResult.irOutcomes ?? [];
    }
    const effective = reconcileFallbackGateFallbacks(selection.fallbacks ?? [], terminalOutcomes, filePath);
    const fileReasons: Partial<Record<IrFallbackReason, number>> = {};
    for (const fb of effective.remaining) {
      const bucket = UNINTENDED.has(fb.reason) ? unintended : deferred;
      bucket[fb.reason] = (bucket[fb.reason] ?? 0) + 1;
      fileReasons[fb.reason] = (fileReasons[fb.reason] ?? 0) + 1;
      if (fb.reason === "body-shape-rejected" && fb.detail) {
        shapeDetails.push({ file: relative(REPO_ROOT, filePath), name: fb.name, detail: fb.detail });
      }
    }
    perFile.push({ file: relative(REPO_ROOT, filePath), reasons: fileReasons });
    const retiredReasons: Partial<Record<IrFallbackReason, number>> = {};
    for (const fb of effective.retired) retiredReasons[fb.reason] = (retiredReasons[fb.reason] ?? 0) + 1;
    if (effective.retired.length > 0) {
      reconciled.push({ file: relative(REPO_ROOT, filePath), reasons: retiredReasons });
    }

    // #3142 Slice 1 — module-level claim assessment (one verdict per module).
    if (selection.moduleInit) {
      const mi = selection.moduleInit;
      if (mi.reason !== null) {
        moduleLevel[mi.reason] = (moduleLevel[mi.reason] ?? 0) + 1;
        modulePerFile.push({ file: relative(REPO_ROOT, filePath), status: `${mi.reason} (${mi.stmtCount} stmts)` });
      } else if (mi.stmtCount === 0) {
        moduleLevelInfo.empty += 1;
        modulePerFile.push({ file: relative(REPO_ROOT, filePath), status: "empty (no module-init statements)" });
      } else {
        moduleLevelInfo.claimable += 1;
        modulePerFile.push({ file: relative(REPO_ROOT, filePath), status: `claimable (${mi.stmtCount} stmts)` });
      }
    }
  }
  return {
    unintended,
    deferred,
    postClaim,
    moduleLevel,
    moduleLevelInfo,
    modulePerFile,
    perFile,
    reconciled,
    shapeDetails,
  };
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
  const shapeDiag = args.has("--shape-diag");

  const {
    unintended,
    deferred,
    postClaim,
    moduleLevel,
    moduleLevelInfo,
    modulePerFile,
    perFile,
    reconciled,
    shapeDetails,
  } = await aggregate();

  // (#2856 Step-1) `--shape-diag`: print the `body-shape-rejected` reject-arm
  // histogram. Requires `JS2WASM_IR_SHAPE_DIAG=1` in the env (select.ts reads it
  // at module load to enable the opt-in recorder). This attributes each of the
  // rejected functions to its proximate `isPhase1*` reject arm + node kind.
  if (shapeDiag) {
    if (process.env.JS2WASM_IR_SHAPE_DIAG !== "1") {
      process.stderr.write(
        "--shape-diag requires JS2WASM_IR_SHAPE_DIAG=1 in the environment (the recorder is gated at module load).\n" +
          "Re-run: JS2WASM_IR_SHAPE_DIAG=1 pnpm run check:ir-fallbacks -- --shape-diag\n",
      );
      process.exitCode = 2;
      return;
    }
    const hist = new Map<string, number>();
    for (const d of shapeDetails) hist.set(d.detail, (hist.get(d.detail) ?? 0) + 1);
    const total = shapeDetails.length;
    process.stdout.write(`\n=== body-shape-rejected reject-arm histogram (#2856 Step-1) ===\n`);
    process.stdout.write(`  attributed: ${total} rejections\n\n`);
    for (const [arm, n] of [...hist.entries()].sort((a, b) => b[1] - a[1])) {
      process.stdout.write(`  ${String(n).padStart(4)}  ${arm}\n`);
    }
    process.stdout.write(`\n=== per-function ===\n`);
    for (const d of shapeDetails.sort((a, b) => a.file.localeCompare(b.file))) {
      process.stdout.write(`  ${d.file}  ${d.name}  →  ${d.detail}\n`);
    }
    process.stdout.write("\n");
    return;
  }

  if (mode === "json") {
    process.stdout.write(
      JSON.stringify({ unintended, deferred, postClaim, moduleLevel, moduleLevelInfo, perFile, reconciled }, null, 2) +
        "\n",
    );
    return;
  }

  const generated = new Date().toISOString().slice(0, 10);
  const next: Baseline = { generated, unintended, deferred, postClaim, moduleLevel };

  // #3142 — one-line context for the module-level section (informational).
  const moduleLevelSummary = `\nModule-level units: ${moduleLevelInfo.claimable} claimable, ${moduleLevelInfo.empty} empty (declarations-only)\n`;

  if (mode === "update") {
    writeFileSync(BASELINE_PATH, JSON.stringify(next, null, 2) + "\n", "utf-8");
    process.stdout.write(`Updated ${relative(REPO_ROOT, BASELINE_PATH)}\n`);
    process.stdout.write(formatTable("Unintended (target = 0)", diffTable({}, unintended).rows));
    process.stdout.write(formatTable("Deferred (informational)", diffTable({}, deferred).rows));
    process.stdout.write(formatTable("Module-level rejections (#3142; target = 0)", diffTable({}, moduleLevel).rows));
    process.stdout.write(moduleLevelSummary);
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
  // #3142 — module-level bucket: gated only once the committed baseline
  // carries the section (back-compat: older baselines report info-only).
  const mlGated = baseline.moduleLevel !== undefined;
  const mlDiff = diffTable(baseline.moduleLevel ?? {}, moduleLevel);
  process.stdout.write(formatTable("Unintended (gated; must not increase)", unDiff.rows));
  process.stdout.write(formatTable("Deferred (informational)", defDiff.rows));
  process.stdout.write(
    formatTable(
      mlGated
        ? "Module-level rejections (#3142; gated; must not increase)"
        : "Module-level rejections (#3142; informational — baseline has no section yet)",
      mlDiff.rows,
    ),
  );
  process.stdout.write(moduleLevelSummary);
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

  // #3142 — module-level bucket growth fails once the baseline carries it.
  if (mlGated && mlDiff.anyIncrease) {
    process.stderr.write(
      `\nIR fallback gate: the module-level rejection bucket grew vs. baseline (#3142).\n` +
        `A corpus module whose top-level statement list was IR-claimable no longer is.\n` +
        `If the change was intentional, run \`pnpm run check:ir-fallbacks -- --update\` and\n` +
        `commit the refreshed baseline.\n`,
    );
    for (const row of modulePerFile) process.stderr.write(`  ${row.file}: ${row.status}\n`);
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
  // #3142 — likewise for the module-level bucket (and a baseline that lacks
  // the section counts as a bankable change so the first ratchet run after
  // this gate lands writes it).
  const anyDecrease =
    unDiff.rows.some((r) => r.delta < 0) ||
    pcDiff.rows.some((r) => r.delta < 0) ||
    (mlGated && mlDiff.rows.some((r) => r.delta < 0)) ||
    !mlGated;

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
  process.stdout.write("\nIR fallback gate: OK (no unintended/post-claim/module-level increases vs. baseline).\n");
  if (verbose) {
    process.stdout.write(formatPerFile(perFile));
    process.stdout.write("\nModule-level per-file (#3142):\n");
    for (const row of modulePerFile) process.stdout.write(`  ${row.file}: ${row.status}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((err) => {
    process.stderr.write(`check-ir-fallbacks failed: ${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(2);
  });
}
