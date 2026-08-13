---
name: dev-self-merge
description: Merge self-check for a green PR. Reads the PR's required-check status from the checks API (the committed ci-status feed is RETIRED), outputs MERGE (mark task completed, stand down — server-side auto-enqueue enqueues, #2786) or ESCALATE. Devs do NOT enqueue.
---

# /dev-self-merge \<N\>

> **Devs DO NOT enqueue. On a passing self-check, mark the task completed and
> stand down — the server-side `auto-enqueue.yml` workflow enqueues (#2786).**
> This skill's outcomes are **MERGE** (regression self-check passes → mark the
> task completed and stand down; you do NOT touch the merge queue) or **ESCALATE**
> (to tech lead). The PR is enqueued by the server-side workflow, not by you.
>
> **Why devs no longer enqueue (#2786).** The old model had the dev one-shot
> enqueue when green, with a background CI watcher to do it after stand-down. But
> that watcher is a child of the dev process — it **died with the agent**, so a
> green PR whose dev had stood down **stranded un-enqueued** (#2225, #2247). The
> fix moves enqueue to the one actor that is long-lived and outside agent
> lifecycle: the GitHub Actions workflow. Its `workflow_run`-on-completion trigger
> fires right after the required-check workflows finish, and its grace window is
> now 0 (#2786), so it enqueues every just-green PR within ~one workflow-startup —
> no dependence on any agent surviving. The required checks are `cheap gate
(main-ancestor + lint)`, `merge shard reports`, and `quality`.
>
> **The merge queue then re-validates on the merged state.** `merge_group` re-runs
> the required checks (the regression-gate #1943 — the hard block), and `auto-park`
> (#2547) labels any PR that fails the merge_group re-run `hold`. The workflow's
> single trailing-add enqueue never loops, so it cannot cause the re-enqueue
> "cancellation churn" (memory `project_merge_queue_requeue_cancels_run`) that
> poll-loop re-adds caused on 2026-06-20.
>
> **Backstops, not the mechanism:** the workflow's ~30-min cron, and the tech
> lead's per-loop open-PR sweep (CLAUDE.md "Tech lead discipline") — both catch
> the rare stray the responsive `workflow_run` run misses (e.g. a PR the queue
> dropped on main-advance). Neither is the primary path.
>
> **SECURITY — the workflow's author-trust gate is now load-bearing.** With no
> dev enqueue, the workflow is the single enqueuer; it only enqueues PRs whose
> `authorAssociation` is OWNER/MEMBER/COLLABORATOR. **External contributor PRs**
> are never auto-enqueued — they require a deliberate maintainer enqueue plus a
> green `cla-check`.

## Waiting for CI — background the watcher, PIPELINE the next slice (do NOT idle)

CI wall time is now ~2 min (115-shard parallel, sort-by-duration scheduling,
parallel gate+shards — see PRs #503, #505, #506), plus merge-queue time after.
The dev does NOT terminate and hand off — it keeps the PR — but it also does
**not sit idle blocking on CI.** Run the watch as a **background task**, then
**immediately claim and start your NEXT slice in a fresh worktree** while CI
runs. On-the-spot recovery from drift / CI-failure with full PR context is
preserved — the watcher notifies you on settle, you recover THEN (the context
lives in the diff, not your foreground attention), and return to the next
slice. Idling on a green-riding PR produces zero output and burns the budget
window; a dev whose PR is in CI should always have a new slice in flight.
A stream of idle pings "while a PR is in CI" means the dev is NOT pipelining —
it should be claiming the next task. (See `.claude/agents/developer.md` step 5
and the pipeline-not-idle memory.)

```bash
# Watch the run live (preferred — exits when the run finishes):
run_id=$(gh pr view <N> --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select(.detailsUrl) | .detailsUrl][0]' \
  | grep -oE 'runs/[0-9]+' | cut -d/ -f2)
gh run watch "$run_id" --exit-status

# Or poll every 30s with a timeout:
deadline=$(( $(date +%s) + 1200 ))   # 20 min hard cap
while :; do
  pending=$(gh pr checks <N> --json state \
    --jq '[.[] | select(.state == "PENDING" or .state == "IN_PROGRESS")] | length')
  [ "$pending" = "0" ] && break
  [ "$(date +%s)" -gt "$deadline" ] && { echo "CI > 20 min — escalate"; exit 2; }
  sleep 30
done
```

After the run exits:

| Outcome                                                     | Action                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **All required checks green + `mergeStateStatus == CLEAN`** | Run Step 0 (the checks-API self-check); on MERGE, mark the task completed and stand down — the server-side workflow enqueues (Step 5, #2786)                                                                                                                            |
| **`UNSTABLE`** (required green, a NON-required check red)   | **Do NOT stand down — `auto-enqueue` skips `UNSTABLE` and the PR strands indefinitely** (#3878, #3904). Re-run the failed job: `gh run rerun <run-id> -R loopdive/js2wasm --failed`. Never enqueue manually                                                                 |
| **Drift** (mergeable_state becomes `BEHIND` while waiting)  | Do NOT re-enqueue. `update-branch`/`auto-refresh-prs` auto-rebases BEHIND PRs and the `auto-enqueue` backstop re-sweeps. A clean fast-forward (`git fetch origin && git merge origin/main && git push`) is optional; never re-enqueue after — the backstop owns re-adds |
| **CI failure** (any required check `FAILURE`)               | Diagnose with full PR context — the agent KNOWS what it changed. Fix locally, `git push`, loop back to wait-for-CI                                                                                                                                                      |
| **Long wait** (>10 min)                                     | Emit a `TaskUpdate` noting the unusual wait but keep waiting                                                                                                                                                                                                            |
| **Very long wait** (>20 min)                                | Escalate to tech lead                                                                                                                                                                                                                                                   |

## Step 0 — the merge gate (checks API; the committed CI feed is RETIRED)

> **The per-PR CI feed `.claude/ci-status/pr-<N>.json` is RETIRED.** The writer
> workflows (`ci-status-feed.yml`, `ci-status-basic.yml`,
> `ci-status-pending.yml`) are `workflow_dispatch`-only stubs; the newest feed
> file on `main` is from the PR-471 era. A current PR will NEVER get one — do
> not fetch it, wait for it, or treat its absence as "CI still in flight".
> (That misread stranded two agents on 2026-07-23.) Steps 1–4 below only ever
> applied to that feed and are kept as historical reference — do not execute
> them.

The operative gate, for EVERY PR (src or not):

```bash
gh pr view <N> --json statusCheckRollup,mergeStateStatus,isDraft,labels \
  --jq '{ mergeStateStatus, isDraft,
          labels: [.labels[].name],
          pending: [.statusCheckRollup[] | select(.status != null and .status != "COMPLETED") | .name],
          failed:  [.statusCheckRollup[] | select(.conclusion == "FAILURE" or .conclusion == "failure") | .name] }'
```

- `pending` non-empty → CI still running. Keep the background watcher on it.
- `failed` non-empty → diagnose with full PR context (you KNOW what you
  changed), fix locally, push, loop back to wait-for-CI. ESCALATE to the tech
  lead only for genuine judgment calls (see "What ESCALATE means").
- All required checks green (per `docs/ci-policy.md` §7) + `mergeStateStatus ==
"CLEAN"` + not a draft + no `hold` label → **MERGE**: mark the task completed
  and stand down (Step 5); the server-side workflow enqueues.
- Green checks but `BEHIND`/`BLOCKED` → the Drift row above; never re-enqueue.
- No checks at all (workflow-only / CI-config PR) → **MERGE** — stand down
  (Step 5); the workflow enqueues, or the tech lead admin-merges a CI-only
  change.

> **What a green PR-level run does and does NOT tell you.** On `pull_request`,
> `merge shard reports` and `check for test262 regressions` are DESIGNED green
> no-ops: the heavy test262 shard matrix is merge_group-only (#2519 slim-down;
> #3431 mg matrix; #3448/#3467 per-SHA baseline reuse), so both jobs green-skip
> with `SHARDS_RAN: false` — their logs literally say "shards intentionally
> skipped" / "no merged test262 report to diff". A green PR is NOT evidence
> your PR causes no test262 regressions. The real regression/trap gates (the
> #3467 per-SHA-merge-base diff, the catastrophic guard #1668, the standalone
> floor/net guards #1897/#2097) run in the `merge_group` re-validation on the
> merged state — which is why a fully-green PR can still be auto-parked
> (#2547) with a bot `hold` label. Handle that per "If the queue rejects your
> PR" below.

---

# LEGACY — Steps 1–4 (retired ci-status feed; do NOT execute)

These steps consumed the retired `.claude/ci-status/pr-<N>.json` feed. The
criteria they describe (`net_per_test > 0`, 10% ratio, 50-per-bucket) are now
enforced by CI itself: the regression-gate job runs them as a hard required
check in the `merge_group` (#1943, #3467). Kept only as reference for the
field semantics.

## Legacy Step 1 — read the feed

```bash
git fetch origin
git show origin/main:.claude/ci-status/pr-<N>.json
```

If `test262_skipped: true` in the JSON, this was a test-only / docs-only PR
(no `src/**` changes). Skip Steps 3–4 entirely:

- `conclusion == "success"` → **MERGE** (go to Step 5, stand down — workflow enqueues)
- `conclusion != "success"` → **ESCALATE — basic CI failed on a non-src PR.**

Extract: `head_sha`, `net_per_test`, `regressions`, `regressions_real`,
`regressions_wasm_change`, `wasm_identical_noise`, `compile_timeouts`,
`improvements`, `run_url`, `baseline_stale`, `baseline_staleness_commits`.

### Legacy Step 1a — baseline staleness short-circuit (#1391)

If `baseline_stale: true` is set on the feed, the regression count is
contaminated by drift on main (tests that flipped between when the baseline
was last refreshed and the PR's CI run). Continuing through the criteria
below would falsely block PRs whose actual same-run-main diff is clean.

```bash
stale=$(jq -r '.baseline_stale // false' .claude/ci-status/pr-<N>.json)
if [ "$stale" = "true" ]; then
  drift=$(jq -r '.baseline_staleness_commits // 0' .claude/ci-status/pr-<N>.json)
  echo "ESCALATE — baseline is stale ($drift commits behind main HEAD)."
  exit 1
fi
```

Output (when triggered):

> **ESCALATE — baseline is stale (N commits behind main HEAD). The CI feed's regression counts are inflated by drift, not by this PR. Tech lead should sanity-check by diffing branch-merged vs main-merged artifacts from the same CI run before merging.**

Skip the rest of the algorithm. Do not merge. The tech lead may override after
confirming via artifact comparison; the staleness threshold (50 commits) is
conservative and most PRs will not be flagged.

`regressions_wasm_change` (added by #1222) = regressions where the
compiled Wasm binary differs between base and PR (excluding
`compile_timeout`). Pass→fail flips on a byte-identical binary are
physically impossible compiler regressions — they're CI runner variance
(scheduling, memory pressure, GC timing). This is the preferred field
for the ratio check in criterion 2.

`regressions_real` (added by #1192) = `compile_error + fail` regressions
only — excludes `compile_timeout` transitions which are runner-load
timing noise (tests right at the 30s compile-timeout boundary flap
based on CI system load). Used as a fallback when `regressions_wasm_change`
is null (older CI feed).

**`compile_timeout` transitions are NOT counted — runner timing noise.**
**Wasm-identical pass→fail flips are NOT counted — runner variance noise.**

Field priority (use the first non-null):
`regressions_wasm_change` → `regressions_real` → `regressions`

### Legacy Step 1b — compile_timeout flake filter

A `pass → compile_timeout` transition is **runner-load noise** unless the
underlying compilation takes meaningfully long. Verified during the 2026-05-21
post-wave investigation: 23 of 27 "regressions" turned out to be timeouts on
tests that compile in <500ms locally. See
`plan/issues/sprints/53/post-wave-regression-investigation.md` for the full
investigation (headline number overstated ~6×).

If `regressions_wasm_change` is null (older CI feed) or if the JSON has a
breakdown by transition kind, the dev should subtract `pass → compile_timeout`
transitions where `baseline_compile_ms < 5000` from the regression count
before applying criterion 2.

The cleanest field to use is `regressions_wasm_change` (introduced in #1222) —
it already excludes `compile_timeout` AND byte-identical-binary flips. If the
feed has it, prefer it. The filter chain stays:

`regressions_wasm_change` → `regressions_real` → `regressions`

If the CI feed somehow surfaces a `regressions` count that includes
compile_timeout flakes (older format), and the feed has a `compile_timeout`
field, compute:

```bash
flake=$(jq -r '.compile_timeout // 0' .claude/ci-status/pr-<N>.json)
R_real=$((regressions - flake))
```

Use `R_real` for criterion 2. Document this in your ESCALATE message if
relevant ("8 of 12 regressions are compile_timeout flake; effective R=4").

## Legacy Step 2 — SHA check

```bash
git rev-parse HEAD
```

If `head_sha` in the JSON ≠ `git rev-parse HEAD` output:

> **ESCALATE — SHA mismatch. CI ran on a different commit. Push again and wait for a new CI result.**

Stop.

> **#1943 — CI ENFORCES criteria 2 and 3 as a hard gate; the `merge_group`
> re-run owns regression-catching.** The regression-gate job
> (`scripts/diff-test262.ts`) fails the required check when the 10% ratio or
> 50-per-bucket limit is exceeded, not just when `net_per_test < 0`. The
> thresholds are exported constants (`REGRESSION_RATIO_LIMIT` /
> `REGRESSION_BUCKET_LIMIT` / `REGRESSION_BUCKET_PATH_DEPTH` in
> `scripts/diff-test262.ts`) — this table is the documentation twin of those
> constants; they are byte-identical by construction. Because the gate runs
> both on the PR and again in the `merge_group` (against the merged state), a
> regression cannot slip through whether the dev runs this self-check or not.
> So this skill is a **pre-enqueue gate**: a clean result means MERGE (mark the
> task completed and stand down — Step 5; the server-side workflow enqueues); a
> failing criterion means ESCALATE to tech lead instead.

## Legacy Step 3 — criteria (in order, stop at first failure)

| #   | Criterion                                                                                                   | Failure output                                                                                                            |
| --- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 1   | `net_per_test > 0`                                                                                          | **ESCALATE — net_per_test is not positive (value: N). PR caused more regressions than improvements.**                     |
| 2   | `R == 0 OR R / improvements < 0.10`, where `R = regressions_wasm_change ?? regressions_real ?? regressions` | **ESCALATE — regression ratio is N% (R/improvements), exceeds 10% threshold.**                                            |
| 3   | No bucket > 50 regressions (see Step 4)                                                                     | **ESCALATE — bucket "\<path\>" has N regressions, exceeds 50-test limit.**                                                |
| 4   | All above pass                                                                                              | **MERGE** — mark the task completed and stand down (Step 5); the workflow enqueues. (merge_group re-runs this same gate.) |

`R` (criterion 2) prefers `regressions_wasm_change` if the feed has it
(post-#1222 CI). This filters out byte-identical-binary pass→fail flips,
which are CI runner variance, not real regressions. Falls back to
`regressions_real` (post-#1192, excludes compile_timeout), then to the
headline `regressions` count. Excluding wasm-identical noise and
`compile_timeout` prevents CI variance from tipping otherwise-clean PRs
above the 10% threshold. Compute it in shell with:

```bash
R=$(jq -r '.regressions_wasm_change // .regressions_real // .regressions' .claude/ci-status/pr-<N>.json)
```

If `regressions` is `null` in the feed (older CI format without per-test tracking): treat criterion 2 as **pass** and skip criterion 3 (no data to bucket). Result is MERGE (stand down; workflow enqueues) if criterion 1 holds.

## Legacy Step 4 — bucket regressions (only if regressions > 0)

Download the merged report artifact and ensure the baseline JSONL is cached
locally (#1528 — the baseline is no longer committed to the repo; it's
fetched on demand from `loopdive/js2wasm-baselines`):

```bash
run_id=$(jq -r '.run_url' .claude/ci-status/pr-<N>.json | grep -oE 'runs/[0-9]+' | cut -d/ -f2)
mkdir -p output/sm-<N>
gh run download "$run_id" -n test262-merged-report -D output/sm-<N>

# Fetch the baseline JSONL to .test262-cache/ if not already present.
node scripts/fetch-baseline-jsonl.mjs
```

Bucket by path prefix:

```bash
python3 - <<'EOF'
import json
from collections import Counter

base = {}
with open('.test262-cache/test262-current.jsonl') as f:
    for line in f:
        try: d = json.loads(line); base[d['file']] = d['status']
        except: pass

new = {}
with open('/tmp/sm-<N>/test262-results-merged.jsonl') as f:
    for line in f:
        try: d = json.loads(line); new[d['file']] = d['status']
        except: pass

regs = [f for f in base if base[f] == 'pass' and new.get(f, 'pass') != 'pass']
buckets = Counter('/'.join(f.split('/')[:5]) for f in regs)
print(f"Total regressions: {len(regs)}")
for path, count in buckets.most_common(10):
    flag = " <- EXCEEDS 50" if count > 50 else ""
    print(f"  {count:4d}  {path}{flag}")
EOF
```

Any bucket with count > 50 → **ESCALATE** with the bucket name and count (criterion 3 above).

## Step 5 — mark task completed, then stand down (do NOT enqueue)

All criteria passed → result is **MERGE**. **You do NOT enqueue (#2786).** The
server-side `auto-enqueue.yml` workflow is the single enqueuer: its
`workflow_run`-on-completion trigger fires right after the required-check
workflows finish and (grace 0) enqueues your just-green PR within ~one
workflow-startup — without depending on you or any watcher surviving. Trying to
enqueue yourself is the old model that stranded green PRs when the dev's watcher
died on stand-down (#2225, #2247).

So on MERGE: **mark your task completed and stand down. Do not touch the merge
queue at all** — no `enqueuePullRequest`, no `gh pr merge --auto`, no re-enqueue.

Once the workflow enqueues, GitHub will:

1. Place the PR on a temp branch (`gh-readonly-queue/main/pr-<N>-...`)
2. Re-run the required checks (`cheap gate`, `merge shard reports`, `quality` —
   incl. the regression-gate) against the merged state via the `merge_group`
   event
3. Fast-forward main if checks pass; `auto-refresh-prs.yml` then merges
   `origin/main` into every other open PR branch
4. If the `merge_group` re-run fails, `auto-park` (#2547) labels the PR `hold` so
   it can't re-churn the queue — fix it on the branch, remove the label, and the
   workflow re-enqueues

> **Never enqueue or re-enqueue from a dev.** The single trailing-add enqueue is
> the workflow's job; re-enqueue **loops** were the sole cause of the merge-queue
> cancellation churn (every re-add changes queue membership → GitHub rebuilds the
> merge group → CANCELS the in-flight `merge_group` run; ~3.5h on 2026-06-20,
> memory `project_merge_queue_requeue_cancels_run`). The workflow's single
> trailing-add never loops. If a green PR somehow sits un-enqueued (the rare stray
> the responsive run missed), the ~30-min cron and the tech lead's per-loop sweep
> catch it. If something looks genuinely wrong, **escalate to the tech lead**.

**The issue file already carries `status: done`.** Under self-merge there is no
separate post-merge observer who can commit a status flip, and once the queue
lands the PR you cannot make a follow-up commit from `/workspace`. So the
**implementation PR itself sets `status: done` + `completed: <date>`** in the
issue frontmatter when you open it (by merge time it IS done; queue rejections
are rare, and the gate already verified what the queue re-verifies). Do NOT open
the PR at `in-review` and plan a later flip — that is exactly what orphans issues
at `in-review` (see #1602/#1603/#1606).

**On a passing self-check (MERGE), your job for this PR is done — STAND DOWN.**
Do not enqueue, do not wait for the merge, do not re-enqueue. The server-side
workflow takes it from here. Proceed immediately:

1. (Status already `done` in the merged PR — no separate flip needed.)
2. `TaskUpdate taskId=<your-task> status=completed`
3. Remove your worktree: `git worktree remove /workspace/.claude/worktrees/<branch>`
4. **Sync the shared checkout once the queue lands the PR:**
   `bash scripts/sync-workspace-main.sh` — fast-forwards `/workspace` to
   `origin/main` so it never rots behind (it silently fell 135 commits behind
   on 2026-05-29, which made the statusline report a stale sprint). It's a
   no-op on a clean, current tree and refuses to touch a dirty one, so it's
   always safe to run. (Tech lead's auto-merge monitor also runs this; running
   it here too keeps the checkout fresh between monitor passes.)
5. `TaskList` → claim next unowned task (or message tech lead if empty)

> If the queue _rejects_ the PR (rare), the `status: done` you set has not yet
> landed on main, so nothing is orphaned; `auto-park` holds it and you re-fix it
> below.

### If the queue rejects your PR (auto-park labels it `hold`)

GitHub fails the final queue checks if something flipped between your CI run and
the queue's re-run (usually main moved). `auto-park` (#2547) then labels the PR
`hold`. In that case — **the backstop, not you, owns the re-add:**

- The auto-refresh workflow may have already pushed a merge of main into your
  branch — fetch and review
- Diagnose and fix with full PR context (you KNOW what you changed), push
- Re-run this self-check against the new CI run
- If clean, **remove the `hold` label** and let the `auto-enqueue` backstop
  re-sweep it — do **NOT** re-enqueue manually. (Your one-shot enqueue is spent;
  manual re-enqueue loops are exactly what caused the cancellation churn.)
  Escalate to the tech lead if it won't clear.

### Admin direct-merge — tech-lead only

`gh pr merge <N> --merge --admin` (bypassing the queue) is **tech-lead-only**,
used only when the change is workflow-only / CI-only (queue ruleset checks don't
apply), a hotfix bypass is explicitly authorized, or the queue itself is broken
and needs unblocking. Set `GATE_BYPASS=1` if the local pre-commit hook blocks
because `pr-<N>.json` isn't present. **Devs never use this.**

## What ESCALATE means

Post to tech lead via SendMessage with:

- Which criterion failed
- The exact values from the CI JSON
- The PR number

Do not merge. Do not move to the next task. Own the issue until it resolves.

## What these fields mean

- **`net_per_test`** = `improvements - regressions` — per-test transitions from `diff-test262.ts`. The merge gate.
- **`regressions_wasm_change`** (#1222) — regressions where the Wasm binary changed (excluding `compile_timeout`). Preferred for criterion 2.
- **`wasm_identical_noise`** (#1222) — pass→other transitions where the Wasm binary is byte-identical on base & PR. These are CI runner variance, **not** real regressions, and are excluded from `regressions_wasm_change`.
- **`regressions_real`** (#1192) — `compile_error + fail` regressions, excludes `compile_timeout`. Fallback for criterion 2.
- **`snapshot_delta`** = bulk pass-count difference vs committed baseline. NOT a merge criterion — contaminated by baseline drift. Ignore it.
