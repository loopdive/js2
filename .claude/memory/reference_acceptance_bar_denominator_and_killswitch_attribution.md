---
name: reference_acceptance_bar_denominator_and_killswitch_attribution
description: "The E6 gold standard for measuring whether a change helps — validate the instrument against a known baseline, prove attribution with a kill-switch arm, and check the acceptance bar's DENOMINATOR before calling a result a shortfall"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-27T00:51:00.500Z
---

**#2928 E6 (PR #3691, merged 2026-07-27) is the best-controlled measurement
this project has produced.** Copy its shape for any "did this actually improve
X?" question.

## The three moves that made it trustworthy

**1. Validate the instrument against a known baseline first.**
The control arm (`main` @ `81dbcad3b`) reproduced the prior handoff baseline
*exactly* — 106/816 = 105 standard + 1 Annex B. Only after that match does a
delta mean anything. A control that does not reproduce a known number is a
broken instrument, and every number downstream of it is unknown, not zero.

**2. Prove attribution by REMOVAL, not by inference.**
A third arm ran the branch with `TEST262_DISABLE_RUNTIME_EVAL_PROVIDER=1`.
It was **status-identical to the control on all 816 files** — so disabling the
provider alone reverts every delta, therefore every delta is attributable to
the new route. "It passes now" is never "my change made it pass"
([[reference_silent_empty_is_indistinguishable_from_real]]). Build the
kill-switch into the change so the third arm is cheap.

**3. Floor the row count — a lost row is not a failing row.**
vitest was killing jobs at 30 s **without writing a jsonl row**, so
**202 of 816 files silently vanished** from one arm, including a file that
passes in isolation. An arm that quietly drops a quarter of its corpus still
produces a confident number. Assert `rows == expected N` before comparing arms.

## The denominator lesson — check the bar before reporting a shortfall

E6 landed **11 attributable flips against a "≥30 official files" acceptance
bar**, which reads as a 37 % miss. But **595 of the 816 files are direct-eval,
out of scope by design** (they need lexical capture — a different issue).
The reachable population for that slice was ~221, not 816.

So the bar had been set against the **wrong denominator**. Before writing up a
result as falling short:

- Ask what the *reachable* population is, not the total corpus size.
- If the bar was set against the total, say so — the finding is
  "the bar is miscalibrated", not "the work underdelivered".
- Report both numbers. 11/221 and 11/816 tell very different stories, and only
  one of them is about this change.

Same family as [[feedback_measure_never_extrapolate]]: always give the
denominator, and make sure it is the denominator of the question you are
actually answering.

Related: [[reference_never_diff_local_sweep_against_committed_ci_baseline]]
(same-run local-vs-local control only) ·
[[reference_broken_instrument_can_still_give_right_answer]]
