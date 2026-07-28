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
 * Intentional reclassifications declare a change-scoped `trap-growth-allow:`
 * per-category ceiling in their own issue frontmatter. The landed merge's push
 * consumes it once, while later refreshes see no granting issue in their
 * change-set. Since #3644 the DECLARATION'S SHAPE selects the contract, exactly
 * as on the PR side (#3596): a nested `tests:` list is honoured here whether or
 * not the oracle bumped, and is machine-verified; a bare `count:` stays
 * oracle-bump-only. See `baselineTrapAllowanceContract`.
 *
 * `BASELINE_TRAP_GROWTH_ALLOW` remains the operational emergency valve.
 *
 * ⚠️ WHICH FORCED PATH BYPASSES THIS GATE — the previous wording ("The FORCED
 * refresh path bypasses the gate") was TRUE of one caller and FALSE of the
 * other, which is worse than saying nothing:
 *   • `refresh-baseline.yml` — the gate is skipped when `IS_FORCED` (its
 *     `if [ "${IS_FORCED}" != "true" ] && …` guard). Bypass is real there.
 *   • `test262-sharded.yml` (`promote-baseline` AND `write-run-cache-bot`, the
 *     queue-merge writer) — there is NO force guard. `force_baseline_refresh`
 *     is consulted only by the separate `regression-gate` job (hence its
 *     "regardless of regressions" wording) and by an audit step that merely
 *     echoes a warning. A forced dispatch of THAT workflow still runs this gate
 *     in full. Its only lever is `--allow`/`BASELINE_TRAP_GROWTH_ALLOW`.
 * Establish that a bypass is live in the caller you actually mean before
 * relying on it.
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
  evaluateTrapReclassification,
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

/**
 * #3370 contract — a BARE `count:`/`reason:` declaration (no `tests:` list) is
 * honoured only across a forward oracle bump, because the bump is itself the
 * containment: an uncheckable number is trusted only where the whole corpus is
 * being deliberately re-measured. Unchanged by #3644; the named-tests contract
 * below is a separate arm.
 */
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

/**
 * (#3644) Which contract does a `trap-growth-allow` declaration get in the
 * BASELINE WRITER? Mirrors `diff-test262.ts`'s PR-side rule exactly: **the
 * declaration's own shape selects the contract, not the run context.**
 *
 *   • `tests:` PRESENT → honoured whether or not the oracle bumped, and then
 *     MACHINE-VERIFIED (`evaluateTrapReclassification`). Strictly a tightening:
 *     verification can only ever refuse a declaration, never admit one the
 *     ceiling alone would have rejected.
 *   • `tests:` ABSENT → #3370 semantics, unchanged: bare count, oracle-bump only.
 *
 * WHY THIS EXISTS. Before #3644 this writer read the allowance **only** when the
 * oracle had bumped forward, so a same-oracle #3596-shaped declaration was
 * invisible here — the allowance was honoured at PR and `merge_group` level and
 * then IGNORED by the post-merge promote job that every downstream gate depends
 * on. Measured consequence (2026-07-25): PR #3629 landed a correct, named,
 * verifiable `trap-growth-allow` for one fail→fail reclassification; the promote
 * job hard-failed `illegal_cast 74 → 75`, and because nothing on main will ever
 * lower that count again, promotion was wedged PERMANENTLY, not transiently.
 * The freeze then cascaded: every later PR's `merge_group` compared the merged
 * state (75) against the frozen baseline (74) and failed on a trap belonging to
 * main, with no valve legitimately available to it — a change-scoped allowance
 * is correctly unreachable for a change you did not make. The queue stopped.
 *
 * THE GENERAL RULE: **an allowance must be readable everywhere it is enforced.**
 * A post-merge gate that can only ever say "no" has no repair path — the code is
 * already on main, so refusing to promote does not undo it, it only blinds every
 * downstream gate and blocks the fix for the very condition it detects.
 */
export function baselineTrapAllowanceContract(opts: {
  hasNamedTests: boolean;
  forwardOracleBump: boolean;
}): "named-verified" | "bare-oracle-bump" | "inert" {
  if (opts.hasNamedTests) return "named-verified";
  return opts.forwardOracleBump ? "bare-oracle-bump" : "inert";
}

async function sendBaselineFreezeAlert(failures: string[]): Promise<void> {
  const url = process.env.NTFY_URL;
  if (!url) return;
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  const runUrl =
    GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_RUN_ID
      ? `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
      : "(run URL unavailable)";
  const body =
    "Baseline promote BLOCKED by the trap-growth gate (#3335): " +
    failures.join(" | ") +
    ". The landing-page test262 number will FREEZE until this is acknowledged " +
    "(repo var BASELINE_TRAP_GROWTH_ALLOW=1 for ONE cycle) or the regression is fixed. " +
    runUrl;
  try {
    await fetch(url, {
      method: "POST",
      headers: { Title: "js2wasm baseline FROZEN (trap-growth #3335)", Priority: "high", Tags: "warning" },
      body,
      signal: AbortSignal.timeout(10000),
    });
    console.log("[trap-growth] freeze alert sent to NTFY_URL.");
  } catch (err) {
    console.log(`[trap-growth] freeze alert send failed (non-fatal): ${(err as Error).message}`);
  }
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
  // (#3644) Read the declaration UNCONDITIONALLY. It used to be read only when
  // `forwardOracleBump` was true, which made a same-oracle #3596-shaped
  // declaration invisible to this writer even though the PR gate honoured it —
  // see `baselineTrapAllowanceContract` for the outage that caused.
  const loaded = await readChangeScopedNumericAllowance({
    key: TRAP_GROWTH_ALLOW_KEY,
    label: "trap-growth-allow (#3644)",
    overrideEnv: "TRAP_GROWTH_ALLOW_FILE",
  });
  for (const note of loaded.notes) console.log(note);
  const allowance = loaded.allowance;
  const contract = baselineTrapAllowanceContract({
    hasNamedTests: (allowance?.tests ?? []).length > 0,
    forwardOracleBump,
  });
  const scopedAllow = allowance && contract !== "inert" ? allowance.count : 0;
  if (allowance) {
    const why =
      contract === "named-verified"
        ? `named-tests contract (#3596 shape) — ${allowance.tests?.length ?? 0} declared test(s), verified below`
        : contract === "bare-oracle-bump"
          ? `bare count across oracle v${baseOracle} → v${candidateOracle} (#3370)`
          : `INERT — a bare count grants nothing without a forward oracle bump; ` +
            `add a nested \`tests:\` list to make the claim machine-checkable (#3596)`;
    console.log(
      `[trap-growth] change-scoped declaration found: ceiling ${allowance.count}, ${why} ` +
        `(${allowance.reason}; ${allowance.sources.join(", ")}).`,
    );
  }
  const effectiveAllow =
    contract === "named-verified"
      ? Math.max(allow, scopedAllow)
      : effectiveBaselineTrapTolerance(allow, baseOracle, candidateOracle, scopedAllow);
  // (#3735) before/after snapshots of the same full-corpus root baseline —
  // exactly the case missingBaselineRowsAreUnknown was designed for; was
  // never wired into this CLI's own call (already covered by issue-3592/-3596 tests).
  const growth = evaluateTrapCategoryGrowth(baseline, candidate, effectiveAllow, {
    missingBaselineRowsAreUnknown: true,
  });

  const fmt = (counts: Record<string, number>) => TRAP_ERROR_CATEGORIES.map((c) => `${c}=${counts[c]}`).join(" ");
  console.log(`[trap-growth] previous: ${fmt(growth.baseCounts)}`);
  console.log(`[trap-growth] candidate: ${fmt(growth.newCounts)} (tolerance ${effectiveAllow})`);

  // (#3644) A named declaration is VERIFIED, not trusted — the same
  // `evaluateTrapReclassification` contract the PR gate applies. Every named
  // test must be non-passing on the previous baseline (a `pass → trap`
  // transition is a real regression and still hard-fails), and every file
  // actually responsible for the growth must be named (so `count: 1` cannot
  // silently excuse an unrelated new trap). Only runs when the allowance did
  // some work — a declaration that excused nothing needs no proof.
  if (allowance && contract === "named-verified" && growth.failures.length === 0) {
    const maxGrowth = Math.max(0, ...TRAP_ERROR_CATEGORIES.map((c) => growth.newCounts[c] - growth.baseCounts[c]));
    if (maxGrowth > 0) {
      const recheck = evaluateTrapReclassification({ allowance, baseline, growth });
      for (const note of recheck.notes) console.log(note);
      if (recheck.failures.length > 0) {
        for (const f of recheck.failures) console.error(`::error title=Baseline trap growth (#3644)::${f}`);
        console.error(
          "[trap-growth] REFUSING baseline push — the change-scoped trap-growth-allow did NOT verify.\n" +
            "The ceiling alone never admits growth: the declaration must name the reclassified tests, each must be\n" +
            "non-passing on the previous baseline, and no undeclared trap growth may remain. See #3596/#3644.",
        );
        await sendBaselineFreezeAlert(recheck.failures);
        process.exit(1);
      }
      console.log(
        `[trap-growth] change-scoped allowance CONSUMED: maximum category growth ${maxGrowth} within the declared ` +
          `ceiling ${allowance.count}, reclassification verified. Promoting.`,
      );
    }
  }

  if (growth.failures.length > 0) {
    for (const f of growth.failures) {
      console.error(`::error title=Baseline trap growth (#3335)::${f}`);
    }
    // (#3644) When the gate refuses and NO declaration was found, say why the
    // scoping came up empty. Previously this path was silent about the
    // allowance entirely, so "the declaration was never read" and "the
    // declaration was read and rejected" looked identical in the log — the
    // ambiguity that made the 2026-07-25 wedge take four hops to diagnose. A
    // shallow checkout whose `HEAD^1` diff fails would also land here, and that
    // failure mode must be visible rather than degrade into a silent refusal.
    if (!allowance) {
      const { resolveChangeBase, changedPaths } = await import("./lib/change-scope.mjs");
      const { base, how } = resolveChangeBase(process.cwd());
      const issueFiles = base ? [...(changedPaths(process.cwd(), base, "plan/issues") ?? [])] : undefined;
      console.error(
        `[trap-growth] no change-scoped trap-growth-allow was found for this change-set.\n` +
          `             base=${base ?? "(unresolved)"} via ${how}\n` +
          `             plan/issues files in the change-set: ` +
          `${issueFiles === undefined ? "(diff failed — scoping is BROKEN, not merely empty)" : issueFiles.length === 0 ? "(none)" : issueFiles.join(", ")}\n` +
          `             If a declaration exists in one of those files and was still not read, the\n` +
          `             scoping is at fault, not the declaration — check the checkout's fetch-depth.`,
      );
    }
    console.error(
      "[trap-growth] REFUSING baseline push — an uncatchable-trap category grew vs the previous baseline.\n" +
        "This is a main-side trap-mode regression: baking it in would silently raise the #3189 ratchet\n" +
        "floor (and park innocent PRs on the flap). Fix the regression on main, or — for an INTENTIONAL\n" +
        "reclassification — declare a bounded trap-growth-allow in the oracle-bump issue, or use\n" +
        "BASELINE_TRAP_GROWTH_ALLOW only as an emergency one-cycle valve. See #3370/#3335.",
    );
    // (#3487) Surface the freeze immediately. A trap-gate refusal FROZE the
    // landing-page baseline for ~7h on 2026-07-19/20, invisible because a
    // low-velocity freeze (~4-6 merges) stays under the 25-commit
    // baseline-floor-staleness-alert threshold. Emit a loud alert (best-effort;
    // never changes the exit-1 behavior below) so a human acknowledges within
    // one push. Alert-only — deliberately NOT auto-force-heal: a forced refresh
    // bypasses this gate and would re-legalize the very growth it refused.
    await sendBaselineFreezeAlert(growth.failures);
    process.exit(1);
  }
  console.log("[trap-growth] OK — no trap-category growth beyond tolerance.");
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split("/").pop()!);
if (isDirectRun) await main();
