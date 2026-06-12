#!/usr/bin/env node
// unstick-merge-queue.mjs — detect and clear a WEDGED merge-queue head.
//
// THE FAILURE MODE (observed 3× on 2026-06-10/11, and twice on 2026-05-30/31):
// the queue head entry sits in AWAITING_CHECKS, the synthetic
// gh-readonly-queue/main/pr-<N>-<sha> branch EXISTS, but GitHub never creates
// the merge_group workflow runs for it — the webhooks silently don't fire.
// Nothing times out for ~3h, then the entry is evicted and the next head often
// hits the same glitch. The overnight 2026-06-10 occurrence stalled all
// merges for 4 hours. The proven fix: dequeue + re-enqueue the head PR via
// GraphQL, which forces GitHub to rebuild the merge group; the rebuild
// reliably dispatches the runs. (A push to main also rebuilds groups, which is
// why an unrelated admin merge revived the queue at 03:23Z on 2026-06-11.)
//
// SURGICAL-NUDGE DISCIPLINE (#1758 lesson): poking the serial queue WHILE a
// merge group is mid-formation is what wedged the queue on 2026-05-30/31. A
// healthy forming group creates its workflow runs within ~1-2 minutes of the
// entry reaching the head. So this script only ever nudges when ALL of:
//   1. the head entry is AWAITING_CHECKS, AND
//   2. ZERO merge_group workflow runs (any status) exist for that PR created
//      at-or-after its enqueuedAt, AND
//   3. the entry has been enqueued for >= STALL_MINUTES (default 12).
// If any merge_group run exists for the head — queued, in_progress, or
// completed — the queue is healthy or finishing and we do NOTHING.
//
// Re-enqueue places the entry at the BACK of the queue. That is intentional:
// a repeat-wedger rotates back instead of blocking everyone, and for the
// single-glitch case the queue is usually otherwise empty enough that it
// returns to the head immediately.
//
// ESCALATION (not automated): if nudges stop working entirely (no group runs
// for ANY head across multiple cycles), the historical last resort is a
// ~10-min merge-queue ruleset disable/re-enable by an admin — see
// docs/ci-policy.md and the 2026-05-31 incident notes in
// scripts/enqueue-green-prs.mjs.
//
// Runs in GitHub Actions (.github/workflows/queue-unstick.yml) on a 15-min
// cron, and by hand: `node scripts/unstick-merge-queue.mjs`.
// DRY RUN: `DRY_RUN=1 node scripts/unstick-merge-queue.mjs` (or `--dry-run`)
// logs the decision without mutating the queue.

import { execFileSync } from "node:child_process";

const DRY_RUN = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");
const STALL_MINUTES = Number(process.env.STALL_MINUTES || 12);
// Default to the real upstream slug. The old default `loopdive/js2wasm` was a
// dead repo name — a hand-run (`node scripts/unstick-merge-queue.mjs` without
// GH_REPO) queried the wrong repo and silently saw an empty queue. CI passes
// GH_REPO=${{ github.repository }} so this only bit manual invocations, but a
// wrong default on a queue-rescue script is exactly the tool you reach for when
// the queue is wedged and you cannot afford a misfire. (#1958b)
const REPO = process.env.GH_REPO || "loopdive/js2";
const [OWNER, NAME] = REPO.split("/");

function gh(args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
    // The actions/runs API returns ~1 MB/page (each run carries full repo +
    // actor objects). The default 1 MB stdio buffer ENOBUFS-crashes the script
    // on a single page, let alone paginating. Give it generous headroom. (#1958b)
    maxBuffer: 64 * 1024 * 1024,
  });
}

function graphql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
  return JSON.parse(gh(args));
}

function log(msg) {
  console.log(`[unstick ${new Date().toISOString()}] ${msg}`);
}

// 1. Read the queue.
const queueData = graphql(
  `{repository(owner:"${OWNER}",name:"${NAME}"){mergeQueue(branch:"main"){entries(first:10){nodes{pullRequest{number id} state position enqueuedAt}}}}}`,
);
const entries = queueData?.data?.repository?.mergeQueue?.entries?.nodes ?? [];
if (entries.length === 0) {
  log("queue empty — nothing to do");
  process.exit(0);
}

// 2. Fetch recent merge_group runs ONCE; match per entry below.
//    PER-ENTRY LESSON (2026-06-11 11:19Z incident): the webhook glitch hits
//    per-GROUP, not just the queue head. With parallel group building,
//    entries 2..N can each be missing their runs while the head is healthy
//    (or vice versa). A head-only check cleared one entry and left four
//    others silently stalled — each needed its own nudge. So: check EVERY
//    entry, nudge every stalled one (oldest first), capped per cycle.
//
//    WINDOW-SIZE GAP (#1958b — the 01:36Z-reported-success-during-#1364-wedge
//    incident): each merge group spawns ~4-5 workflow runs (CI, CLA Check,
//    Differential test, Test262 Sharded). A single `per_page=50` page therefore
//    covers only ~10 PRs of merge_group history. During a busy stretch the
//    wedged head's group runs (or, worse, a STALE prior-enqueue run that aliases
//    it) can sit outside or skew that window, so detection silently misreads the
//    state. We page back far enough to cover the whole queue's recent history
//    (PAGES × 100) and de-alias by created_at below.
const RUN_PAGES = Number(process.env.RUN_PAGES || 4); // 4 × 100 = up to ~80 PRs of merge_group history
const allRuns = [];
for (let page = 1; page <= RUN_PAGES; page++) {
  // Project server-side to just the fields we use (id, head_branch, created_at)
  // so we transfer ~60 B/run instead of ~10 KB/run — the full payload is what
  // ENOBUFS'd the old per_page=50 fetch. `-q` emits one compact JSON object per
  // line (jq default), which we parse line-by-line.
  const out = gh([
    "api",
    `repos/${REPO}/actions/runs?event=merge_group&per_page=100&page=${page}`,
    "-q",
    ".workflow_runs[] | {id, head_branch, created_at}",
  ]).trim();
  const pageRuns = out ? out.split("\n").map((l) => JSON.parse(l)) : [];
  allRuns.push(...pageRuns);
  if (pageRuns.length < 100) break; // last page
}
log(`fetched ${allRuns.length} merge_group runs across up to ${RUN_PAGES} page(s)`);

const MAX_NUDGES = Number(process.env.MAX_NUDGES || 5);
let nudged = 0;
let healthy = 0;

const byPosition = [...entries].sort((a, b) => a.position - b.position);
for (const entry of byPosition) {
  const prNum = entry.pullRequest.number;
  const enqueuedAt = new Date(entry.enqueuedAt);
  const ageMin = (Date.now() - enqueuedAt.getTime()) / 60000;

  if (entry.state !== "AWAITING_CHECKS") {
    // QUEUED entries behind the build window have no group yet by design.
    log(`#${prNum} pos=${entry.position} state=${entry.state} — skip (not building)`);
    continue;
  }
  if (ageMin < STALL_MINUTES) {
    log(`#${prNum} pos=${entry.position} enqueued ${ageMin.toFixed(1)} min ago (< ${STALL_MINUTES}) — too fresh`);
    continue;
  }
  // Match this entry's merge_group runs. The synthetic branch is
  // `gh-readonly-queue/main/pr-<N>-<sha>`; anchor on `/pr-<N>-` so #136 never
  // aliases #1364. DE-ALIAS (#1958b): only runs created AT OR AFTER this
  // entry's current enqueuedAt count. A re-enqueue resets enqueuedAt, so a
  // completed run from a PRIOR enqueue of the same PR has an older created_at
  // and is correctly excluded — that stale-run aliasing is what let a wedged,
  // re-enqueued head read "healthy" and the cycle report success.
  const prefix = `/pr-${prNum}-`;
  const groupRuns = allRuns.filter((r) => r.head_branch?.includes(prefix) && new Date(r.created_at) >= enqueuedAt);
  if (groupRuns.length > 0) {
    healthy++;
    const ids = groupRuns
      .slice(0, 4)
      .map((r) => `${r.id}@${r.created_at}`)
      .join(", ");
    log(`#${prNum} pos=${entry.position} has ${groupRuns.length} merge_group run(s) — healthy [${ids}]`);
    continue;
  }
  // No matching runs after enqueuedAt. Surface whether ANY (stale) runs exist
  // for this PR so a future "missed wedge" is debuggable from the cycle log.
  const staleRuns = allRuns.filter((r) => r.head_branch?.includes(prefix));
  if (staleRuns.length > 0) {
    log(
      `#${prNum} pos=${entry.position}: ${staleRuns.length} merge_group run(s) exist but ALL predate enqueuedAt=${entry.enqueuedAt} (stale prior-enqueue) — treating as wedged`,
    );
  }

  // WEDGED entry.
  log(
    `WEDGE DETECTED: #${prNum} pos=${entry.position} AWAITING_CHECKS for ${ageMin.toFixed(0)} min with zero merge_group runs — nudging (dequeue + re-enqueue)`,
  );
  if (DRY_RUN) {
    log("dry-run — skipping mutation");
    continue;
  }
  if (nudged >= MAX_NUDGES) {
    log(`nudge cap (${MAX_NUDGES}) reached this cycle — leaving #${prNum} for the next run`);
    continue;
  }
  const prId = entry.pullRequest.id;
  graphql(
    `
      mutation ($id: ID!) {
        dequeuePullRequest(input: { id: $id }) {
          clientMutationId
        }
      }
    `,
    { id: prId },
  );
  await new Promise((r) => setTimeout(r, 8000));
  graphql(
    `
      mutation ($id: ID!) {
        enqueuePullRequest(input: { pullRequestId: $id }) {
          clientMutationId
        }
      }
    `,
    { id: prId },
  );
  nudged++;
  log(`nudged #${prNum} — dequeued and re-enqueued (now at queue back)`);
}

log(`cycle done: ${entries.length} entries, ${healthy} healthy, ${nudged} nudged`);
