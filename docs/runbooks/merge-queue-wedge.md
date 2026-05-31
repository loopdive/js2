# Runbook: merge-queue wedge (no `merge_group` dispatch)

**Issue:** #1761 · **Memory:** `.claude/memory/feedback_wedged_merge_queue_reset.md`
· **Related:** #1758 (trigger reduction)

## Symptom

PRs enqueue and sit in `AWAITING_CHECKS` (or `QUEUED`) forever; **zero
`merge_group` workflow runs fire**. Ordinary PR CI (`pull_request` / `push` /
`schedule`) keeps running fine and **githubstatus.com shows no incident**. This
is GitHub-side queue-processor state, not our config — it has recurred ~4× in
24h.

## Confirm it's a real wedge (not a slow head)

```bash
# Newest merge_group run — compare its created_at to the oldest stuck entry's enqueuedAt.
gh api '/repos/loopdive/js2/actions/runs?event=merge_group&per_page=1' \
  | jq '.workflow_runs[0] | {name, created_at, head_branch, conclusion}'

# Oldest queue entry + state + enqueuedAt:
gh api graphql -f query='{ repository(owner:"loopdive",name:"js2"){
  mergeQueue(branch:"main"){ entries(first:20){ nodes {
    enqueuedAt state position pullRequest { number } } } } } }' \
  | jq '.data.repository.mergeQueue.entries.nodes'
```

**WEDGED** = oldest entry is `AWAITING_CHECKS`, enqueued > ~20 min ago, AND no
`merge_group` run was _created_ since that `enqueuedAt`. If a `merge_group` run
created at/after the oldest enqueue exists, the dispatcher is alive (just slow) —
do **not** reset.

## Automatic recovery — the watchdog

`.github/workflows/merge-queue-watchdog.yml` runs `scripts/merge-queue-watchdog.mjs`
every 15 min (and on `workflow_dispatch`). It applies the detect logic above and,
when WEDGED, performs the proven recovery automatically:

1. **Ruleset reset (preferred, needs `Administration:write`):** back up ruleset
   `16700772`, PUT it with the `merge_queue` rule removed (keeping
   `required_status_checks`), **sleep 600 s** (a quick toggle does NOT work),
   restore the original verbatim, then re-enqueue green PRs.
2. **Admin-merge drain (fallback, only contents/PR write):** `gh pr merge
<stuck-green-head> --admin --merge` to drain the wedged head, logged as a gate
   bypass. Unblocks humans but does NOT fix the processor.

**Guards (idempotent / rate-limited):** aborts if the `merge_queue` rule is
already absent (a reset is mid-flight) or if the ruleset was updated within the
last 30 min (cooldown). Single-flight via `concurrency: mq-watchdog`.

**Dry run on demand:**

```bash
DRY_RUN=1 node scripts/merge-queue-watchdog.mjs
# or: gh workflow run merge-queue-watchdog.yml -f dry_run=true
```

### Enabling the clean reset path

Editing the ruleset needs **`Administration:write`**, which the default
`GITHUB_TOKEN` lacks. The workflow uses
`secrets.MQ_ADMIN_TOKEN || secrets.AUTO_ENQUEUE_TOKEN || secrets.GITHUB_TOKEN`.
If no admin-capable token is present, only the fallback drain runs. **Wire a
fine-grained PAT/App token with `Administration:write` as `MQ_ADMIN_TOKEN`** to
enable the proper reset.

## Manual recovery (if the watchdog is disabled / failing)

1. Back up: `gh api /repos/loopdive/js2/rulesets/16700772 > /tmp/ruleset.json`
2. PUT a payload of `{name,target,enforcement,conditions,bypass_actors,rules}`
   with the `merge_queue` rule removed from `rules[]`.
3. **Wait ~10 minutes** (not seconds — GitHub must fully drain the queue state).
4. Re-PUT the original `/tmp/ruleset.json` rules verbatim.
5. Re-enqueue: `node scripts/enqueue-green-prs.mjs`. Watch for a `merge_group`
   run on the next `gh-readonly-queue/main/pr-N-…` ref to confirm dispatch.

Interim while wedged: `gh pr merge <N> --admin --merge` on a fully-green PR only.
Clean up orphaned `gh-readonly-queue/main/pr-*` refs for already-merged PRs.

## Root cause — file a GitHub Support ticket

The watchdog is **recovery**, not a fix. The recurring `merge_group`
non-dispatch with clean config and no incident is a GitHub-side bug; only a
**GitHub Support ticket** gets it fixed at the source. Include: the confirming
queries above, the matching required-check names from the last good
`merge_group` run, ~4 wedge timestamps in 24h, and that githubstatus.com showed
no incident. (Needs the org's support portal — maintainer action.)

## Config levers to reduce wedge frequency (trial after the watchdog is live)

The queue is **serial** (`max_entries_to_build = 1`). Worth confirming
`check_response_timeout_minutes` is not unbounded (so a dead head times out and
recycles instead of holding the serial slot), and trialing
`grouping_strategy: ALLGREEN` with a small batch to reduce per-PR serial poking
(#1758). Trial these only once the watchdog provides a safety net.
