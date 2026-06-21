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
// is SURGICAL — its guards keep it from poking the FORMING HEAD:
//
//   1. NEVER TOUCH A QUEUED ENTRY (trailing-add only). The wedge was caused by
//      dequeuing / re-adding the HEAD of a forming merge group — that membership
//      change makes GitHub rebuild the group and cancels its in-flight run
//      (#1758, project_merge_queue_requeue_cancels_run). This sweep ONLY enqueues
//      PRs that are NOT already in the queue (the `already-queued` skip below
//      covers every entry — forming OR stable — since the queue snapshot lists
//      them all). Every enqueue is therefore a TRAILING APPEND to the queue tail,
//      which does NOT alter the forming head's group and does NOT cancel its run.
//      So we do NOT skip the whole sweep just because a head is forming — that
//      over-broad back-off (the old behaviour) meant the serial queue, which
//      almost always has a forming head, was rarely fed, and green PRs stranded
//      until a human enqueued them. We log the forming head for visibility and
//      proceed to append the trailing green PRs.
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
// AUTHOR-TRUST GATE (#2549). Auto-enqueue is the PRIMARY enqueuer of green PRs
// now that dev agents no longer self-enqueue, so its trust boundary is
// load-bearing. A stranger's fork normally can't even reach "all-green" because
// arbitrary-fork CI does not run without a maintainer approving the workflow run
// (approve-fork-runs.yml only auto-approves the trusted `ttraenkler/js2` fork).
// But "approve CI to review an external PR" is a NORMAL maintainer action, and
// if that run goes green this sweep would otherwise enqueue it → auto-merge.
// "Approve CI" must NOT imply "approve merge." So this script ONLY enqueues PRs
// whose `authorAssociation` is in TRUSTED_AUTHOR_ASSOCIATIONS (OWNER / MEMBER /
// COLLABORATOR); every external PR (FIRST_TIME_CONTRIBUTOR / NONE / CONTRIBUTOR
// without org membership) is SKIPPED with `untrusted-author:<assoc>` and ALWAYS
// requires a deliberate human enqueue, no matter how green. `cla-check`
// (a real merge gate now) is the separate, deeper line of defense for external
// contributions; this author gate is the first line. NOTE: `gh pr list --json`
// does NOT expose authorAssociation (gh 2.23), so it is fetched via GraphQL —
// see authorAssociations() below.
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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
// AUTHOR-TRUST GATE (#2549). Only PRs whose authorAssociation is one of these
// are auto-enqueueable. The rationale: auto-enqueue is now the primary enqueuer
// of green PRs, and a maintainer manually approving a STRANGER's CI run to
// review their external PR ("approve CI") must NOT cascade into an auto-merge
// ("approve merge"). OWNER/MEMBER/COLLABORATOR are people with write/org access
// — work the merge queue may land unattended. Everything else
// (FIRST_TIME_CONTRIBUTOR / NONE / CONTRIBUTOR-without-membership) is external
// and ALWAYS requires a deliberate human enqueue. `cla-check` remains the
// separate, deeper merge gate for external contributions; this is the first line.
const TRUSTED_AUTHOR_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);

// FORK-ALLOWLIST LAYER (#2550). The whole team works through the maintainer's
// own fork `ttraenkler/js2`, but GitHub classifies that maintainer as
// `authorAssociation=CONTRIBUTOR` on the base repo (they've had PRs merged but
// are not an org MEMBER). With the association check alone, EVERY team fork PR
// was skipped `untrusted-author:CONTRIBUTOR` — auto-enqueue was effectively
// disabled and the tech-lead had to hand-enqueue every green PR. So we layer a
// login/fork allowlist ALONGSIDE the association check, mirroring
// approve-fork-runs.yml's "trusted ttraenkler/js2 fork" notion: a PR is trusted
// if it satisfies ANY of (association ∈ trusted set) OR (author login ∈
// TRUSTED_AUTHOR_LOGINS) OR (head repo owner ∈ TRUSTED_FORK_OWNERS). Everything
// else still FAILS CLOSED — a stranger CONTRIBUTOR/NONE is never auto-enqueued,
// and `cla-check` remains the deeper merge gate for external contributions. Keep
// this allowlist narrow: it is a deliberate trust grant, not a convenience.
const TRUSTED_AUTHOR_LOGINS = new Set(
  (process.env.TRUSTED_AUTHOR_LOGINS || "ttraenkler")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);
// The head-repository owner(s) we trust. Mirrors approve-fork-runs.yml's
// TRUSTED_FORK (`ttraenkler/js2`) but compares only the OWNER, since a PR's head
// repo is `<owner>/<any-repo-name>`.
const TRUSTED_FORK_OWNERS = new Set(
  (process.env.TRUSTED_FORK_OWNERS || "ttraenkler")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

// Pure trust decision for the author-trust gate (#2549 + #2550 fork allowlist).
// Returns { trusted: boolean, reason: string }. FAILS CLOSED: a PR is trusted
// ONLY if it satisfies at least one allowlist condition; anything unrecognised
// (unknown association, no login, no head-repo owner) is rejected. Exported so
// the gate can be unit-tested without running the live sweep.
export function isTrustedAuthor({ assoc, authorLogin, headRepoOwner } = {}) {
  const a = (assoc || "UNKNOWN").toUpperCase();
  if (TRUSTED_AUTHOR_ASSOCIATIONS.has(a)) {
    return { trusted: true, reason: `association:${a}` };
  }
  const login = (authorLogin || "").toLowerCase();
  if (login && TRUSTED_AUTHOR_LOGINS.has(login)) {
    return { trusted: true, reason: `trusted-login:${login}` };
  }
  const owner = (headRepoOwner || "").toLowerCase();
  if (owner && TRUSTED_FORK_OWNERS.has(owner)) {
    return { trusted: true, reason: `trusted-fork:${owner}` };
  }
  // Fail closed — keep the original logged reason shape so existing log
  // greps (`untrusted-author:<assoc>`) keep working.
  return { trusted: false, reason: `untrusted-author:${a}` };
}

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
// built. `queued` lists EVERY entry (forming OR stable); the enqueue loop uses it
// to skip PRs already in the queue, so we never re-touch the forming head — only
// append trailing green PRs (#2560). `forming` is now informational only (logged,
// no longer triggers a whole-sweep back-off): poking the head wedges the serial
// queue (#1758), but a trailing append does not.
function mergeQueueSnapshot() {
  const r = graphql(
    `{ repository(owner:"${OWNER}",name:"${NAME}"){ mergeQueue(branch:"main"){ entries(first:100){ nodes { state pullRequest { number } } } } } }`,
  );
  const nodes = r?.data?.repository?.mergeQueue?.entries?.nodes || [];
  const queued = new Set(nodes.map((n) => n.pullRequest?.number).filter(Boolean));
  const forming = nodes.filter((n) => n.state === "AWAITING_CHECKS").map((n) => n.pullRequest?.number);
  return { queued, forming };
}

// TRAILING-ADD SAFETY INVARIANT (#2560). A PR is a candidate for auto-enqueue
// ONLY if it is not already in the merge queue. `queued` is the full set of
// queued entries (forming HEAD included). Returning false for any queued PR is
// what guarantees every enqueue is a TRAILING APPEND to the queue tail — never a
// re-touch of the forming head, which is the only operation that cancels a head's
// in-flight merge_group run and wedges the serial queue (#1758). Pure + exported
// so the invariant can be unit-tested without any `gh` call.
export function isTrailingAddCandidate(prNumber, queued) {
  return !queued.has(prNumber);
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
      // author.login + headRepositoryOwner.login feed the #2550 fork-allowlist
      // layer of the author-trust gate (both fields ARE supported by gh 2.23's
      // `pr list --json`, unlike authorAssociation which needs GraphQL).
      "number,mergeStateStatus,isDraft,labels,id,title,headRefName,createdAt,author,headRepositoryOwner",
    ]),
  );
}

// AUTHOR-TRUST GATE (#2549). `gh pr list --json` cannot return authorAssociation
// (unsupported field in gh 2.23 — it errors "Unknown JSON field"), so fetch it
// for all open PRs in one GraphQL page and return a { prNumber -> assoc } map.
// `authorAssociation` is OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR /
// FIRST_TIME_CONTRIBUTOR / FIRST_TIMER / MANNEQUIN / NONE (the actor's relation
// to the BASE repo, loopdive/js2). A number missing from the map (e.g. >100 open
// PRs, or a transient GraphQL hiccup) is treated as untrusted by the caller —
// fail closed, never enqueue a PR whose association we could not confirm.
function authorAssociations() {
  const r = graphql(
    `{ repository(owner:"${OWNER}",name:"${NAME}"){ pullRequests(first:100,states:OPEN){ nodes { number authorAssociation } } } }`,
  );
  const nodes = r?.data?.repository?.pullRequests?.nodes || [];
  const byNumber = new Map();
  for (const n of nodes) {
    if (n?.number != null) byNumber.set(n.number, n.authorAssociation || "NONE");
  }
  return byNumber;
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

// The live sweep is wrapped in runSweep() and only invoked when this file is
// run as the main module (see the import.meta.url guard at the bottom). That
// keeps `import { isTrustedAuthor } from "./enqueue-green-prs.mjs"` side-effect
// free so the gate can be unit-tested without making any `gh` calls.
function runSweep() {
  const { queued: inQueue, forming } = mergeQueueSnapshot();

  // GUARD 1 — TRAILING-ADD ONLY; never touch the forming head (#2560, was #1758).
  // A merge group mid-formation must not have its membership changed: dequeuing or
  // re-adding the HEAD rebuilds the group and cancels its in-flight run, which is
  // what wedged the serial queue twice on 2026-05-30/31. But this sweep only
  // enqueues PRs NOT already in the queue (every queue entry — forming OR stable —
  // is in `inQueue` and hits the `already-queued` skip below), so every enqueue is
  // a TRAILING APPEND to the queue tail. A trailing append leaves the forming
  // head's merge group untouched and does NOT cancel its run. So we do NOT skip the
  // whole sweep just because a head is forming (the old back-off did, which —
  // because the serial queue nearly always has a forming head — meant green PRs
  // almost never got auto-enqueued and stranded until a human intervened). We log
  // the forming head for visibility and proceed to append the trailing green PRs.
  if (forming.length > 0) {
    console.log(
      `enqueue-green-prs: ${forming.length} queue entr${
        forming.length === 1 ? "y is" : "ies are"
      } AWAITING_CHECKS (head forming): ${forming
        .map((n) => `#${n}`)
        .join(", ")}. Proceeding — only TRAILING green PRs are appended; the forming head is never touched.`,
    );
  }

  const prs = openPrs();
  // AUTHOR-TRUST GATE (#2549). Fetch authorAssociation for all open PRs once (gh
  // pr list cannot return it). The enqueue loop fails closed: a PR missing from
  // this map, or whose association is not trusted, is never auto-enqueued.
  const authorAssoc = authorAssociations();
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
    // TRAILING-ADD SAFETY (#2560): never re-touch a PR already in the queue
    // (forming head OR stable entry). Skipping every queued PR is what keeps each
    // enqueue a trailing append to the tail, so a forming head's merge_group run
    // is never cancelled (#1758).
    if (!isTrailingAddCandidate(pr.number, inQueue)) {
      skipped.push([pr.number, "already-queued"]);
      continue;
    }
    if (!ENQUEUEABLE.has(pr.mergeStateStatus)) {
      skipped.push([pr.number, pr.mergeStateStatus]); // BLOCKED/BEHIND/DIRTY/DRAFT/UNKNOWN
      continue;
    }
    // AUTHOR-TRUST GATE (#2549 + #2550 fork allowlist). Fail closed: a PR is
    // auto-enqueueable only if its authorAssociation is OWNER/MEMBER/COLLABORATOR
    // OR its author login is in TRUSTED_AUTHOR_LOGINS OR its head-repo owner is in
    // TRUSTED_FORK_OWNERS (the maintainer's `ttraenkler` fork — CONTRIBUTOR on the
    // base repo, so the association check alone locked out the whole team). An
    // external PR — even one a maintainer manually approved CI for, to review it —
    // ALWAYS needs a deliberate human enqueue. "Approve CI" ≠ "approve merge." A
    // PR missing from the association map (assoc unknown) and not on the
    // login/fork allowlist is untrusted. See isTrustedAuthor() for the decision.
    const assoc = authorAssoc.get(pr.number) || "UNKNOWN";
    const trust = isTrustedAuthor({
      assoc,
      authorLogin: pr.author?.login,
      headRepoOwner: pr.headRepositoryOwner?.login,
    });
    if (!trust.trusted) {
      skipped.push([pr.number, trust.reason]);
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
}

// Only run the live sweep when invoked directly (`node scripts/enqueue-green-prs.mjs`).
// When imported (e.g. by the gate unit test) this guard is false, so no `gh`
// call is made on import. Mirrors the main-module convention used across scripts/.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runSweep();
}
