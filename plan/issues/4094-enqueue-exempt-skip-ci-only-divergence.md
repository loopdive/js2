---
id: 4094
title: "Enqueue eligibility: a PR behind ONLY by [skip ci] commits counts as enqueueable — break the BEHIND-churn loop at its narrow end"
status: done
completed: 2026-08-02
sprint: 78
created: 2026-08-02
updated: 2026-08-18
priority: high
horizon: s
feasibility: medium
reasoning_effort: high
task_type: infrastructure
area: ci
language_feature: n/a
goal: dogfood
related: [4093, 2786, 3878, 3904]
---

# ⚠ RE-SCOPED — stakeholder decision #2, 2026-08-02 (~14:30Z)

After the mechanism measurements below, the stakeholder chose **"re-scope to
the real mechanism"** over wiring the original exemption or parking:

> Make the enqueue sweep derive eligibility from real signals — required
> checks via the checks API + behindness via the compare API — instead of
> trusting the stale status string. Fixes the coin-flip for ALL strandings,
> not just `[skip ci]` ones.

**The `[skip ci]`-specific exemption below is SUPERSEDED as the deliverable.**
It survives only as history and as the origin of the (reusable) marker
predicate. The new scope:

1. `scripts/enqueue-green-prs.mjs` derives eligibility from **real signals**:
   every required check SUCCESS/skipped (checks API), **zero
   FAILURE-conclusion checks of any kind** (preserving the #3878/#3904 intent
   behind the UNSTABLE exclusion — a red non-required check still blocks), not
   draft, no hold label, author-trust gate unchanged, and **not
   conflicting/DIRTY** (compare/mergeable, not the status string).
2. **Behind-by-ancestry no longer disqualifies.** Observed 2026-08-02
   14:21:49Z: the live queue held #4002 (1 behind) at pos 1 and #4033
   (4 behind) at pos 2, both enqueued by the server-side workflow, both
   verified behind via the compare API — the queue builds merge groups
   against main, now observed rather than assumed.
3. **Residual unknown, handled by design instead of blocking:** whether the
   `enqueuePullRequest` mutation refuses when GitHub's stale string happens to
   read `BEHIND` at call time. Implementation attempts the mutation, captures
   the raw error if refused, logs it as telemetry, and degrades to skip-this-
   sweep — so production answers the question and a refusal costs one sweep,
   not a stranding.
4. Constraints unchanged: **eligibility only, never branch updates**
   (2026-06-11 incident); positive AND negative controls still required.

# ORIGINAL (superseded) — Stakeholder decision 2026-08-02: exempt `[skip ci]`-only divergence

The project lead chose this remedy for the BEHIND-churn loop documented in
issue 4093 (see its "REFRAME" section), over the two alternatives (admit
`BEHIND` wholesale; detection only). Decision recorded verbatim: *"Exempt
[skip ci] divergence — narrow fix: a PR behind ONLY by [skip ci]-tagged
commits still counts as enqueueable."*

## The loop being broken (measured, 4093)

merge → `[skip ci]` baseline commit (six in ~5.5 h) → every open PR `BEHIND` →
`ENQUEUEABLE = {CLEAN, HAS_HOOKS}` (`scripts/enqueue-green-prs.mjs:114`)
excludes it → un-enqueueable until the refresh cron (~0.7/hour actual) catches
up → possibly raced by the next baseline commit. A commit that declares "this
changes nothing needing testing" currently disqualifies every PR in flight.

## ⚠ MEASURED 2026-08-02 14:16Z — `mergeStateStatus: BEHIND` is NOT "behind by commits"

Direct counter-example, observed by the shepherd during the STEP-0 attempt:
PR #4002 at `behind_by = 1` (missing exactly the `[skip ci]` baseline commit
`a23eb628`) reported **`CLEAN`**, with all six required checks SUCCESS — while
#4028, behind by the same single commit, read `UNSTABLE` (a pending
non-required check). Neither read `BEHIND`.

**Consequences for this issue:**

1. **The predicate must derive behindness from `compare(head...main).behind_by`
   — never from the status string.** Treat `BEHIND` as an opaque GitHub verdict
   that only *sometimes* coincides with being behind.
2. **The causal story this issue was filed under is weaker than written.** The
   #4093 loop ("a `[skip ci]` commit removes every open PR from enqueue
   eligibility by making them BEHIND") was inferred from two PRs that did read
   BEHIND at behind=1. The counter-example shows GitHub does not always emit
   BEHIND in that state — a PR can be CLEAN-while-behind, in which case
   auto-enqueue takes it unaided and no exemption is needed. The correlation
   (churn, dead time) is measured and real; the mechanism is NOT established.
3. **Therefore the FIRST work item is now: measure when GitHub actually emits
   `BEHIND`** (branch-protection strictness? recompute timing? per-check
   settings?). If BEHIND-at-behind=1 turns out to be a transient recompute
   state rather than a stable disqualification, the right fix may be smaller
   than this issue proposes — possibly nothing beyond the #4093 detection work.
   Do not build the exemption until this is answered.

STEP 0's original question (does `enqueuePullRequest` accept a BEHIND PR?)
remains unanswered — the green-but-BEHIND condition never obtained on the test
subject. The one-shot directive to the shepherd stands for the next natural
subject.

## Semantics

A `BEHIND` PR is treated as enqueueable **iff every commit main is ahead by
carries a `[skip ci]`-family marker** (`[skip ci]`, `[ci skip]` — enumerate
GitHub's actual accepted set, do not guess). One non-marked commit ⇒ normal
`BEHIND` handling.

- Divergence set via the server-side compare API
  (`repos/…/compare/<head>...main`), NOT local refs.
- All other filters unchanged: `UNSTABLE` stays excluded (#3878/#3904 —
  load-bearing), drafts, hold labels, author-trust gate.

## ⚠ Constraints, from the incident history

1. **This must NOT update/rebase any branch.** The 2026-06-11 incident (17
   bot-updated BEHIND PRs stranded in `action_required`) was about
   *bot-updating branches*; this change only widens the *eligibility test*.
   `ALLOW_UPDATE_BRANCH` semantics stay untouched.
2. **Verify GitHub accepts `enqueuePullRequest` on a BEHIND PR** before
   shipping — the design rests on the queue building merge groups against
   main itself (the script's own comment, line ~817). If the mutation is
   rejected for BEHIND PRs, the whole approach is void; report that rather
   than working around it.
3. **Positive control required**: demonstrate on a real PR behind only by a
   baseline commit that (a) the exemption classifies it enqueueable, (b) the
   enqueue succeeds, (c) the `merge_group` run validates the true merged
   state. And a negative control: a PR behind by one real commit stays
   excluded.
4. The `merge_group` re-validation + auto-park (#2547) remain the safety net —
   this changes who may *enter* the queue, not what the queue validates.

## Why the narrow form

`[skip ci]`-only divergence is, by the commit's own declaration, incapable of
changing test outcomes; gating the queue on it is pure friction. Real
divergence keeps the existing conservative treatment. Blast radius is confined
to one predicate in one script, with the queue's own re-validation behind it.
