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

| Check name | Workflow file | What it gates |
|---|---|---|
| `cheap gate (main-ancestor + lint)` | `.github/workflows/test262-sharded.yml` | fast pre-flight: lint + typecheck on the PR branch (cheap reject before running the test262 matrix) |
| `merge shard reports` | `.github/workflows/test262-sharded.yml` | aggregates the 57 test262 shards into a single pass/fail signal — the authoritative aggregate conformance gate. Hosts the HARD inline guards: the host catastrophic-regression guard (#1668), the **standalone net-regression guard (#1897)**, and the stale-baseline guard (#1668) — see §3 |
| `quality` | `.github/workflows/ci.yml` | lint, format check, typecheck, IR fallback budget (#1376), planning-artifact regen, issue integrity (#1616) **incl. the stale-base dup-ID gate against a simulated merge with `main` (#2530)** |
| `equivalence-gate` | `.github/workflows/ci.yml` | merges the equivalence shards and fails if the shard baseline regresses |
| `linear-tests` | `.github/workflows/ci.yml` | runs the linear-backend (`tests/linear-*.test.ts`), C-ABI (`tests/c-abi.test.ts`), and SIMD (`tests/simd*.test.ts`) suites — the 20 files that previously had no CI job, so every linear-memory lowering change landed ungated (#2139) |
| `check for test262 regressions` | `.github/workflows/test262-sharded.yml` | full rolling-baseline test262 diff; required so pass→fail regressions cannot merge just because the aggregate hard guards stayed below threshold |
| `cla-check` | `.github/workflows/cla-check.yml` | self-hosted CLA-acceptance gate (#1660): internal authors and bots are exempt; external humans must have affirmative CLA acceptance recorded |

### Optional / informational checks (NOT required to merge)

These run on PRs for visibility but are not in the required-checks list.
A failure here surfaces in the PR Checks tab but does not block merge.

| Check name | Workflow file | Why it isn't required |
|---|---|---|
| `test262 js-host/standalone shard 1..57` (114 matrix jobs) | `.github/workflows/test262-sharded.yml` | Individual shard results feed into `merge shard reports`, which is the required check. Individual shard failures are visible for diagnosis but the aggregated signal is what gates. |
| `differential gate (branch vs main)` | `.github/workflows/test262-differential.yml` | Branch-vs-main HEAD comparison with src-tree-hash caching (#1246). Useful diagnostic signal, but the sharded `merge shard reports` is the authoritative gate. Kept running for visibility into per-PR deltas. |
| `measure-and-gate` | `.github/workflows/benchmark-refresh.yml` | Same-run benchmark regression gate. Currently informational at the branch-protection level, but the workflow itself fails on substantial PR regressions (§6 below). Promote to required once the expanded suite has a longer stable signal window. |
| `Test262 Canary` | `.github/workflows/test262-canary.yml` | Smoke check on a small slice of test262 — fast feedback, not authoritative. |
| `cross-backend-parity` | `.github/workflows/cross-backend-parity.yml` | #2711 — runs the #1854 cross-backend differential harness (WasmGC/host vs linear/standalone) over the builtin corpus; red on a host↔standalone divergence. Advisory: deliberately NOT in the required list and deliberately does NOT run in `merge_group`, so it cannot block or wedge the queue. **Do not promote to required while it skips `merge_group`** — a required check that never runs in the queue blocks it permanently (see §below on test262-sharded skip). Per-method gaps it documents: child issues #2715–#2721. |
| `porffor-source-native-canary` | `.github/workflows/porffor-source-canary.yml` | #3478 — explicitly initializes only the pinned optional Porffor gitlink, then compares real-source JavaScript, production linear-Wasm, and sanitizer-instrumented Porffor-C under both allocator policies. Advisory and absent from `merge_group`, so the optional submodule cannot become a required queue dependency. |
| `semantic-sanitizers` | `.github/workflows/porffor-direct-ab.yml` | #3482 — relevant PRs must execute all four native rows: both plain direct-Porffor rows must reproduce their pinned UBSan misalignment finding, while both JS2 rows must remain sanitizer-clean with exact output. Expected direct safety failures are evidence, not skips. Advisory and absent from `merge_group`; its separate optimized job runs only by `workflow_dispatch`, uploads complete evidence without a performance threshold, and never auto-updates results. |

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
    every PR is validated on its own merge_group ref. Historically this was
    pinned to a `batch=1` serial queue because the regression gate diffed
    each group against the *main baseline*, where the cumulative diff of a
    multi-entry queue window lets one PR's improvement mask another's
    regression (ALLGREEN hiding). #1956 retires that constraint: each
    merge_group run publishes its merged JSONLs keyed by the group head SHA,
    and the next group's regression-gate diffs against its **exact
    predecessor group** (the group head's first parent), isolating each PR's
    own delta. With per-PR attribution restored, the queue runs with
    `max_entries_to_build: 5` / `max_entries_to_merge: 5`
    (`min_entries_to_merge` stays 1 — single multi-PR groups would collapse
    per-PR runs and reintroduce intra-group masking). Fallback order when a
    predecessor artifact is unavailable: #1081 runs/<merge-base> cache, then
    latest-main baseline — i.e. exactly the pre-#1956 behavior.
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
    (`gh api /repos/loopdive/js2/rulesets/16700772 --jq .bypass_actors`).
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

For one-off sharded runs outside the normal PR/merge_group path,
`workflow_dispatch` is the supported entry point.

### Merge-queue wedge recovery — manual, one-shot only (#3456)

GitHub's merge queue has a rare silent-wedge failure mode: the head entry
sits in `AWAITING_CHECKS`, the synthetic
`gh-readonly-queue/main/pr-<N>-<sha>` branch exists, but the `merge_group`
workflow runs are never created (webhooks silently don't fire). Nothing
self-heals for ~3h (entry timeout), and the next head often wedges the same
way.

**There is no automated unsticker.** The old `queue-unstick.yml` /
`scripts/unstick-merge-queue.mjs` cron re-enqueued a "wedged" head
automatically, but **a dequeue + re-enqueue rebuilds the merge group and
CANCELS the in-flight `merge_group` run** (memory
`project_merge_queue_requeue_cancels_run`). Even with its gates (12-min
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

### Both lanes are gated — host AND standalone (#1897)

The 57-shard matrix runs **two** test262 targets per chunk: `js-host` (the
default WasmGC/gc lane) and `standalone` (`--target standalone
--no-host-imports nativeStrings`, the pure-Wasm lane). `merge shard reports`
merges **both** sets of shard artifacts and builds both reports, then runs
three HARD inline guards. Because a failing step inside `merge shard reports`
fails the required check, all three guards gate the merge queue **without
any additional required-check name** — no branch-protection change is needed
to enforce them.

| Inline guard | Lane | Fails when | Tolerance |
|---|---|---|---|
| Catastrophic regression guard (#1668) | host | `Regressions with wasm-hash change` > 200 vs `test262-current.jsonl` | high (200) — only a codegen/harness catastrophe trips it |
| **Standalone regression guard (#1897)** | **standalone** | net (`improvements − wasm-change regressions`) < −15 vs `test262-standalone-current.jsonl` | tight (15) — holds the current standalone floor |
| Stale-baseline guard (#1668) | both | baselines JSONL > 50 commits behind main HEAD (promotion pipeline broken) | n/a |

**Why the standalone guard is separate and tighter.** Before #1897 the merge
queue gated only the host lane. The standalone lane runs in the same matrix
and its merged report is built, but nothing failed the merge when standalone
regressed — it was only measured *post-merge* by the non-gating
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

**Non-exception (this is fine).** Resetting a *local* throwaway checkout to
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

| Required check | Workflow | What it protects against |
|---|---|---|
| `cheap gate (main-ancestor + lint)` | `test262-sharded.yml` | fast pre-flight reject: lint + typecheck on the PR branch before any test262 shard runs. Catches obvious failures cheaply and stops the queue from spending compute on a doomed PR. |
| `merge shard reports` | `test262-sharded.yml` | semantic conformance, **both lanes**: aggregates the 57 sharded test262 runs (host + standalone) into a single pass/fail. Authoritative gate via the merge queue (build/merge up to 5 concurrently since #1956; predecessor-group diffing preserves per-PR attribution, so no ALLGREEN hiding) — each PR validated on its own merge_group ref. Hosts the host catastrophic guard (#1668), the standalone net-regression guard (#1897), and the stale-baseline guard (#1668) — see §3. |
| `quality` | `ci.yml` | source quality regressions: lint, formatting, typecheck failures, IR fallback budget exceeded (#1376), planning-artifact regeneration. Also runs the "origin/main is merged into branch" pre-check that catches stale PR branches. |
| `equivalence-gate` | `ci.yml` | semantic equivalence regressions across the sharded equivalence suite after the shard partials are merged. |
| `linear-tests` | `ci.yml` | linear-memory backend regressions: the 20 `tests/linear-*.test.ts` / `tests/c-abi.test.ts` / `tests/simd*.test.ts` files that no CI job executed before #2139, which is why the #1974–#1977 linear-backend bug class shipped silently. |
| `check for test262 regressions` | `test262-sharded.yml` | full rolling-baseline test262 diff, including pass→fail changes that stay below the inline catastrophic thresholds. |
| `cla-check` | `cla-check.yml` | CLA acceptance for external contributors while preserving internal and bot exemptions. |

The CODEOWNERS file gates **who** can approve. The required checks gate
**what** must pass. Both must clear for a PR to merge.

`benchmark-refresh.yml` (the playground perf gate) is not in the required-
checks list but its `pull_request` event path is a hard fail on regression
(§6). Promote it to required once we have a longer stable signal window.

---

## 8. How an admin applies this policy

The script `scripts/enable-branch-protection.sh` PATCHes the GitHub branch
protection API with the JSON payload corresponding to the rules above.
Usage:

```sh
# Dry run — print the payload and curl command, no changes.
./scripts/enable-branch-protection.sh --check

# Apply (requires repo-admin token in GH_TOKEN or `gh auth login`).
./scripts/enable-branch-protection.sh
```

The script is idempotent: re-running it re-applies the canonical state.
Drift between repo settings and this file should be reconciled by running
the script, not by editing settings manually.

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
