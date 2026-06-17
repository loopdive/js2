---
name: dev-self-merge
description: Algorithmic gate for self-merging a PR. Reads CI JSON, applies 4 hard criteria in order, outputs MERGE or ESCALATE. No judgment calls.
---

# /dev-self-merge \<N\>

## Waiting for CI — synchronous, in-context

CI wall time is now ~2 min (115-shard parallel, sort-by-duration scheduling,
parallel gate+shards — see PRs #503, #505, #506). The dev agent **blocks
in-context** waiting for CI rather than terminating and handing off. Idle
Sonnet polling is nearly free, and on-the-spot recovery from drift or CI
failure with full PR context beats the complexity of fire-and-forget.

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

| Outcome                                                    | Action                                                                                                                                    |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **All required checks green**                              | Proceed to Step 0 (or directly to Step 1 if the CI feed JSON is present)                                                                  |
| **Drift** (mergeable_state becomes `BEHIND` while waiting) | `git fetch origin && git merge origin/main` in the worktree, resolve conflicts with full PR context, `git push`, loop back to wait-for-CI |
| **CI failure** (any required check `FAILURE`)              | Diagnose with full PR context — the agent KNOWS what it changed. Fix locally, `git push`, loop back to wait-for-CI                        |
| **Long wait** (>10 min)                                    | Emit a `TaskUpdate` noting the unusual wait but keep waiting                                                                              |
| **Very long wait** (>20 min)                               | Escalate to tech lead                                                                                                                     |

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

- If `failed == 0` and `total > 0`: output **MERGE** and skip to Step 5.
- If `failed > 0`: output **ESCALATE — basic CI failed. Check which checks failed before merging.**
- If `total == 0` (no checks at all): output **MERGE** — workflow-only, no CI gates apply.

If `src/**` changes exist but no status file: CI is still in-flight. Wait.

## Step 1 — read the feed

```bash
git fetch origin
git show origin/main:.claude/ci-status/pr-<N>.json
```

If `test262_skipped: true` in the JSON, this was a test-only / docs-only PR
(no `src/**` changes). Skip Steps 3–4 entirely:

- `conclusion == "success"` → **MERGE** (go to Step 5)
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

> **#1943 — CI now ENFORCES criteria 2 and 3 as a hard gate.** The
> regression-gate job (`scripts/diff-test262.ts`) fails the required check
> when the 10% ratio or 50-per-bucket limit is exceeded, not just when
> `net_per_test < 0`. The thresholds are exported constants
> (`REGRESSION_RATIO_LIMIT` / `REGRESSION_BUCKET_LIMIT` /
> `REGRESSION_BUCKET_PATH_DEPTH` in `scripts/diff-test262.ts`) — this table
> is the documentation twin of those constants; they are byte-identical by
> construction. So a branch-protected PR can no longer merge on `net ≥ 0`
> alone; this skill's job below reduces to interpreting/explaining ESCALATE
> cases the gate surfaces.

## Step 3 — criteria (in order, stop at first failure)

| #   | Criterion                                                                                                   | Failure output                                                                                        |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 1   | `net_per_test > 0`                                                                                          | **ESCALATE — net_per_test is not positive (value: N). PR caused more regressions than improvements.** |
| 2   | `R == 0 OR R / improvements < 0.10`, where `R = regressions_wasm_change ?? regressions_real ?? regressions` | **ESCALATE — regression ratio is N% (R/improvements), exceeds 10% threshold.**                        |
| 3   | No bucket > 50 regressions (see Step 4)                                                                     | **ESCALATE — bucket "\<path\>" has N regressions, exceeds 50-test limit.**                            |
| 4   | All above pass                                                                                              | **MERGE**                                                                                             |

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

If `regressions` is `null` in the feed (older CI format without per-test tracking): treat criterion 2 as **pass** and skip criterion 3 (no data to bucket). Proceed to MERGE if criterion 1 holds.

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

## Step 5 — queue for merge

All criteria passed. **Add the PR to the merge queue via the GraphQL `enqueuePullRequest` mutation** (do NOT use `--admin` direct merge — main is now protected by a merge queue ruleset):

```bash
PRID=$(gh pr view <N> --json id -q .id)
gh api graphql -f query='mutation($id:ID!){ enqueuePullRequest(input:{pullRequestId:$id}){ clientMutationId } }' -f id="$PRID"

# VERIFY it actually landed in the queue — do NOT trust a silent success:
gh api graphql -f query='{ repository(owner:"loopdive",name:"js2"){ mergeQueue(branch:"main"){ entries(first:50){ nodes { pullRequest { number } } } } } }' \
  | grep -q "\"number\":<N>" && echo "queued ✓" || echo "NOT queued — investigate"
```

> **Why GraphQL `enqueuePullRequest`, NOT `gh pr merge <N> --auto`.** `--auto` only
> _arms_ auto-merge on a check-state **transition** — it fires when a PENDING
> required check flips green. By the time `/dev-self-merge` runs (Steps 1–4 only
> proceed on a **complete, green** CI run) the PR is already `CLEAN`, so there is no
> transition left to fire on and `--auto` **silently no-ops — the PR is never
> queued**. This stranded an entire backlog of green PRs on 2026-05-29 (the queue
> sat empty with 9 CLEAN PRs unmerged). The GraphQL mutation enqueues directly and
> works whether the PR is `CLEAN` or still finalizing. Also: never pass `--merge`
> (or any strategy flag) — the merge queue owns the strategy. (`--admin --merge`
> direct bypass is tech-lead-only.)

Once enqueued, GitHub will:

1. Place the PR on a temp branch (`gh-readonly-queue/main/pr-<N>-...`)
2. Re-run the required checks (`cheap gate`, `merge shard reports`, `quality`) against that merged state via the `merge_group` event
3. Fast-forward main if checks pass — usually within minutes of CI completing
4. Trigger `auto-refresh-prs.yml` after the merge, which pushes a fresh `git merge origin/main` to every other open PR branch

**The issue file already carries `status: done`.** Under self-merge there is
no separate post-merge observer who can commit a status flip — and once the
queue lands the PR you cannot make a follow-up commit from `/workspace`. So the
**implementation PR itself sets `status: done` + `completed: <date>`** in the
issue frontmatter when you open it (by merge time it IS done; queue rejections
are rare, and the gate already verified what the queue re-verifies). Do NOT
open the PR at `in-review` and plan a later flip — that is exactly what orphans
issues at `in-review` (see #1602/#1603/#1606).

**Once queued, your job is done.** Do not wait for the actual merge. Proceed immediately:

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

> If the queue _rejects_ the PR (rare — see below), the `status: done` you set
> has not yet landed on main, so nothing is orphaned; re-evaluate and re-queue.

### If the queue rejects your PR

GitHub will comment on the PR if the final queue checks fail (rare — would mean something flipped between your CI run and the queue's re-run, likely main moved). In that case:

- The auto-refresh workflow may have already pushed a merge of main into your branch — fetch and review
- Re-evaluate /dev-self-merge against the new CI run
- If still good, re-queue with the GraphQL `enqueuePullRequest` mutation above (NOT `gh pr merge --auto` — see why in Step 5)

### Admin direct-merge — only when

Use `gh pr merge <N> --merge --admin` (bypassing the queue) only when:

- The change is workflow-only / CI-only and the queue ruleset checks don't apply
- Tech lead explicitly authorizes a hotfix bypass
- The queue itself is broken and needs unblocking

Set `GATE_BYPASS=1` if the local pre-commit hook blocks because `pr-<N>.json` isn't present. **Tech-lead use only.**

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
