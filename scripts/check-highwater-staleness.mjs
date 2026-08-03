#!/usr/bin/env node
// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// #3953 — make a STALE #2097 standalone high-water mark LOUD.
//
// Why this exists (the shape of the bug it detects):
//   The #2097 mark is a raise-only floor. When it falls behind reality, the
//   #2097 gate still reports "passed" — it is just protecting a level far below
//   the current pass count. **A floor that is too LOW never fires.** So the
//   failure is completely silent in the permissive direction, and the only way
//   to see it is to look for the mark FAILING TO MOVE, which nothing did.
//
//   Measured 2026-08-02, the state this detector is built against:
//     mark  = 26546  (generated_at 2026-08-02T12:14:07Z)
//     current (merge_group) = 27021
//     floor = 26546 − 50 = 26496
//   → standalone conformance could have dropped **525 passes** before #2097
//     fired, while every run reported green. 4.3h and 37 merge commits stale.
//
// Two defects in series produced that, and only the first was fixed:
//   1. #3611 — `promote-baseline` was SKIPPED on the HIT path, so the raise
//      never ran at all. FIXED (verified: the raise now executes, run
//      30756312728 / job 91518979710, "raised host-free mark 26546 → 27019").
//   2. #3953 (this) — the raise now runs and writes the file, but the main-repo
//      commit CARRYING it is dropped by the #1951 non-empty-merge-queue
//      deferral. The deferral names `baseline-summary-sync.yml` as the fallback
//      — and that workflow did not stage the high-water file at all (grep
//      "highwater" → 0 hits), so the mark was load-bearing on the queue
//      happening to be empty at promote time.
//
// THE THIRD STATE IS THE POINT. A detector that cannot see must not render as
// "fresh" — that is the same false-empty that made the original bug invisible.
// An unreadable/absent/garbled mark, an unreadable current measurement, or a
// mark with no parseable `generated_at` all resolve to UNKNOWN and exit LOUD.
//
// Usage:
//   node scripts/check-highwater-staleness.mjs --current <N> [--max-age-hours H]
//   node scripts/check-highwater-staleness.mjs --report <merged-standalone-report.json>
//   ... [--mark <path>] [--annotate] [--now <iso>] [--json]
//
// Exit codes:
//   0 — FRESH   (mark tracks reality, or the gap is younger than the grace)
//   1 — STALE   (current exceeds the mark by > tolerance AND the mark is old)
//   2 — UNKNOWN (cannot determine — LOUD, never treated as fresh)

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");
export const DEFAULT_MARK_PATH = resolve(REPO_ROOT, "benchmarks/results/test262-standalone-highwater.json");

/** Default grace: the mark may lag reality for this long before it is a breach. */
export const DEFAULT_MAX_AGE_HOURS = 3;
/** Fallback tolerance when the mark itself does not carry one. */
export const DEFAULT_TOLERANCE = 50;

export const FRESH = "FRESH";
export const STALE = "STALE";
export const UNKNOWN = "UNKNOWN";

/**
 * Classify the mark against a current measurement. PURE — all I/O is done by
 * the caller so this is directly testable (and positive-controllable) without
 * touching the filesystem or the clock.
 *
 * @param {object|null|undefined} mark parsed high-water JSON, or null/undefined if unreadable
 * @param {number|null|undefined} current current host-free standalone pass count
 * @param {{maxAgeHours?: number, now?: Date}} [opts]
 * @returns {{state: string, reason: string, mark: number|null, current: number|null,
 *            floor: number|null, excess: number|null, headroom: number|null,
 *            ageHours: number|null, tolerance: number|null}}
 */
export function classify(mark, current, opts = {}) {
  const maxAgeHours = opts.maxAgeHours ?? DEFAULT_MAX_AGE_HOURS;
  const now = opts.now ?? new Date();
  const base = {
    state: UNKNOWN,
    reason: "",
    mark: null,
    current: null,
    floor: null,
    excess: null,
    headroom: null,
    ageHours: null,
    tolerance: null,
  };

  // --- Third state, branch 1: the mark cannot be read. -----------------------
  // Absent, unparseable, or carrying no numeric host-free count. Explicitly NOT
  // "fresh": we have no idea what floor is in force, which is strictly worse
  // than knowing it is stale.
  if (mark === null || mark === undefined || typeof mark !== "object") {
    return { ...base, reason: "high-water mark file is missing or unreadable" };
  }
  const markPass = mark.host_free_pass ?? mark.pass;
  if (typeof markPass !== "number" || !Number.isFinite(markPass)) {
    return { ...base, reason: "high-water mark carries no numeric host_free_pass/pass" };
  }

  // --- Third state, branch 2: the current measurement cannot be read. --------
  if (typeof current !== "number" || !Number.isFinite(current)) {
    return { ...base, mark: markPass, reason: "current standalone pass count is missing or unreadable" };
  }

  const tolerance = typeof mark.tolerance === "number" ? mark.tolerance : DEFAULT_TOLERANCE;
  const floor = markPass - tolerance;
  const excess = current - markPass;
  // The silent permissive gap: how far conformance could fall from where it
  // actually is before the #2097 gate would fire.
  const headroom = current - floor;
  const withNumbers = { ...base, mark: markPass, current, floor, excess, headroom, tolerance };

  // --- Third state, branch 3: the mark cannot be AGED. ----------------------
  // (#3988 lesson, applied) Freshness is judged on the artifact's OWN
  // `generated_at`, never on sha-equality with the revision that measured it —
  // main always advances underneath a long promote, so a sha check would defer
  // 100% of the time and report "fresh" forever.
  const generatedAt = mark.generated_at;
  const ts = generatedAt ? Date.parse(generatedAt) : Number.NaN;
  if (!Number.isFinite(ts)) {
    return {
      ...withNumbers,
      reason: "high-water mark has no parseable `generated_at` — cannot determine its age",
    };
  }
  const ageHours = (now.getTime() - ts) / 3_600_000;
  const sized = { ...withNumbers, ageHours };

  // --- Determinate states ---------------------------------------------------
  // A mark BELOW current by no more than the tolerance is doing its job: the
  // gate's floor still tracks reality closely. Only a gap wider than the
  // tolerance represents headroom a regression could hide in.
  if (excess <= tolerance) {
    return { ...sized, state: FRESH, reason: `mark tracks current (excess ${excess} ≤ tolerance ${tolerance})` };
  }
  // A wide gap that is BRAND NEW is normal: a merge just improved conformance
  // and the promote has not landed yet. Only a wide gap that PERSISTS is the
  // defect — that is the "fails to move" signature.
  if (ageHours < maxAgeHours) {
    return {
      ...sized,
      state: FRESH,
      reason: `mark is ${excess} behind but only ${ageHours.toFixed(1)}h old (grace ${maxAgeHours}h) — a promote is likely in flight`,
    };
  }
  return {
    ...sized,
    state: STALE,
    reason:
      `mark ${markPass} is ${excess} behind current ${current} and ${ageHours.toFixed(1)}h old ` +
      `(grace ${maxAgeHours}h) — the #2097 floor is ${floor}, so standalone conformance could drop ` +
      `${headroom} passes before the gate fires`,
  };
}

/** Read + parse the mark, returning null on ANY failure (→ UNKNOWN upstream). */
export function loadMark(path) {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/** Read the current host-free standalone pass count from a merged report. */
export function currentFromReport(path) {
  try {
    const r = JSON.parse(readFileSync(resolve(path), "utf-8"));
    const v = r?.full_summary?.host_free_pass ?? r?.summary?.host_free_pass;
    return typeof v === "number" ? v : null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const args = {
    current: undefined,
    report: undefined,
    mark: DEFAULT_MARK_PATH,
    maxAgeHours: DEFAULT_MAX_AGE_HOURS,
    annotate: false,
    json: false,
    now: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--current") args.current = Number(argv[++i]);
    else if (a === "--report") args.report = argv[++i];
    else if (a === "--mark") args.mark = argv[++i];
    else if (a === "--max-age-hours") args.maxAgeHours = Number(argv[++i]);
    else if (a === "--now") args.now = new Date(argv[++i]);
    else if (a === "--annotate") args.annotate = true;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log(
        "Usage: node scripts/check-highwater-staleness.mjs (--current <N> | --report <r.json>) " +
          "[--mark <path>] [--max-age-hours H] [--annotate] [--json]\n" +
          "Exit: 0 FRESH · 1 STALE · 2 UNKNOWN (loud — never green)",
      );
      process.exit(0);
    }
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mark = loadMark(args.mark);
  const current = Number.isFinite(args.current) ? args.current : args.report ? currentFromReport(args.report) : null;

  const r = classify(mark, current, { maxAgeHours: args.maxAgeHours, now: args.now });

  if (args.json) {
    console.log(JSON.stringify(r, null, 2));
  } else {
    console.log(
      `[highwater-staleness] ${r.state}: ${r.reason}` +
        (r.mark !== null ? ` (mark=${r.mark}, current=${r.current ?? "?"}, floor=${r.floor ?? "?"})` : ""),
    );
  }

  if (args.annotate) {
    // UNKNOWN is annotated as an ERROR, not a warning: "I cannot see" must be
    // at least as loud as "I see a problem". Rendering it quietly is the exact
    // false-empty this detector exists to prevent.
    if (r.state === UNKNOWN) console.log(`::error title=High-water mark: CANNOT DETERMINE::${r.reason}`);
    else if (r.state === STALE) console.log(`::error title=High-water mark is STALE::${r.reason}`);
  }

  process.exit(r.state === FRESH ? 0 : r.state === STALE ? 1 : 2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
