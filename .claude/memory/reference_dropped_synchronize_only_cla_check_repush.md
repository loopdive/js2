---
name: reference_gh_actions_runs_head_sha_must_be_full_40_char
description: "`actions/runs?head_sha=` SILENTLY returns total_count=0 for a short sha — always pass the full 40 chars; this faked a repo-wide 'CI is not dispatching' outage"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-25T23:49:33.466Z
---

**`gh api "repos/O/R/actions/runs?head_sha=<sha>"` requires the FULL 40-character
sha. A shorter prefix returns `total_count: 0` — silently, with no error.**

Reproduced 2026-07-26 on one commit (`6830efa361969c7eaf35285f198f43f797cc0801`):

| query | result |
|---|---|
| full 40-char | `total_count = 6` |
| 12-char prefix | `total_count = 0` |

**THIS FAKED AN OUTAGE.** On 2026-07-26 it produced a confident, agent-corroborated
diagnosis that required checks "were never dispatched" on several PRs — the
signature being *only* `CLA Check` present. That conclusion drove: a wrong
"transient dropped-`synchronize` window" theory, a wrong fork-vs-upstream theory,
a premature agent stand-down, and an escalation claiming the merge queue was
blocked on infrastructure. **The PRs were healthy the whole time** (#3639 read
`CLEAN` with CI + Test262 PR stub + parity all present).

**Rules:**
- Always pass `.headRefOid` verbatim. Never truncate for the query — truncate only
  for DISPLAY (`${SHA:0:8}`), and never reuse the truncated value.
- Beware shell habits that truncate: echoing a shortened sha and then reusing that
  variable is the exact trap.
- Before concluding "no runs exist", re-run with the full sha. **Absence of runs is
  an extraordinary claim** — check the query before believing it.

**SECOND, INDEPENDENT CAUSE OF THE SAME FALSE ALARM: too short an observation
window.** Dispatch can lag **~4 minutes** after a push. One agent polled for 7
minutes with a correct full-40 sha, closed its window **24 seconds** before the
runs appeared, and escalated "dispatch is broken". So a clean full-sha query is
NOT sufficient — wait out the lag before declaring a stall. Two different agents
reached the same wrong conclusion by these two different routes on 2026-07-26,
which is why "no runs" needs BOTH checks before it is believed.
- Cross-check with a PR known to be healthy; if it also shows 0, the query is wrong,
  not the repo.

**Related genuine phenomenon, do not confuse:** `mergeStateStatus: UNKNOWN` across
many PRs at once is normal **merge-ref recomputation lag under queue churn** (6 of
8 open PRs at 23:41Z) and is self-healing. It is NOT evidence of broken dispatch.

See [[reference_workflow_touching_prs_never_autoenqueue]] for the one case where a
green PR genuinely never enqueues.
