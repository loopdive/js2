#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3459 — Compute the test262 baseline "clock age" in whole minutes, guaranteed
// NON-NEGATIVE, from a single documented clock source and epoch unit.
//
// Background / the bug this fixes:
//   The baseline-drift/staleness check in test262-sharded.yml printed a
//   NEGATIVE clock age ("-43m clock age") during a merge_group re-validation.
//   The age was computed inline as `(MAIN_HEAD_TS - BASELINE_TS) / 60`, where:
//     • MAIN_HEAD_TS = git `%ct` (committer timestamp) of THIS checkout's main
//       HEAD commit.
//     • BASELINE_TS  = git `%ct` of the loopdive/js2wasm-baselines repo HEAD
//       commit — the baseline JSONL being diffed against.
//   Both are Unix epoch SECONDS, so the epoch UNIT already matched. The defect
//   is a clock-SOURCE mismatch: the baselines-repo commit is produced by the
//   `promote-baseline` job AFTER the main commit it was generated from, and —
//   during a merge_group run — the baseline can reflect a NEWER main state than
//   this speculative checkout's `origin/main` (main advanced while the group was
//   queued). So `MAIN_HEAD_TS - BASELINE_TS` is frequently negative, which is
//   nonsensical as an "age" and misreports the staleness signal.
//
// Semantics (documented, single source):
//   ageMinutes answers "how many whole minutes OLDER than this checkout's main
//   HEAD is the baseline" (i.e. staleness). Inputs are git `%ct` committer
//   timestamps in Unix epoch SECONDS. A raw difference < 0 means the baseline is
//   FRESHER than this checkout's main HEAD (baseline is AHEAD) → it is NOT stale
//   → the age is clamped to 0 and `baselineAhead` is flagged so the caller can
//   log the honest reason instead of a bogus negative number. Invalid / missing
//   timestamps (<= 0 or non-numeric) yield age 0 with `valid: false`.
//
// Usage:
//   node scripts/baseline-clock-age.mjs <MAIN_HEAD_TS> <BASELINE_TS>
//     → prints the clamped non-negative minute count to stdout (for
//       `DIFF_M=$(node scripts/baseline-clock-age.mjs "$MAIN_HEAD_TS" "$BASELINE_TS")`).
//   node scripts/baseline-clock-age.mjs <MAIN_HEAD_TS> <BASELINE_TS> --json
//     → prints { ageMinutes, rawMinutes, baselineAhead, valid } for tooling.
//   Flags may also be given as --main-head-ts <n> / --baseline-ts <n>.

/**
 * Compute the baseline clock age in whole minutes, clamped to be non-negative.
 * Pure + exported for unit testing — no I/O, no process.exit.
 *
 * @param {number|string} mainHeadTs  git `%ct` of the checkout's main HEAD (Unix seconds)
 * @param {number|string} baselineTs  git `%ct` of the baselines-repo HEAD (Unix seconds)
 * @returns {{ ageMinutes: number; rawMinutes: number; baselineAhead: boolean; valid: boolean }}
 *   ageMinutes    — whole minutes, always >= 0 (the value to print/gate on).
 *   rawMinutes    — the un-clamped signed difference (negative ⇒ baseline ahead);
 *                   diagnostic only.
 *   baselineAhead — true when the baseline is fresher than this checkout's main
 *                   HEAD (rawMinutes < 0); not stale.
 *   valid         — false when either timestamp is missing / non-positive /
 *                   non-numeric (age forced to 0).
 */
export function computeClockAge(mainHeadTs, baselineTs) {
  const main = Number(mainHeadTs);
  const base = Number(baselineTs);
  const valid = Number.isFinite(main) && Number.isFinite(base) && main > 0 && base > 0;
  if (!valid) {
    return { ageMinutes: 0, rawMinutes: 0, baselineAhead: false, valid: false };
  }
  // Both timestamps are Unix epoch SECONDS (git %ct). Truncate toward zero so a
  // partial minute never rounds a fresh baseline up to "1m stale".
  const rawMinutes = Math.trunc((main - base) / 60);
  const baselineAhead = rawMinutes < 0;
  const ageMinutes = baselineAhead ? 0 : rawMinutes;
  return { ageMinutes, rawMinutes, baselineAhead, valid };
}

function parsePositionalAndFlags(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function main() {
  const { positional, flags } = parsePositionalAndFlags(process.argv.slice(2));
  const mainHeadTs = flags["main-head-ts"] ?? positional[0] ?? "0";
  const baselineTs = flags["baseline-ts"] ?? positional[1] ?? "0";

  const result = computeClockAge(mainHeadTs, baselineTs);

  if (flags.json === "true") {
    console.log(JSON.stringify(result));
    return;
  }

  if (result.baselineAhead) {
    // Honest note (stderr, so stdout stays a clean integer for `$(...)`): a
    // fresher-than-main-HEAD baseline is expected on merge_group runs.
    console.error(
      `#3459 baseline is FRESHER than this checkout's main HEAD by ${Math.abs(result.rawMinutes)}m ` +
        `(baseline commit newer than main HEAD commit) — reporting clock age 0 (not stale).`,
    );
  }
  console.log(String(result.ageMinutes));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
