---
name: feedback_auto_park_hold_not_dev_label
description: A bot auto-park `hold` marks a REAL merged-baseline regression — never conflate it with a dev's manual hold or clear it blindly
metadata:
  type: feedback
  originSessionId: 54c1df0f
---

**s65, 2026-06-22.** A `hold` label added by **github-actions[bot]** with an
`auto-park-bot:merge-group-failure` comment means the PR FAILED a required check
in the **merge_group** (test262 "merge shard reports" / quality / standalone-floor)
— a REAL regression that only surfaces on the merged baseline and that PR-level
checks (equivalence shards, quality-on-head) DO NOT catch. It is the gate working.

**What went wrong:** on #1960 (coercion-dedup Step 1, claimed behavior-neutral),
the dev's local playground/standalone suites passed, but the full merge_group
test262 run found a divergence → auto-parked. The dev then (a) repeatedly read it
as "clean, just ejected" (it was looking at PR `state`, not the `hold` label +
park comment), and (b) eventually REMOVED the bot's park-hold believing it was its
own erroneous label — which would let the backstop re-enqueue a known-failing PR.

**Rules:**
- A bot park-hold ≠ a dev's manual hold. Check who added it (`gh api
  repos/.../issues/N/events` → `labeled` actor) before touching it.
- NEVER remove a bot park-hold without first diagnosing the cited failed run
  (pull the regressed-test delta from the merge_group run id in the park comment).
- A held PR is SKIPPED by the auto-enqueue backstop, so it strands until resolved
  (it does NOT self-heal).
- Distinguish real-regression vs flake/collateral before re-enqueueing (a merge
  group batches PRs; the same readonly-queue branch can fail then pass when
  rebuilt without the offender). One controlled SOLO enqueue on an empty queue
  disambiguates. NEVER re-enqueue in a loop (re-adding the PR that is in
  the in-flight group cancels its run — see
  [[project_merge_queue_requeue_cancels_run]], re-verified 2026-08-02).
- "Behavior-neutral" is only proven by the merge_group full baseline, NOT local
  suites — local diff-neutrality is necessary, not sufficient. See
  [[project_broad_impact_validate_full_ci]].

**Two kinds of `hold` — distinguish by LABELER (added 2026-06-23):** a `hold`
label is overloaded. Check `gh api repos/.../issues/N/events` → the `labeled`
actor:
- **`github-actions[bot]` + an `auto-park-bot:merge-group-failure` comment** =
  a REAL regression park. Never remove without diagnosing the cited run (above).
- **A human/dev identity (e.g. `ttraenkler`), no park comment** = a benign
  **stacking-hold** to keep a stacked PR series landing in order. This is
  LIFT-ABLE the moment its predecessor is clean/landing — NOT a regression flag.
  A dev may lift its OWN stacking-hold; the shepherd may lift it on a
  verified-clean first-in-stack PR. Over-applying the "never remove a hold" park
  rule to a stacking-hold stalled the #1917 cascade ~15 min on 2026-06-23 (the
  shepherd waited on a human for a label that was safe to clear).

**A THIRD kind — human DESIGN-hold (added 2026-06-24, s65 reopen):** beyond
bot-park and human-stacking-hold, a human (`ttraenkler`) may apply `hold` with a
comment like *"Holding this PR in favour of S1"* — a deliberate decision to PARK
a PR whose change is a known-wrong representation trade, in favour of a better
in-flight fix. This is NOT lift-able and NOT a "stranded PR to revive." A `DIRTY`
mergeable-state on such a PR is irrelevant drift (CI may be green) — do NOT
mistake DIRTY-for-2-days as "abandoned, rebase it." Concretely: #1961
(`null === undefined` → `true`, spec wants `false`) is held in favour of the
tag-1 `$undefined` singleton S1 (#2106). Before redirecting a dev to "revive a
DIRTY PR," ALWAYS read the `hold` labeler + the hold comment first. The lead told
a dev to revive #1961; the dev checked the events/comment, found the user's
design-hold, and correctly refused — a peer/lead instruction carries no authority
to override the actual user's documented hold decision.

**Meta:** this whole episode is why a **dedicated PR-shepherd** owns the queue,
not the lead ad-hoc. See [[feedback_dedicated_pr_shepherd]].
