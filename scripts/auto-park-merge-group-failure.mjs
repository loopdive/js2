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

const REPO = process.env.GH_REPO || "loopdive/js2wasm";
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
// synthetic branches `gh-readonly-queue/<base>/pr-<N>-<sha>`. Returns the PR
// number or null for any branch that is not a queue ref (we must never park on
// those).
//
// #3914 — TWO CORRECTIONS to what this ref means, both load-bearing once the
// queue batches more than one PR per group (`min_entries_to_merge > 1`):
//
//   (a) The trailing SHA is the group's BASE, not its head. Verified against
//       live runs: run 30631849709 had head_branch
//       `gh-readonly-queue/main/pr-3892-a19c4abe…` while its own head_sha was
//       `4aa1162c…`; `a19c4abe` is the main tip the group was built on. The
//       older comment here called it `<headSha>`. That matters because the
//       base SHA is exactly what we need to enumerate the group's members.
//
//   (b) `pr-<N>` names only the LAST PR in the group. In a serial queue that
//       is the only PR, so parking N is complete. In a batched queue the
//       culprit may be any member, so parking only N holds an innocent PR and
//       leaves the actual regressor free to be re-enqueued — reinstating the
//       exact forever-cycle #2547 exists to break. See prNumbersInGroup().
export function prNumberFromQueueBranch(branch) {
  if (typeof branch !== "string") return null;
  const m = branch.match(/^gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]+$/);
  return m ? Number(m[1]) : null;
}

// #3914 — the group's BASE sha, from the same ref. Used to enumerate group
// members via the compare API. Null for non-queue refs.
export function baseShaFromQueueBranch(branch) {
  if (typeof branch !== "string") return null;
  const m = branch.match(/^gh-readonly-queue\/[^/]+\/pr-\d+-([0-9a-f]{7,40})$/);
  return m ? m[1] : null;
}

// #3914 — extract every PR number a merge-group commit range landed. The queue
// stacks one merge commit per entry on top of the base, so the commit subjects
// in `base..head` name each member PR. Both merge-commit and squash-commit
// subject shapes are recognised so this does not silently under-park if the
// repo's merge method ever changes.
//
// Pure so --self-check can exercise it without network.
export function prNumbersFromCommitSubjects(subjects) {
  const found = [];
  for (const raw of subjects || []) {
    if (typeof raw !== "string") continue;
    const subject = raw.split("\n", 1)[0];
    // `Merge pull request #N from owner/branch` (merge-commit method)
    // `some title (#N)` (squash method)
    const m = subject.match(/^Merge pull request #(\d+)\b/) || subject.match(/\(#(\d+)\)\s*$/);
    if (m) {
      const n = Number(m[1]);
      if (!found.includes(n)) found.push(n);
    }
  }
  return found;
}

// INFRA steps — a failure HERE says nothing about the merged state's health.
// Motivating incident (2026-07-24): two parks landed the same day with textually
// identical comments ("Failed checks: - check for test262 regressions", no run
// URL, no step name). #3566 was BOGUS — the shard-artifact download 403'd, the
// verdict step never ran, and the PR merged cleanly once unparked. #3563 was
// CORRECT — the verdict ran and caught a real uncatchable-trap regression. Two
// opposite situations, indistinguishable from the comment, each costing a full
// manual investigation.
//
// Patterns are deliberately TIGHT. Widening this list makes the bot park LESS,
// which is the dangerous direction (a real regression slips into main). When in
// doubt, leave a step out so it classifies as non-infra and parks.
// The transfer-verb entries are grounded in the REAL step inventory, harvested
// 2026-07-25 from .github/workflows/test262-sharded.yml — not guessed:
//   "Download shard artifacts"            "Upload shard artifacts"
//   "Download merged reports (…)"         "Upload merged reports"
//   "Download just-landed group artifact" "Upload regressions report"
// Three of those carry no "artifact" token at all, so an artifact-word-only
// pattern would have MISSED the #3566 class. Every `^Download`/`^Upload` step in
// this repo is pure transfer — none computes a verdict. If a verdict step is
// ever named "Download and compare …", this list must be tightened, because
// that is the direction that lets a regression through.
// `tests/issue-3597-auto-park-step-aware.test.ts` pins the real names so a
// workflow rename surfaces here.
export const INFRA_STEP_PATTERNS = [
  /^set up job$/i,
  /^complete job$/i,
  /^post\s/i, // actions' generated post-run steps ("Post Run actions/checkout@v5")
  /^(check ?out)\b/i,
  /^run actions\/(checkout|setup-node|setup-python|setup-java|cache|download-artifact|upload-artifact)\b/i,
  /^set ?up (node|pnpm|python|java|go|ruby)\b/i,
  /^initialize containers$/i,
  /^stop containers$/i,
  /^(download|upload)\s/i, // transfer steps (see inventory above)
  /\b(download|upload)\b[^\n]*\bartifacts?\b/i,
  // Both orders — "Retry shard artifact upload on transient flake (#3404)" puts
  // the noun FIRST, which an artifact-then-download-only pattern missed (caught
  // by the real-step-name cases in tests/issue-3597-auto-park-step-aware.test.ts).
  /\bartifacts?\b[^\n]*\b(download|upload)\b/i,
];

// Is this step name a setup/infra step (as opposed to a verdict step)?
// Unknown / empty names are NOT infra — they must fall through to parking.
export function isInfraStep(name) {
  if (typeof name !== "string") return false;
  const n = name.trim();
  if (!n) return false;
  return INFRA_STEP_PATTERNS.some((re) => re.test(n));
}

// Classify a run from its jobs list.
//
// (1) CANCELLATION vs REAL FAILURE — a merge-group run that the queue CANCELLED
//     (group rebuilt) reports run-level `failure` but has NO job with
//     conclusion === "failure" (jobs are cancelled/success/skipped). A GENUINE
//     failure has >= 1 failed job.
//
// (2) INFRA vs VERDICT (step awareness) — among genuinely-failed jobs, look at
//     which STEP failed. If EVERY failed step across EVERY failed job is a
//     recognised setup/infra step, the verdict never ran and parking would be
//     bogus (the #3566 shape).
//
// (3) RUNNER KILL (#4157 parks 2-4, 2026-08-13) — a GitHub-hosted runner that
//     receives a shutdown signal mid-job ("The runner has received a shutdown
//     signal", exit 143) produces a job with conclusion === "failure" whose
//     steps contain NO failed step: the step it died in reads `cancelled`.
//     No verdict ran, so this is the same class as (2) — parking is bogus, and
//     the correct response is the eject→auto-enqueue retry loop already
//     documented at the infra-only exit below. Five kill waves on 2026-08-13
//     parked the same PR four times on exactly this shape before the
//     classifier was taught it.
//
// CONSERVATIVE BY CONSTRUCTION: we skip parking only on POSITIVE evidence that
// every failure was infra. A failed job whose failing step we cannot identify
// (`steps` absent/empty — e.g. the API response was trimmed) is
// `unclassifiable` and forces a park; the runner-kill shape is NOT that case —
// it carries positive evidence (>= 1 cancelled step, zero failed steps).
// Being wrong in the permissive direction lets a real regression into main;
// being wrong in the strict direction costs one label removal.
// A cancelled-step death at/above this duration is suspected to be the JOB
// TIMEOUT (timeout-minutes: 40 on the shard jobs), i.e. a genuinely-too-slow
// merged state — that PARKS, because auto-retrying a too-slow PR is the exact
// #2547 infinite-lap cycle this bot exists to break. Below it, the death is a
// mid-flight runner kill. If the shard timeout is ever raised, a wave kill in
// the [35 min, timeout) band wrongly parks — the cheap direction (one label
// removal) by this script's own doctrine.
export const RUNNER_KILL_MAX_MS = 35 * 60 * 1000;

// Steps whose failure is DERIVATIVE of shard-job deaths — the aggregate that
// fails *because* required shards did not succeed. When >= 1 runner-killed
// shard exists in the run, this step's failure carries no independent verdict
// and must not veto the infra classification. When NO runner kill exists, it
// is judged like any other step (i.e. non-infra -> park).
const DERIVATIVE_AGGREGATE_STEPS = [/^Fail if required test262 shards did not succeed$/];
function isDerivativeAggregateStep(name) {
  return typeof name === "string" && DERIVATIVE_AGGREGATE_STEPS.some((re) => re.test(name.trim()));
}

export function classifyRun(jobs) {
  const failed = (jobs || []).filter((j) => j && j.conclusion === "failure");
  const failedJobs = failed.map((j) => j.name);
  const failedDetails = failed.map((j) => {
    const steps = Array.isArray(j.steps) ? j.steps : [];
    const failedSteps = steps.filter((s) => s && s.conclusion === "failure").map((s) => s.name);
    const durationMs = j.started_at && j.completed_at ? Date.parse(j.completed_at) - Date.parse(j.started_at) : null;
    return {
      job: j.name,
      url: j.html_url || null,
      failedSteps,
      // The runner-kill signature, TWO variants (both require dying well
      // before the job timeout; missing timestamps -> NOT a kill,
      // conservative):
      //  A. no step FAILED, >= 1 step CANCELLED mid-flight (the usual shape).
      //  B. (#4455 park 5, 2026-08-14) the dying step is recorded as a
      //     FAILURE (exit 143 surfaces as a step failure on some kills) — for
      //     this variant we require POSITIVE annotation evidence: the caller
      //     sets `shutdownAnnotated` when the job's check-run annotations
      //     carry "The runner has received a shutdown signal". Without the
      //     annotation, a failed step is judged as a real failure.
      runnerKilled:
        durationMs !== null &&
        durationMs < RUNNER_KILL_MAX_MS &&
        ((failedSteps.length === 0 && steps.some((s) => s && s.conclusion === "cancelled")) ||
          j.shutdownAnnotated === true),
    };
  });
  const realFailure = failed.length > 0;
  const anyRunnerKilled = failedDetails.some((d) => d.runnerKilled);
  // Steps that carry an independent verdict for the infra/real judgment.
  const judgedSteps = (d) =>
    anyRunnerKilled ? d.failedSteps.filter((s) => !isDerivativeAggregateStep(s)) : d.failedSteps;
  const unclassifiable = failedDetails.some((d) => d.failedSteps.length === 0 && !d.runnerKilled);
  const infraOnly =
    realFailure &&
    !unclassifiable &&
    failedDetails.every((d) => d.runnerKilled || judgedSteps(d).every((s) => isInfraStep(s)));
  return {
    realFailure,
    failedJobs,
    failedDetails,
    unclassifiable,
    infraOnly,
    shouldPark: realFailure && !infraOnly,
  };
}

// Render the "Failed checks:" block — job name, the step(s) that actually
// failed, and the job URL. This is the half that turns a park comment from
// "something failed" into an actionable pointer.
export function renderFailureLines(failedDetails) {
  return (failedDetails || [])
    .map((d) => {
      const steps = d.failedSteps.length ? ` — failing step: ${d.failedSteps.join(", ")}` : " — failing step: unknown";
      const url = d.url ? ` ([job log](${d.url}))` : "";
      return `- ${d.job}${steps}${url}`;
    })
    .join("\n");
}

// --- gh-backed actions ------------------------------------------------------

function fetchJobs(runId) {
  // Paginate so a 114-job test262 matrix is fully covered.
  // `steps[]` carries the per-step `conclusion` — that is what makes the
  // infra-vs-verdict call possible (#3597). `html_url` gives the park comment a
  // direct pointer to the failing job log.
  const out = gh([
    "api",
    "--paginate",
    `repos/${REPO}/actions/runs/${runId}/jobs?per_page=100`,
    "--jq",
    ".jobs[] | {id, name, conclusion, html_url, started_at, completed_at, steps: [(.steps // [])[] | {name, conclusion}]}",
  ]);
  // --jq with --paginate streams one JSON object per line.
  return out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

// (#4455 park 5) Variant-B runner-kill evidence: exit 143 can surface as a
// FAILED step, indistinguishable from a real crash by steps alone. The
// check-run annotations carry the positive marker. Enrich only failed jobs
// that have a failed step and are not already variant-A kills — one extra
// API call per such job, only on failure runs. Any fetch error leaves
// `shutdownAnnotated` unset (conservative -> judged as a real failure).
const SHUTDOWN_ANNOTATION = /runner has received a shutdown signal/i;
function annotateShutdownKills(jobs) {
  for (const j of jobs || []) {
    if (!j || j.conclusion !== "failure" || !j.id) continue;
    const steps = Array.isArray(j.steps) ? j.steps : [];
    const hasFailedStep = steps.some((s) => s && s.conclusion === "failure");
    if (!hasFailedStep) continue; // variant A handles the cancelled-step shape
    const r = ghMaybe(["api", `repos/${REPO}/check-runs/${j.id}/annotations`, "--jq", ".[].message"]);
    if (r.ok && SHUTDOWN_ANNOTATION.test(r.stdout)) j.shutdownAnnotated = true;
  }
  return jobs;
}

// #3914 — resolve every PR in the failed merge group. Returns a list that
// ALWAYS contains `fallbackPr` (the ref-named PR), so a compare-API failure
// degrades to exactly the pre-#3914 behaviour rather than parking nothing.
//
// With a serial queue (`min_entries_to_merge: 1`) the range holds exactly one
// merge commit, so this returns `[fallbackPr]` and the behaviour is unchanged.
function prNumbersInGroup(baseSha, headSha, fallbackPr) {
  if (!baseSha || !headSha) return [fallbackPr];
  const res = ghMaybe(["api", `repos/${REPO}/compare/${baseSha}...${headSha}`, "--jq", ".commits[].commit.message"]);
  if (!res.ok) {
    console.log(
      `auto-park: compare ${baseSha.slice(0, 8)}...${headSha.slice(0, 8)} failed — falling back to the ref-named PR #${fallbackPr}.`,
    );
    return [fallbackPr];
  }
  const subjects = res.stdout.split(/\r?\n/).filter(Boolean);
  const found = prNumbersFromCommitSubjects(subjects);
  if (!found.includes(fallbackPr)) found.push(fallbackPr);
  return found;
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

function park(prNumber, failedDetails, runUrl, groupPrs = [prNumber]) {
  const failedJobs = failedDetails.map((d) => d.job);
  if (DRY) {
    console.log(`auto-park: DRY RUN — would park #${prNumber} (failed: ${failedJobs.join(", ")})`);
    console.log(renderFailureLines(failedDetails));
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
  // #3914 — when the group held more than one PR, the failure is attributable
  // to the GROUP, not to this PR specifically. Say so, and name the co-members
  // so whoever triages knows to look across them rather than assuming this PR
  // is the regressor.
  const batchNote =
    groupPrs.length > 1
      ? `\n**This was a batched merge group** (${groupPrs.map((n) => `#${n}`).join(", ")}). The failure is attributed to the group as a whole — any member could be the cause, so all of them are parked. Re-enqueue them ONE AT A TIME to attribute the failure before removing \`${HOLD_LABEL}\` from the rest.\n`
      : "";
  // Post one idempotent comment, guarded by the HTML marker.
  const body = `${MARKER}
auto-parked: failed required CI in the merge_group — a real test262/quality regression only surfaces on the merged state, so this PR cycles forever in the queue otherwise (#2547). Fix the failure and remove the \`${HOLD_LABEL}\` label to re-enqueue.
${batchNote}
Failed checks:
${renderFailureLines(failedDetails)}

Run: ${runUrl}

<sub>The failing STEP is named above (#3597). If it is a setup/infra step rather than a verdict step, the verdict never ran and this park may be spurious — confirm against the run before removing \`${HOLD_LABEL}\`.</sub>`;
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

  // #3914 — base-sha extraction from the same ref. Live shape confirmed against
  // run 30631849709 (head_branch pr-3892-a19c4abe…, own head_sha 4aa1162c…).
  eq(
    baseShaFromQueueBranch("gh-readonly-queue/main/pr-3892-a19c4abeaf741e9b8ee74c51e42e18af48df9d4e"),
    "a19c4abeaf741e9b8ee74c51e42e18af48df9d4e",
    "base sha from queue ref",
  );
  eq(baseShaFromQueueBranch("gh-readonly-queue/release/pr-12-abcdef0"), "abcdef0", "short base sha");
  eq(baseShaFromQueueBranch("main"), null, "non-queue branch -> null base sha");
  eq(baseShaFromQueueBranch(undefined), null, "undefined -> null base sha");

  // #3914 — group membership from commit subjects. Order is queue order.
  eq(
    prNumbersFromCommitSubjects([
      "Merge pull request #3890 from ttraenkler/docs-x\n\nbody",
      "Merge pull request #3891 from ttraenkler/issue-y",
      "Merge pull request #3892 from ttraenkler/issue-z",
    ]),
    [3890, 3891, 3892],
    "batched group -> every member PR",
  );
  eq(
    prNumbersFromCommitSubjects(["Merge pull request #3892 from ttraenkler/issue-z"]),
    [3892],
    "serial group -> single member (today's behaviour)",
  );
  eq(
    prNumbersFromCommitSubjects(["fix(#3647): class prototype members are non-enumerable (#3892)"]),
    [3892],
    "squash-commit subject shape",
  );
  eq(
    prNumbersFromCommitSubjects(["chore: no pr reference here", null, 42]),
    [],
    "no PR reference / non-strings -> empty",
  );
  eq(
    prNumbersFromCommitSubjects(["Merge pull request #3892 from a/b", "Merge pull request #3892 from a/b"]),
    [3892],
    "duplicate subjects deduped",
  );

  // Real-vs-cancellation classification.
  const pick = (r) => ({
    realFailure: r.realFailure,
    failedJobs: r.failedJobs,
    infraOnly: r.infraOnly,
    unclassifiable: r.unclassifiable,
    shouldPark: r.shouldPark,
  });
  eq(
    pick(
      classifyRun([
        { name: "quality", conclusion: "success" },
        { name: "merge shard reports", conclusion: "failure" },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["merge shard reports"],
      infraOnly: false,
      unclassifiable: true,
      shouldPark: true,
    },
    "real failure: one failed job (no steps -> unclassifiable -> park)",
  );
  eq(
    pick(
      classifyRun([
        { name: "quality", conclusion: "cancelled" },
        { name: "test262 shard 1", conclusion: "cancelled" },
        { name: "test262 shard 2", conclusion: "success" },
      ]),
    ),
    { realFailure: false, failedJobs: [], infraOnly: false, unclassifiable: false, shouldPark: false },
    "cancellation: zero failed jobs (queue rebuild) -> do not park",
  );
  eq(
    pick(classifyRun([])),
    { realFailure: false, failedJobs: [], infraOnly: false, unclassifiable: false, shouldPark: false },
    "empty jobs -> do not park",
  );

  // (#4157 parks 2-4) Runner-kill shape: failed job, zero failed steps, >= 1
  // cancelled step, died well under the job timeout — positive evidence the
  // runner was shut down mid-step. Infra; the derivative aggregate failure
  // does not veto. Do not park (eject + auto-enqueue is the retry).
  eq(
    pick(
      classifyRun([
        {
          name: "test262 standalone shard 4/36",
          conclusion: "failure",
          started_at: "2026-08-13T23:42:00Z",
          completed_at: "2026-08-13T23:51:00Z",
          steps: [
            { name: "Checkout", conclusion: "success" },
            { name: "Run shard", conclusion: "cancelled" },
          ],
        },
        {
          name: "merge shard reports",
          conclusion: "failure",
          started_at: "2026-08-14T00:26:00Z",
          completed_at: "2026-08-14T00:27:00Z",
          steps: [{ name: "Fail if required test262 shards did not succeed", conclusion: "failure" }],
        },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["test262 standalone shard 4/36", "merge shard reports"],
      infraOnly: true,
      unclassifiable: false,
      shouldPark: false,
    },
    "runner-kill: cancelled step under timeout + derivative aggregate -> infra, do not park",
  );
  // Same cancelled-step shape but the job ran to ~its timeout: that is the
  // job-timeout kill of a genuinely-too-slow merged state — PARK (auto-retry
  // of a too-slow PR is the #2547 infinite lap).
  eq(
    pick(
      classifyRun([
        {
          name: "test262 standalone shard 9/36",
          conclusion: "failure",
          started_at: "2026-08-13T23:00:00Z",
          completed_at: "2026-08-13T23:40:05Z",
          steps: [
            { name: "Checkout", conclusion: "success" },
            { name: "Run shard", conclusion: "cancelled" },
          ],
        },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["test262 standalone shard 9/36"],
      infraOnly: false,
      unclassifiable: true,
      shouldPark: true,
    },
    "timeout-kill: cancelled step at ~job timeout -> park (too-slow merged state)",
  );
  // Missing timestamps: no positive duration evidence -> not a runner kill ->
  // unclassifiable -> park (conservative).
  eq(
    pick(
      classifyRun([
        {
          name: "test262 standalone shard 2/36",
          conclusion: "failure",
          steps: [{ name: "Run shard", conclusion: "cancelled" }],
        },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["test262 standalone shard 2/36"],
      infraOnly: false,
      unclassifiable: true,
      shouldPark: true,
    },
    "cancelled step without timestamps -> no duration evidence -> park",
  );
  // (#4455 park 5) Variant B: a runner kill whose dying step recorded as a
  // FAILURE (exit 143). With the shutdown annotation + short duration -> infra.
  eq(
    pick(
      classifyRun([
        {
          name: "test262 standalone shard 3/36",
          conclusion: "failure",
          started_at: "2026-08-14T03:24:00Z",
          completed_at: "2026-08-14T03:30:24Z",
          shutdownAnnotated: true,
          steps: [
            { name: "Checkout", conclusion: "success" },
            { name: "Run shard", conclusion: "failure" },
          ],
        },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["test262 standalone shard 3/36"],
      infraOnly: true,
      unclassifiable: false,
      shouldPark: false,
    },
    "variant-B kill: failed step + shutdown annotation + short duration -> infra, no park",
  );
  // Same failed step WITHOUT the annotation -> judged real -> park.
  eq(
    pick(
      classifyRun([
        {
          name: "test262 standalone shard 3/36",
          conclusion: "failure",
          started_at: "2026-08-14T03:24:00Z",
          completed_at: "2026-08-14T03:30:24Z",
          steps: [{ name: "Run shard", conclusion: "failure" }],
        },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["test262 standalone shard 3/36"],
      infraOnly: false,
      unclassifiable: false,
      shouldPark: true,
    },
    "failed step without annotation -> real failure -> park",
  );
  // Annotation cannot excuse a ~timeout-length death.
  eq(
    pick(
      classifyRun([
        {
          name: "test262 standalone shard 3/36",
          conclusion: "failure",
          started_at: "2026-08-14T03:00:00Z",
          completed_at: "2026-08-14T03:40:05Z",
          shutdownAnnotated: true,
          steps: [{ name: "Run shard", conclusion: "failure" }],
        },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["test262 standalone shard 3/36"],
      infraOnly: false,
      unclassifiable: false,
      shouldPark: true,
    },
    "variant-B annotation at ~timeout duration -> still park",
  );

  // The derivative aggregate step does NOT get a pass when no runner kill
  // exists in the run — judged like any step, non-infra -> park.
  eq(
    pick(
      classifyRun([
        {
          name: "merge shard reports",
          conclusion: "failure",
          started_at: "2026-08-14T00:26:00Z",
          completed_at: "2026-08-14T00:27:00Z",
          steps: [{ name: "Fail if required test262 shards did not succeed", conclusion: "failure" }],
        },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["merge shard reports"],
      infraOnly: false,
      unclassifiable: false,
      shouldPark: true,
    },
    "derivative aggregate alone (no runner kill) -> park",
  );

  // (#3597) Step awareness — the two shapes that were indistinguishable on
  // 2026-07-24.
  eq(isInfraStep("Download shard artifacts"), true, "infra: download shard artifacts");
  eq(isInfraStep("Set up job"), true, "infra: set up job");
  eq(isInfraStep("Checkout"), true, "infra: checkout");
  eq(isInfraStep("Post Checkout"), true, "infra: post-step");
  eq(isInfraStep("check for test262 regressions"), false, "verdict: regression check is NOT infra");
  eq(isInfraStep("Run standalone floor gate"), false, "verdict: floor gate is NOT infra");
  eq(isInfraStep(""), false, "empty step name is NOT infra");
  eq(isInfraStep(undefined), false, "missing step name is NOT infra");

  eq(
    pick(
      classifyRun([
        {
          name: "check for test262 regressions",
          conclusion: "failure",
          steps: [
            { name: "Set up job", conclusion: "success" },
            { name: "Download shard artifacts", conclusion: "failure" },
            { name: "Compare against baseline", conclusion: "skipped" },
          ],
        },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["check for test262 regressions"],
      infraOnly: true,
      unclassifiable: false,
      shouldPark: false,
    },
    "#3566 shape: artifact download failed, verdict never ran -> DO NOT park",
  );
  eq(
    pick(
      classifyRun([
        {
          name: "check for test262 regressions",
          conclusion: "failure",
          steps: [
            { name: "Download shard artifacts", conclusion: "success" },
            { name: "Compare against baseline", conclusion: "failure" },
          ],
        },
      ]),
    ),
    {
      realFailure: true,
      failedJobs: ["check for test262 regressions"],
      infraOnly: false,
      unclassifiable: false,
      shouldPark: true,
    },
    "#3563 shape: verdict step failed -> MUST park",
  );
  eq(
    pick(
      classifyRun([
        {
          name: "j1",
          conclusion: "failure",
          steps: [{ name: "Download shard artifacts", conclusion: "failure" }],
        },
        {
          name: "j2",
          conclusion: "failure",
          steps: [{ name: "Compare against baseline", conclusion: "failure" }],
        },
      ]),
    ),
    { realFailure: true, failedJobs: ["j1", "j2"], infraOnly: false, unclassifiable: false, shouldPark: true },
    "mixed infra + verdict -> park (any verdict failure wins)",
  );
  eq(
    pick(
      classifyRun([
        { name: "j1", conclusion: "failure", steps: [{ name: "Download shard artifacts", conclusion: "failure" }] },
        { name: "j2", conclusion: "failure", steps: [] },
      ]),
    ),
    { realFailure: true, failedJobs: ["j1", "j2"], infraOnly: false, unclassifiable: true, shouldPark: true },
    "infra + UNCLASSIFIABLE job -> park conservatively",
  );
  eq(
    renderFailureLines([
      { job: "check for test262 regressions", url: "https://x/job/1", failedSteps: ["Compare against baseline"] },
    ]),
    "- check for test262 regressions — failing step: Compare against baseline ([job log](https://x/job/1))",
    "render: job + step + url",
  );
  eq(
    renderFailureLines([{ job: "quality", url: null, failedSteps: [] }]),
    "- quality — failing step: unknown",
    "render: unknown step, no url",
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
    gh(["api", `repos/${REPO}/actions/runs/${runId}`, "--jq", "{head_branch, head_sha, event, conclusion, name}"]),
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

  const jobs = annotateShutdownKills(fetchJobs(runId));
  const { realFailure, failedJobs, failedDetails, infraOnly, unclassifiable } = classifyRun(jobs);
  if (!realFailure) {
    console.log(
      `auto-park: run ${runId} (PR #${prNumber}) has 0 failed jobs of ${jobs.length} — CANCELLATION (queue rebuild), NOT parking.`,
    );
    process.exit(0);
  }
  const runUrl = `https://github.com/${REPO}/actions/runs/${runId}`;
  console.log(renderFailureLines(failedDetails));
  if (infraOnly) {
    // (#3597) Every failed step is a recognised setup/infra step, so the verdict
    // never ran — this is the #3566 shape (shard-artifact download 403'd) and a
    // park here would be bogus. The run is still red, so the queue ejects the PR
    // and `auto-enqueue` re-adds it; that retry is the correct response to a
    // transient infra failure.
    console.log(
      `auto-park: run ${runId} (PR #${prNumber}) failed ONLY in setup/infra steps — verdict never ran, NOT parking. See ${runUrl}`,
    );
    process.exit(0);
  }
  // #3914 — park EVERY PR in the failed group, not just the ref-named one. A
  // serial queue yields a single-member group, so this is a no-op today; under
  // `min_entries_to_merge > 1` it is what keeps the culprit from slipping back
  // into the queue while an innocent group-mate is held in its place.
  const groupPrs = prNumbersInGroup(baseShaFromQueueBranch(runJson.head_branch), runJson.head_sha, prNumber);
  console.log(
    `auto-park: run ${runId} (${runJson.name}) for group [${groupPrs.map((n) => `#${n}`).join(", ")}] has ${failedJobs.length} genuinely-failed job(s)` +
      `${unclassifiable ? " (at least one failing step unidentifiable — parking conservatively)" : ""} — parking.`,
  );
  for (const pr of groupPrs) park(pr, failedDetails, runUrl, groupPrs);
}
