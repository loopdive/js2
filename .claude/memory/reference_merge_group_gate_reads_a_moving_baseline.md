---
name: reference-merge-group-gate-reads-a-moving-baseline
description: "The test262 regression gate clones js2wasm-baselines main INLINE at step time, so the baseline side moves while the candidate side was measured minutes earlier — verdicts are not reproducible and a merge_group park is NOT purely a property of the change (#3648)"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-25T23:00:18.125Z
---

**A `merge_group` failure is a property of the change AND of the wall-clock
position of the gate step relative to the last baseline promote.** Found
2026-07-26 (#3648, `opus-loop-b`) while closing a loose end on why one PR passed
a gate that failed two others on the identical test.

The gate step runs `git clone --depth=1 … && checkout main` on
`js2wasm-baselines` **inline, at step time**, and hands that to
`diff-test262.ts`. The **candidate** side was measured minutes earlier by the
shards. So the reference moves under a fixed measurement.

## The 64-second proof

| time (UTC) | event |
|---|---|
| 22:32:31 | PR #3637 `merge_group` starts; shards measure its merged state |
| **22:43:12** | an operator's re-run promotes the baseline `illegal_cast` 74 → **75** |
| **22:44:16** | #3637's gate step **freshly clones** the baselines repo — now 75 |
| 22:44:21 | gate PASS (75 vs 75) |

Sixty-four seconds earlier it compares 75 against **74** and parks exactly like
#3627 and #3636 did. The trap was **never retired** by #3637 —
`pending-async-dep-from-cycle.js` is still `illegal_cast` in the post-#3637
baseline and the count is still 75. So this is not "the PR fixed it".

## Why it matters more than a flake

- **Verdicts are not reproducible.** Re-running a parked PR can flip it green
  with **no change** to the PR, to main, or to the corpus.
- **Queue-position bias.** Entries in one serial queue are judged against
  *different* baselines depending on where a promote lands.
- **It breaks the premise `auto-park` rests on** — that a merge_group failure
  indicates a regression in the change. A park computed against a
  since-superseded baseline is a **false positive by construction**.

## Why it stayed invisible — the recurring disease

**It is silent in the favourable direction.** A well-timed pass logs nothing
anomalous, and **no line anywhere records which baseline commit produced the
verdict**. Only the unfavourable direction surfaces — as a park that clears on
re-run, which reads as flake and gets waved through.

Fifth instance in one session of *the benign outcome being indistinguishable
from the broken one*: empty `grep` on a binary-classified UTF-8 file, expired
`--log-failed` returning nothing, a vacuous `EXIT=0` from a `PIPESTATUS`
bashism, `never read` vs `read-and-rejected` on an allowance (#3644), and this.
**The cure has been identical every time: print the provenance.**

## Practical rules until #3648 lands

- **Record the baseline provenance alongside any delta** you intend to quote or
  size an allowance from — commit, pass total, trap counts. A delta without it
  is not reproducible and the allowance derived from it is unfalsifiable.
- **Do not re-run to "confirm" a verdict you dislike.** A second run can
  legitimately differ for reasons unrelated to the change, which makes it
  misleading rather than merely expensive.
- **A promote moves the reference, not just the record.** After one, every
  pre-measured delta is stale — 2026-07-25's promote moved the baseline
  30927 → 30517 pass, shrinking an in-flight −989 by hundreds.

Distinct from #3467/#3468 and #3611, which govern which baseline is **written**;
this is which baseline is **read**.

Related: [[reference_change_scoped_allowance_wedges_postmerge_promote]],
[[reference_merge_queue_park_triage_four_causes]],
[[reference_baseline_jsonl_authoritative_over_local_repro_status]],
[[reference_f1_honest_floor_deinflation_landing_recipe]].
