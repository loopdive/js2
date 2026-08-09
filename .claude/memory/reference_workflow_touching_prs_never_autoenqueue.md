---
name: reference_workflow_touching_prs_never_autoenqueue
description: "FALSIFIED as stated — workflow-touching PRs CAN auto-enqueue. The three original cases were all FORK-head; the blocker correlates with fork-head, not with touching .github/workflows/. Always check the queue before enqueuing."
metadata:
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-26T21:05:01.730Z
---

**⚠ The original claim — "a PR modifying `.github/workflows/**` can NEVER be
auto-enqueued" — is FALSIFIED by direct counterexample.** Do not act on it.

**Counterexample, measured 2026-07-26T21:02:35Z.** PR #3690 changes
`.github/workflows/test262-sharded.yml` and was enqueued **by
`js2-merge-queue-bot`**, ~seconds after `quality` went green, with no human
action. `scripts/enqueue-green-prs.mjs` contains **no exclusion whatsoever**
for workflow-touching PRs — grep it; the only `.github` mentions are about the
enqueuer's own trigger.

**The confound the original note missed.** Its three cases were #3590, #3609,
#3602 — all skipped `BLOCKED`, all needing a human PAT enqueue. They shared
*two* properties, and the note attributed the effect to the wrong one:

| PR | head repo | touches workflows | auto-enqueued |
|---|---|---|---|
| #3590 / #3609 / #3602 | **`ttraenkler:`** (fork) | yes | **no** |
| #3690 | **`loopdive:`** (upstream) | yes | **yes** |

Varying only the head repo flips the outcome. So **touching
`.github/workflows/` is not sufficient to cause the block**; fork-head is the
better-correlated variable (consistent with GitHub refusing to let an app token
trust workflow changes arriving from a fork). n=3 vs n=1 — that is a corrected
attribution, **not** a proven mechanism. Do not promote it to a new "never."

**The safe operational rule, correct under every hypothesis:**

> **Check the queue BEFORE enqueuing, always. Never enqueue from a belief
> about whether the workflow *would* have.**

```bash
gh api graphql -f query='{repository(owner:"loopdive",name:"js2wasm"){mergeQueue
  {entries(first:20){nodes{position state enqueuedAt enqueuer{login}
   pullRequest{number}}}}}}'
```

**Why this matters more than the taxonomy.** On 2026-07-26 the lead instructed
the shepherd to do "one deliberate PAT enqueue" on #3690 *because of this note*.
The shepherd checked the queue first and found it already there at position 2 —
had it obeyed, the re-add would have rebuilt the merge group and **cancelled
#3678's in-flight `AWAITING_CHECKS` run at position 1**
([[reference_never_push_to_a_queued_pr_it_ejects_to_the_back]]). A stale
"needs a manual enqueue" belief plus an already-queued PR is exactly how a
re-enqueue loop starts. The check costs one API call.

If a green, non-draft, non-`hold` PR genuinely never appears in the queue,
diagnose from the enqueue sweep log rather than assuming this class —
and note that an admin/PAT `CLEAN` really is a bypass artifact
(ruleset grants `current_user_can_bypass: "always"`), so `CLEAN` from a human
token still does not tell you the enqueuer's view. That part of the original
note survives.

## RE-CONFIRMED LIVE 2026-08-02 (#4046) — the FALSIFIED marking is itself falsified

The App-token `enqueuePullRequest` was refused with the exact string
`Pull request refusing to allow a GitHub App to create or update workflow
'.github/workflows/baseline-summary-sync.yml'` — attribution clean, not
correlational: same mutation, same PR, same instant, refused for the App,
**accepted for the user PAT** (scope `workflow` present). The old entry
attributed the effect to fork-head; the refusal string names the App and the
file, so the mechanism is now unambiguous.

**Scope of the restriction — measured end-to-end, and narrower than feared:**

> **The App block applies to the ENQUEUE mutation only. Once enqueued (by
> PAT), the merge queue MERGES workflow-touching PRs fine** — #4046 went
> position 3 → merge_group green → merged 18:06:02Z with no further friction.

So the shepherd's one-shot PAT enqueue is a **complete remedy** for this
class, not a step that moves the block to merge time. Standing rule until an
admin grants the App the `workflows` permission: every workflow-touching PR
needs the shepherd's manual one-shot; `auto-enqueue` will refuse it and —
because the run still concludes `success` — the refusal is visible only in
the job log (via #4038's telemetry; before that, nothing printed at all).

Related: [[reference_never_push_to_a_queued_pr_it_ejects_to_the_back]] ·
[[reference_autoenqueue_grace0_races_mergestate_recompute]] ·
[[reference_ci_status_feed_retired_use_required_checks]]
