---
id: 4094
title: "Enqueue eligibility: a PR behind ONLY by [skip ci] commits counts as enqueueable — break the BEHIND-churn loop at its narrow end"
status: ready
sprint: current
created: 2026-08-02
updated: 2026-08-02
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

# Stakeholder decision 2026-08-02: exempt `[skip ci]`-only divergence

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
