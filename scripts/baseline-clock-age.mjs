#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3459 — Baseline drift/staleness "clock age" computation.
//
// The merge-shard-reports path of `.github/workflows/test262-sharded.yml`
// prints a baseline "clock age" (`${DIFF_M}m clock age`) in its drift/
// staleness footer. It was computed inline as
//
//     DIFF_M=$(( (MAIN_HEAD_TS - BASELINE_TS) / 60 ))
//
// which could go NEGATIVE (a `-43m clock age` was observed during the #3375
// merge_group triage). Root cause: the two operands are DIFFERENT clock
// sources with the same epoch unit but no ordering guarantee —
//
//   * MAIN_HEAD_TS  = git committer time (`git log -1 --format=%ct`, epoch
//                     SECONDS) of the `origin/main` HEAD commit.
//   * BASELINE_TS   = the wall-clock time (epoch SECONDS) at which the
//                     baselines-repo JSONL was generated/committed.
//
// The baseline is refreshed by `promote-baseline` AFTER a merge lands, so the
// baseline generation time is routinely LATER than the committer time of the
// main commit it reflects. That legitimately makes `BASELINE_TS > MAIN_HEAD_TS`
// → a negative raw difference. Semantically "age" is "how stale is the
// baseline relative to main HEAD"; a baseline that is fresher than main HEAD is
// not stale at all, so its age is 0, not a negative number.
//
// This module centralises the age computation on a SINGLE documented epoch
// unit (seconds) and CLAMPS the result to be non-negative, flagging the skew
// case so the CI log still records that the raw difference was negative.
//
// Usage (CLI, mirrors the inline bash it replaces):
//   node scripts/baseline-clock-age.mjs --main-ts <sec> --baseline-ts <sec>
//     → prints the clamped non-negative age in whole MINUTES to stdout.
//   add --json to print { ageMinutes, rawMinutes, clamped } instead.
//
// A skew (raw < 0) additionally emits a `::notice::` to stderr so the
// negative-input case is visible in the job log without corrupting the stdout
// value the workflow captures into DIFF_M.

const SECONDS_PER_MINUTE = 60;

/**
 * Compute the baseline "clock age" in whole minutes from two epoch-SECONDS
 * timestamps, clamped to be non-negative.
 *
 * @param {number} mainHeadTsSec  git committer time of origin/main HEAD (epoch seconds)
 * @param {number} baselineTsSec  baseline-generation wall-clock time (epoch seconds)
 * @returns {{ ageMinutes: number, rawMinutes: number, clamped: boolean }}
 *   ageMinutes  — clamped, never negative (the value CI should display)
 *   rawMinutes  — the un-clamped signed difference (negative under clock skew)
 *   clamped     — true when the raw difference was negative and got clamped to 0
 */
export function computeClockAgeMinutes(mainHeadTsSec, baselineTsSec) {
  const main = Number(mainHeadTsSec);
  const baseline = Number(baselineTsSec);

  // Missing / unparsable / sentinel-zero inputs → age is undetermined; report
  // 0 (the same conservative default the inline bash used when either ts was
  // "0"). Not a skew, so `clamped` stays false.
  if (!Number.isFinite(main) || !Number.isFinite(baseline) || main <= 0 || baseline <= 0) {
    return { ageMinutes: 0, rawMinutes: 0, clamped: false };
  }

  // Both operands are epoch SECONDS. Truncate toward zero to whole minutes,
  // matching the integer `/ 60` the bash arithmetic did.
  const rawMinutes = Math.trunc((main - baseline) / SECONDS_PER_MINUTE);
  const ageMinutes = Math.max(0, rawMinutes);
  return { ageMinutes, rawMinutes, clamped: rawMinutes < 0 };
}

function parseArgs(argv) {
  const args = { mainTs: undefined, baselineTs: undefined, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--main-ts") args.mainTs = argv[++i];
    else if (a === "--baseline-ts") args.baselineTs = argv[++i];
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: baseline-clock-age.mjs --main-ts <epoch-sec> --baseline-ts <epoch-sec> [--json]");
      process.exit(0);
    }
  }
  return args;
}

function main() {
  const { mainTs, baselineTs, json } = parseArgs(process.argv.slice(2));
  const result = computeClockAgeMinutes(mainTs ?? 0, baselineTs ?? 0);
  if (result.clamped) {
    // Surface the skew in the CI log without polluting the captured stdout.
    console.error(
      `::notice::[baseline-clock-age] baseline is fresher than main HEAD ` +
        `(raw age ${result.rawMinutes}m < 0 — clock skew: baseline generated ` +
        `after the main HEAD commit time). Reporting clamped age 0m.`,
    );
  }
  if (json) {
    console.log(JSON.stringify(result));
  } else {
    console.log(String(result.ageMinutes));
  }
}

// Only run the CLI when invoked directly, not when imported by tests.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}
