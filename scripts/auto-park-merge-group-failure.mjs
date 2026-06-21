#!/usr/bin/env node
// auto-park-merge-group-failure.mjs — park a PR that FAILED a required CI
// workflow in the MERGE QUEUE, so the auto-enqueue sweep stops re-adding it.
//
// WHY THIS EXISTS (#2547): test262 now runs only in the merge_group (the #2519
// slim-down), so a PR can be fully green at PR-time yet carry a REAL test262
// regression that only surfaces when the queue validates it on the merged
// state. GitHub ejects the PR from the queue, but `auto-enqueue` sees it is
// still PR-green and re-enqueues it — it cycles forever, burning a ~15-minute
// merge_group CI run every lap. This script breaks that loop: when a required
// workflow concludes `failure` for a `merge_group` event, it parks the
// offending PR by adding the `hold` label (which `enqueue-green-prs.mjs` skips
// via HOLD_LABELS) and posts ONE idempotent comment telling the author to fix
// the failure and remove `hold` to re-enqueue.
//
// CRITICAL — REAL FAILURE vs CANCELLATION (the #1 footgun; see memory
// project_merge_queue_requeue_cancels_run / project_merge_queue_dup_issue_id_churn).
// When the merge queue rebuilds a group (a membership change: main advanced, an
// entry ahead was dequeued, a PR was added/removed) it CANCELS the in-flight
// runs of the old group. GitHub surfaces that cancellation as a RUN-LEVEL
// `failure` conclusion too — but with ZERO failed JOBS (every job is
// `cancelled`/`success`, none `failure`). Parking on those would wrongly hold
// healthy PRs that were merely re-grouped. So we NEVER trust the run-level
// conclusion alone: we fetch the run's jobs and park ONLY when at least one job
// has `conclusion === "failure"` (a genuinely failed shard/check). Zero failed
// jobs ⇒ it was a cancellation ⇒ do nothing.
//
// USAGE
//   node scripts/auto-park-merge-group-failure.mjs <run-id>
//     Reads the run, maps gh-readonly-queue/main/pr-<N>-<sha> -> PR N, checks
//     for a genuinely-failed job, and parks PR N. Requires `gh` authenticated
//     with pull-requests:write, issues:write, actions:read (GITHUB_TOKEN is
//     sufficient — labelling/commenting does not need to trigger a downstream
//     workflow).
//   node scripts/auto-park-merge-group-failure.mjs --self-check
//     Runs the pure-logic unit checks (branch parse + real-vs-cancellation
//     classification) with no network access and exits non-zero on failure.
//   DRY_RUN=1 ... : log the decision without labelling/commenting.

import { execFileSync } from "node:child_process";

const REPO = process.env.GH_REPO || "loopdive/js2";
const DRY = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
const HOLD_LABEL = "hold"; // matches enqueue-green-prs.mjs HOLD_LABELS
const MARKER = "<!-- auto-park-bot:merge-group-failure -->";

// IMPORTANT: invoke gh via execFileSync with an ARG ARRAY (never a shell
// string) — args bypass the shell so refs/SHAs with special chars are safe.
function gh(args) {
  return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
function ghMaybe(args) {
  try {
    return { ok: true, stdout: gh(args), stderr: "" };
  } catch (e) {
    return { ok: false, stdout: String(e.stdout || ""), stderr: String(e.stderr || e.message || e) };
  }
}

// --- pure logic (unit-tested via --self-check) ------------------------------

// Parse a merge-queue ref into its PR number. The merge queue names its
// synthetic branches `gh-readonly-queue/<base>/pr-<N>-<headSha>` (confirmed in
// merge-group-sweeper.yml / queue-unstick.yml). Returns the PR number or null
// for any branch that is not a queue ref (we must never park on those).
export function prNumberFromQueueBranch(branch) {
  if (typeof branch !== "string") return null;
  const m = branch.match(/^gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]+$/);
  return m ? Number(m[1]) : null;
}

// Classify a run from its jobs list. A merge-group run that the queue CANCELLED
// (group rebuilt) reports run-level `failure` but has NO job with
// conclusion === "failure" (jobs are cancelled/success/skipped). A GENUINE
// failure has >= 1 failed job. Returns { realFailure, failedJobs }.
export function classifyRun(jobs) {
  const failedJobs = (jobs || []).filter((j) => j && j.conclusion === "failure").map((j) => j.name);
  return { realFailure: failedJobs.length > 0, failedJobs };
}

// --- gh-backed actions ------------------------------------------------------

function fetchJobs(runId) {
  // Paginate so a 114-job test262 matrix is fully covered.
  const out = gh([
    "api",
    "--paginate",
    `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`,
    "--jq",
    ".jobs[] | {name, conclusion}",
  ]);
  // --jq with --paginate streams one JSON object per line.
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function prHasHoldLabel(prNumber) {
  const res = ghMaybe(["pr", "view", String(prNumber), "--repo", REPO, "--json", "labels", "--jq", "[.labels[].name]"]);
  if (!res.ok) return false;
  try {
    const names = JSON.parse(res.stdout.trim() || "[]").map((n) => String(n).toLowerCase());
    return names.includes(HOLD_LABEL);
  } catch {
    return false;
  }
}

function park(prNumber, failedJobs) {
  if (DRY) {
    console.log(`auto-park: DRY RUN — would park #${prNumber} (failed: ${failedJobs.join(", ")})`);
    return;
  }
  // Idempotent: if already held, do nothing (avoids re-commenting on requeues).
  if (prHasHoldLabel(prNumber)) {
    console.log(`auto-park: #${prNumber} already has \`${HOLD_LABEL}\` — nothing to do.`);
    return;
  }
  // Add the hold label. REST API (not `gh pr edit --add-label`, which has hit a
  // Projects-classic error on this repo — see memory
  // project_merge_queue_dup_issue_id_churn).
  const label = ghMaybe([
    "api",
    "-X",
    "POST",
    `repos/${REPO}/issues/${prNumber}/labels`,
    "-f",
    `labels[]=${HOLD_LABEL}`,
  ]);
  // Post one idempotent comment, guarded by the HTML marker.
  const body = `${MARKER}
auto-parked: failed required CI in the merge_group — a real test262/quality regression only surfaces on the merged state, so this PR cycles forever in the queue otherwise (#2547). Fix the failure and remove the \`${HOLD_LABEL}\` label to re-enqueue.

Failed checks:
${failedJobs.map((n) => `- ${n}`).join("\n")}`;
  const comment = ghMaybe(["pr", "comment", String(prNumber), "--repo", REPO, "--body", body]);
  console.log(
    `auto-park: parked #${prNumber} (label=${label.ok} comment=${comment.ok}) — failed: ${failedJobs.join(", ")}`,
  );
  if (!label.ok) console.error(`  label error: ${(label.stderr || "").split("\n")[0].slice(0, 160)}`);
  if (!comment.ok) console.error(`  comment error: ${(comment.stderr || "").split("\n")[0].slice(0, 160)}`);
}

// --- self-check (no network) ------------------------------------------------

function selfCheck() {
  let failures = 0;
  const eq = (got, want, label) => {
    const g = JSON.stringify(got);
    const w = JSON.stringify(want);
    if (g !== w) {
      console.error(`FAIL ${label}: got ${g}, want ${w}`);
      failures++;
    } else {
      console.log(`ok   ${label}`);
    }
  };

  // Branch parsing.
  eq(prNumberFromQueueBranch("gh-readonly-queue/main/pr-2547-0a1b2c3d4e5f"), 2547, "parse queue ref");
  eq(prNumberFromQueueBranch("gh-readonly-queue/release/pr-12-abcdef0"), 12, "parse non-main base");
  eq(prNumberFromQueueBranch("main"), null, "non-queue branch -> null");
  eq(prNumberFromQueueBranch("issue-2547-foo"), null, "feature branch -> null");
  eq(prNumberFromQueueBranch("gh-readonly-queue/main/pr-xx-abc"), null, "malformed N -> null");
  eq(prNumberFromQueueBranch(undefined), null, "undefined -> null");

  // Real-vs-cancellation classification.
  eq(
    classifyRun([
      { name: "quality", conclusion: "success" },
      { name: "merge shard reports", conclusion: "failure" },
    ]),
    { realFailure: true, failedJobs: ["merge shard reports"] },
    "real failure: one failed job",
  );
  eq(
    classifyRun([
      { name: "quality", conclusion: "cancelled" },
      { name: "test262 shard 1", conclusion: "cancelled" },
      { name: "test262 shard 2", conclusion: "success" },
    ]),
    { realFailure: false, failedJobs: [] },
    "cancellation: zero failed jobs (queue rebuild) -> do not park",
  );
  eq(classifyRun([]), { realFailure: false, failedJobs: [] }, "empty jobs -> do not park");
  eq(
    classifyRun([
      { name: "a", conclusion: "failure" },
      { name: "b", conclusion: "failure" },
    ]),
    { realFailure: true, failedJobs: ["a", "b"] },
    "multiple failed jobs collected",
  );

  if (failures) {
    console.error(`\n${failures} self-check(s) failed`);
    process.exit(1);
  }
  console.log("\nall self-checks passed");
  process.exit(0);
}

// --- entrypoint -------------------------------------------------------------

function isMain() {
  return process.argv[1] && process.argv[1].endsWith("auto-park-merge-group-failure.mjs");
}

if (isMain()) {
  if (process.argv.includes("--self-check")) {
    selfCheck();
  }

  const runId = process.argv.find((a) => /^\d+$/.test(a));
  if (!runId) {
    console.error("usage: auto-park-merge-group-failure.mjs <run-id> [--dry-run]");
    process.exit(2);
  }

  // Resolve the run's head_branch + event so we can map and double-check it was
  // a merge_group run (the workflow already gates on this, but be defensive).
  const runJson = JSON.parse(
    gh(["api", `repos/${REPO}/actions/runs/${runId}`, "--jq", "{head_branch, event, conclusion, name}"]),
  );
  if (runJson.event !== "merge_group") {
    console.log(`auto-park: run ${runId} event=${runJson.event} (not merge_group) — skipping.`);
    process.exit(0);
  }
  const prNumber = prNumberFromQueueBranch(runJson.head_branch);
  if (!prNumber) {
    console.log(`auto-park: run ${runId} head_branch="${runJson.head_branch}" is not a queue ref — skipping.`);
    process.exit(0);
  }

  const jobs = fetchJobs(runId);
  const { realFailure, failedJobs } = classifyRun(jobs);
  if (!realFailure) {
    console.log(
      `auto-park: run ${runId} (PR #${prNumber}) has 0 failed jobs of ${jobs.length} — CANCELLATION (queue rebuild), NOT parking.`,
    );
    process.exit(0);
  }
  console.log(
    `auto-park: run ${runId} (${runJson.name}) for PR #${prNumber} has ${failedJobs.length} genuinely-failed job(s) — parking.`,
  );
  park(prNumber, failedJobs);
}
