---
id: 5278
title: "selector: reject callable-family equality operands pre-claim (#5165 regression; red issue-3214-imported-hof)"
status: ready
created: 2026-09-02
updated: 2026-09-02
sprint: current
priority: high
horizon: s
feasibility: medium
task_type: bug
area: ir
goal: ir-full-coverage
requested_by: claude/fable-ir-takeover
related: [3214, 3529, 5165, 3521, 5219]
---

## Problem

`tests/issue-3214-imported-hof.test.ts:44` is red on `main`. The R2-T1/G1 lane
bisected it while clearing the `tests/ir` CI admission (PR #5486, checkpoint
note in
[#3521](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3521-ir-r2-prepared-program-free-function-compile-once),
deviation 5) and found a **selector pre-claim gap**, not an R2 defect:

- First-parent bisect over 1,437 commits, `037ff37d9a` (GOOD) → `47e337f3b6`
  (BAD): first bad commit **`ff403c6b2c`**, the merge of PR #5219 (#5165
  tail-position loops / finally-less `try`); its parent `82a09a9b33` is GOOD.
- On `main` the fixture's `identical` function compiles once and correctly
  (`runMain` → 43); only `:44` is red. Its outcome row is
  `(1,1,0) unsupported/build/operand-coercion-unsupported` — a **POST-claim**
  typed demote raised from `src/ir/from-ast.ts:13226-13242`, where both
  operands of the equality are `callable`-typed.
- Before #5165 that body was rejected **PRE-claim**, so the selector never
  claimed it and no demote was needed. #5165 widened what the selector admits
  without widening the guard that rejects callable-family equality operands:
  `src/ir/select.ts:9377-9381` guards only module-extern operands.

`#5165` and `#3529` are both `status: done`, so no live lane owns this; the
R2 lane deliberately did not widen its slice to cover it.

## Implementation Plan

1. **Insertion point** `src/ir/select.ts:9377` — extend the existing operand
   guard so an equality whose either operand is callable-typed is refused
   **before** the claim, with the shape
   `capabilityNo("operand-coercion-unsupported", "expr-callable-equality", expr)`.
   Re-anchor by content if the line has moved; the guard is the one that today
   only inspects module-extern operands.
2. **Do not touch `from-ast.ts:13226-13242`.** The post-claim demote stays as
   the backstop; this issue closes the pre-claim hole so the demote stops
   being the only thing standing between the selector and a claimed body it
   cannot lower. (`from-ast` typing is #3522's territory.)
3. **Ownership**: `src/ir/select.ts` is listed by both
   [#3520](https://js2wasm.loopdive.com/dashboard/issue.html?slug=3520-ir-r1-source-qualified-identity)
   and #3522, so this needs a lead-assigned owner before dispatch — do not
   start it from a lane that is already inside either of those files.
4. **Pins**: un-skip / repair `tests/issue-3214-imported-hof.test.ts:44` so it
   asserts the truthful post-fix routing, and add a pin that the equality
   shape is refused pre-claim (the row becomes a pre-claim `no`, not a
   `(1,1,0)` post-claim demote).
5. **Census**: this lane measures its own `check:ir-fallbacks` bucket — the
   reason moves from a post-claim demote to a pre-claim rejection, which
   changes which bucket the corpus counts it in. Refresh with
   `pnpm run check:ir-fallbacks -- --update-on-decrease` only if a bucket
   shrinks; growth must be justified, not banked.

## Acceptance criteria

1. `tests/issue-3214-imported-hof.test.ts` is fully green, including `:44`,
   with the assertion describing the pre-claim rejection.
2. The `identical` shape's outcome row is a pre-claim refusal, not
   `(1,1,0) unsupported/build/operand-coercion-unsupported`.
3. No byte change on any shape the selector already refused or already
   claimed successfully (file-copy A/B on the host corpus).
4. `check:ir-fallbacks` accounted for, `scripts/ir-fallback-baseline.json`
   edited only through the sanctioned `--update`/`--update-on-decrease` path.
