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
const REPO = process.env.GH_REPO || "loopdive/js2wasm";
const [OWNER, NAME] = REPO.split("/");

function gh(args, input) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
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
const runs = JSON.parse(gh(["api", `repos/${REPO}/actions/runs?event=merge_group&per_page=50`]));
const allRuns = runs.workflow_runs ?? [];

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
  const groupRuns = allRuns.filter(
    (r) => r.head_branch?.includes(`/pr-${prNum}-`) && new Date(r.created_at) >= enqueuedAt,
  );
  if (groupRuns.length > 0) {
    healthy++;
    log(`#${prNum} pos=${entry.position} has ${groupRuns.length} merge_group run(s) — healthy`);
    continue;
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
