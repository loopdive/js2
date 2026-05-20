---
id: 1530
sprint: 53
title: "Prioritise IR fallback phase-out: ratchet the budget to zero"
status: ready
created: 2026-05-20
priority: high
feasibility: medium
reasoning_effort: medium
task_type: refactor
area: ir, codegen
goal: compiler-architecture
related: [1370, 1371, 1372, 1373, 1376, 1527]
---

# #1530 — Prioritise IR fallback phase-out: ratchet the budget to zero

## Problem

The IR retirement gate (`pnpm run check:ir-fallbacks`, #1376) tracks
"unintended" rejection reasons against
`scripts/ir-fallback-baseline.json`. As of 2026-05-08 the budget is:

```
unintended:
  body-shape-rejected: 22
  param-type-not-resolvable: 1
  call-graph-closure: 6
deferred: {}
```

The CI gate prevents growth but does **not** push the number toward
zero. IR-path failures are also demoted to warnings in
`src/compiler.ts:889–896` so they don't break test262 — meaning real
codegen bugs in the default IR path are silently masked by the legacy
fallback.

If IR is the long-term codegen front-end (see #1527 for the
orthogonality framing), the fallback must phase out rather than persist
as a permanent escape hatch.

## Acceptance criteria

1. **Ratchet policy**: every PR that touches `src/ir/from-ast.ts` (or
   adjacent IR files) must not increase any "unintended" bucket.
   Decreases bank automatically — the baseline is updated to the new
   floor when the PR lands.
2. **Per-bucket ownership**: each remaining "unintended" bucket has a
   tracking issue:
   - `body-shape-rejected` (22) → #1370 (class methods), #1373 (async),
     plus any newly-discovered shapes. Open a sub-issue if the existing
     ones do not cover all 22.
   - `param-type-not-resolvable` (1) → small, one-off fix.
   - `call-graph-closure` (6) → #1370, #1373.
3. **Promotion of warnings to errors**: once a bucket hits zero, the
   demote-to-warning path in `compiler.ts:889–896` is removed for that
   class of rejection. The IR path becomes the only path for that node
   kind.
4. **Target dates**:
   - `param-type-not-resolvable` → zero within 1 week.
   - `call-graph-closure` → zero within 2 sprints.
   - `body-shape-rejected` → zero within 4 sprints (depends on #1370,
     #1373 cluster).
5. **Removal of legacy direct-codegen for IR-owned node kinds**: when
   a node kind is fully IR-owned with zero fallback, the direct codegen
   for that kind is deleted from `src/codegen/expressions.ts` /
   `statements.ts`. This is what makes the phase-out real.

## Implementation notes

- This is a coordination issue more than an implementation issue. Most
  of the actual code work lives in the referenced sub-issues.
- Track progress in `plan/log/ir-adoption.md` (created by #1527) — one
  table cell per node kind, status flipping as PRs land.
- Watch for new "deferred" categories sneaking up — they should be rare
  and explicit (e.g. `eval`, `Proxy` are valid permanent deferrals;
  `async-generator` is not).
