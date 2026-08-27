---
id: 4772
title: "ES2015 standalone switch-statement residuals"
status: in_progress
created: 2026-08-27
updated: 2026-08-27
priority: high
goal: test262-conformance
assignee: ttraenkler/codex-es6-switch
parent: 4444
files:
  - src/codegen/statements/control-flow.ts
  - src/codegen/declarations.ts
  - tests/issue-4772-switch-residual.test.ts
  - plan/issues/4772-es2015-switch-standalone-residual.md
---

# #4772 — ES2015 standalone switch-statement residuals

## Problem

The ES2015 closeout umbrella records an approximately 23-row long-tail cluster
under switch statements after the earlier broad switch issues (#2, #134, #162,
#198, #245, #297, and #2063) were completed. Those historical issues prove
basic lowering, fallthrough, string cases, and cross-type strict-equality
matching, but they do not disposition the current authoritative standalone
non-passes. The current edition snapshot is not sufficient evidence for this
cluster because it does not publish a dedicated switch feature row.

This issue owns a fresh exact census and the largest cohesive current root
cause. It must not reopen already-correct behavior or fold unrelated lexical,
generator, parser, or Annex B failures into one patch merely because their
fixture contains a `switch` statement.

## Implementation plan

1. Reconstruct the exact ES2015 switch cohort from the maintained runner's
   11,704-path edition filter and current standalone result rows. Include paths
   whose owned failure is switch lowering; exclude generator, async, parser,
   and unrelated binding failures after solo confirmation.
2. Rerun every candidate alone in standalone and host modes with the pinned
   Test262 checkout, QuickJS artifact, LLVM 18 toolchain, and at most two
   compiler workers. Record pass/fail/compile-error/timeout/skip counts and raw
   signatures in this issue.
3. Partition by semantic cause: discriminant evaluation/coercion, per-case
   StrictEquality, default placement, fallthrough/break completion, and lexical
   declaration/TDZ setup. Select the largest cohesive host-pass cluster whose
   fix belongs to switch lowering.
4. Add focused controls proving discriminant and case expressions evaluate
   once and in source order, case matching uses StrictEquality without a
   shared coercion domain, default may appear anywhere, and abrupt/fallthrough
   completion is preserved.
5. Implement the shared semantic fix in the owning subsystem. Keep driver and
   declaration changes to narrow wiring; do not add fixture rewrites, runner
   exemptions, host-oracle shortcuts, or skip/timeout changes.
6. Rerun the selected exact standalone and host slices, focused controls, and
   one adjacent already-passing switch control. Run mandatory repository gates
   and record exact artifacts, counts, commit SHAs, residuals, and handoff.

## Acceptance

- The candidate census has an exact denominator and every row has a solo
  disposition in both execution lanes.
- The selected cohesive cluster reaches 100% standalone and host pass with
  zero failures, compile errors, compile timeouts, or skips.
- Focused controls cover evaluation count/order, StrictEquality, default
  placement, fallthrough, break, and abrupt completion without regressions.
- Any non-switch root causes are explicitly handed off rather than hidden in
  the denominator.
- The PR follows the repository Description/CLA template and remains draft
  until its scoped implementation is complete, mergeable, and CI-green.

## Initial handoff

Start from current `upstream/main` in the isolated #4772 worktree. The roughly
23-row count in #4444 is a routing estimate from an older snapshot, not the
acceptance denominator. The first checkpoint must publish the fresh manifest
and signature partition before broad source edits.
