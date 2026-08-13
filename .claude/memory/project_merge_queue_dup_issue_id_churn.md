---
name: project-merge-queue-dup-issue-id-churn
description: "Queue churns (PRs cycle, never merge) = duplicate issue-ID gate failing on merge_group only; PR green at PR-time, collides when merged with advanced main"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

# Merge-queue CHURN (distinct from WEDGE): duplicate issue-ID on merge_group

**Symptom**: queue head keeps reaching validation, **failing `quality` (ci.yml,
"Issue integrity + link gate" #1616) with `--check FAILED: N duplicate IDs`**,
ejecting, and being re-added by auto-enqueue — main never advances, queue depth
stays flat or grows. This is CHURN, not the WEDGE (runs DO fire here). See
[[project_merge_queue_wedge_github_token]] for the zero-runs wedge.

**Root cause**: a PR adds `plan/issues/<ID>-<slug>.md` whose `ID` is unique
against *the main it branched from*, but main has since advanced (other PRs
merged new issues with that same ID). The PR-time `quality` check runs on the
PR's stale branch → passes. The **merge_group** check runs on `main + PR` →
duplicate ID → fails. So the PR is `CLEAN`/green at PR-level yet can never merge.
Same drift class as [[project_addunionimports_late_shift_hazard]] / the #2522
branch-base lesson, but for issue-ID allocation. Frequent after a batch of
issue-creating PRs lands (2026-06-20: 7 of 10 queued PRs collided, several
against issues merged the same night — #2519, #2523).

**Diagnose**: for each queued PR, compare its added `plan/issues/NNNN-*.md` IDs
against `git ls-tree origin/main plan/issues/` — any ID present on main with a
*different slug* is a collision. The merge_group `quality` log names the count
but the failing line is `DUPLICATE IDs (N):` just above `--check FAILED`.

**Unblock** (reversible): label each colliding PR **`hold`** (auto-enqueue skips
hold/do-not-merge/wip) and dequeue it, so the non-colliding PRs drain instead of
churning. NB: **`gh pr edit --add-label` fails** on this repo (aborts on a
Projects-classic GraphQL deprecation error) — use the REST endpoint instead:
`gh api -X POST repos/loopdive/js2wasm/issues/<pr>/labels -f 'labels[]=hold'`.
The merge queue does NOT read the label (only auto-enqueue does), so dequeue
once AFTER the label lands or auto-enqueue re-adds within ~1 min.

**Real fix** (per PR, needs author/context — esp. multi-ID or cross-colliding
PRs): renumber the issue file (filename + frontmatter `id:`) to a free ID,
`git merge origin/main`, push, remove `hold`, re-enqueue. Prevention is the
#2522 rule: merge origin/main before enqueue so the collision surfaces at
PR-time, not in the queue.
