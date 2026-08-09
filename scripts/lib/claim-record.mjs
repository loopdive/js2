// scripts/lib/claim-record.mjs (#3880)
//
// ONE definition of "is this issue currently claimed", shared by every reader of
// the orphan `issue-assignments` ref. Before this existed there were two, and
// both were wrong in the same direction:
//
//   claim-issue.mjs      `assignee && status !== "released"`
//   pre-dispatch-gate.mjs `assignee`                          (status ignored entirely)
//
// `--complete` writes `status: "done"`, so under the first rule every completed
// issue stayed CLAIMED forever; under the second, every *released* one did too.
// Measured on the live ref on 2026-07-31 (1,080 entries): 359 `in-progress`,
// 315 `reserved`, 294 `done`, 109 `released`. So `claim-issue.mjs --list`
// reported 654 "active" claims of which 294 were phantoms (45 %), and the
// dispatch gate over-held on all 403 terminal records.
//
// That is not a cosmetic count. It made real dispatch decisions wrong the same
// day: #2916 looked like "a claim nobody held" (costing a routing decision and a
// hand-written STALE banner), #2046 read `in-progress` with three merged PRs
// behind it and an agent was dispatched onto it, and #3420 looked permanently
// claimed after its work merged. Each was re-diagnosed independently as "the
// claim ref is unreliable" — one operator in one predicate, re-derived all
// session without ever resolving to a mechanism. Hence: one definition, in one
// file, imported by both.

/**
 * The states in which a claim is FINISHED. Everything else counts as held.
 *
 * Deliberately a blacklist of terminal states rather than a whitelist of
 * `in-progress`, because the two mistakes are not symmetric:
 *
 *   - reading a FREE record as held    → blocks work. Annoying, safe.
 *   - reading a HELD record as free    → two agents on one issue. This is the
 *                                        duplicate dispatch the lock exists to
 *                                        prevent.
 *
 * A whitelist sends an unrecognised status down the dangerous path. Listing the
 * terminal states sends it down the safe one. The original bug was an
 * INCOMPLETE blacklist (it named `released` but not `done`), not the blacklist.
 */
export const TERMINAL_CLAIM_STATUSES = new Set(["released", "done"]);

/**
 * Is this parsed `<key>.json` record a live claim?
 *
 * A bare `--allocate` reservation carries no assignee: it reserves the id but
 * nobody is working on it, so it is not held. Id reservation is a separate
 * question and is answered by reading every record's `id` regardless of status.
 *
 * @param {{assignee?: string, status?: string} | null | undefined} entry
 * @returns {boolean}
 */
export function isHeldRecord(entry) {
  if (!entry || !entry.assignee) return false;
  return !TERMINAL_CLAIM_STATUSES.has(entry.status);
}
