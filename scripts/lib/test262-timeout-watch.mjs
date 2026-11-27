// #7537 — how a test262 row that stopped at `compile_timeout` is judged
// (owner decision 2026-11-27): a first pass -> compile_timeout is not an
// immediate regression. It is listed and watched; only a REPEAT in the next
// measurement on the same first-parent lineage counts, and that repeat is
// charged to the PRs where the timeout first appeared, never to the change
// being measured now (otherwise P1 merges on a free first timeout and every
// later group, whose base is P1's measurement, is parked).
//
// One module so the IR queue gate (test262-edition-scope.ts) and the legacy
// completed-edition check (test262-edition-ratchet.ts) judge rows alike.

/** Measured under a raised compile timeout because it is watched (section 3 of #7537). */
export const RECHECK_COMPILE_TIMEOUT_MS = 60_000;

/**
 * Most rows one measurement re-checks. Re-checks run serially on one worker,
 * so a real break of many rows would otherwise hold the merge-queue head for
 * hours; above this many candidates the verdict stands without a re-check.
 */
export const RECHECK_MAX_ROWS = 50;

/**
 * The `sourceSha` of a baseline built from the completed rule alone: there was
 * no earlier measurement, so every row of a completed edition counts as passing
 * but its exceptions.
 */
export const COMPLETED_RULE_SHA = "completed-rule";

/** A passing row that now stops at compile_timeout: listed, never gated on first sight. */
export function isListedTimeout(was, now) {
  return was === "pass" && now === "compile_timeout";
}

/**
 * @typedef {{ file: string, firstSeenSha: string, prs: number[] }} WatchEntry
 * @typedef {"pass" | "improvement" | "unchanged" | "listed" | "recheck" | "resolved" | "flake" | "regression" | "confirmedRepeat"} Outcome
 */

/**
 * One row's verdict.
 *
 * A watched row keeps the `pass` its baseline had before the timeout hid it, for
 * exactly one more measurement: that is what makes "repeated" mean two
 * consecutive measurements, and what stops a watched row that now fails from
 * dropping out of the comparison as "was not passing".
 *
 * @param {string} was             the baseline's status (the caller handles rows the baseline lacks)
 * @param {boolean} watched         on the baseline's watch list
 * @param {string} now              this measurement's status
 * @param {boolean} rechecked       this row's status comes from the re-check
 * @returns {Outcome}
 */
export function classifyRow(was, watched, now, rechecked) {
  if (!watched && was !== "pass") return now === "pass" ? "improvement" : "unchanged";
  // A re-checked row that passes was a flake of the shard run, watched or not.
  if (now === "pass") return rechecked ? "flake" : watched ? "resolved" : "pass";
  if (!watched) return isListedTimeout(was, now) ? "listed" : "regression";
  // The timeout already hid this row's result where it first appeared, so a
  // failure now cannot be told apart from the original change: it is a repeat.
  if (now === "compile_timeout" && !rechecked) return "recheck";
  return "confirmedRepeat";
}

/**
 * The next measurement's watch list: new first sightings carry this
 * measurement's commit and PR set; watched rows that are still in question keep
 * their origin; resolved and confirmed rows leave the list.
 *
 * @param {ReadonlyMap<string, WatchEntry>} watch
 * @param {ReadonlyMap<string, Outcome>} outcomes
 * @param {{ sha: string, prs: number[] }} origin
 * @returns {WatchEntry[]}
 */
export function nextWatch(watch, outcomes, origin) {
  const out = [];
  for (const [file, outcome] of outcomes) {
    if (outcome === "listed") out.push({ file, firstSeenSha: origin.sha, prs: origin.prs });
    else if ((outcome === "flake" || outcome === "recheck") && watch.has(file)) out.push(watch.get(file));
  }
  return out.sort((a, b) => a.file.localeCompare(b.file));
}

/** @param {unknown} data  a `timeout-watch.json` document, or undefined @returns {Map<string, WatchEntry>} */
export function readWatch(data) {
  const entries = /** @type {{ watch?: WatchEntry[] } | undefined} */ (data)?.watch ?? [];
  return new Map(entries.map((e) => [e.file, e]));
}
