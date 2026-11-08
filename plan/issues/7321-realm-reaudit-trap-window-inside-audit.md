---
id: 7321
title: "Realm layout completion: a Proxy trap firing during the re-audit's own body walk can still return a mutated layout (follow-up to #6924)"
status: ready
sprint: Backlog
created: 2026-11-07
updated: 2026-11-07
priority: low
horizon: m
feasibility: medium
reasoning_effort: high
task_type: implementation
area: backend
goal: core-semantics
related: [3527]
assignee: "ttraenkler/c-lead"
---

# #7321: trap window inside the realm re-audit (follow-up to PR #6924)

## Problem

PR #6924 (merge 115f9cf59e, issue #3527) re-audits the completed physical
ledger after the canonical realm comparisons, so a Proxy trap fired during
the comparison can no longer hand back a layout owner whose realm or
`Function.prototype` anchor was mutated. The retroactive fresh-context
review of 2026-11-07 (PR #6924 comment 6702097137) confirmed the fix is real,
closes the described window at all 31 trap points tried, is intact on main
b631a4bc, and changes no output (stride-40 ledger identical, 624/624 binaries,
equivalence gate clean; the PR's tests fail 4/6 before and pass 6/6 after).

It also found a narrower window of the same kind, which the PR body itself
names and which exists before and after the merge: a trap that fires during
the LAST body walk inside the re-audit can still change a type record or a
body element that was already checked, and the bad layout is returned. Only
the two anchors are protected. It cannot be reached from a compiled program,
only through compiler-internal data.

## Proposed fix (from the review, not yet tried in a branch)

Fill the realm initializer through main's existing copy-on-fill path
(`fillOwnedFunction`), so the audit walks an owned copy and trap visits drop
to 0. Cost: 13 tests that deliberately mutate after fill need rewriting.

## Also from the review

- The #6924 test pins one trap point; a sweep over all trap points would be
  the stronger regression test (F2).
- The "fresh-context adversarial review" the #6924 body cites was never
  recorded in the repository (F4). Review verdicts belong in the PR body or
  a PR comment — this issue exists because that one was re-done.

## Acceptance

- Trap visits during completion are 0 (or the remaining visits are proven
  harmless) on gc, standalone and wasi.
- Output unchanged: ledger, binaries and the equivalence gate identical.
- The rewritten tests still fail on a build without the #6924 fix.
