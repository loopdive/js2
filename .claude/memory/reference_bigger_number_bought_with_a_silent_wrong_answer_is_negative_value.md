---
name: reference_bigger_number_bought_with_a_silent_wrong_answer_is_negative_value
description: "An agent measured +13 flips and deliberately shipped +7, reverting a +6 arm that silently no-op'd on the MORE idiomatic spelling. Also: read the JSONL, never vitest's reporter line (348 vs 773 while the JSONL was byte-stable)."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-02T05:14:23.788Z
---

Measured 2026-08-02 by the `H-descriptor` agent on PR #4004 (#4047).

## The decision worth copying

It measured **+13** flips and **shipped +7 on purpose.**

The reverted arm resolved a Function/Array `Properties` through #4032's
`__integrity_bag` and scored **+6 more**, including two files where a descriptor
**setter actually fires** — so they were not vacuous passes. It reverted anyway,
because `tests/issue-3957.test.ts` caught this:

```
props.p = v                          -> the expando bag                    OK
Object.defineProperty(props,"p",..)  -> Array:    the SEPARATE #3251 overlay
                                        Function: NOWHERE (lenient no-op arm)
```

Nothing distinguishes those two spellings at runtime. So on the second — **the
more idiomatic one** — the arm enumerated an empty bag, defined nothing, and
returned normally. A silent wrong answer.

> **A +6 bought with a silent wrong answer on the more idiomatic spelling is
> negative value.**

Without #3957's guard the +13 would have shipped **and looked like a pure win**.
That guard is the highest-value artifact that work left behind.

## Corollary: a conformance number is not the objective function

Flips are a proxy. An arm that raises the count while making a common spelling
silently wrong moves the proxy and damages the thing it proxies for. When those
two conflict, the count loses — and say so explicitly in the report, with the
number you *could* have claimed, so the choice is visible rather than looking
like underperformance.

## Separate, load-bearing measurement rule — READ THE JSONL, NEVER THE REPORTER LINE

Across two runs of the same code:

| | run A | run B |
| --- | ---: | ---: |
| vitest `it()`-level tally | 348 | 773 |
| the results JSONL | **byte-identical** | **byte-identical** |

The reporter line swung by more than 2× while the actual results did not move at
all. Anyone sizing anything off the vitest summary is reading noise.

(Same runs also settled a different question: executed at 1-min load **8** and
**13** with **0 flips between them**, so a 13-vs-7 delta was the *code*, not
contention. Contention is a real hazard — see
[[reference_long_single_process_sweep_overcounts_failures]] — but it must be
demonstrated, not assumed.)

## Third note: removing a refusal exposes what it masked

Three "addressed but unflipped" files were **progress, not misses** — they moved
from a blanket refusal to failing on a *later, more specific* thing
(`newObj instanceof Object`, `arr.length`, or a new narrower refusal). Do not
score those as no-ops.

Related: [[reference_acceptance_bar_denominator_and_killswitch_attribution]],
[[feedback_measure_never_extrapolate]],
[[reference_silent_empty_is_indistinguishable_from_real]],
[[reference_valid_wasm_is_not_correct_verify_by_value]].
