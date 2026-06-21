---
name: project-merge-queue-wedge-github-token
description: "Merge queue stuck (head AWAITING_CHECKS, ZERO merge_group runs) = PRs enqueued via GITHUB_TOKEN, NOT a GitHub outage"
metadata: 
  node_type: memory
  type: project
  originSessionId: 75ffdde9-6b72-447e-992f-f6b025616c19
---

# Merge-queue wedge root cause: enqueuing via GITHUB_TOKEN

**Symptom** (cost a full night, 2026-06-19/20): merge-queue head sits
`AWAITING_CHECKS` indefinitely with **zero `merge_group` Test262 runs created**.
Looks exactly like a "webhook-drop" / GitHub event-delivery outage. It is NOT.

**Root cause**: a PR enqueued via **`GITHUB_TOKEN`** (i.e. by `github-actions[bot]`)
does **not** trigger `merge_group` workflows. GitHub's rule "a workflow run using
`GITHUB_TOKEN` cannot trigger another workflow run" suppresses the `merge_group`
`checks_requested` event, so no required check is ever produced → head wedges.
Our `auto-enqueue.yml` and `queue-unstick.yml` use
`GH_TOKEN: ${{ secrets.AUTO_ENQUEUE_TOKEN || secrets.GITHUB_TOKEN }}` — when
`AUTO_ENQUEUE_TOKEN` is unset they fall back to `GITHUB_TOKEN` and every PR they
enqueue/requeue wedges. Dev self-enqueues (user PAT via `gh api graphql
enqueuePullRequest`) work fine — that's why it's intermittent.

**NOT the cause** (ruled out 2026-06-20): GitHub outage (status all-operational,
0 incidents; `pull_request`/`push` runs fire normally); billing/throttling
(public repo = standard runners **free + unlimited minutes**; the $-figure is
100% discounted, nothing to throttle). There IS a per-plan **concurrency cap**
(Free 20 / Pro 40 / Team 60 / Enterprise 180 concurrent jobs) — that explains
*starvation* (jobs `queued`) when 114-job merge_group matrices × speculation
oversubscribe, but NOT "0 runs created".

**Confirmation test**: dequeue all → `enqueuePullRequest` ONE PR via **user PAT**
(`gh` here is authed as `ttraenkler`, a PAT) → a `merge_group` run appears within
~60s and completes. GITHUB_TOKEN-enqueued heads = 0 runs. Proven on #1767.

**Immediate unblock** (no ruleset reset, no unstick — those re-enqueue via
GITHUB_TOKEN and DON'T help): disable `auto-enqueue.yml`, then dequeue every
queue entry and re-`enqueuePullRequest` it via PAT:
`gh api graphql -f query='mutation($id:ID!){enqueuePullRequest(input:{pullRequestId:$id}){clientMutationId}}' -f id=<PR node id>`.
Serial queue (`max_entries_to_build=1`, set in #2519 era) then drains one 114-job
group at a time.

**Permanent fix**: set the `AUTO_ENQUEUE_TOKEN` secret to a **GitHub App
installation token** (preferred — app tokens bypass the trigger restriction, not
user-tied, scoped) or a fine-grained **PAT** (pull-requests + contents write).
`queue-unstick.yml` needs the same token. Then re-enable `auto-enqueue.yml`.

**Do NOT** burn time on: ruleset disable/re-enable resets, `queue-unstick`
hammering, or GitHub-outage/billing theories for this symptom. Check the
**enqueue actor** first. See [[feedback_dedicated_pr_shepherd]], [[project_dev_session_infra_gotchas]].
