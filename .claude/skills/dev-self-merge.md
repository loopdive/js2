---
name: dev-self-merge
description: Regression self-check for a green PR. Reads CI JSON, applies the hard criteria, outputs MERGE (enqueue ONCE, then stand down) or ESCALATE. Auto-enqueue is the backstop.
---

# /dev-self-merge \<N\>

> **Devs self-enqueue EXACTLY ONCE when green, then stand down (2026-06-20).**
> When all required checks are green and this self-check passes, the dev enqueues
> the PR **once** via the GraphQL `enqueuePullRequest` mutation (Step 5), marks
> the task completed, and stands down. This skill's outcomes are **MERGE**
> (enqueue once, then stand down) or **ESCALATE** (to tech lead). After that one
> enqueue the PR is handed off — the dev does NOT touch the queue again.
>
> **Enqueue PROACTIVELY — the moment the three required checks are green.**
> The required checks are `cheap gate (main-ancestor + lint)`, `merge shard
> reports`, and `quality`. Enqueue as soon as **those three** pass — do NOT wait
> for the full equivalence-shard matrix to finish, do NOT wait for a background
> watcher to "settle everything", and do NOT leave the enqueue to the
> `auto-enqueue` backstop (it's sparse and only catches strays). Actively
> enqueuing your own PR the instant it's mergeable is the dev's job; a PR that
> sits green-but-un-enqueued is a process failure. The tech lead also sweeps +
> enqueues green PRs every loop (see CLAUDE.md "Tech lead discipline").
>
> **Enqueue EXACTLY ONCE — never re-enqueue.** The `auto-enqueue.yml` backstop
> (App-token bot identity, sweeps green PRs on every CI completion + ~30-min
> cron) owns ALL re-adds for any PR that strands, drifts, or gets ejected; the
> `merge_group` required checks (the regression-gate, #1943, re-validates against
> the merged state — the hard block) and `auto-park` (#2547, labels any PR that
> fails the merge_group re-run `hold`) backstop the rest.
>
> **Why exactly-once and not a loop.** The ~3.5h "cancellation churn" of
> 2026-06-20 (memory `project_merge_queue_requeue_cancels_run`) came from devs
> **re-enqueuing on a poll loop** — every re-add changes queue membership, makes
> GitHub rebuild the merge group, and **CANCELS the in-flight `merge_group` run**
> for the current head. A single one-shot enqueue does not loop, so it cannot
> churn. The earlier "agents never enqueue" experiment (Option 1) overcorrected:
> auto-enqueue's deliberately-sparse ~30-min cron is too slow to be the
> *primary* enqueuer, so green PRs sat un-enqueued for long idle stretches. The
> back-off fix #2560 (merged) makes auto-enqueue a reliable *backstop*, so
> one-shot-enqueue-then-stand-down is the right balance.
>
> **Auth: use the user PAT for the enqueue, NOT `GITHUB_TOKEN`.** An enqueue
> authenticated with `GITHUB_TOKEN` suppresses the `merge_group` event
> ("workflows can't trigger workflows") and wedges the queue (memory
> `project_merge_queue_wedge_github_token`). The dev's interactive `gh` auth (a
> PAT) is correct here; the *backstop* uses the App token.
>
> **SECURITY — internal/trusted dev agents only.** Dev-self-enqueue applies to
> internal dev agents. **External contributor PRs** still go through
> auto-enqueue's author-trust gate (or a deliberate maintainer enqueue) and a
> green `cla-check` — never self-enqueue someone else's PR.

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

| Outcome                                                    | Action                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **All required checks green**                              | Proceed to Step 0 (or directly to Step 1 if the CI feed JSON is present) for the self-check; on MERGE, enqueue ONCE (Step 5)                                                                                               |
| **Drift** (mergeable_state becomes `BEHIND` while waiting) | Do NOT re-enqueue. `update-branch`/`auto-refresh-prs` auto-rebases BEHIND PRs and the `auto-enqueue` backstop re-sweeps. A clean fast-forward (`git fetch origin && git merge origin/main && git push`) is optional; never re-enqueue after — the backstop owns re-adds |
| **CI failure** (any required check `FAILURE`)              | Diagnose with full PR context — the agent KNOWS what it changed. Fix locally, `git push`, loop back to wait-for-CI                                                                                                        |
| **Long wait** (>10 min)                                    | Emit a `TaskUpdate` noting the unusual wait but keep waiting                                                                                                                                                              |
| **Very long wait** (>20 min)                               | Escalate to tech lead                                                                                                                                                                                                     |

The CI feed `pr-<N>.json` still drives the merge gate below — fetch it once
CI completes:

```bash
git fetch origin
git show origin/main:.claude/ci-status/pr-<N>.json 2>/dev/null
```

Do NOT `git merge origin/main` just to check — `git show` reads the remote ref
without touching your working tree.

## Step 0 — fast-path for non-test262 PRs

If `git show origin/main:.claude/ci-status/pr-<N>.json 2>/dev/null` returns nothing, check whether Test262 was
required for this PR:

```bash
gh pr view <N> --json files --jq '[.files[].path | select(startswith("src/"))] | length'
```

If the result is **0** (no `src/**` changes), Test262 Sharded was not required.
Check basic CI instead:

```bash
gh pr view <N> --json statusCheckRollup \
  --jq '[.statusCheckRollup[] | select(.conclusion != null)] |
        { total: length,
          failed: [.[] | select(.conclusion == "FAILURE" or .conclusion == "failure")] | length }'
```

- If `failed == 0` and `total > 0`: output **MERGE** — enqueue once (Step 5), then stand down.
- If `failed > 0`: output **ESCALATE — basic CI failed. Check which checks failed.**
- If `total == 0` (no checks at all): output **MERGE** — workflow-only, no CI gates apply; enqueue once (Step 5) or have the tech lead admin-merge a CI-only change.

If `src/**` changes exist but no status file: CI is still in-flight. Wait.

## Step 1 — read the feed

```bash
git fetch origin
git show origin/main:.claude/ci-status/pr-<N>.json
```

If `test262_skipped: true` in the JSON, this was a test-only / docs-only PR
(no `src/**` changes). Skip Steps 3–4 entirely:

- `conclusion == "success"` → **MERGE** (go to Step 5, enqueue once)
- `conclusion != "success"` → **ESCALATE — basic CI failed on a non-src PR.**

Extract: `head_sha`, `net_per_test`, `regressions`, `regressions_real`,
`regressions_wasm_change`, `wasm_identical_noise`, `compile_timeouts`,
`improvements`, `run_url`, `baseline_stale`, `baseline_staleness_commits`.

### Step 1a — baseline staleness short-circuit (#1391)

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

### Step 1b — compile_timeout flake filter

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

## Step 2 — SHA check

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
> So this skill is a **pre-enqueue gate**: a clean result means MERGE (enqueue
> the PR ONCE — Step 5 — then stand down); a failing criterion means ESCALATE
> to tech lead instead of enqueuing.

## Step 3 — criteria (in order, stop at first failure)

| #   | Criterion                                                                                                   | Failure output                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | `net_per_test > 0`                                                                                          | **ESCALATE — net_per_test is not positive (value: N). PR caused more regressions than improvements.** |
| 2   | `R == 0 OR R / improvements < 0.10`, where `R = regressions_wasm_change ?? regressions_real ?? regressions` | **ESCALATE — regression ratio is N% (R/improvements), exceeds 10% threshold.**                        |
| 3   | No bucket > 50 regressions (see Step 4)                                                                     | **ESCALATE — bucket "\<path\>" has N regressions, exceeds 50-test limit.**                            |
| 4   | All above pass                                                                                              | **MERGE** — enqueue the PR ONCE (Step 5), then stand down. (The merge_group re-runs this same gate.)  |

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

If `regressions` is `null` in the feed (older CI format without per-test tracking): treat criterion 2 as **pass** and skip criterion 3 (no data to bucket). Result is MERGE (enqueue once) if criterion 1 holds.

## Step 4 — bucket regressions (only if regressions > 0)

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

## Step 5 — enqueue the PR ONCE, then stand down

All criteria passed → result is **MERGE**. **Add the PR to the merge queue via
the GraphQL `enqueuePullRequest` mutation — exactly once** (do NOT use
`gh pr merge --auto`: it only arms on a check-state *transition*, so on an
already-green `CLEAN` PR it silently no-ops and the PR is never queued):

```bash
PRID=$(gh pr view <N> --json id -q .id)
gh api graphql -f query='mutation($id:ID!){ enqueuePullRequest(input:{pullRequestId:$id}){ clientMutationId } }' -f id="$PRID"

# VERIFY it actually landed in the queue — do NOT trust a silent success:
gh api graphql -f query='{ repository(owner:"loopdive",name:"js2"){ mergeQueue(branch:"main"){ entries(first:50){ nodes { pullRequest { number } } } } } }' \
  | grep -q "\"number\":<N>" && echo "queued ✓" || echo "NOT queued — the auto-enqueue backstop will re-sweep within ~30 min; do NOT re-enqueue in a loop"
```

> **Use the user PAT for this enqueue, NOT `GITHUB_TOKEN`.** A `GITHUB_TOKEN`
> enqueue suppresses the `merge_group` event ("workflows can't trigger
> workflows") and wedges the queue (memory
> `project_merge_queue_wedge_github_token`). The dev's interactive `gh` auth is a
> PAT and is correct here. The *backstop* uses an App token.

Once enqueued, GitHub will:

1. Place the PR on a temp branch (`gh-readonly-queue/main/pr-<N>-...`)
2. Re-run the required checks (`cheap gate`, `merge shard reports`, `quality` —
   incl. the regression-gate) against the merged state via the `merge_group`
   event
3. Fast-forward main if checks pass; `auto-refresh-prs.yml` then merges
   `origin/main` into every other open PR branch
4. If the `merge_group` re-run fails, `auto-park` (#2547) labels the PR `hold` so
   it can't re-churn the queue — fix it, remove the label, and the
   `auto-enqueue` backstop re-sweeps

> **Enqueue EXACTLY ONCE — NEVER re-enqueue, NEVER loop.** This single
> `enqueuePullRequest` is the only enqueue you perform for this PR. Do **NOT**
> re-enqueue on drift, ejection, a `hold` label, or a later CI failure —
> re-enqueue **loops** were the sole cause of the merge-queue cancellation churn
> (every re-add changes queue membership → GitHub rebuilds the merge group →
> CANCELS the in-flight `merge_group` run; ~3.5h on 2026-06-20, memory
> `project_merge_queue_requeue_cancels_run`). The **`auto-enqueue.yml` backstop**
> (App-token bot, every ~30 min + on every CI completion) owns ALL re-adds for
> any PR that strands, drifts, or gets ejected — back-off fix #2560 (merged)
> makes it reliable. If something looks genuinely wrong, **escalate to the tech
> lead** — never loop the enqueue yourself.

**The issue file already carries `status: done`.** Under self-merge there is no
separate post-merge observer who can commit a status flip, and once the queue
lands the PR you cannot make a follow-up commit from `/workspace`. So the
**implementation PR itself sets `status: done` + `completed: <date>`** in the
issue frontmatter when you open it (by merge time it IS done; queue rejections
are rare, and the gate already verified what the queue re-verifies). Do NOT open
the PR at `in-review` and plan a later flip — that is exactly what orphans issues
at `in-review` (see #1602/#1603/#1606).

**Once enqueued, your job for this PR is done — STAND DOWN.** Do not wait for the
actual merge, and do not re-enqueue. Proceed immediately:

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
