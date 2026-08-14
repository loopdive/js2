// Shared open-PR issue-file scan (#3598).
//
// Extracted verbatim from `claim-issue.mjs`'s `idsFromOpenPRs` (#2943 hardening)
// so BOTH consumers share one implementation instead of two drifting copies:
//
//   - `claim-issue.mjs --allocate` needs the set of ids in flight, to reserve
//     an id nothing else has taken.
//   - `check-issue-ids.mjs --against-open-prs` (#3598) needs the (PR number →
//     issue-file path) mapping, so a collision can NAME the PR it raced.
//
// Returning paths-per-PR serves both: ids are derivable from paths, the reverse
// is not. That asymmetry is why the shared primitive is the richer one.
//
// #2943 hardening, preserved exactly — the original fanned out 1 + N gh calls,
// making EVERY open PR an independent, silently-swallowed failure point. Under
// rate-limit/contention a dropped call narrowed the id universe with NO signal
// (2026-07-02: --allocate returned 2920 while open PR #2424 already added
// plan/issues/2920-*.md). So:
//   - ONE batched GraphQL query (100 PRs × 100 files per page, paginated);
//   - a per-PR REST `--paginate` fallback for the rare >100-file PR
//     (`gh pr view --json files` silently truncates at 100 — a latent miss);
//   - 3× retry with backoff, and on total failure `complete: false` so the
//     caller WARNS LOUDLY instead of proceeding silently.
// Still fail-OPEN by design (offline/unauthenticated use keeps working), but
// never fail-SILENT.

import { execFileSync } from "node:child_process";

export const ISSUE_ID_RE = /(?:^|\/)plan\/issues\/(\d+)[a-z]?-[^/]*\.md$/;

const PR_SCAN_CALL_TIMEOUT_MS = Number(process.env.CLAIM_PR_SCAN_CALL_TIMEOUT_MS) || 12000;
const PR_SCAN_TOTAL_TIMEOUT_MS = Number(process.env.CLAIM_PR_SCAN_TOTAL_TIMEOUT_MS) || 25000;

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const PR_FILES_QUERY = `query($owner:String!,$name:String!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequests(states:OPEN,first:100,after:$cursor){
      pageInfo{hasNextPage endCursor}
      nodes{number files(first:100){pageInfo{hasNextPage} nodes{path changeType}}}
    }
  }
}`;

/**
 * Filter a PR's changed-file nodes (`{ path, changeType }`) down to the
 * issue-file paths that will EXIST at that PR's head.
 *
 * DELETED entries are excluded — this is the #3598 rename-hazard fix, the top
 * remaining false-positive source: a *detected* rename lists only the new path,
 * but an UNdetected one (similarity too low) appears as ADDED-new + DELETED-old,
 * so without this filter a PR that renumbered AWAY from a contested id still
 * reads as claiming it. Same reasoning covers genuine deletions (a withdrawn
 * issue file no longer claims its id). Pure — hermetically testable.
 */
export function liveIssuePaths(fileNodes) {
  const hits = [];
  for (const f of fileNodes || []) {
    const path = String(f?.path || "").trim();
    if (!path || f?.changeType === "DELETED") continue;
    if (ISSUE_ID_RE.test(path)) hits.push(path);
  }
  return hits;
}

/**
 * Scan every OPEN PR for `plan/issues/<id>-<slug>.md` paths.
 *
 * @returns {{ byPr: Map<number, string[]>, complete: boolean }}
 *   `byPr` maps PR number → the issue-file paths that PR touches.
 *   `complete: false` means the scan failed/timed out and the result is a
 *   FLOOR, not the truth — callers must degrade loudly, never silently.
 */
export function openPrIssueFiles({ repo = process.env.CLAIM_PR_REPO || "loopdive/js2wasm" } = {}) {
  const [owner, name] = repo.split("/");
  const deadline = Date.now() + PR_SCAN_TOTAL_TIMEOUT_MS;
  const ghBounded = (args) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      const e = new Error("open-PR scan budget exhausted");
      e.scanBudgetExhausted = true;
      throw e;
    }
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: Math.min(PR_SCAN_CALL_TIMEOUT_MS, remaining),
      killSignal: "SIGKILL",
    });
  };
  let budgetExhausted = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (Date.now() >= deadline) {
      budgetExhausted = true;
      break;
    }
    try {
      const byPr = new Map();
      const bigPRs = [];
      let cursor = null;
      for (;;) {
        const args = ["api", "graphql", "-f", `query=${PR_FILES_QUERY}`, "-F", `owner=${owner}`, "-F", `name=${name}`];
        if (cursor) args.push("-F", `cursor=${cursor}`);
        const raw = ghBounded(args);
        const prs = JSON.parse(raw)?.data?.repository?.pullRequests;
        if (!prs) throw new Error("unexpected GraphQL shape");
        for (const pr of prs.nodes || []) {
          const hits = liveIssuePaths(pr.files?.nodes);
          if (hits.length) byPr.set(pr.number, hits);
          if (pr.files?.pageInfo?.hasNextPage) bigPRs.push(pr.number);
        }
        if (!prs.pageInfo?.hasNextPage) break;
        cursor = prs.pageInfo.endCursor;
      }
      // >100-file PRs: full file list via REST pagination (the GraphQL page
      // truncated, so whatever we collected above for this PR is incomplete).
      // Same DELETED filter as liveIssuePaths — REST spells it status:"removed".
      for (const n of bigPRs) {
        const raw = ghBounded([
          "api",
          `repos/${repo}/pulls/${n}/files`,
          "--paginate",
          "--jq",
          '.[] | select(.status != "removed") | .filename',
        ]);
        // (#3636) UNION with the GraphQL first page — never REPLACE it. This
        // used to `set` outright, so the first page's ids were DISCARDED the
        // moment the fallback engaged. In practice `--paginate` returns a
        // superset and has hidden the bug, but any PARTIAL REST result silently
        // narrows the id universe, and both failure modes are invisible: a
        // narrower universe just looks like a free id.
        //
        // The asymmetry is the whole argument. Over-including an id wastes a
        // number; under-including one hands out an id another open PR already
        // uses, and that is only caught in the `merge_group`. So the id universe
        // must only ever GROW. (Same principle as the claim-heldness predicate
        // in #3880 — fail toward over-inclusion, never toward under-inclusion.)
        const hits = new Set(byPr.get(n) || []);
        for (const p of raw.split("\n")) {
          const t = p.trim();
          if (ISSUE_ID_RE.test(t)) hits.add(t);
        }
        if (hits.size) byPr.set(n, [...hits]);
        else byPr.delete(n);
      }
      return { byPr, complete: true };
    } catch (e) {
      if (e && e.scanBudgetExhausted) {
        budgetExhausted = true;
        break;
      }
      const backoff = Math.min(attempt * 1000, Math.max(0, deadline - Date.now()));
      if (attempt < 3 && backoff > 0) sleepMs(backoff);
    }
  }
  return { byPr: new Map(), complete: false, budgetExhausted };
}

/** Ids (numbers) added by currently-open PRs — the `claim-issue.mjs` view. */
export function openPrIssueIds(opts) {
  const { byPr, complete, budgetExhausted } = openPrIssueFiles(opts);
  const ids = new Set();
  for (const paths of byPr.values()) {
    for (const p of paths) {
      const m = p.match(ISSUE_ID_RE);
      if (m) ids.add(Number(m[1]));
    }
  }
  return { ids, complete, budgetExhausted, scanTotalTimeoutMs: PR_SCAN_TOTAL_TIMEOUT_MS };
}

/**
 * Filename-id of an issue-file path: "…/3597-x.md" → "3597", "…/779a-y.md" →
 * "779a". Sub-issues (779a, 779b, …) are distinct ids by convention (see
 * check-issue-ids.mjs filenameId) — a sub-issue never collides with its parent.
 */
export function issueFileId(path) {
  const fname = String(path).split("/").pop() || "";
  return fname.match(/^(\d+[a-z]?)-/i)?.[1]?.toLowerCase() ?? null;
}

/**
 * Pure collision verdict for the #3598 PR-level gate (no network — the scan
 * result is injected, so tests are hermetic).
 *
 * @param introduced [{ id, fname }] — issue files this branch ADDS (present at
 *   HEAD, absent at the merge-base with main). `id` is the filename-id.
 * @param byPr Map<prNumber, paths[]> — from openPrIssueFiles().
 * @param selfPr the PR under validation — excluded, or every PR would collide
 *   with itself.
 *
 * A collision is the SAME id under a DIFFERENT filename in ANOTHER open PR.
 * Same id + same filename is two PRs touching one issue file — a modification,
 * NOT a collision (an id-only comparison flagged five innocent PRs when this
 * was first attempted — see #3598 ## Handover).
 */
export function findOpenPrCollisions(introduced, byPr, { selfPr = null } = {}) {
  const collisions = [];
  for (const [prNumber, paths] of byPr) {
    if (selfPr != null && Number(prNumber) === Number(selfPr)) continue;
    for (const p of paths) {
      const otherId = issueFileId(p);
      if (!otherId) continue;
      const otherFname = String(p).split("/").pop();
      for (const { id, fname } of introduced) {
        if (String(id).toLowerCase() === otherId && fname !== otherFname) {
          collisions.push({ id: otherId, fname, prNumber: Number(prNumber), otherPath: p });
        }
      }
    }
  }
  return collisions.sort((a, b) => parseInt(a.id, 10) - parseInt(b.id, 10) || a.prNumber - b.prNumber);
}
