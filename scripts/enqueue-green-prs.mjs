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
//   2. GRACE WINDOW — only enqueue a PR whose checks have all been green for at
//      least GRACE_MINUTES. DEFAULT IS NOW 0 (#2786): this workflow is the SINGLE
//      PRIMARY enqueuer (dev agents no longer self-enqueue), so there is no fresh
//      dev enqueue to race and no reason to wait. The `workflow_run`-on-completion
//      trigger fires right after the required-check workflows finish; with grace 0
//      every just-green PR is enqueued on that responsive run. (A non-zero grace
//      would make that run skip every fresh PR as "too fresh" and strand it until
//      the cron — the bug #2786 fixes.)
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

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = process.env.GH_REPO || "loopdive/js2wasm";
const DRY = process.argv.includes("--dry-run") || process.env.DRY_RUN === "1";
// GRACE default is now 0 (#2786): dev agents no longer self-enqueue, so there is
// no fresh dev GraphQL enqueue to race. A non-zero grace would make the responsive
// `workflow_run`-on-completion trigger SKIP every just-green PR (green-duration ~0
// < grace) — defeating the whole point of the responsive path and stranding the PR
// until the ~30-min cron. With grace 0 the workflow_run run (which starts ~60s after
// checks finish — enough for GitHub to settle mergeStateStatus to CLEAN) enqueues
// immediately. Override via GRACE_MINUTES env for manual sweeps if ever needed.
const GRACE_MINUTES = Number(process.env.GRACE_MINUTES ?? "0");
const GRACE_MS = GRACE_MINUTES * 60 * 1000;
export const HOLD_LABELS = new Set([
  "hold",
  "do-not-merge",
  "do not merge",
  "wip",
  "blocked",
  // Owned by passive-stack-retarget.yml from the base PATCH until an exact
  // base-integrated synchronize event. Never enqueue a stale pre-retarget head.
  "stack-retarget-pending",
]);
// mergeStateStatus values we will enqueue. Do NOT include UNSTABLE: that means
// required checks are green but a non-required check failed, which is exactly
// the state that allowed red PRs to enter the merge queue.
const ENQUEUEABLE = new Set(["CLEAN", "HAS_HOOKS"]);
const PASSING_CHECK_STATES = new Set(["pass", "skipping"]);

// ---------------------------------------------------------------------------
// #4094 — `[skip ci]`-ONLY DIVERGENCE EXEMPTION (stakeholder decision 2026-08-02)
//
// The loop this breaks (measured in #4093): a merge lands, a `[skip ci]` baseline
// commit follows (six in ~5.5h), every open PR goes BEHIND, ENQUEUEABLE excludes
// BEHIND, and the PRs are un-enqueueable until the refresh cron (~0.7/hour actual)
// catches up — often raced by the next baseline commit. A commit whose own message
// declares "this changes nothing needing testing" currently disqualifies every PR
// in flight.
//
// GitHub's ACCEPTED MARKER SET — verified 2026-08-02 against
// docs.github.com/en/actions/how-tos/manage-workflow-runs/skip-workflow-runs,
// NOT from memory. Two properties of that source matter and are easy to get wrong:
//   1. There are FIVE spellings, not one. This repo only ever emits `[skip ci]`,
//      so a predicate matching only that spelling passes every local test and is
//      still wrong in production the first time someone writes `[ci skip]`.
//   2. The doc says the string suppresses `on: push`/`on: pull_request` when added
//      "to the commit message" — anywhere in it, NOT first-line-only. Matching only
//      the subject would silently miss a marker in the body.
// ---------------------------------------------------------------------------
export const SKIP_CI_MARKERS = Object.freeze(["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]"]);

/** True when a single commit message carries any GitHub skip-CI marker. */
export function hasSkipCiMarker(message) {
  if (typeof message !== "string" || message.length === 0) return false;
  const m = message.toLowerCase();
  return SKIP_CI_MARKERS.some((marker) => m.includes(marker));
}

/**
 * #4094 — is a PR's divergence from main composed ONLY of `[skip ci]` commits?
 *
 * `messages` is the FULL commit message of every commit main is ahead by, from
 * the server-side compare API (never local refs — see `divergenceCommitMessages`).
 *
 * FAILS CLOSED, deliberately, in two distinct ways that are easy to conflate:
 *
 *   - `null`/non-array  ⇒ we could not SEE the divergence. Not exempt. A detector
 *     whose "cannot see" answer equals "nothing wrong" is unsound, and this one
 *     gates entry to the merge queue.
 *   - EMPTY array ⇒ ALSO not exempt. This is the silent-empty trap: "no commits
 *     matched" is indistinguishable from "the fetch returned nothing", and a PR
 *     that is genuinely BEHIND must be behind by at least one commit. So the
 *     count is FLOORED at 1 rather than treated as a vacuous all-true.
 *
 * Only a non-empty set in which EVERY message carries a marker is exempt.
 */
export function isSkipCiOnlyDivergence(messages) {
  if (!Array.isArray(messages)) return false;
  if (messages.length === 0) return false; // vacuous-truth guard, see above
  return messages.every((m) => hasSkipCiMarker(m));
}

// ---------------------------------------------------------------------------
// #4094 (re-scoped 2026-08-02) — DERIVE ELIGIBILITY FROM REAL SIGNALS.
//
// The original scope was a `[skip ci]`-only exemption to the BEHIND exclusion.
// Measurement killed that premise: `mergeStateStatus` does not track ancestry at
// all. Observed live, same minute:
//
//     PR #4033  mergeStateStatus=CLEAN     4 commits behind main
//     PR #4034  mergeStateStatus=UNSTABLE  0 commits behind main
//
// and the SAME PR (#4028) read BEHIND and UNSTABLE minutes apart with no push.
// The repo ruleset has `strict_required_status_checks_policy: true`, so a behind
// PR *should* report BEHIND — it doesn't, because the field is STALE: GitHub
// serves the last value it computed, not current ancestry. So today's enqueue
// outcome depends on when the sweep happens to look, which is a coin flip, not
// a policy.
//
// Behind-ness is also NOT disqualifying in fact: PRs #4002 (1 behind) and #4033
// (4 behind) were both sitting in the merge queue, put there by this very
// workflow. The queue builds merge groups against main, exactly as this script's
// own header asserts.
//
// So eligibility is derived from signals that mean what they say:
//   - required checks   → the checks API, by the ruleset's own context names
//   - conflicting-ness  → `mergeable` (MERGEABLE/CONFLICTING/UNKNOWN)
//   - behind-ness       → the compare API, and it does NOT disqualify
// and NEVER from `mergeStateStatus`.
//
// WHAT MUST SURVIVE THIS RE-SCOPE (#3878/#3904): the UNSTABLE exclusion existed
// because a red NON-required check must not reach the queue — that state once
// let red PRs in. Dropping the status string would silently drop that guard, so
// it is re-expressed directly and more precisely: ZERO checks of ANY kind may
// have a FAILURE conclusion, required or not. That is strictly stronger than
// keying on UNSTABLE, which is only a lagging summary of the same fact.
// ---------------------------------------------------------------------------

// The six required contexts (docs/ci-policy.md §7). Read from the ruleset at
// runtime by `requiredCheckNames`; this is the fallback when that read fails.
export const REQUIRED_CHECK_FALLBACK = Object.freeze([
  "cheap gate (main-ancestor + lint)",
  "quality",
  "merge shard reports",
  "equivalence-gate",
  "check for test262 regressions",
  "cla-check",
]);

/** Live required-check contexts from the branch ruleset, falling back if unreadable. */
export function requiredCheckNames(repo = REPO, runner = ghMaybe) {
  const res = runner([
    "api",
    `repos/${repo}/rules/branches/main`,
    "--jq",
    '[.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]',
  ]);
  if (!res.ok) return { names: [...REQUIRED_CHECK_FALLBACK], source: "fallback" };
  try {
    const parsed = JSON.parse(String(res.stdout || ""));
    if (Array.isArray(parsed) && parsed.length > 0) return { names: parsed, source: "ruleset" };
  } catch {
    /* fall through */
  }
  return { names: [...REQUIRED_CHECK_FALLBACK], source: "fallback" };
}

const PENDING_CHECK_STATES = new Set(["pending", "queued", "in_progress"]);

/**
 * #4094 — classify a PR's checks from real check rows (`{name, state}`).
 *
 * ⚠ A CHECK NAME IS NOT AN IDENTIFIER. Several names are published TWICE — the
 * real job and `test262-pr-stub.yml`'s stub both publish `merge shard reports`
 * and `check for test262 regressions`, and on PR #4002 one instance read `pass`
 * while the other read `skipping`. Taking the first match (`head -1`) is how a
 * watcher settles on the stub and calls a PR green that isn't. So EVERY instance
 * of a required name is considered, and the name is satisfied only when ALL of
 * its instances are pass/skipping.
 *
 * A `skipping` required check SATISFIES branch protection (a skipped job still
 * publishes a check run and the ruleset accepts it), so it counts as green here.
 */
export function classifyChecks(rows, requiredNames) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { green: false, reason: "no-checks-visible", failures: [], pendingRequired: [], missingRequired: [] };
  }
  const required = new Set(requiredNames);
  const failures = [];
  const pendingRequired = [];
  const seenRequired = new Set();
  for (const row of rows) {
    const name = String(row?.name ?? "").trim();
    const state = String(row?.state ?? "").trim();
    // Zero-FAILURE rule: applies to EVERY check, required or not (#3878/#3904).
    if (!PASSING_CHECK_STATES.has(state) && !PENDING_CHECK_STATES.has(state)) {
      failures.push(`${name}: ${state}`);
      continue;
    }
    if (!required.has(name)) continue;
    if (PENDING_CHECK_STATES.has(state)) pendingRequired.push(`${name}: ${state}`);
    else seenRequired.add(name);
  }
  const missingRequired = [...required].filter((n) => !seenRequired.has(n));
  if (failures.length > 0)
    return { green: false, reason: `failing:${failures.length}`, failures, pendingRequired, missingRequired };
  if (pendingRequired.length > 0)
    return {
      green: false,
      reason: `pending-required:${pendingRequired.length}`,
      failures,
      pendingRequired,
      missingRequired,
    };
  if (missingRequired.length > 0)
    return {
      green: false,
      // (#4094) WORDING IS LOAD-BEARING — do not shorten this to "stranded" or
      // imply a cause. Two very different mechanisms produce an absent required
      // context, and they have OPPOSITE remedies:
      //   - a dropped `synchronize` delivery — GitHub simply never dispatched the
      //     `pull_request` workflows for this head. Signature: ONLY the
      //     `pull_request_target` checks (`cla-check`, retarget) are present, and
      //     the contexts DID run on an earlier head. Remedy: push any commit.
      //   - a workflow-level `paths:` skip — no check run is ever created, on ANY
      //     head, so the context stays "Expected" forever. Remedy: fix the path
      //     filters (what `test262-pr-stub.yml` exists to prevent).
      // Measured 2026-08-02 on #4028: it looked like the second and was the FIRST
      // (its earlier heads ran `quality`), and a single retrigger commit cleared
      // it. Naming the wrong one sends someone editing path filters to chase a
      // GitHub delivery failure, so this reports the OBSERVATION and the
      // discriminator, never a diagnosis.
      reason: `required-not-reported:${missingRequired.length} [${missingRequired.slice(0, 3).join(", ")}] — no check run on THIS head; if they ran on an earlier head it is a dropped synchronize (push any commit), else check workflow path filters`,
      failures,
      pendingRequired,
      missingRequired,
    };
  return { green: true, reason: "all-required-green", failures, pendingRequired, missingRequired };
}

/**
 * #4094 — the eligibility decision, pure and exported so both controls are
 * unit-testable with no `gh` call and no queue mutation.
 *
 * SCOPE (issue #4094 constraint 1, unchanged by the re-scope): this decides
 * ELIGIBILITY ONLY. It updates/rebases no branch — the 2026-06-11 incident (17
 * bot-updated BEHIND PRs stranded in `action_required`) was caused by
 * *bot-updating branches*, a different mechanism; `ALLOW_UPDATE_BRANCH` is
 * untouched. Drafts, hold labels and the author-trust gate are also unchanged
 * and still applied by the caller.
 *
 * `mergeStateStatus` is deliberately NOT a parameter. It cannot be consulted
 * even by accident.
 */
export function enqueueEligibility({ checks, requiredNames, isDraft, labels = [], mergeable } = {}) {
  if (isDraft) return { eligible: false, reason: "draft" };
  const lowered = labels.map((l) => String(l?.name ?? l ?? "").toLowerCase());
  const held = lowered.find((l) => HOLD_LABELS.has(l));
  if (held) return { eligible: false, reason: `hold-label:${held}` };
  // Conflicting-ness from `mergeable`, never the status string. UNKNOWN means
  // GitHub has not finished computing the merge — fail closed, retry next sweep.
  if (mergeable === "CONFLICTING") return { eligible: false, reason: "conflicting" };
  if (mergeable !== "MERGEABLE") return { eligible: false, reason: `mergeable:${mergeable || "missing"}` };
  const verdict = classifyChecks(checks, requiredNames);
  if (!verdict.green) return { eligible: false, reason: verdict.reason, checks: verdict };
  // NOTE: behind-ness is deliberately absent. A PR behind main is eligible — the
  // queue builds its merge group against main and re-validates there.
  return { eligible: true, reason: "real-signals-green", checks: verdict };
}
// STALL SURFACING (#3584). How long a PR must sit BLOCKED with nothing failing
// and nothing pending before we stop calling it "in flight" and start calling it
// a suspected permanent stall. Deliberately generous: a false positive here
// trains people to ignore the signal, which is worse than a late true positive.
const STALL_MINUTES = Number(process.env.STALL_MINUTES ?? "15");
const STALL_MS = STALL_MINUTES * 60 * 1000;
// Applied to a PR classified `suspected-permanent`. NOT a hold label — it must
// never block anything; it exists so the stall is visible to a human/shepherd
// sweep and to `gh pr list --label`, instead of living only in a workflow log.
const STALL_LABEL = "needs-manual-enqueue";
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

/**
 * #4094 — the full commit messages of every commit `main` is ahead of `headOid` by,
 * read from the SERVER-SIDE compare API (never local refs: this checkout's remote
 * tracking refs are unreliable, and CI has no local main to compare against).
 *
 * ⚠ FIELD TRAP, measured 2026-08-02 on PR #4002. Called as `compare/<head>...main`,
 * GitHub reports `{ahead_by: 1, behind_by: 16, commits: [<1 entry>]}`. The
 * divergence we care about — what main has that the PR does not — is `ahead_by`
 * and the `commits` ARRAY. `behind_by` is the opposite direction (commits the PR
 * head has that main does not) and reading it as "how far behind the PR is" inverts
 * the test: #4002 would have looked 16 commits divergent when it was exactly one
 * `[skip ci]` baseline refresh. Issue #4094 phrases this as "every commit main is
 * ahead by", which is correct — but only `commits`/`ahead_by` express it.
 *
 * Returns `{ ok, messages, reason }`. `ok:false` ⇒ caller must NOT exempt.
 */
/**
 * #4094 — the AUTHORITATIVE head SHA, from the REST pull resource.
 *
 * ⚠ `gh pr view --json headRefOid` (and the GraphQL PR object generally) serves a
 * CACHED SAMPLE. Measured 2026-08-02 on #4028: `headRefOid` returned `d07a989e`
 * while the REST `.head.sha` was already `e24f4378` — one push stale.
 *
 * This is the worst failure shape available to this script, because it is
 * SILENT and internally consistent: check runs fetched for a stale SHA are all
 * genuinely real — complete, green, correctly reported — just for the wrong
 * commit. Nothing anywhere looks anomalous, and the eligibility verdict is
 * simply wrong. Three fields of this repo's PR view were found stale in one day
 * (`mergeStateStatus`, local tracking refs, `headRefOid`), so the rule is: for
 * anything load-bearing, read the specific REST resource.
 */
export function authoritativeHeadSha(prNumber, repo = REPO, runner = ghMaybe) {
  const res = runner(["api", `repos/${repo}/pulls/${prNumber}`, "--jq", ".head.sha"]);
  if (!res.ok) return { ok: false, sha: null, reason: "rest-head-unavailable" };
  const sha = String(res.stdout || "").trim();
  if (!/^[0-9a-f]{40}$/.test(sha)) return { ok: false, sha: null, reason: "rest-head-shape" };
  return { ok: true, sha, reason: "rest" };
}

/**
 * #4094 — reconcile the cached PR-view SHA against the authoritative REST one.
 *
 * FAILS CLOSED both ways. If REST is unreadable we do not fall back to the
 * cached value (that would reinstate exactly the bug). If the two DISAGREE the
 * head moved under the sweep, so every check verdict already computed is about
 * the wrong commit — skip this PR and let the next sweep see a consistent world.
 */
export function reconcileHeadSha(viewSha, rest) {
  if (!rest || rest.ok !== true) return { ok: false, sha: null, reason: rest?.reason || "rest-head-missing" };
  if (viewSha && viewSha !== rest.sha) {
    return {
      ok: false,
      sha: rest.sha,
      reason: `head-sha-stale (view=${String(viewSha).slice(0, 9)} rest=${rest.sha.slice(0, 9)})`,
    };
  }
  return { ok: true, sha: rest.sha, reason: "head-sha-agreed" };
}

export function divergenceCommitMessages(headOid, repo = REPO, runner = ghMaybe) {
  if (!headOid) return { ok: false, messages: null, reason: "no-head-oid" };
  // Reduce to a JSON ARRAY and parse it — do NOT split raw --jq output on newlines.
  // Commit messages are multi-line, and a marker is valid ANYWHERE in the message
  // (verified against GitHub's docs above), so line-splitting would tear a
  // body-borne marker away from its own commit and silently mis-classify it.
  const res = runner(["api", `repos/${repo}/compare/${headOid}...main`, "--jq", "[.commits[].commit.message]"]);
  if (!res.ok) return { ok: false, messages: null, reason: "compare-api-failed" };
  let messages;
  try {
    messages = JSON.parse(String(res.stdout || ""));
  } catch {
    return { ok: false, messages: null, reason: "compare-api-unparseable" };
  }
  if (!Array.isArray(messages)) return { ok: false, messages: null, reason: "compare-api-shape" };
  return { ok: true, messages, reason: `commits:${messages.length}` };
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

// A queued PR must stay completely outside the enqueue path, but an old
// `needs-manual-enqueue` label must not linger after a human has rescued it.
// Keep that informational cleanup on the already-queued skip edge: removing an
// issue label does not change queue membership or rebuild the forming merge
// group. The cleanup callback is injected so this wiring is regression-testable
// without any `gh` calls. Cleanup is best-effort and can never turn a queued PR
// back into an enqueue candidate.
export function reconcileAlreadyQueued(prNumber, queued, labels, clearLabel, dryRun = false) {
  if (isTrailingAddCandidate(prNumber, queued)) return false;
  const hasStaleLabel = labels.some((label) => String(label?.name ?? label).toLowerCase() === STALL_LABEL);
  if (hasStaleLabel && !dryRun) {
    try {
      clearLabel(prNumber);
    } catch {
      // Label hygiene must never weaken the no-re-touch invariant.
    }
  }
  return true;
}

// Exact last-moment guard used immediately before enqueuePullRequest. The main
// sweep snapshot can predate a passive stack retarget: the child may have moved
// from its stack parent to main and acquired stack-retarget-pending while this
// run was doing slower check/history reads. Re-reading these fields closes that
// stale-snapshot window. Pure/exported for deterministic self-check coverage.
export function freshEnqueueGuard(initial, fresh) {
  if (!fresh || fresh.number !== initial?.number) return { ok: false, reason: "fresh-pr-missing" };
  if (fresh.headRefOid !== initial.headRefOid || fresh.headRefName !== initial.headRefName) {
    return { ok: false, reason: "head-changed-during-sweep" };
  }
  if (fresh.baseRefName !== "main") return { ok: false, reason: `base:${fresh.baseRefName || "missing"}` };
  if (fresh.isDraft) return { ok: false, reason: "draft" };
  const labels = (fresh.labels || []).map((label) => String(label?.name || "").toLowerCase());
  if (labels.some((label) => HOLD_LABELS.has(label))) {
    return { ok: false, reason: "hold-label" };
  }
  // (#4094) Was `!ENQUEUEABLE.has(fresh.mergeStateStatus)`. That re-read the same
  // STALE field the sweep had already stopped trusting, so a PR could clear the
  // real-signal gate and then be rejected here by a status GitHub had not
  // recomputed — the freshness re-check turning into a second coin flip. The
  // genuine freshness questions (head moved, base changed, draft, hold) are all
  // above and unchanged; conflicting-ness is the only merge fact left, and it
  // comes from `mergeable`.
  if (fresh.mergeable === "CONFLICTING") return { ok: false, reason: "conflicting" };
  return { ok: true, reason: "exact-fresh-candidate" };
}

// TRANSIENT vs PERMANENT `BLOCKED` (#3584). `mergeStateStatus` is computed
// RELATIVE TO THE QUERYING TOKEN: `BLOCKED` does not mean "this PR is not
// ready", it means "*you* cannot merge this PR right now". The sweep skips every
// non-ENQUEUEABLE state with one identical `skip (BLOCKED)` line, which conflates
// two completely different situations:
//
//   TRANSIENT  — a required check has not reported yet. Resolves on its own;
//                the next workflow_run sweep enqueues the PR. The overwhelmingly
//                common case, and correctly silent.
//   PERMANENT  — the PR is green and will never leave BLOCKED *for this token*.
//                Nothing in the pipeline recovers it: the ~30-min cron re-derives
//                the same state with the same token, no `hold` label is applied,
//                no check is red. The PR just sits, indefinitely, looking fine.
//
// MEASURED (2026-07-31), stating separately what is observed and what is not:
//   OBSERVED — the failing cell is fork-head AND touching `.github/workflows/**`.
//     4/4 such PRs needed a human PAT enqueue (#3567, #3590, #3602, #3609);
//     #3567 was still BLOCKED to the app token after 6h45m green. Every other
//     cell auto-enqueues: fork-head without workflow files (#3887/#3889/#3890,
//     enqueued by js2-merge-queue-bot) and upstream-head with workflow files
//     (#3690/#3843/#3833). The `js2-merge-queue-bot` app installation holds
//     actions/checks/contents/issues/metadata/pull_requests and NOT `workflows`.
//   NOT MEASURED — *why* that cell fails. "The token lacks `workflows` and a
//     fork head is treated differently from a same-repo head" is a plausible
//     reconstruction fitted to the counts above; it has not been tested. So this
//     classifier deliberately does NOT test for fork-head or for workflow paths,
//     and reports a SUSPICION rather than a diagnosis. It keys only on the
//     observable that is actually load-bearing: BLOCKED, nothing red, nothing
//     pending, sustained.
//
// Pure + exported so the transient/permanent split is unit-testable with no
// `gh` call. FAIL-QUIET: anything unknown (checks unreadable, no green
// timestamp) classifies as `transient`, i.e. today's silent behaviour — this
// helper can only ever add a log line, never change an enqueue decision.
export function classifyBlockedSkip(
  { mergeStateStatus, failed, pending, checksError, greenAgeMs } = {},
  stallMs = STALL_MS,
) {
  if (mergeStateStatus !== "BLOCKED") return { suspected: false, reason: `not-blocked:${mergeStateStatus}` };
  if (checksError) return { suspected: false, reason: "checks-unreadable" };
  if (!Array.isArray(failed) || !Array.isArray(pending)) return { suspected: false, reason: "checks-unreadable" };
  if (failed.length > 0) return { suspected: false, reason: `failing-checks:${failed.length}` };
  // A PR whose checks are merely slow must NEVER trip this. Two independent
  // guards: no visible check may be pending, AND the newest check completion
  // must be at least `stallMs` old (a check that starts after this sweep resets
  // that age on the next one).
  if (pending.length > 0) return { suspected: false, reason: `pending-checks:${pending.length}` };
  if (!Number.isFinite(greenAgeMs)) return { suspected: false, reason: "no-green-timestamp" };
  if (greenAgeMs < stallMs) return { suspected: false, reason: `green-only-${Math.round(greenAgeMs / 60000)}m` };
  return { suspected: true, reason: `green-${Math.round(greenAgeMs / 60000)}m-still-blocked` };
}

export function enqueueMutationVariables(pullRequestId, expectedHeadOid) {
  if (typeof pullRequestId !== "string" || pullRequestId === "") {
    throw new Error("pull request node ID is required");
  }
  if (typeof expectedHeadOid !== "string" || !/^[0-9a-f]{40}$/i.test(expectedHeadOid)) {
    throw new Error("expected head OID must be a 40-character hex SHA");
  }
  return { id: pullRequestId, expectedHeadOid };
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
      // (#4094) `mergeable` added: conflicting-ness now comes from this field,
      // never from the stale `mergeStateStatus` summary.
      "number,mergeStateStatus,mergeable,isDraft,labels,id,title,headRefName,headRefOid,baseRefName,author,headRepositoryOwner",
    ]),
  );
}

function freshPrForEnqueue(number) {
  return JSON.parse(
    gh([
      "pr",
      "view",
      String(number),
      "--repo",
      REPO,
      "--json",
      "number,mergeStateStatus,mergeable,isDraft,labels,headRefName,headRefOid,baseRefName",
    ]),
  );
}

// AUTHOR-TRUST GATE (#2549). `gh pr list --json` cannot return authorAssociation
// (unsupported field in gh 2.23 — it errors "Unknown JSON field"), so fetch it
// for all open PRs in one GraphQL page and return a { prNumber -> assoc } map.
// `authorAssociation` is OWNER / MEMBER / COLLABORATOR / CONTRIBUTOR /
// FIRST_TIME_CONTRIBUTOR / FIRST_TIMER / MANNEQUIN / NONE (the actor's relation
// to the BASE repo, loopdive/js2wasm). A number missing from the map (e.g. >100 open
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
    return { failed: [], pending: [], rows: [], error: msg };
  }

  const failed = [];
  const pending = [];
  // (#4094) Every parsed row, kept so `classifyChecks` can verify the REQUIRED
  // contexts are actually PRESENT. "nothing failed and nothing pending" is not
  // the same statement as "the required checks ran" — a PR whose required jobs
  // never reported at all satisfies the former and must still not be enqueued.
  const rows = [];
  let parsed = 0;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cols = line.split("\t");
    if (cols.length < 2) continue;
    parsed++;
    const name = cols[0].trim();
    const state = cols[1].trim();
    rows.push({ name, state });
    if (PASSING_CHECK_STATES.has(state)) continue;
    const entry = `${name}: ${state}`;
    if (state === "pending" || state === "queued" || state === "in_progress") {
      pending.push(entry);
    } else {
      failed.push(entry);
    }
  }
  if (parsed === 0) return { failed: [], pending: [], rows: [], error: "no parseable checks" };

  return { failed, pending, rows, error: null };
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
export function isWorkflowPermissionRefusal(msg) {
  if (typeof msg !== "string") return false;
  return /refusing to allow a GitHub App to create or update workflow/i.test(msg);
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

// STALL LABEL PLUMBING (#3584). `needs-manual-enqueue` is informational: it is
// deliberately absent from HOLD_LABELS so it can never block an enqueue. Both
// helpers are FAIL-SAFE — a labelling hiccup returns a reason string and the
// sweep carries on; the warning log line is emitted either way, so the signal
// is never lost just because the label could not be written.
function prLabels(prNumber) {
  const res = ghMaybe(["pr", "view", String(prNumber), "--repo", REPO, "--json", "labels", "-q", ".labels[].name"]);
  if (!res.ok) return null;
  return res.stdout
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}
function addStallLabel(prNumber) {
  const existing = prLabels(prNumber);
  if (existing === null) return { ok: false, why: "labels-unreadable" };
  if (existing.includes(STALL_LABEL)) return { ok: true, why: "already-labelled" };
  // Create-if-missing first: adding an unknown label name is a 422, and the repo
  // may not have this label yet. `already_exists` is the expected no-op.
  ghMaybe([
    "api",
    "--method",
    "POST",
    `repos/${REPO}/labels`,
    "-f",
    `name=${STALL_LABEL}`,
    "-f",
    "color=d93f0b",
    "-f",
    "description=Green but never auto-enqueued; needs a one-shot manual enqueue (#3584)",
  ]);
  const add = ghMaybe([
    "api",
    "--method",
    "POST",
    `repos/${REPO}/issues/${prNumber}/labels`,
    "-f",
    `labels[]=${STALL_LABEL}`,
  ]);
  if (!add.ok) return { ok: false, why: (add.stderr || "add-label failed").split("\n")[0].slice(0, 100) };
  return { ok: true, why: "labelled" };
}
// Called after a successful enqueue so the label cannot rot on a PR that later
// went through normally. Silent no-op when the label is absent.
function clearStallLabel(prNumber) {
  const existing = prLabels(prNumber);
  if (existing === null || !existing.includes(STALL_LABEL)) return;
  ghMaybe(["api", "--method", "DELETE", `repos/${REPO}/issues/${prNumber}/labels/${STALL_LABEL}`]);
}

// STALL DIAGNOSIS (#3584) — the impure wrapper around classifyBlockedSkip().
// Returns { suspected, reason, annotated } where `annotated` is the string that
// goes in the existing `skip (...)` line, so a reader can tell the two kinds of
// BLOCKED apart without cross-referencing anything.
//
// COST CONTROL: a non-BLOCKED state returns immediately with no API call, so
// BEHIND/DIRTY/UNKNOWN PRs stay as cheap as they were. Only BLOCKED PRs pay one
// `gh pr checks` + one GraphQL rollup read — the same two reads a *candidate*
// PR already pays further down the loop.
//
// FAIL-SAFE: every failure path yields `suspected: false`, i.e. exactly today's
// silent behaviour. This can never strand a PR and never enqueues anything.
// Exported (despite being impure) so the wiring — not just the pure classifier —
// can be smoke-tested against a real PR: `blockedDiagnosis({...realPr,
// mergeStateStatus:"BLOCKED"}, new Map())`. Importing this module runs no `gh`
// call (see the main-module guard at the bottom).
export function blockedDiagnosis(pr, authorAssoc) {
  const state = pr.mergeStateStatus;
  if (state !== "BLOCKED") return { suspected: false, reason: "", annotated: state };
  // Do not label a stranger's PR: an external PR is *supposed* to require a
  // deliberate human enqueue (#2549), so "needs manual enqueue" is not news.
  const trust = isTrustedAuthor({
    assoc: authorAssoc.get(pr.number) || "UNKNOWN",
    authorLogin: pr.author?.login,
    headRepoOwner: pr.headRepositoryOwner?.login,
  });
  if (!trust.trusted) return { suspected: false, reason: "", annotated: state };

  const checks = visibleCheckState(pr.number);
  let greenAgeMs = Number.NaN;
  try {
    const green = greenSince(pr.number);
    if (green) greenAgeMs = green.ageMs;
  } catch {
    greenAgeMs = Number.NaN; // fail-safe -> classified transient
  }
  const verdict = classifyBlockedSkip({
    mergeStateStatus: state,
    failed: checks.failed,
    pending: checks.pending,
    checksError: checks.error,
    greenAgeMs,
  });
  return {
    suspected: verdict.suspected,
    reason: verdict.reason,
    // Deliberately hedged wording. We have measured WHICH PRs stall, not WHY;
    // stating a cause here would launder a reconstruction into a diagnosis.
    annotated: verdict.suspected
      ? `BLOCKED — SUSPECTED PERMANENT (${verdict.reason}); this will not self-resolve, a one-shot manual enqueue is needed`
      : `BLOCKED — transient (${verdict.reason})`,
  };
}

// PARK-RACE GUARD (#2975). auto-enqueue (this script, primary enqueuer since
// #2786, grace 0) and auto-park (#2547) both react to the same failed
// `merge_group` run. When a PR fails merge_group re-validation GitHub removes it
// from the queue; auto-park then adds the `hold` label — but ~5-16s later. In
// that gap this sweep still sees the PR as CLEAN + green + un-`hold`-labelled and
// re-adds it, wasting one full doomed 57-shard merge_group run (and the re-add
// can reshuffle/cancel entries behind it). Deriving the park decision from the
// LABEL loses the race; deriving it from the same FAILED-RUN signal auto-park
// uses does not (issue direction (a), the "race-free" one).
//
// Parse a merge-queue synthetic branch `gh-readonly-queue/<base>/pr-<N>-<sha>`
// into its PR number (mirrors prNumberFromQueueBranch in
// auto-park-merge-group-failure.mjs). Returns null for any non-queue branch, so
// a stray run can never be attributed to a PR. Pure + exported for unit tests.
export function prNumberFromMergeQueueBranch(branch) {
  if (typeof branch !== "string") return null;
  const m = branch.match(/^gh-readonly-queue\/[^/]+\/pr-(\d+)-[0-9a-f]+$/);
  return m ? Number(m[1]) : null;
}

// #3914 — the group's BASE sha from the same ref (mirrors
// baseShaFromQueueBranch in auto-park-merge-group-failure.mjs). `pr-<N>` names
// only the LAST entry in the group, so under a batched queue
// (`min_entries_to_merge > 1`) the branch alone under-reports which PRs a
// failed run implicates. Pure + exported for unit tests.
export function baseShaFromMergeQueueBranch(branch) {
  if (typeof branch !== "string") return null;
  const m = branch.match(/^gh-readonly-queue\/[^/]+\/pr-\d+-([0-9a-f]{7,40})$/);
  return m ? m[1] : null;
}

// #3914 — every PR number named by a merge group's commit subjects (mirrors
// prNumbersFromCommitSubjects in auto-park-merge-group-failure.mjs). Pure +
// exported for unit tests.
export function prNumbersFromMergeGroupSubjects(subjects) {
  const found = [];
  for (const raw of subjects || []) {
    if (typeof raw !== "string") continue;
    const subject = raw.split("\n", 1)[0];
    const m = subject.match(/^Merge pull request #(\d+)\b/) || subject.match(/\(#(\d+)\)\s*$/);
    if (m) {
      const n = Number(m[1]);
      if (!found.includes(n)) found.push(n);
    }
  }
  return found;
}

// Pure park-race decision. Skip a candidate PR ONLY when it has a genuine recent
// merge_group failure AND no human removed a `hold` label AFTER that failure
// (i.e. nobody has deliberately re-admitted it). A later hold-removal means a
// human/agent intentionally re-admitted the PR, so it must get its one prompt
// re-admission (acceptance criterion 2). Exported for unit tests.
export function shouldSkipParkingRace({ mergeGroupFailedAtMs, holdRemovedAtMs } = {}) {
  if (!mergeGroupFailedAtMs) return false; // no failure signal -> enqueue as usual
  if (holdRemovedAtMs && holdRemovedAtMs > mergeGroupFailedAtMs) return false; // re-admitted
  return true; // genuinely failed and not re-admitted -> let auto-park hold it
}

// FAIL-SAFE by design (#2975): every live helper below returns the value that
// makes the sweep fall back to CURRENT behavior (enqueue) on ANY error. So a bug
// or API hiccup here can only ever FAIL TO SKIP (= today's behavior, which
// auto-park still catches) — it can NEVER wrongly strand a good PR.

// Map<prNumber, failedAtMs> of PRs with a RECENT, GENUINE merge_group failure.
// "Genuine" mirrors auto-park's real-vs-cancellation guard: a run-level failure
// can be a mere cancellation (membership change re-groups and cancels in-flight
// runs — 0 failed jobs), so we require >= 1 job with conclusion "failure".
function recentMergeGroupFailures({ windowMinutes = 30, maxRuns = 40 } = {}) {
  const out = new Map();
  try {
    const cutoff = Date.now() - windowMinutes * 60 * 1000;
    // Use the REST API (via `gh api`), NOT `gh run list --event/--status`: those
    // CLI flags do not exist in gh 2.23 (the container), whereas the REST
    // `event`/`status` query params work across every gh version — and let this
    // be validated locally. `--jq` compacts to a single JSON array.
    const res = ghMaybe([
      "api",
      `repos/${REPO}/actions/runs?event=merge_group&per_page=${maxRuns}`,
      "--jq",
      '[.workflow_runs[] | select(.conclusion == "failure") | {id: .id, headBranch: .head_branch, headSha: .head_sha, updatedAt: .updated_at}]',
    ]);
    if (!res.ok) return out; // fail-safe: no failures known -> enqueue as usual
    let runs;
    try {
      runs = JSON.parse(res.stdout);
    } catch {
      return out;
    }
    if (!Array.isArray(runs)) return out;
    for (const run of runs) {
      const whenMs = Date.parse(run.updatedAt);
      if (!Number.isFinite(whenMs) || whenMs < cutoff) continue; // stale / unparseable
      const prNumber = prNumberFromMergeQueueBranch(run.headBranch);
      if (!prNumber) continue;
      // Keep only the most-recent failure per PR; skip the job probe if we
      // already recorded a newer one.
      const existing = out.get(prNumber);
      if (existing && existing >= whenMs) continue;
      if (!runHasFailedJob(run.id)) continue; // cancellation, not a real failure
      // #3914 — attribute the failure to EVERY PR in the group, not just the
      // ref-named last entry. On a serial queue the group has one member and
      // this resolves to [prNumber], unchanged. Under `min_entries_to_merge >
      // 1`, skipping this would leave N-1 members looking un-failed, so the
      // sweep would immediately re-add them into the #2975 park race — the
      // very thing this guard exists to prevent, multiplied by the batch size.
      // The compare call only fires for runs already confirmed genuinely
      // failed (a small subset), and is fail-safe to [prNumber].
      for (const pr of mergeGroupMemberPrs(run, prNumber)) {
        const prior = out.get(pr);
        if (!prior || prior < whenMs) out.set(pr, whenMs);
      }
    }
  } catch {
    return new Map(); // fail-safe
  }
  return out;
}

// #3914 — the PR numbers a failed merge_group run implicates. Reads the group's
// commit range (base sha from the queue ref .. the run's head sha) and pulls the
// PR number out of each commit subject. FAIL-SAFE to `[fallbackPr]` on any
// error, missing field, or empty result, so this can only ever widen the guard,
// never narrow it below today's behaviour.
function mergeGroupMemberPrs(run, fallbackPr) {
  try {
    const baseSha = baseShaFromMergeQueueBranch(run.headBranch);
    const headSha = run.headSha;
    if (!baseSha || !headSha) return [fallbackPr];
    const res = ghMaybe(["api", `repos/${REPO}/compare/${baseSha}...${headSha}`, "--jq", ".commits[].commit.message"]);
    if (!res.ok) return [fallbackPr];
    const found = prNumbersFromMergeGroupSubjects(res.stdout.split(/\r?\n/).filter(Boolean));
    if (!found.includes(fallbackPr)) found.push(fallbackPr);
    return found;
  } catch {
    return [fallbackPr];
  }
}

// True iff the run has >= 1 job that concluded "failure" (a genuine shard/check
// failure, not a whole-run cancellation). Uses the REST jobs endpoint (`gh api`)
// for cross-gh-version stability. Fail-safe: on any error return false so an
// unreadable run is treated as NOT a genuine failure (enqueue as usual).
function runHasFailedJob(runId) {
  try {
    const res = ghMaybe([
      "api",
      `repos/${REPO}/actions/runs/${runId}/jobs`,
      "--jq",
      '[.jobs[] | select(.conclusion == "failure")] | length',
    ]);
    if (!res.ok) return false;
    return Number(res.stdout.trim()) > 0;
  } catch {
    return false;
  }
}

// Timestamp (ms) of the most recent `hold`-label REMOVAL on the PR, or 0 if
// none. A removal after a merge_group failure means someone deliberately
// re-admitted the PR (see shouldSkipParkingRace). Fail-safe: on any error return
// Infinity so the caller treats the PR as "re-admitted" and enqueues as usual
// (never strands a PR because the timeline read hiccupped).
function holdLabelRemovedAtMs(prNumber) {
  try {
    const res = ghMaybe([
      "api",
      "--paginate",
      `repos/${REPO}/issues/${prNumber}/timeline`,
      "-q",
      '[.[] | select(.event == "unlabeled" and .label.name == "hold") | .created_at] | last // empty',
    ]);
    if (!res.ok) return Number.POSITIVE_INFINITY; // fail-safe -> treat as re-admitted
    const ts = res.stdout.trim();
    if (!ts) return 0; // no hold removal recorded
    const ms = Date.parse(ts);
    return Number.isFinite(ms) ? ms : Number.POSITIVE_INFINITY;
  } catch {
    return Number.POSITIVE_INFINITY; // fail-safe
  }
}

// The live sweep is wrapped in runSweep() and only invoked when this file is
// run as the main module (see the import.meta.url guard at the bottom). That
// keeps `import { isTrustedAuthor } from "./enqueue-green-prs.mjs"` side-effect
// free so the gate can be unit-tested without making any `gh` calls.
function runSweep() {
  const { queued: inQueue, forming } = mergeQueueSnapshot();
  // PARK-RACE GUARD (#2975): PRs with a genuine recent merge_group failure that
  // are being (or should be) parked. Computed ONCE per sweep. Fail-safe: empty
  // on any error, so the sweep behaves exactly as before.
  const mergeGroupFailures = recentMergeGroupFailures();

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
  // (#4094) The required contexts, read from the branch ruleset itself so this
  // never drifts from `docs/ci-policy.md` (`linear-tests` was documented as
  // required for months and never was — #3934). Falls back to the static list.
  const requiredInfo = requiredCheckNames();
  const REQUIRED_NAMES = requiredInfo.names;
  const enqueued = [];
  const skipped = [];
  const updated = [];
  const manualEnqueue = [];
  const stalled = []; // #3584 — BLOCKED, nothing red, nothing pending, sustained
  const refusals = []; // #4094 — raw enqueue-mutation refusals, kept as telemetry

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
    if (reconcileAlreadyQueued(pr.number, inQueue, pr.labels || [], clearStallLabel, DRY)) {
      skipped.push([pr.number, "already-queued"]);
      continue;
    }
    // (#4094) REAL-SIGNAL GATE. This used to be `!ENQUEUEABLE.has(mergeStateStatus)`.
    // That field is a STALE SAMPLE, not current state — measured 2026-08-02, PR
    // #4033 read CLEAN while 4 commits behind and #4034 read UNSTABLE while 0
    // behind, and #4028 read BEHIND then UNSTABLE minutes apart with no push. So
    // eligibility now comes from draft / hold labels / `mergeable`, and from the
    // checks API below. Behind-ness deliberately does NOT disqualify: the queue
    // builds merge groups against main (#4002, 1 behind, and #4033, 4 behind,
    // were both queued and #4002 merged with a green merge_group re-validation).
    const gate = enqueueEligibility({
      checks: null, // checks are evaluated below, after the author-trust gate
      requiredNames: REQUIRED_NAMES,
      isDraft: pr.isDraft,
      labels: pr.labels,
      mergeable: pr.mergeable,
    });
    if (!gate.eligible && gate.reason !== "no-checks-visible") {
      // STALL SURFACING (#3584) — unchanged in intent. Best-effort: it changes no
      // enqueue decision, it only decides how loudly we log.
      const diag = blockedDiagnosis(pr, authorAssoc);
      if (diag.suspected) {
        const label = DRY ? { ok: true, why: "would-label" } : addStallLabel(pr.number);
        stalled.push([pr.number, `${diag.reason}; ${label.why}`]);
      }
      skipped.push([pr.number, `${gate.reason} (${diag.annotated})`]);
      continue;
    }
    // PARK-RACE GUARD (#2975). A PR that just FAILED merge_group re-validation is
    // removed from the queue but stays CLEAN + green, so it reaches here in the
    // ~5-16s before auto-park's `hold` label lands. Re-adding it wastes a full
    // doomed merge_group run. Skip it when it has a genuine recent merge_group
    // failure AND nobody removed a `hold` after that failure (a later removal is a
    // deliberate re-admission — honour it). Only PRs in the (usually empty)
    // failure map pay the timeline read. Fail-safe: any error above yields no
    // failure / a re-admit sentinel, so this never wrongly strands a PR.
    const failedAtMs = mergeGroupFailures.get(pr.number);
    if (
      failedAtMs &&
      shouldSkipParkingRace({ mergeGroupFailedAtMs: failedAtMs, holdRemovedAtMs: holdLabelRemovedAtMs(pr.number) })
    ) {
      skipped.push([
        pr.number,
        `merge_group-failure — awaiting auto-park hold (failed ${new Date(failedAtMs).toISOString()})`,
      ]);
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
    // (#4094) The required contexts must be PRESENT, not merely non-failing. The
    // two guards above answer "did anything fail or is anything pending"; neither
    // notices a PR whose required jobs never reported at all. `classifyChecks`
    // also handles the name collision: `merge shard reports` and `check for
    // test262 regressions` are each published TWICE (real job + the #3934 stub),
    // so a first-match read can settle on the stub.
    //
    // SHA STALENESS (measured 2026-08-02): `gh pr view --json headRefOid` can
    // serve a SHA the push has already superseded — the authoritative read is
    // `gh api repos/<repo>/pulls/<N> --jq .head.sha`. That matters here because a
    // predicate keyed on "check runs for a SHA" produces a CONFIDENT WRONG
    // verdict on a stale one: the runs it finds are all genuinely real, just for
    // the wrong head. This path is fail-SAFE rather than fail-wrong only because
    // the enqueue mutation pins `expectedHeadOid` — a stale SHA is refused by
    // GitHub (captured as refusal telemetry) instead of enqueueing the wrong
    // state, and `freshEnqueueGuard` independently rejects a moved head.
    const required = classifyChecks(checks.rows, REQUIRED_NAMES);
    if (!required.green) {
      skipped.push([pr.number, `required-not-green: ${required.reason}`]);
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

    // FINAL EXACT GUARD. Everything above used the sweep's initial open-PR
    // snapshot. A passive stack retarget can add its pending label and change
    // the PR base while those checks are running. Re-read immediately before
    // enqueue, require the same head + main base + no hold, then re-read checks
    // on that exact head. This prevents an already-running sweep from enqueueing
    // the child's stale pre-retarget greens.
    let fresh;
    try {
      fresh = freshPrForEnqueue(pr.number);
    } catch (e) {
      const msg = String(e.stderr || e.message || e)
        .split("\n")[0]
        .slice(0, 120);
      skipped.push([pr.number, `fresh-pr-unavailable: ${msg}`]);
      continue;
    }
    const exact = freshEnqueueGuard(pr, fresh);
    if (!exact.ok) {
      skipped.push([pr.number, `fresh-guard:${exact.reason}`]);
      continue;
    }
    // (#4094) Pin the AUTHORITATIVE head before anything keyed on a SHA. `fresh`
    // came from `gh pr view`, whose `headRefOid` can be one push stale — and the
    // check runs fetched for a stale SHA are all genuinely real, just for the
    // wrong commit, so the verdict is wrong with no anomaly to notice. Fails
    // closed: unreadable REST, or REST disagreeing with the view, both skip.
    const headCheck = reconcileHeadSha(fresh.headRefOid, authoritativeHeadSha(pr.number));
    if (!headCheck.ok) {
      skipped.push([pr.number, `head-sha:${headCheck.reason}`]);
      continue;
    }
    const headSha = headCheck.sha;
    const exactChecks = visibleCheckState(pr.number);
    if (exactChecks.error) {
      skipped.push([pr.number, `fresh-checks-unavailable: ${exactChecks.error}`]);
      continue;
    }
    if (exactChecks.failed.length > 0) {
      skipped.push([pr.number, `fresh-failing-checks: ${exactChecks.failed.slice(0, 5).join(", ")}`]);
      continue;
    }
    if (exactChecks.pending.length > 0) {
      skipped.push([pr.number, `fresh-pending-checks: ${exactChecks.pending.slice(0, 5).join(", ")}`]);
      continue;
    }

    if (DRY) {
      enqueued.push([pr.number, `would-enqueue (green ${ageMin}m >= ${GRACE_MINUTES}m grace)`]);
      continue;
    }
    try {
      graphql(
        `
          mutation ($id: ID!, $expectedHeadOid: GitObjectID!) {
            enqueuePullRequest(input: { pullRequestId: $id, expectedHeadOid: $expectedHeadOid }) {
              clientMutationId
            }
          }
        `,
        enqueueMutationVariables(pr.id, headSha),
      );
      // (#4094) TELEMETRY, not a decision. Record how far behind main this PR was
      // when it was accepted, and whether that divergence was skip-CI-only. This
      // is the evidence base for the re-scope itself: it shows, per enqueue,
      // whether admitting behind PRs is routine or exceptional. Best-effort — a
      // failed compare read must never affect an enqueue that already succeeded.
      let behindNote = "";
      try {
        const div = divergenceCommitMessages(headSha);
        if (div.ok) {
          const n = div.messages.length;
          behindNote =
            n === 0 ? ", up-to-date" : `, behind=${n}${isSkipCiOnlyDivergence(div.messages) ? " (skip-ci only)" : ""}`;
        }
      } catch {
        /* telemetry only */
      }
      enqueued.push([pr.number, `enqueued (green ${ageMin}m${behindNote})`]);
      // #3584: a PR flagged on an earlier sweep and enqueued now was a false
      // positive (or was rescued); drop the label so it cannot rot and dilute
      // the signal. No-op when the label is absent.
      clearStallLabel(pr.number);
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
        // (#4094) MUTATION-REFUSAL TELEMETRY. The one question STEP 0 could not
        // settle without mutating is whether GitHub ever refuses `enqueuePullRequest`
        // for a PR that is behind main. Rather than manufacture that state, capture
        // the RAW error here and degrade to skip: production answers it, and a
        // refusal costs one sweep instead of a stranding. Recorded verbatim (not
        // pattern-matched) so an unanticipated refusal reason is still legible.
        //
        // WORKFLOW-FILE BLOCK (2026-08-19, #4046): for fork-head PRs that touch
        // `.github/workflows/**`, the app can be blocked at enqueue time with an
        // exact message. That mode is permanent for this token, so add the
        // `needs-manual-enqueue` visibility signal the same as #3584's stall.
        if (isWorkflowPermissionRefusal(msg)) {
          const label = DRY ? { ok: true, why: "would label needs-manual-enqueue" } : addStallLabel(pr.number);
          const enriched = `workflow-permission: ${msg}; manual-label:${label.why}`;
          manualEnqueue.push([pr.number, enriched]);
          refusals.push([pr.number, enriched]);
          skipped.push([pr.number, enriched]);
          continue;
        }
        refusals.push([pr.number, msg]);
        skipped.push([pr.number, `enqueue-failed: ${msg}`]);
      }
    }
  }

  console.log(
    `enqueue-green-prs: ${prs.length} open, ${inQueue.size} already queued, grace=${GRACE_MINUTES}m${DRY ? " (DRY RUN)" : ""}`,
  );
  console.log(`enqueue-green-prs: required checks (${requiredInfo.source}): ${REQUIRED_NAMES.join(", ")}`);
  for (const [n, why] of updated) console.log(`  ~ #${n} ${why}`);
  for (const [n, why] of enqueued) console.log(`  + #${n} ${why}`);
  // (#4094) Surfaced separately from the generic skip lines so a mutation refusal
  // is visible as its own class rather than buried among ordinary skips.
  for (const [n, why] of refusals) console.log(`  ! #${n} ENQUEUE REFUSED (telemetry): ${why}`);
  if (manualEnqueue.length > 0) {
    console.log(
      `::warning::enqueue-green-prs: ${manualEnqueue.length} PR(s) need one-shot manual PAT enqueue due workflow-write restriction; they have been labelled ${STALL_LABEL} where possible.`,
    );
    for (const [n, why] of manualEnqueue) console.log(`  ! #${n} manual-enqueue-needed (${why})`);
  }
  for (const [n, why] of skipped) console.log(`  - #${n} skip (${why})`);
  // #3584 — the whole point of the classifier: a stall that used to be one more
  // indistinguishable `skip (BLOCKED)` line now gets its own block at the end of
  // the log, named, with the PR numbers a human has to act on. This makes the
  // stall VISIBLE; it does not fix it. Those PRs still need a one-shot manual
  // enqueue.
  if (stalled.length > 0) {
    console.log(
      `::warning::enqueue-green-prs: ${stalled.length} PR(s) BLOCKED with nothing failing and nothing pending for >= ${STALL_MINUTES}m. This state does not self-resolve — the cron re-derives it identically. Each needs ONE deliberate manual enqueue (never a loop). See #3584.`,
    );
    for (const [n, why] of stalled) console.log(`  ! #${n} suspected-permanent-block (${why})`);
  }
  console.log(`Done: ${updated.length} branch-updated, ${enqueued.length} ${DRY ? "would be " : ""}enqueued.`);
  process.exit(0);
}

function selfCheck() {
  const initial = {
    number: 42,
    headRefName: "stack/child",
    headRefOid: "a".repeat(40),
    baseRefName: "stack/parent",
    mergeStateStatus: "CLEAN",
    mergeable: "MERGEABLE",
    isDraft: false,
    labels: [],
  };
  const exactMain = { ...initial, baseRefName: "main" };
  assert.deepEqual(freshEnqueueGuard(initial, exactMain), {
    ok: true,
    reason: "exact-fresh-candidate",
  });
  assert.deepEqual(
    freshEnqueueGuard(initial, {
      ...exactMain,
      labels: [{ name: "stack-retarget-pending" }],
    }),
    { ok: false, reason: "hold-label" },
    "an already-running sweep must observe the retarget label added after its initial snapshot",
  );
  assert.deepEqual(freshEnqueueGuard(initial, initial), {
    ok: false,
    reason: "base:stack/parent",
  });
  assert.deepEqual(freshEnqueueGuard(initial, { ...exactMain, headRefOid: "b".repeat(40) }), {
    ok: false,
    reason: "head-changed-during-sweep",
  });
  // (#4094) This assertion previously REQUIRED `mergeStateStatus: "BEHIND"` to be
  // rejected. It is inverted deliberately, not relaxed: that field is a stale
  // sample (PR #4033 read CLEAN while 4 commits behind; #4034 read UNSTABLE while
  // 0 behind), and behind-ness genuinely does not block the queue — #4002 was
  // enqueued 1 commit behind and merged with a green merge_group re-validation.
  // A test pinning the old bail would have defended the defect.
  assert.deepEqual(freshEnqueueGuard(initial, { ...exactMain, mergeStateStatus: "BEHIND" }), {
    ok: true,
    reason: "exact-fresh-candidate",
  });
  // Conflicting-ness is the real blocker, and it comes from `mergeable`.
  assert.deepEqual(freshEnqueueGuard(initial, { ...exactMain, mergeable: "CONFLICTING" }), {
    ok: false,
    reason: "conflicting",
  });
  assert.deepEqual(enqueueMutationVariables("PR_node_id", exactMain.headRefOid), {
    id: "PR_node_id",
    expectedHeadOid: exactMain.headRefOid,
  });
  assert.throws(() => enqueueMutationVariables("PR_node_id", "not-a-sha"), /40-character hex SHA/);
  assert.equal(HOLD_LABELS.has("stack-retarget-pending"), true);

  // #3584 — transient vs permanent BLOCKED. The ONLY thing this classifier
  // claims is that these two are distinguishable; it makes no claim about why
  // the permanent one happens, and it changes no enqueue decision.
  const HOUR = 60 * 60 * 1000;
  const green6h45 = {
    mergeStateStatus: "BLOCKED",
    failed: [],
    pending: [],
    checksError: null,
    greenAgeMs: 6.75 * HOUR,
  };
  // THE case this exists for: #3567 — every check green, still BLOCKED to the
  // enqueuer's token after 6h45m. Must be flagged.
  assert.equal(
    classifyBlockedSkip(green6h45).suspected,
    true,
    "a PR green for 6h45m and still BLOCKED must be flagged",
  );
  // ...and the false positive that would destroy the signal's value: a PR whose
  // checks are simply slow. All three shapes of "still working" stay silent.
  assert.equal(
    classifyBlockedSkip({ ...green6h45, pending: ["quality: pending"] }).suspected,
    false,
    "a pending check means in-flight, never a permanent block — this false positive would train people to ignore the label",
  );
  assert.equal(
    classifyBlockedSkip({ ...green6h45, greenAgeMs: 3 * 60 * 1000 }).suspected,
    false,
    "green for only 3m is ordinary post-CI settling, not a stall",
  );
  assert.equal(
    classifyBlockedSkip({ ...green6h45, greenAgeMs: Number.NaN }).suspected,
    false,
    "no green timestamp -> fail quiet",
  );
  assert.equal(
    classifyBlockedSkip({ ...green6h45, failed: ["quality: fail"] }).suspected,
    false,
    "a red check is a real blocker the author must fix, not a token stall",
  );
  assert.equal(
    classifyBlockedSkip({ ...green6h45, checksError: "no parseable checks" }).suspected,
    false,
    "unreadable checks -> fail quiet, never guess",
  );
  // Scoped to BLOCKED: states with their own recovery path must not be
  // reclassified or pay the diagnostic API reads.
  for (const other of ["BEHIND", "DIRTY", "UNSTABLE", "UNKNOWN", "CLEAN"]) {
    assert.equal(
      classifyBlockedSkip({ ...green6h45, mergeStateStatus: other }).suspected,
      false,
      `${other} has its own recovery path and must not be classified as a permanent block`,
    );
  }
  // The threshold is the load-bearing boundary, so pin both sides of it.
  assert.equal(classifyBlockedSkip({ ...green6h45, greenAgeMs: STALL_MS - 1 }).suspected, false);
  assert.equal(classifyBlockedSkip({ ...green6h45, greenAgeMs: STALL_MS }).suspected, true);
  // The informational label must never become a hold — that would convert a
  // visibility aid into the very stall it reports (a held PR is skipped by this
  // sweep forever).
  assert.equal(HOLD_LABELS.has(STALL_LABEL), false, "the stall label must never block an enqueue");

  console.log("enqueue-green-prs: all self-checks passed");
}

// Only run the live sweep when invoked directly (`node scripts/enqueue-green-prs.mjs`).
// When imported (e.g. by the gate unit test) this guard is false, so no `gh`
// call is made on import. Mirrors the main-module convention used across scripts/.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-check")) selfCheck();
  else runSweep();
}
