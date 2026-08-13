---
name: reference_pr_creation_500_bisect_before_blaming_local_setup
description: "When `POST /pulls` 500s, bisect zero-diff vs real-diff before blaming remotes/auth/fork metadata — a 422 control does NOT prove PR creation works."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-24T19:43:56.746Z
---

**`POST /pulls` returning HTTP 500 (empty body) can be a repo-wide GitHub outage, not
your setup.** Observed 2026-07-24 on `loopdive/js2wasm`: every PR creation with a real diff
failed for hours while everything around it looked healthy.

**The bisection that identifies it** (each step is cheap and side-effect-free):

| Probe | Healthy result | Meaning |
|---|---|---|
| invalid head (`no-such-branch`) | **422** | request validation is up |
| branch identical to base (zero diff) | **422** "No commits between" | merge-base path is up |
| branch with a **real diff**, cross-fork | 201 | — if **500**, suspect outage |
| same commits under a **different ref name** | — | rules out ref-keying |
| single source-only commit; trivial commit message | — | rules out content/message/body keying |
| **same-repo head** (not cross-fork) | — | rules out the fork network |
| GraphQL `createPullRequest` | — | rules out a REST-only path |
| `compare/base...head` | **200** | diff computation is up |

**THE TRAP — a 422 control proves almost nothing.** A zero-diff or invalid-head request
short-circuits at *validation* and never reaches PR creation. Concluding "the fork path
is healthy" from that 422 is wrong; it only shows the endpoint parses input. Always
confirm with a **real-diff** probe before ruling anything out. (Made exactly this
over-claim, then had to retract it.)

**Corroborating repo-wide signals:** no PR created repo-wide for hours; open PRs stuck at
`mergeable: UNKNOWN` well past the usual seconds. Note `githubstatus.com` may still read
"All Systems Operational" — absence of an incident is not evidence of health.

**What still works during it:** `git push` (fork and upstream), `compare`, all GETs,
label/comment mutations. So agents can keep committing and pushing — only the PR-creation
step is blocked. Have devs hand the lead a branch+SHA and **stand down** rather than each
running a retry loop; centralize one bounded retry ([[feedback_token_budget_guardrails]]).

**Knock-on risk:** `auto-enqueue.yml` gates on `CLEAN` mergeStateStatus, so degraded
mergeability computation can stall the merge queue too — check before assuming PRs are
merely slow ([[reference_ci_status_feed_retired_use_required_checks]]).

**Do NOT "fix" it by pushing branches to upstream `origin`** to get a same-repo PR — it
does not help (same-repo 500s too) and it recreates the duplicate-branch-name hazard that
pushing to `fork` exists to prevent ([[project_dup_prs_upstream_vs_fork_same_branch_name]]).
