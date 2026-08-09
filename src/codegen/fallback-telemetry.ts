// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * #2089 — silent-fallback telemetry choke point (Phase 0).
 *
 * Codegen-internal counterpart to the proven IR fallback budget
 * (#1376/#1530 — `scripts/check-ir-fallbacks.ts` + `STRICT_IR_REASONS`) and
 * the strict host-import allowlist (#1524/#1888). Roughly 30 of the ~135
 * June-2026 wrong-answer bugs trace to seven *silent-fallback* pattern
 * classes in `src/codegen/` — each emits a plausible-but-wrong value (a
 * `ref.null`, a `0`/`NaN`, a skipped field, a truncated arg list) and
 * continues, so the bug surfaces far from its cause and the class keeps
 * breeding. None were counted.
 *
 * This module is the single place each such site calls so the classes become
 * observable and, eventually, ratcheted to zero (at which point a class is
 * added to {@link STRICT_FALLBACK_CLASSES} and any recurrence is promoted to a
 * hard compile error — exactly the `STRICT_IR_REASONS` lifecycle).
 *
 * Phase 0 is **pure telemetry**: `reportSilentFallback` only increments
 * counters (and, when opted in, pushes a *warning*). No emitted code changes,
 * so it cannot regress conformance — it captures current reality as a baseline
 * for the gate (`scripts/check-codegen-fallbacks.ts`).
 */
import { ts } from "../ts-api.js";
import type { CodegenContext } from "./context/types.js";

/**
 * The seven silent-fallback pattern classes from the fail-loud audit
 * (`plan/log/analysis-2026-06/04-fail-loud-audit.md` §summary table).
 */
export type SilentFallbackClass =
  | "null-fallback" // (a) a `ref.null` value substituted for an unresolvable value
  | "lookup-miss-skip" // (b) a `findIndex`/`=== -1` miss silently skips work
  | "const-fallback" // (c) a `NaN`/`0`/`false` constant substituted for "unresolvable"
  | "arity-truncation" // (d) `Math.min(args.length, arity)` drops trailing args
  | "allowlist-miss" // (e) an allowlist `Set` miss disables a behavior
  | "cap-exceeded-path" // (f) a hardcoded cap silently bounds output
  | "compiler-catch"; // (g) a bare `catch {}` swallows a codegen error

/** All known classes, in declaration order — the canonical iteration order. */
export const SILENT_FALLBACK_CLASSES: readonly SilentFallbackClass[] = [
  "null-fallback",
  "lookup-miss-skip",
  "const-fallback",
  "arity-truncation",
  "allowlist-miss",
  "cap-exceeded-path",
  "compiler-catch",
];

/**
 * Per-class → per-site → hit count. Sites are stable string keys of the form
 * `"<file-stem>:<short-label>"` (e.g. `"unary-updates:incdec-unresolvable-receiver"`)
 * so the baseline JSON diff is readable and resilient to line moves.
 */
export type FallbackCounts = Map<SilentFallbackClass, Map<string, number>>;

/** Build an empty {@link FallbackCounts} with every class pre-seeded. */
export function createFallbackCounts(): FallbackCounts {
  const counts: FallbackCounts = new Map();
  for (const cls of SILENT_FALLBACK_CLASSES) counts.set(cls, new Map());
  return counts;
}

/**
 * Classes promoted to hard errors once their corpus baseline hits zero —
 * the codegen analogue of `STRICT_IR_REASONS` (index.ts). Empty in Phase 0
 * (telemetry only); Phase 4 flips `lookup-miss-skip`/`null-fallback` in here
 * as their buckets zero out. A site in a strict class pushes a hard error.
 */
export const STRICT_FALLBACK_CLASSES: ReadonlySet<SilentFallbackClass> = new Set<SilentFallbackClass>();

/** (#3195) Shared leaf util — an env var is "truthy" when `"1"` or `"true"`. */
export function truthyEnv(v: string | undefined): boolean {
  return v === "1" || v === "true";
}

/**
 * Whether a *strict* class should hard-fail in the current environment.
 * Auto-on under CI / vitest / `NODE_ENV=test`, or forced via
 * `JS2WASM_STRICT_FALLBACKS=1`. Phase 0 has no strict classes, so this only
 * matters once a class is promoted. Typed IR Invariants are independently
 * always fatal and do not use this environment gate.
 */
export function strictFallbacksEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return (
    truthyEnv(env.JS2WASM_STRICT_FALLBACKS) || truthyEnv(env.CI) || env.NODE_ENV === "test" || truthyEnv(env.VITEST)
  );
}

/**
 * Record that a silent fallback was taken at `site`.
 *
 * Three escalation levels (identical lifecycle to `STRICT_IR_REASONS`):
 *   1. always — increments `ctx.fallbackCounts[cls][site]`.
 *   2. opt-in — when `ctx.trackSilentFallbacks` (or `JS2WASM_LOG_CODEGEN_FALLBACKS=1`),
 *      pushes a structured *warning* error so the diagnostic surfaces.
 *   3. strict — when `cls ∈ STRICT_FALLBACK_CLASSES` and {@link strictFallbacksEnabled},
 *      pushes a *hard* error so the fallback can no longer hide.
 *
 * Pure bookkeeping otherwise — it never touches the wasm body, so adding a
 * call at a site is behavior-preserving in Phase 0.
 */
export function reportSilentFallback(
  ctx: CodegenContext,
  cls: SilentFallbackClass,
  site: string,
  node?: ts.Node,
  detail?: string,
): void {
  // 1. count
  let bySite = ctx.fallbackCounts.get(cls);
  if (bySite === undefined) {
    bySite = new Map();
    ctx.fallbackCounts.set(cls, bySite);
  }
  bySite.set(site, (bySite.get(site) ?? 0) + 1);

  const strict = STRICT_FALLBACK_CLASSES.has(cls) && strictFallbacksEnabled();
  const warn = ctx.trackSilentFallbacks === true || truthyEnv(process.env.JS2WASM_LOG_CODEGEN_FALLBACKS);
  if (!strict && !warn) return;

  // 2/3. emit a structured diagnostic (warning, or hard error when strict)
  const where = node ?? ctx.lastKnownNode ?? undefined;
  let line: number | undefined;
  let column: number | undefined;
  const sf = where?.getSourceFile();
  if (sf && where) {
    try {
      const pos = sf.getLineAndCharacterOfPosition(where.getStart(sf));
      line = pos.line + 1;
      column = pos.character + 1;
    } catch {
      // synthetic / detached node — no position; leave undefined.
    }
  }
  const message = `silent-fallback [${cls}] at ${site}${detail ? `: ${detail}` : ""}`;
  ctx.errors.push({
    message,
    line: line ?? 0,
    column: column ?? 0,
    severity: strict ? "error" : "warning",
  });
}

/** Total hits across all classes/sites — used by the gate for a quick summary. */
export function totalFallbackHits(counts: FallbackCounts): number {
  let total = 0;
  for (const bySite of counts.values()) {
    for (const n of bySite.values()) total += n;
  }
  return total;
}

/**
 * Flatten {@link FallbackCounts} into a stable, JSON-serializable shape for the
 * baseline file: `{ [class]: { [site]: count } }`, classes and sites sorted.
 */
export function fallbackCountsToJson(counts: FallbackCounts): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const cls of SILENT_FALLBACK_CLASSES) {
    const bySite = counts.get(cls);
    if (!bySite || bySite.size === 0) continue;
    const sites: Record<string, number> = {};
    for (const site of [...bySite.keys()].sort()) {
      sites[site] = bySite.get(site)!;
    }
    out[cls] = sites;
  }
  return out;
}
