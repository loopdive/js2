---
id: 4254
title: "merge_group runs that skip the shard matrix defer floor breaches onto the NEXT measuring PR — attribution lands on the wrong doorstep by design"
status: ready
created: 2026-08-09
updated: 2026-08-09
priority: medium
feasibility: medium
reasoning_effort: medium
task_type: bugfix
area: ci
language_feature: n/a
goal: dogfood
related: [2097, 2879, 2547, 4239]
origin: "2026-08-09 PR #4252 park diagnosis: three consecutive merge_group runs (pr-4251/4253/4254) reported SHARDS_RAN: false — never measured — so main's −17 drift plus the candidate's −103 arrived as one −120 breach on the first PR whose run DID measure"
---

# #4254 — unmeasured queue crossings make the floor fire on the wrong PR

## Problem

Not every `merge_group` run measures conformance: runs where the shard matrix
is skipped (docs-only diffs, path-filtered changes) report `SHARDS_RAN: false`
and publish green without a standalone pass count. The #2097/#2879 high-water
floor therefore only fires on the next run that DOES measure — which receives
the accumulated drift of every unmeasured merge since the last measurement,
attributed to the one candidate on whose doorstep it lands.

Observed 2026-08-09 (PR #4252's park): the mark stood at 28,939; main's last
MEASURED run (bb5566798, 20:33Z) was already at 28,922 (−17); three
intervening merges crossed unmeasured; PR #4252's run then breached at 28,819
and the bot parked it for the full −120, of which −103 was genuinely its own.
The diagnosis could separate the two only because the compiler diff between
the last measured main and the candidate's base happened to be EMPTY — with
any real interleaved code merge, the attribution would have required manual
archaeology under a bot hold.

Two failure modes this enables:

1. **Wrong-doorstep parks**: a clean PR that merely follows an unmeasured
   regressing merge gets parked for someone else's drop and must prove its
   innocence from artifacts.
2. **Tolerance consumption**: drift accumulated across unmeasured crossings
   eats the ±50 tolerance silently, so the floor's effective budget for the
   measuring candidate shrinks by however much slipped through unmeasured.

## What this is NOT

Not a claim that the skips are wrong — docs-only merges skipping a ~40-min
shard matrix is correct economics. The gap is that the floor's ERROR MESSAGE
and the park comment attribute the whole delta to the candidate, and nothing
records "N merges crossed unmeasured since the last mark-relevant
measurement."

## Acceptance

- [ ] The floor-breach error message reports the last MEASURED main value and
      its sha alongside the mark (e.g. "mark 28,939 @ 83a1202; last measured
      main 28,922 @ bb55667; candidate 28,819 ⇒ ≤ −103 attributable to this
      candidate"), so a parked PR's owner starts with the split instead of
      deriving it.
- [ ] The auto-park comment includes the count of unmeasured merge_group
      crossings since the last measured run.
- [ ] Optional, decide at implementation time: a scheduled measured run on
      main (or promote-time re-measure) when K consecutive crossings were
      unmeasured, so drift cannot accumulate unboundedly between
      measurements.
