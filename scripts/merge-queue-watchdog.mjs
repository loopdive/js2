#!/usr/bin/env node
// merge-queue-watchdog.mjs — detect + auto-recover a wedged GitHub merge queue.
//
// THE WEDGE (#1761, ~4x in 24h): GitHub's merge queue periodically stops
// dispatching `merge_group` events. PRs enqueue and sit forever in
// `AWAITING_CHECKS` while ZERO `merge_group` workflow runs fire — ordinary
// pull_request/push/schedule Actions keep working and githubstatus.com shows no
// incident. It is GitHub-side queue-processor state, not our config.
//
// THE PROVEN MANUAL RECOVERY (see .claude/memory/feedback_wedged_merge_queue_reset):
//   1. back up ruleset RULESET_ID verbatim
//   2. PUT a payload OMITTING the `merge_queue` rule (keep required_status_checks
//      + identical name/target/enforcement/conditions/bypass_actors)
//   3. WAIT ~10 minutes (a quick toggle does NOT work — GitHub must fully drain
//      the queue-processor state)
//   4. re-PUT the ORIGINAL ruleset (restore the captured backup verbatim)
//   5. re-enqueue the green PRs
// This script automates exactly that, idempotently and rate-limited.
//
// AUTH CRUX: editing the ruleset needs repo-admin (Administration:write). The
// default GITHUB_TOKEN cannot. We auto-detect: if the token can write the
// ruleset we take the clean RESET path; otherwise we fall back to draining the
// stuck green head with `gh pr merge --admin --merge` (a logged gate bypass that
// unblocks humans but does NOT fix the processor). Wiring an admin PAT
// (MQ_ADMIN_TOKEN) into Actions enables the proper reset path.
//
// ENV:
//   GH_REPO              owner/name (default loopdive/js2)
//   RULESET_ID           ruleset to toggle (default 16700772)
//   WEDGE_THRESHOLD_MIN  oldest-entry age before we call it wedged (default 20)
//   RESET_COOLDOWN_MIN   skip if ruleset updated_at within this window (default 30)
//   DISABLE_WAIT_SEC     how long to leave merge_queue rule OFF (default 600)
//   DRY_RUN=1            detect + log decision, NO mutation
//   GH_TOKEN / GITHUB_TOKEN  auth (admin preferred; PR-write enables fallback)
//
// Runs in .github/workflows/merge-queue-watchdog.yml (schedule + dispatch) and
// by hand: `DRY_RUN=1 node scripts/merge-queue-watchdog.mjs`.

import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const REPO = process.env.GH_REPO || "loopdive/js2";
const [OWNER, NAME] = REPO.split("/");
const RULESET_ID = process.env.RULESET_ID || "16700772";
const WEDGE_THRESHOLD_MIN = Number(process.env.WEDGE_THRESHOLD_MIN || 20);
const RESET_COOLDOWN_MIN = Number(process.env.RESET_COOLDOWN_MIN || 30);
const DISABLE_WAIT_SEC = Number(process.env.DISABLE_WAIT_SEC || 600);
const DRY = process.env.DRY_RUN === "1" || process.argv.includes("--dry-run");

const MINUTE = 60 * 1000;
const now = () => Date.now();
const ageMin = (iso) => (now() - new Date(iso).getTime()) / MINUTE;
const log = (...a) => console.log(...a);

// IMPORTANT: invoke gh via execFileSync with an ARG ARRAY — never a shell
// string. GraphQL queries contain `$id`/`$signal` which a shell would expand to
// empty, producing "Expected VAR_SIGN" parse errors. Arrays bypass the shell.
function gh(args, { allowFail = false } = {}) {
  try {
    return execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    if (allowFail) {
      const err = new Error(String(e.stderr || e.message || e));
      err.stderr = String(e.stderr || "");
      err.status = e.status;
      throw err;
    }
    throw e;
  }
}
function graphql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`);
  return JSON.parse(gh(args));
}

// ---------------------------------------------------------------------------
// DETECT
// ---------------------------------------------------------------------------

// Oldest merge-queue entry (lowest position) + its state/enqueuedAt.
function oldestQueueEntry() {
  const r = graphql(
    `{ repository(owner:"${OWNER}",name:"${NAME}"){ mergeQueue(branch:"main"){
        entries(first:50){ nodes { enqueuedAt state position pullRequest { number } } } } } }`,
  );
  const nodes = r?.data?.repository?.mergeQueue?.entries?.nodes || [];
  if (nodes.length === 0) return null;
  // position can be null while forming; sort by enqueuedAt asc as the tiebreak.
  nodes.sort((a, b) => {
    const pa = a.position ?? Number.MAX_SAFE_INTEGER;
    const pb = b.position ?? Number.MAX_SAFE_INTEGER;
    if (pa !== pb) return pa - pb;
    return new Date(a.enqueuedAt) - new Date(b.enqueuedAt);
  });
  return { entry: nodes[0], count: nodes.length };
}

// Most recent merge_group Actions run's created_at (ISO), or null if none ever.
function latestMergeGroupRunCreatedAt() {
  const r = JSON.parse(gh(["api", `/repos/${REPO}/actions/runs?event=merge_group&per_page=1`]));
  const run = (r.workflow_runs || [])[0];
  return run ? run.created_at : null;
}

// Returns { wedged: bool, reason, entry, queueCount, lastRunAt }.
function detect() {
  const oldest = oldestQueueEntry();
  if (!oldest) {
    return { wedged: false, reason: "queue empty — nothing to recover" };
  }
  const { entry, count } = oldest;
  const lastRunAt = latestMergeGroupRunCreatedAt();
  const oldestAge = ageMin(entry.enqueuedAt);

  if (entry.state !== "AWAITING_CHECKS") {
    return {
      wedged: false,
      reason: `oldest entry state is ${entry.state}, not AWAITING_CHECKS — queue is progressing`,
      entry,
      queueCount: count,
      lastRunAt,
    };
  }
  if (oldestAge < WEDGE_THRESHOLD_MIN) {
    return {
      wedged: false,
      reason: `oldest entry only ${oldestAge.toFixed(1)}m old (< ${WEDGE_THRESHOLD_MIN}m threshold) — give it time`,
      entry,
      queueCount: count,
      lastRunAt,
    };
  }
  // Load-bearing clause: a merge_group run CREATED at/after this entry's
  // enqueuedAt means dispatch is alive (just slow) → NOT wedged.
  if (lastRunAt && new Date(lastRunAt) >= new Date(entry.enqueuedAt)) {
    return {
      wedged: false,
      reason: `merge_group run dispatched ${ageMin(lastRunAt).toFixed(1)}m ago (>= oldest enqueue) — dispatcher alive, just slow`,
      entry,
      queueCount: count,
      lastRunAt,
    };
  }
  return {
    wedged: true,
    reason: `oldest entry (PR #${entry.pullRequest?.number}) AWAITING_CHECKS for ${oldestAge.toFixed(1)}m and NO merge_group run since its enqueue (${lastRunAt ? `last run ${ageMin(lastRunAt).toFixed(1)}m ago` : "no merge_group runs ever"}) — dispatcher dead`,
    entry,
    queueCount: count,
    lastRunAt,
  };
}

// ---------------------------------------------------------------------------
// RULESET helpers
// ---------------------------------------------------------------------------

function getRuleset() {
  return JSON.parse(gh(["api", `/repos/${REPO}/rulesets/${RULESET_ID}`]));
}

// PUT payload GitHub accepts: name/target/enforcement/conditions/bypass_actors/rules.
function putPayload(rs, rules) {
  return JSON.stringify({
    name: rs.name,
    target: rs.target,
    enforcement: rs.enforcement,
    conditions: rs.conditions,
    bypass_actors: rs.bypass_actors,
    rules,
  });
}

function putRuleset(rs, rules) {
  const body = putPayload(rs, rules);
  return JSON.parse(
    execFileSync("gh", ["api", "--method", "PUT", `/repos/${REPO}/rulesets/${RULESET_ID}`, "--input", "-"], {
      input: body,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}

// Capability probe: can this token write the ruleset? Re-PUT it UNCHANGED.
// A 403 (no Administration:write) throws → caller falls back. A success is a
// genuine no-op (identical rules) so this is safe to run unconditionally.
function canWriteRuleset(rs) {
  try {
    putRuleset(rs, rs.rules);
    return true;
  } catch (e) {
    const msg = String(e.stderr || e.message || e);
    if (/403|Resource not accessible|Administration/i.test(msg)) return false;
    throw e; // unexpected error — surface it
  }
}

// ---------------------------------------------------------------------------
// RECOVER — ruleset reset path (preferred)
// ---------------------------------------------------------------------------

async function recoverViaRulesetReset(rs) {
  const withoutMQ = rs.rules.filter((r) => r.type !== "merge_queue");
  log(`[reset] disabling merge_queue rule (keeping ${withoutMQ.map((r) => r.type).join(", ")})`);
  putRuleset(rs, withoutMQ);
  log(`[reset] merge_queue rule OFF. Waiting ${DISABLE_WAIT_SEC}s for GitHub to drain queue state...`);
  await sleep(DISABLE_WAIT_SEC * 1000);
  log(`[reset] restoring ORIGINAL ruleset verbatim (${rs.rules.length} rules)`);
  putRuleset(rs, rs.rules); // restore captured backup exactly
  // verify merge_queue is back
  const after = getRuleset();
  const restored = after.rules.some((r) => r.type === "merge_queue");
  if (!restored) {
    log(`[reset] WARNING: merge_queue rule NOT present after restore — manual check needed`);
  } else {
    log(`[reset] merge_queue rule restored ✓`);
  }
  reEnqueueGreen();
  log(`[reset] done. Watch for a merge_group run on the next enqueued PR's pr-N ref.`);
}

// Re-feed the queue after the reset using the existing surgical sweep.
function reEnqueueGreen() {
  try {
    log(`[reset] re-enqueuing green PRs via enqueue-green-prs.mjs`);
    const out = execFileSync("node", ["scripts/enqueue-green-prs.mjs"], { encoding: "utf8", env: { ...process.env } });
    log(out.trim());
  } catch (e) {
    log(`[reset] re-enqueue sweep failed (non-fatal): ${String(e.stderr || e.message || e).split("\n")[0]}`);
  }
}

// ---------------------------------------------------------------------------
// RECOVER — gate-bypass drain (fallback, no admin token)
// ---------------------------------------------------------------------------

function recoverViaAdminMerge(entry) {
  const n = entry.pullRequest?.number;
  if (!n) {
    log(`[drain] oldest entry has no PR number — cannot admin-merge. Escalate.`);
    return;
  }
  // Only drain when the PR's required PR-level checks are green.
  const checks = JSON.parse(
    gh(["pr", "view", String(n), "--repo", REPO, "--json", "statusCheckRollup,mergeStateStatus"]),
  );
  const rollup = checks.statusCheckRollup || [];
  const failing = rollup.filter(
    (c) => (c.conclusion && !["SUCCESS", "NEUTRAL", "SKIPPED"].includes(c.conclusion)) || c.state === "FAILURE",
  );
  if (failing.length > 0) {
    log(`[drain] PR #${n} has ${failing.length} non-green check(s) — refusing gate bypass. Escalate.`);
    return;
  }
  log(
    `[drain] GATE BYPASS: no admin token for ruleset reset. Admin-merging stuck green head PR #${n} to drain the wedged queue.`,
  );
  log(
    `[drain] NOTE: this unblocks humans but does NOT fix the queue processor — wire MQ_ADMIN_TOKEN for the proper reset.`,
  );
  gh(["pr", "merge", String(n), "--repo", REPO, "--admin", "--merge"]);
  log(`[drain] PR #${n} admin-merged.`);
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  log(`merge-queue-watchdog: repo=${REPO} ruleset=${RULESET_ID} threshold=${WEDGE_THRESHOLD_MIN}m dry=${DRY}`);

  const d = detect();
  log(`DETECT: ${d.wedged ? "WEDGED" : "healthy"} — ${d.reason}`);
  if (d.queueCount != null) log(`  queue entries: ${d.queueCount}, oldest enqueuedAt: ${d.entry?.enqueuedAt}`);
  if (!d.wedged) {
    log("No action.");
    return;
  }

  // ---- idempotency / rate-limit guards (BEFORE capturing any baseline) ----
  const rs = getRuleset();
  const hasMQ = rs.rules.some((r) => r.type === "merge_queue");
  if (!hasMQ) {
    log(
      `GUARD: merge_queue rule already ABSENT from ruleset — a reset is mid-flight (or misconfigured). Aborting to avoid snapshotting a queue-less baseline.`,
    );
    return;
  }
  const sinceUpdate = ageMin(rs.updated_at);
  if (sinceUpdate < RESET_COOLDOWN_MIN) {
    log(
      `GUARD: ruleset updated ${sinceUpdate.toFixed(1)}m ago (< ${RESET_COOLDOWN_MIN}m cooldown) — a recent reset is settling. Aborting.`,
    );
    return;
  }

  if (DRY) {
    const admin = "(not probed in DRY_RUN)";
    log(`DRY_RUN: would RECOVER. Admin-write capability: ${admin}.`);
    log(`DRY_RUN: preferred path = ruleset reset (disable merge_queue ${DISABLE_WAIT_SEC}s → restore → re-enqueue).`);
    log(`DRY_RUN: fallback path  = admin-merge stuck green head PR #${d.entry?.pullRequest?.number}.`);
    log("DRY_RUN: no mutation performed.");
    return;
  }

  // ---- recover: prefer ruleset reset, fall back to admin-merge ----
  if (canWriteRuleset(rs)) {
    log(`RECOVER via RULESET RESET (admin token available).`);
    await recoverViaRulesetReset(rs);
  } else {
    log(`RECOVER via ADMIN-MERGE DRAIN (no Administration:write — ruleset reset unavailable).`);
    recoverViaAdminMerge(d.entry);
  }
}

main().catch((e) => {
  console.error(`merge-queue-watchdog FAILED: ${String(e.stderr || e.message || e)}`);
  process.exit(1);
});
