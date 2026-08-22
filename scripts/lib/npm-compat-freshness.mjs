// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#4604 S3) Staleness verdict for the committed npm-compat artifact.
//
// The 2026-08-20/21 episode ran >24h before anyone noticed: every refresh run
// died before promotion, the committed artifact silently kept serving a
// regression that was already fixed on main, and the only detector was a
// manual audit. Nothing in CI asserted "the dashboard's data is recent" —
// every gate was about a run's own success, and a run that never publishes
// fails those gates invisibly (cancelled/superseded runs don't even alert).
//
// This module is the pure verdict; the scheduled workflow
// (.github/workflows/npm-compat-staleness.yml) turns a STALE verdict into a
// red run. Kept pure and time-injected so the boundary cases are testable.

/** Default alarm threshold. The refresh runs per push plus a 6h cron, and a
 * healthy promotion adds ~1–2h of merge-queue latency, so a quiet weekend
 * legitimately reaches ~8h. 12h is unreachable while the pipeline works —
 * exactly the #4604 episode's signature. */
export const DEFAULT_MAX_AGE_HOURS = 12;

/**
 * Judge the committed artifact's freshness.
 *
 * @param {string|undefined} rawJson  file contents, or undefined if unreadable
 * @param {{ nowMs: number, maxAgeHours?: number }} opts
 * @returns {{ fresh: boolean, reason: string, ageHours?: number }}
 *
 * An unreadable/malformed artifact or missing `generatedAt` is STALE, not an
 * error state: the guard's one job is "is the dashboard provably recent", and
 * anything short of a parseable recent timestamp is the alarm condition.
 */
export function judgeNpmCompatFreshness(rawJson, { nowMs, maxAgeHours = DEFAULT_MAX_AGE_HOURS }) {
  if (typeof rawJson !== "string" || rawJson.length === 0) {
    return { fresh: false, reason: "artifact missing or unreadable" };
  }
  let generatedAt;
  try {
    generatedAt = JSON.parse(rawJson)?.generatedAt;
  } catch {
    return { fresh: false, reason: "artifact is not valid JSON" };
  }
  const generatedMs = Date.parse(generatedAt ?? "");
  if (Number.isNaN(generatedMs)) {
    return { fresh: false, reason: `generatedAt missing or unparseable (${JSON.stringify(generatedAt)})` };
  }
  const ageHours = (nowMs - generatedMs) / 3_600_000;
  // A future timestamp is a clock or generator bug, not freshness — flag it.
  if (ageHours < -1) {
    return { fresh: false, reason: `generatedAt is ${(-ageHours).toFixed(1)}h in the future`, ageHours };
  }
  if (ageHours > maxAgeHours) {
    return {
      fresh: false,
      reason: `artifact is ${ageHours.toFixed(1)}h old (threshold ${maxAgeHours}h)`,
      ageHours,
    };
  }
  return { fresh: true, reason: `artifact is ${ageHours.toFixed(1)}h old (threshold ${maxAgeHours}h)`, ageHours };
}
