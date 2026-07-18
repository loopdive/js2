// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
/**
 * (#3335) Baseline-refresh trap-growth gate.
 *
 * The #3189 uncatchable-trap ratchet (null_deref / illegal_cast / oob /
 * unreachable) protects PRs against trap-mode worsening — but the SCHEDULED
 * baseline refresh and the promote-baseline job used to bake a main-side
 * trap increase straight into `js2wasm-baselines`, silently RAISING the
 * ratchet floor (the 2026-07-17 45→51 oob flap: six BigInt
 * `TypedArray.prototype.set` files flipped from a catchable error to a
 * trap-classified failure, two innocent PRs parked, and the next refresh
 * legalized the worse mode within one cycle).
 *
 * This gate runs in BOTH baseline writers (`test262-sharded.yml`
 * promote-baseline and `refresh-baseline.yml`) right before the baselines-repo
 * push: it diffs the CANDIDATE jsonl against the PREVIOUS baseline jsonl with
 * the same `evaluateTrapCategoryGrowth` logic the PR ratchet uses, and exits
 * non-zero when any trap category GREW — refusing the push, so main-side
 * trap-mode worsening needs an explicit acknowledgment instead of
 * self-legalizing.
 *
 * Intentional oracle rebaselines declare a change-scoped
 * `trap-growth-allow:` per-category ceiling in their own issue frontmatter.
 * The landed merge's push consumes it once, while later refreshes see no
 * granting issue in their change-set. `BASELINE_TRAP_GROWTH_ALLOW` remains the
 * operational emergency valve. The FORCED refresh path bypasses the gate.
 *
 * Usage:
 *   npx tsx scripts/check-baseline-trap-growth.ts \
 *     --baseline <previous.jsonl> --candidate <new.jsonl> [--allow N]
 *
 * Exit codes: 0 ok / no previous baseline · 1 trap growth beyond tolerance ·
 * 2 usage/IO error.
 */
import { readFileSync, existsSync } from "fs";
import {
  evaluateTrapCategoryGrowth,
  readChangeScopedNumericAllowance,
  TRAP_ERROR_CATEGORIES,
  TRAP_GROWTH_ALLOW_KEY,
} from "./diff-test262.js";

interface Row {
  file: string;
  status: string;
  error_category?: string;
  wasm_sha?: string | null;
  oracle_version?: number;
}

export function loadJsonlMap(path: string): Map<string, Row> {
  const map = new Map<string, Row>();
  const text = readFileSync(path, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed) as Row;
      if (row && typeof row.file === "string") map.set(row.file, row);
    } catch {
      /* tolerate stray partial lines — the writers append atomically per row */
    }
  }
  return map;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function oracleVersion(rows: Map<string, Row>): number | undefined {
  const versions = new Set([...rows.values()].map((row) => row.oracle_version).filter((v) => typeof v === "number"));
  return versions.size === 1 ? [...versions][0] : undefined;
}

export function effectiveBaselineTrapTolerance(
  configured: number,
  baseOracle: number | undefined,
  candidateOracle: number | undefined,
  scopedCeiling: number,
): number {
  return typeof baseOracle === "number" && typeof candidateOracle === "number" && candidateOracle > baseOracle
    ? Math.max(configured, scopedCeiling)
    : configured;
}

async function main(): Promise<void> {
  const baselinePath = arg("--baseline");
  const candidatePath = arg("--candidate");
  const allow = Number.parseInt(arg("--allow") ?? process.env.BASELINE_TRAP_GROWTH_ALLOW ?? "0", 10) || 0;

  if (!baselinePath || !candidatePath) {
    console.error("usage: check-baseline-trap-growth --baseline <old.jsonl> --candidate <new.jsonl> [--allow N]");
    process.exit(2);
  }
  if (!existsSync(baselinePath)) {
    // First-ever baseline (or a fresh baselines clone without the file): there
    // is nothing to ratchet against — allow the seed push.
    console.log(`[trap-growth] no previous baseline at ${baselinePath} — seed push allowed.`);
    process.exit(0);
  }
  if (!existsSync(candidatePath)) {
    console.error(`[trap-growth] candidate jsonl missing: ${candidatePath}`);
    process.exit(2);
  }

  const baseline = loadJsonlMap(baselinePath);
  const candidate = loadJsonlMap(candidatePath);
  const baseOracle = oracleVersion(baseline);
  const candidateOracle = oracleVersion(candidate);
  const forwardOracleBump =
    typeof baseOracle === "number" && typeof candidateOracle === "number" && candidateOracle > baseOracle;
  let scopedAllow = 0;
  if (forwardOracleBump) {
    const loaded = await readChangeScopedNumericAllowance({
      key: TRAP_GROWTH_ALLOW_KEY,
      label: "trap-growth-allow (#3370)",
      overrideEnv: "TRAP_GROWTH_ALLOW_FILE",
    });
    for (const note of loaded.notes) console.log(note);
    if (loaded.allowance) {
      scopedAllow = loaded.allowance.count;
      console.log(
        `[trap-growth] oracle v${baseOracle} → v${candidateOracle}: using change-scoped per-category ceiling ${scopedAllow} ` +
          `(${loaded.allowance.reason}; ${loaded.allowance.sources.join(", ")}).`,
      );
    }
  }
  const effectiveAllow = effectiveBaselineTrapTolerance(allow, baseOracle, candidateOracle, scopedAllow);
  const growth = evaluateTrapCategoryGrowth(baseline, candidate, effectiveAllow);

  const fmt = (counts: Record<string, number>) => TRAP_ERROR_CATEGORIES.map((c) => `${c}=${counts[c]}`).join(" ");
  console.log(`[trap-growth] previous: ${fmt(growth.baseCounts)}`);
  console.log(`[trap-growth] candidate: ${fmt(growth.newCounts)} (tolerance ${effectiveAllow})`);

  if (growth.failures.length > 0) {
    for (const f of growth.failures) {
      console.error(`::error title=Baseline trap growth (#3335)::${f}`);
    }
    console.error(
      "[trap-growth] REFUSING baseline push — an uncatchable-trap category grew vs the previous baseline.\n" +
        "This is a main-side trap-mode regression: baking it in would silently raise the #3189 ratchet\n" +
        "floor (and park innocent PRs on the flap). Fix the regression on main, or — for an INTENTIONAL\n" +
        "reclassification — declare a bounded trap-growth-allow in the oracle-bump issue, or use\n" +
        "BASELINE_TRAP_GROWTH_ALLOW only as an emergency one-cycle valve. See #3370/#3335.",
    );
    process.exit(1);
  }
  console.log("[trap-growth] OK — no trap-category growth beyond tolerance.");
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isDirectRun) await main();
