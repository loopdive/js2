---
name: feedback_reconcile_carried_slate_against_git_on_reopen
description: On sprint reopen/resume, reconcile the carried ready/in-progress slate against upstream/main BEFORE dispatching — frontmatter is systematically stale
metadata:
  type: feedback
  originSessionId: 54c1df0f
---

**s65 reopen, 2026-06-24.** When a sprint is reopened/resumed, its carried
`ready`/`in-progress` issue frontmatter is **systematically stale vs git** — work
landed via child slices, got folded into other issues, was deferred, or is
user-held, but the `status:` field never got flipped. In one session I dispatched
agents at 7 "ready/in-progress" carried issues and **every one was already
handled**: #1373b (deferred epic, inert), #2160 (merged-out via child slices
#2598–#2601, tracker only), promise-async-cap (#55, folded into #2623), #1961
(user design-hold "in favour of S1"), #2621 (no landable WasmGC slice), #1760
(ALREADY landed on main, commit 7a9ba70e6 — its Deliverables were all `[x]`
while status said `ready`), and the #2580 "M2 ~640-row unstarted slice" framing
(all slices landed, refused-set empty).

**Why:** issue `status:`/`sprint:` are hand-maintained; a self-merge PR sets
`done` in the impl PR, but trackers, folded scope, child-slice splits, and
deferred epics drift silently. The Deliverables narrative inside the issue body
drifts independently of `status:` (checked `[x]` while still `ready`).

**How to apply:**
- **Before dispatching on a reopened/resumed sprint, run a reconcile-against-git
  pass first** (a product-owner agent is the right tool): for every carried
  `ready`/`in-progress` issue, PROBE against `upstream/main` (loopdive/js2wasm — the
  fork lags) — `git log --grep`, open-PR scan, run the acceptance tests — and
  flip the already-done ones to `done` (with a Resolution note citing the merge),
  folded→done, deferred→backlog, gated→blocked. Open ONE docs-only
  frontmatter-correction PR. The deliverable is the list of issues that are
  GENUINELY still open + dev-claimable.
- **Until reconciled, make every dispatched agent reground-first**: verify the
  issue against current `upstream/main` and REPORT (not build) if it's already
  handled. This caught all 7 above and saved the wasted builds — see
  [[feedback_reground_spec_against_current_main]],
  [[feedback_verify_fix_in_git_not_narrative]],
  [[feedback_no_duplicate_issue_dispatch]].
- A git claim-lock (`issue-assignments` ref) can hold an issue even when the
  frontmatter shows no assignee — #2083 looked free but was locked by
  `agent-codesize` (exit 3). Check the lock, don't `--force`-steal. See
  [[feedback_slice_claim_collision_check_assignments_log]].
- Distinguish a user/human design-hold from drift before "reviving" a DIRTY PR —
  see [[feedback_auto_park_hold_not_dev_label]].
