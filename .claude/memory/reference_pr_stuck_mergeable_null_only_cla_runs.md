---
name: reference-pr-stuck-mergeable-null-only-cla-runs
description: "PRs can wedge at mergeable=UNKNOWN and never recover — pushing more commits never fixes it, close+reopen does. The ONLY universal discriminator is UNKNOWN persisting across repeated reads; missing pull_request checks is just one possible symptom"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-02T05:30:14.103Z
---

**A PR can wedge at `mergeable: null` / `mergeable_state: "unknown"` and stay
there indefinitely.** It hit **two independent PRs within one hour** on
`loopdive/js2wasm` (2026-07-25, #3639 and #3641), so it is not a one-off.

## ⚠ RULE OUT `MERGED`/`CLOSED` FIRST — added 2026-08-02 after a false positive

**A merged or closed PR reads `mergeable: null` / `mergeStateStatus: UNKNOWN`
PERMANENTLY**, because GitHub stops computing mergeability once a PR is no
longer open. So a merged PR **reproduces the wedge signature below exactly** —
including "persists across repeated polls", which is the discriminator this note
calls the only reliable one.

```bash
gh pr view <N> --json state          # MERGED/CLOSED ⇒ UNKNOWN is EXPECTED, stop here
```

**`mergeStateStatus` is only interpretable on an `OPEN` PR.** Query `state`
alongside it, always — a query that omits `state` cannot distinguish a wedge
from a landed PR.

Measured 2026-08-02: an agent tracked `UNKNOWN` across **~12 reads over ~25
minutes** via both GraphQL and REST, worked through this note's ⚠ false-positive
list, ruled out the *queued* case by direct measurement — and was about to
close+reopen a PR that had **merged 20 minutes earlier**. Every read was
accurate; every inference was invalid.

**The transferable lesson:** ruling out one documented false positive is not the
same as establishing that the signature means what you think it means. It
*resembles* rigor closely enough to pass. A false-positive list is a floor, not
a ceiling — treat it as incomplete by default.

(Corollary artifact worth recognising: a queue branch named
`gh-readonly-queue/main/pr-<other>-<sha>` embeds the **merge commit of the PR
that just landed**. In that incident the SHA quoted as evidence *against* the
PR having merged was that PR's own merge commit.)

## The ONLY reliable discriminator (on an OPEN PR)

```bash
gh api repos/<owner>/<repo>/pulls/<N> -q '.mergeable, .mergeable_state'
```
GitHub computes mergeability **lazily on read**, so the reads are themselves the
nudge. **`UNKNOWN` persisting across repeated polls** is the test; a single read
returning `null` proves nothing. #3639 stayed stuck across 3 polls, #3641 across
8 polls over ~2.5 minutes.

## Do NOT key on missing checks — the surface symptom varies

| | #3639 | #3641 |
|---|---|---|
| `pull_request` workflows | **missing** (only `cla-check`, on `pull_request_target`) | **all present** |
| checks | 2 | **20, all green** |
| `mergeable` | UNKNOWN ×3 polls | UNKNOWN ×8 polls |

**#3641 had nothing missing and nothing failing** — it would sail through an
"absent required checks" test. Treat check absence as a *corroborating* symptom
only.

When checks *are* missing, the split is by **event type**: the survivor runs on
`pull_request_target` (evaluates against the base, needs no merge computation);
everything absent runs on `pull_request` (needs it). That explains why **no
number of pushes can fix it** — the content was never the problem.

## ⚠️ FALSE POSITIVE — a PR *in the merge queue* also reads UNKNOWN

**Before applying the remedy, check whether the PR is currently in the merge
queue.** A queued PR legitimately reports `mergeable: null` /
`mergeable_state: "unknown"` for as long as its `merge_group` run is in flight,
and it will **not** recover on polling — identical to the wedge signature.

```bash
gh run list -R <owner>/<repo> --workflow=<w>.yml --limit 20 \
  --json event,headBranch,status | grep "pr-<N>"
```
An `in_progress`/`queued` `merge_group` run for that PR ⇒ **not wedged, leave it
alone.**

**Closing a queued PR ejects it from the queue and destroys the in-flight
run** — on a de-inflation measurement that is an expensive, non-reproducible
loss (and per
[[reference_merge_group_gate_reads_a_moving_baseline]] a re-run is not
equivalent, because the baseline moves underneath it). Caught 2026-07-26 on
#3635, one poll before the remedy would have been applied.

## Fix

```bash
gh pr close <N> -R <owner>/<repo> && sleep 5 && gh pr reopen <N> -R <owner>/<repo>
```
Immediately reversible. `reopened` is a `pull_request` activity type, so
workflows re-fire on the **unchanged head SHA**. #3639 flipped `null → true` in
~20s; #3641 recovered on the **first** poll after reopen. The unwedge is durable
across later pushes, not just the reopen.

**Cost:** a full workflow re-fire. If the PR touches `&test262-paths` that
includes the entire `Test262 Sharded` matrix — so confirm the wedge before
spending it.

## Rule out first, so you don't misattribute

- **Not a path filter** — check the workflow really has no `paths:`.
- **Not repo-wide** — `gh api "repos/O/R/actions/runs?event=pull_request"`; if
  other branches fire in the same window, it is PR-specific.
- **Not capacity** — check `?status=queued` / `?status=in_progress` totals.
- **Not the head commit's authorship** — an unattributed merge commit
  (`author=none committer=none`) is a red herring; it does not gate workflows.
- **A present merge ref does NOT rule this out** —
  `git ls-remote origin refs/pull/N/merge` returned a SHA on both wedged PRs.

## Related trap — read the job STATUS, not its NAME

A job named **"Cancel Test262 after quality failure"** with status `skipping`
looks, at a glance, exactly like a quality failure. It is the opposite: quality
passed, so the canceller skipped.

Related: [[reference_ci_status_feed_retired_use_required_checks]],
[[reference_merge_group_gate_reads_a_moving_baseline]],
[[reference_pr_creation_500_bisect_before_blaming_local_setup]].
