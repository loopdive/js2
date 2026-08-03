---
name: reference_shape_matrix_is_not_a_population_estimate
description: "A hand-built matrix over syntactic SHAPES correctly describes which shapes a fix moves, but predicts file counts badly — the corpus does not exercise shapes uniformly. Size against the corpus, never off the matrix."
metadata: 
  node_type: memory
  type: reference
  originSessionId: 31a336a9-7fce-4c41-9a15-3e10d02eca44
  modified: 2026-08-01T04:17:45.414Z
---

**Measured 2026-08-01, #2742 / standalone `String.prototype`.**

A 28-row hand matrix over call shapes showed `String.prototype.M.call(obj)`
going **fail→pass** for `charCodeAt`, `indexOf`, `lastIndexOf` and six others
once a superseded wiring was disabled. The natural inference — those methods
will flip tests — was **wrong**.

The 265-file scoped A/B measured **+10 flips, and every single one was in
`trim/`**. `charCodeAt`, `indexOf`, `lastIndexOf` moved by **zero**.

Not a contradiction. The corpus writes the shapes non-uniformly:

- ≤ES5 `trim` tests are written `String.prototype.trim.call(obj)` — the
  literal shape the fix repairs.
- ≤ES5 `charCodeAt`/`indexOf`/`lastIndexOf` tests are written
  `__instance.M = String.prototype.M; __instance.M(…)` — the *transferred*
  shape, which the fix does not touch.

**So a shape matrix is a correct statement about SHAPES and a poor predictor of
FILE COUNTS.** It tells you what a change does; it does not tell you how often
the corpus asks.

**Rules:**

- Use the matrix to establish *mechanism* and to separate populations.
- **Never** multiply matrix rows by intuition to size a fix. Grep the corpus for
  the actual spelling per method, or run the scoped A/B.
- When a matrix row moves but its files do not, that is *information*, not
  noise — it means the corpus uses a different spelling for that member, and
  the untouched spelling is its own population worth naming.
- State the measured flip ratio with its denominator (here: gated 46 in scope,
  flipped 10 = **21.7%**), and quote the flips, not the gate.

Sibling failure mode: sizing from an `includes <harness file>` proxy. In the
same investigation, "4,898 corpus files include `propertyHelper.js`, 1,810
host-pass" is an **upper bound to be sampled**, not a flip prediction —
including a harness proves a file *routes through* a shape, not that the shape
is *why* it fails.

Related: [[feedback_measure_never_extrapolate]] ·
[[reference_acceptance_bar_denominator_and_killswitch_attribution]] ·
[[reference_silent_empty_is_indistinguishable_from_real]]
