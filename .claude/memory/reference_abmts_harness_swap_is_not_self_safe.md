---
name: reference-abmts-harness-swap-is-not-self-safe
description: "plan/probes/3603/ab.mts swaps the worktree's test262/harness symlink for a private (sometimes INSTRUMENTED) copy — safe across worktrees but NOT against a second measurement in the same worktree; a concurrent sweep silently returns all-zero"
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-07-25T22:43:55.381Z
---

**`ab.mts` is worktree-safe and self-UNSAFE.** It replaces this worktree's
`test262/harness` **symlink** with a private copy. `NOTES.txt` documents the
cross-agent hazard; it does **not** document this one.

Arms **A2/B install an INSTRUMENTED `propertyHelper.js`** in which the five
`__push(failures, …)` sites are replaced by `__vpPush`. Consequences for any
*other* harness-dependent measurement running in the same worktree:

- `__push` is never called ⇒ a host-boundary write-back under test never fires.
- Tests that legitimately fail come back **`pass`**.
- A sweep counting spurious firings returns **0** — which reads exactly like a
  clean bill of health.

Observed 2026-07-26: a broad "is the fix over-applying?" sweep returned **0
firings twice**. The second run carried three tests **already proven to fire** as
positive controls — **the controls did not fire either**, which is what exposed
it. `grep -c` on the live harness showed **13 instrumentation markers**. Without
the control the reported conclusion would have been *"0 spurious firings —
over-application refuted corpus-wide"*: a fabricated result on the one condition
the measurement existed to establish.

## Rules

1. **Never run a harness-dependent measurement while an arm is in flight in the
   same worktree.** Serialize, or use a separate worktree.
2. **Pre-flight assert `test262/harness` is a SYMLINK** (not a private copy)
   before measuring. Cheap, and catches this before burning a run.
3. **Never report a zero unless in-run positive controls fired in the same
   process.** A zero from an unproven instrument is indistinguishable from a
   broken instrument.
4. **Audit by timeline when contamination is found** — void only what overlapped.
   Arm **A** installs a *stock* private harness (results stay valid); **A2/B**
   install instrumented ones (results void). Probes using **no** harness at all
   are unaffected. Do not discard sound evidence out of caution, and do not keep
   contaminated evidence out of momentum.

Related: [[reference_broken_instrument_can_still_give_right_answer]],
[[feedback_measure_never_extrapolate]],
[[reference_never_diff_local_sweep_against_committed_ci_baseline]],
[[reference_f1_honest_floor_deinflation_landing_recipe]].
