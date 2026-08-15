# CI Policy: branch protection and required status checks on `main`

This document is the source of truth for the GitHub branch-protection ruleset
applied to `main`. It exists so the configuration is **auditable in version
control** rather than buried in repo settings UI.

Changes to this file MUST be paired with a corresponding settings change in
GitHub (via the admin script in `scripts/enable-branch-protection.sh`, or
manually in the Settings → Rules → Rulesets UI). The script reads its payload
from this file's spec and is the supported way to apply the ruleset.

Related issues:

- #1525 — this policy and the admin script.
- #1391, #1393 — staleness / drift escalation history.
- #1246 — `test262-differential.yml` (the authoritative test262 gate).
- #1214, #1216 — `benchmark-refresh.yml` PR-gate history.

---

## 1. Required status checks on `main`

A PR cannot merge until every check listed here reports `success` for the
PR's head SHA.

### Required-checks list (paste into GitHub UI verbatim)

The string in the left column is the **exact** GitHub check name that must
appear in the branch-protection "Required status checks" list. Names are
case-sensitive and whitespace-sensitive.

**Re-verify this table against the live ruleset rather than trusting the date
on it** — it drifted once already (`linear-tests` was listed here as required
for months while the ruleset had six contexts without it, #3934):

```sh
gh api repos/loopdive/js2wasm/rules/branches/main \
  --jq '[.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]'
```

Enforcement lives in a repo **ruleset**, not classic branch protection — the
classic endpoint (`gh api repos/loopdive/js2wasm/branches/main/protection`) answers
`404 Branch not protected`, which is not the same as "unprotected". Verified
2026-08-01; the ruleset returned exactly the six rows below.

| Check name                          | Workflow file                           | What it gates                                                                                                                                                                                                                                                                                |
| ----------------------------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cheap gate (main-ancestor + lint)` | `.github/workflows/test262-sharded.yml` | fast pre-flight: lint + typecheck on the PR branch (cheap reject before running the test262 matrix)                                                                                                                                                                                          |
| `merge shard reports`               | `.github/workflows/test262-sharded.yml` | aggregates the 57 test262 shards into a single pass/fail signal — the authoritative aggregate conformance gate. Hosts the HARD inline guards: the host catastrophic-regression guard (#1668), the **standalone net-regression guard (#1897)**, and the stale-baseline guard (#1668) — see §3 |
| `quality`                           | `.github/workflows/ci.yml`              | lint, format check, typecheck, IR fallback budget (#1376), planning-artifact regen, issue integrity (#1616) **incl. the stale-base dup-ID gate against a simulated merge with `main` (#2530)**                                                                                               |
| `equivalence-gate`                  | `.github/workflows/ci.yml`              | merges the equivalence shards and fails if the shard baseline regresses                                                                                                                                                                                                                      |
| `check for test262 regressions`     | `.github/workflows/test262-sharded.yml` | full rolling-baseline test262 diff; required so pass→fail regressions cannot merge just because the aggregate hard guards stayed below threshold                                                                                                                                             |
| `cla-check`                         | `.github/workflows/cla-check.yml`       | self-hosted CLA-acceptance gate (#1660): internal authors and bots are exempt; external humans must have affirmative CLA acceptance recorded                                                                                                                                                 |

### Optional / informational checks (NOT required to merge)

These run on PRs for visibility but are not in the required-checks list.
A failure here surfaces in the PR Checks tab but does not block merge.

| Check name                                                 | Workflow file                                 | Why it isn't required                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `linear-tests`                                             | `.github/workflows/ci.yml`                    | Runs the linear-backend (`tests/linear-*.test.ts`), C-ABI (`tests/c-abi.test.ts`) and SIMD (`tests/simd*.test.ts`) suites — the 20 files that had no CI job before #2139. **Documented as required until 2026-08-01 while never being in the ruleset (#3934).** `ci.yml`'s own `changes` job already treats it as optional (it skips it on docs-only PRs). If it should gate, promote it deliberately — ruleset and this document together.                                                                                          |
| `issue-tests`                                              | `.github/workflows/ci.yml`                    | #4448 — runs the `tests/issue-*.test.ts` files the PR itself touches, plus the pinned set in `scripts/select-changed-issue-tests.mjs`. Until this existed, NO check ran that suite at all: `equivalence-gate` runs `tests/equivalence/`, `quality` runs lint/ratchets/named files, the test262 jobs run conformance, `linear-tests` runs the linear subset. A file could therefore be **born red** (#4430's `issue-3529-selector-preclaim` was) or go red later (`6203320a` reddened three of its tests, invisibly, for two days). Not required, and split in two: the **pinned** step is fatal (those files are verified green on main, so a failure is a real regression), the **changed** step is `continue-on-error` because the suite is **not clean on main today** (a #4448 sample found 8 pre-existing failures across `issue-3522-ir-class-compile-once`, `issue-3529-dataflow-outcomes`, `issue-3529-integration-preflight`) and a red non-required check makes the PR `UNSTABLE`, which `auto-enqueue` skips outright (#3878/#3904) — stranding a PR behind an already-red test would be worse than the gap being closed. Grow the pinned list as files are verified green; promote the job to required once the suite is clean.                                     |
| `test262 PR stub — detect relevance`                       | `.github/workflows/test262-pr-stub.yml`       | Decides which workflow owns the three test262-sharded context names on this PR. Not required — but note a non-green NON-required check still blocks merge indirectly by making the PR `UNSTABLE`; see §1's "Reading a PR's check state".                                                                                                                                                                                                                                                                                          |
| `test262 js-host/standalone shard 1..57` (114 matrix jobs) | `.github/workflows/test262-sharded.yml`       | Individual shard results feed into `merge shard reports`, which is the required check. Individual shard failures are visible for diagnosis but the aggregated signal is what gates.                                                                                                                                                                                                                                                                                                                                               |
| `differential gate (branch vs main)`                       | `.github/workflows/test262-differential.yml`  | Branch-vs-main HEAD comparison with src-tree-hash caching (#1246). Useful diagnostic signal, but the sharded `merge shard reports` is the authoritative gate. Kept running for visibility into per-PR deltas.                                                                                                                                                                                                                                                                                                                     |
| `measure-and-gate`                                         | `.github/workflows/benchmark-refresh.yml`     | Same-run benchmark regression gate. Currently informational at the branch-protection level, but the workflow itself fails on substantial PR regressions (§6 below). Promote to required once the expanded suite has a longer stable signal window.                                                                                                                                                                                                                                                                                |
| `Test262 Canary`                                           | `.github/workflows/test262-canary.yml`        | Smoke check on a small slice of test262 — fast feedback, not authoritative.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `cross-backend-parity`                                     | `.github/workflows/cross-backend-parity.yml`  | #2711 — runs the #1854 cross-backend differential harness (WasmGC/host vs linear/standalone) over the builtin corpus; red on a host↔standalone divergence. Advisory: deliberately NOT in the required list and deliberately does NOT run in `merge_group`, so it cannot block or wedge the queue. **Do not promote to required while it skips `merge_group`** — a required check that never runs in the queue blocks it permanently (see §below on test262-sharded skip). Per-method gaps it documents: child issues #2715–#2721. |
| `porffor-source-native-canary`                             | `.github/workflows/porffor-source-canary.yml` | #3478 — explicitly initializes only the pinned optional Porffor gitlink, then compares real-source JavaScript, production linear-Wasm, and sanitizer-instrumented Porffor-C under both allocator policies. Advisory and absent from `merge_group`, so the optional submodule cannot become a required queue dependency.                                                                                                                                                                                                           |
| `semantic-sanitizers`                                      | `.github/workflows/porffor-direct-ab.yml`     | #3482 — relevant PRs must execute all four native rows: both plain direct-Porffor rows must reproduce their pinned UBSan misalignment finding, while both JS2 rows must remain sanitizer-clean with exact output. Expected direct safety failures are evidence, not skips. Advisory and absent from `merge_group`; its separate optimized job runs only by `workflow_dispatch`, uploads complete evidence without a performance threshold, and never auto-updates results.                                                        |

### Reading a PR's check state — three facts that have each caused a wrong call

**1. A SKIPPED required check SATISFIES the requirement.** A job skipped by its
own `if:` still publishes a check run, with conclusion `skipped`, and branch
protection accepts it. On a docs-only PR `equivalence-gate` skips via `ci.yml`'s
`changes` path filter and the PR still reports `CLEAN`. So **do not verify
readiness by counting six `SUCCESS` conclusions in `statusCheckRollup`** — you
will not find them, and you will wrongly conclude the PR is not ready. Read
`mergeStateStatus`, which already accounts for this.

The distinction that matters: a **workflow-level** skip (a `paths:` filter that
stops the run from existing) produces **no check run at all**, so the context
stays "Expected" forever and the PR is genuinely BLOCKED — that is what
`.github/workflows/test262-pr-stub.yml` exists to prevent. A **job-level** `if:`
skip inside a run that did start is satisfied, not missing.

**2. A non-green NON-required check is not harmless.** It drives
`mergeStateStatus` to `UNSTABLE`, and `scripts/enqueue-green-prs.mjs` enqueues
only `{CLEAN, HAS_HOOKS}` — `UNSTABLE` is deliberately excluded. A PR can
therefore have every required check green and never be enqueued, indefinitely,
with nothing naming the cause (#3878, #3904, #3919/#3934). Re-run the failed job
(`gh run rerun <run-id> -R loopdive/js2wasm --failed`) to get back to `CLEAN`.

**3. `auto-refresh-prs` SKIPS DRAFTS.** `.github/workflows/auto-refresh-prs.yml`
filters to `BEHIND`, non-draft, non-`hold` PRs, so a **draft PR is never
rebased** and silently rots against a moving `main` — PR #3919 was 177 commits
behind. Marking a PR draft is not a pause button; it opts the PR out of branch
maintenance. Take a PR out of draft before expecting any automation to touch it.

### Watching a PR's checks: `pending == 0` is NOT "settled" (#3965)

An empty pending list means "nothing pending **that exists**", which is
indistinguishable from "nothing pending". Right after a push GitHub has created
only a couple of check runs, so a watcher that polls `statusCheckRollup` and
stops when no check is `IN_PROGRESS` will settle **immediately**, on a rollup
that contains none of the required jobs, and report green. Observed for real
while watching PR #3950: the first poll returned four checks (`retarget`,
`cla-check`, `release-pending`) with zero pending, and the watcher declared CI
settled roughly a minute after the push.

Two floors make a watcher honest — apply **both**:

1. **Floor the check count.** Require every required check to be **present by
   name** (the list above) before interpreting pass/fail at all. Absence of a
   job is not a pass. Note this is a **presence** test, not a `SUCCESS` count —
   per fact 1 above, a `skipped` conclusion satisfies the requirement, so
   counting `SUCCESS` would reject a legitimately-ready PR.
2. **Pin the head sha.** The API lags a push, so the rollup can still describe
   the **previous** head, whose checks may be complete and passing. Compare
   `.headRefOid` against the sha you actually pushed and refuse to settle until
   they match; settling on a stale head reports a green that says nothing about
   the code under review.

Related: a dropped `synchronize` webhook can leave the PR head behind the fork
ref indefinitely (20 minutes observed on #3950, both shas read full-length, so
not the truncated-sha trap of the `head_sha=` query). The remedy is a **new
commit** — `main` and published branches are append-only, so never force-push to
"resync".

---

## 2. Reviewer policy

- **At least one approving review from a CODEOWNER** is required before a PR
  can merge. The CODEOWNERS file at the repo root maps paths to required
  reviewers.
- **Stale reviews are dismissed** when new commits are pushed to the PR
  branch. This prevents an approval given against an earlier diff from
  silently authorising later changes.
- **The PR author cannot approve their own PR**, including admins.
- **Code-owner review is required for every protected path** — the CODEOWNERS
  entry is treated as authoritative, not advisory.

### `[skip-review]` label exception class

Two narrow classes of commit may bypass the human-review requirement when
labelled `[skip-review]`. The label is enforced at the policy level (in
this doc), not at the GitHub API level, so reviewers should still spot-check
labelled PRs for misuse.

Permitted bypass scopes:

1. **`ci-status` bot commits** — automated SHA-correlation feed writes
   under `.claude/ci-status/`. See `.github/workflows/ci-status-feed.yml`.
2. **Planning artifact regen** — paths under `dashboard/data*`,
   `dashboard/data.js`, `public/graph-data.json`, and `plan/goals/`,
   `plan/issues/sprints/**` when the only diff is the output of
   `pnpm run build:planning-artifacts`. Cf. `ci.yml`'s
   `Commit regenerated planning artifacts` step.

Bypass MUST NOT be used for `src/**`, `tests/**`, `scripts/**`,
`.github/workflows/**`, `docs/**`, `CLAUDE.md`, `CODEOWNERS`, or
`package.json`. If a `[skip-review]` PR touches any of those paths the
reviewer should require a normal CODEOWNER approval before merging.

---

## 3. Test262 gate decision (sharded + merge-queue model)

Two test262 workflows currently run on PRs:

- **`test262-sharded.yml` is the authoritative PR gate.** The required
  check is `merge shard reports`, fed by the 57-shard host and standalone
  matrix.
  - Queue model (#109 → #1956, see `plan/method/pr-drift-protocol.md`):
    every PR is validated on its own `merge_group` ref. Historically this
    was pinned to a `batch=1` serial queue because the regression gate diffed
    each group against the **main baseline**, where the cumulative diff of a
    multi-entry queue window lets one PR's improvement mask another's
    regression (ALLGREEN hiding). #1956 retires that constraint: each
    merge_group run publishes its merged JSONLs keyed by the group head SHA,
    and the next group's regression-gate diffs against its **exact
    predecessor group** (the group head's first parent), isolating each PR's
    own delta. Fallback order when a predecessor artifact is unavailable:
    #1081 runs/<merge-base> cache, then latest-main baseline — i.e. exactly
    the pre-#1956 behavior.
  - **Canonical queue configuration: `max_entries_to_build: 1` (no
    speculation), `max_entries_to_merge: 5`, `min_entries_to_merge: 1`
    (#3914 Step 2 was tried at floor 2 on 2026-08-14 and measured a NO-OP on
    2026-08-15 — reverted; see the floor note below).** These live in the repo
    ruleset, not in any workflow file, so they are applied and read back with
    **`scripts/set-merge-queue-config.sh`** (`--show` to read, `--check` to
    diff, no flag to apply; needs repo-admin `gh`). Before that script existed
    the values were invisible from the repo and this doc's record of them went
    six weeks stale — it still said `max_entries_to_build: 5` long after the
    2026-06-20 wedge reverted it. Treat the script's `--show` output as
    authoritative and this paragraph as the intent.
  - **The two knobs are not the same thing — and NEITHER of them batches CI
    runs.** (Corrected 2026-08-15; the previous version of this bullet claimed
    the cap gives "one run for N PRs", which is not what GitHub's product does.)
    - `max_entries_to_merge` / `min_entries_to_merge` (**merge limits**) only
      group the final fast-forward to `main` of queue entries that have EACH
      already passed **their own** `merge_group` run. GitHub's docs describe
      them as "the number of pull requests to merge into the base branch at the
      same time", and merge limits explicitly do **not** combine `merge_group`
      builds (GitHub community discussion #58523). Every queued PR always gets
      its own temporary branch and its own full shard-matrix run — the native
      merge queue has **no fewer-runs-than-PRs mode**. The fixed per-run
      overhead can never be amortised across PRs with these knobs.
    - `max_entries_to_build` (**speculation depth, 1**) builds up to N
      _separate_ groups concurrently, each with its own full run. It is capped
      at a ~1.25× theoretical win, it puts 5 × ~102 shard jobs on a
      ~120-runner pool, and it is the **only** setting under which a queue
      change ejects other PRs' in-flight runs (any membership change
      invalidates every descendant speculative group). It was enabled by #1956,
      reverted during the 2026-06-20 wedge (#2519 / #2522), and the shard
      matrix has since been resized _for_ a serial queue —
      `scripts/gen-test262-mg-matrix.mjs` assigns 102 of the 120 runners to a
      single merge group. **Do not re-enable it**;
      `set-merge-queue-config.sh` refuses a value > 1 without
      `--allow-speculative-build`. The arithmetic and the four historical
      failure modes are in
      `plan/issues/3914-ci-throughput-merge-queue-batching.md`.
  - **Adding a PR to the queue tail never ejects or cancels anything.** A merge
    group's membership is fixed when the group is created; a later arrival
    forms the *next* group. The one operation that _does_ cancel a run is
    re-adding a PR that is already **in** the in-flight group, which is why
    `scripts/enqueue-green-prs.mjs` is trailing-add-only (#2560,
    `isTrailingAddCandidate`) and why agents never enqueue (#2786). Raising the
    batch cap does not change this — see `project_merge_queue_requeue_cancels_run`.
  - **A red batch ejects every PR in it — that is priced in, and handled.**
    GitHub removes the whole failed group from the queue and does not bisect.
    #3914 landed the three sites that previously assumed one PR per group:
    the predecessor-baseline lookup uses `merge_group.base_sha` (P1),
    `auto-park` parks **every** member and names the co-members (P2), and the
    #2975 park-race guard maps the failure onto every member (P3). Recovery is
    optimistic-batch/split-on-failure: re-enqueue the members singly to
    attribute. Cost is one wasted run, which is the `e`-weighted term in
    #3914's sizing.
  - **`min_entries_to_merge` is back to 1 — #3914 Step 2 was tried and
    measured a NO-OP.** The floor was raised to 2 (5-min timer) on
    2026-08-14T18:16Z on the "the floor is what forms groups" hypothesis.
    Measured across all of 2026-08-15 up to 13:34Z: **29/29 successful merge
    groups still carried exactly one PR**, one full run each, merging ~15 min
    apart — including a window where entries for #4557/#4558/#4559 were
    stacked in the queue simultaneously (their queue merge commits are all
    dated 12:39–12:44Z) and still consumed three full runs. The floor cannot
    bind on this queue, for two structural reasons:
    1. the wait timer counts from queue entry and, per GitHub's docs, the
       queue then "stop[s] waiting for more entries and merge[s] with fewer
       than the minimum" — under load the head's queue wait (≥ one ~15-min
       run) always exceeds the timer, so the floor is waived at every merge
       decision;
    2. merging ≥2 entries together requires ≥2 entries green simultaneously,
       which `max_entries_to_build: 1` makes impossible — the next entry's
       run is only dispatched **after** the head merges (observed +2 s).
    Its only observable effect is added latency on quiet-queue fast merges
    (docs-only runs go green in ~2-3 min, inside the timer). Conclusion for
    future readers: **no ruleset setting batches N PRs into one CI run** —
    that mode does not exist in GitHub's native merge queue. Genuine per-run
    amortisation requires a queue product that builds batches (e.g.
    Mergify-style) or a bot-maintained train PR — a project-lead decision,
    not a ruleset flip.
  - **Intra-group masking is narrower than this doc used to claim.** It applies
    only to the test262 _delta_ gate, not to `quality` / `cheap gate` /
    `equivalence-*` (pass/fail), nor to the catastrophic guard (#1668) or the
    standalone floor (#1897/#2097), which are **absolute** thresholds. And even
    for the delta gate the merged JSONL is per-test, so a batch that regresses
    three tests still names those three ids. Batching costs **attribution**
    (which member did it), not detection.
  - Path filter restricts the matrix to PRs that touch source / test /
    config files. Docs-only PRs skip the full matrix.
  - The `cheap gate (main-ancestor + lint)` job in the same workflow is
    also required — it's a fast reject path before the matrix runs.
  - The `promote-baseline` job (push: main only) is the canonical
    writer for `benchmarks/results/test262-current.json` (landing-page
    summary) and the `js2wasm-baselines` repo's `test262-current.jsonl`
    (history feed for the trend chart). The `refresh-committed-baseline.yml`
    workflow consumes the sharded artifact to sync the committed JSONL.
  - **Baseline pushes to `main` MUST authenticate with the `MAIN_DEPLOY_KEY`
    SSH deploy key, never `GITHUB_TOKEN`.** The deploy key is the only auth
    path in this ruleset's `bypass_actors` (DeployKey: `always`); a
    `GITHUB_TOKEN`-authenticated push to `main` is rejected by ruleset GH013
    ("Changes must be made through a pull request") and silently FREEZES the
    committed baseline while the `js2wasm-baselines` repo moves on — the
    drift deadlock (regression gates go blind; phantom ~500-test regression
    in `git status` / fresh clones). All three baseline-promoting jobs use
    the deploy key + the `baseline-promote` Environment (deployment branch
    restricted to `main`): `promote-baseline` (test262-sharded.yml), the
    scheduled `sync` (baseline-summary-sync.yml), and the manual emergency
    `merge-and-promote` (refresh-baseline.yml). PR #725/#896 and #3 each
    regressed one of these back onto `GITHUB_TOKEN`; do NOT swap any of them
    back. If GH013 recurs, first confirm the ruleset still lists the
    `DeployKey: always` bypass actor
    (`gh api /repos/loopdive/js2wasm/rulesets/16700772 --jq .bypass_actors`).
  - ⚠️ **`refresh-baseline.yml` is `state=disabled_manually` and CANNOT be
    dispatched** (verified 2026-07-25 and again 2026-08-01:
    `gh api repos/loopdive/js2wasm/actions/workflows/265204741 --jq .state`; a
    `workflow_dispatch` returns **HTTP 422 "Cannot trigger a
    'workflow_dispatch' on a disabled workflow"** — it fails before doing
    anything). It is the only non-active workflow in the repo. Any runbook
    step that says "dispatch `refresh-baseline.yml` in EMERGENCY mode" —
    historically the documented lever for a queue wedged on #1897 — **will
    not execute today**. Treat that lever as unavailable until #3611 settles
    its disposition, and do NOT re-enable it mid-incident: that restarts an
    8-hourly cron and runs an unconditional, guard-ignoring promote, which is
    the most dangerous available version of that action.
    **Note `gh workflow list` simply OMITS disabled workflows**, so absence
    there is not evidence of non-existence — query the API by id or path.
  - **Before relying on ANY documented lever, check it is enabled**, not just
    that it exists:
    `gh api repos/loopdive/js2wasm/actions/workflows --jq '.workflows[]|"\(.state) \(.path)"' | grep -v '^active'`.
    Disabling a workflow silently invalidates every runbook line naming it and
    nothing links the two, so an untested recovery path is indistinguishable
    from a working one until the moment it is needed. When disabling a
    workflow, grep the docs for its name **in the same change**.
  - The `check for test262 regressions` job is also required. It compares
    the merged PR report against the baseline and catches full pass→fail
    regressions even when the inline hard guards inside `merge shard reports`
    do not trip. It always publishes a context: on the intentional no-shards
    path it exits cleanly without looking for artifacts.
- **`test262-differential.yml` runs in parallel** as a diagnostic signal
  (#1246). Compares branch tip vs. main HEAD with src-tree-hash caching.
  Useful for triaging "which exact tests flipped on my branch?" but the
  sharded `merge shard reports` aggregate is what gates the merge.
- **`test262-pr-stub.yml` is the path-excluded companion producer (#4).**
  The `paths:` filter above means a PR that touches **no** test262-relevant
  path (docs-only, plan/bookkeeping, or a `tests/issue-N.test.ts`-only PR —
  those test files are not in the allowlist) never triggers
  `test262-sharded.yml` at all, so its three required contexts
  (`cheap gate (main-ancestor + lint)`, `merge shard reports`,
  `check for test262 regressions`) are never produced and the PR is
  permanently BLOCKED ("3 of 6 required status checks expected") even when
  fully green. `test262-pr-stub.yml` runs on **every** PR, diffs base..head
  through `scripts/test262-paths-match.sh` (the same single source of truth
  the `&test262-paths` allowlist mirrors), and emits those three contexts
  **green only when no test262-relevant path changed**. When a test262 path
  did change, the three stub jobs `skipped` (a skipped job publishes no
  context), so the real workflow remains the **sole** producer — the two are
  mutually exclusive on the same matcher, so the green stub can never mask a
  red real run (the PR #496 masking trap). Correctness: a path-excluded PR
  cannot affect conformance, and the merge **queue** still runs the full
  authoritative validation on the merge_group ref regardless (#1657), so
  nothing lands without the real gate's verdict on the merged-with-main tree.

- **Per-lane gating inside a merge_group run.** The two test262 lanes —
  js-host (`gc`, 66 shards) and standalone (36 shards) — have separate
  baselines, separate regression gates and separate shard-weight maps, so
  `scripts/test262-paths-match.sh` also answers the question per lane
  (`--target host|standalone`). The `changes` job publishes `run_host` /
  `run_standalone` alongside `run_shards` (which stays exactly their OR, so
  every existing consumer is unaffected), and a lane the queued diff provably
  cannot move is dropped from the merge_group shard matrix entirely.
  Constraints that make this safe, all pinned by
  `tests/test262-per-lane-gating.test.ts`:
  - A path is narrowed to one lane **only** when the runner demonstrably does
    not read it on the other. Today that is exactly the two shard-weight maps
    (`tests/test262-slow-tests.json` / `-standalone.json`). **All of `src/**`
    stays both-lane** — `target: "standalone"` is a flag through the same
    compiler, not a separate source tree, so there is no sound src-level split.
  - Every uncertain path (missing `base_sha`, failed or empty diff, unexpected
    matcher output, any non-`merge_group` event) emits **both** lanes, and
    consumers read the outputs as `!= 'false'` so a missing output means "run".
  - The surviving lane keeps its **full** shard count, so its corpus partition
    is byte-identical to a two-lane run and stays comparable to the baseline.
  - `push` / `workflow_dispatch` always run both lanes: `promote-baseline`
    publishes both baselines from those runs. A single-lane merge_group also
    does **not** publish the `test262-group-<sha>` artifact, so the #3448
    push:main probe MISSES and the full two-lane matrix runs before promoting.

For one-off sharded runs outside the normal PR/merge_group path,
`workflow_dispatch` is the supported entry point.

### Pushing to `main` from a workflow — the rebuild tax (#3915)

Two facts about the merge queue that are non-obvious, and each of which sent
triage down a wrong path before being written down.

**1. `[skip ci]` does NOT make a push inert to the merge queue.** It suppresses
_workflows on that commit_. It does **not** stop GitHub rebuilding every queued
merge group on the new base, and a rebuild **discards the `merge_group`
validation already running** — including one that has already gone fully green.
The marker reads as "this push is harmless", and that reading is wrong. There
is no failure, no park and no label when this happens: a green run simply
vanishes and a new one starts. What a human reports is "the queue is stuck."

**2. The SHA in `gh-readonly-queue/main/pr-<N>-<sha>` is the BASE commit, not
the group head.** Two distinct groups for the same PR therefore look like one
run set unless you compare the embedded SHA. Grouping `merge_group` runs by
`head_branch` alone produces an "all green" report on a group that was
superseded. To attribute a rebuild, look up the commit the _superseding_ group
was based on — do not match against a hardcoded list of known bot SHAs.

Because a `push: main`-triggered bot lands its commit _after_ the merge that
triggered it, the tax **scales with merge throughput**: the busier the queue,
the more validation is thrown away. Measured 2026-07-31 17:55–23:11Z over 20
distinct PRs, 6 needed more than one merge group and **5 of those 6 rebuilds
were rooted at the one un-gated bot pusher**; the sixth was a legitimate PR
landing ahead, the only kind a serial queue must pay for.

**So: every workflow that pushes to `main` must gate that push on the merge
queue.** Use the shared `scripts/main-push-queue-gate.mjs`
(`test262-sharded.yml` and `baseline-summary-sync.yml` carry an equivalent
inline gate from #1951). Its rule is:

> **defer** ⟸ the queue is _positively_ busy **and** the artifact is
> _positively_ fresh. Everything else proceeds.

Two design points that are easy to get wrong:

- **Fail-open is correct here, and it is not a violation of "a detector must be
  able to say I don't know".** That rule exists because a _verifier_ which
  cannot see must not fall onto the reassuring side. This is a _deferral_, and
  the cost asymmetry is reversed: unknown ⇒ push costs at most one discarded
  validation, once, whereas unknown ⇒ defer can freeze the artifact
  indefinitely on a flaky API — silently, because a skipped push looks exactly
  like a no-op one. The gate still _reports_ that it could not see, via a
  `::warning::` and an explicit `queue=UNKNOWN` in the verdict line.
- **Read freshness from the artifact, never from `git log`.** Every promote job
  here is `fetch-depth: 1`, where `git log -1 --format=%ct -- <path>` returns
  **empty rather than erroring**. Empty parses as "unknown age", which fails
  open — silently disabling the staleness floor forever while the gate keeps
  reporting success. Pass a timestamp carried _inside_ the artifact
  (`benchmark-manifest.json` → `generatedAt`).

**Better still: do not push to `main` at all — promote through a PR.** The gate
above is damage control, and it is damage control with two deliberate holes: the
staleness floor _overrides_ the queue check once the artifact is old enough, and
a malfunctioning gate fails open. Both are the right call for a direct push, and
both mean that on a busy day the deferrals accumulate until something forces a
push into a live merge group anyway. Routing the artifact through a PR removes
the class instead of bounding it: `main` then only ever advances via the queue,
which is this document's own rule for everything else.

`npm-compat-refresh.yml` is the reference implementation (2026-08-09). The shape
that makes it cheap and non-blocking:

- **One reused branch, force-updated, with at most one open PR on it.** Artifact
  PRs coalesce; a backlog of stale ones would be worse than the problem.
- **The diff must stay artifact-only.** `benchmarks/results/**` and
  `website/public/**` are absent from the `&test262-paths` anchor in
  `test262-sharded.yml`, so the merge_group `detect` job emits
  `run_shards=false` and the ~19-minute shard matrix is skipped. One file on
  that anchor — `package.json` is the easy mistake — puts the whole matrix back.
- **No `[skip ci]`.** The PR needs its checks to run to reach `CLEAN`, and the
  landing commit needs to be visible to `deploy-pages`.
- **The PR must be opened by an actor that is not `GITHUB_TOKEN`** (mint a
  GitHub App token). A `GITHUB_TOKEN`-created PR fires no `pull_request` /
  `pull_request_target` events, so it never gets CI or `cla-check`, never
  reaches `CLEAN`, and `auto-enqueue` never touches it — a PR that strands
  forever while looking healthy.
- **Do not enqueue from the workflow** (#2786). `auto-enqueue.yml` is the single
  enqueuer.
- **Do not force-update the branch while its PR is in the merge queue** — that
  rebuilds the in-flight group and cancels its run, which is the same harm
  relocated. If the queue cannot be read, push anyway: an unreadable gate must
  never freeze the artifact.

`benchmark-refresh.yml` and `refresh-baseline.yml` still push directly and still
use the gate; the script stays for them.

A **staleness floor** (`--stale-after-hours`, 6h) keeps a never-draining queue
from freezing the artifact: past the floor the push proceeds anyway, trading at
most one rebuild per floor-period against an unbounded freeze. A pusher whose
file set is re-landed by _another already-gated_ path may declare that with
`--fallback` instead of carrying its own floor.

Note also that the step shell is `bash -e {0}`: capture the gate's exit code
with `... || RC=$?`, never with a bare call followed by `RC=$?`, or the DEFER
path aborts the step and surfaces as a red run instead of a skipped push.

### Merge-queue wedge recovery — manual, one-shot only (#3456)

GitHub's merge queue has a rare silent-wedge failure mode: the head entry
sits in `AWAITING_CHECKS`, the synthetic
`gh-readonly-queue/main/pr-<N>-<sha>` branch exists, but the `merge_group`
workflow runs are never created (webhooks silently don't fire). Nothing
self-heals for ~3h (entry timeout), and the next head often wedges the same
way.

**There is no automated unsticker.** The old `queue-unstick.yml` /
`scripts/unstick-merge-queue.mjs` cron re-enqueued a "wedged" head
automatically, but **a dequeue + re-enqueue of the HEAD rebuilds its merge group
and CANCELS the in-flight `merge_group` run** (memory
`project_merge_queue_requeue_cancels_run`; that is the entry the unsticker
poked, which is why it was so destructive — appending a PR behind the head is
harmless by comparison). Even with its gates (12-min
stall + de-alias + a zero-`merge_group`-runs guard) the loop still produced
sustained cancellation churn during the 2026-07-18/19 recovery-PR drain — a
false-wedge detection cancels a live run, the head re-wedges, and it fires
again. It was removed in #3456. `auto-enqueue.yml` (grace 0) is the
responsive enqueuer; the shepherd/cron sweep is the backstop.

**Recovery for a genuinely dangling head** (confirmed `AWAITING_CHECKS`
with **zero** `merge_group` runs for its SHA for >12 min) is a **single,
manual, human/shepherd-initiated kick — never a loop**:

```bash
# Confirm the head is dangling first: AWAITING_CHECKS + zero merge_group runs.
gh api graphql -f query='{repository(owner:"loopdive",name:"js2wasm"){
  mergeQueue(branch:"main"){entries(first:5){nodes{
    pullRequest{number id} state position enqueuedAt}}}}}'
gh api 'repos/loopdive/js2wasm/actions/runs?event=merge_group&per_page=20' \
  -q '.workflow_runs[].head_branch'   # look for /pr-<N>-

# If dangling, dequeue + re-enqueue ONCE (App/user token, not GITHUB_TOKEN —
# a bot-token re-enqueue does not fire merge_group runs). Never repeat this
# in a loop; a push to main also rebuilds groups if this does not take.
PRID=<node-id-from-above>
gh api graphql -f query="mutation{dequeuePullRequest(input:{id:\"$PRID\"}){clientMutationId}}"
sleep 8
gh api graphql -f query="mutation{enqueuePullRequest(input:{pullRequestId:\"$PRID\"}){clientMutationId}}"
```

If a single kick does not re-fire the runs, the historical last resort is
admin-merging a few green low-risk PRs (repeated pushes to `main` rebuild
all groups on fresh bases) — **not** a ruleset disable/re-enable, which can
deepen the wedge. See the `project_dev_session_infra_gotchas` fix ladder.

### `needs-manual-enqueue` — a PR that will never auto-enqueue (#3584)

`mergeStateStatus` is computed **relative to the querying token**. `BLOCKED`
does not mean "this PR is not ready"; it means "*you* cannot merge this PR
right now." For most causes that state clears on its own. For at least one it
never does — and because the ~30-min cron backstop uses the *same* app token,
it re-derives the identical `BLOCKED` and cannot recover the PR either. The PR
stays green, unlabelled, comment-free, with no failing check, and simply sits.

`scripts/enqueue-green-prs.mjs` now separates the two. A PR that is `BLOCKED`
with **zero failing and zero pending checks for ≥ 15 minutes** is logged as

```
- #N skip (BLOCKED — SUSPECTED PERMANENT (green-405m-still-blocked); …)
```

under a `::warning::` summary block, and gets the **`needs-manual-enqueue`**
label. Ordinary in-flight PRs log `BLOCKED — transient (...)` and stay quiet.

**Shepherd/lead action on that label — read it every sweep:**

```bash
gh pr list -R loopdive/js2wasm --state open --label needs-manual-enqueue
```

Each such PR needs **one** deliberate enqueue with a user PAT (the GraphQL
`enqueuePullRequest` mutation) — **check the queue first, and never loop**.
Checking first is the load-bearing part: adding a PR that is *not* yet queued
appends it behind the head and does not disturb the in-flight group, but
re-adding one that is **already in** that group rebuilds it and cancels its run
(re-verified 2026-08-02, `project_merge_queue_requeue_cancels_run`). The label
auto-clears if the PR later enqueues on its own.

`needs-manual-enqueue` is **not** in `HOLD_LABELS` and must never be added to
it: a hold would make `auto-enqueue` skip the PR permanently, turning the
warning into the stall it was reporting.

**Known failing population (observed, 2026-07-31):** PRs that are *both*
fork-head *and* touch `.github/workflows/**` — 4/4 needed a human enqueue.
Fork-head alone and workflow-touching alone both auto-enqueue fine. The
underlying cause is **not** established; do not act on a mechanism story.
See #3584 and the follow-up experiment in #3906.

### Both lanes are gated — host AND standalone (#1897)

The 57-shard matrix runs **two** test262 targets per chunk: `js-host` (the
default WasmGC/gc lane) and `standalone` (`--target standalone
--no-host-imports nativeStrings`, the pure-Wasm lane). `merge shard reports`
merges **both** sets of shard artifacts and builds both reports, then runs
three HARD inline guards. Because a failing step inside `merge shard reports`
fails the required check, all three guards gate the merge queue **without
any additional required-check name** — no branch-protection change is needed
to enforce them.

| Inline guard                            | Lane           | Fails when                                                                                 | Tolerance                                                |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| Catastrophic regression guard (#1668)   | host           | `Regressions with wasm-hash change` > 200 vs `test262-current.jsonl`                       | high (200) — only a codegen/harness catastrophe trips it |
| **Standalone regression guard (#1897)** | **standalone** | net (`improvements − wasm-change regressions`) < −15 vs `test262-standalone-current.jsonl` | tight (15) — holds the current standalone floor          |
| Stale-baseline guard (#1668)            | both           | baselines JSONL > 50 commits behind main HEAD (promotion pipeline broken)                  | n/a                                                      |

**Why the standalone guard is separate and tighter.** Before #1897 the merge
queue gated only the host lane. The standalone lane runs in the same matrix
and its merged report is built, but nothing failed the merge when standalone
regressed — it was only measured _post-merge_ by the non-gating
`promote-baseline` job. A #1196 merge regressed standalone ~1,800 passes
(+5,582 `compile_error`) and slipped straight through, because the host
catastrophic guard's 200-test threshold never sees the standalone JSONL.
#1897 closes that gap with a standalone-specific net-regression guard at a
much tighter floor.

**Floor-holding, not absolute-target.** The standalone guard diffs against
`test262-standalone-current.jsonl` — the moving standalone baseline that
`promote-baseline` refreshes on every push to main. So it pins **whatever
floor standalone is currently at**: a PR that leaves standalone unchanged
(net 0) or improves it (net > 0) always passes; only a PR that drops the
standalone net below tolerance fails. As standalone fixes land and the
baseline rises, the gate automatically holds the new, higher floor. This is
why the gate can be enforced even while standalone is below its long-term
target — it never blocks an improving or neutral PR.

**Flake tolerance.** The known standalone CI flake is `compile_timeout` under
load (tests near the 30s compile boundary flapping with runner pressure).
`scripts/diff-test262.ts` already **excludes** `compile_timeout` transitions
from its `Regressions with wasm-hash change` count, so the net the guard
gates on is structurally flake-free. The −15 tolerance only absorbs residual
baseline drift (corpus-version skew, `env::`-import nondeterminism); measured
real run-to-run standalone drift was 0 regressions / +3 improvements, so 15
sits well above the noise floor. The threshold is tunable via the
`STANDALONE_REGRESSION_TOLERANCE` env on the guard step.

### Uncatchable-trap growth ratchet (#3189)

On top of the net/ratio/bucket gate, `scripts/diff-test262.ts` runs a
**per-category trap ratchet**: for each of the four uncatchable-Wasm-trap
`error_category` values — `null_deref`, `illegal_cast`, `oob`, `unreachable` —
it compares the candidate's population against the baseline's, and **fails the
gate (`exit 1`) on ANY growth in ANY trap category, independent of
`net_per_test`**. A net-positive PR that fixes 60 assertion-fails while
introducing 12 new `illegal_cast`s clears the net/ratio gate but is blocked
here. The rationale: a Wasm trap **escapes `try`/`catch`** and aborts the whole
test file (#3179 — a trap inside `assert.throws` poisons every test whose body
shares the pattern), so the "crash-free (traps → 0)" goal
(`plan/goals/goal-graph.md`) treats a trap as strictly worse than an ordinary
fail — the trap population may only shrink or hold. The failure names the
newly-trapping files. This applies in **both** the normal and the oracle
re-baseline branches (a genuinely new trap is a real regression regardless of an
oracle bump; the trap categories are not touched by any oracle reclassification,
so they stay comparable across a forward bump). **Decreases auto-bank** with no
per-PR baseline-bump merge conflict: the ratchet reads the committed baseline
jsonl that `promote-baseline` re-seeds on every push to main (#1528/#3131), so a
trap fix lowers the floor automatically on the next promote — there is no
separate ratchet baseline file. Byte-identical (`wasm_sha`-unchanged) pass→trap
flips are excluded as CI runner noise, exactly like the `net_per_test` gate's
wasm-hash filter (#1222). The pure `evaluateTrapCategoryGrowth` logic is
unit-tested in `tests/issue-3189.test.ts`.

---

## 4. Linear history and merge mode

- **`merge` (merge commit) is allowed** — preserves the full branch graph;
  enables a clean revert path.
- **`squash` is allowed** — used for small fixup PRs where the branch
  history is noise.
- **`rebase` is disabled** — rebase-merging rewrites the PR commit SHAs at
  merge time, which breaks `.claude/ci-status/pr-<N>.json` (the file keys on
  the head SHA) and makes the per-commit CI history harder to follow.

Concretely: in the GitHub repo Settings → General → Pull Requests:

- [x] Allow merge commits
- [x] Allow squash merging
- [ ] Allow rebase merging (DISABLED)

The "Default merge mode" for repos without explicit `gh pr merge`
arguments is **merge commit**, matching what `dev-self-merge` invokes
(`gh pr merge <N> --admin --merge`).

---

## 5. Force-push policy — public `main` is append-only

**The public `main` branch is append-only. Its published history must NEVER
be force-pushed or rewritten.** This is a hard rule, above and beyond the
GitHub branch-protection settings below.

What this forbids:

- No `git push --force` / `--force-with-lease` to `main`.
- No rebasing, squashing, or amending of commits that are already published
  on `main`.
- No history-rewriting `git filter-repo` / `filter-branch` / subtree-split
  operations run against the public branch.

The only sanctioned way `main` advances is **appending** new commits via a
PR through the merge queue (§3, §4). The queue only ever fast-forwards or
adds merge commits on top of existing history — it never rewrites it.

**To undo a bad commit, fix forward with a revert PR** (`git revert` →
PR → merge queue). Never rewrite history to "remove" a commit.

**Rationale.** Rewriting published history breaks every external clone and
fork: their local `main` keeps the old lineage, so their next `git pull`
fails with "divergent branches" — through no fault of their own, and with
no clean recovery short of re-cloning. This already happened once (the
one-time public/private repository restructure force-pushed/rewrote
`origin/main`) and broke an external contributor's first `git pull`. We do
not do this again.

**The one exception** is a true emergency — e.g. a leaked secret or key
committed to history that must be expunged. That is a deliberate, announced
break, not a routine operation:

- It requires **explicit human sign-off**. An agent must NEVER rewrite public
  history on its own initiative.
- Watchers, contributors, and fork owners must be **notified in advance** to
  re-clone, and it is understood that all existing forks will diverge.
- The admin temporarily disables the ruleset, performs the push, re-enables,
  and the disable/re-enable is logged in the repo audit log.

**Non-exception (this is fine).** Resetting a _local_ throwaway checkout to
match the remote (`git reset --hard origin/main`) is always allowed — that
moves a local branch pointer and pushes nothing. It is not a remote history
rewrite and is unrelated to this rule.

### GitHub branch-protection settings backing this rule

- **Force-pushes to `main` are blocked** for all users.
- **Admins included**: the branch-protection ruleset is configured with
  `enforce_admins: true`. This prevents accidental destructive pushes from
  maintainer accounts.
- **Override path**: the emergency exception above — the admin temporarily
  disables the ruleset, performs the push, and re-enables. The
  disable/re-enable is logged in the repo audit log.
- **Branch deletion is blocked**: `main` cannot be deleted via API or UI.

---

## 6. Benchmark measurement, regression gate, and promotion

`benchmark-refresh.yml` measures the PR base and synthetic merge candidate
sequentially in one `ubuntu-24.04` job. Both checkouts use the same physical
runner and the same pinned Node 25.7.0, pnpm 10.30.2, Rust 1.94.1, Wasmtime
46.0.1 toolchain. This same-run A/B is the regression baseline; committed
timings from a different runner are not used for the PR verdict.

The refreshed set includes the representative internal strategy suite
(`latest.json`), playground warm and no-JIT charts, size and loadtime
artifacts (including the complete `loadtime/` asset directory), and the
freshly measured js2 Wasmtime/V8 hot-runtime rows and per-program AOT sizes.
Runtime regressions fail only when both the
JS-relative ratio and the absolute Wasm/strategy time cross the configured
substantial-regression thresholds. Deterministic sizes use a percentage
threshold plus an absolute-byte floor. End-to-end loadtime uses a wider 40%
joint runtime/JS-reference gate; individual compile-only microtimings remain
informational. A missing baseline row is a regression.

Javy and StarlingMonkey are post-merge, change-scoped comparison controls, not
compiler-regression gates. Pull requests always carry their last accepted
values forward and never rebuild or measure those lanes. After a push to
`main`, the workflow remeasures their cold/warm runtimes and module sizes only
when their benchmark corpus, auxiliary generator or host setup, componentizer
dependency, or pinned workflow versions changed in that push. Unrelated
`main` pushes and manual runs on unrelated revisions also carry the accepted
values forward unchanged, with the source commit recorded in every runtime
row. When measured, the job uses pinned Javy 8.1.1; Javy's single-entry dynamic
module uses dedicated warm wrappers that batch several calls inside one
exported `run()`, while the pinned Rust host uses a fresh instance for each
outer sample and normalizes the batch wall time per call.

Before either checkout is measured, the workflow copies any deliberately
carried auxiliary controls into an isolated runner-temporary baseline, then
removes every current-run output and the compiled `loadtime/` directory while
preserving `history.json`. Generators must recreate the complete set; only the
explicitly change-scoped auxiliary fields may be inherited, and missing or
invalid carry provenance fails packaging.

One limitation remains: the legacy, non-displayed
`wasm-host-wasmtime-module-size.json` summary has no generator and is not
represented as a freshly measured or promoted artifact.

Every packaged snapshot includes a manifest with `generatedAt`, the full
source SHA, exact tool versions, and the byte length and SHA-256 of every
artifact. Pull-request code runs with read-only repository permissions and
never enters the `baseline-promote` environment. The base branch's lifecycle
script packages, validates, and compares both PR snapshots, so a PR cannot
weaken its own verdict by editing the gate.

For the one introduction PR where the base branch does not yet contain the
lifecycle script, the workflow uses the base branch's existing playground
sidebar diff as its trusted gate and uses candidate code only to package and
validate the read-only candidate artifact. The full base-controlled lifecycle
gate activates after that change lands; candidate lifecycle code is never used
to decide a full comparison while a base lifecycle exists.

After an accepted push to `main` (or a manual refresh), a separate trusted job
downloads and validates the complete snapshot, verifies that `main` still
equals the measured source SHA, and promotes all files in one `[skip ci]`
commit through `MAIN_DEPLOY_KEY`. Promotion is unconditional after successful
main generation: the PR gate already made the regression decision, and
comparing main against an older committed snapshot would freeze an accepted
change. The job then explicitly dispatches `deploy-pages.yml`, because
`[skip ci]` suppresses push-triggered deployment.

---

## 7. Mapping: required check → workflow → why

**Six contexts, verified against the live ruleset on 2026-08-01. Re-run this
rather than trusting the date** (this table said seven — it carried
`linear-tests`, which the ruleset has never contained, #3934):

```sh
gh api repos/loopdive/js2wasm/rules/branches/main \
  --jq '[.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]'
```

| Required check                      | Workflow              | What it protects against                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cheap gate (main-ancestor + lint)` | `test262-sharded.yml` | fast pre-flight reject: lint + typecheck on the PR branch before any test262 shard runs. Catches obvious failures cheaply and stops the queue from spending compute on a doomed PR.                                                                                                                                                                                                                                                                                                   |
| `merge shard reports`               | `test262-sharded.yml` | semantic conformance, **both lanes**: aggregates the 57 sharded test262 runs (host + standalone) into a single pass/fail. Authoritative gate via the merge queue (build/merge up to 5 concurrently since #1956; predecessor-group diffing preserves per-PR attribution, so no ALLGREEN hiding) — each PR validated on its own merge_group ref. Hosts the host catastrophic guard (#1668), the standalone net-regression guard (#1897), and the stale-baseline guard (#1668) — see §3. |
| `quality`                           | `ci.yml`              | source quality regressions: lint, formatting, typecheck failures, IR fallback budget exceeded (#1376), planning-artifact regeneration. Also runs the "origin/main is merged into branch" pre-check that catches stale PR branches.                                                                                                                                                                                                                                                    |
| `equivalence-gate`                  | `ci.yml`              | semantic equivalence regressions across the sharded equivalence suite after the shard partials are merged.                                                                                                                                                                                                                                                                                                                                                                            |
| `check for test262 regressions`     | `test262-sharded.yml` | full rolling-baseline test262 diff, including pass→fail changes that stay below the inline catastrophic thresholds.                                                                                                                                                                                                                                                                                                                                                                   |
| `cla-check`                         | `cla-check.yml`       | CLA acceptance for external contributors while preserving internal and bot exemptions.                                                                                                                                                                                                                                                                                                                                                                                                |

The CODEOWNERS file gates **who** can approve. The required checks gate
**what** must pass. Both must clear for a PR to merge.

`benchmark-refresh.yml` (the playground perf gate) is not in the required-
checks list but its `pull_request` event path is a hard fail on regression
(§6). Promote it to required once we have a longer stable signal window.

---

## 8. How an admin applies this policy

The script `scripts/enable-branch-protection.sh` PUTs the repo **ruleset**
(`/repos/loopdive/js2wasm/rulesets/16700772`) with the JSON payload corresponding to
the rules above. It reads the live ruleset first and replaces only the
required-check list, preserving merge-queue parameters, conditions, enforcement
and bypass actors. Usage:

```sh
# Dry run — print the payload and curl command, no changes.
./scripts/enable-branch-protection.sh --check

# Apply (requires repo-admin token in GH_TOKEN or `gh auth login`).
./scripts/enable-branch-protection.sh
```

The script is idempotent: re-running it re-applies the canonical state.
Drift between repo settings and this file should be reconciled by running
the script, not by editing settings manually.

**Reconciled 2026-08-08.** This section previously said the script targeted the
**classic** branch-protection API and was therefore not what enforces `main`.
That was wrong on the first count: the script has targeted the ruleset endpoint
(`RULESET_ID=16700772`, the live one) since it was rewritten, so running it does
apply real enforcement. The classic endpoint does answer `404 Branch not
protected` for `main` — that is a fact about the classic API, not about this
script, and the two got conflated.

The second half of the old caveat was correct and has now been acted on: the
script's array listed `linear-tests`, which the live ruleset has never
contained (#3934). Left in place it was a loaded gun — a "reconcile the drift"
run would have silently promoted a seventh gate nobody decided to require. It
has been removed, so the array now states the six contexts actually in force.

Verification is still the rule over trust, since the ruleset can be edited in
the GitHub UI without touching this repo:

```sh
gh api repos/loopdive/js2wasm/rules/branches/main \
  --jq '[.[]|select(.type=="required_status_checks")|.parameters.required_status_checks[].context]'
```

---

## 9. Relationship to the `dev-self-merge` skill

`.claude/skills/dev-self-merge/SKILL.md` defines a hook-based gate that reads
`.claude/ci-status/pr-<N>.json` and decides whether an agent invokes
`gh pr merge <N> --admin --merge`.

Once GitHub enforces the required checks listed in §1, the dev-self-merge
gate becomes a **UX layer**, not the merge authority:

- The skill still inspects per-PR ci-status JSON for agent-friendly
  summaries (net per-test deltas, bucket counts, regressions vs.
  improvements).
- The skill still escalates to the tech lead on bucket >50 / ratio >10% /
  catastrophic regressions.
- The skill no longer bears the responsibility of being the only hard
  block — GitHub's branch protection does that.

See #1391 (staleness escalation) for the prior state where the skill was
the sole hard-block path.

---

## 10. Releasing (npm + JSR)

Version tags (`v*`) drive `publish-npm.yml`, which publishes whatever
`package.json` `version` the tagged commit carries. Bump both packages in
lockstep with `node scripts/release.mjs <x.y.z>`, land a `release:` PR, then
tag the merge commit — the workflow's `verify-version` job fails the publish
if the tag and `package.json` versions disagree. Full flow: [releasing.md](releasing.md).
