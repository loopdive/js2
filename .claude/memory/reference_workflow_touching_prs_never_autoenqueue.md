---
name: reference_workflow_touching_prs_never_autoenqueue
description: "A PR modifying .github/workflows/ can NEVER be auto-enqueued — the app token sees BLOCKED; an admin's CLEAN is a bypass artifact. Needs a manual PAT enqueue."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-25T23:31:11.968Z
---

**Any PR that modifies `.github/workflows/**` strands forever under `auto-enqueue.yml`.**
The workflow's GitHub App token is blocked by the repo ruleset from touching
workflow files, so it evaluates the PR as `mergeStateStatus: BLOCKED` and skips it.
The ~30-min cron never recovers it either — it re-evaluates identically.

**The trap that hides this:** an admin/PAT query reports the SAME PR as `CLEAN`,
because ruleset 16700772 grants `current_user_can_bypass: "always"`. So
**`CLEAN` seen from a human token is a bypass artifact, not the enqueuer's view.**
Never conclude "it's CLEAN, the workflow will pick it up" for a workflow-touching PR.

Measured 2026-07-26 (PR #3590). Corroborated in the enqueue sweep log at 13:08Z:
`#3609 skip (BLOCKED)` and `#3602 skip (BLOCKED)` — the only two other recent
workflow-touching PRs — both then required a human `ttraenkler` PAT enqueue at
13:15Z, while every non-workflow PR that sweep was enqueued by
`js2-merge-queue-bot[bot]`.

**Resolution:** these need ONE deliberate maintainer/PAT enqueue (GraphQL
`enqueuePullRequest`). This is the sanctioned lead/shepherd backstop, NOT a dev
action, and it is still ONE-SHOT — never re-enqueue (a re-add rebuilds the merge
group and CANCELS the in-flight `merge_group` run).

**Diagnostic:** if a PR is green on all required checks, carries no `hold`, is not
a draft, and yet never appears in the queue — check whether its diff touches
`.github/workflows/` BEFORE hunting for a failing gate. This class looks identical
to a healthy PR from the outside.

Distinct from [[reference_dropped_synchronize_only_cla_check_repush]] (checks never
dispatched) and from [[reference_ci_status_feed_retired_use_required_checks]].
