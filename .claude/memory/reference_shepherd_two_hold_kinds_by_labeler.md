---
name: reference_shepherd_two_hold_kinds_by_labeler
description: "PR-shepherd — distinguish bot park-hold (real regression, never lift blind) vs dev stacking-hold (benign ordering, lift when first-in-stack clean) by the label ACTOR"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

A `hold` label has TWO distinct meanings; tell them apart by **who applied it**
(`gh api repos/loopdive/js2wasm/issues/<N>/timeline` → last `labeled`/`hold`
event's `.actor.login`, or `/issues/<N>/events`):

1. **Bot park-hold** — actor `github-actions[bot]`, accompanied by an
   `<!-- auto-park-bot:merge-group-failure -->` comment listing failed checks.
   This is a REAL merged-baseline regression that PR-level checks miss (#2547).
   **NEVER remove without diagnosing the cited merge_group run** (pull the
   regressed-test delta, decide real vs flake). See
   [[reference_shepherd_attribute_park_to_own_mergegroup_run]].

2. **Dev / stacking-hold** — actor is a human/dev identity (e.g. `ttraenkler`)
   with NO park-bot comment. Benign ordering hold to keep a PR stack landing in
   sequence (predecessor must land first). **LIFT-ABLE** the moment the PR is
   verified-clean (head moved, all required checks green, mergeStateStatus
   CLEAN) and first-in-stack — it is NOT a regression flag. Lifting it on a
   green first-in-stack PR is correct and keeps the queue moving; leaving it
   stalls the queue waiting on a human.

Worked example (2026-06-22, #1962 emitToNumber): hold was added by
`ttraenkler` (dev stacking-hold, no park comment) after #1960 landed. Cleared it
via REST DELETE + one-shot enqueued — correct. Contrast #1958/#1960 earlier:
those were `github-actions[bot]` park-holds for real regressions, correctly kept
until the owner fixed forward.

Always clear via REST `DELETE /issues/N/labels/hold` and verify (gh pr edit can
silently no-op, [[reference_remove_label_via_rest_not_gh_pr_edit]]).
