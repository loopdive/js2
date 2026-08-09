// Copyright (c) 2026 Loopdive GmbH. Licensed under Apache-2.0 WITH LLVM-exception.
//
// (#3613) THE VACUOUS-VERIFIER GUARD.
//
// The problem this exists for
// ---------------------------
// A verifier that verifies NOTHING looks exactly like a verifier with nothing
// to verify. Both return zero. Nobody notices, because zero is also what
// success looks like.
//
// This is not hypothetical — it has bitten this repo twice in one week:
//
//   • #3601 park (2026-07-25). `trapInnermostFrame` parsed only the LOCAL
//     runner's frame grammar (`… in name() at source L…`). The CI worker
//     renders frames as `[in name() ← caller ← …]`, so EVERY CI trap row read
//     as frameless and the gate concluded "0 verified unmasked pre-existing
//     traps". The frames were present all along. A 100 %-unverifiable rate on
//     a non-empty population was the tell, and nothing was watching for it.
//   • 2026-07-25 vacuity audit. A throw-probe run on a pre-#3592 base reported
//     "43/43 vacuous". The probe itself had been compiled away, so the probe
//     never took effect on ANY file — a 100 %-inert rate, again indistinguish-
//     able from a 100 %-positive finding without a control.
//
// The rule
// --------
// When a checker returns "unverifiable" / "no evidence" / zero for **100 % of
// a non-empty input population**, that is far more likely to be a broken
// checker than a uniformly-clean population. Say so, LOUDLY, instead of
// returning a silent zero.
//
// This module is deliberately dependency-free and pure so it can be called
// from gates (scripts/diff-test262.ts), detectors
// (scripts/detect-vacuity.ts) and their unit tests alike.

/**
 * @typedef {object} VerifierCoverage
 * @property {string}  name        Checker name, e.g. "trapInnermostFrame".
 * @property {number}  population  Size of the non-empty input set it was asked about.
 * @property {number}  verified    How many inputs it could actually answer for.
 * @property {string}  [hint]      What a maintainer should check first (grammar drift, inert probe, …).
 */

/**
 * Minimum population below which a 100 %-unverifiable rate is not yet
 * evidence of a broken checker. One or two unparseable rows happen; a whole
 * population of them does not. Deliberately small — the #3601 gap would have
 * been caught at n = 3.
 */
export const VACUOUS_VERIFIER_MIN_POPULATION = 3;

/**
 * Is this checker vacuous over the given population?
 *
 * @param {VerifierCoverage} c
 * @returns {{ vacuous: boolean; message: string | null; rate: number }}
 */
export function checkVerifierCoverage(c) {
  const population = Math.max(0, c.population | 0);
  const verified = Math.max(0, c.verified | 0);
  const rate = population === 0 ? 1 : verified / population;
  if (population < VACUOUS_VERIFIER_MIN_POPULATION || verified > 0) {
    return { vacuous: false, message: null, rate };
  }
  const message =
    `=== VACUOUS VERIFIER (#3613): \`${c.name}\` answered for 0 of ${population} inputs — a 100 % ` +
    `unverifiable rate on a NON-EMPTY population. Treat this as a BROKEN CHECKER, not as a clean ` +
    `result: a verifier that verifies nothing is indistinguishable from one with nothing to verify. ` +
    (c.hint ? `First thing to check: ${c.hint}. ` : "") +
    `Precedent: the #3601 park read every CI trap row as frameless because the frame parser only ` +
    `knew the local runner's grammar — the evidence was there and the parser could not see it. ===`;
  return { vacuous: true, message, rate };
}

/**
 * Loud side-effecting variant: prints the banner to stderr and returns it so a
 * caller can also fold it into its own report/notes channel.
 *
 * @param {VerifierCoverage} c
 * @param {{ log?: (msg: string) => void }} [opts]
 * @returns {string | null} the warning, or null when the checker is fine
 */
export function warnIfVerifierVacuous(c, opts = {}) {
  const { vacuous, message } = checkVerifierCoverage(c);
  if (!vacuous || !message) return null;
  const log = opts.log ?? ((m) => console.error(m));
  log(message);
  return message;
}

/**
 * Throwing variant, for detectors whose entire OUTPUT would otherwise be the
 * silent zero (e.g. a vacuity probe that never took effect: reporting
 * "100 % vacuous" from an inert probe is worse than reporting nothing).
 *
 * @param {VerifierCoverage} c
 * @returns {void}
 * @throws {Error} when the checker is vacuous over the population
 */
export function assertVerifierNotVacuous(c) {
  const { vacuous, message } = checkVerifierCoverage(c);
  if (vacuous && message) throw new Error(message);
}

/**
 * The ergonomic form for the shape almost every gate in this repo has:
 * "run a predicate over a population and act on the ones it could answer for".
 * Doing the counting here means a caller cannot forget the guard — the warning
 * comes back in the same call that produces the filtered set.
 *
 * ```js
 * const { matched, warning } = guardedFilter(trapRows, (r) => frameOf(r) !== null, {
 *   name: "trapInnermostFrame",
 *   hint: "trap-message frame-grammar drift",
 * });
 * if (warning) notes.push(warning);   // loud, not silent
 * ```
 *
 * Applies to any gate that answers "how many of these can I verify?" —
 * baseline-row matchers, error classifiers, frame/stack parsers, allowance
 * validators, corpus scanners. If the answer is "none of a non-empty set", the
 * gate is far more likely broken than the input uniformly clean.
 *
 * @template T
 * @param {readonly T[]} population
 * @param {(item: T) => boolean} canVerify
 * @param {{ name: string; hint?: string; log?: (msg: string) => void; quiet?: boolean }} opts
 * @returns {{ matched: T[]; unmatched: T[]; warning: string | null; rate: number }}
 */
export function guardedFilter(population, canVerify, opts) {
  const matched = [];
  const unmatched = [];
  for (const item of population) (canVerify(item) ? matched : unmatched).push(item);
  const coverage = { name: opts.name, population: population.length, verified: matched.length, hint: opts.hint };
  const { message, rate } = checkVerifierCoverage(coverage);
  if (message && !opts.quiet) (opts.log ?? ((m) => console.error(m)))(message);
  return { matched, unmatched, warning: message, rate };
}
