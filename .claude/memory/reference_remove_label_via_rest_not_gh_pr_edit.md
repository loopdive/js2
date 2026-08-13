---
name: reference_remove_label_via_rest_not_gh_pr_edit
description: gh pr edit --remove-label can silently fail (projects-classic GraphQL deprecation); use REST DELETE and verify
metadata: 
  node_type: memory
  type: reference
  originSessionId: 54c1df0f-04d4-4026-b675-77fe695fb95c
---

`gh pr edit <N> --remove-label hold` (and `--add-label`) goes through a GraphQL
mutation that, on this repo, trips the **projects-classic deprecation** path and
prints `GraphQL: Projects (classic) is being deprecated ... (repository.pullRequest.projectCards)`
— and the **label change does NOT take effect** even though the command exits 0.

Observed 2026-06-22 (PR-shepherd, #1958): removed `hold` via `gh pr edit
--remove-label hold`, got the projects-classic warning, but the label was still
present (REST `/issues/N/labels` showed `hold`; timeline showed no new
`unlabeled` event). A stale-label read then caused a watcher to falsely report
"RE-PARKED".

Reliable removal (bypasses the projects-classic GraphQL path):
```bash
gh api -X DELETE repos/loopdive/js2wasm/issues/<N>/labels/hold
gh api repos/loopdive/js2wasm/issues/<N>/labels -q '.[].name'   # verify it's gone
```
Always VERIFY the label set via REST after any add/remove — do not trust the
`gh pr edit` exit code. When deciding "was this PR re-parked?", check the
timeline's last `labeled hold` **timestamp** against the known prior park time,
not just label presence (a stale label ≠ a new park).
See [[reference_shepherd_attribute_park_to_own_mergegroup_run]].
