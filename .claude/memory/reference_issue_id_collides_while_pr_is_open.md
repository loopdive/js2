---
name: reference-issue-id-collides-while-pr-is-open
description: "Issue ids are reserved at branch-cut and validated only against the MERGED state, so any PR adding an issue file collides if it stays open long enough — three collisions in one sweep, two of which auto-parked a PR"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-25T22:06:46.381Z
---

**Any PR that adds a `plan/issues/<id>-*.md` file and stays open long enough
will eventually collide.** The id is reserved at branch-cut; `check-issue-ids
--against-main` only fails on the **merged** state. So the PR is green at PR
level and only fails in the `merge_group`, where `auto-park` `hold`-labels it —
and a held PR is skipped by `auto-enqueue`, so it **strands silently**.

Observed 2026-07-25, three collisions in a single lead sweep:

- PR #3614 carried **two** (`#3619`, `#3620`) — this is what auto-parked it.
- PR #3627 (mine) carried one (`#3630`) — main landed a *different* #3630 while
  the PR was open.

Eight more were recorded in the preceding 24h. This is a rate, not bad luck.

## Do this every time

After `node scripts/claim-issue.mjs --allocate`, **verify the id yourself**
before using it — the allocator hands out taken ids (#3636):

```bash
git ls-tree -r --name-only upstream/main plan/issues/ | grep -E "/$NEW-"
for n in $(gh pr list -R loopdive/js2wasm --state open --json number -q '.[].number'); do
  gh pr view $n -R loopdive/js2wasm --json files -q '.files[].path' | grep -E "plan/issues/$NEW-"
done
for b in $(git branch --format='%(refname:short)'); do
  git ls-tree -r --name-only $b plan/issues/ 2>/dev/null | grep -E "/$NEW-"
done
```

## Fixing a collision

Rename-only, and **retarget every reference** — frontmatter `id:`, the `# #NNNN`
heading, in-body `#NNNN` mentions, the `related:` list (bare numbers, easy to
miss), and any `(#NNNN)` comment tags in source/test files. Leaving one behind
points the code at whatever unrelated issue now owns the old id.

## Park-triage note

`gh run view --log-failed` on a cited park run frequently returns **empty**
(expired). An empty log is indistinguishable from "no failure found" — do not
read it as clean. **Reproduce the gate locally instead**
(`node scripts/check-issue-ids.mjs --against-main` after merging main), which
also gives you a before/after control. Note the gate reads **committed** state,
so a staged-but-uncommitted rename still reports the old failure.

Related: [[reference_cross_session_issue_id_collision_renumber_loser]],
[[reference_subissue_filename_dupid_gate]],
[[reference_merge_queue_park_triage_four_causes]],
[[feedback_check_declared_rebaseline_before_crying_corruption]].
