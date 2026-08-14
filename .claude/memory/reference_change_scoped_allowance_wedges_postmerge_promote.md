---
name: reference-change-scoped-allowance-wedges-postmerge-promote
description: "A legitimately-used trap-growth-allow wedged baseline promotion permanently and blocked every shard-running PR — the promote gate read the allowance only across a forward oracle bump, so a same-oracle allowance was never consulted"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-25T22:51:15.324Z
---

**A change-scoped allowance that one enforcement point cannot read turns a
correct PR into a permanent pipeline wedge.** Observed live 2026-07-25 on
`loopdive/js2wasm`.

PR #3629 carried a correct `trap-growth-allow: count 1` (in
`plan/issues/2900-es3-module-indirect-default-binding-update.md`) for
`test/language/module-code/top-level-await/pending-async-dep-from-cycle.js`.
It cleared PR and `merge_group`, merged — and the post-merge promote job then
hard-failed `illegal_cast 74 → 75`, exit 1, **on every subsequent push**.
Nothing on main ever lowers that count, so the wedge is permanent.

## Which job actually wedges — do NOT trust the display name

The failing job's display name is *"promote root baseline + cache per-SHA for
queue merge (#3467/#3468)"*, whose YAML id is **`write-run-cache-bot`** (the
queue-merge writer). The job actually called **`promote-baseline`** (display
name *"promote merged report to main baseline"*) shows as **`skipped`** — it is
**downstream**, so its `needs` is never satisfied once the writer fails. Reading
the display name and calling it "the promote job" is an easy and costly slip.
One conditional in one shared script fixes both writers.

`promote-baseline`'s guard is
`(push || workflow_dispatch) && github.actor != 'github-actions[bot]'`. A
merge-queue push runs as **`github-merge-queue[bot]`**, so the actor guard is
*not* the blocker — and a **manual dispatch runs as the user**, clearing it. That
is why the manual-dispatch unblock works end to end.

## Root cause — ONE conditional, not a missing context

`scripts/check-baseline-trap-growth.ts:142` reads the allowance **only when
`forwardOracleBump` is true**. #3629 was **same-oracle** (baseline
`oracle_version: 11`, no bump) ⇒ the allowance was **never consulted**. This
writer kept pre-#3596 logic; #3596 removed the restriction on the PR side and
nobody mirrored it.

**Tell in the log:** `tolerance 0`, with **no** `oracle vN → vM: using
change-scoped ceiling` line and no reader notes. *Never read* looks different
from *read and rejected* — check for the reader's own log lines before
theorising.

**The tempting wrong hypothesis** (the lead's first, and it was wrong): "the
promote job runs on `push`, so it has no PR context to resolve the allowance
from." It does. `scripts/lib/change-scope.mjs:68-85` (`resolveChangeBase`)
handles `pull_request`, `merge_group`, `push` and `workflow_dispatch` via
`HEAD^1`, and `tests/issue-3303.test.ts:126` pins `fetch-depth: 2` so the parent
resolves.

## The cascade — fix promote only

`merge_group` needs no separate valve: baseline 74 vs main 75 is why every PR
reports "grew 74 → 75". Once promote succeeds the baseline becomes 75 and all
PRs compare 75 vs 75. A per-PR valve would be **wrong** — a change-scoped
allowance is correctly unreachable for a change you did not make.

## The sequencing trap — the fix does not self-trigger

`promote-baseline` is `if: push || workflow_dispatch`, and the **`push` trigger
carries a paths filter** (`&test262-paths`). A fix touching only
`check-baseline-trap-growth.ts` is *off* that list — which is how it lands while
the queue is wedged, but also means **merging it fires no promote**. Baseline
stays stale and the deadlock survives.

**Resolution: a plain (non-forced) `workflow_dispatch` of the sharded workflow
on main.** Every gate still enforces; it is only manually triggered. Strictly
better than forcing or setting a tolerance variable, both of which suppress a
gate.

## What actually unwedged it (the working recipe)

Set repo Actions variable **`BASELINE_TRAP_GROWTH_ALLOW=1`**, **re-run the failed
main push run** (it re-runs as a new attempt), then **reset the variable to `0`**.
The gate then logs `tolerance 1` and banks the growth:

```
[trap-growth] previous:  … illegal_cast=74 …
[trap-growth] candidate: … illegal_cast=75 … (tolerance 1)
[trap-growth] OK — no trap-category growth beyond tolerance.
```

Scope it to one cycle and revert immediately, or the ratchet stays blunted.

**Verify the promote actually happened — do not infer it from a green run.**
Force-fetch the baseline and count:
`node scripts/fetch-baseline-jsonl.mjs --force` then
`grep -ac '"error_category":"illegal_cast"' .test262-cache/test262-current.jsonl`.
Confirm the queue reopened by **observation**: a PR touching `src/**` (so the
full shard matrix runs) merging green.

## Verify a lever is LIVE before citing it

- `test262-sharded.yml`'s `force_baseline_refresh` does **not** bypass the trap
  gate (that gate's only input is repo var `BASELINE_TRAP_GROWTH_ALLOW`); the
  input covers the *regression* gate only.
- `refresh-baseline.yml`'s forced path genuinely bypasses — but the workflow is
  **`disabled_manually`** and cannot be dispatched.
- A header comment asserting "the FORCED refresh path bypasses the gate" is true
  of one workflow and **false** of the one where the wedge lives.

Three inert-or-misdescribed mechanisms in one day (plus the retired `ci-status`
feed). **Check `gh api …/actions/workflows` state, and read the wiring, not the
description.**

## Isolating a PR's true damage while the baseline is stale

Diff **two PRs against the same stale baseline on the same base SHA** — the
shared artifact cancels. Doing this proved a `skip −1214` / `compile_error
+1200` shift was main-side (identical in both) while a `−989 pass` was one PR's
own. You do not need the baseline unwedged to get a trustworthy comparison.

## Design rule

**An allowance must be readable everywhere it is enforced**, and a post-merge
gate that can only say "no" blocks its own repair. Same family as
`regressions-allow` being honored in rebase mode only.

Related: [[reference_baseline_promote_trap_gate_two_failure_modes]],
[[reference_baseline_gates_need_postmerge_autorefresh]],
[[reference_untested_recovery_paths_rot_silently]],
[[reference_merge_queue_park_triage_four_causes]].
