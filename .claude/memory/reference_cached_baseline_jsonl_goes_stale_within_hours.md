---
name: reference_cached_baseline_jsonl_goes_stale_within_hours
description: "The local .test262-cache baseline JSONL is a SNAPSHOT, not a feed — it goes stale within hours and then answers yesterday's question with a number that reproduces perfectly. Re-fetch --force before sizing ANY lever."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-01T17:33:50.521Z
---

**Measured 2026-08-01.** The lead sized five levers and dispatched four agents off
`.test262-cache/test262-standalone-current.jsonl`. The file had been fetched at
**03:15**; by dispatch time it was **~16 hours of `main` out of date**. A subagent
(`L-evalink`) caught it within minutes of starting.

The damage is subtle because **the stale file is internally perfect**. Every
instrument check passed. The scan reproduced `43,106 official / 25,460 pass
(59.1%)` and goal scope `8,545 / 6,004 / 70.3%` *exactly* — which is precisely
why it was believed. A stale baseline does not look broken; it looks
**validated**.

Fresh (same 43,106 official rows, 0 corpus misses):

| | stale 03:15 | fresh 19:01 |
|---|---:|---:|
| official pass | 25,460 (59.1%) | 25,755 (59.7%) |
| goal scope pass | 6,004 (70.3%) | 6,176 (72.3%) |
| goal-scope gap | 2,541 | 2,369 |

## The lever that evaporated

`Import "js2wasm:runtime-eval": module is not an object` was ranked the **#1
cheapest lever at 138 goal-scope files**. On the fresh baseline it is **0**
(all-official 361 → 5). PR #3944 linked a refusal provider in the standalone CI
lane and merged at 05:23 UTC — *after* the snapshot was cut. An entire agent was
dispatched on a population that no longer existed.

## The second trap: a bucket that vanishes has often MOVED, not resolved

Of those 138 files, **exactly 4 flipped to pass**. The other 134 converted from
link deaths into **honest catchable refusals** (`dynamic code evaluation is not
supported in this standalone build`), which surfaced as a *new* 101-file bucket
under a different signature. The lever's real yield was **4/138 = 2.9%**.

> **A bucket disappearing from the top-N does not mean those files left the gap.**
> Verify the partition still SUMS. Same family as *a complement is not a category*.

The residual now needs **real eval capability** (the Acorn interpreter provider,
minutes to compile, not affordable per shard) — so what looked like the cheapest
lever is actually one of the most expensive.

## Rules

1. **`node scripts/fetch-baseline-jsonl.mjs --standalone --force` before sizing
   anything.** Cheap; the alternative is dispatching agents at yesterday.
2. **Stamp every number with the baseline row-timestamp / SHA it came from.** A
   census without that stamp is unusable a day later. Provenance must travel
   WITH the number.
3. **Do not hand a subagent an instrument-check target without checking it is
   still current** — the lead told four agents to validate against
   `25,460 / 59.1%`, which had become a *failure* signal meaning "you are on the
   stale file". An expected-value check inverts into a trap the moment the
   expectation ages.
4. **Never attribute a whole-baseline delta to one PR.** The goal-scope +172
   spanned ~16h of `main` and many PRs. Attribution requires a paired A/B with
   kill-switch removal, not two snapshots.

Related: [[reference_silent_empty_is_indistinguishable_from_real]],
[[feedback_measure_never_extrapolate]],
[[reference_never_diff_local_sweep_against_committed_ci_baseline]],
[[reference_baseline_jsonl_authoritative_over_local_repro_status]],
[[reference_shape_matrix_is_not_a_population_estimate]].
