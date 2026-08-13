#!/usr/bin/env node
/**
 * Pre-dispatch gate — run BEFORE dispatching any agent on issue #N.
 *
 *   node scripts/pre-dispatch-gate.mjs 3571
 *   node scripts/pre-dispatch-gate.mjs 3571 --json
 *
 * Exit 0 = clear to dispatch. Exit 1 = STOP, a blocker was found.
 * Exit 2 = proceed with care (warnings only).
 *
 * WHY THIS EXISTS
 * ---------------
 * The gate used to be three hand-run commands (grep main, check open PRs,
 * check the claim ref). On 2026-07-25 all three PASSED for #3571 and the
 * dispatch was still wrong: #3603's "S1" slice is the same work, and another
 * lane was already on it. Two distinct blind spots:
 *
 *   1. SUBJECT OVERLAP. Work that lives as a *slice inside another issue* is
 *      invisible to an id-based check. #3571 ≈ #3603-S1 shares no id.
 *   2. IN-FLIGHT WORK. A lane that has started but not yet claimed or pushed
 *      leaves no trace in main, in open PRs, or in the claim ref.
 *
 * Plus a false positive that makes the old grep actively misleading:
 *
 *   3. PR NUMBERS AND ISSUE IDS SHARE ONE SEQUENCE. `git log --grep="#3571"`
 *      matches the merge commit of *PR* #3571, which reads as "issue already
 *      merged" when it is not.
 *
 * This script closes 1 and 3 mechanically, and surfaces 2 as far as it can be
 * surfaced. It cannot make 2 airtight — only claiming at dispatch time can.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
// (#4045/#4117) READ THE CLAIM LEDGER THROUGH claim-issue.mjs, NOT a raw
// `git show` of a remote-tracking ref.
//
// The old form named `origin/issue-assignments` directly, which is wrong twice
// over. `origin` is the FORK in agent worktrees, so it read a DIFFERENT
// reservation book from the one the Codex lane and CI's collision gate use —
// the split brain of #4045. And a remote-tracking ref is only as fresh as the
// last fetch, so even against the right book it could answer from an
// arbitrarily stale snapshot. Both failure modes point the same way: the gate
// that exists to prevent duplicate dispatch reports "unclaimed" for an issue
// somebody is holding.
//
// Delegating to `claim-issue.mjs --list --json` leaves ONE reader of the ledger
// (the choice budget-status.mjs already made), so book selection and freshness
// are fixed in one place and cannot drift apart again.
let _claimIndex;
function claimIndex() {
  if (_claimIndex) return _claimIndex;
  const script = path.join(path.dirname(new URL(import.meta.url).pathname), "claim-issue.mjs");
  const byKey = new Map();
  try {
    const out = execFileSync(process.execPath, [script, "--list", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    });
    for (const e of JSON.parse(out).held || []) {
      byKey.set(String(e.slice ? `${e.id}-${e.slice}` : e.id), e);
    }
    _claimIndex = { state: "ok", byKey };
  } catch (err) {
    // A FAILED read is not an empty one — say so, rather than reporting every
    // issue unclaimed, which is the silent-empty this whole family is about.
    _claimIndex = { state: "unreadable", byKey, error: String((err && err.message) || err).slice(0, 200) };
  }
  return _claimIndex;
}
/** Live claim record for `key`, or null. `state` says whether the read worked. */
function liveClaim(key) {
  const idx = claimIndex();
  return { state: idx.state, error: idx.error, entry: idx.byKey.get(String(key)) || null };
}

const ISSUES_DIR = "plan/issues";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const id = argv.find((a) => /^\d+$/.test(a));

if (!id) {
  console.error("usage: node scripts/pre-dispatch-gate.mjs <issue-id> [--json]");
  process.exit(1);
}

const sh = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
};

const blockers = [];
const warnings = [];
const notes = [];

// ── 1. Already merged? ────────────────────────────────────────────────────
// The issue FILE on main is the reliable signal. A --grep hit is not: it also
// matches "Merge pull request #N", i.e. PR #N, which is a different sequence
// sharing the same numbers.
const issueOnMain = sh("git", ["ls-tree", "-r", "--name-only", "origin/main", `${ISSUES_DIR}/`])
  .split("\n")
  .filter((f) => new RegExp(`^${ISSUES_DIR}/${id}-`).test(f));

if (issueOnMain.length) {
  const body = sh("git", ["show", `origin/main:${issueOnMain[0]}`]);
  const status = (body.match(/^status:\s*(\S+)/m) || [])[1] || "unknown";
  notes.push(`issue file on main: ${issueOnMain[0]} (status: ${status})`);
  if (status === "done" || status === "wont-fix") {
    blockers.push(`issue #${id} is already status: ${status} on main — do NOT re-implement`);
  }
} else {
  notes.push(`no ${ISSUES_DIR}/${id}-*.md on main (new or unlanded issue)`);
}

// Report grep hits, but classify them so a PR-merge commit is not mistaken
// for evidence the issue landed.
const grepHits = sh("git", ["log", "origin/main", "--oneline", `--grep=#${id}`, "-i", "-20"])
  .split("\n")
  .filter(Boolean);
const prMergeRe = new RegExp(`Merge pull request #${id}\\b`);
const realHits = grepHits.filter((l) => !prMergeRe.test(l));
const falseHits = grepHits.filter((l) => prMergeRe.test(l));
if (falseHits.length) {
  notes.push(
    `IGNORED ${falseHits.length} grep hit(s) that are PR #${id}'s own merge commit, not issue #${id} ` +
      `(PR numbers and issue ids share one sequence)`,
  );
}
if (realHits.length) {
  warnings.push(`${realHits.length} commit(s) on main mention #${id} — read them before starting:`);
  for (const h of realHits.slice(0, 5)) warnings.push(`    ${h}`);
}

// ── 2. Open PR touching the issue file? ───────────────────────────────────
const prJson = sh("gh", [
  "pr",
  "list",
  "-R",
  "loopdive/js2wasm",
  "--state",
  "open",
  "--limit",
  "60",
  "--json",
  "number,title,headRefName",
]);
if (prJson) {
  try {
    for (const pr of JSON.parse(prJson)) {
      if (new RegExp(`\\b${id}\\b`).test(`${pr.title} ${pr.headRefName}`)) {
        blockers.push(`open PR #${pr.number} appears to cover #${id}: ${pr.title}`);
      }
    }
  } catch {
    warnings.push("could not parse `gh pr list` output — check open PRs by hand");
  }
} else {
  warnings.push("`gh pr list` returned nothing — offline or unauthenticated; check open PRs by hand");
}

// ── 3. Claim ref ──────────────────────────────────────────────────────────
const claimRead = liveClaim(id);
if (claimRead.state === "unreadable") {
  // Deliberately a WARNING, not a silent "unclaimed": the caller must know the
  // gate could not see, because "no record" and "could not look" are the two
  // answers this family of bugs keeps conflating.
  warnings.push(`could not read the claim ledger (${claimRead.error}) — an unreadable ref is NOT an unclaimed one`);
}
if (claimRead.entry) {
  const c = claimRead.entry;
  // (#3880) Heldness comes from the SHARED predicate; `--list` already applies
  // it, so anything present here is a LIVE claim (a `done`/`released` record is
  // filtered out upstream and correctly reads as unclaimed).
  blockers.push(`#${id} is CLAIMED by ${c.assignee}${c.branch ? ` (branch ${c.branch})` : ""}`);
} else if (claimRead.state === "ok") {
  notes.push("no live claim on the ledger — unclaimed");
}

// ── 4. SUBJECT OVERLAP (the gap that let #3571 through) ───────────────────
// Any OTHER issue that references #N in its body may already own this work as
// a slice. An id-based gate cannot see that; a text scan can.
if (fs.existsSync(ISSUES_DIR)) {
  const ref = new RegExp(`#${id}\\b`);
  for (const f of fs.readdirSync(ISSUES_DIR).filter((n) => n.endsWith(".md"))) {
    if (new RegExp(`^${id}-`).test(f)) continue;
    let text;
    try {
      text = fs.readFileSync(path.join(ISSUES_DIR, f), "utf8");
    } catch {
      continue;
    }
    if (!ref.test(text)) continue;
    const status = (text.match(/^status:\s*(\S+)/m) || [])[1] || "unknown";
    const line = `${f} (status: ${status}) references #${id}`;
    if (status === "in-progress") {
      blockers.push(`ACTIVE overlap — ${line}. Another agent may already own this work as a slice.`);
    } else if (status === "ready") {
      warnings.push(`possible overlap — ${line}`);
    }
  }
}

// ── 5. IDIOM OVERLAP — the check that would have caught #3571 ─────────────
// Section 4 only sees issues that CITE #N. The #3571/#3603 duplication had no
// citation in either direction (#3603's `related:` omits 3571), yet #3603's S1
// heading was verbatim #3571's subject. So also match on title terms.
//
// A hand-picked stoplist was tried first and was useless — it flagged 8 issues
// on words like "bind" and "blocker", and a gate that always says STOP gets
// ignored. Instead weight terms by DOCUMENT FREQUENCY: a term in many issues
// carries no signal, a rare one does. This needs no curation and adapts as the
// corpus grows.
const localIssue = fs.existsSync(ISSUES_DIR)
  ? fs.readdirSync(ISSUES_DIR).find((n) => new RegExp(`^${id}-`).test(n))
  : undefined;

if (localIssue) {
  const files = fs.readdirSync(ISSUES_DIR).filter((n) => n.endsWith(".md"));
  const bodies = new Map();
  for (const f of files) {
    try {
      bodies.set(f, fs.readFileSync(path.join(ISSUES_DIR, f), "utf8").toLowerCase());
    } catch {
      /* unreadable — skip */
    }
  }

  const tok = (t) => new Set(t.split(/[^a-z0-9._]+/).filter((w) => w.length >= 4));
  const df = new Map();
  for (const text of bodies.values()) for (const w of tok(text)) df.set(w, (df.get(w) || 0) + 1);

  const raw = bodies.get(localIssue) || "";
  const title = ((raw.match(/^title:\s*"?(.+?)"?\s*$/m) || [])[1] || localIssue).toLowerCase();

  // Rare = appears in at most 1% of issues. Tuned so "uncurrythis"/"call.bind"
  // qualify while "bind", "apply", "blocker" do not.
  const RARE_MAX = Math.max(3, Math.ceil(bodies.size * 0.01));
  const terms = [...tok(title)].filter((w) => (df.get(w) || 0) <= RARE_MAX);

  if (terms.length >= 2) {
    notes.push(`idiom scan: distinctive terms [${terms.join(", ")}] (df <= ${RARE_MAX} of ${bodies.size})`);
    for (const [f, text] of bodies) {
      if (f === localIssue) continue;
      const hits = terms.filter((t) => text.includes(t));
      if (hits.length < 2) continue;
      const status = (text.match(/^status:\s*(\S+)/m) || [])[1] || "unknown";
      if (status === "done" || status === "wont-fix") continue;
      // An overlapping issue's OWN claim is the in-flight signal. #3603 sat at
      // `status: ready` while being actively worked under a claim — checking
      // only its status would have produced a warning, not a stop.
      const otherId = (f.match(/^(\d+)/) || [])[1];
      // (#4045/#4117) Same single ledger reader as the primary check above —
      // `--list` has already applied the shared heldness predicate, so a
      // FINISHED claim on an overlapping issue correctly reads as no signal.
      const claimedBy = otherId ? (liveClaim(otherId).entry || {}).assignee || "" : "";
      const line = `${f} (status: ${status}${claimedBy ? `, CLAIMED by ${claimedBy}` : ""}) shares [${hits.join(", ")}]`;
      if (status === "in-progress" || claimedBy) {
        blockers.push(`ACTIVE idiom overlap — ${line}. READ IT before dispatching.`);
      } else {
        warnings.push(`idiom overlap — ${line}`);
      }
    }
  } else {
    notes.push(`idiom scan: title has <2 distinctive terms (df <= ${RARE_MAX}) — scan skipped`);
  }
} else {
  notes.push(`no local ${ISSUES_DIR}/${id}-*.md — idiom scan skipped`);
}

// ── Report ────────────────────────────────────────────────────────────────
const verdict = blockers.length ? "STOP" : warnings.length ? "CAUTION" : "CLEAR";

if (json) {
  console.log(JSON.stringify({ id, verdict, blockers, warnings, notes }, null, 2));
} else {
  console.log(`\npre-dispatch gate — issue #${id}: ${verdict}\n`);
  for (const b of blockers) console.log(`  BLOCKER  ${b}`);
  for (const w of warnings) console.log(`  warn     ${w}`);
  for (const n of notes) console.log(`  note     ${n}`);
  console.log(
    `\n  REMAINING BLIND SPOT: a lane that has started but not yet claimed or pushed\n` +
      `  leaves NO trace anywhere this script can read. Claim at DISPATCH time\n` +
      `  (claim-issue.mjs <id> <agent> --branch <b>), not at first push, or this\n` +
      `  gate cannot protect the next dispatcher.\n`,
  );
}

process.exit(blockers.length ? 1 : warnings.length ? 2 : 0);
