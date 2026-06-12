#!/usr/bin/env node
// enqueue-green-prs.mjs — keep the merge queue fed automatically, SURGICALLY.
//
// WHY THIS EXISTS: GitHub has no native "auto-enqueue when checks go green".
// The only built-in automation is `gh pr merge --auto`, which arms auto-merge
// on a check-state TRANSITION — it must be armed while checks are still
// pending. But the dev-self-merge gate (net_per_test, regression buckets) needs
// the FINISHED CI results to decide, so by the time an agent acts the PR is
// already CLEAN → no transition left → `--auto` silently no-ops and the PR is
// never queued. The merge queue also DROPS a PR when main advances under it
// (it goes CLEAN-but-dequeued) with nothing re-adding it. Result: green PRs
// strand unqueued (observed repeatedly 2026-05-29). This sweep closes the gap:
// it finds every open, non-draft, mergeable PR that is NOT already in the queue
// and enqueues it via the GraphQL `enqueuePullRequest` mutation.
//
// SERIAL-QUEUE INTERACTION (#1758): the merge queue is SERIAL
// (max_entries_to_build=1). An unconditional, high-frequency enqueue sweep
// races GitHub's `merge_group` formation: a dequeue/enqueue poke at the serial
// head WHILE a merge group is mid-formation wedged the queue twice on
// 2026-05-30/31 (it stuck AWAITING_CHECKS with no `merge_group` dispatched, and
// only a ~10-min ruleset disable/re-enable reset cleared it). The mechanism
// built to un-strand PRs became the thing that wedged the queue. So this sweep
// is now SURGICAL — three guards keep it from poking a forming queue:
//
//   1. BACK-OFF WHILE A HEAD IS FORMING — before sweeping, query the merge
//      queue. If ANY entry is AWAITING_CHECKS (a merge group is mid-formation),
//      SKIP THE ENTIRE SWEEP this run and let GitHub finish. We only sweep when
//      no entry is AWAITING_CHECKS (queue idle / stable / empty). This is the
//      key anti-wedge guard.
//   2. GRACE WINDOW — only enqueue a PR whose checks have all been
//      green for at least GRACE_MINUTES (default 10). "green since" is the most
//      recent completion across the PR's check runs. A PR green for
//      less than the window is left for a later cycle. This guarantees the
//      backstop never races a fresh dev GraphQL enqueue and only catches
//      genuine strays — devs enqueue immediately, this net is for the rare
//      strand (queue-drop on main advance, dev exits before enqueuing).
//   3. ALL-CHECKS GREEN — do not rely on mergeStateStatus alone. GitHub reports
//      UNSTABLE when required checks are green but optional checks are red; the
//      merge queue can still accept that. This script rejects PRs with any
//      failing or pending visible check so advisory CI cannot be ignored by the
//      bot.
//
// Combined with the lowered cron (~30 min) + single-flight concurrency guard in
// the workflow, this removes the high-frequency serial-queue poking entirely.
//
// SAFETY: the merge queue re-runs the REQUIRED checks (cheap gate, merge shard
// reports, quality, equivalence-gate, test262 regression gate) on the merged
// state before landing, and GitHub branch protection is the hard block. The
// enqueue bot also requires every visible PR check to be pass/skipping before
// it queues. Drafts and PRs labelled `hold`/`do-not-merge`/`wip` are skipped so
// work-in-progress is never force-queued.
//
// Runs in GitHub Actions (.github/workflows/auto-enqueue.yml) on CI completion
// + a schedule, and is runnable by hand: `node scripts/enqueue-green-prs.mjs`.
// DRY RUN: `DRY_RUN=1 node scripts/enqueue-green-prs.mjs` (or `--dry-run`) logs
// the back-off decision + per-PR grace-window decisions without enqueuing.
// Requires `gh` authenticated (GITHUB_TOKEN with pull-requests:write in CI).

import { execFileSync } from "node:child_process";

const REPO = process.env.GH_REPO || "loopdive/js2";
const DRY = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const GRACE_MINUTES = Number(process.env.GRACE_MINUTES ?? "10");
const GRACE_MS = GRACE_MINUTES * 60 * 1000;
const HOLD_LABELS = new Set(["hold", "do-not-merge", "do not merge", "wip", "blocked"]);
// mergeStateStatus values we will enqueue. Do NOT include UNSTABLE: that means
// required checks are green but a non-required check failed, which is exactly
// the state that allowed red PRs to enter the merge queue.
const ENQUEUEABLE = new Set(["CLEAN", "HAS_HOOKS"]);
const PASSING_CHECK_STATES = new Set(["pass", "skipping"]);

const [OWNER, NAME] = REPO.split("/");

// IMPORTANT: invoke gh via execFileSync with an ARG ARRAY — never a shell
// string. GraphQL queries contain `$id` and the shell would expand it to
// empty, producing "Expected VAR_SIGN" parse errors. Arrays bypass the shell.
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function ghMaybe(args) {
  try {
    return { ok: true, stdout: gh(args), stderr: "" };
  } catch (e) {
    return {
      ok: false,
      stdout: String(e.stdout || ""),
      stderr: String(e.stderr || e.message || e),
    };
  }
}
function graphql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) args.push("-f", `${k}=${v}`); // -f = raw string field
  return JSON.parse(gh(args));
}

// Merge-queue snapshot: PR numbers already queued + whether any head is forming.
// `state` on a mergeQueueEntry is AWAITING_CHECKS while its merge group is being
// built — that is exactly the window in which a dequeue/enqueue poke wedges the
// serial queue (#1758).
function mergeQueueSnapshot() {
  const r = graphql(
    `{ repository(owner:"${OWNER}",name:"${NAME}"){ mergeQueue(branch:"main"){ entries(first:100){ nodes { state pullRequest { number } } } } } }`,
  );
  const nodes = r?.data?.repository?.mergeQueue?.entries?.nodes || [];
  const queued = new Set(nodes.map((n) => n.pullRequest?.number).filter(Boolean));
  const forming = nodes.filter((n) => n.state === "AWAITING_CHECKS").map((n) => n.pullRequest?.number);
  return { queued, forming };
}

function openPrs() {
  return JSON.parse(
    gh([
      "pr",
      "list",
      "--repo",
      REPO,
      "--state",
      "open",
      "--limit",
      "100",
      "--json",
      "number,mergeStateStatus,isDraft,labels,id,title,headRefName,createdAt",
    ]),
  );
}

// "green since" = the most-recent completion time across the PR's check
// runs. We read the PR's statusCheckRollup contexts (CheckRun.completedAt +
// StatusContext.createdAt) and take the max. A PR whose latest check
// finished < GRACE_MINUTES ago is too fresh to enqueue this cycle. Returns
// { ageMs, completedAt } or null when no completion timestamp is available
// (treated as "not yet eligible" — we never enqueue a PR we cannot age).
function greenSince(prNumber) {
  const r = graphql(
    `{ repository(owner:"${OWNER}",name:"${NAME}"){ pullRequest(number:${prNumber}){ commits(last:1){ nodes { commit { statusCheckRollup { contexts(first:100){ nodes { __typename ... on CheckRun { completedAt } ... on StatusContext { createdAt } } } } } } } } } }`,
  );
  const rollup = r?.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const contexts = rollup?.contexts?.nodes || [];
  let latest = 0;
  for (const c of contexts) {
    const ts = c.completedAt || c.createdAt;
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > latest) latest = ms;
  }
  if (!latest) return null;
  return { ageMs: Date.now() - latest, completedAt: new Date(latest).toISOString() };
}

function visibleCheckState(prNumber) {
  const res = ghMaybe(["pr", "checks", String(prNumber), "--repo", REPO]);
  const output = res.stdout.trim();
  if (!output) {
    const msg = (res.stderr || "no check output").split("\n")[0].slice(0, 120);
    return { failed: [], pending: [], error: msg };
  }

  const failed = [];
  const pending = [];
  let parsed = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 2) continue;
    parsed++;
    const name = cols[0].trim();
    const state = cols[1].trim();
    if (PASSING_CHECK_STATES.has(state)) continue;
    const entry = `${name}: ${state}`;
    if (state === "pending" || state === "queued" || state === "in_progress") {
      pending.push(entry);
    } else {
      failed.push(entry);
    }
  }
  if (parsed === 0) return { failed: [], pending: [], error: "no parseable checks" };

  return { failed, pending, error: null };
}

// CLA-CHECK SHA STRANDING (#1958a). When the merge queue or a drift-update adds
// a `Merge branch 'main'` commit on top of a PR branch, the NEW head SHA has no
// `cla-check` commit status — cla-check.yml runs on pull_request_target and
// posts the status to the PR head SHA only, and does not re-fire when a merge
// commit changes the head. So `enqueuePullRequest` fails with
//   Required status check "cla-check" is expected
// even though CLA was already accepted on the prior head. The fix: rerun the
// PR's latest cla-check workflow run; the pull_request_target re-run re-resolves
// pr.head.sha and reposts cla-check=success on the current head, so the NEXT
// sweep enqueues cleanly. Returns true if a rerun was kicked off.
function isClaExpectedError(msg) {
  return /cla-check.*is expected/i.test(msg) || /required status check.*cla-check/i.test(msg);
}
function rerunClaCheck(prNumber, branch) {
  // Find the most recent cla-check run for this PR's branch and rerun it.
  // `--branch` matches the PR head branch (fork PRs show the source branch).
  const res = ghMaybe([
    "run",
    "list",
    "--repo",
    REPO,
    "--workflow",
    "cla-check.yml",
    "--branch",
    branch,
    "--limit",
    "1",
    "--json",
    "databaseId",
    "-q",
    ".[0].databaseId",
  ]);
  const runId = res.ok ? res.stdout.trim() : "";
  if (!runId) {
    return { ok: false, why: `no cla-check run found for branch ${branch}` };
  }
  const rerun = ghMaybe(["run", "rerun", runId, "--repo", REPO]);
  if (!rerun.ok) {
    return { ok: false, why: `rerun ${runId} failed: ${(rerun.stderr || "").split("\n")[0].slice(0, 80)}` };
  }
  return { ok: true, why: `reran cla-check run ${runId}` };
}

const { queued: inQueue, forming } = mergeQueueSnapshot();

// GUARD 1 — back off while a head is forming. A merge group mid-formation is the
// exact window where poking the serial queue wedges it (#1758). Skip the whole
// sweep; the next cycle (or CI-completion trigger) retries once the queue is idle.
if (forming.length > 0) {
  console.log(
    `enqueue-green-prs: BACK OFF — ${forming.length} queue entr${
      forming.length === 1 ? "y is" : "ies are"
    } AWAITING_CHECKS (head forming): ${forming.map((n) => `#${n}`).join(", ")}. Skipping sweep this cycle.`,
  );
  process.exit(0);
}

const prs = openPrs();
const enqueued = [];
const skipped = [];
const updated = [];

// Auto-update BEHIND PRs: merge base branch in via GitHub API so they can
// re-run CI and eventually become CLEAN. DIRTY PRs (merge conflicts) are
// skipped — those need manual resolution.
//
// OPT-IN ONLY (ALLOW_UPDATE_BRANCH=1). update-branch pushes a merge commit
// authored by the CALLER'S token. From auto-enqueue.yml that caller is
// github-actions[bot], and GitHub parks pull_request runs triggered by bot
// pushes in `action_required` — a state that is neither approvable via API
// for same-repo branches nor rerunnable. The 21:05 sweep on 2026-06-11
// bot-updated 17 BEHIND PRs and stranded every one with a dead check set
// (the exact failure mode that got auto-refresh-prs.yml retired — see its
// header). The merge queue builds merge groups against main itself, so PR
// branches never need auto-updating from CI. A human running this script
// locally with their own token may opt in via ALLOW_UPDATE_BRANCH=1.
const ALLOW_UPDATE_BRANCH = process.env.ALLOW_UPDATE_BRANCH === "1";
for (const pr of prs) {
  if (!ALLOW_UPDATE_BRANCH) break;
  if (pr.mergeStateStatus !== "BEHIND") continue;
  const labels = (pr.labels || []).map((l) => (l.name || "").toLowerCase());
  if (pr.isDraft || labels.some((l) => HOLD_LABELS.has(l))) continue;
  if (DRY) {
    updated.push([pr.number, "would-update-branch (BEHIND)"]);
    continue;
  }
  try {
    // gh pr update-branch requires gh ≥ 2.20; fall back to REST API PUT
    gh(["api", "--method", "PUT", `/repos/${REPO}/pulls/${pr.number}/update-branch`]);
    updated.push([pr.number, "updated-branch (was BEHIND)"]);
  } catch (e) {
    const msg = String(e.stderr || e.message || e)
      .split("\n")[0]
      .slice(0, 120);
    // Conflicts → DIRTY, can't auto-update — skip silently
    if (!msg.includes("conflict")) {
      updated.push([pr.number, `update-failed: ${msg}`]);
    }
  }
}

for (const pr of prs) {
  const labels = (pr.labels || []).map((l) => (l.name || "").toLowerCase());
  if (pr.isDraft) {
    skipped.push([pr.number, "draft"]);
    continue;
  }
  if (labels.some((l) => HOLD_LABELS.has(l))) {
    skipped.push([pr.number, "hold-label"]);
    continue;
  }
  if (inQueue.has(pr.number)) {
    skipped.push([pr.number, "already-queued"]);
    continue;
  }
  if (!ENQUEUEABLE.has(pr.mergeStateStatus)) {
    skipped.push([pr.number, pr.mergeStateStatus]); // BLOCKED/BEHIND/DIRTY/DRAFT/UNKNOWN
    continue;
  }
  const checks = visibleCheckState(pr.number);
  if (checks.error) {
    skipped.push([pr.number, `checks-unavailable: ${checks.error}`]);
    continue;
  }
  if (checks.failed.length > 0) {
    skipped.push([pr.number, `failing-checks: ${checks.failed.slice(0, 5).join(", ")}`]);
    continue;
  }
  if (checks.pending.length > 0) {
    skipped.push([pr.number, `pending-checks: ${checks.pending.slice(0, 5).join(", ")}`]);
    continue;
  }
  // GUARD 3 — grace window. Only enqueue a PR green-but-unqueued for > GRACE.
  // Too-fresh PRs are left for a later cycle so we never race a dev's own
  // GraphQL enqueue; this net only catches genuine strays.
  let green;
  try {
    green = greenSince(pr.number);
  } catch (e) {
    const msg = String(e.stderr || e.message || e)
      .split("\n")[0]
      .slice(0, 120);
    skipped.push([pr.number, `green-since-failed: ${msg}`]);
    continue;
  }
  if (!green) {
    skipped.push([pr.number, "no-green-timestamp"]);
    continue;
  }
  const ageMin = (green.ageMs / 60000).toFixed(1);
  if (green.ageMs < GRACE_MS) {
    skipped.push([pr.number, `too-fresh (green ${ageMin}m < ${GRACE_MINUTES}m grace)`]);
    continue;
  }
  if (DRY) {
    enqueued.push([pr.number, `would-enqueue (green ${ageMin}m >= ${GRACE_MINUTES}m grace)`]);
    continue;
  }
  try {
    graphql(
      `
        mutation ($id: ID!) {
          enqueuePullRequest(input: { pullRequestId: $id }) {
            clientMutationId
          }
        }
      `,
      { id: pr.id },
    );
    enqueued.push([pr.number, `enqueued (green ${ageMin}m)`]);
  } catch (e) {
    // Most common benign error: required checks still in progress (PR just
    // turned mergeable). Leave it — the next sweep / CI-completion run gets it.
    const msg = String(e.stderr || e.message || e)
      .split("\n")[0]
      .slice(0, 120);
    // CLA-CHECK SHA STRANDING (#1958a): if the ONLY blocker is a missing
    // cla-check status on the current head (typical after a merge-main commit),
    // rerun cla-check so the next sweep enqueues cleanly. We already verified
    // above that every VISIBLE check is pass/skipping, so cla-check-expected
    // here means the status is on a stale SHA, not a genuine CLA rejection.
    if (isClaExpectedError(msg)) {
      const r = DRY ? { ok: true, why: "would rerun cla-check" } : rerunClaCheck(pr.number, pr.headRefName);
      skipped.push([pr.number, `cla-check stale on head — ${r.why}; retry next sweep`]);
    } else {
      skipped.push([pr.number, `enqueue-failed: ${msg}`]);
    }
  }
}

// DRAFT ROT (#1958d). Green drafts are invisible to auto-enqueue BY DESIGN —
// but nothing flags them, so a finished draft can rot for ~a day (PRs
// #1345/#1335 — the acorn dogfood blocker — sat green as drafts). This pass
// lists drafts older than DRAFT_AGE_HOURS whose visible checks are all green
// and, ONCE per PR (idempotent on the comment marker + label), nudges the
// author to mark it ready. It never un-drafts or enqueues — that stays a human
// decision.
const DRAFT_AGE_HOURS = Number(process.env.DRAFT_AGE_HOURS ?? "6");
const DRAFT_AGE_MS = DRAFT_AGE_HOURS * 60 * 60 * 1000;
const STALE_DRAFT_LABEL = "stale-draft";
const DRAFT_MARKER = "<!-- enqueue-bot:stale-draft -->";
const draftFlagged = [];
for (const pr of prs) {
  if (!pr.isDraft) continue;
  const labels = (pr.labels || []).map((l) => (l.name || "").toLowerCase());
  if (labels.some((l) => HOLD_LABELS.has(l))) continue; // wip/hold drafts are intentional
  if (labels.includes(STALE_DRAFT_LABEL)) {
    draftFlagged.push([pr.number, "already-flagged"]);
    continue; // idempotent — flagged on a prior sweep
  }
  const ageMs = Date.now() - Date.parse(pr.createdAt);
  if (!Number.isFinite(ageMs) || ageMs < DRAFT_AGE_MS) continue; // too fresh
  const checks = visibleCheckState(pr.number);
  if (checks.error || checks.failed.length > 0 || checks.pending.length > 0) continue; // not green
  const ageH = (ageMs / 3_600_000).toFixed(1);
  if (DRY) {
    draftFlagged.push([pr.number, `would-flag (green draft ${ageH}h old)`]);
    continue;
  }
  // Post one comment + add the label. Both are guarded so re-running is a no-op.
  const comment = ghMaybe([
    "pr",
    "comment",
    String(pr.number),
    "--repo",
    REPO,
    "--body",
    `${DRAFT_MARKER}\nThis PR has been a green draft for ${ageH}h. If it is ready, mark it **Ready for review** so auto-enqueue can pick it up; otherwise add a \`wip\`/\`hold\` label so it stops showing up here.`,
  ]);
  const label = ghMaybe(["pr", "edit", String(pr.number), "--repo", REPO, "--add-label", STALE_DRAFT_LABEL]);
  const why =
    comment.ok && label.ok
      ? `flagged (green draft ${ageH}h)`
      : `flag-partial (comment=${comment.ok} label=${label.ok})`;
  draftFlagged.push([pr.number, why]);
}

console.log(
  `enqueue-green-prs: ${prs.length} open, ${inQueue.size} already queued, grace=${GRACE_MINUTES}m${DRY ? " (DRY RUN)" : ""}`,
);
for (const [n, why] of draftFlagged) console.log(`  ! #${n} draft ${why}`);
for (const [n, why] of updated) console.log(`  ~ #${n} ${why}`);
for (const [n, why] of enqueued) console.log(`  + #${n} ${why}`);
for (const [n, why] of skipped) console.log(`  - #${n} skip (${why})`);
console.log(`Done: ${updated.length} branch-updated, ${enqueued.length} ${DRY ? "would be " : ""}enqueued.`);
process.exit(0);
