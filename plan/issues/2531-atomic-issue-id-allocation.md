---
id: 2531
title: "Atomic, collision-proof issue-ID allocation + PR-time uniqueness gate"
status: done
sprint: 64
created: 2026-06-20
completed: 2026-06-20
priority: high
feasibility: medium
task_type: infrastructure
area: tooling
language_feature: n/a
goal: correctness
related: [2168, 2530, 1616, 1858]
assignee: "ttraenkler/dev-allocation"
---

# #2531 — atomic issue-ID allocation + enforced uniqueness at source

## Problem

The 2026-06-20 merge-queue incident was caused by issue-ID collisions.
Developers hand-pick the `plan/issues/<id>-<slug>.md` id optimistically
("next free off `main`"), but multiple devs on separate branches each pick the
same number because none of their new issue files are on `main` yet. The
duplicate is green at PR time (the colliding file isn't on the branch) and only
fails in the `merge_group`, wedging the queue (see
`project_merge_queue_dup_issue_id_churn`).

ID allocation must be collision-proof **at the source** (atomic reservation),
and a required CI check must **reject** any PR that introduces a colliding id.

## Fix (prevention b — allocation + uniqueness-at-source)

### 1. Atomic allocation — `claim-issue.mjs --allocate`

`scripts/claim-issue.mjs` gains an `--allocate` mode that reserves the next
free id **atomically** against THREE populations, because no single one closes
the race:

- ids already on `origin/main` (the committed record);
- ids added by **every currently-open PR** (in-flight files not yet merged —
  the exact race the wedge came from), scanned via `gh pr view --json files`;
- ids already **reserved on the orphan `issue-assignments` ref** (concurrent
  allocators that won a push microseconds ago).

The next id is `max(union) + 1` (monotonic; strays > 1000 above the contiguous
body are dropped so a mistyped `6406` can't poison `max+1`, re: #1858). The
reservation is written to the orphan ref with the SAME first-push-wins
atomicity as a claim: the loser's push is rejected non-fast-forward, it
re-fetches (now seeing the winner's reservation), and recomputes a fresh id.
Two concurrent allocators therefore can **never** hand out the same number.

- `node scripts/claim-issue.mjs --allocate` → prints the reserved id to stdout.
- `node scripts/claim-issue.mjs --allocate ttraenkler/<agent> --branch <b>` →
  reservation doubles as the claim lock.
- `--dry-run` previews the candidate without reserving; `--no-pr-scan` skips
  the (slower) open-PR scan; `--json` for machine consumption.

### 2. Required CI gate — `check-issue-ids.mjs --against-main`

`scripts/check-issue-ids.mjs` gains an `--against-main` mode (wired into the
`quality` job as `check:issue-ids:against-main`). It diffs the ids this branch
*introduced* (present at `HEAD`, absent at the merge-base with `origin/main`)
against the ids on `origin/main` and FAILS the PR if any collide — before it
can reach the merge queue, with a precise "reserve a fresh id via
`claim-issue.mjs --allocate`" remediation message. Skips cleanly when the base
ref isn't fetched (shallow clone) so it never blocks a build it can't reason
about; the sibling merged-state dup gate (#2530) is the backstop there.

### 3. Documented required flow

CLAUDE.md ("Issues" section), `.claude/agents/product-owner.md`, and
`.claude/agents/developer.md` now state that new issues MUST be created via
`claim-issue.mjs --allocate`, never by hand-picking a number.

## Acceptance criteria

- [x] `claim-issue.mjs --allocate` reserves an id unique against main + open
      PRs + ref reservations, atomically (first-push-wins, retry on contention).
- [x] `check-issue-ids.mjs --against-main` rejects a PR introducing a
      main-colliding id; passes when the branch introduces only fresh ids;
      skips cleanly without the base ref.
- [x] Gate wired into the `quality` CI job (required check).
- [x] Required flow documented in CLAUDE.md + product-owner + developer defs.

## Test Results

- `--allocate --dry-run --no-pr-scan` → next free `#2532` (main ∪ ref).
- `--allocate --dry-run` (PR scan on) → next free `#2541` (main ∪ ref ∪ open
  PRs found ids 2532–2540 in-flight) — exactly the collision the naive
  "next free off main" would have hit.
- `--against-main` on a clean branch → OK (0 introduced).
- `--against-main` with a simulated main-colliding id → FAILED with the
  remediation message (verified locally).
