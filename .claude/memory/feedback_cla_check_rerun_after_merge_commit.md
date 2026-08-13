---
name: feedback_cla_check_rerun_after_merge_commit
description: "Fork PR enqueue fails with \"cla-check expected\" after a merge-main commit; re-run the cla-check workflow to repost the status on the new head"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 64a72f6d-c076-4dff-8bd4-7e7d93e3852c
---

When the merge queue (or a drift-update) adds a `Merge branch 'main'` commit on top of a fork PR branch, the **new head SHA has no `cla-check` commit status**, so `enqueuePullRequest` fails with `Required status check "cla-check" is expected` even though the CLA workflow already passed on the *prior* head. The `auto-enqueue.yml` backstop hits the same wall.

**Why:** `.github/workflows/cla-check.yml` runs on `pull_request_target` and posts `cla-check` to `pr.head.sha` via the statuses API. It does NOT re-run automatically when a merge commit changes the head, so the status lands on the old SHA only.

**How to apply:** `gh run rerun <cla-check-run-id> -R loopdive/js2wasm` — the `pull_request_target` re-run re-resolves `pr.head.sha` to the current head and reposts `cla-check: success` there. Find the run with `gh run list -R loopdive/js2wasm --workflow cla-check.yml --branch <branch> --limit 1`. Wait ~45s, confirm via `gh api repos/loopdive/js2wasm/commits/<head-sha>/status --jq '.statuses[]|select(.context=="cla-check")'`, then re-enqueue. (Hit on #2061 / PR #1365, 2026-06-11.) Related: [[feedback_cla_gate]].
