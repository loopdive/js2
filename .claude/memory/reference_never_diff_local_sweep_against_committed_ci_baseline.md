---
name: reference_never_diff_local_sweep_against_committed_ci_baseline
description: Never diff a local test262 sweep against the committed baseline JSONL — the runners differ. Local-vs-local A/B with the change force-disabled is the only sound control.
metadata: 
  node_type: memory
  type: reference
  originSessionId: 417b718f-2c4e-4164-9782-006e2e33f7ff
  modified: 2026-07-24T20:23:34.775Z
---

**Diffing a local test262 sweep against the committed baseline JSONL produces phantom
deltas.** The committed baseline is produced by the **sharded CI worker**; a local
in-process `runTest262File` differs in ways unrelated to any code change. Caught
2026-07-24 by dev-opus5-mop, which self-corrected a reported "**0 regressions, +118
improvements**" down to the honest "**0 regressions, +50 improvements**" — most of the
phantom gain was `env::WeakMap_new`-class rows the change could not possibly explain.

**Known contamination sources** (both unrelated to the change under test):
- the `L:N ` error-prefix differs between runners
- a large `standalone target emitted host imports: env::X` (#2961) population that does
  **not** reproduce locally — 611 rows showed a changed error signature from this alone

**The only sound control: local-vs-local A/B.** Same runner, same process shape, same
machine — run once with the change **force-disabled** (temporary env switch) and once
enabled, then diff those two. Keep the switch OUT of the committed code; it is a
measurement scaffold, not a feature flag.

**Also report the fail→fail error-signature delta, not just pass/fail counts.** "0 changed
error signatures" is what tells you the **#3439 hard-0 unclassified-root-causes gate** has
nothing new to park on in the `merge_group`. A pass-count diff alone cannot tell you that,
and that gate has zero margin.

**Attribute every out-of-target improvement or refuse to claim it.** In the sound run, all
4 improvements outside the target set traced to one mechanism (a seeded `prototype`:
`Error/prototype/S15.11.3.1_A{1,2,4}_T1.js`, `Object/prototype/S15.2.3.1_A3.js`). An
unattributable "improvement" is a measurement artifact until proven otherwise.

Sibling rules: [[feedback_measure_never_extrapolate]] (cluster labels over-count flips
100-600x), [[feedback_baseline_drift_cross_check.md]] (identical clusters = drift),
[[reference_standalone_floor_inflated_three_vacuity_mechanisms]] (harness can report pass
vacuously, so even a *correct* diff can count vacuous passes).
