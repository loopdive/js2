---
name: feedback_merge_queue_wedge_recovery
description: "Recover a wedged GitHub merge queue (entries stuck AWAITING_CHECKS, no merge_group CI, Actions idle) by dequeue+re-enqueue"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9b7877fc-6699-40e1-b5cf-8f2f65bfd493
---

The loopdive/js2wasm GitHub merge queue periodically **wedges**: entries sit
`AWAITING_CHECKS` indefinitely, **zero `merge_group` CI runs fire**
(`gh run list` filtered to `gh-readonly-queue` branches is empty), and
GitHub Actions is **idle** (not congested) — so it is NOT an Actions
throughput problem and it does NOT self-recover. The wedged PRs are often
fully green at the PR level (all required checks pass) yet never merge.

**Recovery (no main-write, no admin needed):** dequeue then re-enqueue each
stuck PR to force a fresh merge group, which triggers `merge_group` CI:
```
ID=$(gh pr view <N> -R loopdive/js2wasm --json id -q .id)
gh api graphql -f query='mutation($id:ID!){dequeuePullRequest(input:{id:$id}){clientMutationId}}' -f id="$ID"
gh api graphql -f query='mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}' -f id="$ID"
```
Note the **input field names differ**: dequeue uses `id`, enqueue uses
`pullRequestId`. Within ~25s a `gh-readonly-queue/...` run goes
`in_progress` — that confirms recovery.

**Why:** This was misdiagnosed twice as (a) Actions congestion and (b)
`[skip ci]` base-poison (main HEAD being a forced-refresh `[skip ci]`
commit). Both were wrong — the real cause is a stuck merge-group state;
the dequeue+re-enqueue kick fixes it regardless of base. Distinguish from
the genuine doc-drift block (where `quality`/sync:conformance fails on main
HEAD and PRs show BLOCKED, not AWAITING_CHECKS) — that one needs a doc-sync
fix to merge, see [[project_next_session]].

**How to apply:** When nothing has merged for 30+ min and the queue front
is AWAITING_CHECKS with idle Actions, don't wait for self-recovery and
don't escalate for an admin-merge — kick each wedged entry. The
auto-enqueue backstop (`enqueue-green-prs.mjs`) does NOT dequeue stuck
entries, so it can't fix a wedge on its own.
