---
id: 1761
title: "self-healing merge-queue watchdog — auto-recover from merge_group dispatch wedge"
status: in-progress
created: 2026-05-31
updated: 2026-05-31
priority: high
feasibility: hard
task_type: feature
area: ci-infra
goal: platform
related: [1758, 1756]
depends_on: []
sprint: Backlog
---

# #1761 — self-healing merge-queue watchdog

## Problem

GitHub's merge queue periodically stops dispatching `merge_group` events: PRs
enqueue and sit forever in `AWAITING_CHECKS`, **zero `merge_group` workflow runs
fire**, while ordinary `pull_request` / `push` / `schedule` Actions keep working
and githubstatus.com shows no incident. It is GitHub-side queue-processor state,
not our config. This has wedged **~4× in 24h** (see #1758 for the latest two and
the trigger analysis).

Confirmation each time:

```
gh api '/repos/loopdive/js2/actions/runs?event=merge_group&per_page=1'
```

shows no run newer than the oldest stuck entry's `enqueuedAt`.

#1758 made auto-enqueue **surgical** to reduce the _trigger_ (the high-frequency
serial-queue poke). This issue adds the _recovery_ automation: a watchdog that
detects the wedge and performs the proven reset with no human in the loop.

## The one proven manual recovery (see `feedback_wedged_merge_queue_reset`)

1. Back up ruleset **16700772** verbatim.
2. PUT a payload that **omits the `merge_queue` rule** but keeps
   `required_status_checks` (+ identical name/target/enforcement/conditions/
   bypass_actors).
3. **Wait ~10 minutes** — a quick toggle does NOT work; GitHub must fully drain
   the queue-processor state.
4. Re-PUT the **original** ruleset (restore the captured backup verbatim).
5. Re-enqueue the green PRs.

## Deliverable

1. **`scripts/merge-queue-watchdog.mjs`** — detect + recover (idempotent,
   rate-limited, `DRY_RUN=1` supported).
2. **`.github/workflows/merge-queue-watchdog.yml`** — schedule every ~15 min +
   `workflow_dispatch`; single-flight concurrency; `timeout-minutes: 25` (the
   recover path sleeps 600 s).
3. **`docs/runbooks/merge-queue-wedge.md`** — symptom, auto-watchdog, manual
   fallback.

## Detect logic

WEDGED iff **all** hold:

- The merge queue has ≥1 entry.
- The **oldest** entry is `AWAITING_CHECKS` and was `enqueuedAt`
  > `WEDGE_THRESHOLD_MIN` (env, default 20) minutes ago.
- **No `merge_group` Actions run was created since that `enqueuedAt`.**

The third clause is the load-bearing one: it distinguishes a normally-building
head (merge_group runs ARE firing, just slow) from a provably dead dispatcher.
We never recover on a slow-but-live queue.

## Recovery path chosen — and the auth crux

Editing ruleset 16700772 needs **repo-admin** (`Administration: write`). The
default `GITHUB_TOKEN` cannot. The repo already ships an admin-capable PAT in
Actions as **`AUTO_ENQUEUE_TOKEN`** (used by `auto-enqueue.yml`); whether _that_
specific token carries `Administration: write` is not knowable from a secret
name alone, so the script **auto-detects** capability at runtime:

- **Preferred path — ruleset reset** (`MQ_ADMIN_TOKEN` / `ADMIN_TOKEN` /
  `AUTO_ENQUEUE_TOKEN` with admin): back up → disable `merge_queue` rule → sleep
  600 s → restore verbatim → re-enqueue green PRs. The clean, complete recovery.
  The script probes admin by reading the ruleset and confirming the token can
  write it (a dry PUT of the _unchanged_ ruleset is the capability probe; on
  403 it falls back).
- **Fallback path — gate-bypass drain** (only contents/PR-write available):
  `gh pr merge <stuck-green-head> --admin --merge` to drain the wedged head,
  **only** when that PR's required PR-level checks are green. Clearly logged as a
  gate bypass. This unblocks humans but does NOT fix the queue processor; the
  next enqueue may re-wedge until an admin token enables the reset path.

**Recommendation:** wire a fine-grained PAT/App token with
`Administration: write` (e.g. `MQ_ADMIN_TOKEN`) into repo secrets so the
watchdog always takes the clean reset path. The fallback is a stopgap.

## Idempotency / rate-limiting

- If the `merge_queue` rule is **already absent** from the ruleset → a reset is
  mid-flight (or the rule is mis-configured) → **abort, do nothing**. (This is
  exactly the live state during a maintainer reset; the watchdog must not capture
  a queue-less ruleset as its "original" baseline and restore a broken config.)
- If the ruleset `updated_at` is within the last **~30 min** → a reset just ran →
  **abort** (cooldown). `updated_at` is the marker; no external state needed.
- Workflow `concurrency: { group: mq-watchdog, cancel-in-progress: false }`
  guarantees single-flight across the 15-min schedule and the 10-min sleep.

## Validation

- `DRY_RUN=1 node scripts/merge-queue-watchdog.mjs` prints a correct
  WEDGED/healthy decision against the live queue, no mutation.
- Lint/format clean; valid YAML.

## GitHub Support ticket (maintainer action — I cannot file this)

The only thing that fixes the **root cause** is a GitHub Support ticket: report
recurring `merge_group` non-dispatch (queue accepts enqueues, builds no merge
group), clean ruleset config, required-check names matching the last good
merge_group run, and **no githubstatus.com incident**. Include the confirming
query above and ~4 wedge timestamps in 24h. Filing needs the org's support
portal, which only the maintainer can access.

## Config changes that would reduce wedge frequency (notes, not the deliverable)

Observed `merge_queue` is **serial** (`max_entries_to_build = 1` per #1758).
Levers worth trialing once the watchdog provides a safety net:

- **`check_response_timeout_minutes`** — if set very high, a stuck head holds the
  serial slot indefinitely; a saner value (e.g. matching the longest required
  check + margin) lets GitHub time out and recycle a dead head instead of
  wedging. Worth confirming the current value and lowering it.
- **`grouping_strategy: ALLGREEN` + a small batch** (`max_entries_to_build: 2–3`,
  `min_entries_to_merge` with a short `min_entries_to_merge_wait_minutes`) —
  reduces the per-PR serial poking that #1758 implicates as the trigger; a wedge
  on a batch still drains via timeout rather than stranding one-at-a-time.
  These are config trials to run **after** the watchdog lands (so a bad trial
  self-heals). Not changed here.

## Implementation notes (why, not just what)

- **Restore-from-captured-backup, never reconstruct.** The `merge_queue` rule's
  exact params (timeouts, grouping, batch sizes) are not stored anywhere in the
  repo; the script captures the live ruleset _before_ disabling and restores that
  exact object. Hardcoding params would silently drift the queue config on every
  recovery.
- **Order of guards matters.** The "`merge_queue` rule already absent" guard must
  run _before_ capturing the baseline, else a watchdog that fires during a
  maintainer reset would snapshot the queue-less ruleset and "restore" a
  permanently queue-disabled main.
- **Detect is conservative by construction** — three ANDed clauses, the last
  requiring provable dispatcher death. False-negative (miss a wedge for one
  15-min cycle) is acceptable; false-positive (reset a healthy queue, 10-min
  outage) is not.
