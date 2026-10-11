---
id: 6826
title: "maintainability: `check:godfiles` reports 24 + 23 ceiling regressions (left out of #6797), and the LOC-regrowth hook sees six src/codegen god-files above their ceiling on main (call-namespace-static +71, generators-native +56, dataview-native +55, new-super +22, calls-closures +17, array-object-proto +10)"
status: ready
sprint: Backlog
created: 2026-10-02
updated: 2026-10-02
priority: medium
horizon: l
feasibility: medium
reasoning_effort: medium
task_type: infrastructure
area: codegen
language_feature: n/a
goal: maintainability
related: [6797, 3102, 3400, 6808]
requested_by: ttraenkler/claude-review
origin: "the godfiles count is the #6797 implementation's measurement (2026-10-02); the six LOC figures are from the pre-push hook on PR 6419's merge of main 9c6d0b1e (2026-10-02 08:16 UTC)"
---
# #6826 — the god-files keep growing under allowances

## Problem

- `pnpm run check:godfiles` reports **24 + 23** files over their ceilings
  (two ceiling tables); #6797 shipped the import-cycle and flat-directory
  ratchets and explicitly left the god-file ceilings out.
- The LOC-regrowth ratchet (#3102) compares against
  `scripts/loc-budget-baseline.json`, which main refreshes post-merge; between
  refreshes every PR that merges main sees the growth other PRs landed under
  their own allowances. On 2026-10-02 at 08:16 UTC the pre-push hook flagged
  six files above their ceiling on a branch that touched none of them:

  | file | size | ceiling |
  |---|---:|---:|
  | `src/codegen/expressions/call-namespace-static.ts` | 4,522 | 4,451 |
  | `src/codegen/generators-native.ts` | 7,185 | 7,129 |
  | `src/codegen/dataview-native.ts` | 9,887 | 9,832 |
  | `src/codegen/expressions/new-super.ts` | 8,731 | 8,709 |
  | `src/codegen/expressions/calls-closures.ts` | 2,762 | 2,745 |
  | `src/codegen/array-object-proto.ts` | 4,386 | 4,376 |

  Allowances are the sanctioned path, but each one raises the file's effective
  ceiling permanently (the next refresh banks it), so the ratchet only slows
  the growth.

## Correction

1. For each file above, a split along the module map in
   `docs/architecture/codegen-axes.md` (the #6808 cut list covers the
   ir→codegen edges; this is the intra-codegen size), one PR per file, no
   behaviour change, WAT-shape tests unchanged.
2. The LOC hook: compare against the merge base's baseline state (it already
   resolves `origin/main`; use `LOC_GATE_BASE` semantics by default) so growth
   that landed on main is not charged to the branch being pushed.

## Acceptance

- `pnpm run check:godfiles` reports 0 regressions, or each remaining one has
  a dated allowance in an issue file.
- The pre-push hook no longer flags files the branch does not touch (hook
  test).
