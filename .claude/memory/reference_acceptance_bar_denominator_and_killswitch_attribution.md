---
name: reference_acceptance_bar_denominator_and_killswitch_attribution
description: "The E6 gold standard for measuring whether a change helps — validate the instrument against a known baseline, prove attribution with a kill-switch arm, and check the acceptance bar's DENOMINATOR before calling a result a shortfall"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-01T06:46:54.172Z
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

## A kill switch proves the BEHAVIOUR; it does not prove the SHIPPED CODE

**The switch and the shipped change are different artifacts.** An arm run with
`JS2WASM_NO_X=1` (or any env-gated scaffold) establishes that *the behaviour*
produces the measured delta. It does **not** establish that the constant /
carve-out / conditional you actually commit produces the same delta — the
scaffold may read at a different time, cover a different set, or short-circuit
a path the real edit does not.

**So run one more arm with the scaffold DELETED**, on the real change, and
require it to match. Named "arm D" on #2742 (2026-08-01): arm C proved +18/−0
via the env switch; arm D re-ran it with the switch removed and the shipped
constant in place. *If arm D ≠ arm C, the switch was doing something the
committed code does not.*

Same principle as verifying probes still pass after stripping a measurement
scaffold, and as `git diff` against the proven-green head being **empty** after
a revert. Cheap, and it closes the last gap between "I measured this" and
"this is what merges".

## Provenance must travel WITH the number, not near it

**A caveat in prose does not survive re-quoting.** E6 *did* disclose that its
figures were interpreter-linked — in the surrounding text. The headline table
carried the numbers alone, so the numbers travelled and the caveat did not.

**Empirical proof, not an argument: I did it myself, one hop, within days.**
I reported E6 to the stakeholder as "official `eval-code` 106→117, 11
revert-verified attributable flips" with **no tier qualifier**, having read the
disclosure. The prose caveat did not survive a single retelling by someone who
had seen it.

**The fix has TWO halves and needs both** (learned when half one looked
sufficient):

1. **Opt-in behind a named flag** — removes the silence about the *choice*.
2. **A tier announcement on EVERY path** — removes the silence about the
   *outcome*. Logging only the absent/failure case still leaves a successful
   run untraceable, which is precisely the run that produced the inflated
   numbers.

Discovered 2026-08-01: between E6 and E7 the test262 worker linked the
interpreter provider **unconditionally, with no flag and no log line naming the
tier**, while CI's provider cache was always cold. So every *local* standalone
eval figure was inflated relative to CI by roughly the interpreter's yield
(order of magnitude: ≥ +17 on a 262-file slice).

**The distinction that matters, and must not be collapsed:** those numbers were
**not wrong as measured** — the interpreter really produced them, the
kill-switch arm really was status-identical, the attribution really holds. They
were wrong **to use as a CI/lane baseline**, because CI was never in that
configuration. Internal validity intact; external validity void.

**Rules:**

- Put the configuration **inside the table** — a row, a column, or a warning
  block immediately above it. Never only in the paragraph before.
- Name the tier/flag/lane with **every** figure: "refusal tier, CI-comparable"
  vs "interpreter tier, NOT CI-comparable".
- If a harness silently selects a capability the published lane lacks, that is
  a measurement-validity defect, not a convenience — make the selection
  explicit and logged (here: `TEST262_FULL_RUNTIME_EVAL=1`).
- When you discover such a divergence, state **what it invalidates by name**,
  including your own earlier headline numbers.

Related: [[reference_never_diff_local_sweep_against_committed_ci_baseline]]
(same-run local-vs-local control only) ·
[[reference_broken_instrument_can_still_give_right_answer]]
